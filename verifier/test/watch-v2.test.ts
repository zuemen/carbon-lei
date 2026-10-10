// The V2 monitor (src/watch-v2.ts) on a local anvil chain with VerifierAllowlistV2 and EmissionsClaimRegistryV2
// deployed from contracts/out (needs Foundry and `forge build`). Replays the CR1 attack of docs/SECURITY.md §13.1
// and the Maude model (formal/maude, CARBONLEI-CR1): a stolen owner key proposes a rotation, the monitor
// cancels it (live, or after a restart past the delay); a rotation that got through while the monitor was down
// makes it suspend the body, after which the attacker's direct revocation reverts. Also: an expected or
// body-consented rotation is left alone, dry run sends nothing, a restart does not act twice, a key without
// WATCHER_ROLE is reported, and the SDK's hand-written V2 ABI matches the compiled contracts. The "review
// fixes" block replays the monitor-side findings of our own AI-run review (2026-10-10, docs/SECURITY.md §13.1):
// a chained rotation hidden behind a hostile address's consent (H1), a shadow watcher grant and a foreign
// suspension lift (H2), supersede/takeover and new-body alerts, reorg safety (L1), RPC range limits (L2) and a
// registry wired to another allowlist (L3). Delays use evm_increaseTime. V2 is not deployed anywhere; all LEIs
// are fictional (ZZZZ prefix).
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

/** Monitor config for one body, starting at the next block (earlier test bodies' events are not replayed). */
async function config(leiHash: Hex, over: Partial<V2MonitorConfig> = {}): Promise<V2MonitorConfig> {
  return {
    rpc: RPC,
    allowlist,
    registry,
    fromBlock: (await pub.getBlockNumber({ cacheTime: 0 })) + 1n,
    bodies: [leiHash],
    expectedRotations: [],
    expectedRevocations: [],
    expectedWatchers: [],
    expectedBodies: [],
    expectedAuditors: [],
    expectedOwners: [],
    trustedLifters: [],
    confirmations: 0, // anvil mines one block per transaction; L1 has its own test
    logChunk: 10_000n,
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
  const h2 = await ow.deployContract({ abi: REG.abi, bytecode: REG.bytecode.object, args: [allowlist], account: owner, chain: foundry });
  registry = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!.toLowerCase() as Hex;
}, 30_000);

afterAll(() => proc?.kill());

describe("V2 monitor: CR1 replay on a local chain", () => {
  it("live: a stolen owner key proposes a rotation; the monitor cancels it and the rotation can never execute", async () => {
    const { leiHash, body } = await newBody();
    const thief = await fresh();
    const cfg = await config(leiHash);
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
    const cfg = await config(leiHash);
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
    const cfg = await config(leiHash);
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
    const cfg = await config(leiHash, { expectedRotations: [{ leiHash: leiHashOf(lei), newAddr: next.address.toLowerCase() as Hex }] });
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
    const cfg = await config(leiHash);
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
    const cfg = await config(leiHash);
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
    const cfg = await config(leiHash, { policy: { ...DEFAULT_POLICY, cancelUnexpectedRotations: false } });
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
    const cfg = await config(leiHash);
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
    const cfg = await config(leiHash);
    await poll(cfg);
    await expect(pollV2({ ...cfg, registry: "0x000000000000000000000000000000000000dEaD" as Hex }, { emit: () => {}, account: watcher, client: pub })).rejects.toThrow(
      /another deployment/,
    );
    await expect(pollV2({ ...cfg, allowlist: watcher.address }, { emit: () => {}, account: watcher, client: pub })).rejects.toThrow(/not a VerifierAllowlistV2/);
  });
});

