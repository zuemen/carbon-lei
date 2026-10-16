// Regression tests for our own AI-run security review of 17 October 2026 (not an external audit; docs/SECURITY.md ›
// "Review of 17 October 2026"). Each test is the review's proof of concept turned into a test: it failed on the code
// before the fix (commit 1b6b5c9) and passes after it.
//   #1 one VALID proof on several manifest lines counted its claimed tonnes once per line
//   #2 recheck re-verified another file with the same name and portfolio --recheck lifted a tampered line to VALID
//   #7 POST /v1/portfolio trusted caller-supplied verdicts
//   #8 a slow upload held a concurrency slot of the REST API for the whole request timeout
//   #9 share-pack file names could collide and overwrite each other
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { proofFileName } from "../allocation.ts";
import { writeSharePack } from "../allocation-files.ts";
import { shipmentsFromBatch, type BatchDocument } from "../batch.ts";
import { buildPortfolio, type ShipmentInput } from "../portfolio.ts";
import { applyRecheck, type RecheckDocument, type RecheckResult } from "../recheck.ts";
import { createApiServer } from "../server.ts";
import type { Verdict } from "../verdict.ts";
import { portfolioSchemaErrors } from "./helpers/portfolio-schema.ts";
import { recheckSchemaErrors } from "./helpers/recheck-schema.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const replay = pathToFileURL(fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url))).href;
const dir = fileURLToPath(new URL("../../.cache/secrev-2026-10-17/", import.meta.url));
const env = { ...process.env, RPC_REPLAY: recording };
const ORIGINAL = `${root}fixtures/sepolia-demo-proof.json`;
const TAMPERED = `${root}fixtures/sepolia-demo-proof.tampered.json`;

/** A VALID verdict with check 5 passed for credential `said`. */
function valid(said: string): Verdict {
  return {
    format: 2, overall: "VALID", primaryCode: "",
    checks: [0, 1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `check ${id}`, status: "pass" as const, code: "", detail: "" })),
    hidden: 0, rejected: 0,
    disclosed: { cnCode: "7318", unLocode: "TWKHH", specificEmbeddedEmissions_tCO2e_per_t: "1.8", valueType: "actual" },
    credSAID: said, chain: { chainId: 11155111, block: 100 }, checkedAt: 1, warnings: [], trustAnchor: null, tool: { name: "carbonlei", version: "0.1.0" },
  };
}
/** The verdict with a passed check 10 (a carbon price statement of €10 per tonne of good), for the Art 9 block. */
const withCarbonPrice = (v: Verdict): Verdict =>
  ({ ...v, checks: [...v.checks, { id: 10, name: "check 10", status: "pass", code: "", detail: "" }], carbonPrice: { mechanism: "ETS", statementSAID: "Estatement", deductibleEurPerTonneGood: "10" } }) as unknown as Verdict;
const shipment = (id: string, q: string, batch: string, said = "Ecred", claimed = "200"): ShipmentInput => ({
  id, verdict: valid(said), quantityTonnes: q, cnCode: "7318", country: "TW", importDate: "2026-10-10", claimedTonnes: claimed, claimedBatchId: batch,
});

