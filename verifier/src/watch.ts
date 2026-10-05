// Watches the issuer's KEL for the revocation of a credential (default: the auditor's ECR, issued by
// the verifier) and syncs it on-chain with `revokeAuditor` (scripts/demo-scenario.ts, WATCHER key).
//
// It never trusts a local credential `status`: TEL updates are not pushed to other agents, so the
// importer's copy keeps saying `iss` after a revocation. Instead, each poll a non-issuing agent
// (default: the importer) asks the witnesses for the issuer's key state (keyStates().query), then
// scans the issuer's KEL (keyEvents().get) for the seal { i: credSAID, s: "1" } that anchors the
// TEL `rev` event. The KEL is witnessed, so the issuer cannot hide a revocation from one verifier.
//
// On detection it writes fixtures/evidence/revocation-<credSAID>.json (detection time, KEL sequence
// number, seal, raw event, re-checks) and, only with --send, runs
//   node scripts/demo-scenario.ts --network <network> --steps revokeAuditor
// as a child process with this process's environment. On Sepolia the caller provides
// WATCHER_PRIVATE_KEY and SEPOLIA_RPC_URL (or --rpc), e.g. `node --env-file=.env ...`.
// Without --send it only prints "would call revokeAuditor".
//
//   node verifier/src/watch.ts [--cred <SAID>] [--as importer] [--interval 15] [--settle 3]
//                              [--once] [--send] [--network sepolia|local] [--rpc <url>]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log, sleep, waitOp, type Json } from "./keri.ts";
import { checkSealEvent, findIssuanceSeal, findRevocationSeal, type SealHit } from "./revocation.ts";
import {
  AGENT_KEYS,
  EVIDENCE_DIR,
  FIXTURE_PATH,
  REPO_ROOT,
  readJson,
  reconnect,
  requireState,
  writeJson,
  type AgentKey,
  type Party,
  type PrivateState,
} from "./state.ts";

const DEMO_SCENARIO = resolve(REPO_ROOT, "scripts/demo-scenario.ts");
const SAID_RE = /^E[A-Za-z0-9_-]{43}$/;
/** Credential label in fixtures/vlei.json -> demo-scenario step that syncs its revocation on-chain. */
const CHAIN_STEP: Record<string, string> = { ecr: "revokeAuditor" };
/** Attempts at the on-chain step (demo-scenario simulates before sending and skips a recorded step, so a retry is safe). */
const SEND_ATTEMPTS = 3;
/** Heartbeat line every this many quiet polls (15 s x 20 = 5 min). */
const HEARTBEAT_POLLS = 20;

export interface Target {
  credSaid: string;
  label: string;
  issuerKey: AgentKey;
  issuerPre: string;
  holderKey: AgentKey;
  holderPre: string;
}

export interface Options {
  target: Target;
  observerKey: AgentKey;
  intervalMs: number;
  settleMs: number;
  once: boolean;
  send: boolean;
  network: "sepolia" | "local";
  rpc?: string;
}

