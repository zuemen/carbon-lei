// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseV2} from "./BaseV2.t.sol";
import {AcceptAllWallet} from "./ReviewFixes.t.sol";

/// @notice Bounded symbolic checks of the CR1 mitigation (docs/SECURITY.md §13.1), for Halmos:
/// `npm run contracts:symbolic:v2`. Same conventions as `HalmosPropertiesTest`: parameters are
/// symbolic, the call sequence is fixed per function, the start state is the `BaseV2` fixture.
/// `forge test` ignores these functions (no `test` prefix).
contract HalmosCR1Test is BaseV2 {
    function setUp() public override {
        owner = address(0xA00001);
        watcher = address(0xA00002);
        v1 = address(0xB00001);
        v2 = address(0xB00004);
        thief = address(0xB00006);
        v1n = address(0xB00002);
        supplier = address(0xC00001);
        stranger = address(0xC00003);
        super.setUp();
    }

    /// @dev D1: propose, wait any `dt`, execute without a signature. The rotation succeeds
    /// exactly when `dt >= ROTATION_DELAY`; otherwise the old address stays the body's.
    function check_D1_rotationDelay(uint64 dt) public {
        vm.assume(dt < 3650 days);
        _propose(L1, thief);
        uint64 t0 = START + 1 hours;
        vm.warp(t0 + dt);
        bool ok;
        try allowlist.executeRotation(L1) {
            ok = true;
        } catch {}
        assert(ok == (dt >= DELAY));
        (address cur,,,,,,) = allowlist.institutions(L1);
        assert(cur == (ok ? thief : v1));
    }

    /// @dev H1: after a rotation by delay, the new address revokes at any age with any
    /// `effectiveFrom`, then anyone tries `executeRevocation` after any further wait. The report
    /// is revoked only if it happened at least REVOKE_HOLD after the new address was bound.
    function check_H1_revocationHold(uint64 age, uint64 ef, uint64 waitAfter) public {
        vm.assume(age < 3650 days && waitAfter < 3650 days);
        bytes32 k = _regL1(v1, 1, 1000);
        _propose(L1, thief);
        uint64 tBind = START + 1 hours + DELAY;
        vm.warp(tBind);
        allowlist.executeRotation(L1);

        vm.warp(tBind + age);
        vm.prank(thief);
        try registry.revokeReport(k, ef) {} catch {}
        vm.warp(tBind + age + waitAfter);
        try registry.executeRevocation(k) {} catch {}

        uint64 revokedAt = registry.reports(k).revokedAt;
        assert(revokedAt == 0 || revokedAt >= tBind + HOLD);
    }

    /// @dev H1b (review fix H1): after a rotation by delay to an address whose signature checks
    /// always pass (an accept-all ERC-1271 wallet, so only the maturity rule decides), a second
    /// rotation on the consent path after any `dt` succeeds exactly when `dt >= ROTATION_DELAY`.
    function check_H1b_consentNeedsMatureSigner(uint64 dt) public {
        vm.assume(dt < 3650 days);
        AcceptAllWallet w = new AcceptAllWallet();
        _propose(L1, address(w));
        uint64 tBind = START + 1 hours + DELAY;
        vm.warp(tBind);
        allowlist.executeRotation(L1);
        _propose(L1, v1n);
        vm.warp(tBind + dt);
        bool ok;
        try allowlist.executeRotationSigned(L1, hex"") {
            ok = true;
        } catch {}
        assert(ok == (dt >= DELAY));
        (address cur,,,,,,) = allowlist.institutions(L1);
        assert(cur == (ok ? v1n : address(w)));
    }
    /// @dev C1 prototype fix: the owner proposes revoking the watcher, with or without a second
    /// watcher granted first; anyone tries `executeRoleRevoke` after any `dt`, and the revoked
    /// watcher tries to cancel. The watcher loses the role exactly when `dt >= ROTATION_DELAY`
    /// and another watcher exists; there is always at least one watcher; the target never
    /// cancels its own revocation.
    function check_C1_watcherRevokeDelay(uint64 dt, bool second) public {
        vm.assume(dt < 3650 days);
        bytes32 role = allowlist.WATCHER_ROLE();
        address w2 = address(0xA00003);
        uint64 t0 = START + 1 hours;
        if (second) {
            vm.prank(owner);
            allowlist.proposeRoleGrant(role, w2);
            t0 += DELAY;
            vm.warp(t0);
            allowlist.executeRoleGrant(role, w2);
        }
        vm.prank(owner);
        allowlist.proposeRoleRevoke(role, watcher);
        vm.prank(watcher);
        try allowlist.cancelRoleRevoke(role, watcher) {
            assert(false);
        } catch {}
        vm.warp(t0 + dt);
        try allowlist.executeRoleRevoke(role, watcher) {} catch {}
        bool gone = !allowlist.hasRole(role, watcher);
        assert(gone == (dt >= DELAY && second));
        assert(allowlist.watcherCount() >= 1);
    }
}
