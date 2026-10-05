// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VerifierAllowlist} from "./VerifierAllowlist.sol";

/// @title EmissionsClaimRegistry
/// @notice Registers verified embedded-emissions credentials and keeps a claimable
/// tonnage ledger, so the same verified tonnage cannot be declared to more than one
/// importer in total.
///
/// Two layers of keys:
/// - report layer `reportScopeKey` = hash(installationId, reportingPeriod): once bound to
///   a verification report ID it stays bound; a new report ID needs `supersedes`.
///   Revocation does not release it.
/// - credential layer `credScopeKey` = hash(installationId, cnCode, cbamRoute, reportingPeriod):
///   holds the cumulative claimed kilograms, carried over across revisions.
///
/// Keys and commitments are computed off-chain by the SDK; this contract only sees bytes32.
/// Emissions values are illustrative — not official CBAM methodology.
contract EmissionsClaimRegistry {
    VerifierAllowlist public immutable allowlist;

    struct ReportInput {
        bytes32 reportKey; // keccak256(bytes(credSAID))
        bytes32 reportIdHash; // keccak256(bytes(verificationReportId))
        bytes32 reportScopeKey;
        bytes32 credScopeKey;
        bytes32 auditorAidHash;
        uint64 kelSeq;
        address supplier;
        bytes32 supplierCommit;
        bytes32 installationCommit;
        uint96 verifiedKg;
        uint64 validUntil;
        bytes32 supersedes; // 0 = none
    }

    struct ReportRecord {
        address verifier; // address that registered the report
        bytes32 issuerLeiHash; // body that registered the report
        bytes32 auditorAidHash;
        uint64 kelSeq;
        address supplier;
        bytes32 supplierCommit;
        bytes32 installationCommit;
        uint96 verifiedKg;
        uint64 validUntil;
        uint64 registeredAt;
        uint64 revokedAt; // 0 = not revoked
        bytes32 reportIdHash;
        bytes32 reportScopeKey;
        bytes32 credScopeKey;
        bytes32 supersedes;
        bytes32 supersededBy;
    }

    struct ReportScope {
        bytes32 reportIdHash; // currently bound report ID; never reset to 0
        bytes32 latestReportKey;
        uint64 boundAt; // first binding; display only
    }

    struct CredScope {
        uint96 claimedKg; // cumulative, never decreases
        bytes32 latestReportKey;
    }

    struct Shipment {
        bytes32 reportKey;
        uint96 quantityKg;
        bytes32 importerCommit;
        uint64 claimedAt;
    }

    mapping(bytes32 reportKey => ReportRecord) internal _reports;
    mapping(bytes32 batchKey => Shipment) public shipments;
    mapping(bytes32 reportScopeKey => ReportScope) public reportScopes;
    /// @notice Credential-layer ledger, keyed by the report scope and the credential scope together.
    /// For a genuine credential both keys come from the same installation and period, so the pair
    /// adds no freedom; it stops a credential layer from being occupied under an unrelated report
    /// scope (such a credential would also fail the SDK's scope check).
    mapping(bytes32 reportScopeKey => mapping(bytes32 credScopeKey => CredScope)) public credScopes;
    /// @notice When a report ID was moved off a report scope by a revision (0 = never).
    mapping(bytes32 reportScopeKey => mapping(bytes32 reportIdHash => uint64)) public reportIdUnboundAt;

    event ReportRegistered(
        bytes32 indexed reportKey,
        address indexed verifier,
        address indexed supplier,
        bytes32 issuerLeiHash,
        bytes32 reportScopeKey,
        bytes32 credScopeKey,
        bytes32 reportIdHash,
        bytes32 auditorAidHash,
        uint64 kelSeq,
        uint96 verifiedKg,
        uint64 validUntil
    );
    event ReportSuperseded(
        bytes32 indexed oldReportKey,
        bytes32 indexed newReportKey,
        bytes32 indexed credScopeKey,
        uint96 carriedClaimedKg,
        uint96 newVerifiedKg
    );
    event ReportRevoked(bytes32 indexed reportKey, address indexed verifier, uint64 revokedAt);
    event ShipmentClaimed(
        bytes32 indexed batchKey,
        bytes32 indexed reportKey,
        address indexed supplier,
        uint96 quantityKg,
        bytes32 importerCommit,
        uint96 cumulativeClaimedKg,
        uint64 claimedAt
    );

    error NotActiveVerifier(address verifier);
    error AuditorNotAuthorized(bytes32 auditorAidHash, address verifier);
    error ReportExists(bytes32 reportKey);
    error ZeroQuantity();
    error InvalidExpiry(uint64 validUntil);
    error InvalidInput();
    error ReportIdRetired(bytes32 reportScopeKey, bytes32 reportIdHash);
    error PeriodAlreadyCovered(bytes32 reportScopeKey, bytes32 currentReportIdHash);
    error CredScopeAlreadyCovered(bytes32 credScopeKey, bytes32 latestReportKey);
    error SupersedeMismatch(bytes32 expected, bytes32 given);
    error SupersedeOverClaimed(bytes32 credScopeKey, uint96 claimedKg, uint96 verifiedKg);
    error ReportNotFound(bytes32 reportKey);
    error ReportInvalid(bytes32 reportKey);
    error NotSupplier(address caller);
    error BatchAlreadyClaimed(bytes32 batchKey);
    error ExceedsVerifiedTonnage(uint96 remainingKg, uint96 requestedKg);
    error NotReportIssuer(address caller, bytes32 issuerLeiHash);
    error AlreadyRevoked(bytes32 key);

    constructor(VerifierAllowlist allowlist_) {
        if (address(allowlist_) == address(0)) revert InvalidInput();
        allowlist = allowlist_;
    }

    // ------------------------------------------------------------- register

    /// @notice Registers one credential (one installation, CN code, route and period).
    /// Check order: common checks, missing `supersedes`, report layer, then one of
    /// three credential-layer branches:
    /// (a) `supersedes` = 0: the credential layer must be empty;
    /// (b) `supersedes` != 0 and the layer is not empty: revise the layer's latest credential;
    /// (c) `supersedes` != 0 and the layer is empty: take over the report layer through
    ///     any current credential of the scope, without touching that credential's layer.
    function registerReport(ReportInput calldata r) external {
        uint64 nowTs = uint64(block.timestamp);
        bytes32 callerLei = _checkCommon(r, nowTs);

        if (r.supersedes != bytes32(0) && _reports[r.supersedes].registeredAt == 0) {
            revert ReportNotFound(r.supersedes);
        }

        ReportScope storage ps = reportScopes[r.reportScopeKey];
        _checkReportLayer(r, ps, callerLei);

        CredScope storage cs = credScopes[r.reportScopeKey][r.credScopeKey];
        bool reviseLayer;
        if (r.supersedes == bytes32(0)) {
            // (a)
            if (cs.latestReportKey != bytes32(0)) revert CredScopeAlreadyCovered(r.credScopeKey, cs.latestReportKey);
        } else if (cs.latestReportKey != bytes32(0)) {
            // (b)
            _checkRevision(r, cs, callerLei, nowTs);
            reviseLayer = true;
        } else {
            // (c)
            _checkTakeover(r, ps, callerLei, nowTs);
        }

        _reports[r.reportKey] = ReportRecord({
            verifier: msg.sender,
            issuerLeiHash: callerLei,
            auditorAidHash: r.auditorAidHash,
            kelSeq: r.kelSeq,
            supplier: r.supplier,
            supplierCommit: r.supplierCommit,
            installationCommit: r.installationCommit,
            verifiedKg: r.verifiedKg,
            validUntil: r.validUntil,
            registeredAt: nowTs,
            revokedAt: 0,
            reportIdHash: r.reportIdHash,
            reportScopeKey: r.reportScopeKey,
            credScopeKey: r.credScopeKey,
            supersedes: r.supersedes,
            supersededBy: bytes32(0)
        });

        if (ps.reportIdHash == bytes32(0)) {
            ps.reportIdHash = r.reportIdHash;
            ps.boundAt = nowTs;
        } else if (ps.reportIdHash != r.reportIdHash) {
            reportIdUnboundAt[r.reportScopeKey][ps.reportIdHash] = nowTs;
            ps.reportIdHash = r.reportIdHash;
        }
        ps.latestReportKey = r.reportKey;
        cs.latestReportKey = r.reportKey;

        _emitRegistered(r, callerLei);
        if (reviseLayer) {
            _reports[r.supersedes].supersededBy = r.reportKey;
            emit ReportSuperseded(r.supersedes, r.reportKey, r.credScopeKey, cs.claimedKg, r.verifiedKg);
        }
    }

    // ---------------------------------------------------------------- claim

    /// @notice The report's supplier declares a shipment against the credential's
    /// remaining verified tonnage. The ledger is shared by all importers.
    function claimShipment(bytes32 reportKey, bytes32 batchKey, uint96 quantityKg, bytes32 importerCommit) external {
        ReportRecord storage rep = _reports[reportKey];
        if (rep.registeredAt == 0) revert ReportNotFound(reportKey);
        if (!isValid(reportKey)) revert ReportInvalid(reportKey);
        if (msg.sender != rep.supplier) revert NotSupplier(msg.sender);
        if (shipments[batchKey].claimedAt != 0) revert BatchAlreadyClaimed(batchKey);
        if (quantityKg == 0) revert ZeroQuantity();

        CredScope storage cs = credScopes[rep.reportScopeKey][rep.credScopeKey];
        if (uint256(cs.claimedKg) + quantityKg > rep.verifiedKg) {
            uint96 remaining = cs.claimedKg >= rep.verifiedKg ? 0 : rep.verifiedKg - cs.claimedKg;
            revert ExceedsVerifiedTonnage(remaining, quantityKg);
        }

        uint64 nowTs = uint64(block.timestamp);
        shipments[batchKey] =
            Shipment({reportKey: reportKey, quantityKg: quantityKg, importerCommit: importerCommit, claimedAt: nowTs});
        cs.claimedKg += quantityKg;
        emit ShipmentClaimed(batchKey, reportKey, msg.sender, quantityKg, importerCommit, cs.claimedKg, nowTs);
    }

    // --------------------------------------------------------------- revoke

    /// @notice The issuing body revokes a report, from its current address while it is
    /// active. Revocation is immediate and retroactive; neither key layer is released.
    function revokeReport(bytes32 reportKey) external {
        ReportRecord storage rep = _reports[reportKey];
        if (rep.registeredAt == 0) revert ReportNotFound(reportKey);
        if (rep.revokedAt != 0) revert AlreadyRevoked(reportKey);
        uint64 nowTs = uint64(block.timestamp);
        if (!allowlist.isVerifierActiveAt(msg.sender, nowTs)) revert NotActiveVerifier(msg.sender);
        (bytes32 callerLei,,) = allowlist.leiOfAddress(msg.sender);
        if (callerLei != rep.issuerLeiHash) revert NotReportIssuer(msg.sender, rep.issuerLeiHash);

        rep.revokedAt = nowTs;
        emit ReportRevoked(reportKey, msg.sender, nowTs);
    }

    // ---------------------------------------------------------------- views

    /// @notice The full record of a credential (all fields zero if it was never registered).
    function reports(bytes32 reportKey) external view returns (ReportRecord memory) {
        return _reports[reportKey];
    }

    function isValid(bytes32 reportKey) public view returns (bool) {
        return isValidAt(reportKey, uint64(block.timestamp));
    }

    /// @notice Validity of a credential at time `t`. Authorization is not recomputed:
    /// it was checked live at registration. Revocation applies at any `t`.
    function isValidAt(bytes32 reportKey, uint64 t) public view returns (bool) {
        ReportRecord storage rep = _reports[reportKey];
        if (rep.registeredAt == 0 || t < rep.registeredAt) return false;
        if (rep.revokedAt != 0) return false;
        if (t > rep.validUntil) return false;
        if (rep.supersededBy != bytes32(0) && t >= _reports[rep.supersededBy].registeredAt) return false;
        if (rep.reportIdHash != reportScopes[rep.reportScopeKey].reportIdHash) {
            uint64 unboundAt = reportIdUnboundAt[rep.reportScopeKey][rep.reportIdHash];
            if (unboundAt == 0 || t >= unboundAt) return false;
        }
        return true;
    }

    /// @notice `reportValid` turns false only when the report is revoked; supersession,
    /// expiry and authorization changes after the claim do not affect it.
    function shipmentStatus(bytes32 batchKey)
        external
        view
        returns (
            bytes32 reportKey,
            uint96 quantityKg,
            bytes32 importerCommit,
            address verifier,
            uint64 claimedAt,
            bool reportValid
        )
    {
        Shipment storage s = shipments[batchKey];
        ReportRecord storage rep = _reports[s.reportKey];
        reportValid = s.claimedAt != 0 && rep.revokedAt == 0;
        return (s.reportKey, s.quantityKg, s.importerCommit, rep.verifier, s.claimedAt, reportValid);
    }

    /// @notice Ledger headroom of the credential's layer: verifiedKg − cumulative claimedKg
    /// if this credential is its layer's latest and not revoked; otherwise 0.
    /// Whether a claim is accepted now also depends on {isValid}.
    function remainingKg(bytes32 reportKey) external view returns (uint96) {
        ReportRecord storage rep = _reports[reportKey];
        if (rep.registeredAt == 0 || rep.revokedAt != 0) return 0;
        CredScope storage cs = credScopes[rep.reportScopeKey][rep.credScopeKey];
        if (cs.latestReportKey != reportKey || cs.claimedKg >= rep.verifiedKg) return 0;
        return rep.verifiedKg - cs.claimedKg;
    }

    // ------------------------------------------------------------- internal

    function _checkCommon(ReportInput calldata r, uint64 nowTs) private view returns (bytes32 callerLei) {
        if (!allowlist.isVerifierActiveAt(msg.sender, nowTs)) revert NotActiveVerifier(msg.sender);
        if (!allowlist.isAuthorizedAt(r.auditorAidHash, msg.sender, nowTs)) {
            revert AuditorNotAuthorized(r.auditorAidHash, msg.sender);
        }
        if (_reports[r.reportKey].registeredAt != 0) revert ReportExists(r.reportKey);
        if (r.verifiedKg == 0) revert ZeroQuantity();
        if (r.validUntil <= nowTs) revert InvalidExpiry(r.validUntil);
        if (
            r.reportKey == bytes32(0) || r.supplier == address(0) || r.reportScopeKey == bytes32(0)
                || r.credScopeKey == bytes32(0) || r.reportIdHash == bytes32(0)
        ) revert InvalidInput();
        if (reportIdUnboundAt[r.reportScopeKey][r.reportIdHash] != 0) {
            revert ReportIdRetired(r.reportScopeKey, r.reportIdHash);
        }
        (callerLei,,) = allowlist.leiOfAddress(msg.sender);
    }

    /// @dev Report layer: unbound, or bound to the input ID (then only the body that holds
    /// that ID may add credentials under it), or bound to another ID that `supersedes`
    /// carries (a revision that moves the scope to the new ID).
    function _checkReportLayer(ReportInput calldata r, ReportScope storage ps, bytes32 callerLei) private view {
        bytes32 current = ps.reportIdHash;
        if (current == bytes32(0)) return;
        if (current == r.reportIdHash) {
            bytes32 holder = _reports[ps.latestReportKey].issuerLeiHash;
            if (callerLei != holder) revert NotReportIssuer(msg.sender, holder);
            return;
        }
        if (r.supersedes == bytes32(0) || _reports[r.supersedes].reportIdHash != current) {
            revert PeriodAlreadyCovered(r.reportScopeKey, current);
        }
    }

    /// @dev Branch (b): revise the latest credential of the same credential layer.
    function _checkRevision(ReportInput calldata r, CredScope storage cs, bytes32 callerLei, uint64 nowTs)
        private
        view
    {
        if (r.supersedes != cs.latestReportKey) revert SupersedeMismatch(cs.latestReportKey, r.supersedes);
        ReportRecord storage t = _reports[r.supersedes];
        if (t.reportScopeKey != r.reportScopeKey) revert SupersedeMismatch(r.reportScopeKey, t.reportScopeKey);
        _checkIssuerOrInactive(t.issuerLeiHash, callerLei, nowTs);
        if (r.verifiedKg < cs.claimedKg) revert SupersedeOverClaimed(r.credScopeKey, cs.claimedKg, r.verifiedKg);
    }

    /// @dev Branch (c): the input credential layer is empty; move the report scope to a new
    /// report ID through a current credential `t` of the same scope. `t` keeps its own layer
    /// (it becomes invalid because the scope moved) and gets no `supersededBy`.
    function _checkTakeover(ReportInput calldata r, ReportScope storage ps, bytes32 callerLei, uint64 nowTs)
        private
        view
    {
        ReportRecord storage t = _reports[r.supersedes];
        if (t.supersededBy != bytes32(0)) revert SupersedeMismatch(t.supersededBy, r.supersedes);
        if (t.reportScopeKey != r.reportScopeKey) revert SupersedeMismatch(r.reportScopeKey, t.reportScopeKey);
        if (r.reportIdHash == ps.reportIdHash) revert SupersedeMismatch(bytes32(0), r.supersedes);
        _checkIssuerOrInactive(t.issuerLeiHash, callerLei, nowTs);
    }

    /// @dev Same body: always. Another body: only while the original issuer is not active
    /// (suspended or accreditation expired).
    function _checkIssuerOrInactive(bytes32 issuerLei, bytes32 callerLei, uint64 nowTs) private view {
        if (callerLei != issuerLei && allowlist.isInstitutionActiveAt(issuerLei, nowTs)) {
            revert NotReportIssuer(msg.sender, issuerLei);
        }
    }

    function _emitRegistered(ReportInput calldata r, bytes32 callerLei) private {
        emit ReportRegistered(
            r.reportKey,
            msg.sender,
            r.supplier,
            callerLei,
            r.reportScopeKey,
            r.credScopeKey,
            r.reportIdHash,
            r.auditorAidHash,
            r.kelSeq,
            r.verifiedKg,
            r.validUntil
        );
    }
}
