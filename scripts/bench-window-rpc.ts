// Read-only measurement of the verifier's 24 h event search against public RPCs of chains with fast blocks
// (ADOPTION §6.1 "Limits": how many eth_getLogs requests one contested window needs at 2 s or 0.25 s blocks).
// Nothing is deployed, signed or sent; no key is needed.
//
// For each RPC URL it runs the SDK's own code, not a copy of it: a ChainReader (sdk/chain.ts) over that single URL,
// with a deployment record whose two contract addresses are CarbonLEI's Sepolia addresses, which have no code and
// no logs on the measured chain (the realistic case: our contracts emit very few events), and whose deployment block
// is placed `--deploy-days` before the head, so the time-window search has history to narrow. It then calls
// `bodyEventsInTimes` for one closed 24 h window ending `--end-hours-ago` before the head (a block search,
// `blockRangeForTimes`, then one eth_getLogs per chunk of at most LOG_CHUNK blocks, LOG_PARALLEL at once), as
// verifyPresentation does for a proof whose window has closed. Every JSON-RPC request is counted per method, with
// latency, block range and number of logs; errors are recorded with the node's message.
//
// Stress case (not an SDK path): the same block range, the same chunking and parallelism, but eth_getLogs on a busy
// contract (default the WETH predeploy 0x4200…0006 on OP-stack chains) with no topic filter. The SDK does not split a
// rejected range (any failed chunk fails the search closed); for the report only, a rejected chunk is then retried
// in halves (at most `--max-halvings` deep) to show which range the node accepts.
//
// Usage: node scripts/bench-window-rpc.ts --rpc https://sepolia.base.org[,https://...] [--chain-id 84532]
//        [--busy 0x4200000000000000000000000000000000000006] [--window-hours 24] [--end-hours-ago 1]
//        [--deploy-days 3] [--max-halvings 6] [--out docs/data/bench-window-<label>-<date>.json] [--label base-sepolia]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, createTransport, numberToHex, type PublicClient, type Transport } from "viem";
import { ChainReader, LOG_CHUNK, LOG_PARALLEL, SEARCH_TOLERANCE, errorDetail, timedHttp, type Deployment } from "../sdk/chain.ts";
import type { Hex } from "../sdk/credential.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    rpc: { type: "string" },
    "chain-id": { type: "string", default: "84532" },
    busy: { type: "string", default: "0x4200000000000000000000000000000000000006" },
    "window-hours": { type: "string", default: "24" },
    "end-hours-ago": { type: "string", default: "1" },
    "deploy-days": { type: "string", default: "3" },
    "max-halvings": { type: "string", default: "6" },
    label: { type: "string", default: "base-sepolia" },
    out: { type: "string" },
  },
});
if (!args.rpc) throw new Error("--rpc <url[,url...]> is required");
const urls = args.rpc.split(",").map((s) => s.trim()).filter(Boolean);
const chainId = Number(args["chain-id"]);
const windowSec = BigInt(Math.round(Number(args["window-hours"]) * 3600));
const endAgoSec = BigInt(Math.round(Number(args["end-hours-ago"]) * 3600));
const deployDays = Number(args["deploy-days"]);
const maxHalvings = Number(args["max-halvings"]);
const date = new Date().toISOString().slice(0, 10);
const outPath = resolve(root, args.out ?? `docs/data/bench-window-${args.label}-${date}.json`);

// CarbonLEI's Sepolia deployment addresses (fixtures/deployments); on another chain they hold no code and no logs.
const QUIET_ALLOWLIST: Hex = "0xF7AD0cbe867eb9CE4847Af3717C2d27f6434Ea5C";
const QUIET_REGISTRY: Hex = "0xEA52a50d3753bACD835DCd47892754b65a90ca19";
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

interface Req {
  method: string;
  ms: number;
  ok: boolean;
  fromBlock?: number;
  toBlock?: number;
  blocks?: number;
  logs?: number;
  error?: string;
}

