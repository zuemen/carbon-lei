// `carbonlei audit-pack` and `carbonlei verify-pack`: the importer's record of what a year's declaration plan rested
// on, in one folder it can hand to a verifier or a competent authority years later, and the check of that folder.
//
// Legal basis (Regulation (EU) 2023/956, EUR-Lex consolidated text of 20.10.2025, CELEX 02023R0956-20251020):
//   Art 7(5)   the authorised CBAM declarant keeps records of the information required to calculate the embedded
//              emissions (Annex V), detailed enough for accredited verifiers and for the Commission and the competent
//              authority to review the declaration under Art 19(2);
//   Art 7(6)   it keeps those records, "including the report of the verifier, until the end of the fourth year after
//              the year in which the CBAM declaration has been or should have been submitted";
//   Art 9(2)-(3) the same period for the records of a carbon price effectively paid in a third country, certified by
//              an independent person.
// The declaration for import year Y is submitted in year Y+1 (the first, for 2026 imports, by 30 September 2027), so
// the records of year Y are kept until 31 December of year Y+5: `retentionOf(2026)` is 2031-12-31.
//
// What a pack holds: the verify-batch results file as written, every proof file a line was verified from (the very
// bytes: each must hash to the line's `proofSha256`), the evidence bundles those proofs refer to, the optional
// re-check, plan and worksheet files, `pack.json` (chain ID, contract addresses, the pinned block and its hash, tool,
// import year, retention date, each line's verdict), `lines.csv`, `README.txt` and `manifest.json` (SHA-256 and size
// of every other file). Everything but the manifest's `createdAt` is deterministic: the same inputs give the same
// bytes. A SHA-256 manifest detects a change made after it was written; it is not a signature and does not prove when
// the pack was made. Keep the pack (or at least the manifest's own SHA-256) in the company's WORM or archive system.
// It is not a legal opinion and not a CBAM Registry submission.
//
// Node only (file system). The verification itself is `verdictFor` (sdk/verdict.ts), unchanged.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { BatchDocument, BatchResult } from "./batch.ts";
import type { ChainReader, Deployment } from "./chain.ts";
import { isSafeBundlePath } from "./checkers.ts";
import type { Hex } from "./credential.ts";
import type { Presentation } from "./disclosure.ts";
import { sha256Hex } from "./encoding.ts";
import { pinnedToHead, runLimited } from "./pinned.ts";
import { csvField } from "./portfolio.ts";
import { applyRecheck, type RecheckDocument } from "./recheck.ts";
import { sandboxedLoader } from "./server.ts";
import { EXIT, TOOL, verdictFor, type Verdict } from "./verdict.ts";

/** Format of `pack.json` and `manifest.json`; a change that breaks a reader increases it. */
export const AUDIT_PACK_FORMAT = 1;
/** Largest file a pack takes in or `verify-pack` reads (the REST API's evidence limit). */
export const MAX_PACK_FILE_BYTES = 5_000_000;
/** At most this many files in one pack. */
export const MAX_PACK_FILES = 2_000;
/** First import year of the CBAM definitive period. */
export const FIRST_IMPORT_YEAR = 2026;

/** The provisions the pack's retention date rests on, quoted in `pack.json` and README.txt. */
export const LEGAL_BASIS = [
  "Regulation (EU) 2023/956 Art 7(5): the authorised CBAM declarant keeps records of the information required to calculate the embedded emissions (Annex V), detailed enough for accredited verifiers and for the Commission and the competent authority to review the CBAM declaration under Art 19(2).",
  'Art 7(6): those records are kept, "including the report of the verifier, until the end of the fourth year after the year in which the CBAM declaration has been or should have been submitted."',
  "Art 9(2)-(3): records of a carbon price effectively paid in a third country, certified by an independent person, are kept until the end of the fourth year after the year in which the CBAM declaration has been or should have been submitted.",
  "Source: EUR-Lex consolidated text of 20.10.2025, CELEX 02023R0956-20251020.",
] as const;

/**
 * Declaration year and retention date of import year `year`: the declaration for year Y is submitted in Y+1, and the
 * records are kept until the end of the fourth year after it (Art 7(6)), 31 December of Y+5.
 */
export function retentionOf(year: number): { declarationYear: number; retainUntil: string } {
  if (!Number.isInteger(year) || year < FIRST_IMPORT_YEAR || year > 9994) {
    throw new Error(`import year must be a whole year from ${FIRST_IMPORT_YEAR} (the first year of the CBAM definitive period), got ${year}`);
  }
  return { declarationYear: year + 1, retainUntil: `${year + 5}-12-31` };
}

export interface PackFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PackManifest {
  format: typeof AUDIT_PACK_FORMAT;
  kind: "carbonlei-audit-pack-manifest";
  algorithm: "sha256";
  /** The only wall-clock time in the pack; not covered by any hash. */
  createdAt: string;
  note: string;
  /** Every file of the pack but this one, sorted by path. */
  files: PackFile[];
}

