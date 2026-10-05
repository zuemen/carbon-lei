// One-command local demo: starts anvil on 8545 (or reuses a running one), runs the scenario,
// moves the chain 25 hours ahead before the auditor revocation, runs attack 3 and builds
// demo/public/demo-data.json. anvil is left running at the end.
//
// Usage: node scripts/demo-local.ts [--port 8545]
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, isMain, loadTxLog, readJson, rpcReachable } from "./demo-scenario.ts";

/** Genesis time of the local chain: 2026-10-05T00:00:00Z. */
const GENESIS = Math.floor(Date.parse("2026-10-05T00:00:00Z") / 1000);
const HOURS_BEFORE_REVOCATION = 25;

async function rpcCall(rpc: string, method: string, params: unknown[] = []) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function run(script: string, args: string[]) {
  console.log(`\n$ node scripts/${script} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", resolve(ROOT, "scripts", script), ...args], { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) throw new Error(`${script} exited with ${r.status}`);
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8545" } } });
  const port = Number(values.port);
  const rpc = `http://127.0.0.1:${port}`;

  let startedPid: number | undefined;
  const running = await rpcReachable(rpc);
  if (running !== null) {
    if (running !== 31337) throw new Error(`${rpc} answers with chain ${running}, not anvil (31337)`);
    console.log(`anvil already running on ${rpc}; reusing it`);
  } else {
    const child = spawn("anvil", ["--port", String(port), "--timestamp", String(GENESIS), "--silent"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    startedPid = child.pid;
    for (let i = 0; i < 100 && (await rpcReachable(rpc)) === null; i++) await new Promise((r) => setTimeout(r, 100));
    if ((await rpcReachable(rpc)) === null) throw new Error("anvil did not start (is Foundry on PATH?)");
    console.log(`started anvil on ${rpc} (pid ${startedPid}, genesis ${new Date(GENESIS * 1000).toISOString()})`);
  }

  run("demo-scenario.ts", ["--network", "local", "--rpc", rpc]);

  const log = loadTxLog("local", 31337);
  if (!log.txs.some((t) => t.step === "revokeAuditor" && t.result === "success")) {
    await rpcCall(rpc, "evm_increaseTime", [HOURS_BEFORE_REVOCATION * 3600]);
    await rpcCall(rpc, "evm_mine");
    console.log(`\nmoved the chain ${HOURS_BEFORE_REVOCATION} h ahead (revocation more than 24 h after registration)`);
  }
  run("demo-scenario.ts", ["--network", "local", "--rpc", rpc, "--steps", "revokeAuditor,attack3"]);
  run("build-demo-data.ts", ["--network", "local", "--rpc", rpc]);

  // ---- acceptance summary
  const data = readJson<any>(resolve(ROOT, "demo/public/demo-data.json"));
  const checks: { index: number; status: string }[] = data.cached?.verification?.checks ?? [];
  const results: [string, boolean][] = [
    ["checks 0–5 pass", [0, 1, 2, 3, 4, 5].every((i) => checks.find((c) => c.index === i)?.status === "pass")],
    ["dry run sameBatch = BatchAlreadyClaimed", data.cached?.dryRuns?.sameBatch?.errorName === "BatchAlreadyClaimed"],
    ["dry run secondImporter = ExceedsVerifiedTonnage", data.cached?.dryRuns?.secondImporter?.errorName === "ExceedsVerifiedTonnage"],
    ["attack 3 recorded as reverted", data.attacks?.attack3?.result === "reverted"],
    ["remaining 300 t", data.cached?.remainingKg === "300000"],
  ];
  console.log("\nacceptance:");
  for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);

  console.log(
    startedPid !== undefined
      ? `\nanvil is still running (pid ${startedPid}). Stop it with: Stop-Process -Id ${startedPid} (PowerShell) or taskkill /PID ${startedPid} /F (cmd)`
      : "\nanvil was already running before this script and is left as it was.",
  );
  if (results.some(([, ok]) => !ok)) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`demo-local failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
