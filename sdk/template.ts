// Importer for the European Commission's CBAM Communication Template for installations (xlsx).
//
// Deterministic: fixed cell maps per template version, fixed normalisation rules, no inference.
// It reads the values Excel cached when the file was saved; it does not evaluate formulas.
// A missing cached value in a required cell is an error, never a guess.
//
// Supported versions (read from the `0_Versions` sheet): 2.1 (2024-06-05) and 2.1.1 (2024-12-13).
// The template is the Commission's transitional-period template (Implementing Regulation (EU) 2023/1773).
// Values imported from it are a draft for the verification body; they are not verified data.
//
// Works in Node and in the browser: exceljs is loaded on first use (in the browser, through a loader the page passes).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Workbook, Worksheet } from "exceljs";
import { isCnCode, isReportingPeriod, type ClaimName } from "./credential.ts";

export const SUPPORTED_TEMPLATE_VERSIONS = ["2.1", "2.1.1"] as const;
export type TemplateVersion = (typeof SUPPORTED_TEMPLATE_VERSIONS)[number];

/** Decimal places kept for emission intensities and other numbers (round half away from zero). */
export const DECIMALS = 5;
/** Files above this size are refused before parsing. */
export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;

const SC = "Summary_Communication";
const INST = "A_InstData";
const FIRST_PRODUCT_ROW = 26;
const LAST_PRODUCT_ROW = 125; // the template has 100 product rows

/** Columns of the product table on Summary_Communication (header row 25, data from row 26). */
interface ProductColumns {
  productionProcess: string;
  aggregatedGoodsCategory: string;
  cnCode: string;
  cnName: string;
  productName: string;
  seeDirect: string;
  seeIndirect: string;
  seeTotal: string;
  unit: string;
  defaultValueShare: string;
  electricityEfSource: string;
  embeddedElectricity: string;
  electricityEf: string | null;
  mainReducingAgent: string;
  steelMillId: string;
}

interface CellMap {
  installation: Record<keyof InstallationDetails, string>;
  periodStart: string;
  periodEnd: string;
  totals: { direct: string; indirect: string; total: string };
  products: ProductColumns;
  /** Header cells checked before any value is read: cell → expected start of the cached label. */
  headers: Record<string, string>;
}

const INSTALLATION_CELLS: Record<keyof InstallationDetails, string> = {
  name: "G12",
  street: "G13",
  economicActivity: "G14",
  city: "G15", // labelled "Country:" in the template; the formula reads the city (A_InstData!I25)
  country: "G16",
  unLocode: "G17",
  latitude: "G18",
  longitude: "G19",
};

const V2_1_PRODUCTS: ProductColumns = {
  productionProcess: "D",
  aggregatedGoodsCategory: "E",
  cnCode: "F",
  cnName: "G",
  productName: "H",
  seeDirect: "I",
  seeIndirect: "J",
  seeTotal: "K",
  unit: "L",
  defaultValueShare: "M",
  electricityEfSource: "N",
  embeddedElectricity: "O",
  electricityEf: null,
  mainReducingAgent: "P",
  steelMillId: "Q",
};

const COMMON_HEADERS: Record<string, string> = {
  D12: "Name of the installation",
  F25: "CN Codes",
  H25: "Product name",
  I25: "SEE (direct)",
  J25: "SEE (indirect)",
  K25: "SEE (total)",
  M25: "Share of emissions by default value",
  N25: "Source for electricity EF",
  O25: "Embedded electricity",
};

export const CELL_MAPS: Record<TemplateVersion, CellMap> = {
  "2.1": {
    installation: INSTALLATION_CELLS,
    periodStart: "G20",
    periodEnd: "G21",
    totals: { direct: "AH15", indirect: "AH16", total: "AH17" },
    products: V2_1_PRODUCTS,
    headers: { ...COMMON_HEADERS, P25: "The main reducing agent", Q25: "Steel mill identification number" },
  },
  "2.1.1": {
    installation: INSTALLATION_CELLS,
    periodStart: "G20",
    periodEnd: "G21",
    totals: { direct: "AI15", indirect: "AI16", total: "AI17" },
    // V2.1.1 inserts "Electricity EF (tCO2/MWh)" in column P; the columns after it move right by one.
    products: { ...V2_1_PRODUCTS, electricityEf: "P", mainReducingAgent: "Q", steelMillId: "R" },
    headers: {
      ...COMMON_HEADERS,
      P25: "Electricity EF",
      Q25: "The main reducing agent",
      R25: "Steel mill identification number",
    },
  },
};

