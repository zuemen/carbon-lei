// Importer workbench: many verified results → one year's CBAM declaration plan.
// Pure (no chain, no file system): takes verdicts that `verifyPresentation` / `carbonlei verify --json` already
// produced, plus what the importer knows from customs (net mass, CN code, origin, import date), and computes the
// embedded emissions to declare per shipment, totals, the 50 t de minimis status, the quarterly holding requirement,
// the certificates to surrender and their gross € value, and the difference against declaring every shipment on
// default values. It never changes a verdict and sends nothing anywhere.
//
// Regulatory inputs (sources in docs/OPERATE.md › Importer workbench and docs/CLIMATE_IMPACT.md):
//   mark-ups 10 % / 20 % / 30 % for 2026 / 2027 / 2028+ (1 % for fertilisers)    IR (EU) 2026/1740, Annex I opening
//   default values, every country and CN code of Annex I (total emissions column;  IR (EU) 2026/1740, Annex I, parsed
//     CN 7318 from Taiwan 2.707 tCO2e/t = direct; indirect N/A); "Other Countries     by scripts/parse-default-values.mjs
//     and Territories" when a country is not listed or shows "-"                     into data/default-values-2026-1740.json
//   de minimis: exempt while the year's net mass does not exceed 50 t                Reg. (EU) 2023/956 Art 2a + Annex VII
//                                                                                    (inserted by Reg. (EU) 2025/2083)
//   quarterly holding: ≥ 50 % of the embedded emissions imported since 1 January,    Art 22(2) and (2a) as replaced by
//     on default values WITHOUT mark-up, free-allocation adjustment deducted,         Reg. (EU) 2025/2083; from 2027
//   CBAM factor 97.5 % (2026), 95 % (2027), 90 % (2028) …; CSCF 1.0                 Commission verification guidance,
//                                                                                    24 Aug 2026, Table 3 (Art 10a(1a) ETS)
//   SEFA on default values = CBAM factor × CSCF × BM (Column B, default route)       IR (EU) 2025/2620, Annex points 4, 5.1
// Benchmarks (BM) are NOT built in: the right Column B value depends on the 8-digit CN code, the steel grade and the
// default production route of the origin, so the caller passes them (see `freeAllocation`). Without them the
// figures are gross, before the free-allocation adjustment, and say so.
import type { Verdict } from "./verdict.ts";
import { art9Summary, type Art9Summary } from "./carbonprice.ts";
import annexI from "./data/default-values-2026-1740.json" with { type: "json" };

/** Format of `PortfolioSummary`; a change that breaks a consumer increases it. */
export const PORTFOLIO_FORMAT = 1;

/** De minimis threshold, tonnes of net mass per importer and calendar year (Annex VII point 1). */
export const DE_MINIMIS_TONNES = 50;
/** Share of the year-to-date embedded emissions to hold at the end of each quarter (Art 22(2)). */
export const QUARTERLY_HOLDING_SHARE = 0.5;
/** First year the quarterly holding applies (Art 22(2): "From 2027"). */
export const QUARTERLY_HOLDING_FROM = 2027;

/** CBAM factor (Art 10a(1a) of Directive 2003/87/EC), by year; 0 from 2034. Guidance of 24 Aug 2026, Table 3. */
export const CBAM_FACTOR: Readonly<Record<number, number>> = {
  2026: 0.975, 2027: 0.95, 2028: 0.9, 2029: 0.775, 2030: 0.515, 2031: 0.39, 2032: 0.265, 2033: 0.14, 2034: 0,
};
/** Cross-sectoral correction factor; 1.0 for 2026–2030 (2031–2034 preliminary, also 1.0). Same table. */
export const CSCF = 1;

/** One Annex I row: direct, indirect, total (tCO2e/t; null = the annex's "-", "N/A" = not applicable), route. */
export type DefaultValueRow = [string | null, string | null, string | null, string];

/**
 * The default values of Annex I to IR (EU) 2026/1740 (which replaces Annex I to IR (EU) 2025/2621 from 1 January
 * 2026), every country table and "Other Countries and Territories" (key "OTHER"), keyed by ISO 3166 alpha-2 and by
 * CN/TARIC code without spaces. Extracted by scripts/parse-default-values.mjs from the Official Journal XHTML; `source`
 * carries its URL, access date and SHA-256. Unmarked: the year's mark-up is applied by `markedUpDefault`.
 */
export const DEFAULT_VALUES = annexI as unknown as {
  format: 1;
  source: { act: string; part: string; url: string; eli: string; format: string; sha256: string; accessed: string; parser: string };
  columns: ["direct", "indirect", "total", "route"];
  semantics: string[];
  stats: Record<string, unknown>;
  countries: Record<string, { name: string; rows: Record<string, DefaultValueRow> }>;
};

/** Short citation of the built-in table, used in `ShipmentLine.defaultSource`. */
export const DEFAULT_VALUES_ACT = "IR (EU) 2026/1740 Annex I";

/**
 * Column B CBAM benchmarks for CN 7318 (IR (EU) 2025/2620, Annex point 5.3), for reference: carbon steel by route
 * C (BF/BOF) 1.364, D (DRI/EAF) 0.475, E (scrap/EAF) 0.066; stainless 1.154 (production years 2026–27) and 1.116
 * (2028–30). IR 2026/1740 marks most Taiwanese CN 7318 lines with route (C). Exported for callers and the demo; the
 * portfolio uses a benchmark only when the caller passes it.
 */
export const CN7318_BENCHMARKS = {
  carbonSteel: { C: "1.364", D: "0.475", E: "0.066" },
  stainless: { "2026-2027": "1.154", "2028-2030": "1.116" },
} as const;

