// `carbonlei recheck`: re-verify values the importer accepted earlier and say what changed since.
// A value accepted today can later stop being usable: the verification body revokes or supersedes the report, the
// auditor is revoked or the body suspended inside the 24 h CONTESTED window, the claim is no longer on the ledger.
// The importer needs to know before it files its CBAM declaration and when it keeps its records. This file reads
// previously accepted records (the Buyer tab's "Download verification record (JSON)", and `verify-batch` results),
// re-runs the same verification (`verdictFor`, sdk/verdict.ts, unchanged) at ONE pinned head block for the whole
// run, compares each result with the accepted verdict, and classifies the change:
//   action  — the line can no longer rest on the verified value: declare it on the default value (or re-request a
//             proof from the supplier) until a new proof verifies VALID;
//   info    — nothing to change in the declaration (the CONTESTED window closed with no event, or a line improved);
//   none    — unchanged;
//   error   — the re-check could not run (RPC failure, unreadable record): the old answer is NOT confirmed.
// It never changes a verdict and sends nothing on-chain. Schema: docs/schemas/recheck.schema.json.
import type { BatchDocument, BatchResult } from "./batch.ts";
import type { ChainReader } from "./chain.ts";
import { reportKeyOf } from "./commitment.ts";
import { sha256Hex } from "./encoding.ts";
import { pinnedToHead, runLimited } from "./pinned.ts";
import type { Presentation } from "./disclosure.ts";
import { EXIT, TOOL, verdictFor, type Verdict, type VerdictOptions } from "./verdict.ts";

/** Format of `RecheckDocument`; a change that breaks a consumer increases it. */
export const RECHECK_FORMAT = 1;
/** Hours after registration during which an auditor revocation, suspension or rotation makes a report CONTESTED. */
export const DEFAULT_WINDOW_HOURS = 24;
/** At most this many records per run (each costs a full verification against the RPC nodes). */
export const MAX_RECORDS = 500;

export type Severity = "action" | "info" | "none" | "error";

/**
 * What changed since acceptance. The first group needs action, the second is information, then unchanged and error.
 */
export type Change =
  | "REPORT_REVOKED"
  | "REPORT_SUPERSEDED"
  | "REPORT_EXPIRED"
  | "REPORT_NOT_ON_LEDGER"
  | "CLAIM_NOT_ON_LEDGER"
  | "SHIPMENT_CHANGED"
  | "AUDITOR_REVOKED_OR_BODY_SUSPENDED"
  | "ADDRESS_ROTATED"
  | "REVOCATION_CONTESTED"
  | "CONTESTED"
  | "AUTHORITY_INVALID"
  | "ANCHOR_INVALID"
  | "NOW_INVALID"
  | "NOW_INCOMPLETE"
  | "BECAME_FINAL"
  | "WINDOW_OPEN"
  | "IMPROVED"
  | "EXPIRED_SINCE"
  | "UNCHANGED"
  | "STILL_NOT_VALID"
  | "RECHECK_FAILED";

const SEVERITY: Record<Change, Severity> = {
  REPORT_REVOKED: "action",
  REPORT_SUPERSEDED: "action",
  REPORT_EXPIRED: "action",
  REPORT_NOT_ON_LEDGER: "action",
  CLAIM_NOT_ON_LEDGER: "action",
  SHIPMENT_CHANGED: "action",
  AUDITOR_REVOKED_OR_BODY_SUSPENDED: "action",
  ADDRESS_ROTATED: "action",
  REVOCATION_CONTESTED: "action",
  CONTESTED: "action",
  AUTHORITY_INVALID: "action",
  ANCHOR_INVALID: "action",
  NOW_INVALID: "action",
  NOW_INCOMPLETE: "action",
  BECAME_FINAL: "info",
  WINDOW_OPEN: "info",
  IMPROVED: "info",
  EXPIRED_SINCE: "info",
  UNCHANGED: "none",
  STILL_NOT_VALID: "none",
  RECHECK_FAILED: "error",
};