export interface PackLine {
  /** 1-based position in the results file. */
  line: number;
  id: string;
  /** The proof name as the results file gives it (data only; never used as a path inside the pack). */
  proof: string | null;
  /** Path of the packed proof, or null when the line has none (or its bytes were never read). */
  packedAs: string | null;
  proofSha256: string | null;
  verdict: "VALID" | "INVALID" | "CONTESTED" | "INCOMPLETE" | "ERROR" | "NO_PROOF";
  primaryCode: string;
  credSAID: string | null;
  error: string | null;
  /** A later re-check that found the line needs action (`--recheck`). */
  recheck: { change: string; severity: string; checkedAt: string } | null;
  /** Evidence bundles of the proof, packed under proofs/. */
  evidence: string[];
  /** Evidence bundles the proof names that were not found with the hash it gives (re-verification then fails as before). */
  evidenceMissing: string[];
}

export interface PackDocument {
  format: typeof AUDIT_PACK_FORMAT;
  kind: "carbonlei-audit-pack";
  tool: { name: string; version: string };
  importYear: number;
  declarationYear: number;
  retainUntil: string;
  retentionRule: string;
  legalBasis: readonly string[];
  eori: string | null;
  chain: {
    chainId: number;
    contracts: { VerifierAllowlist: Hex; EmissionsClaimRegistry: Hex };
    pinnedBlock: number | null;
    blockHash: Hex | null;
    /** "chain": read from the RPC when the pack was made; "given": passed by the caller (--block-hash), not checked then. */
    blockHashSource: "chain" | "given" | null;
    blockTimestamp: number | null;
  };
  counts: BatchDocument["counts"];
  inputs: { results: string; recheck: string | null; portfolio: string | null; worksheet: string | null };
  lines: PackLine[];
  limits: string[];
}

export interface CreatePackOptions {
  outDir: string;
  resultsPath: string;
  /** Import year (--year); also taken from the plan file, and the two must agree. */
  year?: number;
  /** Folder the results file's proof names are relative to (the manifest's folder); default the results file's folder. */
  proofsDir?: string;
  /** Folder every proof must be inside (default `proofsDir`): a name that leads outside it is refused. */
  proofsRoot?: string;
  /** More folders to look for evidence bundles in, after the proof's own folder (the CLI adds the demo's public folder). */
  evidenceDirs?: string[];
  recheckPath?: string;
  portfolioPath?: string;
  worksheetPath?: string;
  deployment: Deployment;
  /** Hash of the pinned block, when known; else read from `reader`. */
  blockHash?: Hex;
  reader?: ChainReader;
  maxFileBytes?: number;
  now?: Date;
}

/** JSON with every object's keys sorted, two-space indented, one final newline: the same value gives the same bytes. */
export function stableJson(x: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(x), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
}

const sha256Bytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * Reads a regular file that lies inside `root`, at most `maxBytes`. A symbolic link (the file itself), a path whose
 * real location is outside `root` (through `..`, an absolute name or a linked folder), a folder or a larger file is
 * refused, naming `what`.
 */
export function readInside(root: string, path: string, maxBytes: number, what: string): Buffer {
  const rootReal = realpathSync(resolve(root));
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`${what}: not found`);
  }
  if (st.isSymbolicLink()) throw new Error(`${what}: is a symbolic link; refused`);
  if (!st.isFile()) throw new Error(`${what}: not a regular file; refused`);
  if (!inside(realpathSync(path), rootReal)) throw new Error(`${what}: outside ${root}; refused`);
  if (st.size > maxBytes) throw new Error(`${what}: larger than ${maxBytes} bytes; refused`);
  const buf = readFileSync(path);
  if (buf.length > maxBytes) throw new Error(`${what}: larger than ${maxBytes} bytes; refused`);
  return buf;
}

/** A path a pack may list: segments of letters, digits, `_ . -` that do not start with a dot; no `..`, no leading `/`. */
export function isPackPath(p: unknown): p is string {
  return typeof p === "string" && p.length <= 512 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(p);
}

/** Every `{ bundle, sha256 }` reference in a proof, nested ones included (precursor proofs carry their own). */
function bundleRefs(x: unknown, out = new Map<string, string>(), depth = 0): Map<string, string> {
  if (!x || typeof x !== "object" || depth > 32) return out;
  const r = x as { bundle?: unknown; sha256?: unknown };
  if (typeof r.bundle === "string" && typeof r.sha256 === "string") {
    const prev = out.get(r.bundle);
    if (prev !== undefined && prev !== r.sha256.toLowerCase()) throw new Error(`the proof names ${r.bundle} with two different hashes; refused`);
    out.set(r.bundle, r.sha256.toLowerCase());
  }
  for (const v of Array.isArray(x) ? x : Object.values(x)) bundleRefs(v, out, depth + 1);
  return out;
}

const lineId = (r: BatchResult, i: number) => r.line?.id ?? r.proofShipment?.batchId ?? r.proof ?? `line-${i + 1}`;
const statusOf = (r: BatchResult): PackLine["verdict"] => (r.error ? "ERROR" : r.verdict ? r.verdict.overall : "NO_PROOF");

