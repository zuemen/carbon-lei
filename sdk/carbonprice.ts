// Check 10: carbon price paid in the country of origin (CBAM Art 9), on the rules of the Commission's DRAFT
// implementing regulation (Ref. Ares(2026)4841230, published for feedback 13 May 2026, feedback closed 10 June 2026;
// NOT adopted as of 16 October 2026). Every output of this module carries DRAFT_LABEL. Nothing here is binding law.
//
// Regulation (EU) 2023/956 Art 9 lets an authorised CBAM declarant claim a reduction in the CBAM certificates to
// surrender for the carbon price effectively paid in the country of origin, on evidence certified by an independent
// person (draft recital 1; Art 1(f) of the draft). The draft fixes how (Annex I, point-source carbon tax, direct
// emissions):
//   CP_DIR      = the (reduced) carbon tax rate per tonne of CPM emissions                 Annex I 3.3.2
//   RC_DIR      = RC_VALUE / EM_CPM_DIR (refunds in money, per tonne of CPM emissions)     Annex I 3.4, eq. 5a
//   EFF_CP_DIR  = CP_DIR − RC_DIR                                                          eq. 6a
//   EFF_CP_DIRg = (EM_DIRg − Rebated_EM_DIRg) × EFF_CP_DIR   (per tonne of good)           Annex I 6.1, eq. 12a
//                 exempted emissions (free allowances, thresholds, exemptions) are rebates  Annex I 5; draft Art 8(1)(b)
//   €EFF_CP_DIRg = EFF_CP_DIRg × €XR (yearly average rate, Commission-published,          Annex I 7.1, eq. 15a; Art 5
//                 ECB- or Eurostat-based)
//   precursors: EFF_CP_PREg = Σ_p Q_p × Avg(€EFF_CP_p) / Q_TOTg (= m_p × €EFF_CP_p)         Annex I 6.3, eq. 14a
//   €EFF_CPg    = €EFF_CP_DIRg + €EFF_CP_INDg + €EFF_CP_PREg                                eq. 16
//   Reduction   = (€EFF_CPg / Ref Price CBAM) × Q_g   (yearly average CBAM certificate     draft Art 6(1), 6(3)
//                 price of the year of import)
// Only for goods declared on actual values (draft recital 5). The independent person is accredited under
// EN ISO/IEC 17029:2019 for activity group LIV "Certification of the carbon price effectively paid" (draft Art 9(1),
// Annex III) and applies a 5 % materiality level per CN code (draft Art 16).
//
// CarbonLEI's prototype of that evidence: a CARBON PRICE STATEMENT (a SAID'd JSON in the shape of Annex II/IV) that
//   - the paying installation's operator signs (EIP-191, with the supplier address of its registered credential);
//   - an independent person certifies: its lead auditor (ECR vLEI, role CERTIFIER_ROLE, under a body accredited by a
//     NAB for CERTIFIER_ACTIVITY) anchors the statement's SAID in their KEL, and the body, on the same allowlist as
//     the verification bodies, registers it in the same EmissionsClaimRegistry under a separate key domain
//     (SCOPE_DOMAIN): one current statement per installation and period, revocable, superseded by a new one;
//   - carries `productionTonnes` as the registered tonnage: the operator claims the tonnes of good it delivered to
//     each downstream maker against it (importerCommit = that maker's LEI, or the importer's EORI for the good
//     itself), so the contract's ExceedsVerifiedTonnage cap stops the same statement from reducing more tonnes than it
//     covers, across all makers and importers.
// Check 10 (only when the proof carries carbonPriceEvidence) verifies all of that, re-derives the effective price
// from the statement's fields with a PINNED exchange rate (never the statement's own), caps the paid emissions per
// tonne at the credential's embedded emissions, and reports the € per tonne of the declared good that the deduction
// may use. The deduction itself (÷ reference price × quantity) is computed by sdk/portfolio.ts.
import { encodeAbiParameters, keccak256, recoverMessageAddress } from "viem";
import { auditorAidHashOf, batchKeyOf, hashString, importerCommitOf, installationCommitOf, leiHashOf, reportKeyOf, supplierCommitOf } from "./commitment.ts";
import { isCnCode, isLei, isReportingPeriod, isoSeconds, kgToTonnes, tonnesToKg, type Hex } from "./credential.ts";
import type { PrecursorReport } from "./precursor.ts";
import { computeSaid } from "./said.ts";
import type { CheckResult, CheckStatus, EvidenceContext } from "./verify.ts";
import { verifyAnchor, verifyAuthority, type AnchorEvidence, type AuthorityEvidence } from "./vlei.ts";

export const DRAFT_LABEL = "Draft implementing act, not adopted — illustrative";
export const DRAFT_LABEL_ZH = "執行法草案，尚未通過——僅供示意";
export const DRAFT_REF =
  "Commission draft implementing regulation on the carbon price paid in a third country (CBAM Art 9(5)), Ref. Ares(2026)4841230 of 13 May 2026; feedback closed 10 June 2026; not adopted";
export const CARBON_PRICE_STATEMENT_TYPE = "CarbonLEI Carbon Price Statement";
export const CARBON_PRICE_STATEMENT_VERSION = "0.1.0";
/** ECR role of the independent person's lead auditor (the draft's "CBAM certification lead auditor", Art 2(11)). */
export const CERTIFIER_ROLE = "CBAM Certification Lead Auditor";
/** `activity` of the certifier body's accreditation credential (draft Annex III, activity group LIV). */
export const CERTIFIER_ACTIVITY = "Certification of the carbon price effectively paid (CBAM activity group LIV, draft implementing act; demo)";
/** Key domain of statements on the registry: their scope keys can never equal an emissions report's. */
export const SCOPE_DOMAIN = "carbonlei/cbam-art9-draft/0.1";
/**
 * Largest accepted excess of the stated € per tonne of good over the recomputed one: half a cent. The draft sets no
 * rounding rule for the declarant's side (the 5 % materiality of Art 16 is the certifier's threshold, not ours).
 */
export const PRICE_TOLERANCE_EUR = "0.005";
/** Share by which emissions attributed to the good may exceed the mechanism's covered emissions (draft recital 7). */
export const BOUNDARY_TOLERANCE = "0.05";

export interface FxRate {
  currency: string;
  year: number;
  /** Units of the currency per euro (yearly average). */
  unitsPerEur: string;
  source: string;
}

/**
 * Exchange rates the verifier pins (never read from the statement). Draft Art 5: the Commission is to publish yearly
 * averages from ECB rates or, where appropriate, Eurostat; it has published none yet, and the ECB publishes no TWD
 * reference rate, so the demo pins Eurostat's annual average. A production verifier pins the Commission's table.
 */
export const PINNED_FX: readonly FxRate[] = [
  {
    currency: "TWD",
    year: 2025,
    unitsPerEur: "35.196",
    source: "Eurostat ert_bil_eur_a (Euro exchange rates, annual average), TWD per EUR, 2025; dataset updated 2026-07-08, accessed 2026-10-16",
  },
];

