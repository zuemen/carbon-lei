// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice Registry unit tests: register, claim, revoke, validity.
/// Spec: 12 §3.2/§5/§6.2/§7 (scenarios 1, 6, 8) + M0.5 freeze addendum §5 (F-6, F-8, F-9) and §6 (check order).
/// Each test breaks exactly one precondition; errors are matched on the full ABI encoding.
contract RegistryTest is Base {
    bytes32 internal constant K1 = keccak256("ESAID-K1-demo");
    bytes32 internal constant K2 = keccak256("ESAID-K2-demo");
    bytes32 internal constant K6 = keccak256("ESAID-K6-demo");
    bytes32 internal constant K_NONE = keccak256("ESAID-never-registered");

    uint96 internal constant KG500 = 500_000; // 500 t

    // ---------------------------------------------------------------- helpers

    function _regK1() internal {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
    }

    /// @dev A fresh, otherwise-valid input on scope P2/Q2 (does not collide with K1 on P/Q).
    function _freshInput() internal view returns (EmissionsClaimRegistry.ReportInput memory) {
        return _input(K6, rid(6), P2, Q2, KG500, bytes32(0));
    }

    function _claimWith(bytes32 reportKey, bytes32 batchKey, uint96 kg, bytes32 importerCommit) internal {
        vm.prank(supplier);
        registry.claimShipment(reportKey, batchKey, kg, importerCommit);
    }

    function _registeredAt(bytes32 k) internal view returns (uint64 t) {
        t = registry.reports(k).registeredAt;
    }

    function _revokedAt(bytes32 k) internal view returns (uint64 t) {
        t = registry.reports(k).revokedAt;
    }

    function _claimedKg(bytes32 credScope) internal view returns (uint96 kg) {
        (kg,) = registry.credScopes(scopeOf(credScope), credScope);
    }

    function _reportValid(bytes32 batchKey) internal view returns (bool ok) {
        (,,,,, ok) = registry.shipmentStatus(batchKey);
    }

    function _revoke(address caller, bytes32 k) internal {
        vm.prank(caller);
        registry.revokeReport(k);
    }

    function _revokeAuditor(bytes32 aid, bytes32 lei) internal {
        vm.prank(watcher);
        allowlist.revokeAuditor(aid, lei);
    }

    // ------------------------------------------------- C2, C3, C26 (scenario 6 steps 2-4)

    function test_C2_rotatedOldAddressCannotRegister() public {
        _regK1();
        _rotate(L1, v1n);
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1));
        _register(v1, r);
    }

    function test_C2_rotatedNewAddressCanRegister() public {
        _rotate(L1, v1n);
        _register(v1n, _freshInput());
        address verifier = registry.reports(K6).verifier;
        bytes32 lei = registry.reports(K6).issuerLeiHash;
        assertEq(verifier, v1n);
        assertEq(lei, L1);
    }

    function test_C3_reportFromOldAddressStillValidAfterRotation() public {
        _regK1();
        _rotate(L1, v1n);
        vm.warp(block.timestamp + 1 days);
        assertTrue(registry.isValid(K1));
        address verifier = registry.reports(K1).verifier;
        bytes32 lei = registry.reports(K1).issuerLeiHash;
        assertEq(verifier, v1);
        assertEq(lei, L1);
    }

    function test_C26_claimOnOldAddressReportAfterRotation() public {
        _regK1();
        _rotate(L1, v1n);
        _claim(supplier, K1, batch(1), 100_000); // scenario 6 step 4
        (bytes32 rk, uint96 qty,, address verifier, uint64 claimedAt, bool ok) = registry.shipmentStatus(batch(1));
        assertEq(rk, K1);
        assertEq(qty, 100_000);
        assertEq(verifier, v1);
        assertEq(claimedAt, block.timestamp);
        assertTrue(ok);
        assertEq(_claimedKg(Q), 100_000);
        assertEq(registry.remainingKg(K1), 400_000);
    }

    function test_C26_oldAddressCannotRegisterAfterClaim() public {
        _regK1();
        _rotate(L1, v1n);
        _claim(supplier, K1, batch(1), 100_000);
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1));
        _register(v1, r);
    }

    // ---------------------------------------------------------------- C4, C5

    function test_C4_unlistedAddressCannotRegister() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v5));
        _register(v5, r);
    }

    function test_C5_auditorOfOtherBody() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.auditorAidHash = AID_B; // AID-b belongs to L2
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AuditorNotAuthorized.selector, AID_B, v1));
        _register(v1, r);
    }

    // ---------------------------------------------------------------- C6, C7

    function test_C6_ReportExists() public {
        _regK1();
        // same reportKey, but a different (empty) scope pair so nothing else is violated
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(2), P2, Q2, KG500, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportExists.selector, K1));
        _register(v1, r);
    }

    function test_C7_ZeroQuantity_verifiedKg() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.verifiedKg = 0;
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ZeroQuantity.selector));
        _register(v1, r);
    }

    function test_C7_InvalidExpiry_equalsNow() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.validUntil = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidExpiry.selector, uint64(block.timestamp)));
        _register(v1, r);
    }

    function test_C7_InvalidExpiry_beforeNow() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        uint64 past = uint64(block.timestamp) - 1;
        r.validUntil = past;
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidExpiry.selector, past));
        _register(v1, r);
    }

    function test_C7_validUntilOneSecondAfterNowAccepted() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.validUntil = uint64(block.timestamp) + 1;
        _register(v1, r);
        assertTrue(registry.isValid(K6));
    }

    // ---------------------------------------------------------------- C8 - C11

    function test_C8_NotSupplier() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotSupplier.selector, stranger));
        _claim(stranger, K1, batch(1), 100_000);
    }

    function test_C8_NotSupplier_verifierItself() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotSupplier.selector, v1));
        _claim(v1, K1, batch(1), 100_000);
    }

    function test_C9_BatchAlreadyClaimed() public {
        _regK1();
        _claim(supplier, K1, batch(1), 100_000);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.BatchAlreadyClaimed.selector, batch(1)));
        _claim(supplier, K1, batch(1), 100_000);
    }

    function test_C10_claimExactlyVerifiedKg() public {
        _regK1();
        _claim(supplier, K1, batch(1), 200_000);
        _claim(supplier, K1, batch(2), 300_000);
        assertEq(_claimedKg(Q), KG500);
        assertEq(registry.remainingKg(K1), 0);
        assertTrue(registry.isValid(K1));
    }

    function test_C10_singleClaimOfFullAmount() public {
        _regK1();
        _claim(supplier, K1, batch(1), KG500);
        assertEq(registry.remainingKg(K1), 0);
    }

    function test_C11_oneKgOver_afterFull() public {
        _regK1();
        _claim(supplier, K1, batch(1), KG500);
        vm.expectRevert(
            abi.encodeWithSelector(EmissionsClaimRegistry.ExceedsVerifiedTonnage.selector, uint96(0), uint96(1))
        );
        _claim(supplier, K1, batch(2), 1);
    }

    function test_C11_oneKgOver_partial() public {
        _regK1();
        _claim(supplier, K1, batch(1), 200_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                EmissionsClaimRegistry.ExceedsVerifiedTonnage.selector, uint96(300_000), uint96(300_001)
            )
        );
        _claim(supplier, K1, batch(2), 300_001);
    }

    function test_C11_singleClaimOverVerified() public {
        _regK1();
        vm.expectRevert(
            abi.encodeWithSelector(EmissionsClaimRegistry.ExceedsVerifiedTonnage.selector, KG500, uint96(KG500 + 1))
        );
        _claim(supplier, K1, batch(1), KG500 + 1);
    }

    // ---------------------------------------------------------------- C12

    function test_C12_claimNonexistentReport() public {
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportNotFound.selector, K_NONE));
        _claim(supplier, K_NONE, batch(1), 100_000);
    }

    function test_C12_claimRevokedReport() public {
        _regK1();
        _revoke(v1, K1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportInvalid.selector, K1));
        _claim(supplier, K1, batch(1), 100_000);
    }

    function test_C12_claimExpiredReport() public {
        _regK1();
        vm.warp(VALID_UNTIL + 1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportInvalid.selector, K1));
        _claim(supplier, K1, batch(1), 100_000);
    }

    function test_C12_claimOnExpiryDayStillAccepted() public {
        _regK1();
        vm.warp(VALID_UNTIL);
        _claim(supplier, K1, batch(1), 100_000);
        assertEq(_claimedKg(Q), 100_000);
    }

    // ---------------------------------------------------------------- C13

    function test_C13_NotReportIssuer() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotReportIssuer.selector, v2, L1));
        _revoke(v2, K1);
    }

    function test_C13_AlreadyRevoked() public {
        _regK1();
        _revoke(v1, K1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AlreadyRevoked.selector, K1));
        _revoke(v1, K1);
    }

    // ------------------------------------------------------- C14, C32, C25 (expiry)

    function test_C14_isValidFalseAfterValidUntil() public {
        _regK1();
        vm.warp(VALID_UNTIL);
        assertTrue(registry.isValid(K1));
        vm.warp(VALID_UNTIL + 1);
        assertFalse(registry.isValid(K1));
    }

    /// F-9: remainingKg does not look at isValid (expired latest still shows the book balance).
    function test_C14_F9_remainingKgIgnoresExpiry() public {
        _regK1();
        _claim(supplier, K1, batch(1), 200_000);
        vm.warp(VALID_UNTIL + 1);
        assertFalse(registry.isValid(K1));
        assertEq(registry.remainingKg(K1), 300_000);
    }

    function test_C32_isValidAtClaimedAtAfterExpiry() public {
        _regK1();
        vm.warp(block.timestamp + 30 days);
        _claim(supplier, K1, batch(1), 100_000);
        (,,,, uint64 claimedAt,) = registry.shipmentStatus(batch(1));
        vm.warp(VALID_UNTIL + 400 days);
        assertFalse(registry.isValid(K1));
        assertTrue(registry.isValidAt(K1, claimedAt));
    }

    function test_C25_shipmentStatusValidAfterExpiry() public {
        _regK1();
        _claim(supplier, K1, batch(1), 100_000);
        uint64 claimedAt = uint64(vm.getBlockTimestamp()); // via_ir may re-read block.timestamp after warp
        vm.warp(VALID_UNTIL + 1);
        (bytes32 rk, uint96 qty,, address verifier, uint64 ca, bool ok) = registry.shipmentStatus(batch(1));
        assertEq(rk, K1);
        assertEq(qty, 100_000);
        assertEq(verifier, v1);
        assertEq(ca, claimedAt);
        assertTrue(ok);
    }

    // ------------------------------------------------------- C15, C18 (body inactive)

    function test_C15_registerAfterAccreditationExpiry() public {
        vm.warp(ACCREDITED_UNTIL + 1);
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.validUntil = ACCREDITED_UNTIL + 365 days; // keep validUntil in the future: only one violation
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1));
        _register(v1, r);
    }

    function test_C18_registerWhileSuspended() public {
        _suspend(L1);
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1));
        _register(v1, r);
    }

    // ------------------------------------------------------- C16, C17 (auditor revoked)

    function test_C16_reportBeforeAuditorRevocationStaysValid() public {
        _regK1();
        vm.warp(block.timestamp + 1 days);
        _revokeAuditor(AID_A, L1);
        vm.warp(block.timestamp + 1 days);
        assertTrue(registry.isValid(K1));
        _claim(supplier, K1, batch(1), 100_000); // still claimable
        assertTrue(_reportValid(batch(1)));
    }

    function test_C17_registerAfterAuditorRevocation() public {
        _revokeAuditor(AID_A, L1);
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AuditorNotAuthorized.selector, AID_A, v1));
        _register(v1, r);
    }

    // ------------------------------------------------------- C19, C20 (revocation)

    function test_C19_revokedReportInvalidAndNotClaimable() public {
        _regK1();
        _claim(supplier, K1, batch(1), 200_000);
        _revoke(v1, K1);
        assertFalse(registry.isValid(K1));
        assertEq(_revokedAt(K1), block.timestamp);
        assertEq(registry.remainingKg(K1), 0); // P10: revoked → 0
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportInvalid.selector, K1));
        _claim(supplier, K1, batch(2), 100_000); // scenario 1 step 4
    }

    function test_C19_revocationDoesNotReleaseLayers() public {
        _regK1();
        _claim(supplier, K1, batch(1), 200_000);
        _revoke(v1, K1);
        (bytes32 rId, bytes32 latestP,) = registry.reportScopes(P);
        (uint96 claimed, bytes32 latestQ) = registry.credScopes(P, Q);
        assertEq(rId, rid(1));
        assertEq(latestP, K1);
        assertEq(claimed, 200_000);
        assertEq(latestQ, K1);
    }

    function test_C20_shipmentStatusFollowsRevocation() public {
        _regK1();
        _claim(supplier, K1, batch(1), 200_000);
        assertTrue(_reportValid(batch(1)));
        vm.warp(block.timestamp + 1 days);
        _revoke(v1, K1);
        (bytes32 rk, uint96 qty,, address verifier,, bool ok) = registry.shipmentStatus(batch(1));
        assertFalse(ok);
        assertEq(rk, K1);
        assertEq(qty, 200_000);
        assertEq(verifier, v1);
    }

    function test_C20_unknownBatchNotValid() public view {
        (bytes32 rk,,,, uint64 claimedAt, bool ok) = registry.shipmentStatus(batch(99));
        assertEq(rk, bytes32(0));
        assertEq(claimedAt, 0);
        assertFalse(ok);
    }

    // ------------------------------------------------------- C55 (registry InvalidInput)

    function test_C55_zeroSupplier() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.supplier = address(0);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidInput.selector));
        _register(v1, r);
    }

    function test_C55_zeroReportScopeKey() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.reportScopeKey = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidInput.selector));
        _register(v1, r);
    }

    function test_C55_zeroCredScopeKey() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.credScopeKey = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidInput.selector));
        _register(v1, r);
    }

    function test_C55_zeroReportIdHash() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.reportIdHash = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidInput.selector));
        _register(v1, r);
    }

    /// F-6: reportKey = 0 would make the credential layer look empty afterwards.
    function test_C55_F6_zeroReportKey() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.reportKey = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.InvalidInput.selector));
        _register(v1, r);
    }

    // ------------------------------------------------------- C60 (isValidAt boundaries)

    function test_C60_isValidAt_timeMatrix() public {
        _regK1();
        uint64 reg = _registeredAt(K1);
        assertEq(reg, block.timestamp);
        assertFalse(registry.isValidAt(K1, reg - 1), "before registeredAt");
        assertTrue(registry.isValidAt(K1, reg), "at registeredAt");
        assertTrue(registry.isValidAt(K1, reg + 30 days), "inside");
        assertTrue(registry.isValidAt(K1, VALID_UNTIL), "at validUntil");
        assertFalse(registry.isValidAt(K1, VALID_UNTIL + 1), "validUntil + 1");
        assertFalse(registry.isValidAt(K1, 0), "t = 0");
    }

    function test_C60_isValidAt_revocationIsRetroactive() public {
        _regK1();
        uint64 reg = _registeredAt(K1);
        vm.warp(block.timestamp + 10 days);
        _revoke(v1, K1);
        uint64 rev = _revokedAt(K1);
        assertFalse(registry.isValidAt(K1, reg), "at registeredAt after revoke");
        assertFalse(registry.isValidAt(K1, rev - 1), "before revokedAt");
        assertFalse(registry.isValidAt(K1, rev), "at revokedAt");
        assertFalse(registry.isValidAt(K1, rev + 1), "after revokedAt");
    }

    function test_C60_isValidAt_supersedeBoundary() public {
        _regK1();
        uint64 reg = _registeredAt(K1);
        vm.warp(block.timestamp + 10 days);
        // same-ID revision by the same body: only the supersededBy condition moves
        _reg1(K2, rid(1), P, Q, KG500, K1);
        uint64 ts = _registeredAt(K2);
        assertTrue(registry.isValidAt(K1, reg), "at registeredAt");
        assertTrue(registry.isValidAt(K1, ts - 1), "just before supersede");
        assertFalse(registry.isValidAt(K1, ts), "at supersede");
        assertFalse(registry.isValidAt(K1, ts + 1), "after supersede");
        assertTrue(registry.isValidAt(K2, ts), "new credential at its registeredAt");
    }

    function test_C60_isValidEqualsIsValidAtNow() public {
        _regK1();
        uint64[4] memory ts = [uint64(block.timestamp), VALID_UNTIL - 1, VALID_UNTIL, VALID_UNTIL + 1];
        for (uint256 i; i < ts.length; ++i) {
            vm.warp(ts[i]);
            assertEq(registry.isValid(K1), registry.isValidAt(K1, ts[i]));
        }
    }

    function test_C60_isValidAt_unknownReport() public view {
        assertFalse(registry.isValidAt(K_NONE, uint64(block.timestamp)));
        assertFalse(registry.isValid(K_NONE));
        assertEq(registry.remainingKg(K_NONE), 0);
    }

    // ------------------------------------------------------- C64 (owner has no power over reports)

    function test_C64_ownerCannotRegister() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, owner));
        _register(owner, r);
    }

    /// owner is neither an active verifier address nor the issuer; interface spec §3.2 v2 revoke-authority checks
    /// the active-address condition, so the contract answers NotActiveVerifier(owner).
    function test_C64_ownerCannotRevoke() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, owner));
        _revoke(owner, K1);
    }

    /// Single-violation variant: even if the owner address is bound as the current address of
    /// another (active) body, it is not the issuer of L1's report → NotReportIssuer(owner, L1).
    function test_C64_ownerBoundToOtherBodyCannotRevoke() public {
        _regK1();
        _addBody(keccak256("ZZZZ00OWNERBODYDEMO1"), owner);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotReportIssuer.selector, owner, L1));
        _revoke(owner, K1);
    }

    function test_C64_ownerCannotClaim() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotSupplier.selector, owner));
        _claim(owner, K1, batch(1), 100_000);
    }

    function test_C64_watcherCannotRevoke() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, watcher));
        _revoke(watcher, K1);
    }

    // ------------------------------------------------------- C65 (body inactive later)

    function test_C65_suspensionKeepsEarlierReportValid() public {
        _regK1();
        _claim(supplier, K1, batch(1), 100_000);
        vm.warp(block.timestamp + 1 days);
        _suspend(L1);
        vm.warp(block.timestamp + 1 days);
        assertTrue(registry.isValid(K1));
        assertTrue(_reportValid(batch(1)));
        _claim(supplier, K1, batch(2), 100_000);
        assertEq(_claimedKg(Q), 200_000);
        assertTrue(_reportValid(batch(2)));
    }

    function test_C65_accreditationExpiryKeepsEarlierReportValid() public {
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(1), P, Q, KG500, bytes32(0));
        r.validUntil = ACCREDITED_UNTIL + 365 days; // report outlives the accreditation
        _register(v1, r);
        _claim(supplier, K1, batch(1), 100_000);
        vm.warp(ACCREDITED_UNTIL + 1);
        assertFalse(allowlist.isVerifierActiveAt(v1, uint64(block.timestamp)));
        assertTrue(registry.isValid(K1));
        assertTrue(_reportValid(batch(1)));
        _claim(supplier, K1, batch(2), 100_000);
        assertEq(_claimedKg(Q), 200_000);
    }

    // ------------------------------------------------------- C66 (shared ledger across importers)

    function test_C66_secondImporterOverLimit() public {
        _regK1();
        bytes32 imp1 = keccak256("importer-1");
        bytes32 imp2 = keccak256("importer-2");
        _claimWith(K1, batch(1), 200_000, imp1);
        vm.expectRevert(
            abi.encodeWithSelector(
                EmissionsClaimRegistry.ExceedsVerifiedTonnage.selector, uint96(300_000), uint96(400_000)
            )
        );
        _claimWith(K1, batch(2), 400_000, imp2);
    }

    function test_C66_secondImporterExactRemainder() public {
        _regK1();
        bytes32 imp1 = keccak256("importer-1");
        bytes32 imp2 = keccak256("importer-2");
        _claimWith(K1, batch(1), 200_000, imp1);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ShipmentClaimed(
            batch(2), K1, supplier, 300_000, imp2, uint96(500_000), uint64(block.timestamp)
        );
        _claimWith(K1, batch(2), 300_000, imp2);
        (,, bytes32 ic,,,) = registry.shipmentStatus(batch(2));
        assertEq(ic, imp2);
        assertEq(registry.remainingKg(K1), 0);
    }

    // ------------------------------------------------------- C67 (scattered error paths)

    function test_C67_claimZeroQuantity() public {
        _regK1();
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ZeroQuantity.selector));
        _claim(supplier, K1, batch(1), 0);
    }

    function test_C67_revokeNonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportNotFound.selector, K_NONE));
        _revoke(v1, K_NONE);
    }

    /// F-8: a nonexistent `supersedes` is reported before the report/credential layer checks.
    /// Here the layers are occupied and the input carries a new report ID, so without F-8 the
    /// contract would answer PeriodAlreadyCovered / SupersedeMismatch.
    function test_C67_F8_supersedesNonexistent_occupiedScope() public {
        _regK1();
        EmissionsClaimRegistry.ReportInput memory r = _input(K2, rid(2), P, Q, KG500, K_NONE);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportNotFound.selector, K_NONE));
        _register(v1, r);
    }

    function test_C67_F8_supersedesNonexistent_sameReportId() public {
        _regK1();
        EmissionsClaimRegistry.ReportInput memory r = _input(K2, rid(1), P, Q, KG500, K_NONE);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportNotFound.selector, K_NONE));
        _register(v1, r);
    }

    function test_C67_F8_supersedesNonexistent_emptyScope() public {
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.supersedes = K_NONE;
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.ReportNotFound.selector, K_NONE));
        _register(v1, r);
    }

    function test_C67_revokeAuditorTwice() public {
        _revokeAuditor(AID_A, L1);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AlreadyRevoked.selector, AID_A));
        _revokeAuditor(AID_A, L1);
    }

    function test_C67_unknownAuditor() public {
        bytes32 nobody = keccak256("EAuditor-never-added");
        EmissionsClaimRegistry.ReportInput memory r = _freshInput();
        r.auditorAidHash = nobody;
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AuditorNotAuthorized.selector, nobody, v1));
        _register(v1, r);
    }

    // ------------------------------------------------------- happy-path state (12 §3.2 effects)

    function test_C3_registerRecordFields() public {
        _regK1();
        address verifier = registry.reports(K1).verifier;
        bytes32 lei = registry.reports(K1).issuerLeiHash;
        bytes32 aid = registry.reports(K1).auditorAidHash;
        uint64 kelSeq = registry.reports(K1).kelSeq;
        address sup = registry.reports(K1).supplier;
        uint96 vkg = registry.reports(K1).verifiedKg;
        uint64 vu = registry.reports(K1).validUntil;
        uint64 reg = registry.reports(K1).registeredAt;
        uint64 rev = registry.reports(K1).revokedAt;
        bytes32 rId = registry.reports(K1).reportIdHash;
        bytes32 pk = registry.reports(K1).reportScopeKey;
        bytes32 qk = registry.reports(K1).credScopeKey;
        bytes32 sups = registry.reports(K1).supersedes;
        bytes32 supBy = registry.reports(K1).supersededBy;
        assertEq(verifier, v1);
        assertEq(lei, L1);
        assertEq(aid, AID_A);
        assertEq(kelSeq, 3);
        assertEq(sup, supplier);
        assertEq(vkg, KG500);
        assertEq(vu, VALID_UNTIL);
        assertEq(reg, block.timestamp);
        assertEq(rev, 0);
        assertEq(rId, rid(1));
        assertEq(pk, P);
        assertEq(qk, Q);
        assertEq(sups, bytes32(0));
        assertEq(supBy, bytes32(0));
        (bytes32 boundId, bytes32 latestP, uint64 boundAt) = registry.reportScopes(P);
        assertEq(boundId, rid(1));
        assertEq(latestP, K1);
        assertEq(boundAt, block.timestamp);
        (uint96 claimed, bytes32 latestQ) = registry.credScopes(P, Q);
        assertEq(claimed, 0);
        assertEq(latestQ, K1);
        assertEq(registry.remainingKg(K1), KG500);
    }
}