function usage(msg: string): never {
  console.error(`watch: ${msg}`);
  console.error(
    "usage: node verifier/src/watch.ts [--cred <SAID>] [--as <agent>] [--interval <s>] [--settle <s>] [--once] [--send] [--network sepolia|local] [--rpc <url>]",
  );
  process.exit(2);
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      cred: { type: "string" },
      as: { type: "string", default: "importer" },
      interval: { type: "string", default: "15" },
      settle: { type: "string", default: "3" },
      once: { type: "boolean", default: false },
      send: { type: "boolean", default: false },
      network: { type: "string", default: "sepolia" },
      rpc: { type: "string" },
    },
  });
  const fx = readJson(FIXTURE_PATH);
  if (values.cred !== undefined && !SAID_RE.test(values.cred)) usage(`--cred ${values.cred} is not a 44-char SAID`);
  const entries = Object.entries<Json>(fx.credentials);
  const found = values.cred ? entries.find(([, c]) => c.said === values.cred) : (["ecr", fx.credentials.ecr] as [string, Json]);
  if (!found?.[1]) usage(`credential ${values.cred ?? "ecr"} is not in fixtures/vlei.json`);
  const [label, c] = found;
  const target: Target = {
    credSaid: c.said,
    label,
    issuerKey: c.issuer,
    issuerPre: fx.agents[c.issuer].aid,
    holderKey: c.issuee,
    holderPre: fx.agents[c.issuee].aid,
  };

  const observerKey = values.as as AgentKey;
  if (!AGENT_KEYS.includes(observerKey)) usage(`--as must be one of ${AGENT_KEYS.join(", ")}`);
  if (observerKey === target.issuerKey) usage(`--as ${observerKey} is the issuer; watch from an independent agent (default importer)`);
  const interval = Number(values.interval);
  const settle = Number(values.settle);
  if (!Number.isFinite(interval) || interval < 1) usage("--interval must be >= 1 second");
  if (!Number.isFinite(settle) || settle < 0 || settle >= interval) usage("--settle must be >= 0 and below --interval");
  const network = values.network as Options["network"];
  if (network !== "sepolia" && network !== "local") usage("--network must be sepolia or local");

  const opts: Options = {
    target,
    observerKey,
    intervalMs: interval * 1000,
    settleMs: settle * 1000,
    once: values.once!,
    send: values.send!,
    network,
    rpc: values.rpc,
  };
  if (opts.send) {
    if (!CHAIN_STEP[label]) usage(`--send: no on-chain step for credential "${label}" (only ${Object.keys(CHAIN_STEP).join(", ")})`);
    if (!existsSync(DEMO_SCENARIO)) usage(`--send: ${DEMO_SCENARIO} not found`);
    if (network === "sepolia") {
      // Presence only; values are never printed. demo-scenario reads them from the inherited environment.
      const missing = ["WATCHER_PRIVATE_KEY", ...(opts.rpc ? [] : ["SEPOLIA_RPC_URL"])].filter((k) => !process.env[k]);
      if (missing.length) usage(`--send on sepolia needs ${missing.join(", ")} in the environment (e.g. node --env-file=.env)`);
    }
  }
  return opts;
}

function scenarioArgs(o: Options, step: string): string[] {
  return [DEMO_SCENARIO, "--network", o.network, "--steps", step, ...(o.rpc ? ["--rpc", o.rpc] : [])];
}

function displayCommand(o: Options, step: string): string {
  return `node scripts/demo-scenario.ts --network ${o.network} --steps ${step}${o.rpc ? " --rpc <url>" : ""}`;
}

/** Asks the witnesses for the issuer's latest key state, lets KERIA fetch any new events, then reads the KEL. */
async function readIssuerKel(p: Party, pre: string, settleMs: number): Promise<{ events: { ked: Json; atc: string }[]; queriedSn: number }> {
  const op = await p.client.keyStates().query(pre);
  const done = (await waitOp(p.client, op)) as Json;
  // A no-sn query can complete on the previous key-state notice before the new one arrives;
  // the settle delay lets the fresh notice and log fetch land before the KEL is read.
  if (settleMs > 0) await sleep(settleMs);
  const events = (await p.client.keyEvents().get(pre)) as { ked: Json; atc: string }[];
  return { events, queriedSn: done.response?.s ? parseInt(done.response.s, 16) : NaN };
}

function txLogStep(network: string, step: string): Json | undefined {
  const path = resolve(REPO_ROOT, `fixtures/${network}-tx.json`);
  if (!existsSync(path)) return undefined;
  return (readJson(path).txs as Json[]).find((t) => t.step === step && t.result === "success");
}

function runScenario(o: Options, step: string): Promise<number> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, scenarioArgs(o, step), { cwd: REPO_ROOT, env: process.env, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code, signal) => ok(code ?? (signal ? 1 : 0)));
  });
}

/** Side effects of a detection, injectable so the detection-to-sync path can be tested without KERIA or a chain. */
export interface DetectionDeps {
  evidenceDir: string;
  run: (o: Options, step: string) => Promise<number>;
  txLog: (network: string, step: string) => Json | undefined;
  /** Delay between attempts at the on-chain step; default the poll interval. */
  retryDelayMs?: number;
}

const DEFAULT_DEPS: DetectionDeps = { evidenceDir: EVIDENCE_DIR, run: runScenario, txLog: txLogStep };

