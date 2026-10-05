// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice B3 two-layer keys, supersede (branch b), B' cross-body takeover, O3-A whole-report
/// replacement and O7-A report-layer takeover (branch c). Spec: 12 §3.2 / §5 / §7 scenarios 1–9,
/// plus M0.5 addendum (O7-A, C93–C99, §6 check order and SupersedeMismatch parameters).
contract SupersedeTest is Base {
    bytes32 internal constant ZERO = bytes32(0);

    // ------------------------------------------------------------------ helpers

    function _in1(bytes32 k, bytes32 id, bytes32 scope, bytes32 cs, uint96 kg, bytes32 sup)
        internal
        view
        returns (EmissionsClaimRegistry.ReportInput memory r)
    {
        r = _input(k, id, scope, cs, kg, sup);
    }

    function _in2(bytes32 k, bytes32 id, bytes32 scope, bytes32 cs, uint96 kg, bytes32 sup)
        internal
        view
        returns (EmissionsClaimRegistry.ReportInput memory r)
    {
        r = _input(k, id, scope, cs, kg, sup);
        r.auditorAidHash = AID_B;
    }

    function _expectRevertReg(address caller, EmissionsClaimRegistry.ReportInput memory r, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(caller);
        registry.registerReport(r);
    }

    function _expectRevertClaim(address caller, bytes32 k, bytes32 b, uint96 kg, bytes memory err) internal {
        bytes32 commit = keccak256(abi.encode("importer", b));
        vm.expectRevert(err);
        vm.prank(caller);
        registry.claimShipment(k, b, kg, commit);
    }

    function _revoke(address caller, bytes32 k) internal {
        vm.prank(caller);
        registry.revokeReport(k);
    }

    function _assertP(bytes32 p, bytes32 id, bytes32 latest) internal view {
        (bytes32 a, bytes32 b,) = registry.reportScopes(p);
        assertEq(a, id, "reportScopes.reportIdHash");
        assertEq(b, latest, "reportScopes.latestReportKey");
    }

    function _assertQ(bytes32 q, uint96 claimed, bytes32 latest) internal view {
        (uint96 c, bytes32 l) = registry.credScopes(scopeOf(q), q);
        assertEq(c, claimed, "credScopes.claimedKg");
        assertEq(l, latest, "credScopes.latestReportKey");
    }

    function _issuer(bytes32 k) internal view returns (bytes32 v) {
        v = registry.reports(k).issuerLeiHash;
    }

    function _supplierOf(bytes32 k) internal view returns (address v) {
        v = registry.reports(k).supplier;
    }

    function _registeredAt(bytes32 k) internal view returns (uint64 v) {
        v = registry.reports(k).registeredAt;
    }

    function _revokedAt(bytes32 k) internal view returns (uint64 v) {
        v = registry.reports(k).revokedAt;
    }

    function _supersedesOf(bytes32 k) internal view returns (bytes32 v) {
        v = registry.reports(k).supersedes;
    }

    function _supersededBy(bytes32 k) internal view returns (bytes32 v) {
        v = registry.reports(k).supersededBy;
    }

    function _reportValid(bytes32 b) internal view returns (bool v) {
        (,,,,, v) = registry.shipmentStatus(b);
    }

    function _claimedAt(bytes32 b) internal view returns (uint64 v) {
        (,,,, v,) = registry.shipmentStatus(b);
    }

    function _unbound(bytes32 p, bytes32 id) internal view returns (uint64) {
        return registry.reportIdUnboundAt(p, id);
    }

    function _susp(bytes32 lei) internal view returns (uint64 s, uint64 l) {
        (,,,,, s, l) = allowlist.institutions(lei);
    }

    /// @dev With via_ir, block.timestamp is treated as a constant within the test transaction and keeps its pre-warp value, so the current time is always read through the cheatcode.
    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _tick() internal {
        vm.warp(vm.getBlockTimestamp() + 100);
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(registry) && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) n++;
        }
    }

    function _errPeriod(bytes32 p, bytes32 id) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.PeriodAlreadyCovered.selector, p, id);
    }

    function _errMismatch(bytes32 expected, bytes32 given) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.SupersedeMismatch.selector, expected, given);
    }

    function _errIssuer(address caller, bytes32 lei) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.NotReportIssuer.selector, caller, lei);
    }

    function _errOver(bytes32 q, uint96 claimed, uint96 kg) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.SupersedeOverClaimed.selector, q, claimed, kg);
    }

    function _errExceeds(uint96 remaining, uint96 requested) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.ExceedsVerifiedTonnage.selector, remaining, requested);
    }

    function _errInvalid(bytes32 k) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.ReportInvalid.selector, k);
    }

    function _errRetired(bytes32 p, bytes32 id) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.ReportIdRetired.selector, p, id);
    }

    function _errInactive(address v) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v);
    }

    // ================================================================ scenarios

    /// Scenario 1: register -> claim -> revoke -> revision supersede -> over-claim rejected (C19, C29, C35)
    function test_scenario1_registerClaimRevokeSupersedeOverClaim() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");

        // 1. V1 registers K1: R1, P, Q, 500,000
        uint64 t1 = _now();
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _assertP(P, rid(1), K1);
        (,, uint64 boundAt) = registry.reportScopes(P);
        assertEq(boundAt, t1);
        _assertQ(Q, 0, K1);
        assertEq(registry.remainingKg(K1), 500_000);
        assertEq(_issuer(K1), L1);

        // 2. S claims B1 200,000
        _tick();
        _claim(supplier, K1, batch(1), 200_000);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 200_000, K1);
        assertEq(registry.remainingKg(K1), 300_000);

        // 3. V1 revokes K1: neither layer is released
        _tick();
        _revoke(v1, K1);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 200_000, K1);
        assertFalse(registry.isValid(K1));
        assertFalse(_reportValid(batch(1)));
        assertEq(registry.remainingKg(K1), 0);

        // 4. Claiming against revoked K1 -> ReportInvalid
        _expectRevertClaim(supplier, K1, batch(2), 100_000, _errInvalid(K1));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 200_000, K1);

        // 5. V1 revision K2: R2, 450,000, supersedes K1
        _tick();
        uint64 t5 = _now();
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportSuperseded(K1, K2, Q, 200_000, 450_000);
        _reg1(K2, rid(2), P, Q, 450_000, K1);
        _assertP(P, rid(2), K2);
        assertEq(_unbound(P, rid(1)), t5);
        (,, boundAt) = registry.reportScopes(P);
        assertEq(boundAt, t1); // only the first binding is recorded
        _assertQ(Q, 200_000, K2);
        assertEq(_supersededBy(K1), K2);
        assertEq(registry.remainingKg(K2), 250_000);

        // 6. Over-claim -> ExceedsVerifiedTonnage(250,000, 300,000)
        _expectRevertClaim(supplier, K2, batch(3), 300_000, _errExceeds(250_000, 300_000));
        _assertQ(Q, 200_000, K2);

        // 7. Exactly exhausted
        _claim(supplier, K2, batch(3), 250_000);
        _assertQ(Q, 450_000, K2);
        assertEq(registry.remainingKg(K2), 0);

        // 8. One more kg
        _expectRevertClaim(supplier, K2, batch(4), 1, _errExceeds(0, 1));
        _assertQ(Q, 450_000, K2);
    }

    /// Scenario 2: another verification body registers for the same facility and period (C28, C30, C34, C72, C81)
    function test_scenario2_secondBodySameScope() public {
        bytes32 K1 = key("K1");
        bytes32 K3 = key("K3");
        bytes32 K4 = key("K4");

        // 1
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 2. V2 without supersedes -> PeriodAlreadyCovered(P, R1)
        _expectRevertReg(v2, _in2(K3, rid(3), P, Q, 600_000, ZERO), _errPeriod(P, rid(1)));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 3. V1 revokes K1
        _tick();
        _revoke(v1, K1);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 4. Same result after the revoke
        _expectRevertReg(v2, _in2(K3, rid(3), P, Q, 600_000, ZERO), _errPeriod(P, rid(1)));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 5. V2 with supersedes K1: L1 is still valid -> NotReportIssuer(V2, L1)
        _expectRevertReg(v2, _in2(K3, rid(3), P, Q, 600_000, K1), _errIssuer(v2, L1));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);
        assertEq(_supersededBy(K1), ZERO);

        // 6. V2 registers a different period P2 -> succeeds, P unaffected
        _reg2(K4, rid(4), P2, Q2, 500_000, ZERO);
        _assertP(P2, rid(4), K4);
        _assertQ(Q2, 0, K4);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);
    }

    /// Scenario 3: revision verifiedKg below the cumulative claimed amount (C36)
    function test_scenario3_revisionBelowClaimed() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");

        // 1
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 2
        _tick();
        _claim(supplier, K1, batch(1), 200_000);
        _assertQ(Q, 200_000, K1);

        // 3. 150,000 < 200,000 → SupersedeOverClaimed(Q, 200,000, 150,000)
        _tick();
        _expectRevertReg(v1, _in1(K2, rid(2), P, Q, 150_000, K1), _errOver(Q, 200_000, 150_000));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 200_000, K1);
        assertTrue(registry.isValid(K1));
        assertEq(_revokedAt(K1), 0);
        assertEq(_unbound(P, rid(1)), 0);

        // 4. K1 is still latest, the remaining 300,000 is used up
        _claim(supplier, K1, batch(2), 300_000);
        _assertQ(Q, 500_000, K1);

        // 5. 200,000 < 500,000
        _expectRevertReg(v1, _in1(K2, rid(2), P, Q, 200_000, K1), _errOver(Q, 500_000, 200_000));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 500_000, K1);

        // 6. 500,000 -> succeeds
        _tick();
        _reg1(K2, rid(2), P, Q, 500_000, K1);
        _assertP(P, rid(2), K2);
        _assertQ(Q, 500_000, K2);
        assertEq(registry.remainingKg(K2), 0);
        assertEq(registry.remainingKg(K1), 0);
    }

    /// Scenario 4: same report, same CN, two cbamRoutes (C33, C47)
    function test_scenario4_twoRoutesSameReport() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        bytes32 K5 = key("K5");

        // 1
        _reg1(K1, rid(1), P, Q, 300_000, ZERO);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 2. Same R1, Q' (route E)
        _reg1(K2, rid(1), P, Q_E, 200_000, ZERO);
        _assertP(P, rid(1), K2);
        _assertQ(Q_E, 0, K2);
        _assertQ(Q, 0, K1);
        assertEq(_unbound(P, rid(1)), 0);

        // 3. Second certificate for the same report in the same credential layer -> CredScopeAlreadyCovered(Q, K1)
        _expectRevertReg(
            v1,
            _in1(K5, rid(1), P, Q, 300_000, ZERO),
            abi.encodeWithSelector(EmissionsClaimRegistry.CredScopeAlreadyCovered.selector, Q, K1)
        );
        _assertP(P, rid(1), K2);
        _assertQ(Q, 0, K1);

        // 4
        _tick();
        _claim(supplier, K1, batch(1), 300_000);
        _assertQ(Q, 300_000, K1);
        _assertQ(Q_E, 0, K2);

        // 5
        _claim(supplier, K2, batch(2), 200_000);
        _assertQ(Q, 300_000, K1);
        _assertQ(Q_E, 200_000, K2);

        // 6. Q' quota cannot be lent to Q
        _expectRevertClaim(supplier, K1, batch(3), 1, _errExceeds(0, 1));
        _assertQ(Q, 300_000, K1);
        _assertQ(Q_E, 200_000, K2);
    }

    /// Scenario 5: revision of multiple certificates (C53, C57, C59)
    function test_scenario5_multiCredentialRevision() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        bytes32 K1p = key("K1'");
        bytes32 K2p = key("K2'");

        // 1
        _reg1(K1, rid(1), P, Q, 300_000, ZERO);
        _reg1(K2, rid(1), P, Q_E, 200_000, ZERO);
        _assertP(P, rid(1), K2);
        _assertQ(Q, 0, K1);
        _assertQ(Q_E, 0, K2);

        // 2
        _tick();
        _claim(supplier, K1, batch(1), 100_000);
        _claim(supplier, K2, batch(2), 50_000);
        _assertQ(Q, 100_000, K1);
        _assertQ(Q_E, 50_000, K2);

        // 3. K1': R2, Q, 280,000, supersedes K1
        _tick();
        uint64 t3 = _now();
        _reg1(K1p, rid(2), P, Q, 280_000, K1);
        _assertP(P, rid(2), K1p);
        assertEq(_unbound(P, rid(1)), t3);
        _assertQ(Q, 100_000, K1p);
        _assertQ(Q_E, 50_000, K2);
        assertEq(_supersededBy(K1), K1p);

        // 4. Whole-report replacement: K2 becomes invalid immediately (K2 is not superseded)
        assertFalse(registry.isValid(K2));
        assertEq(_supersededBy(K2), ZERO);

        // 5. Claim K2 -> ReportInvalid
        _expectRevertClaim(supplier, K2, batch(3), 10_000, _errInvalid(K2));
        _assertQ(Q_E, 50_000, K2);

        // 6. K2': R2, Q', 200,000, supersedes K2
        _tick();
        _reg1(K2p, rid(2), P, Q_E, 200_000, K2);
        _assertP(P, rid(2), K2p);
        _assertQ(Q_E, 50_000, K2p);
        _assertQ(Q, 100_000, K1p);
        assertTrue(registry.isValid(K2p));
        assertTrue(registry.isValid(K1p));

        // 7. B2 (step 2, earlier than t3) remains valid
        assertTrue(_reportValid(batch(2)));
        assertLt(_claimedAt(batch(2)), t3);
        assertTrue(registry.isValidAt(K2, _claimedAt(batch(2))));
    }

    /// Scenario 6: revoke and revision after the verification body rotates its address (C2, C3, C26, C49, C74, C72)
    function test_scenario6_rotationRevokeAndRevise() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        bytes32 K3 = key("K3");
        bytes32 K6 = key("K6");

        // 1
        uint64 t0 = _now();
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);
        assertEq(_issuer(K1), L1);
        address verifierOfK1 = registry.reports(K1).verifier;
        assertEq(verifierOfK1, v1);

        // 2. owner rotates L1 -> V1n
        _tick();
        uint64 t2 = _now();
        _rotate(L1, v1n);
        (bytes32 lb, uint64 bAt, uint64 uAt) = allowlist.leiOfAddress(v1);
        assertEq(lb, L1);
        assertLe(bAt, t0);
        assertEq(uAt, t2);
        (lb, bAt, uAt) = allowlist.leiOfAddress(v1n);
        assertEq(lb, L1);
        assertEq(bAt, t2);
        assertEq(uAt, 0);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 3. Old address registers -> NotActiveVerifier(V1)
        _expectRevertReg(v1, _in1(K6, rid(6), P2, Q2, 1_000, ZERO), _errInactive(v1));

        // 4. S claims K1 (authorization is not recomputed)
        _claim(supplier, K1, batch(1), 100_000);
        _assertQ(Q, 100_000, K1);

        // 5. Old key revokes -> NotActiveVerifier(V1)
        vm.expectRevert(_errInactive(v1));
        vm.prank(v1);
        registry.revokeReport(K1);
        assertEq(_revokedAt(K1), 0);

        // 6. New key revokes -> succeeds
        _tick();
        uint64 t6 = _now();
        _revoke(v1n, K1);
        assertEq(_revokedAt(K1), t6);
        _assertP(P, rid(1), K1);
        _assertQ(Q, 100_000, K1);

        // 7. V1n revises with AID-a -> succeeds
        _tick();
        _register(v1n, _in1(K2, rid(2), P, Q, 500_000, K1));
        _assertP(P, rid(2), K2);
        _assertQ(Q, 100_000, K2);
        assertEq(_issuer(K2), L1);
        assertEq(_supersededBy(K1), K2);

        // 8. V2 supersede K2 → NotReportIssuer(V2, L1)
        _expectRevertReg(v2, _in2(K3, rid(3), P, Q, 500_000, K2), _errIssuer(v2, L1));
        _assertP(P, rid(2), K2);
        _assertQ(Q, 100_000, K2);
    }

    /// Scenario 7: B' takeover - after the original issuer is suspended, another body supersedes and fills in the supplier itself (C71, C78, C79, C81)
    function test_scenario7_takeoverAfterSuspension() public {
        address X = makeAddr("supplierX");
        bytes32 K9 = key("K9");
        bytes32 K1 = key("K1");
        bytes32 K1p = key("K1'");
        bytes32 K3 = key("K3");
        bytes32 K10 = key("K10");

        // 1. V2 squats K9 first: R9, P, Q, 1 kg, supplier X
        EmissionsClaimRegistry.ReportInput memory r = _in2(K9, rid(9), P, Q, 1, ZERO);
        r.supplier = X;
        _register(v2, r);
        _assertP(P, rid(9), K9);
        _assertQ(Q, 0, K9);

        // 2. V1 supersedes K9: L2 still valid -> NotReportIssuer(V1, L2)
        _expectRevertReg(v1, _in1(K1, rid(1), P, Q, 500_000, K9), _errIssuer(v1, L2));
        _assertP(P, rid(9), K9);
        _assertQ(Q, 0, K9);

        // 3. WATCHER suspends L2
        _tick();
        uint64 t3 = _now();
        _suspend(L2);
        (uint64 s, uint64 l) = _susp(L2);
        assertEq(s, t3);
        assertEq(l, 0);
        _assertP(P, rid(9), K9);

        // 4. V1 takeover: B' (ii), supplier changed to S
        _tick();
        uint64 t4 = _now();
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportSuperseded(K9, K1, Q, 0, 500_000);
        _reg1(K1, rid(1), P, Q, 500_000, K9);
        _assertP(P, rid(1), K1);
        assertEq(_unbound(P, rid(9)), t4);
        _assertQ(Q, 0, K1);
        assertEq(_supersededBy(K9), K1);
        assertEq(_supplierOf(K1), supplier);
        assertEq(_issuer(K9), L2);
        assertEq(_issuer(K1), L1);

        // 5. V1 same-body revision, supplier changed to S2
        _tick();
        r = _in1(K1p, rid(2), P, Q, 480_000, K1);
        r.supplier = supplier2;
        _register(v1, r);
        _assertP(P, rid(2), K1p);
        _assertQ(Q, 0, K1p);
        assertEq(_supplierOf(K1p), supplier2);

        // 6. WATCHER lifts the suspension of L2
        _tick();
        uint64 t6 = _now();
        _lift(L2);
        (s, l) = _susp(L2);
        assertEq(s, t3);
        assertEq(l, t6);

        // 7. V2 tries to take it back: L1 valid -> NotReportIssuer(V2, L1)
        _expectRevertReg(v2, _in2(K3, rid(3), P, Q, 500_000, K1p), _errIssuer(v2, L1));
        _assertP(P, rid(2), K1p);
        _assertQ(Q, 0, K1p);
        assertEq(_supersededBy(K9), K1);

        // 8. WATCHER suspends L1
        _tick();
        _suspend(L1);

        // 9. V2 uses the old R9 -> ReportIdRetired(P, R9)
        _expectRevertReg(v2, _in2(K10, rid(9), P, Q, 500_000, K1p), _errRetired(P, rid(9)));
        _assertP(P, rid(2), K1p);
        _assertQ(Q, 0, K1p);
        assertEq(_unbound(P, rid(9)), t4); // written once, unchanged afterwards
    }

    /// Scenario 8: suspend -> rotate -> lift -> suspend again (C73, C83)
    function test_scenario8_suspendRotateLiftResuspend() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");

        // 1
        uint64 t1 = _now();
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        assertTrue(registry.isValid(K1));

        // 2. Suspend L1
        _tick();
        uint64 t2 = _now();
        _suspend(L1);
        (uint64 s, uint64 l) = _susp(L1);
        assertEq(s, t2);
        assertEq(l, 0);
        assertTrue(registry.isValid(K1));

        // 3. Rotate: the suspension field is untouched
        _tick();
        uint64 t3 = _now();
        _rotate(L1, v1n);
        (address cur,,,,,,) = allowlist.institutions(L1);
        assertEq(cur, v1n);
        (s, l) = _susp(L1);
        assertEq(s, t2);
        assertEq(l, 0);

        // 4. V1n registers -> NotActiveVerifier(V1n)
        _expectRevertReg(v1n, _in1(K2, rid(2), P, Q, 500_000, K1), _errInactive(v1n));
        _assertP(P, rid(1), K1);
        _assertQ(Q, 0, K1);

        // 5. V1n revokes -> NotActiveVerifier(V1n)
        vm.expectRevert(_errInactive(v1n));
        vm.prank(v1n);
        registry.revokeReport(K1);
        assertEq(_revokedAt(K1), 0);

        // 6. Lift
        _tick();
        uint64 t6 = _now();
        _lift(L1);
        (s, l) = _susp(L1);
        assertEq(s, t2);
        assertEq(l, t6);
        assertFalse(allowlist.isVerifierActiveAt(v1n, t3));
        assertFalse(allowlist.isVerifierActiveAt(v1n, t6 - 1));
        assertTrue(allowlist.isVerifierActiveAt(v1n, t6));
        assertTrue(registry.isValid(K1));
        assertTrue(registry.isValidAt(K1, t1));
        assertTrue(registry.isValidAt(K1, t3));

        // 7. V1n revises -> succeeds
        _tick();
        _register(v1n, _in1(K2, rid(2), P, Q, 500_000, K1));
        _assertP(P, rid(2), K2);
        _assertQ(Q, 0, K2);

        // 8. Second suspension
        _tick();
        uint64 t8 = _now();
        _suspend(L1);
        (s, l) = _susp(L1);
        assertEq(s, t8);
        assertEq(l, 0);

        // 9. Lift, then lift again -> NotSuspended(L1)
        _tick();
        uint64 t9 = _now();
        _lift(L1);
        (s, l) = _susp(L1);
        assertEq(l, t9);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotSuspended.selector, L1));
        vm.prank(watcher);
        allowlist.liftSuspension(L1);
    }

    /// Scenario 9: cross-scope report-ID griefing is blocked (C79, C80)
    function test_scenario9_crossScopeGriefingBlocked() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        bytes32 K3 = key("K3");
        bytes32 K4 = key("K4");
        bytes32 K8 = key("K8");
        bytes32 K8p = key("K8'");

        // 1
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _assertP(P, rid(1), K1);

        // 2
        _tick();
        _claim(supplier, K1, batch(1), 100_000);
        _assertQ(Q, 100_000, K1);

        // 3. V2 registers R1 under its own P9
        _tick();
        _reg2(K8, rid(1), P9, Q_P9, 1, ZERO);
        _assertP(P9, rid(1), K8);
        _assertP(P, rid(1), K1);

        // 4. V2 rebinds R8 in P9
        _tick();
        uint64 t4 = _now();
        _reg2(K8p, rid(8), P9, Q_P9, 1, K8);
        _assertP(P9, rid(8), K8p);
        assertEq(_unbound(P9, rid(1)), t4);
        assertEq(_unbound(P, rid(1)), 0);
        _assertP(P, rid(1), K1);

        // 5
        assertTrue(registry.isValid(K1));
        assertTrue(_reportValid(batch(1)));

        // 6. Second certificate for the same report
        _reg1(K2, rid(1), P, Q_E, 200_000, ZERO);
        _assertP(P, rid(1), K2);
        _assertQ(Q_E, 0, K2);

        // 7. V1 revises K1 -> R2
        _tick();
        uint64 t7 = _now();
        _reg1(K3, rid(2), P, Q, 480_000, K1);
        _assertP(P, rid(2), K3);
        assertEq(_unbound(P, rid(1)), t7);
        _assertQ(Q, 100_000, K3);

        // Afterwards V1 registering P with R1 again -> ReportIdRetired(P, R1)
        _expectRevertReg(v1, _in1(K4, rid(1), P, Q10, 1_000, ZERO), _errRetired(P, rid(1)));
    }

    // ================================================================ unit: C numbers

    // ---- C28: second report in the same scope
    function test_C28_PeriodAlreadyCovered_secondReportSameScope() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _expectRevertReg(v2, _in2(key("K3"), rid(3), P, Q, 600_000, ZERO), _errPeriod(P, rid(1)));
        _assertP(P, rid(1), key("K1"));
    }

    function test_C28_PeriodAlreadyCovered_sameBodyNewIdOtherLayer() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _expectRevertReg(v1, _in1(key("K2"), rid(2), P, Q_E, 100_000, ZERO), _errPeriod(P, rid(1)));
        _assertQ(Q_E, 0, ZERO);
    }

    // ---- C29: supersede a revoked report
    function test_C29_supersedeRevokedReport_succeeds() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _revoke(v1, K1);
        _tick();
        _reg1(K2, rid(2), P, Q, 450_000, K1);
        assertEq(_supersededBy(K1), K2);
        assertEq(_supersedesOf(K2), K1);
        assertTrue(registry.isValid(K2));
        assertFalse(registry.isValid(K1));
        _assertP(P, rid(2), K2);
        _assertQ(Q, 0, K2);
    }

    // ---- C30: different periods coexist
    function test_C30_differentPeriodCoexists() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _reg2(key("K4"), rid(4), P2, Q2, 500_000, ZERO);
        _assertP(P, rid(1), key("K1"));
        _assertP(P2, rid(4), key("K4"));
        assertTrue(registry.isValid(key("K1")));
        assertTrue(registry.isValid(key("K4")));
    }

    // ---- C33: both routes of the same report can register
    function test_C33_twoRoutesSameReportBothRegister() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _reg1(key("K2"), rid(1), P, Q_E, 200_000, ZERO);
        _assertQ(Q, 0, key("K1"));
        _assertQ(Q_E, 0, key("K2"));
        _assertP(P, rid(1), key("K2"));
        assertTrue(registry.isValid(key("K1")));
        assertTrue(registry.isValid(key("K2")));
    }

    // ---- C34: revoke does not release the report scope
    function test_C34_PeriodAlreadyCovered_afterRevoke() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _revoke(v1, key("K1"));
        _expectRevertReg(v2, _in2(key("K3"), rid(3), P, Q, 600_000, ZERO), _errPeriod(P, rid(1)));
        _assertP(P, rid(1), key("K1"));
        _assertQ(Q, 0, key("K1"));
    }

    // ---- C35: claimedKg is preserved across revisions
    function test_C35_claimedKgCarriedOverRevision() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, K1, batch(1), 200_000);
        _tick();
        _revoke(v1, K1);
        _tick();
        _reg1(K2, rid(2), P, Q, 450_000, K1);
        _assertQ(Q, 200_000, K2);
        assertEq(registry.remainingKg(K2), 250_000);
        _expectRevertClaim(supplier, K2, batch(2), 250_001, _errExceeds(250_000, 250_001));
        _claim(supplier, K2, batch(2), 250_000);
        _assertQ(Q, 450_000, K2);
    }

    // ---- C36: revision below the cumulative amount
    function test_C36_SupersedeOverClaimed() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, key("K1"), batch(1), 200_000);
        _expectRevertReg(v1, _in1(key("K2"), rid(2), P, Q, 150_000, key("K1")), _errOver(Q, 200_000, 150_000));
        _assertP(P, rid(1), key("K1"));
        _assertQ(Q, 200_000, key("K1"));
        assertTrue(registry.isValid(key("K1")));
    }

    function test_C36_revisionEqualToClaimed_succeeds() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, key("K1"), batch(1), 200_000);
        _tick();
        _reg1(key("K2"), rid(2), P, Q, 200_000, key("K1"));
        _assertQ(Q, 200_000, key("K2"));
        assertEq(registry.remainingKg(key("K2")), 0);
    }

    // ---- C47: second certificate in the same credential layer for the same report
    function test_C47_CredScopeAlreadyCovered_sameReportSameLayer() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _expectRevertReg(
            v1,
            _in1(key("K5"), rid(1), P, Q, 300_000, ZERO),
            abi.encodeWithSelector(EmissionsClaimRegistry.CredScopeAlreadyCovered.selector, Q, key("K1"))
        );
        _assertQ(Q, 0, key("K1"));
    }

    // ---- C48: (b) supersedes is not the latest of that credential layer (points to another credential layer)
    function test_C48_SupersedeMismatch_pointsToOtherCredLayer() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _reg1(key("K2"), rid(1), P, Q_E, 200_000, ZERO);
        _expectRevertReg(v1, _in1(key("K3"), rid(1), P, Q, 300_000, key("K2")), _errMismatch(key("K1"), key("K2")));
        _assertQ(Q, 0, key("K1"));
        _assertQ(Q_E, 0, key("K2"));
    }

    /// C48's "empty credential layer + supersedes" case uses the given of C95 (freeze addendum A-14)
    function test_C48_SupersedeMismatch_emptyLayerSameId() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _expectRevertReg(v1, _in1(key("K2"), rid(1), P, Q_E, 200_000, key("K1")), _errMismatch(ZERO, key("K1")));
        _assertQ(Q_E, 0, ZERO);
    }

    // ---- C49: after a multi-hop rotation, the new address revokes and revises; the auditor need not be re-added
    function test_C49_multiHopRotation_reviseWithSameAuditor() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _rotate(L1, v1n);
        _tick();
        _rotate(L1, v1nn);
        // the intermediate address is also invalid
        vm.expectRevert(_errInactive(v1n));
        vm.prank(v1n);
        registry.revokeReport(K1);
        _tick();
        _revoke(v1nn, K1);
        _tick();
        _register(v1nn, _in1(K2, rid(2), P, Q, 500_000, K1));
        _assertP(P, rid(2), K2);
        _assertQ(Q, 0, K2);
        assertEq(_issuer(K2), L1);
        assertEq(_supersededBy(K1), K2);
        address verifierOfK2 = registry.reports(K2).verifier;
        assertEq(verifierOfK2, v1nn);
    }

    function test_C49_rotatedAddressRevisesWithoutRevoke() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, K1, batch(1), 100_000);
        _tick();
        _rotate(L1, v1n);
        _tick();
        _register(v1n, _in1(K2, rid(2), P, Q, 500_000, K1));
        _assertQ(Q, 100_000, K2);
        assertEq(_supersededBy(K1), K2);
    }

    // ---- C52: superseded (not revoked) certificate
    function test_C52_supersededValidReport_invalidAndNoHeadroom() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, K1, batch(1), 100_000);
        uint64 before = _now();
        _tick();
        uint64 tS = _now();
        // Revision with the same report ID: the report scope is not rebound, so "superseded" is the only invalidation reason
        _reg1(K2, rid(1), P, Q, 500_000, K1);
        assertEq(_revokedAt(K1), 0);
        assertEq(_supersededBy(K1), K2);
        assertFalse(registry.isValid(K1));
        assertTrue(registry.isValidAt(K1, before));
        assertTrue(registry.isValidAt(K1, tS - 1));
        assertFalse(registry.isValidAt(K1, tS));
        assertEq(registry.remainingKg(K1), 0);
        assertEq(registry.remainingKg(K2), 400_000);
        assertTrue(registry.isValid(K2));
        _expectRevertClaim(supplier, K1, batch(2), 1, _errInvalid(K1));
        _assertP(P, rid(1), K2);
        _assertQ(Q, 100_000, K2);
        assertEq(_unbound(P, rid(1)), 0);
    }

    function test_C52_supersededWithNewId_invalid() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg1(K2, rid(2), P, Q, 500_000, K1);
        assertFalse(registry.isValid(K1));
        assertEq(registry.remainingKg(K1), 0);
        assertEq(_supersededBy(K1), K2);
        _expectRevertClaim(supplier, K1, batch(1), 1, _errInvalid(K1));
    }

    // ---- C53: shipments before being superseded remain valid
    function test_C53_shipmentBeforeSupersedeStillValid() public {
        bytes32 K1 = key("K1");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, K1, batch(1), 100_000);
        uint64 claimedAt = _claimedAt(batch(1));
        _tick();
        _reg1(key("K2"), rid(2), P, Q, 500_000, K1);
        assertTrue(_reportValid(batch(1)));
        assertTrue(registry.isValidAt(K1, claimedAt));
        assertFalse(registry.isValid(K1));
    }

    // ---- C56: supersedes points to an already-superseded old certificate
    function test_C56_SupersedeMismatch_alreadySupersededOld() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg1(key("K2"), rid(1), P, Q, 500_000, key("K1"));
        _expectRevertReg(v1, _in1(key("K3"), rid(1), P, Q, 500_000, key("K1")), _errMismatch(key("K2"), key("K1")));
        _assertQ(Q, 0, key("K2"));
        _assertP(P, rid(1), key("K2"));
    }

    function test_C56_SupersedeMismatch_alreadySupersededOld_afterIdChange() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg1(key("K2"), rid(2), P, Q, 500_000, key("K1"));
        // Passing the report scope requires the currently bound R2; the credential layer then rejects with SupersedeMismatch(K2, K1)
        _expectRevertReg(v1, _in1(key("K3"), rid(2), P, Q, 500_000, key("K1")), _errMismatch(key("K2"), key("K1")));
        _assertQ(Q, 0, key("K2"));
    }

    // ---- C57: PeriodAlreadyCovered second path (supersedes belongs to the old report ID)
    function test_C57_PeriodAlreadyCovered_staleCredentialOfOldReport() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _reg1(key("K2"), rid(1), P, Q_E, 200_000, ZERO);
        _tick();
        _reg1(key("K1'"), rid(2), P, Q, 280_000, key("K1"));
        _expectRevertReg(v1, _in1(key("K3"), rid(3), P, Q_E, 200_000, key("K2")), _errPeriod(P, rid(2)));
        _assertP(P, rid(2), key("K1'"));
        _assertQ(Q_E, 0, key("K2"));
    }

    // ---- C58: cross-body supersede, original body still valid (not revoked)
    function test_C58_crossBodySupersede_activeIssuer_reverts() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _expectRevertReg(v2, _in2(key("K3"), rid(3), P, Q, 500_000, key("K1")), _errIssuer(v2, L1));
        _assertP(P, rid(1), key("K1"));
        assertTrue(registry.isValid(key("K1")));
    }

    // ---- C59: whole-report replacement; another certificate is invalid until re-filled
    function test_C59_wholeReportReplaced_otherCredInvalidUntilRevised() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _reg1(key("K2"), rid(1), P, Q_E, 200_000, ZERO);
        _tick();
        _claim(supplier, key("K2"), batch(1), 50_000);
        _tick();
        _reg1(key("K1'"), rid(2), P, Q, 280_000, key("K1"));
        assertFalse(registry.isValid(key("K2")));
        // F-9: remainingKg ignores isValid and still returns the book balance
        assertEq(registry.remainingKg(key("K2")), 150_000);
        _expectRevertClaim(supplier, key("K2"), batch(2), 10_000, _errInvalid(key("K2")));
        _tick();
        _reg1(key("K2'"), rid(2), P, Q_E, 200_000, key("K2"));
        assertTrue(registry.isValid(key("K2'")));
        _claim(supplier, key("K2'"), batch(2), 10_000);
        _assertQ(Q_E, 60_000, key("K2'"));
    }

    // ---- C71: B' (ii) takeover
    function test_C71_takeoverAfterSuspension_supplierRefilled() public {
        address X = makeAddr("supplierX");
        EmissionsClaimRegistry.ReportInput memory r = _in2(key("K9"), rid(9), P, Q, 1, ZERO);
        r.supplier = X;
        _register(v2, r);
        _tick();
        _suspend(L2);
        _tick();
        _reg1(key("K1"), rid(1), P, Q, 500_000, key("K9"));
        assertEq(_supplierOf(key("K1")), supplier);
        assertEq(_supersededBy(key("K9")), key("K1"));
        _assertP(P, rid(1), key("K1"));
        _assertQ(Q, 0, key("K1"));
        assertFalse(registry.isValid(key("K9")));
        assertTrue(registry.isValid(key("K1")));
    }

    /// Another open condition of B' (ii): the original issuer's accreditation expires (this file builds a third body L3 with a 30-day accreditation)
    function test_C71_takeoverAfterAccreditationExpiry() public {
        bytes32 L3 = keccak256("ZZZZ00EUVERIF3DEMO77");
        bytes32 AID_C = keccak256("EAuditorC-demo-aid");
        address v3 = makeAddr("verifier3");
        uint64 until3 = _now() + 30 days;
        vm.startPrank(owner);
        allowlist.addVerifier(
            VerifierAllowlist.VerifierInput({
                leiHash: L3,
                verifier: v3,
                leCredSaidHash: keccak256("LE3"),
                accreditationSaidHash: keccak256("ACC3"),
                accreditedUntil: until3
            })
        );
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(AID_C, L3, keccak256("ECR-C")));
        vm.stopPrank();
        _tick();

        EmissionsClaimRegistry.ReportInput memory r = _in1(key("K9"), rid(9), P, Q, 1, ZERO);
        r.auditorAidHash = AID_C;
        _register(v3, r);

        // Before expiry: L3 valid -> NotReportIssuer(V1, L3)
        vm.warp(until3);
        _expectRevertReg(v1, _in1(key("K1"), rid(1), P, Q, 500_000, key("K9")), _errIssuer(v1, L3));
        // One second after expiry: open
        vm.warp(until3 + 1);
        _reg1(key("K1"), rid(1), P, Q, 500_000, key("K9"));
        _assertP(P, rid(1), key("K1"));
        assertEq(_supersededBy(key("K9")), key("K1"));
    }

    // ---- C72: cross-body supersede, original body valid
    function test_C72_crossBody_revokedIsNotAnOpening() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _revoke(v1, key("K1"));
        _expectRevertReg(v2, _in2(key("K3"), rid(3), P, Q, 600_000, key("K1")), _errIssuer(v2, L1));
        _assertP(P, rid(1), key("K1"));
    }

    function test_C72_crossBody_rotatedIssuerStillActive() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _rotate(L1, v1n);
        _expectRevertReg(v2, _in2(key("K3"), rid(3), P, Q, 500_000, key("K1")), _errIssuer(v2, L1));
        _assertP(P, rid(1), key("K1"));
    }

    // ---- C74: a leaked old key cannot revoke, the new address can
    function test_C74_oldKeyCannotRevoke_newKeyCan() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _rotate(L1, v1n);
        vm.expectRevert(_errInactive(v1));
        vm.prank(v1);
        registry.revokeReport(key("K1"));
        assertTrue(registry.isValid(key("K1")));
        _tick();
        _revoke(v1n, key("K1"));
        assertEq(_revokedAt(key("K1")), _now());
        assertFalse(registry.isValid(key("K1")));
    }

    // ---- C78: same-body revision may change supplier
    function test_C78_sameBodyRevisionChangesSupplier() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        EmissionsClaimRegistry.ReportInput memory r = _in1(key("K1'"), rid(2), P, Q, 480_000, key("K1"));
        r.supplier = supplier2;
        _register(v1, r);
        assertEq(_supplierOf(key("K1'")), supplier2);
        _expectRevertClaim(
            supplier,
            key("K1'"),
            batch(1),
            1,
            abi.encodeWithSelector(EmissionsClaimRegistry.NotSupplier.selector, supplier)
        );
        _claim(supplier2, key("K1'"), batch(1), 1);
        _assertQ(Q, 1, key("K1'"));
    }

    // ---- C79: report ID is not reused
    function test_C79_reportIdRetired_afterTakeover() public {
        _reg2(key("K9"), rid(9), P, Q, 1, ZERO);
        _tick();
        _suspend(L2);
        _tick();
        _reg1(key("K1"), rid(1), P, Q, 500_000, key("K9"));
        _tick();
        _lift(L2);
        _tick();
        _suspend(L1);
        _expectRevertReg(v2, _in2(key("K10"), rid(9), P, Q, 500_000, key("K1")), _errRetired(P, rid(9)));
        // A fresh ID R10 is required for the takeover
        _reg2(key("K10"), rid(10), P, Q, 500_000, key("K1"));
        _assertP(P, rid(10), key("K10"));
    }

    function test_C79_reportIdRetired_sameScopeAfterRevision() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg1(key("K3"), rid(2), P, Q, 480_000, key("K1"));
        _expectRevertReg(v1, _in1(key("K4"), rid(1), P, Q_E, 1_000, ZERO), _errRetired(P, rid(1)));
    }

    // ---- C80: rebinding the same ID in another scope does not retire it in this scope
    function test_C80_crossScopeUnbindDoesNotRetire() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, key("K1"), batch(1), 100_000);
        _tick();
        _reg2(key("K8"), rid(1), P9, Q_P9, 1, ZERO);
        _tick();
        _reg2(key("K8'"), rid(8), P9, Q_P9, 1, key("K8"));
        assertEq(_unbound(P9, rid(1)), _now());
        assertEq(_unbound(P, rid(1)), 0);
        assertTrue(registry.isValid(key("K1")));
        assertTrue(_reportValid(batch(1)));
        _claim(supplier, key("K1"), batch(2), 1);
        _assertQ(Q, 100_001, key("K1"));
    }

    // ---- C81: squatter still valid -> takeover not allowed
    function test_C81_crossBodySupersede_squatterActive_reverts() public {
        _reg2(key("K9"), rid(9), P, Q, 1, ZERO);
        _expectRevertReg(v1, _in1(key("K1"), rid(1), P, Q, 500_000, key("K9")), _errIssuer(v1, L2));
        _assertP(P, rid(9), key("K9"));
        _assertQ(Q, 0, key("K9"));
    }

    // ---- C88: another body attaches under an existing report ID
    function test_C88_NotReportIssuer_attachUnderOtherBodysReportId() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _expectRevertReg(v2, _in2(key("K2"), rid(1), P, Q_E, 1_000, ZERO), _errIssuer(v2, L1));
        _assertQ(Q_E, 0, ZERO);
        _assertP(P, rid(1), key("K1"));
    }

    /// B' takeover cannot reuse the original body's ID: even if L1 is already suspended, the report scope rejects first with NotReportIssuer
    function test_C88_takeoverReusingOriginalId_reverts() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _suspend(L1);
        _expectRevertReg(v2, _in2(key("K3"), rid(1), P, Q, 500_000, key("K1")), _errIssuer(v2, L1));
        _assertP(P, rid(1), key("K1"));
    }

    // ---- C89: same credential layer, different reportScope
    function test_C89_SupersedeMismatch_sameCredLayerDifferentScope() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _expectRevertReg(v1, _in1(key("K2"), rid(2), P2, Q, 500_000, key("K1")), _errMismatch(P2, P));
        _assertP(P2, ZERO, ZERO);
        _assertQ(Q, 0, key("K1"));
    }

    // ---- C90: claimed in the same block, then superseded
    function test_C90_sameBlockClaimThenSupersede_reportValidStillTrue() public {
        bytes32 K1 = key("K1");
        bytes32 K2 = key("K2");
        _reg1(K1, rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, K1, batch(1), 100_000);
        // No warp: same block time
        _reg1(K2, rid(2), P, Q, 500_000, K1);
        assertEq(_claimedAt(batch(1)), _registeredAt(K2));
        assertTrue(_reportValid(batch(1)));
        assertFalse(registry.isValid(K1));
        // Strict single-time semantics: isValidAt is false at the second of supersession, but reportValid only looks at revocation
        assertFalse(registry.isValidAt(K1, _claimedAt(batch(1))));
        _assertQ(Q, 100_000, K2);
    }

    // ---- C91: B' takeover uses the same new ID to take over two credential layers in two steps
    function test_C91_takeoverSameNewIdTwoCredLayers() public {
        _reg1(key("K1"), rid(1), P, Q, 300_000, ZERO);
        _reg1(key("K2"), rid(1), P, Q_E, 200_000, ZERO);
        _tick();
        _claim(supplier, key("K1"), batch(1), 50_000);
        _tick();
        _suspend(L1);
        _tick();
        _reg2(key("K3"), rid(3), P, Q, 300_000, key("K1"));
        _assertP(P, rid(3), key("K3"));
        _assertQ(Q, 50_000, key("K3"));
        assertFalse(registry.isValid(key("K2")));
        _reg2(key("K4"), rid(3), P, Q_E, 200_000, key("K2"));
        _assertP(P, rid(3), key("K4"));
        _assertQ(Q_E, 0, key("K4"));
        assertTrue(registry.isValid(key("K3")));
        assertTrue(registry.isValid(key("K4")));
        assertEq(_issuer(key("K3")), L2);
        assertEq(_issuer(key("K4")), L2);
    }

    // ---- C92: Scenario 9 variant (b): supersede the victim scope using a certificate from a self-made scope
    function test_C92_scenario9Variant_supersedeVictimScopeViaOwnScope() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg2(key("K8"), rid(1), P9, Q_P9, 1, ZERO);
        _tick();
        _expectRevertReg(v2, _in2(key("K8x"), rid(8), P, Q_P9, 1, key("K8")), _errMismatch(P, P9));
        _assertP(P, rid(1), key("K1"));
        assertEq(_unbound(P, rid(1)), 0);
        assertTrue(registry.isValid(key("K1")));
    }

    // ================================================================ O7-A (c): C93–C99

    function _setupC93() internal returns (bytes32 T, bytes32 K1) {
        T = key("T");
        K1 = key("K1");
        _reg2(T, rid(9), P, Q9, 5, ZERO);
        _tick();
        _claim(supplier, T, batch(1), 2);
        _tick();
        _suspend(L2);
        _tick();
        _reg1(K1, rid(1), P, Q, 500_000, T);
    }

    function test_C93_reportLayerTakeover_succeeds() public {
        bytes32 T = key("T");
        bytes32 K1 = key("K1");
        _reg2(T, rid(9), P, Q9, 5, ZERO);
        _tick();
        _claim(supplier, T, batch(1), 2);
        _tick();
        _suspend(L2);
        _tick();
        uint64 t = _now();
        vm.recordLogs();
        _reg1(K1, rid(1), P, Q, 500_000, T);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, EmissionsClaimRegistry.ReportRegistered.selector), 1, "ReportRegistered");
        assertEq(_count(logs, EmissionsClaimRegistry.ReportSuperseded.selector), 0, "ReportSuperseded");

        _assertP(P, rid(1), K1);
        assertEq(_unbound(P, rid(9)), t);
        assertFalse(registry.isValid(T));
        assertEq(_supersededBy(T), ZERO);
        _assertQ(Q9, 2, T);
        _assertQ(Q, 0, K1);
        assertEq(_supersedesOf(K1), T);
        assertTrue(registry.isValid(K1));
        // F-9: T is still the latest of Q9 and not revoked; remainingKg returns the book balance (ignores isValid)
        assertEq(registry.remainingKg(T), 3);
        _expectRevertClaim(supplier, T, batch(2), 1, _errInvalid(T));
        // Shape of I24: supersedes != 0 while the counterpart's supersededBy != K1 => credScopeKey differs, reportScopeKey is the same, reportIdHash differs
        bytes32 idK1 = registry.reports(K1).reportIdHash;
        bytes32 psK1 = registry.reports(K1).reportScopeKey;
        bytes32 qsK1 = registry.reports(K1).credScopeKey;
        bytes32 idT = registry.reports(T).reportIdHash;
        bytes32 psT = registry.reports(T).reportScopeKey;
        bytes32 qsT = registry.reports(T).credScopeKey;
        assertTrue(qsK1 != qsT);
        assertEq(psK1, psT);
        assertTrue(idK1 != idT);
    }

    function test_C94_reportLayerTakeover_issuerActive_reverts() public {
        bytes32 T = key("T");
        _reg2(T, rid(9), P, Q9, 5, ZERO);
        _tick();
        _claim(supplier, T, batch(1), 2);
        _tick();
        _expectRevertReg(v1, _in1(key("K1"), rid(1), P, Q, 500_000, T), _errIssuer(v1, L2));
        _assertP(P, rid(9), T);
        _assertQ(Q, 0, ZERO);
        assertTrue(registry.isValid(T));
    }

    function test_C95_reportLayerTakeover_sameId_reverts() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _expectRevertReg(v1, _in1(key("K2"), rid(1), P, Q_E, 200_000, key("K1")), _errMismatch(ZERO, key("K1")));
        _assertQ(Q_E, 0, ZERO);
        _assertP(P, rid(1), key("K1"));
    }

    function test_C96_frozenLayerRestoredViaRevision() public {
        (bytes32 T,) = _setupC93();
        bytes32 Ka = key("KQ9a");
        bytes32 Kb = key("KQ9b");
        _expectRevertReg(v1, _in1(Ka, rid(1), P, Q9, 1, T), _errOver(Q9, 2, 1));
        _assertQ(Q9, 2, T);

        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportSuperseded(T, Kb, Q9, 2, 300_000);
        _reg1(Kb, rid(1), P, Q9, 300_000, T);
        _assertQ(Q9, 2, Kb);
        assertEq(_supersededBy(T), Kb);
        _assertP(P, rid(1), Kb);
        assertTrue(registry.isValid(Kb));
        assertEq(registry.remainingKg(Kb), 299_998);
    }

    function test_C97_1_formerSquatterLifted_PeriodAlreadyCovered() public {
        (bytes32 T,) = _setupC93();
        _tick();
        _lift(L2);
        _expectRevertReg(v2, _in2(key("Kx"), rid(10), P, Q9, 1_000, T), _errPeriod(P, rid(1)));
        _assertQ(Q9, 2, T);
    }

    function test_C97_2_formerSquatterLifted_NotReportIssuer() public {
        (, bytes32 K1) = _setupC93();
        _tick();
        _lift(L2);
        _expectRevertReg(v2, _in2(key("Ky"), rid(10), P, Q10, 1_000, K1), _errIssuer(v2, L1));
        _assertP(P, rid(1), K1);
        _assertQ(Q10, 0, ZERO);
    }

    function test_C98_takeoverViaOtherScope_SupersedeMismatch() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg2(key("T"), rid(1), P9, Q_P9, 1, ZERO);
        _tick();
        _expectRevertReg(v2, _in2(key("Kx"), rid(8), P, Q10, 1_000, key("T")), _errMismatch(P, P9));
        _assertP(P, rid(1), key("K1"));
        _assertQ(Q10, 0, ZERO);
    }

    /// C98 note: when T's ID differs from P's currently bound value, it is rejected at the report scope first
    function test_C98_takeoverViaOtherScope_differentId_PeriodAlreadyCovered() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg2(key("T"), rid(7), P9, Q_P9, 1, ZERO);
        _tick();
        _expectRevertReg(v2, _in2(key("Kx"), rid(8), P, Q10, 1_000, key("T")), _errPeriod(P, rid(1)));
    }

    function test_C99_reportLayerTakeover_targetAlreadySuperseded() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg1(key("K2"), rid(1), P, Q, 500_000, key("K1"));
        assertEq(_supersededBy(key("K1")), key("K2"));
        _assertP(P, rid(1), key("K2"));
        _expectRevertReg(v1, _in1(key("K3"), rid(2), P, Q_E, 1_000, key("K1")), _errMismatch(key("K2"), key("K1")));
        _assertP(P, rid(1), key("K2"));
        _assertQ(Q_E, 0, ZERO);
    }

    /// Freeze addendum §1.4 item 3: the same body registers an empty credential layer with a fresh ID via (c) = whole-report revision; all other certificates under R1 become invalid
    function test_C95_sameBodyNewIdTakeover_wholeReportReplaced() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _claim(supplier, key("K1"), batch(1), 10);
        _tick();
        uint64 t = _now();
        _reg1(key("K2"), rid(2), P, Q_E, 200_000, key("K1"));
        _assertP(P, rid(2), key("K2"));
        assertEq(_unbound(P, rid(1)), t);
        _assertQ(Q, 10, key("K1"));
        _assertQ(Q_E, 0, key("K2"));
        assertEq(_supersededBy(key("K1")), ZERO);
        assertFalse(registry.isValid(key("K1")));
        assertTrue(registry.isValid(key("K2")));
        assertTrue(_reportValid(batch(1)));
        // Afterwards Q is restored via (b) using the current R2
        _tick();
        _reg1(key("K1'"), rid(2), P, Q, 500_000, key("K1"));
        _assertQ(Q, 10, key("K1'"));
        assertEq(_supersededBy(key("K1")), key("K1'"));
    }

    /// Freeze addendum §1.3: after the squatter's suspension is lifted, the taker cannot use (b) to restore the frozen credential layer
    function test_C96_squatterLifted_frozenLayerStays() public {
        (bytes32 T,) = _setupC93();
        _tick();
        _lift(L2);
        _expectRevertReg(v1, _in1(key("KQ9"), rid(1), P, Q9, 300_000, T), _errIssuer(v1, L2));
        _assertQ(Q9, 2, T);
        assertFalse(registry.isValid(T));
    }

    /// Freeze addendum §6 A-08 (design level, decided to document only): after the original body's suspension is lifted, the facility period rebound via (c) is frozen for it
    function test_C93_A08_originalBodyLockedOutAfterTakeover() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _suspend(L1);
        _tick();
        _reg2(key("K3"), rid(3), P, Q_E, 1, key("K1")); // (c) low-cost rebind
        _tick();
        _lift(L1);
        // New ID: K1's R1 is not P's current R3 -> PeriodAlreadyCovered
        _expectRevertReg(v1, _in1(key("K4"), rid(4), P, Q, 500_000, key("K1")), _errPeriod(P, rid(3)));
        // Current ID: R3's holder is L2 -> NotReportIssuer
        _expectRevertReg(v1, _in1(key("K4"), rid(3), P, Q, 500_000, key("K1")), _errIssuer(v1, L2));
        assertFalse(registry.isValid(key("K1")));
    }

    // ================================================================ check order (freeze addendum §6 A-13)

    /// (1) ReportIdRetired before (2) ReportNotFound
    function test_order_retiredBeforeNotFound() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _reg1(key("K2"), rid(2), P, Q, 500_000, key("K1"));
        _expectRevertReg(v1, _in1(key("K3"), rid(1), P, Q, 500_000, key("nope")), _errRetired(P, rid(1)));
    }

    /// (2) ReportNotFound before (3) report scope (F-8)
    function test_order_notFoundBeforeReportLayer() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _expectRevertReg(
            v2,
            _in2(key("K3"), rid(3), P, Q, 500_000, key("nope")),
            abi.encodeWithSelector(EmissionsClaimRegistry.ReportNotFound.selector, key("nope"))
        );
    }

    /// (3) report scope PeriodAlreadyCovered before (4) (a) CredScopeAlreadyCovered
    function test_order_reportLayerBeforeCredLayer() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _expectRevertReg(v1, _in1(key("K2"), rid(2), P, Q, 500_000, ZERO), _errPeriod(P, rid(1)));
    }

    /// (3) report scope NotReportIssuer (same ID attached by another body) before (4) (c) SupersedeMismatch(0, supersedes)
    function test_order_reportLayerIssuerBeforeBranchC() public {
        _reg1(key("K1"), rid(1), P, Q, 500_000, ZERO);
        _tick();
        _suspend(L1);
        _expectRevertReg(v2, _in2(key("K2"), rid(1), P, Q_E, 1_000, key("K1")), _errIssuer(v2, L1));
    }
}
