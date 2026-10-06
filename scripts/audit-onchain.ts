// Audits the README's "On-chain proof" table against a public Sepolia RPC: for every transaction linked
// in the table, the receipt's status, block and gasUsed must match the recorded values
// (fixtures/sepolia-tx.json and contracts/deployments/11155111.json); for every contract address,
// the address must hold code and be the one created by its deploy transaction. Read only; no key needed.
//
// Usage: node scripts/audit-onchain.ts [--rpc <url>] [--readme README.md] [--txs fixtures/sepolia-tx.json]
//        [--deployment contracts/deployments/11155111.json]
// Exit code 0 when every row matches, 1 otherwise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, fallback, http } from "viem";
import { sepolia } from "viem/chains";
import { SEPOLIA_RPCS } from "../sdk/chain.ts";
import type { Hex } from "../sdk/credential.ts";

export interface TableRow {
  line: number;
  txs: Hex[];
  addresses: Hex[];
  /** Status 0 when the row's result column says the transaction reverted, else 1. */
  expectedStatus: 0 | 1;
}

export interface Recorded {
  block: number;
  gasUsed: number;
  /** Contract created by the transaction (deploy transactions only). */
  contractAddress?: Hex;
}

/** The subset of a viem public client the audit uses. */
export interface ReceiptSource {
  getTransactionReceipt(a: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    gasUsed: bigint;
    contractAddress?: Hex | null;
  }>;
  getCode(a: { address: Hex }): Promise<Hex | undefined>;
}

const TX = /sepolia\.etherscan\.io\/tx\/(0x[0-9a-fA-F]{64})/g;
const ADDRESS = /sepolia\.etherscan\.io\/address\/(0x[0-9a-fA-F]{40})/g;

/** Rows of the tables under "## On-chain proof" that link a transaction or an address. */
export function parseOnchainTable(readme: string): TableRow[] {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## On-chain proof");
  if (start < 0) throw new Error('README has no "## On-chain proof" section');
  const rows: TableRow[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const l = lines[i];
    if (!l.startsWith("|")) continue;
    const txs = [...l.matchAll(TX)].map((m) => m[1] as Hex);
    const addresses = [...l.matchAll(ADDRESS)].map((m) => m[1] as Hex);
    if (!txs.length && !addresses.length) continue;
    const cells = l.split("|").map((c) => c.trim());
    const result = cells[4] ?? "";
    rows.push({ line: i + 1, txs, addresses, expectedStatus: /\brevert/i.test(result) ? 0 : 1 });
  }
  if (!rows.length) throw new Error("the On-chain proof table links no transaction");
  return rows;
}

/** Recorded block and gas per transaction hash (lower case), from the tx record and the deployment record. */
export function recordedTxs(txRecord: any, deployment: any): Map<string, Recorded> {
  const m = new Map<string, Recorded>();
  for (const t of txRecord.txs) m.set(t.hash.toLowerCase(), { block: t.block, gasUsed: t.gasUsed });
  for (const c of Object.values<any>(deployment.contracts))
    m.set(c.txHash.toLowerCase(), { block: c.block, gasUsed: c.gasUsed, contractAddress: c.address });
  return m;
}

export interface AuditLine {
  ok: boolean;
  text: string;
}

export async function audit(rows: TableRow[], recorded: Map<string, Recorded>, src: ReceiptSource): Promise<AuditLine[]> {
  const out: AuditLine[] = [];
  for (const row of rows) {
    for (const hash of row.txs) {
      const want = recorded.get(hash.toLowerCase());
      if (!want) {
        out.push({ ok: false, text: `README line ${row.line}: tx ${hash} has no recorded block and gas` });
        continue;
      }
      let r;
      try {
        r = await src.getTransactionReceipt({ hash });
      } catch (e) {
        out.push({ ok: false, text: `README line ${row.line}: tx ${hash} has no receipt (${(e as Error).message.split("\n")[0]})` });
        continue;
      }
      const status = r.status === "success" ? 1 : 0;
      const diffs: string[] = [];
      if (status !== row.expectedStatus) diffs.push(`status ${status}, README says ${row.expectedStatus}`);
      if (Number(r.blockNumber) !== want.block) diffs.push(`block ${r.blockNumber}, recorded ${want.block}`);
      if (Number(r.gasUsed) !== want.gasUsed) diffs.push(`gasUsed ${r.gasUsed}, recorded ${want.gasUsed}`);
      if (want.contractAddress && r.contractAddress?.toLowerCase() !== want.contractAddress.toLowerCase())
        diffs.push(`created ${r.contractAddress ?? "no contract"}, recorded ${want.contractAddress}`);
      const short = `${hash.slice(0, 10)}…${hash.slice(-3)}`;
      out.push(
        diffs.length
          ? { ok: false, text: `README line ${row.line}: tx ${short}: ${diffs.join("; ")}` }
          : { ok: true, text: `tx ${short}  status ${status}  block ${r.blockNumber}  gas ${r.gasUsed}` },
      );
    }
    for (const address of row.addresses) {
      let code: string | undefined;
      try {
        code = await src.getCode({ address });
      } catch (err) {
        out.push({ ok: false, text: `README line ${row.line}: ${address}: ${(err as Error).message.split("\n")[0]}` });
        continue;
      }
      const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
      const created = row.txs.some((h) => recorded.get(h.toLowerCase())?.contractAddress?.toLowerCase() === address.toLowerCase());
      if (!bytes) out.push({ ok: false, text: `README line ${row.line}: ${address} has no code` });
      else if (!created) out.push({ ok: false, text: `README line ${row.line}: ${address} is not the contract its deploy tx recorded` });
      else out.push({ ok: true, text: `contract ${address}  ${bytes} bytes of code` });
    }
  }
  return out;
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      readme: { type: "string", default: resolve(root, "README.md") },
      txs: { type: "string", default: resolve(root, "fixtures/sepolia-tx.json") },
      deployment: { type: "string", default: resolve(root, "contracts/deployments/11155111.json") },
    },
  });
  const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const urls = values.rpc ? [values.rpc] : SEPOLIA_RPCS;
  const client = createPublicClient({ chain: sepolia, transport: fallback(urls.map((u) => http(u, { retryCount: 2 }))) });
  const rows = parseOnchainTable(readFileSync(values.readme, "utf8"));
  const lines = await audit(rows, recordedTxs(readJson(values.txs), readJson(values.deployment)), client as unknown as ReceiptSource);
  for (const l of lines) console.log(`${l.ok ? "OK  " : "FAIL"}  ${l.text}`);
  const bad = lines.filter((l) => !l.ok).length;
  if (!lines.length) {
    console.error("no rows found in the On-chain proof table");
    return 1;
  }
  const txLines = lines.filter((l) => l.text.includes("tx ")).length;
  const txBad = lines.filter((l) => !l.ok && l.text.includes("tx ")).length;
  const cLines = lines.length - txLines;
  const cBad = bad - txBad;
  console.log(`\n${txLines - txBad} of ${txLines} transactions, ${cLines - cBad} of ${cLines} contracts match (${urls.join(", ")})`);
  if (bad) console.log("If a public RPC is unreachable, retry with: npm run audit:onchain -- --rpc <Sepolia RPC URL>");
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`audit-onchain failed: ${(err as Error).message}`);
      console.error("If a public RPC is unreachable, retry with: npm run audit:onchain -- --rpc <Sepolia RPC URL>");
      process.exit(1);
    },
  );
}
