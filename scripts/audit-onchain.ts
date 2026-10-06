// Audits the README's "On-chain proof" table against public Sepolia RPCs: for every transaction linked
// in the table, the receipt's status, block and gasUsed must match the recorded values
// (fixtures/sepolia-tx.json and contracts/deployments/11155111.json); for every contract address,
// the address must hold code and be the one created by its deploy transaction. Read only; no key needed.
//
// The RPC nodes are tried one after another for each transaction and each address. A node that
// answers with no receipt (`null`: some public nodes prune receipts older than a day or two), with
// an error, or with no code is skipped and the next node is asked. A row fails when no node gives
// an answer (the message lists each node's answer), or when a node's receipt differs from the
// record: a receipt that differs is never outvoted by another node.
//
// Usage: node scripts/audit-onchain.ts [--rpc <url> ...] [--readme README.md] [--txs fixtures/sepolia-tx.json]
//        [--deployment contracts/deployments/11155111.json]
// Exit code 0 when every row matches, 1 otherwise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { errorDetail, isPrunedHistoryError, SEPOLIA_RPCS } from "../sdk/chain.ts";
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

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  contractAddress?: Hex | null;
}

/** The subset of a viem public client the audit uses. A receipt the node does not have may be `null` or an error. */
export interface ReceiptSource {
  getTransactionReceipt(a: { hash: Hex }): Promise<Receipt | null>;
  getCode(a: { address: Hex }): Promise<Hex | undefined>;
}

/** One RPC node: its URL (for the messages) and a client on it. */
export interface Node {
  url: string;
  src: ReceiptSource;
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
  kind: "tx" | "contract";
  text: string;
}

/** Host name of an RPC URL, for short messages. */
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A node's answer when it has no receipt: `null`, or viem's "not found" error, both read as missing history. */
function missingReceipt(err: unknown): boolean {
  return (err as Error)?.name === "TransactionReceiptNotFoundError";
}

/** Why a node gave no usable answer, in a few words. */
function reason(err: unknown): string {
  if (missingReceipt(err)) return "no receipt (null: history pruned, or the transaction is unknown to this node)";
  return `${isPrunedHistoryError(err) ? "history pruned: " : "error: "}${errorDetail(err)}`;
}

/**
 * Checks every row against the nodes, in order. `src` may be one source (one node) or a list of nodes.
 * Fail-closed: a row passes only on a receipt (or code) that a node returned and that matches the record.
 */
