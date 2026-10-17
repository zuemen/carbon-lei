// The fields of the Commission's CBAM communication template (v2.1.1, sheet `Summary_Communication`) that a
// verified CarbonLEI proof can fill, as a CSV for the declarant's records: `carbonlei export-communication`.
// One row per template field, in the sheet's order, with the value, the signed field or check it comes from, and
// whether the value is from the verified proof, was hidden by the supplier, or is not held by CarbonLEI.
// Mapping: docs/REGISTRY_EXPORT.md §4. Nothing is exported unless the verification is VALID with check 5 bound
// to the importer's EORI. Not validated by the Commission, and not a CBAM Registry submission.
// Browser-safe (no Node APIs) and dependency-free: no spreadsheet library.
import { CLAIM_ORDER, splitReportingPeriod, type ClaimName } from "./credential.ts";
import { csvField } from "./portfolio.ts";
import type { Verdict } from "./verdict.ts";

/** The template this export follows (docs/REGISTRY_EXPORT.md R4). The workbook is not part of this module. */
export const COMMUNICATION_TEMPLATE = {
  name: "CBAM Communication template for installations",
  version: "2.1.1",
  date: "2024-12-13",
  sheet: "Summary_Communication",
  page: "https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-communication-and-news_en",
  sha256: "5a4e28fdbccfdca45a2c0520184b551a20c0c7bba3db79f87d78c9e58a6c0917",
} as const;

export const NOT_VALIDATED =
  "not validated by the Commission; a copy for the declarant's records, not a Registry submission";

export type CommunicationStatus = "from verified proof" | "hidden by supplier" | "not held";

export interface CommunicationRow {
  /** Section heading of the sheet the field sits under. */
  section: string;
  /** Cell of the field's label on `Summary_Communication` (product fields: header row 25; the value goes in row 26). */
  cell: string;
  /** The label exactly as the template writes it (cached cell text of v2.1.1). */
  field: string;
  value: string;
  /** Which signed field or check produced the value, or why there is none. */
  source: string;
  status: CommunicationStatus;
}

/** Labels of `Summary_Communication` v2.1.1 in sheet order, with their cells (read from the published workbook). */
export const SUMMARY_COMMUNICATION_FIELDS: readonly { section: string; cell: string; field: string }[] = [
  ...(
    [
      ["D12", "Name of the installation (English name):"],
      ["D13", "Street, Number:"],
      ["D14", "Economic activity:"],
      ["D15", "Country:"],
      ["D16", "Country:"],
      ["D17", "UNLOCODE:"],
      ["D18", "Coordinates of the main emission source (latitude):"],
      ["D19", "Coordinates of the main emission source (longitude):"],
      ["D20", "Reporting period start:"],
      ["D21", "Reporting period end:"],
    ] as const
  ).map(([cell, field]) => ({ section: "Installation details", cell, field })),
  ...(
    [
      ["I11", "Aggregated good produced"],
      ["J11", "Route 1"],
      ["K11", "Route 2"],
      ["L11", "Route 3"],
      ["M11", "Route 4"],
      ["N11", "Route 5"],
      ["O11", "Route 6"],
      ["R11", "Production process"],
      ["S11", "Aggregated goods category"],
    ] as const
  ).map(([cell, field]) => ({ section: "Summary of the production processes and production routes, where relevant", cell, field })),
  ...(
    [
      ["AA11", "Calculation - based (excl. PFC emissions)"],
      ["AC11", "Total PFC emissions"],
      ["AE11", "Measurement - based"],
      ["AG11", "Other"],
      ["AA15", "Total direct emissions during reporting period:"],
      ["AA16", "Total indirect emissions during reporting period:"],
      ["AA17", "Total emissions during reporting period:"],
      ["AA19", "General information on data quality:"],
      ["AA20", "Justification for use of default values (if relevant):"],
      ["AA21", "Information on quality assurance:"],
    ] as const
  ).map(([cell, field]) => ({ section: "Summary of emissions by monitoring methodology and data quality", cell, field })),
  ...(
    [
      ["AL12", "Carbon price instrument:"],
      ["AL13", "Any additional information:"],
    ] as const
  ).map(([cell, field]) => ({ section: "Further information", cell, field })),
  ...(
    [
      ["D25", "Production process from which the products arise"],
      ["E25", "Type of aggregated good or precursor"],
      ["F25", "CN Codes"],
      ["G25", "CN Name"],
      ["H25", "Product name \n(used for communication with reporting declarant, e.g. on invoices)"],
      ["I25", "SEE (direct)"],
      ["J25", "SEE (indirect)"],
      ["K25", "SEE (total)"],
      ["L25", "Unit"],
      ["M25", "Share of emissions by default value"],
      ["N25", "Source for electricity EF"],
      ["O25", "Embedded electricity (MWh/t)"],
      ["P25", "Electricity EF (tCO2/MWh)"],
      ["Q25", "The main reducing agent of the precursor, if known"],
      ["R25", "Steel mill identification number"],
      ["S25", "% Mn"],
      ["T25", "% Cr"],
      ["U25", "% Ni"],
      ["V25", "% other alloys"],
      ["W25", "% carbon"],
      ["X25", "t scrap per t steel"],
      ["Y25", "% other materials"],
      ["Z25", "% pre-consumer scrap"],
      ["AA25", "t scrap per t aluminium"],
      ["AB25", "% non-aluminium elements"],
      ["AC25", "Clinker factor"],
      ["AD25", "Calcined or not"],
      ["AE25", "Concentration, if hydrous solution"],
      ["AF25", "% nitric acid"],
      ["AG25", "% urea"],
      ["AH25", "% N contained"],
      ["AI25", "% N as ammonium (NH4+)"],
      ["AJ25", "% N as nitrate (NO3–)"],
      ["AK25", "% N as Urea"],
      ["AL25", "% N in other (organic) forms"],
      ["AM25", "Type of instrument (carbon pricing)"],
      ["AN25", "Share of total embedded emissions covered by the carbon price"],
      ["AO25", "Embedded emissions covered by the carbon price"],
      ["AQ25", "Currency"],
      ["AR25", "Carbon price (CP) due (per produced t or MWh)"],
      ["AT25", "Type of rebate"],
      ["AU25", "Share of embedded emissions covered by the rebate"],
      ["AV25", "Embedded emissions covered by rebate"],
      ["AX25", "Amount of rebate (per produced t or MWh)"],
      ["AZ25", "Result: Effective CP due (per produced t or MWh)"],
    ] as const
  ).map(([cell, field]) => ({ section: "Summary of products", cell, field })),
];

