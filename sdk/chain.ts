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

/** Public Sepolia RPCs with CORS: primary, then backup (tested 2026-09-24). */
export const SEPOLIA_RPCS = ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.ethpandaops.io"];
/** Largest getLogs range used against public RPCs. */
export const LOG_CHUNK = 10_000n;

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

  constructor(client: PublicClient, deployment: Deployment) {
    this.client = client;
    this.allowlist = deployment.contracts.VerifierAllowlist.address;
    this.registry = deployment.contracts.EmissionsClaimRegistry.address;
    this.fromBlock = BigInt(
      Math.min(deployment.contracts.VerifierAllowlist.block, deployment.contracts.EmissionsClaimRegistry.block),
    );
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
    } as never) as Promise<T>;
  }

  private readAllowlist<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.client.readContract({
      address: this.allowlist,
      abi: verifierAllowlistAbi,
      functionName,
      args,
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

  isInstitutionActiveAt(leiHash: Hex, t: bigint): Promise<boolean> {
    return this.readAllowlist<boolean>("isInstitutionActiveAt", [leiHash, t]);
  }

  async latestTimestamp(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }

  /** `AuditorRevoked(auditorAidHash, leiHash)` events, with their `revokedAt`. */
  async auditorRevocations(auditorAidHash: Hex, leiHash: Hex): Promise<TimedEvent[]> {
    const logs = await this.chunkedLogs(this.allowlist, verifierAllowlistAbi, "AuditorRevoked", {
      auditorAidHash,
      leiHash,
    });
    return logs.map((l) => ({
      time: (l.args as { revokedAt: bigint }).revokedAt,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  }

  /** `VerifierSuspended(leiHash)` events, with their `suspendedAt`. */
  async suspensions(leiHash: Hex): Promise<TimedEvent[]> {
    const logs = await this.chunkedLogs(this.allowlist, verifierAllowlistAbi, "VerifierSuspended", { leiHash });
    return logs.map((l) => ({
      time: (l.args as { suspendedAt: bigint }).suspendedAt,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
    }));
  }

  private async chunkedLogs(address: Hex, abi: readonly unknown[], eventName: string, args: Record<string, Hex>) {
    const latest = await this.client.getBlockNumber({ cacheTime: 0 });
    const out: { args: unknown; blockNumber: bigint; transactionHash: Hex }[] = [];
    for (let from = this.fromBlock; from <= latest; from += LOG_CHUNK) {
      const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
      const logs = await this.client.getContractEvents({
        address,
        abi,
        eventName,
        args,
        fromBlock: from,
        toBlock: to,
      } as never);
      for (const l of logs as unknown as { args: unknown; blockNumber: bigint; transactionHash: Hex }[]) out.push(l);
    }
    return out;
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
