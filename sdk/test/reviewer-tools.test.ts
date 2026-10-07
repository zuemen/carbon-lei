// Offline tests for the reviewer commands: `npm run verify:demo` reads the demo page's proof, and
// `npm run verify:tampered` reads the same proof with one signed disclosure changed, and
// `npm run audit:onchain` (scripts/audit-onchain.ts) flags any row of the On-chain proof table that differs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { audit, parseOnchainTable, recordedTxs, type ReceiptSource } from "../../scripts/audit-onchain.ts";
import type { ChainReader } from "../chain.ts";
import type { Hex } from "../credential.ts";
import { decodeDisclosure, type Presentation } from "../disclosure.ts";
import { verifyPresentation } from "../verify.ts";
import { disclosureCounts, disclosureSummary } from "../summary.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const readme = read("README.md");
const txRecord = JSON.parse(read("fixtures/sepolia-tx.json"));
const deployment = JSON.parse(read("contracts/deployments/11155111.json"));
const recorded = recordedTxs(txRecord, deployment);

/** A chain whose receipts are exactly the recorded ones, with the status the README states. */
function fakeChain(rows = parseOnchainTable(readme)): ReceiptSource & { receipts: Map<string, any>; code: Map<string, Hex> } {
  const receipts = new Map<string, any>();
  const code = new Map<string, Hex>();
  for (const row of rows)
    for (const h of row.txs) {
      const r = recorded.get(h.toLowerCase())!;
      receipts.set(h.toLowerCase(), {
        status: row.expectedStatus ? "success" : "reverted",
        blockNumber: BigInt(r.block),
        gasUsed: BigInt(r.gasUsed),
        contractAddress: r.contractAddress ?? null,
      });
      if (r.contractAddress) code.set(r.contractAddress.toLowerCase(), "0x6080");
    }
  return {
    receipts,
    code,
    async getTransactionReceipt({ hash }) {
      const r = receipts.get(hash.toLowerCase());
      if (!r) throw new Error("receipt not found");
      return r;
    },
    async getCode({ address }) {
      return code.get(address.toLowerCase());
    },
  };
}

const failures = async (chain: ReceiptSource, rows = parseOnchainTable(readme)) =>
  (await audit(rows, recorded, chain)).filter((l) => !l.ok).map((l) => l.text);

describe("audit:onchain", () => {
  it("reads every transaction and contract of the README table, with the reverted one expected at status 0", () => {
    const rows = parseOnchainTable(readme);
    expect(rows.flatMap((r) => r.txs)).toHaveLength(12);
    expect(rows.flatMap((r) => r.addresses)).toEqual([
      deployment.contracts.VerifierAllowlist.address,
      deployment.contracts.EmissionsClaimRegistry.address,
    ]);
    expect(rows.filter((r) => r.txs.length && r.expectedStatus === 0)).toHaveLength(1);
  });

  it("passes when every receipt matches", async () => {
    expect(await failures(fakeChain())).toEqual([]);
  });

  it("fails on a wrong gas, block, status, missing code or unrecorded hash", async () => {
    const claim = txRecord.txs.find((t: any) => t.step === "claim1").hash.toLowerCase();
    for (const [field, value] of [["gasUsed", 1n], ["blockNumber", 1n], ["status", "reverted"]] as const) {
      const chain = fakeChain();
      chain.receipts.get(claim)[field] = value;
      expect(await failures(chain)).toHaveLength(1);
    }
    const noCode = fakeChain();
    noCode.code.clear();
    expect(await failures(noCode)).toHaveLength(2);

    const edited = readme.replace(claim.slice(2), `${claim.slice(2, -1)}0`);
    const rows = parseOnchainTable(edited);
    expect(await failures(fakeChain(parseOnchainTable(readme)), rows)).toEqual([
      expect.stringContaining("has no recorded block and gas"),
    ]);
  });
});

