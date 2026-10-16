// `carbonlei recheck`: reading accepted records from files (Node only; sdk/recheck.ts itself has no file system so
// the browser demo can use it).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { sha256Hex } from "./encoding.ts";
import { MAX_RECORDS, recordsFromJson, type AcceptedRecord } from "./recheck.ts";

/**
 * Reads a file or a folder of records (every .json file, in name order). A `verify-batch` results file names each
 * proof as given to verify-batch: it is looked up next to the results file, then in `proofsDir`, then in the
 * current directory. When the results file recorded the proof's SHA-256, the first file of that name whose bytes
 * hash to it is used; a file of that name with other bytes is never taken for it (the re-check of that line then
 * fails, RECHECK_FAILED). A proof not found at all leaves the record to a ledger-only re-check.
 */
export function loadRecords(target: string, opts: { proofsDir?: string } = {}): { records: AcceptedRecord[]; skipped: string[] } {
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((n) => n.endsWith(".json"))
        .sort()
        .map((n) => resolve(target, n))
    : [resolve(target)];
  const out = { records: [] as AcceptedRecord[], skipped: [] as string[] };
  for (const file of files) {
    const name = basename(file);
    let x: unknown;
    try {
      x = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      out.skipped.push(`${name}: not JSON (${(e as Error).message})`);
      continue;
    }
    const bases = [dirname(file), ...(opts.proofsDir ? [resolve(opts.proofsDir)] : []), process.cwd()];
    const findProof = (p: string, sha256: string | null) => {
      let first: { path: string; text: string } | null = null;
      for (const b of bases) {
        const path = resolve(b, p);
        if (!existsSync(path) || !statSync(path).isFile()) continue;
        const text = readFileSync(path, "utf8");
        if (sha256 === null || sha256Hex(text) === sha256) return { path, text };
        first ??= { path, text };
      }
      // Only files of that name with other bytes: returned so the re-check reports the mismatch instead of a verdict.
      return first;
    };
    const r = recordsFromJson(x, name, findProof);
    // A Buyer record's evidence bundles are read relative to the record file.
    for (const rec of r.records) if (rec.proof && !rec.proofPath) rec.proofPath = file;
    out.records.push(...r.records);
    out.skipped.push(...r.skipped);
  }
  if (out.records.length > MAX_RECORDS) throw new Error(`${out.records.length} records: at most ${MAX_RECORDS} per run`);
  return out;
}
