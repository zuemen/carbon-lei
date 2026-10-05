// Plain-English text for contract reverts and verification failure codes.
// Identifiers stay as they are in the contracts and the SDK; the page shows both.

export const REVERT_TEXT: Record<string, string> = {
  NotActiveVerifier:
    "This address is not an active verification body on the allowlist: it is not registered, was replaced by a newer address, or its accreditation is suspended or expired.",
  AuditorNotAuthorized: "The auditor is not authorised by this verification body at this time.",
  ReportExists: "A report with this identifier is already registered.",
  ZeroQuantity: "The quantity must be greater than zero.",
  InvalidExpiry: "The validity end date (of the report or of the accreditation) must be in the future.",
  ReportNotFound: "No report with this identifier is registered.",
  ReportInvalid:
    "The report is revoked, expired or replaced by a revised report, so no new shipment can be claimed against it.",
  NotSupplier: "Only the supplier named in the report can claim shipments against it.",
  BatchAlreadyClaimed: "This batch has already been claimed.",
  ExceedsVerifiedTonnage: "This claim would exceed the tonnes covered by the verified report.",
  NotReportIssuer:
    "Only the verification body that issued this report can revoke it, or revise it while that body is still active.",
  AlreadyRevoked: "This report or auditor is already revoked.",
  OwnableUnauthorizedAccount:
    "Only the trust-registry operator can add verification bodies or auditors, or change a body's address.",
  AccessControlUnauthorizedAccount:
    "Only the revocation watcher can sync suspensions, lift them, or revoke auditors.",
  PeriodAlreadyCovered:
    "A report already covers this installation and reporting period. A new one must name the report it replaces — revoking the old one does not free the period.",
  SupersedeOverClaimed:
    "The revised report covers fewer tonnes than have already been claimed for this product and route.",
  InvalidInput: "A required field is empty or zero (an address or an identifier).",
  ReportIdRetired:
    "This report ID was replaced by a revised report for this installation and period and cannot be used again there.",
  CredScopeAlreadyCovered:
    "A credential already covers this installation, product, route and period. A new one must name the credential it replaces.",
  SupersedeMismatch:
    "The report named as replaced is not the latest one for this installation, product, route and period.",
  VerifierExists: "This verification body is already on the allowlist.",
  VerifierNotFound: "This verification body is not on the allowlist.",
  AddressAlreadyBound: "This address has already been used by a verification body and cannot be reused.",
  AuditorExists:
    "This auditor is already listed under this verification body. A revoked auditor cannot be re-added.",
  AuditorNotFound: "This auditor is not listed under this verification body.",
  AlreadySuspended: "This verification body is already suspended.",
  NotSuspended: "This verification body is not suspended.",
};

export const CODE_TEXT: Record<string, string> = {
  PRESENTATION_MALFORMED: "The proof is incomplete or not in the expected format.",
  SAID_MISMATCH: "The credential was altered after it was issued: its content hash no longer matches its ID.",
  DISCLOSURE_TAMPERED: "A disclosed value was changed after the supplier created the proof.",
  BAD_SIGNATURE: "The signature does not come from the verification body named in the credential.",
  "REPORT_INVALID/NOT_REGISTERED": "No report with this credential ID is registered on Sepolia.",
  "REPORT_INVALID/REVOKED": "The verification body revoked this report.",
  "REPORT_INVALID/EXPIRED": "The report was no longer valid when this batch was claimed.",
  "REPORT_INVALID/SUPERSEDED": "This batch was claimed after the report was replaced by a revised report.",
  "REPORT_INVALID/REGISTRANT_MISMATCH": "The report on-chain was registered by a different verification body.",
  "REPORT_INVALID/SUPPLIER_MISMATCH": "The supplier in the proof does not match the report on-chain.",
  "REPORT_INVALID/ISSUER_MISMATCH": "The auditor or quantity on-chain does not match the signed credential.",
  "REPORT_INVALID/SCOPE_MISMATCH":
    "The installation, product, route, period or report ID differs from the report on-chain.",
  REPORT_INVALID: "The contract's answer and this page's own check disagree.",
  CONTESTED:
    "Registered within 24 h before a revocation was synced on-chain — needs human review. Neither passed nor failed.",
  SHIPMENT_MISMATCH: "This batch was not claimed for you, or not for this quantity.",
  ANCHOR_NOT_FOUND: "The auditor's signed history (KERI log) contains no record of this report.",
  AUTHORITY_INVALID:
    "The chain of authority behind the auditor is broken: their role credential, their verification body's vLEI, or its accreditation is missing, revoked or expired, or the chain does not lead to the root of trust this page is configured with.",
};

export function revertText(name: string, args: readonly unknown[] = []): string {
  if (name === "ExceedsVerifiedTonnage" && args.length >= 2) {
    return `This claim would exceed the tonnes covered by the verified report (${kgToT(args[0])} t left, ${kgToT(args[1])} t requested).`;
  }
  return REVERT_TEXT[name] ?? "The contract rejected this call.";
}

export function kgToT(kg: unknown): string {
  const n = BigInt(String(kg));
  const whole = n / 1000n;
  const frac = n % 1000n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(3, "0").replace(/0+$/, "")}`;
}
