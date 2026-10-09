// Offline tests for reading old history through several public RPC nodes: a node that has pruned old
// history answers a receipt request with `null` and a log or historical-state request with an
// error such as 4444. The reader and `npm run audit:onchain` then ask the next node; when no node
// answers they fail with each node's answer, and never read a missing answer as a pass.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseError, createPublicClient, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { audit, parseOnchainTable, recordedTxs, type Node, type ReceiptSource } from "../../scripts/audit-onchain.ts";
import { verifierAllowlistAbi } from "../abi.ts";
import { fileURLToPath } from "node:url";
import {
  ChainReader,
  historyFallback,
  isPrunedHistoryError,
  RPC_TIMEOUT_MS,
  RpcNodesError,
  rpcUrlsFrom,
  SEPOLIA_RPCS,
  timedHttp,
} from "../chain.ts";
import { vleiCheckers } from "../checkers.ts";
import type { Presentation } from "../disclosure.ts";
import { INCOMPLETE_HISTORY, isIncompleteHistory, verifyPresentation } from "../verify.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const deployment = JSON.parse(read("contracts/deployments/11155111.json"));

const A = "https://a.example/rpc";
const B = "https://b.example/rpc";
const C = "https://c.example/rpc";
const TX = `0x${"11".repeat(32)}` as Hex;
const LEI = `0x${"22".repeat(32)}` as Hex;

/** A handler's answer that never comes: the request hangs until the caller aborts it (its timeout). */
const HANG = "hang" as const;
type Handler = (method: string, params: unknown[]) => { result?: unknown; error?: { code: number; message: string; data?: Hex } } | typeof HANG;

/** Serves JSON-RPC from one handler per URL in place of `fetch`, and records which URL got which method. */
function serve(nodes: Record<string, Handler>) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body));
    const handle = nodes[url];
    if (!handle) throw new TypeError(`fetch failed: ${url}`);
    calls.push({ url, method: body.method });
    const answer = handle(body.method, body.params ?? []);
    if (answer === HANG) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))),
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const receipt = {
  blockHash: `0x${"33".repeat(32)}`,
  blockNumber: "0xb4c46e",
  contractAddress: null,
  cumulativeGasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  from: `0x${"44".repeat(20)}`,
  gasUsed: "0x5208",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  to: `0x${"55".repeat(20)}`,
  transactionHash: TX,
  transactionIndex: "0x0",
  type: "0x2",
};

const suspensionLog = {
  address: deployment.contracts.VerifierAllowlist.address,
  topics: encodeEventTopics({ abi: verifierAllowlistAbi, eventName: "VerifierSuspended", args: { leiHash: LEI } } as never),
  data: encodeAbiParameters([{ type: "uint64" }], [1_760_000_000n]),
  blockNumber: "0xb4c470",
  blockHash: `0x${"66".repeat(32)}`,
  transactionHash: `0x${"77".repeat(32)}`,
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
};

const pruned4444 = { error: { code: 4444, message: "pruned history unavailable" } };
const client = (urls: string[]) => createPublicClient({ chain: sepolia, transport: historyFallback(urls) });

