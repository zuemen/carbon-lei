// Read-only access to the two contracts on Sepolia (or a local anvil): views, events,
// revert decoding and dry runs (eth_call) for the "Try to break it" counterexamples.
// Never sends transactions and never needs a private key.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTransport,
  http,
  shouldThrow,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { sepolia } from "viem/chains";
import { emissionsClaimRegistryAbi, verifierAllowlistAbi } from "./abi.ts";
import type { Hex } from "./credential.ts";
import { DEFAULT_MAX_HEAD_AGE_SEC } from "./verify.ts";

export { sepolia as SEPOLIA_CHAIN };

/**
 * Public Sepolia RPCs with CORS, tried in this order. Each kept the full history on 2026-10-07:
 * the receipt of the deployment transaction (block 11,846,766), `eth_getLogs` over 10,000 blocks
 * from the deployment block and `eth_call` at a block just after it all answered.
 * Only full-history nodes are listed. A node that prunes old history (publicnode drops history
 * older than about 36 hours) can answer an event search over a pruned range with an empty list
 * instead of an error, which would hide a revocation; so such a node is never used by default.
 */
export const SEPOLIA_RPCS = [
  "https://rpc.sepolia.ethpandaops.io",
  "https://sepolia.gateway.tenderly.co",
  "https://gateway.tenderly.co/public/sepolia",
];
/** Largest getLogs range used against public RPCs. */
export const LOG_CHUNK = 10_000n;
/** At most this many getLogs requests in flight at once (public RPCs rate-limit bursts). */
export const LOG_PARALLEL = 4;
/**
 * Block search for a time window (`blockRangeForTimes`): at most this many rounds of getBlock reads
 * per bound (2 reads in parallel per round).
 */
export const SEARCH_ROUNDS = 4;
/** The search stops once a bound is known to within this many blocks (the log range then has this much margin). */
export const SEARCH_TOLERANCE = 512n;
/** Smallest margin, in blocks, put on each side of an interpolated estimate. */
export const SEARCH_MIN_SLACK = 16n;
/** Block timestamps read by the search are reused only for blocks at least this deep below the snapshot. */
const CACHE_DEPTH = 128n;
/** At most this many block timestamps are kept per reader (the cache is cleared when full). */
const CACHE_BLOCKS = 4096;

export interface ChainReaderOptions {
  /**
   * Search events from the deployment block, as before the time-window search was added
   * (`blockRangeForTimes` then always returns the whole range). Reference mode for tests and audits.
   */
  fullEventScan?: boolean;
  /** Overrides `SEARCH_TOLERANCE` (tests use 0 to make the search tighten every bound as far as it can). */
  searchTolerance?: bigint;
}

/** A block range for an event search, and whether it was narrowed (false: the whole range from deployment). */
export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
  narrowed: boolean;
}

export interface Deployment {
  chainId: number;
  contracts: {
    VerifierAllowlist: { address: Hex; block: number };
    EmissionsClaimRegistry: { address: Hex; block: number };
  };
}

export interface ReportRecord {
  verifier: Hex;
  issuerLeiHash: Hex;
  auditorAidHash: Hex;
  kelSeq: bigint;
  supplier: Hex;
  supplierCommit: Hex;
  installationCommit: Hex;
  verifiedKg: bigint;
  validUntil: bigint;
  registeredAt: bigint;
  revokedAt: bigint;
  reportIdHash: Hex;
  reportScopeKey: Hex;
  credScopeKey: Hex;
  supersedes: Hex;
  supersededBy: Hex;
}

export interface ShipmentStatus {
  reportKey: Hex;
  quantityKg: bigint;
  importerCommit: Hex;
  verifier: Hex;
  claimedAt: bigint;
  reportValid: boolean;
}

