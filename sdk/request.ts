// Supplier data requests: the importer asks a supplier for proofs of named shipments with named fields
// (`carbonlei request`), the supplier answers with `present --request` or `present-batch --request`, and the importer
// checks the answer with the same verifier as `verify-batch`, at one pinned block (`carbonlei check-response`).
//
// The request is a JSON file the parties exchange however they like. It is NOT a CBAM Registry message and NOT a
// function of the Commission's O3CI portal; sending it (email, portal, EDI) is out of scope. Nothing in it is signed:
// what the importer relies on is the answer, which is verified like any proof (checks 0-10, check 5 bound to the
// request's EORI), and then matched line by line to what was asked.
//
// Fields asked for by default come from the existing lists, not a list of its own: the required disclosures of
// checks 3-5 (`REQUIRED_DISCLOSURES`), the fields check 8 reconciles (`RECONCILED_CLAIMS`) and the fields the
// communication-template export copies (`COMMUNICATION_CLAIMS`). Browser-safe: no file system.
import type { AllocationBook, BookBatch } from "./allocation.ts";
import type { BatchResult, ManifestLine } from "./batch.ts";
import type { ChainReader } from "./chain.ts";
import { COMMUNICATION_CLAIMS } from "./communication.ts";
import { RECONCILED_CLAIMS } from "./consistency.ts";
import {
  CLAIM_ORDER,
  DISCLOSABLE,
  REQUIRED_DISCLOSURES,
  SUPPLIER_PRIVATE,
  checkShipmentForms,
  isIsoDate,
  isLei,
  tonnesToKg,
  type ClaimName,
} from "./credential.ts";
import { decodeDisclosure, type Presentation } from "./disclosure.ts";
import { bytesToHex, sha256Hex } from "./encoding.ts";
import type { SignedCredential } from "./issue.ts";
import { pinnedToHead, runLimited } from "./pinned.ts";
import { CN_CODE, csvField, notSubjectToCbam, originCode, parseCsv } from "./portfolio.ts";
import { TOOL, verdictFor, type Verdict, type VerdictOptions } from "./verdict.ts";

export const REQUEST_SCHEMA = "carbonlei-data-request";
export const REQUEST_VERSION = 1;
export const RESPONSE_CHECK_FORMAT = 1;

/** Printed in every request and every response check. */
export const REQUEST_NOTICE =
  "CarbonLEI data request between two companies: not a CBAM Registry message and not a function of the Commission's O3CI portal; how it is sent (email, portal) is up to the parties. The answer is checked with carbonlei check-response.";