const SIGNED = new Set<string>(CLAIM_ORDER);

/**
 * Refuses a verdict that is not VALID with check 5 bound to an EORI: only a value the verification accepted for
 * this importer is copied into the template's fields.
 */
export function assertExportable(v: Verdict): void {
  if (v.overall !== "VALID") {
    throw new Error(`the proof did not verify (${v.overall}${v.primaryCode ? `, ${v.primaryCode}` : ""}); nothing exported`);
  }
  const c5 = v.checks.find((c) => c.id === 5);
  if (c5?.status !== "pass") {
    throw new Error(`check 5 did not bind the shipment to your EORI (${c5?.status ?? "missing"}); nothing exported`);
  }
  if (v.chain.block === null) throw new Error("the verification read no pinned block; nothing exported");
}

/** The rows of the export, one per `Summary_Communication` field, in the template's order. */
export function communicationRows(v: Verdict): CommunicationRow[] {
  assertExportable(v);
  const d = v.disclosed;
  /** A signed claim: its disclosed value, or "hidden by supplier" when the supplier withheld it. */
  const claim = (name: ClaimName, transform: (s: string) => string = (s) => s, how = "") => {
    if (!SIGNED.has(name)) throw new Error(`not a credential field: ${name}`);
    const source = `signed field ${name}${how ? `, ${how}` : ""} (verified: check 2)`;
    return d[name] === undefined
      ? { value: "", source: `signed field ${name}, not disclosed in this proof`, status: "hidden by supplier" as const }
      : { value: transform(d[name]), source, status: "from verified proof" as const };
  };
  const notHeld = (why = "CarbonLEI's credential has no such field; the operator supplies it") => ({ value: "", source: why, status: "not held" as const });

  const period = d.reportingPeriod === undefined ? undefined : splitReportingPeriod(d.reportingPeriod);
  const cp = v.carbonPrice;
  const c10 = v.checks.find((c) => c.id === 10);
  const cpGood = cp && c10?.status === "pass" && cp.target?.kind === "good";
  const cpNote = !cp
    ? "the proof carries no carbon price statement (check 10 not run)"
    : c10?.status !== "pass"
      ? `check 10 did not pass (${c10?.status ?? "missing"})`
      : "the certified carbon price is for a precursor, not this good";
  const price = (key: "mechanism" | "currency" | "localPerTonne" | "coveredEmissionsPerTonne" | "paidShare", how = "") =>
    cpGood && cp[key] !== null
      ? { value: cp[key] as string, source: `check 10 carbonPrice.${key}${how} — ${cp.draft}`, status: "from verified proof" as const }
      : notHeld(`not held: ${cpNote}`);
  const withPrecursors = v.precursors?.signed && v.checks.find((c) => c.id === 9)?.status !== "fail";

  const fill: Record<string, Omit<CommunicationRow, "section" | "cell" | "field">> = {
    D12: claim("installationName"),
    D15: notHeld("not held: the template labels this row \"Country:\" but its formula reads the city (A_InstData!I25)"),
    D16: claim("unLocode", (s) => s.slice(0, 2), "first two letters (the UN/LOCODE country code, ISO 3166-1 alpha-2, as in the template's country code list)"),
    D17: claim("unLocode"),
    D20: period ? { ...claim("reportingPeriod"), value: period.start, source: "signed field reportingPeriod, start date (verified: check 2)" } : claim("reportingPeriod"),
    D21: period ? { ...claim("reportingPeriod"), value: period.end, source: "signed field reportingPeriod, end date (verified: check 2)" } : claim("reportingPeriod"),
    J11: notHeld("not held: signed field cbamRoute is a column letter of the default-value table of IR (EU) 2026/1740, not a template route; no conversion is defined (REGISTRY_EXPORT §4.2)"),
    AL12: notHeld("not held: the installation-level instrument; a certified statement for this good fills \"Type of instrument (carbon pricing)\" below"),
    F25: claim(
      "cnCode",
      (s) => s,
      d.cnCode !== undefined && d.cnCode.length < 8
        ? `${d.cnCode.length}-digit heading; the template's list (Parameters_CNCodes) holds 8-digit CN codes, so the operator picks the 8-digit code`
        : "",
    ),
    I25: claim(
      "specificEmbeddedEmissions_tCO2e_per_t",
      (s) => s,
      `direct embedded emissions${withPrecursors ? ", including the precursors' embedded direct emissions checked by check 9" : ""}`,
    ),
    L25:
      d.specificEmbeddedEmissions_tCO2e_per_t === undefined
        ? { value: "", source: "unit of signed field specificEmbeddedEmissions_tCO2e_per_t, which is not disclosed in this proof", status: "hidden by supplier" }
        : { value: "tCO2e/t", source: "unit of signed field specificEmbeddedEmissions_tCO2e_per_t (template unit string)", status: "from verified proof" },
    M25: notHeld("not held: the operator's share of default values in its own calculation; CarbonLEI's default line is an importer-side decision (REGISTRY_EXPORT §4.2)"),
    AM25: price("mechanism"),
    AN25: price("paidShare", " (a fraction: 1 = 100 %)"),
    AO25: price("coveredEmissionsPerTonne", " (tCO2e per t of good)"),
    AQ25: price("currency", " (ISO 4217 code; the template shows the currency name)"),
    AR25: price("localPerTonne", " (per t of good, in that currency)"),
  };
  return SUMMARY_COMMUNICATION_FIELDS.map((f) => ({ ...f, ...(fill[f.cell] ?? notHeld()) }));
}

