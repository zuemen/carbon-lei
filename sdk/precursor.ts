// Check 9: the precursor chain of trust (multi-tier). A complex good's specific embedded emissions (SEE) are its own
// process's attributed emissions plus the embedded emissions of the precursors it consumed:
//   SEE_g = ae_g + Σ m_i · SEE_i      (Commission Guidance No. 3, 14 August 2026, section 4.2.2.3, Equations 59–63)
// where m_i is the mass of precursor i consumed per tonne of good, scrap and losses included (Guidance No. 3, p. 34,
// "Note on the parameter Mi"; Guidance No. 5d, 14 August 2026, p. 14: "if e.g. 20% of the original mass are cut away
// ... 100 t precursor are required for 80 t of final product"). Actual data for a precursor need a valid
// verification report from its producer; otherwise its default value (with mark-up) applies (Guidance No. 3,
// pp. 34 and 36–37, section 4.10.1).
//
// The verification body of the good signs a precursor statement (ae_g and, per precursor, m_i and either the
// producer's credential SAID and the batch the producer claimed for this good's maker, or the default value it
// applied) by committing to its digest in the credential core (`precursorDigest`, covered by the SAID, the EIP-712
// signature and the auditor's KEL anchor). The supplier presents the statement and, per verified precursor, the
// producer's own proof. Check 9 then
//   (a) verifies each producer's proof with checks 0–9 (recursively), with check 5 bound to the good's supplier LEI:
//       the producer claimed that batch for this maker on the same registry, so one verified tonne of wire rod can
//       back only one screw maker (the contract's ExceedsVerifiedTonnage cap, one tier up);
//   (b) checks the precursor's CN code and period against the statement and the good, and that the claimed tonnes
//       cover m_i × the good's verified tonnes;
//   (c) recomputes SEE_g and compares it with the declared (signed) value within PRECURSOR_TOLERANCE;
//   (d) flags a precursor for which the statement applies a default value (advisory: the value is the body's, not
//       checked against the Default Values Act here).
import { keccak256, stringToBytes } from "viem";
import { canonicalJson } from "./consistency.ts";
import { isCnCode, isReportingPeriod, kgToTonnes, tonnesToKg, type Hex } from "./credential.ts";
import type { Presentation } from "./disclosure.ts";
import { verifyOffline, verifyPresentation, type CheckResult, type CheckStatus, type EvidenceCheckers, type EvidenceContext, type Overall } from "./verify.ts";
import { verifyAnchor, verifyAuthority, type AnchorEvidence, type AuthorityEvidence } from "./vlei.ts";

export const PRECURSOR_STATEMENT_TYPE = "CarbonLEI Precursor Statement";
export const PRECURSOR_STATEMENT_VERSION = "0.1.0";
/**
 * Largest accepted difference between the declared SEE and the recomputed one, in tCO2e per tonne of good. SEE
 * values are reported rounded; the guidance sets no tolerance, so this is our own choice (about 0.5% of 1.8).
 */
export const PRECURSOR_TOLERANCE = "0.01";
/** How many precursor tiers below the good are verified (each tier is a full proof verification). */
export const MAX_PRECURSOR_DEPTH = 3;
/** Most lines one statement may have. */
export const MAX_PRECURSOR_LINES = 16;

export interface PrecursorLine {
  /** CN code of the precursor (4, 6 or 8 digits), e.g. "7213" (wire rod). */
  cnCode: string;
  /** m_i: tonnes of this precursor consumed per tonne of good, scrap and losses included (decimal, ≤ 6 places). */
  massPerTonne: string;
  source: "verified" | "default";
  /** verified: SAID of the producer's credential (registered on the same registry). */
  credSAID?: string;
  /** verified: the batch the producer claimed for this good's maker on that credential. */
  batchId?: string;
  /** default: the default value the operator applied, mark-up included, tCO2e/t of precursor. */
  defaultSEE?: string;
  /** default: where it comes from, as the body states it (free text; not checked here). */
  defaultBasis?: string;
}

export interface PrecursorStatement {
  type: typeof PRECURSOR_STATEMENT_TYPE;
  version: typeof PRECURSOR_STATEMENT_VERSION;
  /** ae_g: the good's own process's specific attributed direct emissions, tCO2e/t (Guidance No. 3, Eq. 63). */
  attributedDirect: string;
  lines: PrecursorLine[];
}

