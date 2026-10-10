// V2 monitor: watches VerifierAllowlistV2 / EmissionsClaimRegistryV2 (contracts/src/v2, CR1 mitigation,
// docs/SECURITY.md §13.1) and reacts with the WATCHER key. V2 is tested but NOT deployed.
//
// The delays in V2 only help if someone reacts within them. The Maude CR1 model (formal/maude,
// CARBONLEI-CR1) shows V2 holds if every rotation proposal the body did not ask for is cancelled within
// ROTATION_DELAY and, when a rotation got through anyway, the body is SUSPENDED within REVOKE_HOLD
// (cancelling queued revocations alone is not enough: the attacker can wait until its address has been
// bound for 72 h and revoke directly). The default policy is exactly that:
//
//   RotationProposed  for a watched body, not in `expectedRotations`  -> cancelRotation
//   VerifierAddressRotated, not expected and not body-consented       -> suspendVerifier (deadline: rotatedAt + REVOKE_HOLD)
//   RevocationQueued  (requester bound < REVOKE_HOLD), not expected   -> cancelRevocation
//
// "Expected" is the body's out-of-band confirmation: a (leiHash or lei, newAddr) pair, or a report key,
// that the operator adds to the config after hearing from the body. A rotation executed with
// `executeRotationSigned` carries the body's own EIP-712 consent and is treated as confirmed
// (`trustSignedRotations`, default true). Every poll also checks that the watcher key still holds
// WATCHER_ROLE (the owner can drop it) and alerts if not.
//
// Alerts are JSON lines on stdout ({ ts, level, type, ... }); with V2_WATCH_WEBHOOK_URL set each alert is
// also POSTed there (best effort). --dry-run only alerts and never sends a transaction. State (last block
// read and the events already acted on) is kept in a JSON file (default verifier/.data/watch-v2-state.json),
// and each action re-reads the chain state first, so a restart replays safely. The watcher key comes from
// WATCHER_PRIVATE_KEY (not needed with --dry-run). Chain time (the head block's timestamp), not wall time,
// decides deadlines.
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
const LOG_CHUNK = 10_000n;
const HEARTBEAT_POLLS = 20;

