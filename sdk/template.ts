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
//
// Untrusted input: before exceljs sees the file, the zip directory is listed and checked against ZIP_LIMITS, only the
// parts the importer reads are inflated (with a running byte count), and they are repacked into a small xlsx.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Workbook, Worksheet } from "exceljs";
import { Inflate, zipSync } from "fflate";
import { isCnCode, isReportingPeriod, type ClaimName } from "./credential.ts";

export const SUPPORTED_TEMPLATE_VERSIONS = ["2.1", "2.1.1"] as const;
export type TemplateVersion = (typeof SUPPORTED_TEMPLATE_VERSIONS)[number];

/** Decimal places kept for emission intensities and other numbers (round half away from zero). */
export const DECIMALS = 5;
/** Files above this size are refused before parsing. */
export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
/**
 * Limits on the zip container, checked before anything is inflated. Declared sizes come from the zip's central
 * directory; while an entry is inflated, its output is counted and may not exceed the size it declares.
 */
export const ZIP_LIMITS = {
  maxEntries: 1000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 150 * 1024 * 1024,
} as const;
/** |SEE (total) − (SEE (direct) + SEE (indirect))| above this is an error. */
export const SUM_TOLERANCE = 1e-4;

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

/** Label of the installation totals (row 15, column before the value): V2.1 Z15, V2.1.1 AA15. */
const TOTALS_LABEL = "Total direct emissions";

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
    headers: { ...COMMON_HEADERS, P25: "The main reducing agent", Q25: "Steel mill identification number", Z15: TOTALS_LABEL },
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
      AA15: TOTALS_LABEL,
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
  /** Plausibility findings that do not stop the import (for example a UN/LOCODE from another country). */
  warnings: string[];
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

/** Days between the 1900 and 1904 date systems of Excel. */
const DATE1904_OFFSET = 1462;

/**
 * Date cell → YYYY-MM-DD taken in UTC. Accepts a Date, an Excel serial day number or an ISO date string.
 * Serial numbers use the workbook's date system: 1900 by default, 1904 when `date1904` is set
 * (exceljs already applies the date system to the cells it returns as Date).
 * An ISO string must name a real calendar day: "2023-02-30" is refused, not rolled over to March.
 */
export function toUtcDate(v: unknown, where: string, date1904 = false): string {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "number" && Number.isInteger(v) && v > 0) d = new Date((v + (date1904 ? DATE1904_OFFSET : 0) - 25569) * 86_400_000);
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(v.trim())) {
    const ymd = v.trim().slice(0, 10);
    d = new Date(ymd + "T00:00:00Z");
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) d = null;
  }
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