/** Verifier block on A_InstData (plain input cells, the same in V2.1 and V2.1.1). Optional in the transitional period. */
const VERIFIER_CELLS: Record<keyof VerifierDetails, string> = {
  name: "I37",
  street: "I38",
  city: "I39",
  postCode: "I40",
  country: "I41",
  accreditationMemberState: "I51",
  nabName: "I52",
  accreditationNumber: "I53",
};

export interface InstallationDetails {
  name: string;
  street: string | null;
  economicActivity: string | null;
  city: string | null;
  country: string | null;
  unLocode: string | null;
  latitude: string | null;
  longitude: string | null;
}

export interface VerifierDetails {
  name: string | null;
  street: string | null;
  city: string | null;
  postCode: string | null;
  country: string | null;
  accreditationMemberState: string | null;
  nabName: string | null;
  accreditationNumber: string | null;
}

export interface TemplateProduct {
  /** Row on Summary_Communication. */
  row: number;
  productionProcess: string | null;
  aggregatedGoodsCategory: string | null;
  cnCode: string;
  cnName: string | null;
  productName: string | null;
  /** tCO2e per tonne, decimal string with DECIMALS places. */
  seeDirect: string;
  seeIndirect: string;
  seeTotal: string;
  unit: string | null;
  /** Share of emissions from default values, as a fraction 0–1 (decimal string), or null if blank. */
  defaultValueShare: string | null;
  electricityEfSource: string | null;
  embeddedElectricity_MWh_per_t: string | null;
  /** V2.1.1 only (computed by the template as SEE indirect / embedded electricity). */
  electricityEf_tCO2_per_MWh: string | null;
  mainReducingAgent: string | null;
  steelMillId: string | null;
  /** Field name → source cell, for example "seeDirect" → "Summary_Communication!I26". */
  sources: Record<string, string>;
}

export interface ParsedTemplate {
  templateVersion: TemplateVersion;
  /** Date of the last entry in 0_Versions, YYYY-MM-DD (UTC). */
  templateVersionDate: string | null;
  /** sha256 of the file bytes, lower-case hex. */
  sha256: string;
  installation: InstallationDetails;
  reportingPeriod: { start: string; end: string };
  installationTotals_tCO2e: { direct: string | null; indirect: string | null; total: string | null };
  products: TemplateProduct[];
  verifier: VerifierDetails;
  /** CarbonLEI credential fields this template has no cell for (plus verifier fields left blank in this file). */
  unmapped: ClaimName[];
  /** Field name → source cell for installation, period, totals and verifier values. */
  sources: Record<string, string>;
  /** Number of non-empty values read from the file (installation, period, totals, verifier, product cells). */
  extractedValues: number;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

// --------------------------------------------------------------- normalisation

/**
 * Number → decimal string with exactly `dp` places, rounded half away from zero.
 * Rounding is done on the shortest decimal representation of the double (Number.prototype.toString),
 * in integer arithmetic, so 2.0069382352941174 → "2.00694" and 0.4066 → "0.40660".
 */
export function roundDecimal(n: number, dp = DECIMALS): string {
  if (!Number.isFinite(n)) throw new TemplateError(`not a finite number: ${n}`);
  const neg = n < 0;
  const [mant, expPart] = Math.abs(n).toString().split("e");
  const [intPart, frac = ""] = mant.split(".");
  let digits = intPart + frac;
  let point = intPart.length + Number(expPart ?? 0);
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  const keep = point + dp;
  digits = digits.padEnd(keep + 1, "0");
  let kept = BigInt(digits.slice(0, keep) || "0");
  if (Number(digits[keep]) >= 5) kept += 1n;
  const s = kept.toString().padStart(dp + 1, "0");
  const out = dp > 0 ? `${s.slice(0, s.length - dp)}.${s.slice(s.length - dp)}` : s;
  return neg && kept !== 0n ? `-${out}` : out;
}

/** Date cell → YYYY-MM-DD taken in UTC. Accepts a Date, an Excel serial day number (1900 system) or an ISO date string. */
export function toUtcDate(v: unknown, where: string): string {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "number" && Number.isInteger(v) && v > 0) d = new Date((v - 25569) * 86_400_000);
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(v.trim())) d = new Date(v.trim().slice(0, 10) + "T00:00:00Z");
  if (!d || Number.isNaN(d.getTime())) throw new TemplateError(`${where}: not a date: ${JSON.stringify(v)}`);
  return d.toISOString().slice(0, 10);
}