describe("historyFallback (SDK reader)", () => {
  it("the first node answers null for an old receipt → asks the next node and returns its receipt", async () => {
    const calls = serve({ [A]: () => ({ result: null }), [B]: () => ({ result: receipt }) });
    const r = await client([A, B]).getTransactionReceipt({ hash: TX });
    expect(r.blockNumber).toBe(0xb4c46en);
    expect(calls.map((c) => c.url)).toEqual([A, B]);
  });

  it("the first node fails getLogs with 4444 → the event search reads the next node's logs", async () => {
    const calls = serve({ [A]: () => pruned4444, [B]: (m) => (m === "eth_getLogs" ? { result: [suspensionLog] } : { result: null }) });
    const reader = ChainReader.forRpc(deployment, [A, B], sepolia);
    const from = BigInt(deployment.contracts.VerifierAllowlist.block);
    const events = await reader.suspensions(LEI, from + 100n, from);
    expect(events).toEqual([{ time: 1_760_000_000n, blockNumber: 0xb4c470n, txHash: suspensionLog.transactionHash }]);
    expect(calls.map((c) => c.url)).toEqual([A, B]);
  });

  it("an eth_call at an old block that fails with 'missing trie node' → the next node answers", async () => {
    serve({
      [A]: () => ({ error: { code: -32000, message: "missing trie node 381efd (path ) state is not available" } }),
      [B]: () => ({ result: encodeAbiParameters([{ type: "bool" }], [true]) }),
    });
    const reader = ChainReader.forRpc(deployment, [A, B], sepolia).at(11_846_770n);
    expect(await reader.isInstitutionActiveAt(LEI, 1n)).toBe(true);
  });

  it("every node fails → a clear error naming each node's answer, not an empty result", async () => {
    serve({ [A]: () => pruned4444, [B]: () => ({ error: { code: -32005, message: "rate limited" } }) });
    const reader = ChainReader.forRpc(deployment, [A, B, C], sepolia);
    const from = BigInt(deployment.contracts.VerifierAllowlist.block);
    const err = await reader.suspensions(LEI, from + 100n, from).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BaseError);
    const nodesErr = (err as BaseError).walk((e) => e instanceof RpcNodesError) as RpcNodesError;
    expect(nodesErr).toBeInstanceOf(RpcNodesError);
    expect(nodesErr.outcomes.map((o) => [o.url, o.kind])).toEqual([
      [A, "pruned"],
      [B, "error"],
      [C, "error"],
    ]);
    const message = (err as BaseError).message;
    expect(message).toContain("eth_getLogs: none of the 3 RPC nodes answered");
    expect(message).toContain(`${A}: history pruned: pruned history unavailable`);
    expect(message).toContain(`${B}: rate limited`);
  });

  it("every node answers null → the receipt is not found (an error), never a receipt", async () => {
    serve({ [A]: () => ({ result: null }), [B]: () => ({ result: null }) });
    await expect(client([A, B]).getTransactionReceipt({ hash: TX })).rejects.toThrow(/could not be found/);
  });

  it("a contract revert is the same on every node: thrown at once, the next node is not asked", async () => {
    const calls = serve({
      [A]: () => ({ error: { code: 3, message: "execution reverted", data: "0x" } }),
      [B]: () => ({ result: encodeAbiParameters([{ type: "bool" }], [true]) }),
    });
    const reader = ChainReader.forRpc(deployment, [A, B], sepolia);
    await expect(reader.isInstitutionActiveAt(LEI, 1n)).rejects.toThrow();
    expect(calls.map((c) => c.url)).toEqual([A]);
  });

  it("one node answers null and the other fails → an error naming both, not 'not found' (the failed node may have it)", async () => {
    serve({ [A]: () => ({ result: null }), [B]: () => ({ error: { code: -32005, message: "rate limited" } }) });
    const err = await client([A, B]).getTransactionReceipt({ hash: TX }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const nodesErr = (err as BaseError).walk((e) => e instanceof RpcNodesError) as RpcNodesError;
    expect(nodesErr.outcomes.map((o) => [o.url, o.kind])).toEqual([
      [A, "null"],
      [B, "error"],
    ]);
  });

  it("refuses an empty node list", () => {
    expect(() => historyFallback([])).toThrow("historyFallback needs at least one RPC URL");
  });

  it("recognises pruned-history errors", () => {
    expect(isPrunedHistoryError({ code: 4444, message: "x" })).toBe(true);
    expect(isPrunedHistoryError(new Error("missing trie node abc"))).toBe(true);
    expect(isPrunedHistoryError({ details: "historical state 381e is not available" })).toBe(true);
    expect(isPrunedHistoryError(new Error("outer", { cause: { code: 4444 } }))).toBe(true);
    expect(isPrunedHistoryError(new Error("execution reverted"))).toBe(false);
  });
});

