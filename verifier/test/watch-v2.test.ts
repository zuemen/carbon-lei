// The V2 monitor (src/watch-v2.ts) on a local anvil chain with VerifierAllowlistV2 and EmissionsClaimRegistryV2
// deployed from contracts/out (needs Foundry and `forge build`). Replays the CR1 attack of docs/SECURITY.md §13.1
// and the Maude model (formal/maude, CARBONLEI-CR1): a stolen owner key proposes a rotation, the monitor
// cancels it (live, or after a restart past the delay); a rotation that got through while the monitor was down
// makes it suspend the body, after which the attacker's direct revocation reverts. Also: an expected or
// body-consented rotation is left alone, dry run sends nothing, a restart does not act twice, a key without
// WATCHER_ROLE is reported, and the SDK's hand-written V2 ABI matches the compiled contracts. Delays use
// evm_increaseTime. V2 is not deployed anywhere; all LEIs are fictional (ZZZZ prefix).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  stringToBytes,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leiHashOf } from "../../sdk/commitment.ts";
import type { Hex } from "../../sdk/credential.ts";
import { allowlistV2Abi, isV2Allowlist, registryV2Abi, v2Advisory } from "../../sdk/v2.ts";
import { DEFAULT_POLICY, pollV2, type Alert, type V2MonitorConfig } from "../src/watch-v2.ts";

const PORT = 8571;
const RPC = `http://127.0.0.1:${PORT}`;
const HOUR = 3600;
const DELAY = 72 * HOUR;
// anvil's default development keys (public, test-only)
const OWNER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WATCHER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ACCREDITED_UNTIL = 1924905600n; // 2030-12-31
const VALID_UNTIL = 1830211200n; // 2027-12-31

const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
const AL = artifact("VerifierAllowlistV2");
const REG = artifact("EmissionsClaimRegistryV2");

let proc: ChildProcess;
let pub: PublicClient;
const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
const owner = privateKeyToAccount(OWNER_KEY); // plays the stolen owner key too
const watcher = privateKeyToAccount(WATCHER_KEY);
let allowlist: Hex;
let registry: Hex;
let fromBlock: bigint;
let bodyN = 0;

const wallet = (a: PrivateKeyAccount) => createWalletClient({ account: a, chain: foundry, transport: http(RPC) });

async function fresh(): Promise<PrivateKeyAccount> {
  const a = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: a.address, value: parseEther("10") });
  return a;
}

async function tx(from: PrivateKeyAccount, target: "al" | "reg", functionName: string, args: readonly unknown[]) {
  const address = target === "al" ? allowlist : registry;
  const abi = target === "al" ? AL.abi : REG.abi;
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: from } as never);
  const hash = await wallet(from).writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return r;
}