export interface TimedEvent {
  time: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

export class ChainReader {
  readonly client: PublicClient;
  readonly allowlist: Hex;
  readonly registry: Hex;
  readonly fromBlock: bigint;
  /** Block in which the later of the two contracts was deployed. */
  readonly deployedBlock: bigint;
  /** When set (see `at`), every view call and event search reads this block, not the latest one. */
  readonly blockNumber?: bigint;
  readonly options: ChainReaderOptions;
  /** Chain ID the deployment file names; verification refuses an RPC that reports another one. */
  readonly chainId: number;
  private readonly deployment: Deployment;
  /**
   * Shared with the readers made by `at`: the deployment block's timestamp, read once, and the
   * timestamps the block search has read of blocks at least `CACHE_DEPTH` below the snapshot.
   */
  private cache: { deploymentTimestamp?: Promise<bigint>; blocks: Map<bigint, bigint> } = { blocks: new Map() };

  constructor(client: PublicClient, deployment: Deployment, blockNumber?: bigint, options: ChainReaderOptions = {}) {
    this.client = client;
    this.deployment = deployment;
    this.blockNumber = blockNumber;
    this.options = options;
    this.chainId = deployment.chainId;
    this.allowlist = deployment.contracts.VerifierAllowlist.address;
    this.registry = deployment.contracts.EmissionsClaimRegistry.address;
    this.fromBlock = BigInt(
      Math.min(deployment.contracts.VerifierAllowlist.block, deployment.contracts.EmissionsClaimRegistry.block),
    );
    this.deployedBlock = BigInt(
      Math.max(deployment.contracts.VerifierAllowlist.block, deployment.contracts.EmissionsClaimRegistry.block),
    );
  }

  /** A reader on the same RPC whose views and event searches all read block `blockNumber` (one snapshot). */
  at(blockNumber: bigint): ChainReader {
    const r = new ChainReader(this.client, this.deployment, blockNumber, this.options);
    r.cache = this.cache;
    return r;
  }

  /**
   * Timestamp of the deployment block (`fromBlock`), read once per reader and the readers made from it
   * by `at`; a failed read is not kept. The block is final, so the value does not depend on the snapshot.
   */
  deploymentTimestamp(): Promise<bigint> {
    if (!this.cache.deploymentTimestamp) {
      const p = this.client.getBlock({ blockNumber: this.fromBlock }).then((b) => b.timestamp);
      this.cache.deploymentTimestamp = p;
      p.catch(() => {
        if (this.cache.deploymentTimestamp === p) this.cache.deploymentTimestamp = undefined;
      });
    }
    return this.cache.deploymentTimestamp;
  }

  static forSepolia(deployment: Deployment, rpcUrls: string[] = SEPOLIA_RPCS, options?: ChainReaderOptions): ChainReader {
    return ChainReader.forRpc(deployment, rpcUrls, sepolia, options);
  }

  /**
   * Several URLs: tried in order (`historyFallback`), and a node whose latest block is older than the deployment
   * chain's head-age limit (`DEFAULT_MAX_HEAD_AGE_SEC`) is passed over for the next one.
   */
  static forRpc(deployment: Deployment, rpcUrls: string[], chain?: Chain, options?: ChainReaderOptions): ChainReader {
    const transport =
      rpcUrls.length === 1
        ? http(rpcUrls[0])
        : historyFallback(rpcUrls, { maxHeadAgeSec: DEFAULT_MAX_HEAD_AGE_SEC[deployment.chainId] });
    return new ChainReader(createPublicClient({ chain, transport }) as PublicClient, deployment, undefined, options);
  }

  private readRegistry<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.client.readContract({
      address: this.registry,
      abi: emissionsClaimRegistryAbi,
      functionName,
      args,
      blockNumber: this.blockNumber,
    } as never) as Promise<T>;
  }