/** One imported consignment, as the importer knows it from customs, with the verdict of its supplier's proof. */
export interface ShipmentInput {
  /** The importer's line or batch id. */
  id: string;
  /** Verdict of the supplier's proof (`carbonlei verify --json`), or null/undefined when there is none. */
  verdict?: Verdict | null;
  /** Error of a verification that could not run (the `error` of a VerdictError). */
  verifyError?: string;
  /**
   * A re-check after acceptance (sdk/recheck.ts) found this line needs action, for example "REPORT_REVOKED": the
   * line is planned on the default value whatever its verdict, with this as the reason.
   */
  downgradedBy?: string;
  /** Net mass in tonnes, as a decimal string with at most 3 decimals (kg). */
  quantityTonnes: string;
  /** CN code of 4, 6 or 8 digits, or a 10-digit TARIC code (spaces allowed). */
  cnCode: string;
  /** Country of origin, ISO 3166 alpha-2. */
  country: string;
  /** Date of release for free circulation, YYYY-MM-DD. */
  importDate: string;
  supplier?: string;
  installation?: string;
  /**
   * Tonnes the supplier claimed for this importer on the ledger (the proof's shipment quantity). Used only when
   * check 5 passed: a declared quantity above it cannot rest on the verified value.
   */
  claimedTonnes?: string;
  /**
   * Batch id of that ledger claim (the proof's shipment batch). With the verdict's credential ID it keys the claim:
   * lines that share one claim share its tonnes across the whole portfolio, in input order, so one proof on several
   * manifest lines is counted once.
   */
  claimedBatchId?: string;
  /** Unmarked default value for this line, overriding `defaults` and the built-in Annex I table (tCO2e/t). */
  defaultValue?: string;
  /** Operator's verified specific embedded free allocation (tCO2e/t), for a line declared on actual values. */
  sefaActual?: string;
  /** Free text carried to the worksheet (for example "illustrative, not on-chain"). */
  note?: string;
}

export interface PortfolioOptions {
  /** Calendar year of import being planned; shipments of other years are listed and left out. */
  year: number;
  /** € per CBAM certificate for every quarter (overrides `quarterPrices`). */
  priceEur?: string;
  /** € per certificate by quarter of importation (2026 goods are priced per quarter, Art 21(1a)). */
  quarterPrices?: Partial<Record<1 | 2 | 3 | 4, string>>;
  /**
   * Unmarked default values that take precedence over the built-in Annex I table (`DEFAULT_VALUES`),
   * `<country>:<CN prefix>` → tCO2e/t; the longest prefix among them wins.
   */
  defaults?: Record<string, string>;
  /**
   * Free-allocation adjustment on default values: Column B benchmark of the origin's default production route,
   * `<country>:<CN prefix>` → tCO2e/t. `cbamFactor` defaults to `CBAM_FACTOR[year]`, `cscf` to 1.
   */
  freeAllocation?: { benchmarks: Record<string, string>; cbamFactor?: string; cscf?: string };
  /**
   * Optional carbon price deduction (CBAM Art 9) on the rules of the Commission's DRAFT implementing act (not adopted:
   * illustrative): the yearly reference price of CBAM certificates to divide by (draft Art 6(3)). The result is a
   * separate `art9` block; totals stay before it.
   */
  art9?: { refPriceEur: string };
  /**
   * Where the verdicts came from, stated in `verdictSource` and as the first note (for example the input file of
   * `carbonlei portfolio`, or caller-supplied verdicts on the REST API). buildPortfolio never re-verifies a proof.
   */
  verdictSource?: string;
}

export type Basis = "actual" | "default";

export interface ShipmentLine {
  id: string;
  cnCode: string;
  country: string;
  importDate: string;
  quarter: 1 | 2 | 3 | 4;
  supplier: string;
  installation: string;
  quantityTonnes: string;
  /** VALID, INVALID, CONTESTED, INCOMPLETE, ERROR (verification did not run) or NONE (no proof). */
  verdict: string;
  primaryCode: string;
  basis: Basis;
  /** Why the line is on default values; "" when it uses the verified value. */
  reason: string;
  /** Intensity used, tCO2e/t: the verified value, or the default with the year's mark-up. */
  seeUsed: string;
  /** Verified intensity when the line uses it (direct emissions for iron and steel), else "". */
  seeVerified: string;
  /** Unmarked default and the year's marked-up default, tCO2e/t. */
  defaultValue: string;
  /** Where the unmarked default comes from: the Annex I table and CN line it was read from, or the caller. */
  defaultSource: string;
  defaultMarkedUp: string;
  /** Embedded emissions declared, tCO2e (3 decimals). */
  embeddedT: string;
  /** Embedded emissions if this line were declared on the marked-up default, tCO2e. */
  allDefaultT: string;
  /** Free-allocation adjustment deducted, tCO2e; "" when not computed. */
  adjustmentT: string;
  /** Embedded emissions after the adjustment (gross when `adjustmentT` is ""), tCO2e. */
  obligationT: string;
  /** Quarterly-holding basis: unmarked default × quantity, minus the default adjustment when known, tCO2e. */
  holdingBasisT: string;
  verificationReportId: string;
  verifierLEI: string;
  credSAID: string;
  pinnedBlock: number | null;
  note: string;
}

export interface Group {
  key: string;
  shipments: number;
  quantityTonnes: string;
  embeddedT: string;
  allDefaultT: string;
}

export interface QuarterHolding {
  quarter: 1 | 2 | 3 | 4;
  /** Last day of the quarter, YYYY-MM-DD. */
  end: string;
  cumulativeBasisT: string;
  /** 50 % of the cumulative basis, tCO2e, and as whole certificates (rounded up). */
  requiredT: string;
  requiredCertificates: number;
  /** Whether the obligation applies at the end of this quarter (year ≥ 2027, threshold exceeded, Art 22(2a)). */
  applies: boolean;
  why: string;
}

export interface PortfolioSummary {
  format: typeof PORTFOLIO_FORMAT;
  kind: "carbonlei-portfolio";
  year: number;
  shipments: ShipmentLine[];
  /** Lines of another year, or that could not be planned, with the reason. */
  excluded: { id: string; reason: string }[];
  totals: {
    shipments: number;
    onActual: number;
    onDefault: number;
    quantityTonnes: string;
    embeddedT: string;
    allDefaultT: string;
    /** allDefaultT − embeddedT: the declared-emissions gap of the verified values (not a physical reduction). */
    gapT: string;
    adjustmentT: string;
    obligationT: string;
    allDefaultObligationT: string;
    /** Whole certificates to surrender (obligation rounded up), and for the all-default plan. */
    certificates: number;
    allDefaultCertificates: number;
    /** Gross € (obligation × price of the quarter of importation), null when a price is missing. */
    grossEur: string | null;
    allDefaultGrossEur: string | null;
    savedEur: string | null;
  };
  byCnCode: Group[];
  byCountry: Group[];
  byInstallation: Group[];
  bySupplier: Group[];
  byQuarter: Group[];
  deMinimis: {
    thresholdTonnes: number;
    netMassTonnes: string;
    exempt: boolean;
    /** The line whose import took the year's net mass over 50 t, and its quarter; null while exempt. */
    exceededBy: { id: string; importDate: string; quarter: 1 | 2 | 3 | 4 } | null;
  };
  quarterlyHolding: QuarterHolding[];
  freeAllocation: {
    applied: "none" | "partial" | "all";
    cbamFactor: string | null;
    cscf: string | null;
    note: string;
  };
  prices: Record<string, string | null>;
  rounding: string[];
  notes: string[];
  /** Where the verdicts came from (`PortfolioOptions.verdictSource`), when the caller said. */
  verdictSource?: string;
  /**
   * REST API only (POST /v1/portfolio): the HMAC binding of the plan, the binding (`mac`) of the verify-batch results
   * it was computed from when the server had bound them, and the client's nonce (sdk/server.ts).
   */
  binding?: { alg: "HMAC-SHA256"; mac: string };
  resultsBinding?: string;
  nonce?: string;
  /** Only with `PortfolioOptions.art9`: the draft Art 9 deduction, kept apart (sdk/carbonprice.ts art9Summary). */
  art9?: Art9Summary;
}

