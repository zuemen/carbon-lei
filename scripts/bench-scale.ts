// Scaling benchmark on a growing ledger: a local anvil chain (no fork) with both contracts deployed as the SDK
// integration tests deploy them (sdk/test/helpers/local-chain.ts), then the ledger is grown in steps (by default
// 1, 10, 100, 1,000 and 5,000 reports, each with 2 shipment claims, spread over many verification bodies, auditors
// and suppliers). At each step it measures:
//   - gas: every bulk registerReport and claimShipment receipt of the step (min / mean / max), and one probe report
//     with a real SDK credential, its first claim and its second claim, sent alone;
//   - the verifier: the SDK's verifyPresentation on a fresh proof (the probe registered at this step) and on an old
//     proof (registered before any bulk data), R runs each with a new reader per run, counting every JSON-RPC
//     request per method and recording each eth_getLogs block range and the number of logs it returned; one
//     extra run of the old proof with the full scan from the deployment block (the fallback) for comparison;
//   - state: the registry's and the allowlist's non-zero storage slots, counted in anvil_dumpState.
// The old proof's history is mined first: right after it is registered, one day plus 100,000 more empty blocks,
// 12 s apart (about 15 days), while the state is still small. anvil recomputes the whole state root for every
// block it mines (its time per empty block grows linearly with the number of storage slots: 2,000 blocks took
// 34 ms with no slots and 8.5 s with 5,000 slots, 87 s with 50,000), so long runs of blocks after the bulk data
// would take hours; this is a cost of the test node, not of the contracts. After the steps named by
// --day-after (default 1000) one more day of blocks is mined, and that step's fresh proof is verified again with
// its 24 h window closed.
// Checks 6 and 7 (vLEI evidence: KEL anchor and authority chain) are local computations that do not read the
// ledger; here they are stubbed to pass, so a proof can end VALID (their cost is in bench-verify, docs/data/bench-verify-*).
// Bulk transactions are signed locally and sent as JSON-RPC batches with automine off, then mined with evm_mine
// into blocks of the default 30,000,000 gas limit.
// Also: block gas limits read from public L1/L2 RPCs (skipped with --no-l2), for the throughput headroom.
//
// Usage: node scripts/bench-scale.ts [--steps 1,10,100,1000,5000] [--claims 2] [--runs 7] [--port 18745]
//        [--history-blocks 100000] [--day-after 1000] [--no-l2] [--out docs/data/bench-scale-<date>.json]
// Needs anvil (Foundry) on PATH or in ~/.foundry/bin, and `forge build` output in contracts/out.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  stringToBytes,
  toHex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { emissionsClaimRegistryAbi, verifierAllowlistAbi } from "../sdk/abi.ts";
import { ChainReader, LOG_CHUNK, type ChainReaderOptions, type Deployment } from "../sdk/chain.ts";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../sdk/commitment.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../sdk/credential.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../sdk/issue.ts";
import type { Presentation } from "../sdk/disclosure.ts";
import { verifyPresentation, type CheckResult } from "../sdk/verify.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const demo = JSON.parse(readFileSync(resolve(ROOT, "fixtures/demo.json"), "utf8"));
const EORI = demo.entities.importers[0].eori as string;
const GENESIS = 1_790_000_000; // 2026-09-21, as in the SDK integration tests
const ACCREDITED_UNTIL = 1_924_905_600n; // 2030-12-31
const VALID_UNTIL = BigInt(Date.parse("2029-12-31T00:00:00Z") / 1000);
const BLOCK_TIME = 12;
const DAY_BLOCKS = 7_200;
const BODIES = 20;
const AUDITORS_PER_BODY = 2;
const SUPPLIERS = 50;
const REPORT_KG = 500_000n;
const CLAIM_KG = 200_000n;
const L1_GAS_LIMIT = 30_000_000;

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const salt = (s: string): Hex => keccak256(stringToBytes(`bench-scale:${s}`));
const keyOf = (s: string): Hex => keccak256(stringToBytes(`bench-scale-key:${s}`));

// ------------------------------------------------------------------ anvil

function anvilBin() {
  const local = resolve(homedir(), ".foundry/bin/anvil");
  return spawnSync("anvil", ["--version"]).status === 0 ? "anvil" : existsSync(local) ? local : "anvil";
}

