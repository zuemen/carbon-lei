// Supplier portal: one verified report, many buyers. The supplier keeps a local allocation book (which batch of the
// verified tonnage goes to which importer, with the importer's EORI and the per-batch salt) and reconciles it against
// the registry at one pinned block. The chain holds only commitments (batchKey, importerCommit, quantityKg); the book
// is matched to them locally with the supplier's own salts. EORIs and salts never leave this module's inputs: the
// reconciliation report and the share-pack plan name importers by the book's local id and name only.
//
// Browser-safe (no node:fs): the demo's Supplier tab uses `reconcile` and `buildSharePack` too.
import { emissionsClaimRegistryAbi } from "./abi.ts";
import type { ChainReader, ReportRecord, ShipmentStatus } from "./chain.ts";
import { batchKeyOf, importerCommitOf, reportKeyOf, ZERO32 } from "./commitment.ts";
import { check8HiddenFields, RECONCILED_CLAIMS } from "./consistency.ts";
import { CLAIM_ORDER, REQUIRED_DISCLOSURES, tonnesToKg, type Hex } from "./credential.ts";
import { isSalt, sha256Hex } from "./encoding.ts";
import type { Presentation } from "./disclosure.ts";
import { DEMO_DISCLOSURE, present, type SignedCredential } from "./issue.ts";

// ------------------------------------------------------------------ disclosure presets

/**
 * The fewest fields a proof can disclose and still verify VALID: the required ones (checks 3-5) plus every field
 * check 8 reconciles (`RECONCILED_CLAIMS`), since the credential core commits to a signed reconciliation. Hidden:
 * UN/LOCODE, value type and the verification body's LEI (and the supplier-private fields, never disclosed).
 */
export const MINIMAL_VERIFIABLE_DISCLOSURE: readonly string[] = CLAIM_ORDER.filter(
  (n) => (REQUIRED_DISCLOSURES as readonly string[]).includes(n) || (RECONCILED_CLAIMS as readonly string[]).includes(n),
);

/** Field presets offered to a supplier (the demo's Allocations tab): each one verifies VALID (sdk/test/disclosure-presets.test.ts). */
export const DISCLOSURE_PRESETS = {
  /** What an importer needs for a CBAM declaration (the demo default, 21 fields). */
  importer: DEMO_DISCLOSURE,
  /** The fewest fields that still verify VALID (18 fields). */
  minimal: MINIMAL_VERIFIABLE_DISCLOSURE,
} as const satisfies Record<string, readonly string[]>;

// ------------------------------------------------------------------ the book

export type BookStatus = "planned" | "claimed";

export interface BookImporter {
  /** Local id, used in file names and reports (never the EORI). */
  id: string;
  name?: string;
  /** The importer's EORI: secret to the supplier's book; only its salted commitment is on-chain. */
  eori: string;
  /** Fields this buyer receives (the required ones are always added). Default: the book's `defaultFields`. */
  fields?: string[];
}

export interface BookBatch {
  batchId: string;
  /** `BookImporter.id`. */
  importer: string;
  /** Per-batch salt of the importer commitment (32 bytes, 0x + 64 lower-case hex). A secret: keep it with the book. */
  importerSalt: Hex;
  quantityTonnes: string;
  /** YYYY-MM-DD. */
  shipmentDate: string;
  /** "claimed": the supplier sent claimShipment; "planned": not yet. */
  status: BookStatus;
  /** Overrides the importer's field list for this batch. */
  fields?: string[];
}

export interface AllocationBook {
  version: 1;
  /** Path of the credential file (from `carbonlei issue`), relative to the book; `--credential` overrides it. */
  credential?: string;
  /** Fields every buyer receives unless its importer entry says otherwise. Default: DEMO_DISCLOSURE. */
  defaultFields?: string[];
  importers: BookImporter[];
  batches: BookBatch[];
}

