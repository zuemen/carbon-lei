// V2 monitor: watches VerifierAllowlistV2 / EmissionsClaimRegistryV2 (contracts/src/v2, CR1 mitigation,
// docs/SECURITY.md §13.1) and reacts with the WATCHER key. V2 is tested but NOT deployed.
//
// The delays in V2 only help if someone reacts within them. The Maude CR1 model (formal/maude,
// CARBONLEI-CR1) shows the rotation/revocation part of V2 holds if every rotation proposal the body did not ask
// for is cancelled within ROTATION_DELAY and, when a rotation got through anyway, the body is SUSPENDED within
// REVOKE_HOLD. The model has no role grants, suspension lifts, new bodies or supersede/takeover, so the rules
// below for those (added after our own AI-run review, 2026-10-10, §13.1) are not covered by it. Default policy:
//
//   RotationProposed  for a watched body, not in `expectedRotations`  -> cancelRotation
//   VerifierAddressRotated, not expected and not body-consented       -> taint the body; suspendVerifier
//       "Body-consented" = executed with executeRotationSigned by an old address that was mature (bound at least
//       ROTATION_DELAY) or itself expected, on a body not already tainted. A body stays tainted across later
//       hops (a hostile address consenting to the next one does not clean it) until an expected rotation, so the
//       chain from the last trusted address to the current one is judged as a whole (review finding H1).
//   RevocationQueued  (requester bound < REVOKE_HOLD), not expected   -> cancelRevocation
//   RoleGrantProposed (WATCHER_ROLE), account not in `expectedWatchers` -> cancelRoleGrant (H2)
//   SuspensionLifted  of a suspension this monitor made, by another address -> suspendVerifier again (H2)
//   RoleGranted / RoleRevoked, OwnershipTransferStarted / Transferred, VerifierAdded / AuditorAdded not in the
//       expected lists, VerifierSuspended by someone else, ReportSuperseded, ReportScopeTakenOver -> alert only
//
// "Expected" is the body's (or operator's) out-of-band confirmation in the config. Every poll also checks that
// the watcher key still holds WATCHER_ROLE and alerts if not, re-checks that proposals it cancelled are still
// gone (a reorg can undo a cancel), reads events only up to head - `confirmations` (default 12), halves the
// getLogs block range when the RPC refuses a range, and checks registry.allowlist() == config allowlist.
//
// Alerts are JSON lines on stdout ({ ts, level, type, ... }); with V2_WATCH_WEBHOOK_URL set each alert is
// also POSTed there (best effort). --dry-run only alerts and never sends a transaction. State (last block
// read, the events already acted on, tainted bodies, cancelled proposals) is kept in a JSON file (default
// verifier/.data/watch-v2-state.json), and each action re-reads the chain state first, so a restart replays
// safely. The watcher key comes from WATCHER_PRIVATE_KEY (not needed with --dry-run). Chain time (the head
// block's timestamp), not wall time, decides deadlines.
//
//   node verifier/src/watch-v2.ts --config <file.json> [--dry-run] [--once] [--interval 15] [--state <file>]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { leiHashOf } from "../../sdk/commitment.ts";
import type { Hex } from "../../sdk/credential.ts";
import { allowlistV2Abi, isV2Allowlist, registryV2Abi } from "../../sdk/v2.ts";
import { REPO_ROOT, readJson, writeJson } from "./state.ts";

export const DEFAULT_V2_STATE_PATH = resolve(REPO_ROOT, "verifier/.data/watch-v2-state.json");
const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_LOG_CHUNK = 10_000n;
const DEFAULT_CONFIRMATIONS = 12;
const HEARTBEAT_POLLS = 20;
const RANGE_ERROR = /range|limit|too many|too large|exceed|max(imum)? .*(results|blocks)|returned more than|response size/i;

export interface V2Policy {
  /** cancelRotation on a proposal not in `expectedRotations` (default true). */
  cancelUnexpectedRotations: boolean;
  /** suspendVerifier after a rotation that was neither expected nor body-consented (default true). */
  suspendOnUnexpectedRotation: boolean;
  /** cancelRevocation on a queued revocation not in `expectedRevocations` (default true). */
  cancelUnexpectedRevocations: boolean;
  /**
   * A rotation executed through executeRotationSigned counts as body-consented if the signing old address was
   * mature or expected and the body was not already tainted (default true).
   */
  trustSignedRotations: boolean;
  /** cancelRoleGrant on a WATCHER_ROLE grant proposal for an account not in `expectedWatchers` (default true). */
  cancelUnexpectedRoleGrants: boolean;
  /** suspendVerifier again when a suspension this monitor made is lifted by an address other than the watcher key or `trustedLifters` (default true). */
  resuspendOnForeignLift: boolean;
}