const USE_DEFAULT = "Declare this line on the default value (with the year's mark-up) until the supplier sends a new proof that verifies VALID";
/** What the importer should do, by change. */
export const ACTION: Record<Change, string> = {
  REPORT_REVOKED: `${USE_DEFAULT}; ask the supplier why the verification body revoked the report.`,
  REPORT_SUPERSEDED: "Ask the supplier for a proof of the superseding credential and verify it; until it verifies VALID, declare this line on the default value.",
  REPORT_EXPIRED: `${USE_DEFAULT}; re-check with your EORI so the report is judged at the shipment's claim time.`,
  REPORT_NOT_ON_LEDGER: `${USE_DEFAULT}; the report is not on the registry this RPC node reads (check the network and the node).`,
  CLAIM_NOT_ON_LEDGER: `${USE_DEFAULT}; ask the supplier to claim the shipment for you on the ledger.`,
  SHIPMENT_CHANGED: `${USE_DEFAULT}; the claim on the ledger no longer matches this shipment.`,
  AUDITOR_REVOKED_OR_BODY_SUSPENDED: `A person must review this line (docs/OPERATE.md › CONTESTED): the auditor was revoked or the body suspended within the window after registration. ${USE_DEFAULT}.`,
  ADDRESS_ROTATED: `A person must review this line (docs/OPERATE.md › CONTESTED): the registering address was rotated soon after registration. ${USE_DEFAULT}.`,
  REVOCATION_CONTESTED: `A person must review this line (docs/OPERATE.md › CONTESTED): the report was revoked from an address that may have been stolen. ${USE_DEFAULT}.`,
  CONTESTED: `A person must review this line (docs/OPERATE.md › CONTESTED). ${USE_DEFAULT}.`,
  AUTHORITY_INVALID: `${USE_DEFAULT}; the vLEI authority chain no longer verifies.`,
  ANCHOR_INVALID: `${USE_DEFAULT}; the auditor's KEL anchor no longer verifies.`,
  NOW_INVALID: `${USE_DEFAULT}.`,
  NOW_INCOMPLETE: `${USE_DEFAULT}; some checks could not run (missing evidence or history), so the value is not confirmed.`,
  BECAME_FINAL:
    "Nothing to change: the CONTESTED window after registration has closed with no auditor revocation, suspension or address rotation. The report can still be revoked or superseded later: keep re-checking until you file.",
  WINDOW_OPEN: "Nothing to change yet: the CONTESTED window after registration is still open; re-check after it closes.",
  IMPROVED: "The line now verifies VALID: review it before you use the verified value.",
  EXPIRED_SINCE: "Only the report's status was read: it is past its validity now, which does not matter for a shipment claimed before; attach the proof for a full re-check.",
  UNCHANGED: "Nothing to change.",
  STILL_NOT_VALID: "Nothing to change: the line was not on the verified value and still is not.",
  RECHECK_FAILED: "The re-check could not run, so the accepted value is NOT confirmed; fix the cause and run it again before you file.",
};

/** A previously accepted verification, normalised from either input format. */
export interface AcceptedRecord {
  /** File (and line) the record came from. */
  source: string;
  /** The importer's line or batch id. */
  id: string;
  batchId: string | null;
  credSAID: string | null;
  /** EORI to bind check 5 with; never copied to the output. */
  eori: string | null;
  /** When the importer accepted it (ISO 8601), if the record says. */
  acceptedAt: string | null;
  accepted: { overall: string; primaryCode: string; block: number | null };
  chainId: number | null;
  /** Registry address the record names (Buyer records), to refuse a record from another deployment. */
  registry: string | null;
  /** The proof, when the record carries it or names a file that exists; else the re-check reads the ledger only. */
  proof: Presentation | null;
  proofText: string | null;
  /** File the proof came from (evidence bundles are read next to it). */
  proofPath: string | null;
  /**
   * SHA-256 (hex) of the proof bytes the accepted verdict was computed from (`verify-batch` results record it). When
   * set, the re-check verifies the proof only if `proofText` hashes to it; otherwise the record is RECHECK_FAILED.
   */
  expectedSha256?: string | null;
  /** Why the record could not be read, when it could not. */
  loadError?: string;
}

export interface RecheckResult {
  source: string;
  id: string;
  batchId: string | null;
  credSAID: string | null;
  /** full: the proof was verified again (all its checks: 0-8, plus 9 and 10 when it carries a precursor or carbon-price statement); ledger-only: only the report's status was read (no proof). */
  mode: "full" | "ledger-only";
  accepted: { overall: string; primaryCode: string; at: string | null; block: number | null };
  current: { overall: string; primaryCode: string; block: number | null } | null;
  change: Change;
  severity: Severity;
  /** Every reason found, most important first. */
  reasons: string[];
  action: string;
  /** End of the CONTESTED window after registration (UNIX seconds), when known; and whether it has closed. */
  window: { closesAt: number; closed: boolean } | null;
  /** The full current verdict (mode "full"); null in ledger-only mode or on error. */
  verdict: Verdict | null;
  error: string | null;
  /**
   * SHA-256 (hex) of the proof bytes this re-check verified (mode "full"), else null. `applyRecheck` lets a re-check
   * improve a verify-batch line only when this equals the line's `proofSha256`.
   */
  proofSha256?: string | null;
}