/** UN/LOCODE as written in the template (may contain a space, e.g. "US ABC") → "USABC". */
export function normaliseUnLocode(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}
const UN_LOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;

// ------------------------------------------------------------------ cell reads

type Prim = string | number | boolean | Date;

/**
 * The cached value of a cell: plain value, or the stored result of a formula. Blank and "" → null.
 * Formula results are read from `cell.result`: exceljs's `cell.value` drops falsy results, so a cached 0 would read as missing.
 * A cached empty string (`<v/>`) and a formula saved without a result both read as null; they cannot be told apart.
 */
function cached(ws: Worksheet, ref: string): Prim | null {
  const cell = ws.getCell(ref);
  const raw = cell.value as unknown;
  const isFormula = !!raw && typeof raw === "object" && ("formula" in raw || "sharedFormula" in raw);
  const v = isFormula ? (cell.result as unknown) : raw;
  const unwrap = (x: unknown): Prim | null => {
    if (x === null || x === undefined) return null;
    if (typeof x === "string") return x.trim() === "" ? null : x;
    if (typeof x === "number" || typeof x === "boolean" || x instanceof Date) return x;
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      if ("error" in o) throw new TemplateError(`${ws.name}!${ref}: cached value is an Excel error (${String(o.error)})`);
      if ("formula" in o || "sharedFormula" in o) return unwrap(o.result);
      if (Array.isArray(o.richText)) return unwrap((o.richText as { text: string }[]).map((t) => t.text).join(""));
      if ("text" in o) return unwrap(o.text);
    }
    return null;
  };
  return unwrap(v);
}

const asText = (v: Prim | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v).trim());

function requireCached(ws: Worksheet, ref: string, what: string): Prim {
  const v = cached(ws, ref);
  if (v === null) {
    throw new TemplateError(
      `${ws.name}!${ref} (${what}) is empty or has no cached value. This importer reads the values Excel stored when the file ` +
        `was saved and does not evaluate formulas; open the filled template in Excel or LibreOffice, recalculate and save it.`,
    );
  }
  return v;
}

function requireNumber(ws: Worksheet, ref: string, what: string): string {
  const v = requireCached(ws, ref, what);
  if (typeof v !== "number") throw new TemplateError(`${ws.name}!${ref} (${what}): not a number: ${JSON.stringify(v)}`);
  return roundDecimal(v);
}

function optionalNumber(ws: Worksheet, ref: string): string | null {
  const v = cached(ws, ref);
  return typeof v === "number" ? roundDecimal(v) : null;
}

function sheet(wb: Workbook, name: string): Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new TemplateError(`sheet "${name}" not found: not a CBAM Communication Template`);
  return ws;
}

/** Template version: the last version number listed in column E of 0_Versions (rows 9–60). */
export function detectVersion(wb: Workbook): { version: string; date: string | null } {
  const ws = wb.getWorksheet("0_Versions");
  if (!ws) throw new TemplateError(`sheet "0_Versions" not found: not a CBAM Communication Template`);
  let found: { version: string; date: string | null } | null = null;
  for (let r = 9; r <= 60; r++) {
    const v = cached(ws, `E${r}`);
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    if (/^\d+(\.\d+)*$/.test(s)) {
      const d = cached(ws, `F${r}`);
      let date: string | null = null;
      try {
        date = d === null ? null : toUtcDate(d, `0_Versions!F${r}`);
      } catch {
        date = null;
      }
      found = { version: s, date };
    }
  }
  if (!found) throw new TemplateError("no version number found in 0_Versions!E9:E60");
  return found;
}

/** CarbonLEI fields the Communication Template has no cell for. */
export const NOT_IN_TEMPLATE: readonly ClaimName[] = [
  "supplierLEI",
  "operatorId",
  "installationId",
  "cbamRoute",
  "verifiedTonnes",
  "verificationReportId",
  "verifierLEI",
  "siteVisit",
  "assuranceLevel",
  "materialityThreshold",
  "validUntil",
  "energyMix",
  "supplierCost",
];

// ---------------------------------------------------------------------- parse

export type ExcelModule = typeof import("exceljs");

