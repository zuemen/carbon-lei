// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerifierAllowlistV2} from "../../src/v2/VerifierAllowlistV2.sol";
import {EmissionsClaimRegistryV2} from "../../src/v2/EmissionsClaimRegistryV2.sol";

/// @notice Fixture for the CR1 mitigation (docs/SECURITY.md §13.1), mirroring `Base` with the
/// V2 contracts. Organisations and LEIs are fictional (ZZZZ prefix). Not deployed.
abstract contract BaseV2 is Test {
    VerifierAllowlistV2 internal allowlist;
    EmissionsClaimRegistryV2 internal registry;

    address internal owner = makeAddr("owner");
    address internal watcher = makeAddr("watcher");
    uint256 internal v1Key = uint256(keccak256("verifier1-key"));
    address internal v1 = vm.addr(v1Key); // body L1
    address internal v2 = makeAddr("verifier2"); // body L2
    address internal thief = makeAddr("thief"); // address a stolen owner key installs
    address internal v1n = makeAddr("verifier1-rotated"); // honest new address of L1
    address internal supplier = makeAddr("supplier");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant L1 = keccak256("ZZZZ00EUVERIFDEMO152");
    bytes32 internal constant L2 = keccak256("ZZZZ00EUVERIF2DEMO99");
    bytes32 internal constant AID_A = keccak256("EAuditorA-demo-aid");
    bytes32 internal constant AID_B = keccak256("EAuditorB-demo-aid");
    bytes32 internal constant P = keccak256("P:INST-01:2026");
    bytes32 internal constant Q = keccak256("Q:INST-01:7318:C:2026");
    bytes32 internal constant KA = keccak256("ESAID-A");

    uint64 internal constant ACCREDITED_UNTIL = 1924905600; // 2030-12-31
    uint64 internal constant VALID_UNTIL = 1830211200; // 2027-12-31
    uint64 internal constant START = 1790000000;
    uint64 internal constant DELAY = 72 hours;
    uint64 internal constant HOLD = 72 hours;

    function setUp() public virtual {
        vm.warp(START);
        allowlist = new VerifierAllowlistV2(owner, watcher);
        registry = new EmissionsClaimRegistryV2(allowlist);
        _addBody(L1, v1);
        _addBody(L2, v2);
        vm.startPrank(owner);
        allowlist.addAuditor(VerifierAllowlistV2.AuditorInput(AID_A, L1, keccak256("ECR-A")));
        allowlist.addAuditor(VerifierAllowlistV2.AuditorInput(AID_B, L2, keccak256("ECR-B")));
        vm.stopPrank();
        vm.warp(START + 1 hours);
    }

    function _addBody(bytes32 lei, address addr) internal {
        vm.prank(owner);
        allowlist.addVerifier(
            VerifierAllowlistV2.VerifierInput({
                leiHash: lei,
                verifier: addr,
                leCredSaidHash: keccak256(abi.encode("LE", lei)),
                accreditationSaidHash: keccak256(abi.encode("ACC", lei)),
                accreditedUntil: ACCREDITED_UNTIL
            })
        );
    }

    function rid(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("VR-DEMO-", n));
    }

    function rk(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("ESAID-", n));
    }

    function batch(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("BATCH-DEMO-2026-", n));
    }

    /// @dev Registers report `n` of body L1 (its own report and credential scope) from `caller`.
    function _regL1(address caller, uint256 n, uint96 kg) internal returns (bytes32 reportKey) {
        reportKey = rk(n);
        EmissionsClaimRegistryV2.ReportInput memory r = EmissionsClaimRegistryV2.ReportInput({
            reportKey: reportKey,
            reportIdHash: rid(n),
            reportScopeKey: keccak256(abi.encode("P", n)),
            credScopeKey: keccak256(abi.encode("Q", n)),
            auditorAidHash: AID_A,
            kelSeq: 3,
            supplier: supplier,
            supplierCommit: keccak256("supplier-commit"),
            installationCommit: keccak256("installation-commit"),
            verifiedKg: kg,
            validUntil: VALID_UNTIL,
            supersedes: bytes32(0)
        });
        vm.prank(caller);
        registry.registerReport(r);
    }

    function _claim(bytes32 reportKey, uint256 b, uint96 kg) internal {
        vm.prank(supplier);
        registry.claimShipment(reportKey, batch(b), kg, keccak256(abi.encode("importer", b)));
    }

    function _propose(bytes32 lei, address newAddr) internal {
        vm.prank(owner);
        allowlist.proposeRotation(lei, newAddr);
    }

    /// @dev Propose, wait the delay, execute: the only path without the old address's consent.
    function _rotateDelayed(bytes32 lei, address newAddr) internal {
        _propose(lei, newAddr);
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRotation(lei);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _revokedAt(bytes32 reportKey) internal view returns (uint64) {
        return registry.reports(reportKey).revokedAt;
    }

    function _boundAt(address a) internal view returns (uint64 b) {
        (, b,) = allowlist.leiOfAddress(a);
    }

    function _pendingRequester(bytes32 reportKey) internal view returns (address r) {
        (r,,) = registry.pendingRevocations(reportKey);
    }
}