// ---------------------------------------------------------------------------------------------------------------
// Exact decimal arithmetic on bigint: a value with `scale` decimals is stored as value × 10^scale.

const P10 = (n: number) => 10n ** BigInt(n);

/** Parses a non-negative decimal string with at most `scale` decimals into units of 10^-scale. */
export function parseDec(s: string, scale: number, what = "value"): bigint {
  const t = String(s).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error(`${what} must be a non-negative decimal number, got "${s}"`);
  const frac = m[2] ?? "";
  if (frac.length > scale) {
    if (/[^0]/.test(frac.slice(scale))) throw new Error(`${what} has more than ${scale} decimals: "${s}"`);
  }
  return BigInt(m[1]) * P10(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale) || "0");
}

/** Divides by 10^drop with rounding half up (values are non-negative). */
export function roundHalfUp(v: bigint, drop: number): bigint {
  if (drop <= 0) return v * P10(-drop);
  const d = P10(drop);
  return (v + d / 2n) / d;
}

/** Formats units of 10^-scale with exactly `scale` decimals. */
export function fmtDec(v: bigint, scale: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(scale + 1, "0");
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return neg ? `-${out}` : out;
}

const ceilDiv = (v: bigint, d: bigint) => (v <= 0n ? 0n : (v + d - 1n) / d);

// Scales: tonnes of goods to kg (3), intensities to 1e-6 (6), tCO2e to kg (3), € to cents (2).
const Q = 3;
const I = 6;
const E = 3;

// ---------------------------------------------------------------------------------------------------------------

const cnDigits = (cn: string) => cn.replace(/\s+/g, "");

/**
 * The CN codes a shipment line may carry, after removing spaces: 4, 6 or 8 digits, or a 10-digit TARIC code (Annex I
 * of IR 2026/1740 has TARIC lines, for example 2523 10 00 10 and 2523 10 00 90 for clinker).
 */
export const CN_CODE = /^\d{4}(\d{2}){0,3}$/;

/**
 * Origins that are not subject to CBAM: the 27 EU member states (goods of Union origin are not imported; "EL" is the
 * EU's code for Greece) and the countries of Annex III point 1 to Reg. (EU) 2023/956 (Iceland, Liechtenstein, Norway,
 * Switzerland). The territories of Annex III point 2 (Büsingen, Heligoland, Livigno, Ceuta, Melilla) have no ISO
 * 3166 alpha-2 code of their own and are not recognised here.
 */
export const NOT_SUBJECT_TO_CBAM: Readonly<Record<string, string>> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", HR: "Croatia", CY: "Cyprus", CZ: "Czechia", DK: "Denmark", EE: "Estonia",
  FI: "Finland", FR: "France", DE: "Germany", GR: "Greece", EL: "Greece", HU: "Hungary", IE: "Ireland", IT: "Italy",
  LV: "Latvia", LT: "Lithuania", LU: "Luxembourg", MT: "Malta", NL: "Netherlands", PL: "Poland", PT: "Portugal",
  RO: "Romania", SK: "Slovakia", SI: "Slovenia", ES: "Spain", SE: "Sweden",
  IS: "Iceland", LI: "Liechtenstein", NO: "Norway", CH: "Switzerland",
};

/** Upper-case origin code; "UK", the common but non-ISO code of the United Kingdom, is read as GB. */
export function originCode(country: string): string {
  const c = String(country ?? "").trim().toUpperCase();
  return c === "UK" ? "GB" : c;
}

/** Why goods from `country` are not subject to CBAM, or null when they are. */
export function notSubjectToCbam(country: string): string | null {
  const iso = originCode(country);
  const name = NOT_SUBJECT_TO_CBAM[iso];
  if (!name) return null;
  const why = ["IS", "LI", "NO", "CH"].includes(iso) ? "listed in Annex III to Reg. (EU) 2023/956" : "an EU member state: goods of Union origin are not imports";
  return `goods originating in ${name} (${iso}) are not subject to CBAM (${why}); leave the line out of the CBAM plan`;
}

/** Mark-up for goods imported in `year` (IR 2026/1740, Annex I): 1 % fertilisers; 10/20/30 % the other sectors. */
export function markupFor(cnCode: string, year: number): { pct: number; sector: string } {
  const cn = cnDigits(cnCode);
  if (year < 2026) throw new Error(`year ${year} is before the definitive period (CBAM default mark-ups start in 2026)`);
  if (cn.startsWith("2716")) throw new Error(`CN ${cnCode} is electricity: declared per MWh, out of scope of this worksheet`);
  const fertiliser = cn.startsWith("31") || cn.startsWith("2808") || cn.startsWith("2814") || cn.startsWith("283421");
  if (fertiliser) return { pct: 1, sector: "fertilisers" };
  return { pct: year === 2026 ? 10 : year === 2027 ? 20 : 30, sector: "cement, iron and steel, aluminium or hydrogen" };
}

/** Marked-up default, rounded half up to 3 decimals (our convention: the CBAM Registry's rounding is not published). */
export function markedUpDefault(unmarked: string, cnCode: string, year: number): string {
  const { pct } = markupFor(cnCode, year);
  const v = parseDec(unmarked, I, "default value") * BigInt(100 + pct); // scale I + 2
  return fmtDec(roundHalfUp(v, I + 2 - 3), 3);
}

