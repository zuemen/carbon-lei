// Importer workbench (sdk/portfolio.ts, sdk/batch.ts, `carbonlei verify-batch` and `carbonlei portfolio`).
// Every expected figure below is computed by hand in the comment next to it, from the sourced inputs:
// CN 7318 from Taiwan 2.707 tCO2e/t unmarked; mark-up 10 % (2026), 20 % (2027); CBAM factor 0.975 (2026),
// 0.95 (2027); Column B benchmark 1.364 (carbon steel, route C); price €82.32 (Q3 2026).
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  batchDocument,
  batchExitCode,
  loadBatchInput,
  pinnedToHead,
  runLimited,
  shipmentsFromBatch,
  type BatchDocument,
  type BatchResult,
} from "../batch.ts";
import type { ChainReader } from "../chain.ts";
import {
  buildPortfolio,
  CBAM_FACTOR,
  csvField,
  eligibility,
  fmtDec,
  markedUpDefault,
  markupFor,
  parseDec,
  roundHalfUp,
  worksheetCsv,
  WORKSHEET_COLUMNS,
  type ShipmentInput,
} from "../portfolio.ts";
import type { Verdict } from "../verdict.ts";
import { portfolioSchemaErrors } from "./helpers/portfolio-schema.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const replay = pathToFileURL(fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url))).href;
const dir = fileURLToPath(new URL("../../.cache/portfolio-test/", import.meta.url));

/** A verdict as `verify --json` prints it: VALID, check 5 passed, the demo credential's disclosures. */
function verdict(over: Partial<Verdict> = {}, disclosed: Record<string, string> = {}): Verdict {
  return {
    format: 2,
    overall: "VALID",
    primaryCode: "",
    checks: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, name: `check ${id}`, status: "pass" as const, code: "", detail: "" })),
    hidden: 0,
    rejected: 0,
    disclosed: {
      cnCode: "7318",
      unLocode: "TWKHH",
      specificEmbeddedEmissions_tCO2e_per_t: "1.8",
      valueType: "actual",
      installationId: "TW-DEMO-0001",
      supplierLEI: "ZZZZ00TWSCREWDEMO185",
      verificationReportId: "VR-DEMO-0001",
      verifierLEI: "ZZZZ00EUVERIFDEMO152",
      ...disclosed,
    },
    credSAID: "Edemo",
    chain: { chainId: 11155111, block: 11861300 },
    checkedAt: 1,
    warnings: [],
    trustAnchor: null,
    tool: { name: "carbonlei", version: "0.1.0" },
    ...over,
  };
}

const ship = (over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  id: "S1",
  verdict: verdict(),
  quantityTonnes: "200",
  cnCode: "7318",
  country: "TW",
  importDate: "2026-10-10",
  claimedTonnes: "200",
  ...over,
});

describe("decimal arithmetic and rounding", () => {
  it("parses exactly, rounds half up, formats with fixed decimals", () => {
    expect(parseDec("200", 3)).toBe(200000n);
    expect(parseDec("25.5", 3)).toBe(25500n);
    expect(parseDec("1.8000", 3)).toBe(1800n); // trailing zeros beyond the scale are allowed
    expect(() => parseDec("1.0001", 3)).toThrow(/more than 3 decimals/);
    expect(() => parseDec("-1", 3)).toThrow(/non-negative/);
    expect(() => parseDec("1e3", 3)).toThrow(/non-negative decimal/);
    expect(roundHalfUp(12345n, 1)).toBe(1235n); // 1234.5 → 1235
    expect(roundHalfUp(12344n, 1)).toBe(1234n);
    expect(fmtDec(5n, 3)).toBe("0.005");
    expect(fmtDec(-1500n, 3)).toBe("-1.500");
  });

  it("mark-ups by year and sector (IR 2026/1740 Annex I): 10/20/30 %, fertilisers 1 %; marked-up value to 3 decimals", () => {
    expect(markupFor("7318", 2026).pct).toBe(10);
    expect(markupFor("7318 15 95", 2027).pct).toBe(20);
    expect(markupFor("7601", 2028).pct).toBe(30);
    expect(markupFor("7318", 2031).pct).toBe(30);
    expect(markupFor("3102", 2027).pct).toBe(1);
    expect(() => markupFor("7318", 2025)).toThrow(/before the definitive period/);
    expect(() => markupFor("2716", 2026)).toThrow(/electricity/);
    expect(markedUpDefault("2.707", "7318", 2026)).toBe("2.978"); // 2.9777 → 2.978
    expect(markedUpDefault("2.707", "7318", 2027)).toBe("3.248"); // 3.2484 → 3.248
    expect(markedUpDefault("2.707", "7318", 2028)).toBe("3.519"); // 3.5191 → 3.519
  });

  it("CBAM factor table (Commission guidance of 24 August 2026, Table 3)", () => {
    expect(CBAM_FACTOR[2026]).toBe(0.975);
    expect(CBAM_FACTOR[2027]).toBe(0.95);
    expect(CBAM_FACTOR[2030]).toBe(0.515);
    expect(CBAM_FACTOR[2034]).toBe(0);
  });
});

