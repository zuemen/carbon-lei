// Verifier latency benchmark: runs the SDK's verifyPresentation on the demo proof
// (fixtures/sepolia-demo-proof.json, with its evidence bundle) and records, per run, the time,
// the number of JSON-RPC requests (counted by a wrapper around viem's http transport) and the
// requests per method. Four series:
//   cold:  a new Node process and a new client per run, against a public Sepolia RPC;
//   warm:  one client, runs back to back, against the same RPC (after one unrecorded warm-up run);
//   warmFullScan: as warm, with the CONTESTED events searched from the deployment block (the
//          behaviour before the time-window search), for comparison;
//   anvil: one client, runs back to back, against a local anvil fork of Sepolia pinned to one block
//          (after one unrecorded warm-up run that fills anvil's fork cache), to separate computation
//          from network latency. The time spent waiting for anvil is recorded per run as well.
// It also counts the non-zero storage words of the demo report and its claim (eth_getStorageAt) and
// writes a scalability projection computed from the recorded gas (labelled as projected, not measured).
// Every run must end VALID; the script exits 1 otherwise. Read only; no key needed.
//
// Usage: node scripts/bench-verify.ts [--n 20] [--rpc <url>] [--out <file.json>] [--no-anvil] [--anvil-port 18645]
//        node scripts/bench-verify.ts --child --rpc <url>   (one cold run; prints one JSON line; used by the cold series)
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  createPublicClient,
  encodeAbiParameters,
  formatUnits,
  hexToBigInt,
  http,
  keccak256,
  toHex,
  type PublicClient,
  type Transport,
} from "viem";
import { sepolia } from "viem/chains";
import {
  ChainReader,
  LOG_CHUNK,
  SEARCH_ROUNDS,
  SEARCH_TOLERANCE,
  SEPOLIA_RPCS,
  type ChainReaderOptions,
  type Deployment,
} from "../sdk/chain.ts";
import { batchKeyOf, reportKeyOf } from "../sdk/commitment.ts";
import type { Hex } from "../sdk/credential.ts";
import { vleiCheckers } from "../sdk/checkers.ts";
import { decodeDisclosure, type Presentation } from "../sdk/disclosure.ts";
import { verifyPresentation } from "../sdk/verify.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROOF = resolve(ROOT, "fixtures/sepolia-demo-proof.json");
const DEPLOYMENT = resolve(ROOT, "contracts/deployments/11155111.json");
const TX_LOG = resolve(ROOT, "fixtures/sepolia-tx.json");
const EORI = "NLDEMO000000001";

/** One verification: wall time, JSON-RPC requests in total and per method, time spent waiting for responses. */
export interface RunRecord {
  ms: number;
  rpcRequests: number;
  byMethod: Record<string, number>;
  /** Summed request duration per method. */
  byMethodMs: Record<string, number>;
  /** Sum of the durations of all requests (they overlap when sent in parallel, so this can exceed `ms`). */
  rpcWaitMsSum: number;
  /** Wall time during which at least one request was in flight (the union of the request intervals). */
  rpcBusyMs: number;
  overall: string;
}

/**
 * A viem public client whose http transport counts and times every JSON-RPC request. Retries are
 * off (retryCount 0), so each counted request is one HTTP request; requests are not batched.
 */
export function countingClient(url: string) {
  let log: { method: string; start: number; end: number }[] = [];
  const base = http(url, { retryCount: 0 });
  const transport: Transport = (opts) => {
    const t = base(opts);
    return {
      ...t,
      request: (async (args: { method: string }, o?: unknown) => {
        const start = performance.now();
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, o);
        } finally {
          log.push({ method: args.method, start, end: performance.now() });
        }
      }) as typeof t.request,
    };
  };
  const client = createPublicClient({ chain: sepolia, transport }) as PublicClient;
  return {
    client,
    reset() {
      log = [];
    },
    stats(): Omit<RunRecord, "ms" | "overall"> {
      const byMethod: Record<string, number> = {};
      const byMethodMs: Record<string, number> = {};
      for (const l of log) {
        byMethod[l.method] = (byMethod[l.method] ?? 0) + 1;
        byMethodMs[l.method] = round((byMethodMs[l.method] ?? 0) + l.end - l.start);
      }
      const sorted = [...log].sort((a, b) => a.start - b.start);
      let busy = 0;
      let curS = 0;
      let curE = -Infinity;
      for (const l of sorted) {
        if (l.start > curE) {
          if (curE > curS) busy += curE - curS;
          curS = l.start;
          curE = l.end;
        } else if (l.end > curE) curE = l.end;
      }
      if (curE > curS) busy += curE - curS;
      return {
        rpcRequests: log.length,
        byMethod,
        byMethodMs,
        rpcWaitMsSum: round(log.reduce((s, l) => s + (l.end - l.start), 0)),
        rpcBusyMs: round(busy),
      };
    },
  };
}