/** Looks a `<country>:<CN prefix>` key up in a table; the longest matching prefix wins. */
export function lookup(table: Record<string, string> | undefined, country: string, cnCode: string): string | undefined {
  if (!table) return undefined;
  const cn = cnDigits(cnCode);
  let best: { len: number; v: string } | undefined;
  for (const [k, v] of Object.entries(table)) {
    const [c, p] = k.split(":");
    if (originCode(c ?? "") !== originCode(country) || !p || !cn.startsWith(cnDigits(p))) continue;
    if (!best || cnDigits(p).length > best.len) best = { len: cnDigits(p).length, v };
  }
  return best?.v;
}

/** Result of `annexDefault`: the unmarked default and where it comes from, or why there is none. */
export type AnnexDefault =
  | { value: string; table: string; code: string; source: string }
  | { value: undefined; reason: string };

type TableHit =
  | { kind: "value"; value: string; code: string; lines?: number; mixed?: boolean }
  | { kind: "none"; why: string }
  | { kind: "ambiguous"; codes: string[] };

/** "731815" → "7318 15", as the annex prints codes (a 10-digit TARIC code gets a fourth pair). */
const spacedCn = (code: string) => code.replace(/^(\d{4})((?:\d{2})*)$/, (_, head: string, rest: string) => [head, ...(rest.match(/\d{2}/g) ?? [])].join(" "));

/** The longest code listed in table `iso` that is a prefix of `cn`, or undefined. */
function longestPrefix(iso: string, cn: string): string | undefined {
  const t = DEFAULT_VALUES.countries[iso];
  let best: string | undefined;
  if (t) for (const code of Object.keys(t.rows)) if (cn.startsWith(code) && (!best || code.length > best.length)) best = code;
  return best;
}

/**
 * The value a single annex line `code` takes for an origin with table `iso`: the origin's own line (longest prefix)
 * when it has a value, else the "Other Countries and Territories" line (longest prefix), else null.
 */
function effectiveLine(iso: string, code: string): { value: string | null; table: string; code: string } {
  const own = iso === "OTHER" ? undefined : longestPrefix(iso, code);
  const ownTotal = own !== undefined ? DEFAULT_VALUES.countries[iso].rows[own][2] : null;
  if (own !== undefined && ownTotal !== null) return { value: ownTotal, table: iso, code: own };
  const other = longestPrefix("OTHER", code);
  return { value: other !== undefined ? DEFAULT_VALUES.countries.OTHER.rows[other][2] : null, table: "OTHER", code: other ?? code };
}

/**
 * Looks a CN code up in one Annex I table: the longest listed code that is a prefix of it, else its sub-lines.
 * For a country table, a code shorter than the annex's lines (for example CN 7202 for the lines under it) resolves
 * only when every line under it has the same value, where a line the country does not list (or shows as "-") takes
 * its "Other Countries and Territories" value: the union of both tables' lines under the code is compared (third
 * review of 17 October 2026, M2: Albania lists only CN 7202 41 at 2.350, but CN 7202 19 from Albania is 5.590).
 */
function inTable(iso: string, cn: string): TableHit {
  const t = DEFAULT_VALUES.countries[iso];
  if (!t) return { kind: "none", why: "is not listed" };
  const best = longestPrefix(iso, cn);
  if (best !== undefined) {
    const total = t.rows[best][2];
    return total === null ? { kind: "none", why: `shows "-" for CN ${spacedCn(best)}` } : { kind: "value", value: total, code: best };
  }
  const under = Object.keys(t.rows).filter((code) => code.startsWith(cn));
  if (!under.length) return { kind: "none", why: `does not list CN ${spacedCn(cn)}` };
  const lines = iso === "OTHER" ? under : [...new Set([...under, ...Object.keys(DEFAULT_VALUES.countries.OTHER.rows).filter((code) => code.startsWith(cn))])].sort();
  const eff = lines.map((code) => ({ line: code, ...effectiveLine(iso, code) }));
  const totals = new Set(eff.map((e) => e.value));
  if (totals.size === 1) {
    const [only] = totals;
    if (only === null) return { kind: "none", why: `shows "-" for every line under CN ${spacedCn(cn)}` };
    const tables = new Set(eff.map((e) => e.table));
    return { kind: "value", value: only, code: cn, lines: lines.length, ...(tables.size > 1 ? { mixed: true } : {}) };
  }
  return { kind: "ambiguous", codes: eff.map((e) => `${spacedCn(e.line)} = ${e.value ?? "-"}${iso !== "OTHER" && e.table === "OTHER" ? " (Other Countries and Territories)" : ""}`) };
}

/**
 * The unmarked default value (total emissions, tCO2e/t) of Annex I to IR (EU) 2026/1740 for a good of `cnCode` from
 * `country`. Per the annex's opening paragraph, a country that is not listed, or whose table gives no value ("-"),
 * takes the value of "Other Countries and Territories"; so does a line the country's table does not list. A CN code
 * shorter than the annex's lines resolves only when all the lines under it carry one value, counting the lines the
 * country does not list at their "Other Countries and Territories" value; otherwise the reason asks for the longer
 * code or a caller value (`defaults`). "UK" is read as GB; an origin not subject to CBAM (EU member state, Annex III
 * country) has no default value, and the reason says so.
 */
export function annexDefault(country: string, cnCode: string): AnnexDefault {
  const cn = cnDigits(cnCode);
  const iso = originCode(country);
  if (!/^[A-Z]{2}$/.test(iso)) return { value: undefined, reason: `"${country}" is not an ISO 3166 alpha-2 code` };
  const exempt = notSubjectToCbam(iso);
  if (exempt) return { value: undefined, reason: exempt };
  if (!CN_CODE.test(cn)) return { value: undefined, reason: `CN code "${cnCode}" is not 4, 6 or 8 digits or a 10-digit TARIC code` };
  const ambiguous = (name: string, codes: string[]): AnnexDefault => ({
    value: undefined,
    reason:
      `CN ${cnCode} covers lines with different default values in the ${name} table of ${DEFAULT_VALUES_ACT}` +
      `${name === DEFAULT_VALUES.countries.OTHER.name ? "" : ` (with "Other Countries and Territories" for the lines it does not list or shows as "-")`}` +
      ` (${codes.slice(0, 5).join(", ")}${codes.length > 5 ? ", …" : ""}); give the longer CN or TARIC code, or pass the value in \`defaults\``,
  });
  const cite = (tableIso: string, h: { value: string; code: string; lines?: number; mixed?: boolean }, why?: string): AnnexDefault => {
    const name = DEFAULT_VALUES.countries[tableIso].name;
    const spaced = spacedCn(h.code);
    const at = h.lines
      ? `every one of the ${h.lines} lines under CN ${spaced}${h.mixed ? `, the lines ${name} does not list or shows as "-" taken from Other Countries and Territories` : ""}`
      : `CN ${spaced}`;
    return { value: h.value, table: tableIso, code: h.code, source: `${DEFAULT_VALUES_ACT}, ${name}, ${at}${why ? ` (${iso} ${why})` : ""}` };
  };
  const own = inTable(iso, cn);
  if (own.kind === "value") return cite(iso, own);
  if (own.kind === "ambiguous") return ambiguous(DEFAULT_VALUES.countries[iso].name, own.codes);
  const other = inTable("OTHER", cn);
  if (other.kind === "value") return cite("OTHER", other, own.why);
  if (other.kind === "ambiguous") return ambiguous(DEFAULT_VALUES.countries.OTHER.name, other.codes);
  return { value: undefined, reason: `CN ${cnCode} has no default value in ${DEFAULT_VALUES_ACT} (not a good it lists)` };
}

