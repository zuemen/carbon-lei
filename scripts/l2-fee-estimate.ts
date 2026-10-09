// L2 fee estimate without a funded wallet. For each L2, the demo's six transactions (deploy
// VerifierAllowlist, deploy EmissionsClaimRegistry, addVerifier, addAuditor, registerReport, claimShipment)
// are replayed on a local `anvil --fork-url <public L2 RPC>` fork, from the same sender addresses
// (impersonated) and with the same calldata as the Sepolia demo transactions (fixtures/sepolia-tx.json;
// contracts/src is unchanged since that deployment). The fork gives the execution gas of each transaction.
// The fees are then read from the live chain, not the fork:
//   OP stack (Base, OP Mainnet): L2 base fee (latest block's baseFeePerGas) and eth_maxPriorityFeePerGas;
//     the L1 data fee from the GasPriceOracle predeploy 0x420…000F `getL1Fee(bytes)`, called with the
//     unsigned RLP-encoded EIP-1559 transaction (the oracle adds 68 bytes for the signature itself, in
//     both the Ecotone and the Fjord formulas), plus `getL1FeeUpperBound(len)` for comparison and
//     `getOperatorFee(gasUsed)` (Isthmus and later).
//   Arbitrum One: L2 base fee from the latest block, and the L1 component in gas units from the
//     NodeInterface (0x…C8) `gasEstimateL1Component(to, contractCreation, data)`, called with eth_call.
// ETH/USD from CoinGecko's simple price API, timestamped. Several samples, some minutes apart.
// Nothing is signed or sent to a live chain; no key is needed. This is an estimate, not a deployment.
//
// Usage: node scripts/l2-fee-estimate.ts [--samples 6] [--interval-sec 120] [--out docs/data/l2-fees-<date>.json]
//        [--chains base,optimism,arbitrum] [--port 18745]
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  concat,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hexToBigInt,
  pad,
  parseAbi,
  serializeTransaction,
  toHex,
  type Hex,
} from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEPOLIA_RPC = "https://rpc.sepolia.ethpandaops.io";

type ChainCfg = { key: string; name: string; chainId: number; rpc: string; kind: "op" | "arbitrum" };
const CHAINS: Record<string, ChainCfg> = {
  base: { key: "base", name: "Base mainnet", chainId: 8453, rpc: "https://mainnet.base.org", kind: "op" },
  optimism: { key: "optimism", name: "OP Mainnet", chainId: 10, rpc: "https://mainnet.optimism.io", kind: "op" },
  arbitrum: { key: "arbitrum", name: "Arbitrum One", chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc", kind: "arbitrum" },
};

const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F" as const;
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8" as const;
const oracleAbi = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
  "function l1BaseFee() view returns (uint256)",
  "function blobBaseFee() view returns (uint256)",
  "function baseFeeScalar() view returns (uint32)",
  "function blobBaseFeeScalar() view returns (uint32)",
  "function isFjord() view returns (bool)",
  "function isIsthmus() view returns (bool)",
  "function isJovian() view returns (bool)",
  "function version() view returns (string)",
]);
const nodeInterfaceAbi = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

/** The demo flow, in order; `step` names as in fixtures/sepolia-tx.json. */
const STEPS = [
  { op: "deployAllowlist", sepolia: "deploy:VerifierAllowlist" },
  { op: "deployRegistry", sepolia: "deploy:EmissionsClaimRegistry" },
  { op: "addVerifier", sepolia: "addVerifier" },
  { op: "addAuditor", sepolia: "addAuditor" },
  { op: "registerReport", sepolia: "registerReport1" },
  { op: "claimShipment", sepolia: "claim1" },
] as const;

// ------------------------------------------------------------------ JSON-RPC

