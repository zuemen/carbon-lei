// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BaseV2} from "./BaseV2.t.sol";
import {VerifierAllowlistV2} from "../../src/v2/VerifierAllowlistV2.sol";
import {EmissionsClaimRegistryV2} from "../../src/v2/EmissionsClaimRegistryV2.sol";

/// @notice Fuzz properties of the delay and hold rules (docs/SECURITY.md §13.1).
/// D1: without the current address's consent, a rotation takes effect only if
///     `ROTATION_DELAY` has passed since the proposal.
/// H1: a revocation is applied only if the revoking address had been bound to its body for at
///     least `REVOKE_HOLD` (either at once, or after a queue of `REVOKE_HOLD`).
/// E1: with `effectiveFrom = e`, a shipment claimed at `c` stays valid exactly when `c < e`.
contract FuzzV2Test is BaseV2 {
    function testFuzz_D1_rotationRespectsDelay(uint64 dt) public {
        dt = uint64(bound(dt, 0, 30 days));
        _propose(L1, thief);
        uint64 t0 = START + 1 hours;
        vm.warp(t0 + dt);
        if (dt < DELAY) {
            vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RotationNotReady.selector, L1, t0 + DELAY));
            allowlist.executeRotation(L1);
            assertTrue(allowlist.isVerifierActiveAt(v1, t0 + dt));
        } else {
            allowlist.executeRotation(L1);
            assertEq(_boundAt(thief), t0 + dt);
        }
    }

    function testFuzz_D1_signedPathNeedsCurrentAddressKey(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(pk != v1Key);
        _propose(L1, thief);
        bytes memory sig = _sign(pk, allowlist.rotationDigest(L1, thief));
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, sig);
    }

    function testFuzz_D1_garbageSignatureRejected(bytes calldata sig) public {
        _propose(L1, thief);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, sig);
    }

    function testFuzz_H1_freshAddressRevocationHeld(uint64 age, uint64 waitAfter, uint64 ef) public {
        bytes32 k = _regL1(v1, 1, 1000);
        uint64 tBind = START + 1 hours + DELAY;
        _rotateDelayed(L1, v1n); // v1n bound at tBind
        age = uint64(bound(age, 0, 10 days));
        vm.warp(tBind + age);
        uint64 tReq = tBind + age;
        ef = uint64(bound(ef, 0, tReq));
        vm.prank(v1n);
        registry.revokeReport(k, ef);

        if (age >= HOLD) {
            assertEq(_revokedAt(k), tReq);
            return;
        }
        assertEq(_revokedAt(k), 0);
        assertTrue(registry.isValid(k));
        waitAfter = uint64(bound(waitAfter, 0, 10 days));
        vm.warp(tReq + waitAfter);
        if (waitAfter < HOLD) {
            vm.expectRevert(
                abi.encodeWithSelector(EmissionsClaimRegistryV2.RevocationNotReady.selector, k, tReq + HOLD)
            );
            registry.executeRevocation(k);
        } else {
            registry.executeRevocation(k);
            assertGe(_revokedAt(k), tBind + HOLD);
            assertEq(registry.revocationEffectiveFrom(k), ef);
        }
    }

    function testFuzz_E1_effectiveFromSplitsShipments(uint64 c, uint64 e) public {
        bytes32 k = _regL1(v1, 1, 1000);
        uint64 t0 = START + 1 hours;
        c = uint64(bound(c, t0, t0 + 2 days));
        vm.warp(c);
        _claim(k, 1, 10);
        uint64 tRev = START + HOLD + 3 days; // v1 matured; after every claim time
        vm.warp(tRev);
        e = uint64(bound(e, 0, tRev));
        vm.prank(v1);
        registry.revokeReport(k, e);
        (,,,,, bool valid) = registry.shipmentStatus(batch(1));
        assertEq(valid, c < e);
        assertEq(registry.isValidAt(k, c), c < e);
    }
}