describe("eligibility: the verified value only for a VALID proof bound to the importer", () => {
  it("accepts the demo case and names the reason for every refusal", () => {
    expect(eligibility(ship())).toEqual({ ok: true, see: "1.8" });
    expect(eligibility(ship({ verdict: null }))).toEqual({ ok: false, reason: "no supplier proof" });
    expect(eligibility(ship({ verifyError: "RPC down" }))).toMatchObject({ ok: false, reason: "verification did not run: RPC down" });
    expect(eligibility(ship({ verdict: verdict({ overall: "INVALID", primaryCode: "DISCLOSURE_TAMPERED" }) }))).toMatchObject({
      reason: "proof INVALID (DISCLOSURE_TAMPERED)",
    });
    expect(eligibility(ship({ verdict: verdict({ overall: "CONTESTED", primaryCode: "" }) }))).toMatchObject({ reason: "proof CONTESTED" });
    expect(eligibility(ship({ verdict: verdict({ overall: "INCOMPLETE" }) }))).toMatchObject({ reason: "proof INCOMPLETE" });
    const noCheck5 = verdict();
    noCheck5.checks[5] = { ...noCheck5.checks[5], status: "skipped" };
    expect(eligibility(ship({ verdict: noCheck5 }))).toMatchObject({ reason: expect.stringMatching(/check 5/) });
    expect(eligibility(ship({ verdict: verdict({}, { specificEmbeddedEmissions_tCO2e_per_t: undefined as unknown as string }) }))).toMatchObject({
      ok: false,
    });
    expect(eligibility(ship({ cnCode: "7326" }))).toMatchObject({ reason: "the credential covers CN 7318, not CN 7326" });
    expect(eligibility(ship({ cnCode: "73181595" }))).toEqual({ ok: true, see: "1.8" }); // 8-digit within the 4-digit credential
    expect(eligibility(ship({ country: "CN" }))).toMatchObject({ reason: "the installation is in TW, not CN" });
    expect(eligibility(ship({ quantityTonnes: "200.001" }))).toMatchObject({ reason: "200.001 t declared but only 200 t claimed on the ledger" });
    expect(eligibility(ship({ verdict: verdict({}, { valueType: "default" }) }))).toMatchObject({ reason: 'the credential states valueType "default"' });
  });
});

