// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseV2} from "./BaseV2.t.sol";
import {VerifierAllowlistV2} from "../../src/v2/VerifierAllowlistV2.sol";
import {EmissionsClaimRegistryV2} from "../../src/v2/EmissionsClaimRegistryV2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @dev ERC-1271 wallet that accepts every signature: isolates the maturity rule from
/// signature checking.
contract AcceptAllWallet is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }
}

/// @notice Regression tests for the findings of our own AI-run adversarial review of the V2
/// CR1 mitigation (2026-10-10, not an outside audit; docs/SECURITY.md §13.1). Each test replays
/// one proof of concept that succeeded against the previous V2 code and checks that the attack
/// now fails. Organisations and LEIs are fictional (ZZZZ prefix). Not deployed.
contract ReviewFixesTest is BaseV2 {
    bytes32 internal R;
    uint256 internal thiefKey = uint256(keccak256("thief-key"));
    address internal thiefK;
    uint64 internal constant T1 = START + 365 days;

    function setUp() public override {
        super.setUp();
        R = _regL1(v1, 1, 1000);
        _claim(R, 1, 100);
        vm.warp(T1); // v1 has been bound for a year
        thiefK = vm.addr(thiefKey);
    }

    function _input(
        bytes32 key,
        bytes32 rid_,
        bytes32 scope,
        bytes32 cred,
        bytes32 aud,
        address sup,
        uint96 kg,
        bytes32 s
    ) internal pure returns (EmissionsClaimRegistryV2.ReportInput memory) {
        return EmissionsClaimRegistryV2.ReportInput({
            reportKey: key,
            reportIdHash: rid_,
            reportScopeKey: scope,
            credScopeKey: cred,
            auditorAidHash: aud,
            kelSeq: 9,
            supplier: sup,
            supplierCommit: bytes32(0),
            installationCommit: bytes32(0),
            verifiedKg: kg,
            validUntil: VALID_UNTIL,
            supersedes: s
        });
    }

    function _scope(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("P", n));
    }

    function _cred(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("Q", n));
    }

    function _current(bytes32 lei) internal view returns (address cur) {
        (cur,,,,,,) = allowlist.institutions(lei);
    }

    // ------------------------------------------------------------------ H1

    /// @dev H1 PoC: after a hostile rotation A -> thiefK, thiefK "consents" to thiefK -> thief2
    /// in the same block. Now refused: thiefK is not mature, so the WATCHER keeps its
    /// REVOKE_HOLD window to suspend the body.
    function test_H1_chainedRotation_selfConsent_reverts() public {
        _rotateDelayed(L1, thiefK);
        uint64 tBind = uint64(block.timestamp);
        address thief2 = makeAddr("thief2");
        _propose(L1, thief2);
        bytes memory sig = _sign(thiefKey, allowlist.rotationDigest(L1, thief2));
        vm.expectRevert(
            abi.encodeWithSelector(VerifierAllowlistV2.ConsentSignerNotMature.selector, L1, thiefK, tBind + DELAY)
        );
        allowlist.executeRotationSigned(L1, sig);
        assertEq(_current(L1), thiefK);
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        vm.warp(block.timestamp + HOLD);
        vm.prank(thiefK);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, thiefK));
        registry.revokeReport(R, 0);
        assertTrue(registry.isValidAt(R, START + 2 hours));
    }

    /// @dev H1 boundary: consent counts from exactly boundAt + ROTATION_DELAY.
    function test_H1_consentMaturityBoundary() public {
        _rotateDelayed(L1, thiefK);
        uint64 tBind = uint64(block.timestamp);
        address next = makeAddr("next");
        _propose(L1, next);
        bytes memory sig = _sign(thiefKey, allowlist.rotationDigest(L1, next));
        vm.warp(tBind + DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(VerifierAllowlistV2.ConsentSignerNotMature.selector, L1, thiefK, tBind + DELAY)
        );
        allowlist.executeRotationSigned(L1, sig);
        vm.warp(tBind + DELAY);
        allowlist.executeRotationSigned(L1, sig);
        assertEq(_current(L1), next);
    }

    /// @dev H1 as a fuzz property: with a signer that accepts anything, the consent path
    /// succeeds exactly when the current address has been bound for ROTATION_DELAY.
    function testFuzz_H1_consentNeedsMatureSigner(uint64 dt) public {
        dt = uint64(bound(dt, 0, 30 days));
        AcceptAllWallet w = new AcceptAllWallet();
        _rotateDelayed(L1, address(w));
        uint64 tBind = uint64(block.timestamp);
        _propose(L1, v1n);
        vm.warp(tBind + dt);
        try allowlist.executeRotationSigned(L1, hex"") {
            assertGe(dt, DELAY);
            assertEq(_current(L1), v1n);
        } catch {
            assertLt(dt, DELAY);
            assertEq(_current(L1), address(w));
        }
    }

    /// @dev A body added by the owner is not mature either: a fake body cannot consent at once.
    function test_H1_newlyAddedBodyCannotConsentAtOnce() public {
        bytes32 L3 = keccak256("ZZZZ-fresh-body");
        _addBody(L3, thiefK);
        _propose(L3, makeAddr("x"));
        bytes memory sig = _sign(thiefKey, allowlist.rotationDigest(L3, makeAddr("x")));
        vm.expectRevert(
            abi.encodeWithSelector(VerifierAllowlistV2.ConsentSignerNotMature.selector, L3, thiefK, T1 + DELAY)
        );
        allowlist.executeRotationSigned(L3, sig);
    }

    // ------------------------------------------------------------------ H2

    /// @dev H2 PoC: the owner key grants a shadow address WATCHER_ROLE to lift the real
    /// watcher's suspension. Direct grant now reverts; the shadow can do nothing.
    function test_H2_selfGrantedWatcher_reverts_suspensionHolds() public {
        address shadow = makeAddr("shadowWatcher");
        bytes32 role = allowlist.WATCHER_ROLE();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RoleGrantNeedsDelay.selector, role));
        allowlist.grantRole(role, shadow);
        _rotateDelayed(L1, thief);
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        vm.prank(shadow);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, shadow, role));
        allowlist.liftSuspension(L1);
        vm.warp(block.timestamp + HOLD);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, thief));
        registry.revokeReport(R, 0);
        assertTrue(registry.isValidAt(R, START + 2 hours));
    }

    /// @dev H2: a proposed watcher grant waits ROTATION_DELAY, and the real watcher cancels it.
    function test_H2_roleGrantProposal_watcherCancels() public {
        address shadow = makeAddr("shadowWatcher");
        bytes32 role = allowlist.WATCHER_ROLE();
        vm.expectEmit(true, true, false, true, address(allowlist));
        emit VerifierAllowlistV2.RoleGrantProposed(role, shadow, T1 + DELAY);
        vm.prank(owner);
        allowlist.proposeRoleGrant(role, shadow);
        vm.expectRevert(
            abi.encodeWithSelector(VerifierAllowlistV2.RoleGrantNotReady.selector, role, shadow, T1 + DELAY)
        );
        allowlist.executeRoleGrant(role, shadow);
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit VerifierAllowlistV2.RoleGrantCancelled(role, shadow, watcher);
        vm.prank(watcher);
        allowlist.cancelRoleGrant(role, shadow);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRoleGrant.selector, role, shadow));
        allowlist.executeRoleGrant(role, shadow);
        assertFalse(allowlist.hasRole(role, shadow));
    }

    /// @dev H2: an uncancelled grant executes after the delay (anyone may submit).
    function test_H2_roleGrant_executesAfterDelay() public {
        address w2 = makeAddr("second-watcher");
        bytes32 role = allowlist.WATCHER_ROLE();
        vm.prank(owner);
        allowlist.proposeRoleGrant(role, w2);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RoleGrantAlreadyPending.selector, role, w2));
        allowlist.proposeRoleGrant(role, w2);
        vm.warp(T1 + DELAY);
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit IAccessControl.RoleGranted(role, w2, stranger);
        vm.prank(stranger);
        allowlist.executeRoleGrant(role, w2);
        assertTrue(allowlist.hasRole(role, w2));
    }

    /// @dev H2: only the admin proposes, only WATCHER_ROLE, only watchers or the owner cancel.
    function test_H2_roleGrant_accessRules() public {
        bytes32 role = allowlist.WATCHER_ROLE();
        bytes32 admin = allowlist.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, admin)
        );
        allowlist.proposeRoleGrant(role, stranger);
        vm.startPrank(owner);
        vm.expectRevert(VerifierAllowlistV2.InvalidInput.selector);
        allowlist.proposeRoleGrant(admin, stranger);
        vm.expectRevert(VerifierAllowlistV2.InvalidInput.selector);
        allowlist.proposeRoleGrant(role, address(0));
        allowlist.proposeRoleGrant(role, stranger);
        vm.stopPrank();
        address[2] memory others = [stranger, v1];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NotAllowedToCancel.selector, others[i]));
            allowlist.cancelRoleGrant(role, stranger);
        }
        vm.prank(owner);
        allowlist.cancelRoleGrant(role, stranger);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRoleGrant.selector, role, stranger));
        allowlist.cancelRoleGrant(role, stranger);
    }

    /// @dev H2b PoC (no rotation at all): shadow watcher suspends L1, an owner-added fake body
    /// takes over L1's report scope at once. The grant reverts; and even after an honest
    /// suspension, a freshly added body cannot take over for REVOKE_HOLD (M1).
    function test_H2b_noRotation_suspendAndTakeover_blocked() public {
        address shadow = makeAddr("shadowWatcher");
        bytes32 L3 = keccak256("ZZZZ-attacker-body");
        bytes32 AID_X = keccak256("aud-x");
        vm.startPrank(owner);
        bytes32 role = allowlist.WATCHER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RoleGrantNeedsDelay.selector, role));
        allowlist.grantRole(role, shadow);
        allowlist.addVerifier(
            VerifierAllowlistV2.VerifierInput(L3, thief, keccak256("le"), keccak256("acc"), ACCREDITED_UNTIL)
        );
        allowlist.addAuditor(VerifierAllowlistV2.AuditorInput(AID_X, L3, keccak256("ecr")));
        vm.stopPrank();
        vm.prank(watcher); // worst case: L1 is suspended anyway
        allowlist.suspendVerifier(L1);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.CallerNotMature.selector, thief, T1 + HOLD));
        registry.registerReport(
            _input(keccak256("T"), keccak256("rid-t"), _scope(1), _cred(1), AID_X, thief, 1_000_000, R)
        );
        assertTrue(registry.isValid(R));
    }

    // ------------------------------------------------------------------ M1

    /// @dev M1 PoC: a freshly rotated address cannot revoke at once (held), but revising the
    /// report (branch b) used to invalidate it at once. Now refused until REVOKE_HOLD.
    function test_M1_supersedeByFreshAddress_reverts() public {
        _rotateDelayed(L1, thief);
        uint64 tBind = uint64(block.timestamp);
        address thiefSupplier = makeAddr("thiefSupplier");
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.CallerNotMature.selector, thief, tBind + HOLD));
        registry.registerReport(
            _input(keccak256("X1"), rid(1), _scope(1), _cred(1), AID_A, thiefSupplier, 1_000_000, R)
        );
        assertTrue(registry.isValid(R));
        _claim(R, 2, 1); // the honest supplier can still claim
    }

    /// @dev M1 PoC: takeover (branch c) through R used to invalidate every credential of the
    /// report scope at once. Now refused until REVOKE_HOLD.
    function test_M1_takeoverByFreshAddress_reverts() public {
        vm.prank(v1);
        registry.registerReport(
            _input(keccak256("R2"), rid(1), _scope(1), keccak256("Q-other"), AID_A, supplier, 500, bytes32(0))
        );
        _rotateDelayed(L1, thief);
        uint64 tBind = uint64(block.timestamp);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.CallerNotMature.selector, thief, tBind + HOLD));
        registry.registerReport(
            _input(keccak256("T1"), keccak256("rid-thief"), _scope(1), keccak256("Q-new"), AID_A, thief, 1, R)
        );
        assertTrue(registry.isValid(R));
        assertTrue(registry.isValid(keccak256("R2")));
    }

    /// @dev M1 cost and boundary: an honest rotated address may revise from boundAt + HOLD;
    /// a takeover emits ReportScopeTakenOver; a new registration (branch a) is never delayed.
    function test_M1_matureAddressRevises_newRegistrationNotDelayed() public {
        _rotateDelayed(L1, v1n);
        uint64 tBind = uint64(block.timestamp);
        _regL1(v1n, 7, 10); // branch (a) at once
        EmissionsClaimRegistryV2.ReportInput memory r =
            _input(keccak256("X2"), rid(1), _scope(1), _cred(1), AID_A, supplier, 1000, R);
        vm.warp(tBind + HOLD - 1);
        vm.prank(v1n);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.CallerNotMature.selector, v1n, tBind + HOLD));
        registry.registerReport(r);
        vm.warp(tBind + HOLD);
        vm.prank(v1n);
        registry.registerReport(r);
        assertFalse(registry.isValid(R));
        // takeover of report 7's scope by the same (now mature) body: emits ReportScopeTakenOver
        vm.expectEmit(true, true, true, true, address(registry));
        emit EmissionsClaimRegistryV2.ReportScopeTakenOver(rk(7), keccak256("T7"), _scope(7), L1);
        vm.prank(v1n);
        registry.registerReport(
            _input(keccak256("T7"), keccak256("rid-7b"), _scope(7), keccak256("Q-7b"), AID_A, supplier, 5, rk(7))
        );
    }

    // ------------------------------------------------------------------ M2

    /// @dev M2 PoC: a stolen body key cancelled every rescue rotation, even while suspended.
    /// Now the suspended body's address cannot cancel; the owner's rescue completes after the
    /// delay; the watcher lifts the suspension; the stolen key is unbound.
    function test_M2_suspendedBodyKeyCannotBlockRescue() public {
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        _propose(L1, v1n);
        vm.prank(v1); // the stolen key
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NotAllowedToCancel.selector, v1));
        allowlist.cancelRotation(L1);
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRotation(L1);
        assertEq(_current(L1), v1n);
        vm.prank(watcher);
        allowlist.liftSuspension(L1);
        assertTrue(allowlist.isVerifierActiveAt(v1n, uint64(block.timestamp)));
        assertFalse(allowlist.isVerifierActiveAt(v1, uint64(block.timestamp)));
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, v1));
        registry.revokeReport(R, 0);
    }

    /// @dev M2: the rescue stays cancellable by the WATCHER (a hostile rescue proposal by a
    /// stolen owner key is still stopped), and an active body can still cancel as before.
    function test_M2_watcherCancelsWhileSuspended_bodyCancelsAfterLift() public {
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        _propose(L1, thief);
        vm.prank(watcher);
        allowlist.cancelRotation(L1);
        vm.prank(watcher);
        allowlist.liftSuspension(L1);
        _propose(L1, thief);
        vm.prank(v1);
        allowlist.cancelRotation(L1);
        assertEq(_current(L1), v1);
    }

    // ------------------------------------------------------------------ L4

    /// @dev L4 (documented, not changed): a queued revocation keeps the effectiveFrom given at
    /// queue time, so a shipment claimed during the hold is invalid once it is executed. Claims
    /// are not blocked while it is queued; the SDK reports the queue as advisory.
    function test_L4_claimDuringHold_invalidOnceExecuted() public {
        _rotateDelayed(L1, v1n);
        uint64 tReq = uint64(block.timestamp);
        vm.prank(v1n);
        registry.revokeReport(R, tReq);
        vm.warp(tReq + 1 hours);
        _claim(R, 3, 10); // accepted while queued
        vm.warp(tReq + HOLD);
        registry.executeRevocation(R);
        (,,,,, bool validEarlier) = registry.shipmentStatus(batch(1));
        (,,,,, bool validDuringHold) = registry.shipmentStatus(batch(3));
        assertTrue(validEarlier);
        assertFalse(validDuringHold);
    }
}