export class BookError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`allocation book: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_FIELDS = new Set<string>(CLAIM_ORDER);

/** Checks the shape of a parsed book; throws `BookError` listing every problem. */
export function parseBook(x: unknown): AllocationBook {
  const p: string[] = [];
  const b = x as Partial<AllocationBook> | null;
  if (!b || typeof b !== "object") throw new BookError(["not a JSON object"]);
  if (b.version !== 1) p.push(`version must be 1, got ${JSON.stringify(b.version)}`);
  if (!Array.isArray(b.importers)) p.push("importers must be an array");
  if (!Array.isArray(b.batches)) p.push("batches must be an array");
  if (p.length) throw new BookError(p);
  const checkFields = (where: string, f: unknown) => {
    if (f === undefined) return;
    if (!Array.isArray(f) || f.some((n) => typeof n !== "string")) return p.push(`${where}: fields must be a list of field names`);
    for (const n of f as string[]) if (!KNOWN_FIELDS.has(n)) p.push(`${where}: unknown field ${n}`);
  };
  checkFields("defaultFields", b.defaultFields);
  const ids = new Set<string>();
  b.importers!.forEach((im, i) => {
    const w = `importers[${i}]`;
    if (!im || typeof im.id !== "string" || !im.id.trim()) return p.push(`${w}: id missing`);
    if (ids.has(im.id)) p.push(`${w}: duplicate id ${im.id}`);
    ids.add(im.id);
    if (typeof im.eori !== "string" || !/^[A-Z]{2}[A-Za-z0-9]{1,15}$/.test(im.eori)) p.push(`${w} (${im.id}): eori is not an EORI number`);
    checkFields(`${w} (${im.id})`, im.fields);
  });
  const batchIds = new Set<string>();
  b.batches!.forEach((bt, i) => {
    const w = `batches[${i}]`;
    if (!bt || typeof bt.batchId !== "string" || !bt.batchId.trim()) return p.push(`${w}: batchId missing`);
    const wb = `${w} (${bt.batchId})`;
    if (batchIds.has(bt.batchId)) p.push(`${wb}: duplicate batchId (one batch can be claimed once)`);
    batchIds.add(bt.batchId);
    if (!ids.has(bt.importer)) p.push(`${wb}: importer ${JSON.stringify(bt.importer)} is not in importers`);
    if (!isSalt(bt.importerSalt)) p.push(`${wb}: importerSalt must be 0x + 64 lower-case hex`);
    try {
      tonnesToKg(String(bt.quantityTonnes));
    } catch (e) {
      p.push(`${wb}: quantityTonnes ${(e as Error).message}`);
    }
    if (typeof bt.shipmentDate !== "string" || !DATE.test(bt.shipmentDate)) p.push(`${wb}: shipmentDate must be YYYY-MM-DD`);
    if (bt.status !== "planned" && bt.status !== "claimed") p.push(`${wb}: status must be "planned" or "claimed"`);
    checkFields(wb, bt.fields);
  });
  if (p.length) throw new BookError(p);
  return b as AllocationBook;
}

/** The fields a batch's proof discloses: its own list, else the importer's, else the book default; required ones added. */
export function fieldsFor(book: AllocationBook, batch: BookBatch): string[] {
  const im = book.importers.find((i) => i.id === batch.importer);
  const chosen = new Set<string>(batch.fields ?? im?.fields ?? book.defaultFields ?? DEMO_DISCLOSURE);
  for (const r of REQUIRED_DISCLOSURES) chosen.add(r);
  return CLAIM_ORDER.filter((n) => chosen.has(n));
}

// ------------------------------------------------------------------ the chain snapshot

export interface ClaimEvent {
  batchKey: Hex;
  quantityKg: bigint;
  importerCommit: Hex;
  cumulativeClaimedKg: bigint;
  claimedAt: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

/** What the registry says about one credential at one block. */
export interface AllocationSnapshot {
  blockNumber: bigint;
  blockTime: bigint;
  reportKey: Hex;
  report: Pick<ReportRecord, "verifiedKg" | "registeredAt" | "revokedAt" | "supersededBy" | "validUntil">;
  /** `isValidAt(reportKey, blockTime)`: whether a claim would be accepted now (with enough tonnes left). */
  claimable: boolean;
  remainingKg: bigint;
  /** Cumulative claimed kg of the credential layer (includes claims carried over from a superseded report). */
  ledgerClaimedKg: bigint;
  /** `shipmentStatus` of every batchKey in the book. */
  shipments: Record<Hex, Pick<ShipmentStatus, "reportKey" | "quantityKg" | "importerCommit" | "claimedAt" | "reportValid">>;
  /** `ShipmentClaimed` events of this report up to the block; absent when the event search was not run. */
  events?: ClaimEvent[];
}

/** The credential data the reconciliation needs: the report key (from the SAID) and the batch salt. */
export interface ReportRef {
  credSAID: string;
  batchSalt: Hex;
  /** The credential core commits to a signed reconciliation: proofs must disclose the fields check 8 needs. */
  reconciliation?: boolean;
}

export const reportRefOf = (cred: SignedCredential): ReportRef => ({
  credSAID: cred.core.d,
  batchSalt: cred.claims.batchSalt,
  ...(cred.core.reconciliation ? { reconciliation: true } : {}),
});

export const batchKeysOf = (book: AllocationBook, ref: ReportRef): Hex[] =>
  book.batches.map((b) => batchKeyOf(reportKeyOf(ref.credSAID), b.batchId, ref.batchSalt));

/** At most this many blocks per `eth_getLogs` request (as `LOG_CHUNK` in chain.ts). */
const EVENT_CHUNK = 10_000n;

/**
 * `ShipmentClaimed` events of `reportKey` in [fromBlock, toBlock], read one chunk at a time (filtered on the indexed
 * reportKey topic). `fromBlock` defaults to the registry's deployment block.
 */
export async function readClaimEvents(reader: ChainReader, reportKey: Hex, toBlock: bigint, fromBlock?: bigint): Promise<ClaimEvent[]> {
  const start = fromBlock !== undefined && fromBlock > reader.fromBlock ? fromBlock : reader.fromBlock;
  const out: ClaimEvent[] = [];
  for (let from = start; from <= toBlock; from += EVENT_CHUNK) {
    const to = from + EVENT_CHUNK - 1n < toBlock ? from + EVENT_CHUNK - 1n : toBlock;
    const logs = (await reader.client.getContractEvents({
      address: reader.registry,
      abi: emissionsClaimRegistryAbi,
      eventName: "ShipmentClaimed",
      args: { reportKey },
      fromBlock: from,
      toBlock: to,
    } as never)) as unknown as { args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex }[];
    for (const l of logs) {
      out.push({
        batchKey: l.args.batchKey as Hex,
        quantityKg: l.args.quantityKg as bigint,
        importerCommit: l.args.importerCommit as Hex,
        cumulativeClaimedKg: l.args.cumulativeClaimedKg as bigint,
        claimedAt: l.args.claimedAt as bigint,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
      });
    }
  }
  return out;
}

/**
 * Reads everything `reconcile` needs at one pinned block (the latest, unless `blockNumber` is given): the report
 * record, its remaining tonnes, the layer ledger, the status of every batch in the book and, with `events`, the
 * report's `ShipmentClaimed` events (to find claims the book does not list).
 */
export async function readAllocationSnapshot(
  reader: ChainReader,
  book: AllocationBook,
  ref: ReportRef,
  opts: { events?: boolean; fromBlock?: bigint; blockNumber?: bigint } = {},
): Promise<AllocationSnapshot> {
  const head =
    opts.blockNumber !== undefined
      ? await reader.client.getBlock({ blockNumber: opts.blockNumber }).then((b) => ({ number: b.number as bigint, timestamp: b.timestamp }))
      : await reader.latestBlock();
  const blockNumber = head.number;
  const blockTime = head.timestamp;
  const at = reader.at(blockNumber);
  const reportKey = reportKeyOf(ref.credSAID);
  const report = await at.report(reportKey);
  const [remainingKg, claimable, ledger] = await Promise.all([
    at.remainingKg(reportKey),
    at.isValidAt(reportKey, blockTime),
    report.registeredAt === 0n ? Promise.resolve({ claimedKg: 0n }) : at.credScope(report.reportScopeKey, report.credScopeKey),
  ]);
  const shipments: AllocationSnapshot["shipments"] = {};
  for (const k of batchKeysOf(book, ref)) shipments[k] = await at.shipmentStatus(k);
  const events = opts.events ? await readClaimEvents(reader, reportKey, blockNumber, opts.fromBlock) : undefined;
  return {
    blockNumber,
    blockTime,
    reportKey,
    report: {
      verifiedKg: report.verifiedKg,
      registeredAt: report.registeredAt,
      revokedAt: report.revokedAt,
      supersededBy: report.supersededBy,
      validUntil: report.validUntil,
    },
    claimable,
    remainingKg,
    ledgerClaimedKg: ledger.claimedKg,
    shipments,
    ...(events ? { events } : {}),
  };
}

// ------------------------------------------------------------------ reconciliation

export type BatchState =
  /** On-chain and matching the book (quantity and importer commitment). */
  | "claimed"
  /** On-chain under this batch key, but the quantity or the importer commitment differs from the book. */
  | "mismatch"
  /** The book says claimed; the registry has no claim for this batch. */
  | "missing"
  /** Not yet claimed; fits in the remaining tonnes (in book order). */
  | "planned"
  /** Not yet claimed; the contract would refuse it (ExceedsVerifiedTonnage) after the planned batches before it. */
  | "over-allocated"
  /** Not yet claimed; the report takes no claims now (revoked, replaced, expired or not registered). */
  | "blocked";

export type IssueCode =
  | "CLAIM_MISSING"
  | "QUANTITY_MISMATCH"
  | "IMPORTER_MISMATCH"
  | "BOOK_STALE"
  | "OVER_ALLOCATED"
  | "REPORT_NOT_CLAIMABLE"
  | "REPORT_REVOKED"
  | "UNKNOWN_CLAIM"
  | "UNACCOUNTED_KG"
  | "SALT_REUSED"
  | "FIELDS_INCOMPLETE";

export interface AllocationIssue {
  code: IssueCode;
  /** "action": the supplier must fix something (exit 1); "warning": worth a look. */
  severity: "action" | "warning";
  batchId?: string;
  detail: string;
}

export interface BatchLine {
  batchId: string;
  importer: string;
  importerName?: string;
  quantityKg: bigint;
  bookStatus: BookStatus;
  state: BatchState;
  batchKey: Hex;
  onchainQuantityKg?: bigint;
  claimedAt?: bigint;
}

export interface ImporterLine {
  id: string;
  name?: string;
  claimedKg: bigint;
  plannedKg: bigint;
  refusedKg: bigint;
  batches: number;
}

export type ReportState = "claimable" | "revoked" | "replaced" | "expired" | "not-registered" | "not-claimable";

export interface SharePackPlanEntry {
  importer: string;
  importerName?: string;
  fields: string[];
  /** Fields check 8 needs that this importer's proofs hide: they would verify INCOMPLETE (present-batch skips them). */
  incomplete?: string[];
  proofs: { batchId: string; file: string; ready: boolean; reason: string }[];
}

export interface AllocationReport {
  reportKey: Hex;
  block: bigint;
  blockTime: bigint;
  report: { state: ReportState; verifiedKg: bigint; ledgerClaimedKg: bigint; remainingKg: bigint };
  batches: BatchLine[];
  importers: ImporterLine[];
  totals: {
    claimedKg: bigint;
    plannedKg: bigint;
    refusedKg: bigint;
    /** Remaining tonnes after every planned batch that fits is claimed. */
    remainingAfterPlanKg: bigint;
    /** Ledger kg that no claimed batch of the book explains (0 when everything is in the book). */
    unaccountedKg: bigint;
  };
  unknownClaims: Omit<ClaimEvent, "importerCommit">[];
  sharePack: SharePackPlanEntry[];
  issues: AllocationIssue[];
  /** True when no issue needs action. */
  ok: boolean;
}

export function reportStateOf(s: AllocationSnapshot): ReportState {
  if (s.report.registeredAt === 0n) return "not-registered";
  if (s.report.revokedAt !== 0n) return "revoked";
  if (s.report.supersededBy !== ZERO32) return "replaced";
  if (s.blockTime > s.report.validUntil) return "expired";
  return s.claimable ? "claimable" : "not-claimable";
}

/**
 * File name of a batch's proof in a share pack: `<importer id>--<batch id>--<hash>.proof.json`, unsafe characters as
 * `_`. The readable part alone is not unique ("acme" + "b--1" and "acme--b" + "1" read the same, and so do "a/b" and
 * "a_b"), so the name ends with the first 10 hex digits of SHA-256 over both full ids (review of 17 October 2026).
 */
export function proofFileName(importerId: string, batchId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return `${safe(importerId)}--${safe(batchId)}--${sha256Hex(JSON.stringify([importerId, batchId])).slice(0, 10)}.proof.json`;
}

const t = (kg: bigint) => {
  const w = kg / 1000n;
  const f = (kg % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
};

/** Matches the book against the snapshot; pure (no chain access). */
export function reconcile(book: AllocationBook, ref: ReportRef, snap: AllocationSnapshot): AllocationReport {
  const reportKey = reportKeyOf(ref.credSAID);
  if (reportKey !== snap.reportKey) throw new Error("the snapshot was read for another credential");
  const state = reportStateOf(snap);
  const importers = new Map(book.importers.map((i) => [i.id, i]));
  const issues: AllocationIssue[] = [];
  const lines: BatchLine[] = [];
  let available = state === "claimable" ? snap.remainingKg : 0n;
  const bookKeys = new Set<Hex>();

  for (const b of book.batches) {
    const im = importers.get(b.importer)!;
    const batchKey = batchKeyOf(reportKey, b.batchId, ref.batchSalt);
    bookKeys.add(batchKey);
    const quantityKg = tonnesToKg(b.quantityTonnes);
    const s = snap.shipments[batchKey];
    const onChain = s && s.claimedAt !== 0n ? s : undefined;
    const line: BatchLine = { batchId: b.batchId, importer: im.id, ...(im.name ? { importerName: im.name } : {}), quantityKg, bookStatus: b.status, state: "planned", batchKey };
    if (onChain) {
      line.onchainQuantityKg = onChain.quantityKg;
      line.claimedAt = onChain.claimedAt;
      const qtyOk = onChain.quantityKg === quantityKg;
      const commitOk = onChain.importerCommit === importerCommitOf(im.eori, b.importerSalt);
      line.state = qtyOk && commitOk ? "claimed" : "mismatch";
      if (!qtyOk) issues.push({ code: "QUANTITY_MISMATCH", severity: "action", batchId: b.batchId, detail: `the book says ${t(quantityKg)} t, the registry ${t(onChain.quantityKg)} t` });
      if (!commitOk)
        issues.push({ code: "IMPORTER_MISMATCH", severity: "action", batchId: b.batchId, detail: `the claim was committed to another importer or salt than the book's ${im.id}; its proof would fail check 5 for that importer` });
      if (b.status === "planned" && line.state === "claimed")
        issues.push({ code: "BOOK_STALE", severity: "warning", batchId: b.batchId, detail: "the book says planned, the registry has the claim: mark it claimed" });
      if (!onChain.reportValid) issues.push({ code: "REPORT_REVOKED", severity: "action", batchId: b.batchId, detail: "the report was revoked: proofs for this batch fail check 4" });
    } else if (b.status === "claimed") {
      line.state = "missing";
      issues.push({ code: "CLAIM_MISSING", severity: "action", batchId: b.batchId, detail: "the book says claimed, the registry has no claim for this batch (not sent, reverted, or another batch ID or salt)" });
    } else if (state !== "claimable") {
      line.state = "blocked";
      issues.push({ code: "REPORT_NOT_CLAIMABLE", severity: "action", batchId: b.batchId, detail: `the report takes no claims (${state})` });
    } else if (quantityKg > available) {
      line.state = "over-allocated";
      issues.push({
        code: "OVER_ALLOCATED",
        severity: "action",
        batchId: b.batchId,
        detail: `${t(quantityKg)} t requested, ${t(available)} t left after the planned batches before it: claimShipment would revert with ExceedsVerifiedTonnage`,
      });
    } else {
      available -= quantityKg;
    }
    lines.push(line);
  }

  // Salts: one per batch keeps one importer's batches unlinkable to each other on-chain.
  const seen = new Map<string, string>();
  for (const b of book.batches) {
    const prev = seen.get(b.importerSalt);
    if (prev) issues.push({ code: "SALT_REUSED", severity: "warning", batchId: b.batchId, detail: `same importer salt as batch ${prev}: their commitments are linkable on-chain` });
    else seen.set(b.importerSalt, b.batchId);
  }

  const unknownClaims = (snap.events ?? []).filter((e) => !bookKeys.has(e.batchKey)).map(({ importerCommit: _, ...e }) => e);
  for (const e of unknownClaims)
    issues.push({ code: "UNKNOWN_CLAIM", severity: "action", detail: `on-chain claim of ${t(e.quantityKg)} t in block ${e.blockNumber} (batchKey ${e.batchKey.slice(0, 10)}…) is not in the book` });

  const sum = (f: (l: BatchLine) => boolean, q: (l: BatchLine) => bigint = (l) => l.quantityKg) => lines.filter(f).reduce((a, l) => a + q(l), 0n);
  const onchainKg = sum((l) => l.onchainQuantityKg !== undefined, (l) => l.onchainQuantityKg!);
  const claimedKg = sum((l) => l.state === "claimed");
  const plannedKg = sum((l) => l.state === "planned");
  const refusedKg = sum((l) => l.state === "over-allocated" || l.state === "blocked");
  const unaccountedKg = snap.ledgerClaimedKg > onchainKg ? snap.ledgerClaimedKg - onchainKg : 0n;
  const eventsExplained = unknownClaims.reduce((a, e) => a + e.quantityKg, 0n);
  if (unaccountedKg > eventsExplained)
    issues.push({
      code: "UNACCOUNTED_KG",
      severity: snap.events ? "action" : "warning",
      detail: `${t(unaccountedKg - eventsExplained)} t of the ledger's ${t(snap.ledgerClaimedKg)} t claimed is not in the book${snap.events ? "" : " (run with the event search to list those claims; claims carried over from a replaced report also count)"}`,
    });

  const byImporter: ImporterLine[] = book.importers.map((im) => {
    const mine = lines.filter((l) => l.importer === im.id);
    return {
      id: im.id,
      ...(im.name ? { name: im.name } : {}),
      claimedKg: mine.filter((l) => l.state === "claimed").reduce((a, l) => a + l.quantityKg, 0n),
      plannedKg: mine.filter((l) => l.state === "planned").reduce((a, l) => a + l.quantityKg, 0n),
      refusedKg: mine.filter((l) => l.state === "over-allocated" || l.state === "blocked").reduce((a, l) => a + l.quantityKg, 0n),
      batches: mine.length,
    };
  });

  const REASON: Record<BatchState, string> = {
    claimed: "claim on-chain matches the book: the proof verifies for this importer",
    mismatch: "the on-chain claim differs from the book: fix the book or the claim first",
    missing: "no claim on-chain: check 5 would fail",
    planned: "send the claim first; until then check 5 fails (claim not found)",
    "over-allocated": "would be refused by the contract: no proof",
    blocked: "the report takes no claims: no proof",
  };
  const sharePack: SharePackPlanEntry[] = book.importers
    .map((im) => {
      const mine = book.batches.filter((b) => b.importer === im.id);
      const fields = mine.length ? fieldsFor(book, mine[0]) : fieldsFor(book, { importer: im.id } as BookBatch);
      const hidden = check8HiddenFields({ reconciliation: ref.reconciliation }, fields);
      return {
        importer: im.id,
        ...(im.name ? { importerName: im.name } : {}),
        fields,
        ...(hidden.length ? { incomplete: hidden } : {}),
        proofs: mine.map((b) => {
          const l = lines.find((x) => x.batchId === b.batchId)!;
          return { batchId: b.batchId, file: proofFileName(im.id, b.batchId), ready: l.state === "claimed" && state !== "revoked", reason: REASON[l.state] };
        }),
      };
    })
    .filter((e) => e.proofs.length);
  // Per batch (a batch can override its importer's fields): a proof that hides a field check 8 needs never verifies.
  for (const b of book.batches) {
    const hidden = check8HiddenFields({ reconciliation: ref.reconciliation }, fieldsFor(book, b));
    if (hidden.length) issues.push({ code: "FIELDS_INCOMPLETE", severity: "action", batchId: b.batchId, detail: incompleteReason(hidden) });
  }

  return {
    reportKey,
    block: snap.blockNumber,
    blockTime: snap.blockTime,
    report: { state, verifiedKg: snap.report.verifiedKg, ledgerClaimedKg: snap.ledgerClaimedKg, remainingKg: snap.remainingKg },
    batches: lines,
    importers: byImporter,
    totals: { claimedKg, plannedKg, refusedKg, remainingAfterPlanKg: available, unaccountedKg },
    unknownClaims,
    sharePack,
    issues,
    ok: !issues.some((i) => i.severity === "action"),
  };
}