/** What the supplier presents: the statement and, per line, the producer's proof (null for a default line). */
export interface PrecursorEvidence {
  statement: PrecursorStatement;
  proofs: (Presentation | null)[];
}

export interface PrecursorLineResult {
  index: number;
  cnCode: string;
  massPerTonne: string;
  source: "verified" | "default";
  status: CheckStatus;
  code: string;
  detail: string;
  /** SEE of the precursor used in the recomputation (the producer's disclosed value, or the default). */
  see: string | null;
  /** m_i × SEE_i, tCO2e per tonne of good. */
  contribution: string | null;
  credSAID?: string;
  batchId?: string;
  defaultBasis?: string;
  producer?: { lei?: string; installationId?: string; reportingPeriod?: string; cnCode?: string; verifierLEI?: string; verifiedTonnes?: string };
  /** Tonnes the producer claimed for this good's maker (check 5 of the producer's proof), and the tonnes needed. */
  claimedTonnes?: string;
  neededTonnes?: string;
  /** The producer's proof verification (checks 0–9). */
  verification?: { overall: Overall; primaryCode: string; checks: CheckResult[]; precursors?: PrecursorReport };
}

export interface PrecursorReport {
  /** The statement's digest is in the good's signed core (false: presented, but not signed by the good's body). */
  signed: boolean;
  attributedDirect: string | null;
  declared: string | null;
  recomputed: string | null;
  precursorTotal: string | null;
  difference: string | null;
  tolerance: string;
  goodVerifiedTonnes: string | null;
  lines: PrecursorLineResult[];
}

export type PrecursorCheckResult = CheckResult & { precursors?: PrecursorReport };

// ------------------------------------------------------------------ digest and shape

/** keccak256 of the statement's canonical JSON (sorted keys): the value of `precursorDigest` in the core. */
export function precursorDigestOf(statement: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(statement)));
}

