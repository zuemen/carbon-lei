// Check 8: rule-based reconciliation between the verification report (its structured fields,
// "report extract") and the signed credential. Advisory: a mismatch flags the report for human
// review; it never fails the check list. No AI model is involved.
//
// At issuance the verification body runs the rules and puts three hashes in the credential core
// (input, output, rule version), so the reconciliation is covered by the SAID and the signature.
// At verification the buyer re-runs the same rules on the extract it received and compares hashes.
import { keccak256, stringToBytes } from "viem";
import type { CredentialClaims, Hex } from "./credential.ts";
import type { Reconciliation } from "./disclosure.ts";

export const RULES_VERSION = "carbonlei-reconciliation/1";

/** Structured fields of a verification report (field names follow the annex of IR (EU) 2025/2546). */
export interface ReportExtract {
  reportId: string;
  reportingPeriod: string;
  installationId: string;
  verifierName: string;
  accreditationNumber: string;
  nabName: string;
  accreditedUntil: string;
  accreditationScope: string[];
  leadAuditor: string;
  siteVisit: string;
  siteVisitDates: string;
  materialityThreshold: string;
  quantityPerCn: { cnCode: string; quantity: string }[];
  specificEmbeddedEmissionsPerCn: { cnCode: string; value: string }[];
  assuranceLevel: string;
  signedBy: string;
  signedAt: string;
  /** True when this is the installation's first verified reporting period (site visit must be physical). */
  firstVerifiedPeriod: boolean;
}

/** Credential fields the rules read; all of them must be disclosed for check 8 to run. */
export const RECONCILED_CLAIMS = [
  "verifiedTonnes",
  "specificEmbeddedEmissions_tCO2e_per_t",
  "verificationReportId",
  "reportingPeriod",
  "installationId",
  "accreditationNumber",
  "nabName",
  "cnCode",
  "siteVisit",
  "assuranceLevel",
  "materialityThreshold",
  "issuedAt",
  "validUntil",
] as const satisfies readonly (keyof CredentialClaims)[];

export type ReconciledClaims = Record<(typeof RECONCILED_CLAIMS)[number], string>;

export interface Finding {
  rule: string;
  ok: boolean;
  code: string;
}

const RULES = [
  "quantity-per-cn",
  "intensity-per-cn",
  "report-id",
  "reporting-period",
  "installation",
  "accreditation-number",
  "accreditation-body",
  "cn-in-scope",
  "first-period-physical-visit",
  "reasonable-assurance",
  "materiality-5-percent",
  "date-order",
] as const;

