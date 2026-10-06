// Importer for the Commission's CBAM Communication Template (sdk/template.ts).
// Expected values for the official "Steel 3 Screws and nuts" example are copied by hand from the
// Commission's file (opened in a spreadsheet), not computed by the importer.
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkNormalForms, METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import { decodeDisclosure } from "../disclosure.ts";
import { issueCredential } from "../issue.ts";
import {
  draftCredentialFields,
  NOT_IN_TEMPLATE,
  parseTemplate,
  roundDecimal,
  TemplateError,
  toUtcDate,
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
  share?: number;
  cn?: string;
}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
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
    ...(v211
      ? { P25: "Electricity EF (tCO2/MWh)", Q25: "The main reducing agent of the precursor, if known", R25: "Steel mill identification number" }
      : { P25: "The main reducing agent of the precursor, if known", Q25: "Steel mill identification number" }),
  }))
    f(ref, label);
  if (opts.name !== null) f("G12", opts.name ?? "Synthetic Plant");
  else f("G12", undefined);
  f("G16", "TW");
  f("G17", "tw khh");
  f("G20", new Date(Date.UTC(2026, 0, 1)));
  f("G21", 46387); // Excel serial for 2026-12-31
  f(v211 ? "AI15" : "AH15", 1000);
  f("D26", "Cold heading");
  f("F26", opts.cn ?? "73181569");
  f("H26", "Bolt M8");
  f("I26", opts.seeDirect === undefined ? 1.234565 : opts.seeDirect);
  f("J26", 0.5);
  f("K26", 1.734565);
  f("L26", "tCO2e/t");
  f("M26", opts.share ?? 0);
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
});