describe("verify:demo", () => {
  it("fixtures/sepolia-demo-proof.json is the demo page's proof", () => {
    const demo = JSON.parse(read("demo/public/demo-data.json"));
    expect(JSON.parse(read("fixtures/sepolia-demo-proof.json"))).toEqual(demo.proof);
  });
});

/** A chain with nothing registered: checks 0-3 run fully offline, checks 4-5 fail as not registered. */
function emptyChain(): ChainReader {
  const zero = `0x${"0".repeat(64)}`;
  const r = {
    client: { getChainId: async () => 11155111 },
    chainId: 11155111,
    registry: deployment.contracts.EmissionsClaimRegistry.address,
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

describe("verify:tampered", () => {
  const proof = JSON.parse(read("fixtures/sepolia-demo-proof.json")) as Presentation;
  const tampered = JSON.parse(read("fixtures/sepolia-demo-proof.tampered.json")) as Presentation;

  it("differs from the demo proof in one signed disclosure only: the verified intensity, 1.8 -> 1.2", () => {
    const changed = proof.disclosures.flatMap((d, i) => (d === tampered.disclosures[i] ? [] : [i]));
    expect(changed).toHaveLength(1);
    const [before, after] = [proof, tampered].map((p) => decodeDisclosure(p.disclosures[changed[0]]));
    expect(before).toEqual({ ...after, value: "1.8" });
    expect(after).toMatchObject({ name: "specificEmbeddedEmissions_tCO2e_per_t", value: "1.2" });
    expect({ ...tampered, disclosures: proof.disclosures }).toEqual(proof);
  });

  it("fails check 2 with DISCLOSURE_TAMPERED offline, while checks 0, 1 and 3 still pass", async () => {
    const byIndex = async (p: Presentation) => (await verifyPresentation(p, emptyChain())).checks.slice(0, 4);
    expect((await byIndex(proof)).map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass"]);
    const r = await verifyPresentation(tampered, emptyChain());
    expect(r.overall).toBe("INVALID");
    expect(r.primaryCode).toBe("DISCLOSURE_TAMPERED");
    expect(r.checks.slice(0, 4).map((c) => [c.status, c.code])).toEqual([
      ["pass", ""],
      ["pass", ""],
      ["fail", "DISCLOSURE_TAMPERED"],
      ["pass", ""],
    ]);
  });
});

describe("verify summary line", () => {
  const proof = JSON.parse(read("fixtures/sepolia-demo-proof.json")) as Presentation;
  const tampered = JSON.parse(read("fixtures/sepolia-demo-proof.tampered.json")) as Presentation;

  it("demo proof: 5 fields hidden by the supplier, no disclosure rejected", async () => {
    const r = await verifyPresentation(proof, emptyChain());
    expect(disclosureCounts(proof, r)).toEqual({ hidden: 5, rejected: 0 });
    expect(disclosureSummary(proof, r)).toBe("5 field(s) hidden by supplier");
  });

  it("tampered proof: the changed disclosure is counted as rejected, not as hidden by the supplier", async () => {
    const r = await verifyPresentation(tampered, emptyChain());
    expect(r.hidden).toBe(6); // the result itself is unchanged: a rejected disclosure reveals no signed value
    expect(disclosureCounts(tampered, r)).toEqual({ hidden: 5, rejected: 1 });
    expect(disclosureSummary(tampered, r)).toBe("5 field(s) hidden by supplier; 1 disclosure(s) rejected");
  });

  it("a malformed proof stops at check 0: no disclosure is reported as rejected", async () => {
    const bad = { ...proof, disclosures: [...proof.disclosures, "not-a-disclosure"] };
    const r = await verifyPresentation(bad, emptyChain());
    expect(r.checks.map((c) => [c.index, c.code])).toEqual([[0, "PRESENTATION_MALFORMED"]]);
    expect(disclosureCounts(bad, r)).toEqual({ hidden: 0, rejected: 0 });
  });
});
