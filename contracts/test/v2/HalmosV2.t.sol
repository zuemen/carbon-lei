// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseV2} from "./BaseV2.t.sol";

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
}