export interface CarbonPriceStatement {
  type: typeof CARBON_PRICE_STATEMENT_TYPE;
  version: typeof CARBON_PRICE_STATEMENT_VERSION;
  /** SAID of the statement (Blake3, as the credential core's). */
  d: string;
  /** Always DRAFT_LABEL: the statement says it rests on a draft. */
  notice: string;
  /** The paying installation (Annex II 1). */
  operator: { name: string; lei: string; installationId: string };
  /** Same period as the verification report (draft Art 3(3)). */
  reportingPeriod: string;
  /** CN code of the good the price is attributed to (Annex I 4.2). */
  cnCode: string;
  /** SAIDs of the verified CBAM credentials of that good (Annex II 2(c): the verified emissions report). */
  credentials: string[];
  mechanism: { country: string; name: string; legalBasis: string; form: "point-source carbon tax"; covers: "direct" };
  /** ISO 4217 code of the local currency. */
  currency: string;
  /** CP_DIR: the carbon tax rate (or the reduced rate paid) per tonne of CPM emissions, local currency (Annex I 3.3.2). */
  ratePerTonne: string;
  /** EM_CPM_DIR: direct emissions reported and confirmed under the mechanism for the period, tCO2e (Annex I 3.1, 4). */
  cpmEmissions: string;
  /** Emissions exempted from payment (free allowances, thresholds, adjustment factors, other exemptions), tCO2e (Annex I 5). */
  exemptEmissions: string;
  exemptBasis: string;
  /** The scheme's own parameters, when it sets them (re-derives the exemption): chargeable = (EM − K) × factor. */
  adjustment?: { thresholdK: string; factor: string };
  /** RC_VALUE: refunds or other monetary compensation received or due, local currency (Annex I 3.4); "0" when none. */
  refunds: string;
  /** The tax paid per the official record (Annex I 3.5.2(b)(1)), local currency. */
  feePaid: string;
  /** Tonnes of the good produced in the period: the tonnage registered and claimable against this statement. */
  productionTonnes: string;
  /** EM_DIRg: CPM emissions attributed per tonne of the good, tCO2e/t (Annex I 4.2, eq. 9a). */
  emissionsPerTonne: string;
  /** Yearly average exchange rate used (Art 5), units of local currency per euro. */
  fx: { unitsPerEur: string; year: number; source: string };
  /** €EFF_CPg as certified: € per tonne of good (Annex II 3(m)(4); Annex IV 2.2(a)). */
  effectivePriceEurPerTonne: string;
  /** Materiality level applied (draft Art 16). */
  materiality: "5%";
  /** The independent person checked rebates and compensation (Annex IV 2.1(g)). */
  rebatesChecked: boolean;
  certifier: { name: string; lei: string; auditorAID: string; accreditationNumber: string };
  certificationReportId: string;
  certifiedAt: string;
  validUntil: string;
}

/** What the supplier presents with its proof. */
export interface CarbonPriceEvidence {
  statement: CarbonPriceStatement;
  /** EIP-191 signature over the statement's SAID by the operator's supplier address. */
  operatorSignature: Hex;
  /** The certifier lead auditor's KEL event anchoring the statement's SAID (same shape as check 6's evidence). */
  anchorEvidence: unknown;
  /** vLEI chain of the certifier (same shape as check 7's evidence; ECR role CERTIFIER_ROLE). */
  authorityEvidence: unknown;
  /** The operator's claim of tonnes of good against the statement for the beneficiary (maker LEI or importer EORI). */
  claim: { batchId: string; quantityTonnes: string; batchSalt: Hex; beneficiarySalt: Hex };
}

export interface CarbonPriceReport {
  draft: typeof DRAFT_LABEL;
  statementSAID: string | null;
  target: { kind: "precursor" | "good"; line?: number; credSAID: string; cnCode: string; massPerTonne: string; seeCap: string | null } | null;
  mechanism: string | null;
  currency: string | null;
  ratePerTonne: string | null;
  /** Share of the CPM emissions on which the price was paid (1 − exempt/CPM). */
  paidShare: string | null;
  emissionsPerTonne: string | null;
  /** EM_DIRg × paid share, and after the cap at the credential's embedded emissions, tCO2e per t of the statement's good. */
  paidEmissionsPerTonne: string | null;
  coveredEmissionsPerTonne: string | null;
  /** EFF_CP_DIRg in local currency per t of the statement's good. */
  localPerTonne: string | null;
  fx: (FxRate & { pinned: boolean }) | null;
  /** €EFF_CP per t of the statement's good, recomputed; and as stated (certified). */
  eurPerTonne: string | null;
  statedEurPerTonne: string | null;
  /** € per tCO2e of the good's emissions (€ per t of good ÷ EM_DIRg): what the fee amounts to per tonne emitted. */
  eurPerTCO2e: string | null;
  /** € per tCO2e on which the fee was actually charged (rate net of refunds ÷ FX). */
  eurPerPaidTCO2e: string | null;
  /** € per tonne of the DECLARED good the deduction may use (× m for a precursor; the lower of stated and recomputed). */
  deductibleEurPerTonneGood: string | null;
  claim: { batchId: string; claimedTonnes: string | null; neededTonnes: string | null } | null;
  certifier: { name: string; lei: string; aid: string; role: string } | null;
  registeredAt: string | null;
  /** The calculation, step by step (English, numbers only). */
  steps: string[];
}

export type CarbonPriceCheckResult = CheckResult & { carbonPrice?: CarbonPriceReport };

// ------------------------------------------------------------------ exact decimals (rationals over bigint)