let rpcId = 0;
async function rpc<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(`${method} on ${url}: ${j.error.message}`);
      return j.result as T;
    } catch (e) {
      if (attempt >= 2 || String(e).includes("execution reverted")) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function ethCall(url: string, to: Hex, data: Hex, block: Hex | "latest" = "latest"): Promise<Hex> {
  return rpc<Hex>(url, "eth_call", [{ to, data }, block]);
}

// ------------------------------------------------------------------ inputs

type SepoliaTx = { step: string; hash: Hex; from: Hex; to: Hex | null; input: Hex; gasUsed: number };

async function loadSepoliaTxs(): Promise<SepoliaTx[]> {
  const log = JSON.parse(readFileSync(resolve(ROOT, "fixtures/sepolia-tx.json"), "utf8"));
  const dep = JSON.parse(readFileSync(resolve(ROOT, "contracts/deployments/11155111.json"), "utf8"));
  const wanted: { step: string; hash: Hex; gasUsed: number }[] = [
    { step: "deploy:VerifierAllowlist", hash: dep.contracts.VerifierAllowlist.txHash, gasUsed: dep.contracts.VerifierAllowlist.gasUsed },
    { step: "deploy:EmissionsClaimRegistry", hash: dep.contracts.EmissionsClaimRegistry.txHash, gasUsed: dep.contracts.EmissionsClaimRegistry.gasUsed },
    ...STEPS.slice(2).map((s) => {
      const t = log.txs.find((x: any) => x.step === s.sepolia && x.result === "success");
      if (!t) throw new Error(`no ${s.sepolia} in fixtures/sepolia-tx.json`);
      return { step: s.sepolia, hash: t.hash as Hex, gasUsed: Number(t.gasUsed) };
    }),
  ];
  const out: SepoliaTx[] = [];
  for (const w of wanted) {
    const tx = await rpc<any>(SEPOLIA_RPC, "eth_getTransactionByHash", [w.hash]);
    if (!tx) throw new Error(`Sepolia tx ${w.hash} not found on ${SEPOLIA_RPC}`);
    out.push({ ...w, from: getAddress(tx.from), to: tx.to ? getAddress(tx.to) : null, input: tx.input });
  }
  return out;
}

async function ethUsd(): Promise<{ usd: number; at: string; source: string }> {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true";
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const j = (await res.json()) as { ethereum: { usd: number; last_updated_at: number } };
  return {
    usd: j.ethereum.usd,
    at: new Date(j.ethereum.last_updated_at * 1000).toISOString(),
    source: "CoinGecko /api/v3/simple/price (ids=ethereum, vs_currencies=usd); `at` is CoinGecko's last_updated_at",
  };
}

// ------------------------------------------------------------------ fork: execution gas

async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--auto-impersonate", "--silent", "--no-mining"], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try {
      await rpc(url, "eth_chainId");
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  child.kill();
  throw new Error("anvil did not start (is Foundry on PATH?)");
}

type ForkResult = { op: string; from: Hex; to: Hex | null; data: Hex; nonce: number; gasUsed: number; sepoliaGasUsed: number; status: string };

