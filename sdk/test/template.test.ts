// Importer for the Commission's CBAM Communication Template (sdk/template.ts).
// Expected values for the official "Steel 3 Screws and nuts" example are copied by hand from the
// Commission's file (opened in a spreadsheet), not computed by the importer.
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { deflateSync, unzipSync, zipSync } from "fflate";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkNormalForms, METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import { decodeDisclosure } from "../disclosure.ts";
import { issueCredential } from "../issue.ts";
import {
  draftCredentialFields,
  extractTemplateParts,
  listZipEntries,
  NOT_IN_TEMPLATE,
  parseTemplate,
  roundDecimal,
  TemplateError,
  toUtcDate,
  ZIP_LIMITS,
  type ParsedTemplate,
} from "../template.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/cbam-template/${name}`, import.meta.url)));
const SCREWS = "CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx";
const BLANK_V211 = "CBAM_Communication_template_for_installations_en_20241213.xlsx";

let screws: Promise<ParsedTemplate> | undefined;
const parsedScrews = () => (screws ??= parseTemplate(fixture(SCREWS)));

/** A small workbook with the template's sheet names and the cells the importer reads. */
async function synthetic(opts: {
  version: string;
  layout?: "2.1" | "2.1.1";
  name?: string | null;
  seeDirect?: number | null;
  share?: number | null;
  cn?: string;
  country?: string;
  unLocode?: string;
  seeIndirect?: number;
  seeTotal?: number;
  totals?: [number, number, number];
  periodEnd?: unknown;
  date1904?: boolean;
}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  if (opts.date1904) wb.properties.date1904 = true;
  const v = wb.addWorksheet("0_Versions");
  v.getCell("E9").value = "0.1";
  v.getCell("F9").value = new Date(Date.UTC(2023, 7, 21));
  v.getCell("E10").value = opts.version;
  v.getCell("F10").value = new Date(Date.UTC(2024, 11, 13));
  const sc = wb.addWorksheet("Summary_Communication");
  const f = (ref: string, result: unknown) => {
    sc.getCell(ref).value = { formula: "X", result } as ExcelJS.CellFormulaValue;
  };
  const v211 = (opts.layout ?? "2.1.1") === "2.1.1";
  f("D12", "Name of the installation (English name):");
  for (const [ref, label] of Object.entries({
    F25: "CN Codes",
    H25: "Product name (used for communication with reporting declarant, e.g. on invoices)",
    I25: "SEE (direct)",
    J25: "SEE (indirect)",
    K25: "SEE (total)",
    M25: "Share of emissions by default value",
    N25: "Source for electricity EF",
    O25: "Embedded electricity (MWh/t)",
    ...(v211 ? { AA15: "Total direct emissions during reporting period:" } : { Z15: "Total direct emissions during reporting period:" }),
    ...(v211
      ? { P25: "Electricity EF (tCO2/MWh)", Q25: "The main reducing agent of the precursor, if known", R25: "Steel mill identification number" }
      : { P25: "The main reducing agent of the precursor, if known", Q25: "Steel mill identification number" }),
  }))
    f(ref, label);
  if (opts.name !== null) f("G12", opts.name ?? "Synthetic Plant");
  else f("G12", undefined);
  f("G16", opts.country ?? "TW");
  f("G17", opts.unLocode ?? "tw khh");
  f("G20", new Date(Date.UTC(2026, 0, 1)));
  f("G21", opts.periodEnd ?? 46387); // Excel serial for 2026-12-31
  const [td, ti, tt] = opts.totals ?? [1000, 400, 1400];
  f(v211 ? "AI15" : "AH15", td);
  f(v211 ? "AI16" : "AH16", ti);
  f(v211 ? "AI17" : "AH17", tt);
  f("D26", "Cold heading");
  f("F26", opts.cn ?? "73181569");
  f("H26", "Bolt M8");
  f("I26", opts.seeDirect === undefined ? 1.234565 : opts.seeDirect);
  f("J26", opts.seeIndirect ?? 0.5);
  f("K26", opts.seeTotal ?? 1.734565);
  f("L26", "tCO2e/t");
  f("M26", opts.share === null ? undefined : (opts.share ?? 0));
  f("O26", 0.75);
  if (v211) {
    f("P26", 0.6666666666666666);
    f("Q26", "Natural gas");
    f("R26", 1234);
  } else f("P26", "Natural gas");
  const inst = wb.addWorksheet("A_InstData");
  inst.getCell("I37").value = "Synthetic Verifier GmbH";
  inst.getCell("I52").value = "Synthetic Accreditation Body";
  inst.getCell("I53").value = "D-VS-00000-01";
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("Communication Template: the Commission's screws and nuts example (V2.1)", () => {
  it("detects the template version from 0_Versions and pins the file hash", async () => {
    const t = await parsedScrews();
    expect(t.templateVersion).toBe("2.1");
    expect(t.templateVersionDate).toBe("2024-06-05");
    expect(t.sha256).toBe("47512690d157640ba3828e65fab20f34725dc8aef72406073ca31d5bcbb6fd93");
  });

  it("reads installation and reporting period (dates in UTC)", async () => {
    const t = await parsedScrews();
    expect(t.installation.name).toBe("Example Screw Production Plant");
    expect(t.installation.city).toBe("Example City");
    expect(t.installation.country).toBe("US");
    expect(t.installation.unLocode).toBe("US ABC");
    expect(t.reportingPeriod).toEqual({ start: "2023-01-01", end: "2023-12-31" });
    expect(t.installationTotals_tCO2e).toEqual({ direct: "4948.02000", indirect: "4198.32000", total: "9146.34000" });
    expect(t.verifier.name).toBeNull();
    expect(t.verifier.nabName).toBeNull();
  });

  it("reads both product rows with the hand-copied values", async () => {
    const t = await parsedScrews();
    expect(t.products).toHaveLength(2);
    const [p1, p2] = t.products;
    expect([p1.cnCode, p1.seeDirect, p1.seeIndirect, p1.seeTotal]).toEqual(["73181542", "2.00694", "0.40660", "2.41354"]);
    expect([p2.cnCode, p2.seeDirect, p2.seeIndirect, p2.seeTotal]).toEqual(["73181535", "1.95245", "2.27880", "4.23124"]);
    expect(p1.productName).toBe("Screws and Nuts Art. C1");
    expect(p1.row).toBe(26);
    expect(p1.sources.seeDirect).toBe("Summary_Communication!I26");
    expect(p1.defaultValueShare).toBe("0.00000"); // cached 0, not blank
    expect(p1.mainReducingAgent).toBe("Coal or coke");
    expect(p1.electricityEf_tCO2_per_MWh).toBeNull(); // V2.1 has no such column
  });

  it("drafts only the credential fields the template can fill, SEE (direct) for CN 7318", async () => {
    const t = await parsedScrews();
    const d = draftCredentialFields(t, 0);
    expect(d.fields).toEqual({
      installationName: "Example Screw Production Plant",
      unLocode: "USABC",
      cnCode: "73181542",
      reportingPeriod: "2023-01-01/2023-12-31",
      specificEmbeddedEmissions_tCO2e_per_t: "2.00694",
      valueType: "actual",
      productionRoute: "Carbon steel screws and nuts; main reducing agent of the precursor: Coal or coke",
    });
    expect(d.rows.find((r) => r.field === "specificEmbeddedEmissions_tCO2e_per_t")?.source).toBe("Summary_Communication!I26");
    const missing = d.toBeSupplied.map((s) => s.field);
    expect(missing).toEqual([...NOT_IN_TEMPLATE, "nabName", "accreditationNumber"]);
    expect(t.unmapped).toEqual(missing);
    const by = (who: string) => d.toBeSupplied.filter((s) => s.by === who).map((s) => s.field);
    expect(by("supplier")).toEqual(["supplierLEI", "operatorId", "installationId", "cbamRoute", "energyMix", "supplierCost"]);
    expect(by("verification body")).toEqual([
      "verifiedTonnes",
      "verificationReportId",
      "verifierLEI",
      "siteVisit",
      "assuranceLevel",
      "materialityThreshold",
      "validUntil",
      "nabName",
      "accreditationNumber",
    ]);
    for (const f of ["verifiedTonnes", "energyMix"]) {
      expect(d.toBeSupplied.find((s) => s.field === f)?.reason).toBe("not mapped: the template's activity data has a different meaning");
    }
    expect(d.rows.find((r) => r.field === "specificEmbeddedEmissions_tCO2e_per_t")?.rule).toMatch(
      /CN 7318 counts direct emissions only for CBAM certificates in the definitive period \(transitional reports also listed indirect emissions\)/,
    );
    expect(t.warnings).toEqual([]);
    expect(draftCredentialFields(t, 1).fields.specificEmbeddedEmissions_tCO2e_per_t).toBe("1.95245");
    expect(() => draftCredentialFields(t, 2)).toThrow(/product 3 not found/);
  });

  it("round trip: draft + values the verification body supplies → signed credential carrying the template values", async () => {
    const t = await parsedScrews();
    const d = draftCredentialFields(t, 0);
    const supplied: Omit<CredentialClaims, keyof typeof d.fields> = {
      supplierLEI: "ZZZZ00TWSCREWDEMO185",
      operatorId: "USZZZZ00TWSCREWDEMO185",
      installationId: "US-ZZZZ00TWSCREWDEMO185-0001",
      cbamRoute: "C",
      verifiedTonnes: "500",
      methodologyNote: METHODOLOGY_NOTE,
      verificationReportId: "VR-DEMO-0001",
      verifierLEI: "ZZZZ00EUVERIFDEMO152",
      accreditationNumber: "DEMO-ACC-CBAM-0001",
      nabName: "Demo Accreditation Body",
      siteVisit: "physical",
      assuranceLevel: "reasonable",
      materialityThreshold: "5%",
      energyMix: "withheld",
      supplierCost: "withheld",
      idSalt: `0x${"11".repeat(32)}`,
      batchSalt: `0x${"22".repeat(32)}`,
      issuedAt: "2026-10-01T00:00:00Z",
      validUntil: "2027-12-31T00:00:00Z",
    };
    const claims = { ...supplied, ...d.fields } as CredentialClaims;
    expect(checkNormalForms(claims)).toEqual([]);
    const cred = await issueCredential({
      claims,
      auditorAID: "EDemoAuditorAidForTemplateTests0000000000000",
      signer: privateKeyToAccount(`0x${"42".repeat(32)}` as Hex),
      registry: `0x${"00".repeat(19)}01`,
      chainId: 31337,
    });
    for (const [k, v] of Object.entries(d.fields)) expect(decodeDisclosure(cred.disclosures[k]).value).toBe(v);
  });
});

describe("Communication Template: versions and refusals", () => {
  it("V2.1.1 cell map: columns from P move right by one, totals in AI", async () => {
    const t = await parseTemplate(await synthetic({ version: "2.1.1" }));
    expect(t.templateVersion).toBe("2.1.1");
    const p = t.products[0];
    expect(p.electricityEf_tCO2_per_MWh).toBe("0.66667");
    expect(p.mainReducingAgent).toBe("Natural gas");
    expect(p.steelMillId).toBe("1234");
    expect(p.sources.steelMillId).toBe("Summary_Communication!R26");
    expect(t.installationTotals_tCO2e.direct).toBe("1000.00000");
    expect(t.reportingPeriod).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    const d = draftCredentialFields(t);
    expect(d.fields.unLocode).toBe("TWKHH");
    expect(d.fields.specificEmbeddedEmissions_tCO2e_per_t).toBe("1.23457"); // 1.234565 rounds half away from zero
    expect(d.fields.nabName).toBe("Synthetic Accreditation Body");
    expect(d.fields.accreditationNumber).toBe("D-VS-00000-01");
    expect(t.unmapped).toEqual([...NOT_IN_TEMPLATE]);
  });

  it("refuses an unknown template version", async () => {
    for (const version of ["1.1", "2.0", "2.0.1", "3.0"]) {
      await expect(parseTemplate(await synthetic({ version }))).rejects.toThrow(`unsupported template version ${version}`);
    }
  });

  it("refuses a V2.1.1 file whose header row does not match the V2.1.1 layout", async () => {
    await expect(parseTemplate(await synthetic({ version: "2.1.1", layout: "2.1" }))).rejects.toThrow(/expected header "Electricity EF…"/);
  });

  it("refuses the blank official V2.1.1 template: no cached values", async () => {
    const err = await parseTemplate(fixture(BLANK_V211)).catch((e) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.message).toMatch(/Summary_Communication!G12 \(installation name\) is empty or has no cached value/);
    expect(err.message).toMatch(/does not evaluate formulas/);
  });

  it("refuses a product row whose SEE (direct) has no cached value instead of guessing", async () => {
    await expect(parseTemplate(await synthetic({ version: "2.1", layout: "2.1", seeDirect: null }))).rejects.toThrow(
      /Summary_Communication!I26 \(SEE \(direct\) of CN 73181569\) is empty or has no cached value/,
    );
  });

  it("refuses files that are not a Communication Template", async () => {
    await expect(parseTemplate(new TextEncoder().encode("not a zip"))).rejects.toThrow(/not a readable xlsx file/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1");
    await expect(parseTemplate(new Uint8Array(await wb.xlsx.writeBuffer()))).rejects.toThrow(/sheet "0_Versions" not found/);
  });

  it("valueType: share 1 → default, a mix is left to the verification body, other CN chapters are not mapped", async () => {
    const def = draftCredentialFields(await parseTemplate(await synthetic({ version: "2.1.1", share: 1 })));
    expect(def.fields.valueType).toBe("default");
    const mix = draftCredentialFields(await parseTemplate(await synthetic({ version: "2.1.1", share: 0.25 })));
    expect(mix.fields.valueType).toBeUndefined();
    expect(mix.toBeSupplied.find((s) => s.field === "valueType")?.reason).toMatch(/0\.25000/);
    const cement = draftCredentialFields(await parseTemplate(await synthetic({ version: "2.1.1", cn: "25232900" })));
    expect(cement.fields.specificEmbeddedEmissions_tCO2e_per_t).toBeUndefined();
    expect(cement.toBeSupplied.map((s) => s.field)).toContain("specificEmbeddedEmissions_tCO2e_per_t");
  });
});

describe("Communication Template: normalisation rules", () => {
  it("rounds to 5 decimals, half away from zero, on the shortest decimal form", () => {
    expect(roundDecimal(2.0069382352941174)).toBe("2.00694");
    expect(roundDecimal(0.4066)).toBe("0.40660");
    expect(roundDecimal(4.23124268292683)).toBe("4.23124");
    expect(roundDecimal(1.000005)).toBe("1.00001"); // float toFixed(5) gives "1.00000"
    expect(roundDecimal(-1.000005)).toBe("-1.00001");
    expect(roundDecimal(0)).toBe("0.00000");
    expect(roundDecimal(-0.000001)).toBe("0.00000");
    expect(roundDecimal(1e-7)).toBe("0.00000");
    expect(roundDecimal(6e-6)).toBe("0.00001");
    expect(roundDecimal(9146.34)).toBe("9146.34000");
    expect(roundDecimal(1.5e21)).toBe("1500000000000000000000.00000");
    expect(() => roundDecimal(Number.NaN)).toThrow();
  });

  it("dates are taken in UTC from Date values, Excel serial numbers and ISO strings", () => {
    expect(toUtcDate(new Date(Date.UTC(2023, 11, 31)), "x")).toBe("2023-12-31");
    expect(toUtcDate(new Date("2023-12-31T23:30:00-05:00"), "x")).toBe("2024-01-01"); // UTC, not local time
    expect(toUtcDate(45291, "x")).toBe("2023-12-31");
    expect(toUtcDate("2023-01-01", "x")).toBe("2023-01-01");
    expect(() => toUtcDate("31/12/2023", "G21")).toThrow(/G21: not a date/);
    expect(() => toUtcDate(45291.5, "x")).toThrow();
  });

  it("refuses ISO date strings that are not calendar days instead of rolling them over", () => {
    expect(() => toUtcDate("2023-02-30", "G21")).toThrow(/G21: not a date: "2023-02-30"/);
    expect(() => toUtcDate("2023-13-01", "G21")).toThrow(/not a date/);
    expect(() => toUtcDate("2023-04-31T00:00:00Z", "G21")).toThrow(/not a date/);
    expect(toUtcDate("2024-02-29", "x")).toBe("2024-02-29");
  });

  it("reads Excel serial numbers in the 1904 date system when the workbook uses it", async () => {
    expect(toUtcDate(45291, "x", true)).toBe("2028-01-01"); // 1462 days after 2023-12-31, its date in the 1900 system
    expect(toUtcDate(44925, "x", true)).toBe("2026-12-31");
    const t = await parseTemplate(await synthetic({ version: "2.1.1", date1904: true, periodEnd: 44925 }));
    expect(t.reportingPeriod).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });
});

describe("Communication Template: plausibility checks", () => {
  it("refuses a negative SEE", async () => {
    await expect(parseTemplate(await synthetic({ version: "2.1.1", seeIndirect: -0.5, seeTotal: 0.734565 }))).rejects.toThrow(
      /Summary_Communication!J26 \(SEE \(indirect\) of CN 73181569\) is negative/,
    );
  });

  it("refuses SEE (total) that is not SEE (direct) + SEE (indirect) within 1e-4", async () => {
    await expect(parseTemplate(await synthetic({ version: "2.1.1", seeTotal: 1.7347 }))).rejects.toThrow(
      /Summary_Communication!I26:K26 \(SEE of CN 73181569\): total 1\.7347 is not direct 1\.234565 \+ indirect 0\.5/,
    );
    // within the tolerance: accepted
    const t = await parseTemplate(await synthetic({ version: "2.1.1", seeTotal: 1.73465 }));
    expect(t.products[0].seeTotal).toBe("1.73465");
    await expect(parseTemplate(await synthetic({ version: "2.1.1", totals: [1000, 400, 1500] }))).rejects.toThrow(
      /installation totals Summary_Communication!AI15:AI17: total 1500 is not direct 1000 \+ indirect 400/,
    );
  });

  it("warns when the UN/LOCODE does not start with the installation's country code", async () => {
    const ok = await parseTemplate(await synthetic({ version: "2.1.1" }));
    expect(ok.warnings).toEqual([]);
    const t = await parseTemplate(await synthetic({ version: "2.1.1", country: "VN", unLocode: "TW KHH" }));
    expect(t.warnings).toEqual([
      'UN/LOCODE "TW KHH" (Summary_Communication!G17) does not start with the country code "VN" (Summary_Communication!G16)',
    ]);
    expect(draftCredentialFields(t).fields.unLocode).toBe("TWKHH"); // a warning, not a refusal
  });

  it("a blank share of emissions by default values leaves the value type to be supplied, not actual", async () => {
    const d = draftCredentialFields(await parseTemplate(await synthetic({ version: "2.1.1", share: null })));
    expect(d.fields.valueType).toBeUndefined();
    expect(d.toBeSupplied.find((s) => s.field === "valueType")).toEqual({
      field: "valueType",
      by: "supplier",
      reason: "share of emissions by default values (Summary_Communication!M26) is blank",
    });
  });

  it("layout guard: the totals label must be in Z15 (V2.1) or AA15 (V2.1.1)", async () => {
    // A V2.1 layout carries the label in Z15, so read as V2.1.1 the header P25 fails first; check the label alone:
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await synthetic({ version: "2.1.1" })).buffer as ArrayBuffer);
    const sc = wb.getWorksheet("Summary_Communication")!;
    sc.getCell("AA15").value = { formula: "X", result: "Total emissions during reporting period:" } as ExcelJS.CellFormulaValue;
    await expect(parseTemplate(new Uint8Array(await wb.xlsx.writeBuffer()))).rejects.toThrow(
      /Summary_Communication!AA15: expected header "Total direct emissions…"/,
    );
  });
});