/// @dev Random sequences over rotation and revocation. Records every applied revocation with
/// the revoker's `boundAt`, and every rotation with its proposal time.
contract HandlerV2 is Test {
    VerifierAllowlistV2 public allowlist;
    EmissionsClaimRegistryV2 public registry;
    address public owner;
    address public watcher;
    bytes32 public constant LEI = keccak256("ZZZZ-INV-L1");
    bytes32[] public keys;
    address[] public candidates;

    uint64 public lastProposedAt;
    uint256 public appliedRevocations;
    uint256 public executedRotations;
    bool public violationH1;
    bool public violationD1;

    constructor(VerifierAllowlistV2 a, EmissionsClaimRegistryV2 r, address o, address w, bytes32[] memory k) {
        allowlist = a;
        registry = r;
        owner = o;
        watcher = w;
        keys = k;
        for (uint256 i = 0; i < 6; i++) {
            candidates.push(address(uint160(0xD000 + i)));
        }
    }

    function _current() internal view returns (address cur) {
        (cur,,,,,,) = allowlist.institutions(LEI);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 5 days));
    }

    function propose(uint256 i) external {
        address a = candidates[i % candidates.length];
        vm.prank(owner);
        try allowlist.proposeRotation(LEI, a) {
            lastProposedAt = uint64(block.timestamp);
        } catch {}
    }

    function cancel(uint256 who) external {
        address[3] memory c = [_current(), watcher, owner];
        vm.prank(c[who % 3]);
        try allowlist.cancelRotation(LEI) {} catch {}
    }

    function execute() external {
        try allowlist.executeRotation(LEI) {
            executedRotations++;
            if (block.timestamp < uint256(lastProposedAt) + allowlist.ROTATION_DELAY()) violationD1 = true;
        } catch {}
    }

    function revoke(uint256 i, uint64 ef) external {
        bytes32 k = keys[i % keys.length];
        address cur = _current();
        ef = uint64(bound(ef, 0, block.timestamp));
        vm.prank(cur);
        try registry.revokeReport(k, ef) {
            _record(k, cur);
        } catch {}
    }

    function executeRevocation(uint256 i) external {
        bytes32 k = keys[i % keys.length];
        (address req,,) = registry.pendingRevocations(k);
        try registry.executeRevocation(k) {
            _record(k, req);
        } catch {}
    }

    function cancelRevocation(uint256 i) external {
        vm.prank(watcher);
        try registry.cancelRevocation(keys[i % keys.length]) {} catch {}
    }

    function _record(bytes32 k, address revoker) internal {
        uint64 revokedAt = registry.reports(k).revokedAt;
        if (revokedAt == 0) return; // queued
        appliedRevocations++;
        (, uint64 boundAt,) = allowlist.leiOfAddress(revoker);
        if (revokedAt < uint256(boundAt) + registry.REVOKE_HOLD()) violationH1 = true;
    }
}

/// @notice Invariants H1 and D1 under random call sequences.
contract InvariantsV2Test is StdInvariant, Test {
    HandlerV2 internal handler;
    EmissionsClaimRegistryV2 internal registry;

    function setUp() public {
        vm.warp(1790000000);
        address owner = makeAddr("inv-owner");
        address watcher = makeAddr("inv-watcher");
        address v = makeAddr("inv-v1");
        bytes32 lei = keccak256("ZZZZ-INV-L1");
        bytes32 aid = keccak256("inv-aid");
        VerifierAllowlistV2 allowlist = new VerifierAllowlistV2(owner, watcher);
        registry = new EmissionsClaimRegistryV2(allowlist);
        vm.startPrank(owner);
        allowlist.addVerifier(VerifierAllowlistV2.VerifierInput(lei, v, keccak256("LE"), keccak256("ACC"), 1924905600));
        allowlist.addAuditor(VerifierAllowlistV2.AuditorInput(aid, lei, keccak256("ECR")));
        vm.stopPrank();

        bytes32[] memory keys = new bytes32[](4);
        for (uint256 i = 0; i < 4; i++) {
            keys[i] = keccak256(abi.encode("inv-report", i));
            vm.prank(v);
            registry.registerReport(
                EmissionsClaimRegistryV2.ReportInput({
                    reportKey: keys[i],
                    reportIdHash: keccak256(abi.encode("rid", i)),
                    reportScopeKey: keccak256(abi.encode("P", i)),
                    credScopeKey: keccak256(abi.encode("Q", i)),
                    auditorAidHash: aid,
                    kelSeq: 1,
                    supplier: makeAddr("inv-supplier"),
                    supplierCommit: bytes32(0),
                    installationCommit: bytes32(0),
                    verifiedKg: 1000,
                    validUntil: 1830211200,
                    supersedes: bytes32(0)
                })
            );
        }
        handler = new HandlerV2(allowlist, registry, owner, watcher, keys);
        targetContract(address(handler));
    }

    function invariant_H1_revocationOnlyByMaturedBinding() public view {
        assertFalse(handler.violationH1(), "H1: revocation applied before REVOKE_HOLD of the revoker's binding");
    }

    function invariant_D1_rotationOnlyAfterDelay() public view {
        assertFalse(handler.violationD1(), "D1: rotation executed before ROTATION_DELAY");
    }
}
