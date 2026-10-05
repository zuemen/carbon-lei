// Credential data model: field names, disclosure rules, fixed values, identifier
// normal forms and unit conversion. Pure data — no chain access.

export type Hex = `0x${string}`;

/** Fixed note carried by every credential and every export. */
export const METHODOLOGY_NOTE = "illustrative — not official CBAM methodology";
export const CREDENTIAL_TYPE = "CBAM Embedded Emissions Credential";
export const CREDENTIAL_VERSION = "0.1.0";
export const SEPOLIA_CHAIN_ID = 11155111;
export const UINT96_MAX = (1n << 96n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;

/** Claims of one credential: one installation, CN code, production route and period. All values are strings. */
export interface CredentialClaims {
  supplierLEI: string;
  operatorId: string;
  installationId: string;
  installationName: string;
  unLocode: string;
  cnCode: string;
  cbamRoute: string;
  productionRoute: string;
  reportingPeriod: string;
  verifiedTonnes: string;
  specificEmbeddedEmissions_tCO2e_per_t: string;
  valueType: string;
  methodologyNote: string;
  verificationReportId: string;
  verifierLEI: string;
  accreditationNumber: string;
  nabName: string;
  siteVisit: string;
  assuranceLevel: string;
  materialityThreshold: string;
  energyMix: string;
  supplierCost: string;
  idSalt: Hex;
  batchSalt: Hex;
  issuedAt: string;
  validUntil: string;
}

export type ClaimName = keyof CredentialClaims;

/** Fields the supplier may show to an importer. The rest stay with the verification body. */
export const DISCLOSABLE: readonly ClaimName[] = [
  "supplierLEI",
  "operatorId",
  "installationId",
  "installationName",
  "unLocode",
  "cnCode",
  "cbamRoute",
  "reportingPeriod",
  "verifiedTonnes",
  "specificEmbeddedEmissions_tCO2e_per_t",
  "valueType",
  "methodologyNote",
  "verificationReportId",
  "verifierLEI",
  "accreditationNumber",
  "nabName",
  "siteVisit",
  "assuranceLevel",
  "materialityThreshold",
  "idSalt",
  "batchSalt",
  "issuedAt",
  "validUntil",
];

/** Never shown to an importer. */
export const SUPPLIER_PRIVATE: readonly ClaimName[] = ["productionRoute", "energyMix", "supplierCost"];

/** A presentation must disclose at least these; without them checks 3–5 cannot be recomputed. */
export const REQUIRED_DISCLOSURES: readonly ClaimName[] = [
  "supplierLEI",
  "installationId",
  "cnCode",
  "cbamRoute",
  "reportingPeriod",
  "verifiedTonnes",
  "verificationReportId",
  "methodologyNote",
  "idSalt",
  "batchSalt",
];

export const CLAIM_ORDER: readonly ClaimName[] = [...DISCLOSABLE, ...SUPPLIER_PRIVATE];

// ------------------------------------------------------------------ normal forms

/** Demo installation ID format: country code, operator LEI, four-digit sequence (fixtures). */
const INSTALLATION_ID = /^[A-Z]{2}-[A-Z0-9]{20}-\d{4}$/;
/** Reporting period: two ISO dates separated by "/", start not after end. */
const REPORTING_PERIOD = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;
/** Production route: a single upper-case route letter as in the benchmark annex (demo uses C and E). */
const CBAM_ROUTE = /^[A-Z]$/;
/** CN code: digits only, 4, 6 or 8 of them, no spaces. */
const CN_CODE = /^\d{4}(\d{2}){0,2}$/;
const LEI = /^[A-Z0-9]{18}\d{2}$/;

function isIsoDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isInstallationId(s: string): boolean {
  return INSTALLATION_ID.test(s);
}

export function isReportingPeriod(s: string): boolean {
  const m = REPORTING_PERIOD.exec(s);
  if (!m) return false;
  const [, start, end] = m;
  return isIsoDate(start) && isIsoDate(end) && start <= end;
}

export function isCbamRoute(s: string): boolean {
  return CBAM_ROUTE.test(s);
}

export function isCnCode(s: string): boolean {
  return CN_CODE.test(s);
}

export function isLei(s: string): boolean {
  return LEI.test(s);
}

export function splitReportingPeriod(s: string): { start: string; end: string } {
  const m = REPORTING_PERIOD.exec(s);
  if (!m || !isReportingPeriod(s)) throw new Error(`reportingPeriod not in normal form: ${s}`);
  return { start: m[1], end: m[2] };
}

/** Identifier fields that feed on-chain keys must be in normal form (spec I20). Returns the failing field names. */
export function checkNormalForms(c: Partial<CredentialClaims>): string[] {
  const bad: string[] = [];
  if (c.installationId !== undefined && !isInstallationId(c.installationId)) bad.push("installationId");
  if (c.reportingPeriod !== undefined && !isReportingPeriod(c.reportingPeriod)) bad.push("reportingPeriod");
  if (c.cbamRoute !== undefined && !isCbamRoute(c.cbamRoute)) bad.push("cbamRoute");
  if (c.cnCode !== undefined && !isCnCode(c.cnCode)) bad.push("cnCode");
  if (c.supplierLEI !== undefined && !isLei(c.supplierLEI)) bad.push("supplierLEI");
  if (c.verifierLEI !== undefined && !isLei(c.verifierLEI)) bad.push("verifierLEI");
  return bad;
}

// --------------------------------------------------------------------- units

/**
 * Tonnes (decimal string) to whole kilograms. Decimal arithmetic on the string,
 * no floating point. Rejects negatives, more than three decimals that do not
 * vanish, results of 0 kg and values above uint96.
 */
export function tonnesToKg(tonnes: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(tonnes.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${tonnes}`);
  const whole = m[1];
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 3) throw new Error(`not a whole number of kilograms: ${tonnes}`);
  const kg = BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
  if (kg === 0n) throw new Error("zero quantity");
  if (kg > UINT96_MAX) throw new Error("quantity above uint96");
  return kg;
}

/** ISO 8601 UTC timestamp to UNIX seconds (milliseconds dropped). */
export function isoToSeconds(iso: string): bigint {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not an ISO 8601 time: ${iso}`);
  const s = BigInt(Math.floor(ms / 1000));
  if (s < 0n || s > UINT64_MAX) throw new Error("time out of uint64 range");
  return s;
}
