// Built-in CBAM default values: Annex I to Commission Implementing Regulation (EU) 2026/1740, parsed by
// scripts/parse-default-values.mjs from the Official Journal XHTML (SHA-256 pinned) into
// sdk/data/default-values-2026-1740.json, and looked up by sdk/portfolio.ts (`annexDefault`, `buildPortfolio`).
//
// Expected values below were read from that extraction and, for the three quoted rows, from the annex text itself:
// the quotes are the rows' cell text as the source XHTML renders it (accessed 2026-10-17), parsed here by a separate
// regular expression, not by the parser under test.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ES module without type declarations
import { ACCESSED, EXPECTED_SHA256, SOURCE_URL, buildDocument, parseAnnexI, serialise } from "../../scripts/parse-default-values.mjs";
import { annexDefault, buildPortfolio, DEFAULT_VALUES, type ShipmentInput } from "../portfolio.ts";
import { createApiServer } from "../server.ts";
import { portfolioSchemaErrors } from "./helpers/portfolio-schema.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const dataFile = fileURLToPath(new URL("../data/default-values-2026-1740.json", import.meta.url));
const dir = fileURLToPath(new URL("../../.cache/default-values-test/", import.meta.url));

const row = (iso: string, code: string) => DEFAULT_VALUES.countries[iso]?.rows[code];

describe("Annex I extraction (IR (EU) 2026/1740)", () => {
  it("names its source: URL, access date, SHA-256 pinned by the parser; 121 countries + Other Countries and Territories", () => {
    expect(DEFAULT_VALUES.source).toMatchObject({ url: SOURCE_URL, accessed: ACCESSED, sha256: EXPECTED_SHA256, parser: "scripts/parse-default-values.mjs" });
    expect(DEFAULT_VALUES.source.url).toBe("http://publications.europa.eu/resource/celex/32026R1740");
    expect(DEFAULT_VALUES.source.accessed).toBe("2026-10-17");
    expect(DEFAULT_VALUES.source.sha256).toBe("4e9291a81606f1a3c0579df63373af52d998817d9de9081f6b579982f88dfb33");
    expect(DEFAULT_VALUES.source.act).toContain("Implementing Regulation (EU) 2026/1740 of 20 July 2026");
    expect(Object.keys(DEFAULT_VALUES.countries)).toHaveLength(122);
    expect(DEFAULT_VALUES.countries.OTHER.name).toBe("Other Countries and Territories");
    const s = DEFAULT_VALUES.stats as { rows: number; rowsWithValue: number; rowsWithoutValue: number };
    const counted = Object.values(DEFAULT_VALUES.countries).reduce((n, c) => n + Object.keys(c.rows).length, 0);
    expect(counted).toBe(s.rows);
    expect(s.rowsWithValue + s.rowsWithoutValue).toBe(s.rows);
    expect(s.rows).toBe(11670);
  });

  it("the committed file is the parser's own serialisation (byte-stable, one row per line)", () => {
    const text = readFileSync(dataFile, "utf8");
    expect(serialise(JSON.parse(text))).toBe(text);
  });

  it("spot checks across countries, sectors and CN code lengths (direct, indirect, total, route)", () => {
    expect(row("TW", "731815")).toEqual(["2.707", "N/A", "2.707", "C"]);
    expect(row("OTHER", "731815")).toEqual(["4.801", "N/A", "4.801", "C"]);
    expect(row("VN", "731816")).toEqual(["2.960", "N/A", "2.960", "C"]);
    expect(row("IN", "7208")).toEqual(["4.280", "N/A", "4.280", "C"]);
    expect(row("TR", "72142000")).toEqual(["2.310", "N/A", "2.310", "C"]);
    expect(row("KR", "73063077")).toEqual(["2.164", "N/A", "2.164", "C"]);
    expect(row("UA", "72071111")).toEqual(["2.397", "N/A", "2.397", "C"]);
    expect(row("GB", "7308")).toEqual(["3.040", "N/A", "3.040", "C"]);
    expect(row("JP", "73044100")).toEqual(["3.320", "N/A", "3.320", ""]);
    expect(row("US", "7601")).toEqual(["1.700", "N/A", "1.700", "K"]);
    expect(row("TW", "28041000")).toEqual(["10.820", "N/A", "10.820", ""]); // hydrogen
    expect(row("AL", "25232900")).toEqual(["0.900", "0.030", "0.930", ""]); // cement: indirect given
    // Recital 9: values added for Zambia 7202 11 and Zimbabwe 7202 41.
    expect(row("ZM", "720211")).toEqual(["1.690", "N/A", "1.690", ""]);
    expect(row("ZW", "720241")).toEqual(["2.350", "N/A", "2.350", ""]);
    // "-" kept as null; "see below" group headings not stored.
    expect(row("TW", "72181000")).toEqual([null, "N/A", null, ""]);
    expect(row("TW", "7318")).toBeUndefined();
    // Every Taiwanese CN 7318 line: 2.707 direct, N/A indirect, 2.707 total (the value the SDK had built in before).
    const tw7318 = Object.entries(DEFAULT_VALUES.countries.TW.rows).filter(([c]) => c.startsWith("7318"));
    expect(tw7318).toHaveLength(15);
    expect(tw7318.every(([, r]) => r[0] === "2.707" && r[1] === "N/A" && r[2] === "2.707")).toBe(true);
  });

  it("three rows checked against the annex text quoted from the source", () => {
    // Each quote: code, description, direct, indirect, total, route, as the source's table row reads.
    const quotes: [string, string, string][] = [
      ["TW", "Taiwan", "7318 15 Threaded screws and bolts, of iron or steel, whether or not with their nuts and washers (excl. coach screws and other wood screws, screw hooks and screw rings, self-tapping screws, lag screws, stoppers, plugs and the like, threaded) 2,707 N/A 2,707 (C)"],
      ["CN", "China", "7318 15 Threaded screws and bolts, of iron or steel, whether or not with their nuts and washers (excl. coach screws and other wood screws, screw hooks and screw rings, self-tapping screws, lag screws, stoppers, plugs and the like, threaded) 6,375 N/A 6,375 (C)"],
      ["OTHER", "Other Countries and Territories", 'Flat-rolled products of high-speed steel, of a width of <= 600 mm, hot-rolled or cold-rolled "cold-reduced" 5,500 N/A 5,500 (F)'],
    ];
    const codes = ["731815", "731815", "72262000"];
    quotes.forEach(([iso, name, quote], k) => {
      const m = /(\d+),(\d{3}) (N\/A|\d+,\d{3}) (\d+),(\d{3})(?: \(([A-L])\))?$/.exec(quote)!;
      expect(DEFAULT_VALUES.countries[iso].name).toBe(name);
      expect(row(iso, codes[k])).toEqual([`${m[1]}.${m[2]}`, m[3], `${m[4]}.${m[5]}`, m[6] ?? ""]);
    });
  });
});