/** Writes a zip from entries whose data is already compressed, with the sizes given (they may lie). CRCs are left 0. */
function rawZip(entries: { name: string; data: Uint8Array; method: 0 | 8; size: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const h = new Uint8Array(30 + name.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, e.method, true);
    dv.setUint32(18, e.data.length, true);
    dv.setUint32(22, e.size, true);
    dv.setUint16(26, name.length, true);
    h.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    local.push(h, e.data);
    central.push(c);
    offset += h.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

describe("Communication Template: untrusted zip containers", () => {
  const MB = 1024 * 1024;
  // Re-zipping the 1.3 MB example workbook and generating the 60 MB bomb take a few seconds under V8 coverage
  // (`npm run test:coverage`), more than vitest's 5 s default on a loaded machine. The parse itself
  // is still held to 2 s below.
  const ZIP_TEST_TIMEOUT = 30_000;
  // A real minimal template, re-zipped with every part deflated; the bomb replaces or joins its parts.
  const baseParts = async () => {
    const parts = unzipSync(await synthetic({ version: "2.1.1" }));
    return Object.entries(parts).map(([name, raw]) => ({ name, data: deflateSync(raw), method: 8 as const, size: raw.length }));
  };
  // 60 MB of "<" characters deflates to about 60 kB (ratio about 1000:1); generated here, never committed.
  let bomb: Uint8Array | undefined;
  const bombData = () => (bomb ??= deflateSync(new Uint8Array(60 * MB).fill(0x3c), { level: 1 }));

  it("parses the template re-zipped by another writer (stored entries) and keeps only the parts it reads", async () => {
    const stored = zipSync(unzipSync(fixture(SCREWS)), { level: 0 });
    const t = await parseTemplate(stored);
    expect(t.products.map((p) => p.seeDirect)).toEqual(["2.00694", "1.95245"]);
    const names = listZipEntries(extractTemplateParts(fixture(SCREWS))).map((e) => e.name).sort();
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml", // 0_Versions
      "xl/worksheets/sheet14.xml", // Summary_Communication
      "xl/worksheets/sheet5.xml", // A_InstData
    ]);
  }, ZIP_TEST_TIMEOUT);

  it("refuses a high-ratio zip bomb (honest sizes) within 2 seconds, before inflating it", async () => {
    const data = bombData();
    expect(data.length).toBeLessThan(MB);
    const parts = await baseParts();
    const file = rawZip([...parts.filter((p) => !p.name.endsWith("sheet2.xml")), { name: "xl/worksheets/sheet2.xml", data, method: 8, size: 60 * MB }]);
    const t0 = performance.now();
    await expect(parseTemplate(file)).rejects.toThrow(/zip entry "xl\/worksheets\/sheet2.xml" declares 62914560 bytes uncompressed \(limit 52428800 per entry\)/);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, ZIP_TEST_TIMEOUT);

  it("refuses a zip bomb that understates its size, counting the bytes actually inflated, within 2 seconds", async () => {
    const parts = await baseParts();
    const sheets = parts.filter((p) => p.name.startsWith("xl/worksheets/sheet")).map((p) => p.name);
    const target = sheets[sheets.length - 1]; // one of the sheets the importer reads
    const file = rawZip([...parts.filter((p) => p.name !== target), { name: target, data: bombData(), method: 8, size: 4096 }]);
    const t0 = performance.now();
    await expect(parseTemplate(file)).rejects.toThrow(new RegExp(`zip entry "${target}" inflates to more than the 4096 bytes it declares`));
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("refuses declared sizes above 150 MB in total and more entries than the limit", async () => {
    const parts = await baseParts();
    const filler = (i: number) => ({ name: `xl/media/fill${i}.bin`, data: new Uint8Array(0), method: 8 as const, size: 40 * MB });
    await expect(parseTemplate(rawZip([...parts, ...[0, 1, 2, 3].map(filler)]))).rejects.toThrow(
      /zip entries declare more than 157286400 bytes uncompressed in total/,
    );
    const many = Array.from({ length: ZIP_LIMITS.maxEntries }, (_, i) => ({ name: `x/${i}`, data: new Uint8Array(0), method: 0 as const, size: 0 }));
    await expect(parseTemplate(rawZip([...parts, ...many]))).rejects.toThrow(/zip has \d+ entries \(limit 1000\)/);
  });
});