/**
 * Default loader: the exceljs package (Node). The specifier is a variable so that bundlers leave it alone;
 * the demo passes its own loader, which adds exceljs's prebuilt browser file only when a file is read.
 */
async function nodeExcel(): Promise<ExcelModule> {
  const spec = "exceljs";
  const mod = (await import(/* @vite-ignore */ spec)) as { default?: ExcelModule } & ExcelModule;
  return mod.default ?? mod;
}

async function loadWorkbook(bytes: Uint8Array, excel: () => Promise<ExcelModule>): Promise<Workbook> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs accepts an ArrayBuffer in both Node and the browser.
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (e) {
    throw new TemplateError(`not a readable xlsx file: ${(e as Error).message}`);
  }
  return wb;
}

/** Parses a filled CBAM Communication Template (V2.1 or V2.1.1). Throws TemplateError on anything it cannot read exactly. */
export async function parseTemplate(
  bytes: Uint8Array,
  opts: { excel?: () => Promise<ExcelModule> } = {},
): Promise<ParsedTemplate> {
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) throw new TemplateError(`file larger than ${MAX_TEMPLATE_BYTES} bytes`);
  const hash = bytesToHex(sha256(bytes));
  const wb = await loadWorkbook(bytes, opts.excel ?? nodeExcel);
  const { version, date } = detectVersion(wb);
  if (!(SUPPORTED_TEMPLATE_VERSIONS as readonly string[]).includes(version)) {
    throw new TemplateError(`unsupported template version ${version} (supported: ${SUPPORTED_TEMPLATE_VERSIONS.join(", ")})`);
  }
  const templateVersion = version as TemplateVersion;
  const map = CELL_MAPS[templateVersion];
  const sc = sheet(wb, SC);
  const inst = sheet(wb, INST);

  // Layout guard: the header labels must be the ones this cell map was written for.
  for (const [ref, label] of Object.entries(map.headers)) {
    const got = asText(cached(sc, ref));
    if (got === null) throw new TemplateError(`${SC}!${ref} (header "${label}") has no cached value; the file was saved without calculated values`);
    if (!got.startsWith(label)) {
      throw new TemplateError(`${SC}!${ref}: expected header "${label}…", found "${got}"; layout does not match template version ${templateVersion}`);
    }
  }

  const sources: Record<string, string> = {};
  let extracted = 0;
  const at = (s: string, ref: string) => `${s}!${ref}`;

  const name = asText(requireCached(sc, map.installation.name, "installation name")) as string;
  const installation = { name } as InstallationDetails;
  for (const [k, ref] of Object.entries(map.installation) as [keyof InstallationDetails, string][]) {
    if (k !== "name") installation[k] = asText(cached(sc, ref));
    sources[`installation.${k}`] = at(SC, ref);
    if (installation[k] !== null) extracted++;
  }

  const start = toUtcDate(requireCached(sc, map.periodStart, "reporting period start"), at(SC, map.periodStart));
  const end = toUtcDate(requireCached(sc, map.periodEnd, "reporting period end"), at(SC, map.periodEnd));
  if (start > end) throw new TemplateError(`reporting period start ${start} is after its end ${end}`);
  sources["reportingPeriod.start"] = at(SC, map.periodStart);
  sources["reportingPeriod.end"] = at(SC, map.periodEnd);
  extracted += 2;

  const installationTotals_tCO2e = {
    direct: optionalNumber(sc, map.totals.direct),
    indirect: optionalNumber(sc, map.totals.indirect),
    total: optionalNumber(sc, map.totals.total),
  };
  for (const k of ["direct", "indirect", "total"] as const) {
    sources[`installationTotals_tCO2e.${k}`] = at(SC, map.totals[k]);
    if (installationTotals_tCO2e[k] !== null) extracted++;
  }

  const verifier = {} as VerifierDetails;
  for (const [k, ref] of Object.entries(VERIFIER_CELLS) as [keyof VerifierDetails, string][]) {
    verifier[k] = asText(cached(inst, ref));
    sources[`verifier.${k}`] = at(INST, ref);
    if (verifier[k] !== null) extracted++;
  }

  const c = map.products;
  const products: TemplateProduct[] = [];
  for (let row = FIRST_PRODUCT_ROW; row <= LAST_PRODUCT_ROW; row++) {
    const cnRaw = cached(sc, `${c.cnCode}${row}`);
    if (cnRaw === null) continue;
    const cnCode = String(cnRaw).replace(/\s+/g, "");
    if (!isCnCode(cnCode)) throw new TemplateError(`${SC}!${c.cnCode}${row}: CN code "${cnRaw}" is not 4, 6 or 8 digits`);
    const text = (col: string | null) => (col ? asText(cached(sc, `${col}${row}`)) : null);
    const num = (col: string | null) => (col ? optionalNumber(sc, `${col}${row}`) : null);
    const p: TemplateProduct = {
      row,
      productionProcess: text(c.productionProcess),
      aggregatedGoodsCategory: text(c.aggregatedGoodsCategory),
      cnCode,
      cnName: text(c.cnName),
      productName: text(c.productName),
      seeDirect: requireNumber(sc, `${c.seeDirect}${row}`, `SEE (direct) of CN ${cnCode}`),
      seeIndirect: requireNumber(sc, `${c.seeIndirect}${row}`, `SEE (indirect) of CN ${cnCode}`),
      seeTotal: requireNumber(sc, `${c.seeTotal}${row}`, `SEE (total) of CN ${cnCode}`),
      unit: text(c.unit),
      defaultValueShare: num(c.defaultValueShare),
      electricityEfSource: text(c.electricityEfSource),
      embeddedElectricity_MWh_per_t: num(c.embeddedElectricity),
      electricityEf_tCO2_per_MWh: num(c.electricityEf),
      mainReducingAgent: text(c.mainReducingAgent),
      steelMillId: text(c.steelMillId),
      sources: {},
    };
    const cols: [keyof TemplateProduct, string | null][] = [
      ["productionProcess", c.productionProcess],
      ["aggregatedGoodsCategory", c.aggregatedGoodsCategory],
      ["cnCode", c.cnCode],
      ["cnName", c.cnName],
      ["productName", c.productName],
      ["seeDirect", c.seeDirect],
      ["seeIndirect", c.seeIndirect],
      ["seeTotal", c.seeTotal],
      ["unit", c.unit],
      ["defaultValueShare", c.defaultValueShare],
      ["electricityEfSource", c.electricityEfSource],
      ["embeddedElectricity_MWh_per_t", c.embeddedElectricity],
      ["electricityEf_tCO2_per_MWh", c.electricityEf],
      ["mainReducingAgent", c.mainReducingAgent],
      ["steelMillId", c.steelMillId],
    ];
    for (const [k, col] of cols) {
      if (!col) continue;
      p.sources[k] = at(SC, `${col}${row}`);
      if (p[k] !== null) extracted++;
    }
    if (p.unit !== null && p.unit !== "tCO2e/t") throw new TemplateError(`${SC}!${c.unit}${row}: unit "${p.unit}", expected "tCO2e/t"`);
    products.push(p);
  }
  if (products.length === 0) {
    throw new TemplateError(`no product rows with a cached CN code in ${SC}!${c.cnCode}${FIRST_PRODUCT_ROW}:${c.cnCode}${LAST_PRODUCT_ROW}`);
  }

  const unmapped: ClaimName[] = [...NOT_IN_TEMPLATE];
  if (verifier.nabName === null) unmapped.push("nabName");
  if (verifier.accreditationNumber === null) unmapped.push("accreditationNumber");

  return {
    templateVersion,
    templateVersionDate: date,
    sha256: hash,
    installation,
    reportingPeriod: { start, end },
    installationTotals_tCO2e,
    products,
    verifier,
    unmapped,
    sources,
    extractedValues: extracted,
  };
}