describe("parseAnnexI on the source's markup", () => {
  const cell = (cls: string, t: string) => `<td valign="top" class="oj-table"><p class="${cls}">${t}</p></td>`;
  const heads = ["Product CN Code / TARIC Code", "Description", "Default Value (direct emissions) (tCO<span class=\"oj-sub\">2</span>eq/tonne of good)", "Default Value (indirect emissions) (tCO<span class=\"oj-sub\">2</span>eq/tonne of good)", "Default Value (total emissions) (tCO<span class=\"oj-sub\">2</span>eq/tonne of good)", "Underlying production route determining CBAM BM"];
  const table = (country: string, rows: string[][], sixth = heads[5]) =>
    `<table width="100%" class="oj-table"><tbody><tr class="oj-table"><td colspan="6"><p class="oj-tbl-hdr"><span class="oj-bold">${country}</span></p></td></tr>` +
    `<tr class="oj-table">${[...heads.slice(0, 5), sixth].map((h) => cell("oj-tbl-hdr", h)).join("")}</tr>` +
    rows.map((r) => `<tr class="oj-table">${r.map((c, i) => cell(i === 0 ? "oj-tbl-cod" : "oj-tbl-txt", c)).join("")}</tr>`).join("") +
    `</tbody></table>`;
  const doc = (...tables: string[]) =>
    `<p>Default values for goods imported into the customs territory of the Union, except for electricity</p>${tables.join("")}<p class="oj-doc-ti">ANNEX II</p>`;
  const tw = table("Taiwan", [
    ["<span class=\"oj-bold\">Iron and steel</span>", " ", " ", " ", " ", " "],
    ["7318", "Screws", "see below", "see below", "see below", " "],
    ["7318 15", "Threaded screws", "2,707", "N/A", "2,707", "(C)"],
    ["7218 10 00", "Steel, stainless", "-", "N/A", "-", " "],
    ["2523900090", "Other hydraulic cements", "0,860", "0,030", "0,890", "(A)"],
  ]);
  const other = table("Other Countries and Territories", [["7318 15", "Threaded screws", "4,801", "N/A", "4,801", "(C)"]]);

  it("reads codes, values, '-' and routes; skips sector and 'see below' rows", () => {
    const { countries, stats } = parseAnnexI(doc(tw, other));
    expect(countries.TW.rows).toEqual({ "731815": ["2.707", "N/A", "2.707", "C"], "72181000": [null, "N/A", null, ""], "2523900090": ["0.860", "0.030", "0.890", "A"] });
    expect(countries.OTHER.rows["731815"]).toEqual(["4.801", "N/A", "4.801", "C"]);
    expect(stats).toMatchObject({ tables: 2, rows: 4, valued: 3, noValue: 1, groupHeadings: 1 });
    // Same input, same bytes.
    expect(serialise(buildDocument(doc(tw, other), "00"))).toBe(serialise(buildDocument(doc(tw, other), "00")));
  });

  it("stops on what it does not recognise instead of guessing", () => {
    expect(() => parseAnnexI(doc(table("Atlantis", []), other))).toThrow(/unknown country heading "Atlantis"/);
    expect(() => parseAnnexI(doc(table("Taiwan", [["7318 15", "x", "2.707", "N/A", "2.707", "(C)"]]), other))).toThrow(/unexpected value "2.707"/);
    expect(() => parseAnnexI(doc(table("Taiwan", [["7318 1", "x", "2,707", "N/A", "2,707", ""]]), other))).toThrow(/unexpected code/);
    expect(() => parseAnnexI(doc(tw))).toThrow(/Other Countries and Territories/);
    expect(() => parseAnnexI(doc(table("Taiwan", [], "Route"), other))).toThrow(/unexpected column headings/);
    // The one stray prefix in the source (Oman's sixth heading, "A Underlying …") is accepted.
    expect(parseAnnexI(doc(table("Oman", [], `A ${heads[5]}`), other)).countries.OM.rows).toEqual({});
  });
});