const round = (x: number) => Math.round(x * 10) / 10;

const loadBundle = async (p: string) => readFileSync(resolve(dirname(PROOF), p), "utf8");

async function verifyOnce(reader: ChainReader, proof: Presentation) {
  const t0 = performance.now();
  const r = await verifyPresentation(proof, reader, { importerEORI: EORI, checkers: vleiCheckers({ loadBundle }) });
  return { ms: round(performance.now() - t0), overall: r.overall };
}

async function series(
  url: string,
  n: number,
  deployment: Deployment,
  proof: Presentation,
  options: ChainReaderOptions = {},
): Promise<RunRecord[]> {
  const c = countingClient(url);
  const reader = new ChainReader(c.client, deployment, undefined, options);
  await verifyOnce(reader, proof); // warm-up, not recorded
  const runs: RunRecord[] = [];
  for (let i = 0; i < n; i++) {
    c.reset();
    const v = await verifyOnce(reader, proof);
    runs.push({ ms: v.ms, ...c.stats(), overall: v.overall });
  }
  return runs;
}

/** Child mode: one cold verification in a fresh process; `sinceProcessStartMs` includes module loading. */
async function child(url: string) {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as Deployment;
  const proof = JSON.parse(readFileSync(PROOF, "utf8")) as Presentation;
  const c = countingClient(url);
  const reader = new ChainReader(c.client, deployment);
  const v = await verifyOnce(reader, proof);
  const rec = { ms: v.ms, ...c.stats(), overall: v.overall, sinceProcessStartMs: round(performance.now()) };
  process.stdout.write(JSON.stringify(rec) + "\n");
}

function coldRun(url: string): Promise<RunRecord & { sinceProcessStartMs: number; processWallMs: number }> {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    const p = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(import.meta.url), "--child", "--rpc", url],
      { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const processWallMs = round(performance.now() - t0);
      if (code !== 0) return rej(new Error(`cold run exited with ${code}`));
      res({ ...JSON.parse(out.trim().split("\n").pop()!), processWallMs });
    });
  });
}

/** Nearest-rank percentile. */
export function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}

export function summary(xs: number[]) {
  return { p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), min: Math.min(...xs), max: Math.max(...xs) };
}

async function rpcJson(url: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function startAnvilFork(forkUrl: string, block: number, port: number) {
  const url = `http://127.0.0.1:${port}`;
  const p = spawn("anvil", ["--fork-url", forkUrl, "--fork-block-number", String(block), "--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      await rpcJson(url, "eth_chainId");
      return { url, stop: () => p.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  p.kill();
  throw new Error("anvil did not start (is Foundry on PATH?)");
}

function sizes() {
  const proofText = readFileSync(PROOF);
  const proof = JSON.parse(proofText.toString("utf8"));
  const bundlePath = resolve(dirname(PROOF), proof.authorityEvidence.bundle);
  const bundle = readFileSync(bundlePath);
  const gz = (b: Buffer) => gzipSync(b, { level: 9 }).length;
  return {
    proofFile: "fixtures/sepolia-demo-proof.json",
    proofBytes: proofText.length,
    proofGzipBytes: gz(proofText),
    evidenceBundleFile: `fixtures/${proof.authorityEvidence.bundle}`,
    evidenceBundleBytes: bundle.length,
    evidenceBundleGzipBytes: gz(bundle),
    gzipNote: "gzip level 9 (node:zlib); the KEL anchor evidence is inline in the proof",
  };
}

function machine() {
  const c = cpus();
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return {
    cpu: c[0]?.model ?? "unknown",
    logicalCpus: c.length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
    commit: git.status === 0 ? git.stdout.trim() : "unknown",
  };
}

const word = (key: Hex, slot: bigint) =>
  hexToBigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, slot])));

