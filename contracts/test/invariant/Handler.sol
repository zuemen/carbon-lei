// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerifierAllowlist} from "../../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../../src/EmissionsClaimRegistry.sol";

/// @notice Random sequences of every state-changing call. Each action may revert;
/// only successful calls are recorded in ghost state.
contract Handler is Test {
    VerifierAllowlist public immutable allowlist;
    EmissionsClaimRegistry public immutable registry;
    address public immutable owner;
    address public immutable watcher;

    bytes32[] public bodies;
    mapping(bytes32 lei => address[]) internal bodyAddresses;
    mapping(bytes32 lei => bytes32[]) internal bodyAuditors;
    mapping(bytes32 lei => uint64) internal ghostAddedAt;
    mapping(address addr => uint64) internal ghostBoundAt;
    mapping(address addr => uint64) internal ghostUnboundAt;
    mapping(bytes32 aid => mapping(bytes32 lei => uint64)) internal ghostAuditorAddedAt;
    mapping(bytes32 aid => mapping(bytes32 lei => uint64)) internal ghostAuditorRevokedAt;
    address[] public allAddresses;

    bytes32[] public scopes;
    bytes32[] public credLayers;
    mapping(bytes32 credLayer => bytes32) public scopeOfLayer;
    address[2] internal suppliers;

    bytes32[] public reportKeys;
    mapping(bytes32 reportKey => uint64) internal ghostRevokedAt;
    bytes32[] public batches;
    /// @dev The shipment record as written by the first successful claim of each batch (P2).
    mapping(bytes32 batchKey => EmissionsClaimRegistry.Shipment) internal ghostShipment;
    /// @dev Successful claims per batch key; P2 requires at most one.
    mapping(bytes32 batchKey => uint256) public ghostBatchClaims;
    mapping(bytes32 credLayer => uint256) public ghostClaimedSum;
    mapping(bytes32 scope => uint64) internal ghostScopeBoundAt;
    bytes32[] public retiredScope;
    bytes32[] public retiredId;

    /// @dev Set when a success is observed that breaks a per-call property (I14).
    bool public ghostViolation;
    string public ghostViolationReason;

    mapping(string action => uint256) public successes;

    uint256 internal nonce;

    constructor(VerifierAllowlist allowlist_, EmissionsClaimRegistry registry_, address owner_, address watcher_) {
        allowlist = allowlist_;
        registry = registry_;
        owner = owner_;
        watcher = watcher_;
        suppliers[0] = makeAddr("inv-supplier-0");
        suppliers[1] = makeAddr("inv-supplier-1");
        for (uint256 s = 0; s < 2; s++) {
            bytes32 scope = keccak256(abi.encode("scope", s));
            scopes.push(scope);
            for (uint256 c = 0; c < 3; c++) {
                bytes32 layer = keccak256(abi.encode("layer", s, c));
                credLayers.push(layer);
                scopeOfLayer[layer] = scope;
            }
        }
    }

    // --------------------------------------------------------------- setup

    function seedBody(bytes32 lei, address addr, uint64 accreditedUntil) external {
        vm.prank(owner);
        allowlist.addVerifier(
            VerifierAllowlist.VerifierInput(
                lei, addr, keccak256(abi.encode("LE", lei)), keccak256("ACC"), accreditedUntil
            )
        );
        _recordBody(lei, addr);
        bytes32 aid = keccak256(abi.encode("aid", lei, uint256(0)));
        vm.prank(owner);
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(aid, lei, keccak256("ECR")));
        _recordAuditor(aid, lei);
    }

    // ------------------------------------------------------------- actions

    /// @param mode 0 = (a) new credential, 1 = (b) revise layer latest, 2 = (c) take over the report scope
    function register(uint256 bodySeed, uint256 layerSeed, uint256 kgSeed, uint256 mode, uint256 flags) external {
        bytes32 lei = bodies[bodySeed % bodies.length];
        bytes32 layer = credLayers[layerSeed % credLayers.length];
        bytes32 scope = scopeOfLayer[layer];
        uint256 kind = mode % 4; // 0-2: build a plausible input from current state; 3: raw

        (bytes32 currentId, bytes32 scopeLatest,) = registry.reportScopes(scope);
        (, bytes32 layerLatest) = registry.credScopes(scope, layer);
        bytes32 holder = scopeLatest != bytes32(0) ? _issuer(scopeLatest) : bytes32(0);
        if (kind != 3 && holder != bytes32(0) && (flags >> 56) % 2 == 1) lei = holder;
        address caller = _currentAddress(lei, flags);

        EmissionsClaimRegistry.ReportInput memory r;
        r.reportKey = keccak256(abi.encode("credSAID", ++nonce));
        r.reportScopeKey = scope;
        r.credScopeKey = layer;
        r.auditorAidHash = _auditor(lei, flags >> 8);
        // forge-lint: disable-next-line(unsafe-typecast)
        r.kelSeq = uint64(nonce); // nonce stays far below 2^64 within a run
        r.supplier = suppliers[(flags >> 16) % 2];
        r.supplierCommit = keccak256(abi.encode("sc", nonce));
        r.installationCommit = keccak256(abi.encode("ic", scope));
        r.verifiedKg = uint96(bound(kgSeed, 1, 1_000_000));
        r.validUntil = uint64(block.timestamp + bound(flags >> 24, 30 days, 400 days));
        bytes32 fresh = keccak256(abi.encode("reportId", nonce));

        if (kind == 3) {
            uint256 rawMode = (mode >> 2) % 3;
            bool reuse = (flags >> 40) % 2 == 1 && currentId != bytes32(0);
            r.reportIdHash = reuse ? currentId : fresh;
            if (rawMode == 1) r.supersedes = layerLatest;
            else if (rawMode == 2) r.supersedes = scopeLatest;
        } else if (layerLatest != bytes32(0)) {
            // (b) revise the layer; the scope holder may keep the current id
            r.supersedes = layerLatest;
            r.reportIdHash = (lei == holder && (flags >> 40) % 2 == 1) ? currentId : fresh;
        } else if (currentId == bytes32(0)) {
            r.reportIdHash = fresh; // (a) first credential of the scope
        } else if (lei == holder) {
            r.reportIdHash = (flags >> 48) % 4 == 3 ? fresh : currentId; // (a) another layer of the same report
        } else {
            r.supersedes = scopeLatest; // (c) take the scope over through an empty layer
            r.reportIdHash = fresh;
        }

        vm.prank(caller);
        try registry.registerReport(r) {
            reportKeys.push(r.reportKey);
            if (currentId == bytes32(0)) ghostScopeBoundAt[scope] = uint64(block.timestamp);
            if (currentId != bytes32(0) && currentId != r.reportIdHash) {
                retiredScope.push(scope);
                retiredId.push(currentId);
            }
            if (r.supersedes == bytes32(0)) {
                successes["registerNew"]++;
            } else if (layerLatest != bytes32(0)) {
                successes["revise"]++;
                if (_issuer(r.supersedes) != lei) successes["reviseOtherBody"]++;
            } else {
                successes["takeover"]++;
                if (_issuer(r.supersedes) != lei) successes["takeoverOtherBody"]++;
            }
        } catch {}
    }

    /// @dev Registration followed by a claim on the new credential, so ledgers fill up
    /// within the fuzz depth.
    function registerAndClaim(uint256 bodySeed, uint256 layerSeed, uint256 kgSeed, uint256 mode, uint256 flags)
        external
    {
        uint256 before = reportKeys.length;
        this.register(bodySeed, layerSeed, kgSeed, mode, flags);
        if (reportKeys.length > before) this.claim(reportKeys.length - 1, kgSeed >> 96);
    }

    function claim(uint256 reportSeed, uint256 kgSeed) external {
        if (reportKeys.length == 0) return;
        bytes32 k = reportKeys[reportSeed % reportKeys.length];
        EmissionsClaimRegistry.ReportRecord memory rep = report(k);
        uint96 kg = uint96(bound(kgSeed, 1, 700_000));
        bytes32 b = keccak256(abi.encode("batch", ++nonce));
        vm.prank(rep.supplier);
        bytes32 importer = keccak256(abi.encode("importer", nonce));
        try registry.claimShipment(k, b, kg, importer) {
            batches.push(b);
            ghostShipment[b] = EmissionsClaimRegistry.Shipment(k, kg, importer, uint64(block.timestamp));
            ghostBatchClaims[b]++;
            ghostClaimedSum[rep.credScopeKey] += kg;
            successes["claim"]++;
        } catch {}
    }

    /// @dev P2: resend an already claimed batch key, against its own report or another one,
    /// with any quantity and importer. Every success is counted; the invariant expects none.
    function reclaim(uint256 batchSeed, uint256 reportSeed, uint256 kgSeed, uint256 flags) external {
        if (batches.length == 0) return;
        bytes32 b = batches[batchSeed % batches.length];
        bytes32 k = (flags % 2 == 0) ? ghostShipment[b].reportKey : reportKeys[reportSeed % reportKeys.length];
        EmissionsClaimRegistry.ReportRecord memory rep = report(k);
        // small quantities, so a missing batch check would not be masked by the tonnage cap
        uint96 kg = uint96(bound(kgSeed, 1, 1_000));
        bytes32 importer =
            (flags >> 1) % 2 == 0 ? ghostShipment[b].importerCommit : keccak256(abi.encode("re", ++nonce));
        vm.prank(rep.supplier);
        try registry.claimShipment(k, b, kg, importer) {
            ghostBatchClaims[b]++;
            ghostClaimedSum[rep.credScopeKey] += kg;
            successes["reclaim"]++;
        } catch {}
        successes["reclaimAttempt"]++;
    }

    function revoke(uint256 reportSeed, uint256 bodySeed, uint256 flags) external {
        if (reportKeys.length == 0) return;
        bytes32 k = reportKeys[reportSeed % reportKeys.length];
        bytes32 lei = (flags % 4 == 3) ? bodies[bodySeed % bodies.length] : report(k).issuerLeiHash;
        address caller = _currentAddress(lei, flags >> 8);
        vm.prank(caller);
        try registry.revokeReport(k) {
            ghostRevokedAt[k] = uint64(block.timestamp);
            successes["revoke"]++;
            (bytes32 callerLei,, uint64 unboundAt) = allowlist.leiOfAddress(caller);
            if (
                unboundAt != 0 || callerLei != report(k).issuerLeiHash
                    || !allowlist.isInstitutionActiveAt(callerLei, uint64(block.timestamp))
            ) _violate("I14: revoke by an inactive or foreign address");
        } catch {}
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1 minutes, 20 days));
        successes["warp"]++;
    }

    function suspend(uint256 bodySeed) external {
        if (bodySeed % 4 != 0) return; // suspensions are rare events
        bytes32 lei = bodies[bodySeed % bodies.length];
        vm.prank(watcher);
        try allowlist.suspendVerifier(lei) {
            successes["suspend"]++;
        } catch {}
    }

    function lift(uint256 bodySeed) external {
        bytes32 lei = bodies[bodySeed % bodies.length];
        vm.prank(watcher);
        try allowlist.liftSuspension(lei) {
            successes["lift"]++;
        } catch {}
    }

    function revokeAuditor(uint256 bodySeed, uint256 aidSeed) external {
        if (aidSeed % 4 != 0) return;
        bytes32 lei = bodies[bodySeed % bodies.length];
        bytes32[] storage aids = bodyAuditors[lei];
        bytes32 aid = aids[aidSeed % aids.length];
        vm.prank(watcher);
        try allowlist.revokeAuditor(aid, lei) {
            ghostAuditorRevokedAt[aid][lei] = uint64(block.timestamp);
            successes["revokeAuditor"]++;
        } catch {}
    }

    function rotate(uint256 bodySeed) external {
        if (bodySeed % 2 != 0) return;
        bytes32 lei = bodies[bodySeed % bodies.length];
        address newAddr = makeAddr(string(abi.encode("rotated", ++nonce)));
        (address oldAddr,,,,,,) = allowlist.institutions(lei);
        vm.prank(owner);
        try allowlist.rotateVerifierAddress(lei, newAddr) {
            ghostUnboundAt[oldAddr] = uint64(block.timestamp);
            _recordBody(lei, newAddr);
            successes["rotate"]++;
        } catch {}
    }

    function addAuditor(uint256 bodySeed) external {
        bytes32 lei = bodies[bodySeed % bodies.length];
        bytes32 aid = keccak256(abi.encode("aid", lei, ++nonce));
        vm.prank(owner);
        try allowlist.addAuditor(VerifierAllowlist.AuditorInput(aid, lei, keccak256("ECR"))) {
            _recordAuditor(aid, lei);
            successes["addAuditor"]++;
        } catch {}
    }

    function addVerifier(uint256 seed) external {
        if (bodies.length >= 5) return;
        bytes32 lei = keccak256(abi.encode("lei", ++nonce));
        address addr = makeAddr(string(abi.encode("body", nonce)));
        uint64 until = uint64(block.timestamp + bound(seed, 30 days, 3 * 365 days));
        vm.prank(owner);
        try allowlist.addVerifier(
            VerifierAllowlist.VerifierInput(lei, addr, keccak256(abi.encode("LE", lei)), keccak256("ACC"), until)
        ) {
            _recordBody(lei, addr);
            successes["addVerifier"]++;
            bytes32 aid = keccak256(abi.encode("aid", lei, uint256(0)));
            vm.prank(owner);
            try allowlist.addAuditor(VerifierAllowlist.AuditorInput(aid, lei, keccak256("ECR"))) {
                _recordAuditor(aid, lei);
            } catch {}
        } catch {}
    }

    // ---------------------------------------------------------------- views

    function report(bytes32 k) public view returns (EmissionsClaimRegistry.ReportRecord memory r) {
        r = registry.reports(k);
    }

    function reportCount() external view returns (uint256) {
        return reportKeys.length;
    }

    function batchCount() external view returns (uint256) {
        return batches.length;
    }

    function ghostShipmentOf(bytes32 batchKey) external view returns (EmissionsClaimRegistry.Shipment memory) {
        return ghostShipment[batchKey];
    }

    function bodyCount() external view returns (uint256) {
        return bodies.length;
    }

    function addressCount() external view returns (uint256) {
        return allAddresses.length;
    }

    function addressesOf(bytes32 lei) external view returns (address[] memory) {
        return bodyAddresses[lei];
    }

    function auditorsOf(bytes32 lei) external view returns (bytes32[] memory) {
        return bodyAuditors[lei];
    }

    function scopeCount() external view returns (uint256) {
        return scopes.length;
    }

    function layerCount() external view returns (uint256) {
        return credLayers.length;
    }

    function retiredCount() external view returns (uint256) {
        return retiredScope.length;
    }

    function ghosts(address addr) external view returns (uint64 boundAt, uint64 unboundAt) {
        return (ghostBoundAt[addr], ghostUnboundAt[addr]);
    }

    function ghostAuditor(bytes32 aid, bytes32 lei) external view returns (uint64 addedAt, uint64 revokedAt) {
        return (ghostAuditorAddedAt[aid][lei], ghostAuditorRevokedAt[aid][lei]);
    }

    function ghostBodyAddedAt(bytes32 lei) external view returns (uint64) {
        return ghostAddedAt[lei];
    }

    function ghostReportRevokedAt(bytes32 k) external view returns (uint64) {
        return ghostRevokedAt[k];
    }

    function ghostScopeBound(bytes32 scope) external view returns (uint64) {
        return ghostScopeBoundAt[scope];
    }

    // ------------------------------------------------------------- internal

    function _recordBody(bytes32 lei, address addr) internal {
        if (bodyAddresses[lei].length == 0) {
            bodies.push(lei);
            ghostAddedAt[lei] = uint64(block.timestamp);
        }
        bodyAddresses[lei].push(addr);
        allAddresses.push(addr);
        ghostBoundAt[addr] = uint64(block.timestamp);
    }

    function _recordAuditor(bytes32 aid, bytes32 lei) internal {
        bodyAuditors[lei].push(aid);
        ghostAuditorAddedAt[aid][lei] = uint64(block.timestamp);
    }

    /// @dev Usually the current address; one time in eight an older one (exercises rotation).
    function _currentAddress(bytes32 lei, uint256 flags) internal view returns (address) {
        address[] storage addrs = bodyAddresses[lei];
        if (flags % 8 == 7) return addrs[(flags >> 3) % addrs.length];
        return addrs[addrs.length - 1];
    }

    /// @dev Usually the body's newest auditor; sometimes an older (possibly revoked) one,
    /// and one time in sixteen another body's auditor.
    function _auditor(bytes32 lei, uint256 flags) internal view returns (bytes32) {
        if (flags % 16 == 15) {
            bytes32 other = bodies[(flags >> 4) % bodies.length];
            bytes32[] storage oa = bodyAuditors[other];
            return oa[oa.length - 1];
        }
        bytes32[] storage aids = bodyAuditors[lei];
        if (flags % 4 == 3) return aids[(flags >> 2) % aids.length];
        return aids[aids.length - 1];
    }

    function _issuer(bytes32 k) internal view returns (bytes32 lei) {
        lei = registry.reports(k).issuerLeiHash;
    }

    function _violate(string memory reason) internal {
        if (!ghostViolation) {
            ghostViolation = true;
            ghostViolationReason = reason;
        }
    }
}