/** JSON with sorted keys, so the same data always hashes the same. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

const h = (s: string): Hex => keccak256(stringToBytes(s));
const num = (s: string) => Number(s.replace(/[^0-9.]/g, ""));
const day = (iso: string) => iso.slice(0, 10);

/** CN code is in scope if a scope entry is a prefix of it (chapter, heading or full code), e.g. "73", "7318". */
export function cnInScope(cnCode: string, scope: string[]): boolean {
  return scope.map((s) => s.replace(/^CN\s*/i, "").replace(/\s/g, "")).some((p) => p.length >= 2 && cnCode.startsWith(p));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRows = (v: unknown, valueKey: string) =>
  Array.isArray(v) && v.every((r) => isObj(r) && typeof r.cnCode === "string" && typeof r[valueKey] === "string");

/**
 * Why a report extract cannot be read by the rules (the fields they index or parse have the wrong type), or
 * null when it can. The extract is supplier-supplied JSON: the rules run only on an extract that passes this.
 */
export function extractShapeProblem(x: unknown): string | null {
  if (!isObj(x)) return "the report extract is not a JSON object";
  const bad: string[] = [];
  if (!isRows(x.quantityPerCn, "quantity")) bad.push("quantityPerCn");
  if (!isRows(x.specificEmbeddedEmissionsPerCn, "value")) bad.push("specificEmbeddedEmissionsPerCn");
  if (!(Array.isArray(x.accreditationScope) && x.accreditationScope.every((v) => typeof v === "string"))) {
    bad.push("accreditationScope");
  }
  if (typeof x.signedAt !== "string") bad.push("signedAt");
  return bad.length ? `report extract fields of the wrong type: ${bad.join(", ")}` : null;
}

export function runRules(x: ReportExtract, c: ReconciledClaims): Finding[] {
  const qty = x.quantityPerCn.find((q) => q.cnCode === c.cnCode);
  const inten = x.specificEmbeddedEmissionsPerCn.find((q) => q.cnCode === c.cnCode);
  const [start, end] = c.reportingPeriod.split("/");
  const F = "CONSISTENCY_WARNING/FIELD_MISMATCH";
  const res: [string, boolean, string][] = [
    ["quantity-per-cn", !!qty && num(qty.quantity) === num(c.verifiedTonnes), F],
    ["intensity-per-cn", !!inten && num(inten.value) === num(c.specificEmbeddedEmissions_tCO2e_per_t), F],
    ["report-id", x.reportId === c.verificationReportId, F],
    ["reporting-period", x.reportingPeriod === c.reportingPeriod, F],
    ["installation", x.installationId === c.installationId, F],
    ["accreditation-number", x.accreditationNumber === c.accreditationNumber, F],
    ["accreditation-body", x.nabName === c.nabName, F],
    ["cn-in-scope", cnInScope(c.cnCode, x.accreditationScope), "CONSISTENCY_WARNING/CN_NOT_IN_SCOPE"],
    ["first-period-physical-visit", !x.firstVerifiedPeriod || x.siteVisit === "physical", "CONSISTENCY_WARNING/FIRST_YEAR_NOT_PHYSICAL"],
    ["reasonable-assurance", x.assuranceLevel === "reasonable", "CONSISTENCY_WARNING/ASSURANCE_NOT_REASONABLE"],
    ["materiality-5-percent", x.materialityThreshold === "5%", "CONSISTENCY_WARNING/MATERIALITY_NOT_5"],
    [
      "date-order",
      start <= end && end <= day(x.signedAt) && day(x.signedAt) <= day(c.issuedAt) && day(c.issuedAt) <= day(c.validUntil),
      "CONSISTENCY_WARNING/PERIOD_ORDER",
    ],
  ];
  return res.map(([rule, ok, code]) => ({ rule, ok, code: ok ? "" : code }));
}

/** Runs the rules and returns the findings with the three hashes that go into the credential core. */
export function reconcile(x: ReportExtract, c: ReconciledClaims): { findings: Finding[]; reconciliation: Reconciliation } {
  const findings = runRules(x, c);
  return {
    findings,
    reconciliation: {
      inputHash: h(canonicalJson({ extract: x, claims: c })),
      outputHash: h(canonicalJson(findings)),
      ruleVersionHash: h(`${RULES_VERSION}:${RULES.join(",")}`),
    },
  };
}

export function pickReconciledClaims(fields: Record<string, string>): ReconciledClaims | null {
  const out: Record<string, string> = {};
  for (const k of RECONCILED_CLAIMS) {
    if (typeof fields[k] !== "string") return null;
    out[k] = fields[k];
  }
  return out as ReconciledClaims;
}

/** Check 8 at verification: compare the recomputed hashes, then report the first failing rule. */
export function checkReconciliation(
  x: ReportExtract,
  disclosed: Record<string, string>,
  signed?: Reconciliation,
  rejected: readonly string[] = [],
): { status: "pass" | "warn" | "skipped"; code: string; detail: string } {
  const c = pickReconciledClaims(disclosed);
  if (!c) {
    // A field that was presented but refused by check 2 is not the same as one the supplier kept hidden.
    const refused = RECONCILED_CLAIMS.some((k) => typeof disclosed[k] !== "string" && rejected.includes(k));
    return {
      status: "skipped",
      code: "",
      detail: refused
        ? "a disclosed field needed for the reconciliation was rejected by check 2"
        : "fields needed for the reconciliation were not disclosed",
    };
  }
  const shape = extractShapeProblem(x);
  if (shape) return { status: "warn", code: "CONSISTENCY_WARNING/EXTRACT_MALFORMED", detail: shape };
  const { findings, reconciliation } = reconcile(x, c);
  if (!signed) return { status: "skipped", code: "", detail: "this credential carries no reconciliation proof" };
  if (
    signed.inputHash !== reconciliation.inputHash ||
    signed.outputHash !== reconciliation.outputHash ||
    signed.ruleVersionHash !== reconciliation.ruleVersionHash
  ) {
    return {
      status: "warn",
      code: "CONSISTENCY_WARNING/PROOF_MISMATCH",
      detail: "the report fields differ from those the auditor reconciled and signed",
    };
  }
  const bad = findings.find((f) => !f.ok);
  return bad
    ? { status: "warn", code: bad.code, detail: `rule "${bad.rule}" flags the signed reconciliation — needs human review` }
    : { status: "pass", code: "", detail: `${findings.length} rules match the verification report; covered by the auditor's signature` };
}
