// `carbonlei verify-batch` and `carbonlei portfolio`: reading the batch input, running many verifications with a
// small concurrency, the results file, and turning it into the shipments `buildPortfolio` plans.
// The verification itself is `verdictFor` (sdk/verdict.ts), unchanged; this file only orders and collects.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChainReader } from "./chain.ts";
import { decodeDisclosure } from "./disclosure.ts";
import type { PortfolioSummary, ShipmentInput } from "./portfolio.ts";
import { EXIT, TOOL, type Verdict } from "./verdict.ts";

/** Format of the results file `verify-batch` writes. */
export const BATCH_FORMAT = 1;
/** Concurrency limit: public RPC nodes rate-limit, so at most this many proofs are verified at once. */
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 2;

/** What the importer knows about one line from customs; anything missing is taken from the proof. */
export interface ManifestLine {
  /** Proof file, relative to the manifest; null or absent for a line with no supplier proof (default values). */
  proof?: string | null;
  id?: string;
  quantityTonnes?: string;
  cnCode?: string;
  country?: string;
  importDate?: string;
  supplier?: string;
  installation?: string;
  defaultValue?: string;
  sefaActual?: string;
  note?: string;
}

export interface Manifest {
  /** Importer EORI for check 5 (the CLI's --eori wins). */
  eori?: string;
  shipments: ManifestLine[];
}

export interface BatchEntry {
  /** Absolute path of the proof, or null for a line without one. */
  proofPath: string | null;
  line: ManifestLine;
}

export interface BatchResult {
  /** Proof path as given (relative to the manifest or the folder), or null. */
  proof: string | null;
  line: ManifestLine;
  verdict: Verdict | null;
  error: string | null;
  /** The proof's own shipment fields (batch, quantity, date), as presented; trusted only when check 5 passed. */
  proofShipment: { batchId: string; quantityTonnes: string; shipmentDate: string } | null;
  /** Set by `applyRecheck` (sdk/recheck.ts) when a later re-check found the line needs action: planned on the default. */
  recheck?: { change: string; severity: string; checkedAt: string; pinnedBlock: number | null };
}

export interface BatchDocument {
  format: typeof BATCH_FORMAT;
  kind: "carbonlei-batch";
  /** Block every verification of the run read (one snapshot). */
  pinnedBlock: number | null;
  chainId: number | null;
  eori: string | null;
  verifiedAt: string;
  counts: Record<"VALID" | "INVALID" | "CONTESTED" | "INCOMPLETE" | "ERROR" | "NO_PROOF", number>;
  results: BatchResult[];
  tool: { name: string; version: string };
}

const isProof = (x: unknown): boolean =>
  !!x && typeof x === "object" && typeof (x as { core?: unknown }).core === "string" && "signature" in (x as object);

/**
 * The lines of a batch: a folder (every .json file in it that is a proof, in name order) or a manifest file
 * (`{ eori?, shipments: [{ proof, quantityTonnes, cnCode, country, importDate, … }] }`).
 */
export function loadBatchInput(target: string): { entries: BatchEntry[]; eori?: string; skipped: string[] } {
  const skipped: string[] = [];
  if (statSync(target).isDirectory()) {
    const entries: BatchEntry[] = [];
    for (const name of readdirSync(target).filter((n) => n.endsWith(".json")).sort()) {
      const path = resolve(target, name);
      try {
        if (isProof(JSON.parse(readFileSync(path, "utf8")))) {
          entries.push({ proofPath: path, line: { proof: name } });
          continue;
        }
      } catch {}
      skipped.push(name);
    }
    if (!entries.length) throw new Error(`no proof files (.json with core and signature) in ${target}`);
    return { entries, skipped };
  }
  const m = JSON.parse(readFileSync(target, "utf8")) as Manifest;
  if (!m || !Array.isArray(m.shipments) || !m.shipments.length) throw new Error(`${target}: a manifest needs a non-empty "shipments" array`);
  const base = dirname(resolve(target));
  return {
    entries: m.shipments.map((line) => ({ proofPath: line.proof ? resolve(base, line.proof) : null, line })),
    eori: typeof m.eori === "string" ? m.eori : undefined,
    skipped,
  };
}

/**
 * A reader whose `latestBlock` always returns `head`: every verification of a batch then pins its reads to that one
 * block (`verifyPresentation` reads the head once and continues on `reader.at(head.number)`), so all proofs of a
 * run are judged against the same chain state. Everything else is the reader's own.
 */
export function pinnedToHead(reader: ChainReader, head: { number: bigint; timestamp: bigint }): ChainReader {
  const r = Object.create(reader) as ChainReader;
  r.latestBlock = async () => ({ number: head.number, timestamp: head.timestamp });
  return r;
}