let rpcUrl = "";
let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}
/** One JSON-RPC batch (one HTTP request); throws on the first error. */
async function rpcBatch<T = unknown>(calls: [string, unknown[]][]): Promise<T[]> {
  if (!calls.length) return [];
  const body = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: ++rpcId, method, params }));
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as { id: number; result?: T; error?: { message: string } }[];
  const byId = new Map(j.map((x) => [x.id, x]));
  return body.map((b) => {
    const x = byId.get(b.id)!;
    if (x.error) throw new Error(`${b.method}: ${x.error.message}`);
    return x.result as T;
  });
}

/** Free memory percentage from macOS `memory_pressure` (undefined elsewhere). */
function memoryFreePct(): number | undefined {
  const r = spawnSync("memory_pressure", [], { encoding: "utf8" });
  const m = r.status === 0 ? /free percentage:\s*(\d+)%/.exec(r.stdout) : null;
  return m ? Number(m[1]) : undefined;
}

// ------------------------------------------------------------------ counting reader

interface LogRange {
  fromBlock: number;
  toBlock: number;
  blocks: number;
  logs: number;
}
interface RunRecord {
  ms: number;
  overall: string;
  rpcRequests: number;
  byMethod: Record<string, number>;
  getLogs: LogRange[];
}

/** A ChainReader whose client counts every JSON-RPC request and records each eth_getLogs range (no retries). */
function countingReader(deployment: Deployment, options: ChainReaderOptions = {}) {
  const log: { method: string; range?: LogRange }[] = [];
  const base = http(rpcUrl, { retryCount: 0 });
  const transport: Transport = (opts) => {
    const t = base(opts);
    return {
      ...t,
      request: (async (args: { method: string; params?: unknown[] }, o?: unknown) => {
        const res = await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, o);
        if (args.method === "eth_getLogs") {
          const p = (args.params?.[0] ?? {}) as { fromBlock?: Hex; toBlock?: Hex };
          const from = Number(BigInt(p.fromBlock ?? "0x0"));
          const to = Number(BigInt(p.toBlock ?? "0x0"));
          log.push({ method: args.method, range: { fromBlock: from, toBlock: to, blocks: to - from + 1, logs: Array.isArray(res) ? res.length : 0 } });
        } else log.push({ method: args.method });
        return res;
      }) as typeof t.request,
    };
  };
  const client = createPublicClient({ chain: foundry, transport }) as PublicClient;
  return {
    reader: new ChainReader(client, deployment, undefined, options),
    stats() {
      const byMethod: Record<string, number> = {};
      for (const l of log) byMethod[l.method] = (byMethod[l.method] ?? 0) + 1;
      return { rpcRequests: log.length, byMethod, getLogs: log.flatMap((l) => (l.range ? [l.range] : [])) };
    },
  };
}

const pass = (index: number) => (): CheckResult => ({ index, name: "", status: "pass", code: "", detail: "stubbed in bench-scale" });
const CHECKERS = { anchor: pass(6), authority: pass(7) };

async function verifyRuns(deployment: Deployment, proof: Presentation, runs: number, options: ChainReaderOptions = {}): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (let i = 0; i <= runs; i++) {
    const c = countingReader(deployment, options);
    const t0 = performance.now();
    const r = await verifyPresentation(proof, c.reader, { importerEORI: EORI, checkers: CHECKERS });
    const ms = round(performance.now() - t0);
    if (i > 0) out.push({ ms, overall: r.overall, ...c.stats() }); // run 0: warm-up (module JIT), not recorded
  }
  return out;
}

function pct(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}
const summary = (xs: number[]) => ({ p50: pct(xs, 0.5), p95: pct(xs, 0.95), min: Math.min(...xs), max: Math.max(...xs) });
function summarize(runs: RunRecord[]) {
  const last = runs[runs.length - 1];
  return {
    overall: [...new Set(runs.map((r) => r.overall))].join(","),
    ms: summary(runs.map((r) => r.ms)),
    rpcRequests: summary(runs.map((r) => r.rpcRequests)),
    byMethod: last.byMethod,
    getLogs: last.getLogs,
    getLogsRequests: summary(runs.map((r) => r.getLogs.length)),
    getLogsBlocksSearched: summary(runs.map((r) => r.getLogs.reduce((s, g) => s + g.blocks, 0))),
    getLogsLogsReturned: summary(runs.map((r) => r.getLogs.reduce((s, g) => s + g.logs, 0))),
  };
}

