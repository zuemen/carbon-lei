// ERP integration example: an ERP's CBAM import lines (CSV) → `carbonlei serve` REST API → a CSV the ERP can import back.
//
//   1. read the ERP export (one row per purchase-order line: PO, CN code, origin, supplier, net mass, import date,
//      proof file reference) and check every row;
//   2. map the rows to the body of POST /v1/verify-batch (the proof files are read from one folder, nothing outside it);
//   3. call the API (started in this process on 127.0.0.1, or an existing server behind the importer's gateway);
//   4. check the HMAC binding of the verify-batch results with the key shared with the server (CARBONLEI_API_HMAC_KEY),
//      and that they are for this run: the importer's EORI, the run's fresh nonce, verified within maxResultAgeSec;
//   5. POST /v1/portfolio with the results unchanged, so the server plans only verdicts it computed itself; check the
//      plan's own binding, nonce and results binding, and every plan line against the bound results;
//   6. write one CSV row per ERP line: verdict, verified or default value, reason code, certificates estimate.
//
// The write-back is a planning aid. It is NOT a CBAM Registry filing, not the Registry XML and not a CBAM declaration.
// No SAP, Oracle or other ERP connector is included: the ERP side is a CSV file in a generic shape (README.md).
// Run: node examples/erp-integration/erp-sync.ts --help
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { BatchDocument, BatchResult } from "../../sdk/batch.ts";
import { ChainReader, rpcUrlsFrom, SEPOLIA_CHAIN, type Deployment } from "../../sdk/chain.ts";
import { annexDefault, CN_CODE, csvField, fmtDec, notSubjectToCbam, parseCsv, parseDec, roundHalfUp, type PortfolioSummary, type ShipmentLine } from "../../sdk/portfolio.ts";
import { canonicalJson, createApiServer, DEFAULTS as SERVE_DEFAULTS, type ServeOptions } from "../../sdk/server.ts";

/** Columns the ERP export must have (any order; other columns are ignored). */
export const ERP_COLUMNS = ["po_number", "po_line", "cn_code", "country_of_origin", "supplier_name", "quantity_tonnes", "import_date", "proof_file"] as const;

/** Columns of the write-back CSV, after a title row. */
export const WRITEBACK_COLUMNS = [
  "po_number",
  "po_line",
  "line_id",
  "cn_code",
  "country_of_origin",
  "quantity_tonnes",
  "import_date",
  "verdict",
  "primary_code",
  "value_used",
  "see_used_tco2e_per_t",
  "reason_code",
  "reason",
  "embedded_tco2e",
  "certificates_estimate_tco2e",
  "verification_report_id",
  "credential_said",
  "pinned_block",
] as const;

/**
 * Reason codes in the write-back (stable, for ERP rules). VERIFIED is the only code on the verified value; every other
 * planned line is on the default value with the year's mark-up; ERP_ROW_INVALID and EXCLUDED lines are not planned.
 */
export const REASON_CODES = {
  VERIFIED: "VALID proof bound to the importer's EORI (check 5): the verified value is used",
  NO_PROOF: "no supplier proof referenced in the ERP line",
  PROOF_FILE_MISSING: "the referenced proof file is not in the proof folder",
  PROOF_FILE_UNREADABLE: "the referenced file is not a CarbonLEI proof (JSON with core and signature)",
  PROOF_INVALID: "the proof is INVALID (see primary_code)",
  PROOF_CONTESTED: "the proof is CONTESTED (see primary_code)",
  PROOF_INCOMPLETE: "the proof is INCOMPLETE: a check could not be completed",
  VERIFY_ERROR: "the verification could not run (RPC or evidence error)",
  NOT_BOUND_TO_IMPORTER: "check 5 did not bind the shipment to the importer's EORI",
  CN_MISMATCH: "the credential covers another CN code",
  ORIGIN_MISMATCH: "the installation is in another country than the ERP line says",
  QUANTITY_EXCEEDS_CLAIM: "more tonnes declared than claimed on the ledger for this batch",
  RECHECK_ACTION: "a later re-check found the accepted value needs action",
  NOT_ELIGIBLE: "VALID, but the verified value cannot be used (see reason)",
  EXCLUDED: "left out of the plan (another year, or the line could not be planned)",
  ERP_ROW_INVALID: "the ERP row failed validation and was not sent",
} as const;
export type ReasonCode = keyof typeof REASON_CODES;

