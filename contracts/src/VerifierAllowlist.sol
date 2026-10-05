// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title VerifierAllowlist
/// @notice Trust registry of accredited verification bodies and their auditors.
/// A body is keyed by the keccak256 hash of its LEI (`leiHash`), not by an address:
/// addresses can be rotated, and old addresses keep a record of when they belonged
/// to which body so that reports registered earlier can still be looked up.
/// The owner adds bodies, adds auditors and rotates addresses. A separate WATCHER
/// key can only suspend a body, lift a suspension, or revoke an auditor.
/// Prototype on Sepolia; all demo organisations and LEIs are fictional.
contract VerifierAllowlist is Ownable, AccessControl {
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");

    /// @notice `credType` returned by {credentialRecord}: the body's LE vLEI.
    bytes32 public constant CRED_TYPE_LE = keccak256("vLEI/LE");

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
        uint64 suspendedAt; // start of the most recent suspension; 0 = never suspended
        uint64 liftedAt; // 0 = suspended now (if suspendedAt != 0) or never suspended
    }

    struct AddressBinding {
        bytes32 leiHash;
        uint64 boundAt;
        uint64 unboundAt; // 0 = still the body's current address
    }

    struct AuditorRecord {
        bytes32 ecrSaidHash;
        uint64 addedAt;
        uint64 revokedAt; // 0 = not revoked
    }

    mapping(bytes32 leiHash => InstitutionRecord) public institutions;
    mapping(address addr => AddressBinding) public leiOfAddress;
    mapping(bytes32 auditorAidHash => mapping(bytes32 leiHash => AuditorRecord)) public auditors;

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

    constructor(address initialOwner, address watcher) Ownable(initialOwner) {
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

    /// @notice Moves a body to a new address. The old address keeps its binding with
    /// `unboundAt` set, so it can no longer act but reports it registered still resolve.
    /// Suspension and accreditation fields are not touched.
    function rotateVerifierAddress(bytes32 leiHash, address newAddr) external onlyOwner {
        InstitutionRecord storage inst = institutions[leiHash];
        if (inst.addedAt == 0) revert VerifierNotFound(leiHash);
        if (newAddr == address(0)) revert InvalidInput();
        if (leiOfAddress[newAddr].boundAt != 0) revert AddressAlreadyBound(newAddr);

        uint64 nowTs = uint64(block.timestamp);
        address oldAddr = inst.currentAddress;
        leiOfAddress[oldAddr].unboundAt = nowTs;
        leiOfAddress[newAddr] = AddressBinding({leiHash: leiHash, boundAt: nowTs, unboundAt: 0});
        inst.currentAddress = newAddr;
        emit VerifierAddressRotated(leiHash, oldAddr, newAddr, nowTs);
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

    /// @notice True if the body exists, was added at or before `t`, its accreditation
    /// has not expired at `t`, and `t` is outside its most recent suspension
    /// interval [suspendedAt, liftedAt).
    function isInstitutionActiveAt(bytes32 leiHash, uint64 t) public view returns (bool) {
        InstitutionRecord storage inst = institutions[leiHash];
        if (inst.addedAt == 0 || t < inst.addedAt || t > inst.accreditedUntil) return false;
        if (inst.suspendedAt == 0 || t < inst.suspendedAt) return true;
        return inst.liftedAt != 0 && t >= inst.liftedAt;
    }

    /// @notice True if `verifier` was bound to a body at `t` (not yet rotated away)
    /// and that body was active at `t`.
    function isVerifierActiveAt(address verifier, uint64 t) public view returns (bool) {
        AddressBinding storage b = leiOfAddress[verifier];
        if (b.boundAt == 0 || t < b.boundAt) return false;
        if (b.unboundAt != 0 && t >= b.unboundAt) return false;
        return isInstitutionActiveAt(b.leiHash, t);
    }

    /// @notice True if `verifier` was active at `t` and the auditor was registered
    /// under the verifier's body and not revoked at `t`.
    function isAuthorizedAt(bytes32 auditorAidHash, address verifier, uint64 t) public view returns (bool) {
        if (!isVerifierActiveAt(verifier, t)) return false;
        AuditorRecord storage rec = auditors[auditorAidHash][leiOfAddress[verifier].leiHash];
        if (rec.addedAt == 0 || t < rec.addedAt) return false;
        return rec.revokedAt == 0 || t < rec.revokedAt;
    }

    /// @notice Credential record with the same shape as a cross-chain identity (CCID)
    /// credential lookup. Returns zeros for an address that is not, or no longer,
    /// the current address of a body.
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

    // -------------------------------------------------------------- internal

    /// @dev DEFAULT_ADMIN_ROLE (which administers WATCHER_ROLE) can only be held by the owner,
    /// so no second admin can outlive a transfer of ownership.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account != owner()) revert InvalidInput();
        return super._grantRole(role, account);
    }

    /// @dev Keeps DEFAULT_ADMIN_ROLE with the owner, so that whoever owns the
    /// allowlist also administers the WATCHER role.
    function _transferOwnership(address newOwner) internal override {
        address oldOwner = owner();
        super._transferOwnership(newOwner);
        if (oldOwner != address(0)) _revokeRole(DEFAULT_ADMIN_ROLE, oldOwner);
        if (newOwner != address(0)) _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
    }
}