/** Exit code of `carbonlei allocate`: 0 when nothing needs action, else 1 (3 is used when the run could not finish). */
export const allocationExitCode = (r: AllocationReport): number => (r.ok ? 0 : 1);

/** Plain-text reconciliation for the terminal. Names importers by local id and name only. */
export function printAllocation(r: AllocationReport): string {
  const L: string[] = [];
  L.push(`Report ${r.reportKey.slice(0, 10)}…  at block ${r.block}  (${new Date(Number(r.blockTime) * 1000).toISOString()})`);
  L.push(`State ${r.report.state}  ·  verified ${t(r.report.verifiedKg)} t  ·  claimed on the ledger ${t(r.report.ledgerClaimedKg)} t  ·  remaining ${t(r.report.remainingKg)} t`);
  L.push("", "Batches (book order):");
  const w = Math.max(8, ...r.batches.map((b) => b.batchId.length));
  for (const b of r.batches) {
    const who = b.importerName ? `${b.importer} (${b.importerName})` : b.importer;
    const chain = b.onchainQuantityKg !== undefined && b.onchainQuantityKg !== b.quantityKg ? `  [on-chain ${t(b.onchainQuantityKg)} t]` : "";
    L.push(`  ${b.batchId.padEnd(w)}  ${t(b.quantityKg).padStart(9)} t  ${b.state.toUpperCase().padEnd(14)}  → ${who}${chain}`);
  }
  L.push("", "Per importer:");
  for (const i of r.importers) {
    L.push(`  ${i.id}${i.name ? ` (${i.name})` : ""}: claimed ${t(i.claimedKg)} t · planned ${t(i.plannedKg)} t${i.refusedKg ? ` · would be refused ${t(i.refusedKg)} t` : ""}`);
  }
  L.push("", `Plan: ${t(r.totals.plannedKg)} t planned fits; ${t(r.totals.remainingAfterPlanKg)} t would remain${r.totals.refusedKg ? `; ${t(r.totals.refusedKg)} t would be refused` : ""}.`);
  if (r.unknownClaims.length) {
    L.push("", "On-chain claims not in the book:");
    for (const e of r.unknownClaims) L.push(`  block ${e.blockNumber}  ${t(e.quantityKg)} t  batchKey ${e.batchKey}  tx ${e.txHash}`);
  }
  L.push("", "Share pack (one proof per batch; `carbonlei present-batch`):");
  for (const s of r.sharePack) {
    L.push(`  ${s.importer}: ${s.fields.length} fields${s.incomplete ? ` — hides ${s.incomplete.join(", ")}: would verify INCOMPLETE` : ""}`);
    for (const p of s.proofs) L.push(`    ${p.ready ? "READY  " : "NOT YET"}  ${p.file} — ${p.reason}`);
  }
  if (r.issues.length) {
    L.push("", `Issues (${r.issues.length}):`);
    for (const i of r.issues) L.push(`  ${i.severity === "action" ? "ACTION " : "warning"} ${i.code}${i.batchId ? ` ${i.batchId}` : ""} — ${i.detail}`);
  }
  L.push("", r.ok ? "OK: the book and the registry agree." : "NEEDS ACTION: see the issues above.");
  return L.join("\n");
}