describe("buildPortfolio: hand-computed vectors", () => {
  it("the demo shipment alone, 2026, €82.32: 360 vs 595.6 tCO2e, € 19,394.59 difference", () => {
    const p = buildPortfolio([ship()], { year: 2026, priceEur: "82.32" });
    const l = p.shipments[0];
    expect(l).toMatchObject({ basis: "actual", seeUsed: "1.8", defaultMarkedUp: "2.978", embeddedT: "360.000", allDefaultT: "595.600", quarter: 4 });
    expect(l.holdingBasisT).toBe("541.400"); // 200 × 2.707 (unmarked)
    expect(p.totals).toMatchObject({
      embeddedT: "360.000",
      allDefaultT: "595.600",
      gapT: "235.600", // 595.6 − 360
      certificates: 360,
      allDefaultCertificates: 596, // ⌈595.6⌉
      grossEur: "29635.20", // 360 × 82.32
      allDefaultGrossEur: "49029.79", // 595.6 × 82.32 = 49,029.792
      savedEur: "19394.59",
    });
    expect(p.deMinimis).toEqual({ thresholdTonnes: 50, netMassTonnes: "200.000", exempt: false, exceededBy: { id: "S1", importDate: "2026-10-10", quarter: 4 } });
    expect(p.quarterlyHolding.every((q) => !q.applies && /from 2027/.test(q.why))).toBe(true);
    expect(p.freeAllocation.applied).toBe("none");
    expect(portfolioSchemaErrors(p)).toEqual([]);
  });

  it("mixed portfolio: defaults with the reason, groups, de minimis crossing, 2026 quarter prices", () => {
    const p = buildPortfolio(
      [
        ship({ id: "A", quantityTonnes: "20", claimedTonnes: "20", importDate: "2026-02-01", supplier: "Sup A", installation: "I-A" }),
        ship({ id: "B", quantityTonnes: "25.5", verdict: null, cnCode: "73181595", importDate: "2026-05-15", supplier: "Sup B", installation: "I-B" }),
        ship({ id: "C", quantityTonnes: "10", claimedTonnes: "10", importDate: "2026-08-30", verdict: verdict({ overall: "INVALID", primaryCode: "DISCLOSURE_TAMPERED" }), supplier: "Sup A", installation: "I-A" }),
        ship({ id: "OLD", importDate: "2025-12-31" }),
      ],
      { year: 2026, quarterPrices: { 1: "75.36", 2: "75.28", 3: "82.32" } },
    );
    expect(p.excluded).toEqual([{ id: "OLD", reason: "imported in 2025, not 2026" }]);
    const [a, b, c] = p.shipments;
    expect(a).toMatchObject({ basis: "actual", embeddedT: "36.000", allDefaultT: "59.560" }); // 20 × 1.8; 20 × 2.978
    expect(b).toMatchObject({ basis: "default", reason: "no supplier proof", embeddedT: "75.939", verdict: "NONE" }); // 25.5 × 2.978 = 75.939
    expect(c).toMatchObject({ basis: "default", reason: "proof INVALID (DISCLOSURE_TAMPERED)", embeddedT: "29.780" }); // 10 × 2.978
    expect(p.totals).toMatchObject({ quantityTonnes: "55.500", embeddedT: "141.719", allDefaultT: "165.279", gapT: "23.560", onActual: 1, onDefault: 2 });
    // € by quarter of importation: 36 × 75.36 + 75.939 × 75.28 + 29.78 × 82.32
    //   = 2,712.96 + 5,716.68792 + 2,451.4896 = 10,881.13752 → 10,881.14
    expect(p.totals.grossEur).toBe("10881.14");
    // all-default: 59.56 × 75.36 + 75.939 × 75.28 + 29.78 × 82.32 = 4,488.4416 + 5,716.68792 + 2,451.4896 = 12,656.61912
    expect(p.totals.allDefaultGrossEur).toBe("12656.62");
    expect(p.totals.savedEur).toBe("1775.48");
    expect(p.prices).toEqual({ Q1: "75.36", Q2: "75.28", Q3: "82.32", Q4: null });
    // 20 t (Feb) + 25.5 t (May) = 45.5 t; + 10 t (Aug) = 55.5 t > 50 t: line C crosses the threshold.
    expect(p.deMinimis.exceededBy).toEqual({ id: "C", importDate: "2026-08-30", quarter: 3 });
    expect(p.bySupplier).toEqual([
      { key: "Sup A", shipments: 2, quantityTonnes: "30.000", embeddedT: "65.780", allDefaultT: "89.340" },
      { key: "Sup B", shipments: 1, quantityTonnes: "25.500", embeddedT: "75.939", allDefaultT: "75.939" },
    ]);
    expect(p.byCnCode.map((g) => g.key)).toEqual(["7318", "73181595"]);
    expect(p.byQuarter.map((g) => [g.key, g.embeddedT])).toEqual([["Q1", "36.000"], ["Q2", "75.939"], ["Q3", "29.780"]]);
    expect(p.byCountry).toEqual([{ key: "TW", shipments: 3, quantityTonnes: "55.500", embeddedT: "141.719", allDefaultT: "165.279" }]);
    expect(portfolioSchemaErrors(p)).toEqual([]);
  });

  it("no € without a price for every quarter", () => {
    const p = buildPortfolio([ship()], { year: 2026, quarterPrices: { 3: "82.32" } });
    expect(p.totals.grossEur).toBeNull();
    expect(p.totals.savedEur).toBeNull();
  });

  it("de minimis: exactly 50 t is exempt (does not exceed), 50.001 t is not (Art 2a)", () => {
    const at = (q: string) => buildPortfolio([ship({ quantityTonnes: q, claimedTonnes: q })], { year: 2026 }).deMinimis;
    expect(at("50").exempt).toBe(true);
    expect(at("50").exceededBy).toBeNull();
    expect(at("50.001").exempt).toBe(false);
    const p = buildPortfolio([ship({ quantityTonnes: "40", claimedTonnes: "40" })], { year: 2026 });
    expect(p.notes.join(" ")).toMatch(/does not exceed 50 t: exempt for 2026/);
  });

  it("free-allocation adjustment, 2026: SEFA = 0.975 × 1 × 1.364 = 1.3299 tCO2e/t", () => {
    const fa = { benchmarks: { "TW:7318": "1.364" } };
    const p = buildPortfolio([ship(), ship({ id: "D", verdict: null, quantityTonnes: "100", importDate: "2026-11-01" })], { year: 2026, priceEur: "82.32", freeAllocation: fa });
    const [actual, def] = p.shipments;
    // Actual line without the operator's SEFA: gross (the operator's verified SEFA is not in the credential).
    expect(actual).toMatchObject({ embeddedT: "360.000", adjustmentT: "", obligationT: "360.000" });
    // Default line: 100 × 2.978 = 297.8; adjustment 100 × 1.3299 = 132.99; obligation 164.81.
    expect(def).toMatchObject({ embeddedT: "297.800", adjustmentT: "132.990", obligationT: "164.810" });
    expect(p.freeAllocation).toMatchObject({ applied: "partial", cbamFactor: "0.975", cscf: "1" });
    // All-default obligation: (595.6 − 265.98) + 164.81 = 329.62 + 164.81 = 494.43 → 495 certificates.
    expect(p.totals).toMatchObject({ obligationT: "524.810", allDefaultObligationT: "494.430", certificates: 525, allDefaultCertificates: 495 });
    // With the operator's verified SEFA on the actual line: 360 − 200 × 1.3299 = 360 − 265.98 = 94.02.
    const q = buildPortfolio([ship({ sefaActual: "1.3299" })], { year: 2026, freeAllocation: fa });
    expect(q.shipments[0]).toMatchObject({ adjustmentT: "265.980", obligationT: "94.020" });
    expect(q.freeAllocation.applied).toBe("all");
    expect(portfolioSchemaErrors(p)).toEqual([]);
  });

  it("quarterly holding, 2027: unmarked defaults, from the quarter after the 50 t crossing (Art 22(2), (2a))", () => {
    const lines = [
      ship({ id: "Q1", quantityTonnes: "30", claimedTonnes: "30", importDate: "2027-02-10" }),
      ship({ id: "Q2", quantityTonnes: "30", claimedTonnes: "30", importDate: "2027-05-10" }),
      ship({ id: "Q3", quantityTonnes: "100", claimedTonnes: "100", importDate: "2027-07-01" }),
    ];
    const gross = buildPortfolio(lines, { year: 2027 });
    expect(gross.shipments[0].defaultMarkedUp).toBe("3.248");
    // Basis 2.707 per t: Q1 81.21; Q2 162.42; Q3 and Q4 160 × 2.707 = 433.12; required 50 %.
    expect(gross.quarterlyHolding.map((q) => [q.cumulativeBasisT, q.requiredT, q.requiredCertificates, q.applies])).toEqual([
      ["81.210", "40.605", 41, false],
      ["162.420", "81.210", 82, false],
      ["433.120", "216.560", 217, true],
      ["433.120", "216.560", 217, true],
    ]);
    expect(gross.quarterlyHolding[0].why).toMatch(/exceeded in Q2/);
    expect(gross.quarterlyHolding[1].why).toMatch(/end of the next quarter/);
    // With the 2027 adjustment: SEFA 0.95 × 1.364 = 1.2958; basis 2.707 − 1.2958 = 1.4112 per t;
    // Q3: 30 × 1.4112 + 30 × 1.4112 + 100 × 1.4112 = 42.336 + 42.336 + 141.12 = 225.792; 50 % = 112.896 → 113.
    const net = buildPortfolio(lines, { year: 2027, freeAllocation: { benchmarks: { "TW:7318": "1.364" } } });
    expect(net.quarterlyHolding[2]).toMatchObject({ cumulativeBasisT: "225.792", requiredT: "112.896", requiredCertificates: 113, applies: true });
    // Within 50 t for the whole year: never required.
    const small = buildPortfolio([lines[0]], { year: 2027 });
    expect(small.quarterlyHolding.every((q) => !q.applies && /de minimis/.test(q.why))).toBe(true);
  });

  it("rejects malformed input, naming the line", () => {
    expect(() => buildPortfolio([ship({ cnCode: "73" })], { year: 2026 })).toThrow(/S1: CN code must be 4 to 8 digits/);
    expect(() => buildPortfolio([ship({ country: "Taiwan" })], { year: 2026 })).toThrow(/S1: country/);
    expect(() => buildPortfolio([ship({ importDate: "10/10/2026" })], { year: 2026 })).toThrow(/S1: import date/);
    expect(() => buildPortfolio([ship({ quantityTonnes: "1.0005" })], { year: 2026 })).toThrow(/more than 3 decimals/);
    expect(() => buildPortfolio([ship(), ship()], { year: 2026 })).toThrow(/duplicate id/);
    expect(() => buildPortfolio([ship({ country: "VN", verdict: null })], { year: 2026 })).toThrow(/no default value known for CN 7318 from VN/);
    expect(() => buildPortfolio([ship()], { year: 2025 })).toThrow(/before the definitive period/);
    // A default passed by the caller is used (and the mark-up applied).
    const vn = buildPortfolio([ship({ country: "VN", verdict: null })], { year: 2026, defaults: { "VN:7318": "3.000" } });
    expect(vn.shipments[0]).toMatchObject({ defaultValue: "3.000", defaultMarkedUp: "3.300", embeddedT: "660.000" });
  });
});

