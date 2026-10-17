// Regression tests for the third round of our own AI-run review of 17 October 2026 (not an external audit;
// docs/SECURITY.md § 16), on the code added since ef13c9a. Each test failed on the code before the fix (commit 3f130b6)
// and passes after it.
//   H1  the ERP client trusted the unbound /v1/portfolio answer: a man in the middle turned an INVALID line VERIFIED
//   M1  the ERP client did not check the results' EORI or freshness: another importer's bound results were replayed
//   M2  a short CN code resolved on the country's own lines only, ignoring lines that fall back to "Other Countries"
//   M3  10-digit TARIC codes of Annex I could not be planned (only 4 to 8 digits were accepted)
//   L1  csvField left ";" and tab unquoted and missed a formula behind leading white space
//   L2  "UK" took the "Other Countries" value instead of GB's; EU and Annex III origins were planned on "Other"
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as erp from "../../examples/erp-integration/erp-sync.ts";
import { ChainReader, type Deployment } from "../chain.ts";
import { annexDefault, buildPortfolio, csvField, DEFAULT_VALUES, type ShipmentInput } from "../portfolio.ts";
import { createApiServer } from "../server.ts";
import { portfolioSchemaErrors } from "./helpers/portfolio-schema.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const path = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const csvText = readFileSync(path("examples/erp-integration/erp-export.csv"), "utf8");
const proofDir = path("fixtures/");
const recording = path("sdk/test/fixtures/sepolia-demo-rpc.json");
const deployment = JSON.parse(readFileSync(path("contracts/deployments/11155111.json"), "utf8")) as Deployment;
const EORI = "NLDEMO000000001";
const KEY = "third-review-test-key-0123456789abcdef";
const real = globalThis.fetch;

/** RPC calls are answered from the recording; calls to local servers go through (as in erp-integration.test.ts). */
function offline() {
  const replay = replayFetch(recording);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    (input instanceof Request ? input.url : String(input)).startsWith("http://127.0.0.1:") ? real(input, init) : replay(input, init),
  );
  const head = JSON.parse(readFileSync(recording, "utf8")).answers['eth_getBlockByNumber ["latest",false]'].result;
  const realNow = Date.now.bind(Date);
  const offset = Number(BigInt(head.timestamp)) * 1000 + 5_000 - realNow();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
}

