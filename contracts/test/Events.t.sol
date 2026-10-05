// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice Registry event field assertions (C22, C50, C68).
/// Spec: 12 §4 event table + M0.5 freeze addendum §1.2 (branch (c) emits no ReportSuperseded)
/// and §6 A-14 (ReportSuperseded only in branch (b)).
contract EventsTest is Base {
    bytes32 internal constant K1 = keccak256("ESAID-K1-demo");
    bytes32 internal constant K2 = keccak256("ESAID-K2-demo");
    bytes32 internal constant K3 = keccak256("ESAID-K3-demo");

    uint96 internal constant KG500 = 500_000;
    uint64 internal constant KEL = 11; // distinct from the fixture default (3)

    bytes32 internal constant SUPPLIER_COMMIT = keccak256("supplier-commit");
    bytes32 internal constant INSTALLATION_COMMIT = keccak256("installation-commit");

    // ---------------------------------------------------------------- helpers

    function _countTopic(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) ++n;
        }
    }

    function _countFrom(Vm.Log[] memory logs, address emitter) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter) ++n;
        }
    }

    function _claimWith(bytes32 reportKey, bytes32 batchKey, uint96 kg, bytes32 importerCommit) internal {
        vm.prank(supplier);
        registry.claimShipment(reportKey, batchKey, kg, importerCommit);
    }

    // ---------------------------------------------------------------- C68 ReportRegistered (11 fields)

    function test_C68_ReportRegistered_allFields_L1() public {
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(1), P, Q, KG500, bytes32(0));
        r.kelSeq = KEL;
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRegistered(K1, v1, supplier, L1, P, Q, rid(1), AID_A, KEL, KG500, VALID_UNTIL);
        _register(v1, r);
    }

    function test_C68_ReportRegistered_allFields_L2() public {
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(9), P9, Q_P9, 123_456, bytes32(0));
        r.auditorAidHash = AID_B;
        r.supplier = supplier2;
        r.kelSeq = KEL;
        r.validUntil = VALID_UNTIL - 7 days;
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRegistered(
            K1, v2, supplier2, L2, P9, Q_P9, rid(9), AID_B, KEL, 123_456, VALID_UNTIL - 7 days
        );
        _register(v2, r);
    }

    /// After rotation the event carries the caller's (new) address and the same body LEI hash.
    function test_C68_ReportRegistered_afterRotation() public {
        _rotate(L1, v1n);
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(1), P, Q, KG500, bytes32(0));
        r.kelSeq = KEL;
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRegistered(
            K1, v1n, supplier, L1, P, Q, rid(1), AID_A, KEL, KG500, VALID_UNTIL
        );
        _register(v1n, r);
    }

    /// Decodes the raw log to check topic layout (3 indexed) and every data word.
    function test_C68_ReportRegistered_rawLogLayout() public {
        EmissionsClaimRegistry.ReportInput memory r = _input(K1, rid(1), P, Q, KG500, bytes32(0));
        r.kelSeq = KEL;
        vm.recordLogs();
        _register(v1, r);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one log");
        Vm.Log memory l = logs[0];
        assertEq(l.emitter, address(registry));
        assertEq(l.topics.length, 4);
        assertEq(l.topics[0], EmissionsClaimRegistry.ReportRegistered.selector);
        assertEq(l.topics[1], K1);
        assertEq(l.topics[2], bytes32(uint256(uint160(v1))));
        assertEq(l.topics[3], bytes32(uint256(uint160(supplier))));
        (
            bytes32 issuerLei,
            bytes32 scopeKey,
            bytes32 credKey,
            bytes32 reportId,
            bytes32 aid,
            uint64 kel,
            uint96 kg,
            uint64 vu
        ) = abi.decode(l.data, (bytes32, bytes32, bytes32, bytes32, bytes32, uint64, uint96, uint64));
        assertEq(issuerLei, L1);
        assertEq(scopeKey, P);
        assertEq(credKey, Q);
        assertEq(reportId, rid(1));
        assertEq(aid, AID_A);
        assertEq(kel, KEL);
        assertEq(kg, KG500);
        assertEq(vu, VALID_UNTIL);
    }

    // ---------------------------------------------------------------- C50 ReportSuperseded

    /// Scenario 1 step 5: ReportRegistered + ReportSuperseded(K1, K2, Q, 200,000, 450,000) in one tx.
    function test_C50_ReportSuperseded_scenario1Step5() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        _claim(supplier, K1, batch(1), 200_000);
        _revoke(v1, K1);

        EmissionsClaimRegistry.ReportInput memory r = _input(K2, rid(2), P, Q, 450_000, K1);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRegistered(K2, v1, supplier, L1, P, Q, rid(2), AID_A, 3, 450_000, VALID_UNTIL);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportSuperseded(K1, K2, Q, 200_000, 450_000);
        _register(v1, r);
    }

    function test_C50_ReportSuperseded_onlyTwoLogsInTx() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        _claim(supplier, K1, batch(1), 200_000);
        vm.recordLogs();
        _reg1(K2, rid(1), P, Q, 450_000, K1); // same-ID revision
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], EmissionsClaimRegistry.ReportRegistered.selector);
        assertEq(logs[1].topics[0], EmissionsClaimRegistry.ReportSuperseded.selector);
        assertEq(logs[1].topics[1], K1);
        assertEq(logs[1].topics[2], K2);
        assertEq(logs[1].topics[3], Q);
        (uint96 carried, uint96 newKg) = abi.decode(logs[1].data, (uint96, uint96));
        assertEq(carried, 200_000);
        assertEq(newKg, 450_000);
    }

    /// carriedClaimedKg = 0 when nothing was claimed yet.
    function test_C50_ReportSuperseded_zeroCarried() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportSuperseded(K1, K2, Q, 0, 600_000);
        _reg1(K2, rid(1), P, Q, 600_000, K1);
    }

    /// B′ (ii): another body supersedes a suspended issuer's credential; the two
    /// ReportRegistered events differ in issuerLeiHash, ReportSuperseded carries the ledger.
    function test_C50_ReportSuperseded_otherBodyAfterSuspension() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        _claim(supplier, K1, batch(1), 150_000);
        _suspend(L1);

        EmissionsClaimRegistry.ReportInput memory r = _input(K2, rid(2), P, Q, 400_000, K1);
        r.auditorAidHash = AID_B;
        r.supplier = supplier2;
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRegistered(
            K2, v2, supplier2, L2, P, Q, rid(2), AID_B, 3, 400_000, VALID_UNTIL
        );
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportSuperseded(K1, K2, Q, 150_000, 400_000);
        _register(v2, r);
    }

    /// O7-A branch (c): report-layer takeover into an empty credential layer emits
    /// ReportRegistered only, never ReportSuperseded (addendum §1.2, F-O7-1).
    function test_C50_takeoverEmitsNoReportSuperseded() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        _claim(supplier, K1, batch(1), 200_000);

        EmissionsClaimRegistry.ReportInput memory r = _input(K3, rid(2), P, Q_E, 300_000, K1);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRegistered(
            K3, v1, supplier, L1, P, Q_E, rid(2), AID_A, 3, 300_000, VALID_UNTIL
        );
        _register(v1, r);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // the test contract's own expectEmit template is recorded too; count registry logs only
        assertEq(_countFrom(logs, address(registry)), 1, "only ReportRegistered");
        assertEq(_countTopic(logs, EmissionsClaimRegistry.ReportSuperseded.selector), 0);
        assertEq(_countTopic(logs, EmissionsClaimRegistry.ReportRegistered.selector), 1);
    }

    function test_C50_noSupersedeEmitsNoReportSuperseded() public {
        vm.recordLogs();
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(_countTopic(logs, EmissionsClaimRegistry.ReportSuperseded.selector), 0);
    }

    // ---------------------------------------------------------------- C22 ReportRevoked / ShipmentClaimed

    function test_C22_ReportRevoked_fields() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        vm.warp(block.timestamp + 3 days);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRevoked(K1, v1, uint64(vm.getBlockTimestamp()));
        _revoke(v1, K1);
    }

    /// verifier = caller's current address, which differs from the registering address after rotation.
    function test_C22_ReportRevoked_verifierIsCurrentAddressAfterRotation() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        _rotate(L1, v1n);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ReportRevoked(K1, v1n, uint64(vm.getBlockTimestamp()));
        _revoke(v1n, K1);
        address registeredBy = registry.reports(K1).verifier;
        assertEq(registeredBy, v1);
    }

    function test_C22_ShipmentClaimed_cumulative() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        bytes32 imp1 = keccak256("importer-1");
        bytes32 imp2 = keccak256("importer-2");

        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ShipmentClaimed(
            batch(1), K1, supplier, 200_000, imp1, 200_000, uint64(vm.getBlockTimestamp())
        );
        _claimWith(K1, batch(1), 200_000, imp1);

        vm.warp(block.timestamp + 2 days);
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ShipmentClaimed(
            batch(2), K1, supplier, 100_000, imp2, 300_000, uint64(vm.getBlockTimestamp())
        );
        _claimWith(K1, batch(2), 100_000, imp2);
    }

    /// cumulativeClaimedKg is per credential layer and carries over a revision.
    function test_C22_ShipmentClaimed_cumulativeCarriesOverSupersede() public {
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        _claim(supplier, K1, batch(1), 200_000);
        _reg1(K2, rid(1), P, Q, 450_000, K1);
        bytes32 imp = keccak256("importer-3");
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistry.ShipmentClaimed(
            batch(3), K2, supplier, 250_000, imp, 450_000, uint64(vm.getBlockTimestamp())
        );
        _claimWith(K2, batch(3), 250_000, imp);
    }

    /// Every registry state change emits exactly its own event, from the registry.
    function test_C22_eachStateChangeEmitsItsEvent() public {
        vm.recordLogs();
        _reg1(K1, rid(1), P, Q, KG500, bytes32(0));
        Vm.Log[] memory a = vm.getRecordedLogs();
        assertEq(a.length, 1);
        assertEq(a[0].emitter, address(registry));
        assertEq(a[0].topics[0], EmissionsClaimRegistry.ReportRegistered.selector);

        _claim(supplier, K1, batch(1), 100_000);
        Vm.Log[] memory b = vm.getRecordedLogs();
        assertEq(b.length, 1);
        assertEq(b[0].emitter, address(registry));
        assertEq(b[0].topics[0], EmissionsClaimRegistry.ShipmentClaimed.selector);

        _reg1(K2, rid(1), P, Q, KG500, K1);
        Vm.Log[] memory c = vm.getRecordedLogs();
        assertEq(c.length, 2);
        assertEq(c[0].topics[0], EmissionsClaimRegistry.ReportRegistered.selector);
        assertEq(c[1].topics[0], EmissionsClaimRegistry.ReportSuperseded.selector);

        _revoke(v1, K2);
        Vm.Log[] memory d = vm.getRecordedLogs();
        assertEq(d.length, 1);
        assertEq(d[0].emitter, address(registry));
        assertEq(d[0].topics[0], EmissionsClaimRegistry.ReportRevoked.selector);
    }

    function _revoke(address caller, bytes32 k) internal {
        vm.prank(caller);
        registry.revokeReport(k);
    }
}
