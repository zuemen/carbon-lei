// Audit evidence pack (sdk/audit-pack.ts): `carbonlei audit-pack` and `verify-pack` end to end on recorded Sepolia
// answers, deterministic output, the retention date of Reg. (EU) 2023/956 Art 7(6), every tamper type verify-pack must
// detect, the inputs audit-pack must refuse, a block-hash mismatch and a stored verdict that differs from the chain.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAuditPack,
  isPackPath,
  retentionOf,
  verifyPackExitCode,
  verifyPackOffline,
  verifyPackOnChain,
  type PackDocument,
  type PackManifest,
} from "../audit-pack.ts";
import type { BatchDocument } from "../batch.ts";
import { ChainReader, type Deployment } from "../chain.ts";
import type { Hex } from "../credential.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const replay = pathToFileURL(fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url))).href;
const dir = fileURLToPath(new URL("../../.cache/audit-pack-test/", import.meta.url));
const deployment = JSON.parse(readFileSync(`${root}contracts/deployments/11155111.json`, "utf8")) as Deployment;
const recorded = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url)), "utf8"));
const head = recorded.answers['eth_getBlockByNumber ["latest",false]'].result;
const HASH = head.hash as Hex;
// The recording read the head as "latest"; audit-pack and verify-pack read the same block by its number.
const rpc = `${dir}rpc.json`;
const env = () => ({ ...process.env, RPC_REPLAY: rpc });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const pack = `${dir}pack/`;
let results: BatchDocument;

/** A fresh copy of the CLI-made pack, for one tamper case. */
function copyPack(name: string): string {
  const to = `${dir}t-${name}/`;
  rmSync(to, { recursive: true, force: true });
  cpSync(pack, to, { recursive: true });
  return to;
}

/** Writes a results document next to nothing else, and returns its path. */
function resultsAt(name: string, doc: BatchDocument): string {
  mkdirSync(`${dir}${name}`, { recursive: true });
  const p = `${dir}${name}/results.json`;
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

const opts = (resultsPath: string, outDir: string) => ({
  outDir,
  resultsPath,
  year: 2026,
  proofsDir: `${root}fixtures/workbench`,
  proofsRoot: `${root}fixtures`,
  deployment,
  blockHash: HASH,
});

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(rpc, JSON.stringify({ ...recorded, answers: { ...recorded.answers, [`eth_getBlockByNumber ["${head.number}",false]`]: { result: head } } }));
  const vb = await run(process.execPath, ["--import", replay, cli, "verify-batch", `${root}fixtures/workbench/manifest.json`, "--out", `${dir}results.json`], { env: env() }).catch((e) => e);
  expect(vb.code).toBe(1); // line 2 is the tampered copy
  results = readJson(`${dir}results.json`);
  const ap = await run(
    process.execPath,
    ["--import", replay, cli, "audit-pack", `${dir}results.json`, "--year", "2026", "--proofs", `${root}fixtures/workbench`, "--proofs-root", `${root}fixtures`, "--out", pack],
    { env: env() },
  );
  expect(ap.stdout).toContain("keep until 2031-12-31");
}, 400_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retention date (Reg. (EU) 2023/956 Art 7(6), Art 9(2)-(3))", () => {
  it("import year Y: declaration in Y+1, records kept until 31 December of Y+5", () => {
    expect(retentionOf(2026)).toEqual({ declarationYear: 2027, retainUntil: "2031-12-31" });
    expect(retentionOf(2030)).toEqual({ declarationYear: 2031, retainUntil: "2035-12-31" });
    expect(() => retentionOf(2025)).toThrow(/from 2026/);
    expect(() => retentionOf(2026.5)).toThrow();
  });
});

