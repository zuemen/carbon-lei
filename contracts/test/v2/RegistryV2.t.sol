// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseV2} from "./BaseV2.t.sol";
import {EmissionsClaimRegistryV2} from "../../src/v2/EmissionsClaimRegistryV2.sol";

/// @notice Revocation hold (REVOKE_HOLD), queue, cancellation and `effectiveFrom` of
/// EmissionsClaimRegistryV2 (docs/SECURITY.md §13.1). Registration and claims are V1 code.
contract RegistryV2Test is BaseV2 {
    bytes32 internal k;

    function setUp() public override {
        super.setUp();
        k = _regL1(v1, 1, 1_000_000);
    }

    /// @dev v1 was bound at START; from START + HOLD its revocations apply at once.
    function _matured() internal {
        vm.warp(START + HOLD);
    }

    // ----------------------------------------------------- immediate path

    function test_revoke_maturedAddress_appliesAtOnce() public {
        _matured();
        uint64 t = uint64(block.timestamp);
        vm.expectEmit(true, true, false, true, address(registry));
        emit EmissionsClaimRegistryV2.ReportRevoked(k, v1, t);
        vm.prank(v1);
        registry.revokeReport(k, 0);
        assertEq(_revokedAt(k), t);
        assertFalse(registry.isValid(k));
        assertFalse(registry.isValidAt(k, START + 2 hours)); // retroactive with effectiveFrom 0
        assertEq(registry.remainingKg(k), 0);
    }

    function test_revoke_boundaryOneSecondBeforeMaturity_isQueued() public {
        vm.warp(START + HOLD - 1);
        vm.prank(v1);
        registry.revokeReport(k, 0);
        assertEq(_revokedAt(k), 0);
        assertEq(_pendingRequester(k), v1);
    }

    function test_revoke_checks() public {
        _matured();
        vm.prank(v2);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotReportIssuer.selector, v2, L1));
        registry.revokeReport(k, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, stranger));
        registry.revokeReport(k, 0);
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.ReportNotFound.selector, rk(99)));
        registry.revokeReport(rk(99), 0);
        vm.prank(v1);
        vm.expectRevert(EmissionsClaimRegistryV2.InvalidInput.selector);
        registry.revokeReport(k, uint64(block.timestamp) + 1);
        vm.prank(v1);
        registry.revokeReport(k, 0);
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.AlreadyRevoked.selector, k));
        registry.revokeReport(k, 0);
    }

    function test_revoke_suspendedBody_reverts() public {
        _matured();
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, v1));
        registry.revokeReport(k, 0);
    }

    // -------------------------------------------------------- queued path

    function test_revoke_freshlyRotatedAddress_isQueued_reportStaysValid() public {
        _matured();
        _rotateDelayed(L1, v1n);
        uint64 t = uint64(block.timestamp);
        vm.expectEmit(true, true, false, true, address(registry));
        emit EmissionsClaimRegistryV2.RevocationQueued(k, v1n, 0, t + HOLD);
        vm.prank(v1n);
        registry.revokeReport(k, 0);

        assertEq(_revokedAt(k), 0);
        assertTrue(registry.isValid(k));
        (address req, uint64 ef, uint64 readyAt) = registry.pendingRevocations(k);
        assertEq(req, v1n);
        assertEq(ef, 0);
        assertEq(readyAt, t + HOLD);
        _claim(k, 1, 10_000); // claims continue during the hold
    }

    function test_executeRevocation_afterHold_anyoneMayCall() public {
        _matured();
        _rotateDelayed(L1, v1n);
        vm.prank(v1n);
        registry.revokeReport(k, 0);
        uint64 readyAt = uint64(block.timestamp) + HOLD;

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.RevocationNotReady.selector, k, readyAt));
        registry.executeRevocation(k);

        vm.warp(readyAt);
        vm.expectEmit(true, true, false, true, address(registry));
        emit EmissionsClaimRegistryV2.ReportRevoked(k, v1n, readyAt);
        vm.prank(stranger);
        registry.executeRevocation(k);
        assertEq(_revokedAt(k), readyAt);
        assertFalse(registry.isValid(k));
        assertEq(_pendingRequester(k), address(0));
    }

    function test_revoke_secondRequestWhileQueued_reverts() public {
        vm.prank(v1);
        registry.revokeReport(k, 0); // v1 is itself younger than HOLD here
        vm.prank(v1);
        vm.expectRevert(
            abi.encodeWithSelector(
                EmissionsClaimRegistryV2.RevocationPending.selector, k, uint64(block.timestamp) + HOLD
            )
        );
        registry.revokeReport(k, 0);
    }

    function test_revoke_onboardingWindowIsHeldToo() public {
        // A body added less than HOLD ago is held as well (cost of reading only boundAt).
        vm.prank(v1);
        registry.revokeReport(k, 0);
        assertEq(_revokedAt(k), 0);
        assertEq(_pendingRequester(k), v1);
    }

    function test_revoke_immediateAfterMaturity_replacesOwnQueuedRequest() public {
        vm.prank(v1);
        registry.revokeReport(k, 0);
        _matured();
        vm.prank(v1);
        registry.revokeReport(k, 0);
        assertEq(_revokedAt(k), uint64(block.timestamp));
        assertEq(_pendingRequester(k), address(0));
    }

    function test_executeRevocation_noPending_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NoPendingRevocation.selector, k));
        registry.executeRevocation(k);
    }

    // --------------------------------------------------------- cancel

    function test_cancelRevocation_byWatcher() public {
        vm.prank(v1);
        registry.revokeReport(k, 0);
        vm.expectEmit(true, true, false, false, address(registry));
        emit EmissionsClaimRegistryV2.RevocationCancelled(k, watcher);
        vm.prank(watcher);
        registry.cancelRevocation(k);
        vm.warp(block.timestamp + HOLD);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NoPendingRevocation.selector, k));
        registry.executeRevocation(k);
        assertTrue(registry.isValid(k));
    }

    function test_cancelRevocation_byIssuerCurrentAddress() public {
        vm.prank(v1);
        registry.revokeReport(k, 0);
        vm.prank(v1);
        registry.cancelRevocation(k);
        assertEq(_pendingRequester(k), address(0));
    }

    function test_cancelRevocation_byOthers_reverts() public {
        vm.prank(v1);
        registry.revokeReport(k, 0);
        address[3] memory others = [stranger, v2, owner];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotAllowedToCancel.selector, others[i]));
            registry.cancelRevocation(k);
        }
    }

    function test_cancelRevocation_noPending_reverts() public {
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NoPendingRevocation.selector, k));
        registry.cancelRevocation(k);
    }

    function test_executeRevocation_lapsesIfBodySuspendedDuringHold() public {
        vm.prank(v1);
        registry.revokeReport(k, 0);
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        vm.warp(block.timestamp + HOLD);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, v1));
        registry.executeRevocation(k);
    }

    function test_executeRevocation_lapsesIfRequesterRotatedAway() public {
        vm.prank(v1);
        registry.revokeReport(k, 0);
        _propose(L1, v1n);
        allowlist.executeRotationSigned(L1, _sign(v1Key, allowlist.rotationDigest(L1, v1n)));
        vm.warp(block.timestamp + HOLD);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, v1));
        registry.executeRevocation(k);
        vm.prank(v1n); // the body's new current address can clear it
        registry.cancelRevocation(k);
    }

    // ------------------------------------------------------ effectiveFrom

    function test_effectiveFrom_keepsEarlierShipmentsValid() public {
        _claim(k, 1, 100_000);
        uint64 tSplit = uint64(block.timestamp) + 1;
        vm.warp(tSplit);
        _claim(k, 2, 100_000);
        _matured();
        vm.expectEmit(true, false, false, true, address(registry));
        emit EmissionsClaimRegistryV2.RevocationEffectiveFrom(k, tSplit);
        vm.prank(v1);
        registry.revokeReport(k, tSplit);

        (,,,,, bool valid1) = registry.shipmentStatus(batch(1));
        (,,,,, bool valid2) = registry.shipmentStatus(batch(2));
        assertTrue(valid1);
        assertFalse(valid2);
        assertTrue(registry.isValidAt(k, tSplit - 1));
        assertFalse(registry.isValidAt(k, tSplit));
        assertFalse(registry.isValid(k));
        assertEq(registry.revocationEffectiveFrom(k), tSplit);
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.ReportInvalid.selector, k));
        registry.claimShipment(k, batch(3), 1, bytes32(0));
    }

    function test_effectiveFrom_zero_isRetroactiveLikeV1() public {
        _claim(k, 1, 100_000);
        _matured();
        vm.prank(v1);
        registry.revokeReport(k, 0);
        (,,,,, bool valid1) = registry.shipmentStatus(batch(1));
        assertFalse(valid1);
        assertFalse(registry.isValidAt(k, START + 1 hours));
    }

    function test_effectiveFrom_carriedThroughQueue() public {
        _claim(k, 1, 100_000);
        uint64 ef = uint64(block.timestamp) + 1;
        vm.warp(ef);
        vm.prank(v1);
        registry.revokeReport(k, ef);
        vm.warp(block.timestamp + HOLD);
        registry.executeRevocation(k);
        (,,,,, bool valid1) = registry.shipmentStatus(batch(1));
        assertTrue(valid1);
        assertEq(registry.revocationEffectiveFrom(k), ef);
    }

    // ------------------------------------------- V1 behaviour unchanged

    function test_registerClaimSupersede_unchangedFromV1() public {
        _claim(k, 1, 400_000);
        EmissionsClaimRegistryV2.ReportInput memory r = EmissionsClaimRegistryV2.ReportInput({
            reportKey: rk(2),
            reportIdHash: rid(1),
            reportScopeKey: keccak256(abi.encode("P", uint256(1))),
            credScopeKey: keccak256(abi.encode("Q", uint256(1))),
            auditorAidHash: AID_A,
            kelSeq: 4,
            supplier: supplier,
            supplierCommit: keccak256("supplier-commit"),
            installationCommit: keccak256("installation-commit"),
            verifiedKg: 300_000,
            validUntil: VALID_UNTIL,
            supersedes: k
        });
        vm.prank(v1);
        vm.expectRevert(
            abi.encodeWithSelector(
                EmissionsClaimRegistryV2.SupersedeOverClaimed.selector, r.credScopeKey, uint96(400_000), uint96(300_000)
            )
        );
        registry.registerReport(r);
        r.verifiedKg = 900_000;
        vm.prank(v1);
        registry.registerReport(r);
        assertEq(registry.remainingKg(rk(2)), 500_000);
        assertFalse(registry.isValid(k));
        vm.prank(supplier);
        vm.expectRevert(
            abi.encodeWithSelector(EmissionsClaimRegistryV2.ExceedsVerifiedTonnage.selector, 500_000, 500_001)
        );
        registry.claimShipment(rk(2), batch(9), 500_001, bytes32(0));
    }
}