async function replayOnFork(cfg: ChainCfg, txs: SepoliaTx[], port: number): Promise<{ forkBlock: number; results: ForkResult[] }> {
  const child = await startAnvil(cfg.rpc, port);
  const url = `http://127.0.0.1:${port}`;
  try {
    const forkBlock = Number(hexToBigInt(await rpc<Hex>(url, "eth_blockNumber")));
    const senders = [...new Set(txs.map((t) => t.from))];
    for (const s of senders) await rpc(url, "anvil_setBalance", [s, toHex(10n ** 20n)]);
    const addrs: Record<string, Hex> = {};
    const results: ForkResult[] = [];
    for (let i = 0; i < STEPS.length; i++) {
      const s = STEPS[i];
      const t = txs[i];
      let to: Hex | null = t.to;
      let data = t.input;
      if (s.op === "deployRegistry") {
        // Constructor argument (the last 32 bytes of the init code): the allowlist on this fork.
        data = concat([data.slice(0, data.length - 64) as Hex, pad(addrs.allowlist)]);
      } else if (s.op === "addVerifier" || s.op === "addAuditor") to = addrs.allowlist;
      else if (s.op === "registerReport" || s.op === "claimShipment") to = addrs.registry;
      const nonce = Number(hexToBigInt(await rpc<Hex>(url, "eth_getTransactionCount", [t.from, "latest"])));
      const hash = await rpc<Hex>(url, "eth_sendTransaction", [{ from: t.from, ...(to ? { to } : {}), data, gas: toHex(5_000_000) }]);
      await rpc(url, "evm_mine");
      const r = await rpc<any>(url, "eth_getTransactionReceipt", [hash]);
      if (r.status !== "0x1") throw new Error(`${cfg.name} fork: ${s.op} reverted`);
      if (s.op === "deployAllowlist") addrs.allowlist = getAddress(r.contractAddress);
      if (s.op === "deployRegistry") addrs.registry = getAddress(r.contractAddress);
      results.push({ op: s.op, from: t.from, to, data, nonce, gasUsed: Number(hexToBigInt(r.gasUsed)), sepoliaGasUsed: t.gasUsed, status: "success" });
      console.log(`  ${cfg.name} fork: ${s.op} gasUsed ${Number(hexToBigInt(r.gasUsed))} (Sepolia ${t.gasUsed})`);
    }
    return { forkBlock, results };
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ------------------------------------------------------------------ live fees

/** Unsigned RLP-encoded EIP-1559 transaction, as the GasPriceOracle expects. */
function unsignedTx(chainId: number, f: ForkResult, baseFee: bigint, tip: bigint): Hex {
  return serializeTransaction({
    type: "eip1559",
    chainId,
    nonce: f.nonce,
    gas: BigInt(Math.ceil(f.gasUsed * 1.2)),
    maxFeePerGas: baseFee * 2n + tip,
    maxPriorityFeePerGas: tip,
    ...(f.to ? { to: f.to } : {}),
    value: 0n,
    data: f.data,
  });
}

const gwei = (w: bigint) => Number(formatUnits(w, 9));
const eth = (w: bigint) => Number(formatUnits(w, 18));

async function sampleOp(cfg: ChainCfg, fork: ForkResult[]) {
  const blk = await rpc<any>(cfg.rpc, "eth_getBlockByNumber", ["latest", false]);
  const blockTag = blk.number as Hex;
  const baseFee = hexToBigInt(blk.baseFeePerGas);
  const tip = hexToBigInt(await rpc<Hex>(cfg.rpc, "eth_maxPriorityFeePerGas"));
  const gasPrice = hexToBigInt(await rpc<Hex>(cfg.rpc, "eth_gasPrice"));
  const read = async (fn: any, args: any[] = []) =>
    decodeFunctionResult({ abi: oracleAbi, functionName: fn, data: await ethCall(cfg.rpc, GAS_PRICE_ORACLE, encodeFunctionData({ abi: oracleAbi, functionName: fn, args } as any), blockTag) } as any) as any;
  const oracle = {
    version: await read("version"),
    isFjord: await read("isFjord"),
    isIsthmus: await read("isIsthmus"),
    isJovian: await read("isJovian"),
    l1BaseFeeWei: String(await read("l1BaseFee")),
    blobBaseFeeWei: String(await read("blobBaseFee")),
    baseFeeScalar: Number(await read("baseFeeScalar")),
    blobBaseFeeScalar: Number(await read("blobBaseFeeScalar")),
  };
  const ops = [];
  for (const f of fork) {
    const raw = unsignedTx(cfg.chainId, f, baseFee, tip);
    const l1Fee = (await read("getL1Fee", [raw])) as bigint;
    const l1Upper = (await read("getL1FeeUpperBound", [BigInt((raw.length - 2) / 2)])) as bigint;
    let operatorFee = 0n;
    if (oracle.isIsthmus) operatorFee = (await read("getOperatorFee", [BigInt(f.gasUsed)])) as bigint;
    const l2Base = BigInt(f.gasUsed) * baseFee;
    const l2Tip = BigInt(f.gasUsed) * tip;
    ops.push({
      op: f.op,
      gasUsed: f.gasUsed,
      unsignedTxBytes: (raw.length - 2) / 2,
      l2ExecutionFeeAtBaseFeeWei: String(l2Base),
      l2PriorityTipWei: String(l2Tip),
      l1DataFeeWei: String(l1Fee),
      l1DataFeeUpperBoundWei: String(l1Upper),
      operatorFeeWei: String(operatorFee),
      totalWei: String(l2Base + l1Fee + operatorFee),
      totalWithTipWei: String(l2Base + l2Tip + l1Fee + operatorFee),
    });
  }
  return {
    block: Number(hexToBigInt(blockTag)),
    blockTimestampUtc: new Date(Number(hexToBigInt(blk.timestamp)) * 1000).toISOString(),
    l2BaseFeeWei: String(baseFee),
    l2BaseFeeGwei: gwei(baseFee),
    maxPriorityFeePerGasWei: String(tip),
    ethGasPriceWei: String(gasPrice),
    oracle,
    ops,
  };
}

async function sampleArbitrum(cfg: ChainCfg, fork: ForkResult[]) {
  const blk = await rpc<any>(cfg.rpc, "eth_getBlockByNumber", ["latest", false]);
  const blockTag = blk.number as Hex;
  const baseFee = hexToBigInt(blk.baseFeePerGas);
  const gasPrice = hexToBigInt(await rpc<Hex>(cfg.rpc, "eth_gasPrice"));
  // Calls go to an address without code; the L1 component depends on the transaction's bytes, not
  // on what the call does. Contract creations are sent with contractCreation = true.
  const noCode = "0x000000000000000000000000000000000000dEaD" as Hex;
  const ops = [];
  let l1BaseFeeEstimate = 0n;
  for (const f of fork) {
    const creation = f.to === null;
    const data = encodeFunctionData({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", args: [noCode, creation, f.data] });
    const out = await rpc<Hex>(cfg.rpc, "eth_call", [{ to: NODE_INTERFACE, data, from: f.from }, blockTag]);
    const [l1Gas, nodeBaseFee, l1Est] = decodeFunctionResult({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", data: out }) as readonly [bigint, bigint, bigint];
    l1BaseFeeEstimate = l1Est;
    const price = nodeBaseFee > 0n ? nodeBaseFee : baseFee;
    const l2 = BigInt(f.gasUsed) * price;
    const l1 = l1Gas * price;
    ops.push({
      op: f.op,
      gasUsed: f.gasUsed,
      l1ComponentGas: Number(l1Gas),
      l2ExecutionFeeAtBaseFeeWei: String(l2),
      l1DataFeeWei: String(l1),
      totalWei: String(l2 + l1),
      totalWithTipWei: String(l2 + l1),
    });
  }
  return {
    block: Number(hexToBigInt(blockTag)),
    blockTimestampUtc: new Date(Number(hexToBigInt(blk.timestamp)) * 1000).toISOString(),
    l2BaseFeeWei: String(baseFee),
    l2BaseFeeGwei: gwei(baseFee),
    ethGasPriceWei: String(gasPrice),
    l1BaseFeeEstimateWei: String(l1BaseFeeEstimate),
    ops,
  };
}

// ------------------------------------------------------------------ summary

const CORRIDOR = { registrations: 743, claimsLow: 1856, claimsHigh: 18564, source: "docs/ADOPTION.md §6.1" };

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarise(samples: any[], ethUsdPrice: number) {
  const usd = (s: any, op: string, field: string) => {
    const o = s.ops.find((x: any) => x.op === op);
    return eth(BigInt(o[field] ?? o.totalWei)) * ethUsdPrice;
  };
  const stats = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });
  const view = (field: "totalWei" | "totalWithTipWei") => {
    const perOp: Record<string, any> = {};
    for (const op of samples[0].ops.map((o: any) => o.op)) {
      const totals = samples.map((s) => usd(s, op, field));
      const l1 = samples.map((s) => usd(s, op, "l1DataFeeWei"));
      perOp[op] = { ...stats(totals), l1ShareMedian: median(l1.map((v, i) => (totals[i] ? v / totals[i] : 0))) };
    }
    const pair = samples.map((s) => usd(s, "registerReport", field) + usd(s, "claimShipment", field));
    const reg = perOp.registerReport.median;
    const claim = perOp.claimShipment.median;
    return {
      perOperationUsd: perOp,
      reportPlusClaimUsd: stats(pair),
      corridorAnnualUsdEstimate: {
        low: CORRIDOR.registrations * reg + CORRIDOR.claimsLow * claim,
        high: CORRIDOR.registrations * reg + CORRIDOR.claimsHigh * claim,
      },
    };
  };
  return {
    note: "USD at the median ETH price of the run. Corridor: an estimate at the median sampled fees, registrations × registerReport + claims × claimShipment (every claim priced as a first claim); not a forecast.",
    baseFeeOnly: view("totalWei"),
    withSuggestedTip: view("totalWithTipWei"),
  };
}

// ------------------------------------------------------------------ main

async function main() {
  const { values } = parseArgs({
    options: {
      samples: { type: "string", default: "6" },
      "interval-sec": { type: "string", default: "120" },
      chains: { type: "string", default: "base,optimism,arbitrum" },
      port: { type: "string", default: "18745" },
      out: { type: "string" },
    },
  });
  const nSamples = Number(values.samples);
  const interval = Number(values["interval-sec"]) * 1000;
  const chains = values.chains!.split(",").map((c) => {
    const cfg = CHAINS[c.trim()];
    if (!cfg) throw new Error(`unknown chain ${c}; use ${Object.keys(CHAINS).join(", ")}`);
    return cfg;
  });
  const startedAt = new Date().toISOString();
  const out = values.out ?? `docs/data/l2-fees-${startedAt.slice(0, 10)}.json`;

  console.log("reading the Sepolia demo transactions …");
  const txs = await loadSepoliaTxs();

  // One fork at a time.
  const forks: Record<string, { forkBlock: number; results: ForkResult[] }> = {};
  for (const cfg of chains) {
    console.log(`forking ${cfg.name} (${cfg.rpc}) …`);
    forks[cfg.key] = await replayOnFork(cfg, txs, Number(values.port));
  }

  const prices: Awaited<ReturnType<typeof ethUsd>>[] = [];
  const samples: Record<string, any[]> = Object.fromEntries(chains.map((c) => [c.key, []]));
  for (let i = 0; i < nSamples; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, interval));
    const at = new Date().toISOString();
    try {
      prices.push(await ethUsd());
    } catch (e) {
      console.warn(`  ETH price unavailable at ${at}: ${e}`);
    }
    for (const cfg of chains) {
      const fork = forks[cfg.key].results;
      const s = cfg.kind === "op" ? await sampleOp(cfg, fork) : await sampleArbitrum(cfg, fork);
      samples[cfg.key].push({ sampledAtUtc: at, ...s });
      const reg = s.ops.find((o: any) => o.op === "registerReport")!;
      console.log(`  sample ${i + 1}/${nSamples} ${cfg.name} block ${s.block}: L2 base fee ${s.l2BaseFeeGwei} gwei; registerReport total ${eth(BigInt(reg.totalWei))} ETH`);
    }
  }
  if (!prices.length) throw new Error("no ETH price could be read");
  const ethUsdMedian = median(prices.map((p) => p.usd));

  const result = {
    kind: "estimate, not a deployment",
    startedAtUtc: startedAt,
    finishedAtUtc: new Date().toISOString(),
    method:
      "Execution gas: the six Sepolia demo transactions (same senders, impersonated; same calldata; the registry's constructor argument replaced by the fork's allowlist) replayed on `anvil --fork-url` of each L2. " +
      "Fees: read from the live chain at the sampled block. OP stack: gasUsed × latest baseFeePerGas, plus GasPriceOracle.getL1Fee(unsigned RLP EIP-1559 tx), plus GasPriceOracle.getOperatorFee(gasUsed). " +
      "Arbitrum One: (gasUsed + NodeInterface.gasEstimateL1Component(...).gasEstimateForL1) × the base fee it returns. totalWei excludes the priority tip; totalWithTipWei adds eth_maxPriorityFeePerGas × gasUsed (OP stack; Arbitrum has no priority fee, so the two are equal there).",
    caveats: [
      "The unsigned transaction uses the fork's nonce, a gas limit of 1.2 × gasUsed and maxFeePerGas = 2 × base fee + tip; a real wallet's fields differ by a few bytes, which changes the L1 data fee slightly.",
      "Every claim is priced as the demo's first claim against a report; later claims against the same report use less gas.",
      "Arbitrum: the L1 component is estimated with `to` = an address without code for calls (the estimate depends on the transaction's bytes); Arbitrum execution gas taken from an anvil fork, which runs the EVM, not ArbOS.",
      "Fees vary with L1 and L2 demand; the samples cover only the minutes listed.",
    ],
    ethUsd: { median: ethUsdMedian, samples: prices },
    corridor: CORRIDOR,
    sepoliaSource: { rpc: SEPOLIA_RPC, txs: txs.map((t) => ({ step: t.step, hash: t.hash, gasUsed: t.gasUsed })) },
    chains: Object.fromEntries(
      chains.map((cfg) => [
        cfg.key,
        {
          name: cfg.name,
          chainId: cfg.chainId,
          rpc: cfg.rpc,
          forkBlock: forks[cfg.key].forkBlock,
          executionGas: forks[cfg.key].results.map(({ op, gasUsed, sepoliaGasUsed, nonce }) => ({ op, gasUsed, sepoliaGasUsed, nonce })),
          samples: samples[cfg.key],
          summary: summarise(samples[cfg.key], ethUsdMedian),
        },
      ]),
    ),
  };
  mkdirSync(dirname(resolve(ROOT, out)), { recursive: true });
  writeFileSync(resolve(ROOT, out), JSON.stringify(result, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  for (const cfg of chains) {
    for (const mode of ["baseFeeOnly", "withSuggestedTip"] as const) {
      const s = result.chains[cfg.key].summary[mode];
      console.log(`${cfg.name} [${mode}]: report+claim median US$${s.reportPlusClaimUsd.median.toFixed(5)}; corridor US$${s.corridorAnnualUsdEstimate.low.toFixed(2)}–${s.corridorAnnualUsdEstimate.high.toFixed(2)} a year`);
      for (const [op, v] of Object.entries<any>(s.perOperationUsd)) console.log(`  ${op}: US$${v.median.toFixed(6)} (min ${v.min.toFixed(6)}, max ${v.max.toFixed(6)}), L1 share ${(v.l1ShareMedian * 100).toFixed(0)}%`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