describe("carbonlei audit-pack and verify-pack (recorded Sepolia answers)", () => {
  it("writes the pack: results, both proofs, their evidence, the block hash read from the chain, retention, manifest", async () => {
    const m = readJson(`${pack}manifest.json`) as PackManifest;
    const p = readJson(`${pack}pack.json`) as PackDocument;
    expect(m.files.map((f) => f.path)).toEqual([
      "README.txt",
      "inputs/results.json",
      "lines.csv",
      "pack.json",
      "proofs/001-sepolia-demo-proof.json",
      "proofs/002-sepolia-demo-proof.tampered.json",
      "proofs/evidence/authority-bundle.json",
    ]);
    for (const f of m.files) expect([f.sha256, f.size]).toEqual([sha(readFileSync(`${pack}${f.path}`)), readFileSync(`${pack}${f.path}`).length]);
    expect(readFileSync(`${pack}inputs/results.json`)).toEqual(readFileSync(`${dir}results.json`));
    expect(p).toMatchObject({ importYear: 2026, declarationYear: 2027, retainUntil: "2031-12-31", eori: "NLDEMO000000001", tool: { name: "carbonlei" } });
    expect(p.chain).toEqual({
      chainId: 11155111,
      contracts: { VerifierAllowlist: deployment.contracts.VerifierAllowlist.address, EmissionsClaimRegistry: deployment.contracts.EmissionsClaimRegistry.address },
      pinnedBlock: Number(BigInt(head.number)),
      blockHash: HASH,
      blockHashSource: "chain",
      blockTimestamp: Number(BigInt(head.timestamp)),
    });
    expect(p.lines.map((l) => [l.verdict, l.packedAs, l.evidence])).toEqual([
      ["VALID", "proofs/001-sepolia-demo-proof.json", ["proofs/evidence/authority-bundle.json"]],
      ["INVALID", "proofs/002-sepolia-demo-proof.tampered.json", ["proofs/evidence/authority-bundle.json"]],
      ["NO_PROOF", null, []],
    ]);
    expect(p.legalBasis.join(" ")).toContain("until the end of the fourth year after the year in which the CBAM declaration has been or should have been submitted");
    const readme = readFileSync(`${pack}README.txt`, "utf8");
    expect(readme).toContain("not a signature and not a timestamp");
    expect(readme).toContain("not a legal opinion and not a CBAM Registry submission");
  });

  it("verify-pack: the files match and every verified line gives the same verdict at the pinned block (exit 0)", async () => {
    const r = await run(process.execPath, ["--import", replay, cli, "verify-pack", pack, "--json"], { env: env() });
    const out = JSON.parse(r.stdout);
    expect(out.offline.ok).toBe(true);
    expect(out.chain.blockHash).toEqual({ recorded: HASH, found: HASH, match: true });
    expect(out.chain.lines.map((l: { outcome: string }) => l.outcome)).toEqual(["MATCH", "MATCH", "NOT_COMPARED"]);
    const text = await run(process.execPath, [cli, "verify-pack", pack, "--offline"]);
    expect(text.stdout).toContain("Files: 7 file(s) match the manifest");
  }, 300_000);

  it("is deterministic: the same inputs give the same bytes; only the manifest's createdAt differs", async () => {
    const a = await createAuditPack({ ...opts(`${dir}results.json`, `${dir}det-a`), now: new Date("2027-01-01T00:00:00Z") });
    const b = await createAuditPack({ ...opts(`${dir}results.json`, `${dir}det-b`), now: new Date("2031-06-30T12:00:00Z") });
    expect(a.manifest.files).toEqual(b.manifest.files);
    expect({ ...a.manifest, createdAt: "" }).toEqual({ ...b.manifest, createdAt: "" });
    for (const f of a.manifest.files) expect(readFileSync(`${dir}det-a/${f.path}`)).toEqual(readFileSync(`${dir}det-b/${f.path}`));
    expect(a.pack.chain.blockHashSource).toBe("given");
    // The CLI pack read the hash from the chain (and its timestamp): only pack.json and README.txt differ from it.
    const cliFiles = (readJson(`${pack}manifest.json`) as PackManifest).files;
    expect(a.manifest.files.filter((f) => !cliFiles.some((g) => g.path === f.path && g.sha256 === f.sha256)).map((f) => f.path)).toEqual(["README.txt", "pack.json"]);
  });
});