export interface RecheckDocument {
  format: typeof RECHECK_FORMAT;
  kind: "carbonlei-recheck";
  pinnedBlock: number | null;
  blockTime: number | null;
  chainId: number | null;
  checkedAt: string;
  windowHours: number;
  counts: Record<Severity, number>;
  results: RecheckResult[];
  notes: string[];
  tool: { name: string; version: string };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading records

const isProof = (x: unknown): x is Presentation =>
  !!x && typeof x === "object" && typeof (x as { core?: unknown }).core === "string" && "signature" in (x as object);

const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function credSAIDOf(proof: Presentation | null): string | null {
  if (!proof) return null;
  try {
    return str(JSON.parse(proof.core)?.d);
  } catch {
    return null;
  }
}

/** Is this object a Buyer-tab verification record? */
export const isBuyerRecord = (x: unknown): boolean =>
  !!x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string" && /^CarbonLEI verification record/.test((x as { kind: string }).kind);

/**
 * A Buyer-tab verification record → AcceptedRecord. The record carries the proof (`proof`, added with this
 * feature); an older record without it is re-checked against the ledger only, by its credential ID.
 */
export function fromBuyerRecord(rec: Record<string, unknown>, source: string, proofPath: string | null = null): AcceptedRecord {
  const net = (rec.network ?? {}) as Record<string, unknown>;
  const checks = Array.isArray(rec.checks) ? (rec.checks as { status?: string; code?: string }[]) : [];
  const proof = isProof(rec.proof) ? (rec.proof as Presentation) : null;
  const batchId = str(rec.batchId) ?? proof?.shipment?.batchId ?? null;
  return {
    source,
    id: batchId ?? str(rec.credSAID) ?? source,
    batchId,
    credSAID: str(rec.credSAID) ?? credSAIDOf(proof),
    eori: str(rec.importerEORI),
    acceptedAt: str(rec.createdAt),
    accepted: { overall: str(rec.overall) ?? "UNKNOWN", primaryCode: checks.find((c) => c.status === "fail")?.code ?? "", block: num((rec as { block?: unknown }).block) },
    chainId: num(net.chainId),
    registry: str(net.registry),
    proof,
    proofText: proof ? JSON.stringify(proof) : null,
    proofPath,
  };
}

/** `{ proof, verdict, eori?, acceptedAt?, id? }`: the verdict `carbonlei verify --json` (or POST /v1/verify) returned, kept with its proof. */
export const isAcceptedVerdict = (x: unknown): boolean => {
  const v = (x as { verdict?: { overall?: unknown; format?: unknown } })?.verdict;
  return !!v && typeof v === "object" && typeof v.overall === "string" && typeof v.format === "number";
};

export function fromAcceptedVerdict(rec: Record<string, unknown>, source: string): AcceptedRecord {
  const v = rec.verdict as Verdict;
  const proof = isProof(rec.proof) ? (rec.proof as Presentation) : null;
  const batchId = proof?.shipment?.batchId ?? null;
  return {
    source,
    id: str(rec.id) ?? batchId ?? v.credSAID ?? source,
    batchId,
    credSAID: v.credSAID ?? credSAIDOf(proof),
    eori: str(rec.eori),
    acceptedAt: str(rec.acceptedAt),
    accepted: { overall: v.overall, primaryCode: v.primaryCode ?? "", block: v.chain?.block ?? null },
    chainId: v.chain?.chainId ?? null,
    registry: null,
    proof,
    proofText: proof ? JSON.stringify(proof) : null,
    proofPath: null,
  };
}

/**
 * Looks a proof file up by the name a results file gives it. With `sha256`, a file whose bytes hash to it should be
 * preferred over another file of the same name (sdk/recheck-files.ts searches several folders).
 */
export type FindProof = (proof: string, sha256: string | null) => { path: string; text: string } | null;

/** The lines of a `verify-batch` results file that had a verdict → AcceptedRecords (lines without a proof are skipped). */
export function fromBatchDocument(doc: BatchDocument, source: string, findProof: FindProof = () => null): { records: AcceptedRecord[]; skipped: string[] } {
  const records: AcceptedRecord[] = [];
  const skipped: string[] = [];
  doc.results.forEach((r: BatchResult, i) => {
    const where = `${source}#${i + 1}`;
    const id = r.line?.id ?? r.proofShipment?.batchId ?? r.proof ?? `line-${i + 1}`;
    if (!r.verdict) {
      skipped.push(`${where} (${id}): ${r.error ? "its verification did not run" : "no supplier proof"}, so nothing was accepted`);
      return;
    }
    let proof: Presentation | null = null;
    let proofText: string | null = null;
    let proofPath: string | null = null;
    const expectedSha256 = typeof r.proofSha256 === "string" && /^[0-9a-f]{64}$/.test(r.proofSha256) ? r.proofSha256 : null;
    const inline = (r as BatchResult & { proofObject?: unknown }).proofObject;
    if (isProof(inline)) {
      proof = inline;
      proofText = JSON.stringify(inline);
    } else if (r.proof) {
      const found = findProof(r.proof, expectedSha256);
      if (found) {
        try {
          const p = JSON.parse(found.text);
          if (isProof(p)) {
            proof = p;
            proofText = found.text;
            proofPath = found.path;
          }
        } catch {}
      }
    }
    records.push({
      source: where,
      id,
      batchId: r.proofShipment?.batchId ?? null,
      credSAID: r.verdict.credSAID,
      eori: doc.eori,
      acceptedAt: doc.verifiedAt ?? null,
      accepted: { overall: r.verdict.overall, primaryCode: r.verdict.primaryCode, block: r.verdict.chain?.block ?? doc.pinnedBlock ?? null },
      chainId: doc.chainId ?? r.verdict.chain?.chainId ?? null,
      registry: null,
      proof,
      proofText,
      proofPath,
      expectedSha256,
    });
  });
  return { records, skipped };
}

/**
 * Records from parsed JSON (one file's content): a Buyer record, an array of them, or a `verify-batch` results
 * file. Anything else is reported as skipped.
 */
export function recordsFromJson(x: unknown, source: string, findProof?: FindProof): { records: AcceptedRecord[]; skipped: string[] } {
  if (Array.isArray(x)) {
    const out = { records: [] as AcceptedRecord[], skipped: [] as string[] };
    x.forEach((item, i) => {
      const r = recordsFromJson(item, `${source}[${i}]`, findProof);
      out.records.push(...r.records);
      out.skipped.push(...r.skipped);
    });
    return out;
  }
  if (isBuyerRecord(x)) return { records: [fromBuyerRecord(x as Record<string, unknown>, source)], skipped: [] };
  if (isAcceptedVerdict(x)) return { records: [fromAcceptedVerdict(x as Record<string, unknown>, source)], skipped: [] };
  if ((x as { kind?: unknown })?.kind === "carbonlei-batch" && Array.isArray((x as BatchDocument).results)) {
    return fromBatchDocument(x as BatchDocument, source, findProof);
  }
  return { records: [], skipped: [`${source}: not a verification record or a verify-batch results file`] };
}

// ---------------------------------------------------------------------------------------------------------------
// Classifying

/** The causes a current verdict shows, most important first (a verdict can show several). */
export function causesOf(v: Verdict): Change[] {
  const out: Change[] = [];
  const c4 = v.checks.find((c) => c.id === 4);
  const c5 = v.checks.find((c) => c.id === 5);
  const contested = (c: typeof c4) => c?.code === "CONTESTED";
  for (const c of [c4, c5]) {
    if (!contested(c)) continue;
    const d = c!.detail;
    // A revocation from a possibly stolen address names the revoking address's rotations: test it first.
    if (/revoked this report|revoked after the claim/.test(d)) out.push("REVOCATION_CONTESTED");
    else {
      if (/revoked or suspended within/.test(d)) out.push("AUDITOR_REVOKED_OR_BODY_SUSPENDED");
      if (/registering address was rotated/.test(d)) out.push("ADDRESS_ROTATED");
      if (!out.length) out.push("CONTESTED");
    }
  }
  if (c4?.status === "fail") {
    if (c4.code === "REPORT_INVALID/REVOKED") out.push("REPORT_REVOKED");
    else if (c4.code === "REPORT_INVALID/SUPERSEDED") out.push("REPORT_SUPERSEDED");
    else if (c4.code === "REPORT_INVALID/EXPIRED") out.push("REPORT_EXPIRED");
    else if (c4.code === "REPORT_INVALID/NOT_REGISTERED") out.push("REPORT_NOT_ON_LEDGER");
  }
  if (c5?.status === "fail" && c5.code === "SHIPMENT_MISMATCH") {
    if (/revoked after the claim/.test(c5.detail)) out.push("REPORT_REVOKED");
    else if (/no claim for this batch/.test(c5.detail)) out.push("CLAIM_NOT_ON_LEDGER");
    else out.push("SHIPMENT_CHANGED");
  }
  if (v.checks.find((c) => c.id === 7)?.status === "fail") out.push("AUTHORITY_INVALID");
  if (v.checks.find((c) => c.id === 6)?.status === "fail") out.push("ANCHOR_INVALID");
  if (v.overall === "INVALID" && !out.length) out.push("NOW_INVALID");
  if (v.overall === "INCOMPLETE" && !out.length) out.push("NOW_INCOMPLETE");
  if (v.overall === "CONTESTED" && !out.length) out.push("CONTESTED");
  return [...new Set(out)];
}

const reasonOf = (v: Verdict, change: Change): string => {
  const c4 = v.checks.find((c) => c.id === 4);
  const c5 = v.checks.find((c) => c.id === 5);
  const pick =
    change === "AUTHORITY_INVALID"
      ? v.checks.find((c) => c.id === 7)
      : change === "ANCHOR_INVALID"
        ? v.checks.find((c) => c.id === 6)
        : change === "CLAIM_NOT_ON_LEDGER" || change === "SHIPMENT_CHANGED"
          ? c5
          : c4?.status !== "pass" || c4.code
            ? c4
            : c5;
  const base = `${change}: now ${v.overall}${v.primaryCode ? ` (${v.primaryCode})` : ""}`;
  return pick?.detail ? `${base} — check ${pick.id}: ${pick.detail}` : base;
};

export interface ClassifyContext {
  /** Head block time of the re-check (UNIX seconds). */
  headTime: number;
  /** When the report was registered (UNIX seconds), when known. */
  registeredAt?: number;
  windowHours?: number;
}

/**
 * Compares an accepted verdict with the current one. Pure: `current` is a verdict computed at the pinned head.
 */
export function classify(
  accepted: AcceptedRecord["accepted"] & { at?: string | null },
  current: Verdict,
  ctx: ClassifyContext,
): Pick<RecheckResult, "change" | "severity" | "reasons" | "action" | "window"> {
  const windowSec = Math.round((ctx.windowHours ?? DEFAULT_WINDOW_HOURS) * 3600);
  const window =
    ctx.registeredAt !== undefined && ctx.registeredAt > 0
      ? { closesAt: ctx.registeredAt + windowSec, closed: ctx.headTime >= ctx.registeredAt + windowSec }
      : null;
  const wasValid = accepted.overall === "VALID";
  let change: Change;
  let reasons: string[];
  if (current.overall === "VALID") {
    if (!wasValid) {
      change = "IMPROVED";
      reasons = [`accepted as ${accepted.overall}${accepted.primaryCode ? ` (${accepted.primaryCode})` : ""}, now VALID`];
    } else if (window && !window.closed) {
      change = "WINDOW_OPEN";
      reasons = [`still VALID; the ${ctx.windowHours ?? DEFAULT_WINDOW_HOURS} h CONTESTED window closes at ${new Date(window.closesAt * 1000).toISOString()}`];
    } else {
      const acceptedSec = accepted.at ? Date.parse(accepted.at) / 1000 : NaN;
      const acceptedInWindow = window !== null && Number.isFinite(acceptedSec) && acceptedSec < window.closesAt;
      change = acceptedInWindow ? "BECAME_FINAL" : "UNCHANGED";
      reasons = [
        acceptedInWindow
          ? `still VALID; accepted while the CONTESTED window was open, which closed at ${new Date(window!.closesAt * 1000).toISOString()} with no event`
          : "still VALID",
      ];
    }
  } else {
    const causes = causesOf(current);
    if (!wasValid && current.overall === accepted.overall && current.primaryCode === accepted.primaryCode) {
      change = "STILL_NOT_VALID";
      reasons = [`still ${current.overall}${current.primaryCode ? ` (${current.primaryCode})` : ""}`];
    } else if (!wasValid) {
      // Not on the verified value before and not now: nothing to change in the declaration, only the reason moved.
      change = "STILL_NOT_VALID";
      reasons = [`accepted as ${accepted.overall}${accepted.primaryCode ? ` (${accepted.primaryCode})` : ""}; now ${current.overall}${current.primaryCode ? ` (${current.primaryCode})` : ""}`];
    } else {
      change = causes[0] ?? "NOW_INVALID";
      reasons = causes.map((c) => reasonOf(current, c));
    }
  }
  return { change, severity: SEVERITY[change], reasons, action: ACTION[change], window };
}

/** Ledger-only classification from the report's on-chain record (no proof to verify). */
export function classifyLedgerOnly(
  accepted: AcceptedRecord["accepted"] & { at?: string | null },
  report: { registeredAt: bigint; revokedAt: bigint; supersededBy: string; validUntil: bigint },
  ctx: ClassifyContext,
): Pick<RecheckResult, "change" | "severity" | "reasons" | "action" | "window" | "current"> & { current: { overall: string; primaryCode: string; block: null } } {
  const reasons: string[] = [];
  let change: Change;
  let overall = "NOT_REVERIFIED";
  let code = "";
  const windowSec = Math.round((ctx.windowHours ?? DEFAULT_WINDOW_HOURS) * 3600);
  const reg = Number(report.registeredAt);
  const window = reg > 0 ? { closesAt: reg + windowSec, closed: ctx.headTime >= reg + windowSec } : null;
  if (report.registeredAt === 0n) {
    change = "REPORT_NOT_ON_LEDGER";
    overall = "INVALID";
    code = "REPORT_INVALID/NOT_REGISTERED";
    reasons.push("REPORT_NOT_ON_LEDGER: no report with this credential ID on the registry (ledger only; no proof attached)");
  } else if (report.revokedAt !== 0n) {
    change = "REPORT_REVOKED";
    overall = "INVALID";
    code = "REPORT_INVALID/REVOKED";
    reasons.push(`REPORT_REVOKED: the report was revoked at ${new Date(Number(report.revokedAt) * 1000).toISOString()} (ledger only; attach the proof for the full checks)`);
  } else if (!/^0x0{64}$/i.test(report.supersededBy)) {
    // Without the proof the claim time is unknown, so a supersession after the claim cannot be told apart: fail closed.
    change = "REPORT_SUPERSEDED";
    overall = "INVALID";
    code = "REPORT_INVALID/SUPERSEDED";
    reasons.push("REPORT_SUPERSEDED: a newer credential replaced this report (ledger only: attach the proof to tell whether it was replaced before or after your claim)");
  } else if (BigInt(ctx.headTime) > report.validUntil) {
    change = "EXPIRED_SINCE";
    overall = "NOT_REVERIFIED";
    reasons.push(`EXPIRED_SINCE: past the report's validity (${new Date(Number(report.validUntil) * 1000).toISOString()}) at the head block; not revoked or superseded`);
  } else {
    change = accepted.overall === "VALID" ? "UNCHANGED" : "STILL_NOT_VALID";
    overall = "NOT_REVERIFIED";
    reasons.push("the report is registered, not revoked, not superseded and within its validity (ledger only: checks 0-3 and 5-8 were not re-run)");
  }
  if (accepted.overall !== "VALID" && SEVERITY[change] === "action") {
    reasons.unshift(`accepted as ${accepted.overall}: the line was not on the verified value`);
    change = "STILL_NOT_VALID";
  }
  return { change, severity: SEVERITY[change], reasons, action: ACTION[change], window, current: { overall, primaryCode: code, block: null } };
}

// ---------------------------------------------------------------------------------------------------------------
// Running

export interface RecheckOptions extends Pick<VerdictOptions, "checkers" | "trustAnchor" | "maxHeadAgeSec"> {
  /** Evidence bundle loader for a record's proof (default: none, so checks 6-7 fail on a referenced bundle). */
  loadBundleFor?: (r: AcceptedRecord) => ((path: string) => Promise<string> | string) | undefined;
  /** CONTESTED window in hours (default 24, the verifier's default). */
  windowHours?: number;
  /** Proofs verified at once (1-4, default 2). */
  concurrency?: number;
  /** Bounds each verification (for the CLI's overall RPC deadline). */
  within?: <T>(p: Promise<T>) => Promise<T>;
  now?: Date;
}

/**
 * Re-checks every record at one pinned head block and returns the change of each. A record that cannot be
 * re-checked (unreadable, from another chain or registry, RPC failure) is an `error` result, never "unchanged".
 */
export async function recheckRecords(records: AcceptedRecord[], reader: ChainReader, opts: RecheckOptions = {}): Promise<RecheckDocument> {
  if (records.length > MAX_RECORDS) throw new Error(`${records.length} records: at most ${MAX_RECORDS} per run`);
  const within = opts.within ?? (<T>(p: Promise<T>) => p);
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours) || windowHours < 0) throw new Error(`window must be a number of hours ≥ 0, got ${windowHours}`);
  const head = await within(reader.latestBlock());
  const pinned = pinnedToHead(reader, head);
  const at = reader.at(head.number);
  const chainId = await within(reader.client.getChainId());
  const registry = reader.registry.toLowerCase();
  const headTime = Number(head.timestamp);

  const results = await runLimited(records, opts.concurrency ?? 2, async (r): Promise<RecheckResult> => {
    const base = {
      source: r.source,
      id: r.id,
      batchId: r.batchId,
      credSAID: r.credSAID,
      accepted: { overall: r.accepted.overall, primaryCode: r.accepted.primaryCode, at: r.acceptedAt, block: r.accepted.block },
    };
    const fail = (mode: RecheckResult["mode"], error: string): RecheckResult => ({
      ...base,
      mode,
      current: null,
      change: "RECHECK_FAILED",
      severity: "error",
      reasons: [`RECHECK_FAILED: ${error}`],
      action: ACTION.RECHECK_FAILED,
      window: null,
      verdict: null,
      error,
      proofSha256: null,
    });
    const mode = r.proof ? "full" : "ledger-only";
    if (r.loadError) return fail(mode, r.loadError);
    // The bytes re-verified must be the bytes that were accepted: a file of the same name elsewhere (a tampered copy,
    // or the original next to a tampered one) would re-verify another proof and report it as this line.
    const digest = r.proof ? sha256Hex(r.proofText ?? JSON.stringify(r.proof)) : null;
    // (With no proof found at all, the record is re-checked on the ledger only, which never yields a verdict.)
    if (r.expectedSha256 && r.proof && digest !== r.expectedSha256) {
      return fail(mode, `the proof found${r.proofPath ? ` (${r.proofPath})` : ""} has sha256 ${digest}, not the ${r.expectedSha256} verify-batch recorded: it is another file, so it was not re-verified`);
    }
    if (r.proof && r.batchId && r.proof.shipment?.batchId !== undefined && r.proof.shipment.batchId !== r.batchId) {
      return fail(mode, `the record's batch ${r.batchId} differs from its proof's (${r.proof.shipment.batchId})`);
    }
    if (r.chainId !== null && r.chainId !== chainId) return fail(mode, `the record is from chain ${r.chainId}; the RPC node serves chain ${chainId}`);
    if (r.registry && r.registry.toLowerCase() !== registry) return fail(mode, `the record names registry ${r.registry}; this deployment's registry is ${reader.registry}`);
    const proofSAID = credSAIDOf(r.proof);
    if (r.proof && r.credSAID && proofSAID && proofSAID !== r.credSAID) return fail(mode, "the record's credential ID differs from its proof's");
    const said = r.credSAID ?? proofSAID;
    if (!said) return fail(mode, "the record has neither a proof nor a credential ID to re-check");
    try {
      const report = await within(at.report(reportKeyOf(said)));
      const ctx: ClassifyContext = { headTime, registeredAt: Number(report.registeredAt), windowHours };
      const acc = { ...r.accepted, at: r.acceptedAt };
      if (!r.proof) {
        const c = classifyLedgerOnly(acc, report, ctx);
        return { ...base, mode, verdict: null, error: null, ...c, proofSha256: null };
      }
      const loadBundle = opts.loadBundleFor?.(r);
      const v = await within(
        verdictFor(r.proof, pinned, {
          importerEORI: r.eori ?? undefined,
          ...(loadBundle ? { loadBundle } : {}),
          ...(opts.checkers ? { checkers: opts.checkers } : {}),
          ...(opts.trustAnchor ? { trustAnchor: opts.trustAnchor } : {}),
          ...(opts.maxHeadAgeSec !== undefined ? { maxHeadAgeSec: opts.maxHeadAgeSec } : {}),
          contestedWindowHours: windowHours,
          ...(r.proofText ? { proofText: r.proofText } : {}),
        }),
      );
      const c = classify(acc, v, ctx);
      return { ...base, mode, current: { overall: v.overall, primaryCode: v.primaryCode, block: v.chain.block }, verdict: v, error: null, ...c, proofSha256: digest };
    } catch (e) {
      return fail(mode, (e as Error).message);
    }
  });

  const counts: Record<Severity, number> = { action: 0, info: 0, none: 0, error: 0 };
  for (const x of results) counts[x.severity]++;
  const notes = [
    "Every record was re-checked at the one pinned block above (one snapshot of the chain).",
    `CONTESTED window: ${windowHours} h after registration (the verifier's default is 24 h).`,
    "A line with severity \"action\" must not rest on the verified value: the portfolio (carbonlei portfolio --recheck) plans it on the default.",
    "Not a CBAM declaration and not a CBAM Registry document. Keep this re-check result with the records of the accepted value.",
  ];
  if (results.some((x) => x.mode === "ledger-only")) {
    notes.push("Ledger-only lines had no proof attached: only the report's status (registered, revoked, superseded, validity) was read; checks 0-3 and 5-8 were not re-run.");
  }
  return {
    format: RECHECK_FORMAT,
    kind: "carbonlei-recheck",
    pinnedBlock: Number(head.number),
    blockTime: headTime,
    chainId,
    checkedAt: (opts.now ?? new Date()).toISOString(),
    windowHours,
    counts,
    results,
    notes,
    tool: { ...TOOL },
  };
}

