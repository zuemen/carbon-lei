// The machine-readable verdict (sdk/verdict.ts) and its schema (docs/schemas/verdict.schema.json),
// without a chain: the shape of each case, the exit codes and the error path of `verify --json`.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainReader, type Deployment } from "../chain.ts";
import { vleiCheckers } from "../checkers.ts";
import { decodeDisclosure, type Presentation } from "../disclosure.ts";
import { verifyPresentation, type CheckResult, type EvidenceCheckers, type VerificationResult } from "../verify.ts";
import { EXIT, TOOL, exitCodeOf, toVerdict, verdictError, verdictFor } from "../verdict.ts";
import { DEMO_TRUST_ANCHOR } from "../vlei.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const proof = readJson("fixtures/sepolia-demo-proof.json") as Presentation;
const tampered = readJson("fixtures/sepolia-demo-proof.tampered.json") as Presentation;
const deployment = readJson("contracts/deployments/11155111.json") as Deployment;
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const loadBundle = (path: string) => readFileSync(new URL(`../../demo/public/${path}`, import.meta.url), "utf8");

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

/** A chain with nothing registered, counting the reads verdictFor watches (checks 0-3 run offline). */
function emptyChain(over: { getChainId?: () => Promise<number> } = {}) {
  const zero = `0x${"0".repeat(64)}`;
  const calls = { getChainId: 0, latestBlock: 0, at: 0 };
  const r = {
    client: {
      getChainId: async () => {
        calls.getChainId++;
        return over.getChainId ? over.getChainId() : 11155111;
      },
    },
    registry: deployment.contracts.EmissionsClaimRegistry.address,
    deployedBlock: 0n,
    options: {},
    deploymentTimestamp: async () => 0n,
    latestBlock: async () => {
      calls.latestBlock++;
      return { number: 4242n, timestamp: 1791177348n };
    },
    at(this: unknown) {
      calls.at++;
      // verdictFor's proxy calls the reader's own methods on the reader, not on the proxy.
      if (this !== r) throw new Error("at() called on the proxy");
      return r;
    },
    report: async () => ({ registeredAt: 0n }),
    shipmentStatus: async () => ({ reportKey: zero, claimedAt: 0n }),
    remainingKg: async () => 0n,
    reportScope: async () => ({ reportIdHash: zero, latestReportKey: zero, boundAt: 0n }),
  };
  return { reader: r as unknown as ChainReader, calls };
}

const pass = (index: number, name: string): CheckResult => ({ index, name, status: "pass", code: "", detail: "stub" });
const stubCheckers: EvidenceCheckers = {
  anchor: () => pass(6, "KEL anchor"),
  authority: () => pass(7, "Authority chain"),
  reconciliation: () => pass(8, "Reconciliation"),
};
const asCheck = (c: VerificationResult["checks"][number]) => ({ id: c.index, name: c.name, status: c.status, code: c.code, detail: c.detail });

describe("toVerdict", () => {
  it("CONTESTED: maps every check field by field, in order, and copies the disclosed values", () => {
    const checks: VerificationResult["checks"] = [
      { index: 0, name: "Structure", status: "pass", code: "", detail: "" },
      { index: 4, name: "On-chain report", status: "pass", code: "CONTESTED", detail: "revoked 2 h after" },
      { index: 5, name: "Shipment", status: "skipped", code: "", detail: "no EORI" },
      { index: 8, name: "Reconciliation", status: "warn", code: "CONSISTENCY_WARNING/PROOF_MISMATCH", detail: "1 rule" },
    ];
    const disclosed = { productCN: "7318" };
    const v = toVerdict(proof, result({ overall: "CONTESTED", checks, disclosed }), { chainId: 11155111, block: 7n });
    expect([v.overall, v.primaryCode, exitCodeOf(v)]).toEqual(["CONTESTED", "", EXIT.CONTESTED]);
    expect(v.checks).toEqual(checks.map(asCheck));
    expect(v.disclosed).toEqual(disclosed);
    expect(v.disclosed).not.toBe(disclosed);
    expect(v.tool).not.toBe(TOOL);
    expect([v.chain, v.trustAnchor]).toEqual([{ chainId: 11155111, block: 7 }, null]);
    expect(verdictSchemaErrors(v)).toEqual([]);
  });

  it("INVALID: keeps the primary code of the first failing check", () => {
    const checks: VerificationResult["checks"] = [
      { index: 0, name: "Structure", status: "pass", code: "", detail: "" },
      { index: 3, name: "Signature", status: "fail", code: "BAD_SIGNATURE", detail: "x" },
      { index: 4, name: "On-chain report", status: "fail", code: "REPORT_NOT_REGISTERED", detail: "y" },
    ];
    const v = toVerdict(proof, result({ overall: "INVALID", primaryCode: "BAD_SIGNATURE", checks }), { chainId: 1, block: 0n });
    expect([v.overall, v.primaryCode, exitCodeOf(v)]).toEqual(["INVALID", "BAD_SIGNATURE", EXIT.INVALID]);
    expect(v.chain).toEqual({ chainId: 1, block: 0 });
    expect(verdictSchemaErrors(v)).toEqual([]);
  });

  it("hidden and rejected: once check 2 ran, a presented disclosure missing from the disclosed values is rejected, not hidden", () => {
    const check2 = [{ index: 2, name: "Disclosures", status: "fail" as const, code: "DISCLOSURE_TAMPERED", detail: "" }];
    const names = new Set(proof.disclosures.map((d) => decodeDisclosure(d).name));
    const none = toVerdict(proof, result({ overall: "INVALID", primaryCode: "DISCLOSURE_TAMPERED", checks: check2, hidden: names.size + 3 }), {});
    expect([none.hidden, none.rejected]).toEqual([3, names.size]);
    // The hidden count never goes below 0.
    expect(toVerdict(proof, result({ checks: check2, hidden: 0 }), {}).hidden).toBe(0);
    // Without check 2 (the run stopped at check 0) nothing is split.
    expect(toVerdict(proof, result({ hidden: 5 }), {})).toMatchObject({ hidden: 5, rejected: 0 });
  });

  it("a core that parses but has no string SAID: credSAID null", () => {
    expect(toVerdict({ ...proof, core: JSON.stringify({ d: 5 }) }, result(), {}).credSAID).toBeNull();
    expect(toVerdict({ ...proof, core: "null" }, result(), {}).credSAID).toBeNull();
  });
});

