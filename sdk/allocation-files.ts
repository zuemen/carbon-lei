// File side of the supplier portal (sdk/allocation.ts): reads the allocation book and its credential, writes a share
// pack (one proof file per batch and a manifest). Node only; the demo uses sdk/allocation.ts directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseBook, type AllocationBook, type ProofEvidence, type SharePackProof } from "./allocation.ts";
import type { Presentation } from "./disclosure.ts";
import type { SignedCredential } from "./issue.ts";

/** The book and its credential: `--credential` if given, else the book's `credential` path (relative to the book). */
export function loadBook(bookPath: string, credentialPath?: string): { book: AllocationBook; cred: SignedCredential } {
  const book = parseBook(JSON.parse(readFileSync(bookPath, "utf8")));
  const credFile = credentialPath ?? (book.credential ? resolve(dirname(bookPath), book.credential) : undefined);
  if (!credFile) throw new Error("no credential: pass --credential <credential.json> or set \"credential\" in the book");
  const file = JSON.parse(readFileSync(credFile, "utf8"));
  const raw = file.credential ?? file;
  // `carbonlei issue` output ({ credential }) or a bare credential; also the recorded Sepolia fixture shape
  // (fixtures/sepolia-credential.json: coreJson without the parsed core).
  const cred = (raw?.coreJson && !raw.core ? { ...raw, core: JSON.parse(raw.coreJson) } : raw) as SignedCredential;
  if (!cred?.core?.d || !cred?.claims?.batchSalt || !cred?.disclosures) throw new Error(`${credFile} is not a credential from carbonlei issue (needs core, claims and disclosures)`);
  return { book, cred };
}

/** Evidence of an existing proof of the same credential, to attach to every proof of the pack (checks 6-9). */
export function evidenceFrom(proofPath: string, cred: SignedCredential): ProofEvidence {
  const p = JSON.parse(readFileSync(proofPath, "utf8")) as Presentation;
  if (JSON.parse(p.core).d !== cred.core.d) throw new Error(`${proofPath} is a proof of another credential`);
  return {
    ...(p.anchorEvidence ? { anchorEvidence: p.anchorEvidence } : {}),
    ...(p.authorityEvidence ? { authorityEvidence: p.authorityEvidence } : {}),
    ...(p.reportExtract ? { reportExtract: p.reportExtract } : {}),
    ...(p.precursorEvidence ? { precursorEvidence: p.precursorEvidence } : {}),
  };
}

export interface SharePackManifest {
  credSAID: string;
  createdAt: string;
  /** Per proof: who it is for (the book's local id and name), the batch, the file and the fields it discloses. No EORI, no salt. */
  proofs: { importer: string; importerName?: string; batchId: string; file: string; fields: string[] }[];
  skipped: { batchId: string; reason: string }[];
  /** With `present-batch --request`: the request answered and its lines the book has no batch for. */
  request?: { requestId: string; notInBook: { lineId: string; reference: string; reason: string }[] };
}

/**
 * Writes each proof to `<dir>/<file>` and `<dir>/share-pack.json`; returns the manifest. Refuses (before writing
 * anything) a pack that names one file twice or a proof file that already exists: a proof is never overwritten.
 */
export function writeSharePack(
  dir: string,
  book: AllocationBook,
  cred: SignedCredential,
  pack: { proofs: SharePackProof[]; skipped: { batchId: string; reason: string }[] },
  now = new Date(),
  request?: SharePackManifest["request"],
): SharePackManifest {
  const seen = new Set<string>();
  if (existsSync(resolve(dir, "share-pack.json"))) throw new Error(`share pack: ${resolve(dir, "share-pack.json")} already exists; write the pack to a new folder (nothing written)`);
  for (const p of pack.proofs) {
    if (seen.has(p.file)) throw new Error(`share pack: the file name ${p.file} is used twice; nothing written`);
    seen.add(p.file);
    if (existsSync(resolve(dir, p.file))) throw new Error(`share pack: ${resolve(dir, p.file)} already exists; write the pack to a new folder (nothing written)`);
  }
  mkdirSync(dir, { recursive: true });
  const names = new Map(book.importers.map((i) => [i.id, i.name]));
  // "wx": fail rather than overwrite, should a file appear between the check above and the write.
  for (const p of pack.proofs) writeFileSync(resolve(dir, p.file), JSON.stringify(p.proof, null, 2) + "\n", { flag: "wx" });
  const manifest: SharePackManifest = {
    credSAID: cred.core.d,
    createdAt: now.toISOString(),
    proofs: pack.proofs.map((p) => ({ importer: p.importer, ...(names.get(p.importer) ? { importerName: names.get(p.importer) } : {}), batchId: p.batchId, file: p.file, fields: p.fields })),
    skipped: pack.skipped,
    ...(request ? { request } : {}),
  };
  writeFileSync(resolve(dir, "share-pack.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}
