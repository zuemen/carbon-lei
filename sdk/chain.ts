// Read-only access to the two contracts on Sepolia (or a local anvil): views, events,
// revert decoding and dry runs (eth_call) for the "Try to break it" counterexamples.
// Never sends transactions and never needs a private key.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { emissionsClaimRegistryAbi, verifierAllowlistAbi } from "./abi.ts";
import type { Hex } from "./credential.ts";

export { sepolia as SEPOLIA_CHAIN };

/** Public Sepolia RPCs with CORS: primary, then backup (tested 2026-09-24). */
export const SEPOLIA_RPCS = ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.ethpandaops.io"];
/** Largest getLogs range used against public RPCs. */
export const LOG_CHUNK = 10_000n;
/** At most this many getLogs requests in flight at once (public RPCs rate-limit bursts). */
export const LOG_PARALLEL = 4;

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
  private readonly deployment: Deployment;

  constructor(client: PublicClient, deployment: Deployment, blockNumber?: bigint) {
    this.client = client;
    this.deployment = deployment;
    this.blockNumber = blockNumber;
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
    return new ChainReader(this.client, this.deployment, blockNumber);
  }

  static forSepolia(deployment: Deployment, rpcUrls: string[] = SEPOLIA_RPCS): ChainReader {
    return ChainReader.forRpc(deployment, rpcUrls, sepolia);
  }

  static forRpc(deployment: Deployment, rpcUrls: string[], chain?: Chain): ChainReader {
    const transport = rpcUrls.length === 1 ? http(rpcUrls[0]) : fallback(rpcUrls.map((u) => http(u)));
    return new ChainReader(createPublicClient({ chain, transport }) as PublicClient, deployment);
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
   * `toBlock` (default: the pinned block, else the latest block) lets a caller search up to a block it has already read.
   */
  async auditorRevocations(auditorAidHash: Hex, leiHash: Hex, toBlock?: bigint): Promise<TimedEvent[]> {
    const logs = await this.chunkedLogs(
      this.allowlist,
      verifierAllowlistAbi,
      "AuditorRevoked",
      { auditorAidHash, leiHash },
      toBlock,
    );
    return logs.map((l) => ({
      time: (l.args as { revokedAt: bigint }).revokedAt,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  }

  /** `VerifierSuspended(leiHash)` events, with their `suspendedAt`. `toBlock` as for `auditorRevocations`. */
  async suspensions(leiHash: Hex, toBlock?: bigint): Promise<TimedEvent[]> {
    const logs = await this.chunkedLogs(this.allowlist, verifierAllowlistAbi, "VerifierSuspended", { leiHash }, toBlock);
    return logs.map((l) => ({
      time: (l.args as { suspendedAt: bigint }).suspendedAt,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  }

  /** All matching logs from the deployment block, in block order; chunks are read a few at a time in parallel. */
  private async chunkedLogs(
    address: Hex,
    abi: readonly unknown[],
    eventName: string,
    args: Record<string, Hex>,
    toBlock?: bigint,
  ) {
    type Log = { args: unknown; blockNumber: bigint; transactionHash: Hex };
    const latest = toBlock ?? this.blockNumber ?? (await this.client.getBlockNumber({ cacheTime: 0 }));
    const ranges: [bigint, bigint][] = [];
    for (let from = this.fromBlock; from <= latest; from += LOG_CHUNK) {
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
