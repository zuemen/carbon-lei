// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice Shared fixture. Organisations and LEIs are fictional (ZZZZ prefix).
abstract contract Base is Test {
    VerifierAllowlist internal allowlist;
    EmissionsClaimRegistry internal registry;

    address internal owner = makeAddr("owner"); // W1
    address internal watcher = makeAddr("watcher"); // W2
    address internal v1 = makeAddr("verifier1"); // body L1 (Demo Verification GmbH)
    address internal v1n = makeAddr("verifier1-rotated");
    address internal v1nn = makeAddr("verifier1-rotated-twice");
    address internal v2 = makeAddr("verifier2"); // body L2 (a second accredited body)
    address internal v5 = makeAddr("impostor"); // never on the allowlist
    address internal supplier = makeAddr("supplier"); // S (Demo Fasteners Co.)
    address internal supplier2 = makeAddr("supplier2");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant L1 = keccak256("ZZZZ00EUVERIFDEMO152");
    bytes32 internal constant L2 = keccak256("ZZZZ00EUVERIF2DEMO99");
    bytes32 internal constant AID_A = keccak256("EAuditorA-demo-aid"); // auditor of L1
    bytes32 internal constant AID_B = keccak256("EAuditorB-demo-aid"); // auditor of L2

    // report layer: (installation, period)
    bytes32 internal constant P = keccak256("P:INST-01:2026");
    bytes32 internal constant P2 = keccak256("P:INST-01:2027");
    bytes32 internal constant P9 = keccak256("P:INST-09:2026");
    // credential layer: (installation, CN, route, period)
    bytes32 internal constant Q = keccak256("Q:INST-01:7318:C:2026");
    bytes32 internal constant Q_E = keccak256("Q:INST-01:7318:E:2026"); // Q' in the spec
    bytes32 internal constant Q2 = keccak256("Q:INST-01:7318:C:2027");
    bytes32 internal constant Q9 = keccak256("Q:INST-01:7208:C:2026");
    bytes32 internal constant Q10 = keccak256("Q:INST-01:7210:C:2026");
    bytes32 internal constant Q_P9 = keccak256("Q:INST-09:7318:C:2026");

    uint64 internal constant ACCREDITED_UNTIL = 1924905600; // 2030-12-31T00:00:00Z
    uint64 internal constant VALID_UNTIL = 1830211200; // 2027-12-31T00:00:00Z
    uint64 internal constant START = 1790000000; // 2026-09-21

    function setUp() public virtual {
        vm.warp(START);
        allowlist = new VerifierAllowlist(owner, watcher);
        registry = new EmissionsClaimRegistry(allowlist);

        _addBody(L1, v1);
        _addBody(L2, v2);
        vm.prank(owner);
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(AID_A, L1, keccak256("ECR-A")));
        vm.prank(owner);
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(AID_B, L2, keccak256("ECR-B")));
        vm.warp(START + 1 hours);
    }

    // ---------------------------------------------------------------- helpers

    function _addBody(bytes32 lei, address addr) internal {
        vm.prank(owner);
        allowlist.addVerifier(
            VerifierAllowlist.VerifierInput({
                leiHash: lei,
                verifier: addr,
                leCredSaidHash: keccak256(abi.encode("LE", lei)),
                accreditationSaidHash: keccak256(abi.encode("ACC", lei)),
                accreditedUntil: ACCREDITED_UNTIL
            })
        );
    }

    /// @dev Report scope of the fixture credential layers.
    function scopeOf(bytes32 q) internal pure returns (bytes32) {
        if (q == Q2) return P2;
        if (q == Q_P9) return P9;
        return P;
    }

    function rid(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("VR-DEMO-", n));
    }

    function key(string memory credSaid) internal pure returns (bytes32) {
        return keccak256(bytes(credSaid));
    }

    function batch(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("BATCH-DEMO-2026-", n));
    }

    /// @dev A valid input for body L1 / auditor AID_A; tests override single fields.
    function _input(
        bytes32 reportKey,
        bytes32 reportId,
        bytes32 scope,
        bytes32 credScope,
        uint96 kg,
        bytes32 supersedes
    ) internal view returns (EmissionsClaimRegistry.ReportInput memory r) {
        r = EmissionsClaimRegistry.ReportInput({
            reportKey: reportKey,
            reportIdHash: reportId,
            reportScopeKey: scope,
            credScopeKey: credScope,
            auditorAidHash: AID_A,
            kelSeq: 3,
            supplier: supplier,
            supplierCommit: keccak256("supplier-commit"),
            installationCommit: keccak256("installation-commit"),
            verifiedKg: kg,
            validUntil: VALID_UNTIL,
            supersedes: supersedes
        });
    }

    function _register(address caller, EmissionsClaimRegistry.ReportInput memory r) internal {
        vm.prank(caller);
        registry.registerReport(r);
    }

    /// @dev Registers as L1 (v1, AID_A).
    function _reg1(bytes32 reportKey, bytes32 reportId, bytes32 scope, bytes32 credScope, uint96 kg, bytes32 supersedes)
        internal
    {
        _register(v1, _input(reportKey, reportId, scope, credScope, kg, supersedes));
    }

    /// @dev Registers as L2 (v2, AID_B).
    function _reg2(bytes32 reportKey, bytes32 reportId, bytes32 scope, bytes32 credScope, uint96 kg, bytes32 supersedes)
        internal
    {
        EmissionsClaimRegistry.ReportInput memory r = _input(reportKey, reportId, scope, credScope, kg, supersedes);
        r.auditorAidHash = AID_B;
        _register(v2, r);
    }

    function _claim(address caller, bytes32 reportKey, bytes32 batchKey, uint96 kg) internal {
        vm.prank(caller);
        registry.claimShipment(reportKey, batchKey, kg, keccak256(abi.encode("importer", batchKey)));
    }

    function _suspend(bytes32 lei) internal {
        vm.prank(watcher);
        allowlist.suspendVerifier(lei);
    }

    function _lift(bytes32 lei) internal {
        vm.prank(watcher);
        allowlist.liftSuspension(lei);
    }

    function _rotate(bytes32 lei, address newAddr) internal {
        vm.prank(owner);
        allowlist.rotateVerifierAddress(lei, newAddr);
    }
}