/** A single-URL transport (the SDK's timedHttp, no retries, so every rejection is seen) that records each request. */
function recording(url: string, log: Req[]): Transport {
  const inner = timedHttp(url, { retryCount: 0, timeoutMs: 30_000 });
  return ((config: Parameters<Transport>[0]) => {
    const node = inner(config);
    return createTransport(
      {
        key: "recording",
        name: "recording",
        type: "http",
        retryCount: 0,
        async request(a: { method: string; params?: unknown }): Promise<any> {
          const t0 = performance.now();
          const r: Req = { method: a.method, ms: 0, ok: false };
          if (a.method === "eth_getLogs") {
            const p = (a.params as { fromBlock: Hex; toBlock: Hex }[])[0];
            r.fromBlock = Number(BigInt(p.fromBlock));
            r.toBlock = Number(BigInt(p.toBlock));
            r.blocks = r.toBlock - r.fromBlock + 1;
          }
          try {
            const res = await node.request(a as never);
            r.ok = true;
            if (Array.isArray(res)) r.logs = res.length;
            return res;
          } catch (err) {
            r.error = errorDetail(err).slice(0, 400);
            throw err;
          } finally {
            r.ms = Math.round((performance.now() - t0) * 10) / 10;
            log.push(r);
          }
        },
      },
      { url },
    );
  }) as Transport;
}

const summary = (log: Req[], ms: number) => {
  const by: Record<string, number> = {};
  for (const r of log) by[r.method] = (by[r.method] ?? 0) + 1;
  const gl = log.filter((r) => r.method === "eth_getLogs");
  return {
    requestsByMethod: by,
    requestsTotal: log.length,
    getLogsRequests: gl.length,
    getLogsRejected: gl.filter((r) => !r.ok).length,
    logsReturned: gl.reduce((s, r) => s + (r.logs ?? 0), 0),
    blocksSearched: gl.filter((r) => r.ok).reduce((s, r) => s + (r.blocks ?? 0), 0),
    wallMs: Math.round(ms),
    errors: [...new Set(log.filter((r) => !r.ok).map((r) => r.error))],
  };
};