export interface V2Policy {
  /** cancelRotation on a proposal not in `expectedRotations` (default true). */
  cancelUnexpectedRotations: boolean;
  /** suspendVerifier after a rotation that was neither expected nor body-consented (default true). */
  suspendOnUnexpectedRotation: boolean;
  /** cancelRevocation on a queued revocation not in `expectedRevocations` (default true). */
  cancelUnexpectedRevocations: boolean;
  /** A rotation executed through executeRotationSigned (the body's EIP-712 consent) counts as expected (default true). */
  trustSignedRotations: boolean;
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

export interface V2State {
  version: 1;
  chainId: number;
  allowlist: Hex;
  registry: Hex;
  /** Last block fully processed (-1 before the first poll). */
  lastBlock: string;
  /** Events already acted on, by `txHash:logIndex`. */
  handled: Record<string, HandledEntry>;
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
    expectedRevocations: ((j.expectedRevocations as string[] | undefined) ?? []).map(lower),
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
    return s;
  }
  return {
    version: 1,
    chainId,
    allowlist: cfg.allowlist,
    registry: cfg.registry,
    lastBlock: String(cfg.fromBlock - 1n),
    handled: {},
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

/**
 * One poll: reads the new V2 events up to the head, acts on each per the policy, saves the state.
 * A failed action leaves `lastBlock` before that event's block, so the next poll retries it.
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
  const head = await client.getBlock({ blockTag: "latest" });
  const now = head.timestamp;
  const [revokeHold, watcherRole] = await Promise.all([
    client.readContract({ address: cfg.registry, abi: registryV2Abi, functionName: "REVOKE_HOLD" }),
    client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "WATCHER_ROLE" }),
  ]);

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
  const send = async (address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<{ tx?: Hex; already?: string }> => {
    try {
      await client.simulateContract({ address, abi, functionName, args, account: deps.account } as never);
    } catch (err) {
      const name = revertName(err);
      if (name && ["NoPendingRotation", "AlreadySuspended", "NoPendingRevocation"].includes(name)) return { already: name };
      throw err;
    }
    const hash = await wallet!.writeContract({ address, abi, functionName, args, account: deps.account!, chain: null } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} tx ${hash} reverted`);
    txs.push(hash);
    return { tx: hash };
  };

  const from = BigInt(state.lastBlock) + 1n;
  let retryFrom: bigint | undefined;
  for (let start = from; start <= head.number; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < head.number ? start + LOG_CHUNK - 1n : head.number;
    const [alLogs, regLogs] = await Promise.all([
      client.getLogs({
        address: cfg.allowlist,
        events: allowlistV2Abi.filter((x) => x.type === "event" && (x.name === "RotationProposed" || x.name === "VerifierAddressRotated")),
        fromBlock: start,
        toBlock: end,
      }),
      client.getLogs({
        address: cfg.registry,
        events: registryV2Abi.filter((x) => x.type === "event" && x.name === "RevocationQueued"),
        fromBlock: start,
        toBlock: end,
      }),
    ]);
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
          const leiHash = a.leiHash as Hex;
          const newAddr = lower(a.newAddr as string);
          const readyAt = a.readyAt as bigint;
          if (!watched(leiHash)) continue;
          const info = { ...base, leiHash, newAddr, readyAt, secondsLeft: readyAt > now ? readyAt - now : 0n };
          if (cfg.expectedRotations.some((e) => e.leiHash === lower(leiHash) && e.newAddr === newAddr)) {
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
          done(r.tx ? "cancelled" : "already", r.tx);
        } else if (lg.eventName === "VerifierAddressRotated") {
          const leiHash = a.leiHash as Hex;
          const newAddr = lower(a.newAddr as string);
          const rotatedAt = a.rotatedAt as bigint;
          if (!watched(leiHash)) continue;
          const deadline = rotatedAt + revokeHold;
          const info = { ...base, leiHash, oldAddr: a.oldAddr, newAddr, rotatedAt, suspendDeadline: deadline, late: now >= deadline };
          if (cfg.expectedRotations.some((e) => e.leiHash === lower(leiHash) && e.newAddr === newAddr)) {
            alert("info", "rotation_executed_expected", info);
            done("expected");
            continue;
          }
          if (cfg.policy.trustSignedRotations) {
            const tx = await client.getTransaction({ hash: lg.transactionHash! });
            let fn: string | undefined;
            try {
              fn = decodeFunctionData({ abi: allowlistV2Abi, data: tx.input }).functionName;
            } catch {
              fn = undefined; // called through another contract (multisig, timelock): not provably consented
            }
            if (fn === "executeRotationSigned" && lower(tx.to ?? "") === cfg.allowlist) {
              alert("info", "rotation_executed_with_body_consent", info);
              done("consented");
              continue;
            }
          }
          alert("critical", "rotation_executed_unexpected", info);
          const inst = await client.readContract({ address: cfg.allowlist, abi: allowlistV2Abi, functionName: "institutions", args: [leiHash] });
          const [currentAddress, , , , , suspendedAt, liftedAt] = inst;
          if (suspendedAt !== 0n && liftedAt === 0n) {
            alert("info", "body_already_suspended", info);
            done("already_suspended");
            continue;
          }
          if (lower(currentAddress) !== newAddr) {
            alert("warn", "rotation_superseded", { ...info, currentAddress });
            done("superseded");
            continue;
          }
          if (!cfg.policy.suspendOnUnexpectedRotation) {
            alert("critical", "body_left_active_by_policy", info);
            done("policy_off");
            continue;
          }
          if (cfg.dryRun) {
            alert("critical", "would_suspend_body", info);
            done("dry_run_alerted");
            continue;
          }
          const r = await send(cfg.allowlist, allowlistV2Abi, "suspendVerifier", [leiHash]);
          alert("critical", r.tx ? "body_suspended" : "body_already_suspended", { ...info, suspendTx: r.tx, revert: r.already });
          done(r.tx ? "suspended" : "already_suspended", r.tx);
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
        }
      } catch (err) {
        failures++;
        alert("critical", "action_failed", { ...base, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
        if (retryFrom === undefined || lg.blockNumber! < retryFrom) retryFrom = lg.blockNumber!;
      }
    }
  }
  state.lastBlock = String(retryFrom !== undefined ? retryFrom - 1n : head.number);
  state.updatedAt = new Date().toISOString();
  writeJson(statePathOf(cfg), state);
  return { head: head.number, now, alerts, txs, failures };
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