describe("verify-pack detects every change (offline)", () => {
  it("a changed byte, a deleted file, an extra file", () => {
    const changed = copyPack("byte");
    const f = `${changed}proofs/001-sepolia-demo-proof.json`;
    const b = readFileSync(f);
    b[10] = b[10] ^ 1;
    writeFileSync(f, b);
    const r1 = verifyPackOffline(changed);
    expect(r1.ok).toBe(false);
    expect(r1.changed).toEqual([{ path: "proofs/001-sepolia-demo-proof.json", detail: "SHA-256 differs from the manifest" }]);
    expect(r1.inconsistent[0]).toMatch(/line 1: .* does not hash to the line's proofSha256/);
    expect(verifyPackExitCode(r1)).toBe(1);

    const deleted = copyPack("deleted");
    unlinkSync(`${deleted}proofs/evidence/authority-bundle.json`);
    expect(verifyPackOffline(deleted)).toMatchObject({ ok: false, missing: ["proofs/evidence/authority-bundle.json"] });

    const extra = copyPack("extra");
    writeFileSync(`${extra}proofs/003-forged.json`, "{}");
    expect(verifyPackOffline(extra)).toMatchObject({ ok: false, extra: ["proofs/003-forged.json"] });
  });

  it("a manifest edit: a changed hash is caught; a consistently rewritten manifest only by the archived fingerprint", () => {
    const edited = copyPack("manifest");
    const m = readJson(`${edited}manifest.json`) as PackManifest;
    const original = sha(readFileSync(`${edited}manifest.json`));
    m.files[0].sha256 = "0".repeat(64);
    writeFileSync(`${edited}manifest.json`, JSON.stringify(m));
    expect(verifyPackOffline(edited).changed.map((c) => c.path)).toEqual(["README.txt"]);

    // Someone rewrites a file and the manifest to match: the hashes agree, and only --expect-manifest shows it.
    const rewritten = copyPack("rewritten");
    writeFileSync(`${rewritten}README.txt`, "nothing to see\n");
    const m2 = readJson(`${rewritten}manifest.json`) as PackManifest;
    m2.files[0] = { path: "README.txt", sha256: sha("nothing to see\n"), size: 15 };
    writeFileSync(`${rewritten}manifest.json`, JSON.stringify(m2));
    expect(verifyPackOffline(rewritten).ok).toBe(true);
    expect(verifyPackOffline(rewritten, { expectManifest: original })).toMatchObject({ ok: false, manifestMismatch: true });
    expect(verifyPackOffline(pack, { expectManifest: original }).ok).toBe(true);
  });

  it("a manifest that lists ../ or absolute paths is refused, and so is a symbolic link", async () => {
    const dots = copyPack("dots");
    const m = readJson(`${dots}manifest.json`) as PackManifest;
    m.files.push({ path: "../results.json", sha256: sha(readFileSync(`${dir}results.json`)), size: readFileSync(`${dir}results.json`).length });
    m.files.push({ path: "/etc/hosts", sha256: "0".repeat(64), size: 1 });
    writeFileSync(`${dots}manifest.json`, JSON.stringify(m));
    const r = verifyPackOffline(dots);
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual([
      'manifest lists a path that is not allowed in a pack: "../results.json"',
      'manifest lists a path that is not allowed in a pack: "/etc/hosts"',
    ]);
    for (const p of ["../x", "a/../b", "./a", ".hidden", "a//b", "/a", "a\\b"]) expect(isPackPath(p), p).toBe(false);

    // A listed file replaced by a link to a copy with the same bytes outside the pack: refused, not followed.
    const linked = copyPack("link");
    const outside = `${dir}outside-proof.json`;
    cpSync(`${linked}proofs/001-sepolia-demo-proof.json`, outside);
    unlinkSync(`${linked}proofs/001-sepolia-demo-proof.json`);
    symlinkSync(outside, `${linked}proofs/001-sepolia-demo-proof.json`);
    const rl = verifyPackOffline(linked);
    expect(rl.ok).toBe(false);
    expect(rl.refused).toContain("proofs/001-sepolia-demo-proof.json: symbolic link");
    expect(rl.missing).toEqual([]);
    const cliRun = await run(process.execPath, [cli, "verify-pack", linked]).catch((e) => e);
    expect(cliRun.code).toBe(1);
    expect(cliRun.stdout).toContain("REFUSED   proofs/001-sepolia-demo-proof.json: symbolic link");
  }, 120_000);
});

describe("audit-pack refuses unsafe inputs (nothing written)", () => {
  const withProof = (name: string, proof: string, over: Partial<BatchDocument["results"][number]> = {}) =>
    resultsAt(name, { ...results, results: [{ ...results.results[0], proof, ...over }] });

  it("a proof name that leads outside --proofs-root, through ../ or an absolute path", async () => {
    await expect(createAuditPack(opts(withProof("trav", "../../sdk/package.json"), `${dir}o-trav`))).rejects.toThrow(/line 1: proof \.\.\/\.\.\/sdk\/package\.json: outside .*; refused/);
    await expect(createAuditPack(opts(withProof("abs", "/etc/hosts"), `${dir}o-abs`))).rejects.toThrow(/outside .*; refused/);
    expect(() => readdirSync(`${dir}o-trav`)).toThrow();
  });

  it("a symbolic link, an oversize file, other bytes than verified, no digest, a non-empty output folder", async () => {
    mkdirSync(`${dir}src`, { recursive: true });
    symlinkSync(`${root}fixtures/sepolia-demo-proof.json`, `${dir}src/link.json`);
    const link = resultsAt("link", { ...results, results: [{ ...results.results[0], proof: "link.json" }] });
    await expect(createAuditPack({ ...opts(link, `${dir}o-link`), proofsDir: `${dir}src`, proofsRoot: `${dir}src` })).rejects.toThrow(/link\.json: is a symbolic link; refused/);

    await expect(createAuditPack({ ...opts(`${dir}results.json`, `${dir}o-big`), maxFileBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes; refused/);

    const other = withProof("other", "../sepolia-demo-proof.tampered.json"); // line 1's digest, line 2's bytes
    await expect(createAuditPack(opts(other, `${dir}o-other`))).rejects.toThrow(/other bytes than the ones verified/);

    const old = withProof("old", "../sepolia-demo-proof.json", { proofSha256: undefined });
    await expect(createAuditPack(opts(old, `${dir}o-old`))).rejects.toThrow(/records no proofSha256 .* run verify-batch again/);

    mkdirSync(`${dir}o-full`, { recursive: true });
    writeFileSync(`${dir}o-full/keep.txt`, "x");
    await expect(createAuditPack(opts(`${dir}results.json`, `${dir}o-full`))).rejects.toThrow(/is not empty/);
    expect(readdirSync(`${dir}o-full`)).toEqual(["keep.txt"]);

    await expect(createAuditPack({ ...opts(`${dir}results.json`, `${dir}o-y`), year: 2025 })).rejects.toThrow(/from 2026/);
    await expect(createAuditPack({ ...opts(`${dir}results.json`, `${dir}o-chain`), deployment: { ...deployment, chainId: 1 } })).rejects.toThrow(/verified on chain 11155111/);
  });

  it("lines.csv guards against formula injection (csvField)", async () => {
    const evil = resultsAt("evil", { ...results, results: [results.results[0], { ...results.results[2], line: { ...results.results[2].line, id: "=HYPERLINK(\"http://x\")" } }] });
    await createAuditPack(opts(evil, `${dir}o-evil`));
    const row = readFileSync(`${dir}o-evil/lines.csv`, "utf8").split("\r\n")[3];
    expect(row).toMatch(/^2,"'=HYPERLINK\(""http:\/\/x""\)",/);
  });
});

describe("verify-pack against the chain fails closed", () => {
  const reader = () => {
    vi.stubGlobal("fetch", replayFetch(rpc));
    return ChainReader.forSepolia(deployment);
  };

  it("a recorded block hash that differs from the chain: no line is re-verified, exit 1", async () => {
    await createAuditPack({ ...opts(`${dir}results.json`, `${dir}o-hash`), blockHash: `0x${"11".repeat(32)}` as Hex });
    const off = verifyPackOffline(`${dir}o-hash`);
    expect(off.ok).toBe(true);
    const ch = await verifyPackOnChain(`${dir}o-hash`, reader());
    expect(ch.blockHash).toEqual({ recorded: `0x${"11".repeat(32)}`, found: HASH, match: false });
    expect(ch.lines.every((l) => l.outcome === "NOT_COMPARED")).toBe(true);
    expect(verifyPackExitCode(off, ch)).toBe(1);
  }, 120_000);

  it("a stored verdict the chain does not reproduce is DIFFERS (exit 1); the others MATCH", async () => {
    const forged = structuredClone(results);
    const v = forged.results[1].verdict!;
    v.overall = "VALID";
    v.primaryCode = "";
    v.checks = v.checks.map((c) => ({ ...c, status: "pass", code: "" }));
    await createAuditPack(opts(resultsAt("forged", forged), `${dir}o-forged`));
    const ch = await verifyPackOnChain(`${dir}o-forged`, reader());
    expect(ch.blockHash.match).toBe(true);
    expect(ch.lines.map((l) => l.outcome)).toEqual(["MATCH", "DIFFERS", "NOT_COMPARED"]);
    expect(ch.lines[1]).toMatchObject({ stored: "VALID", now: "INVALID (DISCLOSURE_TAMPERED)" });
    expect(ch.lines[1].detail).toMatch(/check \d+ now fail DISCLOSURE_TAMPERED/);
    expect(verifyPackExitCode(verifyPackOffline(`${dir}o-forged`), ch)).toBe(1);
    // A pack for other contracts is refused before anything is read.
    await expect(verifyPackOnChain(`${dir}o-forged`, ChainReader.forSepolia({ ...deployment, contracts: { ...deployment.contracts, EmissionsClaimRegistry: { address: `0x${"22".repeat(20)}`, block: 1 } } }))).rejects.toThrow(/pass that deployment file/);
  }, 120_000);
});
