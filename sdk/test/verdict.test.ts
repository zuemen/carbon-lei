// The machine-readable verdict (sdk/verdict.ts) and its schema (docs/schemas/verdict.schema.json),
// without a chain: the shape of each case, the exit codes and the error path of `verify --json`.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Presentation } from "../disclosure.ts";
import type { VerificationResult } from "../verify.ts";
import { EXIT, TOOL, exitCodeOf, toVerdict, verdictError } from "../verdict.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const proof = JSON.parse(readFileSync(new URL("../../fixtures/sepolia-demo-proof.json", import.meta.url), "utf8")) as Presentation;

const result = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  overall: "VALID",
  checks: [{ index: 0, name: "Structure", status: "pass", code: "", detail: "" }],
  disclosed: {},
  hidden: 0,
  primaryCode: "",
  checkedAt: 1791177348n,
  ...over,
});

describe("verdict", () => {
  it("tool version is the SDK package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(TOOL.version).toBe(pkg.version);
  });

  it("exit codes: VALID 0, INVALID 1, CONTESTED 2, error 3", () => {
    expect([exitCodeOf({ overall: "VALID" }), exitCodeOf({ overall: "INVALID" }), exitCodeOf({ overall: "CONTESTED" }), EXIT.ERROR]).toEqual([0, 1, 2, 3]);
  });

  it("a malformed proof: chain fields null, schema-valid", () => {
    const v = toVerdict({ ...proof, core: "{" }, result({ overall: "INVALID", primaryCode: "PRESENTATION_MALFORMED", checks: [{ index: 0, name: "Structure", status: "fail", code: "PRESENTATION_MALFORMED", detail: "x" }], checkedAt: undefined }), {});
    expect(v.chain).toEqual({ chainId: null, block: null });
    expect([v.credSAID, v.checkedAt, v.trustAnchor]).toEqual([null, null, null]);
    expect(verdictSchemaErrors(v)).toEqual([]);
  });

  it("the schema rejects an unknown verdict, an INVALID verdict without a code and extra fields", () => {
    const v = toVerdict(proof, result(), { chainId: 11155111, block: 11859236n, trustAnchor: "E".padEnd(44, "A") });
    expect(verdictSchemaErrors(v)).toEqual([]);
    expect(v.credSAID).toBe(JSON.parse(proof.core).d);
    expect(verdictSchemaErrors({ ...v, overall: "MAYBE" })).not.toEqual([]);
    expect(verdictSchemaErrors({ ...v, overall: "INVALID" })).not.toEqual([]);
    expect(verdictSchemaErrors({ ...v, primaryCode: "BAD_SIGNATURE" })).not.toEqual([]);
    expect(verdictSchemaErrors({ ...v, extra: 1 })).not.toEqual([]);
    expect(verdictSchemaErrors({ ...v, checks: [{ ...v.checks[0], status: "ok" }] })).not.toEqual([]);
    expect(verdictSchemaErrors(verdictError(new Error("boom")))).toEqual([]);
  });

  it("verify --json on an unreadable proof: an error object and exit 3; without --json, exit 1 as before", async () => {
    const missing = fileURLToPath(new URL("../../.cache/no-such-proof.json", import.meta.url));
    const withJson = await run(process.execPath, [cli, "verify", "--proof", missing, "--json"]).catch((e) => e);
    expect(withJson.code).toBe(3);
    const out = JSON.parse(withJson.stdout);
    expect(verdictSchemaErrors(out)).toEqual([]);
    expect(out.error).toMatch(/no-such-proof/);
    const plain = await run(process.execPath, [cli, "verify", "--proof", missing]).catch((e) => e);
    expect([plain.code, plain.stdout]).toEqual([1, ""]);
  }, 30_000);
});