const DEC = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const SCALE = 1_000_000n;
/** A non-negative decimal with at most six places, scaled by 10^6. */
export function dec6(s: string): bigint {
  if (typeof s !== "string" || !DEC.test(s)) throw new Error(`not a decimal with at most six places: ${String(s)}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * SCALE + BigInt((f + "000000").slice(0, 6));
}
/** A value scaled by 10^12, rounded half up to six places, without trailing zeros. */
export function fmt12(x: bigint): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const r = (a + SCALE / 2n) / SCALE; // to 10^-6
  const whole = r / SCALE;
  const frac = (r % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg && r !== 0n ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a statement cannot be used (first problem found), or null. */
export function statementProblem(s: unknown): string | null {
  if (!isObj(s)) return "the precursor statement is not a JSON object";
  if (s.type !== PRECURSOR_STATEMENT_TYPE || s.version !== PRECURSOR_STATEMENT_VERSION) return "unknown precursor statement type or version";
  if (typeof s.attributedDirect !== "string" || !DEC.test(s.attributedDirect)) return "attributedDirect is not a decimal";
  if (!Array.isArray(s.lines) || s.lines.length === 0 || s.lines.length > MAX_PRECURSOR_LINES) {
    return `the statement must list 1 to ${MAX_PRECURSOR_LINES} precursor lines`;
  }
  const seen = new Set<string>();
  for (const [i, l] of (s.lines as unknown[]).entries()) {
    if (!isObj(l)) return `line ${i + 1} is not an object`;
    if (typeof l.cnCode !== "string" || !isCnCode(l.cnCode)) return `line ${i + 1}: cnCode is not a CN code`;
    if (typeof l.massPerTonne !== "string" || !DEC.test(l.massPerTonne) || dec6(l.massPerTonne) === 0n) {
      return `line ${i + 1}: massPerTonne is not a positive decimal`;
    }
    if (l.source === "verified") {
      if (typeof l.credSAID !== "string" || !/^E[A-Za-z0-9_-]{43}$/.test(l.credSAID)) return `line ${i + 1}: credSAID is not a SAID`;
      if (typeof l.batchId !== "string" || l.batchId === "") return `line ${i + 1}: batchId missing`;
      const key = `${l.credSAID}\u0000${l.batchId}`;
      // The same claimed batch counted twice would count its tonnes twice.
      if (seen.has(key)) return `line ${i + 1} repeats the credential and batch of an earlier line`;
      seen.add(key);
    } else if (l.source === "default") {
      if (typeof l.defaultSEE !== "string" || !DEC.test(l.defaultSEE)) return `line ${i + 1}: defaultSEE is not a decimal`;
    } else return `line ${i + 1}: source must be "verified" or "default"`;
  }
  return null;
}

// ------------------------------------------------------------------ scope rules

/**
 * Whether `precursor` can be a relevant precursor of `good`, for the aggregated goods categories this demo covers:
 * iron or steel products (chapters 72 and 73) take ferro-alloys, pig iron, DRI, crude steel and iron or steel
 * products (Guidance No. 3, Table 4-2, rows 11–15; Guidance No. 5d, p. 14), all in chapters 72 and 73, never 7204
 * ferrous waste and scrap (outside CBAM, Annex I of Regulation (EU) 2023/956); aluminium products (76) take
 * unwrought aluminium and aluminium products (76). null: this verifier has no rule for the good's CN code.
 */
export function relevantPrecursor(good: string, precursor: string): boolean | null {
  const steel = (cn: string) => (cn.startsWith("72") && !cn.startsWith("7204")) || cn.startsWith("73");
  if (good.startsWith("72") || good.startsWith("73")) return steel(precursor);
  if (good.startsWith("76")) return precursor.startsWith("76");
  return null;
}

/** The producer's period may not start after the good's period ends (a precursor is made before it is consumed). */
export function periodFits(precursorPeriod: string, goodPeriod: string): boolean {
  if (!isReportingPeriod(precursorPeriod) || !isReportingPeriod(goodPeriod)) return false;
  return precursorPeriod.split("/")[0] <= goodPeriod.split("/")[1];
}

// ------------------------------------------------------------------ the check

export interface PrecursorCheckerOptions {
  /** Checkers for the producers' proofs (checks 6–9 one tier down, with the root pinned for that tier). */
  checkers: () => EvidenceCheckers;
}

const SEE = "specificEmbeddedEmissions_tCO2e_per_t";
/** Order of severity of a line or of the whole check: fail, CONTESTED, not checked, advisory, pass. */
const rank = (r: { status: CheckStatus; code: string }) =>
  r.status === "fail" ? 4 : r.status === "warn" && r.code === "CONTESTED" ? 3 : r.status === "skipped" ? 2 : r.status === "warn" ? 1 : 0;

function firstFailing(checks: CheckResult[]): string {
  const f = checks.find((c) => c.status === "fail") ?? checks.find((c) => c.status === "warn" && c.code === "CONTESTED") ?? checks.find((c) => c.status === "skipped");
  return f ? `check ${f.index} ${f.status === "skipped" ? "not run" : f.code}${f.detail ? `: ${f.detail}` : ""}` : "";
}

/**
 * Check 9 as an evidence checker (sdk/verify.ts runs it when the core commits to a statement or the proof carries
 * precursor evidence). Verdict mapping, from the worst line:
 *  - fail → INVALID: the statement's digest differs from the signed one; the signed statement is malformed; a
 *    producer's proof is INVALID (not registered, unknown or revoked body or auditor, revoked or superseded report,
 *    batch not claimed for this maker, ...); a precursor outside the statement's CN code, not a relevant precursor,
 *    or from a later period; claimed tonnes below m_i × the good's verified tonnes; declared SEE below the
 *    recomputation by more than the tolerance (the good's value relies on precursor data it cannot rely on);
 *  - warn CONTESTED → CONTESTED: a producer's proof is CONTESTED (needs a person's review);
 *  - skipped → INCOMPLETE (when the core commits to a statement): a producer's proof or a value needed for the
 *    recomputation was not presented, or a producer's proof is INCOMPLETE;
 *  - advisory warn (overall unchanged): a default value applied for a precursor (PRECURSOR_WARNING/DEFAULT_USED);
 *    declared SEE above the recomputation (PRECURSOR_WARNING/SEE_OVERSTATED: conservative, but inconsistent).
 * When the core carries no `precursorDigest`, nothing binds the statement to the good's value: every outcome is
 * reported as an advisory warning (PRECURSOR_WARNING/UNSIGNED) and the overall result does not change.
 */
export function precursorChecker(opts: PrecursorCheckerOptions) {
  return async (evidence: unknown, ctx: EvidenceContext): Promise<PrecursorCheckResult> => {
    const signed = typeof ctx.core.precursorDigest === "string";
    const d = ctx.disclosed;
    const report: PrecursorReport = {
      signed,
      attributedDirect: null,
      declared: d[SEE] ?? null,
      recomputed: null,
      precursorTotal: null,
      difference: null,
      tolerance: PRECURSOR_TOLERANCE,
      goodVerifiedTonnes: d.verifiedTonnes ?? null,
      lines: [],
    };
    const out = (status: CheckStatus, code: string, detail: string): PrecursorCheckResult => {
      if (!signed) {
        const why = "the precursor statement is not covered by this credential's signature (the core has no precursorDigest), so it is shown for information only";
        return { index: 9, name: "", status: "warn", code: "PRECURSOR_WARNING/UNSIGNED", detail: `${why}${detail ? `; ${status === "pass" ? "it would pass" : `found: ${detail}`}` : ""}`, precursors: report };
      }
      return { index: 9, name: "", status, code, detail, precursors: report };
    };

    if (!isObj(evidence) || !Array.isArray(evidence.proofs)) return out("fail", "PRECURSOR_INVALID/STATEMENT_MALFORMED", "the precursor evidence is not { statement, proofs[] }");
    if (signed && precursorDigestOf(evidence.statement) !== ctx.core.precursorDigest) {
      return out("fail", "PRECURSOR_INVALID/DIGEST_MISMATCH", "the precursor statement differs from the one the verification body signed");
    }
    const problem = statementProblem(evidence.statement);
    if (problem) return out("fail", "PRECURSOR_INVALID/STATEMENT_MALFORMED", problem);
    const st = evidence.statement as unknown as PrecursorStatement;
    report.attributedDirect = st.attributedDirect;
    const proofs = evidence.proofs as unknown[];
    if (proofs.length !== st.lines.length) return out("fail", "PRECURSOR_INVALID/STATEMENT_MALFORMED", "the evidence must carry one proof slot per statement line");

    const goodKg = (() => {
      try {
        return tonnesToKg(d.verifiedTonnes ?? "");
      } catch {
        return undefined;
      }
    })();
    const goodCn = d.cnCode ?? "";
    const goodPeriod = d.reportingPeriod ?? "";
    const goodLei = d.supplierLEI ?? "";

    for (const [i, line] of st.lines.entries()) {
      const r: PrecursorLineResult = {
        index: i,
        cnCode: line.cnCode,
        massPerTonne: line.massPerTonne,
        source: line.source,
        status: "pass",
        code: "",
        detail: "",
        see: null,
        contribution: null,
        ...(line.credSAID ? { credSAID: line.credSAID } : {}),
        ...(line.batchId ? { batchId: line.batchId } : {}),
        ...(line.defaultBasis ? { defaultBasis: line.defaultBasis } : {}),
      };
      report.lines.push(r);
      const set = (status: CheckStatus, code: string, detail: string) => {
        if (rank({ status, code }) > rank(r)) Object.assign(r, { status, code, detail });
      };
      const rel = relevantPrecursor(goodCn, line.cnCode);
      if (rel === false) set("fail", "PRECURSOR_INVALID/SCOPE", `CN ${line.cnCode} is not a relevant precursor of CN ${goodCn}`);

      if (line.source === "default") {
        r.see = line.defaultSEE!;
        set("warn", "PRECURSOR_WARNING/DEFAULT_USED", `precursor default used for CN ${line.cnCode} (${line.defaultSEE} tCO2e/t${line.defaultBasis ? `, ${line.defaultBasis}` : ""}; the value is the verification body's, not checked against the Default Values Act here)`);
      } else {
        const proof = proofs[i];
        if (!isObj(proof)) {
          set("skipped", "", `the producer's proof for precursor line ${i + 1} (credential ${line.credSAID}) was not presented`);
        } else {
          const p = proof as unknown as Presentation;
          let coreD: unknown;
          try {
            coreD = JSON.parse(p.core)?.d;
          } catch {}
          if (coreD !== line.credSAID) set("fail", "PRECURSOR_INVALID/NOT_BOUND", "the producer's proof is for another credential than the statement names");
          else if (p.shipment?.batchId !== line.batchId) set("fail", "PRECURSOR_INVALID/NOT_BOUND", "the producer's proof does not carry the batch the statement names");
          else {
            const v = await verifyPresentation(p, ctx.reader, {
              // Check 5 of the producer's proof: the batch was claimed for this good's maker (its LEI, committed
              // with the proof's importer salt), so the claim counts against the producer's verified tonnes.
              importerEORI: goodLei,
              checkers: opts.checkers(),
              // The reader is pinned to the block the good's verification already checked for freshness.
              maxHeadAgeSec: Infinity,
              ...(ctx.options?.contestedWindowHours !== undefined ? { contestedWindowHours: ctx.options.contestedWindowHours } : {}),
              ...(ctx.options?.minAddressTenureDays !== undefined ? { minAddressTenureDays: ctx.options.minAddressTenureDays } : {}),
            });
            r.verification = { overall: v.overall, primaryCode: v.primaryCode, checks: v.checks, ...(v.precursors ? { precursors: v.precursors } : {}) };
            const pd = v.disclosed;
            r.producer = {
              lei: pd.supplierLEI,
              installationId: pd.installationId,
              reportingPeriod: pd.reportingPeriod,
              cnCode: pd.cnCode,
              verifierLEI: pd.verifierLEI,
              verifiedTonnes: pd.verifiedTonnes,
            };
            const why = firstFailing(v.checks);
            if (v.overall === "INVALID") set("fail", "PRECURSOR_INVALID/CREDENTIAL", `the precursor credential does not verify (${why}); the good's value cannot rely on its data, and the precursor's default value would apply instead`);
            else if (v.overall === "CONTESTED") set("warn", "CONTESTED", `the precursor credential needs review (${why})`);
            else if (v.overall === "INCOMPLETE") set("skipped", "", `the precursor credential was not fully checked (${why || "evidence checkers missing"})`);
            if (pd.cnCode !== line.cnCode) set("fail", "PRECURSOR_INVALID/SCOPE", `the producer's credential is for CN ${pd.cnCode ?? "(not disclosed)"}, the statement says CN ${line.cnCode}`);
            if (!periodFits(pd.reportingPeriod ?? "", goodPeriod)) {
              set("fail", "PRECURSOR_INVALID/SCOPE", `the producer's period ${pd.reportingPeriod ?? "(not disclosed)"} starts after the good's period ${goodPeriod} ends`);
            }
            const c5 = v.checks.find((c) => c.index === 5);
            if (c5?.status === "pass") {
              const claimedKg = tonnesToKg(p.shipment!.quantityTonnes);
              r.claimedTonnes = kgToTonnes(claimedKg);
              if (goodKg !== undefined) {
                const needKg = (dec6(line.massPerTonne) * goodKg + SCALE - 1n) / SCALE;
                r.neededTonnes = kgToTonnes(needKg);
                if (claimedKg < needKg) {
                  set("fail", "PRECURSOR_INVALID/MASS_NOT_COVERED", `${r.claimedTonnes} t of CN ${line.cnCode} claimed for this maker, but ${line.massPerTonne} t/t × ${d.verifiedTonnes} t of goods needs ${r.neededTonnes} t`);
                }
              }
            }
            if (pd[SEE] === undefined) set("skipped", "", "the producer did not disclose its specific embedded emissions, so the SEE cannot be recomputed");
            else r.see = pd[SEE];
          }
        }
      }
      if (r.see !== null) r.contribution = fmt12(dec6(line.massPerTonne) * dec6(r.see));
      if (r.status === "pass") r.detail = `${line.massPerTonne} t/t × ${r.see} tCO2e/t = ${r.contribution} tCO2e per t of good`;
    }

    // (c) mass balance: SEE_g = ae_g + Σ m_i · SEE_i, compared with the declared, signed value.
    let balance: { status: CheckStatus; code: string; detail: string } = { status: "pass", code: "", detail: "" };
    if (report.lines.every((l) => l.see !== null) && report.declared !== null) {
      const total = report.lines.reduce((s, l) => s + dec6(l.massPerTonne) * dec6(l.see!), 0n);
      const recomputed = dec6(st.attributedDirect) * SCALE + total;
      let declared: bigint;
      try {
        declared = dec6(report.declared) * SCALE;
      } catch {
        declared = -1n;
      }
      report.precursorTotal = fmt12(total);
      report.recomputed = fmt12(recomputed);
      const tol = dec6(PRECURSOR_TOLERANCE) * SCALE;
      if (declared < 0n) balance = { status: "skipped", code: "", detail: `the declared SEE ${report.declared} cannot be read` };
      else {
        report.difference = fmt12(declared - recomputed);
        const eq = `${st.attributedDirect} + ${report.precursorTotal} = ${report.recomputed} tCO2e/t recomputed, ${report.declared} declared`;
        if (declared + tol < recomputed) balance = { status: "fail", code: "PRECURSOR_INVALID/SEE_UNDERSTATED", detail: `declared SEE is below direct + precursor emissions by more than ${PRECURSOR_TOLERANCE} tCO2e/t (${eq})` };
        else if (declared > recomputed + tol) balance = { status: "warn", code: "PRECURSOR_WARNING/SEE_OVERSTATED", detail: `declared SEE is above direct + precursor emissions by more than ${PRECURSOR_TOLERANCE} tCO2e/t (${eq}); conservative, but not what the statement gives` };
        else balance = { status: "pass", code: "", detail: `${eq}, within ${PRECURSOR_TOLERANCE}` };
      }
    } else if (report.declared === null) {
      balance = { status: "skipped", code: "", detail: "the supplier did not disclose the good's specific embedded emissions, so the SEE cannot be recomputed" };
    } else {
      balance = { status: "skipped", code: "", detail: "a precursor's SEE is missing, so the SEE was not recomputed" };
    }

    const worst = [...report.lines.map((l) => ({ status: l.status, code: l.code, detail: `precursor line ${l.index + 1} (CN ${l.cnCode}): ${l.detail}` })), balance].reduce((a, b) => (rank(b) > rank(a) ? b : a));
    if (worst.status === "pass") {
      const v = report.lines.filter((l) => l.source === "verified").length;
      return out("pass", "", `${balance.detail}; ${v} verified precursor credential${v === 1 ? "" : "s"}, each claimed for this maker on the shared ledger`);
    }
    // Advisory findings are listed together, so a default line does not hide an overstated value (or the reverse).
    if (rank(worst) === 1) {
      const all = [...report.lines.filter((l) => rank(l) === 1).map((l) => l.detail), ...(rank(balance) === 1 ? [balance.detail] : [])];
      return out("warn", worst.code, `${all.join("; ")}${balance.status === "pass" ? `; ${balance.detail}` : ""}`);
    }
    return out(worst.status, worst.code, worst.detail);
  };
}

