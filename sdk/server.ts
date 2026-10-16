// `carbonlei serve`: a small REST API over the same SDK calls as the CLI, for an importer's own systems (ERP,
// compliance tool, scheduler). node:http only, no framework and no new dependency. OpenAPI: docs/schemas/openapi.json.
//
//   POST /v1/verify        { proof, eori? }                         → verdict (docs/schemas/verdict.schema.json)
//   POST /v1/verify-batch  { eori?, shipments: [{ proof, id, … }] } → verify-batch results, one pinned block
//   POST /v1/portfolio     { results, year, priceEur?, defaults?, benchmarks?, recheck? } → declaration plan
//   POST /v1/recheck       { records: [...] }                        → re-check (docs/schemas/recheck.schema.json)
//   GET  /v1/health        chain head, chain ID, RPC node hosts, limits
//   GET  /openapi.json     the OpenAPI 3.1 description
//
// SECURITY: the server has NO authentication and NO TLS. It binds 127.0.0.1 by default and must sit behind the
// integrator's own gateway (authentication, TLS, rate limits) before anything else can reach it. It never sends a
// transaction and holds no key. Limits: request body size, JSON content type, a per-request timeout, a cap on
// concurrent verifications, and a cap on lines per batch. Logs are one JSON line per request on stderr, without
// the request body, the EORI, the client address or the query string (docs/SECURITY.md › HTTP API).
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { batchDocument, pinnedToHead, proofShipmentOf, runLimited, shipmentsFromBatch, type BatchDocument, type BatchResult, type ManifestLine } from "./batch.ts";
import type { ChainReader } from "./chain.ts";
import type { Presentation } from "./disclosure.ts";
import { buildPortfolio } from "./portfolio.ts";
import { applyRecheck, MAX_RECORDS, recheckExitCode, recheckRecords, recordsFromJson, type RecheckDocument } from "./recheck.ts";
import { duplicateKey } from "./said.ts";
import { exitCodeOf, TOOL, verdictError, verdictFor } from "./verdict.ts";
import type { EvidenceCheckers } from "./verify.ts";

export const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  /** Largest request body, bytes (a demo proof with its evidence references is about 20 kB). */
  maxBodyBytes: 1_000_000,
  /** Longest a request may take before the server answers 504. */
  timeoutMs: 60_000,
  /** Verifications (POST requests) running at once; more are answered 503 with Retry-After. */
  maxConcurrent: 4,
  /** Lines per /v1/verify-batch request. */
  maxBatch: 50,
  /** Largest evidence bundle file read from the evidence folder, bytes. */
  maxBundleBytes: 5_000_000,
} as const;

export interface ServeOptions {
  /** The chain reader every request reads through (one RPC configuration for the server). */
  reader: ChainReader;
  /** RPC hosts, for /v1/health (host names only: a URL may carry an API key in its path). */
  rpcUrls?: string[];
  /** Folder evidence bundles are read from (proofs refer to them by relative path); nothing outside it is read. */
  evidenceDir?: string;
  /** Checks 6-8 (tests); default: the vLEI checkers with bundles from `evidenceDir`. */
  checkers?: EvidenceCheckers;
  trustAnchor?: string;
  maxHeadAgeSec?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxBatch?: number;
  /** Exactly one origin allowed for CORS; off (no CORS headers) when not set. */
  corsOrigin?: string;
  /** Log sink, one object per event (default: a JSON line on stderr). */
  log?: (entry: Record<string, unknown>) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Replaces every URL in a message by its origin, so an RPC API key in a URL path never reaches a log or a client. */
export function redact(message: string): string {
  return message.replace(/\b(https?|wss?):\/\/[^\s"'<>]+/gi, (m) => {
    try {
      const u = new URL(m);
      return `${u.protocol}//${u.host}/…`;
    } catch {
      return "<url>";
    }
  });
}

const isProof = (x: unknown): x is Presentation =>
  !!x && typeof x === "object" && typeof (x as { core?: unknown }).core === "string" && "signature" in (x as object);

/**
 * Evidence bundle loader confined to `dir`: a path that resolves (after symbolic links) outside it, or a file
 * larger than `maxBundleBytes`, is refused.
 */
export function sandboxedLoader(dir: string, maxBytes: number = DEFAULTS.maxBundleBytes) {
  const root = realpathSync(resolve(dir));
  return async (p: string): Promise<string> => {
    if (typeof p !== "string" || p.includes("\0")) throw new Error("evidence path is not a file name");
    let full: string;
    try {
      full = realpathSync(resolve(root, p));
    } catch {
      throw new Error(`evidence file ${p} not found`);
    }
    if (full !== root && !full.startsWith(root + sep)) throw new Error("evidence path outside the evidence folder");
    if (statSync(full).size > maxBytes) throw new Error(`evidence file larger than ${maxBytes} bytes`);
    return readFile(full, "utf8");
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, `request body larger than ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, `request body larger than ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !done && ((done = true), resolveBody(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (e) => !done && ((done = true), reject(e)));
  });
}

function parseJsonBody(text: string): Record<string, unknown> {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw new HttpError(400, "the request body is not valid JSON");
  }
  // JSON.parse keeps the last of two equal keys where another reader may keep the first: refuse (as check 0 does).
  const dup = duplicateKey(text);
  if (dup !== null) throw new HttpError(400, `the request body repeats the key ${JSON.stringify(dup)}`);
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(400, "the request body must be a JSON object");
  return x as Record<string, unknown>;
}