/**
 * Writes an audit pack to `outDir` (which must not exist or be empty; nothing is overwritten) and returns its
 * manifest and `pack.json`. Refuses, before writing anything: a results file that is not verify-batch output, a line
 * whose proof cannot be found inside `proofsRoot`, has other bytes than its `proofSha256` or has no digest at all
 * (results written before 17 October 2026: run verify-batch again), symbolic links, files over the size limit, a
 * deployment on another chain than the results, and import years that disagree.
 */
export async function createAuditPack(o: CreatePackOptions): Promise<{ manifest: PackManifest; pack: PackDocument; manifestSha256: string }> {
  const max = o.maxFileBytes ?? MAX_PACK_FILE_BYTES;
  const files = new Map<string, Buffer>();
  const add = (path: string, data: Buffer | string) => {
    if (!isPackPath(path)) throw new Error(`internal: ${path} is not a pack path`);
    if (files.has(path)) throw new Error(`two files would be written to ${path}; refused`);
    files.set(path, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  };
  const readArg = (path: string, what: string) => readInside(dirname(resolve(path)), resolve(path), max, what);

  // ------------------------------------------------------------------ inputs
  const resultsBytes = readArg(o.resultsPath, "results file");
  const doc = JSON.parse(resultsBytes.toString("utf8")) as BatchDocument;
  if (doc?.kind !== "carbonlei-batch" || !Array.isArray(doc.results)) throw new Error("not a carbonlei verify-batch results file");
  if (doc.chainId !== null && doc.chainId !== o.deployment.chainId) {
    throw new Error(`the results were verified on chain ${doc.chainId}, but the deployment is for chain ${o.deployment.chainId}; pass the deployment file they were verified with`);
  }
  add("inputs/results.json", resultsBytes);

  let recheck: RecheckDocument | undefined;
  if (o.recheckPath) {
    const b = readArg(o.recheckPath, "re-check file");
    recheck = JSON.parse(b.toString("utf8")) as RecheckDocument;
    if (recheck?.kind !== "carbonlei-recheck") throw new Error("--recheck: not a carbonlei recheck file");
    add("inputs/recheck.json", b);
  }
  let planYear: number | undefined;
  if (o.portfolioPath) {
    const b = readArg(o.portfolioPath, "plan file");
    const p = JSON.parse(b.toString("utf8")) as { year?: unknown; shipments?: unknown };
    if (typeof p?.year !== "number" || !Array.isArray(p.shipments)) throw new Error("--portfolio: not the JSON of carbonlei portfolio (--out or --json)");
    planYear = p.year;
    add("inputs/portfolio.json", b);
  }
  // The worksheet is copied byte for byte (portfolio already wrote it through csvField); it is not parsed.
  if (o.worksheetPath) add("inputs/worksheet.csv", readArg(o.worksheetPath, "worksheet"));

  if (o.year !== undefined && planYear !== undefined && o.year !== planYear) throw new Error(`--year ${o.year} differs from the plan's year ${planYear}; refused`);
  const year = o.year ?? planYear;
  if (year === undefined) throw new Error("no import year: pass --year <YYYY> (or --portfolio <summary.json>)");
  const { declarationYear, retainUntil } = retentionOf(year);

  // ------------------------------------------------------------------ proofs and their evidence
  const base = resolve(o.proofsDir ?? dirname(resolve(o.resultsPath)));
  const root = resolve(o.proofsRoot ?? base);
  const applied = recheck ? applyRecheck(doc, recheck) : doc;
  const width = Math.max(3, String(doc.results.length).length);
  const bundles = new Map<string, string>(); // pack path → sha256
  const lines: PackLine[] = doc.results.map((r, i) => {
    const line: PackLine = {
      line: i + 1,
      id: String(lineId(r, i)),
      proof: r.proof ?? null,
      packedAs: null,
      proofSha256: r.proofSha256 ?? null,
      verdict: statusOf(r),
      primaryCode: r.verdict?.primaryCode ?? "",
      credSAID: r.verdict?.credSAID ?? null,
      error: r.error ?? null,
      recheck: applied.results[i]?.recheck ? { change: applied.results[i].recheck!.change, severity: applied.results[i].recheck!.severity, checkedAt: applied.results[i].recheck!.checkedAt } : null,
      evidence: [],
      evidenceMissing: [],
    };
    if (!r.proof) return line;
    // A proof that could not be read when it was verified has no bytes to keep (verify-batch recorded no digest).
    if (r.error && !r.proofSha256) return line;
    if (typeof r.proof !== "string" || r.proof.includes("\0")) throw new Error(`line ${i + 1}: the proof name is not a file name; refused`);
    if (!r.proofSha256) throw new Error(`line ${i + 1} (${r.proof}): the results file records no proofSha256 (written before 17 October 2026); run verify-batch again so the pack holds the bytes that were verified`);
    const src = resolve(base, r.proof);
    const bytes = readInside(root, src, max, `line ${i + 1}: proof ${r.proof}`);
    if (sha256Hex(bytes.toString("utf8")) !== r.proofSha256) {
      throw new Error(`line ${i + 1}: proof ${r.proof} has other bytes than the ones verified (SHA-256 differs from proofSha256); refused`);
    }
    const name = basename(r.proof).replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    line.packedAs = `proofs/${String(i + 1).padStart(width, "0")}-${name}`;
    add(line.packedAs, bytes);
    let refs = new Map<string, string>();
    try {
      refs = bundleRefs(JSON.parse(bytes.toString("utf8")) as Presentation);
    } catch (e) {
      if (/refused$/.test((e as Error).message)) throw new Error(`line ${i + 1}: ${(e as Error).message}`);
    }
    for (const [ref, sha] of [...refs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const packPath = `proofs/${ref}`;
      if (!isSafeBundlePath(ref) || !isPackPath(packPath)) {
        line.evidenceMissing.push(ref);
        continue;
      }
      if (bundles.has(packPath)) {
        if (bundles.get(packPath) !== sha) throw new Error(`line ${i + 1}: ${ref} is named with another hash by an earlier line; refused`);
        line.evidence.push(packPath);
        continue;
      }
      let found: Buffer | undefined;
      for (const dir of [dirname(src), ...(o.evidenceDirs ?? [])]) {
        try {
          const b = readInside(dir, resolve(dir, ref), max, `line ${i + 1}: evidence ${ref}`);
          if (sha256Hex(b.toString("utf8")) === sha) {
            found = b;
            break;
          }
        } catch (e) {
          if (!/not found$/.test((e as Error).message)) throw e;
        }
      }
      if (!found) {
        line.evidenceMissing.push(ref);
        continue;
      }
      bundles.set(packPath, sha);
      add(packPath, found);
      line.evidence.push(packPath);
    }
    return line;
  });

  // ------------------------------------------------------------------ the pinned block
  let blockHash: Hex | null = null;
  let blockTimestamp: number | null = null;
  let blockHashSource: PackDocument["chain"]["blockHashSource"] = null;
  if (doc.pinnedBlock !== null) {
    if (o.blockHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(o.blockHash)) throw new Error(`--block-hash must be 0x and 64 hex digits, got ${o.blockHash}`);
      blockHash = o.blockHash.toLowerCase() as Hex;
      blockHashSource = "given";
    } else {
      if (!o.reader) throw new Error("the pinned block's hash is needed: pass an RPC (or --block-hash <0x…>)");
      const b = await o.reader.client.getBlock({ blockNumber: BigInt(doc.pinnedBlock) });
      if (!b?.hash) throw new Error(`the RPC returned no hash for block ${doc.pinnedBlock}`);
      blockHash = b.hash.toLowerCase() as Hex;
      blockTimestamp = Number(b.timestamp);
      blockHashSource = "chain";
    }
  }

  const pack: PackDocument = {
    format: AUDIT_PACK_FORMAT,
    kind: "carbonlei-audit-pack",
    tool: { ...TOOL },
    importYear: year,
    declarationYear,
    retainUntil,
    retentionRule: `The declaration for import year ${year} is submitted in ${declarationYear}; Art 7(6) and Art 9(2)-(3) keep the records until the end of the fourth year after that year: ${retainUntil}.`,
    legalBasis: LEGAL_BASIS,
    eori: doc.eori ?? null,
    chain: {
      chainId: o.deployment.chainId,
      contracts: { VerifierAllowlist: o.deployment.contracts.VerifierAllowlist.address, EmissionsClaimRegistry: o.deployment.contracts.EmissionsClaimRegistry.address },
      pinnedBlock: doc.pinnedBlock ?? null,
      blockHash,
      blockHashSource,
      blockTimestamp,
    },
    counts: doc.counts,
    inputs: {
      results: "inputs/results.json",
      recheck: recheck ? "inputs/recheck.json" : null,
      portfolio: files.has("inputs/portfolio.json") ? "inputs/portfolio.json" : null,
      worksheet: files.has("inputs/worksheet.csv") ? "inputs/worksheet.csv" : null,
    },
    lines,
    limits: [
      "manifest.json lists the SHA-256 and size of every other file: it shows whether a file changed after the manifest was written. It is not a signature and does not prove when the pack was made; keep the pack, or at least the manifest's own SHA-256, in a write-once (WORM) or archive system.",
      "The verdicts are those of carbonlei verify-batch at the pinned block; verify-pack re-runs the same verification at that block.",
      "Not a legal opinion and not a CBAM Registry submission. The verifier's report itself, and any record of a carbon price paid, are kept by the importer in its own records; this pack holds what CarbonLEI checked.",
    ],
  };
  add("pack.json", stableJson(pack));
  add("lines.csv", linesCsv(pack));
  add("README.txt", readmeText(pack));
  if (files.size > MAX_PACK_FILES) throw new Error(`${files.size} files: at most ${MAX_PACK_FILES} per pack`);

  const manifest: PackManifest = {
    format: AUDIT_PACK_FORMAT,
    kind: "carbonlei-audit-pack-manifest",
    algorithm: "sha256",
    createdAt: (o.now ?? new Date()).toISOString(),
    note: "SHA-256 and size of every file in this folder but manifest.json. Detects changes; not a signature, not a timestamp. Check with: carbonlei verify-pack <this folder>",
    files: [...files].map(([path, b]) => ({ path, sha256: sha256Bytes(b), size: b.length })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const manifestText = stableJson(manifest);

  // ------------------------------------------------------------------ write (nothing is overwritten)
  const out = resolve(o.outDir);
  let existing: string[] = [];
  try {
    if (lstatSync(out).isSymbolicLink()) throw new Error(`${o.outDir} is a symbolic link; write the pack to a new folder`);
    existing = readdirSync(out);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing.length) throw new Error(`${o.outDir} is not empty; write the pack to a new folder (nothing written)`);
  for (const [path, b] of [...files].sort(([a], [z]) => (a < z ? -1 : 1))) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), b, { flag: "wx" });
  }
  writeFileSync(join(out, "manifest.json"), manifestText, { flag: "wx" });
  return { manifest, pack, manifestSha256: sha256Bytes(Buffer.from(manifestText, "utf8")) };
}

