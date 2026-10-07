// Negative tests for the EIP-712 domain (SECURITY.md T4 (c)): a signature is bound to one chain ID and
// one verifying contract, and it does not name the importer, so only check 5 binds a proof to one.
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { ChainReader } from "../chain.ts";
import { SEPOLIA_CHAIN_ID, type Hex } from "../credential.ts";
import type { Presentation } from "../disclosure.ts";
import { EIP712_TYPES, domainOf, recoverIssuer, signCredential } from "../eip712.ts";
import { verifyPresentation } from "../verify.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const v = JSON.parse(read("fixtures/vectors.json"));
const deployment = JSON.parse(read("contracts/deployments/11155111.json"));
const proof = JSON.parse(read("fixtures/sepolia-demo-proof.json")) as Presentation;
const registry = deployment.contracts.EmissionsClaimRegistry.address as Hex;

const message = {
  credSAID: v.V10.credSAID as string,
  supplierCommit: v.V10.supplierCommit as Hex,
  verifiedKg: BigInt(v.V10.verifiedKg),
  validUntil: BigInt(v.V10.validUntil),
};
// Anvil's first default account: a public test key.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OTHER_REGISTRY = "0x00000000000000000000000000000000ca7b0202" as Hex;
const lower = (a: string) => a.toLowerCase();

describe("EIP-712 domain binding", () => {
  it("the default domain is Sepolia (chain ID 11155111): another chain needs a new signature", () => {
    expect(SEPOLIA_CHAIN_ID).toBe(11155111);
    expect(domainOf(registry)).toEqual({ name: "CarbonLEI", version: "1", chainId: 11155111, verifyingContract: registry });
    expect(v.V10.chainId).toBe(11155111);
  });

  it("a signature recovers its signer only under the chain ID it was signed for", async () => {
    const sig = await signCredential(account, v.V10.registry, message, SEPOLIA_CHAIN_ID);
    expect(lower(await recoverIssuer(v.V10.registry, message, sig, SEPOLIA_CHAIN_ID))).toBe(lower(account.address));
    for (const chainId of [1, 31337, 11155112]) {
      expect(lower(await recoverIssuer(v.V10.registry, message, sig, chainId))).not.toBe(lower(account.address));
    }
    // And the reverse: a signature made for another chain does not recover as the signer on Sepolia.
    const mainnetSig = await signCredential(account, v.V10.registry, message, 1);
    expect(lower(await recoverIssuer(v.V10.registry, message, mainnetSig, SEPOLIA_CHAIN_ID))).not.toBe(lower(account.address));
  });

  it("a signature recovers its signer only under the verifying contract it was signed for", async () => {
    const sig = await signCredential(account, v.V10.registry, message, SEPOLIA_CHAIN_ID);
    expect(lower(await recoverIssuer(OTHER_REGISTRY, message, sig, SEPOLIA_CHAIN_ID))).not.toBe(lower(account.address));
    const otherSig = await signCredential(account, OTHER_REGISTRY, message, SEPOLIA_CHAIN_ID);
    expect(lower(await recoverIssuer(v.V10.registry, message, otherSig, SEPOLIA_CHAIN_ID))).not.toBe(lower(account.address));
  });

  it("the cross-language vector V10 is rejected under another chain ID or contract", async () => {
    const signer = lower(v.V10.signer);
    expect(lower(await recoverIssuer(v.V10.registry, message, v.V10.signature, v.V10.chainId))).toBe(signer);
    expect(lower(await recoverIssuer(v.V10.registry, message, v.V10.signature, 1))).not.toBe(signer);
    expect(lower(await recoverIssuer(OTHER_REGISTRY, message, v.V10.signature, v.V10.chainId))).not.toBe(signer);
  });

  it("the signed message names no importer: the same signature holds for every importer", () => {
    expect(EIP712_TYPES.EmissionsCredential.map((f) => f.name)).toEqual(["credSAID", "supplierCommit", "verifiedKg", "validUntil"]);
  });
});

/**
 * A chain with nothing registered, answering with the given chain ID and registry address; its deployment file
 * names `deploymentChainId` (default: the same chain). Its head block is fresh.
 */
function emptyChain(chainId: number, registryAddress: Hex, deploymentChainId = chainId): ChainReader {
  const zero = `0x${"0".repeat(64)}`;
  const r = {
    client: { getChainId: async () => chainId },
    chainId: deploymentChainId,
    registry: registryAddress,
    deployedBlock: 0n,
    options: {},
    deploymentTimestamp: async () => 0n,
    latestBlock: async () => ({ number: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    at: () => r,
    report: async () => ({ registeredAt: 0n }),
    shipmentStatus: async () => ({ reportKey: zero, claimedAt: 0n }),
    remainingKg: async () => 0n,
    reportScope: async () => ({ reportIdHash: zero, latestReportKey: zero, boundAt: 0n }),
  };
  return r as unknown as ChainReader;
}

const check3 = async (chainId: number, reg: Hex, importerEORI?: string) =>
  (await verifyPresentation(proof, emptyChain(chainId, reg), { importerEORI })).checks.find((c) => c.index === 3)!;

describe("check 3 on the demo proof", () => {
  it("passes on the Sepolia deployment it was signed for", async () => {
    expect((await check3(SEPOLIA_CHAIN_ID, registry)).status).toBe("pass");
  });

  it("fails with BAD_SIGNATURE when the deployment and its RPC are another chain", async () => {
    const c = await check3(1, registry);
    expect([c.status, c.code]).toEqual(["fail", "BAD_SIGNATURE"]);
  });

  it("refuses an RPC on another chain than the deployment file names (no result, an error)", async () => {
    await expect(verifyPresentation(proof, emptyChain(31337, registry, SEPOLIA_CHAIN_ID))).rejects.toThrow(
      "RPC is on chain 31337, but the deployment is for chain 11155111",
    );
  });

  it("fails with BAD_SIGNATURE against another registry contract", async () => {
    const c = await check3(SEPOLIA_CHAIN_ID, OTHER_REGISTRY);
    expect([c.status, c.code]).toEqual(["fail", "BAD_SIGNATURE"]);
  });

  it("passes whatever importer checks it: binding to an importer is check 5, not the signature", async () => {
    for (const eori of [undefined, "NLDEMO000000001", "DEOTHER00000002"]) {
      expect((await check3(SEPOLIA_CHAIN_ID, registry, eori)).status).toBe("pass");
    }
  });
});