export async function audit(
  rows: TableRow[],
  recorded: Map<string, Recorded>,
  src: ReceiptSource | Node[],
): Promise<AuditLine[]> {
  const nodes: Node[] = Array.isArray(src) ? src : [{ url: "rpc", src }];
  if (!nodes.length) throw new Error("audit needs at least one RPC node");
  const tried = (answers: string[]) => answers.join("; ");
  const out: AuditLine[] = [];
  for (const row of rows) {
    for (const hash of row.txs) {
      const short = `${hash.slice(0, 10)}…${hash.slice(-3)}`;
      const want = recorded.get(hash.toLowerCase());
      if (!want) {
        out.push({ ok: false, kind: "tx", text: `README line ${row.line}: tx ${hash} has no recorded block and gas` });
        continue;
      }
      const answers: string[] = [];
      let line: AuditLine | undefined;
      for (const node of nodes) {
        let r: Receipt | null;
        try {
          r = await node.src.getTransactionReceipt({ hash });
        } catch (e) {
          answers.push(`${host(node.url)}: ${reason(e)}`);
          continue;
        }
        if (!r) {
          answers.push(`${host(node.url)}: ${reason({ name: "TransactionReceiptNotFoundError" })}`);
          continue;
        }
        const status = r.status === "success" ? 1 : 0;
        const diffs: string[] = [];
        if (status !== row.expectedStatus) diffs.push(`status ${status}, README says ${row.expectedStatus}`);
        if (Number(r.blockNumber) !== want.block) diffs.push(`block ${r.blockNumber}, recorded ${want.block}`);
        if (Number(r.gasUsed) !== want.gasUsed) diffs.push(`gasUsed ${r.gasUsed}, recorded ${want.gasUsed}`);
        if (want.contractAddress && r.contractAddress?.toLowerCase() !== want.contractAddress.toLowerCase())
          diffs.push(`created ${r.contractAddress ?? "no contract"}, recorded ${want.contractAddress}`);
        line = diffs.length
          ? { ok: false, kind: "tx", text: `README line ${row.line}: tx ${short}: ${diffs.join("; ")} (from ${host(node.url)})` }
          : {
              ok: true,
              kind: "tx",
              text: `tx ${short}  status ${status}  block ${r.blockNumber}  gas ${r.gasUsed}  (${host(node.url)})`,
            };
        break;
      }
      out.push(
        line ?? {
          ok: false,
          kind: "tx",
          text: `README line ${row.line}: tx ${short}: no node returned the receipt (${tried(answers)})`,
        },
      );
    }
    for (const address of row.addresses) {
      const created = row.txs.some(
        (h) => recorded.get(h.toLowerCase())?.contractAddress?.toLowerCase() === address.toLowerCase(),
      );
      if (!created) {
        out.push({
          ok: false,
          kind: "contract",
          text: `README line ${row.line}: ${address} is not the contract its deploy transaction recorded`,
        });
        continue;
      }
      const answers: string[] = [];
      let line: AuditLine | undefined;
      for (const node of nodes) {
        let code: string | undefined;
        try {
          code = await node.src.getCode({ address });
        } catch (err) {
          answers.push(`${host(node.url)}: ${reason(err)}`);
          continue;
        }
        const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
        if (!bytes) {
          answers.push(`${host(node.url)}: no code`);
          continue;
        }
        line = { ok: true, kind: "contract", text: `contract ${address}  ${bytes} bytes of code  (${host(node.url)})` };
        break;
      }
      out.push(
        line ?? {
          ok: false,
          kind: "contract",
          text: `README line ${row.line}: ${address} has no code on any node (${tried(answers)})`,
        },
      );
    }
  }
  return out;
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { values } = parseArgs({
    options: {
      rpc: { type: "string", multiple: true },
      readme: { type: "string", default: resolve(root, "README.md") },
      txs: { type: "string", default: resolve(root, "fixtures/sepolia-tx.json") },
      deployment: { type: "string", default: resolve(root, "contracts/deployments/11155111.json") },
    },
  });
  const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const urls = values.rpc?.length ? values.rpc : SEPOLIA_RPCS;
  const nodes: Node[] = urls.map((url) => ({
    url,
    src: createPublicClient({ chain: sepolia, transport: http(url, { retryCount: 2 }) }) as unknown as ReceiptSource,
  }));
  const rows = parseOnchainTable(readFileSync(values.readme, "utf8"));
  const lines = await audit(rows, recordedTxs(readJson(values.txs), readJson(values.deployment)), nodes);
  for (const l of lines) console.log(`${l.ok ? "OK  " : "FAIL"}  ${l.text}`);
  if (!lines.length) {
    console.error("no rows found in the On-chain proof table");
    return 1;
  }
  const count = (kind: AuditLine["kind"]) => {
    const all = lines.filter((l) => l.kind === kind);
    return `${all.filter((l) => l.ok).length} of ${all.length}`;
  };
  const bad = lines.filter((l) => !l.ok).length;
  console.log(`\n${count("tx")} transactions, ${count("contract")} contracts match (nodes tried in order: ${urls.join(", ")})`);
  if (bad) console.log("If every public RPC is unreachable or pruned, retry with: npm run audit:onchain -- --rpc <Sepolia archive RPC URL>");
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`audit-onchain failed: ${(err as Error).message}`);
      console.error("If every public RPC is unreachable or pruned, retry with: npm run audit:onchain -- --rpc <Sepolia archive RPC URL>");
      process.exit(1);
    },
  );
}