  private readAllowlist<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.client.readContract({
      address: this.allowlist,
      abi: verifierAllowlistAbi,
      functionName,
      args,
      blockNumber: this.blockNumber,
    } as never) as Promise<T>;
  }

  report(reportKey: Hex): Promise<ReportRecord> {
    return this.readRegistry<ReportRecord>("reports", [reportKey]);
  }

  async reportScope(reportScopeKey: Hex) {
    const [reportIdHash, latestReportKey, boundAt] = await this.readRegistry<[Hex, Hex, bigint]>("reportScopes", [
      reportScopeKey,
    ]);
    return { reportIdHash, latestReportKey, boundAt };
  }

  /** Credential-layer ledger; keyed by the report scope and the credential scope together. */
  async credScope(reportScopeKey: Hex, credScopeKey: Hex) {
    const [claimedKg, latestReportKey] = await this.readRegistry<[bigint, Hex]>("credScopes", [
      reportScopeKey,
      credScopeKey,
    ]);
    return { claimedKg, latestReportKey };
  }

  reportIdUnboundAt(reportScopeKey: Hex, reportIdHash: Hex): Promise<bigint> {
    return this.readRegistry<bigint>("reportIdUnboundAt", [reportScopeKey, reportIdHash]);
  }

  async shipmentStatus(batchKey: Hex): Promise<ShipmentStatus> {
    const [reportKey, quantityKg, importerCommit, verifier, claimedAt, reportValid] = await this.readRegistry<
      [Hex, bigint, Hex, Hex, bigint, boolean]
    >("shipmentStatus", [batchKey]);
    return { reportKey, quantityKg, importerCommit, verifier, claimedAt, reportValid };
  }

  isValidAt(reportKey: Hex, t: bigint): Promise<boolean> {
    return this.readRegistry<boolean>("isValidAt", [reportKey, t]);
  }

  remainingKg(reportKey: Hex): Promise<bigint> {
    return this.readRegistry<bigint>("remainingKg", [reportKey]);
  }

  async institution(leiHash: Hex) {
    const [currentAddress, leCredSaidHash, accreditationSaidHash, accreditedUntil, addedAt, suspendedAt, liftedAt] =
      await this.readAllowlist<[Hex, Hex, Hex, bigint, bigint, bigint, bigint]>("institutions", [leiHash]);
    return { currentAddress, leCredSaidHash, accreditationSaidHash, accreditedUntil, addedAt, suspendedAt, liftedAt };
  }

  async addressBinding(addr: Hex) {
    const [leiHash, addressBoundAt, unboundAt] = await this.readAllowlist<[Hex, bigint, bigint]>("leiOfAddress", [addr]);
    return { leiHash, addressBoundAt, unboundAt };
  }

  async auditor(auditorAidHash: Hex, leiHash: Hex) {
    const [ecrSaidHash, addedAt, revokedAt] = await this.readAllowlist<[Hex, bigint, bigint]>("auditors", [
      auditorAidHash,
      leiHash,
    ]);
    return { ecrSaidHash, addedAt, revokedAt };
  }

  isInstitutionActiveAt(leiHash: Hex, t: bigint): Promise<boolean> {
    return this.readAllowlist<boolean>("isInstitutionActiveAt", [leiHash, t]);
  }

  async latestTimestamp(): Promise<bigint> {
    return (await this.latestBlock()).timestamp;
  }

  /** Number and timestamp of the latest block, in one request (of the pinned block, for a reader from `at`). */
  async latestBlock(): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.client.getBlock(this.blockNumber === undefined ? undefined : { blockNumber: this.blockNumber });
    return { number: b.number, timestamp: b.timestamp };
  }

  /**
   * `AuditorRevoked(auditorAidHash, leiHash)` events, with their `revokedAt`.
   * `toBlock` (default: the pinned block, else the latest block) lets a caller search up to a block it has already read;
   * `fromBlock` (default and lower limit: the deployment block) lets it start later, for example at a range from
   * `blockRangeForTimes`.
   */
  async auditorRevocations(auditorAidHash: Hex, leiHash: Hex, toBlock?: bigint, fromBlock?: bigint): Promise<TimedEvent[]> {
    const logs = await this.chunkedLogs(
      this.allowlist,
      verifierAllowlistAbi,
      "AuditorRevoked",
      { auditorAidHash, leiHash },
      toBlock,
      fromBlock,
    );
    return logs.map((l) => ({
      time: (l.args as { revokedAt: bigint }).revokedAt,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  }

  /** `VerifierSuspended(leiHash)` events, with their `suspendedAt`. `toBlock` and `fromBlock` as for `auditorRevocations`. */
  async suspensions(leiHash: Hex, toBlock?: bigint, fromBlock?: bigint): Promise<TimedEvent[]> {
    const logs = await this.chunkedLogs(
      this.allowlist,
      verifierAllowlistAbi,
      "VerifierSuspended",
      { leiHash },
      toBlock,
      fromBlock,
    );
    return logs.map((l) => ({
      time: (l.args as { suspendedAt: bigint }).suspendedAt,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  }

  /**
   * A block range that contains every block, up to `head` (default: the pinned block, else the latest
   * block), whose timestamp lies in [fromTime, toTime]. Both contracts stamp their events with
   * `block.timestamp`, so an event whose time lies in that interval was emitted inside the range.
   *
   * Interpolation search: the deployment block and `head` give the average block time; each round
   * estimates the boundary block (from the block time between the blocks read last) and reads, in
   * parallel, the two blocks a margin either side of the estimate. The range starts at
   * a block with timestamp < fromTime (or at the deployment block) and ends at a block with
   * timestamp > toTime (or at `head`); timestamps never decrease from block to block, so it is never
   * narrower than needed. A bound the search has not pinned down after `SEARCH_ROUNDS` rounds stays
   * at the last bracketing block, which is still on the safe side. Any read error gives the whole
   * range from the deployment block (fail-safe), as does a chain that has advanced by at most the
   * tolerance since the deployment (nothing to search).
   */
  async blockRangeForTimes(
    fromTime: bigint,
    toTime: bigint,
    head?: { number: bigint; timestamp: bigint },
  ): Promise<BlockRange> {
    const latest = head?.number ?? this.blockNumber ?? (await this.client.getBlockNumber({ cacheTime: 0 }));
    const whole: BlockRange = { fromBlock: this.fromBlock, toBlock: latest, narrowed: false };
    const tol = this.options.searchTolerance ?? SEARCH_TOLERANCE;
    if (this.options.fullEventScan || latest - this.fromBlock <= tol) return whole;
    const until = toTime < fromTime ? fromTime : toTime;
    try {
      const blocks = this.cache.blocks;
      const at = async (n: bigint): Promise<Probe> => {
        const cached = blocks.get(n);
        if (cached !== undefined) return { n, ts: cached };
        const ts = (await this.client.getBlock({ blockNumber: n })).timestamp;
        // Only blocks deep enough below the snapshot to be final are kept (a reorg cannot change them).
        if (n + CACHE_DEPTH <= latest) {
          if (blocks.size >= CACHE_BLOCKS) blocks.clear();
          blocks.set(n, ts);
        }
        return { n, ts };
      };
      const [first, last] = await Promise.all([
        this.deploymentTimestamp().then((ts) => ({ n: this.fromBlock, ts })),
        head ? { n: head.number, ts: head.timestamp } : at(latest),
      ]);
      if (last.ts < first.ts) return whole;
      // Lower bound: a block with timestamp < fromTime ("after" the boundary: timestamp >= fromTime).
      const lower = async () => {
        if (first.ts >= fromTime) return first.n;
        if (last.ts < fromTime) return last.n;
        return (await bracket(first, last, fromTime, (ts) => ts >= fromTime, at, tol)).lo.n;
      };
      // Upper bound: a block with timestamp > until ("after" the boundary: timestamp > until).
      const upper = async () => {
        if (last.ts <= until) return last.n;
        if (first.ts > until) return first.n;
        return (await bracket(first, last, until, (ts) => ts > until, at, tol)).hi.n;
      };
      const [fromBlock, toBlock] = await Promise.all([lower(), upper()]);
      return { fromBlock, toBlock, narrowed: true };
    } catch {
      return whole;
    }
  }

  /**
   * All matching logs in [fromBlock, toBlock] (defaults: the deployment block, and the pinned block or
   * else the latest block), in block order; chunks are read a few at a time in parallel.
   */
  private async chunkedLogs(
    address: Hex,
    abi: readonly unknown[],
    eventName: string,
    args: Record<string, Hex>,
    toBlock?: bigint,
    fromBlock?: bigint,
  ) {
    type Log = { args: unknown; blockNumber: bigint; transactionHash: Hex };
    const latest = toBlock ?? this.blockNumber ?? (await this.client.getBlockNumber({ cacheTime: 0 }));
    const start = fromBlock !== undefined && fromBlock > this.fromBlock ? fromBlock : this.fromBlock;
    const ranges: [bigint, bigint][] = [];
    for (let from = start; from <= latest; from += LOG_CHUNK) {
      ranges.push([from, from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest]);
    }
    const chunks: Log[][] = new Array(ranges.length);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const i = next++;
        const [from, to] = ranges[i];
        chunks[i] = (await this.client.getContractEvents({
          address,
          abi,
          eventName,
          args,
          fromBlock: from,
          toBlock: to,
        } as never)) as unknown as Log[];
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOG_PARALLEL, ranges.length) }, worker));
    return chunks.flat();
  }

  /** Dry run of a registry call as `account` (eth_call; no key, no transaction). Returns the revert, if any. */
  async dryRun(functionName: "registerReport" | "claimShipment" | "revokeReport", args: readonly unknown[], account: Hex) {
    try {
      await this.client.simulateContract({
        address: this.registry,
        abi: emissionsClaimRegistryAbi,
        functionName,
        args,
        account,
      } as never);
      return { reverted: false as const };
    } catch (err) {
      return { reverted: true as const, ...decodeRevert(err) };
    }
  }
}

/**
 * Methods whose `null` result means "not found". A node that has pruned old history answers them
 * with `null` rather than an error, so `historyFallback` asks the next node.
 */
const NULL_IS_MISSING = new Set([
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
]);

const hexToBig = (x: unknown): bigint | undefined => {
  if (typeof x !== "string" || !/^0x[0-9a-f]+$/i.test(x)) return undefined;
  return BigInt(x);
};

/** `eth_getBlockByNumber` for the latest block (viem's `getBlock()` without a block number). */
function isLatestBlockRequest(method: string, params: unknown): boolean {
  return method === "eth_getBlockByNumber" && Array.isArray(params) && params[0] === "latest";
}

/** The block number a request reads at, when it names one (a view call, an event search's end, a block). */
function requestedBlock(method: string, params: unknown): bigint | undefined {
  if (!Array.isArray(params)) return undefined;
  switch (method) {
    case "eth_call":
    case "eth_getBalance":
    case "eth_getCode":
    case "eth_getStorageAt":
      return hexToBig(params[params.length - 1]);
    case "eth_getBlockByNumber":
      return hexToBig(params[0]);
    case "eth_getLogs": {
      const f = params[0] as { toBlock?: unknown } | undefined;
      return hexToBig(f?.toBlock);
    }
    default:
      return undefined;
  }
}

const PRUNED = /prun|missing trie node|historical state|header not found|history (is )?(not available|unavailable)/i;

/** An RPC error that says the node no longer has the requested block, state or logs (for example code 4444). */
export function isPrunedHistoryError(err: unknown): boolean {
  let e = err as { code?: unknown; message?: unknown; details?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && typeof e === "object" && depth < 8; depth++, e = e.cause as typeof e) {
    if (e.code === 4444) return true;
    if (typeof e.details === "string" && PRUNED.test(e.details)) return true;
    if (typeof e.message === "string" && PRUNED.test(e.message)) return true;
  }
  return false;
}

/** What one node answered to one request, when it did not give a usable answer. */
export interface NodeOutcome {
  url: string;
  /**
   * "null": `null` for a method in which it means "not found"; "pruned": a pruned-history error; "behind": a latest
   * block older than the head-age limit, or a request for a block after the latest one the node reported.
   */
  kind: "null" | "pruned" | "error" | "behind";
  detail: string;
}

/** Every node failed one request; `outcomes` lists each node's answer in the order the nodes were tried. */
export class RpcNodesError extends BaseError {
  readonly outcomes: NodeOutcome[];
  constructor(method: string, outcomes: NodeOutcome[]) {
    super(`${method}: none of the ${outcomes.length} RPC nodes answered`, {
      name: "RpcNodesError",
      metaMessages: outcomes.map((o) => `${o.url}: ${o.detail}`),
    });
    this.outcomes = outcomes;
  }
}

/** First line of an RPC error's most specific message. */
export function errorDetail(err: unknown): string {
  const e = err as { details?: unknown; shortMessage?: unknown; message?: unknown };
  const text = [e?.details, e?.shortMessage, e?.message].find((x) => typeof x === "string" && x) as string | undefined;
  return (text ?? String(err)).split("\n")[0];
}

/**
 * A transport over several RPC nodes, tried in order for each request. The next node is asked when
 * one fails with any error other than a contract revert or a rejection (viem's `shouldThrow`: those
 * would be the same on every node), which includes pruned-history errors such as 4444 or
 * "missing trie node", and when one answers `null` to a request for a receipt, a transaction or a
 * block, which is how a pruned node reports history it has dropped. If every node answers `null`,
 * the result is `null` (not found, which callers treat as a failure); if every node fails,
 * `RpcNodesError` lists each node's answer. A missing answer is never turned into a pass.
 *
 * With `maxHeadAgeSec`, a node whose latest block (`eth_getBlockByNumber("latest")`) is older than that against
 * `now` is behind: the next node is asked. If every node that answered is behind, the newest of their blocks is
 * returned, and the caller's own head-age check (verifyPresentation) reports it. A node that was passed over, or
 * any node whose latest block is known, is not asked for a block after that latest block (an event search past a
 * node's head could come back short rather than fail).
 */
export function historyFallback(
  urls: string[],
  opts: { retryCount?: number; maxHeadAgeSec?: number; now?: () => number } = {},
): Transport {
  if (!urls.length) throw new Error("historyFallback needs at least one RPC URL");
  return (({ chain, timeout, ...rest }) => {
    const nodes = urls.map((u) => http(u)({ ...rest, chain, timeout, retryCount: opts.retryCount ?? 1 }));
    // Latest block number each node last reported (shared by every request of this transport).
    const knownHead: (bigint | undefined)[] = urls.map(() => undefined);
    const maxAge =
      opts.maxHeadAgeSec === undefined || opts.maxHeadAgeSec === Infinity || Number.isNaN(opts.maxHeadAgeSec)
        ? undefined
        : BigInt(Math.floor(Math.max(0, opts.maxHeadAgeSec)));
    return createTransport({
      key: "historyFallback",
      name: "History fallback",
      type: "fallback",
      retryCount: 0,
      async request({ method, params }: { method: string; params?: unknown }): Promise<any> {
        const outcomes: NodeOutcome[] = [];
        const latest = isLatestBlockRequest(method, params);
        const wanted = requestedBlock(method, params);
        let behind: { number: bigint; result: unknown } | undefined;
        for (let i = 0; i < nodes.length; i++) {
          const head = knownHead[i];
          if (wanted !== undefined && head !== undefined && wanted > head) {
            outcomes.push({ url: urls[i], kind: "behind", detail: `its latest block ${head} is before the requested block ${wanted}` });
            continue;
          }
          let result: unknown;
          try {
            result = await nodes[i].request({ method, params } as never);
          } catch (err) {
            if (shouldThrow(err as Error)) throw err;
            const pruned = isPrunedHistoryError(err);
            outcomes.push({
              url: urls[i],
              kind: pruned ? "pruned" : "error",
              detail: `${pruned ? "history pruned: " : ""}${errorDetail(err)}`,
            });
            continue;
          }
          if (result === null && NULL_IS_MISSING.has(method)) {
            outcomes.push({ url: urls[i], kind: "null", detail: "null (history pruned, or not known to this node)" });
            continue;
          }
          if (latest && result && typeof result === "object") {
            const b = result as { number?: unknown; timestamp?: unknown };
            const number = hexToBig(b.number);
            const timestamp = hexToBig(b.timestamp);
            if (number !== undefined) knownHead[i] = number;
            if (maxAge !== undefined && number !== undefined && timestamp !== undefined) {
              const age = BigInt(Math.floor((opts.now ?? Date.now)() / 1000)) - timestamp;
              if (age > maxAge) {
                outcomes.push({ url: urls[i], kind: "behind", detail: `latest block ${number} is ${age} s old` });
                if (!behind || number > behind.number) behind = { number, result };
                continue;
              }
            }
          }
          return result;
        }
        if (behind) return behind.result;
        if (outcomes.every((o) => o.kind === "null")) return null;
        throw new RpcNodesError(method, outcomes);
      },
    });
  }) as Transport;
}

interface Probe {
  n: bigint;
  ts: bigint;
}

/**
 * Narrows a bracket around the boundary where blocks become "after" `target`: on return `lo` is not
 * after it and `hi` is (both hold on entry, and every read keeps them, because timestamps never
 * decrease with the block number). Each round estimates the boundary block from the block time
 * between the two blocks read last (between `lo` and `hi` until two blocks have been read), so a
 * stretch of faster or slower blocks near the target does not slow the search down; the estimate
 * is kept strictly inside the bracket. Each round reads the blocks `slack` either side of the
 * estimate: 1/128 of the bracket in the first round, then a quarter of the last correction.
 */
async function bracket(
  lo: Probe,
  hi: Probe,
  target: bigint,
  after: (ts: bigint) => boolean,
  at: (n: bigint) => Promise<Probe>,
  tolerance: bigint,
): Promise<{ lo: Probe; hi: Probe }> {
  const interpolate = (a: Probe, b: Probe) =>
    a.ts === b.ts ? undefined : a.n + ((target - a.ts) * (b.n - a.n)) / (b.ts - a.ts);
  let recent: Probe[] = [];
  let prev: bigint | undefined;
  for (let round = 0; round < SEARCH_ROUNDS && hi.n - lo.n > 1n && hi.n - lo.n > tolerance; round++) {
    const est =
      (recent.length === 2 ? interpolate(recent[0], recent[1]) : undefined) ??
      interpolate(lo, hi) ??
      lo.n + (hi.n - lo.n) / 2n;
    const slack =
      SEARCH_MIN_SLACK + (prev === undefined ? (hi.n - lo.n) / 128n : (est > prev ? est - prev : prev - est) / 4n);
    const clamp = (n: bigint) => (n <= lo.n ? lo.n + 1n : n >= hi.n ? hi.n - 1n : n);
    const ns = [...new Set([clamp(est - slack), clamp(est + slack)])];
    const read = await Promise.all(ns.map(at));
    for (const p of read) {
      if (after(p.ts)) {
        if (p.n < hi.n) hi = p;
      } else if (p.n > lo.n) lo = p;
    }
    recent = [...recent, ...read].slice(-2);
    prev = est;
  }
  return { lo, hi };
}

/** Custom error name and arguments from a viem contract error. */
export function decodeRevert(err: unknown): { errorName: string; args: readonly unknown[] } {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      return { errorName: reverted.data.errorName, args: reverted.data.args ?? [] };
    }
  }
  return { errorName: "UNKNOWN", args: [String((err as Error)?.message ?? err)] };
}