// ------------------------------------------------------------------ offline re-check (the hosted page)

export interface OfflineItem {
  id: string;
  ok: boolean | null;
  detail: string;
}

/**
 * What a browser can re-check of a precursor tier from exported evidence alone, without the chain: the statement's
 * digest against the good's core, and per verified line the producer's KEL anchor and vLEI chain (pinned to
 * `trustAnchor`, without the on-chain allowlist records), the CN code and period rules, and the mass balance from
 * the disclosed values. Registration, authorisation at the registering block, revocation and the claim are on-chain
 * facts this function does not see (ok: null for those).
 */
export async function checkPrecursorsOffline(
  goodCore: { precursorDigest?: string },
  disclosed: Record<string, string>,
  evidence: PrecursorEvidence,
  opts: { trustAnchor: string; deployment: { registry: Hex; chainId: number }; kelSeq?: bigint },
): Promise<OfflineItem[]> {
  const items: OfflineItem[] = [];
  const digestOk = typeof goodCore.precursorDigest === "string" && precursorDigestOf(evidence.statement) === goodCore.precursorDigest;
  items.push({ id: "digest", ok: digestOk, detail: digestOk ? "the statement's digest matches the one in the signed credential core" : "the statement's digest does not match the signed credential core" });
  const problem = statementProblem(evidence.statement);
  if (problem) {
    items.push({ id: "statement", ok: false, detail: problem });
    return items;
  }
  const st = evidence.statement;
  let total = 0n;
  let complete = true;
  for (const [i, line] of st.lines.entries()) {
    if (line.source === "default") {
      total += dec6(line.massPerTonne) * dec6(line.defaultSEE!);
      items.push({ id: `line${i}:default`, ok: null, detail: `precursor default used for CN ${line.cnCode}: ${line.defaultSEE} tCO2e/t` });
      continue;
    }
    const p = evidence.proofs[i];
    if (!p) {
      complete = false;
      items.push({ id: `line${i}:proof`, ok: false, detail: "producer's proof not presented" });
      continue;
    }
    const off = await verifyOffline(p, opts.deployment);
    const local = off.checks.filter((c) => c.index <= 3);
    const localOk = local.length === 4 && local.every((c) => c.status === "pass");
    items.push({
      id: `line${i}:checks0-3`,
      ok: localOk,
      detail: localOk
        ? "producer's proof: structure, SAID, disclosures and its verification body's signature (checks 0–3)"
        : `producer's proof fails ${local.filter((c) => c.status !== "pass").map((c) => `check ${c.index} ${c.code}`).join(", ")}`,
    });
    const pd = off.disclosed;
    let core: { d: string; issuer: { auditorAID: string; verifierLEI: string } } | undefined;
    try {
      core = JSON.parse(p.core);
    } catch {}
    items.push({ id: `line${i}:bound`, ok: core?.d === line.credSAID && p.shipment?.batchId === line.batchId, detail: `the producer's proof is for credential ${line.credSAID} and batch ${line.batchId}` });
    if (core?.issuer) {
      const anchor = verifyAnchor(p.anchorEvidence as AnchorEvidence, { credSAID: core.d, auditorAID: core.issuer.auditorAID, kelSeq: opts.kelSeq ?? 1n });
      items.push({ id: `line${i}:anchor`, ok: anchor.ok, detail: anchor.ok ? "the producer's lead auditor anchored the credential in their KEL (signature checked)" : anchor.detail });
      const auth = verifyAuthority(p.authorityEvidence as AuthorityEvidence, { trustAnchor: opts.trustAnchor, auditorAID: core.issuer.auditorAID, verifierLEI: core.issuer.verifierLEI, cnCode: pd.cnCode ?? "" });
      items.push({ id: `line${i}:authority`, ok: auth.ok, detail: auth.ok ? `vLEI chain of the producer's verification body (LEI ${core.issuer.verifierLEI}) to the pinned root, accredited for CN ${pd.cnCode}` : auth.detail });
    }
    const scopeOk = pd.cnCode === line.cnCode && relevantPrecursor(disclosed.cnCode ?? "", line.cnCode) !== false && periodFits(pd.reportingPeriod ?? "", disclosed.reportingPeriod ?? "");
    items.push({ id: `line${i}:scope`, ok: scopeOk, detail: `CN ${pd.cnCode} (statement: ${line.cnCode}), period ${pd.reportingPeriod} (good: ${disclosed.reportingPeriod})` });
    items.push({ id: `line${i}:onchain`, ok: null, detail: "registration, authorisation at the registering block, revocation and the claim for this maker: on-chain facts, not re-read here" });
    if (pd[SEE] === undefined) complete = false;
    else total += dec6(line.massPerTonne) * dec6(pd[SEE]);
  }
  if (complete && disclosed[SEE] !== undefined) {
    const recomputed = dec6(st.attributedDirect) * SCALE + total;
    const declared = dec6(disclosed[SEE]) * SCALE;
    const tol = dec6(PRECURSOR_TOLERANCE) * SCALE;
    const ok = declared + tol >= recomputed;
    items.push({ id: "balance", ok, detail: `${st.attributedDirect} + ${fmt12(total)} = ${fmt12(recomputed)} tCO2e/t recomputed, ${disclosed[SEE]} declared (tolerance ${PRECURSOR_TOLERANCE})` });
  } else items.push({ id: "balance", ok: null, detail: "a value needed for the recomputation is missing" });
  return items;
}
