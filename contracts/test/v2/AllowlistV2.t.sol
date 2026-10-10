// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseV2} from "./BaseV2.t.sol";
import {VerifierAllowlistV2} from "../../src/v2/VerifierAllowlistV2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal ERC-1271 wallet with one signing key, standing in for a body's smart wallet.
contract MockWallet1271 is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return err == ECDSA.RecoverError.NoError && rec == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

/// @notice Two-step address rotation, cancellation, consent signature and ownership rules of
/// VerifierAllowlistV2 (docs/SECURITY.md §13.1).
contract AllowlistV2Test is BaseV2 {
    // ------------------------------------------------------------ propose

    function test_propose_storesAndEmits_noStateChange() public {
        vm.expectEmit(true, true, false, true, address(allowlist));
        emit VerifierAllowlistV2.RotationProposed(L1, v1n, uint64(block.timestamp) + DELAY);
        _propose(L1, v1n);

        (address newAddr, uint64 readyAt) = allowlist.pendingRotations(L1);
        assertEq(newAddr, v1n);
        assertEq(readyAt, uint64(block.timestamp) + DELAY);
        assertTrue(allowlist.isVerifierActiveAt(v1, uint64(block.timestamp)));
        assertFalse(allowlist.isVerifierActiveAt(v1n, uint64(block.timestamp)));
        assertEq(_boundAt(v1n), 0);
    }

    function test_propose_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        allowlist.proposeRotation(L1, v1n);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, watcher));
        allowlist.proposeRotation(L1, v1n);
    }

    function test_propose_rejectsBadInput() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.VerifierNotFound.selector, bytes32(uint256(7))));
        allowlist.proposeRotation(bytes32(uint256(7)), v1n);
        vm.expectRevert(VerifierAllowlistV2.InvalidInput.selector);
        allowlist.proposeRotation(L1, address(0));
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.AddressAlreadyBound.selector, v2));
        allowlist.proposeRotation(L1, v2);
        allowlist.proposeRotation(L1, v1n);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RotationAlreadyPending.selector, L1));
        allowlist.proposeRotation(L1, thief);
        vm.stopPrank();
    }

    function test_rotateVerifierAddress_oneStepIsGone() public {
        (bool ok,) =
            address(allowlist).call(abi.encodeWithSignature("rotateVerifierAddress(bytes32,address)", L1, thief));
        assertFalse(ok);
    }

    // ------------------------------------------------------------ execute

    function test_execute_beforeDelay_reverts() public {
        _propose(L1, v1n);
        uint64 readyAt = uint64(block.timestamp) + DELAY;
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RotationNotReady.selector, L1, readyAt));
        allowlist.executeRotation(L1);
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.RotationNotReady.selector, L1, readyAt));
        allowlist.executeRotation(L1);
    }

    function test_execute_afterDelay_rotates_anyoneMayCall() public {
        _propose(L1, v1n);
        vm.warp(block.timestamp + DELAY);
        uint64 t = uint64(block.timestamp);
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit VerifierAllowlistV2.VerifierAddressRotated(L1, v1, v1n, t);
        vm.prank(stranger);
        allowlist.executeRotation(L1);

        (address cur,,,,,,) = allowlist.institutions(L1);
        assertEq(cur, v1n);
        assertFalse(allowlist.isVerifierActiveAt(v1, t));
        assertTrue(allowlist.isVerifierActiveAt(v1n, t));
        (, uint64 boundAt, uint64 unboundAt) = allowlist.leiOfAddress(v1);
        assertEq(unboundAt, t);
        assertEq(boundAt, START);
        assertEq(_boundAt(v1n), t);
        (address pend,) = allowlist.pendingRotations(L1);
        assertEq(pend, address(0));
        assertEq(allowlist.rotationNonce(L1), 1);
        // V1-shaped views keep working: the new address carries the body's credential.
        (bytes32 credType,, bytes32 credHash) = allowlist.credentialRecord(v1n);
        assertEq(credType, allowlist.CRED_TYPE_LE());
        assertEq(credHash, keccak256(abi.encode("LE", L1)));
        (credType,,) = allowlist.credentialRecord(v1);
        assertEq(credType, bytes32(0));
    }

    function test_execute_noPending_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRotation.selector, L1));
        allowlist.executeRotation(L1);
    }

    function test_execute_rechecksAddressBoundDuringDelay() public {
        _propose(L1, v1n);
        _addBody(keccak256("ZZZZ-L3"), v1n); // v1n bound to another body meanwhile
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.AddressAlreadyBound.selector, v1n));
        allowlist.executeRotation(L1);
    }

    // ------------------------------------------------------------- cancel

    function test_cancel_byCurrentAddress() public {
        _propose(L1, thief);
        vm.expectEmit(true, true, true, true, address(allowlist));
        emit VerifierAllowlistV2.RotationCancelled(L1, thief, v1);
        vm.prank(v1);
        allowlist.cancelRotation(L1);
        assertEq(allowlist.rotationNonce(L1), 1);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRotation.selector, L1));
        allowlist.executeRotation(L1);
    }

    function test_cancel_byWatcherAndOwner() public {
        _propose(L1, thief);
        vm.prank(watcher);
        allowlist.cancelRotation(L1);
        _propose(L1, thief);
        vm.prank(owner);
        allowlist.cancelRotation(L1);
        assertEq(allowlist.rotationNonce(L1), 2);
    }

    function test_cancel_byOthers_reverts() public {
        _propose(L1, thief);
        address[3] memory others = [stranger, thief, v2];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NotAllowedToCancel.selector, others[i]));
            allowlist.cancelRotation(L1);
        }
        vm.prank(v1);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRotation.selector, L2));
        allowlist.cancelRotation(L2);
    }

    // ------------------------------------------------------ consent path

    function test_signed_currentAddressConsent_rotatesAtOnce() public {
        vm.warp(START + DELAY); // v1 (bound at START) is mature: H1 fix
        _propose(L1, v1n);
        bytes memory sig = _sign(v1Key, allowlist.rotationDigest(L1, v1n));
        vm.prank(stranger);
        allowlist.executeRotationSigned(L1, sig);
        (address cur,,,,,,) = allowlist.institutions(L1);
        assertEq(cur, v1n);
        assertEq(_boundAt(v1n), uint64(block.timestamp));
    }

    function test_signed_wrongSigner_reverts() public {
        _propose(L1, thief);
        bytes memory sig = _sign(uint256(keccak256("thief-key")), allowlist.rotationDigest(L1, thief));
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, sig);
    }

    function test_signed_consentForOtherAddress_reverts() public {
        bytes memory sigForV1n = _sign(v1Key, allowlist.rotationDigest(L1, v1n));
        _propose(L1, thief);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, sigForV1n);
    }

    function test_signed_consentNotReusableAfterCancel() public {
        _propose(L1, v1n);
        bytes memory sig = _sign(v1Key, allowlist.rotationDigest(L1, v1n));
        vm.prank(v1);
        allowlist.cancelRotation(L1);
        _propose(L1, v1n);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, sig);
    }

    function test_signed_withoutProposal_reverts() public {
        bytes memory sig = _sign(v1Key, allowlist.rotationDigest(L1, v1n));
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRotation.selector, L1));
        allowlist.executeRotationSigned(L1, sig);
    }

    function test_signed_malleableHighS_reverts() public {
        _propose(L1, v1n);
        bytes32 digest = allowlist.rotationDigest(L1, v1n);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(v1Key, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, flipped);
    }

    function test_signed_erc1271Wallet() public {
        uint256 walletKey = uint256(keccak256("wallet-signer"));
        MockWallet1271 wallet = new MockWallet1271(vm.addr(walletKey));
        _rotateDelayed(L1, address(wallet));
        _propose(L1, v1n);
        bytes32 digest = allowlist.rotationDigest(L1, v1n);
        vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.BadRotationSignature.selector, L1));
        allowlist.executeRotationSigned(L1, _sign(uint256(keccak256("other")), digest));
        vm.warp(block.timestamp + DELAY); // the wallet's binding must be mature (H1 fix)
        allowlist.executeRotationSigned(L1, _sign(walletKey, digest));
        (address cur,,,,,,) = allowlist.institutions(L1);
        assertEq(cur, v1n);
    }

    // ---------------------------------------------------------- ownership

    function test_ownership_twoStep_andAdminRoleMovesOnAccept() public {
        address newOwner = makeAddr("new-owner");
        vm.prank(owner);
        allowlist.transferOwnership(newOwner);
        assertEq(allowlist.owner(), owner);
        assertTrue(allowlist.hasRole(allowlist.DEFAULT_ADMIN_ROLE(), owner));
        vm.prank(newOwner);
        allowlist.acceptOwnership();
        assertEq(allowlist.owner(), newOwner);
        assertTrue(allowlist.hasRole(allowlist.DEFAULT_ADMIN_ROLE(), newOwner));
        assertFalse(allowlist.hasRole(allowlist.DEFAULT_ADMIN_ROLE(), owner));
    }

    function test_ownership_typoAddressCannotTakeOver() public {
        vm.prank(owner);
        allowlist.transferOwnership(stranger);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, thief));
        allowlist.acceptOwnership();
        assertEq(allowlist.owner(), owner);
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(owner);
        vm.expectRevert(VerifierAllowlistV2.RenounceDisabled.selector);
        allowlist.renounceOwnership();
        assertEq(allowlist.owner(), owner);
    }

    function test_adminRole_cannotBeGrantedToNonOwner() public {
        bytes32 admin = allowlist.DEFAULT_ADMIN_ROLE();
        vm.prank(owner);
        vm.expectRevert(VerifierAllowlistV2.InvalidInput.selector);
        allowlist.grantRole(admin, stranger);
    }
}
