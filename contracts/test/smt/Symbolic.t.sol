// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";

/// @notice Bounded symbolic check for hevm (docs/SECURITY.md §9.2). Run from the repository root:
/// `forge build --ast --out out && hevm test --root . --match prove_`.
/// The quantity is symbolic, so the check covers every uint96 value, not a fuzz sample; the
/// call sequence (one registration, one claim) is fixed, so it is bounded. `forge test`
/// ignores this function (no `test` prefix). Plain `assert` is used for hevm.
contract SymbolicTest is Base {
    /// @dev P1, one claim against a fresh 500 t credential: the claim is accepted exactly when
    /// 0 < q <= verifiedKg, and the slot then holds exactly q (else 0).
    function prove_P1_oneClaim(uint96 q) public {
        bytes32 k = keccak256("ESAID-S-A");
        _reg1(k, rid(1), P, Q, 500_000, bytes32(0));
        vm.prank(supplier);
        bool ok;
        try registry.claimShipment(k, batch(1), q, keccak256("importer")) {
            ok = true;
        } catch {}
        (uint96 claimedKg,) = registry.credScopes(P, Q);
        assert(ok == (q != 0 && q <= 500_000));
        assert(claimedKg == (ok ? q : 0));
    }
}