describe("worksheet CSV", () => {
  it("title row, the declaration columns, one row per line, a total; CSV injection neutralised", () => {
    const p = buildPortfolio([ship(), ship({ id: "=HYPERLINK(1)", verdict: null, supplier: 'A "B", C' })], { year: 2026 });
    const rows = worksheetCsv(p).split("\r\n");
    expect(rows[0]).toMatch(/not the CBAM Registry XML schema/);
    expect(rows[1]).toBe(WORKSHEET_COLUMNS.join(","));
    expect(rows[2]).toMatch(/^S1,7318,TW,TW-DEMO-0001,ZZZZ00TWSCREWDEMO185,2026-10-10,Q4,200.000,1.8,,actual,2.707,2.978,360.000,,360.000,VALID,,VR-DEMO-0001/);
    expect(rows[3].startsWith("'=HYPERLINK(1)")).toBe(true);
    expect(rows[3]).toContain('"A ""B"", C"');
    expect(rows[4]).toMatch(/^TOTAL,.*,400.000,.*955.600,,955.600$/); // 360 + 595.6
    expect(csvField("-1.5")).toBe("-1.5");
    expect(csvField("+31")).toBe("'+31");
  });
});

describe("verify-batch helpers", () => {
  it("runLimited keeps input order and never exceeds the concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await runLimited([30, 5, 20, 1, 10], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    await expect(runLimited([1], 5, async () => 0)).rejects.toThrow(/1 to 4/);
  });

  it("pinnedToHead answers every latestBlock with the one head and keeps the reader's other methods", async () => {
    let calls = 0;
    const base = { latestBlock: async () => ({ number: BigInt(++calls), timestamp: 0n }), chainId: 11155111 } as unknown as ChainReader;
    const head = await base.latestBlock();
    const pinned = pinnedToHead(base, head);
    expect((await pinned.latestBlock()).number).toBe(1n);
    expect((await pinned.latestBlock()).number).toBe(1n);
    expect(calls).toBe(1);
    expect(pinned.chainId).toBe(11155111);
  });

  it("exit code: error 3, else INVALID 1, CONTESTED 2, INCOMPLETE 4, else 0", () => {
    const res = (v: Verdict | null, error: string | null = null): BatchResult => ({ proof: "p.json", line: {}, verdict: v, error, proofShipment: null });
    expect(batchExitCode(batchDocument([res(verdict()), res(null)], {}))).toBe(0);
    expect(batchExitCode(batchDocument([res(verdict()), res(verdict({ overall: "INCOMPLETE" }))], {}))).toBe(4);
    expect(batchExitCode(batchDocument([res(verdict({ overall: "CONTESTED" })), res(verdict({ overall: "INCOMPLETE" }))], {}))).toBe(2);
    expect(batchExitCode(batchDocument([res(verdict({ overall: "CONTESTED" })), res(verdict({ overall: "INVALID" }))], {}))).toBe(1);
    expect(batchExitCode(batchDocument([res(verdict({ overall: "INVALID" })), res(null, "boom")], {}))).toBe(3);
  });

  it("shipmentsFromBatch: manifest fields win; the proof's quantity and date only when check 5 passed", () => {
    const bound = verdict();
    const unbound = verdict();
    unbound.checks[5] = { ...unbound.checks[5], status: "skipped" };
    const doc = batchDocument(
      [
        { proof: "a.json", line: {}, verdict: bound, error: null, proofShipment: { batchId: "B-1", quantityTonnes: "200", shipmentDate: "2026-10-10" } },
        { proof: "b.json", line: { quantityTonnes: "5", importDate: "2026-03-01" }, verdict: unbound, error: null, proofShipment: { batchId: "B-1", quantityTonnes: "999", shipmentDate: "2026-01-01" } },
      ],
      {},
    );
    const [a, b] = shipmentsFromBatch(doc);
    expect(a).toMatchObject({ id: "B-1", quantityTonnes: "200", importDate: "2026-10-10", cnCode: "7318", country: "TW", claimedTonnes: "200" });
    expect(b).toMatchObject({ id: "B-1 (b.json)", quantityTonnes: "5", importDate: "2026-03-01" });
    expect(b.claimedTonnes).toBeUndefined();
    const missing = batchDocument([{ proof: "c.json", line: {}, verdict: unbound, error: null, proofShipment: { batchId: "B-2", quantityTonnes: "1", shipmentDate: "2026-01-01" } }], {});
    expect(() => shipmentsFromBatch(missing)).toThrow(/B-2: no quantityTonnes .*--eori/);
    expect(() => shipmentsFromBatch({ kind: "x" } as unknown as BatchDocument)).toThrow(/not a carbonlei verify-batch results file/);
  });

  it("loadBatchInput: a folder lists its proof files; a manifest resolves proofs next to it", () => {
    const folder = loadBatchInput(`${root}fixtures`);
    expect(folder.entries.map((e) => e.line.proof)).toEqual(["sepolia-demo-proof.json", "sepolia-demo-proof.tampered.json"]);
    expect(folder.skipped).toContain("demo.json");
    const m = loadBatchInput(`${root}fixtures/workbench/manifest.json`);
    expect(m.eori).toBe("NLDEMO000000001");
    expect(m.entries.map((e) => Boolean(e.proofPath?.endsWith("sepolia-demo-proof.json")))).toEqual([true, false, false]);
    expect(m.entries[2].proofPath).toBeNull();
  });
});