/**
 * Non-zero storage words of the demo report and its shipment on the registry, read with eth_getStorageAt
 * at the latest block. Base slots from `forge inspect EmissionsClaimRegistry storage-layout`:
 * _reports 0 (ReportRecord, 13 words), shipments 1 (Shipment, 4), reportScopes 2 (ReportScope, 3),
 * credScopes 3 (nested mapping to CredScope, 2).
 */
async function demoStorage(url: string, deployment: Deployment, proof: Presentation) {
  const client = createPublicClient({ chain: sepolia, transport: http(url) }) as PublicClient;
  const registry = deployment.contracts.EmissionsClaimRegistry.address;
  const core = JSON.parse(proof.core) as { d: string };
  const fields = Object.fromEntries(proof.disclosures.map((e) => [decodeDisclosure(e).name, decodeDisclosure(e).value]));
  const reportKey = reportKeyOf(core.d);
  const batchKey = batchKeyOf(reportKey, proof.shipment!.batchId, fields.batchSalt as Hex);
  const blockNumber = await client.getBlockNumber();
  const rep = await new ChainReader(client, deployment).at(blockNumber).report(reportKey);
  const nonZero = async (base: bigint, words: number) => {
    let n = 0;
    for (let i = 0n; i < BigInt(words); i++) {
      const v = await client.getStorageAt({ address: registry, slot: toHex(base + i, { size: 32 }), blockNumber });
      if (v && hexToBigInt(v) !== 0n) n++;
    }
    return { words, nonZero: n };
  };
  return {
    method:
      "eth_getStorageAt on every word of the demo report's records at the latest block; base slots from `forge inspect EmissionsClaimRegistry storage-layout`. The demo report is a first report in its scope with one claim against it",
    blockNumber: Number(blockNumber),
    reportRecord: await nonZero(word(reportKey, 0n), 13),
    reportScope: await nonZero(word(rep.reportScopeKey, 2n), 3),
    credScope: await nonZero(word(rep.credScopeKey, word(rep.reportScopeKey, 3n)), 2),
    shipment: await nonZero(word(batchKey, 1n), 4),
  };
}

/**
 * Scalability projection (computed, not measured) from the gas in the Sepolia receipts
 * (fixtures/sepolia-tx.json) and the storage words counted by `demoStorage`.
 */