describe("#1 one proof on several lines: its claimed tonnes are counted once across the portfolio", () => {
  it("the review's manifest (the Sepolia demo proof, 200 t claimed, on three 200 t lines): only the first line rests on the verified value", async () => {
    mkdirSync(dir, { recursive: true });
    const line = (id: string, date: string) => ({ proof: ORIGINAL, id, quantityTonnes: "200", cnCode: "7318", country: "TW", importDate: date });
    writeFileSync(`${dir}manifest-dup.json`, JSON.stringify({ eori: "NLDEMO000000001", shipments: [line("LINE-A", "2026-10-10"), line("LINE-B", "2026-10-11"), line("LINE-C", "2026-10-12")] }));
    const r = await run(process.execPath, ["--import", replay, cli, "verify-batch", `${dir}manifest-dup.json`, "--out", `${dir}dup-results.json`, "--json"], { env });
    expect(JSON.parse(r.stdout).counts.VALID).toBe(3);
    const p = JSON.parse((await run(process.execPath, [cli, "portfolio", `${dir}dup-results.json`, "--year", "2026", "--json"])).stdout);
    expect(portfolioSchemaErrors(p)).toEqual([]);
    expect(p.shipments.map((l: { basis: string }) => l.basis)).toEqual(["actual", "default", "default"]);
    expect(p.shipments[1].reason).toContain("already used by LINE-A");
    expect(p.totals.onActual).toBe(1);
    expect(p.notes.join("\n")).toContain("on 3 lines (LINE-A, LINE-B, LINE-C)");
  }, 60_000);

  it("split lines within the claim stay on the verified value; the line that goes over it, in manifest order, takes the default; other batches are separate", () => {
    const within = buildPortfolio([shipment("A", "120", "B-1"), shipment("B", "80", "B-1")], { year: 2026 });
    expect(within.shipments.map((l) => l.basis)).toEqual(["actual", "actual"]);
    const over = buildPortfolio([shipment("A", "120", "B-1"), shipment("B", "100", "B-1"), shipment("C", "80", "B-1"), shipment("D", "200", "B-2")], { year: 2026 });
    expect(over.shipments.map((l) => l.basis)).toEqual(["actual", "default", "actual", "actual"]);
    expect(over.shipments[1].reason).toBe("100 t declared but only 80.000 t of the 200 t claimed on the ledger for batch B-1 remain (already used by A)");
  });

  it("a duplicate batch from two proof files is no longer renamed into a separate line that keeps its tonnes; the Art 9 block follows the line basis", () => {
    const res = (proof: string) => ({
      proof, line: { proof, quantityTonnes: "200", cnCode: "7318", country: "TW", importDate: "2026-10-10" }, verdict: withCarbonPrice(valid("Ecred")), error: null,
      proofShipment: { batchId: "B-1", quantityTonnes: "200", shipmentDate: "2026-10-10" },
    });
    const doc = { format: 1, kind: "carbonlei-batch", pinnedBlock: 100, chainId: 11155111, eori: "X", verifiedAt: "", counts: {}, results: [res("a.json"), res("b.json")], tool: {} } as unknown as BatchDocument;
    const s = buildPortfolio(shipmentsFromBatch(doc), { year: 2026, art9: { refPriceEur: "80" } });
    expect(s.shipments.map((l) => [l.id, l.basis])).toEqual([["B-1", "actual"], ["B-1 (b.json)", "default"]]);
    // The draft Art 9 deduction is taken on the line on actual values only; the over-claimed copy is listed as not used.
    expect(s.art9?.lines.map((l) => l.id)).toEqual(["B-1"]);
    expect(s.art9?.notUsed).toEqual([{ id: "B-1 (b.json)", reason: expect.stringContaining("declared on default values") }]);
  });
});

