// Offline tests for the reviewer commands: `npm run verify:demo` reads the demo page's proof, and
// `npm run audit:onchain` (scripts/audit-onchain.ts) flags any row of the On-chain proof table that differs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { audit, parseOnchainTable, recordedTxs, type ReceiptSource } from "../../scripts/audit-onchain.ts";
import type { Hex } from "../credential.ts";

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