export const COMMUNICATION_COLUMNS = ["template field", "value", "source", "status", "template cell"] as const;

/**
 * The export as CSV text (RFC 4180, CRLF line ends): header lines, the column row, one row per field.
 * `proofSha256` is the SHA-256 of the proof file exactly as verified.
 */
export function communicationCsv(v: Verdict, proofSha256: string): string {
  const rows = communicationRows(v);
  const held = rows.filter((r) => r.status === "from verified proof").length;
  const hidden = rows.filter((r) => r.status === "hidden by supplier").length;
  const out: string[][] = [
    [`# ${COMMUNICATION_TEMPLATE.name} v${COMMUNICATION_TEMPLATE.version} (${COMMUNICATION_TEMPLATE.date}), sheet ${COMMUNICATION_TEMPLATE.sheet}; workbook SHA-256 ${COMMUNICATION_TEMPLATE.sha256}; ${COMMUNICATION_TEMPLATE.page}`],
    [`# ${NOT_VALIDATED}`],
    [`# proof SHA-256 ${proofSha256}; credential ${v.credSAID ?? ""}; verified ${v.overall} at pinned block ${v.chain.block} (chain ${v.chain.chainId ?? ""})`],
    [`# ${rows.length} fields: ${held} from the verified proof, ${hidden} hidden by the supplier, ${rows.length - held - hidden} not held (blank)`],
    [...COMMUNICATION_COLUMNS],
    ...rows.map((r) => [r.field, r.value, r.source, r.status, `${COMMUNICATION_TEMPLATE.sheet}!${r.cell}`]),
  ];
  return out.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