const EORI = /^[A-Z]{2}[A-Za-z0-9]{1,15}$/;
const REQUEST_ID = /^req-[0-9a-f]{32}$/;
const LINE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class RequestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`data request: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** One shipment the importer asks proof for. */
export interface RequestLine {
  /** The importer's own line id, unique in the request (default L1, L2, … in input order). */
  lineId: string;
  supplierLEI: string;
  supplierName?: string;
  /** CN code as customs has it: 4, 6 or 8 digits, or a 10-digit TARIC code. */
  cnCode: string;
  /** Country of origin, ISO 3166 alpha-2. */
  country: string;
  /** Net mass in tonnes (at most three decimals). */
  quantityTonnes: string;
  /** The batch ID the supplier claims on the ledger for this shipment (on the invoice or the purchase order). */
  reference: string;
  /** Answer wanted by this date (YYYY-MM-DD). */
  dueDate: string;
  /** Customs import date (YYYY-MM-DD), when known; `portfolio` needs it for a line answered by no proof. */
  importDate?: string;
  note?: string;
}

export interface DataRequest {
  schema: typeof REQUEST_SCHEMA;
  version: typeof REQUEST_VERSION;
  /** Random; names the request in the files of both sides. Proofs do not carry it: lines are matched by `reference`. */
  requestId: string;
  createdAt: string;
  importer: { eori: string; name?: string };
  importYear: number;
  supplier: { lei: string; name?: string };
  fields: {
    /** Fields every proof must disclose: the required ones, check 8's and the communication export's. */
    required: string[];
    /** Further fields the importer asks for. */
    extra: string[];
    /** Why each required field is asked for. */
    why: Record<string, string>;
  };
  lines: RequestLine[];
  notice: string;
}

// ------------------------------------------------------------------ the fields asked for

/** The fields a request asks for by default, in credential order, each with the reason taken from the code. */
export function defaultRequestFields(): { fields: ClaimName[]; why: Record<string, string> } {
  const reasons = new Map<string, string[]>();
  const add = (list: readonly string[], why: string) => list.forEach((n) => reasons.set(n, [...(reasons.get(n) ?? []), why]));
  add(REQUIRED_DISCLOSURES, "checks 3-5 need it (REQUIRED_DISCLOSURES)");
  add(RECONCILED_CLAIMS, "check 8 reconciles it with the verification report (RECONCILED_CLAIMS)");
  add(COMMUNICATION_CLAIMS, "export-communication copies it into the Commission's template (COMMUNICATION_CLAIMS)");
  const fields = CLAIM_ORDER.filter((n) => reasons.has(n));
  return { fields, why: Object.fromEntries(fields.map((n) => [n, reasons.get(n)!.join("; ")])) };
}

/** Every field the request asks for (required and extra), in credential order. */
export function requestedFields(r: Pick<DataRequest, "fields">): string[] {
  const want = new Set([...r.fields.required, ...r.fields.extra]);
  return CLAIM_ORDER.filter((n) => want.has(n));
}

// ------------------------------------------------------------------ building requests (importer)

const COLUMNS: Record<string, keyof RequestLine> = {
  line_id: "lineId",
  supplier_lei: "supplierLEI",
  supplier_name: "supplierName",
  cn_code: "cnCode",
  country: "country",
  country_of_origin: "country",
  quantity_tonnes: "quantityTonnes",
  reference: "reference",
  batch_id: "reference",
  po_number: "reference",
  due_date: "dueDate",
  import_date: "importDate",
  note: "note",
};
/** CSV columns `carbonlei request` needs (any order, header case ignored; other columns are ignored). */
export const REQUEST_CSV_COLUMNS = ["supplier_lei", "cn_code", "country", "quantity_tonnes", "reference", "due_date"] as const;

/** Request lines from a CSV (one row per line; `REQUEST_CSV_COLUMNS`, optional line_id, supplier_name, import_date, note). */
export function linesFromCsv(text: string): Partial<RequestLine>[] {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new RequestError(["the CSV is empty"]);
  const names = header.map((h) => h.trim().toLowerCase());
  const missing = REQUEST_CSV_COLUMNS.filter((c) => !names.includes(c) && !(c === "country" && names.includes("country_of_origin")) && !(c === "reference" && (names.includes("batch_id") || names.includes("po_number"))));
  if (missing.length) throw new RequestError([`the CSV lacks column(s) ${missing.join(", ")}`]);
  return body.map((row) => {
    const line: Partial<Record<keyof RequestLine, string>> = {};
    names.forEach((n, i) => {
      const key = COLUMNS[n];
      const v = (row[i] ?? "").trim();
      if (key && v !== "" && line[key] === undefined) line[key] = v;
    });
    return line as Partial<RequestLine>;
  });
}

/** Request lines from JSON: an array of lines, or `{ lines: [...] }`, with the field names of `RequestLine`. */
export function linesFromJson(x: unknown): Partial<RequestLine>[] {
  const list = Array.isArray(x) ? x : (x as { lines?: unknown })?.lines;
  if (!Array.isArray(list)) throw new RequestError(['JSON input must be an array of lines or { "lines": [...] }']);
  return list.map((l) => (l && typeof l === "object" ? { ...(l as object) } : {})) as Partial<RequestLine>[];
}

function lineProblems(l: Partial<RequestLine>, where: string, importYear?: number): string[] {
  const p: string[] = [];
  const str = (k: keyof RequestLine) => typeof l[k] === "string" && (l[k] as string).trim() !== "";
  if (!str("supplierLEI") || !isLei(l.supplierLEI!)) p.push(`${where}: supplier LEI ${JSON.stringify(l.supplierLEI ?? "")} is not an LEI (20 characters)`);
  if (!str("cnCode") || !CN_CODE.test(l.cnCode!.replace(/\s+/g, ""))) p.push(`${where}: CN code ${JSON.stringify(l.cnCode ?? "")} is not 4, 6 or 8 digits or a 10-digit TARIC code`);
  if (!str("country") || !/^[A-Z]{2}$/.test(originCode(l.country!))) p.push(`${where}: country ${JSON.stringify(l.country ?? "")} is not an ISO 3166 alpha-2 code`);
  else if (notSubjectToCbam(l.country!)) p.push(`${where}: ${notSubjectToCbam(l.country!)}`);
  try {
    tonnesToKg(String(l.quantityTonnes ?? ""));
    if (!/^(0|[1-9]\d*)(\.\d{1,3})?$/.test(String(l.quantityTonnes))) throw new Error("not in plain decimal form");
  } catch (e) {
    p.push(`${where}: quantity ${JSON.stringify(l.quantityTonnes ?? "")} in tonnes: ${(e as Error).message}`);
  }
  if (!str("reference") || checkShipmentForms({ batchId: l.reference!, quantityTonnes: "1", shipmentDate: "2026-01-01" }).length) {
    p.push(`${where}: reference ${JSON.stringify(l.reference ?? "")} is not a batch ID (1-128 characters, no control characters, no leading or trailing space)`);
  }
  if (!str("dueDate") || !isIsoDate(l.dueDate!)) p.push(`${where}: due date ${JSON.stringify(l.dueDate ?? "")} is not YYYY-MM-DD`);
  if (l.importDate !== undefined) {
    if (typeof l.importDate !== "string" || !isIsoDate(l.importDate)) p.push(`${where}: import date ${JSON.stringify(l.importDate)} is not YYYY-MM-DD`);
    else if (importYear !== undefined && Number(l.importDate.slice(0, 4)) !== importYear) p.push(`${where}: import date ${l.importDate} is not in import year ${importYear}`);
  }
  if (l.lineId !== undefined && (typeof l.lineId !== "string" || !LINE_ID.test(l.lineId))) p.push(`${where}: line id ${JSON.stringify(l.lineId)} must be 1-64 letters, digits, ".", "_" or "-"`);
  for (const k of ["supplierName", "note"] as const) if (l[k] !== undefined && typeof l[k] !== "string") p.push(`${where}: ${k} must be text`);
  return p;
}

function fieldProblems(required: readonly unknown[], extra: readonly unknown[]): string[] {
  const p: string[] = [];
  const disclosable = new Set<string>(DISCLOSABLE);
  for (const n of [...required, ...extra]) {
    if (typeof n !== "string" || !disclosable.has(n)) {
      p.push((SUPPLIER_PRIVATE as readonly unknown[]).includes(n) ? `field ${n} is never disclosed to an importer (supplier-private)` : `unknown field ${JSON.stringify(n)}`);
    }
  }
  const all = new Set([...required, ...extra]);
  const lacking = REQUIRED_DISCLOSURES.filter((n) => !all.has(n));
  if (lacking.length) p.push(`the request must ask for ${lacking.join(", ")}: without them no proof verifies (checks 3-5)`);
  return p;
}

/** A fresh request ID: "req-" and 16 random bytes in hex. */
export const newRequestId = () => `req-${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;

/**
 * One request per supplier LEI (in order of first appearance) from the importer's lines. Throws `RequestError`
 * listing every problem: a bad LEI, CN code, origin (not subject to CBAM included), quantity, reference or date,
 * an import date outside the import year, a reference or line id used twice for one supplier, an unknown,
 * supplier-private or duplicate extra field.
 */
export function buildRequests(
  input: Partial<RequestLine>[],
  opts: { eori: string; importYear: number; importerName?: string; extraFields?: string[]; defaultDueDate?: string; now?: Date; newId?: () => string },
): DataRequest[] {
  const p: string[] = [];
  if (!EORI.test(opts.eori ?? "")) p.push(`EORI ${JSON.stringify(opts.eori ?? "")} is not an EORI number`);
  if (!Number.isInteger(opts.importYear) || opts.importYear < 2026 || opts.importYear > 2100) p.push(`import year must be 2026 or later, got ${opts.importYear}`);
  if (opts.defaultDueDate !== undefined && !isIsoDate(opts.defaultDueDate)) p.push(`--due ${JSON.stringify(opts.defaultDueDate)} is not YYYY-MM-DD`);
  if (!input.length) p.push("no request lines");
  const { fields, why } = defaultRequestFields();
  const extra = CLAIM_ORDER.filter((n) => (opts.extraFields ?? []).includes(n) && !fields.includes(n));
  p.push(...fieldProblems(fields, opts.extraFields ?? []));
  const groups = new Map<string, RequestLine[]>();
  input.forEach((raw, i) => {
    const l: Partial<RequestLine> = {
      ...raw,
      ...(typeof raw.cnCode === "string" ? { cnCode: raw.cnCode.replace(/\s+/g, "") } : {}),
      ...(typeof raw.country === "string" ? { country: originCode(raw.country) } : {}),
      ...(raw.dueDate === undefined && opts.defaultDueDate ? { dueDate: opts.defaultDueDate } : {}),
    };
    const where = `line ${i + 1}${typeof l.reference === "string" ? ` (${l.reference})` : ""}`;
    const bad = lineProblems(l, where, opts.importYear);
    if (bad.length) return void p.push(...bad);
    const list = groups.get(l.supplierLEI!) ?? [];
    if (list.some((x) => x.reference === l.reference)) p.push(`${where}: reference ${l.reference} is used twice for supplier ${l.supplierLEI}`);
    const lineId = l.lineId ?? `L${list.length + 1}`;
    if (list.some((x) => x.lineId === lineId)) p.push(`${where}: line id ${lineId} is used twice for supplier ${l.supplierLEI}`);
    list.push({
      lineId,
      supplierLEI: l.supplierLEI!,
      ...(l.supplierName ? { supplierName: l.supplierName } : {}),
      cnCode: l.cnCode!,
      country: l.country!,
      quantityTonnes: l.quantityTonnes!,
      reference: l.reference!,
      dueDate: l.dueDate!,
      ...(l.importDate ? { importDate: l.importDate } : {}),
      ...(l.note ? { note: l.note } : {}),
    });
    groups.set(l.supplierLEI!, list);
  });
  if (p.length) throw new RequestError(p);
  const now = (opts.now ?? new Date()).toISOString();
  return [...groups].map(([lei, lines]) => ({
    schema: REQUEST_SCHEMA,
    version: REQUEST_VERSION,
    requestId: (opts.newId ?? newRequestId)(),
    createdAt: now,
    importer: { eori: opts.eori, ...(opts.importerName ? { name: opts.importerName } : {}) },
    importYear: opts.importYear,
    supplier: { lei, ...(lines.find((l) => l.supplierName)?.supplierName ? { name: lines.find((l) => l.supplierName)!.supplierName } : {}) },
    fields: { required: [...fields], extra, why },
    lines,
    notice: REQUEST_NOTICE,
  }));
}

/** File name of a request: one per supplier LEI. */
export const requestFileName = (r: DataRequest) => `request-${r.supplier.lei}.json`;

/** Checks a request read from a file (either side); throws `RequestError` listing every problem. */
export function parseRequest(x: unknown): DataRequest {
  const r = x as Partial<DataRequest> | null;
  if (!r || typeof r !== "object") throw new RequestError(["not a JSON object"]);
  const p: string[] = [];
  if (r.schema !== REQUEST_SCHEMA) p.push(`schema must be ${JSON.stringify(REQUEST_SCHEMA)}, got ${JSON.stringify(r.schema)}`);
  if (r.version !== REQUEST_VERSION) p.push(`version must be ${REQUEST_VERSION}, got ${JSON.stringify(r.version)}`);
  if (typeof r.requestId !== "string" || !REQUEST_ID.test(r.requestId)) p.push("requestId must be req- and 32 hex digits");
  if (!r.importer || typeof r.importer.eori !== "string" || !EORI.test(r.importer.eori)) p.push("importer.eori is not an EORI number");
  if (!Number.isInteger(r.importYear) || r.importYear! < 2026) p.push("importYear must be 2026 or later");
  if (!r.supplier || typeof r.supplier.lei !== "string" || !isLei(r.supplier.lei)) p.push("supplier.lei is not an LEI");
  if (!r.fields || !Array.isArray(r.fields.required) || !Array.isArray(r.fields.extra)) p.push("fields.required and fields.extra must be lists");
  else p.push(...fieldProblems(r.fields.required, r.fields.extra));
  if (!Array.isArray(r.lines) || !r.lines.length) p.push("lines must be a non-empty list");
  else {
    const refs = new Set<string>();
    const ids = new Set<string>();
    r.lines.forEach((l, i) => {
      const where = `lines[${i}]`;
      if (typeof l?.lineId !== "string") return void p.push(`${where}: lineId missing`);
      p.push(...lineProblems(l, `${where} (${l.lineId})`, r.importYear));
      if (r.supplier && l.supplierLEI !== r.supplier.lei) p.push(`${where} (${l.lineId}): supplier LEI ${l.supplierLEI} differs from the request's supplier ${r.supplier.lei}`);
      if (refs.has(l.reference)) p.push(`${where} (${l.lineId}): reference ${l.reference} used twice`);
      if (ids.has(l.lineId)) p.push(`${where}: line id ${l.lineId} used twice`);
      refs.add(l.reference);
      ids.add(l.lineId);
    });
  }
  if (p.length) throw new RequestError(p);
  return r as DataRequest;
}

// ------------------------------------------------------------------ answering (supplier)

/** A field's value as the credential would disclose it (from its salted disclosure), or undefined. */
function credentialValue(cred: SignedCredential, name: string): string | undefined {
  const enc = cred.disclosures?.[name];
  if (!enc) return undefined;
  try {
    const d = decodeDisclosure(enc);
    return d.name === name ? d.value : undefined;
  } catch {
    return undefined;
  }
}

/** The CN code of a credential covers the CN code of a line when one is a prefix of the other (heading and full code). */
export const cnMatches = (lineCn: string, credCn: string) => lineCn.startsWith(credCn) || credCn.startsWith(lineCn);

/**
 * The fields a proof answering `r` discloses: exactly the requested ones, unless `fields` lists more and
 * `overDisclose` is set. Refuses (throws `RequestError`) when the credential is not the requested supplier's (LEI),
 * lacks a disclosure for a requested field, `fields` leaves out a requested field, or adds one without `overDisclose`
 * (a supplier-private field is refused even then).
 */
export function answerFields(r: DataRequest, cred: SignedCredential, opts: { fields?: string[]; overDisclose?: boolean } = {}): string[] {
  const p: string[] = [];
  const asked = requestedFields(r);
  const lei = credentialValue(cred, "supplierLEI");
  if (lei !== r.supplier.lei) p.push(`the credential is for supplier ${lei ?? "(no LEI disclosure)"}, the request is addressed to ${r.supplier.lei}: answer it with that supplier's credential`);
  const lacking = asked.filter((n) => credentialValue(cred, n) === undefined);
  if (lacking.length) p.push(`the credential has no disclosure for ${lacking.join(", ")}, which the request asks for: it cannot answer this request (nothing written)`);
  let out = asked;
  if (opts.fields) {
    const given = new Set(opts.fields);
    const left = asked.filter((n) => !given.has(n));
    if (left.length) p.push(`--fields leaves out ${left.join(", ")}, which the request asks for; add them or leave --fields out`);
    const more = CLAIM_ORDER.filter((n) => given.has(n) && !asked.includes(n));
    const priv = more.filter((n) => (SUPPLIER_PRIVATE as readonly string[]).includes(n));
    if (priv.length) p.push(`${priv.join(", ")} is supplier-private and is never disclosed`);
    else if (more.length && !opts.overDisclose) p.push(`--fields adds ${more.join(", ")}, which the request does not ask for; leave them out or pass --over-disclose`);
    const unknown = opts.fields.filter((n) => !(CLAIM_ORDER as readonly string[]).includes(n));
    if (unknown.length) p.push(`unknown field(s) ${unknown.join(", ")}`);
    out = CLAIM_ORDER.filter((n) => given.has(n) || asked.includes(n));
  }
  if (p.length) throw new RequestError(p);
  return out;
}

/** Why `cred` cannot answer `line` (CN code or origin), or none. */
export function lineCredentialProblems(line: RequestLine, cred: SignedCredential): string[] {
  const p: string[] = [];
  const cn = credentialValue(cred, "cnCode");
  if (cn !== undefined && !cnMatches(line.cnCode, cn)) p.push(`line ${line.lineId} asks for CN ${line.cnCode}; the credential is for CN ${cn}`);
  const loc = credentialValue(cred, "unLocode");
  if (loc !== undefined && loc.slice(0, 2) !== line.country) p.push(`line ${line.lineId} asks for origin ${line.country}; the credential's installation is in ${loc.slice(0, 2)} (UN/LOCODE ${loc})`);
  return p;
}

/** The line a single proof answers: `lineId`, else the line whose reference is `batchId`, else the only line. */
export function selectLine(r: DataRequest, opts: { lineId?: string; batchId?: string }): RequestLine {
  if (opts.lineId !== undefined) {
    const l = r.lines.find((x) => x.lineId === opts.lineId);
    if (!l) throw new RequestError([`no line ${opts.lineId} in request ${r.requestId} (lines: ${r.lines.map((x) => x.lineId).join(", ")})`]);
    if (opts.batchId !== undefined && opts.batchId !== l.reference) {
      throw new RequestError([`line ${l.lineId} asks for batch ${l.reference}; a proof for batch ${opts.batchId} would be reported as not requested`]);
    }
    return l;
  }
  if (opts.batchId !== undefined) {
    const l = r.lines.find((x) => x.reference === opts.batchId);
    if (!l) throw new RequestError([`no line of request ${r.requestId} has reference ${opts.batchId} (references: ${r.lines.map((x) => x.reference).join(", ")})`]);
    return l;
  }
  if (r.lines.length === 1) return r.lines[0];
  throw new RequestError([`the request has ${r.lines.length} lines: pass --line <id> (${r.lines.map((x) => `${x.lineId}=${x.reference}`).join(", ")})`]);
}

export interface RequestBatchPlan {
  /** The book narrowed to the requested batches of the requesting importer, each with the answer's fields. */
  book: AllocationBook;
  /** Lines the book has no batch for (the supplier's answer will be missing them). */
  notInBook: { lineId: string; reference: string; reason: string }[];
  warnings: string[];
}

/**
 * `present-batch --request`: the batches of the book that answer `r` (the importer whose EORI is the request's,
 * batch IDs equal to the lines' references), with the request's fields (`answerFields`; with `overDisclose`, the
 * book's own fields for that buyer are added). Throws `RequestError` for the wrong credential, a missing field, a
 * CN code or origin the credential does not cover, or a book without the requesting importer.
 */
export function planRequestBatches(
  r: DataRequest,
  book: AllocationBook,
  cred: SignedCredential,
  opts: { overDisclose?: boolean; bookFields?: (b: BookBatch) => string[] } = {},
): RequestBatchPlan {
  const base = answerFields(r, cred);
  const p = r.lines.flatMap((l) => lineCredentialProblems(l, cred));
  if (p.length) throw new RequestError(p);
  const importers = book.importers.filter((i) => i.eori === r.importer.eori);
  if (!importers.length) throw new RequestError([`no importer in the allocation book has the request's EORI: add it to the book, or check that the request is for you`]);
  const ids = new Set(importers.map((i) => i.id));
  const warnings: string[] = [];
  const notInBook: RequestBatchPlan["notInBook"] = [];
  const batches: BookBatch[] = [];
  for (const l of r.lines) {
    const b = book.batches.find((x) => x.batchId === l.reference);
    if (!b || !ids.has(b.importer)) {
      notInBook.push({ lineId: l.lineId, reference: l.reference, reason: b ? "the book allocates this batch to another importer" : "no batch with this ID in the book" });
      continue;
    }
    if (tonnesToKg(b.quantityTonnes) < tonnesToKg(l.quantityTonnes)) {
      warnings.push(`line ${l.lineId} (${l.reference}): the book allocates ${b.quantityTonnes} t, the request asks for ${l.quantityTonnes} t; the importer will see QUANTITY_SHORT`);
    }
    const extra = opts.overDisclose && opts.bookFields ? opts.bookFields(b) : [];
    const want = new Set([...base, ...extra]);
    batches.push({ ...b, fields: CLAIM_ORDER.filter((n) => want.has(n) && !(SUPPLIER_PRIVATE as readonly string[]).includes(n)) });
  }
  return { book: { ...book, importers, batches }, notInBook, warnings };
}

// ------------------------------------------------------------------ checking the answer (importer)

export type LineStatus = "ANSWERED" | "NEEDS_ACTION" | "NOT_VERIFIED" | "MISSING" | "ERROR";
export type ResponseIssueCode =
  | "MISSING"
  | "OVERDUE"
  | "VERIFY_ERROR"
  | "NOT_VERIFIED"
  | "WRONG_SUPPLIER"
  | "WRONG_CN"
  | "WRONG_ORIGIN"
  | "QUANTITY_SHORT"
  | "FIELD_NOT_DISCLOSED"
  | "EXTRA_FIELDS";

export interface ResponseIssue {
  code: ResponseIssueCode;
  /** action: the line is not answered as asked; warning: answered, but look (over-disclosure); info: context. */
  severity: "action" | "warning" | "info";
  detail: string;
  fields?: string[];
}

/** One proof as verified: its name, the SHA-256 of its bytes, the verdict (or the error) and its shipment part. */
export interface VerifiedProof {
  name: string;
  sha256: string | null;
  verdict: Verdict | null;
  error: string | null;
  shipment: { batchId: string; quantityTonnes: string; shipmentDate: string } | null;
}

export interface ResponseLine {
  lineId: string;
  reference: string;
  supplierLEI: string;
  cnCode: string;
  country: string;
  quantityTonnes: string;
  dueDate: string;
  importDate?: string;
  status: LineStatus;
  issues: ResponseIssue[];
  /** The proof matched to this line, or null. */
  proof: string | null;
  proofSha256: string | null;
  overall: Verdict["overall"] | null;
  primaryCode: string | null;
  /** Tonnes the proof's ledger claim covers (check 5 bound it to the request's EORI), or null. */
  provenTonnes: string | null;
  /** True when `responseResults` hands the proof's verdict to `portfolio` (a VALID proof of this supplier, CN and origin). */
  usable: boolean;
}

export interface ResponseCheck {
  format: typeof RESPONSE_CHECK_FORMAT;
  kind: "carbonlei-response-check";
  requestId: string;
  /** SHA-256 of the request file as read. */
  requestSha256: string;
  importerEori: string;
  supplierLEI: string;
  importYear: number;
  requestedFields: string[];
  pinnedBlock: number | null;
  chainId: number | null;
  checkedAt: string;
  counts: Record<LineStatus, number>;
  lines: ResponseLine[];
  /** Proofs that answer no line: another batch, a second proof for a line, no shipment part. */
  unmatched: { proof: string; batchId: string | null; reason: "NOT_REQUESTED" | "DUPLICATE" | "NO_SHIPMENT"; detail: string }[];
  /** The verdicts, one per proof given, in input order (as `verify-batch` would store them). */
  proofs: VerifiedProof[];
  notice: string;
  tool: { name: string; version: string };
}

const ACTION = (code: ResponseIssueCode, detail: string, fields?: string[]): ResponseIssue => ({ code, severity: "action", detail, ...(fields ? { fields } : {}) });

/**
 * Matches verified proofs to the request's lines. A proof answers the line whose `reference` is its batch ID; for a
 * VALID proof that ID is the one check 5 found claimed for the request's EORI. The first VALID proof of a line is
 * used (else the first one); others are `DUPLICATE`. Per line: MISSING (no proof; OVERDUE after the due date),
 * ERROR (the verification could not run), NOT_VERIFIED (not VALID), NEEDS_ACTION (VALID, but another supplier, CN
 * code or origin, fewer tonnes than asked, or a requested field not disclosed) or ANSWERED (warnings allowed: fields
 * disclosed that were not asked for are `EXTRA_FIELDS`).
 */
export function matchResponse(
  r: DataRequest,
  proofs: VerifiedProof[],
  ctx: { requestSha256: string; pinnedBlock?: bigint | number | null; chainId?: number | null; now?: Date },
): ResponseCheck {
  const now = ctx.now ?? new Date();
  const asked = requestedFields(r);
  const byRef = new Map<string, VerifiedProof[]>();
  const unmatched: ResponseCheck["unmatched"] = [];
  for (const pr of proofs) {
    const ref = pr.shipment?.batchId;
    if (ref === undefined) {
      unmatched.push({ proof: pr.name, batchId: null, reason: "NO_SHIPMENT", detail: "the proof has no shipment part, so check 5 cannot bind it to your EORI and it answers no line" });
      continue;
    }
    if (!r.lines.some((l) => l.reference === ref)) {
      unmatched.push({ proof: pr.name, batchId: ref, reason: "NOT_REQUESTED", detail: `batch ${ref} is not a reference of request ${r.requestId}` });
      continue;
    }
    byRef.set(ref, [...(byRef.get(ref) ?? []), pr]);
  }
  const lines = r.lines.map((l): ResponseLine => {
    const cands = byRef.get(l.reference) ?? [];
    const pr = cands.find((c) => c.verdict?.overall === "VALID") ?? cands[0];
    for (const c of cands) {
      if (c === pr) continue;
      const own = c.error ? "could not be verified" : `${c.verdict?.overall ?? "not verified"}${c.verdict?.primaryCode ? ` (${c.verdict.primaryCode})` : ""}`;
      unmatched.push({ proof: c.name, batchId: l.reference, reason: "DUPLICATE", detail: `line ${l.lineId} is answered by ${pr!.name}; this proof: ${own}` });
    }
    const base = { lineId: l.lineId, reference: l.reference, supplierLEI: l.supplierLEI, cnCode: l.cnCode, country: l.country, quantityTonnes: l.quantityTonnes, dueDate: l.dueDate, ...(l.importDate ? { importDate: l.importDate } : {}) };
    if (!pr) {
      const issues = [ACTION("MISSING", `no proof for batch ${l.reference}`)];
      if (now.toISOString().slice(0, 10) > l.dueDate) issues.push({ code: "OVERDUE", severity: "info", detail: `due ${l.dueDate}` });
      return { ...base, status: "MISSING", issues, proof: null, proofSha256: null, overall: null, primaryCode: null, provenTonnes: null, usable: false };
    }
    const common = { proof: pr.name, proofSha256: pr.sha256 };
    if (pr.error || !pr.verdict) {
      return { ...base, ...common, status: "ERROR", issues: [ACTION("VERIFY_ERROR", `the verification could not run: ${pr.error ?? "no verdict"}`)], overall: null, primaryCode: null, provenTonnes: null, usable: false };
    }
    const v = pr.verdict;
    const bound = v.checks.find((c) => c.id === 5)?.status === "pass";
    if (v.overall !== "VALID" || !bound) {
      const why = v.overall !== "VALID" ? `${v.overall}${v.primaryCode ? ` (${v.primaryCode})` : ""}` : "check 5 did not bind the shipment to the request's EORI";
      return { ...base, ...common, status: "NOT_VERIFIED", issues: [ACTION("NOT_VERIFIED", `the proof did not verify: ${why}`)], overall: v.overall, primaryCode: v.primaryCode || null, provenTonnes: null, usable: false };
    }
    const d = v.disclosed;
    const issues: ResponseIssue[] = [];
    if (d.supplierLEI !== l.supplierLEI) issues.push(ACTION("WRONG_SUPPLIER", `the proof is from supplier ${d.supplierLEI ?? "(LEI not disclosed)"}, the line asks for ${l.supplierLEI}`));
    if (d.cnCode !== undefined && !cnMatches(l.cnCode, d.cnCode)) issues.push(ACTION("WRONG_CN", `the credential is for CN ${d.cnCode}, the line is CN ${l.cnCode}`));
    if (d.unLocode !== undefined && d.unLocode.slice(0, 2) !== l.country) issues.push(ACTION("WRONG_ORIGIN", `the installation is in ${d.unLocode.slice(0, 2)} (UN/LOCODE ${d.unLocode}), the line's origin is ${l.country}`));
    const proven = pr.shipment!.quantityTonnes;
    let short = false;
    try {
      short = tonnesToKg(proven) < tonnesToKg(l.quantityTonnes);
    } catch {
      short = true;
    }
    if (short) issues.push(ACTION("QUANTITY_SHORT", `the ledger claim covers ${proven} t of the ${l.quantityTonnes} t asked`));
    const hidden = asked.filter((n) => d[n] === undefined);
    if (hidden.length) issues.push(ACTION("FIELD_NOT_DISCLOSED", `requested but not disclosed: ${hidden.join(", ")}`, hidden));
    const extra = CLAIM_ORDER.filter((n) => d[n] !== undefined && !asked.includes(n));
    if (extra.length) issues.push({ code: "EXTRA_FIELDS", severity: "warning", detail: `disclosed but not requested: ${extra.join(", ")}`, fields: extra });
    const status: LineStatus = issues.some((i) => i.severity === "action") ? "NEEDS_ACTION" : "ANSWERED";
    const usable = !issues.some((i) => ["WRONG_SUPPLIER", "WRONG_CN", "WRONG_ORIGIN"].includes(i.code));
    return { ...base, ...common, status, issues, overall: v.overall, primaryCode: v.primaryCode || null, provenTonnes: proven, usable };
  });
  const counts: Record<LineStatus, number> = { ANSWERED: 0, NEEDS_ACTION: 0, NOT_VERIFIED: 0, MISSING: 0, ERROR: 0 };
  for (const l of lines) counts[l.status]++;
  const pinned = ctx.pinnedBlock === undefined || ctx.pinnedBlock === null ? null : Number(ctx.pinnedBlock);
  return {
    format: RESPONSE_CHECK_FORMAT,
    kind: "carbonlei-response-check",
    requestId: r.requestId,
    requestSha256: ctx.requestSha256,
    importerEori: r.importer.eori,
    supplierLEI: r.supplier.lei,
    importYear: r.importYear,
    requestedFields: asked,
    pinnedBlock: pinned,
    chainId: ctx.chainId ?? null,
    checkedAt: now.toISOString(),
    counts,
    lines,
    unmatched,
    proofs,
    notice: REQUEST_NOTICE,
    tool: { ...TOOL },
  };
}

/** Exit code of a response check: 3 if a verification could not run, else 1 if any line is not ANSWERED, else 0. */
export function responseExitCode(c: Pick<ResponseCheck, "counts">): number {
  if (c.counts.ERROR) return 3;
  return c.counts.NEEDS_ACTION || c.counts.NOT_VERIFIED || c.counts.MISSING ? 1 : 0;
}

/**
 * Verifies every proof with the normal verifier (`verdictFor`, check 5 bound to the request's EORI) against one
 * pinned block, then matches them to the request (`matchResponse`).
 */
export async function checkResponse(
  r: DataRequest,
  requestText: string,
  proofs: { name: string; text: string; loadBundle?: VerdictOptions["loadBundle"] }[],
  reader: ChainReader,
  opts: Omit<VerdictOptions, "importerEORI" | "proofText" | "loadBundle"> & { concurrency?: number; within?: <T>(p: Promise<T>) => Promise<T> } = {},
): Promise<ResponseCheck> {
  // `now` (milliseconds) is the verifier's clock (head-age limit) and the time of the check (due dates).
  const { concurrency = 2, within = (p) => p, ...verdictOpts } = opts;
  const now = opts.now ? new Date(opts.now()) : undefined;
  const head = await within(reader.latestBlock());
  const pinned = pinnedToHead(reader, head);
  let chainId: number | null = null;
  const verified = await runLimited(proofs, concurrency, async (p): Promise<VerifiedProof> => {
    let proof: Presentation | undefined;
    const sha256 = sha256Hex(p.text);
    try {
      proof = JSON.parse(p.text) as Presentation;
      const v = await within(verdictFor(proof, pinned, { ...verdictOpts, importerEORI: r.importer.eori, proofText: p.text, ...(p.loadBundle ? { loadBundle: p.loadBundle } : {}) }));
      chainId ??= v.chain.chainId;
      return { name: p.name, sha256, verdict: v, error: null, shipment: shipmentOf(proof) };
    } catch (err) {
      return { name: p.name, sha256, verdict: null, error: (err as Error).message, shipment: proof ? shipmentOf(proof) : null };
    }
  });
  return matchResponse(r, verified, { requestSha256: sha256Hex(requestText), pinnedBlock: head.number, chainId, ...(now ? { now } : {}) });
}

function shipmentOf(proof: unknown): VerifiedProof["shipment"] {
  const s = (proof as { shipment?: Record<string, unknown> })?.shipment;
  if (!s || typeof s.batchId !== "string") return null;
  return { batchId: s.batchId, quantityTonnes: String(s.quantityTonnes ?? ""), shipmentDate: String(s.shipmentDate ?? "") };
}

/**
 * One `verify-batch` result per request line, for `portfolio`, `recheck` and `audit-pack`: the importer's own line
 * data (CN code, origin, quantity, import date, supplier) and, when the line's proof is usable, its verdict as computed
 * here. A missing, unverified or unusable line (another supplier, CN code or origin) has no verdict, so `portfolio`
 * plans it on the default value. `proofPath` turns a proof name into the path stored in the results.
 */
export function responseResults(c: ResponseCheck, proofPath: (name: string) => string = (n) => n): BatchResult[] {
  const byName = new Map(c.proofs.map((p) => [p.name, p]));
  return c.lines.map((l) => {
    const pr = l.proof ? byName.get(l.proof) : undefined;
    const reasons = l.issues.filter((i) => i.severity === "action").map((i) => i.code);
    const line: ManifestLine = {
      id: l.lineId,
      quantityTonnes: l.quantityTonnes,
      cnCode: l.cnCode,
      country: l.country,
      supplier: l.supplierLEI,
      note: `request ${c.requestId} line ${l.lineId} (batch ${l.reference}): ${l.status}${reasons.length ? ` ${reasons.join(", ")}` : ""}${pr && !l.usable ? "; proof not used" : ""}`,
    };
    if (l.importDate) line.importDate = l.importDate;
    if (!pr || !l.usable) return { proof: null, line, verdict: null, error: null, proofShipment: null };
    line.proof = proofPath(pr.name);
    return { proof: proofPath(pr.name), line, verdict: pr.verdict, error: pr.error, proofShipment: pr.shipment, proofSha256: pr.sha256 };
  });
}

export const RESPONSE_CSV_COLUMNS = [
  "line",
  "reference",
  "supplier_lei",
  "cn_code",
  "country",
  "quantity_tonnes",
  "proven_tonnes",
  "due_date",
  "status",
  "issues",
  "proof",
  "verdict",
  "primary_code",
] as const;

/** The check as CSV (RFC 4180, CRLF line ends): the column row, one row per line, then one per unmatched proof. */
export function responseCsv(c: ResponseCheck): string {
  const rows: string[][] = [[...RESPONSE_CSV_COLUMNS]];
  for (const l of c.lines) {
    rows.push([
      l.lineId,
      l.reference,
      l.supplierLEI,
      l.cnCode,
      l.country,
      l.quantityTonnes,
      l.provenTonnes ?? "",
      l.dueDate,
      l.status,
      l.issues.map((i) => i.code).join(" "),
      l.proof ?? "",
      l.overall ?? "",
      l.primaryCode ?? "",
    ]);
  }
  for (const u of c.unmatched) rows.push(["", u.batchId ?? "", "", "", "", "", "", "", u.reason, u.detail, u.proof, "", ""]);
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** The check for the terminal. */
export function printResponseCheck(c: ResponseCheck): string {
  const L = [`Request ${c.requestId} to ${c.supplierLEI}, import year ${c.importYear}: ${c.lines.length} line(s), checked at pinned block ${c.pinnedBlock ?? "—"} (chain ${c.chainId ?? "—"})`];
  const w = Math.max(4, ...c.lines.map((l) => l.lineId.length));
  for (const l of c.lines) {
    L.push(`${l.status.padEnd(12)} ${l.lineId.padEnd(w)}  ${l.reference}  ${l.quantityTonnes} t${l.provenTonnes !== null ? ` (proven ${l.provenTonnes} t)` : ""}${l.proof ? `  ${l.proof}` : ""}`);
    for (const i of l.issues) L.push(`${" ".repeat(13)}${i.severity === "action" ? "-" : i.severity === "warning" ? "!" : "·"} ${i.code}: ${i.detail}`);
  }
  for (const u of c.unmatched) L.push(`(not used)   ${u.proof}: ${u.reason} — ${u.detail}`);
  const n = c.counts;
  L.push("", `${n.ANSWERED} answered, ${n.NEEDS_ACTION} need action, ${n.NOT_VERIFIED} not verified, ${n.MISSING} missing, ${n.ERROR} error`, c.notice);
  return L.join("\n");
}