// ------------------------------------------------------------------ share pack (proofs)

export interface SharePackProof {
  importer: string;
  batchId: string;
  file: string;
  fields: string[];
  proof: Presentation;
  /** Fields check 8 needs that this proof hides (written only with `allowIncomplete`): it verifies INCOMPLETE. */
  incomplete?: string[];
}

/** Why a share-pack proof is not written: it hides fields check 8 needs, so the buyer's verifier says INCOMPLETE. */
export const incompleteReason = (hidden: readonly string[]) =>
  `hides ${hidden.join(", ")}, which check 8 needs: the buyer's verifier would return Not verified (INCOMPLETE); add the fields to the book or pass --allow-incomplete`;

/** Evidence copied into every proof (from an existing proof of the same credential): checks 6-9 read it. */
export type ProofEvidence = Pick<Presentation, "anchorEvidence" | "authorityEvidence" | "reportExtract" | "precursorEvidence">;

/**
 * One selective-disclosure proof per batch, with each buyer's fields (`fieldsFor`), via `present`. By default only
 * batches the book marks claimed; `only` narrows that further (e.g. to the batches `reconcile` found READY).
 * `includePlanned` also builds planned batches (the demo's preview): their proofs fail check 5 until the claim is sent.
 * A batch whose fields hide one check 8 needs (`check8HiddenFields`) is skipped, since its proof would verify
 * INCOMPLETE, unless `allowIncomplete` (then the proof is written and lists the hidden fields in `incomplete`).
 */
