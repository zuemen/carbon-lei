// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseV2} from "./BaseV2.t.sol";
import {VerifierAllowlistV2} from "../../src/v2/VerifierAllowlistV2.sol";
import {EmissionsClaimRegistryV2} from "../../src/v2/EmissionsClaimRegistryV2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Prototype fix for finding C1 (branch c1-fix-prototype, not merged; docs/SECURITY.md
/// §13.1): WATCHER_ROLE revocation is two-step with ROTATION_DELAY, cancellable by any other
/// watcher or the owner (not by the watcher being revoked), and the last watcher cannot be
/// revoked; `renounceRole` stays immediate. These tests pin the mechanics and the trade-off:
/// a stolen watcher key can no longer be removed by the owner in one transaction.
contract C1FixTest is BaseV2 {
    bytes32 internal role;
    address internal w2 = makeAddr("watcher2");

    function setUp() public override {
        super.setUp();
        role = allowlist.WATCHER_ROLE();
    }

    function _addWatcher(address a) internal {
        vm.prank(owner);
        allowlist.proposeRoleGrant(role, a);
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRoleGrant(role, a);
    }

    // ------------------------------------------------------------- mechanics

    function test_C1_watcherCount_tracksGrantsRevokesAndRenounces() public {
        assertEq(allowlist.watcherCount(), 1);
        _addWatcher(w2);
        assertEq(allowlist.watcherCount(), 2);
        vm.prank(w2);
        allowlist.renounceRole(role, w2);
        assertEq(allowlist.watcherCount(), 1);
    }

    function test_C1_proposeRoleRevoke_inputsAndAccess() public {
        bytes32 admin = allowlist.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, admin)
        );
        allowlist.proposeRoleRevoke(role, watcher);
        vm.startPrank(owner);
        vm.expectRevert(VerifierAllowlistV2.InvalidInput.selector);
        allowlist.proposeRoleRevoke(admin, owner); // only WATCHER_ROLE
        vm.expectRevert(VerifierAllowlistV2.InvalidInput.selector);
        allowlist.proposeRoleRevoke(role, stranger); // not a watcher
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlistV2.RoleRevokeProposed(role, watcher, uint64(block.timestamp) + DELAY);
        allowlist.proposeRoleRevoke(role, watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RoleRevokeAlreadyPending.selector, role, watcher));
        allowlist.proposeRoleRevoke(role, watcher);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRoleRevoke.selector, role, w2));
        allowlist.executeRoleRevoke(role, w2);
    }

    /// @dev Two watchers: the revocation waits ROTATION_DELAY, then anyone executes it.
    function test_C1_revoke_waitsDelay_thenExecutes() public {
        _addWatcher(w2);
        uint64 t1 = START + 1 hours + DELAY; // literal: via-IR caches block.timestamp
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, w2);
        vm.warp(t1 + DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(VerifierAllowlistV2.RoleRevokeNotReady.selector, role, w2, t1 + DELAY)
        );
        allowlist.executeRoleRevoke(role, w2);
        assertTrue(allowlist.hasRole(role, w2));
        vm.warp(t1 + DELAY);
        vm.expectEmit(address(allowlist));
        emit IAccessControl.RoleRevoked(role, w2, stranger);
        vm.prank(stranger);
        allowlist.executeRoleRevoke(role, w2);
        assertFalse(allowlist.hasRole(role, w2));
        assertEq(allowlist.watcherCount(), 1);
    }

    /// @dev Cancel: another watcher or the owner; not the target, not the body, not a stranger.
    function test_C1_cancelRoleRevoke_access() public {
        _addWatcher(w2);
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, w2);
        address[3] memory refused = [w2, v1, stranger];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NotAllowedToCancel.selector, refused[i]));
            allowlist.cancelRoleRevoke(role, w2);
        }
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlistV2.RoleRevokeCancelled(role, w2, watcher);
        vm.prank(watcher);
        allowlist.cancelRoleRevoke(role, w2);
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, w2);
        vm.prank(owner);
        allowlist.cancelRoleRevoke(role, w2);
        assertEq(allowlist.pendingRoleRevokes(role, w2), 0);
    }

    /// @dev Two honest watchers, stolen owner key revoking both: each cancels the other's
    /// revocation. If neither reacts, only one executes; the other is the last watcher.
    function test_C1_twoWatchers_ownerKeyCannotRemoveBoth() public {
        _addWatcher(w2);
        vm.startPrank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        allowlist.proposeRoleRevoke(role, w2);
        vm.stopPrank();
        vm.prank(w2);
        allowlist.cancelRoleRevoke(role, watcher);
        vm.prank(watcher);
        allowlist.cancelRoleRevoke(role, w2);
        // Nobody reacts this time.
        vm.startPrank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        allowlist.proposeRoleRevoke(role, w2);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRoleRevoke(role, watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.LastWatcher.selector, w2));
        allowlist.executeRoleRevoke(role, w2);
        assertEq(allowlist.watcherCount(), 1);
    }

    /// @dev `renounceRole` is immediate, also for the last watcher, and clears a pending
    /// revocation (so a later re-grant does not inherit it).
    function test_C1_renounce_immediate_evenLastWatcher() public {
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        vm.prank(watcher);
        allowlist.renounceRole(role, watcher);
        assertFalse(allowlist.hasRole(role, watcher));
        assertEq(allowlist.watcherCount(), 0);
        assertEq(allowlist.pendingRoleRevokes(role, watcher), 0);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRoleRevoke.selector, role, watcher));
        allowlist.executeRoleRevoke(role, watcher);
    }

    // -------------------------------------------------------------- trade-off

    /// @dev Trade-off 1: watcher key `watcher` is stolen; an honest second watcher w2 exists.
    /// The owner (honest) proposes the revocation at once, but the stolen key keeps the role for
    /// ROTATION_DELAY (72 h). In that window it can suspend, lift the honest watcher's
    /// suspension, cancel the owner's rescue rotation, cancel held revocations and WATCHER
    /// grants; it cannot cancel its own revocation, and every one of its actions can be undone
    /// or repeated by w2 and the owner. Before the fix the owner removed it in one transaction.
    function test_C1_tradeoff_stolenWatcher_72hWindow_whatItCanAndCannotDo() public {
        _addWatcher(w2);
        uint64 t1 = START + 1 hours + DELAY;
        bytes32 k = _regL1(v1, 1, 1000);
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, watcher); // `watcher` is the stolen key from here on
        // cannot: cancel its own revocation
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NotAllowedToCancel.selector, watcher));
        allowlist.cancelRoleRevoke(role, watcher);
        // can: suspend a body (registrations by L1 stop until a watcher lifts)
        vm.prank(watcher);
        allowlist.suspendVerifier(L1);
        assertFalse(allowlist.isVerifierActiveAt(v1, uint64(block.timestamp)));
        vm.prank(w2);
        allowlist.liftSuspension(L1);
        // can: lift a suspension the honest watcher made
        vm.prank(w2);
        allowlist.suspendVerifier(L2);
        vm.prank(watcher);
        allowlist.liftSuspension(L2);
        assertTrue(allowlist.isVerifierActiveAt(v2, uint64(block.timestamp)));
        // can: cancel the owner's rotation (e.g. a rescue rotation), repeatedly, for 72 h
        _propose(L2, makeAddr("v2-rescue"));
        vm.prank(watcher);
        allowlist.cancelRotation(L2);
        // can: cancel a WATCHER grant (the owner's replacement watcher)
        address w3 = makeAddr("watcher3");
        vm.prank(owner);
        allowlist.proposeRoleGrant(role, w3);
        vm.prank(watcher);
        allowlist.cancelRoleGrant(role, w3);
        // can: cancel a held revocation by a freshly rotated honest address
        _rotateDelayed(L1, v1n); // t1 + DELAY: the stolen key's revocation is ready too
        vm.prank(v1n);
        registry.revokeReport(k, 0);
        vm.prank(watcher);
        registry.cancelRevocation(k);
        // ... until the revocation executes, exactly ROTATION_DELAY after the proposal
        assertEq(vm.getBlockTimestamp(), t1 + DELAY);
        allowlist.executeRoleRevoke(role, watcher);
        assertFalse(allowlist.hasRole(role, watcher));
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, watcher, role));
        allowlist.suspendVerifier(L1);
    }

    /// @dev Trade-off 2, the worst case of the window: the stolen watcher key and a stolen
    /// long-held body key together. The honest watcher w2 has suspended L1 because its key was
    /// stolen; the stolen watcher lifts it and the body key revokes a report in the same block
    /// (CR1a: a long-held address revokes at once). w2 can re-suspend, but not undo the
    /// revocation; this works for the full 72 h. Before the fix the same pair worked until
    /// the owner's single `revokeRole` transaction, and the watcher's holder can still end the
    /// window at once with `renounceRole`.
    function test_C1_tradeoff_stolenWatcherPlusStolenBodyKey_liftThenRevoke() public {
        _addWatcher(w2);
        bytes32 k = _regL1(v1, 1, 1000);
        vm.warp(block.timestamp + 30 days);
        vm.prank(w2);
        allowlist.suspendVerifier(L1);
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        vm.prank(watcher);
        allowlist.liftSuspension(L1);
        vm.prank(v1); // the stolen body key
        registry.revokeReport(k, 0);
        assertFalse(registry.isValid(k));
        vm.prank(w2);
        allowlist.suspendVerifier(L1);
    }

    /// @dev Trade-off 2b: the holder of the stolen watcher key ends the window at once.
    function test_C1_tradeoff_stolenWatcher_renounceEndsWindowAtOnce() public {
        _addWatcher(w2);
        vm.prank(watcher);
        allowlist.renounceRole(role, watcher);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, watcher, role));
        allowlist.liftSuspension(L1);
    }

    /// @dev Trade-off 3: with a single watcher whose key is stolen, the owner cannot remove it
    /// (LastWatcher) and cannot add a replacement (the stolen key cancels every grant). Only
    /// `renounceRole` by the key's holder, or a new allowlist, ends it. Deploy two watchers.
    function test_C1_tradeoff_singleStolenWatcher_ownerCannotReplace() public {
        address w3 = makeAddr("watcher3");
        vm.startPrank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        allowlist.proposeRoleGrant(role, w3);
        vm.stopPrank();
        vm.prank(watcher); // stolen
        allowlist.cancelRoleGrant(role, w3);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.LastWatcher.selector, watcher));
        allowlist.executeRoleRevoke(role, watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRoleGrant.selector, role, w3));
        allowlist.executeRoleGrant(role, w3);
        // The holder renounces: zero watchers, and the owner's grant can no longer be cancelled.
        vm.prank(watcher);
        allowlist.renounceRole(role, watcher);
        vm.prank(owner);
        allowlist.proposeRoleGrant(role, w3);
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRoleGrant(role, w3);
        assertTrue(allowlist.hasRole(role, w3));
        assertEq(allowlist.watcherCount(), 1);
    }

    /// @dev Ordinary watcher replacement, single-watcher deployment: grant the new one first
    /// (72 h), then revoke the old one (72 h). The old watcher could cancel the grant, not the
    /// revocation.
    function test_C1_ordinaryWatcherReplacement_takes144h() public {
        _addWatcher(w2);
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRoleRevoke(role, watcher);
        assertFalse(allowlist.hasRole(role, watcher));
        assertTrue(allowlist.hasRole(role, w2));
    }
}
