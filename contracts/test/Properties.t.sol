// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice Fuzz tests that state the on-chain security properties P1, P2, P3 and P6 of
/// docs/SECURITY.md §9 directly, one property per test.
contract PropertiesTest is Base {
    bytes32 internal constant KA = keccak256("ESAID-P-A");
    bytes32 internal constant KB = keccak256("ESAID-P-B");
    bytes32 internal constant KR = keccak256("ESAID-P-R");
    uint96 internal constant KG500 = 500_000; // 500 t

    function _claimedKg(bytes32 scope, bytes32 credScope) internal view returns (uint96 claimedKg) {
        (claimedKg,) = registry.credScopes(scope, credScope);
    }

    function _tryClaim(bytes32 reportKey, bytes32 batchKey, uint96 kg) internal returns (bool ok) {
        vm.prank(supplier);
        try registry.claimShipment(reportKey, batchKey, kg, keccak256("importer")) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    // ------------------------------------------------------------------- P1

    /// @dev P1: within one credential slot, a claim is accepted exactly when it keeps the
    /// cumulative claim at or below verifiedKg, and the slot's claimedKg equals the sum of
    /// the accepted claims, so it never exceeds verifiedKg.
    function testFuzz_P1_claimsNeverExceedVerified(uint96 verifiedKg, uint96[6] memory qs) public {
        verifiedKg = uint96(bound(verifiedKg, 1, 1e15));
        _reg1(KA, rid(1), P, Q, verifiedKg, bytes32(0));
        uint256 sum;
        for (uint256 i = 0; i < qs.length; i++) {
            uint96 q = uint96(bound(qs[i], 0, uint256(verifiedKg) * 2));
            bool expectOk = q != 0 && sum + q <= verifiedKg;
            assertEq(_tryClaim(KA, batch(100 + i), q), expectOk, "P1 claim accepted iff within verifiedKg");
            if (expectOk) sum += q;
            assertEq(uint256(_claimedKg(P, Q)), sum, "P1 claimedKg = sum of accepted claims");
            assertLe(_claimedKg(P, Q), verifiedKg, "P1 claimedKg <= verifiedKg");
        }
    }

    /// @dev P1 across a revision: the revised credential must cover what is already claimed,
    /// the claimed quantity carries over, and later claims are capped by the new verifiedKg.
    function testFuzz_P1_revisionKeepsConservation(uint96 claimKg, uint96 newKg, uint96 extraKg) public {
        claimKg = uint96(bound(claimKg, 1, KG500));
        newKg = uint96(bound(newKg, 1, 2 * uint256(KG500)));
        extraKg = uint96(bound(extraKg, 1, 2 * uint256(KG500)));
        _reg1(KA, rid(1), P, Q, KG500, bytes32(0));
        assertTrue(_tryClaim(KA, batch(1), claimKg));

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(v1);
        try registry.registerReport(_input(KR, rid(1), P, Q, newKg, KA)) {
            assertGe(newKg, claimKg, "P1 revision accepted only if it covers the claimed quantity");
        } catch {
            assertLt(newKg, claimKg, "P1 revision refused only if it is below the claimed quantity");
            return;
        }
        assertEq(_claimedKg(P, Q), claimKg, "P1 claimed quantity carried over");
        assertFalse(_tryClaim(KA, batch(2), 1), "P1 superseded credential is not claimable");
        bool expectOk = uint256(claimKg) + extraKg <= newKg;
        assertEq(_tryClaim(KR, batch(3), extraKg), expectOk, "P1 cap is the revised verifiedKg");
        assertLe(_claimedKg(P, Q), newKg, "P1 claimedKg <= latest verifiedKg");
    }

    // ------------------------------------------------------------------- P2

    /// @dev P2: a batch key is claimed at most once, whatever report, quantity or time the
    /// second attempt uses, and the first shipment record is never overwritten.
    function testFuzz_P2_batchClaimedAtMostOnce(bytes32 batchKey, uint96 q1, uint96 q2, bool otherReport, uint32 dt)
        public
    {
        q1 = uint96(bound(q1, 1, 100_000));
        q2 = uint96(bound(q2, 1, 100_000));
        _reg1(KA, rid(1), P, Q, KG500, bytes32(0));
        _reg1(KB, rid(1), P, Q_E, KG500, bytes32(0));
        assertTrue(_tryClaim(KA, batchKey, q1), "first claim");
        (bytes32 rk, uint96 qty, bytes32 imp, uint64 at) = registry.shipments(batchKey);

        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 300 days));
        bytes32 second = otherReport ? KB : KA;
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.BatchAlreadyClaimed.selector, batchKey));
        registry.claimShipment(second, batchKey, q2, keccak256("importer-2"));

        (bytes32 rk2, uint96 qty2, bytes32 imp2, uint64 at2) = registry.shipments(batchKey);
        assertEq(rk2, rk, "P2 report unchanged");
        assertEq(qty2, qty, "P2 quantity unchanged");
        assertEq(imp2, imp, "P2 importer unchanged");
        assertEq(at2, at, "P2 claimedAt unchanged");
        assertEq(_claimedKg(P, Q) + _claimedKg(P, Q_E), q1, "P2 ledger counts the batch once");
    }

    // ------------------------------------------------------------------- P3

    /// @dev P3: registerReport succeeds exactly when, at that block, the sender is the current
    /// address of an active body (listed, not rotated away, not suspended, accreditation not
    /// expired) and the auditor belongs to that body and is not revoked.
    function testFuzz_P3_registrationIffAuthorizedAtBlock(uint8 flags) public {
        address sender = v1;
        bytes32 aid = AID_A;
        if (flags & 1 != 0) _suspend(L1);
        if (flags & 2 != 0) _revokeAuditorA();
        if (flags & 4 != 0) aid = AID_B; // auditor of another body
        if (flags & 8 != 0) {
            _rotate(L1, v1n); // v1 rotated away
        }
        if (flags & 16 != 0) sender = v5; // never listed
        if (flags & 32 != 0) vm.warp(ACCREDITED_UNTIL + 1);

        uint64 nowTs = uint64(vm.getBlockTimestamp());
        bool active = allowlist.isVerifierActiveAt(sender, nowTs);
        bool authorized = allowlist.isAuthorizedAt(aid, sender, nowTs);
        bool expectOk = (flags & 63) == 0;
        assertEq(active && authorized, expectOk, "fixture: conditions match the flags");

        EmissionsClaimRegistry.ReportInput memory r = _input(KA, rid(1), P2, Q2, KG500, bytes32(0));
        r.auditorAidHash = aid;
        r.validUntil = uint64(vm.getBlockTimestamp()) + 365 days;
        vm.prank(sender);
        try registry.registerReport(r) {
            assertTrue(expectOk, "P3 registered although not authorised");
            EmissionsClaimRegistry.ReportRecord memory rec = registry.reports(KA);
            assertEq(rec.verifier, sender, "P3 record names the sender");
            assertEq(rec.registeredAt, nowTs, "P3 registered at this block");
            assertTrue(allowlist.isVerifierActiveAt(rec.verifier, rec.registeredAt), "P3 active at registeredAt");
            assertTrue(
                allowlist.isAuthorizedAt(rec.auditorAidHash, rec.verifier, rec.registeredAt),
                "P3 auditor authorised at registeredAt"
            );
            (bytes32 lei,,) = allowlist.leiOfAddress(sender);
            assertEq(rec.issuerLeiHash, lei, "P3 issuer is the sender's body");
        } catch {
            assertFalse(expectOk, "P3 refused although authorised");
        }
    }

    // ------------------------------------------------------------------- P6

    /// @dev P6: an auditor revocation, once synced on-chain, is never undone: the auditor stays
    /// unauthorised at every later time, cannot be added again under that body, and no report
    /// can be registered with it, even after the body's suspension is lifted. A report
    /// registered before the sync keeps its on-chain validity (CONTESTED is decided off-chain).
    function testFuzz_P6_auditorRevocationIsPermanent(uint32 dtBefore, uint32 dtAfter, bool suspendAndLift) public {
        _reg1(KA, rid(1), P, Q, KG500, bytes32(0));
        vm.warp(vm.getBlockTimestamp() + bound(dtBefore, 1, 30 days));
        _revokeAuditorA();
        (, uint64 addedAt, uint64 revokedAt) = allowlist.auditors(AID_A, L1);
        assertEq(revokedAt, uint64(vm.getBlockTimestamp()));

        vm.warp(vm.getBlockTimestamp() + bound(dtAfter, 0, 1000 days));
        if (suspendAndLift) {
            _suspend(L1);
            vm.warp(vm.getBlockTimestamp() + 1);
            _lift(L1);
        }
        uint64 nowTs = uint64(vm.getBlockTimestamp());
        (, uint64 addedAt2, uint64 revokedAt2) = allowlist.auditors(AID_A, L1);
        assertEq(addedAt2, addedAt, "P6 addedAt fixed");
        assertEq(revokedAt2, revokedAt, "P6 revokedAt fixed");
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, nowTs), "P6 still unauthorised");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AuditorExists.selector, AID_A, L1));
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(AID_A, L1, keccak256("ECR-A-again")));

        EmissionsClaimRegistry.ReportInput memory r = _input(KB, rid(2), P2, Q2, KG500, bytes32(0));
        r.validUntil = nowTs + 365 days;
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AuditorNotAuthorized.selector, AID_A, v1));
        registry.registerReport(r);

        if (nowTs <= VALID_UNTIL) assertTrue(registry.isValid(KA), "P6 earlier report keeps on-chain validity");
    }

    /// @dev P6 for reports: a report revocation is never undone; the report is invalid at every
    /// time, including its own registration time.
    function testFuzz_P6_reportRevocationIsPermanent(uint32 dt, uint64 t) public {
        _reg1(KA, rid(1), P, Q, KG500, bytes32(0));
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 300 days));
        vm.prank(v1);
        registry.revokeReport(KA);
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AlreadyRevoked.selector, KA));
        registry.revokeReport(KA);
        assertFalse(registry.isValidAt(KA, t), "P6 revoked report invalid at any t");
        assertFalse(_tryClaim(KA, batch(1), 1), "P6 revoked report not claimable");
    }

    function _revokeAuditorA() internal {
        vm.prank(watcher);
        allowlist.revokeAuditor(AID_A, L1);
    }
}