describe("carbonlei verify-batch and portfolio (recorded Sepolia answers)", () => {
  it("verifies the manifest at one pinned block, exits 1 for the tampered copy, and plans the year", async () => {
    mkdirSync(dir, { recursive: true });
    const results = `${dir}results.json`;
    const r = await run(process.execPath, ["--import", replay, cli, "verify-batch", `${root}fixtures/workbench/manifest.json`, "--out", results, "--json"], {
      env: { ...process.env, RPC_REPLAY: recording },
    }).catch((e) => e);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout) as BatchDocument;
    expect(doc).toMatchObject({ kind: "carbonlei-batch", chainId: 11155111, eori: "NLDEMO000000001", counts: { VALID: 1, INVALID: 1, NO_PROOF: 1, ERROR: 0 } });
    expect(doc.pinnedBlock).toBe(Number(BigInt(JSON.parse(readFileSync(recording, "utf8")).answers['eth_getBlockByNumber ["latest",false]'].result.number)));
    expect(doc.results.every((x) => x.verdict === null || x.verdict.chain.block === doc.pinnedBlock)).toBe(true);
    expect(doc.results[1].verdict?.primaryCode).toBe("DISCLOSURE_TAMPERED");
    expect(JSON.parse(readFileSync(results, "utf8"))).toEqual(doc);

    const csv = `${dir}worksheet.csv`;
    const p = await run(process.execPath, [cli, "portfolio", results, "--year", "2026", "--price", "82.32", "--csv", csv, "--json"]);
    const s = JSON.parse(p.stdout);
    expect(portfolioSchemaErrors(s)).toEqual([]);
    // 200 × 1.8 = 360; 40 × 2.978 = 119.12; 25.5 × 2.978 = 75.939 → 555.059; all-default 265.5 × 2.978 = 790.659.
    expect(s.totals).toMatchObject({ embeddedT: "555.059", allDefaultT: "790.659", gapT: "235.600", certificates: 556, savedEur: "19394.59" });
    expect(s.shipments.map((l: { basis: string }) => l.basis)).toEqual(["actual", "default", "default"]);
    expect(readFileSync(csv, "utf8").split("\r\n")[2]).toMatch(/^BATCH-DEMO-2026-0001,7318,TW,TW-ZZZZ00TWSCREWDEMO185-0001,/);

    const text = await run(process.execPath, [cli, "portfolio", results, "--year", "2026", "--price", "82.32"]);
    expect(text.stdout).toContain("worksheet, not a CBAM declaration");
    expect(text.stdout).toContain("Certificates to surrender 556 (all on defaults: 791)");
    // Text output groups thousands as the page does; the JSON keeps the plain decimal string.
    expect(text.stdout).toContain("Gross €45,692.46 (all on defaults €65,087.05; difference €19,394.59)");
    expect(s.totals.grossEur).toBe("45692.46");

    writeFileSync(`${dir}bm.json`, JSON.stringify({ "TW:7318": "1.364" }));
    const withFa = JSON.parse((await run(process.execPath, [cli, "portfolio", results, "--year", "2026", "--benchmarks", `${dir}bm.json`, "--json"])).stdout);
    // Default lines: (40 + 25.5) × 1.3299 = 53.196 + 33.91245 → 53.196 + 33.912 = 87.108 tCO2e deducted.
    expect(withFa.totals.adjustmentT).toBe("87.108");
    const bad = await run(process.execPath, [cli, "portfolio", results]).catch((e) => e);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--year");
  }, 60_000);
});