function requireNumber(ws: Worksheet, ref: string, what: string): number {
  const v = requireCached(ws, ref, what);
  if (typeof v !== "number") throw new TemplateError(`${ws.name}!${ref} (${what}): not a number: ${JSON.stringify(v)}`);
  return v;
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
  const date1904 = !!wb.properties?.date1904;
  let found: { version: string; date: string | null } | null = null;
  for (let r = 9; r <= 60; r++) {
    const v = cached(ws, `E${r}`);
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    if (/^\d+(\.\d+)*$/.test(s)) {
      const d = cached(ws, `F${r}`);
      let date: string | null = null;
      try {
        date = d === null ? null : toUtcDate(d, `0_Versions!F${r}`, date1904);
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
 * Default loader (Node): exceljs's prebuilt bundle, the same file the demo's worker uses. Its Node entry point would
 * also load the streaming reader (unzipper and its dependencies), which the importer does not use: it hands exceljs
 * an in-memory buffer. The specifier is a variable so that bundlers leave it alone; the demo passes its own loader.
 */
async function nodeExcel(): Promise<ExcelModule> {
  const spec = "exceljs/dist/exceljs.min.js";
  const mod = (await import(/* @vite-ignore */ spec)) as { default?: ExcelModule } & ExcelModule;
  return mod.default ?? mod;
}

// ------------------------------------------------------------- zip container

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  compressedSize: number;
  /** Uncompressed size declared in the central directory. */
  size: number;
  localHeaderOffset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const zipError = (msg: string) => new TemplateError(`not a readable xlsx file: ${msg}`);

/**
 * Lists the entries of a zip file from its central directory, without inflating anything, and refuses the file if
 * it has more than `limits.maxEntries` entries, an entry that declares more than `limits.maxEntryBytes`
 * uncompressed, or declared sizes that add up to more than `limits.maxTotalBytes`. ZIP64, multi-disk and
 * encrypted archives are refused (an xlsx under MAX_TEMPLATE_BYTES needs none of them).
 */
export function listZipEntries(bytes: Uint8Array, limits: typeof ZIP_LIMITS = ZIP_LIMITS): ZipEntry[] {
  let eocd = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 22 - 0xffff); i >= min; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw zipError("no zip end-of-central-directory record");
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0 || u16(bytes, eocd + 8) !== count) throw zipError("multi-disk zip");
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw zipError("ZIP64 is not supported");
  if (count > limits.maxEntries) throw new TemplateError(`zip has ${count} entries (limit ${limits.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw zipError("central directory out of range");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let i = 0, p = cdOffset; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || u32(bytes, p) !== 0x02014b50) throw zipError("corrupt central directory");
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const next = p + 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    if (next > cdOffset + cdSize) throw zipError("corrupt central directory");
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const localHeaderOffset = u32(bytes, p + 42);
    p = next;
    if (flags & 1) throw zipError(`zip entry "${name}" is encrypted`);
    if (method !== 0 && method !== 8) throw zipError(`zip entry "${name}" uses compression method ${method}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff) throw zipError("ZIP64 is not supported");
    if (size > limits.maxEntryBytes) {
      throw new TemplateError(`zip entry "${name}" declares ${size} bytes uncompressed (limit ${limits.maxEntryBytes} per entry)`);
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new TemplateError(`zip entries declare more than ${limits.maxTotalBytes} bytes uncompressed in total`);
    if (names.has(name)) throw zipError(`zip entry "${name}" appears twice`);
    names.add(name);
    entries.push({ name, method, compressedSize, size, localHeaderOffset });
  }
  return entries;
}

/** Input bytes handed to the inflater per step; deflate expands at most about 1032:1, so one step yields ≤ ~4 MB. */
const INFLATE_STEP = 4096;

/** Inflates one entry, counting output bytes: more than the declared size (itself capped by ZIP_LIMITS) is an error. */
export function inflateZipEntry(bytes: Uint8Array, e: ZipEntry): Uint8Array {
  const o = e.localHeaderOffset;
  if (o + 30 > bytes.length || u32(bytes, o) !== 0x04034b50) throw zipError(`local header of "${e.name}" not found`);
  const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
  const data = bytes.subarray(start, start + e.compressedSize);
  if (start + e.compressedSize > bytes.length) throw zipError(`zip entry "${e.name}" is truncated`);
  if (e.method === 0) {
    if (e.compressedSize !== e.size) throw zipError(`stored zip entry "${e.name}" has inconsistent sizes`);
    return data.slice();
  }
  const out = new Uint8Array(e.size);
  let n = 0;
  const inf = new Inflate((chunk) => {
    if (n + chunk.length > e.size) {
      throw new TemplateError(`zip entry "${e.name}" inflates to more than the ${e.size} bytes it declares`);
    }
    out.set(chunk, n);
    n += chunk.length;
  });
  try {
    if (data.length === 0) inf.push(data, true);
    for (let i = 0; i < data.length; i += INFLATE_STEP) inf.push(data.subarray(i, i + INFLATE_STEP), i + INFLATE_STEP >= data.length);
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    throw zipError(`zip entry "${e.name}": ${(err as Error).message}`);
  }
  if (n !== e.size) throw zipError(`zip entry "${e.name}" inflates to ${n} bytes, not the ${e.size} it declares`);
  return out;
}

/** Sheets the importer reads; the other sheets of the template are not inflated. */
const SHEETS_READ = ["0_Versions", INST, SC];

const xmlAttr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3]) : null;
};
const xmlUnescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, x: string) =>
    x === "lt" ? "<" : x === "gt" ? ">" : x === "quot" ? '"' : x === "apos" ? "'" : x === "amp" ? "&" : String.fromCodePoint(x[1] === "x" ? parseInt(x.slice(2), 16) : Number(x.slice(1))),
  );

