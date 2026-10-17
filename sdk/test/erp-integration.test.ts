// ERP integration example (examples/erp-integration/erp-sync.ts): the ERP CSV mapping, the HMAC check of the API's
// results, the reason codes, and the whole flow against the REST API on the recorded Sepolia answers (no network).
// Expected figures, computed by hand: CN 7318 from Taiwan 2.707 tCO2e/t unmarked, 2.978 with the 2026 mark-up (10 %).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingValid,
  mapErpRows,
  parseCsv,
  readErpCsv,
  reasonCodeOf,
  REASON_CODES,
  runErpSync,
  WRITEBACK_COLUMNS,
  type ErpRow,
} from "../../examples/erp-integration/erp-sync.ts";
import { ChainReader, type Deployment } from "../chain.ts";
import type { ShipmentLine } from "../portfolio.ts";
import { canonicalJson, createApiServer } from "../server.ts";
import { portfolioSchemaErrors } from "./helpers/portfolio-schema.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const path = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const csvText = readFileSync(path("examples/erp-integration/erp-export.csv"), "utf8");
const proofDir = path("fixtures/");
const recording = path("sdk/test/fixtures/sepolia-demo-rpc.json");
const deployment = JSON.parse(readFileSync(path("contracts/deployments/11155111.json"), "utf8")) as Deployment;
const EORI = "NLDEMO000000001";
const KEY = "erp-integration-test-key-0123456789abcdef";

const row = (over: Partial<ErpRow> = {}): ErpRow => ({
  rowNumber: 2,
  poNumber: "PO-1",
  poLine: "10",
  cnCode: "73181595",
  country: "TW",
  supplier: "Example Bolts Co. (fictional)",
  quantityTonnes: "1",
  importDate: "2026-12-01",
  proofFile: "",
  ...over,
});