/** The revert error name of a call that must fail. */
async function reverts(from: PrivateKeyAccount, target: "al" | "reg", functionName: string, args: readonly unknown[]): Promise<string> {
  try {
    await pub.simulateContract({ address: target === "al" ? allowlist : registry, abi: target === "al" ? AL.abi : REG.abi, functionName, args, account: from } as never);
  } catch (err) {
    const m = String((err as Error).message);
    const name = /reverted with the following reason:\s*\n?\s*(\w+)/.exec(m)?.[1] ?? /Error: (\w+)\(/.exec(m)?.[1];
    return name ?? m;
  }
  throw new Error(`${functionName} did not revert`);
}

async function advance(seconds: number) {
  await test.increaseTime({ seconds });
  await test.mine({ blocks: 1 });
}

/** A new fictional body with its own address, an auditor and (optionally) one registered report. */
async function newBody(withReport = false) {
  bodyN++;
  const lei = `ZZZZ00EUV2WATCH${String(bodyN).padStart(5, "0")}`;
  const leiHash = leiHashOf(lei);
  const body = await fresh();
  await tx(owner, "al", "addVerifier", [
    { leiHash, verifier: body.address, leCredSaidHash: keccak256(stringToBytes(`LE:${lei}`)), accreditationSaidHash: keccak256(stringToBytes(`ACC:${lei}`)), accreditedUntil: ACCREDITED_UNTIL },
  ]);
  const auditorAidHash = keccak256(stringToBytes(`EAuditor-${lei}`));
  await tx(owner, "al", "addAuditor", [{ auditorAidHash, leiHash, ecrSaidHash: keccak256(stringToBytes(`ECR:${lei}`)) }]);
  let reportKey: Hex | undefined;
  if (withReport) {
    reportKey = keccak256(stringToBytes(`ESAID-${lei}`));
    await advance(HOUR);
    await tx(body, "reg", "registerReport", [
      {
        reportKey,
        reportIdHash: keccak256(stringToBytes(`VR-${lei}`)),
        reportScopeKey: keccak256(stringToBytes(`P:${lei}`)),
        credScopeKey: keccak256(stringToBytes(`Q:${lei}`)),
        auditorAidHash,
        kelSeq: 3n,
        supplier: owner.address,
        supplierCommit: keccak256(stringToBytes("supplier-commit")),
        installationCommit: keccak256(stringToBytes("installation-commit")),
        verifiedKg: 500_000n,
        validUntil: VALID_UNTIL,
        supersedes: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    ]);
  }
  // Bound well over REVOKE_HOLD ago, as an established body would be.
  await advance(DELAY + HOUR);
  return { lei, leiHash, body, reportKey };
}

function config(leiHash: Hex, over: Partial<V2MonitorConfig> = {}): V2MonitorConfig {
  return {
    rpc: RPC,
    allowlist,
    registry,
    fromBlock,
    bodies: [leiHash],
    expectedRotations: [],
    expectedRevocations: [],
    policy: { ...DEFAULT_POLICY },
    dryRun: false,
    statePath: join(mkdtempSync(join(tmpdir(), "watch-v2-")), "state.json"),
    intervalMs: 1000,
    ...over,
  };
}

/** Runs one poll with the watcher key (or `account`), collecting the alerts. */
async function poll(cfg: V2MonitorConfig, account: PrivateKeyAccount | undefined = watcher) {
  const seen: Alert[] = [];
  const r = await pollV2(cfg, { emit: (a) => seen.push(a), account, client: pub });
  return { ...r, types: seen.map((a) => a.type), seen };
}

const pending = async (leiHash: Hex) =>
  (await pub.readContract({ address: allowlist, abi: allowlistV2Abi, functionName: "pendingRotations", args: [leiHash] }))[0];
const institution = (leiHash: Hex) => pub.readContract({ address: allowlist, abi: allowlistV2Abi, functionName: "institutions", args: [leiHash] });

beforeAll(async () => {
  proc = spawn("anvil", ["--port", String(PORT), "--silent", "--timestamp", "1790000000"], { stdio: "ignore" });
  pub = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const ow = wallet(owner);
  const h1 = await ow.deployContract({ abi: AL.abi, bytecode: AL.bytecode.object, args: [owner.address, watcher.address], account: owner, chain: foundry });
  const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
  allowlist = r1.contractAddress!.toLowerCase() as Hex;
  fromBlock = r1.blockNumber;
  const h2 = await ow.deployContract({ abi: REG.abi, bytecode: REG.bytecode.object, args: [allowlist], account: owner, chain: foundry });
  registry = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!.toLowerCase() as Hex;
}, 30_000);

afterAll(() => proc?.kill());

describe("V2 monitor: CR1 replay on a local chain", () => {
  it("live: a stolen owner key proposes a rotation; the monitor cancels it and the rotation can never execute", async () => {
    const { leiHash, body } = await newBody();
    const thief = await fresh();
    const cfg = config(leiHash);
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);

    const r = await poll(cfg);
    expect(r.types).toEqual(["rotation_proposed_unexpected", "rotation_cancelled"]);
    expect(r.txs).toHaveLength(1);
    expect(await pending(leiHash)).toBe("0x0000000000000000000000000000000000000000");

    await advance(DELAY + HOUR);
    expect(await reverts(thief, "al", "executeRotation", [leiHash])).toBe("NoPendingRotation");
    expect((await institution(leiHash))[0]).toBe(body.address);
    // Restart on the same state file: nothing new, nothing sent twice.
    const again = await poll(cfg);
    expect(again.types).toEqual([]);
    expect(again.txs).toEqual([]);
  });

  it("monitor down past the delay, restarted before anyone executes: it still cancels (cancel has no deadline while pending)", async () => {
    const { leiHash, body } = await newBody();
    const thief = await fresh();
    const cfg = config(leiHash);
    expect((await poll(cfg)).types).toEqual([]); // state file at the current head
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    await advance(DELAY + HOUR); // monitor down; the proposal is now executable

    const r = await poll(cfg);
    expect(r.types).toEqual(["rotation_proposed_unexpected", "rotation_cancelled"]);
    expect(r.seen[0].secondsLeft).toBe("0");
    expect(await reverts(thief, "al", "executeRotation", [leiHash])).toBe("NoPendingRotation");
    expect((await institution(leiHash))[0]).toBe(body.address);
  });

  it("rotation executed while the monitor was down: after restart it suspends the body and cancels the queued revocation; the attacker's later direct revoke reverts", async () => {
    const { leiHash, reportKey } = await newBody(true);
    const thief = await fresh();
    const cfg = config(leiHash);
    expect((await poll(cfg)).types).toEqual([]);

    // Monitor down: the stolen key proposes, waits the delay, executes; the thief queues a revocation at once.
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    await advance(DELAY);
    await tx(thief, "al", "executeRotation", [leiHash]);
    await tx(thief, "reg", "revokeReport", [reportKey, 0n]);
    const [req] = await pub.readContract({ address: registry, abi: registryV2Abi, functionName: "pendingRevocations", args: [reportKey!] });
    expect(req.toLowerCase()).toBe(thief.address.toLowerCase());
    await advance(HOUR);

    const r = await poll(cfg);
    expect(r.types).toEqual([
      "rotation_proposed_unexpected",
      "rotation_no_longer_pending",
      "rotation_executed_unexpected",
      "body_suspended",
      "revocation_queued_unexpected",
      "revocation_cancelled",
    ]);
    const executed = r.seen.find((a) => a.type === "body_suspended")!;
    expect(executed.late).toBe(false); // within REVOKE_HOLD of the rotation
    const inst = await institution(leiHash);
    expect(inst[5]).not.toBe(0n); // suspendedAt
    expect(inst[6]).toBe(0n); // not lifted

    // The attacker waits until its address has been bound for REVOKE_HOLD and revokes directly: refused.
    await advance(DELAY + HOUR);
    expect(await reverts(thief, "reg", "revokeReport", [reportKey, 0n])).toBe("NotActiveVerifier");
    expect(await reverts(thief, "reg", "executeRevocation", [reportKey])).toBe("NoPendingRevocation");
    const rep = (await pub.readContract({ address: registry, abi: REG.abi, functionName: "reports", args: [reportKey] })) as { revokedAt: bigint };
    expect(rep.revokedAt).toBe(0n);

    // Restart: nothing sent twice.
    expect((await poll(cfg)).txs).toEqual([]);
  });

  it("expected rotation (body's out-of-band confirmation in the config): not cancelled, executed, body not suspended", async () => {
    const { lei, leiHash } = await newBody();
    const next = await fresh();
    const cfg = config(leiHash, { expectedRotations: [{ leiHash: leiHashOf(lei), newAddr: next.address.toLowerCase() as Hex }] });
    await tx(owner, "al", "proposeRotation", [leiHash, next.address]);
    const r1 = await poll(cfg);
    expect(r1.types).toEqual(["rotation_proposed_expected"]);
    expect(r1.txs).toEqual([]);
    await advance(DELAY);
    await tx(next, "al", "executeRotation", [leiHash]);
    const r2 = await poll(cfg);
    expect(r2.types).toEqual(["rotation_executed_expected"]);
    expect(r2.txs).toEqual([]);
    const inst = await institution(leiHash);
    expect(inst[0]).toBe(next.address);
    expect(inst[5]).toBe(0n);
  });

  it("a rotation executed with the body's signed consent (executeRotationSigned) is not suspended", async () => {
    const { leiHash, body } = await newBody();
    const next = await fresh();
    const cfg = config(leiHash);
    expect((await poll(cfg)).types).toEqual([]);
    await tx(owner, "al", "proposeRotation", [leiHash, next.address]);
    const digest = (await pub.readContract({ address: allowlist, abi: AL.abi, functionName: "rotationDigest", args: [leiHash, next.address] })) as Hex;
    const sig = await body.sign({ hash: digest });
    await tx(next, "al", "executeRotationSigned", [leiHash, sig]);
    const r = await poll(cfg);
    expect(r.types).toEqual(["rotation_proposed_unexpected", "rotation_no_longer_pending", "rotation_executed_with_body_consent"]);
    expect(r.txs).toEqual([]);
    expect((await institution(leiHash))[5]).toBe(0n);
  });

  it("dry run: alerts only, sends no transaction, and does not consume the events for a later real run", async () => {
    const { leiHash } = await newBody();
    const thief = await fresh();
    const cfg = config(leiHash);
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    const nonce = await pub.getTransactionCount({ address: watcher.address });

    const dry = await poll({ ...cfg, dryRun: true }, undefined);
    expect(dry.types).toEqual(["rotation_proposed_unexpected", "would_cancel_rotation"]);
    expect(dry.txs).toEqual([]);
    expect(await pub.getTransactionCount({ address: watcher.address })).toBe(nonce);
    expect((await pending(leiHash)).toLowerCase()).toBe(thief.address.toLowerCase());
    expect((await poll({ ...cfg, dryRun: true }, undefined)).types).toEqual([]); // dry-run state: no repeat alert

    const real = await poll(cfg);
    expect(real.types).toEqual(["rotation_proposed_unexpected", "rotation_cancelled"]);
  });

  it("policy switched off: alerts critically but leaves the proposal pending", async () => {
    const { leiHash } = await newBody();
    const thief = await fresh();
    const cfg = config(leiHash, { policy: { ...DEFAULT_POLICY, cancelUnexpectedRotations: false } });
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    const r = await poll(cfg);
    expect(r.types).toEqual(["rotation_proposed_unexpected", "rotation_left_pending_by_policy"]);
    expect(r.txs).toEqual([]);
    await tx(owner, "al", "cancelRotation", [leiHash]);
  });

  it("a key without WATCHER_ROLE is reported, and its failed action is retried on the next poll", async () => {
    const { leiHash } = await newBody();
    const thief = await fresh();
    const notWatcher = await fresh();
    const cfg = config(leiHash);
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    const bad = await poll(cfg, notWatcher);
    expect(bad.types).toEqual(["watcher_role_missing", "rotation_proposed_unexpected", "action_failed"]);
    expect(bad.failures).toBe(1);
    // The same state file with the real watcher key: the event is replayed and acted on.
    const good = await poll(cfg);
    expect(good.types).toEqual(["rotation_proposed_unexpected", "rotation_cancelled"]);
  });

  it("refuses a V1 allowlist and a state file from another deployment", async () => {
    const { leiHash } = await newBody();
    const cfg = config(leiHash);
    await poll(cfg);
    await expect(pollV2({ ...cfg, registry: "0x000000000000000000000000000000000000dEaD" as Hex }, { emit: () => {}, account: watcher, client: pub })).rejects.toThrow(
      /another deployment/,
    );
    await expect(pollV2({ ...cfg, allowlist: watcher.address }, { emit: () => {}, account: watcher, client: pub })).rejects.toThrow(/not a VerifierAllowlistV2/);
  });
});

describe("SDK V2 read support (sdk/v2.ts)", () => {
  it("tells V2 from a non-V2 address and reports a pending rotation and a queued revocation as advisory notes", async () => {
    expect(await isV2Allowlist(pub, allowlist)).toBe(true);
    expect(await isV2Allowlist(pub, registry)).toBe(false); // a contract without ROTATION_DELAY
    const { leiHash, reportKey } = await newBody(true);
    const thief = await fresh();
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    const now = (await pub.getBlock()).timestamp;
    const adv = await v2Advisory(pub, { allowlist, registry }, { leiHash, reportKey, now });
    expect(adv).toMatchObject({ v2: true, rotationDelaySec: 259200n, revokeHoldSec: 259200n, queuedRevocation: null });
    expect(adv!.pendingRotation!.newAddr).toBe(thief.address);
    expect(adv!.notes[0]).toMatch(/pending; executable at/);
    await tx(owner, "al", "cancelRotation", [leiHash]);
  });

  it("the hand-written V2 ABI fragments match the compiled contracts", () => {
    const check = (frag: Abi, compiled: Abi) => {
      for (const f of frag) {
        if (f.type === "function") {
          const sel = toFunctionSelector(f as AbiFunction);
          const c = compiled.find((x) => x.type === "function" && toFunctionSelector(x as AbiFunction) === sel) as AbiFunction | undefined;
          expect(c, f.name).toBeDefined();
          expect(c!.outputs.map((o) => o.type)).toEqual(f.outputs.map((o) => o.type));
        } else if (f.type === "event") {
          const sel = toEventSelector(f as AbiEvent);
          const c = compiled.find((x) => x.type === "event" && toEventSelector(x as AbiEvent) === sel) as AbiEvent | undefined;
          expect(c, f.name).toBeDefined();
          expect(c!.inputs.map((i) => i.indexed ?? false)).toEqual(f.inputs.map((i) => i.indexed ?? false));
        } else if (f.type === "error") {
          expect(compiled.some((x) => x.type === "error" && x.name === f.name), f.name).toBe(true);
        }
      }
    };
    check(allowlistV2Abi as Abi, AL.abi);
    check(registryV2Abi as Abi, REG.abi);
  });
});