/** Resolves a relationship target of xl/workbook.xml to a zip path. */
const partPath = (target: string) => (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);

/**
 * Checks the zip container and returns a small xlsx with only the parts the importer reads: content types,
 * package and workbook relationships, the workbook, shared strings, styles and the sheets 0_Versions, A_InstData
 * and Summary_Communication. Every other part is listed (and counted against ZIP_LIMITS) but not inflated.
 */
export function extractTemplateParts(bytes: Uint8Array, limits: typeof ZIP_LIMITS = ZIP_LIMITS): Uint8Array {
  const entries = listZipEntries(bytes, limits);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const parts: Record<string, Uint8Array> = {};
  const read = (name: string, required: boolean): string | null => {
    const e = byName.get(name);
    if (!e) {
      if (required) throw zipError(`"${name}" not found; not an xlsx workbook`);
      return null;
    }
    parts[name] = inflateZipEntry(bytes, e);
    return new TextDecoder().decode(parts[name]);
  };
  read("[Content_Types].xml", true);
  read("_rels/.rels", true);
  const workbook = read("xl/workbook.xml", true) as string;
  const rels = read("xl/_rels/workbook.xml.rels", true) as string;
  const relById = new Map<string, { type: string; target: string }>();
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = xmlAttr(tag, "Id");
    const target = xmlAttr(tag, "Target");
    if (id && target) relById.set(id, { type: xmlAttr(tag, "Type") ?? "", target: xmlUnescape(target) });
  }
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlUnescape(xmlAttr(tag, "name") ?? "");
    const rid = /\s[\w.-]+:id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const rel = rid ? relById.get(rid) : undefined;
    if (SHEETS_READ.includes(name) && rel) read(partPath(rel.target), true);
  }
  for (const kind of ["sharedStrings", "styles"]) {
    const rel = [...relById.values()].find((r) => r.type.endsWith(`/${kind}`));
    read(rel ? partPath(rel.target) : `xl/${kind}.xml`, false);
  }
  return zipSync(parts, { level: 0 });
}

async function loadWorkbook(bytes: Uint8Array, excel: () => Promise<ExcelModule>): Promise<Workbook> {
  const small = extractTemplateParts(bytes);
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs accepts an ArrayBuffer in both Node and the browser.
    await wb.xlsx.load(small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength) as ArrayBuffer);
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

  const warnings: string[] = [];
  if (installation.unLocode !== null && installation.country !== null && /^[A-Za-z]{2}$/.test(installation.country)) {
    const u = normaliseUnLocode(installation.unLocode);
    if (u.slice(0, 2) !== installation.country.toUpperCase()) {
      warnings.push(
        `UN/LOCODE "${installation.unLocode}" (${at(SC, map.installation.unLocode)}) does not start with the country code ` +
          `"${installation.country}" (${at(SC, map.installation.country)})`,
      );
    }
  }

  const date1904 = !!wb.properties?.date1904;
  const start = toUtcDate(requireCached(sc, map.periodStart, "reporting period start"), at(SC, map.periodStart), date1904);
  const end = toUtcDate(requireCached(sc, map.periodEnd, "reporting period end"), at(SC, map.periodEnd), date1904);
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
  {
    const [d, i, tot] = (["direct", "indirect", "total"] as const).map((k) => cached(sc, map.totals[k]));
    if (typeof d === "number" && typeof i === "number" && typeof tot === "number") {
      checkSum(d, i, tot, `installation totals ${at(SC, map.totals.direct)}:${map.totals.total}`);
    }
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
    const see = {} as Record<"direct" | "indirect" | "total", number>;
    for (const [k, col] of [["direct", c.seeDirect], ["indirect", c.seeIndirect], ["total", c.seeTotal]] as const) {
      const ref = `${col}${row}`;
      see[k] = requireNumber(sc, ref, `SEE (${k}) of CN ${cnCode}`);
      if (see[k] < 0) throw new TemplateError(`${at(SC, ref)} (SEE (${k}) of CN ${cnCode}) is negative: ${see[k]}`);
    }
    checkSum(see.direct, see.indirect, see.total, `${at(SC, `${c.seeDirect}${row}`)}:${c.seeTotal}${row} (SEE of CN ${cnCode})`);
    const p: TemplateProduct = {
      row,
      productionProcess: text(c.productionProcess),
      aggregatedGoodsCategory: text(c.aggregatedGoodsCategory),
      cnCode,
      cnName: text(c.cnName),
      productName: text(c.productName),
      seeDirect: roundDecimal(see.direct),
      seeIndirect: roundDecimal(see.indirect),
      seeTotal: roundDecimal(see.total),
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
    warnings,
  };
}

