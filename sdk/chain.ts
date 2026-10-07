// Read-only access to the two contracts on Sepolia (or a local anvil): views, events,
// revert decoding and dry runs (eth_call) for the "Try to break it" counterexamples.
// Never sends transactions and never needs a private key.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTransport,
  http,
  numberToHex,
  parseEventLogs,
  shouldThrow,
  toEventSelector,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { sepolia } from "viem/chains";
import { emissionsClaimRegistryAbi, verifierAllowlistAbi } from "./abi.ts";
import type { Hex } from "./credential.ts";
import { defaultMaxHeadAgeSec } from "./verify.ts";

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

/** The demo page's connection line when every node's head is older than the head-age limit. */
export const HEAD_BEHIND = (age: number, limit: number) =>
  `Sepolia nodes are behind: the newest block they report is ${age} s old, more than the ${limit} s allowed, so Verify will refuse it. Try again in a few minutes.`;

/** A block range for an event search, and whether it was narrowed (false: the whole range from deployment). */
export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
  narrowed: boolean;
}

export interface Deployment {
  chainId: number;
  /**
   * Head-age limit, in seconds, for this deployment's chain; overrides `defaultMaxHeadAgeSec(chainId)`. `Infinity`,
   * or `null` in a JSON file, turns the limit off (tests on a local anvil chain whose block times the test sets).
   */
  maxHeadAgeSec?: number | null;
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

/**
 * An event the verifier's CONTESTED rules read (`bodyEvents`). From the allowlist, about one body: an auditor
 * revocation, a suspension of the body, or a rotation of the body's address (`oldAddr` is the address rotated away).
 * From the registry, about one report: its registration (`registered`, with no time field: `time` is 0) and its
 * revocation (`reportRevoked`, with the revoking address in `revoker`).
 */
export interface BodyEvent extends TimedEvent {
  kind: "auditorRevoked" | "suspended" | "rotated" | "registered" | "reportRevoked";
  oldAddr?: Hex;
  newAddr?: Hex;
  reportKey?: Hex;
  revoker?: Hex;
  logIndex: number;
}

/** A `ReportRegistered` event of one report scope (`scopeRegistrations`). */
export interface ScopeRegistration {
  reportKey: Hex;
  issuerLeiHash: Hex;
  supplier: Hex;
  reportIdHash: Hex;
  credScopeKey: Hex;
  blockNumber: bigint;
  logIndex: number;
}

const selector = (abi: readonly unknown[], name: string) =>
  toEventSelector((abi as { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === name) as never);
const BODY_EVENT_TOPICS = ["AuditorRevoked", "VerifierSuspended", "VerifierAddressRotated"].map((n) => selector(verifierAllowlistAbi, n));
const REPORT_EVENT_TOPICS = ["ReportRegistered", "ReportRevoked"].map((n) => selector(emissionsClaimRegistryAbi, n));
const BOTH_ABIS = [...verifierAllowlistAbi, ...emissionsClaimRegistryAbi];

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
  /** The deployment's head-age limit (`Deployment.maxHeadAgeSec`), when it sets one. */
  readonly maxHeadAgeSec?: number;
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
    this.maxHeadAgeSec = deployment.maxHeadAgeSec === null ? Infinity : deployment.maxHeadAgeSec;
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
   * The demo page's reader over `rpcUrls` (on Sepolia when the deployment is), and `HEAD_BEHIND` text when every
   * node's head is older than the head-age limit (`headBehind`, given 4 s).
   */
  static async forPage(deployment: Deployment, rpcUrls: string[]): Promise<{ reader: ChainReader; behind?: string }> {
    const reader = ChainReader.forRpc(deployment, rpcUrls, deployment.chainId === sepolia.id ? sepolia : undefined);
    return { reader, behind: (await reader.headBehind(4000))?.text };
  }

  /**
   * Several URLs: tried in order (`historyFallback`), and a node whose latest block is older than the deployment's
   * head-age limit (`Deployment.maxHeadAgeSec`, else `defaultMaxHeadAgeSec`) is passed over for the next one.
   */
  static forRpc(deployment: Deployment, rpcUrls: string[], chain?: Chain, options?: ChainReaderOptions): ChainReader {
    const transport =
      rpcUrls.length === 1
        ? timedHttp(rpcUrls[0], { retryCount: 3 })
        : historyFallback(rpcUrls, {
            maxHeadAgeSec: deployment.maxHeadAgeSec === null ? Infinity : (deployment.maxHeadAgeSec ?? defaultMaxHeadAgeSec(deployment.chainId)),
          });
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

  /** The head-age limit, in seconds, that `verifyPresentation` applies by default (`Infinity`: none). */
  get headAgeLimitSec(): number {
    return this.maxHeadAgeSec ?? defaultMaxHeadAgeSec(this.chainId);
  }

  /**
   * The age of the newest head the nodes report, when it is over `headAgeLimitSec` (the reader passes over a node that
   * is behind, so this is the case only when every node is). Undefined when the head is recent, there is no limit, or
   * the head could not be read within `timeoutMs` (a verification then reports any problem itself). The demo page
   * uses it for its connection line.
   */
  async headBehind(timeoutMs: number, now: () => number = Date.now): Promise<{ age: number; limit: number; text: string } | undefined> {
    const limit = this.headAgeLimitSec;
    if (!Number.isFinite(limit)) return undefined;
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      const head = await Promise.race([
        this.latestBlock(),
        new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error("timeout")), timeoutMs))),
      ]);
      const age = Math.floor(now() / 1000) - Number(head.timestamp);
      return age > limit ? { age, limit, text: HEAD_BEHIND(age, limit) } : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(t);
    }
  }

  /** How many RPC nodes this reader can ask (several for a `historyFallback` transport, else 1). */
  get nodeCount(): number {
    const n = (this.client.transport as { rpcNodeCount?: unknown }).rpcNodeCount;
    return typeof n === "number" && n > 0 ? n : 1;
  }

  /**
   * Moves the nodes that answered event searches since the last call to the end of the order in which the nodes are
   * asked, so the next verification reads its events from another node. False when there is no other node to ask.
   */
  preferOtherNodes(): boolean {
    const f = (this.client.transport as { demoteLogNodes?: unknown }).demoteLogNodes;
    return typeof f === "function" ? Boolean(f()) : false;
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
   * The events the CONTESTED rules read, for one body, one auditor and (with `reportKey`) one report, in one
   * `eth_getLogs` request per chunk: from the allowlist `AuditorRevoked(auditorAidHash, leiHash)`,
   * `VerifierSuspended(leiHash)` and `VerifierAddressRotated(leiHash, oldAddr, newAddr)`; from the registry
   * `ReportRegistered(reportKey, …)` and `ReportRevoked(reportKey, revoker, revokedAt)`. The request names both
   * contracts, filters topic 0 on these events and topic 1 on the auditor, the body or the report (their first indexed
   * field); the result is then filtered on the contract and the full key (an `AuditorRevoked` of the same auditor
   * under another body is dropped). Only the allowlist owner and the watcher can emit the allowlist events, and only
   * the body can register or revoke its report, so an outsider cannot add entries. The report's own
   * `ReportRegistered` lets the caller tell an answer without events from a node that has lost the history
   * (`verifyPresentation` refuses one). `toBlock` and `fromBlock` as for `auditorRevocations`; any request error is
   * thrown (fail closed).
   */
  async bodyEvents(leiHash: Hex, auditorAidHash: Hex, toBlock?: bigint, fromBlock?: bigint, reportKey?: Hex): Promise<BodyEvent[]> {
    type RawLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex | bigint; transactionHash: Hex; logIndex: Hex | number };
    const raw = await this.chunked<RawLog>(
      (from, to) =>
        this.client.request({
          method: "eth_getLogs",
          params: [
            {
              address: reportKey ? [this.allowlist, this.registry] : this.allowlist,
              topics: reportKey
                ? [[...BODY_EVENT_TOPICS, ...REPORT_EVENT_TOPICS], [auditorAidHash, leiHash, reportKey]]
                : [BODY_EVENT_TOPICS, [auditorAidHash, leiHash]],
              fromBlock: numberToHex(from),
              toBlock: numberToHex(to),
            },
          ],
        } as never) as Promise<RawLog[]>,
      toBlock,
      fromBlock,
    );
    const out: BodyEvent[] = [];
    const eq = (x: unknown, y: Hex) => typeof x === "string" && x.toLowerCase() === y.toLowerCase();
    for (const l of parseEventLogs({ abi: BOTH_ABIS, logs: raw as never, strict: true })) {
      const a = l.args as Record<string, unknown>;
      const base = {
        blockNumber: BigInt(l.blockNumber as unknown as Hex),
        txHash: l.transactionHash as Hex,
        logIndex: Number(l.logIndex as unknown as Hex),
      };
      const fromAllowlist = eq(l.address, this.allowlist);
      const fromRegistry = eq(l.address, this.registry);
      if (fromAllowlist && l.eventName === "AuditorRevoked") {
        if (eq(a.auditorAidHash, auditorAidHash) && eq(a.leiHash, leiHash)) {
          out.push({ kind: "auditorRevoked", time: a.revokedAt as bigint, ...base });
        }
      } else if (fromAllowlist && l.eventName === "VerifierSuspended") {
        if (eq(a.leiHash, leiHash)) out.push({ kind: "suspended", time: a.suspendedAt as bigint, ...base });
      } else if (fromAllowlist && l.eventName === "VerifierAddressRotated") {
        if (eq(a.leiHash, leiHash)) {
          out.push({ kind: "rotated", time: a.rotatedAt as bigint, oldAddr: a.oldAddr as Hex, newAddr: a.newAddr as Hex, ...base });
        }
      } else if (fromRegistry && reportKey && l.eventName === "ReportRegistered") {
        if (eq(a.reportKey, reportKey)) out.push({ kind: "registered", time: 0n, reportKey, ...base });
      } else if (fromRegistry && reportKey && l.eventName === "ReportRevoked") {
        if (eq(a.reportKey, reportKey)) {
          out.push({ kind: "reportRevoked", time: a.revokedAt as bigint, reportKey, revoker: a.verifier as Hex, ...base });
        }
      }
    }
    return out;
  }

  /**
   * The `ReportRegistered` events of one report scope in every block whose timestamp lies in [fromTime, toTime], up
   * to `head` (`reportScopeKey` is not an indexed field, so every `ReportRegistered` of the range is read and the
   * scope is filtered here). One block search (`blockRangeForTimes`) and one `eth_getLogs` per chunk of the range;
   * the whole range from the deployment block if the search could not narrow it. Any request error is thrown.
   */
  async scopeRegistrations(
    reportScopeKey: Hex,
    fromTime: bigint,
    toTime: bigint,
    head: { number: bigint; timestamp: bigint },
  ): Promise<ScopeRegistration[]> {
    const range = await this.blockRangeForTimes(fromTime, toTime, head);
    type RawLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex | bigint; transactionHash: Hex; logIndex: Hex | number };
    const raw = await this.chunked<RawLog>(
      (from, to) =>
        this.client.request({
          method: "eth_getLogs",
          params: [{ address: this.registry, topics: [REPORT_EVENT_TOPICS[0]], fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
        } as never) as Promise<RawLog[]>,
      range.toBlock,
      range.fromBlock,
    );
    const out: ScopeRegistration[] = [];
    for (const l of parseEventLogs({ abi: emissionsClaimRegistryAbi, logs: raw as never, strict: true })) {
      const a = l.args as Record<string, unknown>;
      if (l.eventName !== "ReportRegistered" || String(l.address).toLowerCase() !== this.registry.toLowerCase()) continue;
      if (String(a.reportScopeKey).toLowerCase() !== reportScopeKey.toLowerCase()) continue;
      out.push({
        reportKey: a.reportKey as Hex,
        issuerLeiHash: a.issuerLeiHash as Hex,
        supplier: a.supplier as Hex,
        reportIdHash: a.reportIdHash as Hex,
        credScopeKey: a.credScopeKey as Hex,
        blockNumber: BigInt(l.blockNumber as unknown as Hex),
        logIndex: Number(l.logIndex as unknown as Hex),
      });
    }
    return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  }

  /**
   * `bodyEvents` (with `reportKey`: also that report's registry events) over every block whose timestamp lies in one of the time `intervals` ([from, to], in seconds), up
   * to `head`. Overlapping intervals are merged first, each remaining interval gets its own block range
   * (`blockRangeForTimes`), and overlapping or adjacent block ranges are merged again, so no block is searched twice.
   * If any range could not be narrowed (a failed block read, `fullEventScan`, a young chain), the whole range from
   * the deployment block to `head` is searched once instead (fail-safe, never narrower than needed).
   */
  async bodyEventsInTimes(
    leiHash: Hex,
    auditorAidHash: Hex,
    intervals: readonly (readonly [bigint, bigint])[],
    head: { number: bigint; timestamp: bigint },
    reportKey?: Hex,
  ): Promise<BodyEvent[]> {
    const times = intervals.map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [bigint, bigint]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const merged: [bigint, bigint][] = [];
    for (const [a, b] of times) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) {
        if (b > last[1]) last[1] = b;
      } else merged.push([a, b]);
    }
    const found = await Promise.all(merged.map(([a, b]) => this.blockRangeForTimes(a, b, head)));
    let blocks: [bigint, bigint][] = found.some((r) => !r.narrowed)
      ? [[this.fromBlock, head.number]]
      : found.map((r) => [r.fromBlock, r.toBlock] as [bigint, bigint]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const joined: [bigint, bigint][] = [];
    for (const [a, b] of blocks) {
      const last = joined[joined.length - 1];
      if (last && a <= last[1] + 1n) {
        if (b > last[1]) last[1] = b;
      } else joined.push([a, b]);
    }
    blocks = joined;
    const parts = await Promise.all(blocks.map(([a, b]) => this.bodyEvents(leiHash, auditorAidHash, b, a, reportKey)));
    return parts.flat();
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
  private chunkedLogs(
    address: Hex,
    abi: readonly unknown[],
    eventName: string,
    args: Record<string, Hex>,
    toBlock?: bigint,
    fromBlock?: bigint,
  ) {
    type Log = { args: unknown; blockNumber: bigint; transactionHash: Hex };
    return this.chunked<Log>(
      (from, to) =>
        this.client.getContractEvents({
          address,
          abi,
          eventName,
          args,
          fromBlock: from,
          toBlock: to,
        } as never) as unknown as Promise<Log[]>,
      toBlock,
      fromBlock,
    );
  }

  /**
   * `read` over [fromBlock, toBlock] (defaults as for `chunkedLogs`) in chunks of at most `LOG_CHUNK` blocks, at most
   * `LOG_PARALLEL` at once; the results in block order. Any failed chunk rejects the whole search.
   */
  private async chunked<L>(read: (from: bigint, to: bigint) => Promise<L[]>, toBlock?: bigint, fromBlock?: bigint): Promise<L[]> {
    const latest = toBlock ?? this.blockNumber ?? (await this.client.getBlockNumber({ cacheTime: 0 }));
    const start = fromBlock !== undefined && fromBlock > this.fromBlock ? fromBlock : this.fromBlock;
    const ranges: [bigint, bigint][] = [];
    for (let from = start; from <= latest; from += LOG_CHUNK) {
      ranges.push([from, from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest]);
    }
    const chunks: L[][] = new Array(ranges.length);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const i = next++;
        const [from, to] = ranges[i];
        chunks[i] = await read(from, to);
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

/** How long one request to one RPC node may take before the next node is asked (and a lone node fails). */
export const RPC_TIMEOUT_MS = 8_000;

/** Seconds, for messages ("8 s", "0.05 s"). */
const secondsOf = (ms: number) => `${Number((ms / 1000).toFixed(3))} s`;

/** One RPC node did not answer one request within `RPC_TIMEOUT_MS` (no retry on that node). */
export class RpcTimeoutError extends BaseError {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`node ${url} did not answer within ${secondsOf(timeoutMs)}; try again or use another RPC`, { name: "RpcTimeoutError" });
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** viem's retry rule for HTTP RPC errors (`shouldRetry` in viem's buildRequest), used for every error but a timeout. */
function retryable(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; status?: unknown };
  if (e?.name === "AbortError") return false;
  if (typeof e?.code === "number") return [-1, -32005, -32603, 429, -32007].includes(e.code);
  if (e?.name === "HttpRequestError" && typeof e.status === "number") return [403, 408, 413, 429, 500, 502, 503, 504].includes(e.status);
  return true;
}

