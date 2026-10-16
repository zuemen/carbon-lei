// Re-check of accepted values (sdk/recheck.ts) and the REST API (sdk/server.ts) on a local anvil chain.
// Each scenario first accepts a VALID verdict, then changes the chain the way the real world would (the body revokes
// the report, the watcher revokes the auditor inside the 24 h window, time passes) and re-checks. Checks 6-8 use
// passing stand-in checkers (the vLEI checkers are tested on real evidence in vlei.test.ts).
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../commitment.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import type { Presentation } from "../disclosure.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../issue.ts";
import { applyRecheck, recheckExitCode, recheckRecords, recordsFromJson, type RecheckDocument } from "../recheck.ts";
import { createApiServer, sandboxedLoader, type ServeOptions } from "../server.ts";
import { verdictFor, type Verdict } from "../verdict.ts";
import type { EvidenceCheckers } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";
import { recheckSchemaErrors } from "./helpers/recheck-schema.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const salt = (s: string): Hex => keccak256(stringToBytes(`rc:${s}`));
const AID_1 = "EDemoAuditorAidForRecheckTests10000000000000";
const AID_2 = "EDemoAuditorAidForRecheckTests20000000000000";
const EORI = demo.entities.importers[0].eori as string;

const pass = (index: number) => async () => ({ index, name: "", status: "pass" as const, code: "", detail: "stand-in" });
const checkers: EvidenceCheckers = { anchor: pass(6), authority: pass(7), reconciliation: pass(8) };
const extract = { c: 3, quantityPerCn: [], specificEmbeddedEmissionsPerCn: [], accreditationScope: [], signedAt: "" };

let c: LocalChain;

function claims(n: number, over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  return {
    supplierLEI: s.lei, operatorId: s.operatorId, installationId: s.installations[0].id, installationName: s.installations[0].name,
    unLocode: s.unLocode, cnCode: "7318", cbamRoute: "C", productionRoute: "withheld", reportingPeriod: `${2020 + n}-01-01/${2020 + n}-12-31`,
    verifiedTonnes: "500", specificEmbeddedEmissions_tCO2e_per_t: "1.8", valueType: "actual", methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: `VR-RECHECK-000${n}`, verifierLEI: demo.entities.verifier.lei, accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name, siteVisit: "physical", assuranceLevel: "reasonable", materialityThreshold: "5%",
    energyMix: "withheld", supplierCost: "withheld", idSalt: salt(`id${n}`), batchSalt: salt(`batch${n}`),
    issuedAt: "2026-09-01T00:00:00Z", validUntil: "2027-12-31T00:00:00Z", ...over,
  };
}

/** Issues, registers and claims a credential for EORI; returns the proof with stand-in evidence attached. */
async function shipped(n: number, auditorAID: string): Promise<{ cred: SignedCredential; proof: Presentation }> {
  const cred = await issueCredential({ claims: claims(n), auditorAID, signer: c.verifier, registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 });
  await send(c, c.verifier, "registry", "registerReport", [reportInputOf(cred, { supplier: c.supplier.address, kelSeq: 1n })]);
  const shipment = { batchId: `BATCH-RECHECK-${n}`, quantityTonnes: "100", shipmentDate: "2026-10-10", importerSalt: salt(`imp${n}`) };
  await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cred, { ...shipment, importerEORI: EORI }));
  const proof = { ...present(cred, DEMO_DISCLOSURE, shipment), anchorEvidence: { a: n }, authorityEvidence: { b: n }, reportExtract: extract } as Presentation;
  return { cred, proof };
}

/** What an importer keeps when it accepts: the proof, the verdict and the time (chain time of the head). */
async function accept(proof: Presentation) {
  const verdict = await verdictFor(proof, c.reader, { importerEORI: EORI, checkers });
  expect(verdict.overall).toBe("VALID");
  const head = await c.reader.latestBlock();
  return { proof, verdict, eori: EORI, acceptedAt: new Date(Number(head.timestamp) * 1000).toISOString() };
}

const recheck = (records: unknown[]) => recheckRecords(recordsFromJson(records, "test").records, c.reader, { checkers });

let A: Awaited<ReturnType<typeof accept>>; // revoked by the body after acceptance
let B: Awaited<ReturnType<typeof accept>>; // accepted inside the window; becomes final
let C: Awaited<ReturnType<typeof accept>>; // its auditor is revoked inside the window
let first: RecheckDocument;