const listen = async (s: Server) => {
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

/** A genuine API server and, in front of it, a proxy that may rewrite each answer (the review's man in the middle). */
async function apiBehindProxy(rewrite: (path: string, text: string) => string) {
  const api = createApiServer({ reader: ChainReader.forSepolia(deployment), evidenceDir: proofDir, log: () => undefined, hmacKey: KEY });
  const up = await listen(api);
  const proxy = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const r = await real(up + req.url, { method: req.method, headers: { "content-type": "application/json" }, body });
    const text = rewrite(req.url ?? "", await r.text());
    res.writeHead(r.status, { "content-type": "application/json" }).end(text);
  });
  const baseUrl = await listen(proxy);
  return { baseUrl, close: () => (api.close(), proxy.close()) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("H1 the ERP client trusts only a bound plan that agrees with the bound results", () => {
  it("the review's proxy turns the INVALID (tampered proof) line VALID at 0.100 in /v1/portfolio: the run is refused, nothing written", async () => {
    offline();
    const { baseUrl, close } = await apiBehindProxy((p, text) => {
      if (p !== "/v1/portfolio") return text;
      const plan = JSON.parse(text);
      const l = plan.shipments.find((s: { verdict: string }) => s.verdict === "INVALID");
      Object.assign(l, { verdict: "VALID", primaryCode: "", basis: "actual", seeUsed: "0.100", embeddedT: "4.000", obligationT: "4.000" });
      return JSON.stringify(plan);
    });
    try {
      await expect(erp.runErpSync({ csvText, proofDir, eori: EORI, year: 2026, hmacKey: KEY, api: { baseUrl } })).rejects.toThrow(/plan does not carry a valid HMAC binding/);
    } finally {
      close();
    }
  }, 60_000);

  it("POST /v1/portfolio binds its plan (HMAC), names the binding of the results it planned and echoes the nonce", async () => {
    offline();
    const api = createApiServer({ reader: ChainReader.forSepolia(deployment), evidenceDir: proofDir, log: () => undefined, hmacKey: KEY });
    const base = await listen(api);
    const post = async (p: string, body: unknown) => (await real(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    try {
      const nonce = "n".repeat(32);
      const results = await post("/v1/verify-batch", { eori: EORI, nonce, shipments: [{ proof: null, id: "L1", quantityTonnes: "10", cnCode: "73181595", country: "TW", importDate: "2026-10-10" }] });
      expect(results.nonce).toBe(nonce);
      expect(erp.bindingValid(results, KEY)).toBe(true);
      const plan = await post("/v1/portfolio", { results, year: 2026, nonce });
      expect(erp.bindingValid(plan, KEY)).toBe(true);
      expect(plan).toMatchObject({ nonce, resultsBinding: results.binding.mac });
      expect(portfolioSchemaErrors(plan)).toEqual([]);
      expect(erp.bindingValid({ ...plan, totals: { ...plan.totals, certificates: 0 } }, KEY)).toBe(false);
    } finally {
      api.close();
    }
  }, 60_000);

  it("cross-check: a plan line on the verified value whose bound verdict is not VALID with check 5 passed, or at another value, is refused", async () => {
    offline();
    const ok = await erp.runErpSync({ csvText, proofDir, eori: EORI, year: 2026, hmacKey: KEY, serve: { reader: ChainReader.forSepolia(deployment), evidenceDir: proofDir, log: () => undefined } });
    const { request } = erp.mapErpRows(erp.readErpCsv(csvText), { proofDir, eori: EORI });
    expect(() => erp.crossCheckPlan(ok.plan, ok.results, request)).not.toThrow();
    const forge = (id: string, over: object) => ({ ...ok.plan, shipments: ok.plan.shipments.map((s) => (s.id === id ? { ...s, ...over } : s)) });
    // The tampered proof's line (INVALID) moved to the verified value.
    expect(() => erp.crossCheckPlan(forge("PO-4500001002/10", { verdict: "VALID", basis: "actual", seeUsed: "1.8", seeVerified: "1.8", embeddedT: "72.000" }), ok.results, request)).toThrow(
      /bound results say INVALID/,
    );
    expect(() => erp.crossCheckPlan(forge("PO-4500001002/10", { basis: "actual", seeUsed: "1.8", seeVerified: "1.8" }), ok.results, request)).toThrow(/not VALID with check 5 passed/);
    // The VALID line at a lower value than its verdict discloses, or more tonnes than were sent.
    expect(() => erp.crossCheckPlan(forge("PO-4500001001/10", { seeUsed: "0.100", seeVerified: "0.100", embeddedT: "20.000" }), ok.results, request)).toThrow(/bound verdict discloses 1.8/);
    expect(() => erp.crossCheckPlan(forge("PO-4500001001/10", { quantityTonnes: "100.000", embeddedT: "180.000" }), ok.results, request)).toThrow(/200 t were sent/);
    // A line dropped from the plan.
    expect(() => erp.crossCheckPlan({ ...ok.plan, shipments: ok.plan.shipments.slice(1) }, ok.results, request)).toThrow(/does not list line PO-4500001001\/10/);
  }, 60_000);
});

describe("M1 bound results are used only for the EORI and the request they were made for", () => {
  it("the review's replay: importer A's bound verify-batch answer replayed to importer B's run is refused", async () => {
    offline();
    let saved: string | undefined;
    const { baseUrl, close } = await apiBehindProxy((p, text) => (p !== "/v1/verify-batch" ? text : (saved ??= text)));
    try {
      await erp.runErpSync({ csvText, proofDir, eori: EORI, year: 2026, hmacKey: KEY, api: { baseUrl } });
      await expect(erp.runErpSync({ csvText, proofDir, eori: "DEOTHER00000009", year: 2026, hmacKey: KEY, api: { baseUrl } })).rejects.toThrow(
        /results are for EORI NLDEMO000000001, not for the EORI of this run/,
      );
      // The same importer's earlier answer replayed to a later run: another nonce.
      await expect(erp.runErpSync({ csvText, proofDir, eori: EORI, year: 2026, hmacKey: KEY, api: { baseUrl } })).rejects.toThrow(/not made for this request \(their nonce differs\)/);
    } finally {
      close();
    }
  }, 60_000);

  it("results verified longer ago than maxResultAgeSec are refused; the server refuses a malformed nonce", async () => {
    const doc = { eori: EORI, nonce: "a".repeat(32), verifiedAt: "2026-10-17T10:00:00.000Z" } as never;
    const at = (iso: string) => Date.parse(iso);
    expect(() => erp.checkResultsFresh(doc, { eori: EORI, nonce: "a".repeat(32), maxAgeSec: 600, now: at("2026-10-17T10:05:00.000Z") })).not.toThrow();
    expect(() => erp.checkResultsFresh(doc, { eori: EORI, nonce: "a".repeat(32), maxAgeSec: 600, now: at("2026-10-17T10:20:00.000Z") })).toThrow(/not within the last 600 s/);
    expect(erp.DEFAULT_MAX_RESULT_AGE_SEC).toBe(600);
    const api = createApiServer({ reader: { latestBlock: async () => ({ number: 1n, timestamp: 0n }) } as never, log: () => undefined, hmacKey: KEY });
    const base = await listen(api);
    try {
      const r = await real(`${base}/v1/verify-batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: "short", shipments: [{ proof: null }] }) });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/"nonce" must be 16 to 128 characters/);
    } finally {
      api.close();
    }
  });
});

describe("M2 a short CN code resolves only when every line under it, own or 'Other Countries', has one value", () => {
  it("CN 7202 from AL, DO, EC, GT, NC and ZM is ambiguous (each lists one 7202 line; the others take 'Other Countries')", () => {
    for (const iso of ["AL", "DO", "EC", "GT", "NC", "ZM"]) {
      const r = annexDefault(iso, "7202");
      expect(r.value, iso).toBeUndefined();
      expect(r.value === undefined && r.reason).toMatch(/7202 19 = 5\.590 \(Other Countries and Territories\).*pass the value in `defaults`/);
    }
    expect(annexDefault("AL", "72021900")).toMatchObject({ value: "5.590", table: "OTHER" });
    expect(() => buildPortfolio([{ id: "x", quantityTonnes: "100", cnCode: "7202", country: "AL", importDate: "2026-06-01" }], { year: 2026 })).toThrow(/give the longer CN or TARIC code, or pass the value in `defaults`/);
  });

  it("every country, every 4-, 6- and 8-digit prefix: a value for the short code is the value of each line under it", () => {
    const C = DEFAULT_VALUES.countries;
    const wrong: string[] = [];
    for (const iso of Object.keys(C).filter((k) => k !== "OTHER")) {
      const codes = [...Object.keys(C[iso].rows), ...Object.keys(C.OTHER.rows)];
      const prefixes = new Set(codes.flatMap((c) => [4, 6, 8].filter((n) => c.length > n).map((n) => c.slice(0, n))));
      for (const x of prefixes) {
        const r = annexDefault(iso, x);
        if (r.value === undefined) continue;
        for (const line of codes.filter((c) => c.startsWith(x) && c !== x)) {
          const l = annexDefault(iso, line);
          if (l.value !== r.value) wrong.push(`${iso} ${x}=${r.value} but ${line}=${l.value}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("M3 10-digit TARIC codes of Annex I can be planned, everywhere", () => {
  it("buildPortfolio plans CN 2523 10 00 10 from China (1.300) and keeps refusing odd lengths; the short code names `defaults`", () => {
    const line = (cnCode: string): ShipmentInput => ({ id: "x", quantityTonnes: "100", cnCode, country: "CN", importDate: "2026-06-01" });
    const p = buildPortfolio([line("2523 10 00 10")], { year: 2026 });
    expect(p.shipments[0]).toMatchObject({ defaultValue: "1.300", defaultSource: "IR (EU) 2026/1740 Annex I, China, CN 2523 10 00 10" });
    expect(() => buildPortfolio([line("25231000")], { year: 2026 })).toThrow(/2523 10 00 10 = 1\.300, 2523 10 00 90 = 1\.390\); give the longer CN or TARIC code, or pass the value in `defaults`/);
    expect(() => buildPortfolio([line("2523100")], { year: 2026 })).toThrow(/4, 6 or 8 digits or a 10-digit TARIC code/);
    expect(() => buildPortfolio([line("252310001")], { year: 2026 })).toThrow(/4, 6 or 8 digits or a 10-digit TARIC code/);
  });

  it("the ERP mapping sends a 10-digit row, and writes back a row the plan could not resolve as ERP_ROW_INVALID instead of failing the run", () => {
    const row = (poLine: string, cnCode: string): erp.ErpRow => ({ rowNumber: 2, poNumber: "PO-1", poLine, cnCode, country: "CN", supplier: "S", quantityTonnes: "1", importDate: "2026-12-01", proofFile: "" });
    const { request, lines } = erp.mapErpRows([row("1", "2523100010"), row("2", "25231000")], { proofDir, eori: EORI });
    expect(request.shipments.map((s) => s.cnCode)).toEqual(["2523100010"]);
    expect(lines[1]).toMatchObject({ sent: false, code: "ERP_ROW_INVALID" });
    expect(lines[1].detail).toMatch(/cn_code "25231000" from CN: .*pass the value in `defaults`/);
  });
});

describe("L1 CSV fields: delimiters other than the comma, and formulas behind white space", () => {
  it("quotes ; and tab; prefixes = + - @ after leading white space, and a leading tab or CR; leaves plain numbers", () => {
    expect(csvField("Acme Works;=1+1")).toBe('"Acme Works;=1+1"');
    expect(csvField("a\tb")).toBe('"a\tb"');
    expect(csvField("  =HYPERLINK(1)")).toBe("'  =HYPERLINK(1)");
    expect(csvField("\n@SUM(A1)")).toBe("\"'\n@SUM(A1)\"");
    expect(csvField("\t=1")).toBe("\"'\t=1\"");
    expect(csvField("-1.5")).toBe("-1.5");
    expect(csvField("x,y")).toBe('"x,y"');
  });
});

describe("L2 origin codes: UK is GB; origins not subject to CBAM are refused, not planned on 'Other Countries'", () => {
  it("UK takes the United Kingdom's value (CN 7208 39 00: 2.420, not 4.049), and the line says GB", () => {
    expect(annexDefault("UK", "72083900")).toMatchObject({ value: "2.420", table: "GB" });
    const p = buildPortfolio([{ id: "x", quantityTonnes: "10", cnCode: "72083900", country: "UK", importDate: "2026-06-01" }], { year: 2026 });
    expect(p.shipments[0]).toMatchObject({ country: "GB", defaultValue: "2.420" });
  });

  it("an EU member state, or an Annex III country (IS, LI, NO, CH), is refused with 'not subject to CBAM'", () => {
    for (const iso of ["DE", "FR", "NL", "EL", "NO", "CH", "IS", "LI"]) {
      const r = annexDefault(iso, "72083900");
      expect(r.value, iso).toBeUndefined();
      expect(r.value === undefined && r.reason).toContain("not subject to CBAM");
      expect(() => buildPortfolio([{ id: "x", quantityTonnes: "10", cnCode: "72083900", country: iso, importDate: "2026-06-01", defaultValue: "1.000" }], { year: 2026 })).toThrow(
        /not subject to CBAM/,
      );
    }
    expect(annexDefault("CH", "7208")).toMatchObject({ reason: expect.stringContaining("Annex III to Reg. (EU) 2023/956") });
    const { lines } = erp.mapErpRows([{ rowNumber: 2, poNumber: "PO-1", poLine: "1", cnCode: "72083900", country: "DE", supplier: "S", quantityTonnes: "1", importDate: "2026-12-01", proofFile: "" }], { proofDir, eori: EORI });
    expect(lines[0]).toMatchObject({ code: "ERP_ROW_INVALID", detail: expect.stringContaining("not subject to CBAM") });
  });
});