const isTimeout = (err: unknown) => err instanceof BaseError && !!err.walk((e) => (e as { name?: unknown })?.name === "TimeoutError");

/**
 * viem's `http` transport, with a timeout of `timeoutMs` per request (default `RPC_TIMEOUT_MS`). A request that times
 * out is not retried on the same node: it fails with `RpcTimeoutError` ("node … did not answer within 8 s"). Other
 * errors are retried up to `retryCount` times, as viem's `http` does.
 */
export function timedHttp(url: string, opts: { retryCount?: number; timeoutMs?: number } = {}): Transport {
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  const retryCount = opts.retryCount ?? 1;
  return ((config: Parameters<Transport>[0]) => {
    const node = http(url, { timeout: timeoutMs, retryCount: 0 })({ ...config, timeout: timeoutMs, retryCount: 0 });
    return createTransport(
      {
        key: "http",
        name: "HTTP JSON-RPC",
        type: "http",
        retryCount: 0,
        timeout: timeoutMs,
        async request(args: { method: string; params?: unknown }): Promise<any> {
          for (let attempt = 0; ; attempt++) {
            try {
              return await node.request(args as never);
            } catch (err) {
              if (isTimeout(err)) throw new RpcTimeoutError(url, timeoutMs);
              if (attempt >= retryCount || shouldThrow(err as Error) || !retryable(err)) throw err;
              await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
            }
          }
        },
      },
      { url },
    );
  }) as Transport;
}