/** One row per line (CSV injection guarded by `csvField`). */
export function linesCsv(p: PackDocument): string {
  const rows: (string | number | null)[][] = [
    [`# CarbonLEI audit pack, import year ${p.importYear}, keep until ${p.retainUntil}; verdicts at block ${p.chain.pinnedBlock ?? "-"} of chain ${p.chain.chainId}. Not a CBAM Registry submission`],
    ["line", "id", "proof", "packed_as", "proof_sha256", "verdict", "primary_code", "cred_said", "recheck", "evidence_missing", "error"],
  ];
  for (const l of p.lines) {
    rows.push([l.line, l.id, l.proof, l.packedAs, l.proofSha256, l.verdict, l.primaryCode, l.credSAID, l.recheck ? `${l.recheck.change} (${l.recheck.severity})` : "", l.evidenceMissing.join(" "), l.error]);
  }
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** The pack's README.txt: what it proves, what it does not, and how to check it. */
export function readmeText(p: PackDocument): string {
  const c = p.counts;
  return [
    `CarbonLEI audit pack - import year ${p.importYear}`,
    "",
    "WHAT THIS FOLDER IS",
    `The records an importer kept of the supplier proofs behind its CBAM declaration plan for ${p.importYear}: every proof file`,
    "a line was verified from (byte for byte), the evidence files those proofs refer to, the verify-batch results with each",
    "line's verdict, and the optional re-check, plan and worksheet files. lines.csv lists the lines; pack.json says the same",
    "in JSON, with the chain, the contract addresses and the block every verdict was read at.",
    "",
    "KEEP UNTIL",
    `${p.retainUntil}. ${p.retentionRule}`,
    ...p.legalBasis.map((s) => `  - ${s}`),
    "",
    "WHAT IT SHOWS",
    `- ${p.lines.length} line(s): ${c.VALID} VALID, ${c.INVALID} INVALID, ${c.CONTESTED} CONTESTED, ${c.INCOMPLETE} INCOMPLETE, ${c.ERROR} error, ${c.NO_PROOF} without proof.`,
    `- Chain ${p.chain.chainId}, VerifierAllowlist ${p.chain.contracts.VerifierAllowlist}, EmissionsClaimRegistry ${p.chain.contracts.EmissionsClaimRegistry}.`,
    `- Every verdict was read at block ${p.chain.pinnedBlock ?? "-"} (hash ${p.chain.blockHash ?? "-"}; ${p.chain.blockHashSource === "chain" ? "read from the chain when the pack was made" : p.chain.blockHashSource === "given" ? "given by the person who made the pack, not checked then" : "none"}).`,
    `- Made with ${p.tool.name} ${p.tool.version}.`,
    "",
    "WHAT IT DOES NOT SHOW",
    "- manifest.json holds the SHA-256 and size of every other file. It reveals a file changed after the manifest was written,",
    "  but it is not a signature and not a timestamp: someone who can change the files can also write a new manifest. Keep the",
    "  folder, or at least the SHA-256 of manifest.json, in a write-once (WORM) or archive system the company controls.",
    "- It is not a legal opinion and not a CBAM Registry submission. The verifier's report and any certified record of a carbon",
    "  price paid are part of the importer's own records; keep them with this folder.",
    "",
    "HOW TO RE-CHECK IT",
    "1. Files only, no network:   carbonlei verify-pack <this folder> --offline",
    "   Recomputes every SHA-256 and reports missing, extra and changed files. Add --expect-manifest <sha256> with the",
    "   fingerprint you archived to detect a rewritten manifest.",
    "2. Against the chain:        carbonlei verify-pack <this folder> [--rpc <full-history node>]",
    "   Also confirms the recorded block hash and re-verifies every proof at that block, MATCH or DIFFERS per line.",
    "   Use a node that keeps the full history; a pruned node cannot answer for an old block and the check fails closed.",
    "Without the CLI: sha256sum each file and compare with manifest.json.",
    "",
  ].join("\n");
}

// =================================================================== verify-pack

export interface OfflineReport {
  ok: boolean;
  /** SHA-256 of manifest.json as found. */
  manifestSha256: string | null;
  /** --expect-manifest given and different from manifestSha256. */
  manifestMismatch: boolean;
  missing: string[];
  extra: string[];
  changed: { path: string; detail: string }[];
  refused: string[];
  /** Consistency problems inside pack.json (a proof that does not hash to its line's digest, a wrong retention date). */
  inconsistent: string[];
  filesChecked: number;
}

/** Recursively lists a folder without following links; symbolic links and other non-files come back in `odd`. */
function walk(root: string, rel = "", depth = 0, acc = { files: [] as string[], odd: [] as string[] }) {
  if (depth > 16) {
    acc.odd.push(`${rel}: folders nested too deep`);
    return acc;
  }
  for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) acc.odd.push(`${p}: symbolic link`);
    else if (e.isDirectory()) walk(root, p, depth + 1, acc);
    else if (e.isFile()) acc.files.push(p);
    else acc.odd.push(`${p}: not a regular file`);
    if (acc.files.length + acc.odd.length > MAX_PACK_FILES + 1) throw new Error(`more than ${MAX_PACK_FILES} files in the pack; refused`);
  }
  return acc;
}