export interface V2MonitorConfig {
  rpc: string;
  allowlist: Hex;
  registry: Hex;
  /** First block to read on a fresh state file (the deployment block). */
  fromBlock: bigint;
  /** Bodies (leiHash) to watch; empty = every body. */
  bodies: Hex[];
  expectedRotations: { leiHash: Hex; newAddr: Hex }[];
  expectedRevocations: Hex[];
  /** Accounts whose WATCHER_ROLE grant proposals are expected (H2). */
  expectedWatchers: Hex[];
  /** leiHashes of bodies whose onboarding is expected (others alert; onboarding is never blocked). */
  expectedBodies: Hex[];
  /** auditorAidHashes whose addition is expected (others alert). */
  expectedAuditors: Hex[];
  /** Addresses an ownership transfer to which is expected (others alert critically). */
  expectedOwners: Hex[];
  /** Addresses (besides the watcher key) allowed to lift a suspension this monitor made. */
  trustedLifters: Hex[];
  /** Events are read up to head - confirmations (reorg safety; default 12). */
  confirmations: number;
  /** getLogs block range; halved automatically when the RPC refuses a range (default 10,000). */
  logChunk: bigint;
  policy: V2Policy;
  dryRun: boolean;
  statePath: string;
  intervalMs: number;
}

export const DEFAULT_POLICY: V2Policy = {
  cancelUnexpectedRotations: true,
  suspendOnUnexpectedRotation: true,
  cancelUnexpectedRevocations: true,
  trustSignedRotations: true,
  cancelUnexpectedRoleGrants: true,
  resuspendOnForeignLift: true,
};

export interface Alert {
  ts: string;
  level: "info" | "warn" | "critical";
  type: string;
  [k: string]: unknown;
}

interface HandledEntry {
  type: string;
  outcome: string;
  tx?: Hex;
  at: string;
}

/** Per-body record: tainted by a rotation that was neither expected nor body-consented (H1). */
interface BodyState {
  tainted: boolean;
  /** The hop that tainted the body (for alerts and deadlines). */
  taint?: { id: string; oldAddr: Hex; newAddr: Hex; rotatedAt: string; reason: string };
  /** The suspension for the current taint was sent, found in place, or alerted (policy off / dry run). */
  suspendHandled?: boolean;
  /** This monitor's key suspended the body and nobody trusted has lifted it since. */
  suspendedByUs?: boolean;
}

/** A proposal this monitor cancelled; re-checked until its readyAt (a reorg can undo the cancel). */
interface CancelledProposal {
  kind: "rotation" | "roleGrant";
  leiHash?: Hex;
  role?: Hex;
  target: Hex;
  readyAt: string;
}

export interface V2State {
  version: 1;
  chainId: number;
  allowlist: Hex;
  registry: Hex;
  /** Last block fully processed (-1 before the first poll). */
  lastBlock: string;
  /** Events already acted on, by `txHash:logIndex`. */
  handled: Record<string, HandledEntry>;
  bodies?: Record<string, BodyState>;
  cancelled?: CancelledProposal[];
  updatedAt: string;
}

export interface V2Deps {
  emit: (a: Alert) => void;
  /** Watcher key; required unless dry run. */
  account?: PrivateKeyAccount;
  client?: PublicClient;
  wallet?: WalletClient;
}

export interface PollResult {
  head: bigint;
  /** Last block whose events were read (head - confirmations). */
  toBlock: bigint;
  now: bigint;
  alerts: Alert[];
  txs: Hex[];
  failures: number;
}

const lower = (h: string) => h.toLowerCase() as Hex;