function quarterOf(date: string): 1 | 2 | 3 | 4 {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`import date must be YYYY-MM-DD, got "${date}"`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`import date has no month ${m[2]}: "${date}"`);
  return (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

const QUARTER_END = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" } as const;

/** Country of a UN/LOCODE (its first two letters), or "". */
const countryOfLocode = (l: string | undefined) => (l && /^[A-Z]{2}/.test(l) ? l.slice(0, 2) : "");

/**
 * Whether a line may rest on the verified value, and why not. The verified value is used only when the proof is
 * VALID, check 5 bound the shipment to the importer, and the disclosed CN code, origin and claimed tonnes agree
 * with what the importer declares to customs.
 */
export function eligibility(s: ShipmentInput): { ok: true; see: string } | { ok: false; reason: string } {
  const v = s.verdict;
  if (s.downgradedBy) return { ok: false, reason: `re-checked after acceptance: ${s.downgradedBy}` };
  if (s.verifyError) return { ok: false, reason: `verification did not run: ${s.verifyError}` };
  if (!v) return { ok: false, reason: "no supplier proof" };
  if (v.overall !== "VALID") return { ok: false, reason: `proof ${v.overall}${v.primaryCode ? ` (${v.primaryCode})` : ""}` };
  const d = v.disclosed ?? {};
  const see = d.specificEmbeddedEmissions_tCO2e_per_t;
  if (see === undefined) return { ok: false, reason: "the supplier did not disclose the intensity" };
  if (d.valueType !== undefined && d.valueType !== "actual") return { ok: false, reason: `the credential states valueType "${d.valueType}"` };
  if (v.checks.find((c) => c.id === 5)?.status !== "pass") {
    return { ok: false, reason: "check 5 did not bind the shipment to your EORI (verify with --eori)" };
  }
  if (d.cnCode !== undefined) {
    const a = cnDigits(d.cnCode);
    const b = cnDigits(s.cnCode);
    if (!b.startsWith(a) && !a.startsWith(b)) return { ok: false, reason: `the credential covers CN ${d.cnCode}, not CN ${s.cnCode}` };
  }
  const origin = countryOfLocode(d.unLocode);
  if (origin && origin !== s.country.toUpperCase()) return { ok: false, reason: `the installation is in ${origin}, not ${s.country}` };
  if (s.claimedTonnes !== undefined && parseDec(s.quantityTonnes, Q, "quantity") > parseDec(s.claimedTonnes, Q, "claimed tonnes")) {
    return { ok: false, reason: `${s.quantityTonnes} t declared but only ${s.claimedTonnes} t claimed on the ledger` };
  }
  try {
    parseDec(see, I, "verified intensity");
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return { ok: true, see };
}

function group(lines: ShipmentLine[], keyOf: (l: ShipmentLine) => string): Group[] {
  const m = new Map<string, { n: number; q: bigint; e: bigint; d: bigint }>();
  for (const l of lines) {
    const k = keyOf(l) || "(not given)";
    const g = m.get(k) ?? { n: 0, q: 0n, e: 0n, d: 0n };
    g.n++;
    g.q += parseDec(l.quantityTonnes, Q);
    g.e += parseDec(l.embeddedT, E);
    g.d += parseDec(l.allDefaultT, E);
    m.set(k, g);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, g]) => ({ key, shipments: g.n, quantityTonnes: fmtDec(g.q, Q), embeddedT: fmtDec(g.e, E), allDefaultT: fmtDec(g.d, E) }));
}

export const ROUNDING_RULES = [
  "Quantities are read exactly to the kilogram (at most 3 decimals); intensities to 6 decimals.",
  "Marked-up default = unmarked default × (1 + mark-up), rounded half up to 3 decimals (our convention: the CBAM Registry computes it and its rounding is not published).",
  "Default free allocation per tonne = CBAM factor × CSCF × benchmark, kept to 6 decimals (rounded half up).",
  "Per line: tCO2e = tonnes × intensity, rounded half up to 3 decimals (kg CO2e); totals and groups are sums of the rounded lines.",
  "Certificates = total obligation in tCO2e rounded up to a whole certificate; quarterly holding likewise (a purchase plan, not a Registry rule).",
  "Gross € = Σ line obligation × price of its quarter, rounded half up to the cent.",
] as const;