export interface ErpRow {
  /** 1-based line number in the CSV file (the header is line 1). */
  rowNumber: number;
  poNumber: string;
  poLine: string;
  cnCode: string;
  country: string;
  supplier: string;
  quantityTonnes: string;
  importDate: string;
  proofFile: string;
}

/** One ERP row after mapping: sent to the API (with its proof or none), or rejected before any call. */
export interface MappedLine {
  row: ErpRow;
  /** The line id sent to the API and shown in the plan: `<po_number>/<po_line>`. */
  id: string;
  sent: boolean;
  /** Set when the mapping already decided the reason (rejected row, missing or unreadable proof file). */
  code?: ReasonCode;
  detail?: string;
}

export interface BatchRequest {
  eori: string;
  shipments: { id: string; proof: unknown; quantityTonnes: string; cnCode: string; country: string; importDate: string; supplier: string; note?: string }[];
}

// The RFC 4180 reader lives in sdk/portfolio.ts (also used by `carbonlei request`); re-exported for this example's callers.
export { parseCsv };

/** The ERP export's rows, by column name. Throws when a required column is missing. */
export function readErpCsv(text: string): ErpRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error("the ERP export is empty");
  const names = header.map((h) => h.trim().toLowerCase());
  const missing = ERP_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length) throw new Error(`the ERP export lacks column(s) ${missing.join(", ")} (README: field mapping)`);
  const at = (r: string[], c: (typeof ERP_COLUMNS)[number]) => (r[names.indexOf(c)] ?? "").trim();
  return body.map((r, i) => ({
    rowNumber: i + 2,
    poNumber: at(r, "po_number"),
    poLine: at(r, "po_line"),
    cnCode: at(r, "cn_code").replace(/\s+/g, ""),
    country: at(r, "country_of_origin").toUpperCase(),
    supplier: at(r, "supplier_name"),
    quantityTonnes: at(r, "quantity_tonnes"),
    importDate: at(r, "import_date"),
    proofFile: at(r, "proof_file"),
  }));
}

/**
 * Why a row cannot be sent, or null. Net mass up to 3 decimals (kg), CN code of 4, 6 or 8 digits or a 10-digit TARIC
 * code, ISO country subject to CBAM ("UK" is read as GB), and a default value the plan can resolve for that origin and
 * code (Annex I of IR 2026/1740): one line the plan cannot resolve would make the whole POST /v1/portfolio fail (422),
 * so it is caught here and written back with ERP_ROW_INVALID instead.
 */
export function rowProblem(r: ErpRow): string | null {
  if (!r.poNumber || !r.poLine) return "po_number and po_line are required";
  if (!CN_CODE.test(r.cnCode)) return `cn_code "${r.cnCode}" is not 4, 6 or 8 digits or a 10-digit TARIC code`;
  if (!/^[A-Z]{2}$/.test(r.country)) return `country_of_origin "${r.country}" is not an ISO 3166 alpha-2 code`;
  const exempt = notSubjectToCbam(r.country);
  if (exempt) return `country_of_origin "${r.country}": ${exempt}`;
  const dv = annexDefault(r.country, r.cnCode);
  if (dv.value === undefined) return `cn_code "${r.cnCode}" from ${r.country}: ${dv.reason}`;
  if (!/^\d+(\.\d{1,3})?$/.test(r.quantityTonnes) || Number(r.quantityTonnes) <= 0) {
    return `quantity_tonnes "${r.quantityTonnes}" is not a positive number of tonnes with at most 3 decimals`;
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.importDate);
  const date = d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])) : null;
  if (!d || !date || date.getUTCMonth() !== +d[2] - 1 || date.getUTCDate() !== +d[3]) return `import_date "${r.importDate}" is not a date YYYY-MM-DD`;
  return null;
}

const isProof = (x: unknown): boolean =>
  !!x && typeof x === "object" && typeof (x as { core?: unknown }).core === "string" && "signature" in (x as object);