/** The pack's manifest and pack.json, read safely (no links, size-capped). Throws when either is unusable. */
export function readPack(dir: string, maxBytes = MAX_PACK_FILE_BYTES): { manifest: PackManifest; manifestText: Buffer; pack: PackDocument } {
  const root = resolve(dir);
  const manifestText = readInside(root, join(root, "manifest.json"), maxBytes, "manifest.json");
  const manifest = JSON.parse(manifestText.toString("utf8")) as PackManifest;
  if (manifest?.kind !== "carbonlei-audit-pack-manifest" || !Array.isArray(manifest.files)) throw new Error("manifest.json is not a carbonlei audit pack manifest");
  if (manifest.format !== AUDIT_PACK_FORMAT) throw new Error(`manifest.json has format ${manifest.format}; this tool reads format ${AUDIT_PACK_FORMAT}`);
  const pack = JSON.parse(readInside(root, join(root, "pack.json"), maxBytes, "pack.json").toString("utf8")) as PackDocument;
  if (pack?.kind !== "carbonlei-audit-pack" || !Array.isArray(pack.lines)) throw new Error("pack.json is not a carbonlei audit pack");
  return { manifest, manifestText, pack };
}

/**
 * Checks a pack without the network: every file the manifest lists exists, is a regular file inside the folder and
 * has the listed size and SHA-256; no other file is present; every listed path is a plain relative path (no `..`, no
 * absolute path, no link); each packed proof hashes to its line's `proofSha256`; the retention date follows from the
 * import year. `expectManifest`: the SHA-256 of manifest.json kept elsewhere, to detect a rewritten manifest.
 */