/** Exit code: 3 if any record could not be re-checked, else 1 if any needs action, else 0. */
export function recheckExitCode(doc: Pick<RecheckDocument, "counts">): number {
  return doc.counts.error ? EXIT.ERROR : doc.counts.action ? EXIT.INVALID : EXIT.VALID;
}

/**
 * What a webhook receives: the changed lines only (severity action, info or error), with no EORI, no proof and no
 * disclosed values. Null when nothing changed.
 */
export function webhookPayload(doc: RecheckDocument): Record<string, unknown> | null {
  const changes = doc.results.filter((r) => r.severity !== "none");
  if (!changes.length) return null;
  return {
    kind: "carbonlei-recheck-changes",
    format: RECHECK_FORMAT,
    pinnedBlock: doc.pinnedBlock,
    chainId: doc.chainId,
    checkedAt: doc.checkedAt,
    counts: doc.counts,
    changes: changes.map((r) => ({
      id: r.id,
      credSAID: r.credSAID,
      change: r.change,
      severity: r.severity,
      accepted: r.accepted.overall,
      current: r.current?.overall ?? null,
      primaryCode: r.current?.primaryCode ?? "",
      action: r.action,
    })),
    tool: doc.tool,
  };
}

/**
 * POSTs the changes to `url` (best effort, 10 s). Returns a short status that never includes the URL, which may
 * carry a secret token (for example a chat webhook).
 */