export interface Rat {
  n: bigint;
  d: bigint;
}
const DEC = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const isDec = (s: unknown): s is string => typeof s === "string" && DEC.test(s);
function rat(s: string): Rat {
  if (!isDec(s)) throw new Error(`not a decimal with at most six places: ${String(s)}`);
  const [w, f = ""] = s.split(".");
  return { n: BigInt(w + f), d: 10n ** BigInt(f.length) };
}
const mul = (a: Rat, b: Rat): Rat => ({ n: a.n * b.n, d: a.d * b.d });
const div = (a: Rat, b: Rat): Rat => ({ n: a.n * b.d, d: a.d * b.n });
const sub = (a: Rat, b: Rat): Rat => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const add = (a: Rat, b: Rat): Rat => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const cmp = (a: Rat, b: Rat) => {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};
const ONE: Rat = { n: 1n, d: 1n };
const ZERO: Rat = { n: 0n, d: 1n };
/** Rounded half up (away from zero) to `places` decimals, without trailing zeros. */
export function fmtRat(r: Rat, places = 6): string {
  const neg = r.n < 0n !== r.d < 0n && r.n !== 0n;
  const n = r.n < 0n ? -r.n : r.n;
  const d = r.d < 0n ? -r.d : r.d;
  const s = 10n ** BigInt(places);
  const v = (n * s * 2n + d) / (d * 2n);
  const whole = v / s;
  const frac = (v % s).toString().padStart(places, "0").replace(/0+$/, "");
  return `${neg && v !== 0n ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
/** Rounded half up to three decimals (Taiwan's chargeable emissions, Regulations Governing the Collection of Carbon Fees Art 5). */
const round3 = (r: Rat): Rat => rat(fmtRat(r, 3));
const min = (a: Rat, b: Rat) => (cmp(a, b) <= 0 ? a : b);

// ------------------------------------------------------------------ statement

/** The registry keys of a statement (separate domain: never equal to an emissions report's keys). */
export function carbonPriceKeys(st: Pick<CarbonPriceStatement, "d" | "operator" | "reportingPeriod" | "cnCode" | "certificationReportId">) {
  const salt = keccak256(new TextEncoder().encode(st.d)) as Hex;
  return {
    reportKey: reportKeyOf(st.d),
    reportIdHash: hashString(st.certificationReportId),
    reportScopeKey: keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }], [SCOPE_DOMAIN, st.operator.installationId, st.reportingPeriod])),
    credScopeKey: keccak256(
      encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }], [SCOPE_DOMAIN, st.operator.installationId, st.cnCode, st.reportingPeriod]),
    ),
    supplierCommit: supplierCommitOf(st.operator.lei, salt),
    installationCommit: installationCommitOf(st.operator.installationId, salt),
  };
}

/** Adds the SAID (`d`) to a statement built with `d: ""`. */
export function saidifyStatement(st: Omit<CarbonPriceStatement, "d"> & { d?: string }): CarbonPriceStatement {
  const { d: _d, type, version, ...rest } = st;
  const out = { type, version, d: "", ...rest } as CarbonPriceStatement;
  out.d = computeSaid(out as unknown as Record<string, unknown>);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSaid = (s: unknown) => typeof s === "string" && /^E[A-Za-z0-9_-]{43}$/.test(s);

/** Why a statement cannot be used (first problem found), or null. */
export function statementProblem(s: unknown): string | null {
  if (!isObj(s)) return "the carbon price statement is not a JSON object";
  if (s.type !== CARBON_PRICE_STATEMENT_TYPE || s.version !== CARBON_PRICE_STATEMENT_VERSION) return "unknown carbon price statement type or version";
  if (s.notice !== DRAFT_LABEL) return `the statement must carry the notice "${DRAFT_LABEL}"`;
  if (!isSaid(s.d)) return "the statement has no SAID";
  const op = s.operator;
  if (!isObj(op) || typeof op.name !== "string" || typeof op.lei !== "string" || !isLei(op.lei) || typeof op.installationId !== "string" || !op.installationId) return "operator (name, LEI, installationId) missing or malformed";
  if (typeof s.reportingPeriod !== "string" || !isReportingPeriod(s.reportingPeriod)) return "reportingPeriod is not a period";
  if (typeof s.cnCode !== "string" || !isCnCode(s.cnCode)) return "cnCode is not a CN code";
  if (!Array.isArray(s.credentials) || s.credentials.length === 0 || s.credentials.length > 16 || !s.credentials.every(isSaid)) return "credentials must list 1 to 16 credential SAIDs";
  const m = s.mechanism;
  if (!isObj(m) || typeof m.country !== "string" || typeof m.name !== "string" || typeof m.legalBasis !== "string") return "mechanism (country, name, legal basis) missing";
  if (m.form !== "point-source carbon tax" || m.covers !== "direct") return "only a point-source carbon tax on direct emissions is supported (Annex I 3.1, 3.3.2)";
  if (typeof s.currency !== "string" || !/^[A-Z]{3}$/.test(s.currency)) return "currency is not an ISO 4217 code";
  for (const k of ["ratePerTonne", "cpmEmissions", "exemptEmissions", "refunds", "feePaid", "productionTonnes", "emissionsPerTonne", "effectivePriceEurPerTonne"] as const) {
    if (!isDec(s[k])) return `${k} is not a decimal (at most six places)`;
  }
  if (rat(s.cpmEmissions as string).n === 0n) return "cpmEmissions must be positive";
  if (cmp(rat(s.exemptEmissions as string), rat(s.cpmEmissions as string)) > 0) return "exemptEmissions exceed cpmEmissions";
  if (typeof s.exemptBasis !== "string") return "exemptBasis missing (say why emissions are exempted, or 'none')";
  if (s.adjustment !== undefined && !(isObj(s.adjustment) && isDec(s.adjustment.thresholdK) && isDec(s.adjustment.factor) && cmp(rat(s.adjustment.factor as string), ONE) <= 0)) {
    return "adjustment must be { thresholdK, factor ≤ 1 }";
  }
  try {
    tonnesToKg(s.productionTonnes as string);
  } catch {
    return "productionTonnes must have at most 3 decimals";
  }
  const fx = s.fx;
  if (!isObj(fx) || !isDec(fx.unitsPerEur) || rat(fx.unitsPerEur as string).n === 0n || !Number.isInteger(fx.year) || typeof fx.source !== "string") return "fx (unitsPerEur, year, source) missing or malformed";
  if (s.materiality !== "5%") return 'materiality must be "5%" (draft Art 16)';
  if (s.rebatesChecked !== true) return "the certifier did not confirm that rebates and compensation were checked (Annex IV 2.1(g))";
  const c = s.certifier;
  if (!isObj(c) || typeof c.name !== "string" || typeof c.lei !== "string" || !isLei(c.lei) || typeof c.auditorAID !== "string" || typeof c.accreditationNumber !== "string") return "certifier (name, LEI, auditorAID, accreditationNumber) missing";
  if (typeof s.certificationReportId !== "string" || !s.certificationReportId) return "certificationReportId missing";
  if (isoSeconds(s.certifiedAt as string) === undefined || isoSeconds(s.validUntil as string) === undefined) return "certifiedAt and validUntil must be ISO 8601 times with a time zone";
  return null;
}

// ------------------------------------------------------------------ the price

export interface PriceResult {
  problems: { status: CheckStatus; code: string; detail: string }[];
  paidShare: Rat;
  paidEmissionsPerTonne: Rat;
  coveredEmissionsPerTonne: Rat;
  capped: boolean;
  localPerTonne: Rat;
  eurPerTonne: Rat | null;
  eurPerTCO2e: Rat | null;
  eurPerPaidTCO2e: Rat | null;
  fx: (FxRate & { pinned: boolean }) | null;
  steps: string[];
}

/**
 * Re-derives the effective price from a well-formed statement (statementProblem(s) === null), with the exchange rate
 * from `fxTable` (not the statement's), capping the paid emissions per tonne at `seeCap` (the credential's embedded
 * emissions per tonne, when known). Problems found: fail (rebates understated, payment not evidenced, emissions above
 * the mechanism's, pinned rate differs), skipped (no pinned rate), advisory warn (rate of another year, capped).
 */
export function recomputePrice(st: CarbonPriceStatement, opts: { fxTable?: readonly FxRate[]; seeCap?: string | null } = {}): PriceResult {
  const problems: PriceResult["problems"] = [];
  const steps: string[] = [];
  const C = rat(st.cpmEmissions);
  const X = rat(st.exemptEmissions);
  const R = rat(st.ratePerTonne);
  const F = rat(st.refunds);
  const EM = rat(st.emissionsPerTonne);
  const cur = st.currency;

  // Exemption against the scheme's own parameters: a smaller exemption than the scheme grants hides a rebate.
  if (st.adjustment) {
    const K = rat(st.adjustment.thresholdK);
    const f = rat(st.adjustment.factor);
    const base = cmp(C, K) > 0 ? sub(C, K) : ZERO;
    const chargeable = round3(mul(base, f));
    const required = sub(C, chargeable);
    steps.push(`chargeable emissions = (${st.cpmEmissions} − K ${st.adjustment.thresholdK}) × ${st.adjustment.factor} = ${fmtRat(chargeable, 3)} t; exempt = ${fmtRat(required, 3)} t`);
    if (cmp(X, required) < 0) {
      problems.push({ status: "fail", code: "CARBON_PRICE_INVALID/REBATES_UNDERSTATED", detail: `the statement exempts ${st.exemptEmissions} t, but K ${st.adjustment.thresholdK} and factor ${st.adjustment.factor} exempt ${fmtRat(required, 3)} t of ${st.cpmEmissions} t: a rebate is left out (draft Art 8(1)(b))` });
    }
  }
  const paidShare = div(sub(C, X), C);
  const effRate = sub(R, div(F, C)); // EFF_CP_DIR, eq. 6a
  steps.push(`EFF_CP_DIR = ${st.ratePerTonne} − ${st.refunds} / ${st.cpmEmissions} = ${fmtRat(effRate)} ${cur}/tCO2e (eq. 5a, 6a)`);
  // Payment evidence: what the statement's price implies was paid must not exceed the official record (+1 unit:
  // Taiwan's fee is rounded down to a whole dollar, Art 5).
  const payable = sub(mul(sub(C, X), R), F);
  if (cmp(payable, add(rat(st.feePaid), ONE)) > 0) {
    problems.push({ status: "fail", code: "CARBON_PRICE_INVALID/PAYMENT_NOT_EVIDENCED", detail: `(${st.cpmEmissions} − ${st.exemptEmissions}) × ${st.ratePerTonne} − ${st.refunds} = ${fmtRat(payable, 2)} ${cur} implied, but the official record shows ${st.feePaid} ${cur} paid` });
  }
  // The good cannot carry more covered emissions than the mechanism covered (5 % boundary difference allowed, recital 7).
  const attributed = mul(EM, rat(st.productionTonnes));
  if (cmp(attributed, mul(C, add(ONE, rat(BOUNDARY_TOLERANCE)))) > 0) {
    problems.push({ status: "fail", code: "CARBON_PRICE_INVALID/EMISSIONS_EXCEED_CPM", detail: `${st.emissionsPerTonne} tCO2e/t × ${st.productionTonnes} t = ${fmtRat(attributed, 3)} t attributed to the good, more than the ${st.cpmEmissions} t the mechanism covered (+${Number(BOUNDARY_TOLERANCE) * 100} %)` });
  }
  const paidEm = mul(EM, paidShare);
  let covered = paidEm;
  let capped = false;
  if (opts.seeCap && isDec(opts.seeCap)) {
    covered = min(paidEm, rat(opts.seeCap));
    capped = cmp(covered, paidEm) < 0;
    if (capped) problems.push({ status: "warn", code: "CARBON_PRICE_WARNING/CAPPED", detail: `paid emissions ${fmtRat(paidEm)} tCO2e/t capped at the credential's embedded emissions ${opts.seeCap} tCO2e/t` });
  }
  steps.push(`(EM ${st.emissionsPerTonne} − rebated ${fmtRat(sub(EM, paidEm))}) = ${fmtRat(paidEm)} tCO2e/t paid on (share ${fmtRat(paidShare)}${capped ? `, capped at ${opts.seeCap}` : ""}) (eq. 11a, 12a)`);
  const local = mul(covered, effRate);
  steps.push(`EFF_CP_DIRg = ${fmtRat(covered)} × ${fmtRat(effRate)} = ${fmtRat(local)} ${cur} per t of good (eq. 12a)`);

  // Exchange rate: pinned by the verifier; the statement's must equal it.
  const table = opts.fxTable ?? PINNED_FX;
  const pinned = table.find((r) => r.currency === cur && r.year === st.fx.year);
  let eur: Rat | null = null;
  let perT: Rat | null = null;
  let perPaid: Rat | null = null;
  let fx: PriceResult["fx"] = null;
  if (!pinned) {
    problems.push({ status: "skipped", code: "", detail: `no pinned yearly average rate for ${cur} ${st.fx.year}: the € value cannot be confirmed (draft Art 5)` });
    fx = { currency: cur, year: st.fx.year, unitsPerEur: st.fx.unitsPerEur, source: st.fx.source, pinned: false };
  } else {
    fx = { ...pinned, pinned: true };
    if (cmp(rat(st.fx.unitsPerEur), rat(pinned.unitsPerEur)) !== 0) {
      problems.push({ status: "fail", code: "CARBON_PRICE_INVALID/FX_MISMATCH", detail: `the statement converts at ${st.fx.unitsPerEur} ${cur}/EUR; the pinned ${st.fx.year} average is ${pinned.unitsPerEur} (${pinned.source})` });
    }
    eur = div(local, rat(pinned.unitsPerEur));
    perPaid = div(effRate, rat(pinned.unitsPerEur));
    perT = EM.n === 0n ? null : div(eur, EM);
    steps.push(`€EFF_CP_DIRg = ${fmtRat(local)} ÷ ${pinned.unitsPerEur} ${cur}/EUR = €${fmtRat(eur)} per t of good (eq. 15a; ${pinned.source})`);
  }
  const periodYear = Number(st.reportingPeriod.slice(0, 4));
  if (st.fx.year !== periodYear) {
    problems.push({ status: "warn", code: "CARBON_PRICE_WARNING/FX_YEAR", detail: `the ${st.fx.year} average rate is used for a ${periodYear} period; the draft wants the reporting period's year (Art 5(1)), not published yet` });
  }
  return { problems, paidShare, paidEmissionsPerTonne: paidEm, coveredEmissionsPerTonne: covered, capped, localPerTonne: local, eurPerTonne: eur, eurPerTCO2e: perT, eurPerPaidTCO2e: perPaid, fx, steps };
}