const optString = (body: Record<string, unknown>, key: string): string | undefined => {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `"${key}" must be a string`);
  return v;
};

const optMap = (body: Record<string, unknown>, key: string): Record<string, string> | undefined => {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, `"${key}" must be an object of "<country>:<CN prefix>": value`);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
};

let openapiCache: string | undefined;
function openapiText(): string {
  return (openapiCache ??= readFileSync(fileURLToPath(new URL("../docs/schemas/openapi.json", import.meta.url)), "utf8"));
}

/** The API server (not yet listening). */
export function createApiServer(opts: ServeOptions): Server {
  const maxBody = opts.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULTS.maxConcurrent;
  const maxBatch = opts.maxBatch ?? DEFAULTS.maxBatch;
  const log = opts.log ?? ((e: Record<string, unknown>) => process.stderr.write(json(e) + "\n"));
  const loadBundle = opts.evidenceDir ? sandboxedLoader(opts.evidenceDir) : undefined;
  const verdictOpts = {
    ...(opts.checkers ? { checkers: opts.checkers } : {}),
    ...(loadBundle ? { loadBundle } : {}),
    ...(opts.trustAnchor ? { trustAnchor: opts.trustAnchor } : {}),
    ...(opts.maxHeadAgeSec !== undefined ? { maxHeadAgeSec: opts.maxHeadAgeSec } : {}),
  };
  let active = 0;

  const routes: Record<string, (body: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ status: number; body: unknown; exit?: number }>> = {
    "/v1/verify": async (body, ctx) => {
      if (!isProof(body.proof)) throw new HttpError(400, '"proof" must be a proof object (with "core" and "signature")');
      const eori = optString(body, "eori");
      ctx.eori = eori ? "given" : "none";
      try {
        const v = await verdictFor(body.proof, opts.reader, { ...verdictOpts, importerEORI: eori, proofText: JSON.stringify(body.proof) });
        ctx.outcome = v.overall;
        return { status: 200, body: v, exit: exitCodeOf(v) };
      } catch (e) {
        ctx.outcome = "ERROR";
        return { status: 502, body: verdictError(new Error(redact((e as Error).message))), exit: 3 };
      }
    },
    "/v1/verify-batch": async (body, ctx) => {
      const lines = body.shipments;
      if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, '"shipments" must be a non-empty array');
      if (lines.length > maxBatch) throw new HttpError(413, `at most ${maxBatch} shipments per request`);
      const eori = optString(body, "eori");
      ctx.eori = eori ? "given" : "none";
      const head = await opts.reader.latestBlock().catch((e) => {
        throw new HttpError(502, redact((e as Error).message));
      });
      const pinned = pinnedToHead(opts.reader, head);
      let chainId: number | undefined;
      const results = await runLimited(lines as unknown[], 2, async (raw, i): Promise<BatchResult> => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `shipments[${i}] must be an object`);
        const { proof, ...rest } = raw as Record<string, unknown>;
        const line = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === "string")) as ManifestLine;
        const name = line.id ?? `shipments[${i}]`;
        if (proof === null || proof === undefined) return { proof: null, line: { ...line, proof: null }, verdict: null, error: null, proofShipment: null };
        if (!isProof(proof)) throw new HttpError(400, `shipments[${i}].proof must be a proof object or null`);
        try {
          const v = await verdictFor(proof, pinned, { ...verdictOpts, importerEORI: eori, proofText: JSON.stringify(proof) });
          chainId ??= v.chain.chainId ?? undefined;
          return { proof: name, line, verdict: v, error: null, proofShipment: proofShipmentOf(proof) };
        } catch (e) {
          return { proof: name, line, verdict: null, error: redact((e as Error).message), proofShipment: proofShipmentOf(proof) };
        }
      });
      const doc = batchDocument(results, { pinnedBlock: head.number, chainId, eori });
      ctx.outcome = doc.counts;
      return { status: 200, body: doc };
    },
    "/v1/portfolio": async (body, ctx) => {
      const year = body.year;
      if (typeof year !== "number" || !Number.isInteger(year)) throw new HttpError(400, '"year" must be an integer, for example 2026');
      let doc = body.results as BatchDocument;
      if ((doc as { kind?: unknown })?.kind !== "carbonlei-batch") throw new HttpError(400, '"results" must be a verify-batch results document');
      const recheck = body.recheck as RecheckDocument | undefined;
      const bm = optMap(body, "benchmarks");
      const { cbamFactor, cscf, ...benchmarks } = bm ?? {};
      try {
        if (recheck !== undefined && recheck !== null) doc = applyRecheck(doc, recheck);
        const summary = buildPortfolio(shipmentsFromBatch(doc), {
          year,
          ...(optString(body, "priceEur") !== undefined ? { priceEur: optString(body, "priceEur") } : {}),
          ...(optMap(body, "defaults") ? { defaults: optMap(body, "defaults") } : {}),
          ...(bm ? { freeAllocation: { benchmarks, ...(cbamFactor ? { cbamFactor } : {}), ...(cscf ? { cscf } : {}) } } : {}),
        });
        ctx.outcome = { onActual: summary.totals.onActual, onDefault: summary.totals.onDefault };
        return { status: 200, body: summary };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(422, (e as Error).message);
      }
    },
    "/v1/recheck": async (body, ctx) => {
      if (!Array.isArray(body.records) || !body.records.length) throw new HttpError(400, '"records" must be a non-empty array');
      const { records, skipped } = recordsFromJson(body.records, "records");
      if (!records.length) throw new HttpError(400, `no record to re-check: ${skipped.join("; ")}`);
      if (records.length > MAX_RECORDS) throw new HttpError(413, `at most ${MAX_RECORDS} records per request`);
      ctx.eori = records.some((r) => r.eori) ? "given" : "none";
      let doc: RecheckDocument;
      try {
        doc = await recheckRecords(records, opts.reader, {
          ...(opts.checkers ? { checkers: opts.checkers } : {}),
          ...(opts.trustAnchor ? { trustAnchor: opts.trustAnchor } : {}),
          ...(opts.maxHeadAgeSec !== undefined ? { maxHeadAgeSec: opts.maxHeadAgeSec } : {}),
          ...(loadBundle ? { loadBundleFor: () => loadBundle } : {}),
        });
      } catch (e) {
        throw new HttpError(502, redact((e as Error).message));
      }
      for (const r of doc.results) if (r.error) r.error = redact(r.error), (r.reasons = r.reasons.map(redact));
      ctx.outcome = doc.counts;
      return { status: 200, body: skipped.length ? { ...doc, skipped } : doc, exit: recheckExitCode(doc) };
    },
  };

  const health = async () => {
    try {
      const [head, chainId] = await Promise.all([opts.reader.latestBlock(), opts.reader.client.getChainId()]);
      return {
        status: 200,
        body: {
          status: "ok",
          chainId,
          registry: opts.reader.registry,
          head: { number: Number(head.number), timestamp: Number(head.timestamp), ageSec: Math.max(0, Math.round(Date.now() / 1000 - Number(head.timestamp))) },
          rpc: { nodes: opts.rpcUrls?.length ?? null, hosts: (opts.rpcUrls ?? []).map((u) => { try { return new URL(u).host; } catch { return "<invalid>"; } }) },
          auth: "none: run behind your own gateway (authentication, TLS, rate limits)",
          limits: { maxBodyBytes: maxBody, timeoutMs, maxConcurrent, maxBatch, maxRecords: MAX_RECORDS, active },
          tool: { ...TOOL },
        },
      };
    } catch (e) {
      return { status: 503, body: { status: "unavailable", error: redact((e as Error).message), tool: { ...TOOL } } };
    }
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const id = randomBytes(6).toString("hex");
    const path = (req.url ?? "/").split("?")[0];
    const ctx: Record<string, unknown> = {};
    let bytesIn = 0;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      const text = typeof body === "string" ? body : json(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": id,
        ...(opts.corsOrigin ? { "access-control-allow-origin": opts.corsOrigin, vary: "Origin" } : {}),
        ...headers,
      });
      res.end(text);
      log({
        ts: new Date().toISOString(),
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        msg: "request",
        id,
        method: req.method,
        path: path.length > 64 ? `${path.slice(0, 64)}…` : path,
        status,
        ms: Date.now() - started,
        bytesIn,
        ...(ctx.eori ? { eori: ctx.eori } : {}),
        ...(ctx.outcome !== undefined ? { outcome: ctx.outcome } : {}),
        ...(status >= 400 && typeof (body as { error?: unknown })?.error === "string" ? { error: (body as { error: string }).error.slice(0, 300) } : {}),
      });
    };
    try {
      if (req.method === "OPTIONS" && opts.corsOrigin) {
        return send(204, "", { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      }
      if (path === "/v1/health" || path === "/openapi.json") {
        if (req.method !== "GET") throw new HttpError(405, "use GET", { allow: "GET" });
        if (path === "/openapi.json") return send(200, openapiText());
        const h = await health();
        return send(h.status, h.body);
      }
      const route = routes[path];
      if (!route) throw new HttpError(404, `no such endpoint: see GET /openapi.json`);
      if (req.method !== "POST") throw new HttpError(405, "use POST", { allow: "POST" });
      const type = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!/^application\/json(\s*;|$)/.test(type)) throw new HttpError(415, "Content-Type must be application/json");
      if (active >= maxConcurrent) throw new HttpError(503, `busy: ${maxConcurrent} requests are running; retry shortly`, { "retry-after": "5" });
      active++;
      // The slot is held until the work really ends, even after a 504: a verification cannot be cancelled midway.
      let timer: NodeJS.Timeout | undefined;
      const work = (async () => {
        const text = await readBody(req, maxBody);
        bytesIn = Buffer.byteLength(text);
        return route(parseJsonBody(text), ctx);
      })().finally(() => active--);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(504, `the request took longer than ${timeoutMs / 1000} s`)), timeoutMs);
      });
      work.catch(() => undefined);
      try {
        const out = await Promise.race([work, timeout]);
        send(out.status, out.body, out.exit !== undefined ? { "x-carbonlei-exit": String(out.exit) } : {});
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message, tool: { ...TOOL } }, e.headers);
      else send(500, { error: redact((e as Error)?.message ?? String(e)), tool: { ...TOOL } });
    }
  });
  // Slow-client limits of node:http (headers and whole request), on top of the per-request timeout.
  server.headersTimeout = 10_000;
  server.requestTimeout = timeoutMs + 5_000;
  server.maxHeadersCount = 50;
  return server;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopback = (host: string) => LOOPBACK.has(host) || host.startsWith("127.");