beforeAll(async () => {
  c = await startLocalChain(20545 + Math.floor(Math.random() * 1000));
  const lei = leiHashOf(demo.entities.verifier.lei);
  await send(c, c.owner, "allowlist", "addVerifier", [
    { leiHash: lei, verifier: c.verifier.address, leCredSaidHash: hashString("LE"), accreditationSaidHash: hashString("ACC"), accreditedUntil: 1924905600n },
  ]);
  for (const aid of [AID_1, AID_2]) {
    await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(aid), leiHash: lei, ecrSaidHash: hashString(`ECR-${aid}`) }]);
  }
  A = await accept((await shipped(1, AID_1)).proof);
  B = await accept((await shipped(2, AID_1)).proof);
  C = await accept((await shipped(3, AID_2)).proof);
  first = await recheck([A, B, C]);
}, 90_000);

afterAll(() => c?.stop());

describe("recheck on anvil", () => {
  it("right after acceptance: every line still VALID, the CONTESTED window still open (info), exit 0", () => {
    expect(recheckSchemaErrors(first)).toEqual([]);
    expect(first.results.map((r) => [r.change, r.severity, r.mode])).toEqual([
      ["WINDOW_OPEN", "info", "full"],
      ["WINDOW_OPEN", "info", "full"],
      ["WINDOW_OPEN", "info", "full"],
    ]);
    expect(first.results.every((r) => r.window && !r.window.closed && r.verdict?.chain.block === first.pinnedBlock)).toBe(true);
    expect(recheckExitCode(first)).toBe(0);
  });

  it("the body revokes A, the watcher revokes C's auditor within 24 h, then 25 h pass: A and C need action, B became final", async () => {
    await send(c, c.verifier, "registry", "revokeReport", [reportKeyOf(JSON.parse(A.proof.core).d)]);
    await c.test.increaseTime({ seconds: 3600 });
    await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(AID_2), leiHashOf(demo.entities.verifier.lei)]);
    await c.test.increaseTime({ seconds: 25 * 3600 });
    await c.test.mine({ blocks: 1 });

    const doc = await recheck([A, B, C]);
    expect(recheckSchemaErrors(doc)).toEqual([]);
    const [a, b, cc] = doc.results;
    expect([a.change, a.severity, a.current?.overall, a.current?.primaryCode]).toEqual(["REPORT_REVOKED", "action", "INVALID", "REPORT_INVALID/REVOKED"]);
    expect(a.reasons[0]).toContain("the verification body revoked this report");
    expect(a.action).toMatch(/^Declare this line on the default value/);
    expect([b.change, b.severity, b.window?.closed]).toEqual(["BECAME_FINAL", "info", true]);
    expect([cc.change, cc.severity, cc.current?.overall]).toEqual(["AUDITOR_REVOKED_OR_BODY_SUSPENDED", "action", "CONTESTED"]);
    expect(cc.reasons[0]).toContain("revoked or suspended within 24 h after");
    expect(doc.counts).toEqual({ action: 2, info: 1, none: 0, error: 0 });
    expect(recheckExitCode(doc)).toBe(1);
    // Accepted after the window had closed: unchanged, not "became final".
    const late = await recheck([{ ...B, acceptedAt: new Date().toISOString() }]);
    expect(late.results[0].change).toBe("UNCHANGED");
  });

  it("a Buyer-tab record without its proof is re-checked on the ledger only: the revocation is still found", async () => {
    const buyer = {
      kind: "CarbonLEI verification record (demo)",
      createdAt: A.acceptedAt,
      network: { name: "anvil", chainId: 31337, registry: c.deployment.contracts.EmissionsClaimRegistry.address },
      credSAID: A.verdict.credSAID,
      batchId: "BATCH-RECHECK-1",
      importerEORI: EORI,
      overall: "VALID",
      checks: A.verdict.checks.map(({ id, ...x }) => ({ index: id, ...x })),
    };
    const doc = await recheck([buyer, { ...buyer, credSAID: B.verdict.credSAID }, { ...buyer, network: { chainId: 1 } }]);
    expect(doc.results.map((r) => [r.mode, r.change, r.severity])).toEqual([
      ["ledger-only", "REPORT_REVOKED", "action"],
      ["ledger-only", "UNCHANGED", "none"],
      ["ledger-only", "RECHECK_FAILED", "error"],
    ]);
    expect(doc.results[2].error).toContain("the record is from chain 1");
    expect(doc.notes.join(" ")).toContain("Ledger-only lines had no proof attached");
    expect(recheckExitCode(doc)).toBe(3);
  });

  it("feeds the portfolio: the revoked line moves from the verified value to the default, with the re-check as reason", async () => {
    const batch = {
      format: 1 as const, kind: "carbonlei-batch" as const, pinnedBlock: first.pinnedBlock, chainId: 31337, eori: EORI, verifiedAt: A.acceptedAt,
      counts: { VALID: 2, INVALID: 0, CONTESTED: 0, INCOMPLETE: 0, ERROR: 0, NO_PROOF: 0 },
      results: [A, B].map((x, i) => ({
        proof: `p${i}.json`, line: { id: `L${i + 1}`, cnCode: "7318", country: "TW", quantityTonnes: "100", importDate: "2026-10-10" },
        verdict: x.verdict, error: null, proofShipment: { batchId: x.proof.shipment!.batchId, quantityTonnes: "100", shipmentDate: "2026-10-10" },
      })),
      tool: { name: "carbonlei", version: "0.1.0" },
    };
    const doc = await recheck([A, B]);
    const applied = applyRecheck(batch, doc);
    expect(applied.results[0].recheck).toMatchObject({ change: "REPORT_REVOKED", severity: "action", pinnedBlock: doc.pinnedBlock });
    expect(applied.results[0].verdict?.overall).toBe("INVALID");
    expect(applied.results[1].recheck).toBeUndefined();
    const { buildPortfolio } = await import("../portfolio.ts");
    const { shipmentsFromBatch } = await import("../batch.ts");
    const before = buildPortfolio(shipmentsFromBatch(batch), { year: 2026 });
    const after = buildPortfolio(shipmentsFromBatch(applied), { year: 2026 });
    expect(before.shipments.map((l) => l.basis)).toEqual(["actual", "actual"]);
    expect(after.shipments.map((l) => l.basis)).toEqual(["default", "actual"]);
    expect(after.shipments[0].reason).toMatch(/^re-checked after acceptance: REPORT_REVOKED \(re-check of \d{4}-\d{2}-\d{2}, block \d+\)$/);
    // 100 t × 1.8 = 180 → 100 t × 2.978 (2.707 + 10 %) = 297.8 tCO2e.
    expect([before.shipments[0].embeddedT, after.shipments[0].embeddedT]).toEqual(["180.000", "297.800"]);
  });
});