// ------------------------------------------------------------------ the check

export interface CarbonPriceCheckerOptions {
  /** Root of trust for the certifier's vLEI chain (pinned by the verifier, never read from the evidence). */
  trustAnchor: string;
  fxTable?: readonly FxRate[];
}

export interface CarbonPriceContext {
  /** Check 9's breakdown, when it ran (a precursor target needs it). */
  precursors?: PrecursorReport;
  /** The importer's EORI (a statement on the good itself is claimed for the importer). */
  importerEORI?: string;
  /** The proof's shipment quantity (the tonnes a statement on the good itself must cover). */
  shipmentTonnes?: string;
}

const SEE = "specificEmbeddedEmissions_tCO2e_per_t";
const rank = (r: { status: CheckStatus; code: string }) =>
  r.status === "fail" ? 4 : r.status === "warn" && r.code === "CONTESTED" ? 3 : r.status === "skipped" ? 2 : r.status === "warn" ? 1 : 0;

function emptyReport(): CarbonPriceReport {
  return {
    draft: DRAFT_LABEL,
    statementSAID: null,
    target: null,
    mechanism: null,
    currency: null,
    ratePerTonne: null,
    paidShare: null,
    emissionsPerTonne: null,
    paidEmissionsPerTonne: null,
    coveredEmissionsPerTonne: null,
    localPerTonne: null,
    fx: null,
    eurPerTonne: null,
    statedEurPerTonne: null,
    eurPerTCO2e: null,
    eurPerPaidTCO2e: null,
    deductibleEurPerTonneGood: null,
    claim: null,
    certifier: null,
    registeredAt: null,
    steps: [],
  };
}