export function verifyPackOffline(dir: string, opts: { expectManifest?: string; maxFileBytes?: number } = {}): OfflineReport {
  const max = opts.maxFileBytes ?? MAX_PACK_FILE_BYTES;
  const root = resolve(dir);
  const rep: OfflineReport = { ok: false, manifestSha256: null, manifestMismatch: false, missing: [], extra: [], changed: [], refused: [], inconsistent: [], filesChecked: 0 };
  let manifest: PackManifest;
  let pack: PackDocument | undefined;
  try {
    const r = readPack(root, max);
    manifest = r.manifest;
    pack = r.pack;
    rep.manifestSha256 = sha256Bytes(r.manifestText);
  } catch (e) {
    rep.refused.push((e as Error).message);
    return rep;
  }
  if (opts.expectManifest && opts.expectManifest.toLowerCase() !== rep.manifestSha256) rep.manifestMismatch = true;
  const listed = new Map<string, PackFile>();
  for (const f of manifest.files) {
    if (!f || !isPackPath(f.path) || f.path === "manifest.json") {
      rep.refused.push(`manifest lists a path that is not allowed in a pack: ${JSON.stringify(f?.path)}`);
      continue;
    }
    if (listed.has(f.path)) {
      rep.refused.push(`manifest lists ${f.path} twice`);
      continue;
    }
    listed.set(f.path, f);
  }
  for (const req of ["pack.json", "README.txt", "inputs/results.json"]) if (!listed.has(req)) rep.refused.push(`manifest does not list ${req}`);
  let found: ReturnType<typeof walk>;
  try {
    found = walk(root);
  } catch (e) {
    rep.refused.push((e as Error).message);
    return rep;
  }
  rep.refused.push(...found.odd);
  const present = new Set(found.files);
  for (const p of found.files) if (p !== "manifest.json" && !listed.has(p)) rep.extra.push(p);
  for (const [path, f] of [...listed].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!present.has(path)) {
      if (!found.odd.some((o) => o.startsWith(`${path}:`))) rep.missing.push(path);
      continue;
    }
    try {
      const b = readInside(root, join(root, path), max, path);
      rep.filesChecked++;
      if (b.length !== f.size) rep.changed.push({ path, detail: `size ${b.length}, manifest says ${f.size}` });
      else if (sha256Bytes(b) !== String(f.sha256).toLowerCase()) rep.changed.push({ path, detail: "SHA-256 differs from the manifest" });
    } catch (e) {
      rep.refused.push((e as Error).message);
    }
  }
  // pack.json against the files it names (only meaningful once the files match the manifest).
  if (pack) {
    try {
      const { retainUntil } = retentionOf(pack.importYear);
      if (pack.retainUntil !== retainUntil) rep.inconsistent.push(`pack.json says keep until ${pack.retainUntil}; import year ${pack.importYear} gives ${retainUntil}`);
    } catch (e) {
      rep.inconsistent.push(`pack.json: ${(e as Error).message}`);
    }
    for (const l of pack.lines) {
      if (l.packedAs === null) continue;
      if (!isPackPath(l.packedAs) || !listed.has(l.packedAs)) {
        rep.inconsistent.push(`line ${l.line}: its proof ${JSON.stringify(l.packedAs)} is not a file of the manifest`);
        continue;
      }
      try {
        const text = readInside(root, join(root, l.packedAs), max, l.packedAs).toString("utf8");
        if (sha256Hex(text) !== l.proofSha256) rep.inconsistent.push(`line ${l.line}: ${l.packedAs} does not hash to the line's proofSha256`);
      } catch {
        /* reported above */
      }
    }
  }
  rep.ok = !rep.manifestMismatch && !rep.missing.length && !rep.extra.length && !rep.changed.length && !rep.refused.length && !rep.inconsistent.length;
  return rep;
}