// ------------------------------------------------------------------ the draft

export const TO_BE_SUPPLIED = "to be supplied by the verification body";
export const SET_AT_ISSUANCE = "set by the SDK at issuance";

export interface DraftRow {
  field: ClaimName;
  value: string;
  /** Source cell(s) in the template. */
  source: string;
  /** The normalisation rule applied. */
  rule: string;
}

export interface CredentialDraft {
  product: { row: number; cnCode: string; productName: string | null };
  /** Draft values for the CarbonLEI fields the template can fill. */
  fields: Partial<Record<ClaimName, string>>;
  rows: DraftRow[];
  /** Fields left for the verification body, with the reason. */
  toBeSupplied: { field: ClaimName; reason: string }[];
  /** Fields the SDK sets when the credential is issued. */
  setAtIssuance: ClaimName[];
}

/**
 * CN codes for which this draft maps SEE (direct) to the credential intensity.
 * CN 7318 is listed in Annex II of Regulation (EU) 2023/956 (goods for which only direct emissions are taken into account).
 * Other CN codes are left to the verification body rather than guessed.
 */
export const DIRECT_ONLY_CN_PREFIXES = ["7318"] as const;

/** Credential field draft for one product row (index into `t.products`). Only fields with a template source are filled. */
export function draftCredentialFields(t: ParsedTemplate, productIndex = 0): CredentialDraft {
  const p = t.products[productIndex];
  if (!p) throw new TemplateError(`product ${productIndex + 1} not found (the file has ${t.products.length})`);
  const rows: DraftRow[] = [];
  const toBeSupplied: { field: ClaimName; reason: string }[] = NOT_IN_TEMPLATE.map((field) => ({
    field,
    reason: "no cell in the Communication Template",
  }));
  const add = (field: ClaimName, value: string, source: string, rule: string) => rows.push({ field, value, source, rule });

  add("installationName", t.installation.name, t.sources["installation.name"], "text, trimmed");
  if (t.installation.unLocode !== null) {
    const u = normaliseUnLocode(t.installation.unLocode);
    if (UN_LOCODE.test(u)) add("unLocode", u, t.sources["installation.unLocode"], "spaces removed, upper case");
    else toBeSupplied.push({ field: "unLocode", reason: `"${t.installation.unLocode}" is not a UN/LOCODE` });
  } else toBeSupplied.push({ field: "unLocode", reason: "blank in the template" });

  add("cnCode", p.cnCode, p.sources.cnCode, "digits only; the 8-digit CN code is kept");
  const period = `${t.reportingPeriod.start}/${t.reportingPeriod.end}`;
  if (!isReportingPeriod(period)) throw new TemplateError(`reporting period ${period} not in normal form`);
  add("reportingPeriod", period, `${t.sources["reportingPeriod.start"]}, ${t.sources["reportingPeriod.end"]}`, "dates read in UTC, start/end");

  if (DIRECT_ONLY_CN_PREFIXES.some((x) => p.cnCode.startsWith(x))) {
    add(
      "specificEmbeddedEmissions_tCO2e_per_t",
      p.seeDirect,
      p.sources.seeDirect,
      `SEE (direct), rounded half away from zero to ${DECIMALS} decimals; CN 7318 counts direct emissions only`,
    );
  } else {
    toBeSupplied.push({
      field: "specificEmbeddedEmissions_tCO2e_per_t",
      reason: `this importer maps SEE (direct) only for CN ${DIRECT_ONLY_CN_PREFIXES.join(", ")}; whether CN ${p.cnCode} counts indirect emissions is left to the verification body`,
    });
  }

  const share = p.defaultValueShare === null ? 0 : Number(p.defaultValueShare);
  const shareSource = p.sources.defaultValueShare;
  if (share === 0) add("valueType", "actual", shareSource, p.defaultValueShare === null ? "share by default values blank → read as 0 → actual" : "share by default values 0 → actual");
  else if (share === 1) add("valueType", "default", shareSource, "share by default values 1 → default");
  else toBeSupplied.push({ field: "valueType", reason: `share by default values is ${p.defaultValueShare}; CarbonLEI has no value type for a mix` });

  if (p.productionProcess !== null) {
    const parts = [p.productionProcess, p.mainReducingAgent ? `main reducing agent of the precursor: ${p.mainReducingAgent}` : null].filter(Boolean);
    add(
      "productionRoute",
      parts.join("; "),
      [p.sources.productionProcess, p.mainReducingAgent ? p.sources.mainReducingAgent : null].filter(Boolean).join(", "),
      "free text joined with \"; \"; never disclosed to importers",
    );
  } else toBeSupplied.push({ field: "productionRoute", reason: "blank in the template" });

  for (const k of ["nabName", "accreditationNumber"] as const) {
    if (t.verifier[k] !== null) add(k, t.verifier[k] as string, t.sources[`verifier.${k}`], "text, trimmed");
    else toBeSupplied.push({ field: k, reason: "blank in the template (optional in the transitional period)" });
  }

  const fields: Partial<Record<ClaimName, string>> = {};
  for (const r of rows) fields[r.field] = r.value;
  return {
    product: { row: p.row, cnCode: p.cnCode, productName: p.productName },
    fields,
    rows,
    toBeSupplied,
    setAtIssuance: ["methodologyNote", "idSalt", "batchSalt", "issuedAt"],
  };
}