export async function postWebhook(url: string, payload: unknown, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, detail: "the webhook URL is not a valid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, detail: `the webhook URL must be http(s), got ${u.protocol}` };
  try {
    const res = await fetchImpl(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).name === "TimeoutError" ? "timed out after 10 s" : "the request failed (network error)" };
  }
}

/**
 * Feeds a re-check into the portfolio: each `verify-batch` line whose re-check found a change takes the current
 * verdict, and a line that needs action is marked so `buildPortfolio` plans it on the default value with the
 * re-check as the reason. Lines are matched on the credential ID (and the batch id when both have one); a verdict
 * that is not worse is taken over only when the re-check verified the same proof bytes (equal `proofSha256`).
 */
export function applyRecheck(batch: BatchDocument, recheck: RecheckDocument): BatchDocument {
  if (recheck?.kind !== "carbonlei-recheck" || !Array.isArray(recheck.results)) throw new Error("not a carbonlei recheck results file");
  const results = batch.results.map((r, i) => {
    if (!r.verdict?.credSAID) return r;
    // A matching re-check may always make the line worse. It may replace the verdict otherwise (improve it, or
    // refresh it) only when it verified the very bytes this line was verified from: the two SHA-256 digests are
    // recorded and equal. Neither the credential ID nor the file name or line number proves that: a tampered copy of
    // a proof carries the original's credSAID and batch id, and a file of the same name can be another proof
    // (review of 17 October 2026, finding 2).
    const id = r.line?.id ?? r.proofShipment?.batchId ?? r.proof ?? `line-${i + 1}`;
    const exact = recheck.results.find((x) => x.source.endsWith(`#${i + 1}`) && x.id === id && x.credSAID === r.verdict!.credSAID);
    const loose = exact
      ? undefined
      : recheck.results.filter(
          (x) => x.credSAID === r.verdict!.credSAID && (!x.batchId || !r.proofShipment?.batchId || x.batchId === r.proofShipment.batchId),
        );
    const hit = exact ?? (loose && loose.length === 1 ? loose[0] : undefined);
    if (!hit) return r;
    const rank: Record<string, number> = { VALID: 0, CONTESTED: 1, INCOMPLETE: 2, INVALID: 3 };
    const worse = (v: Verdict | null) => !!v && (rank[v.overall] ?? 3) > (rank[r.verdict!.overall] ?? 3);
    const sameBytes = typeof hit.proofSha256 === "string" && typeof r.proofSha256 === "string" && hit.proofSha256 === r.proofSha256;
    const replace = hit.verdict && (sameBytes || worse(hit.verdict));
    const out: BatchResult = { ...r, ...(replace ? { verdict: hit.verdict! } : {}) };
    if (hit.severity === "action" || hit.severity === "error") {
      out.recheck = { change: hit.change, severity: hit.severity, checkedAt: recheck.checkedAt, pinnedBlock: recheck.pinnedBlock };
    }
    return out;
  });
  return { ...batch, results };
}