describe("V2 monitor: review fixes (our own AI-run review, 2026-10-10)", () => {
  const watcherRole = () => pub.readContract({ address: allowlist, abi: allowlistV2Abi, functionName: "WATCHER_ROLE" });

  it("H1: a hostile rotation, then a consented hop from the hostile address once it is mature: the chain stays tainted and the body is suspended", async () => {
    const { leiHash, reportKey } = await newBody(true);
    const thiefK = await fresh();
    const thief2 = await fresh();
    const cfg = await config(leiHash);
    expect((await poll(cfg)).types).toEqual([]);

    // Monitor down. Hop 1 by delay; the review's PoC (thiefK consents at once) is refused by the contract now.
    await tx(owner, "al", "proposeRotation", [leiHash, thiefK.address]);
    await advance(DELAY);
    await tx(thiefK, "al", "executeRotation", [leiHash]);
    await tx(owner, "al", "proposeRotation", [leiHash, thief2.address]);
    const digest = (await pub.readContract({ address: allowlist, abi: AL.abi, functionName: "rotationDigest", args: [leiHash, thief2.address] })) as Hex;
    const sig = await thiefK.sign({ hash: digest });
    expect(await reverts(thiefK, "al", "executeRotationSigned", [leiHash, sig])).toBe("ConsentSignerNotMature");
    // Still down when thiefK matures: its consent now passes the contract (hop 2).
    await advance(DELAY);
    await tx(thiefK, "al", "executeRotationSigned", [leiHash, sig]);
    await advance(HOUR);

    const r = await poll(cfg);
    expect(r.types).toEqual([
      "rotation_proposed_unexpected",
      "rotation_no_longer_pending",
      "rotation_executed_unexpected",
      "rotation_proposed_unexpected",
      "rotation_no_longer_pending",
      "rotation_executed_unexpected",
      "body_suspended",
    ]);
    expect(r.seen[2].superseded).toBe(true);
    expect(r.seen[5].reason).toMatch(/earlier unexpected rotation/);
    await advance(DELAY + HOUR);
    expect(await reverts(thief2, "reg", "revokeReport", [reportKey, 0n])).toBe("NotActiveVerifier");
    expect((await poll(cfg)).txs).toEqual([]);
  });

  it("H2: direct grantRole(WATCHER_ROLE) reverts; an unexpected grant proposal is cancelled and can never execute", async () => {
    const { leiHash } = await newBody();
    const shadow = await fresh();
    const cfg = await config(leiHash);
    const role = await watcherRole();
    expect(await reverts(owner, "al", "grantRole", [role, shadow.address])).toBe("RoleGrantNeedsDelay");
    await tx(owner, "al", "proposeRoleGrant", [role, shadow.address]);
    const r = await poll(cfg);
    expect(r.types).toEqual(["role_grant_proposed_unexpected", "role_grant_cancelled"]);
    await advance(DELAY + HOUR);
    expect(await reverts(shadow, "al", "executeRoleGrant", [role, shadow.address])).toBe("NoPendingRoleGrant");
    expect((await poll(cfg)).types).toEqual([]);
  });

  it("H2: a suspension the monitor made, lifted by another watcher, is re-imposed", async () => {
    const { leiHash } = await newBody();
    const w2 = await fresh();
    const thief = await fresh();
    const cfg = await config(leiHash, { expectedWatchers: [w2.address.toLowerCase() as Hex] });
    const role = await watcherRole();
    await tx(owner, "al", "proposeRoleGrant", [role, w2.address]);
    expect((await poll(cfg)).types).toEqual(["role_grant_proposed_expected"]);
    await advance(DELAY);
    await tx(w2, "al", "executeRoleGrant", [role, w2.address]);
    expect((await poll(cfg)).types).toEqual(["watcher_granted_expected"]);

    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]); // monitor down
    await advance(DELAY);
    await tx(thief, "al", "executeRotation", [leiHash]);
    expect((await poll(cfg)).types).toEqual(["rotation_proposed_unexpected", "rotation_no_longer_pending", "rotation_executed_unexpected", "body_suspended"]);

    await tx(w2, "al", "liftSuspension", [leiHash]);
    const r = await poll(cfg);
    expect(r.types).toEqual(["suspension_lifted_by_other", "body_resuspended"]);
    const inst = await institution(leiHash);
    expect(inst[5]).not.toBe(0n);
    expect(inst[6]).toBe(0n);
    expect((await poll(cfg)).types).toEqual([]); // its own re-suspension is not reported again
  });

  it("H2/M1: a new body, a new auditor, an ownership transfer, a supersede and a takeover are alerted (alert only)", async () => {
    const { lei, leiHash, body, reportKey } = await newBody(true);
    const cfg = await config(leiHash);
    const other = await fresh();
    const L3 = leiHashOf("ZZZZ00EUV2WATCHNEWB1");
    await tx(owner, "al", "addVerifier", [
      { leiHash: L3, verifier: other.address, leCredSaidHash: keccak256(stringToBytes("LE:new")), accreditationSaidHash: keccak256(stringToBytes("ACC:new")), accreditedUntil: ACCREDITED_UNTIL },
    ]);
    await tx(owner, "al", "addAuditor", [{ auditorAidHash: keccak256(stringToBytes("EAuditor-new")), leiHash: L3, ecrSaidHash: keccak256(stringToBytes("ECR:new")) }]);
    await tx(owner, "al", "transferOwnership", [other.address]);
    const report = (n: string, supersedes: Hex, cred = `Q:${lei}`, rid = `VR-${lei}`) => ({
      reportKey: keccak256(stringToBytes(`ESAID-${lei}-${n}`)),
      reportIdHash: keccak256(stringToBytes(rid)),
      reportScopeKey: keccak256(stringToBytes(`P:${lei}`)),
      credScopeKey: keccak256(stringToBytes(cred)),
      auditorAidHash: keccak256(stringToBytes(`EAuditor-${lei}`)),
      kelSeq: 4n,
      supplier: owner.address,
      supplierCommit: keccak256(stringToBytes("supplier-commit")),
      installationCommit: keccak256(stringToBytes("installation-commit")),
      verifiedKg: 600_000n,
      validUntil: VALID_UNTIL,
      supersedes,
    });
    const rev = report("rev", reportKey!);
    await tx(body, "reg", "registerReport", [rev]); // revision (branch b); the body's address is mature
    await tx(body, "reg", "registerReport", [report("tko", rev.reportKey, `Q2:${lei}`, `VR2-${lei}`)]); // takeover (branch c)
    const r = await poll(cfg);
    expect(r.types).toEqual(["body_added_unexpected", "auditor_added_unexpected", "ownership_transfer_started_unexpected", "report_superseded", "report_scope_taken_over"]);
    expect(r.txs).toEqual([]);
    await tx(owner, "al", "transferOwnership", ["0x0000000000000000000000000000000000000000"]); // withdraw the transfer
  });

  it("L1: reads only confirmed blocks; a cancel undone by a reorg is detected and repeated before readyAt", async () => {
    const { leiHash } = await newBody();
    const thief = await fresh();
    const cfg = await config(leiHash, { confirmations: 3 });
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    expect((await poll(cfg)).types).toEqual([]); // the proposal is not 3 blocks deep yet
    const snap = await test.snapshot();
    await test.mine({ blocks: 3 });
    expect((await poll(cfg)).types).toEqual(["rotation_proposed_unexpected", "rotation_cancelled"]);
    // A reorg drops the blocks with the cancel: the proposal is pending again.
    await test.revert({ id: snap });
    expect((await pending(leiHash)).toLowerCase()).toBe(thief.address.toLowerCase());
    const again = await poll(cfg);
    expect(again.types).toEqual(["cancelled_proposal_reappeared", "proposal_cancelled_again"]);
    expect(await pending(leiHash)).toBe("0x0000000000000000000000000000000000000000");
  });

  it("L2: when the RPC refuses a block range, the monitor halves it and still acts on the events", async () => {
    const { leiHash } = await newBody();
    const thief = await fresh();
    const cfg = await config(leiHash);
    await test.mine({ blocks: 30 });
    await tx(owner, "al", "proposeRotation", [leiHash, thief.address]);
    const limited = new Proxy(pub, {
      get(t, k, r) {
        if (k === "getLogs") {
          return async (args: { fromBlock: bigint; toBlock: bigint }) => {
            if (args.toBlock - args.fromBlock > 7n) throw new Error("query exceeds max block range 8");
            return t.getLogs(args as never);
          };
        }
        return Reflect.get(t, k, r);
      },
    }) as PublicClient;
    const seen: Alert[] = [];
    await pollV2(cfg, { emit: (a) => seen.push(a), account: watcher, client: limited });
    const types = seen.map((a) => a.type);
    expect(types.filter((t) => t === "log_chunk_reduced").length).toBeGreaterThan(0);
    expect(types.filter((t) => t !== "log_chunk_reduced")).toEqual(["rotation_proposed_unexpected", "rotation_cancelled"]);
  });

  it("L3: refuses a registry wired to another allowlist", async () => {
    const { leiHash } = await newBody();
    const h = await wallet(owner).deployContract({ abi: REG.abi, bytecode: REG.bytecode.object, args: [watcher.address], account: owner, chain: foundry });
    const otherRegistry = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!.toLowerCase() as Hex;
    await expect(pollV2({ ...(await config(leiHash)), registry: otherRegistry }, { emit: () => {}, account: watcher, client: pub })).rejects.toThrow(/points to allowlist/);
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

  it("L4: a queued revocation's advisory says that a shipment claimed now becomes invalid if it is executed", async () => {
    const { leiHash, body, reportKey } = await newBody(true);
    const next = await fresh();
    await tx(owner, "al", "proposeRotation", [leiHash, next.address]);
    const digest = (await pub.readContract({ address: allowlist, abi: AL.abi, functionName: "rotationDigest", args: [leiHash, next.address] })) as Hex;
    await tx(next, "al", "executeRotationSigned", [leiHash, await body.sign({ hash: digest })]); // body is mature: consent counts
    await tx(next, "reg", "revokeReport", [reportKey, 0n]); // next is fresh: queued
    const now = (await pub.getBlock()).timestamp;
    const adv = await v2Advisory(pub, { allowlist, registry }, { leiHash, reportKey, now });
    expect(adv!.queuedRevocation!.requester).toBe(next.address);
    expect(adv!.notes[0]).toMatch(/is queued .*every shipment of this report, including one claimed now, becomes invalid if it is executed/);
    await tx(watcher, "reg", "cancelRevocation", [reportKey]);
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
