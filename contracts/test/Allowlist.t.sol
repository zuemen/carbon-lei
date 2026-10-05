// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";
import {Base} from "./Base.t.sol";

/// @notice VerifierAllowlist unit tests (C21, C22-allowlist, C27, C51, C54, C55,
/// C61, C62, C63, C70, C73/C83-allowlist, C87, ownership).
/// Spec: interface spec §3.1 / §4 / §5 / §6.1 / §7 (scenarios 6, 8)
/// + freeze addendum §5 (F-1..F-10) and §6. Timestamps are tracked in locals and never
/// read back from block.timestamp (via_ir may cache it across vm.warp).
contract AllowlistTest is Base {
    bytes32 internal constant WATCHER_ROLE = keccak256("WATCHER_ROLE");
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant L3 = keccak256("ZZZZ00EUVERIF3DEMO77"); // a third body, not in the fixture
    bytes32 internal constant AID_C = keccak256("EAuditorC-demo-aid");
    uint64 internal constant T0 = START + 1 hours; // time after Base.setUp

    address internal v3 = makeAddr("verifier3");
    address internal newOwner = makeAddr("newOwner");
    address internal watcher2 = makeAddr("watcher2");

    // ---------------------------------------------------------------- helpers

    function _vin(bytes32 lei, address addr, uint64 until)
        internal
        pure
        returns (VerifierAllowlist.VerifierInput memory)
    {
        return VerifierAllowlist.VerifierInput({
            leiHash: lei,
            verifier: addr,
            leCredSaidHash: keccak256(abi.encode("LE", lei)),
            accreditationSaidHash: keccak256(abi.encode("ACC", lei)),
            accreditedUntil: until
        });
    }

    function _ain(bytes32 aid, bytes32 lei) internal pure returns (VerifierAllowlist.AuditorInput memory) {
        return VerifierAllowlist.AuditorInput({auditorAidHash: aid, leiHash: lei, ecrSaidHash: _ecr(aid, lei)});
    }

    function _ecr(bytes32 aid, bytes32 lei) internal pure returns (bytes32) {
        return keccak256(abi.encode("ECR", aid, lei));
    }

    function _inst(bytes32 lei) internal view returns (VerifierAllowlist.InstitutionRecord memory r) {
        (
            r.currentAddress,
            r.leCredSaidHash,
            r.accreditationSaidHash,
            r.accreditedUntil,
            r.addedAt,
            r.suspendedAt,
            r.liftedAt
        ) = allowlist.institutions(lei);
    }

    function _bind(address a) internal view returns (VerifierAllowlist.AddressBinding memory b) {
        (b.leiHash, b.boundAt, b.unboundAt) = allowlist.leiOfAddress(a);
    }

    function _aud(bytes32 aid, bytes32 lei) internal view returns (VerifierAllowlist.AuditorRecord memory a) {
        (a.ecrSaidHash, a.addedAt, a.revokedAt) = allowlist.auditors(aid, lei);
    }

    function _ownableErr(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    function _roleErr(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    function _err(bytes4 sel) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(sel);
    }

    function _addAuditor(bytes32 aid, bytes32 lei) internal {
        vm.prank(owner);
        allowlist.addAuditor(_ain(aid, lei));
    }

    function _revokeAuditor(bytes32 aid, bytes32 lei) internal {
        vm.prank(watcher);
        allowlist.revokeAuditor(aid, lei);
    }

    function _assertBinding(address a, bytes32 lei, uint64 boundAt, uint64 unboundAt) internal view {
        VerifierAllowlist.AddressBinding memory b = _bind(a);
        assertEq(b.leiHash, lei, "binding.leiHash");
        assertEq(b.boundAt, boundAt, "binding.boundAt");
        assertEq(b.unboundAt, unboundAt, "binding.unboundAt");
    }

    function _assertSuspension(bytes32 lei, uint64 suspendedAt, uint64 liftedAt) internal view {
        VerifierAllowlist.InstitutionRecord memory r = _inst(lei);
        assertEq(r.suspendedAt, suspendedAt, "inst.suspendedAt");
        assertEq(r.liftedAt, liftedAt, "inst.liftedAt");
    }

    // =========================================================== C51 / C27
    // owner functions: OwnableUnauthorizedAccount(caller)
    // WATCHER functions: AccessControlUnauthorizedAccount(caller, WATCHER_ROLE), owner included

    function test_C51_rolesAtDeploy() public view {
        assertEq(allowlist.WATCHER_ROLE(), WATCHER_ROLE);
        assertEq(allowlist.DEFAULT_ADMIN_ROLE(), DEFAULT_ADMIN_ROLE);
        assertEq(allowlist.owner(), owner);
        assertTrue(allowlist.hasRole(WATCHER_ROLE, watcher));
        assertTrue(allowlist.hasRole(DEFAULT_ADMIN_ROLE, owner));
        assertFalse(allowlist.hasRole(WATCHER_ROLE, owner), "owner must not hold WATCHER");
        assertFalse(allowlist.hasRole(DEFAULT_ADMIN_ROLE, watcher), "WATCHER must not be admin");
        assertEq(allowlist.getRoleAdmin(WATCHER_ROLE), DEFAULT_ADMIN_ROLE);
    }

    function test_C51_addVerifier_stranger_reverts() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        vm.prank(stranger);
        vm.expectRevert(_ownableErr(stranger));
        allowlist.addVerifier(v);
    }

    function test_C51_addVerifier_watcher_reverts() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        vm.prank(watcher);
        vm.expectRevert(_ownableErr(watcher));
        allowlist.addVerifier(v);
    }

    function test_C51_addAuditor_stranger_reverts() public {
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(stranger);
        vm.expectRevert(_ownableErr(stranger));
        allowlist.addAuditor(a);
    }

    function test_C51_addAuditor_verifierOfThatBody_reverts() public {
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(v1);
        vm.expectRevert(_ownableErr(v1));
        allowlist.addAuditor(a);
    }

    function test_C51_addAuditor_watcher_reverts() public {
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(watcher);
        vm.expectRevert(_ownableErr(watcher));
        allowlist.addAuditor(a);
    }

    function test_C51_rotate_stranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(_ownableErr(stranger));
        allowlist.rotateVerifierAddress(L1, v1n);
    }

    function test_C51_rotate_verifierOfThatBody_reverts() public {
        vm.prank(v1);
        vm.expectRevert(_ownableErr(v1));
        allowlist.rotateVerifierAddress(L1, v1n);
    }

    function test_C51_rotate_watcher_reverts() public {
        vm.prank(watcher);
        vm.expectRevert(_ownableErr(watcher));
        allowlist.rotateVerifierAddress(L1, v1n);
    }

    function test_C51_suspend_stranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(_roleErr(stranger, WATCHER_ROLE));
        allowlist.suspendVerifier(L1);
    }

    function test_C51_suspend_owner_reverts() public {
        vm.prank(owner);
        vm.expectRevert(_roleErr(owner, WATCHER_ROLE));
        allowlist.suspendVerifier(L1);
    }

    function test_C51_suspend_otherVerifier_reverts() public {
        vm.prank(v2);
        vm.expectRevert(_roleErr(v2, WATCHER_ROLE));
        allowlist.suspendVerifier(L1);
    }

    function test_C51_lift_stranger_reverts() public {
        _suspend(L1);
        vm.prank(stranger);
        vm.expectRevert(_roleErr(stranger, WATCHER_ROLE));
        allowlist.liftSuspension(L1);
    }

    function test_C51_lift_owner_reverts() public {
        _suspend(L1);
        vm.prank(owner);
        vm.expectRevert(_roleErr(owner, WATCHER_ROLE));
        allowlist.liftSuspension(L1);
    }

    function test_C51_lift_suspendedVerifierItself_reverts() public {
        _suspend(L1);
        vm.prank(v1);
        vm.expectRevert(_roleErr(v1, WATCHER_ROLE));
        allowlist.liftSuspension(L1);
    }

    function test_C51_revokeAuditor_stranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(_roleErr(stranger, WATCHER_ROLE));
        allowlist.revokeAuditor(AID_A, L1);
    }

    function test_C51_fuzz_nonOwner_ownerFunctions_revert(address caller) public {
        vm.assume(caller != owner);
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(caller);
        vm.expectRevert(_ownableErr(caller));
        allowlist.addVerifier(v);
        vm.prank(caller);
        vm.expectRevert(_ownableErr(caller));
        allowlist.addAuditor(a);
        vm.prank(caller);
        vm.expectRevert(_ownableErr(caller));
        allowlist.rotateVerifierAddress(L1, v1n);
    }

    function test_C51_fuzz_nonWatcher_watcherFunctions_revert(address caller) public {
        vm.assume(caller != watcher);
        vm.prank(caller);
        vm.expectRevert(_roleErr(caller, WATCHER_ROLE));
        allowlist.suspendVerifier(L1);
        vm.prank(caller);
        vm.expectRevert(_roleErr(caller, WATCHER_ROLE));
        allowlist.revokeAuditor(AID_A, L1);
        _suspend(L1);
        vm.prank(caller);
        vm.expectRevert(_roleErr(caller, WATCHER_ROLE));
        allowlist.liftSuspension(L1);
    }

    function test_C27_revokeAuditor_owner_reverts() public {
        vm.prank(owner);
        vm.expectRevert(_roleErr(owner, WATCHER_ROLE));
        allowlist.revokeAuditor(AID_A, L1);
        // nothing changed
        assertEq(_aud(AID_A, L1).revokedAt, 0);
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, T0));
    }

    function test_C51_watcherCannotGrantRoles() public {
        vm.prank(watcher);
        vm.expectRevert(_roleErr(watcher, DEFAULT_ADMIN_ROLE));
        allowlist.grantRole(WATCHER_ROLE, stranger);
    }

    // ============================================================ ownership
    // DEFAULT_ADMIN_ROLE follows the owner (12 §6.1; _transferOwnership override).

    function test_Ownership_constructor_grantsAdminToOwnerAndWatcherRole() public {
        vm.expectEmit();
        emit Ownable.OwnershipTransferred(address(0), newOwner);
        vm.expectEmit();
        emit IAccessControl.RoleGranted(DEFAULT_ADMIN_ROLE, newOwner, address(this));
        vm.expectEmit();
        emit IAccessControl.RoleGranted(WATCHER_ROLE, watcher2, address(this));
        VerifierAllowlist a = new VerifierAllowlist(newOwner, watcher2);

        assertEq(a.owner(), newOwner);
        assertTrue(a.hasRole(DEFAULT_ADMIN_ROLE, newOwner));
        assertTrue(a.hasRole(WATCHER_ROLE, watcher2));
        assertFalse(a.hasRole(DEFAULT_ADMIN_ROLE, address(this)), "deployer must not keep admin");
    }

    function test_Ownership_transfer_movesDefaultAdminRole() public {
        vm.expectEmit(address(allowlist));
        emit Ownable.OwnershipTransferred(owner, newOwner);
        vm.expectEmit(address(allowlist));
        emit IAccessControl.RoleRevoked(DEFAULT_ADMIN_ROLE, owner, owner);
        vm.expectEmit(address(allowlist));
        emit IAccessControl.RoleGranted(DEFAULT_ADMIN_ROLE, newOwner, owner);
        vm.prank(owner);
        allowlist.transferOwnership(newOwner);

        assertEq(allowlist.owner(), newOwner);
        assertFalse(allowlist.hasRole(DEFAULT_ADMIN_ROLE, owner), "old owner keeps admin");
        assertTrue(allowlist.hasRole(DEFAULT_ADMIN_ROLE, newOwner), "new owner lacks admin");
        assertTrue(allowlist.hasRole(WATCHER_ROLE, watcher), "WATCHER untouched by transfer");
    }

    function test_Ownership_transfer_oldOwnerCannotGrantWatcher() public {
        vm.prank(owner);
        allowlist.transferOwnership(newOwner);

        vm.prank(owner);
        vm.expectRevert(_roleErr(owner, DEFAULT_ADMIN_ROLE));
        allowlist.grantRole(WATCHER_ROLE, watcher2);
    }

    function test_Ownership_transfer_oldOwnerCannotUseOwnerFunctions() public {
        vm.prank(owner);
        allowlist.transferOwnership(newOwner);

        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        vm.prank(owner);
        vm.expectRevert(_ownableErr(owner));
        allowlist.addVerifier(v);

        vm.prank(newOwner);
        allowlist.addVerifier(v);
        assertEq(_inst(L3).currentAddress, v3);
    }

    function test_Ownership_transfer_newOwnerAdministersWatcher() public {
        vm.prank(owner);
        allowlist.transferOwnership(newOwner);

        vm.startPrank(newOwner);
        allowlist.grantRole(WATCHER_ROLE, watcher2);
        allowlist.revokeRole(WATCHER_ROLE, watcher);
        vm.stopPrank();

        vm.prank(watcher);
        vm.expectRevert(_roleErr(watcher, WATCHER_ROLE));
        allowlist.suspendVerifier(L1);

        vm.prank(watcher2);
        allowlist.suspendVerifier(L1);
        assertEq(_inst(L1).suspendedAt, T0);
    }

    function test_Ownership_transfer_twice_adminFollowsEachHop() public {
        vm.prank(owner);
        allowlist.transferOwnership(newOwner);
        vm.prank(newOwner);
        allowlist.transferOwnership(stranger);

        assertFalse(allowlist.hasRole(DEFAULT_ADMIN_ROLE, owner));
        assertFalse(allowlist.hasRole(DEFAULT_ADMIN_ROLE, newOwner));
        assertTrue(allowlist.hasRole(DEFAULT_ADMIN_ROLE, stranger));
    }

    function test_Ownership_transferToSelf_keepsAdmin() public {
        vm.prank(owner);
        allowlist.transferOwnership(owner);
        assertEq(allowlist.owner(), owner);
        assertTrue(allowlist.hasRole(DEFAULT_ADMIN_ROLE, owner));
    }

    function test_Ownership_transferToZero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        allowlist.transferOwnership(address(0));
        assertTrue(allowlist.hasRole(DEFAULT_ADMIN_ROLE, owner));
    }

    function test_Ownership_renounce_dropsAdminRole() public {
        vm.prank(owner);
        allowlist.renounceOwnership();

        assertEq(allowlist.owner(), address(0));
        assertFalse(allowlist.hasRole(DEFAULT_ADMIN_ROLE, owner));
        assertFalse(allowlist.hasRole(DEFAULT_ADMIN_ROLE, address(0)));
        // WATCHER keeps working; nobody can grant WATCHER any more.
        _suspend(L1);
        vm.prank(owner);
        vm.expectRevert(_roleErr(owner, DEFAULT_ADMIN_ROLE));
        allowlist.grantRole(WATCHER_ROLE, watcher2);
    }

    // ================================================================= C54

    function test_C54_VerifierExists_activeBody() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L1, v3, ACCREDITED_UNTIL);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierExists.selector, L1));
        allowlist.addVerifier(v);
    }

    function test_C54_VerifierExists_whileSuspended() public {
        _suspend(L1);
        VerifierAllowlist.VerifierInput memory v = _vin(L1, v3, ACCREDITED_UNTIL);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierExists.selector, L1));
        allowlist.addVerifier(v);
    }

    function test_C54_VerifierExists_afterExpiry() public {
        uint64 t = ACCREDITED_UNTIL + 1;
        vm.warp(t);
        assertFalse(allowlist.isInstitutionActiveAt(L1, t), "precondition: L1 expired");
        VerifierAllowlist.VerifierInput memory v = _vin(L1, v3, t + 365 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierExists.selector, L1));
        allowlist.addVerifier(v);
    }

    function test_C54_VerifierNotFound_suspend() public {
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierNotFound.selector, L3));
        allowlist.suspendVerifier(L3);
    }

    function test_C54_VerifierNotFound_lift() public {
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierNotFound.selector, L3));
        allowlist.liftSuspension(L3);
    }

    function test_C54_VerifierNotFound_rotate() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierNotFound.selector, L3));
        allowlist.rotateVerifierAddress(L3, v3);
    }

    function test_C54_VerifierNotFound_addAuditor() public {
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L3);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.VerifierNotFound.selector, L3));
        allowlist.addAuditor(a);
    }

    function test_C54_AuditorExists_duplicate() public {
        VerifierAllowlist.AuditorInput memory a = _ain(AID_A, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AuditorExists.selector, AID_A, L1));
        allowlist.addAuditor(a);
    }

    function test_C54_AuditorExists_reAddAfterRevoke() public {
        _revokeAuditor(AID_A, L1);
        vm.warp(T0 + 1);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_A, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AuditorExists.selector, AID_A, L1));
        allowlist.addAuditor(a);
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, T0 + 1), "revocation is irreversible");
    }

    function test_C54_sameAidUnderOtherBody_isSeparateKey() public {
        _addAuditor(AID_A, L2); // "moves to another body" = a different (aid, L) key
        assertTrue(allowlist.isAuthorizedAt(AID_A, v2, T0));
        _revokeAuditor(AID_A, L1);
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, T0));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v2, T0), "revoking (A, L1) must not touch (A, L2)");
    }

    function test_C54_AuditorNotFound_unknownAid() public {
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AuditorNotFound.selector, AID_C, L1));
        allowlist.revokeAuditor(AID_C, L1);
    }

    function test_C54_AuditorNotFound_auditorOfOtherBody() public {
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AuditorNotFound.selector, AID_A, L2));
        allowlist.revokeAuditor(AID_A, L2);
    }

    function test_C54_AlreadySuspended() public {
        _suspend(L1);
        vm.warp(T0 + 1);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AlreadySuspended.selector, L1));
        allowlist.suspendVerifier(L1);
        _assertSuspension(L1, T0, 0);
    }

    function test_C54_NotSuspended_neverSuspended() public {
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotSuspended.selector, L1));
        allowlist.liftSuspension(L1);
    }

    function test_C54_InvalidExpiry_equalsNow() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, T0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.InvalidExpiry.selector, T0));
        allowlist.addVerifier(v);
    }

    function test_C54_InvalidExpiry_beforeNow() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, T0 - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.InvalidExpiry.selector, T0 - 1));
        allowlist.addVerifier(v);
    }

    function test_C54_InvalidExpiry_zero() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.InvalidExpiry.selector, uint64(0)));
        allowlist.addVerifier(v);
    }

    function test_C54_addVerifier_expiryOneSecondAhead_ok() public {
        vm.prank(owner);
        allowlist.addVerifier(_vin(L3, v3, T0 + 1));
        assertTrue(allowlist.isInstitutionActiveAt(L3, T0 + 1));
        assertFalse(allowlist.isInstitutionActiveAt(L3, T0 + 2));
    }

    function test_C54_addAuditor_suspendedBody_NotActiveVerifier() public {
        _suspend(L1);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotActiveVerifier.selector, v1));
        allowlist.addAuditor(a);
    }

    function test_C54_addAuditor_expiredBody_NotActiveVerifier() public {
        vm.warp(ACCREDITED_UNTIL + 1);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotActiveVerifier.selector, v1));
        allowlist.addAuditor(a);
    }

    function test_C54_addAuditor_suspendedRotatedBody_reportsCurrentAddress() public {
        _suspend(L1);
        vm.warp(T0 + 1);
        _rotate(L1, v1n);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotActiveVerifier.selector, v1n));
        allowlist.addAuditor(a);
    }

    function test_C54_addAuditor_afterLift_ok() public {
        _suspend(L1);
        vm.warp(T0 + 10);
        _lift(L1);
        _addAuditor(AID_C, L1);
        assertTrue(allowlist.isAuthorizedAt(AID_C, v1, T0 + 10));
    }

    // ================================================================= C55
    // InvalidInput (allowlist part) + F-7

    function test_C55_addVerifier_zeroLeiHash() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        v.leiHash = bytes32(0);
        vm.prank(owner);
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        allowlist.addVerifier(v);
    }

    function test_C55_addVerifier_zeroVerifier() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, address(0), ACCREDITED_UNTIL);
        vm.prank(owner);
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        allowlist.addVerifier(v);
    }

    function test_C55_addVerifier_zeroLeCredSaidHash() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        v.leCredSaidHash = bytes32(0);
        vm.prank(owner);
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        allowlist.addVerifier(v);
    }

    function test_C55_addVerifier_zeroAccreditationSaidHash() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, ACCREDITED_UNTIL);
        v.accreditationSaidHash = bytes32(0);
        vm.prank(owner);
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        allowlist.addVerifier(v);
    }

    function test_C55_rotate_zeroNewAddr() public {
        vm.prank(owner);
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        allowlist.rotateVerifierAddress(L1, address(0));
    }

    function test_C55_addAuditor_zeroAid() public {
        VerifierAllowlist.AuditorInput memory a = _ain(bytes32(0), L1);
        vm.prank(owner);
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        allowlist.addAuditor(a);
    }

    /// F-7: rotating to the current address is AddressAlreadyBound, not InvalidInput.
    function test_C55_rotate_toCurrentAddress_AddressAlreadyBound() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v1));
        allowlist.rotateVerifierAddress(L1, v1);
    }

    function test_C55_rotate_toCurrentAddressAfterRotation_AddressAlreadyBound() public {
        _rotate(L1, v1n);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v1n));
        allowlist.rotateVerifierAddress(L1, v1n);
    }

    function test_C55_constructor_zeroWatcher() public {
        vm.expectRevert(_err(VerifierAllowlist.InvalidInput.selector));
        new VerifierAllowlist(owner, address(0));
    }

    function test_C55_constructor_zeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new VerifierAllowlist(address(0), watcher);
    }

    // ========================================================== C21 / C70

    function test_C21_credTypeConstant_F1() public view {
        assertEq(allowlist.CRED_TYPE_LE(), keccak256("vLEI/LE"));
    }

    function test_C21_credentialRecord_currentAddress() public view {
        (bytes32 credType, uint64 expiresAt, bytes32 credHash) = allowlist.credentialRecord(v1);
        assertEq(credType, keccak256("vLEI/LE"), "credType");
        assertEq(expiresAt, ACCREDITED_UNTIL, "expiresAt");
        assertEq(credHash, keccak256(abi.encode("LE", L1)), "credHash");

        (credType, expiresAt, credHash) = allowlist.credentialRecord(v2);
        assertEq(credType, keccak256("vLEI/LE"));
        assertEq(expiresAt, ACCREDITED_UNTIL);
        assertEq(credHash, keccak256(abi.encode("LE", L2)));
    }

    function test_C21_credentialRecord_reflectsBodyFields() public {
        uint64 until = T0 + 30 days;
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, until);
        v.leCredSaidHash = keccak256("LE-cred-L3-custom");
        vm.prank(owner);
        allowlist.addVerifier(v);
        (bytes32 credType, uint64 expiresAt, bytes32 credHash) = allowlist.credentialRecord(v3);
        assertEq(credType, keccak256("vLEI/LE"));
        assertEq(expiresAt, until);
        assertEq(credHash, keccak256("LE-cred-L3-custom"));
    }

    /// Spec only zeroes the record for an unbound / rotated-away address; a suspended
    /// or expired body's current address still returns its record.
    function test_C21_credentialRecord_suspendedOrExpired_stillReturnsRecord() public {
        _suspend(L1);
        (bytes32 credType, uint64 expiresAt, bytes32 credHash) = allowlist.credentialRecord(v1);
        assertEq(credType, keccak256("vLEI/LE"));
        assertEq(expiresAt, ACCREDITED_UNTIL);
        assertEq(credHash, keccak256(abi.encode("LE", L1)));

        vm.warp(ACCREDITED_UNTIL + 1);
        (credType, expiresAt, credHash) = allowlist.credentialRecord(v2);
        assertEq(credType, keccak256("vLEI/LE"));
        assertEq(expiresAt, ACCREDITED_UNTIL);
        assertEq(credHash, keccak256(abi.encode("LE", L2)));
    }

    function test_C70_credentialRecord_unboundAddress_zeros() public view {
        (bytes32 credType, uint64 expiresAt, bytes32 credHash) = allowlist.credentialRecord(v5);
        assertEq(credType, bytes32(0));
        assertEq(expiresAt, 0);
        assertEq(credHash, bytes32(0));

        (credType, expiresAt, credHash) = allowlist.credentialRecord(address(0));
        assertEq(credType, bytes32(0));
        assertEq(expiresAt, 0);
        assertEq(credHash, bytes32(0));
    }

    function test_C70_credentialRecord_rotatedAway_zeros_newAddressHasRecord() public {
        _rotate(L1, v1n);
        (bytes32 credType, uint64 expiresAt, bytes32 credHash) = allowlist.credentialRecord(v1);
        assertEq(credType, bytes32(0), "old credType");
        assertEq(expiresAt, 0, "old expiresAt");
        assertEq(credHash, bytes32(0), "old credHash");

        (credType, expiresAt, credHash) = allowlist.credentialRecord(v1n);
        assertEq(credType, keccak256("vLEI/LE"));
        assertEq(expiresAt, ACCREDITED_UNTIL);
        assertEq(credHash, keccak256(abi.encode("LE", L1)));
    }

    function test_C70_credentialRecord_twoHops_onlyLatestHasRecord() public {
        _rotate(L1, v1n);
        vm.warp(T0 + 1);
        _rotate(L1, v1nn);
        (bytes32 c1,,) = allowlist.credentialRecord(v1);
        (bytes32 c2,,) = allowlist.credentialRecord(v1n);
        (bytes32 c3, uint64 e3, bytes32 h3) = allowlist.credentialRecord(v1nn);
        assertEq(c1, bytes32(0));
        assertEq(c2, bytes32(0));
        assertEq(c3, keccak256("vLEI/LE"));
        assertEq(e3, ACCREDITED_UNTIL);
        assertEq(h3, keccak256(abi.encode("LE", L1)));
    }

    // ================================================================= C61
    // time boundaries of isInstitutionActiveAt / isVerifierActiveAt / isAuthorizedAt

    function test_C61_accreditedUntil_sameSecondValid_plusOneInvalid_views() public view {
        assertTrue(allowlist.isInstitutionActiveAt(L1, ACCREDITED_UNTIL));
        assertFalse(allowlist.isInstitutionActiveAt(L1, ACCREDITED_UNTIL + 1));
        assertTrue(allowlist.isVerifierActiveAt(v1, ACCREDITED_UNTIL));
        assertFalse(allowlist.isVerifierActiveAt(v1, ACCREDITED_UNTIL + 1));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, ACCREDITED_UNTIL));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, ACCREDITED_UNTIL + 1));
    }

    function test_C61_accreditedUntil_sameSecond_addAuditorOk() public {
        vm.warp(ACCREDITED_UNTIL);
        _addAuditor(AID_C, L1);
        assertEq(_aud(AID_C, L1).addedAt, ACCREDITED_UNTIL);
    }

    function test_C61_accreditedUntil_plusOne_addAuditorReverts() public {
        vm.warp(ACCREDITED_UNTIL + 1);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotActiveVerifier.selector, v1));
        allowlist.addAuditor(a);
    }

    function test_C61_addedAt_boundary() public view {
        assertFalse(allowlist.isInstitutionActiveAt(L1, START - 1));
        assertTrue(allowlist.isInstitutionActiveAt(L1, START));
        assertFalse(allowlist.isVerifierActiveAt(v1, START - 1));
        assertTrue(allowlist.isVerifierActiveAt(v1, START));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, START - 1));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, START));
    }

    function test_C61_unknownBodyAndAddress_false() public view {
        assertFalse(allowlist.isInstitutionActiveAt(L3, T0));
        assertFalse(allowlist.isInstitutionActiveAt(bytes32(0), T0));
        assertFalse(allowlist.isVerifierActiveAt(v5, T0));
        assertFalse(allowlist.isVerifierActiveAt(address(0), T0));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v5, T0));
        assertFalse(allowlist.isAuthorizedAt(AID_C, v1, T0), "unregistered auditor");
        assertFalse(allowlist.isAuthorizedAt(AID_B, v1, T0), "auditor of L2 under L1");
        assertFalse(allowlist.isAuthorizedAt(AID_A, v2, T0), "auditor of L1 under L2");
    }

    function test_C61_suspensionInterval_halfOpen() public {
        uint64 tS = T0 + 1 hours;
        uint64 tL = T0 + 3 hours;
        vm.warp(tS);
        _suspend(L1);
        vm.warp(tL);
        _lift(L1);
        _assertSuspension(L1, tS, tL);

        assertTrue(allowlist.isInstitutionActiveAt(L1, tS - 1), "before suspendedAt");
        assertFalse(allowlist.isInstitutionActiveAt(L1, tS), "at suspendedAt");
        assertFalse(allowlist.isInstitutionActiveAt(L1, tL - 1), "just before liftedAt");
        assertTrue(allowlist.isInstitutionActiveAt(L1, tL), "at liftedAt");

        assertTrue(allowlist.isVerifierActiveAt(v1, tS - 1));
        assertFalse(allowlist.isVerifierActiveAt(v1, tS));
        assertFalse(allowlist.isVerifierActiveAt(v1, tL - 1));
        assertTrue(allowlist.isVerifierActiveAt(v1, tL));

        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, tS - 1));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, tS));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, tL - 1));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, tL));

        // other body untouched
        assertTrue(allowlist.isInstitutionActiveAt(L2, tS));
    }

    function test_C61_suspensionOpen_falseUntilExpiry() public {
        uint64 tS = T0 + 1 hours;
        vm.warp(tS);
        _suspend(L1);
        _assertSuspension(L1, tS, 0);
        assertTrue(allowlist.isInstitutionActiveAt(L1, tS - 1));
        assertFalse(allowlist.isInstitutionActiveAt(L1, tS));
        assertFalse(allowlist.isInstitutionActiveAt(L1, tS + 365 days));
        assertFalse(allowlist.isInstitutionActiveAt(L1, ACCREDITED_UNTIL));
    }

    function test_C61_suspensionBoundary_actions() public {
        uint64 tS = T0 + 1 hours;
        uint64 tL = T0 + 3 hours;
        vm.warp(tS);
        _suspend(L1);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotActiveVerifier.selector, v1));
        allowlist.addAuditor(a); // in the suspension second

        vm.warp(tL);
        _lift(L1);
        _addAuditor(AID_C, L1); // in the lift second
        assertEq(_aud(AID_C, L1).addedAt, tL);
    }

    function test_C61_suspendAndLiftSameSecond_emptyInterval() public {
        _suspend(L1);
        _lift(L1);
        _assertSuspension(L1, T0, T0);
        assertTrue(allowlist.isInstitutionActiveAt(L1, T0));
        assertTrue(allowlist.isInstitutionActiveAt(L1, T0 - 1));
    }

    function test_C61_auditorAddedAtRevokedAt_boundary() public {
        uint64 tA = T0 + 10;
        uint64 tR = T0 + 100;
        vm.warp(tA);
        _addAuditor(AID_C, L1);
        vm.warp(tR);
        _revokeAuditor(AID_C, L1);

        assertFalse(allowlist.isAuthorizedAt(AID_C, v1, tA - 1), "before addedAt");
        assertTrue(allowlist.isAuthorizedAt(AID_C, v1, tA), "at addedAt");
        assertTrue(allowlist.isAuthorizedAt(AID_C, v1, tR - 1), "before revokedAt");
        assertFalse(allowlist.isAuthorizedAt(AID_C, v1, tR), "at revokedAt");
        // verifier itself stays active
        assertTrue(allowlist.isVerifierActiveAt(v1, tR));
    }

    function test_C61_rotation_boundary() public {
        uint64 tr = T0 + 1 hours;
        vm.warp(tr);
        _rotate(L1, v1n);

        assertTrue(allowlist.isVerifierActiveAt(v1, tr - 1), "old addr before rotation");
        assertFalse(allowlist.isVerifierActiveAt(v1, tr), "old addr at rotation");
        assertFalse(allowlist.isVerifierActiveAt(v1n, tr - 1), "new addr before rotation");
        assertTrue(allowlist.isVerifierActiveAt(v1n, tr), "new addr at rotation");

        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, tr - 1));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, tr));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1n, tr - 1));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1n, tr));

        assertTrue(allowlist.isInstitutionActiveAt(L1, tr - 1));
        assertTrue(allowlist.isInstitutionActiveAt(L1, tr));
    }

    /// isInstitutionActiveAt / isVerifierActiveAt / isAuthorizedAt against the 12 §3.1
    /// formulas for any t, with one lifted suspension interval and a rotation inside it.
    function test_C61_fuzz_viewsMatchSpecFormula(uint64 t) public {
        uint64 tS = T0 + 1 hours;
        uint64 tR = T0 + 2 hours;
        uint64 tL = T0 + 3 hours;
        vm.warp(tS);
        _suspend(L1);
        vm.warp(tR);
        _rotate(L1, v1n);
        vm.warp(tL);
        _lift(L1);

        bool inst = t >= START && t <= ACCREDITED_UNTIL && (t < tS || t >= tL);
        assertEq(allowlist.isInstitutionActiveAt(L1, t), inst, "institution");
        assertEq(allowlist.isVerifierActiveAt(v1, t), inst && t >= START && t < tR, "old address");
        assertEq(allowlist.isVerifierActiveAt(v1n, t), inst && t >= tR, "new address");
        assertEq(allowlist.isAuthorizedAt(AID_A, v1, t), inst && t >= START && t < tR, "auditor via old");
        assertEq(allowlist.isAuthorizedAt(AID_A, v1n, t), inst && t >= tR, "auditor via new");
        assertFalse(allowlist.isAuthorizedAt(AID_B, v1n, t), "foreign auditor");
    }

    // ================================================================= C62
    // VerifierAddressRotated + AddressBinding / InstitutionRecord fields

    function test_C62_rotate_emitsEvent_andUpdatesRecords() public {
        uint64 tr = T0 + 1 hours;
        vm.warp(tr);
        VerifierAllowlist.InstitutionRecord memory before = _inst(L1);

        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAddressRotated(L1, v1, v1n, tr);
        _rotate(L1, v1n);

        // old binding: only unboundAt written
        _assertBinding(v1, L1, START, tr);
        // new binding
        _assertBinding(v1n, L1, tr, 0);
        // institution: only currentAddress changes
        VerifierAllowlist.InstitutionRecord memory r = _inst(L1);
        assertEq(r.currentAddress, v1n, "currentAddress");
        assertEq(r.leCredSaidHash, before.leCredSaidHash, "leCredSaidHash");
        assertEq(r.leCredSaidHash, keccak256(abi.encode("LE", L1)));
        assertEq(r.accreditationSaidHash, before.accreditationSaidHash, "accreditationSaidHash");
        assertEq(r.accreditationSaidHash, keccak256(abi.encode("ACC", L1)));
        assertEq(r.accreditedUntil, ACCREDITED_UNTIL, "accreditedUntil not extended");
        assertEq(r.addedAt, START, "addedAt");
        assertEq(r.suspendedAt, 0, "suspendedAt");
        assertEq(r.liftedAt, 0, "liftedAt");
        // auditor record untouched
        VerifierAllowlist.AuditorRecord memory a = _aud(AID_A, L1);
        assertEq(a.ecrSaidHash, keccak256("ECR-A"));
        assertEq(a.addedAt, START);
        assertEq(a.revokedAt, 0);
    }

    function test_C62_rotate_preservesSuspensionFields() public {
        uint64 tS = T0 + 1 hours;
        uint64 tL = T0 + 2 hours;
        uint64 tr = T0 + 3 hours;
        vm.warp(tS);
        _suspend(L1);
        vm.warp(tL);
        _lift(L1);
        vm.warp(tr);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAddressRotated(L1, v1, v1n, tr);
        _rotate(L1, v1n);
        _assertSuspension(L1, tS, tL);
    }

    // ================================================================= C63
    // two-hop rotation V1 -> V1n -> V1nn

    function test_C63_doubleRotation_auditorCarriesOver_oldAddressesBlocked() public {
        uint64 t1 = T0 + 1 hours;
        uint64 t2 = T0 + 2 hours;
        vm.warp(t1);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAddressRotated(L1, v1, v1n, t1);
        _rotate(L1, v1n);
        vm.warp(t2);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAddressRotated(L1, v1n, v1nn, t2);
        _rotate(L1, v1nn);

        _assertBinding(v1, L1, START, t1);
        _assertBinding(v1n, L1, t1, t2);
        _assertBinding(v1nn, L1, t2, 0);
        assertEq(_inst(L1).currentAddress, v1nn);

        // auditor not re-added, record unchanged, authorised through the newest address
        VerifierAllowlist.AuditorRecord memory a = _aud(AID_A, L1);
        assertEq(a.addedAt, START);
        assertEq(a.revokedAt, 0);
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1nn, t2));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1, t2));
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1n, t2));
        // history still answers for the window each address was current
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1, t1 - 1));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1n, t1));
        assertTrue(allowlist.isAuthorizedAt(AID_A, v1n, t2 - 1));
    }

    function test_C63_doubleRotation_V1CannotRegister() public {
        _rotate(L1, v1n);
        vm.warp(T0 + 1);
        _rotate(L1, v1nn);
        EmissionsClaimRegistry.ReportInput memory r = _input(key("K-C63-v1"), rid(631), P, Q, 500_000, bytes32(0));
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1));
        registry.registerReport(r);
    }

    function test_C63_doubleRotation_V1nCannotRegister() public {
        _rotate(L1, v1n);
        vm.warp(T0 + 1);
        _rotate(L1, v1nn);
        EmissionsClaimRegistry.ReportInput memory r = _input(key("K-C63-v1n"), rid(632), P, Q, 500_000, bytes32(0));
        vm.prank(v1n);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistry.NotActiveVerifier.selector, v1n));
        registry.registerReport(r);
    }

    function test_C63_doubleRotation_V1nnRegistersWithoutReAddingAuditor() public {
        _rotate(L1, v1n);
        vm.warp(T0 + 1);
        _rotate(L1, v1nn);
        _register(v1nn, _input(key("K-C63-v1nn"), rid(633), P, Q, 500_000, bytes32(0)));
        assertTrue(registry.isValid(key("K-C63-v1nn")));
    }

    // ========================================================= C73 / C83
    // scenario 8, allowlist part: suspend -> rotate -> lift -> re-suspend -> double lift

    function test_C73_suspensionSurvivesRotation() public {
        uint64 t2 = T0 + 2 hours;
        uint64 t3 = T0 + 3 hours;
        vm.warp(t2);
        _suspend(L1);
        vm.warp(t3);
        _rotate(L1, v1n);

        VerifierAllowlist.InstitutionRecord memory r = _inst(L1);
        assertEq(r.currentAddress, v1n);
        assertEq(r.suspendedAt, t2, "rotation must not clear suspendedAt");
        assertEq(r.liftedAt, 0, "rotation must not lift");
        assertFalse(allowlist.isInstitutionActiveAt(L1, t3));
        assertFalse(allowlist.isVerifierActiveAt(v1n, t3), "new address of suspended body");
        assertFalse(allowlist.isAuthorizedAt(AID_A, v1n, t3));
        // a WATCHER-suspended body cannot be revived by rotating either
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotActiveVerifier.selector, v1n));
        allowlist.addAuditor(a);
    }

    function test_C83_suspendRotateLiftResuspend_sequence() public {
        uint64 t2 = T0 + 2 hours;
        uint64 t3 = T0 + 3 hours;
        uint64 t6 = T0 + 6 hours;
        uint64 t8 = T0 + 8 hours;
        uint64 t9 = T0 + 9 hours;

        // step 2: suspend
        vm.warp(t2);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierSuspended(L1, t2);
        _suspend(L1);
        _assertSuspension(L1, t2, 0);

        // step 3: rotate while suspended
        vm.warp(t3);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAddressRotated(L1, v1, v1n, t3);
        _rotate(L1, v1n);
        _assertSuspension(L1, t2, 0);

        // step 6: lift
        vm.warp(t6);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.SuspensionLifted(L1, t6);
        _lift(L1);
        _assertSuspension(L1, t2, t6);
        assertFalse(allowlist.isVerifierActiveAt(v1n, t2), "v1n not yet bound at t2");
        assertFalse(allowlist.isVerifierActiveAt(v1n, t3), "v1n bound but body suspended");
        assertFalse(allowlist.isVerifierActiveAt(v1n, t6 - 1));
        assertTrue(allowlist.isVerifierActiveAt(v1n, t6), "active again from liftedAt");
        assertTrue(allowlist.isVerifierActiveAt(v1, t2 - 1), "v1 before suspension");
        assertFalse(allowlist.isVerifierActiveAt(v1, t6), "v1 rotated away, lift does not revive it");

        // step 8: second suspension overwrites the first interval
        vm.warp(t8);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierSuspended(L1, t8);
        _suspend(L1);
        _assertSuspension(L1, t8, 0);
        assertFalse(allowlist.isVerifierActiveAt(v1n, t8));
        assertTrue(allowlist.isVerifierActiveAt(v1n, t8 - 1));
        // Q04: only the most recent interval is kept; t2..t6 lives only in events
        assertTrue(allowlist.isInstitutionActiveAt(L1, t2), "older interval forgotten (Q04)");

        // step 9: lift, then lift again
        vm.warp(t9);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.SuspensionLifted(L1, t9);
        _lift(L1);
        _assertSuspension(L1, t8, t9);
        assertTrue(allowlist.isVerifierActiveAt(v1n, t9));

        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotSuspended.selector, L1));
        allowlist.liftSuspension(L1);
        _assertSuspension(L1, t8, t9);
    }

    function test_C83_doubleLift_NotSuspended() public {
        _suspend(L1);
        vm.warp(T0 + 10);
        _lift(L1);
        vm.warp(T0 + 20);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.NotSuspended.selector, L1));
        allowlist.liftSuspension(L1);
    }

    function test_C83_resuspendAfterLift_resetsLiftedAt() public {
        _suspend(L1);
        vm.warp(T0 + 10);
        _lift(L1);
        vm.warp(T0 + 20);
        _suspend(L1);
        _assertSuspension(L1, T0 + 20, 0);
        assertFalse(allowlist.isInstitutionActiveAt(L1, T0 + 20));
    }

    // ================================================================= C87
    // an address that was ever bound can never be bound again

    function test_C87_rotatedAwayAddress_addVerifier_AddressAlreadyBound() public {
        _rotate(L1, v1n);
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v1, ACCREDITED_UNTIL);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v1));
        allowlist.addVerifier(v);
    }

    function test_C87_currentAddressOfOtherBody_addVerifier_AddressAlreadyBound() public {
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v2, ACCREDITED_UNTIL);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v2));
        allowlist.addVerifier(v);
    }

    function test_C87_rotateBackToOldAddress_AddressAlreadyBound() public {
        _rotate(L1, v1n);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v1));
        allowlist.rotateVerifierAddress(L1, v1);
    }

    function test_C87_rotateToOtherBodysOldAddress_AddressAlreadyBound() public {
        _rotate(L1, v1n);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v1));
        allowlist.rotateVerifierAddress(L2, v1);
    }

    function test_C87_rotateToOtherBodysCurrentAddress_AddressAlreadyBound() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlist.AddressAlreadyBound.selector, v2));
        allowlist.rotateVerifierAddress(L1, v2);
    }

    // ============================================================ C22 events
    // every allowlist event, all fields (VerifierAddressRotated is in C62/C63/C83)

    function test_C22_VerifierAdded_allFields() public {
        uint64 until = T0 + 400 days;
        VerifierAllowlist.VerifierInput memory v = _vin(L3, v3, until);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAdded(L3, v3, until, keccak256(abi.encode("ACC", L3)));
        vm.prank(owner);
        allowlist.addVerifier(v);

        VerifierAllowlist.InstitutionRecord memory r = _inst(L3);
        assertEq(r.currentAddress, v3);
        assertEq(r.leCredSaidHash, keccak256(abi.encode("LE", L3)));
        assertEq(r.accreditationSaidHash, keccak256(abi.encode("ACC", L3)));
        assertEq(r.accreditedUntil, until);
        assertEq(r.addedAt, T0);
        assertEq(r.suspendedAt, 0);
        assertEq(r.liftedAt, 0);
        _assertBinding(v3, L3, T0, 0);
        assertTrue(allowlist.isVerifierActiveAt(v3, T0));
    }

    function test_C22_VerifierSuspended_allFields() public {
        uint64 t = T0 + 5 minutes;
        vm.warp(t);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierSuspended(L2, t);
        _suspend(L2);
        _assertSuspension(L2, t, 0);
    }

    function test_C22_SuspensionLifted_allFields() public {
        _suspend(L2);
        uint64 t = T0 + 7 minutes;
        vm.warp(t);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.SuspensionLifted(L2, t);
        _lift(L2);
        _assertSuspension(L2, T0, t);
    }

    function test_C22_AuditorAdded_allFields() public {
        uint64 t = T0 + 9 minutes;
        vm.warp(t);
        VerifierAllowlist.AuditorInput memory a = _ain(AID_C, L2);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.AuditorAdded(AID_C, L2, _ecr(AID_C, L2));
        vm.prank(owner);
        allowlist.addAuditor(a);

        VerifierAllowlist.AuditorRecord memory rec = _aud(AID_C, L2);
        assertEq(rec.ecrSaidHash, _ecr(AID_C, L2));
        assertEq(rec.addedAt, t);
        assertEq(rec.revokedAt, 0);
    }

    function test_C22_AuditorRevoked_allFields() public {
        uint64 t = T0 + 11 minutes;
        vm.warp(t);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.AuditorRevoked(AID_B, L2, t);
        _revokeAuditor(AID_B, L2);

        VerifierAllowlist.AuditorRecord memory rec = _aud(AID_B, L2);
        assertEq(rec.ecrSaidHash, keccak256("ECR-B"));
        assertEq(rec.addedAt, START);
        assertEq(rec.revokedAt, t);
    }

    function test_C22_VerifierAddressRotated_allFields() public {
        uint64 t = T0 + 13 minutes;
        vm.warp(t);
        vm.expectEmit(address(allowlist));
        emit VerifierAllowlist.VerifierAddressRotated(L2, v2, v3, t);
        _rotate(L2, v3);
    }
}
