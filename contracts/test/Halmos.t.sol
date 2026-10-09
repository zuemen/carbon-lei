// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @dev Halmos cheatcode (halmos-cheatcodes `SVM`), declared here to avoid another submodule.
interface SVM {
    function createCalldata(string memory contractName) external pure returns (bytes memory data);
}

/// @notice Bounded symbolic checks of the on-chain properties P1, P2, P3 and P6 of
/// docs/SECURITY.md §9, for Halmos (docs/SECURITY.md §9.2). Run: `npm run contracts:symbolic`.
///
/// Every `check_` function is one Halmos test. Its parameters are symbolic: Halmos explores
/// every value of the declared type at once, not a sample. What is bounded is the call
/// sequence: each check fixes the order and number of transactions (stated per function), and
/// the starting state is the `Base` fixture (two bodies L1 and L2, auditors AID_A under L1 and
/// AID_B under L2, accredited until 2030-12-31). There are no loops over symbolic bounds; the
/// one fixed-length loop (3 claims) is within `--loop 3`. A result is "proved within these
/// bounds", not a proof over all call sequences.
///
/// `forge test` ignores these functions (no `test` prefix), so the forge test count does not
/// change. Plain `assert` is used; a failing `assert` is a Halmos counterexample.
contract HalmosPropertiesTest is Base {
    SVM internal constant svm = SVM(0xF3993A62377BCd56AE39D773740A5390411E8BC9);

    /// @dev Halmos models `vm.addr` (used by `makeAddr`) as an uninterpreted function: the
    /// fixture addresses would be symbolic, distinct from each other but free to equal a
    /// contract or precompile address, which gives spurious counterexamples. Concrete,
    /// distinct addresses that are no contract and no precompile replace them here.
    function setUp() public override {
        owner = address(0xA00001);
        watcher = address(0xA00002);
        v1 = address(0xB00001);
        v1n = address(0xB00002);
        v1nn = address(0xB00003);
        v2 = address(0xB00004);
        v5 = address(0xB00005);
        supplier = address(0xC00001);
        supplier2 = address(0xC00002);
        stranger = address(0xC00003);
        super.setUp();
    }

    bytes32 internal constant KA = keccak256("ESAID-S-A");
    bytes32 internal constant KB = keccak256("ESAID-S-B");
    bytes32 internal constant KR = keccak256("ESAID-S-R");
    bytes32 internal constant IMP = keccak256("importer");

    function _tryClaim(address caller, bytes32 reportKey, bytes32 batchKey, uint96 kg, bytes32 imp)
        internal
        returns (bool ok)
    {
        vm.prank(caller);
        try registry.claimShipment(reportKey, batchKey, kg, imp) {
            ok = true;
        } catch {}
    }

    function _tryRegister(address caller, EmissionsClaimRegistry.ReportInput memory r) internal returns (bool ok) {
        vm.prank(caller);
        try registry.registerReport(r) {
            ok = true;
        } catch {}
    }

    function _claimed(bytes32 s, bytes32 c) internal view returns (uint96 kg) {
        (kg,) = registry.credScopes(s, c);
    }

    function _latest(bytes32 s, bytes32 c) internal view returns (bytes32 k) {
        (, k) = registry.credScopes(s, c);
    }

    function _verified(bytes32 k) internal view returns (uint96) {
        return registry.reports(k).verifiedKg;
    }

    /// @dev The P1 statement for one ledger slot (s, c).
    function _assertSlot(bytes32 s, bytes32 c) internal view {
        bytes32 latest = _latest(s, c);
        uint96 claimed = _claimed(s, c);
        if (latest == bytes32(0)) assert(claimed == 0);
        else assert(claimed <= _verified(latest));
    }

    // ------------------------------------------------------------------- P1

    /// @dev P1, one slot, 1 registration + 3 claims. Symbolic: verifiedKg V (any non-zero
    /// uint96) and the three quantities (any uint96). Each claim is accepted exactly when
    /// 0 < q and claimed + q <= V; claimedKg equals the sum of accepted claims and stays <= V.
    function check_P1_threeClaims(uint96 V, uint96 q0, uint96 q1, uint96 q2) public {
        vm.assume(V != 0);
        _reg1(KA, rid(1), P, Q, V, bytes32(0));
        uint96[3] memory qs = [q0, q1, q2];
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            uint96 q = qs[i];
            bool ok = _tryClaim(supplier, KA, batch(i), q, IMP);
            assert(ok == (q != 0 && sum + q <= V));
            if (ok) sum += q;
            assert(uint256(_claimed(P, Q)) == sum);
            assert(_claimed(P, Q) <= V);
        }
    }

    /// @dev P1 across a revision (branch (b)), 1 registration + 1 claim + 1 revision + 2 claims.
    /// Symbolic: V, the first claim c1, the revised newKg, a claim q against the superseded
    /// credential (any batch key) and a claim c2 against the revision. The revision is accepted
    /// exactly when newKg >= claimed; claimed carries over; the superseded credential takes no
    /// claim; the cap is then newKg.
    function check_P1_revision(uint96 V, uint96 c1, uint96 newKg, bytes32 bOld, uint96 q, uint96 c2) public {
        vm.assume(V != 0 && c1 != 0 && c1 <= V);
        _reg1(KA, rid(1), P, Q, V, bytes32(0));
        assert(_tryClaim(supplier, KA, batch(1), c1, IMP));

        vm.warp(START + 1 days);
        bool revised = _tryRegister(v1, _input(KR, rid(1), P, Q, newKg, KA));
        assert(revised == (newKg != 0 && newKg >= c1));
        if (!revised) {
            _assertSlot(P, Q);
            return;
        }
        assert(_latest(P, Q) == KR);
        assert(_claimed(P, Q) == c1);
        assert(!_tryClaim(supplier, KA, bOld, q, IMP));
        bool ok = _tryClaim(supplier, KR, batch(2), c2, IMP);
        assert(ok == (c2 != 0 && uint256(c1) + c2 <= newKg));
        assert(_claimed(P, Q) == (ok ? c1 + c2 : c1));
        _assertSlot(P, Q);
    }

    /// @dev P1 against a second registration chosen from a finite set, 1 registration + 1 claim
    /// + 1 registration + 1 claim. The second registration's sender is v1 (with AID_A) or v2
    /// (with AID_B); its report key is KA (already taken) or KB; its report ID rid(1) or rid(2);
    /// its report scope P or P2; its credential scope Q or Q_E; its `supersedes` 0 or KA; its
    /// supplier `supplier` or `supplier2`; these are branch choices. Symbolic: the first claim
    /// c1, the second input's verifiedKg and validUntil, and the second claim's report (KA or
    /// KB), caller (either supplier), batch key and quantity. The P1 statement then holds for
    /// every slot either registration can touch: (P, Q), (P, Q_E), (P2, Q), (P2, Q_E).
    /// (A version with every input field and the claim's report key fully symbolic gave no
    /// result in 20 minutes; see docs/data/symbolic-2026-10-09.txt.)
    function check_P1_secondRegistrationThenClaim(
        uint96 c1,
        uint8 choice,
        uint96 kg,
        uint64 validUntil,
        bool claimKB,
        bool claimAsSupplier2,
        bytes32 b2,
        uint96 q2
    ) public {
        vm.assume(c1 != 0 && c1 <= 500_000);
        _reg1(KA, rid(1), P, Q, 500_000, bytes32(0));
        assert(_tryClaim(supplier, KA, batch(1), c1, IMP));
        vm.warp(START + 1 days);

        // decode 7 binary choices from `choice` (128 combinations), branching on each bit
        address sender = v1;
        bytes32 aid = AID_A;
        if (choice & 1 != 0) {
            sender = v2;
            aid = AID_B;
        }
        bytes32 rk = KB;
        if (choice & 2 != 0) rk = KA;
        bytes32 rId = rid(1);
        if (choice & 4 != 0) rId = rid(2);
        bytes32 scope = P;
        if (choice & 8 != 0) scope = P2;
        bytes32 cred = Q;
        if (choice & 16 != 0) cred = Q_E;
        bytes32 sup = bytes32(0);
        if (choice & 32 != 0) sup = KA;
        address supp = supplier;
        if (choice & 64 != 0) supp = supplier2;
        vm.assume(choice < 128);

        EmissionsClaimRegistry.ReportInput memory r = _input(rk, rId, scope, cred, kg, sup);
        r.auditorAidHash = aid;
        r.supplier = supp;
        r.validUntil = validUntil;
        _tryRegister(sender, r);

        bytes32 k2 = KA;
        if (claimKB) k2 = KB;
        address claimer = supplier;
        if (claimAsSupplier2) claimer = supplier2;
        _tryClaim(claimer, k2, b2, q2, IMP);

        _assertSlot(P, Q);
        _assertSlot(P, Q_E);
        _assertSlot(P2, Q);
        _assertSlot(P2, Q_E);
    }

    // ------------------------------------------------------------------- P2

    /// @dev P2, 2 registrations + 2 claims of the same batch key. Symbolic: the batch key, both
    /// quantities and importer commitments, the second caller, which report the second claim
    /// uses (KA or KB in another slot), and the time between the claims (up to 2^32 s). The
    /// second claim always reverts and the stored record is unchanged.
    function check_P2_batchClaimedOnce(
        bytes32 b,
        uint96 q1,
        bytes32 imp1,
        bool otherReport,
        address caller2,
        uint96 q2,
        bytes32 imp2,
        uint32 dt
    ) public {
        _reg1(KA, rid(1), P, Q, 500_000, bytes32(0));
        _reg1(KB, rid(1), P, Q_E, 500_000, bytes32(0));
        vm.assume(_tryClaim(supplier, KA, b, q1, imp1));
        (bytes32 k1, uint96 s1, bytes32 i1, uint64 t1) = registry.shipments(b);

        vm.warp(uint256(START) + 1 hours + dt);
        assert(!_tryClaim(caller2, otherReport ? KB : KA, b, q2, imp2));

        (bytes32 k1b, uint96 s1b, bytes32 i1b, uint64 t1b) = registry.shipments(b);
        assert(k1b == k1 && k1 == KA);
        assert(s1b == s1 && s1 == q1);
        assert(i1b == i1 && i1 == imp1);
        assert(t1b == t1 && t1 != 0);
    }

    /// @dev P2 against any single call: after one claim of batch key b, one call to the
    /// registry with symbolic calldata (any function, any arguments) from a symbolic sender
    /// leaves the record of b unchanged. Symbolic: b, the first quantity, the sender, and the calldata
    /// (`svm.createCalldata`: every external function of the registry, all arguments symbolic).
    function check_P2_recordNeverRewritten(bytes32 b, uint96 q1, address sender) public {
        _reg1(KA, rid(1), P, Q, 500_000, bytes32(0));
        vm.assume(_tryClaim(supplier, KA, b, q1, IMP));
        (bytes32 k1, uint96 s1, bytes32 i1, uint64 t1) = registry.shipments(b);

        vm.warp(START + 1 days);
        bytes memory data = svm.createCalldata("EmissionsClaimRegistry");
        vm.prank(sender);
        (bool success,) = address(registry).call(data);
        success; // either outcome is allowed; only the record matters

        (bytes32 k2, uint96 s2, bytes32 i2, uint64 t2) = registry.shipments(b);
        assert(k2 == k1 && s2 == s1 && i2 == i1 && t2 == t1);
    }

    // ------------------------------------------------------------------- P3

    /// @dev Registers KA (500 t, no expiry problem) as `sender` with auditor `aid` and checks
    /// P3: it succeeds exactly when `expected` (the spec predicate the caller computed from the
    /// event times, not from the allowlist's views); the allowlist's views in the pre-state
    /// agree; on success the record stores the sender, its body and the time.
    function _checkP3(address sender, bytes32 aid, uint64 t, bool bodyActive, bool expected, bytes32 lei) internal {
        vm.warp(t);
        assert(allowlist.isVerifierActiveAt(sender, t) == bodyActive);
        assert(allowlist.isAuthorizedAt(aid, sender, t) == expected);
        EmissionsClaimRegistry.ReportInput memory r = _input(KA, rid(1), P, Q, 500_000, bytes32(0));
        r.auditorAidHash = aid;
        r.validUntil = type(uint64).max;
        bool ok = _tryRegister(sender, r);
        assert(ok == expected);
        if (ok) {
            EmissionsClaimRegistry.ReportRecord memory rec = registry.reports(KA);
            assert(rec.verifier == sender && rec.issuerLeiHash == lei && rec.registeredAt == t);
        }
    }

    /// @dev P3, no allowlist event + 1 registration. Symbolic: the sender (any address), the
    /// auditor AID (any bytes32) and the registration time (any uint64 from the fixture's
    /// time on, so accreditation expiry is covered). Only v1 with AID_A and v2 with AID_B,
    /// up to `accreditedUntil`, can register.
    function check_P3_senderAuditorExpiry(address sender, bytes32 aid, uint64 t) public {
        vm.assume(t >= START + 1 hours);
        bytes32 lei;
        bytes32 ownAid;
        if (sender == v1) {
            lei = L1;
            ownAid = AID_A;
        } else if (sender == v2) {
            lei = L2;
            ownAid = AID_B;
        }
        bool bodyActive = lei != bytes32(0) && t <= ACCREDITED_UNTIL;
        _checkP3(sender, aid, t, bodyActive, bodyActive && aid == ownAid, lei);
    }

    /// @dev P3, 1 or 2 suspension events (suspend L1, optionally lift) + 1 registration by v1.
    /// Symbolic: the auditor AID, whether the suspension is lifted, the event times and the
    /// registration time (each any uint64, in that order, from the fixture's time on).
    function check_P3_suspension(bytes32 aid, bool lift, uint64 tS, uint64 tL, uint64 t) public {
        vm.assume(START + 1 hours <= tS && tS <= tL && tL <= t);
        vm.warp(tS);
        _suspend(L1);
        if (lift) {
            vm.warp(tL);
            _lift(L1);
        }
        bool bodyActive = t <= ACCREDITED_UNTIL && lift && t >= tL;
        _checkP3(v1, aid, t, bodyActive, bodyActive && aid == AID_A, L1);
    }

    /// @dev P3, 1 auditor revocation (AID_A or AID_B) + 1 registration by v1. Symbolic: the
    /// auditor in the registration, which auditor is revoked, the revocation time and the
    /// registration time (any uint64 from the revocation on).
    function check_P3_auditorRevocation(bytes32 aid, bool revokeB, uint64 tR, uint64 t) public {
        vm.assume(START + 1 hours <= tR && tR <= t);
        vm.warp(tR);
        vm.prank(watcher);
        if (revokeB) allowlist.revokeAuditor(AID_B, L2);
        else allowlist.revokeAuditor(AID_A, L1);
        bool bodyActive = t <= ACCREDITED_UNTIL;
        _checkP3(v1, aid, t, bodyActive, bodyActive && aid == AID_A && revokeB, L1);
    }

    /// @dev P3, 1 address rotation of L1 (v1 -> v1n) + 1 registration by v1 or v1n. Symbolic:
    /// which address sends, the auditor AID, the rotation time and the registration time (any
    /// uint64 from the rotation on). The rotated-away address cannot register; the new one can.
    function check_P3_rotation(bool useNew, bytes32 aid, uint64 tRot, uint64 t) public {
        vm.assume(START + 1 hours <= tRot && tRot <= t);
        vm.warp(tRot);
        _rotate(L1, v1n);
        address sender = v1;
        if (useNew) sender = v1n;
        bool bodyActive = useNew && t <= ACCREDITED_UNTIL;
        _checkP3(sender, aid, t, bodyActive, bodyActive && aid == AID_A, L1);
    }

    // ------------------------------------------------------------------- P6

    /// @dev P6 (report), 1 registration + 0 or 1 claim + 1 revocation + 1 claim. Symbolic: the
    /// first claim's quantity, the revocation time, and the later claim's caller, batch key,
    /// quantity, importer commitment and time (any uint64 from the revocation on). The revoked
    /// report takes no claim, `isValidAt` is false at every symbolic time, and a second
    /// revocation by L1 reverts and leaves `revokedAt` unchanged.
    function check_P6_revokedReportNeverClaimable(
        bool claimFirst,
        uint96 c1,
        uint64 tRev,
        address caller,
        bytes32 b,
        uint96 q,
        bytes32 imp,
        uint64 t,
        uint64 tView
    ) public {
        uint64 t0 = START + 1 hours;
        vm.assume(t0 <= tRev && tRev <= t && tRev <= ACCREDITED_UNTIL);
        _reg1(KA, rid(1), P, Q, 500_000, bytes32(0));
        if (claimFirst) _tryClaim(supplier, KA, batch(1), c1, IMP);

        vm.warp(tRev);
        vm.prank(v1);
        registry.revokeReport(KA);

        vm.warp(t);
        assert(!_tryClaim(caller, KA, b, q, imp));
        assert(!registry.isValidAt(KA, tView));
        vm.prank(v1);
        try registry.revokeReport(KA) {
            assert(false);
        } catch {}
        assert(registry.reports(KA).revokedAt == tRev);
    }

    /// @dev P6 (auditor), 1 revocation + up to 2 suspension events + 1 re-add attempt + 1
    /// registration. Symbolic: the revocation time, whether L1 is suspended and lifted after
    /// it (and when), and the registration time (any uint64 from the last event on). AID_A
    /// cannot be authorised for v1 again, cannot be re-added, and no report with it registers.
    function check_P6_auditorRevocationIsPermanent(uint64 tR, bool suspend, bool lift, uint64 tS, uint64 tL, uint64 t)
        public
    {
        uint64 t0 = START + 1 hours;
        vm.assume(t0 <= tR && tR <= tS && tS <= tL && tL <= t);
        vm.warp(tR);
        vm.prank(watcher);
        allowlist.revokeAuditor(AID_A, L1);
        if (suspend) {
            vm.warp(tS);
            _suspend(L1);
            if (lift) {
                vm.warp(tL);
                _lift(L1);
            }
        }
        vm.warp(t);
        assert(!allowlist.isAuthorizedAt(AID_A, v1, t));
        vm.prank(owner);
        try allowlist.addAuditor(VerifierAllowlist.AuditorInput(AID_A, L1, keccak256("ECR-A2"))) {
            assert(false);
        } catch {}
        EmissionsClaimRegistry.ReportInput memory r = _input(KA, rid(1), P, Q, 500_000, bytes32(0));
        r.validUntil = type(uint64).max;
        assert(!_tryRegister(v1, r));
        (, uint64 addedAt, uint64 revokedAt) = allowlist.auditors(AID_A, L1);
        assert(addedAt == START && revokedAt == tR);
    }
}