export type LineOutcome = "MATCH" | "DIFFERS" | "ERROR" | "NOT_COMPARED";

export interface ChainReport {
  chainId: number;
  pinnedBlock: number | null;
  blockHash: { recorded: string | null; found: string | null; match: boolean };
  lines: { line: number; id: string; outcome: LineOutcome; stored: string; now: string | null; detail: string }[];
  counts: Record<LineOutcome, number>;
}

/** The parts of a verdict that must be equal for MATCH: overall, primary code, credential ID, block and each check. */
function verdictKey(v: Verdict) {
  return JSON.stringify([v.overall, v.primaryCode, v.credSAID, v.chain.block, v.checks.map((c) => [c.id, c.status, c.code])]);
}

/**
 * Re-checks a pack against the chain: the contracts and chain must be the reader's; the pinned block's hash must equal
 * the recorded one (otherwise no line is re-verified: the node is on another chain or fork); then each line that was
 * verified is verified again at that block, from the packed proof and evidence, with the stored EORI and trust anchor,
 * and compared with the stored verdict. Run `verifyPackOffline` first: this function trusts the files as they are.
 */
export async function verifyPackOnChain(
  dir: string,
  reader: ChainReader,
  opts: { concurrency?: number; within?: <T>(p: Promise<T>) => Promise<T> } = {},
): Promise<ChainReport> {
  const root = resolve(dir);
  const { pack } = readPack(root);
  const within = opts.within ?? (<T>(p: Promise<T>) => p);
  const counts: ChainReport["counts"] = { MATCH: 0, DIFFERS: 0, ERROR: 0, NOT_COMPARED: 0 };
  const rep: ChainReport = { chainId: pack.chain.chainId, pinnedBlock: pack.chain.pinnedBlock, blockHash: { recorded: pack.chain.blockHash, found: null, match: false }, lines: [], counts };
  const c = pack.chain.contracts;
  if (pack.chain.chainId !== reader.chainId || c.VerifierAllowlist?.toLowerCase() !== reader.allowlist.toLowerCase() || c.EmissionsClaimRegistry?.toLowerCase() !== reader.registry.toLowerCase()) {
    throw new Error(`the pack was made for chain ${pack.chain.chainId} and contracts ${c.VerifierAllowlist} / ${c.EmissionsClaimRegistry}; pass that deployment file (--deployment)`);
  }
  const results = (JSON.parse(readInside(root, join(root, pack.inputs.results), MAX_PACK_FILE_BYTES, pack.inputs.results).toString("utf8")) as BatchDocument).results;
  const notCompared = (l: PackLine, detail: string) => ({ line: l.line, id: l.id, outcome: "NOT_COMPARED" as const, stored: l.verdict, now: null, detail });
  if (pack.chain.pinnedBlock === null || !pack.chain.blockHash) {
    rep.lines = pack.lines.map((l) => notCompared(l, "the pack records no pinned block and hash"));
  } else {
    const block = await within(reader.client.getBlock({ blockNumber: BigInt(pack.chain.pinnedBlock) }));
    rep.blockHash.found = block?.hash?.toLowerCase() ?? null;
    rep.blockHash.match = rep.blockHash.found !== null && rep.blockHash.found === pack.chain.blockHash.toLowerCase();
    if (!rep.blockHash.match) {
      rep.lines = pack.lines.map((l) => notCompared(l, "not re-verified: the block hash differs"));
    } else {
      const head = pinnedToHead(reader, { number: block.number as bigint, timestamp: block.timestamp });
      const loadBundle = sandboxedLoader(join(root, "proofs"));
      rep.lines = await runLimited(pack.lines, opts.concurrency ?? 2, async (l) => {
        const stored = results[l.line - 1]?.verdict;
        if (!l.packedAs) return notCompared(l, l.proof ? "proof not packed" : "no proof");
        if (!stored) return notCompared(l, `no stored verdict (${l.verdict}${l.error ? `: ${l.error}` : ""})`);
        try {
          const proofText = readInside(root, join(root, l.packedAs), MAX_PACK_FILE_BYTES, l.packedAs).toString("utf8");
          if (sha256Hex(proofText) !== l.proofSha256) throw new Error(`${l.packedAs} does not hash to the line's proofSha256`);
          const v = await within(
            verdictFor(JSON.parse(proofText) as Presentation, head, {
              importerEORI: pack.eori ?? undefined,
              loadBundle,
              ...(stored.trustAnchor ? { trustAnchor: stored.trustAnchor } : {}),
              // The pinned block is old by design; the head-age limit is for live verifications.
              maxHeadAgeSec: Infinity,
              proofText,
            }),
          );
          const same = verdictKey(v) === verdictKey(stored);
          const now = `${v.overall}${v.primaryCode ? ` (${v.primaryCode})` : ""}`;
          const was = `${stored.overall}${stored.primaryCode ? ` (${stored.primaryCode})` : ""}`;
          const diff = same ? "" : v.checks.filter((x) => { const s = stored.checks.find((y) => y.id === x.id); return !s || s.status !== x.status || s.code !== x.code; }).map((x) => `check ${x.id} now ${x.status}${x.code ? ` ${x.code}` : ""}`).join("; ");
          return { line: l.line, id: l.id, outcome: same ? ("MATCH" as const) : ("DIFFERS" as const), stored: was, now, detail: same ? "same verdict at the pinned block" : diff || "overall, code or credential differs" };
        } catch (e) {
          return { line: l.line, id: l.id, outcome: "ERROR" as const, stored: l.verdict, now: null, detail: (e as Error).message };
        }
      });
    }
  }
  for (const l of rep.lines) counts[l.outcome]++;
  return rep;
}