/**
 * Check 10 as an evidence checker (sdk/verify.ts runs it after check 9 when the proof carries carbonPriceEvidence).
 * Verdict mapping, from the worst finding (as check 9):
 *  - fail → INVALID: malformed statement or wrong SAID; the statement names none of the credentials this proof relies
 *    on, or another installation, period, CN code or LEI; not registered, registered with other keys, revoked or
 *    superseded; the operator's signature is not from the address registered as the credential's supplier; the
 *    certifier's KEL anchor or vLEI chain fails (another role, no accreditation for activity LIV, not on the allowlist
 *    at registration, another root); no claim for this maker/importer, or fewer tonnes claimed than needed; rebates
 *    understated against the scheme's own parameters; the implied payment exceeds the official record; more emissions
 *    attributed than the mechanism covered; the exchange rate differs from the pinned one; the stated € price exceeds
 *    the recomputed one by more than PRICE_TOLERANCE_EUR;
 *  - warn CONTESTED → CONTESTED: the certifier's lead auditor was revoked on the allowlist after the registration;
 *  - skipped → INCOMPLETE: no pinned exchange rate for that currency and year; the precursor the statement applies to
 *    was not verified (check 9 not decided); a statement on the good itself without the importer's EORI;
 *  - advisory warn (overall unchanged): exchange rate of another year than the period; paid emissions capped at the
 *    credential's; the stated price is below the recomputed one (the lower is used).
 * Every detail starts with DRAFT_LABEL.
 */