/** total must equal direct + indirect within SUM_TOLERANCE (the template computes it as their sum). */
function checkSum(direct: number, indirect: number, total: number, where: string): void {
  const diff = Math.abs(total - (direct + indirect));
  if (!(diff <= SUM_TOLERANCE)) {
    throw new TemplateError(`${where}: total ${total} is not direct ${direct} + indirect ${indirect} (difference ${diff}, tolerance ${SUM_TOLERANCE})`);
  }
}

// ------------------------------------------------------------------ the draft

export const SET_AT_ISSUANCE = "set by the SDK at issuance";

/** Who still has to supply a field the template could not fill. */
export type SuppliedBy = "supplier" | "verification body";

export interface ToBeSupplied {
  field: ClaimName;
  by: SuppliedBy;
  reason: string;
}

const NO_CELL = "no cell in the Communication Template";
const DIFFERENT_MEANING = "not mapped: the template's activity data has a different meaning";

/** For each field in NOT_IN_TEMPLATE: who supplies it and why the template cannot. */
const NOT_IN_TEMPLATE_BY: Partial<Record<ClaimName, { by: SuppliedBy; reason: string }>> = {
  supplierLEI: { by: "supplier", reason: NO_CELL },
  operatorId: { by: "supplier", reason: NO_CELL },
  installationId: { by: "supplier", reason: NO_CELL },
  cbamRoute: { by: "supplier", reason: NO_CELL },
  verifiedTonnes: { by: "verification body", reason: DIFFERENT_MEANING },
  verificationReportId: { by: "verification body", reason: NO_CELL },
  verifierLEI: { by: "verification body", reason: NO_CELL },
  siteVisit: { by: "verification body", reason: NO_CELL },
  assuranceLevel: { by: "verification body", reason: NO_CELL },
  materialityThreshold: { by: "verification body", reason: NO_CELL },
  validUntil: { by: "verification body", reason: NO_CELL },
  energyMix: { by: "supplier", reason: DIFFERENT_MEANING },
  supplierCost: { by: "supplier", reason: NO_CELL },
};

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
  /** Fields the template could not fill: who supplies each (the supplier or the verification body) and why. */
  toBeSupplied: ToBeSupplied[];
  /** Fields the SDK sets when the credential is issued. */
  setAtIssuance: ClaimName[];
}

/**
 * CN codes of Annex II of Regulation (EU) 2023/956, "List of goods for which only direct emissions are to be taken into
 * account, pursuant to Article 7(1)", as amended by Regulation (EU) 2025/2083, Article 1(29) (adds 2716 00 00, electrical
 * energy). Each entry is the CN code as printed in the Annex, digits only: the iron and steel rows (chapter 72 with the
 * exceptions below, and headings 7301 to 7326 as listed), the aluminium rows (7601 to 7616 as listed), 2804 10 00 hydrogen
 * and 2716 00 00 electrical energy. Chapters 72 and 73 are not taken whole: 2601 12 00 (agglomerated iron ores) is in
 * Annex I but not in Annex II, and 73 has only the headings listed.
 * A product's CN code is covered when it starts with an entry and does not start with an entry of ANNEX_II_EXCEPT.
 * Text checked against the Official Journal (L 130/52, 16.5.2023; L 2025/2083, 17.10.2025) on 2026-10-07.
 */