/**
 * The RPC URLs a CLI command uses: `--rpc`, else the comma-separated list in `CARBONLEI_RPC_URL`, else `SEPOLIA_RPCS`.
 * `source` says where the list came from.
 */
export function rpcUrlsFrom(flag: string | undefined, env: string | undefined): { urls: string[]; source: "flag" | "env" | "default" } {
  if (flag !== undefined && flag.trim() !== "") return { urls: [flag.trim()], source: "flag" };
  const list = (env ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (list.length) return { urls: list, source: "env" };
  return { urls: [...SEPOLIA_RPCS], source: "default" };
}

/** What one node answered to one request, when it did not give a usable answer. */
export interface NodeOutcome {
  url: string;
  /**
   * "null": `null` for a method in which it means "not found"; "pruned": a pruned-history error; "behind": a latest
   * block older than the head-age limit, or a request for a block after the latest one the node reported.
   */
  kind: "null" | "pruned" | "error" | "behind" | "timeout";
  detail: string;
}

/** Every node failed one request; `outcomes` lists each node's answer in the order the nodes were tried. */
export class RpcNodesError extends BaseError {
  readonly outcomes: NodeOutcome[];
  constructor(method: string, outcomes: NodeOutcome[]) {
    const silent = outcomes.length > 0 && outcomes.every((o) => o.kind === "timeout");
    super(
      silent
        ? `${method}: none of the ${outcomes.length} RPC nodes answered: ${outcomes.map((o) => `node ${o.url} ${o.detail}`).join("; ")}; try again or use another RPC`
        : `${method}: none of the ${outcomes.length} RPC nodes answered`,
      {
        name: "RpcNodesError",
        metaMessages: outcomes.map((o) => `${o.url}: ${o.detail}`),
      },
    );
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
 *
 * Each request to a node has a timeout (`timeoutMs`, default `RPC_TIMEOUT_MS`). A node that times out is not asked
 * again for that request and is moved to the end of the order for the next ones, so one node that hangs costs one
 * timeout, not one per request. `demoteLogNodes` (on the transport, used by `ChainReader.preferOtherNodes`) moves the
 * nodes that answered `eth_getLogs` to the end in the same way, so a retried verification reads its events elsewhere.
 */
export function historyFallback(
  urls: string[],
  opts: { retryCount?: number; maxHeadAgeSec?: number; now?: () => number; timeoutMs?: number } = {},
): Transport {
  if (!urls.length) throw new Error("historyFallback needs at least one RPC URL");
  return (({ chain, timeout, ...rest }) => {
    const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
    const nodes = urls.map((u) =>
      timedHttp(u, { retryCount: opts.retryCount ?? 1, timeoutMs })({ ...rest, chain, timeout, retryCount: 0 }),
    );
    // The order in which the nodes are asked (indices into `urls`), and the nodes that answered an event search.
    let order = urls.map((_, i) => i);
    const toEnd = (picked: number[]) => {
      order = [...order.filter((i) => !picked.includes(i)), ...order.filter((i) => picked.includes(i))];
    };
    let logNodes: number[] = [];
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
        for (const i of [...order]) {
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
            if (err instanceof RpcTimeoutError) {
              outcomes.push({ url: urls[i], kind: "timeout", detail: `did not answer within ${secondsOf(timeoutMs)}` });
              toEnd([i]);
              continue;
            }
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
          if (method === "eth_getLogs" && !logNodes.includes(i)) logNodes.push(i);
          return result;
        }
        if (behind) return behind.result;
        if (outcomes.every((o) => o.kind === "null")) return null;
        throw new RpcNodesError(method, outcomes);
      },
    }, {
      rpcNodeCount: urls.length,
      // Moves the nodes that answered `eth_getLogs` since the last call (else, or if that was every node, the first
      // node in the order) to the end.
      demoteLogNodes(): boolean {
        if (urls.length < 2) return false;
        toEnd(logNodes.length && logNodes.length < urls.length ? logNodes : [order[0]]);
        logNodes = [];
        return true;
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