export function carbonPriceChecker(opts: CarbonPriceCheckerOptions) {
  return async (evidence: unknown, ctx: EvidenceContext, extra: CarbonPriceContext = {}): Promise<CarbonPriceCheckResult> => {
    const report = emptyReport();
    const findings: { status: CheckStatus; code: string; detail: string }[] = [];
    const note = (status: CheckStatus, code: string, detail: string) => findings.push({ status, code, detail });
    const done = (): CarbonPriceCheckResult => {
      const worst = findings.reduce<{ status: CheckStatus; code: string; detail: string }>((a, b) => (rank(b) > rank(a) ? b : a), { status: "pass", code: "", detail: "" });
      const pre = `[${DRAFT_LABEL}] `;
      if (worst.status === "pass") {
        return { index: 10, name: "", status: "pass", code: "", detail: `${pre}${passDetail(report)}`, carbonPrice: report };
      }
      if (rank(worst) === 1) {
        const all = findings.filter((f) => rank(f) === 1).map((f) => f.detail);
        return { index: 10, name: "", status: "warn", code: worst.code, detail: `${pre}${all.join("; ")}; ${passDetail(report)}`, carbonPrice: report };
      }
      return { index: 10, name: "", status: worst.status, code: worst.code, detail: `${pre}${worst.detail}`, carbonPrice: report };
    };

    if (!isObj(evidence)) {
      note("fail", "CARBON_PRICE_INVALID/STATEMENT_MALFORMED", "the carbon price evidence is not an object");
      return done();
    }
    const problem = statementProblem(evidence.statement);
    if (problem) {
      note("fail", "CARBON_PRICE_INVALID/STATEMENT_MALFORMED", problem);
      return done();
    }
    const st = evidence.statement as CarbonPriceStatement;
    report.statementSAID = st.d;
    report.mechanism = `${st.mechanism.name} (${st.mechanism.country})`;
    report.currency = st.currency;
    report.ratePerTonne = st.ratePerTonne;
    report.emissionsPerTonne = st.emissionsPerTonne;
    report.statedEurPerTonne = st.effectivePriceEurPerTonne;
    report.certifier = { name: st.certifier.name, lei: st.certifier.lei, aid: st.certifier.auditorAID, role: CERTIFIER_ROLE };
    if (computeSaid(st as unknown as Record<string, unknown>) !== st.d) {
      note("fail", "CARBON_PRICE_INVALID/SAID", "the statement's SAID does not match its content");
      return done();
    }
    const cl = evidence.claim;
    if (!isObj(cl) || typeof cl.batchId !== "string" || !cl.batchId || typeof cl.quantityTonnes !== "string" || typeof cl.batchSalt !== "string" || typeof cl.beneficiarySalt !== "string") {
      note("fail", "CARBON_PRICE_INVALID/STATEMENT_MALFORMED", "the evidence has no claim { batchId, quantityTonnes, batchSalt, beneficiarySalt }");
      return done();
    }

    // ---- what the statement applies to: the good's own credential, or a verified precursor line of check 9
    const d = ctx.disclosed;
    const goodLei = d.supplierLEI ?? "";
    type Target = NonNullable<CarbonPriceReport["target"]> & { lei?: string; installationId?: string; reportingPeriod?: string; beneficiary?: string; needKg?: bigint };
    let target: Target | undefined;
    const lines = extra.precursors?.lines ?? [];
    const line = lines.find((l) => l.source === "verified" && l.credSAID && st.credentials.includes(l.credSAID));
    if (st.credentials.includes(ctx.core.d)) {
      const own = extra.precursors?.attributedDirect ?? d[SEE] ?? null;
      target = {
        kind: "good",
        credSAID: ctx.core.d,
        cnCode: d.cnCode ?? "",
        massPerTonne: "1",
        seeCap: own,
        lei: goodLei,
        installationId: d.installationId,
        reportingPeriod: d.reportingPeriod,
        beneficiary: extra.importerEORI,
        ...(extra.shipmentTonnes ? { needKg: tonnesToKg(extra.shipmentTonnes) } : {}),
      };
      if (!extra.importerEORI) note("skipped", "", "the statement is on the good itself: its claim is checked for the importer, so verify with your EORI");
    } else if (line) {
      target = {
        kind: "precursor",
        line: line.index,
        credSAID: line.credSAID!,
        cnCode: line.producer?.cnCode ?? line.cnCode,
        massPerTonne: line.massPerTonne,
        seeCap: line.see,
        lei: line.producer?.lei,
        installationId: line.producer?.installationId,
        reportingPeriod: line.producer?.reportingPeriod,
        beneficiary: goodLei,
        ...(line.neededTonnes ? { needKg: tonnesToKg(line.neededTonnes) } : {}),
      };
      if (line.status === "fail") note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", `the precursor credential the statement applies to fails check 9 (${line.code})`);
      else if (line.status === "skipped" || !line.producer) note("skipped", "", "the precursor credential the statement applies to was not verified (check 9 not decided)");
    } else {
      note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", "the statement covers none of the credentials this proof relies on (the good's own, or a verified precursor of check 9)");
      return done();
    }
    report.target = { kind: target.kind, ...(target.line !== undefined ? { line: target.line } : {}), credSAID: target.credSAID, cnCode: target.cnCode, massPerTonne: target.massPerTonne, seeCap: target.seeCap };
    if (target.lei !== undefined && target.lei !== st.operator.lei) note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", `the statement's operator is LEI ${st.operator.lei}, the credential's supplier ${target.lei}`);
    if (target.installationId !== undefined && target.installationId !== st.operator.installationId) note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", `the statement is for installation ${st.operator.installationId}, the credential for ${target.installationId}`);
    if (target.reportingPeriod !== undefined && target.reportingPeriod !== st.reportingPeriod) note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", `the statement covers ${st.reportingPeriod}, the credential ${target.reportingPeriod} (draft Art 3(3): the same period)`);
    if (target.cnCode && target.cnCode !== st.cnCode) note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", `the statement is for CN ${st.cnCode}, the credential for CN ${target.cnCode}`);

    // ---- on-chain: registration by the certifier body, keys, revocation, supersession
    const keys = carbonPriceKeys(st);
    const rd = ctx.reader;
    const [rep, credRep] = await Promise.all([rd.report(keys.reportKey), rd.report(reportKeyOf(target.credSAID))]);
    if (rep.registeredAt === 0n) {
      note("fail", "CARBON_PRICE_INVALID/NOT_REGISTERED", "the statement is not registered on the registry");
      return finishPrice();
    }
    report.registeredAt = rep.registeredAt.toString();
    const mismatch = [
      rep.reportScopeKey !== keys.reportScopeKey && "report scope",
      rep.credScopeKey !== keys.credScopeKey && "credential scope",
      rep.reportIdHash !== keys.reportIdHash && "certification report ID",
      rep.supplierCommit !== keys.supplierCommit && "operator LEI",
      rep.installationCommit !== keys.installationCommit && "installation",
      rep.auditorAidHash !== auditorAidHashOf(st.certifier.auditorAID) && "certifier lead auditor",
      rep.issuerLeiHash !== leiHashOf(st.certifier.lei) && "certifier body LEI",
      rep.verifiedKg !== tonnesToKg(st.productionTonnes) && "production tonnes",
    ].filter(Boolean);
    if (mismatch.length) note("fail", "CARBON_PRICE_INVALID/NOT_BOUND", `the registration differs from the statement in: ${mismatch.join(", ")}`);
    if (rep.revokedAt !== 0n) note("fail", "CARBON_PRICE_INVALID/REVOKED", "the certifier revoked the statement on the registry");
    if (rep.supersededBy !== `0x${"0".repeat(64)}`) note("fail", "CARBON_PRICE_INVALID/SUPERSEDED", `a newer statement for the same installation and period replaced this one (${rep.supersededBy})`);

    // ---- the operator: signature by the supplier address of the registered statement = the credential's supplier
    let signer: string | undefined;
    try {
      signer = await recoverMessageAddress({ message: st.d, signature: evidence.operatorSignature as Hex });
    } catch {
      signer = undefined;
    }
    if (!signer || signer.toLowerCase() !== rep.supplier.toLowerCase()) note("fail", "CARBON_PRICE_INVALID/OPERATOR_SIGNATURE", "the operator's signature over the statement is not from the supplier address registered with it");
    else if (credRep.registeredAt !== 0n && credRep.supplier.toLowerCase() !== rep.supplier.toLowerCase()) {
      note("fail", "CARBON_PRICE_INVALID/OPERATOR_SIGNATURE", "the statement was signed by another address than the supplier of the credential it applies to");
    }

    // ---- the independent person: KEL anchor and vLEI chain (role and accreditation activity), allowlist records
    const anchor = verifyAnchor(evidence.anchorEvidence as AnchorEvidence, { credSAID: st.d, auditorAID: st.certifier.auditorAID, kelSeq: rep.kelSeq, auditorAidHash: rep.auditorAidHash });
    if (!anchor.ok) note("fail", "CARBON_PRICE_INVALID/CERTIFIER_ANCHOR", anchor.detail);
    const [inst, aud] = await Promise.all([rd.institution(rep.issuerLeiHash), rd.auditor(rep.auditorAidHash, rep.issuerLeiHash)]);
    const auth = verifyAuthority(evidence.authorityEvidence as AuthorityEvidence, {
      trustAnchor: opts.trustAnchor,
      auditorAID: st.certifier.auditorAID,
      verifierLEI: st.certifier.lei,
      cnCode: st.cnCode,
      registeredAt: rep.registeredAt,
      role: CERTIFIER_ROLE,
      activity: CERTIFIER_ACTIVITY,
      onchain: {
        leCredSaidHash: inst.leCredSaidHash,
        accreditationSaidHash: inst.accreditationSaidHash,
        ecrSaidHash: aud.ecrSaidHash,
        accreditedUntil: inst.accreditedUntil,
        auditorAddedAt: aud.addedAt,
        auditorRevokedAt: aud.revokedAt,
      },
    });
    if (!auth.ok) note("fail", "CARBON_PRICE_INVALID/CERTIFIER_AUTHORITY", auth.detail);
    else if (aud.revokedAt !== 0n && aud.revokedAt >= rep.registeredAt) {
      note("warn", "CONTESTED", "the certifier's lead auditor was revoked on the allowlist after certifying this statement: a person should review it");
    }

    // ---- the claim: tonnes of the statement's good claimed for this maker (or importer), at least the tonnes needed
    report.claim = { batchId: cl.batchId as string, claimedTonnes: null, neededTonnes: target.needKg !== undefined ? kgToTonnes(target.needKg) : null };
    if (target.beneficiary) {
      const batchKey = batchKeyOf(keys.reportKey, cl.batchId as string, cl.batchSalt as Hex);
      const s = await rd.shipmentStatus(batchKey);
      if (s.claimedAt === 0n || s.reportKey !== keys.reportKey) note("fail", "CARBON_PRICE_INVALID/NOT_CLAIMED", `batch ${cl.batchId} was not claimed against this statement`);
      else if (s.importerCommit !== importerCommitOf(target.beneficiary, cl.beneficiarySalt as Hex)) {
        note("fail", "CARBON_PRICE_INVALID/NOT_CLAIMED", `batch ${cl.batchId} was claimed for someone other than ${target.kind === "precursor" ? `the maker ${target.beneficiary}` : "you"}`);
      } else {
        report.claim.claimedTonnes = kgToTonnes(s.quantityKg);
        if (target.needKg !== undefined && s.quantityKg < target.needKg) {
          note("fail", "CARBON_PRICE_INVALID/TONNES_NOT_COVERED", `${report.claim.claimedTonnes} t claimed against the statement for this ${target.kind === "precursor" ? "maker" : "importer"}, ${report.claim.neededTonnes} t needed`);
        }
      }
    }
    return finishPrice();

    function finishPrice(): CarbonPriceCheckResult {
      const pr = recomputePrice(st, { fxTable: opts.fxTable, seeCap: target?.seeCap ?? null });
      for (const p of pr.problems) note(p.status, p.code, p.detail);
      report.paidShare = fmtRat(pr.paidShare);
      report.paidEmissionsPerTonne = fmtRat(pr.paidEmissionsPerTonne);
      report.coveredEmissionsPerTonne = fmtRat(pr.coveredEmissionsPerTonne);
      report.localPerTonne = fmtRat(pr.localPerTonne);
      report.fx = pr.fx;
      report.steps = pr.steps;
      if (pr.eurPerTonne) {
        report.eurPerTonne = fmtRat(pr.eurPerTonne);
        report.eurPerTCO2e = pr.eurPerTCO2e ? fmtRat(pr.eurPerTCO2e) : null;
        report.eurPerPaidTCO2e = fmtRat(pr.eurPerPaidTCO2e!);
        const stated = rat(st.effectivePriceEurPerTonne);
        if (cmp(stated, add(pr.eurPerTonne, rat(PRICE_TOLERANCE_EUR))) > 0) {
          note("fail", "CARBON_PRICE_INVALID/PRICE_OVERSTATED", `€${st.effectivePriceEurPerTonne} per t stated, €${report.eurPerTonne} recomputed (tolerance €${PRICE_TOLERANCE_EUR})`);
        } else if (cmp(stated, sub(pr.eurPerTonne, rat(PRICE_TOLERANCE_EUR))) < 0) {
          note("warn", "CARBON_PRICE_WARNING/PRICE_UNDERSTATED", `€${st.effectivePriceEurPerTonne} per t stated, €${report.eurPerTonne} recomputed: the lower is used`);
        }
        const use = min(stated, pr.eurPerTonne);
        if (target) {
          const per = mul(use, rat(target.massPerTonne));
          report.deductibleEurPerTonneGood = fmtRat(per);
          report.steps.push(
            target.kind === "precursor"
              ? `€EFF_CP_PREg = ${target.massPerTonne} t/t × €${fmtRat(use)} = €${report.deductibleEurPerTonneGood} per t of the declared good (eq. 14a, m = Q_p / Q_TOTg)`
              : `€EFF_CPg = €${report.deductibleEurPerTonneGood} per t of the declared good (eq. 16)`,
          );
        }
      }
      return done();
    }
  };
}

function passDetail(r: CarbonPriceReport): string {
  if (!r.deductibleEurPerTonneGood) return "carbon price statement checked";
  const who = r.certifier ? `certified by ${r.certifier.name} (${CERTIFIER_ROLE})` : "certified";
  return `${r.mechanism}: ${r.ratePerTonne} ${r.currency}/tCO2e on ${r.paidShare} of the emissions → €${r.eurPerTCO2e} per tCO2e emitted, €${r.eurPerTonne} per t of CN ${r.target?.cnCode}; €${r.deductibleEurPerTonneGood} per t of the declared good; ${who}; ${r.claim?.claimedTonnes ?? "?"} t claimed against the statement (${r.claim?.neededTonnes ?? "?"} t needed)`;
}

/** Check 10's breakdown as indented lines under the CLI's check list. */
export function carbonPriceLines(r: CarbonPriceReport, indent = "      "): string[] {
  return [`${indent}${DRAFT_LABEL.toUpperCase()}`, ...r.steps.map((s) => `${indent}${s}`)];
}

// ------------------------------------------------------------------ deduction (draft Art 6(1))

/**
 * Certificates the deduction removes for `quantityTonnes` of the declared good: €EFF_CPg ÷ reference price × Q_g,
 * rounded DOWN to three decimals (a conservative planning figure; the draft sets no rounding), never more than
 * `capT` (the line's obligation). Draft Art 6(1); the reference price is the yearly average CBAM certificate price of
 * the year of import (Art 6(3)).
 */
export function art9Reduction(eurPerTonneGood: string, refPriceEur: string, quantityTonnes: string, capT?: string): string {
  const r = div(mul(rat(eurPerTonneGood), rat(quantityTonnes)), rat(refPriceEur));
  const down = (r.n * 1000n) / r.d; // floor, non-negative
  let v = down;
  if (capT !== undefined) {
    const c = rat(capT);
    const capK = (c.n * 1000n) / c.d;
    if (v > capK) v = capK;
  }
  const w = v / 1000n;
  const f = (v % 1000n).toString().padStart(3, "0");
  return `${w}.${f}`;
}

// ------------------------------------------------------------------ portfolio line (sdk/portfolio.ts, additive)

/** A line of the planning worksheet, as far as the Art 9 summary needs it (sdk/portfolio.ts ShipmentLine). */
export interface Art9LineInput {
  id: string;
  basis: "actual" | "default";
  quantityTonnes: string;
  obligationT: string;
}

export interface Art9Summary {
  draft: typeof DRAFT_LABEL;
  basis: string;
  refPriceEur: string;
  refPriceNote: string;
  lines: { id: string; mechanism: string; statementSAID: string; eurPerTonneGood: string; quantityTonnes: string; reductionCertificates: string }[];
  /** Lines with a carbon price statement that cannot be used, with the reason. */
  notUsed: { id: string; reason: string }[];
  totalReduction: string;
  /** Obligation before the deduction (the portfolio's totals.obligationT), after it, and whole certificates after it. */
  obligationT: string;
  netObligationT: string;
  netCertificates: number;
  note: string;
}

/**
 * The draft Art 9 deduction for a portfolio, kept apart from its totals: per line on actual values whose verdict has a
 * check 10 that passed (or only advised), €EFF_CPg ÷ reference price × Q_g (draft Art 6(1)), capped at the line's
 * obligation. `verdicts` maps a line id to its verdict's check 10 and breakdown.
 */
export function art9Summary(
  lines: readonly Art9LineInput[],
  verdicts: ReadonlyMap<string, { overall: string; checks: { id: number; status: string; code: string }[]; carbonPrice?: CarbonPriceReport } | null | undefined>,
  opts: { refPriceEur: string },
  obligationT: string,
): Art9Summary {
  rat(opts.refPriceEur); // throws on a malformed price
  const out: Art9Summary["lines"] = [];
  const notUsed: Art9Summary["notUsed"] = [];
  let total = 0n; // thousandths of a certificate
  for (const l of lines) {
    const v = verdicts.get(l.id);
    const c10 = v?.checks.find((c) => c.id === 10);
    if (!v || !c10) continue;
    const cp = v.carbonPrice;
    if (l.basis !== "actual") {
      notUsed.push({ id: l.id, reason: "declared on default values: the certified carbon price applies only to actual values (draft recital 5); a default carbon price would apply instead (none published)" });
    } else if (v.overall !== "VALID" || (c10.status !== "pass" && c10.status !== "warn") || c10.code === "CONTESTED") {
      notUsed.push({ id: l.id, reason: `check 10 ${c10.status}${c10.code ? ` ${c10.code}` : ""}` });
    } else if (!cp?.deductibleEurPerTonneGood) {
      notUsed.push({ id: l.id, reason: "no € price per tonne recomputed" });
    } else {
      const red = art9Reduction(cp.deductibleEurPerTonneGood, opts.refPriceEur, l.quantityTonnes, l.obligationT);
      total += BigInt(red.replace(".", ""));
      out.push({ id: l.id, mechanism: cp.mechanism ?? "", statementSAID: cp.statementSAID ?? "", eurPerTonneGood: cp.deductibleEurPerTonneGood, quantityTonnes: l.quantityTonnes, reductionCertificates: red });
    }
  }
  const t3 = (x: bigint) => `${x / 1000n}.${(x % 1000n).toString().padStart(3, "0")}`;
  const obl = rat(obligationT);
  const oblK = (obl.n * 1000n) / obl.d;
  const net = oblK > total ? oblK - total : 0n;
  return {
    draft: DRAFT_LABEL,
    basis: DRAFT_REF,
    refPriceEur: opts.refPriceEur,
    refPriceNote:
      "The draft's reference price is the yearly average CBAM certificate price of the year of import (draft Art 6(3)); pass the published figure. Reductions are rounded down to 0.001 certificate (our convention; the draft sets none).",
    lines: out,
    notUsed,
    totalReduction: t3(total),
    obligationT: t3(oblK),
    netObligationT: t3(net),
    netCertificates: Number((net + 999n) / 1000n),
    note: `${DRAFT_LABEL}: the deduction is shown apart; the portfolio's totals and certificates are before it.`,
  };
}

/** The Art 9 summary as text for the CLI. */
export function art9Text(a: Art9Summary): string {
  const rows = a.lines.map((l) => `  ${l.id}: ${l.quantityTonnes} t × €${l.eurPerTonneGood}/t ÷ €${a.refPriceEur} = ${l.reductionCertificates} certificates (${l.mechanism})`);
  const skipped = a.notUsed.map((n) => `  ${n.id}: not used — ${n.reason}`);
  return [
    `\nCARBON PRICE PAID (CBAM Art 9) — ${DRAFT_LABEL.toUpperCase()}`,
    ...rows,
    ...skipped,
    `  total reduction ${a.totalReduction} of ${a.obligationT} tCO2e → ${a.netObligationT} tCO2e, ${a.netCertificates} certificates after it`,
    `  ${a.refPriceNote}`,
  ].join("\n");
}

// ------------------------------------------------------------------ offline re-check (the hosted page)

export interface CarbonPriceOfflineItem {
  id: string;
  ok: boolean | null;
  detail: string;
}

/**
 * What a browser can re-check of a carbon price statement from exported evidence alone, without the chain: its shape
 * and SAID, the certifier lead auditor's KEL anchor (key from their inception, kelSeq 1) and vLEI chain pinned to
 * `trustAnchor` (role and accreditation activity; no allowlist records), the operator's signature (the address it
 * recovers to; that it is the registered supplier is on-chain), and the price re-derivation with the pinned rate.
 * Registration, revocation, supersession, the allowlist and the claim are on-chain facts (ok: null).
 */
export async function checkCarbonPriceOffline(evidence: CarbonPriceEvidence, opts: { trustAnchor: string; fxTable?: readonly FxRate[]; seeCap?: string | null; massPerTonne?: string }): Promise<CarbonPriceOfflineItem[]> {
  const items: CarbonPriceOfflineItem[] = [];
  const st = evidence.statement;
  const problem = statementProblem(st);
  if (problem) return [{ id: "statement", ok: false, detail: problem }];
  const saidOk = computeSaid(st as unknown as Record<string, unknown>) === st.d;
  items.push({ id: "said", ok: saidOk, detail: saidOk ? `the statement's SAID ${st.d} matches its content` : "the statement's SAID does not match its content" });
  let signer = "";
  try {
    signer = await recoverMessageAddress({ message: st.d, signature: evidence.operatorSignature });
  } catch {}
  items.push({ id: "operator", ok: signer ? true : false, detail: signer ? `the operator signed the SAID with address ${signer} (that it is the supplier registered with the statement and the credential is checked on-chain)` : "the operator's signature cannot be read" });
  const anchor = verifyAnchor(evidence.anchorEvidence as AnchorEvidence, { credSAID: st.d, auditorAID: st.certifier.auditorAID, kelSeq: 1n });
  items.push({ id: "anchor", ok: anchor.ok, detail: anchor.ok ? `the certification lead auditor anchored the statement in their KEL (${anchor.detail.replace(/^KERI event #1 by the auditor anchors this credential; /, "")})` : anchor.detail });
  const auth = verifyAuthority(evidence.authorityEvidence as AuthorityEvidence, { trustAnchor: opts.trustAnchor, auditorAID: st.certifier.auditorAID, verifierLEI: st.certifier.lei, cnCode: st.cnCode, role: CERTIFIER_ROLE, activity: CERTIFIER_ACTIVITY });
  items.push({ id: "authority", ok: auth.ok, detail: auth.ok ? `vLEI chain of the independent person (LEI ${st.certifier.lei}) to the pinned root: ${auth.detail}` : auth.detail });
  const pr = recomputePrice(st, { fxTable: opts.fxTable, seeCap: opts.seeCap ?? null });
  const fails = pr.problems.filter((p) => p.status === "fail");
  items.push({ id: "price", ok: fails.length ? false : pr.eurPerTonne ? true : null, detail: fails.length ? fails.map((f) => f.detail).join("; ") : pr.steps.join("; ") });
  if (pr.eurPerTonne) {
    const stated = rat(st.effectivePriceEurPerTonne);
    const ok = cmp(stated, add(pr.eurPerTonne, rat(PRICE_TOLERANCE_EUR))) <= 0;
    const per = opts.massPerTonne ? ` → €${fmtRat(mul(min(stated, pr.eurPerTonne), rat(opts.massPerTonne)))} per t of the declared good (× ${opts.massPerTonne} t/t)` : "";
    items.push({ id: "stated", ok, detail: `€${st.effectivePriceEurPerTonne} per t stated, €${fmtRat(pr.eurPerTonne)} recomputed at the pinned rate${per}` });
  }
  items.push({ id: "onchain", ok: null, detail: "registration by an allowlisted certifier, revocation, supersession and the claim for this maker: on-chain facts, not re-read here" });
  return items;
}