export const DIRECT_ONLY_CN_PREFIXES = [
  "72",
  "7301",
  "7302",
  "730300",
  "7304",
  "7305",
  "7306",
  "7307",
  "7308",
  "730900",
  "7310",
  "731100",
  "7318",
  "7326",
  "7601",
  "7603",
  "7604",
  "7605",
  "7606",
  "7607",
  "7608",
  "76090000",
  "7610",
  "76110000",
  "7612",
  "76130000",
  "7614",
  "7616",
  "28041000",
  "27160000",
] as const;
/** The "Except:" list of the chapter 72 row of Annex II: ferro-silicon (7202 2), the other listed ferro-alloys, and 7204 ferrous waste and scrap. */
export const ANNEX_II_EXCEPT = ["72022", "720230", "720250", "720270", "720280", "720291", "720292", "720293", "720299", "7204"] as const;
export const CN7318_DIRECT_ONLY =
  "CN 7318 counts direct emissions only for CBAM certificates in the definitive period (transitional reports also listed indirect emissions)";
/** Electricity is in Annex II, but its embedded emissions are per MWh; the credential intensity is per tonne. */
const ELECTRICITY = "27160000";

export type AnnexIIStatus =
  | { status: "listed"; entry: string }
  | { status: "not listed" }
  /** The code is shorter than an Annex II entry or exception it contains, so the Annex does not decide it. */
  | { status: "undetermined"; entries: string[] };

/** Whether a CN code (4, 6 or 8 digits) is in Annex II of Regulation (EU) 2023/956 (only direct emissions are taken into account). */
export function annexIIStatus(cnCode: string): AnnexIIStatus {
  if (ANNEX_II_EXCEPT.some((x) => cnCode.startsWith(x))) return { status: "not listed" };
  const finer = [...DIRECT_ONLY_CN_PREFIXES, ...ANNEX_II_EXCEPT].filter((x) => x.length > cnCode.length && x.startsWith(cnCode));
  const entry = DIRECT_ONLY_CN_PREFIXES.find((x) => cnCode.startsWith(x));
  if (finer.length > 0) return { status: "undetermined", entries: entry ? [entry, ...finer] : finer };
  return entry ? { status: "listed", entry } : { status: "not listed" };
}

/** The rule note for a covered entry; for 7318 it is exactly CN7318_DIRECT_ONLY. */
function directOnlyNote(entry: string): string {
  const cn = entry === "72" ? "chapter 72 (except the ferro-alloys and scrap Annex II excludes)" : entry.replace(/^(\d{4})(\d{2})?(\d{2})?$/, (_, a, b, c) => [a, b, c].filter(Boolean).join(" "));
  return `CN ${cn} counts direct emissions only for CBAM certificates in the definitive period (transitional reports also listed indirect emissions)`;
}

