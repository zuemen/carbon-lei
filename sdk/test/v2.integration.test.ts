// sdk/v2.ts on a local anvil chain: the V1 contracts (the deployed design) are not read as V2 and get no
// advisory; a VerifierAllowlistV2 / EmissionsClaimRegistryV2 pair deployed from contracts/out is recognised and
// reports a pending rotation. V2 is not deployed anywhere. The CR1 monitor that uses this lives in
// verifier/src/watch-v2.ts (tests: verifier/test/watch-v2.test.ts).
import { readFileSync } from "node:fs";
import type { Abi } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leiHashOf } from "../commitment.ts";
import type { Hex } from "../credential.ts";
import { isV2Allowlist, pendingRotation, queuedRevocation, v2Advisory } from "../v2.ts";
import { startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

let c: LocalChain;
let v2: { allowlist: Hex; registry: Hex };
const LEI = "ZZZZ00EUV2SDKDEMO001"; // fictional

beforeAll(async () => {
  c = await startLocalChain(26545 + Math.floor(Math.random() * 1000));
  const deploy = async (name: string, args: unknown[]) => {
    const a = artifact(name);
    const hash = await c.wallet(c.owner).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, account: c.owner, chain: foundry });
    return (await c.pub.waitForTransactionReceipt({ hash })).contractAddress as Hex;
  };
  const allowlist = await deploy("VerifierAllowlistV2", [c.owner.address, c.watcher.address]);
  v2 = { allowlist, registry: await deploy("EmissionsClaimRegistryV2", [allowlist]) };
}, 30_000);

afterAll(() => c?.stop());

describe("sdk/v2.ts", () => {
  it("a V1 deployment is not V2 and gets no advisory (V1 verdicts are untouched)", async () => {
    const v1 = { allowlist: c.deployment.contracts.VerifierAllowlist.address, registry: c.deployment.contracts.EmissionsClaimRegistry.address };
    expect(await isV2Allowlist(c.pub, v1.allowlist)).toBe(false);
    expect(await v2Advisory(c.pub, v1, { leiHash: leiHashOf(LEI), now: 0n })).toBeNull();
  });

  it("a V2 deployment is recognised; a pending rotation appears in the advisory and nothing is queued", async () => {
    expect(await isV2Allowlist(c.pub, v2.allowlist)).toBe(true);
    const leiHash = leiHashOf(LEI);
    const al = artifact("VerifierAllowlistV2").abi;
    const send = async (functionName: string, args: unknown[]) => {
      const hash = await c.wallet(c.owner).writeContract({ address: v2.allowlist, abi: al, functionName, args, account: c.owner, chain: foundry } as never);
      await c.pub.waitForTransactionReceipt({ hash });
    };
    await send("addVerifier", [
      { leiHash, verifier: c.verifier.address, leCredSaidHash: leiHashOf("LE"), accreditationSaidHash: leiHashOf("ACC"), accreditedUntil: 1924905600n },
    ]);
    expect(await pendingRotation(c.pub, v2.allowlist, leiHash)).toBeNull();
    await send("proposeRotation", [leiHash, c.other.address]);
    const now = (await c.pub.getBlock()).timestamp;
    const adv = await v2Advisory(c.pub, v2, { leiHash, reportKey: leiHashOf("ESAID-none"), now });
    expect(adv).toMatchObject({ v2: true, rotationDelaySec: 259200n, revokeHoldSec: 259200n, queuedRevocation: null });
    expect(adv!.pendingRotation).toEqual({ newAddr: c.other.address, readyAt: now + 259200n });
    expect(adv!.notes).toEqual([`address rotation to ${c.other.address} is pending; executable at ${now + 259200n} (in 259200 s)`]);
    expect(await queuedRevocation(c.pub, v2.registry, leiHashOf("ESAID-none"))).toBeNull();
  });
});