describe("#2 recheck verifies only the proof bytes verify-batch verified", () => {
  it("the review's folders: a same-named original in --proofs does not re-verify the tampered line, and portfolio --recheck keeps it on the default", async () => {
    for (const d of ["F1", "F2", "RC"]) rmSync(`${dir}${d}`, { recursive: true, force: true }), mkdirSync(`${dir}${d}`, { recursive: true });
    copyFileSync(ORIGINAL, `${dir}F1/a.json`);
    copyFileSync(TAMPERED, `${dir}F1/b.json`);
    copyFileSync(ORIGINAL, `${dir}F2/a.json`);
    copyFileSync(ORIGINAL, `${dir}F2/b.json`);
    const vb = await run(process.execPath, ["--import", replay, cli, "verify-batch", `${dir}F1`, "--eori", "NLDEMO000000001", "--out", `${dir}RC/F1-results.json`, "--json"], { env }).catch((e) => e);
    const results = JSON.parse(vb.stdout) as BatchDocument;
    expect(results.results.map((x) => x.verdict?.overall)).toEqual(["VALID", "INVALID"]);

    const rc = await run(process.execPath, ["--import", replay, cli, "recheck", `${dir}RC/F1-results.json`, "--proofs", `${dir}F2`, "--json", "--out", `${dir}recheck.json`], { env }).catch((e) => e);
    const doc = JSON.parse(rc.stdout) as RecheckDocument;
    expect(recheckSchemaErrors(doc)).toEqual([]);
    const b = doc.results.find((x) => x.id === "BATCH-DEMO-2026-0001" && x.source.endsWith("#2"))!;
    expect([b.change, b.severity, b.verdict]).toEqual(["RECHECK_FAILED", "error", null]);
    expect(b.error).toContain("sha256");
    expect(results.results[1].proofSha256).toMatch(/^[0-9a-f]{64}$/);

    const p = JSON.parse((await run(process.execPath, [cli, "portfolio", `${dir}RC/F1-results.json`, "--year", "2026", "--recheck", `${dir}recheck.json`, "--json"])).stdout);
    const bLine = p.shipments.find((l: { id: string }) => l.id.includes("b.json"));
    expect([bLine.verdict, bLine.basis]).toEqual(["INVALID", "default"]);

    // With the right folder the same results re-check in full (the hash matches).
    const ok = JSON.parse((await run(process.execPath, ["--import", replay, cli, "recheck", `${dir}RC/F1-results.json`, "--proofs", `${dir}F1`, "--json"], { env }).catch((e) => e)).stdout) as RecheckDocument;
    expect(ok.results.map((x) => [x.mode, x.current?.overall])).toEqual([["full", "VALID"], ["full", "INVALID"]]);
  }, 90_000);

  it("applyRecheck never improves a line unless the re-checked proof's sha256 matches the line's", () => {
    const said = "Ecred";
    const bad = { ...valid(said), overall: "INVALID" as const, primaryCode: "DISCLOSURE_TAMPERED" };
    const batch = {
      format: 1, kind: "carbonlei-batch", pinnedBlock: 100, chainId: 11155111, eori: "X", verifiedAt: "", counts: {}, tool: {},
      results: [{ proof: "b.json", line: { proof: "b.json" }, verdict: bad, error: null, proofShipment: { batchId: "B-1", quantityTonnes: "200", shipmentDate: "2026-10-10" }, proofSha256: "a".repeat(64) }],
    } as unknown as BatchDocument;
    const hit = (sha: string | null) =>
      ({
        source: "F1-results.json#1", id: "B-1", batchId: "B-1", credSAID: said, mode: "full", accepted: { overall: "INVALID", primaryCode: "", at: null, block: 90 },
        current: { overall: "VALID", primaryCode: "", block: 100 }, change: "IMPROVED", severity: "info", reasons: [], action: "", window: null, verdict: valid(said), error: null, proofSha256: sha,
      }) as unknown as RecheckResult;
    const doc = (r: RecheckResult) => ({ kind: "carbonlei-recheck", checkedAt: "", pinnedBlock: 100, results: [r] }) as unknown as RecheckDocument;
    expect(applyRecheck(batch, doc(hit("b".repeat(64)))).results[0].verdict?.overall).toBe("INVALID");
    expect(applyRecheck(batch, doc(hit(null))).results[0].verdict?.overall).toBe("INVALID");
    expect(applyRecheck(batch, doc(hit("a".repeat(64)))).results[0].verdict?.overall).toBe("VALID");
  });
});

// A chain reader that answers only what the server needs without verifying a proof.
const fakeReader = { latestBlock: async () => ({ number: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }), client: { getChainId: async () => 31337 }, registry: "0x0" } as never;