/** Exit code of verify-pack: 1 on any change, refusal or difference, else 3 if a re-verification could not run, else 0. */
export function verifyPackExitCode(off: OfflineReport, chain?: ChainReport): number {
  if (!off.ok) return EXIT.INVALID;
  if (chain && (!chain.blockHash.match && chain.pinnedBlock !== null)) return EXIT.INVALID;
  if (chain?.counts.DIFFERS) return EXIT.INVALID;
  if (chain?.counts.ERROR) return EXIT.ERROR;
  return EXIT.VALID;
}

/** verify-pack for the terminal. */
export function printVerifyPack(dir: string, off: OfflineReport, chain?: ChainReport): string {
  const L = [`Audit pack ${relative(process.cwd(), resolve(dir)) || "."}: manifest SHA-256 ${off.manifestSha256 ?? "-"}`];
  if (off.manifestMismatch) L.push("CHANGED   manifest.json: its SHA-256 differs from --expect-manifest");
  for (const r of off.refused) L.push(`REFUSED   ${r}`);
  for (const m of off.missing) L.push(`MISSING   ${m}`);
  for (const x of off.extra) L.push(`EXTRA     ${x}`);
  for (const c of off.changed) L.push(`CHANGED   ${c.path} — ${c.detail}`);
  for (const i of off.inconsistent) L.push(`MISMATCH  ${i}`);
  L.push(off.ok ? `Files: ${off.filesChecked} file(s) match the manifest` : "Files: the pack does NOT match its manifest");
  if (chain) {
    L.push(`Block ${chain.pinnedBlock ?? "-"} on chain ${chain.chainId}: hash ${chain.blockHash.match ? "matches" : `DIFFERS (recorded ${chain.blockHash.recorded ?? "-"}, chain ${chain.blockHash.found ?? "-"})`}`);
    for (const l of chain.lines) L.push(`${l.outcome.padEnd(12)} line ${l.line} ${l.id}: stored ${l.stored}${l.now ? `, now ${l.now}` : ""} — ${l.detail}`);
    const k = chain.counts;
    L.push(`${chain.lines.length} line(s): ${k.MATCH} match, ${k.DIFFERS} differ, ${k.ERROR} could not be re-verified, ${k.NOT_COMPARED} not compared`);
  } else if (off.ok) L.push("Chain: not checked (--offline)");
  return L.join("\n");
}
