// The SDK example under "Machine-readable verdict" in README.md, run exactly as written: the first
// ```js block of that section is extracted and run with Node from the repository root. Its Sepolia
// reads are answered offline from recorded answers (sdk/test/fixtures/sepolia-demo-rpc.json, see
// helpers/rpc-replay.ts), so the example cannot drift from the code and the test needs no network.
// Refresh the recording with: RPC_RECORD=sdk/test/fixtures/sepolia-demo-rpc.json node --import ./sdk/test/helpers/rpc-replay.ts verify.mjs
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const preload = fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));

function readmeSnippet(readme: string): string {
  const section = readme.split(/^### Machine-readable verdict$/m)[1]?.split(/^#{2,3} /m)[0];
  const code = section && /```js\n([\s\S]*?)```/.exec(section)?.[1];
  if (!code) throw new Error('README.md has no ```js block under "### Machine-readable verdict"');
  return code;
}

describe("README SDK example", () => {
  it("runs as written and prints a VALID verdict for the demo proof", async () => {
    const code = readmeSnippet(readFileSync(`${root}README.md`, "utf8"));
    expect(code.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(10);
    const { stdout } = await run(process.execPath, ["--import", preload, "--input-type=module", "-e", code], {
      cwd: root,
      env: { ...process.env, RPC_REPLAY: recording, RPC_RECORD: "" },
    });
    const block = JSON.parse(readFileSync(recording, "utf8")).answers['eth_getBlockByNumber ["latest",false]'].result.number;
    expect(stdout.trim()).toBe(`VALID - ${Number(block)}`);
  }, 30_000);
});