/** Credential field draft for one product row (index into `t.products`). Only fields with a template source are filled. */
export function draftCredentialFields(t: ParsedTemplate, productIndex = 0): CredentialDraft {
  const p = t.products[productIndex];
  if (!p) throw new TemplateError(`product ${productIndex + 1} not found (the file has ${t.products.length})`);
  const rows: DraftRow[] = [];
  const toBeSupplied: ToBeSupplied[] = NOT_IN_TEMPLATE.map((field) => ({
    field,
    ...(NOT_IN_TEMPLATE_BY[field] ?? { by: "verification body", reason: NO_CELL }),
  }));
  const add = (field: ClaimName, value: string, source: string, rule: string) => rows.push({ field, value, source, rule });
  const later = (field: ClaimName, by: SuppliedBy, reason: string) => toBeSupplied.push({ field, by, reason });

  add("installationName", t.installation.name, t.sources["installation.name"], "text, trimmed");
  if (t.installation.unLocode !== null) {
    const u = normaliseUnLocode(t.installation.unLocode);
    if (UN_LOCODE.test(u)) add("unLocode", u, t.sources["installation.unLocode"], "spaces removed, upper case");
    else later("unLocode", "supplier", `"${t.installation.unLocode}" is not a UN/LOCODE`);
  } else later("unLocode", "supplier", "blank in the template");

  add("cnCode", p.cnCode, p.sources.cnCode, "digits only; the 8-digit CN code is kept");
  const period = `${t.reportingPeriod.start}/${t.reportingPeriod.end}`;
  if (!isReportingPeriod(period)) throw new TemplateError(`reporting period ${period} not in normal form`);
  add("reportingPeriod", period, `${t.sources["reportingPeriod.start"]}, ${t.sources["reportingPeriod.end"]}`, "dates read in UTC, start/end");

  const annexII = annexIIStatus(p.cnCode);
  if (annexII.status === "listed" && annexII.entry !== ELECTRICITY) {
    add(
      "specificEmbeddedEmissions_tCO2e_per_t",
      p.seeDirect,
      p.sources.seeDirect,
      `SEE (direct), rounded half away from zero to ${DECIMALS} decimals; ${annexII.entry === "7318" ? CN7318_DIRECT_ONLY : directOnlyNote(annexII.entry)}`,
    );
  } else {
    later(
      "specificEmbeddedEmissions_tCO2e_per_t",
      "verification body",
      annexII.status === "listed"
        ? `CN ${p.cnCode} (electrical energy) is in Annex II of Regulation (EU) 2023/956, but its embedded emissions are per MWh and the credential intensity is per tonne`
        : annexII.status === "undetermined"
          ? `CN ${p.cnCode} has ${p.cnCode.length} digits and Annex II of Regulation (EU) 2023/956 lists only part of it (${annexII.entries.join(", ")}); whether it counts indirect emissions is left to the verification body`
          : `this importer maps SEE (direct) only for the CN codes in Annex II of Regulation (EU) 2023/956 (direct emissions only); CN ${p.cnCode} is not listed there, so whether it counts indirect emissions is left to the verification body`,
    );
  }

  // A blank share is not read as 0: blank means the supplier has not stated it, so the value type stays open.
  const shareSource = p.sources.defaultValueShare;
  const share = p.defaultValueShare === null ? null : Number(p.defaultValueShare);
  if (share === null) later("valueType", "supplier", `share of emissions by default values (${shareSource}) is blank`);
  else if (share === 0) add("valueType", "actual", shareSource, "share by default values 0 → actual");
  else if (share === 1) add("valueType", "default", shareSource, "share by default values 1 → default");
  else if (share > 0 && share < 1) later("valueType", "verification body", `share by default values is ${p.defaultValueShare}; CarbonLEI has no value type for a mix`);
  else later("valueType", "supplier", `share by default values is ${p.defaultValueShare}, not a fraction between 0 and 1`);

  if (p.productionProcess !== null) {
    const parts = [p.productionProcess, p.mainReducingAgent ? `main reducing agent of the precursor: ${p.mainReducingAgent}` : null].filter(Boolean);
    add(
      "productionRoute",
      parts.join("; "),
      [p.sources.productionProcess, p.mainReducingAgent ? p.sources.mainReducingAgent : null].filter(Boolean).join(", "),
      "free text joined with \"; \"; never disclosed to importers",
    );
  } else later("productionRoute", "supplier", "blank in the template");

  for (const k of ["nabName", "accreditationNumber"] as const) {
    if (t.verifier[k] !== null) add(k, t.verifier[k] as string, t.sources[`verifier.${k}`], "text, trimmed");
    else later(k, "verification body", "blank in the template (optional in the transitional period)");
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