describe("verdictError", () => {
  it("takes the message of an Error, or the text of anything else, and conforms to the schema", () => {
    const outs = [verdictError(new Error("boom")), verdictError("plain text"), verdictError(undefined), verdictError(null), verdictError({ message: "rpc down" })];
    expect(outs.map((o) => o.error)).toEqual(["boom", "plain text", "undefined", "null", "rpc down"]);
    for (const o of outs) {
      expect(o).toEqual({ format: 1, error: o.error, tool: TOOL });
      expect(verdictSchemaErrors(o)).toEqual([]);
    }
  });
});

describe("verdictFor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the demo proof against the recorded Sepolia answers: VALID, the recorded block, the demo root, the same checks as verifyPresentation", async () => {
    vi.stubGlobal("fetch", replayFetch(recording));
    const importerEORI = "NLDEMO000000001";
    const v = await verdictFor(proof, ChainReader.forSepolia(deployment), { importerEORI, loadBundle });
    const head = readJson("sdk/test/fixtures/sepolia-demo-rpc.json").answers['eth_getBlockByNumber ["latest",false]'].result;
    expect([v.overall, v.primaryCode, exitCodeOf(v)]).toEqual(["VALID", "", EXIT.VALID]);
    expect(v.chain).toEqual({ chainId: 11155111, block: Number(head.number) });
    expect(v.trustAnchor).toBe(DEMO_TRUST_ANCHOR);
    expect(v.checks.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([v.rejected, v.credSAID]).toEqual([0, JSON.parse(proof.core).d]);
    expect(typeof v.checkedAt).toBe("number");
    expect(verdictSchemaErrors(v)).toEqual([]);
    const r = await verifyPresentation(proof, ChainReader.forSepolia(deployment), {
      importerEORI,
      checkers: vleiCheckers({ loadBundle: async (p: string) => loadBundle(p) }),
    });
    expect(v.checks).toEqual(r.checks.map(asCheck));
    expect(v.disclosed).toEqual(r.disclosed);
  }, 30_000);

  it("the tampered proof: INVALID with DISCLOSURE_TAMPERED, one disclosure rejected, block and chain ID from the reads verifyPresentation made", async () => {
    const { reader, calls } = emptyChain();
    const v = await verdictFor(tampered, reader, { checkers: stubCheckers });
    expect([v.overall, v.primaryCode, exitCodeOf(v)]).toEqual(["INVALID", "DISCLOSURE_TAMPERED", EXIT.INVALID]);
    expect(v.checks.find((c) => c.id === 2)).toMatchObject({ status: "fail", code: "DISCLOSURE_TAMPERED" });
    expect(v.rejected).toBe(1);
    expect(v.disclosed).not.toHaveProperty("specificEmbeddedEmissions_tCO2e_per_t");
    expect(v.chain).toEqual({ chainId: 11155111, block: 4242 });
    // verdictFor adds no request of its own.
    expect(calls).toEqual({ getChainId: 1, latestBlock: 1, at: 1 });
    // Caller-supplied checkers and no trust anchor: the verdict does not name a root.
    expect(v.trustAnchor).toBeNull();
    expect(verdictSchemaErrors(v)).toEqual([]);
  });

  it("names the root it was given, with the caller's checkers or with the default ones", async () => {
    const root = "E".padEnd(44, "B");
    const custom = await verdictFor(proof, emptyChain().reader, { checkers: stubCheckers, trustAnchor: root });
    const dflt = await verdictFor(proof, emptyChain().reader, { trustAnchor: root, loadBundle });
    for (const v of [custom, dflt]) {
      expect(v.trustAnchor).toBe(root);
      // Nothing is registered on the empty chain, so check 4 fails whatever the root.
      expect(v.overall).toBe("INVALID");
      expect(v.checks.find((c) => c.id === 4)?.status).toBe("fail");
      expect(verdictSchemaErrors(v)).toEqual([]);
    }
  });

  it("a malformed proof stops at check 0 before any chain read: block null", async () => {
    const { reader, calls } = emptyChain();
    const v = await verdictFor({ ...proof, disclosures: "x" } as unknown as Presentation, reader, { checkers: stubCheckers });
    expect([v.overall, v.checks[0].status]).toEqual(["INVALID", "fail"]);
    expect(v.chain.block).toBeNull();
    expect(calls.latestBlock).toBe(0);
    expect(verdictSchemaErrors(v)).toEqual([]);
  });

  it("a chain read that throws rejects, and its error object conforms to the schema", async () => {
    const { reader } = emptyChain({ getChainId: async () => Promise.reject(new Error("rpc unreachable")) });
    const err = await verdictFor(proof, reader, { checkers: stubCheckers }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const out = verdictError(err);
    expect(out.error).toMatch(/rpc unreachable/);
    expect(verdictSchemaErrors(out)).toEqual([]);
  });
});