// Red-team round 2 (N-L4): a node that is behind no longer stops the verification while another node is current.
describe("ChainReader.at: a repeated view call at the pinned block", () => {
  const T = encodeAbiParameters([{ type: "bool" }], [true]);
  const LEI2 = `0x${"66".repeat(32)}` as Hex;
  const ethCalls = (calls: { method: string }[]) => calls.filter((c) => c.method === "eth_call").length;

  it("the same function and arguments at the same block → one eth_call, the same answer", async () => {
    const calls = serve({ [A]: () => ({ result: T }) });
    const reader = ChainReader.forRpc(deployment, [A], sepolia).at(11_846_770n);
    const [x, y] = await Promise.all([reader.isInstitutionActiveAt(LEI, 1n), reader.isInstitutionActiveAt(LEI, 1n)]);
    expect([x, y, await reader.isInstitutionActiveAt(LEI, 1n)]).toEqual([true, true, true]);
    expect(ethCalls(calls)).toBe(1);
  });

  it("other arguments, another reader pinned by at, or an unpinned reader → a new eth_call each", async () => {
    const calls = serve({ [A]: () => ({ result: T }) });
    const base = ChainReader.forRpc(deployment, [A], sepolia);
    const r1 = base.at(11_846_770n);
    await r1.isInstitutionActiveAt(LEI, 1n);
    await r1.isInstitutionActiveAt(LEI, 2n);
    await r1.isInstitutionActiveAt(LEI2, 1n);
    expect(ethCalls(calls)).toBe(3);
    await base.at(11_846_770n).isInstitutionActiveAt(LEI, 1n);
    expect(ethCalls(calls)).toBe(4);
    await base.isInstitutionActiveAt(LEI, 1n);
    await base.isInstitutionActiveAt(LEI, 1n);
    expect(ethCalls(calls)).toBe(6);
  });

  it("a failed call is not kept: the next identical call asks the node again", async () => {
    let fail = true;
    const calls = serve({
      [A]: (m) => (m === "eth_call" && fail ? { error: { code: -32000, message: "missing trie node 381efd (path ) state is not available" } } : { result: T }),
    });
    const reader = ChainReader.forRpc(deployment, [A], sepolia).at(11_846_770n);
    await expect(reader.isInstitutionActiveAt(LEI, 1n)).rejects.toThrow();
    const failed = ethCalls(calls);
    expect(failed).toBeGreaterThan(0);
    fail = false;
    expect(await reader.isInstitutionActiveAt(LEI, 1n)).toBe(true);
    expect(ethCalls(calls)).toBe(failed + 1);
  });
});