/** The re-check for the terminal. */
export function printRecheck(doc: RecheckDocument, skipped: string[] = []): string {
  const L = [`Re-check at pinned block ${doc.pinnedBlock ?? "—"} (chain ${doc.chainId ?? "—"}, block time ${doc.blockTime ? new Date(doc.blockTime * 1000).toISOString() : "—"})`, ""];
  // Severity "none" reads OK only when the line still rests on a verified value; a line that was not VALID and still
  // is not reads UNCHANGED (the workbench's NO CHANGE). The JSON keeps the severity values as they are.
  const mark: Record<Severity, string> = { action: "ACTION", info: "INFO", none: "OK", error: "ERROR" };
  for (const r of doc.results) {
    const now = r.current ? `${r.current.overall}${r.current.primaryCode ? ` [${r.current.primaryCode}]` : ""}` : "—";
    const label = r.change === "STILL_NOT_VALID" ? "UNCHANGED" : mark[r.severity];
    L.push(`${label.padEnd(9)} ${r.id}  ${r.change}  accepted ${r.accepted.overall} → now ${now}${r.mode === "ledger-only" ? "  (ledger only)" : ""}`);
    for (const why of r.reasons) L.push(`            ${why}`);
    if (r.severity !== "none") L.push(`            → ${r.action}`);
  }
  for (const s of skipped) L.push(`(skipped) ${s}`);
  const c = doc.counts;
  L.push("", `${doc.results.length} record(s): ${c.action} need action, ${c.info} for information, ${c.none} unchanged, ${c.error} could not be re-checked`);
  return L.join("\n");
}