describe("ERP CSV and mapping", () => {
  it("parses RFC 4180 CSV: BOM, CRLF and LF, quoted commas, doubled quotes, blank lines; refuses an open quote", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["1", ""]]);
    expect(() => parseCsv('a,"b\n')).toThrow(/not closed/);
  });

  it("reads columns by name in any order, ignores extra columns, names the missing ones", () => {
    const rows = readErpCsv("plant,proof_file,import_date,quantity_tonnes,supplier_name,country_of_origin,cn_code,po_line,po_number\nX,p.json,2026-12-01,3,S,tw,7318 15 95,10,PO-9\n");
    expect(rows).toEqual([{ rowNumber: 2, poNumber: "PO-9", poLine: "10", cnCode: "73181595", country: "TW", supplier: "S", quantityTonnes: "3", importDate: "2026-12-01", proofFile: "p.json" }]);
    expect(() => readErpCsv("po_number,cn_code\n")).toThrow(/lacks column\(s\) po_line, country_of_origin, supplier_name, quantity_tonnes, import_date, proof_file/);
  });

  it("maps the example export: proofs read from the proof folder, a missing proof sent without one, a bad row not sent", () => {
    const { request, lines } = mapErpRows(readErpCsv(csvText), { proofDir, eori: EORI });
    expect(request.eori).toBe(EORI);
    expect(request.shipments.map((s) => s.id)).toEqual(["PO-4500001001/10", "PO-4500001002/10", "PO-4500001003/20", "PO-4500001004/10"]);
    const [a, b, c, d] = request.shipments;
    expect(a).toMatchObject({ quantityTonnes: "200", cnCode: "73181595", country: "TW", importDate: "2026-10-10", supplier: "Demo Fasteners Co. (fictional)" });
    expect(a.proof).toEqual(JSON.parse(readFileSync(path("fixtures/sepolia-demo-proof.json"), "utf8")));
    expect(b.proof).toEqual(JSON.parse(readFileSync(path("fixtures/sepolia-demo-proof.tampered.json"), "utf8")));
    expect([c.proof, d.proof]).toEqual([null, null]);
    expect(d.note).toBe("proof-not-yet-received.json not found in the proof folder");
    expect(lines.map((l) => [l.id, l.sent, l.code ?? ""])).toEqual([
      ["PO-4500001001/10", true, ""],
      ["PO-4500001002/10", true, ""],
      ["PO-4500001003/20", true, ""],
      ["PO-4500001004/10", true, "PROOF_FILE_MISSING"],
      ["PO-4500001005/10", false, "ERP_ROW_INVALID"],
    ]);
    expect(lines[4].detail).toBe('CSV line 6: cn_code "7318159" is not 4, 6 or 8 digits');
  });

  it("rejects bad rows and proof references outside the proof folder; a file that is not a proof is sent without one", () => {
    const { request, lines } = mapErpRows(
      [
        row({ poLine: "1", proofFile: "../package.json" }),
        row({ poLine: "2", proofFile: path("fixtures/sepolia-demo-proof.json") }),
        row({ poLine: "3", proofFile: "demo.json" }),
        row({ poLine: "3" }),
        row({ poLine: "4", quantityTonnes: "1.0001" }),
        row({ poLine: "5", quantityTonnes: "0" }),
        row({ poLine: "6", importDate: "2026-02-30" }),
        row({ poLine: "7", country: "TWN" }),
        row({ poLine: "", poNumber: "PO-2" }),
      ],
      { proofDir, eori: EORI },
    );
    expect(lines.map((l) => [l.code, l.detail?.replace(/^CSV line 2: /, "")])).toEqual([
      ["ERP_ROW_INVALID", "proof_file points outside the proof folder"],
      ["ERP_ROW_INVALID", "proof_file must be a file name relative to the proof folder"],
      ["PROOF_FILE_UNREADABLE", "demo.json: not a proof (no core and signature)"],
      ["ERP_ROW_INVALID", "PO line PO-1/3 appears twice"],
      ["ERP_ROW_INVALID", 'quantity_tonnes "1.0001" is not a positive number of tonnes with at most 3 decimals'],
      ["ERP_ROW_INVALID", 'quantity_tonnes "0" is not a positive number of tonnes with at most 3 decimals'],
      ["ERP_ROW_INVALID", 'import_date "2026-02-30" is not a date YYYY-MM-DD'],
      ["ERP_ROW_INVALID", 'country_of_origin "TWN" is not an ISO 3166 alpha-2 code'],
      ["ERP_ROW_INVALID", "po_number and po_line are required"],
    ]);
    expect(request.shipments.map((s) => [s.id, s.proof])).toEqual([["PO-1/3", null]]);
  });

  it("checks the API's HMAC binding exactly as the server computes it; an altered document or another key fails", () => {
    const doc = { kind: "carbonlei-batch", counts: { VALID: 1 }, results: [{ line: { id: "a" }, verdict: { overall: "VALID" } }] };
    const mac = createHmac("sha256", KEY).update(canonicalJson(doc)).digest("hex");
    const bound = { ...doc, binding: { alg: "HMAC-SHA256", mac } };
    expect(bindingValid(bound, KEY)).toBe(true);
    expect(bindingValid(JSON.parse(JSON.stringify(bound)), Buffer.from(KEY))).toBe(true);
    expect(bindingValid({ ...bound, counts: { VALID: 2 } }, KEY)).toBe(false);
    expect(bindingValid(bound, `${KEY}x`)).toBe(false);
    expect(bindingValid(doc, KEY)).toBe(false);
    expect(bindingValid({ ...doc, binding: { alg: "HMAC-SHA256", mac: "zz" } }, KEY)).toBe(false);
  });

  it("names a reason code for every way a line ends on the default value", () => {
    const l = (over: Partial<ShipmentLine>) => ({ basis: "default", verdict: "VALID", reason: "", ...over }) as ShipmentLine;
    expect(reasonCodeOf(l({ basis: "actual" }))).toBe("VERIFIED");
    expect(reasonCodeOf(l({ verdict: "NONE" }))).toBe("NO_PROOF");
    expect(reasonCodeOf(l({ verdict: "NONE" }), { row: row(), id: "x", sent: true, code: "PROOF_FILE_MISSING" })).toBe("PROOF_FILE_MISSING");
    expect(["ERROR", "INVALID", "CONTESTED", "INCOMPLETE"].map((verdict) => reasonCodeOf(l({ verdict })))).toEqual([
      "VERIFY_ERROR",
      "PROOF_INVALID",
      "PROOF_CONTESTED",
      "PROOF_INCOMPLETE",
    ]);
    expect(reasonCodeOf(l({ reason: "check 5 did not bind the shipment to your EORI (verify with --eori)" }))).toBe("NOT_BOUND_TO_IMPORTER");
    expect(reasonCodeOf(l({ reason: "the credential covers CN 7318, not CN 7326" }))).toBe("CN_MISMATCH");
    expect(reasonCodeOf(l({ reason: "the installation is in TW, not CN" }))).toBe("ORIGIN_MISMATCH");
    expect(reasonCodeOf(l({ reason: "250 t declared but only 200 t claimed on the ledger" }))).toBe("QUANTITY_EXCEEDS_CLAIM");
    expect(reasonCodeOf(l({ reason: "re-checked after acceptance: REPORT_REVOKED (re-check of 2026-10-20, block 1)" }))).toBe("RECHECK_ACTION");
    expect(reasonCodeOf(l({ reason: 'the credential states valueType "default"' }))).toBe("NOT_ELIGIBLE");
    expect(Object.keys(REASON_CODES)).toHaveLength(16);
  });
});

