// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title VerifierAllowlistV2 (CR1 mitigation, docs/SECURITY.md §13.1)
/// @notice Same trust registry as `VerifierAllowlist` (V1, deployed on Sepolia), with the
/// one-step `rotateVerifierAddress` replaced by a two-step rotation:
/// - the owner proposes a new address for a body; it can be executed by anyone after
///   `ROTATION_DELAY`, or at once if the body's current address consents with an EIP-712
///   signature over `Rotation(leiHash, newAddr, nonce)` (EOA or ERC-1271 wallet);
/// - until then the body's current address, the WATCHER or the owner can cancel it.
/// Ownership is two-step (`Ownable2Step`) and cannot be renounced. The owner is meant to be
/// a multisig behind a `TimelockController`; this contract does not enforce that.
///
/// Every V1 view (`institutions`, `leiOfAddress`, `auditors`, `isInstitutionActiveAt`,
/// `isVerifierActiveAt`, `isAuthorizedAt`, `credentialRecord`) and every V1 event keep their
/// signature, so a reader of V1 can read V2. The revocation hold (REVOKE_HOLD) for a freshly
/// bound address lives in `EmissionsClaimRegistryV2` and reads `leiOfAddress(..).boundAt`.
///
/// Not deployed. Tested in contracts/test/v2. All demo organisations and LEIs are fictional.
contract VerifierAllowlistV2 is Ownable2Step, AccessControl, EIP712 {
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");
    bytes32 public constant CRED_TYPE_LE = keccak256("vLEI/LE");

    /// @notice Wait between `proposeRotation` and `executeRotation`. A governance choice
    /// (docs/SECURITY.md §13.1), not a result of this project.
    uint64 public constant ROTATION_DELAY = 72 hours;

    bytes32 public constant ROTATION_TYPEHASH = keccak256("Rotation(bytes32 leiHash,address newAddr,uint256 nonce)");

    struct VerifierInput {
        bytes32 leiHash;
        address verifier;
        bytes32 leCredSaidHash;
        bytes32 accreditationSaidHash;
        uint64 accreditedUntil;
    }

    struct AuditorInput {
        bytes32 auditorAidHash;
        bytes32 leiHash;
        bytes32 ecrSaidHash;
    }

    struct InstitutionRecord {
        address currentAddress;
        bytes32 leCredSaidHash;
        bytes32 accreditationSaidHash;
        uint64 accreditedUntil;
        uint64 addedAt;
        uint64 suspendedAt;
        uint64 liftedAt;
    }

    struct AddressBinding {
        bytes32 leiHash;
        uint64 boundAt;
        uint64 unboundAt;
    }

    struct AuditorRecord {
        bytes32 ecrSaidHash;
        uint64 addedAt;
        uint64 revokedAt;
    }

    struct PendingRotation {
        address newAddr; // 0 = none pending
        uint64 readyAt;
    }

    mapping(bytes32 leiHash => InstitutionRecord) public institutions;
    mapping(address addr => AddressBinding) public leiOfAddress;
    mapping(bytes32 auditorAidHash => mapping(bytes32 leiHash => AuditorRecord)) public auditors;
    mapping(bytes32 leiHash => PendingRotation) public pendingRotations;
    /// @notice Bumped on every executed or cancelled rotation, so a consent signature is good
    /// for one proposal only.
    mapping(bytes32 leiHash => uint256) public rotationNonce;

    event VerifierAdded(
        bytes32 indexed leiHash, address indexed verifier, uint64 accreditedUntil, bytes32 accreditationSaidHash
    );
    event VerifierSuspended(bytes32 indexed leiHash, uint64 suspendedAt);
    event SuspensionLifted(bytes32 indexed leiHash, uint64 liftedAt);
    event AuditorAdded(bytes32 indexed auditorAidHash, bytes32 indexed leiHash, bytes32 ecrSaidHash);
    event AuditorRevoked(bytes32 indexed auditorAidHash, bytes32 indexed leiHash, uint64 revokedAt);
    event VerifierAddressRotated(
        bytes32 indexed leiHash, address indexed oldAddr, address indexed newAddr, uint64 rotatedAt
    );
    event RotationProposed(bytes32 indexed leiHash, address indexed newAddr, uint64 readyAt);
    event RotationCancelled(bytes32 indexed leiHash, address indexed newAddr, address indexed by);

    error InvalidInput();
    error InvalidExpiry(uint64 validUntil);
    error VerifierExists(bytes32 leiHash);
    error VerifierNotFound(bytes32 leiHash);
    error AddressAlreadyBound(address addr);
    error NotActiveVerifier(address verifier);
    error AuditorExists(bytes32 auditorAidHash, bytes32 leiHash);
    error AuditorNotFound(bytes32 auditorAidHash, bytes32 leiHash);
    error AlreadyRevoked(bytes32 key);
    error AlreadySuspended(bytes32 leiHash);
    error NotSuspended(bytes32 leiHash);
    error RotationAlreadyPending(bytes32 leiHash);
    error NoPendingRotation(bytes32 leiHash);
    error RotationNotReady(bytes32 leiHash, uint64 readyAt);
    error NotAllowedToCancel(address caller);
    error BadRotationSignature(bytes32 leiHash);
    error RenounceDisabled();

    constructor(address initialOwner, address watcher) Ownable(initialOwner) EIP712("VerifierAllowlistV2", "1") {
        if (watcher == address(0)) revert InvalidInput();
        _grantRole(WATCHER_ROLE, watcher);
    }

    // ---------------------------------------------------------------- owner

    function addVerifier(VerifierInput calldata v) external onlyOwner {
        if (
            v.leiHash == bytes32(0) || v.leCredSaidHash == bytes32(0) || v.accreditationSaidHash == bytes32(0)
                || v.verifier == address(0)
        ) revert InvalidInput();
        if (institutions[v.leiHash].addedAt != 0) revert VerifierExists(v.leiHash);
        if (leiOfAddress[v.verifier].boundAt != 0) revert AddressAlreadyBound(v.verifier);
        if (v.accreditedUntil <= block.timestamp) revert InvalidExpiry(v.accreditedUntil);

        uint64 nowTs = uint64(block.timestamp);
        institutions[v.leiHash] = InstitutionRecord({
            currentAddress: v.verifier,
            leCredSaidHash: v.leCredSaidHash,
            accreditationSaidHash: v.accreditationSaidHash,
            accreditedUntil: v.accreditedUntil,
            addedAt: nowTs,
            suspendedAt: 0,
            liftedAt: 0
        });
        leiOfAddress[v.verifier] = AddressBinding({leiHash: v.leiHash, boundAt: nowTs, unboundAt: 0});
        emit VerifierAdded(v.leiHash, v.verifier, v.accreditedUntil, v.accreditationSaidHash);
    }

    function addAuditor(AuditorInput calldata a) external onlyOwner {
        InstitutionRecord storage inst = institutions[a.leiHash];
        if (inst.addedAt == 0) revert VerifierNotFound(a.leiHash);
        if (!isInstitutionActiveAt(a.leiHash, uint64(block.timestamp))) {
            revert NotActiveVerifier(inst.currentAddress);
        }
        if (a.auditorAidHash == bytes32(0) || a.ecrSaidHash == bytes32(0)) revert InvalidInput();
        if (auditors[a.auditorAidHash][a.leiHash].addedAt != 0) revert AuditorExists(a.auditorAidHash, a.leiHash);

        auditors[a.auditorAidHash][a.leiHash] =
            AuditorRecord({ecrSaidHash: a.ecrSaidHash, addedAt: uint64(block.timestamp), revokedAt: 0});
        emit AuditorAdded(a.auditorAidHash, a.leiHash, a.ecrSaidHash);
    }

    // ------------------------------------------------------------- rotation

    /// @notice Step 1: the owner proposes `newAddr` for a body. Nothing changes on the body
    /// until {executeRotation} or {executeRotationSigned}. One proposal per body at a time.
    function proposeRotation(bytes32 leiHash, address newAddr) external onlyOwner {
        if (institutions[leiHash].addedAt == 0) revert VerifierNotFound(leiHash);
        if (newAddr == address(0)) revert InvalidInput();
        if (leiOfAddress[newAddr].boundAt != 0) revert AddressAlreadyBound(newAddr);
        if (pendingRotations[leiHash].newAddr != address(0)) revert RotationAlreadyPending(leiHash);

        uint64 readyAt = uint64(block.timestamp) + ROTATION_DELAY;
        pendingRotations[leiHash] = PendingRotation({newAddr: newAddr, readyAt: readyAt});
        emit RotationProposed(leiHash, newAddr, readyAt);
    }

    /// @notice Cancels a pending rotation. Allowed for the body's current address (the
    /// party a hostile rotation would dispossess), the WATCHER, and the owner.
    function cancelRotation(bytes32 leiHash) external {
        PendingRotation memory p = pendingRotations[leiHash];
        if (p.newAddr == address(0)) revert NoPendingRotation(leiHash);
        if (
            msg.sender != institutions[leiHash].currentAddress && !hasRole(WATCHER_ROLE, msg.sender)
                && msg.sender != owner()
        ) revert NotAllowedToCancel(msg.sender);

        delete pendingRotations[leiHash];
        rotationNonce[leiHash]++;
        emit RotationCancelled(leiHash, p.newAddr, msg.sender);
    }

    /// @notice Step 2 (delay path): anyone, once `block.timestamp >= readyAt`.
    function executeRotation(bytes32 leiHash) external {
        PendingRotation memory p = pendingRotations[leiHash];
        if (p.newAddr == address(0)) revert NoPendingRotation(leiHash);
        if (block.timestamp < p.readyAt) revert RotationNotReady(leiHash, p.readyAt);
        _rotate(leiHash, p.newAddr);
    }

    /// @notice Step 2 (consent path): anyone may submit, without the delay, if the body's
    /// current address signed `Rotation(leiHash, newAddr, rotationNonce[leiHash])`.
    function executeRotationSigned(bytes32 leiHash, bytes calldata oldAddrSig) external {
        PendingRotation memory p = pendingRotations[leiHash];
        if (p.newAddr == address(0)) revert NoPendingRotation(leiHash);
        if (!SignatureChecker.isValidSignatureNow(
                institutions[leiHash].currentAddress, rotationDigest(leiHash, p.newAddr), oldAddrSig
            )) revert BadRotationSignature(leiHash);
        _rotate(leiHash, p.newAddr);
    }

    // -------------------------------------------------------------- watcher

    function suspendVerifier(bytes32 leiHash) external onlyRole(WATCHER_ROLE) {
        InstitutionRecord storage inst = institutions[leiHash];
        if (inst.addedAt == 0) revert VerifierNotFound(leiHash);
        if (inst.suspendedAt != 0 && inst.liftedAt == 0) revert AlreadySuspended(leiHash);

        uint64 nowTs = uint64(block.timestamp);
        inst.suspendedAt = nowTs;
        inst.liftedAt = 0;
        emit VerifierSuspended(leiHash, nowTs);
    }

    function liftSuspension(bytes32 leiHash) external onlyRole(WATCHER_ROLE) {
        InstitutionRecord storage inst = institutions[leiHash];
        if (inst.addedAt == 0) revert VerifierNotFound(leiHash);
        if (inst.suspendedAt == 0 || inst.liftedAt != 0) revert NotSuspended(leiHash);

        uint64 nowTs = uint64(block.timestamp);
        inst.liftedAt = nowTs;
        emit SuspensionLifted(leiHash, nowTs);
    }

    function revokeAuditor(bytes32 auditorAidHash, bytes32 leiHash) external onlyRole(WATCHER_ROLE) {
        AuditorRecord storage rec = auditors[auditorAidHash][leiHash];
        if (rec.addedAt == 0) revert AuditorNotFound(auditorAidHash, leiHash);
        if (rec.revokedAt != 0) revert AlreadyRevoked(auditorAidHash);

        uint64 nowTs = uint64(block.timestamp);
        rec.revokedAt = nowTs;
        emit AuditorRevoked(auditorAidHash, leiHash, nowTs);
    }

    // ---------------------------------------------------------------- views

    function isInstitutionActiveAt(bytes32 leiHash, uint64 t) public view returns (bool) {
        InstitutionRecord storage inst = institutions[leiHash];
        if (inst.addedAt == 0 || t < inst.addedAt || t > inst.accreditedUntil) return false;
        if (inst.suspendedAt == 0 || t < inst.suspendedAt) return true;
        return inst.liftedAt != 0 && t >= inst.liftedAt;
    }

    function isVerifierActiveAt(address verifier, uint64 t) public view returns (bool) {
        AddressBinding storage b = leiOfAddress[verifier];
        if (b.boundAt == 0 || t < b.boundAt) return false;
        if (b.unboundAt != 0 && t >= b.unboundAt) return false;
        return isInstitutionActiveAt(b.leiHash, t);
    }

    function isAuthorizedAt(bytes32 auditorAidHash, address verifier, uint64 t) public view returns (bool) {
        if (!isVerifierActiveAt(verifier, t)) return false;
        AuditorRecord storage rec = auditors[auditorAidHash][leiOfAddress[verifier].leiHash];
        if (rec.addedAt == 0 || t < rec.addedAt) return false;
        return rec.revokedAt == 0 || t < rec.revokedAt;
    }

    function credentialRecord(address verifier)
        external
        view
        returns (bytes32 credType, uint64 expiresAt, bytes32 credHash)
    {
        AddressBinding storage b = leiOfAddress[verifier];
        if (b.boundAt == 0 || b.unboundAt != 0) return (bytes32(0), 0, bytes32(0));
        InstitutionRecord storage inst = institutions[b.leiHash];
        return (CRED_TYPE_LE, inst.accreditedUntil, inst.leCredSaidHash);
    }

    /// @notice EIP-712 digest the body's current address signs to consent to a rotation.
    function rotationDigest(bytes32 leiHash, address newAddr) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ROTATION_TYPEHASH, leiHash, newAddr, rotationNonce[leiHash])));
    }

    // -------------------------------------------------------------- internal

    /// @dev Same state change as V1 `rotateVerifierAddress`. Re-checks `newAddr`, which may
    /// have been bound by {addVerifier} or another rotation since the proposal.
    function _rotate(bytes32 leiHash, address newAddr) private {
        if (leiOfAddress[newAddr].boundAt != 0) revert AddressAlreadyBound(newAddr);
        InstitutionRecord storage inst = institutions[leiHash];
        uint64 nowTs = uint64(block.timestamp);
        address oldAddr = inst.currentAddress;

        delete pendingRotations[leiHash];
        rotationNonce[leiHash]++;
        leiOfAddress[oldAddr].unboundAt = nowTs;
        leiOfAddress[newAddr] = AddressBinding({leiHash: leiHash, boundAt: nowTs, unboundAt: 0});
        inst.currentAddress = newAddr;
        emit VerifierAddressRotated(leiHash, oldAddr, newAddr, nowTs);
    }

    /// @dev Renouncing would leave the allowlist without anyone able to add bodies or move
    /// a body off a lost key (T10, §11).
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account != owner()) revert InvalidInput();
        return super._grantRole(role, account);
    }

    /// @dev Called by Ownable2Step only on `acceptOwnership` (and in the constructor), so the
    /// admin role moves when the new owner accepts.
    function _transferOwnership(address newOwner) internal override {
        address oldOwner = owner();
        super._transferOwnership(newOwner);
        if (oldOwner != address(0)) _revokeRole(DEFAULT_ADMIN_ROLE, oldOwner);
        if (newOwner != address(0)) _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
    }
}