/** Writes the revocation evidence and, with --send and passing re-checks, runs the on-chain step. Returns the exit code. */
export async function onDetected(
  o: Options,
  observer: { key: string; aid: { prefix: string } },
  hit: SealHit,
  events: { ked: Json; atc?: string }[],
  ctx: { watchStartedAt: string; polls: number },
  deps: DetectionDeps = DEFAULT_DEPS,
): Promise<number> {
  const now = new Date().toISOString();
  const { target } = o;
  const path = resolve(deps.evidenceDir, `revocation-${target.credSaid}.json`);
  const prev = existsSync(path) ? readJson(path) : undefined;
  const same = prev?.seal?.d === hit.seal.d && prev?.kelSeq === hit.sn;
  const checks = checkSealEvent(hit, events);
  const iss = findIssuanceSeal(events, target.credSaid, { issuer: target.issuerPre });
  const step = CHAIN_STEP[target.label];
  const checksOk = checks.saidRecomputed && checks.sizeMatchesVersion && checks.priorLinked && checks.signatureValid;

  const evidence: Json = {
    note:
      "Revocation of a credential, detected in the issuer's KEL: the event at kelSeq carries the seal " +
      "{ i: credSAID, s: '1', d: <TEL rev event SAID> }. Read by an independent agent after a witness key-state query; " +
      "no local credential status was used. Verify: SAID = Blake3-256 over `event.raw` with `d` replaced by 44 '#'; " +
      "signature = Ed25519 over the UTF-8 bytes of `event.raw` with the issuer's current signing key.",
    credSAID: target.credSaid,
    credential: target.label,
    issuer: { agent: target.issuerKey, aid: target.issuerPre },
    holder: { agent: target.holderKey, aid: target.holderPre },
    observer: { agent: observer.key, aid: observer.aid.prefix, method: "keyStates().query + keyEvents().get" },
    detectedAt: same ? prev.detectedAt : now,
    ...(same ? { redetectedAt: now } : {}),
    watchStartedAt: same ? prev.watchStartedAt : ctx.watchStartedAt,
    polls: ctx.polls,
    intervalSeconds: o.intervalMs / 1000,
    kelSeq: hit.sn,
    seal: hit.seal,
    revEventSAID: hit.seal.d,
    event: { raw: hit.raw, said: hit.eventSaid, type: hit.eventType, sn: hit.ked.s, prior: hit.ked.p, seals: hit.ked.a },
    kelAttachment: hit.atc ?? null,
    issuance: iss ? { kelSeq: iss.sn, seal: iss.seal, eventSAID: iss.eventSaid } : null,
    checks: {
      saidRecomputed: checks.saidRecomputed,
      sizeMatchesVersion: checks.sizeMatchesVersion,
      priorLinked: checks.priorLinked,
      signatureValid: checks.signatureValid,
      establishmentEvent: checks.establishmentEvent,
      signingKeys: checks.signingKeys,
      signatures: checks.signatures,
    },
    chainSync: (step
      ? { network: o.network, step, command: displayCommand(o, step), sent: false }
      : { network: o.network, step: null, sent: false, note: `no on-chain step for credential "${target.label}"` }) as Json,
  };
  writeJson(path, evidence);
  log(`REVOKED: ${target.label} ${target.credSaid} — seal in ${target.issuerKey} KEL at sn ${hit.sn} (event ${hit.eventSaid}, rev ${hit.seal.d})`);
  log(`wrote ${path}`);

  if (!checksOk) {
    evidence.chainSync.refused = "seal event failed its re-checks";
    writeJson(path, evidence);
    console.error("revocation event failed its own checks; not syncing on-chain", evidence.checks);
    return 1;
  }
  if (!step) {
    console.log(`no on-chain step for credential "${target.label}"; evidence only`);
    return 0;
  }
  if (!o.send) {
    console.log(`would call ${step}: ${displayCommand(o, step)}   (pass --send to send it)`);
    return 0;
  }

  const prior = deps.txLog(o.network, step);
  if (prior) log(`note: ${step} already recorded in fixtures/${o.network}-tx.json (${prior.hash}); demo-scenario will skip it`);
  let exitCode = 1;
  let attempts = 0;
  while (attempts < SEND_ATTEMPTS) {
    attempts++;
    log(`calling ${displayCommand(o, step)} (attempt ${attempts}/${SEND_ATTEMPTS})`);
    exitCode = await deps.run(o, step);
    if (exitCode === 0) break;
    if (attempts < SEND_ATTEMPTS) {
      log(`${step} exited with ${exitCode}; retrying`);
      await sleep(deps.retryDelayMs ?? o.intervalMs);
    }
  }
  const tx = deps.txLog(o.network, step);
  evidence.chainSync = {
    ...evidence.chainSync,
    sent: true,
    attempts,
    exitCode,
    finishedAt: new Date().toISOString(),
    tx: tx ? { hash: tx.hash, block: tx.block, time: tx.time } : null,
    secondsFromDetectionToBlock: tx ? Math.round((Date.parse(tx.time) - Date.parse(evidence.detectedAt)) / 1000) : null,
  };
  writeJson(path, evidence);
  if (exitCode !== 0) console.error(`${step} failed (exit ${exitCode}); evidence kept at ${path}`);
  else log(`${step} on ${o.network}: ${tx ? `${tx.hash} · block ${tx.block} · ${tx.time}` : "done (no tx record found)"}`);
  return exitCode;
}

