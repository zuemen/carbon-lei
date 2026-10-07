// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice Tests added for mutants that survived `node scripts/mutation-test.mjs`
/// (docs/data/mutation-2026-10-07.json). Each test names the mutant it kills.
contract MutationTest is Base {
    // ---------------------------------------------------------------- constructors

    /// Kills: Registry line 137, deleting the zero-address check, or comparing against address(1).
    function test_C103_registryRejectsZeroAllowlist() public {
        vm.expectRevert(EmissionsClaimRegistry.InvalidInput.selector);
        new EmissionsClaimRegistry(VerifierAllowlist(address(0)));
        // address(1) is not special: the constructor accepts it
        new EmissionsClaimRegistry(VerifierAllowlist(address(1)));
    }

    /// An owner at address(1) loses DEFAULT_ADMIN_ROLE when it transfers ownership.
    /// Kills Allowlist line 236 `oldOwner != address(0)` -> `address(1)`.
    function test_C106_ownerAtAddressOneLosesAdminOnTransfer() public {
        address one = address(1);
        VerifierAllowlist al = new VerifierAllowlist(one, watcher);
        assertTrue(al.hasRole(al.DEFAULT_ADMIN_ROLE(), one));
        vm.prank(one);
        al.transferOwnership(owner);
        assertEq(al.owner(), owner);
        assertFalse(al.hasRole(al.DEFAULT_ADMIN_ROLE(), one), "old owner keeps no admin role");
        assertTrue(al.hasRole(al.DEFAULT_ADMIN_ROLE(), owner));
    }

    // ---------------------------------------------------------------- report key 1

    /// A report whose key is bytes32(uint256(1)) is a normal report: it can be revised under a new
    /// report ID. Kills Registry line 341 `r.supersedes == bytes32(0)` -> `bytes32(uint256(1))`,
    /// which would treat `supersedes = 1` as "no supersedes" and revert PeriodAlreadyCovered.
    function test_C105_reportKeyOneCanBeSuperseded() public {
        bytes32 one = bytes32(uint256(1));
        _reg1(one, rid(1), P, Q, 1000, bytes32(0));
        _claim(supplier, one, batch(1), 300);
        _reg1(key("K-ONE-2"), rid(2), P, Q, 1000, one);
        assertEq(registry.reports(one).supersededBy, key("K-ONE-2"));
        assertEq(registry.remainingKg(key("K-ONE-2")), 700);
        (bytes32 current,,) = registry.reportScopes(P);
        assertEq(current, rid(2), "scope moved to the new report ID");
    }

    // ---------------------------------------------------------------- timestamp 1

    /// A full life cycle at block timestamp 1, the smallest non-zero timestamp. Both contracts
    /// use 0 as "never happened", so every timestamp field here is 1, not 0, and must count as set.
    /// Kills the `== 0` -> `== 1` mutants on timestamp fields (for example Registry lines 268
    /// and 304), which behave like the original at every timestamp except 1.
    function test_C104_lifecycleAtTimestampOne() public {
        vm.warp(1);
        VerifierAllowlist al = new VerifierAllowlist(owner, watcher);
        EmissionsClaimRegistry reg = new EmissionsClaimRegistry(al);
        vm.startPrank(owner);
        al.addVerifier(
            VerifierAllowlist.VerifierInput({
                leiHash: L1,
                verifier: v1,
                leCredSaidHash: keccak256("LE"),
                accreditationSaidHash: keccak256("ACC"),
                accreditedUntil: ACCREDITED_UNTIL
            })
        );
        al.addAuditor(VerifierAllowlist.AuditorInput(AID_A, L1, keccak256("ECR-A")));
        vm.stopPrank();
        assertTrue(al.isInstitutionActiveAt(L1, 1), "body active at 1");
        assertTrue(al.isVerifierActiveAt(v1, 1), "verifier active at 1");
        assertTrue(al.isAuthorizedAt(AID_A, v1, 1), "auditor authorized at 1");

        assertFalse(reg.isValidAt(key("never-registered"), 0), "unknown key at 0");
        bytes32 k1 = key("T1-SAID");
        vm.prank(v1);
        reg.registerReport(_input(k1, rid(1), P, Q, 1000, bytes32(0)));
        assertTrue(reg.isValidAt(k1, 1), "valid at 1");
        assertTrue(reg.isValid(k1), "valid now");
        assertEq(reg.remainingKg(k1), 1000, "headroom at 1");

        vm.prank(supplier);
        reg.claimShipment(k1, batch(1), 400, keccak256("imp"));
        assertEq(reg.remainingKg(k1), 600);
        (,,,, uint64 claimedAt, bool ok) = reg.shipmentStatus(batch(1));
        assertEq(claimedAt, 1);
        assertTrue(ok, "shipment valid at 1");
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.BatchAlreadyClaimed.selector, batch(1)));
        reg.claimShipment(k1, batch(1), 1, keccak256("imp"));

        // revision at timestamp 1, then revocation of the revision at timestamp 1
        bytes32 k2 = key("T1-SAID-2");
        vm.prank(v1);
        reg.registerReport(_input(k2, rid(1), P, Q, 1000, k1));
        assertFalse(reg.isValidAt(k1, 1), "superseded at 1");
        assertTrue(reg.isValidAt(k2, 1), "revision valid at 1");
        vm.prank(v1);
        reg.revokeReport(k2);
        assertFalse(reg.isValidAt(k2, 1), "revoked");
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.AlreadyRevoked.selector, k2));
        reg.revokeReport(k2);

        // suspension and auditor revocation at timestamp 1
        vm.prank(watcher);
        al.suspendVerifier(L1);
        assertFalse(al.isInstitutionActiveAt(L1, 1), "suspended at 1");
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AlreadySuspended.selector, L1));
        al.suspendVerifier(L1);
        vm.prank(watcher);
        al.liftSuspension(L1);
        assertTrue(al.isInstitutionActiveAt(L1, 1), "lifted at 1");
        vm.prank(watcher);
        al.revokeAuditor(AID_A, L1);
        assertFalse(al.isAuthorizedAt(AID_A, v1, 1), "auditor revoked at 1");
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AlreadyRevoked.selector, AID_A));
        al.revokeAuditor(AID_A, L1);

        // address rotation at timestamp 1
        vm.prank(owner);
        al.rotateVerifierAddress(L1, v1n);
        assertFalse(al.isVerifierActiveAt(v1, 1), "old address unbound at 1");
        (bytes32 credType,,) = al.credentialRecord(v1);
        assertEq(credType, bytes32(0), "old address has no credential record");
    }
}