describe("annexDefault: lookup with the annex's fallback rule", () => {
  it("Taiwan CN 7318: 2.707 for the heading (all 15 lines agree) and for an 8-digit code", () => {
    expect(annexDefault("TW", "7318")).toEqual({ value: "2.707", table: "TW", code: "7318", source: "IR (EU) 2026/1740 Annex I, Taiwan, every one of the 15 lines under CN 7318" });
    expect(annexDefault("tw", "7318 15 95")).toMatchObject({ value: "2.707", table: "TW", code: "731815", source: "IR (EU) 2026/1740 Annex I, Taiwan, CN 7318 15" });
  });

  it("a listed country uses its own table; the longest listed code wins", () => {
    expect(annexDefault("VN", "73181595")).toMatchObject({ value: "2.750", table: "VN", code: "731815" });
    expect(annexDefault("CN", "73181595")).toMatchObject({ value: "6.375", table: "CN" });
    expect(annexDefault("IN", "72081000")).toMatchObject({ value: "4.280", table: "IN", code: "7208" });
  });

  it("an unlisted country, or a '-' field, takes 'Other Countries and Territories' (Annex I opening paragraph)", () => {
    expect(annexDefault("XK", "73181595")).toMatchObject({ value: "4.801", table: "OTHER", source: expect.stringContaining("(XK is not listed)") });
    expect(annexDefault("TW", "72181000")).toMatchObject({ value: "5.006", table: "OTHER", source: expect.stringContaining('(TW shows "-" for CN 7218 10 00)') });
  });

  it("a short code whose lines differ, or a good outside Annex I, gets a reason instead of a value", () => {
    expect(annexDefault("VN", "7318")).toMatchObject({ value: undefined, reason: expect.stringContaining("different default values in the Viet Nam table") });
    expect(annexDefault("TW", "25231000")).toMatchObject({ value: undefined, reason: expect.stringContaining("give the longer CN or TARIC code, or pass the value in `defaults`") }); // white vs grey clinker (TARIC)
    expect(annexDefault("US", "8471")).toMatchObject({ value: undefined, reason: expect.stringContaining("not a good it lists") });
  });
});