// ------------------------------------------------------------------ main

function machine() {
  const c = cpus();
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const anvil = spawnSync(anvilBin(), ["--version"], { encoding: "utf8" });
  return {
    cpu: c[0]?.model ?? "unknown",
    logicalCpus: c.length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
    anvil: anvil.stdout?.split("\n")[0] ?? "unknown",
    commit: git.status === 0 ? git.stdout.trim() : "unknown",
  };
}

function bytecode(name: string): Hex {
  return JSON.parse(readFileSync(resolve(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8")).bytecode.object as Hex;
}

async function l2GasLimits() {
  const chains = [
    { name: "Ethereum mainnet", rpc: "https://ethereum-rpc.publicnode.com" },
    { name: "Base mainnet", rpc: "https://mainnet.base.org" },
    { name: "OP Mainnet", rpc: "https://mainnet.optimism.io" },
    { name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc" },
  ];
  const out = [];
  for (const c of chains) {
    try {
      const res = await fetch(c.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
        signal: AbortSignal.timeout(10_000),
      });
      const b = ((await res.json()) as { result: { number: Hex; gasLimit: Hex; timestamp: Hex } }).result;
      out.push({
        name: c.name,
        rpc: c.rpc,
        block: Number(BigInt(b.number)),
        blockTime: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(),
        gasLimit: Number(BigInt(b.gasLimit)),
      });
    } catch (e) {
      out.push({ name: c.name, rpc: c.rpc, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      steps: { type: "string", default: "1,10,100,1000,5000" },
      claims: { type: "string", default: "2" },
      runs: { type: "string", default: "7" },
      port: { type: "string", default: "18745" },
      "history-blocks": { type: "string", default: "100000" },
      "day-after": { type: "string", default: "1000" },
      "no-l2": { type: "boolean", default: false },
      "min-free": { type: "string", default: "15" },
      out: { type: "string" },
    },
  });
  const steps = (values.steps as string).split(",").map(Number);
  const claimsPerReport = Number(values.claims);
  const runs = Number(values.runs);
  const historyBlocks = Number(values["history-blocks"]);
  const dayAfter = new Set((values["day-after"] as string).split(",").filter(Boolean).map(Number));
  const minFree = Number(values["min-free"]);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const guard = (where: string) => {
    const free = memoryFreePct();
    if (free !== undefined && free < minFree) throw new Error(`memory free ${free}% < ${minFree}% at ${where}; stopping`);
    return free;
  };
  guard("start");

  const port = Number(values.port);
  rpcUrl = `http://127.0.0.1:${port}`;
  // Cancun (the contracts' EVM version) and no historical states, as in the long-chain SDK test: mining many
  // empty blocks stays fast and anvil's memory stays small.
  const proc = spawn(
    anvilBin(),
    ["--port", String(port), "--silent", "--timestamp", String(GENESIS), "--hardfork", "cancun", "--prune-history", "--gas-limit", String(L1_GAS_LIMIT)],
    { stdio: "ignore" },
  );
  const stop = () => proc.kill();
  process.on("exit", stop);
  for (let i = 0; i < 100; i++) {
    try {
      await rpc("eth_chainId");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const pub = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const wallet = (a: PrivateKeyAccount) => createWalletClient({ account: a, chain: foundry, transport: http(rpcUrl) });
  const acct = (label: string) => privateKeyToAccount(keyOf(label));
  const owner = acct("owner");
  const watcher = acct("watcher");
  const bodies = Array.from({ length: BODIES }, (_, i) => ({
    account: acct(`body-${i}`),
    lei: `ZZZZ00BENCHBODY${String(i).padStart(5, "0")}`,
    auditors: Array.from({ length: AUDITORS_PER_BODY }, (_, j) => `EBenchScaleAuditor-${i}-${j}`.padEnd(44, "0")),
  }));
  const suppliers = Array.from({ length: SUPPLIERS }, (_, i) => acct(`supplier-${i}`));
  const everyone = [owner, watcher, ...bodies.map((b) => b.account), ...suppliers];
  await rpcBatch(everyone.map((a) => ["anvil_setBalance", [a.address, toHex(10n ** 24n)]]));
  const nonces = new Map<string, number>(everyone.map((a) => [a.address, 0]));

  const ow = wallet(owner);
  const r1 = await pub.waitForTransactionReceipt({
    hash: await ow.deployContract({ abi: verifierAllowlistAbi, bytecode: bytecode("VerifierAllowlist"), args: [owner.address, watcher.address] } as never),
  });
  const allowlist = r1.contractAddress as Hex;
  const r2 = await pub.waitForTransactionReceipt({
    hash: await ow.deployContract({ abi: emissionsClaimRegistryAbi, bytecode: bytecode("EmissionsClaimRegistry"), args: [allowlist] } as never),
  });
  const registry = r2.contractAddress as Hex;
  nonces.set(owner.address, 2);
  const deployment: Deployment = {
    chainId: 31337,
    maxHeadAgeSec: Infinity,
    contracts: { VerifierAllowlist: { address: allowlist, block: Number(r1.blockNumber) }, EmissionsClaimRegistry: { address: registry, block: Number(r2.blockNumber) } },
  };

  // ---- raw transactions: signed here, sent in JSON-RPC batches
  async function signTx(from: PrivateKeyAccount, to: Hex, data: Hex, gas: bigint) {
    const nonce = nonces.get(from.address)!;
    nonces.set(from.address, nonce + 1);
    return from.signTransaction({ to, data, gas, nonce, chainId: 31337, type: "eip1559", maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 0n });
  }
  /** Sends the signed transactions with automine off, mines until the pool is empty, returns the receipts. */
  async function sendAndMine(raw: Hex[]) {
    const hashes: Hex[] = [];
    let blocks = 0;
    for (let i = 0; i < raw.length; i += 400) {
      await rpc("evm_setAutomine", [false]);
      hashes.push(...(await rpcBatch<Hex>(raw.slice(i, i + 400).map((r) => ["eth_sendRawTransaction", [r]]))));
      for (;;) {
        const st = await rpc<{ pending: Hex }>("txpool_status");
        if (BigInt(st.pending) === 0n) break;
        await rpc("evm_mine");
        blocks++;
      }
    }
    await rpc("evm_setAutomine", [true]);
    const receipts: { status: Hex; gasUsed: Hex; blockNumber: Hex }[] = [];
    for (let i = 0; i < hashes.length; i += 500) {
      receipts.push(...(await rpcBatch<{ status: Hex; gasUsed: Hex; blockNumber: Hex }>(hashes.slice(i, i + 500).map((h) => ["eth_getTransactionReceipt", [h]]))));
    }
    const failed = receipts.filter((r) => r.status !== "0x1").length;
    if (failed) throw new Error(`${failed} of ${receipts.length} bulk transactions reverted`);
    return { gas: receipts.map((r) => Number(BigInt(r.gasUsed))), blocks };
  }
  const gasStats = (g: number[]) =>
    g.length ? { count: g.length, min: Math.min(...g), mean: round(g.reduce((s, x) => s + x, 0) / g.length), max: Math.max(...g) } : { count: 0 };

  // ---- onboarding: bodies and auditors
  const onboard: Hex[] = [];
  for (const b of bodies) {
    onboard.push(
      await signTx(owner, allowlist, encodeFunctionData({
        abi: verifierAllowlistAbi,
        functionName: "addVerifier",
        args: [{ leiHash: leiHashOf(b.lei), verifier: b.account.address, leCredSaidHash: hashString(`LE-${b.lei}`), accreditationSaidHash: hashString(`ACC-${b.lei}`), accreditedUntil: ACCREDITED_UNTIL }],
      } as never), 300_000n),
    );
  }
  for (const b of bodies) {
    for (const aid of b.auditors) {
      onboard.push(
        await signTx(owner, allowlist, encodeFunctionData({
          abi: verifierAllowlistAbi,
          functionName: "addAuditor",
          args: [{ auditorAidHash: auditorAidHashOf(aid), leiHash: leiHashOf(b.lei), ecrSaidHash: hashString(`ECR-${aid}`) }],
        } as never), 200_000n),
      );
    }
  }
  const onboarding = await sendAndMine(onboard);

  // ---- probe credentials: real SDK credentials, body 0, supplier 0
  let probeN = 0;
  const probeBody = bodies[0];
  const probeSupplier = suppliers[0];
  function probeClaims(): CredentialClaims {
    probeN++;
    const s = demo.entities.supplier;
    return {
      supplierLEI: s.lei,
      operatorId: s.operatorId,
      installationId: `TW-ZZZZ00TWSCREWDEMO185-${String(8000 + probeN)}`,
      installationName: "Demo Fasteners Plant (fictional)",
      unLocode: s.unLocode,
      cnCode: "7318",
      cbamRoute: "C",
      productionRoute: "BF-BOF wire rod (illustrative)",
      reportingPeriod: demo.reports[0].reportingPeriod,
      verifiedTonnes: "500",
      specificEmbeddedEmissions_tCO2e_per_t: "1.8",
      valueType: "actual",
      methodologyNote: METHODOLOGY_NOTE,
      verificationReportId: `VR-SCALE-${String(probeN).padStart(4, "0")}`,
      verifierLEI: probeBody.lei,
      accreditationNumber: demo.entities.verifier.accreditationNumber,
      nabName: demo.entities.nab.name,
      siteVisit: "physical",
      assuranceLevel: "reasonable",
      materialityThreshold: "5%",
      energyMix: "withheld (illustrative)",
      supplierCost: "withheld (illustrative)",
      idSalt: salt(`id:${probeN}`),
      batchSalt: salt(`batch:${probeN}`),
      issuedAt: "2026-09-01T00:00:00Z",
      validUntil: "2029-12-31T00:00:00Z",
    };
  }
  /** Registers a probe credential alone (automine), then its two claims; returns the proof of the first claim and the gas. */
  async function probe() {
    const cred: SignedCredential = await issueCredential({ claims: probeClaims(), auditorAID: probeBody.auditors[0], signer: probeBody.account, registry, chainId: 31337 });
    const send = async (from: PrivateKeyAccount, data: Hex, gas: bigint) => {
      const hash = await rpc<Hex>("eth_sendRawTransaction", [await signTx(from, registry, data, gas)]);
      let r: { status: Hex; gasUsed: Hex } | null = null;
      for (let i = 0; i < 500 && !r; i++) {
        r = await rpc<{ status: Hex; gasUsed: Hex } | null>("eth_getTransactionReceipt", [hash]);
        if (!r) await new Promise((res) => setTimeout(res, 10));
      }
      if (r?.status !== "0x1") throw new Error(`probe transaction ${hash} failed: ${JSON.stringify(r)}`);
      return Number(BigInt(r.gasUsed));
    };
    const reg = await send(probeBody.account, encodeFunctionData({ abi: emissionsClaimRegistryAbi, functionName: "registerReport", args: [reportInputOf(cred, { supplier: probeSupplier.address, kelSeq: 1n })] } as never), 600_000n);
    const shipment = { batchId: `BATCH-SCALE-${probeN}-1`, quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: salt(`imp:${probeN}`) };
    const claim1 = await send(probeSupplier, encodeFunctionData({ abi: emissionsClaimRegistryAbi, functionName: "claimShipment", args: claimArgsOf(cred, { ...shipment, importerEORI: EORI }) } as never), 300_000n);
    const claim2 = await send(probeSupplier, encodeFunctionData({ abi: emissionsClaimRegistryAbi, functionName: "claimShipment", args: claimArgsOf(cred, { ...shipment, batchId: `BATCH-SCALE-${probeN}-2`, importerEORI: EORI }) } as never), 300_000n);
    const proof: Presentation = { ...present(cred, DEMO_DISCLOSURE, shipment), anchorEvidence: { stub: true }, authorityEvidence: { stub: true } };
    return { proof, reportKey: reportKeyOf(cred.core.d), gas: { registerReport: reg, claimShipmentFirst: claim1, claimShipmentSecond: claim2 } };
  }

  async function state() {
    const hex = await rpc<Hex>("anvil_dumpState");
    const buf = Buffer.from(hex.slice(2), "hex");
    const json = JSON.parse(gunzipSync(buf).toString("utf8")) as { accounts: Record<string, { storage: Record<string, string> }> };
    const slots = (a: Hex) => {
      const acc = Object.entries(json.accounts).find(([k]) => k.toLowerCase() === a.toLowerCase())?.[1];
      return acc ? Object.values(acc.storage).filter((v) => BigInt(v) !== 0n).length : 0;
    };
    // (the dump's size is not reported: it also holds anvil's block history, so it does not measure the state)
    const r = slots(registry);
    return { registrySlots: r, registryValueBytes: 32 * r, allowlistSlots: slots(allowlist) };
  }

  const mine = async (blocks: number) => {
    for (let left = blocks; left > 0; left -= 10_000) await rpc("anvil_mine", [toHex(Math.min(left, 10_000)), toHex(BLOCK_TIME)]);
  };

  const stateBefore = await state();
  const old = await probe();
  console.log(`deployed; onboarding ${BODIES} bodies × ${AUDITORS_PER_BODY} auditors; old probe registered (gas ${JSON.stringify(old.gas)})`);
  const tHist = performance.now();
  await mine(DAY_BLOCKS + historyBlocks);
  const history = {
    blocksMined: DAY_BLOCKS + historyBlocks,
    blockTimeSec: BLOCK_TIME,
    seconds: round((performance.now() - tHist) / 1000),
    headBlock: Number(await pub.getBlockNumber({ cacheTime: 0 })),
    note: "mined right after the old probe, before any bulk data (see the header of scripts/bench-scale.ts)",
  };
  console.log(`history: ${history.blocksMined} blocks in ${history.seconds} s`);

  let bulkReports = 0;
  let bulkClaims = 0;
  let prevState = await state();
  const records = [];
  for (const target of steps) {
    const tStep = performance.now();
    // ---- grow the ledger to `target` bulk reports, each with `claimsPerReport` claims
    const reg: Hex[] = [];
    const cl: Hex[] = [];
    const newReports = target - bulkReports;
    for (let k = bulkReports; k < target; k++) {
      const b = bodies[k % BODIES];
      const supplier = suppliers[k % SUPPLIERS];
      const reportKey = salt(`report:${k}`);
      reg.push(
        await signTx(b.account, registry, encodeFunctionData({
          abi: emissionsClaimRegistryAbi,
          functionName: "registerReport",
          args: [{
            reportKey,
            reportIdHash: salt(`reportId:${k}`),
            reportScopeKey: salt(`scope:${k}`),
            credScopeKey: salt(`cred:${k}`),
            auditorAidHash: auditorAidHashOf(b.auditors[k % AUDITORS_PER_BODY]),
            kelSeq: 1n,
            supplier: supplier.address,
            supplierCommit: salt(`sc:${k}`),
            installationCommit: salt(`ic:${k}`),
            verifiedKg: REPORT_KG,
            validUntil: VALID_UNTIL,
            supersedes: `0x${"0".repeat(64)}`,
          }],
        } as never), 600_000n),
      );
      for (let j = 0; j < claimsPerReport; j++) {
        cl.push(
          await signTx(supplier, registry, encodeFunctionData({
            abi: emissionsClaimRegistryAbi,
            functionName: "claimShipment",
            args: [reportKey, salt(`batch:${k}:${j}`), CLAIM_KG, salt(`importer:${k}:${j}`)],
          } as never), 300_000n),
        );
      }
    }
    const tSend = performance.now();
    const regRes = await sendAndMine(reg);
    // first and second claims of each report are interleaved per report; split them by position
    const clRes = await sendAndMine(cl);
    const sendSec = round((performance.now() - tSend) / 1000);
    bulkReports = target;
    bulkClaims += newReports * claimsPerReport;
    const firstClaims = clRes.gas.filter((_, i) => i % claimsPerReport === 0);
    const laterClaims = clRes.gas.filter((_, i) => i % claimsPerReport !== 0);
    const afterBulk = await state();

    // ---- a fresh probe, then verify fresh and old
    const fresh = await probe();
    await mine(10);
    const head = Number(await pub.getBlockNumber({ cacheTime: 0 }));
    const freshRuns = await verifyRuns(deployment, fresh.proof, runs);
    const oldRuns = await verifyRuns(deployment, old.proof, runs);
    const oldFull = await verifyRuns(deployment, old.proof, 1, { fullEventScan: true });
    let freshOneDayLater;
    if (dayAfter.has(target)) {
      const tDay = performance.now();
      await mine(DAY_BLOCKS + 10);
      freshOneDayLater = {
        blocksMined: DAY_BLOCKS + 10,
        mineSeconds: round((performance.now() - tDay) / 1000),
        headBlock: Number(await pub.getBlockNumber({ cacheTime: 0 })),
        verify: summarize(await verifyRuns(deployment, fresh.proof, runs)),
      };
    }
    const st = await state();
    const free = guard(`step ${target}`);
    const dReports = newReports;
    const dClaims = newReports * claimsPerReport;
    const rec = {
      bulkReports,
      bulkClaims,
      totalReports: bulkReports + probeN,
      totalClaims: bulkClaims + 2 * probeN,
      headBlock: head,
      blocksSinceDeployment: head - deployment.contracts.VerifierAllowlist.block + 1,
      bulk: {
        sendAndMineSeconds: sendSec,
        blocksMined: regRes.blocks + clRes.blocks,
        registerReportGas: gasStats(regRes.gas),
        claimShipmentFirstGas: gasStats(firstClaims),
        claimShipmentLaterGas: gasStats(laterClaims),
        registerReportsPerFullBlock: regRes.blocks ? round(reg.length / regRes.blocks) : null,
        claimsPerFullBlock: clRes.blocks ? round(cl.length / clRes.blocks) : null,
      },
      probeGas: fresh.gas,
      storage: {
        ...st,
        bulkDeltaRegistrySlots: afterBulk.registrySlots - prevState.registrySlots,
        bulkDeltaRegistrySlotsPerReportWithClaims: dReports ? round((afterBulk.registrySlots - prevState.registrySlots) / dReports, 3) : null,
        note: `the bulk delta covers ${dReports} reports and ${dClaims} claims of this step (probes excluded)`,
      },
      verifyFresh: summarize(freshRuns),
      verifyOld: summarize(oldRuns),
      verifyOldFullScan: summarize(oldFull),
      verifyFreshOneDayLater: freshOneDayLater,
      memoryFreePct: free,
      stepSeconds: round((performance.now() - tStep) / 1000),
    };
    prevState = st;
    records.push(rec);
    console.log(
      `step ${target}: reports ${rec.totalReports}, claims ${rec.totalClaims}, head ${head}; register gas ${JSON.stringify(rec.bulk.registerReportGas)}; ` +
        `probe ${JSON.stringify(fresh.gas)}; fresh ${rec.verifyFresh.overall} p50 ${rec.verifyFresh.ms.p50} ms ${rec.verifyFresh.rpcRequests.p50} req ` +
        `(getLogs ${rec.verifyFresh.getLogsRequests.p50}, ${rec.verifyFresh.getLogsBlocksSearched.p50} blocks); old ${rec.verifyOld.overall} p50 ${rec.verifyOld.ms.p50} ms ` +
        `${rec.verifyOld.rpcRequests.p50} req (getLogs ${rec.verifyOld.getLogsRequests.p50}, ${rec.verifyOld.getLogsBlocksSearched.p50} blocks); ` +
        `fullScan getLogs ${rec.verifyOldFullScan.getLogsRequests.p50}; ` +
        (freshOneDayLater ? `fresh+1d p50 ${freshOneDayLater.verify.ms.p50} ms, getLogs ${freshOneDayLater.verify.getLogsBlocksSearched.p50} blocks (mined in ${freshOneDayLater.mineSeconds} s); ` : "") +
        `registry slots ${st.registrySlots}; mem free ${free}%; ${rec.stepSeconds} s`,
    );
  }

  // ---- throughput headroom
  const last = records[records.length - 1];
  const claimGas = last.probeGas.claimShipmentFirst;
  const regGas = last.probeGas.registerReport;
  const limits = values["no-l2"] ? [] : await l2GasLimits();
  const perBlock = (limit: number) => ({
    claimsPerBlock: Math.floor(limit / claimGas),
    registrationsPerBlock: Math.floor(limit / regGas),
    corridorDayAt53TxShareOfOneBlock: round((53 * claimGas) / limit, 4),
  });
  // Arbitrum's block gasLimit field is a fixed large value, not a capacity; its throughput is set per second.
  const meaningful = (name: string) => name !== "Arbitrum One";
  const headroom = {
    method:
      "gas limit / measured gas per operation (first claim of a report, the dearer one; first report in a new scope). Block capacity only: ignores other traffic on a public chain, L1 data limits of an L2 and per-second gas targets",
    claimGas,
    registerGas: regGas,
    l1_30M: { gasLimit: L1_GAS_LIMIT, ...perBlock(L1_GAS_LIMIT), perDayAt12s: { claims: Math.floor(L1_GAS_LIMIT / claimGas) * DAY_BLOCKS } },
    corridor: {
      source: "docs/ADOPTION.md §6.1 corridor estimate: about 7 to 53 transactions a day (an assumption, not a measurement)",
      txPerDay: [7, 53],
      shareOfOne30MBlock: { at53PerDay: round((53 * claimGas) / L1_GAS_LIMIT, 4) },
      shareOfOneDayOf30MBlocks: { at53PerDay: (53 * claimGas) / (L1_GAS_LIMIT * DAY_BLOCKS) },
    },
    liveGasLimits: limits.map((l) =>
      "gasLimit" in l && l.gasLimit !== undefined
        ? meaningful(l.name)
          ? { ...l, ...perBlock(l.gasLimit) }
          : { ...l, note: "the block gasLimit field is a fixed placeholder on this chain, not a block capacity; no per-block figure is computed" }
        : l,
    ),
  };

  const out = {
    description:
      "Raw output of scripts/bench-scale.ts: the ledger grown in steps on a local anvil chain (no fork, no network latency), with gas, verifier requests and latency, eth_getLogs ranges and storage measured at each step. Checks 6 and 7 stubbed to pass (local computations, not ledger reads). One machine; not a load test of a public chain.",
    startedAt,
    finishedAt: new Date().toISOString(),
    totalSeconds: round((performance.now() - t0) / 1000),
    machine: machine(),
    setup: {
      anvil: `--hardfork cancun --prune-history --gas-limit ${L1_GAS_LIMIT} --timestamp ${GENESIS}`,
      bodies: BODIES,
      auditorsPerBody: AUDITORS_PER_BODY,
      suppliers: SUPPLIERS,
      claimsPerReport,
      reportKg: Number(REPORT_KG),
      claimKg: Number(CLAIM_KG),
      steps,
      runsPerProof: runs,
      dayAfterSteps: [...dayAfter],
      logChunk: Number(LOG_CHUNK),
      onboarding: { blocks: onboarding.blocks, addVerifierGas: gasStats(onboarding.gas.slice(0, BODIES)), addAuditorGas: gasStats(onboarding.gas.slice(BODIES)) },
      bulkInputs:
        "bulk reports use random 32-byte keys and commitments (the contract sees only bytes32), each a first report in a new installation scope; probes use real SDK credentials (issueCredential, reportInputOf, claimArgsOf)",
      verifier:
        "verifyPresentation with the importer's EORI, a new ChainReader (new client, empty caches) per run, one unrecorded warm-up run per series; fresh = the probe registered at this step (one day after the step's bulk data); old = the probe registered before any bulk data",
    },
    stateBeforeProbes: stateBefore,
    oldProbe: { reportKey: old.reportKey, gas: old.gas },
    history,
    steps: records,
    headroom,
  };
  const date = startedAt.slice(0, 10);
  const path = resolve(ROOT, (values.out as string) ?? `docs/data/bench-scale-${date}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote ${path} in ${out.totalSeconds} s`);
  stop();
  const bad = records.flatMap((r) => [r.verifyFresh.overall, r.verifyOld.overall]).filter((o) => o !== "VALID");
  if (bad.length) {
    console.error(`verifications not VALID: ${bad.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