async function runOne(url: string) {
  const probe = createPublicClient({ transport: timedHttp(url, { retryCount: 2, timeoutMs: 30_000 }) }) as PublicClient;
  const reported = await probe.getChainId();
  if (reported !== chainId) throw new Error(`${url} reports chain ${reported}, expected ${chainId}`);
  const headBlock = await probe.getBlock({ blockTag: "latest" });
  const head = { number: headBlock.number, timestamp: headBlock.timestamp };
  // Average block time over the last 10,000 blocks, from two block reads (for the report).
  const back = await probe.getBlock({ blockNumber: head.number - 10_000n });
  const blockTimeSec = Number(head.timestamp - back.timestamp) / 10_000;
  const deployBlock = Number(head.number) - Math.round((deployDays * 86_400) / blockTimeSec);
  const deployment: Deployment = {
    chainId,
    maxHeadAgeSec: null,
    contracts: {
      VerifierAllowlist: { address: QUIET_ALLOWLIST, block: deployBlock },
      EmissionsClaimRegistry: { address: QUIET_REGISTRY, block: deployBlock },
    },
  };
  const to = head.timestamp - endAgoSec;
  const from = to - windowSec;

  // Realistic case: the SDK's bodyEventsInTimes over the quiet addresses.
  const quietLog: Req[] = [];
  const reader = new ChainReader(
    createPublicClient({ transport: recording(url, quietLog) }) as PublicClient,
    deployment,
    head.number,
  );
  const range = await reader.blockRangeForTimes(from, to, head);
  const quietLog2: Req[] = [];
  const reader2 = new ChainReader(createPublicClient({ transport: recording(url, quietLog2) }) as PublicClient, deployment, head.number);
  let quietError: string | undefined;
  let events = -1;
  const t0 = performance.now();
  try {
    events = (await reader2.bodyEventsInTimes(H(1), H(2), [[from, to]], head, H(3))).length;
  } catch (err) {
    quietError = errorDetail(err).slice(0, 400);
  }
  const quietMs = performance.now() - t0;

  // Stress case: same range, same chunking, busy address, no topic filter.
  const busyLog: Req[] = [];
  const busyClient = createPublicClient({ transport: recording(url, busyLog) }) as PublicClient;
  const getLogs = (a: bigint, b: bigint) =>
    busyClient.request({
      method: "eth_getLogs",
      params: [{ address: args.busy as Hex, fromBlock: numberToHex(a), toBlock: numberToHex(b) }],
    } as never) as Promise<unknown[]>;
  const chunks: [bigint, bigint][] = [];
  for (let a = range.fromBlock; a <= range.toBlock; a += LOG_CHUNK) {
    chunks.push([a, a + LOG_CHUNK - 1n < range.toBlock ? a + LOG_CHUNK - 1n : range.toBlock]);
  }
  const rejected: [bigint, bigint][] = [];
  const t1 = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOG_PARALLEL, chunks.length) }, async () => {
      while (next < chunks.length) {
        const c = chunks[next++];
        try {
          await getLogs(c[0], c[1]);
        } catch {
          rejected.push(c);
        }
      }
    }),
  );
  const busyMs = performance.now() - t1;
  // Report only: split the first rejected chunk in halves until the node accepts a range.
  let halvings = 0;
  let acceptedRange: number | undefined;
  if (rejected.length) {
    let [a, b] = rejected[0];
    while (halvings < maxHalvings) {
      b = a + (b - a + 1n) / 2n - 1n;
      halvings++;
      try {
        await getLogs(a, b);
        acceptedRange = Number(b - a + 1n);
        break;
      } catch {
        /* keep halving */
      }
    }
  }

  return {
    url,
    chainId: reported,
    head: { number: Number(head.number), timestamp: Number(head.timestamp), iso: new Date(Number(head.timestamp) * 1000).toISOString() },
    avgBlockTimeSecLast10k: blockTimeSec,
    window: {
      fromTime: Number(from),
      toTime: Number(to),
      hours: Number(windowSec) / 3600,
      endsSecBeforeHead: Number(endAgoSec),
    },
    deploymentBlockAssumed: deployBlock,
    blockRange: { fromBlock: Number(range.fromBlock), toBlock: Number(range.toBlock), blocks: Number(range.toBlock - range.fromBlock + 1n), narrowed: range.narrowed },
    blockSearchOnly: summary(quietLog, 0),
    realistic: {
      description: "SDK ChainReader.bodyEventsInTimes (block search + chunked eth_getLogs), two addresses with no logs on this chain, topic filters as the verifier sends them",
      addresses: [QUIET_ALLOWLIST, QUIET_REGISTRY],
      eventsReturned: events,
      error: quietError,
      ...summary(quietLog2, quietMs),
      requests: quietLog2,
    },
    stress: {
      description: "same block range and chunking (LOG_CHUNK, LOG_PARALLEL), eth_getLogs on a busy address with no topic filter; not an SDK path",
      address: args.busy,
      chunks: chunks.length,
      chunksRejected: rejected.length,
      reportOnlyHalvingsOfFirstRejectedChunk: halvings,
      reportOnlyAcceptedRangeBlocks: acceptedRange,
      ...summary(busyLog, busyMs),
      requests: busyLog,
    },
  };
}

const runs = [];
for (const url of urls) {
  process.stderr.write(`${url} ...\n`);
  try {
    const r = await runOne(url);
    process.stderr.write(
      `  range ${r.blockRange.blocks} blocks; realistic: ${r.realistic.getLogsRequests} getLogs (${r.realistic.getLogsRejected} rejected), ${r.realistic.requestsTotal} requests, ${r.realistic.wallMs} ms, ${r.realistic.logsReturned} logs${r.realistic.error ? `, ERROR ${r.realistic.error}` : ""}; stress: ${r.stress.getLogsRequests} getLogs, ${r.stress.chunksRejected} rejected, ${r.stress.logsReturned} logs, ${r.stress.wallMs} ms\n`,
    );
    runs.push(r);
  } catch (err) {
    process.stderr.write(`  failed: ${errorDetail(err)}\n`);
    runs.push({ url, error: errorDetail(err).slice(0, 400) });
  }
}

const out = {
  script: "scripts/bench-window-rpc.ts",
  measuredAt: new Date().toISOString(),
  label: args.label,
  conditions: {
    note: "Public testnet RPCs, single run per endpoint, from one client machine; latency varies with the node, the network and load. Read-only: no deployment, no transaction, no key.",
    sdkConstants: { LOG_CHUNK: Number(LOG_CHUNK), LOG_PARALLEL, SEARCH_TOLERANCE: Number(SEARCH_TOLERANCE) },
    windowHours: Number(windowSec) / 3600,
    deployDaysBeforeHead: deployDays,
  },
  runs,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
process.stderr.write(`wrote ${outPath}\n`);