/** Normalises a JSON config: `lei` strings become leiHash, addresses are lower-cased, policy gets defaults. */
export function configFromJson(j: Record<string, unknown>, over: Partial<V2MonitorConfig> = {}): V2MonitorConfig {
  const hashOf = (e: { lei?: string; leiHash?: string }): Hex => {
    if (e.leiHash) return lower(e.leiHash);
    if (e.lei) return leiHashOf(e.lei);
    throw new Error("each body / expected rotation needs lei or leiHash");
  };
  const need = (k: string) => {
    if (typeof j[k] !== "string") throw new Error(`config: ${k} is required`);
    return j[k] as string;
  };
  const list = (k: string) => ((j[k] as string[] | undefined) ?? []).map(lower);
  const cfg: V2MonitorConfig = {
    rpc: need("rpc"),
    allowlist: lower(need("allowlist")),
    registry: lower(need("registry")),
    fromBlock: BigInt((j.fromBlock as number | string | undefined) ?? 0),
    bodies: ((j.bodies as { lei?: string; leiHash?: string }[] | undefined) ?? []).map(hashOf),
    expectedRotations: ((j.expectedRotations as { lei?: string; leiHash?: string; newAddr: string }[] | undefined) ?? []).map((e) => ({
      leiHash: hashOf(e),
      newAddr: lower(e.newAddr),
    })),
    expectedRevocations: list("expectedRevocations"),
    expectedWatchers: list("expectedWatchers"),
    expectedBodies: ((j.expectedBodies as { lei?: string; leiHash?: string }[] | undefined) ?? []).map(hashOf),
    expectedAuditors: list("expectedAuditors"),
    expectedOwners: list("expectedOwners"),
    trustedLifters: list("trustedLifters"),
    confirmations: Number(j.confirmations ?? DEFAULT_CONFIRMATIONS),
    logChunk: BigInt((j.logChunk as number | string | undefined) ?? DEFAULT_LOG_CHUNK),
    policy: { ...DEFAULT_POLICY, ...((j.policy as Partial<V2Policy> | undefined) ?? {}) },
    dryRun: Boolean(j.dryRun ?? false),
    statePath: (j.statePath as string | undefined) ?? DEFAULT_V2_STATE_PATH,
    intervalMs: Number(j.intervalSeconds ?? 15) * 1000,
  };
  return { ...cfg, ...over };
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/** Default alert sink: one JSON line on stdout, plus a best-effort POST to V2_WATCH_WEBHOOK_URL when set. */
export function stdoutEmit(a: Alert): void {
  const line = JSON.stringify(jsonSafe(a));
  console.log(line);
  const url = process.env.V2_WATCH_WEBHOOK_URL;
  if (url) {
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: line, signal: AbortSignal.timeout(5000) }).catch(
      (err) => console.error(`watch-v2: webhook POST failed: ${err instanceof Error ? err.message : err}`),
    );
  }
}

/**
 * The state file a run uses. A dry run keeps its own file (`<state>.dry-run.json`), so a later real run
 * still acts on everything a dry run only alerted about.
 */
export function statePathOf(cfg: V2MonitorConfig): string {
  return cfg.dryRun ? cfg.statePath.replace(/(\.json)?$/, ".dry-run.json") : cfg.statePath;
}

export function loadV2State(cfg: V2MonitorConfig, chainId: number): V2State {
  const path = statePathOf(cfg);
  if (existsSync(path)) {
    const s = readJson(path) as V2State;
    if (lower(s.allowlist) !== cfg.allowlist || lower(s.registry) !== cfg.registry || s.chainId !== chainId) {
      throw new Error(`${path} belongs to another deployment (${s.chainId}/${s.allowlist}); use another --state`);
    }
    return { ...s, bodies: s.bodies ?? {}, cancelled: s.cancelled ?? [] };
  }
  return {
    version: 1,
    chainId,
    allowlist: cfg.allowlist,
    registry: cfg.registry,
    lastBlock: String(cfg.fromBlock - 1n),
    handled: {},
    bodies: {},
    cancelled: [],
    updatedAt: new Date().toISOString(),
  };
}

function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? "reverted";
  }
  return undefined;
}

const errText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/**
 * One poll: re-checks cancelled proposals, reads the new V2 events up to head - confirmations, acts on each per
 * the policy, suspends tainted bodies, saves the state. A failed action on an event leaves `lastBlock` before
 * that event's block, so the next poll retries it; a failed suspension stays pending in the body state.
 */
