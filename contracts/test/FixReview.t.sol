// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Review of the fixes for R-11 (ledger keyed by report scope and credential scope), R-12
/// (admin role only for the owner) and R-16 (non-zero ECR hash): do they introduce new problems?
/// Every test passing means "the behaviour described in the name exists".
contract FixReviewTest is Base {
    bytes32 internal constant ADMIN = 0x00;
    bytes32 internal constant WATCHER = keccak256("WATCHER_ROLE");

    // ------------------------------------------------------------ R-11 dual key

    /// Two ledgers for the same Q under different P: on-chain alone the sum of claims over Q
    /// exceeds the installation's verifiedKg (500_000 + 1). Only the SDK's 4j scope check
    /// (reportScopeKey recomputed from disclosed fields) rejects the (P9, Q) credential.
    function test_RV2_A_sameQTwoScopes_onChainSumExceedsCap_sdkMustCatch() public {
        bytes32 K8 = key("ATTACKER-SAID");
        bytes32 K1 = key("VICTIM-SAID");
        EmissionsClaimRegistry.ReportInput memory r = _input(K8, rid(9), P9, Q, 1_000_000, bytes32(0));
        r.auditorAidHash = AID_B;
        r.supplier = supplier2;
        _register(v2, r);
        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));

        _claim(supplier, K1, batch(1), 500_000);
        _claim(supplier2, K8, batch(2), 1_000_000);
        (uint96 c1,) = registry.credScopes(P, Q);
        (uint96 c8,) = registry.credScopes(P9, Q);
        assertEq(c1, 500_000);
        assertEq(c8, 1_000_000);
        assertTrue(registry.isValid(K8), "squatter credential is valid on-chain; SDK 4j is the only gate");
    }

    /// I7 under the dual key: every slot's latest carries both keys of the slot.
    function test_RV2_B_I7_bothKeysPointBack() public {
        bytes32 K8 = key("K8");
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg2(K8, rid(9), P9, Q, 1, bytes32(0));
        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));
        _claim(supplier, K1, batch(1), 100_000);
        // (b) revision in the victim's slot does not touch the squatter's slot
        _reg1(K2, rid(1), P, Q, 600_000, K1);

        (uint96 cPQ, bytes32 lPQ) = registry.credScopes(P, Q);
        (uint96 cP9Q, bytes32 lP9Q) = registry.credScopes(P9, Q);
        assertEq(lPQ, K2);
        assertEq(cPQ, 100_000, "claimedKg carried inside the (P,Q) slot");
        assertEq(lP9Q, K8);
        assertEq(cP9Q, 0);
        EmissionsClaimRegistry.ReportRecord memory a = registry.reports(lPQ);
        EmissionsClaimRegistry.ReportRecord memory b = registry.reports(lP9Q);
        assertEq(a.reportScopeKey, P);
        assertEq(a.credScopeKey, Q);
        assertEq(b.reportScopeKey, P9);
        assertEq(b.credScopeKey, Q);
        assertFalse(registry.isValid(K1));
        assertTrue(registry.isValid(K8), "revision in (P,Q) leaves (P9,Q) alone");
        assertEq(registry.remainingKg(K2), 500_000);
    }

    /// (c) takeover cannot use a credential from another scope even if it shares Q; and after a
    /// genuine takeover the frozen layer's claimedKg still binds the next (b) revision.
    function test_RV2_C_takeoverAcrossScopesBlocked_capCarried() public {
        bytes32 K8 = key("K8");
        bytes32 K1 = key("K1");
        // squatter copies P's report ID (C98 pattern) so the report-layer check passes and
        // the scope check in (c) is what blocks it; with another ID PeriodAlreadyCovered comes first
        _reg2(K8, rid(1), P9, Q, 1, bytes32(0));
        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));
        _claim(supplier, K1, batch(1), 100_000);
        _suspend(L1);

        // (c) via the squatter's credential: scope mismatch (P vs P9)
        EmissionsClaimRegistry.ReportInput memory r = _input(key("K9"), rid(2), P, Q_E, 10, K8);
        r.auditorAidHash = AID_B;
        vm.prank(v2);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.SupersedeMismatch.selector, P, P9));
        registry.registerReport(r);

        // (c) via K1 (A-08, accepted): P moves to rid(2); (P,Q) freezes with 100_000 claimed
        r.supersedes = K1;
        _register(v2, r);
        assertFalse(registry.isValid(K1));
        (uint96 c, bytes32 l) = registry.credScopes(P, Q);
        assertEq(c, 100_000);
        assertEq(l, K1, "takeover leaves K1 as latest of (P,Q)");

        // (b) on (P,Q) by L2 must still respect the carried claimedKg
        EmissionsClaimRegistry.ReportInput memory r2 = _input(key("K10"), rid(2), P, Q, 50_000, K1);
        r2.auditorAidHash = AID_B;
        vm.prank(v2);
        vm.expectRevert(
            abi.encodeWithSelector(
                EmissionsClaimRegistry.SupersedeOverClaimed.selector, Q, uint96(100_000), uint96(50_000)
            )
        );
        registry.registerReport(r2);
        r2.verifiedKg = 100_000;
        _register(v2, r2);
        assertEq(registry.remainingKg(key("K10")), 0, "cap fully consumed by the pre-takeover claims");
        // the squatter's slot never entered any of this
        (, bytes32 l9) = registry.credScopes(P9, Q);
        assertEq(l9, K8);
    }

    /// (a) in a fresh scope with a Q that is live elsewhere: allowed (that is the fix), but
    /// the scope's report-ID binding still applies to the new scope independently.
    function test_RV2_D_freshScopeSameQ_reportLayerIndependent() public {
        bytes32 K1 = key("K1");
        _reg1(K1, rid(1), P, Q, 500_000, bytes32(0));
        // L2 registers Q under P9 with the *same* report ID as P: allowed (different scope)
        _reg2(key("K8"), rid(1), P9, Q, 1, bytes32(0));
        (bytes32 idP,,) = registry.reportScopes(P);
        (bytes32 idP9,,) = registry.reportScopes(P9);
        assertEq(idP, rid(1));
        assertEq(idP9, rid(1));
        // L2 cannot then use that credential to hang anything under P (NotReportIssuer first)
        EmissionsClaimRegistry.ReportInput memory r = _input(key("K9"), rid(1), P, Q_E, 1, bytes32(0));
        r.auditorAidHash = AID_B;
        vm.prank(v2);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotReportIssuer.selector, v2, L1));
        registry.registerReport(r);
    }

    // ------------------------------------------------------------ R-12 _grantRole override

    /// Owner can still strip itself of DEFAULT_ADMIN via renounceRole / revokeRole (WATCHER then
    /// cannot be rotated) but recovers by transferring ownership to itself.
    function test_RV2_E_ownerDropsAdmin_recoversBySelfTransfer() public {
        vm.prank(owner);
        allowlist.renounceRole(ADMIN, owner);
        assertFalse(allowlist.hasRole(ADMIN, owner));
        assertEq(allowlist.owner(), owner);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, ADMIN));
        allowlist.grantRole(WATCHER, stranger);

        vm.prank(owner);
        allowlist.transferOwnership(owner);
        assertTrue(allowlist.hasRole(ADMIN, owner), "self-transfer regrants admin");
        vm.prank(owner);
        allowlist.grantRole(WATCHER, stranger);
        assertTrue(allowlist.hasRole(WATCHER, stranger));
    }

    function test_RV2_F_ownerRevokeRoleOnSelf_sameRecovery() public {
        vm.prank(owner);
        allowlist.revokeRole(ADMIN, owner);
        assertFalse(allowlist.hasRole(ADMIN, owner));
        vm.prank(owner);
        allowlist.transferOwnership(owner);
        assertTrue(allowlist.hasRole(ADMIN, owner));
    }

    /// grantRole(ADMIN, owner) by the owner is a no-op, not a revert; after a transfer the old
    /// owner can neither grant admin to itself (not admin) nor be granted admin by the new owner.
    function test_RV2_G_grantAdminToOwnerNoop_oldOwnerLockedOut() public {
        vm.prank(owner);
        allowlist.grantRole(ADMIN, owner);
        assertTrue(allowlist.hasRole(ADMIN, owner));

        vm.prank(owner);
        allowlist.transferOwnership(v5);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, ADMIN));
        allowlist.grantRole(ADMIN, owner);
        vm.prank(v5);
        vm.expectRevert(VerifierAllowlist.InvalidInput.selector);
        allowlist.grantRole(ADMIN, owner);
        // WATCHER administration unaffected
        vm.prank(v5);
        allowlist.grantRole(WATCHER, stranger);
        vm.prank(v5);
        allowlist.revokeRole(WATCHER, watcher);
        assertFalse(allowlist.hasRole(WATCHER, watcher));
    }

    /// Constructor ordering: Ownable's constructor calls the overridden _transferOwnership before
    /// the derived constructor body; owner() is already set when _grantRole(ADMIN) runs.
    function test_RV2_H_constructorOrdering_watcherEqualsOwnerAllowed() public {
        VerifierAllowlist a = new VerifierAllowlist(stranger, stranger);
        assertEq(a.owner(), stranger);
        assertTrue(a.hasRole(ADMIN, stranger));
        assertTrue(a.hasRole(WATCHER, stranger), "watcher == owner is not rejected by the contract");
    }

    /// renounceOwnership after the override: no revert, no admin left, nobody can ever get it back.
    function test_RV2_I_renounceOwnership_noRevert_noAdminForever() public {
        vm.prank(owner);
        allowlist.renounceOwnership();
        assertEq(allowlist.owner(), address(0));
        assertFalse(allowlist.hasRole(ADMIN, owner));
        vm.prank(owner);
        vm.expectRevert();
        allowlist.transferOwnership(owner);
    }

    // ------------------------------------------------------------ R-16 order of checks

    /// addAuditor with ecrSaidHash = 0 on an unknown body reports VerifierNotFound first (unordered
    /// precondition set in 12 §3.1, so either is acceptable; recorded for the SDK error mapping).
    function test_RV2_J_addAuditorZeroEcr_unknownBody_orderIsNotFoundFirst() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierNotFound.selector, keccak256("L-none")));
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(keccak256("AID-Z"), keccak256("L-none"), bytes32(0)));
        // zero auditorAidHash and zero ecr on a known body: InvalidInput
        vm.prank(owner);
        vm.expectRevert(VerifierAllowlist.InvalidInput.selector);
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(bytes32(0), L1, bytes32(0)));
    }
}