describe("historyFallback: a node whose latest block is too old", () => {
  const NOW = 1_800_000_000;
  const clock = () => NOW * 1000;
  const block = (n: number, ts: number) => ({
    number: `0x${n.toString(16)}`,
    timestamp: `0x${ts.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    parentHash: `0x${"00".repeat(32)}`,
    transactions: [],
  });
  const latestOr = (b: object, rest: Handler): Handler => (m, p) => (m === "eth_getBlockByNumber" && p[0] === "latest" ? { result: b } : rest(m, p));
  const ok = encodeAbiParameters([{ type: "bool" }], [true]);
  const staleClient = (urls: string[], maxHeadAgeSec?: number) =>
    createPublicClient({ chain: sepolia, transport: historyFallback(urls, { maxHeadAgeSec, now: clock }) });

  it("the first node's head is older than the limit → the next node's head; reads at that block skip the node that is behind", async () => {
    const calls = serve({
      [A]: latestOr(block(100, NOW - 3600), () => ({ result: ok })),
      [B]: latestOr(block(400, NOW - 12), () => ({ result: ok })),
    });
    const reader = new ChainReader(staleClient([A, B], 300) as never, deployment);
    const head = await reader.latestBlock();
    expect(head).toEqual({ number: 400n, timestamp: BigInt(NOW - 12) });
    expect(await reader.at(head.number).isInstitutionActiveAt(LEI, 1n)).toBe(true);
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      [A, "eth_getBlockByNumber"],
      [B, "eth_getBlockByNumber"],
      [B, "eth_call"],
    ]);
  });

  it("every node is behind → the newest of their heads, so the verification's head-age check reports it", async () => {
    serve({ [A]: latestOr(block(100, NOW - 3600), () => ({ result: ok })), [B]: latestOr(block(150, NOW - 1800), () => ({ result: ok })) });
    const head = await new ChainReader(staleClient([A, B], 300) as never, deployment).latestBlock();
    expect(head).toEqual({ number: 150n, timestamp: BigInt(NOW - 1800) });
  });

  it("a current first node is used as before; without a limit an old head is used as before", async () => {
    const calls = serve({ [A]: latestOr(block(100, NOW - 60), () => ({ result: ok })), [B]: latestOr(block(400, NOW), () => ({ result: ok })) });
    expect((await new ChainReader(staleClient([A, B], 300) as never, deployment).latestBlock()).number).toBe(100n);
    expect((await new ChainReader(staleClient([A, B]) as never, deployment).latestBlock()).number).toBe(100n);
    expect(calls.map((c) => c.url)).toEqual([A, A]);
  });

  it("ChainReader.forRpc on Sepolia applies the chain's head-age limit (300 s) when choosing among nodes", async () => {
    serve({
      [A]: latestOr(block(100, Math.floor(Date.now() / 1000) - 3600), () => ({ result: ok })),
      [B]: latestOr(block(400, Math.floor(Date.now() / 1000)), () => ({ result: ok })),
    });
    expect((await ChainReader.forRpc(deployment, [A, B], sepolia).latestBlock()).number).toBe(400n);
  });

  // Node-failure drill L6: the demo page's connection line says the nodes are behind, rather than "Connected".
  it("the demo page's reader: every node behind → the text for its connection line; one current node → none", async () => {
    const now = Math.floor(Date.now() / 1000);
    serve({ [A]: latestOr(block(100, now - 600), () => ({ result: ok })), [B]: latestOr(block(150, now - 601), () => ({ result: ok })) });
    const behind = (await ChainReader.forPage(deployment, [A, B])).behind;
    expect(behind).toMatch(/^Sepolia nodes are behind: the newest block they report is 60\d s old, more than the 300 s allowed, so Verify will refuse it\./);
    serve({ [A]: latestOr(block(100, now - 600), () => ({ result: ok })), [B]: latestOr(block(400, now), () => ({ result: ok })) });
    expect((await ChainReader.forPage(deployment, [A, B])).behind).toBeUndefined();
    // A head that cannot be read is left to Verify to report (no claim either way).
    serve({ [A]: () => ({ error: { code: -32000, message: "down" } }) });
    expect((await ChainReader.forPage(deployment, [A])).behind).toBeUndefined();
  });
});

// Node-failure drill L5: a node that hangs costs one timeout (8 s by default), not one per request and retry.
describe("historyFallback: a node that does not answer", () => {
  const T = 50;
  const chainId = { result: "0xaa36a7" };

  it("one request waits at most the timeout for a node, then asks the next one; the silent node is asked last afterwards", async () => {
    const calls = serve({ [A]: () => HANG, [B]: () => chainId });
    const c = createPublicClient({ chain: sepolia, transport: historyFallback([A, B], { timeoutMs: T }) });
    const t0 = Date.now();
    expect(await c.getChainId()).toBe(11155111);
    expect(Date.now() - t0).toBeLessThan(T * 6);
    expect(await c.request({ method: "eth_chainId" })).toBe("0xaa36a7");
    // A once (no retry after its timeout), then B; the second request goes to B first.
    expect(calls.map((x) => x.url)).toEqual([A, B, B]);
  });

  it("every node silent → one timeout per node, and an error that says which node did not answer within how long", async () => {
    const calls = serve({ [A]: () => HANG, [B]: () => HANG });
    const c = createPublicClient({ chain: sepolia, transport: historyFallback([A, B], { timeoutMs: T }) });
    const err = (await c.getChainId().then(
      () => undefined,
      (e: unknown) => e,
    )) as BaseError;
    const nodesErr = err.walk((e) => e instanceof RpcNodesError) as RpcNodesError;
    expect(nodesErr.outcomes.map((o) => [o.url, o.kind, o.detail])).toEqual([
      [A, "timeout", "did not answer within 0.05 s"],
      [B, "timeout", "did not answer within 0.05 s"],
    ]);
    expect(err.message).toContain(
      `eth_chainId: none of the 2 RPC nodes answered: node ${A} did not answer within 0.05 s; node ${B} did not answer within 0.05 s; try again or use another RPC`,
    );
    expect(calls).toHaveLength(2);
  });

  it("a single node (--rpc): one timeout, no retry, and the message names the node and the time", async () => {
    const calls = serve({ [A]: () => HANG });
    const c = createPublicClient({ chain: sepolia, transport: timedHttp(A, { retryCount: 3, timeoutMs: T }) });
    const t0 = Date.now();
    await expect(c.getChainId()).rejects.toThrow(`node ${A} did not answer within 0.05 s; try again or use another RPC`);
    expect(Date.now() - t0).toBeLessThan(T * 6);
    expect(calls).toHaveLength(1);
  });

  it("other errors are still retried as before (a rate limit), and the default timeout is 8 s", async () => {
    let n = 0;
    const calls = serve({ [A]: () => (++n === 1 ? { error: { code: -32005, message: "rate limited" } } : chainId) });
    const c = createPublicClient({ chain: sepolia, transport: timedHttp(A, { retryCount: 1 }) });
    expect(await c.getChainId()).toBe(11155111);
    expect(calls).toHaveLength(2);
    expect(RPC_TIMEOUT_MS).toBe(8_000);
  });
});

// L3: the CLI's node list.
describe("CLI RPC list: --rpc, then CARBONLEI_RPC_URL, then the default list", () => {
  it("takes --rpc first, then the comma-separated environment variable, then SEPOLIA_RPCS", () => {
    expect(rpcUrlsFrom("https://flag.example", `${A},${B}`)).toEqual({ urls: ["https://flag.example"], source: "flag" });
    expect(rpcUrlsFrom(undefined, ` ${A} , ${B},, `)).toEqual({ urls: [A, B], source: "env" });
    expect(rpcUrlsFrom(undefined, A)).toEqual({ urls: [A], source: "env" });
    expect(rpcUrlsFrom(undefined, undefined)).toEqual({ urls: SEPOLIA_RPCS, source: "default" });
    expect(rpcUrlsFrom("", " , ")).toEqual({ urls: SEPOLIA_RPCS, source: "default" });
  });
});

// L7: an incomplete event history from one node is asked of the next node; only when every node's answer is
// incomplete does the verification fail (fail closed).
describe("verifyPresentation: an incomplete eth_getLogs answer from one node", () => {
  const proof = JSON.parse(read("fixtures/sepolia-demo-proof.json")) as Presentation;
  const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
  const head = JSON.parse(read("sdk/test/fixtures/sepolia-demo-rpc.json")).answers['eth_getBlockByNumber ["latest",false]'].result;
  const now = () => Number(BigInt(head.timestamp)) * 1000 + 5_000;
  const loadBundle = async (p: string) => read(`demo/public/${p}`);
  const opts = { importerEORI: "NLDEMO000000001", now, checkers: vleiCheckers({ loadBundle }) };

  /** The recorded Sepolia answers, except that the nodes in `empty` answer every eth_getLogs with no events. */
  function replayWithEmptyLogs(empty: string[]) {
    const replay = replayFetch(recording);
    const logs: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      // Node names as in SEPOLIA_RPCS (fetch gets "https://host/" for "https://host").
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = [...SEPOLIA_RPCS, A].find((u) => new URL(u).href === new URL(href).href) ?? href;
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getLogs") {
        logs.push(url);
        if (empty.includes(url)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }), { headers: { "content-type": "application/json" } });
      }
      return replay(input, init);
    });
    return logs;
  }

  it("the first node's answer is empty → the verification is run again with the events read from the next node: VALID", async () => {
    const logs = replayWithEmptyLogs([SEPOLIA_RPCS[0]]);
    const r = await verifyPresentation(proof, ChainReader.forSepolia(deployment), opts);
    expect(r.overall).toBe("VALID");
    expect(r.checks.filter((c) => c.status === "pass")).toHaveLength(9);
    expect(logs[0]).toBe(SEPOLIA_RPCS[0]);
    expect(logs.at(-1)).toBe(SEPOLIA_RPCS[1]);
  }, 30_000);

  it("every node's answer is empty → fails with the incomplete-history error after asking each node", async () => {
    const logs = replayWithEmptyLogs(SEPOLIA_RPCS);
    const err = await verifyPresentation(proof, ChainReader.forSepolia(deployment), opts).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe(INCOMPLETE_HISTORY("this report's own ReportRegistered event"));
    expect(isIncompleteHistory(err)).toBe(true);
    expect([...new Set(logs)]).toEqual(SEPOLIA_RPCS);
  }, 30_000);

  it("a single node with an empty answer fails at once (nothing else to ask)", async () => {
    const logs = replayWithEmptyLogs([A]);
    await expect(verifyPresentation(proof, ChainReader.forRpc(deployment, [A], sepolia), opts)).rejects.toThrow(/incomplete event history/);
    expect(new Set(logs)).toEqual(new Set([A]));
  }, 30_000);
});

describe("default RPC list", () => {
  it("lists only full-history nodes (no node known to prune history); the demo page uses the same list", () => {
    expect(SEPOLIA_RPCS).toEqual([
      "https://rpc.sepolia.ethpandaops.io",
      "https://sepolia.gateway.tenderly.co",
      "https://gateway.tenderly.co/public/sepolia",
    ]);
    // Nodes measured on 2026-10-07 to prune old receipts, logs or state, or to cap the log range below 10,000 blocks.
    const pruning = ["publicnode.com", "0xrpc.io", "1rpc.io", "thirdweb.com"];
    for (const url of SEPOLIA_RPCS) expect(pruning.some((p) => url.includes(p)), url).toBe(false);
    expect(JSON.parse(read("demo/public/demo-data.json")).network.rpcs).toEqual(SEPOLIA_RPCS);
  });
});

describe("audit:onchain over several nodes", () => {
  const readme = read("README.md");
  const recorded = recordedTxs(JSON.parse(read("fixtures/sepolia-tx.json")), deployment);
  const rows = parseOnchainTable(readme);

  /** A node with every recorded receipt and code; `pruned` drops the receipts (null) and `codeless` the code. */
  function node(url: string, mode: { pruned?: boolean; codeless?: boolean; down?: boolean; gasOff?: boolean } = {}): Node {
    const src: ReceiptSource = {
      async getTransactionReceipt({ hash }) {
        if (mode.down) throw new Error("fetch failed");
        if (mode.pruned) return null;
        const r = recorded.get(hash.toLowerCase())!;
        const row = rows.find((x) => x.txs.includes(hash))!;
        return {
          status: row.expectedStatus ? "success" : "reverted",
          blockNumber: BigInt(r.block),
          gasUsed: BigInt(r.gasUsed) + (mode.gasOff ? 1n : 0n),
          contractAddress: r.contractAddress ?? null,
        };
      },
      async getCode() {
        if (mode.down) throw Object.assign(new Error("pruned history unavailable"), { code: 4444 });
        return mode.codeless ? "0x" : "0x6080";
      },
    };
    return { url, src };
  }
  const fails = async (nodes: Node[]) => (await audit(rows, recorded, nodes)).filter((l) => !l.ok).map((l) => l.text);

  it("the first node has pruned the receipts and has no code → every row passes on the second node", async () => {
    const lines = await audit(rows, recorded, [node(A, { pruned: true, codeless: true }), node(B)]);
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    expect(lines.filter((l) => l.kind === "tx")).toHaveLength(12);
    expect(lines.every((l) => l.text.includes("b.example"))).toBe(true);
  });

  it("every node pruned, empty or down → each row fails and names every node's answer", async () => {
    const f = await fails([node(A, { pruned: true, codeless: true }), node(B, { down: true })]);
    expect(f).toHaveLength(14);
    expect(f[0]).toMatch(/no node returned the receipt \(a\.example: no receipt \(null.*b\.example: error: fetch failed\)/);
    expect(f.find((t) => t.includes("has no code"))).toMatch(/a\.example: no code; b\.example: history pruned: pruned history unavailable/);
  });

  it("a receipt that differs from the record fails, even if a later node would match", async () => {
    const f = await fails([node(A, { gasOff: true }), node(B)]);
    expect(f).toHaveLength(12);
    expect(f[0]).toMatch(/gasUsed .* \(from a\.example\)/);
  });
});