export async function pollV2(cfg: V2MonitorConfig, deps: V2Deps): Promise<PollResult> {
  const client = deps.client ?? (createPublicClient({ transport: http(cfg.rpc) }) as PublicClient);
  const alerts: Alert[] = [];
  const txs: Hex[] = [];
  let failures = 0;
  const alert = (level: Alert["level"], type: string, fields: Record<string, unknown> = {}) => {
    const a: Alert = { ts: new Date().toISOString(), level, type, ...(jsonSafe(fields) as object) };
    alerts.push(a);
    deps.emit(a);
  };

  const chainId = await client.getChainId();
  if (!(await isV2Allowlist(client, cfg.allowlist))) throw new Error(`${cfg.allowlist} is not a VerifierAllowlistV2 (no ROTATION_DELAY)`);
  const state = loadV2State(cfg, chainId);
  const bodies = state.bodies!;
  // L3: the registry must read this allowlist, or the monitor would guard the wrong trust registry.
  const regAllowlist = await client.readContract({ address: cfg.registry, abi: registryV2Abi, functionName: "allowlist" });
  if (lower(regAllowlist) !== cfg.allowlist) {
    throw new Error(`registry ${cfg.registry} points to allowlist ${lower(regAllowlist)}, not the configured ${cfg.allowlist}`);
  }
  const head = await client.getBlock({ blockTag: "latest" });
  const now = head.timestamp;
  const depth = BigInt(Math.max(0, Math.floor(cfg.confirmations)));
  const toBlock = head.number - depth;
  const [revokeHold, rotationDelay, watcherRole] = await Promise.all([
    client.readContract({ address: cfg.registry, abi: registryV2Abi, functionName: "REVOKE_HOLD" }),
    client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "ROTATION_DELAY" }),
    client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "WATCHER_ROLE" }),
  ]);
  const me = deps.account ? lower(deps.account.address) : undefined;

  if (!cfg.dryRun && !deps.account) throw new Error("not a dry run and no watcher key (WATCHER_PRIVATE_KEY)");
  if (deps.account) {
    const has = await client.readContract({
      address: cfg.allowlist,
      abi: allowlistV2Abi,
      functionName: "hasRole",
      args: [watcherRole, deps.account.address],
    });
    if (!has) alert("critical", "watcher_role_missing", { watcher: deps.account.address, note: "this key cannot cancel or suspend; the owner may have revoked WATCHER_ROLE" });
  }
  const wallet = deps.wallet ?? (deps.account ? createWalletClient({ account: deps.account, transport: http(cfg.rpc) }) : undefined);

  const watched = (lei: Hex) => cfg.bodies.length === 0 || cfg.bodies.includes(lower(lei));
  const isExpectedRotation = (lei: Hex, addr: string) => cfg.expectedRotations.some((e) => e.leiHash === lower(lei) && e.newAddr === lower(addr));
  const send = async (address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<{ tx?: Hex; already?: string }> => {
    try {
      await client.simulateContract({ address, abi, functionName, args, account: deps.account } as never);
    } catch (err) {
      const name = revertName(err);
      if (name && ["NoPendingRotation", "AlreadySuspended", "NoPendingRevocation", "NoPendingRoleGrant"].includes(name)) return { already: name };
      throw err;
    }
    const hash = await wallet!.writeContract({ address, abi, functionName, args, account: deps.account!, chain: null } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} tx ${hash} reverted`);
    txs.push(hash);
    return { tx: hash };
  };
  const institution = (leiHash: Hex) => client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "institutions", args: [leiHash] });
  const txFrom = async (hash: Hex) => lower((await client.getTransaction({ hash })).from);

  // --- L1: proposals this monitor cancelled must still be gone (a reorg can drop the cancel transaction).
  const keep: CancelledProposal[] = [];
  for (const c of state.cancelled!) {
    const readyAt = BigInt(c.readyAt);
    let pendingAgain = false;
    try {
      if (c.kind === "rotation") {
        const [pAddr, pReady] = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "pendingRotations", args: [c.leiHash!] });
        pendingAgain = lower(pAddr) === c.target && pReady === readyAt;
      } else {
        const pReady = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "pendingRoleGrants", args: [c.role!, c.target] });
        pendingAgain = pReady === readyAt;
      }
      if (pendingAgain) {
        const info = { kind: c.kind, leiHash: c.leiHash, role: c.role, target: c.target, readyAt, secondsLeft: readyAt > now ? readyAt - now : 0n, dryRun: cfg.dryRun };
        alert("critical", "cancelled_proposal_reappeared", info);
        if (cfg.dryRun) {
          keep.push(c);
          continue;
        }
        const r =
          c.kind === "rotation"
            ? await send(cfg.allowlist, allowlistV2Abi, "cancelRotation", [c.leiHash!])
            : await send(cfg.allowlist, allowlistV2Abi, "cancelRoleGrant", [c.role!, c.target]);
        alert("warn", r.tx ? "proposal_cancelled_again" : "proposal_already_gone", { ...info, cancelTx: r.tx, revert: r.already });
        keep.push(c);
      } else if (now < readyAt) {
        keep.push(c); // keep checking until it could have executed
      }
    } catch (err) {
      failures++;
      alert("critical", "action_failed", { kind: c.kind, target: c.target, error: errText(err) });
      keep.push(c);
    }
  }
  state.cancelled = keep;

  // --- tainted bodies (H1): suspend unless the chain ends at an expected address.
  const suspendFailed = new Set<string>();
  const trySuspend = async (leiHash: Hex, extra: Record<string, unknown> = {}) => {
    const b = bodies[leiHash];
    if (!b?.tainted || b.suspendHandled || suspendFailed.has(leiHash)) return;
    const t = b.taint!;
    const deadline = BigInt(t.rotatedAt) + revokeHold;
    const info = { leiHash, taintedBy: t, suspendDeadline: deadline, late: now >= deadline, dryRun: cfg.dryRun, ...extra };
    try {
      const [currentAddress, , , , , suspendedAt, liftedAt] = await institution(leiHash);
      if (suspendedAt !== 0n && liftedAt === 0n) {
        alert("info", "body_already_suspended", info);
        b.suspendHandled = true;
        return;
      }
      if (isExpectedRotation(leiHash, currentAddress)) {
        alert("info", "tainted_chain_ends_at_expected_address", { ...info, currentAddress });
        bodies[leiHash] = { tainted: false };
        return;
      }
      if (!cfg.policy.suspendOnUnexpectedRotation) {
        alert("critical", "body_left_active_by_policy", info);
        b.suspendHandled = true;
        return;
      }
      if (cfg.dryRun) {
        alert("critical", "would_suspend_body", info);
        b.suspendHandled = true;
        return;
      }
      const r = await send(cfg.allowlist, allowlistV2Abi, "suspendVerifier", [leiHash]);
      alert("critical", r.tx ? "body_suspended" : "body_already_suspended", { ...info, suspendTx: r.tx, revert: r.already });
      b.suspendHandled = true;
      if (r.tx) b.suspendedByUs = true;
    } catch (err) {
      failures++;
      suspendFailed.add(leiHash);
      alert("critical", "action_failed", { ...info, action: "suspendVerifier", error: errText(err) });
    }
  };

  const alEvents = new Set([
    "RotationProposed",
    "VerifierAddressRotated",
    "RoleGrantProposed",
    "RoleGranted",
    "RoleRevoked",
    "SuspensionLifted",
    "VerifierSuspended",
    "VerifierAdded",
    "AuditorAdded",
    "OwnershipTransferStarted",
    "OwnershipTransferred",
  ]);
  const regEvents = new Set(["RevocationQueued", "ReportSuperseded", "ReportScopeTakenOver"]);

  const from = BigInt(state.lastBlock) + 1n;
  let retryFrom: bigint | undefined;
  let chunk = cfg.logChunk > 0n ? cfg.logChunk : DEFAULT_LOG_CHUNK;
  for (let start = from; start <= toBlock; ) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    let alLogs, regLogs;
    try {
      [alLogs, regLogs] = await Promise.all([
        client.getLogs({ address: cfg.allowlist, events: allowlistV2Abi.filter((x) => x.type === "event" && alEvents.has(x.name)), fromBlock: start, toBlock: end }),
        client.getLogs({ address: cfg.registry, events: registryV2Abi.filter((x) => x.type === "event" && regEvents.has(x.name)), fromBlock: start, toBlock: end }),
      ]);
    } catch (err) {
      // L2: providers cap the block range; halve and retry the same start.
      if (chunk > 1n && RANGE_ERROR.test(err instanceof Error ? err.message : String(err))) {
        chunk = chunk / 2n;
        alert("info", "log_chunk_reduced", { fromBlock: start, newChunk: chunk, error: errText(err) });
        continue;
      }
      throw err;
    }
    start = end + 1n;
    const logs = [...alLogs, ...regLogs].sort((a, b) =>
      a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1,
    );

    for (const lg of logs) {
      const id = `${lg.transactionHash}:${lg.logIndex}`;
      if (state.handled[id]) continue;
      const base = { event: lg.eventName, block: lg.blockNumber, tx: lg.transactionHash, dryRun: cfg.dryRun };
      const done = (outcome: string, tx?: Hex) => {
        state.handled[id] = { type: lg.eventName!, outcome, ...(tx ? { tx } : {}), at: new Date().toISOString() };
      };
      try {
        const a = lg.args as Record<string, unknown>;
        if (lg.eventName === "RotationProposed") {
          const leiHash = lower(a.leiHash as string);
          const newAddr = lower(a.newAddr as string);
          const readyAt = a.readyAt as bigint;
          if (!watched(leiHash)) continue;
          const info = { ...base, leiHash, newAddr, readyAt, secondsLeft: readyAt > now ? readyAt - now : 0n };
          if (isExpectedRotation(leiHash, newAddr)) {
            alert("info", "rotation_proposed_expected", info);
            done("expected");
            continue;
          }
          alert("warn", "rotation_proposed_unexpected", info);
          const [pAddr] = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "pendingRotations", args: [leiHash] });
          if (lower(pAddr) !== newAddr) {
            alert("info", "rotation_no_longer_pending", info);
            done("not_pending");
            continue;
          }
          if (!cfg.policy.cancelUnexpectedRotations) {
            alert("critical", "rotation_left_pending_by_policy", info);
            done("policy_off");
            continue;
          }
          if (cfg.dryRun) {
            alert("critical", "would_cancel_rotation", info);
            done("dry_run_alerted");
            continue;
          }
          const r = await send(cfg.allowlist, allowlistV2Abi, "cancelRotation", [leiHash]);
          alert(r.tx ? "warn" : "info", r.tx ? "rotation_cancelled" : "rotation_already_gone", { ...info, cancelTx: r.tx, revert: r.already });
          if (r.tx) state.cancelled!.push({ kind: "rotation", leiHash, target: newAddr, readyAt: String(readyAt) });
          done(r.tx ? "cancelled" : "already", r.tx);
        } else if (lg.eventName === "VerifierAddressRotated") {
          const leiHash = lower(a.leiHash as string);
          const oldAddr = lower(a.oldAddr as string);
          const newAddr = lower(a.newAddr as string);
          const rotatedAt = a.rotatedAt as bigint;
          if (!watched(leiHash)) continue;
          const deadline = rotatedAt + revokeHold;
          const info = { ...base, leiHash, oldAddr, newAddr, rotatedAt, suspendDeadline: deadline, late: now >= deadline };
          const body = (bodies[leiHash] ??= { tainted: false });
          if (isExpectedRotation(leiHash, newAddr)) {
            alert("info", "rotation_executed_expected", info);
            if (body.tainted) alert("info", "taint_cleared_by_expected_rotation", info);
            bodies[leiHash] = { tainted: false, suspendedByUs: body.suspendedByUs };
            done("expected");
            continue;
          }
          let reason = "executed after the delay without the body's consent";
          if (cfg.policy.trustSignedRotations) {
            const tx = await client.getTransaction({ hash: lg.transactionHash! });
            let fn: string | undefined;
            try {
              fn = decodeFunctionData({ abi: allowlistV2Abi, data: tx.input }).functionName;
            } catch {
              fn = undefined; // called through another contract (multisig, timelock): not provably consented
            }
            if (fn === "executeRotationSigned" && lower(tx.to ?? "") === cfg.allowlist) {
              const [, signerBoundAt] = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "leiOfAddress", args: [oldAddr] });
              const mature = signerBoundAt + rotationDelay <= rotatedAt;
              const signerExpected = isExpectedRotation(leiHash, oldAddr);
              if (!body.tainted && (mature || signerExpected)) {
                alert("info", "rotation_executed_with_body_consent", { ...info, signerBoundAt, signerMature: mature });
                done("consented");
                continue;
              }
              reason = body.tainted
                ? "signed by an address installed by an earlier unexpected rotation"
                : "signed by an address bound less than ROTATION_DELAY ago";
            }
          }
          const [currentAddress] = await institution(leiHash);
          const superseded = lower(currentAddress) !== newAddr;
          alert("critical", "rotation_executed_unexpected", { ...info, reason, ...(superseded ? { superseded, currentAddress } : {}) });
          bodies[leiHash] = {
            tainted: true,
            taint: { id, oldAddr, newAddr, rotatedAt: String(rotatedAt), reason },
            suspendHandled: false,
            suspendedByUs: body.suspendedByUs,
          };
          done("tainted");
          // A later hop in this batch may still end the chain at an expected address; judge it then.
          if (!superseded) await trySuspend(leiHash);
        } else if (lg.eventName === "RevocationQueued") {
          const reportKey = lower(a.reportKey as string);
          const requester = lower(a.requester as string);
          const [leiHash, boundAt] = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "leiOfAddress", args: [requester] });
          if (!watched(leiHash)) continue;
          const info = { ...base, reportKey, requester, leiHash, requesterBoundAt: boundAt, effectiveFrom: a.effectiveFrom, readyAt: a.readyAt };
          if (cfg.expectedRevocations.includes(reportKey)) {
            alert("info", "revocation_queued_expected", info);
            done("expected");
            continue;
          }
          alert("warn", "revocation_queued_unexpected", info);
          const [req] = await client.readContract({ address: cfg.registry, abi: registryV2Abi, functionName: "pendingRevocations", args: [reportKey] });
          if (lower(req) !== requester) {
            alert("info", "revocation_no_longer_pending", info);
            done("not_pending");
            continue;
          }
          if (!cfg.policy.cancelUnexpectedRevocations) {
            alert("critical", "revocation_left_queued_by_policy", info);
            done("policy_off");
            continue;
          }
          if (cfg.dryRun) {
            alert("critical", "would_cancel_revocation", info);
            done("dry_run_alerted");
            continue;
          }
          const r = await send(cfg.registry, registryV2Abi, "cancelRevocation", [reportKey]);
          alert(r.tx ? "warn" : "info", r.tx ? "revocation_cancelled" : "revocation_already_gone", { ...info, cancelTx: r.tx, revert: r.already });
          done(r.tx ? "cancelled" : "already", r.tx);
        } else if (lg.eventName === "RoleGrantProposed") {
          const role = lower(a.role as string);
          const account = lower(a.account as string);
          const readyAt = a.readyAt as bigint;
          const info = { ...base, role, account, readyAt, secondsLeft: readyAt > now ? readyAt - now : 0n };
          if (role !== lower(watcherRole) || cfg.expectedWatchers.includes(account)) {
            alert("info", "role_grant_proposed_expected", info);
            done("expected");
            continue;
          }
          alert("critical", "role_grant_proposed_unexpected", info);
          const pReady = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "pendingRoleGrants", args: [role, account] });
          if (pReady !== readyAt) {
            alert("info", "role_grant_no_longer_pending", info);
            done("not_pending");
            continue;
          }
          if (!cfg.policy.cancelUnexpectedRoleGrants) {
            alert("critical", "role_grant_left_pending_by_policy", info);
            done("policy_off");
            continue;
          }
          if (cfg.dryRun) {
            alert("critical", "would_cancel_role_grant", info);
            done("dry_run_alerted");
            continue;
          }
          const r = await send(cfg.allowlist, allowlistV2Abi, "cancelRoleGrant", [role, account]);
          alert(r.tx ? "warn" : "info", r.tx ? "role_grant_cancelled" : "role_grant_already_gone", { ...info, cancelTx: r.tx, revert: r.already });
          if (r.tx) state.cancelled!.push({ kind: "roleGrant", role, target: account, readyAt: String(readyAt) });
          done(r.tx ? "cancelled" : "already", r.tx);
        } else if (lg.eventName === "RoleGranted" || lg.eventName === "RoleRevoked") {
          const role = lower(a.role as string);
          const account = lower(a.account as string);
          const info = { ...base, role, account, sender: a.sender };
          const isWatcher = role === lower(watcherRole);
          if (lg.eventName === "RoleGranted") {
            if (isWatcher) {
              const ok = account === me || cfg.expectedWatchers.includes(account);
              alert(ok ? "info" : "critical", ok ? "watcher_granted_expected" : "watcher_granted_unexpected", info);
            } else if (role === ADMIN_ROLE) {
              // The admin role only ever follows ownership; an unexpected owner is alerted on OwnershipTransferStarted too.
              const ok = cfg.expectedOwners.includes(account) || account === lower(await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "owner" }));
              alert(ok ? "info" : "critical", ok ? "admin_role_moved_with_ownership" : "admin_granted_unexpected", info);
            } else {
              alert("warn", "role_granted", info);
            }
          } else if (isWatcher) {
            alert("critical", account === me ? "watcher_role_revoked_from_this_key" : "watcher_role_revoked", info);
          } else if (role !== ADMIN_ROLE) {
            alert("warn", "role_revoked", info);
          }
          done("alerted");
        } else if (lg.eventName === "OwnershipTransferStarted" || lg.eventName === "OwnershipTransferred") {
          const prev = lower(a.previousOwner as string);
          const next = lower(a.newOwner as string);
          if (prev === ZERO) {
            done("constructor");
            continue;
          }
          const info = { ...base, previousOwner: prev, newOwner: next };
          const ok = cfg.expectedOwners.includes(next) || (lg.eventName === "OwnershipTransferStarted" && next === ZERO);
          const type = lg.eventName === "OwnershipTransferStarted" ? "ownership_transfer_started" : "ownership_transferred";
          alert(ok ? "info" : "critical", ok ? `${type}_expected` : `${type}_unexpected`, info);
          done("alerted");
        } else if (lg.eventName === "VerifierSuspended") {
          const leiHash = lower(a.leiHash as string);
          if (!watched(leiHash)) continue;
          if (me && (await txFrom(lg.transactionHash!)) === me) {
            done("own");
            continue;
          }
          alert("warn", "body_suspended_by_other", { ...base, leiHash });
          done("alerted");
        } else if (lg.eventName === "SuspensionLifted") {
          const leiHash = lower(a.leiHash as string);
          if (!watched(leiHash)) continue;
          const by = await txFrom(lg.transactionHash!);
          const body = bodies[leiHash];
          const info = { ...base, leiHash, by };
          if (by === me || cfg.trustedLifters.includes(by)) {
            // The operator lifted it on purpose: clear the taint and the record of our suspension.
            alert("info", "suspension_lifted_by_trusted_key", info);
            bodies[leiHash] = { tainted: false };
            done("trusted");
            continue;
          }
          if (!body?.suspendedByUs) {
            alert("warn", "suspension_lifted", info);
            done("alerted");
            continue;
          }
          alert("critical", "suspension_lifted_by_other", info);
          const [, , , , , suspendedAt, liftedAt] = await institution(leiHash);
          if (suspendedAt !== 0n && liftedAt === 0n) {
            alert("info", "body_already_suspended", info);
            done("already_suspended");
            continue;
          }
          if (!cfg.policy.resuspendOnForeignLift) {
            alert("critical", "body_left_active_by_policy", info);
            done("policy_off");
            continue;
          }
          if (cfg.dryRun) {
            alert("critical", "would_resuspend_body", info);
            done("dry_run_alerted");
            continue;
          }
          const r = await send(cfg.allowlist, allowlistV2Abi, "suspendVerifier", [leiHash]);
          alert("critical", r.tx ? "body_resuspended" : "body_already_suspended", { ...info, suspendTx: r.tx, revert: r.already });
          done(r.tx ? "resuspended" : "already_suspended", r.tx);
        } else if (lg.eventName === "VerifierAdded") {
          const leiHash = lower(a.leiHash as string);
          const ok = cfg.expectedBodies.includes(leiHash);
          alert(ok ? "info" : "warn", ok ? "body_added_expected" : "body_added_unexpected", { ...base, leiHash, verifier: a.verifier });
          done("alerted");
        } else if (lg.eventName === "AuditorAdded") {
          const auditorAidHash = lower(a.auditorAidHash as string);
          const ok = cfg.expectedAuditors.includes(auditorAidHash);
          alert(ok ? "info" : "warn", ok ? "auditor_added_expected" : "auditor_added_unexpected", { ...base, auditorAidHash, leiHash: a.leiHash });
          done("alerted");
        } else if (lg.eventName === "ReportSuperseded") {
          alert("warn", "report_superseded", { ...base, oldReportKey: a.oldReportKey, newReportKey: a.newReportKey, credScopeKey: a.credScopeKey });
          done("alerted");
        } else if (lg.eventName === "ReportScopeTakenOver") {
          alert("warn", "report_scope_taken_over", { ...base, takenFromReportKey: a.takenFromReportKey, newReportKey: a.newReportKey, reportScopeKey: a.reportScopeKey, issuerLeiHash: a.issuerLeiHash });
          done("alerted");
        }
      } catch (err) {
        failures++;
        alert("critical", "action_failed", { ...base, error: errText(err) });
        if (retryFrom === undefined || lg.blockNumber! < retryFrom) retryFrom = lg.blockNumber!;
      }
    }
  }
  // Bodies still tainted and not yet suspended (chain superseded within the batch, or an earlier failure).
  for (const lei of Object.keys(bodies)) await trySuspend(lei as Hex);

  if (toBlock >= from) state.lastBlock = String(retryFrom !== undefined ? retryFrom - 1n : toBlock);
  state.updatedAt = new Date().toISOString();
  writeJson(statePathOf(cfg), state);
  return { head: head.number, toBlock, now, alerts, txs, failures };
}

function usage(msg: string): never {
  console.error(`watch-v2: ${msg}`);
  console.error("usage: node verifier/src/watch-v2.ts --config <file.json> [--dry-run] [--once] [--interval <s>] [--state <file>] [--rpc <url>]");
  process.exit(2);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      state: { type: "string" },
      rpc: { type: "string" },
    },
  });
  if (!values.config) usage("--config is required (see verifier/config/watch-v2.example.json)");
  const j = readJson(resolve(values.config)) as Record<string, unknown>;
  const cfg = configFromJson(j, {
    ...(values["dry-run"] ? { dryRun: true } : {}),
    ...(values.interval ? { intervalMs: Number(values.interval) * 1000 } : {}),
    ...(values.state ? { statePath: resolve(values.state) } : {}),
    ...(values.rpc ? { rpc: values.rpc } : {}),
  });
  if (!Number.isFinite(cfg.intervalMs) || cfg.intervalMs < 1000) usage("--interval must be >= 1 second");
  const key = process.env.WATCHER_PRIVATE_KEY;
  if (!cfg.dryRun && !key) usage("WATCHER_PRIVATE_KEY is required unless --dry-run (e.g. node --env-file=.env ...)");
  const account = key ? privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex) : undefined;
  const deps: V2Deps = { emit: stdoutEmit, account };
  stdoutEmit({
    ts: new Date().toISOString(),
    level: "info",
    type: "monitor_started",
    allowlist: cfg.allowlist,
    registry: cfg.registry,
    bodies: cfg.bodies.length ? cfg.bodies : "all",
    expectedRotations: cfg.expectedRotations.length,
    expectedRevocations: cfg.expectedRevocations.length,
    expectedWatchers: cfg.expectedWatchers.length,
    expectedBodies: cfg.expectedBodies.length,
    confirmations: cfg.confirmations,
    policy: cfg.policy,
    dryRun: cfg.dryRun,
    watcher: account?.address ?? null,
    statePath: statePathOf(cfg),
  });
  let quiet = 0;
  for (;;) {
    try {
      const r = await pollV2(cfg, deps);
      if (values.once) return r.failures ? 1 : 0;
      if (r.alerts.length || ++quiet >= HEARTBEAT_POLLS) {
        if (!r.alerts.length) stdoutEmit({ ts: new Date().toISOString(), level: "info", type: "heartbeat", head: String(r.head), chainTime: String(r.now) });
        quiet = 0;
      }
    } catch (err) {
      stdoutEmit({ ts: new Date().toISOString(), level: "critical", type: "poll_failed", error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      if (values.once) return 1;
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

const isMain = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main()
    .then((code) => process.stdout.write("", () => process.exit(code)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