/** The year's declaration plan for a set of shipments. Throws on malformed input (with the line id). */
export function buildPortfolio(rawInput: ShipmentInput[], opts: PortfolioOptions): PortfolioSummary {
  // "UK" is read as GB everywhere below (Annex I table, eligibility's origin check, groups).
  const input = rawInput.map((s) => (typeof s.country === "string" && s.country.trim().toUpperCase() === "UK" ? { ...s, country: "GB" } : s));
  const year = opts.year;
  if (!Number.isInteger(year)) throw new Error(`year must be an integer, got ${year}`);
  markupFor("7318", year); // rejects a year before 2026
  const fa = opts.freeAllocation;
  const factorStr = fa ? (fa.cbamFactor ?? (CBAM_FACTOR[year] ?? (year > 2034 ? 0 : undefined))?.toString()) : undefined;
  if (fa && factorStr === undefined) throw new Error(`no CBAM factor known for ${year}; pass freeAllocation.cbamFactor`);
  const factor = factorStr !== undefined ? parseDec(factorStr, I, "CBAM factor") : undefined; // scale I
  const cscf = fa ? parseDec(fa.cscf ?? String(CSCF), I, "CSCF") : undefined; // scale I

  const priceOf = (q: 1 | 2 | 3 | 4): bigint | null => {
    const p = opts.priceEur ?? opts.quarterPrices?.[q];
    return p === undefined ? null : parseDec(p, 2, "price");
  };

  // One ledger claim (credential ID + batch id) may back several lines (a split consignment), but never more tonnes
  // in total than were claimed: in input order, a line that would take the claim over goes to the default value.
  // Lines of other years count too (the claim is the same). A quantity that cannot be read is left to the main loop,
  // which reports it with the line id.
  const claimUse = new Map<string, { claimedKg: bigint; usedKg: bigint; usedBy: string[]; lines: string[]; batch: string }>();
  const overClaim = new Map<ShipmentInput, string>();
  for (const s of input) {
    const said = s.verdict?.credSAID;
    if (!said || s.claimedBatchId === undefined || s.claimedTonnes === undefined) continue;
    let qKg: bigint;
    let claimedKg: bigint;
    try {
      qKg = parseDec(s.quantityTonnes, Q);
      claimedKg = parseDec(s.claimedTonnes, Q);
    } catch {
      continue;
    }
    const key = JSON.stringify([said, s.claimedBatchId]);
    const u = claimUse.get(key) ?? { claimedKg, usedKg: 0n, usedBy: [], lines: [], batch: s.claimedBatchId };
    claimUse.set(key, u);
    u.lines.push(s.id);
    if (!eligibility(s).ok) continue;
    if (u.usedKg + qKg > u.claimedKg) {
      const left = u.claimedKg > u.usedKg ? u.claimedKg - u.usedKg : 0n;
      overClaim.set(
        s,
        `${s.quantityTonnes} t declared but only ${fmtDec(left, Q)} t of the ${s.claimedTonnes} t claimed on the ledger for batch ${s.claimedBatchId} remain (already used by ${u.usedBy.join(", ")})`,
      );
      continue;
    }
    u.usedKg += qKg;
    u.usedBy.push(s.id);
  }

  const lines: ShipmentLine[] = [];
  const excluded: { id: string; reason: string }[] = [];
  const ids = new Set<string>();
  const allDefaultObl: bigint[] = []; // aligned with `lines`
  let faLines = 0;
  for (const s of input) {
    const where = `shipment ${s.id || "(no id)"}`;
    if (!s.id) throw new Error("every shipment needs an id");
    if (ids.has(s.id)) throw new Error(`${where}: duplicate id`);
    ids.add(s.id);
    if (!CN_CODE.test(cnDigits(s.cnCode ?? ""))) throw new Error(`${where}: CN code must be 4, 6 or 8 digits or a 10-digit TARIC code, got "${s.cnCode}"`);
    if (!/^[A-Za-z]{2}$/.test(s.country ?? "")) throw new Error(`${where}: country must be an ISO 3166 alpha-2 code, got "${s.country}"`);
    const exempt = notSubjectToCbam(s.country);
    if (exempt) throw new Error(`${where}: ${exempt}`);
    let quarter: 1 | 2 | 3 | 4;
    try {
      quarter = quarterOf(s.importDate);
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
    if (Number(s.importDate.slice(0, 4)) !== year) {
      excluded.push({ id: s.id, reason: `imported in ${s.importDate.slice(0, 4)}, not ${year}` });
      continue;
    }
    const qKg = parseDec(s.quantityTonnes, Q, `${where}: quantity`);
    // The caller's value wins (the line's own, then `defaults`); otherwise Annex I of IR (EU) 2026/1740.
    const callerDefault = s.defaultValue ?? lookup(opts.defaults, s.country, s.cnCode);
    const annex = callerDefault === undefined ? annexDefault(s.country, s.cnCode) : undefined;
    const unmarked = callerDefault ?? annex?.value;
    if (unmarked === undefined) {
      const why = annex && annex.value === undefined ? `: ${annex.reason}` : "";
      throw new Error(`${where}: no default value known for CN ${s.cnCode} from ${s.country.toUpperCase()}${why}${why.includes("`defaults`") ? "" : "; pass it (defaultValue or defaults)"}`);
    }
    const defaultSource =
      s.defaultValue !== undefined ? "caller (shipment defaultValue)" : callerDefault !== undefined ? "caller (defaults)" : annex?.value !== undefined ? annex.source : "";
    const marked = markedUpDefault(unmarked, s.cnCode, year);
    const over = overClaim.get(s);
    const el: ReturnType<typeof eligibility> = over !== undefined ? { ok: false, reason: over } : eligibility(s);
    const seeUsed = el.ok ? el.see : marked;
    const lineT = (intensity: string) => roundHalfUp(qKg * parseDec(intensity, I), Q + I - E);
    const embedded = lineT(seeUsed);
    const allDefault = lineT(marked);

    // Free-allocation adjustment: on default values from the benchmark; on actual values from the operator's SEFA.
    let sefaDefault: bigint | undefined; // scale I
    const bm = fa ? lookup(fa.benchmarks, s.country, s.cnCode) : undefined;
    if (bm !== undefined && factor !== undefined && cscf !== undefined) {
      sefaDefault = roundHalfUp(factor * cscf * parseDec(bm, I, `${where}: benchmark`), 2 * I);
    }
    const sefaUsed = el.ok ? (s.sefaActual !== undefined ? parseDec(s.sefaActual, I, `${where}: SEFA`) : undefined) : sefaDefault;
    const adjustment = sefaUsed !== undefined ? roundHalfUp(qKg * sefaUsed, Q + I - E) : undefined;
    if (adjustment !== undefined) faLines++;
    const obligation = adjustment !== undefined ? (embedded > adjustment ? embedded - adjustment : 0n) : embedded;
    const unmarkedT = lineT(unmarked);
    const holdingAdj = sefaDefault !== undefined ? roundHalfUp(qKg * sefaDefault, Q + I - E) : 0n;
    const holdingBasis = unmarkedT > holdingAdj ? unmarkedT - holdingAdj : 0n;
    const d = s.verdict?.disclosed ?? {};
    lines.push({
      id: s.id,
      cnCode: s.cnCode,
      country: s.country.toUpperCase(),
      importDate: s.importDate,
      quarter,
      supplier: s.supplier ?? d.supplierLEI ?? "",
      installation: s.installation ?? d.installationId ?? "",
      quantityTonnes: fmtDec(qKg, Q),
      verdict: s.verifyError ? "ERROR" : (s.verdict?.overall ?? "NONE"),
      primaryCode: s.verdict?.primaryCode ?? "",
      basis: el.ok ? "actual" : "default",
      reason: el.ok ? "" : el.reason,
      seeUsed: el.ok ? el.see : marked,
      seeVerified: el.ok ? el.see : "",
      defaultValue: unmarked,
      defaultSource,
      defaultMarkedUp: marked,
      embeddedT: fmtDec(embedded, E),
      allDefaultT: fmtDec(allDefault, E),
      adjustmentT: adjustment !== undefined ? fmtDec(adjustment, E) : "",
      obligationT: fmtDec(obligation, E),
      holdingBasisT: fmtDec(holdingBasis, E),
      verificationReportId: el.ok ? (d.verificationReportId ?? "") : "",
      verifierLEI: el.ok ? (d.verifierLEI ?? "") : "",
      credSAID: s.verdict?.credSAID ?? "",
      pinnedBlock: s.verdict?.chain?.block ?? null,
      note: s.note ?? "",
    });
    // The all-default obligation needs the default adjustment even for lines declared on actual values.
    const allDefaultAdj = sefaDefault !== undefined ? roundHalfUp(qKg * sefaDefault, Q + I - E) : 0n;
    allDefaultObl.push(allDefault > allDefaultAdj ? allDefault - allDefaultAdj : 0n);
  }

  // Totals.
  const sum = (f: (l: ShipmentLine) => string, scale: number) => lines.reduce((a, l) => a + parseDec(f(l) || "0", scale), 0n);
  const qTotal = sum((l) => l.quantityTonnes, Q);
  const embeddedTotal = sum((l) => l.embeddedT, E);
  const allDefaultTotal = sum((l) => l.allDefaultT, E);
  const adjustmentTotal = sum((l) => l.adjustmentT, E);
  const obligationTotal = sum((l) => l.obligationT, E);
  const allDefaultObligation = allDefaultObl.reduce((a, v) => a + v, 0n);
  const eur = (pick: (l: ShipmentLine, i: number) => bigint): bigint | null => {
    let cents = 0n; // scale E + 2
    for (const [i, l] of lines.entries()) {
      const p = priceOf(l.quarter);
      if (p === null) return null;
      cents += pick(l, i) * p;
    }
    return roundHalfUp(cents, E);
  };
  const grossEur = eur((l) => parseDec(l.obligationT, E));
  const allDefaultEur = eur((_, i) => allDefaultObl[i]);

  // De minimis (Art 2a): exempt while the year's net mass does not exceed 50 t; the line that crosses it.
  const sorted = [...lines].sort((a, b) => (a.importDate < b.importDate ? -1 : a.importDate > b.importDate ? 1 : 0));
  const limit = BigInt(DE_MINIMIS_TONNES) * P10(Q);
  let running = 0n;
  let exceededBy: PortfolioSummary["deMinimis"]["exceededBy"] = null;
  for (const l of sorted) {
    running += parseDec(l.quantityTonnes, Q);
    if (!exceededBy && running > limit) exceededBy = { id: l.id, importDate: l.importDate, quarter: l.quarter };
  }
  const exempt = exceededBy === null;

  // Quarterly holding (Art 22(2), (2a)).
  const quarterlyHolding: QuarterHolding[] = ([1, 2, 3, 4] as const).map((q) => {
    const end = `${year}-${QUARTER_END[q]}`;
    const basis = lines.filter((l) => l.importDate <= end).reduce((a, l) => a + parseDec(l.holdingBasisT, E), 0n);
    const required = roundHalfUp(basis * 5n, 1); // × 0.5, scale E
    let applies = true;
    let why = `≥ 50 % of the year-to-date embedded emissions on unmarked default values${faLines || fa ? ", free-allocation adjustment deducted where a benchmark was given" : ", before the free-allocation adjustment (no benchmark given)"}`;
    if (year < QUARTERLY_HOLDING_FROM) {
      applies = false;
      why = `does not apply to ${year} imports: the quarterly holding applies from ${QUARTERLY_HOLDING_FROM} (certificates are sold from 1 February 2027)`;
    } else if (exempt) {
      applies = false;
      why = `not required: net mass so far within the ${DE_MINIMIS_TONNES} t de minimis threshold`;
    } else if (exceededBy && q <= exceededBy.quarter) {
      applies = false;
      why =
        q < exceededBy.quarter
          ? `not yet required: the ${DE_MINIMIS_TONNES} t threshold was exceeded in Q${exceededBy.quarter}`
          : `not yet required: threshold exceeded in this quarter; comply by the end of the next quarter (Art 22(2a))`;
    }
    return { quarter: q, end, cumulativeBasisT: fmtDec(basis, E), requiredT: fmtDec(required, E), requiredCertificates: Number(ceilDiv(required, P10(E))), applies, why };
  });

  const onActual = lines.filter((l) => l.basis === "actual").length;
  const prices: Record<string, string | null> = {};
  for (const q of [1, 2, 3, 4] as const) {
    const p = priceOf(q);
    prices[`Q${q}`] = p === null ? null : fmtDec(p, 2);
  }
  const notes: string[] = [
    "A planning worksheet, not a CBAM declaration and not the CBAM Registry's XML format.",
    "The gap between all-default and the plan is a gap in declared emissions, not a physical reduction.",
    "Lines on actual values use the verified intensity only when the proof is VALID and check 5 bound the shipment to your EORI.",
    "Carbon price paid in the country of origin (Art 9) is not deducted.",
  ];
  for (const u of claimUse.values()) {
    if (u.lines.length < 2) continue;
    notes.push(
      `One ledger claim (batch ${u.batch}, ${fmtDec(u.claimedKg, Q)} t) is on ${u.lines.length} lines (${u.lines.join(", ")}): their tonnes are counted together against the claim, in input order; a line that would exceed it is planned on the default value.`,
    );
  }
  if (opts.verdictSource) notes.unshift(`Verdicts: ${opts.verdictSource}.`);
  if (exempt) notes.push(`Net mass ${fmtDec(qTotal, Q)} t does not exceed ${DE_MINIMIS_TONNES} t: exempt for ${year} (Art 2a) as long as no further CBAM goods are imported this year; the figures show what would apply.`);
  if (!fa) notes.push("Gross figures: no free-allocation benchmark was given, so the adjustment of Art 31 is not deducted.");
  if (fa && faLines < lines.length) notes.push("Some lines have no free-allocation adjustment (no benchmark for their CN code and origin, or no operator SEFA for a line on actual values); their figures are gross.");
  if (year === 2026 && !opts.priceEur) notes.push("2026 goods are priced at the average of the quarter of importation (Art 21(1a)).");

  return {
    format: PORTFOLIO_FORMAT,
    kind: "carbonlei-portfolio",
    year,
    shipments: lines,
    excluded,
    totals: {
      shipments: lines.length,
      onActual,
      onDefault: lines.length - onActual,
      quantityTonnes: fmtDec(qTotal, Q),
      embeddedT: fmtDec(embeddedTotal, E),
      allDefaultT: fmtDec(allDefaultTotal, E),
      gapT: fmtDec(allDefaultTotal - embeddedTotal, E),
      adjustmentT: fmtDec(adjustmentTotal, E),
      obligationT: fmtDec(obligationTotal, E),
      allDefaultObligationT: fmtDec(allDefaultObligation, E),
      certificates: Number(ceilDiv(obligationTotal, P10(E))),
      allDefaultCertificates: Number(ceilDiv(allDefaultObligation, P10(E))),
      grossEur: grossEur === null ? null : fmtDec(grossEur, 2),
      allDefaultGrossEur: allDefaultEur === null ? null : fmtDec(allDefaultEur, 2),
      savedEur: grossEur === null || allDefaultEur === null ? null : fmtDec(allDefaultEur - grossEur, 2),
    },
    byCnCode: group(lines, (l) => cnDigits(l.cnCode)),
    byCountry: group(lines, (l) => l.country),
    byInstallation: group(lines, (l) => l.installation),
    bySupplier: group(lines, (l) => l.supplier),
    byQuarter: group(lines, (l) => `Q${l.quarter}`),
    deMinimis: { thresholdTonnes: DE_MINIMIS_TONNES, netMassTonnes: fmtDec(qTotal, Q), exempt, exceededBy },
    quarterlyHolding,
    freeAllocation: {
      applied: faLines === 0 ? "none" : faLines === lines.length ? "all" : "partial",
      cbamFactor: factor !== undefined ? fmtDec(factor, I).replace(/0+$/, "").replace(/\.$/, "") : null,
      cscf: cscf !== undefined ? fmtDec(cscf, I).replace(/0+$/, "").replace(/\.$/, "") : null,
      note: fa
        ? "Default lines: SEFA = CBAM factor × CSCF × benchmark (IR (EU) 2025/2620, Annex point 4). Lines on actual values use the operator's verified SEFA when given."
        : "Not applied: pass the Column B benchmarks of IR (EU) 2025/2620 for your goods to deduct it.",
    },
    prices,
    rounding: [...ROUNDING_RULES],
    notes,
    ...(opts.verdictSource ? { verdictSource: opts.verdictSource } : {}),
    ...(opts.art9 ? { art9: art9Summary(lines, new Map(input.map((s) => [s.id, s.verdict])), opts.art9, fmtDec(obligationTotal, E)) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Worksheet (CSV): one row per line, the fields a CBAM declaration asks for per good, plus how each was derived.

export const WORKSHEET_COLUMNS = [
  "line_id",
  "cn_code",
  "country_of_origin",
  "installation_id",
  "supplier",
  "import_date",
  "quarter",
  "net_mass_t",
  "see_direct_tco2e_per_t",
  "see_indirect_tco2e_per_t",
  "value_basis",
  "default_unmarked_tco2e_per_t",
  "default_marked_up_tco2e_per_t",
  "embedded_emissions_tco2e",
  "free_allocation_adjustment_tco2e",
  "obligation_tco2e",
  "verdict",
  "reason_for_default",
  "verification_report_id",
  "verifier_lei",
  "credential_said",
  "pinned_block",
  "note",
] as const;

/**
 * RFC 4180 field, quoted when it holds a comma, semicolon, tab, quote or line break (a spreadsheet that splits on ";"
 * or tab then keeps it in one cell). CSV injection: a field whose first character after leading white space is = + - @, or
 * that starts with a tab or carriage return, is prefixed with ' (a plain number such as -1.5 is left as it is).
 */
export function csvField(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if ((/^[\t\r]/.test(s) || /^\s*[=+\-@]/.test(s)) &&!/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF); a UTF-8 BOM is dropped; blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    field = "";
  };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (field += '"'), (i += 2);
      else if (c === '"') (quoted = false), i++;
      else (field += c), i++;
      continue;
    }
    if (c === '"' && field === "") (quoted = true), i++;
    else if (c === ",") row.push(field), (field = ""), i++;
    else if (c === "\r" && s[i + 1] === "\n") endRow(), (i += 2);
    else if (c === "\n" || c === "\r") endRow(), i++;
    else (field += c), i++;
  }
  if (quoted) throw new Error("CSV: a quoted field is not closed");
  if (field !== "" || row.length) endRow();
  return rows;
}

/** The declaration worksheet as CSV text (CRLF line ends, header row first, a title row before it). */
export function worksheetCsv(p: PortfolioSummary): string {
  const rows: string[][] = [];
  rows.push([`# CarbonLEI declaration worksheet ${p.year}: a planning aid, not the CBAM Registry XML schema and not a CBAM declaration`]);
  rows.push([...WORKSHEET_COLUMNS]);
  for (const l of p.shipments) {
    rows.push([
      l.id,
      l.cnCode,
      l.country,
      l.installation,
      l.supplier,
      l.importDate,
      `Q${l.quarter}`,
      l.quantityTonnes,
      l.seeUsed,
      "",
      l.basis,
      l.defaultValue,
      l.defaultMarkedUp,
      l.embeddedT,
      l.adjustmentT,
      l.obligationT,
      l.verdict,
      l.reason,
      l.verificationReportId,
      l.verifierLEI,
      l.credSAID,
      l.pinnedBlock === null ? "" : String(l.pinnedBlock),
      l.note,
    ]);
  }
  const t = p.totals;
  rows.push(["TOTAL", "", "", "", "", "", "", t.quantityTonnes, "", "", `${t.onActual} actual / ${t.onDefault} default`, "", "", t.embeddedT, p.freeAllocation.applied === "none" ? "" : t.adjustmentT, t.obligationT]);
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