async function listen(opts: Record<string, unknown> = {}) {
  const server = createApiServer({ reader: fakeReader, log: () => {}, ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { server, base, post };
}

describe("#7 POST /v1/portfolio does not trust caller-supplied verdicts", () => {
  it("the review's forged results (a tampered line marked VALID at 0.1 tCO2e/t) are refused; only an explicit opt-in plans them, labelled unverified", async () => {
    const { server, post } = await listen({ hmacKey: "k".repeat(32) });
    try {
      const forged = JSON.parse(readFileSync(new URL("./fixtures/secrev/forged-results.json", import.meta.url), "utf8"));
      const res = await post("/v1/portfolio", { results: forged, year: 2026 });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.error).toContain("not bound by this server");

      const opted = await post("/v1/portfolio", { results: forged, year: 2026, trustCallerVerdicts: true });
      const s = await opted.json();
      expect(opted.status).toBe(200);
      expect(s.verdictSource).toContain("caller-supplied verdicts, not verified");
      expect(s.notes[0]).toContain("caller-supplied verdicts, not verified");
    } finally {
      server.close();
    }
  });

  it("results from this server's /v1/verify-batch are accepted; a changed byte, or a server with another key, refuses them", async () => {
    const a = await listen({ hmacKey: "k".repeat(32) });
    const other = await listen({ hmacKey: "z".repeat(32) });
    try {
      const vb = await a.post("/v1/verify-batch", { shipments: [{ proof: null, id: "L1", quantityTonnes: "60", cnCode: "7318", country: "TW", importDate: "2026-10-10" }] });
      const results = await vb.json();
      expect(results.binding).toMatchObject({ alg: "HMAC-SHA256" });
      const ok = await a.post("/v1/portfolio", { results, year: 2026 });
      const s = await ok.json();
      expect(ok.status).toBe(200);
      expect(s.verdictSource).toContain("verified by this server");
      const changed = structuredClone(results);
      changed.results[0].line.quantityTonnes = "6";
      expect((await a.post("/v1/portfolio", { results: changed, year: 2026 })).status).toBe(422);
      expect((await other.post("/v1/portfolio", { results, year: 2026 })).status).toBe(422);
    } finally {
      a.server.close();
      other.server.close();
    }
  });
});

describe("#8 a slow upload does not hold a concurrency slot", () => {
  it("four clients trickling a body: other POSTs still run, no slot is taken, and the slow requests end at the body deadline", async () => {
    const { server, base, post } = await listen({ bodyTimeoutMs: 600 });
    const sockets: ReturnType<typeof connect>[] = [];
    const answers: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const s = connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
          s.write(`POST /v1/verify HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"pro`);
          const t = setInterval(() => s.writable && s.write("a"), 100);
          s.on("close", () => clearInterval(t));
        });
        s.on("data", (d) => answers.push(d.toString()));
        s.on("error", () => {});
        sockets.push(s);
      }
      await new Promise((r) => setTimeout(r, 300));
      const health = await (await fetch(`${base}/v1/health`)).json();
      expect(health.limits.active).toBe(0);
      expect((await post("/v1/recheck", {})).status).toBe(400);
      await new Promise((r) => setTimeout(r, 900));
      expect(answers.filter((a) => a.startsWith("HTTP/1.1 408")).length).toBe(4);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});

describe("#9 share-pack file names are collision-free and never overwrite", () => {
  it("different (importer, batch) pairs that read the same once joined with -- get different names", () => {
    expect(proofFileName("acme", "b--1")).not.toBe(proofFileName("acme--b", "1"));
    expect(proofFileName("acme/eu", "B 1")).not.toBe(proofFileName("acme_eu", "B_1"));
    expect(proofFileName("acme", "B-1")).toMatch(/^acme--B-1--[0-9a-f]{10}\.proof\.json$/);
  });

  it("writeSharePack refuses to overwrite an existing file", () => {
    const out = `${dir}pack/`;
    rmSync(out, { recursive: true, force: true });
    const proofs = [{ importer: "acme", batchId: "b--1", file: proofFileName("acme", "b--1"), fields: [], proof: { n: 1 } }];
    const book = { version: 1, importers: [{ id: "acme" }], batches: [] } as never;
    const cred = { core: { d: "Ecred" } } as never;
    writeSharePack(out, book, cred, { proofs: proofs as never, skipped: [] });
    expect(existsSync(`${out}${proofs[0].file}`)).toBe(true);
    expect(() => writeSharePack(out, book, cred, { proofs: proofs as never, skipped: [] })).toThrow(/already exists/);
    const twice = [proofs[0], { ...proofs[0], proof: { n: 2 } }];
    rmSync(out, { recursive: true, force: true });
    expect(() => writeSharePack(out, book, cred, { proofs: twice as never, skipped: [] })).toThrow(/twice/);
  });
});