/** Runs `fn` on every item, at most `concurrency` at a time, and returns the results in input order. */
export async function runLimited<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}, got ${concurrency}`);
  }
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

export function batchDocument(results: BatchResult[], ctx: { pinnedBlock?: bigint; chainId?: number; eori?: string; now?: Date }): BatchDocument {
  const counts: BatchDocument["counts"] = { VALID: 0, INVALID: 0, CONTESTED: 0, INCOMPLETE: 0, ERROR: 0, NO_PROOF: 0 };
  for (const r of results) {
    if (r.error) counts.ERROR++;
    else if (!r.verdict) counts.NO_PROOF++;
    else counts[r.verdict.overall]++;
  }
  return {
    format: BATCH_FORMAT,
    kind: "carbonlei-batch",
    pinnedBlock: ctx.pinnedBlock === undefined ? null : Number(ctx.pinnedBlock),
    chainId: ctx.chainId ?? null,
    eori: ctx.eori ?? null,
    verifiedAt: (ctx.now ?? new Date()).toISOString(),
    counts,
    results,
    tool: { ...TOOL },
  };
}

/**
 * Exit code of a batch: 3 if any verification could not run, else 1 if any proof is INVALID, else 2 if any is
 * CONTESTED, else 4 if any is INCOMPLETE, else 0 (lines without a proof do not change it).
 */
export function batchExitCode(doc: Pick<BatchDocument, "counts">): number {
  const c = doc.counts;
  return c.ERROR ? EXIT.ERROR : c.INVALID ? EXIT.INVALID : c.CONTESTED ? EXIT.CONTESTED : c.INCOMPLETE ? EXIT.INCOMPLETE : EXIT.VALID;
}

/** The proof's shipment fields, as presented (not yet checked). */
export function proofShipmentOf(proof: unknown): BatchResult["proofShipment"] {
  const s = (proof as { shipment?: Record<string, unknown> })?.shipment;
  if (!s || typeof s.batchId !== "string") return null;
  return { batchId: s.batchId, quantityTonnes: String(s.quantityTonnes ?? ""), shipmentDate: String(s.shipmentDate ?? "") };
}

/** A disclosed field's value from the proof itself (used only to name a line whose verification failed). */
export function presentedField(proof: unknown, name: string): string | undefined {
  for (const enc of (proof as { disclosures?: unknown })?.disclosures instanceof Array ? (proof as { disclosures: string[] }).disclosures : []) {
    try {
      const d = decodeDisclosure(enc);
      if (d.name === name) return d.value;
    } catch {}
  }
  return undefined;
}

/**
 * The shipments of a results file, for `buildPortfolio`. The importer's manifest fields win; otherwise the CN code
 * and origin come from the verified disclosures and the quantity and date from the proof's shipment, but only when
 * check 5 confirmed that shipment on the ledger. A line missing a field throws, naming the line and the field.
 */
export function shipmentsFromBatch(doc: BatchDocument): ShipmentInput[] {
  if (doc?.kind !== "carbonlei-batch" || !Array.isArray(doc.results)) throw new Error("not a carbonlei verify-batch results file");
  const seen = new Set<string>();
  return doc.results.map((r, i) => {
    const v = r.verdict;
    const bound = v?.checks?.find((c) => c.id === 5)?.status === "pass";
    const ps = bound ? r.proofShipment : null;
    const d = v?.disclosed ?? {};
    // The importer's own id, else the batch id; a batch id seen before (two proofs for one batch) gets the file name.
    let id = r.line.id ?? ps?.batchId ?? r.proofShipment?.batchId ?? r.proof ?? `line-${i + 1}`;
    if (seen.has(id) && !r.line.id) id = `${id} (${r.proof ?? `line ${i + 1}`})`;
    seen.add(id);
    const pick = (field: keyof ManifestLine, fallback: string | undefined) => {
      const x = (r.line[field] as string | undefined) ?? fallback;
      if (x === undefined || x === "") {
        throw new Error(`${id}: no ${field} (give it in the manifest${field === "quantityTonnes" || field === "importDate" ? ", or verify with --eori so check 5 confirms the proof's shipment" : ""})`);
      }
      return x;
    };
    return {
      id,
      verdict: v,
      ...(r.error ? { verifyError: r.error } : {}),
      ...(r.recheck ? { downgradedBy: `${r.recheck.change} (re-check of ${r.recheck.checkedAt.slice(0, 10)}, block ${r.recheck.pinnedBlock ?? "—"})` } : {}),
      quantityTonnes: pick("quantityTonnes", ps?.quantityTonnes),
      cnCode: pick("cnCode", d.cnCode),
      country: pick("country", d.unLocode?.slice(0, 2)),
      importDate: pick("importDate", ps?.shipmentDate),
      supplier: r.line.supplier ?? d.supplierLEI,
      installation: r.line.installation ?? d.installationId,
      ...(ps ? { claimedTonnes: ps.quantityTonnes } : {}),
      ...(r.line.defaultValue ? { defaultValue: r.line.defaultValue } : {}),
      ...(r.line.sefaActual ? { sefaActual: r.line.sefaActual } : {}),
      ...(r.line.note ? { note: r.line.note } : {}),
    };
  });
}

/** One line per proof for the terminal. */
export function printBatch(doc: BatchDocument): string {
  const L = [`Pinned block ${doc.pinnedBlock ?? "—"} (chain ${doc.chainId ?? "—"})${doc.eori ? `, EORI ${doc.eori}` : ", no EORI: check 5 skipped"}`];
  for (const r of doc.results) {
    const status = r.error ? "ERROR" : r.verdict ? r.verdict.overall : "NO PROOF";
    const code = r.verdict?.primaryCode ? ` [${r.verdict.primaryCode}]` : "";
    L.push(`${status.padEnd(10)} ${r.proof ?? "(no proof)"}${code}${r.error ? ` — ${r.error}` : ""}`);
  }
  const c = doc.counts;
  L.push("", `${doc.results.length} line(s): ${c.VALID} VALID, ${c.INVALID} INVALID, ${c.CONTESTED} CONTESTED, ${c.INCOMPLETE} INCOMPLETE, ${c.ERROR} error, ${c.NO_PROOF} without proof`);
  return L.join("\n");
}

/** The portfolio summary for the terminal. */
export function printPortfolio(p: PortfolioSummary): string {
  const t = p.totals;
  const L = [`CBAM declaration plan ${p.year} — worksheet, not a CBAM declaration`, ""];
  const w = Math.max(4, ...p.shipments.map((l) => l.id.length));
  L.push(`${"line".padEnd(w)}  CN        orig  Q   net t      basis    tCO2e/t  embedded tCO2e  verdict`);
  for (const l of p.shipments) {
    L.push(
      `${l.id.padEnd(w)}  ${l.cnCode.padEnd(8)}  ${l.country.padEnd(4)}  Q${l.quarter}  ${l.quantityTonnes.padStart(9)}  ${l.basis.padEnd(7)}  ${l.seeUsed.padStart(7)}  ${l.embeddedT.padStart(14)}  ${l.verdict}${l.reason ? ` — ${l.reason}` : ""}`,
    );
  }
  for (const x of p.excluded) L.push(`(left out) ${x.id}: ${x.reason}`);
  L.push(
    "",
    `Net mass ${t.quantityTonnes} t — de minimis (${p.deMinimis.thresholdTonnes} t): ${p.deMinimis.exempt ? "not exceeded, exempt" : `exceeded by ${p.deMinimis.exceededBy?.id} (${p.deMinimis.exceededBy?.importDate})`}`,
    `Embedded emissions ${t.embeddedT} tCO2e (${t.onActual} line(s) on verified values, ${t.onDefault} on defaults); all on defaults: ${t.allDefaultT} tCO2e; gap ${t.gapT} tCO2e (declared, not a physical reduction)`,
    `Free-allocation adjustment ${p.freeAllocation.applied === "none" ? "not applied (gross figures)" : `${t.adjustmentT} tCO2e (${p.freeAllocation.applied}; CBAM factor ${p.freeAllocation.cbamFactor})`}`,
    `Certificates to surrender ${t.certificates} (all on defaults: ${t.allDefaultCertificates})`,
    t.grossEur === null
      ? "Gross €: no price for every quarter (pass --price)"
      : `Gross € ${t.grossEur} (all on defaults € ${t.allDefaultGrossEur}; difference € ${t.savedEur}) — illustrative, gross`,
    "",
    "Quarterly holding (Art 22(2)):",
  );
  for (const q of p.quarterlyHolding) L.push(`  Q${q.quarter} (${q.end})  ${q.applies ? `hold ≥ ${q.requiredCertificates} certificates (${q.requiredT} tCO2e)` : "—"}  ${q.why}`);
  L.push("", ...p.notes.map((n) => `· ${n}`));
  return L.join("\n");
}

/** Reads a JSON map file for --defaults / --benchmarks. */
export function readMap(path: string, what: string): Record<string, string> {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error(`${what} file must be a JSON object of "<country>:<CN prefix>": value`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[k] = String(v);
  return out;
}

