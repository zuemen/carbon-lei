// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Findings of the M1 adversarial review. Fixed findings are regression tests (C100–C102);
/// the others document accepted residual risks (listed in SECURITY.md).
contract HardeningTest is Base {
    address internal x = makeAddr("third-party-admin");
    bytes32 internal constant ADMIN = 0x00;
    bytes32 internal constant WATCHER = keccak256("WATCHER_ROLE");

    // ------------------------------------------------------------------ RV-11 (fixed)
    /// RV-11 (medium, fixed): an accredited body registered the victim's credential layer Q under a
    /// scope of its own (P9) and so occupied Q for good. The ledger is now keyed by
    /// (reportScopeKey, credScopeKey): the squatter's credential lands in its own slot and the
    /// installation's body registers Q under P as normal.
    function test_C100_crossScopeSquatDoesNotBlockTheLayer() public {
        bytes32 K8 = key("ATTACKER-SAID");
        bytes32 K1 = key("VICTIM-SAID");
        _reg2(K8, rid(9), P9, Q, 1, bytes32(0));

        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));
        (, bytes32 latestP) = registry.credScopes(P, Q);
        (, bytes32 latestP9) = registry.credScopes(P9, Q);
        assertEq(latestP, K1, "installation's own layer");
        assertEq(latestP9, K8, "squatter stays in its own slot");

        // the two ledgers are separate: claims on K8 do not use K1's tonnage
        _claim(supplier, K1, batch(1), 500_000);
        assertEq(registry.remainingKg(K1), 0);
        assertEq(registry.remainingKg(K8), 1);
        // and K8 cannot be used to revise the installation's layer
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.SupersedeMismatch.selector, K1, K8));
        _reg1(key("K2"), rid(1), P, Q, 600_000, K8);
    }

    // ------------------------------------------------------------------ RV-12 (fixed)
    /// RV-12 (low, fixed): DEFAULT_ADMIN_ROLE can no longer be granted to anyone but the owner,
    /// so no second admin can take over the WATCHER role or outlive an ownership transfer.
    function test_C101_adminRoleOnlyForOwner() public {
        vm.prank(owner);
        vm.expectRevert(VerifierAllowlist.InvalidInput.selector);
        allowlist.grantRole(ADMIN, x);
        assertFalse(allowlist.hasRole(ADMIN, x));

        vm.prank(owner);
        allowlist.transferOwnership(v5);
        assertTrue(allowlist.hasRole(ADMIN, v5));
        assertFalse(allowlist.hasRole(ADMIN, owner));
        vm.prank(v5);
        allowlist.grantRole(WATCHER, stranger);
        assertTrue(allowlist.hasRole(WATCHER, stranger));
    }

    // ------------------------------------------------------------------ RV-13
    /// RV-13 (low): renounceOwnership leaves the allowlist with no DEFAULT_ADMIN at all;
    /// WATCHER can never be rotated again (already covered by test_Ownership_renounce_dropsAdminRole,
    /// listed here only for the deployment checklist).
    function test_RV13_renounceOwnership_noAdminLeft() public {
        vm.prank(owner);
        allowlist.renounceOwnership();
        assertFalse(allowlist.hasRole(ADMIN, owner));
        vm.prank(owner);
        vm.expectRevert();
        allowlist.grantRole(WATCHER, stranger);
    }

    // ------------------------------------------------------------------ RV-14
    /// RV-14 (low, nuisance): `batchKey` is a global namespace. The supplier of an unrelated
    /// valid credential can claim with the victim's batchKey (e.g. by front-running the mempool);
    /// the victim's claim then fails with BatchAlreadyClaimed and must re-salt.
    function test_RV14_batchKeyGlobalNamespace_frontRun() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2-other-installation");
        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));
        EmissionsClaimRegistry.ReportInput memory r = _input(K2, rid(2), P2, Q2, 10, bytes32(0));
        r.supplier = supplier2;
        _register(v1, r);

        bytes32 B = batch(1); // victim's batchKey, visible in the mempool
        _claim(supplier2, K2, B, 1); // attacker claims first, on its own credential
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.BatchAlreadyClaimed.selector, B));
        _claim(supplier, K1, B, 100_000);

        (bytes32 rk,,,,,) = registry.shipmentStatus(B);
        assertEq(rk, K2, "batchKey now points to the attacker's credential");
    }

    // ------------------------------------------------------------------ RV-15
    /// RV-15 (low, nuisance): `reportKey` is also first-come: an accredited body can burn the
    /// victim's credential SAID by front-running registerReport with the same reportKey.
    function test_RV15_reportKeyFrontRun_burnsSaid() public {
        bytes32 K1 = key("VICTIM-CRED-SAID");
        _reg2(K1, rid(9), P9, Q_P9, 1, bytes32(0)); // attacker copies only reportKey
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportExists.selector, K1));
        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));
    }

    // ------------------------------------------------------------------ RV-16 (fixed)
    /// RV-16 (low, fixed): addAuditor rejects a zero ECR SAID hash.
    function test_C102_addAuditorRejectsZeroEcrHash() public {
        vm.prank(owner);
        vm.expectRevert(VerifierAllowlist.InvalidInput.selector);
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(keccak256("AID-Z"), L1, bytes32(0)));
    }

    // ------------------------------------------------------------------ RV-17
    /// RV-17 (low, design): a credential may outlive its body's accreditation and nobody can
    /// revoke it (O9-A removes the body's revoke right, O8-A gives WATCHER none).
    function test_RV17_credentialOutlivesAccreditation_unrevocable() public {
        bytes32 K1 = key("K1");
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(1), P, Q, 500_000, bytes32(0));
        r.validUntil = ACCREDITED_UNTIL + 365 days;
        _register(v1, r);

        vm.warp(ACCREDITED_UNTIL + 1);
        assertTrue(registry.isValid(K1), "still valid after accreditation expiry");
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1));
        registry.revokeReport(K1);
        // supplier can still claim
        _claim(supplier, K1, batch(1), 100_000);
    }
}