async function watch(o: Options, state: PrivateState): Promise<number> {
  const { target } = o;
  const watchStartedAt = new Date().toISOString();
  log(
    `watching ${target.issuerKey} KEL ${target.issuerPre} for the revocation of ${target.label} ${target.credSaid} ` +
      `as ${o.observerKey}; every ${o.intervalMs / 1000} s${o.once ? " (once)" : ""}; ` +
      `on-chain sync: ${o.send ? `SEND ${CHAIN_STEP[target.label]} on ${o.network}` : "off (dry run)"}`,
  );
  let observer: Party | undefined;
  let lastSn = -1;
  let quiet = 0;
  for (let polls = 1; ; polls++) {
    const t0 = Date.now();
    try {
      observer ??= await reconnect(state, o.observerKey);
      const { events, queriedSn } = await readIssuerKel(observer, target.issuerPre, o.settleMs);
      if (events.length === 0) throw new Error(`${o.observerKey} does not know ${target.issuerPre} (OOBI not resolved?)`);
      const kelSn = Math.max(...events.map((e) => parseInt(e.ked.s, 16)));
      const hit = findRevocationSeal(events, target.credSaid, { issuer: target.issuerPre });
      if (hit) return await onDetected(o, observer, hit, events, { watchStartedAt, polls });

      const iss = findIssuanceSeal(events, target.credSaid, { issuer: target.issuerPre });
      if (!iss) {
        console.error(`issuance seal { i: ${target.credSaid}, s: "0" } is not in the ${target.issuerKey} KEL: wrong credential or issuer`);
        return 1;
      }
      const status = {
        revoked: false,
        credSAID: target.credSaid,
        credential: target.label,
        issuer: target.issuerPre,
        observer: `${o.observerKey} ${observer.aid.prefix}`,
        kelSn,
        queriedSn,
        issuance: { kelSeq: iss.sn, seal: iss.seal },
        checkedAt: new Date().toISOString(),
      };
      if (o.once) {
        log(`not revoked: ${target.issuerKey} KEL sn ${kelSn}, ${target.label} issuance anchored at sn ${iss.sn}, no { i: credSAID, s: "1" } seal`);
        console.log(JSON.stringify(status));
        return 0;
      }
      if (kelSn !== lastSn || ++quiet >= HEARTBEAT_POLLS) {
        const changed = kelSn !== lastSn && lastSn >= 0 ? `, was ${lastSn}` : "";
        log(`poll ${polls}: not revoked (issuer KEL sn ${kelSn}${changed}; poll took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        quiet = 0;
      }
      lastSn = kelSn;
    } catch (err) {
      if (o.once) throw err;
      log(`poll ${polls} failed: ${err instanceof Error ? err.message : err}; retrying with a fresh connection`);
      observer = undefined;
    }
    await sleep(o.intervalMs);
  }
}

async function main(): Promise<number> {
  const o = parseOptions();
  return watch(o, requireState());
}

// Exit explicitly once stdout is flushed: idle HTTP connections to KERIA would otherwise keep the process alive.
const isMain = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main()
    .then((code) => process.stdout.write("", () => process.exit(code)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