describe("buildPortfolio on the built-in Annex I", () => {
  const line = (over: Partial<ShipmentInput>): ShipmentInput => ({ id: "L1", verdict: null, quantityTonnes: "100", cnCode: "7318", country: "TW", importDate: "2026-10-10", ...over });

  it("Taiwan CN 7318 unchanged: 2.707 unmarked, 2.978 marked up in 2026, 3.248 in 2027", () => {
    const p = buildPortfolio([line({})], { year: 2026 });
    // 100 × 2.707 × 1.10 = 100 × 2.978 (2.9777 rounded half up) = 297.8 tCO2e.
    expect(p.shipments[0]).toMatchObject({ defaultValue: "2.707", defaultMarkedUp: "2.978", embeddedT: "297.800", defaultSource: "IR (EU) 2026/1740 Annex I, Taiwan, every one of the 15 lines under CN 7318" });
    expect(portfolioSchemaErrors(p)).toEqual([]);
    // 2.707 × 1.20 = 3.2484 → 3.248.
    expect(buildPortfolio([line({ importDate: "2027-01-05", cnCode: "73181595" })], { year: 2027 }).shipments[0]).toMatchObject({ defaultValue: "2.707", defaultMarkedUp: "3.248" });
  });

  it("a supplier outside Taiwan is planned without passing defaults", () => {
    const p = buildPortfolio([line({ id: "VN1", country: "VN", cnCode: "73181595" }), line({ id: "XK1", country: "XK", cnCode: "73181595" })], { year: 2026 });
    // VN: 2.750 × 1.10 = 3.025; 100 t → 302.5. Other countries: 4.801 × 1.10 = 5.2811 → 5.281; 100 t → 528.1.
    expect(p.shipments[0]).toMatchObject({ defaultValue: "2.750", defaultMarkedUp: "3.025", embeddedT: "302.500", defaultSource: "IR (EU) 2026/1740 Annex I, Viet Nam, CN 7318 15" });
    expect(p.shipments[1]).toMatchObject({ defaultValue: "4.801", defaultMarkedUp: "5.281", embeddedT: "528.100" });
    expect(p.shipments[1].defaultSource).toContain("Other Countries and Territories");
    expect(portfolioSchemaErrors(p)).toEqual([]);
  });

  it("the caller's values still win: the line's defaultValue, then defaults (even a shorter prefix than the annex's)", () => {
    const viaMap = buildPortfolio([line({ country: "VN", cnCode: "73181595" })], { year: 2026, defaults: { "VN:73": "3.000" } });
    expect(viaMap.shipments[0]).toMatchObject({ defaultValue: "3.000", defaultMarkedUp: "3.300", defaultSource: "caller (defaults)" });
    const tw = buildPortfolio([line({})], { year: 2026, defaults: { "TW:7318": "2.000" } });
    expect(tw.shipments[0]).toMatchObject({ defaultValue: "2.000", defaultSource: "caller (defaults)" });
    const own = buildPortfolio([line({ defaultValue: "1.500" })], { year: 2026, defaults: { "TW:7318": "2.000" } });
    expect(own.shipments[0]).toMatchObject({ defaultValue: "1.500", defaultSource: "caller (shipment defaultValue)" });
  });

  it("no value: the error names the line and the annex's reason", () => {
    expect(() => buildPortfolio([line({ country: "VN" })], { year: 2026 })).toThrow(/shipment L1: no default value known for CN 7318 from VN: CN 7318 covers lines with different default values/);
    expect(() => buildPortfolio([line({ cnCode: "8471" })], { year: 2026 })).toThrow(/not a good it lists\); pass it/);
  });

  it("the REST API (/v1/portfolio) and the CLI (carbonlei portfolio) plan a Vietnamese line from the built-in table", async () => {
    const reader = { latestBlock: async () => ({ number: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }), client: { getChainId: async () => 31337 }, registry: "0x0" } as never;
    const server = createApiServer({ reader, log: () => {}, hmacKey: "k".repeat(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const vb = await post("/v1/verify-batch", { shipments: [{ proof: null, id: "VN-1", quantityTonnes: "60", cnCode: "7318 15 95", country: "VN", importDate: "2026-10-10" }] });
      const results = await vb.json();
      const res = await post("/v1/portfolio", { results, year: 2026 });
      const s = await res.json();
      expect(res.status).toBe(200);
      // 60 × 3.025 = 181.5 tCO2e.
      expect(s.shipments[0]).toMatchObject({ defaultValue: "2.750", defaultMarkedUp: "3.025", embeddedT: "181.500", defaultSource: "IR (EU) 2026/1740 Annex I, Viet Nam, CN 7318 15" });

      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}results.json`, JSON.stringify(results));
      const out = JSON.parse((await run(process.execPath, [cli, "portfolio", `${dir}results.json`, "--year", "2026", "--json"])).stdout);
      expect(out.shipments[0]).toMatchObject({ defaultValue: "2.750", embeddedT: "181.500" });
    } finally {
      server.close();
    }
  }, 30_000);
});
