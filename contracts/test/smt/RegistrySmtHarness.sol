// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VerifierAllowlist} from "../../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../../src/EmissionsClaimRegistry.sol";

/// @notice Test-only harness for the solc SMTChecker (FOUNDRY_PROFILE=smt, see foundry.toml).
/// It inherits the deployed registry unchanged and only adds view functions whose asserts
/// state P1 and P2 of docs/SECURITY.md §9. It is never deployed; the default profile compiles
/// it like any other test file, and the deployed bytecode of EmissionsClaimRegistry is unaffected.
contract RegistrySmtHarness is EmissionsClaimRegistry {
    constructor(VerifierAllowlist allowlist_) EmissionsClaimRegistry(allowlist_) {}

    /// @dev P1 (conservation), per ledger slot: the cumulative claim fits the slot's latest
    /// credential, and an empty slot has no claims.
    function checkP1(bytes32 reportScopeKey, bytes32 credScopeKey) external view {
        CredScope storage cs = credScopes[reportScopeKey][credScopeKey];
        if (cs.latestReportKey == bytes32(0)) {
            assert(cs.claimedKg == 0);
        } else {
            assert(cs.claimedKg <= _reports[cs.latestReportKey].verifiedKg);
        }
    }

    /// @dev P2 (batch uniqueness), as a state property: a recorded shipment always points to a
    /// registered report, so `claimedAt != 0` is a sound "already claimed" marker for that batch.
    function checkP2(bytes32 batchKey) external view {
        Shipment storage s = shipments[batchKey];
        if (s.claimedAt != 0) {
            assert(s.quantityKg != 0);
            assert(_reports[s.reportKey].registeredAt != 0);
            assert(s.claimedAt >= _reports[s.reportKey].registeredAt);
        }
    }
}