/**
 * Maps the ERP rows to a /v1/verify-batch body. A row that fails validation is not sent. A proof file is read only
 * from `proofDir` (after resolving symbolic links; an absolute path or one outside the folder rejects the row); a
 * missing or unreadable file sends the line without a proof, so it is planned on the default value with that reason.
 */
export function mapErpRows(rows: ErpRow[], opts: { proofDir: string; eori: string; maxProofBytes?: number }): { request: BatchRequest; lines: MappedLine[] } {
  const root = realpathSync(resolve(opts.proofDir));
  const maxBytes = opts.maxProofBytes ?? SERVE_DEFAULTS.maxBodyBytes;
  const seen = new Set<string>();
  const lines: MappedLine[] = [];
  const shipments: BatchRequest["shipments"] = [];
  for (const row of rows) {
    const id = `${row.poNumber}/${row.poLine}`;
    let problem = rowProblem(row);
    if (!problem && seen.has(id)) problem = `PO line ${id} appears twice`;
    seen.add(id);
    let proof: unknown = null;
    let code: ReasonCode | undefined;
    let detail: string | undefined;
    if (!problem && row.proofFile) {
      if (isAbsolute(row.proofFile) || row.proofFile.includes("\0")) problem = "proof_file must be a file name relative to the proof folder";
      else {
        let full: string | null = null;
        try {
          full = realpathSync(resolve(root, row.proofFile));
        } catch {
          (code = "PROOF_FILE_MISSING"), (detail = `${row.proofFile} not found in the proof folder`);
        }
        if (full !== null && full !== root && !full.startsWith(root + sep)) problem = "proof_file points outside the proof folder";
        else if (full !== null) {
          try {
            if (statSync(full).size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
            const x = JSON.parse(readFileSync(full, "utf8"));
            if (!isProof(x)) throw new Error("not a proof (no core and signature)");
            proof = x;
          } catch (e) {
            (code = "PROOF_FILE_UNREADABLE"), (detail = `${row.proofFile}: ${(e as Error).message}`);
          }
        }
      }
    }
    if (problem) {
      lines.push({ row, id, sent: false, code: "ERP_ROW_INVALID", detail: `CSV line ${row.rowNumber}: ${problem}` });
      continue;
    }
    lines.push({ row, id, sent: true, ...(code ? { code, detail } : {}) });
    shipments.push({
      id,
      proof,
      quantityTonnes: row.quantityTonnes,
      cnCode: row.cnCode,
      country: row.country,
      importDate: row.importDate,
      supplier: row.supplier,
      ...(detail ? { note: detail } : {}),
    });
  }
  return { request: { eori: opts.eori, shipments }, lines };
}

/** Whether `doc.binding` is the HMAC-SHA256 the server computes (sdk/server.ts) with `key`, over the rest of `doc`. */
export function bindingValid(doc: unknown, key: string | Uint8Array): boolean {
  const b = (doc as { binding?: { alg?: unknown; mac?: unknown } })?.binding;
  if (!b || b.alg !== "HMAC-SHA256" || typeof b.mac !== "string" || !/^[0-9a-f]{64}$/.test(b.mac)) return false;
  const { binding: _drop, ...rest } = doc as Record<string, unknown>;
  const mac = createHmac("sha256", typeof key === "string" ? Buffer.from(key, "utf8") : key).update(canonicalJson(rest)).digest();
  return timingSafeEqual(Buffer.from(b.mac, "hex"), mac);
}

/** Default for `SyncOptions.maxResultAgeSec`: bound results older than this (by their `verifiedAt`) are refused. */
export const DEFAULT_MAX_RESULT_AGE_SEC = 600;

/**
 * Bound verify-batch results are for this run: verified for the EORI we asked about (check 5 was run for us, not for
 * another importer), carrying the nonce we sent, and verified at most `maxAgeSec` ago by the server's clock
 * (`verifiedAt`, inside the binding). The pinned block's own age is checked by the server when it verifies (head-age
 * limit, `maxHeadAgeSec`); the nonce makes sure that answer was given to this request.
 */
export function checkResultsFresh(results: BatchDocument, want: { eori: string; nonce: string; maxAgeSec: number; now?: number }): void {
  if (results.eori !== want.eori) throw new Error(`the verify-batch results are for EORI ${results.eori ?? "(none)"}, not for the EORI of this run: not used`);
  if (results.nonce !== want.nonce) throw new Error("the verify-batch results were not made for this request (their nonce differs): a replayed response");
  // `new Date()`, not Date.now(): the same clock the server stamps `verifiedAt` with.
  const age = ((want.now ?? new Date().getTime()) - Date.parse(results.verifiedAt)) / 1000;
  if (!Number.isFinite(age) || age > want.maxAgeSec || age < -want.maxAgeSec) {
    throw new Error(`the verify-batch results were verified at ${results.verifiedAt}, not within the last ${want.maxAgeSec} s`);
  }
}

/**
 * Checks every plan line against the bound verify-batch results it must come from (defence in depth behind the plan's
 * binding, third review H1): the plan has exactly the lines sent (planned or excluded), each with the verdict the
 * results give it, and a line on the verified value only when that line's verdict is VALID with check 5 passed, at the
 * disclosed intensity, for the quantity sent. Throws on the first difference.
 */
export function crossCheckPlan(plan: PortfolioSummary, results: BatchDocument, request: BatchRequest): void {
  const byId = new Map(results.results.map((r) => [r.line.id, r]));
  const sent = new Map(request.shipments.map((s) => [s.id, s]));
  const seen = new Set<string>();
  for (const id of [...plan.shipments.map((s) => s.id), ...plan.excluded.map((x) => x.id)]) {
    if (!sent.has(id)) throw new Error(`the plan has a line ${id} that was not sent`);
    if (seen.has(id)) throw new Error(`the plan lists line ${id} twice`);
    seen.add(id);
  }
  for (const id of sent.keys()) if (!seen.has(id)) throw new Error(`the plan does not list line ${id}`);
  for (const s of plan.shipments) {
    const r = byId.get(s.id)!;
    const verdict = r.error ? "ERROR" : r.verdict ? r.verdict.overall : "NONE";
    if (s.verdict !== verdict) throw new Error(`plan line ${s.id}: verdict ${s.verdict}, but the bound results say ${verdict}`);
    if (parseDec(s.quantityTonnes, 3) !== parseDec(sent.get(s.id)!.quantityTonnes, 3)) throw new Error(`plan line ${s.id}: ${s.quantityTonnes} t, but ${sent.get(s.id)!.quantityTonnes} t were sent`);
    if (s.basis === "actual") {
      const v = r.verdict;
      const see = v?.disclosed?.specificEmbeddedEmissions_tCO2e_per_t;
      if (!v || v.overall !== "VALID" || v.checks.find((c) => c.id === 5)?.status !== "pass" || see === undefined) {
        throw new Error(`plan line ${s.id} is on the verified value, but its bound verdict is not VALID with check 5 passed`);
      }
      if (s.seeUsed !== see || s.seeVerified !== see) throw new Error(`plan line ${s.id}: verified value ${s.seeUsed}, but the bound verdict discloses ${see}`);
      const embedded = fmtDec(roundHalfUp(parseDec(s.quantityTonnes, 3) * parseDec(see, 6), 6), 3);
      if (s.embeddedT !== embedded) throw new Error(`plan line ${s.id}: ${s.embeddedT} tCO2e, but ${s.quantityTonnes} t × ${see} = ${embedded}`);
    } else if (s.basis !== "default" || s.seeUsed !== s.defaultMarkedUp) {
      throw new Error(`plan line ${s.id}: not on the verified value, but its intensity is not the marked-up default`);
    }
  }
}

/** The reason code of a planned line (ShipmentLine of the portfolio), given what the mapping already knew. */
export function reasonCodeOf(l: ShipmentLine, mapped?: MappedLine): ReasonCode {
  if (l.basis === "actual") return "VERIFIED";
  if (mapped?.code) return mapped.code;
  switch (l.verdict) {
    case "NONE":
      return "NO_PROOF";
    case "ERROR":
      return "VERIFY_ERROR";
    case "INVALID":
      return "PROOF_INVALID";
    case "CONTESTED":
      return "PROOF_CONTESTED";
    case "INCOMPLETE":
      return "PROOF_INCOMPLETE";
  }
  const r = l.reason;
  if (r.startsWith("re-checked after acceptance")) return "RECHECK_ACTION";
  if (r.includes("check 5")) return "NOT_BOUND_TO_IMPORTER";
  if (r.includes("the credential covers CN")) return "CN_MISMATCH";
  if (r.includes("the installation is in")) return "ORIGIN_MISMATCH";
  if (r.includes("claimed on the ledger")) return "QUANTITY_EXCEEDS_CLAIM";
  return "NOT_ELIGIBLE";
}

export interface WritebackRow {
  line: MappedLine;
  planned: ShipmentLine | null;
  code: ReasonCode;
  reason: string;
}

/** One write-back row per ERP row, in the ERP's order. */
export function writebackRows(lines: MappedLine[], plan: PortfolioSummary): WritebackRow[] {
  const byId = new Map(plan.shipments.map((s) => [s.id, s]));
  const excluded = new Map(plan.excluded.map((x) => [x.id, x.reason]));
  return lines.map((line) => {
    const planned = byId.get(line.id) ?? null;
    if (planned) {
      const code = reasonCodeOf(planned, line);
      const reason = code === "VERIFIED" ? REASON_CODES.VERIFIED : line.code && line.detail ? `${planned.reason}: ${line.detail}` : planned.reason;
      return { line, planned, code, reason };
    }
    if (!line.sent) return { line, planned: null, code: "ERP_ROW_INVALID", reason: line.detail ?? REASON_CODES.ERP_ROW_INVALID };
    return { line, planned: null, code: "EXCLUDED", reason: excluded.get(line.id) ?? "not in the plan returned by the API" };
  });
}

/** The write-back CSV: a title row saying what it is not, the header, one row per ERP row, a total row (CRLF). */
export function writebackCsv(rows: WritebackRow[], plan: PortfolioSummary, results: BatchDocument): string {
  const out: string[][] = [
    [
      `# CarbonLEI ERP write-back ${plan.year}: NOT a CBAM Registry filing / not the Registry XML / not a CBAM declaration. ` +
        `A planning aid for review. certificates_estimate_tco2e is the line's gross obligation in tCO2e (1 certificate = 1 tCO2e: whole certificates only on the total). ` +
        `Verified at block ${results.pinnedBlock ?? "-"} (chain ${results.chainId ?? "-"}). The verify-batch results and the plan were bound by the API's HMAC with this run's nonce and EORI and checked. ` +
        `Every line on the verified value was checked against its VALID verdict (check 5 passed).`,
    ],
    [...WRITEBACK_COLUMNS],
  ];
  for (const { line, planned: p, code, reason } of rows) {
    out.push([
      line.row.poNumber,
      line.row.poLine,
      line.id,
      line.row.cnCode,
      line.row.country,
      line.row.quantityTonnes,
      line.row.importDate,
      p ? p.verdict : "",
      p ? p.primaryCode : "",
      p ? (p.basis === "actual" ? "verified" : "default") : "",
      p ? p.seeUsed : "",
      code,
      reason,
      p ? p.embeddedT : "",
      p ? p.obligationT : "",
      p ? p.verificationReportId : "",
      p ? p.credSAID : "",
      p && p.pinnedBlock !== null ? String(p.pinnedBlock) : "",
    ]);
  }
  const t = plan.totals;
  out.push(["TOTAL", "", "", "", "", t.quantityTonnes, "", "", "", `${t.onActual} verified / ${t.onDefault} default`, "", "", `${t.certificates} whole certificates (gross)`, t.embeddedT, t.obligationT]);
  return out.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export interface SyncOptions {
  /** The ERP export (CSV text). */
  csvText: string;
  /** Folder the ERP's proof file references are resolved in. */
  proofDir: string;
  /** Importer EORI for check 5. */
  eori: string;
  /** Declaration year planned. */
  year: number;
  /** EUR per certificate, optional (the plan then has gross EUR totals). */
  priceEur?: string;
  /** Key shared with the API server (CARBONLEI_API_HMAC_KEY), at least 32 bytes. */
  hmacKey: string | Uint8Array;
  /** An API server already running (behind the importer's gateway); `headers` are sent to the gateway. */
  api?: { baseUrl: string; headers?: Record<string, string> };
  /** Otherwise: a server started in this process on 127.0.0.1 with these options (the HMAC key is `hmacKey`). */
  serve?: Omit<ServeOptions, "hmacKey">;
  /** Oldest bound results accepted, seconds since their `verifiedAt` (default `DEFAULT_MAX_RESULT_AGE_SEC`, 600). */
  maxResultAgeSec?: number;
}

export interface SyncResult {
  csv: string;
  rows: WritebackRow[];
  lines: MappedLine[];
  results: BatchDocument;
  plan: PortfolioSummary;
}

async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${path}: HTTP ${r.status}, not JSON: ${text.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}: ${typeof j.error === "string" ? j.error : text.slice(0, 200)}`);
  return j;
}

/** The whole flow: map, verify-batch, check the binding, portfolio, write-back CSV. */
export async function runErpSync(o: SyncOptions): Promise<SyncResult> {
  if (!o.api && !o.serve) throw new Error("give either api (a running server) or serve (start one in this process)");
  const key = typeof o.hmacKey === "string" ? Buffer.from(o.hmacKey, "utf8") : o.hmacKey;
  if (key.length < 32) throw new Error("the HMAC key shared with the API (CARBONLEI_API_HMAC_KEY) must be at least 32 bytes");
  const { request, lines } = mapErpRows(readErpCsv(o.csvText), { proofDir: o.proofDir, eori: o.eori });
  if (!request.shipments.length) throw new Error("no ERP row could be sent (all failed validation)");
  if (request.shipments.length > SERVE_DEFAULTS.maxBatch) {
    throw new Error(`${request.shipments.length} lines: the API takes at most ${SERVE_DEFAULTS.maxBatch} per verify-batch request (one pinned block, one plan); split the export`);
  }
  let server: ReturnType<typeof createApiServer> | undefined;
  let base = o.api?.baseUrl.replace(/\/+$/, "") ?? "";
  try {
    if (!o.api) {
      server = createApiServer({ ...o.serve!, hmacKey: key });
      await new Promise<void>((ok, fail) => server!.once("error", fail).listen(0, "127.0.0.1", () => ok()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    const headers = o.api?.headers ?? {};
    // A fresh nonce per run, sent with both requests: the server copies it inside each bound response, so a response
    // recorded earlier (for this importer or another) cannot be replayed to this run (third review, M1).
    const nonce = randomBytes(16).toString("hex");
    const results = (await postJson(base, "/v1/verify-batch", { ...request, nonce }, headers)) as unknown as BatchDocument;
    if (results.kind !== "carbonlei-batch" || !Array.isArray(results.results)) throw new Error("/v1/verify-batch did not return a results document");
    // The results must come from the server that holds our key, unchanged: anything else is not used.
    if (!bindingValid(results, key)) throw new Error("the verify-batch results do not carry a valid HMAC binding for our key: not from the expected server, or altered on the way");
    checkResultsFresh(results, { eori: o.eori, nonce, maxAgeSec: o.maxResultAgeSec ?? DEFAULT_MAX_RESULT_AGE_SEC });
    const sentIds = request.shipments.map((s) => s.id);
    const gotIds = results.results.map((r: BatchResult) => r.line.id);
    if (sentIds.join("\n") !== gotIds.join("\n")) throw new Error("the verify-batch results do not list the lines that were sent, in order");
    const plan = (await postJson(base, "/v1/portfolio", { results, year: o.year, nonce, ...(o.priceEur ? { priceEur: o.priceEur } : {}) }, headers)) as unknown as PortfolioSummary;
    if (plan.kind !== "carbonlei-portfolio") throw new Error("/v1/portfolio did not return a plan");
    // The plan is bound as well (H1): unchanged, made by the server that holds our key, for this request, from these results.
    if (!bindingValid(plan, key)) throw new Error("the plan does not carry a valid HMAC binding for our key: not from the expected server, or altered on the way");
    if (plan.nonce !== nonce) throw new Error("the plan was not made for this request (its nonce differs): a replayed response");
    if (plan.resultsBinding !== results.binding?.mac) throw new Error("the plan was not computed from the verify-batch results of this run");
    if (!plan.verdictSource?.startsWith("verified by this server")) throw new Error(`the plan was not computed from bound verdicts: ${plan.verdictSource ?? "no verdictSource"}`);
    crossCheckPlan(plan, results, request);
    const rows = writebackRows(lines, plan);
    return { csv: writebackCsv(rows, plan, results), rows, lines, results, plan };
  } finally {
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  }
}

const HELP = `node examples/erp-integration/erp-sync.ts [options]

  --csv <file>          ERP export (default: examples/erp-integration/erp-export.csv)
  --proof-dir <dir>     folder the proof_file column refers to (default: fixtures/)
  --eori <EORI>         importer EORI for check 5 (required)
  --year <yyyy>         declaration year (default 2026)
  --price <EUR>         EUR per certificate, for gross EUR totals (optional)
  --out <file>          write-back CSV (default: stdout)
  --api <url>           use a running carbonlei serve (behind your gateway) instead of starting one here;
                        CARBONLEI_API_GATEWAY_TOKEN, when set, is sent as "Authorization: Bearer" to the gateway
  --evidence-dir <dir>  evidence bundles for the in-process server (default: fixtures/)
  --rpc <url>           RPC node(s) for the in-process server (else CARBONLEI_RPC_URL, else the default list)

CARBONLEI_API_HMAC_KEY (>= 32 bytes) is the key shared with the server; with --api it is required, otherwise a
random key is made for this run. The output is NOT a CBAM Registry filing (README.md).`;

async function main(argv: string[]): Promise<number> {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  const { values } = parseArgs({
    args: argv,
    options: {
      csv: { type: "string" },
      "proof-dir": { type: "string" },
      eori: { type: "string" },
      year: { type: "string" },
      price: { type: "string" },
      out: { type: "string" },
      api: { type: "string" },
      "evidence-dir": { type: "string" },
      rpc: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP), 0;
  if (!values.eori) throw new Error("--eori is required (the importer the shipments were declared to)");
  const year = Number(values.year ?? 2026);
  const envKey = process.env.CARBONLEI_API_HMAC_KEY;
  if (values.api && !envKey) throw new Error("--api needs CARBONLEI_API_HMAC_KEY, the key the server binds its results with");
  const hmacKey = envKey ? envKey : randomBytes(32);
  let serve: SyncOptions["serve"];
  if (!values.api) {
    const deployment = JSON.parse(readFileSync(here("../../contracts/deployments/11155111.json"), "utf8")) as Deployment;
    const { urls } = rpcUrlsFrom(values.rpc, process.env.CARBONLEI_RPC_URL);
    serve = { reader: ChainReader.forRpc(deployment, urls, SEPOLIA_CHAIN), rpcUrls: urls, evidenceDir: values["evidence-dir"] ?? here("../../fixtures/") };
  }
  const token = process.env.CARBONLEI_API_GATEWAY_TOKEN;
  const r = await runErpSync({
    csvText: readFileSync(values.csv ?? here("./erp-export.csv"), "utf8"),
    proofDir: values["proof-dir"] ?? here("../../fixtures/"),
    eori: values.eori,
    year,
    ...(values.price ? { priceEur: values.price } : {}),
    hmacKey,
    ...(values.api ? { api: { baseUrl: values.api, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) } } : { serve }),
  });
  if (values.out) mkdirSync(dirname(resolve(values.out)), { recursive: true }), writeFileSync(values.out, r.csv);
  else process.stdout.write(r.csv);
  const t = r.plan.totals;
  console.error(
    `${r.rows.length} ERP line(s): ${t.onActual} on verified values, ${t.onDefault} on defaults, ${r.rows.filter((x) => !x.planned).length} not planned; ` +
      `${t.certificates} certificates (gross). Results and plan bindings, EORI and nonce checked. Not a CBAM Registry filing.${values.out ? ` Written to ${values.out}.` : ""}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`erp-sync: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
