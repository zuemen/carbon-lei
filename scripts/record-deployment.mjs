// Writes contracts/deployments/<chainId>.json from Foundry's broadcast receipts.
// Usage: node scripts/record-deployment.mjs [chainId]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const chainId = process.argv[2] ?? "11155111";
const run = JSON.parse(
  readFileSync(`contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`, "utf8"),
);
const receipts = new Map(run.receipts.map((r) => [r.transactionHash, r]));
const contracts = {};
for (const tx of run.transactions) {
  if (tx.transactionType !== "CREATE") continue;
  const receipt = receipts.get(tx.hash);
  contracts[tx.contractName] = {
    address: tx.contractAddress,
    txHash: tx.hash,
    block: Number(BigInt(receipt.blockNumber)),
    gasUsed: Number(BigInt(receipt.gasUsed)),
    constructorArguments: tx.arguments ?? [],
  };
}
const commit = execSync("git rev-parse HEAD").toString().trim();
const out = {
  chainId: Number(chainId),
  network: chainId === "11155111" ? "sepolia" : "unknown",
  deployedAt: new Date(run.timestamp * 1000).toISOString(),
  commit,
  contracts,
};
mkdirSync("contracts/deployments", { recursive: true });
writeFileSync(`contracts/deployments/${chainId}.json`, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
