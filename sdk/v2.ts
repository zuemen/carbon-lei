// Read-only support for the V2 contracts (contracts/src/v2, CR1 mitigation, docs/SECURITY.md §13.1).
// V2 is tested but NOT deployed; the demo and every verdict stay on V1. This module only lets a reader
// tell a V2 deployment from a V1 one and report, as advisory information, a body's pending address
// rotation and a report's queued revocation. Nothing here changes a verification result.
//
// The ABI fragments are hand-written (human-readable, viem `parseAbi`) so they need no `forge build`
// output; contracts/test/v2 and verifier/test/watch-v2.test.ts check them against the compiled contracts.
import { parseAbi, type PublicClient } from "viem";
import type { Hex } from "./credential.ts";

/** V2-only parts of `VerifierAllowlistV2`, plus the V1 events and views the V2 monitor reads. */
export const allowlistV2Abi = parseAbi([
  "function ROTATION_DELAY() view returns (uint64)",
  "function WATCHER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function owner() view returns (address)",
  "function pendingRotations(bytes32 leiHash) view returns (address newAddr, uint64 readyAt)",
  "function rotationNonce(bytes32 leiHash) view returns (uint256)",
  "function institutions(bytes32 leiHash) view returns (address currentAddress, bytes32 leCredSaidHash, bytes32 accreditationSaidHash, uint64 accreditedUntil, uint64 addedAt, uint64 suspendedAt, uint64 liftedAt)",
  "function leiOfAddress(address addr) view returns (bytes32 leiHash, uint64 boundAt, uint64 unboundAt)",
  "function proposeRotation(bytes32 leiHash, address newAddr)",
  "function cancelRotation(bytes32 leiHash)",
  "function executeRotation(bytes32 leiHash)",
  "function executeRotationSigned(bytes32 leiHash, bytes oldAddrSig)",
  "function suspendVerifier(bytes32 leiHash)",
  "event RotationProposed(bytes32 indexed leiHash, address indexed newAddr, uint64 readyAt)",
  "event RotationCancelled(bytes32 indexed leiHash, address indexed newAddr, address indexed by)",
  "event VerifierAddressRotated(bytes32 indexed leiHash, address indexed oldAddr, address indexed newAddr, uint64 rotatedAt)",
  "event VerifierSuspended(bytes32 indexed leiHash, uint64 suspendedAt)",
  "error NoPendingRotation(bytes32 leiHash)",
  "error RotationNotReady(bytes32 leiHash, uint64 readyAt)",
  "error NotAllowedToCancel(address caller)",
  "error AlreadySuspended(bytes32 leiHash)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

/** V2-only parts of `EmissionsClaimRegistryV2`. */
export const registryV2Abi = parseAbi([
  "function REVOKE_HOLD() view returns (uint64)",
  "function pendingRevocations(bytes32 reportKey) view returns (address requester, uint64 effectiveFrom, uint64 readyAt)",
  "function revocationEffectiveFrom(bytes32 reportKey) view returns (uint64)",
  "function revokeReport(bytes32 reportKey, uint64 effectiveFrom)",
  "function executeRevocation(bytes32 reportKey)",
  "function cancelRevocation(bytes32 reportKey)",
  "event RevocationQueued(bytes32 indexed reportKey, address indexed requester, uint64 effectiveFrom, uint64 readyAt)",
  "event RevocationCancelled(bytes32 indexed reportKey, address indexed by)",
  "event ReportRevoked(bytes32 indexed reportKey, address indexed verifier, uint64 revokedAt)",
  "error NoPendingRevocation(bytes32 reportKey)",
  "error RevocationNotReady(bytes32 reportKey, uint64 readyAt)",
  "error NotActiveVerifier(address verifier)",
  "error NotReportIssuer(address caller, bytes32 issuerLeiHash)",
  "error AlreadyRevoked(bytes32 key)",
  "error RevocationPending(bytes32 reportKey, uint64 readyAt)",
  "error NotAllowedToCancel(address caller)",
]);

export interface PendingRotation {
  newAddr: Hex;
  readyAt: bigint;
}

export interface QueuedRevocation {
  requester: Hex;
  effectiveFrom: bigint;
  readyAt: bigint;
}

/** Advisory V2 state of one body (and optionally one report). Never part of a verdict. */
export interface V2Advisory {
  v2: true;
  rotationDelaySec: bigint;
  revokeHoldSec: bigint;
  pendingRotation: PendingRotation | null;
  queuedRevocation?: QueuedRevocation | null;
  notes: string[];
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * True when `allowlist` answers `ROTATION_DELAY()` (V2); false when the call reverts or returns nothing
 * (V1 has no such function). Other errors (RPC down) are thrown, so a network fault is not read as "V1".
 */
export async function isV2Allowlist(client: PublicClient, allowlist: Hex, blockNumber?: bigint): Promise<boolean> {
  try {
    await client.readContract({ address: allowlist, abi: allowlistV2Abi, functionName: "ROTATION_DELAY", blockNumber });
    return true;
  } catch (err) {
    const name = (err as { name?: string; walk?: (fn: (e: unknown) => boolean) => unknown })?.walk?.(
      (e) => (e as { name?: string })?.name === "ContractFunctionRevertedError" || (e as { name?: string })?.name === "ContractFunctionZeroDataError",
    );
    if (name) return false;
    throw err;
  }
}

export async function pendingRotation(client: PublicClient, allowlist: Hex, leiHash: Hex, blockNumber?: bigint): Promise<PendingRotation | null> {
  const [newAddr, readyAt] = await client.readContract({
    address: allowlist,
    abi: allowlistV2Abi,
    functionName: "pendingRotations",
    args: [leiHash],
    blockNumber,
  });
  return newAddr === ZERO ? null : { newAddr, readyAt };
}

export async function queuedRevocation(client: PublicClient, registry: Hex, reportKey: Hex, blockNumber?: bigint): Promise<QueuedRevocation | null> {
  const [requester, effectiveFrom, readyAt] = await client.readContract({
    address: registry,
    abi: registryV2Abi,
    functionName: "pendingRevocations",
    args: [reportKey],
    blockNumber,
  });
  return requester === ZERO ? null : { requester, effectiveFrom, readyAt };
}

/**
 * Advisory V2 state for a body (and a report, when given), or `null` on a V1 deployment. `now` is the
 * chain time the notes compare deadlines against (e.g. the pinned head block's timestamp).
 */
export async function v2Advisory(
  client: PublicClient,
  contracts: { allowlist: Hex; registry: Hex },
  q: { leiHash: Hex; reportKey?: Hex; now: bigint; blockNumber?: bigint },
): Promise<V2Advisory | null> {
  if (!(await isV2Allowlist(client, contracts.allowlist, q.blockNumber))) return null;
  const b = q.blockNumber;
  const [rotationDelaySec, revokeHoldSec, rot, rev] = await Promise.all([
    client.readContract({ address: contracts.allowlist, abi: allowlistV2Abi, functionName: "ROTATION_DELAY", blockNumber: b }),
    client.readContract({ address: contracts.registry, abi: registryV2Abi, functionName: "REVOKE_HOLD", blockNumber: b }),
    pendingRotation(client, contracts.allowlist, q.leiHash, b),
    q.reportKey ? queuedRevocation(client, contracts.registry, q.reportKey, b) : Promise.resolve(undefined),
  ]);
  const notes: string[] = [];
  if (rot) {
    notes.push(
      q.now >= rot.readyAt
        ? `address rotation to ${rot.newAddr} is pending and executable now (ready since ${rot.readyAt})`
        : `address rotation to ${rot.newAddr} is pending; executable at ${rot.readyAt} (in ${rot.readyAt - q.now} s)`,
    );
  }
  if (rev) {
    notes.push(
      `revocation by ${rev.requester} is queued (effective from ${rev.effectiveFrom}); ` +
        (q.now >= rev.readyAt ? `executable now (ready since ${rev.readyAt})` : `executable at ${rev.readyAt}`),
    );
  }
  return {
    v2: true,
    rotationDelaySec,
    revokeHoldSec,
    pendingRotation: rot,
    ...(q.reportKey ? { queuedRevocation: rev ?? null } : {}),
    notes,
  };
}