export function buildSharePack(
  cred: SignedCredential,
  book: AllocationBook,
  opts: { evidence?: ProofEvidence; only?: (b: BookBatch) => boolean; includePlanned?: boolean; allowIncomplete?: boolean } = {},
): { proofs: SharePackProof[]; skipped: { batchId: string; reason: string }[] } {
  const proofs: SharePackProof[] = [];
  const skipped: { batchId: string; reason: string }[] = [];
  const ev = opts.evidence ?? {};
  for (const b of book.batches) {
    if (b.status !== "claimed" && !opts.includePlanned) {
      skipped.push({ batchId: b.batchId, reason: "planned: send the claim first" });
      continue;
    }
    if (opts.only && !opts.only(b)) {
      skipped.push({ batchId: b.batchId, reason: "not READY in the reconciliation (see carbonlei allocate)" });
      continue;
    }
    const fields = fieldsFor(book, b);
    const hidden = check8HiddenFields(cred.core, fields);
    if (hidden.length && !opts.allowIncomplete) {
      skipped.push({ batchId: b.batchId, reason: incompleteReason(hidden) });
      continue;
    }
    const p = present(cred, fields, { batchId: b.batchId, quantityTonnes: b.quantityTonnes, shipmentDate: b.shipmentDate, importerSalt: b.importerSalt });
    const proof: Presentation = {
      ...p,
      ...(ev.anchorEvidence ? { anchorEvidence: ev.anchorEvidence } : {}),
      ...(ev.authorityEvidence ? { authorityEvidence: ev.authorityEvidence } : {}),
      ...(ev.reportExtract ? { reportExtract: ev.reportExtract } : {}),
      ...(ev.precursorEvidence ? { precursorEvidence: ev.precursorEvidence } : {}),
    };
    proofs.push({ importer: b.importer, batchId: b.batchId, file: proofFileName(b.importer, b.batchId), fields, proof, ...(hidden.length ? { incomplete: hidden } : {}) });
  }
  return { proofs, skipped };
}