describe("REST API (carbonlei serve) on anvil", () => {
  const logs: Record<string, unknown>[] = [];
  const servers: ReturnType<typeof createApiServer>[] = [];
  async function start(over: Partial<ServeOptions> = {}): Promise<string> {
    const s = createApiServer({ reader: c.reader, rpcUrls: [c.rpc], checkers, log: (e) => logs.push(e), ...over });
    servers.push(s);
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const post = (url: string, body: unknown, type = "application/json") =>
    fetch(url, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
  afterAll(() => servers.forEach((s) => s.close()));

  it("GET / and GET /v1/openapi.json return the same OpenAPI document as /openapi.json; POST there is 405", async () => {
    const base = await start();
    const doc = await (await fetch(`${base}/openapi.json`)).text();
    for (const p of ["/", "/v1/openapi.json"]) {
      const r = await fetch(`${base}${p}`);
      expect([p, r.status, r.headers.get("content-type")]).toEqual([p, 200, "application/json; charset=utf-8"]);
      expect(await r.text()).toBe(doc);
    }
    expect(JSON.parse(doc).openapi).toBe("3.1.0");
    const post = await fetch(`${base}/`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect((await fetch(`${base}/v2/nothing`)).status).toBe(404);
  });

  it("health, OpenAPI, verify (same verdict as the SDK, exit header), verify-batch → portfolio → recheck", async () => {
    const base = await start();
    const h = await fetch(`${base}/v1/health`);
    expect(h.status).toBe(200);
    const health = await h.json();
    expect(health).toMatchObject({ status: "ok", chainId: 31337, rpc: { nodes: 1, hosts: [new URL(c.rpc).host] } });
    expect(health.auth).toMatch(/^none/);
    const api = await (await fetch(`${base}/openapi.json`)).json();
    expect(api.openapi).toBe("3.1.0");
    expect(Object.keys(api.paths)).toEqual(["/v1/verify", "/v1/verify-batch", "/v1/portfolio", "/v1/recheck", "/v1/health", "/openapi.json"]);

    const r = await post(`${base}/v1/verify`, { proof: B.proof, eori: EORI });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-carbonlei-exit")).toBe("0");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    const v = (await r.json()) as Verdict;
    expect(verdictSchemaErrors(v)).toEqual([]);
    const sdk = await verdictFor(B.proof, c.reader, { importerEORI: EORI, checkers });
    expect({ ...v, chain: null }).toEqual({ ...JSON.parse(JSON.stringify(sdk)), chain: null });
    const revoked = await post(`${base}/v1/verify`, { proof: A.proof, eori: EORI });
    expect(revoked.headers.get("x-carbonlei-exit")).toBe("1");

    const vb = await post(`${base}/v1/verify-batch`, {
      eori: EORI,
      shipments: [
        { proof: B.proof, id: "L-B", cnCode: "7318", country: "TW", quantityTonnes: "100", importDate: "2026-10-10" },
        { proof: null, id: "L-NONE", cnCode: "7318", country: "TW", quantityTonnes: "10", importDate: "2026-11-01" },
      ],
    });
    expect(vb.status).toBe(200);
    const results = await vb.json();
    expect(results).toMatchObject({ kind: "carbonlei-batch", counts: { VALID: 1, NO_PROOF: 1 } });
    const pf = await post(`${base}/v1/portfolio`, { results, year: 2026, priceEur: "82.32" });
    expect(pf.status).toBe(200);
    const plan = await pf.json();
    expect(plan.shipments.map((l: { basis: string }) => l.basis)).toEqual(["actual", "default"]);
    const bad = await post(`${base}/v1/portfolio`, { results, year: "2026" });
    expect(bad.status).toBe(400);

    const rc = await post(`${base}/v1/recheck`, { records: [A, B, { not: "a record" }] });
    expect(rc.status).toBe(200);
    expect(rc.headers.get("x-carbonlei-exit")).toBe("1");
    const doc = await rc.json();
    expect(doc.results.map((x: { change: string }) => x.change)).toEqual(["REPORT_REVOKED", "BECAME_FINAL"]);
    expect(doc.skipped).toEqual(["records[2]: not a verification record or a verify-batch results file"]);
    const { skipped: _, ...plain } = doc;
    expect(recheckSchemaErrors(plain)).toEqual([]);

    // Logs: one line per request, outcome and "eori: given", never the EORI itself or the body.
    const text = JSON.stringify(logs);
    expect(text).not.toContain(EORI);
    expect(text).not.toContain(B.proof.signature);
    expect(logs.find((l) => l.path === "/v1/verify")).toMatchObject({ msg: "request", method: "POST", status: 200, eori: "given", outcome: "VALID" });
    expect(logs.every((l) => typeof l.ms === "number" && typeof l.id === "string")).toBe(true);
  });

  it("refuses bad requests: wrong method, unknown path, content type, invalid JSON, repeated key, oversized body", async () => {
    const base = await start({ maxBodyBytes: 2000 });
    expect((await fetch(`${base}/v1/verify`)).status).toBe(405);
    expect((await fetch(`${base}/v1/health`, { method: "POST" })).status).toBe(405);
    expect((await post(`${base}/v2/verify`, {})).status).toBe(404);
    expect((await post(`${base}/v1/verify`, { proof: B.proof }, "text/plain")).status).toBe(415);
    expect((await post(`${base}/v1/verify`, "{not json")).status).toBe(400);
    const dup = await post(`${base}/v1/verify`, '{"proof":{},"proof":{}}');
    expect([dup.status, (await dup.json()).error]).toEqual([400, 'the request body repeats the key "proof"']);
    expect((await post(`${base}/v1/verify`, { proof: { core: 1 } })).status).toBe(400);
    const big = await post(`${base}/v1/verify`, { proof: B.proof, pad: "x".repeat(5000) });
    expect([big.status, (await big.json()).error]).toEqual([413, "request body larger than 2000 bytes"]);
    expect((await post(`${base}/v1/verify-batch`, { shipments: [] })).status).toBe(400);
  });

  it("concurrency limit answers 503 with Retry-After; the per-request timeout answers 504", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: EvidenceCheckers = { ...checkers, anchor: async () => (await gate, { index: 6, name: "", status: "pass" as const, code: "", detail: "" }) };
    const base = await start({ checkers: slow, maxConcurrent: 1, timeoutMs: 30_000 });
    const firstReq = post(`${base}/v1/verify`, { proof: B.proof, eori: EORI });
    await new Promise((r) => setTimeout(r, 300));
    const busy = await post(`${base}/v1/verify`, { proof: B.proof, eori: EORI });
    expect([busy.status, busy.headers.get("retry-after")]).toEqual([503, "5"]);
    release();
    expect((await firstReq).status).toBe(200);

    const never: EvidenceCheckers = { ...checkers, anchor: () => new Promise(() => undefined) };
    const base2 = await start({ checkers: never, timeoutMs: 300 });
    const t = await post(`${base2}/v1/verify`, { proof: B.proof, eori: EORI });
    expect([t.status, (await t.json()).error]).toEqual([504, "the request took longer than 0.3 s"]);
  });

  it("CORS only for the one configured origin; evidence reads stay inside the evidence folder", async () => {
    const base = await start({ corsOrigin: "https://erp.example" });
    const pre = await fetch(`${base}/v1/verify`, { method: "OPTIONS" });
    expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, "https://erp.example"]);
    expect((await fetch(`${base}/v1/health`)).headers.get("access-control-allow-origin")).toBe("https://erp.example");
    const load = sandboxedLoader(new URL("../../demo/public/", import.meta.url).pathname);
    expect(await load("evidence/index.json")).toContain("{");
    await expect(load("../../package.json")).rejects.toThrow("evidence path outside the evidence folder");
    await expect(load("evidence/nope.json")).rejects.toThrow("not found");
  });
});