describe("ERP → REST API → write-back (recorded Sepolia answers, no network)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** RPC calls are answered from the recording; calls to the local API server go through. */
  function offline() {
    const real = globalThis.fetch;
    const replay = replayFetch(recording);
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      (input instanceof Request ? input.url : String(input)).startsWith("http://127.0.0.1:") ? real(input, init) : replay(input, init),
    );
    // The recorded head is checked against the clock of the recording (head-age limit 300 s on Sepolia).
    const head = JSON.parse(readFileSync(recording, "utf8")).answers['eth_getBlockByNumber ["latest",false]'].result;
    const realNow = Date.now.bind(Date);
    const offset = Number(BigInt(head.timestamp)) * 1000 + 5_000 - realNow();
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  }
  const serve = () => ({ reader: ChainReader.forSepolia(deployment), evidenceDir: proofDir, log: () => undefined });

  it("starts the API in-process, checks the binding, plans 2026 and writes one row per ERP line with its reason code", async () => {
    offline();
    const r = await runErpSync({ csvText, proofDir, eori: EORI, year: 2026, priceEur: "82.32", hmacKey: KEY, serve: serve() });
    expect(r.results).toMatchObject({ kind: "carbonlei-batch", chainId: 11155111, eori: EORI, counts: { VALID: 1, INVALID: 1, NO_PROOF: 2, ERROR: 0 } });
    expect(bindingValid(r.results, KEY)).toBe(true);
    expect(portfolioSchemaErrors(r.plan)).toEqual([]);
    expect(r.plan.verdictSource).toMatch(/^verified by this server/);
    expect(r.rows.map((x) => [x.line.id, x.code, x.planned?.basis ?? "", x.planned?.embeddedT ?? ""])).toEqual([
      ["PO-4500001001/10", "VERIFIED", "actual", "360.000"], // 200 × 1.8
      ["PO-4500001002/10", "PROOF_INVALID", "default", "119.120"], // 40 × 2.978
      ["PO-4500001003/20", "NO_PROOF", "default", "75.939"], // 25.5 × 2.978
      ["PO-4500001004/10", "PROOF_FILE_MISSING", "default", "35.736"], // 12 × 2.978
      ["PO-4500001005/10", "ERP_ROW_INVALID", "", ""],
    ]);
    // 360 + 119.12 + 75.939 + 35.736 = 590.795 tCO2e → 591 certificates; all on defaults 277.5 × 2.978 = 826.395 → 827.
    expect(r.plan.totals).toMatchObject({ embeddedT: "590.795", certificates: 591, allDefaultCertificates: 827, onActual: 1, onDefault: 3 });

    const csv = r.csv.split("\r\n");
    expect(csv[0]).toMatch(/^# CarbonLEI ERP write-back 2026: NOT a CBAM Registry filing \/ not the Registry XML \/ not a CBAM declaration\. /);
    expect(csv[0]).toContain(`Verified at block ${r.results.pinnedBlock} (chain 11155111)`);
    expect(csv[1]).toBe(WRITEBACK_COLUMNS.join(","));
    const cells = parseCsv(r.csv).slice(2);
    const col = (name: (typeof WRITEBACK_COLUMNS)[number]) => cells.map((c) => c[WRITEBACK_COLUMNS.indexOf(name)]);
    expect(col("value_used")).toEqual(["verified", "default", "default", "default", "", "1 verified / 3 default"]);
    expect(col("see_used_tco2e_per_t").slice(0, 5)).toEqual(["1.8", "2.978", "2.978", "2.978", ""]);
    expect(col("primary_code").slice(0, 2)).toEqual(["", "DISCLOSURE_TAMPERED"]);
    expect(col("certificates_estimate_tco2e")).toEqual(["360.000", "119.120", "75.939", "35.736", "", "590.795"]);
    expect(col("reason")[3]).toBe("no supplier proof: proof-not-yet-received.json not found in the proof folder");
    expect(col("reason")[4]).toBe('CSV line 6: cn_code "7318159" is not 4, 6 or 8 digits');
    expect(cells[5].slice(0, 6)).toEqual(["TOTAL", "", "", "", "", "277.500"]);
    expect(cells[5][12]).toBe("591 whole certificates (gross)");
  }, 60_000);

  it("refuses results whose HMAC binding is not for its key (a server with another key), before any plan", async () => {
    offline();
    const other = createApiServer({ ...serve(), hmacKey: `${KEY}-other-server` });
    await new Promise<void>((ok) => other.listen(0, "127.0.0.1", ok));
    try {
      const baseUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      await expect(runErpSync({ csvText, proofDir, eori: EORI, year: 2026, hmacKey: KEY, api: { baseUrl } })).rejects.toThrow(
        /do not carry a valid HMAC binding for our key/,
      );
      await expect(runErpSync({ csvText, proofDir, eori: EORI, year: 2026, hmacKey: "short", api: { baseUrl } })).rejects.toThrow(/at least 32 bytes/);
    } finally {
      other.close();
    }
  }, 60_000);
});