export function projection(gasRegister: number, gasClaim: number, logBlockSpan: number, windowedGetLogs = 2) {
  const gwei = [1, 5, 20];
  const eth = (gas: number) => Object.fromEntries(gwei.map((g) => [`${g} gwei`, formatUnits(BigInt(gas) * BigInt(g), 9)]));
  const cases: [number, number][] = [
    [1, 1],
    [10, 100],
    [100, 1_000],
    [1_000, 10_000],
  ];
  const blocksPerDay = 7_200;
  const getLogs = (span: number) => 2 * Math.ceil(span / Number(LOG_CHUNK));
  // 24 h of blocks plus the largest margin left on each side once the search has converged.
  const windowLogs = getLogs(blocksPerDay + 2 * Number(SEARCH_TOLERANCE) + 1);
  return {
    label: "PROJECTED, NOT MEASURED: computed from the measured gas and storage figures; no ETH-to-currency conversion",
    gasFormula: `gas(N, M) = ${gasRegister} * N + ${gasClaim} * M (N reports, M shipment claims)`,
    slotFormula: "slots(N, M) = 14 * N + 4 * M + L, where L <= N is the number of reports with at least one claim; bytes = 32 * slots",
    assumptions: [
      "every report is a first report in a new installation and reporting period (ReportRecord 10 non-zero words + ReportScope 3 + CredScope.latestReportKey 1 = 14); a revision or take-over writes a different set of words and has not been measured here",
      "every claim is priced at the measured first-claim gas; a later claim against the same report does not turn CredScope.claimedKg from zero to non-zero, so it should cost less (not measured)",
      "onboarding (addVerifier 163,521 gas, addAuditor 75,119 gas) is once per body and per auditor and is not included",
      "neither contract has a loop or a growing array: registerReport and claimShipment write fixed sets of mapping entries, so the gas per operation does not depend on N or M",
      "L2 would be lower; not measured",
    ],
    perOperationEth: {
      registerReport: { gas: gasRegister, eth: eth(gasRegister) },
      claimShipment: { gas: gasClaim, eth: eth(gasClaim) },
      oneReportOneClaim: { gas: gasRegister + gasClaim, eth: eth(gasRegister + gasClaim) },
    },
    cases: cases.map(([N, M]) => {
      const gas = gasRegister * N + gasClaim * M;
      const slots = 14 * N + 4 * M + Math.min(N, M);
      return { N, M, gas, eth: eth(gas), slots, bytes: 32 * slots, slotNote: "L = min(N, M)" };
    }),
    verifier: {
      viewCalls:
        "7 eth_call per verification, each a fixed number of mapping lookups (sdk/verify.ts round 0 and 1, sdk/checkers.ts; contracts/src/EmissionsClaimRegistry.sol reports, shipmentStatus, remainingKg, reportScopes, isValidAt; VerifierAllowlist institutions, auditors): independent of N and M",
      eventSearches: `eth_getLogs per verification = 2 * ceil(S / ${LOG_CHUNK}), S = the blocks from a block before registeredAt to a block after registeredAt + 24 h, found by interpolation search (sdk/chain.ts blockRangeForTimes; AuditorRevoked and VerifierSuspended, filtered by indexed topics): S <= 24 h of blocks (${blocksPerDay} at 12 s) + a margin of at most ${SEARCH_TOLERANCE} blocks on each side once the search has converged, so 2 requests, independent of the age of the deployment and of N and M`,
      blockSearch: `eth_getBlockByNumber per verification = 1 (block B) + 1 (the deployment block, read once per reader) + at most ${2 * 2 * SEARCH_ROUNDS} for the search (2 bounds, at most ${SEARCH_ROUNDS} rounds of 2 parallel reads each); also independent of the age of the deployment`,
      fallback: `if a block read fails, the whole range from the deployment block is searched, as before: 2 * ceil(blockSpan / ${LOG_CHUNK}) eth_getLogs, blockSpan = latest block - deployment block + 1 (fail-safe, never a narrower range)`,
      measuredBlockSpan: logBlockSpan,
      measuredGetLogs: windowedGetLogs,
      fullScanGetLogs: getLogs(logBlockSpan),
      projectedGetLogs: {
        assumption: `${blocksPerDay} blocks per day (12 s slots, no missed slots)`,
        "30 days": windowLogs,
        "1 year": windowLogs,
        fullScanFallback: { "30 days": getLogs(30 * blocksPerDay), "1 year": getLogs(365 * blocksPerDay) },
      },
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      n: { type: "string", default: "20" },
      rpc: { type: "string", default: SEPOLIA_RPCS[0] },
      out: { type: "string" },
      child: { type: "boolean", default: false },
      "no-anvil": { type: "boolean", default: false },
      "anvil-port": { type: "string", default: "18645" },
    },
  });
  const url = values.rpc as string;
  if (values.child) return child(url);

  const n = Number(values.n);
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as Deployment;
  const proof = JSON.parse(readFileSync(PROOF, "utf8")) as Presentation;
  const startedAt = new Date().toISOString();
  const date = startedAt.slice(0, 10);

  console.log(`cold: ${n} runs, each in a new process, against ${url}`);
  const cold = [];
  for (let i = 0; i < n; i++) {
    const r = await coldRun(url);
    cold.push(r);
    console.log(`  cold ${i + 1}: ${r.ms} ms, ${r.rpcRequests} requests, ${r.overall}`);
  }
  console.log(`warm: ${n} runs on one client against ${url}`);
  const warm = await series(url, n, deployment, proof);
  warm.forEach((r, i) => console.log(`  warm ${i + 1}: ${r.ms} ms, ${r.rpcRequests} requests, ${r.overall}`));
  console.log(`warmFullScan: ${n} runs on one client against ${url}, events searched from the deployment block`);
  const warmFullScan = await series(url, n, deployment, proof, { fullEventScan: true });
  warmFullScan.forEach((r, i) =>
    console.log(`  warmFullScan ${i + 1}: ${r.ms} ms, ${r.rpcRequests} requests, ${r.overall}`),
  );

  let anvil: { forkBlock: number; runs: RunRecord[] } | undefined;
  if (!values["no-anvil"]) {
    const head = Number(BigInt((await rpcJson(url, "eth_blockNumber")) as string));
    const a = await startAnvilFork(url, head, Number(values["anvil-port"]));
    try {
      console.log(`anvil: fork of ${url} at block ${head}; ${n} runs on one client against ${a.url}`);
      const runs = await series(a.url, n, deployment, proof);
      runs.forEach((r, i) =>
        console.log(`  anvil ${i + 1}: ${r.ms} ms, ${r.rpcRequests} requests, rpc busy ${r.rpcBusyMs} ms, ${r.overall}`),
      );
      anvil = { forkBlock: head, runs };
    } finally {
      a.stop();
    }
  }

  const storage = await demoStorage(url, deployment, proof);
  const txs = JSON.parse(readFileSync(TX_LOG, "utf8")).txs as { step: string; gasUsed: number }[];
  const gasOf = (step: string) => txs.find((t) => t.step === step)!.gasUsed;
  const latest = anvil?.forkBlock ?? storage.blockNumber;
  const c = deployment.contracts;
  const logBlockSpan = latest - Math.min(c.VerifierAllowlist.block, c.EmissionsClaimRegistry.block) + 1;

  const all = [...cold, ...warm, ...warmFullScan, ...(anvil?.runs ?? [])];
  const windowedGetLogs = Math.max(...[...cold, ...warm].map((r) => r.byMethod.eth_getLogs ?? 0));
  const bad = all.filter((r) => r.overall !== "VALID");
  const out = {
    description:
      "Raw output of scripts/bench-verify.ts: SDK verifyPresentation on the demo proof with the importer's EORI and the vLEI checkers (checks 0-8), times in milliseconds. Percentiles are nearest-rank. One machine, one network; not a load test.",
    startedAt,
    finishedAt: new Date().toISOString(),
    rpc: url,
    machine: machine(),
    sizes: sizes(),
    n,
    storage,
    projection: projection(gasOf("registerReport1"), gasOf("claim1"), logBlockSpan, windowedGetLogs),
    cold: {
      method:
        "a new Node process and a new viem client per run; `ms` is the verifyPresentation call, `sinceProcessStartMs` adds module loading, `processWallMs` is measured by the parent from spawn to exit",
      summaryMs: summary(cold.map((r) => r.ms)),
      summaryProcessWallMs: summary(cold.map((r) => r.processWallMs)),
      summaryRpcRequests: summary(cold.map((r) => r.rpcRequests)),
      runs: cold,
    },
    warm: {
      method: "one viem client, runs back to back after one unrecorded warm-up run",
      summaryMs: summary(warm.map((r) => r.ms)),
      summaryRpcRequests: summary(warm.map((r) => r.rpcRequests)),
      runs: warm,
    },
    warmFullScan: {
      method:
        "as warm, but the reader searches the CONTESTED events from the deployment block (ChainReaderOptions.fullEventScan, the behaviour before the time-window search), for comparison; run right after the warm series",
      summaryMs: summary(warmFullScan.map((r) => r.ms)),
      summaryRpcRequests: summary(warmFullScan.map((r) => r.rpcRequests)),
      runs: warmFullScan,
    },
    anvil: anvil && {
      method:
        "local anvil fork of the same RPC pinned to forkBlock, one viem client, runs back to back after one unrecorded warm-up run that fills anvil's fork cache; `rpcBusyMs` is the time with at least one request in flight, so `ms - rpcBusyMs` bounds the computation time from below",
      forkBlock: anvil.forkBlock,
      summaryMs: summary(anvil.runs.map((r) => r.ms)),
      summaryRpcBusyMs: summary(anvil.runs.map((r) => r.rpcBusyMs)),
      summaryOutsideRpcMs: summary(anvil.runs.map((r) => round(r.ms - r.rpcBusyMs))),
      summaryRpcRequests: summary(anvil.runs.map((r) => r.rpcRequests)),
      runs: anvil.runs,
    },
  };
  const path = resolve(ROOT, (values.out as string) ?? `docs/data/bench-verify-${date}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote ${path}`);
  console.log(
    JSON.stringify(
      { cold: out.cold.summaryMs, warm: out.warm.summaryMs, warmFullScan: out.warmFullScan.summaryMs, anvil: out.anvil?.summaryMs },
      null,
      2,
    ),
  );
  if (bad.length) {
    console.error(`${bad.length} run(s) did not end VALID`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
