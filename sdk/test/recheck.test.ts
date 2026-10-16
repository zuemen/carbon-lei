// Re-check of accepted values (sdk/recheck.ts): classification on hand-built verdicts, record loading, the webhook
// payload and delivery, URL redaction for the API, and `carbonlei recheck` end to end on recorded Sepolia answers.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ACTION,
  causesOf,
  classify,
  classifyLedgerOnly,
  loadRecords,
  postWebhook,
  recheckExitCode,
  webhookPayload,
  type RecheckDocument,
} from "../recheck.ts";
import { redact } from "../server.ts";
import type { Verdict, VerdictCheck } from "../verdict.ts";
import { recheckSchemaErrors } from "./helpers/recheck-schema.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const replay = pathToFileURL(fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url))).href;
const dir = fileURLToPath(new URL("../../.cache/recheck-test/", import.meta.url));

/** A verdict with the given overall and check results (all other checks passed). */
function v(overall: Verdict["overall"], special: Record<number, Partial<VerdictCheck>> = {}): Verdict {
  const checks = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, name: `check ${id}`, status: "pass" as const, code: "", detail: "", ...special[id] }));
  return {
    format: 2, overall, primaryCode: checks.find((c) => c.status === "fail")?.code ?? "", checks, hidden: 0, rejected: 0, disclosed: {},
    credSAID: "Ecred", chain: { chainId: 11155111, block: 100 }, checkedAt: 1, warnings: [], trustAnchor: null, tool: { name: "carbonlei", version: "0.1.0" },
  };
}
const VALID = { overall: "VALID", primaryCode: "", block: 90, at: "2026-10-05T06:00:00Z" };
const REG = Date.parse("2026-10-05T05:15:36Z") / 1000;
const ctx = { headTime: REG + 2 * 86400, registeredAt: REG };

describe("classify: what changed since acceptance, and how serious it is", () => {
  it("each downgrade from VALID names its cause and needs action", () => {
    const cases: [Verdict, string][] = [
      [v("INVALID", { 4: { status: "fail", code: "REPORT_INVALID/REVOKED", detail: "the verification body revoked this report" } }), "REPORT_REVOKED"],
      [v("INVALID", { 4: { status: "fail", code: "REPORT_INVALID/SUPERSEDED", detail: "replaced by a revision in the same credential layer" } }), "REPORT_SUPERSEDED"],
      [v("INVALID", { 4: { status: "fail", code: "REPORT_INVALID/EXPIRED" } }), "REPORT_EXPIRED"],
      [v("INVALID", { 4: { status: "fail", code: "REPORT_INVALID/NOT_REGISTERED" } }), "REPORT_NOT_ON_LEDGER"],
      [v("INVALID", { 5: { status: "fail", code: "SHIPMENT_MISMATCH", detail: "no claim for this batch on the registry" } }), "CLAIM_NOT_ON_LEDGER"],
      [v("INVALID", { 5: { status: "fail", code: "SHIPMENT_MISMATCH", detail: "the claimed quantity differs" } }), "SHIPMENT_CHANGED"],
      [v("INVALID", { 5: { status: "fail", code: "SHIPMENT_MISMATCH", detail: "the report was revoked after the claim" } }), "REPORT_REVOKED"],
      [v("CONTESTED", { 4: { status: "pass", code: "CONTESTED", detail: "registered by an authorized auditor; revoked or suspended within 24 h after" } }), "AUDITOR_REVOKED_OR_BODY_SUSPENDED"],
      [v("CONTESTED", { 4: { status: "pass", code: "CONTESTED", detail: "registered…; the registering address was rotated within 24 h after" } }), "ADDRESS_ROTATED"],
      // The revoker's detail mentions a rotation too: it is a contested revocation, not a rotated registrant.
      [v("CONTESTED", { 4: { status: "warn", code: "CONTESTED", detail: "the verification body revoked this report; the revoking address was rotated away within 24 h after the revocation" } }), "REVOCATION_CONTESTED"],
      [v("CONTESTED", { 4: { status: "pass", code: "CONTESTED", detail: "the revision chain names another supplier address" } }), "CONTESTED"],
      [v("INVALID", { 7: { status: "fail", code: "AUTHORITY_INVALID" } }), "AUTHORITY_INVALID"],
      [v("INVALID", { 6: { status: "fail", code: "ANCHOR_INVALID" } }), "ANCHOR_INVALID"],
      [v("INVALID", { 3: { status: "fail", code: "BAD_SIGNATURE" } }), "NOW_INVALID"],
      [v("INCOMPLETE", { 8: { status: "skipped" } }), "NOW_INCOMPLETE"],
    ];
    for (const [cur, change] of cases) {
      const c = classify(VALID, cur, ctx);
      expect([c.change, c.severity], change).toEqual([change, "action"]);
      expect(c.action).toBe(ACTION[c.change]);
      expect(c.reasons[0]).toMatch(new RegExp(`^${change}: now ${cur.overall}`));
    }
    // Several causes at once are all reported, the most important first.
    const both = v("INVALID", {
      4: { status: "fail", code: "REPORT_INVALID/REVOKED", detail: "the verification body revoked this report" },
      5: { status: "fail", code: "SHIPMENT_MISMATCH", detail: "the report was revoked after the claim" },
      7: { status: "fail", code: "AUTHORITY_INVALID" },
    });
    expect(causesOf(both)).toEqual(["REPORT_REVOKED", "AUTHORITY_INVALID"]);
  });

  it("still VALID: final, still in the window, or unchanged; a line that was not VALID is never 'action'", () => {
    expect(classify(VALID, v("VALID"), ctx)).toMatchObject({ change: "BECAME_FINAL", severity: "info", window: { closesAt: REG + 86400, closed: true } });
    expect(classify({ ...VALID, at: "2026-10-06T06:00:00Z" }, v("VALID"), ctx).change).toBe("UNCHANGED");
    expect(classify({ ...VALID, at: null }, v("VALID"), ctx).change).toBe("UNCHANGED");
    const open = classify(VALID, v("VALID"), { headTime: REG + 3600, registeredAt: REG });
    expect([open.change, open.severity, open.reasons[0]]).toEqual(["WINDOW_OPEN", "info", "still VALID; the 24 h CONTESTED window closes at 2026-10-06T05:15:36.000Z"]);
    expect(classify(VALID, v("VALID"), { ...ctx, windowHours: 72 }).change).toBe("WINDOW_OPEN");
    const wasInvalid = { overall: "INVALID", primaryCode: "DISCLOSURE_TAMPERED", block: 1, at: null };
    expect(classify(wasInvalid, v("INVALID", { 2: { status: "fail", code: "DISCLOSURE_TAMPERED" } }), ctx)).toMatchObject({ change: "STILL_NOT_VALID", severity: "none" });
    expect(classify(wasInvalid, v("INVALID", { 4: { status: "fail", code: "REPORT_INVALID/REVOKED" } }), ctx)).toMatchObject({ change: "STILL_NOT_VALID", severity: "none" });
    expect(classify({ overall: "INCOMPLETE", primaryCode: "", block: 1, at: null }, v("VALID"), ctx)).toMatchObject({ change: "IMPROVED", severity: "info" });
  });

  it("ledger only (no proof): revoked and superseded need action (fail closed); past validity is information", () => {
    const rep = { registeredAt: BigInt(REG), revokedAt: 0n, supersededBy: `0x${"0".repeat(64)}`, validUntil: BigInt(REG + 365 * 86400) };
    expect(classifyLedgerOnly(VALID, rep, ctx)).toMatchObject({ change: "UNCHANGED", severity: "none", current: { overall: "NOT_REVERIFIED" } });
    expect(classifyLedgerOnly(VALID, { ...rep, revokedAt: BigInt(REG + 10) }, ctx)).toMatchObject({ change: "REPORT_REVOKED", severity: "action", current: { overall: "INVALID", primaryCode: "REPORT_INVALID/REVOKED" } });
    expect(classifyLedgerOnly(VALID, { ...rep, supersededBy: `0x${"1".repeat(64)}` }, ctx)).toMatchObject({ change: "REPORT_SUPERSEDED", severity: "action" });
    expect(classifyLedgerOnly(VALID, { ...rep, registeredAt: 0n }, ctx)).toMatchObject({ change: "REPORT_NOT_ON_LEDGER", severity: "action", window: null });
    expect(classifyLedgerOnly(VALID, { ...rep, validUntil: BigInt(REG) }, ctx)).toMatchObject({ change: "EXPIRED_SINCE", severity: "info" });
    expect(classifyLedgerOnly({ ...VALID, overall: "INVALID" }, { ...rep, revokedAt: 1n }, ctx)).toMatchObject({ change: "STILL_NOT_VALID", severity: "none" });
  });
});

describe("records, exit code, webhook", () => {
  it("loadRecords: Buyer records and verify-batch results; proofs found next to the file or in --proofs; junk skipped", () => {
    mkdirSync(`${dir}records`, { recursive: true });
    writeFileSync(`${dir}records/a-buyer.json`, readFileSync(`${root}fixtures/recheck/demo-accepted-record.json`));
    const batch = {
      format: 1, kind: "carbonlei-batch", pinnedBlock: 5, chainId: 11155111, eori: "NLDEMO000000001", verifiedAt: "2026-10-07T00:00:00Z",
      counts: {}, tool: {},
      results: [
        { proof: "sepolia-demo-proof.json", line: { id: "L1" }, verdict: v("VALID"), error: null, proofShipment: { batchId: "BATCH-DEMO-2026-0001", quantityTonnes: "200", shipmentDate: "2026-10-10" } },
        { proof: "missing.json", line: { id: "L2" }, verdict: v("VALID"), error: null, proofShipment: null },
        { proof: null, line: { id: "L3" }, verdict: null, error: null, proofShipment: null },
      ],
    };
    writeFileSync(`${dir}records/b-results.json`, JSON.stringify(batch));
    writeFileSync(`${dir}records/c-junk.json`, JSON.stringify({ hello: 1 }));
    writeFileSync(`${dir}records/d-notjson.json`, "{");
    const { records, skipped } = loadRecords(`${dir}records`, { proofsDir: `${root}fixtures` });
    expect(records.map((r) => [r.source, r.id, r.eori, !!r.proof, r.accepted.overall])).toEqual([
      ["a-buyer.json", "BATCH-DEMO-2026-0001", "NLDEMO000000001", true, "VALID"],
      ["b-results.json#1", "L1", "NLDEMO000000001", true, "VALID"],
      ["b-results.json#2", "L2", "NLDEMO000000001", false, "VALID"],
    ]);
    expect(records[0].proofPath).toBe(`${dir}records/a-buyer.json`);
    expect(records[0].acceptedAt).toBe("2026-10-05T06:00:00Z");
    expect(skipped).toEqual([
      "b-results.json#3 (L3): no supplier proof, so nothing was accepted",
      "c-junk.json: not a verification record or a verify-batch results file",
      expect.stringMatching(/^d-notjson\.json: not JSON/),
    ]);
  });

  it("exit code 3 on any error, else 1 on any action, else 0; the webhook gets changed lines only, without EORI", () => {
    expect([recheckExitCode({ counts: { action: 1, info: 0, none: 0, error: 1 } }), recheckExitCode({ counts: { action: 1, info: 3, none: 0, error: 0 } }), recheckExitCode({ counts: { action: 0, info: 2, none: 5, error: 0 } })]).toEqual([3, 1, 0]);
    const r = (id: string, severity: string, change: string) => ({
      source: "x", id, batchId: null, credSAID: "E1", mode: "full", accepted: { overall: "VALID", primaryCode: "", at: null, block: 1 },
      current: { overall: "INVALID", primaryCode: "REPORT_INVALID/REVOKED", block: 2 }, change, severity, reasons: [], action: "do it", window: null, verdict: v("INVALID"), error: null,
    });
    const doc = { pinnedBlock: 2, chainId: 1, checkedAt: "t", counts: { action: 1, info: 0, none: 1, error: 0 }, results: [r("L1", "action", "REPORT_REVOKED"), r("L2", "none", "UNCHANGED")], tool: { name: "carbonlei", version: "0.1.0" } } as unknown as RecheckDocument;
    const p = webhookPayload(doc)!;
    expect(p.changes).toEqual([{ id: "L1", credSAID: "E1", change: "REPORT_REVOKED", severity: "action", accepted: "VALID", current: "INVALID", primaryCode: "REPORT_INVALID/REVOKED", action: "do it" }]);
    expect(JSON.stringify(p)).not.toMatch(/eori|disclosed|signature/i);
    expect(webhookPayload({ ...doc, results: [r("L2", "none", "UNCHANGED")] } as unknown as RecheckDocument)).toBeNull();
  });

  it("postWebhook POSTs JSON and never reports the URL (it may carry a token)", async () => {
    const got: { type?: string; body: string }[] = [];
    const s = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => {
        got.push({ type: req.headers["content-type"], body: b });
        res.writeHead(req.url === "/fail" ? 500 : 204).end();
      });
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    expect(await postWebhook(`${base}/hook?token=SECRET`, { a: 1 })).toEqual({ ok: true, detail: "HTTP 204" });
    expect(got[0]).toEqual({ type: "application/json", body: '{"a":1}' });
    expect(await postWebhook(`${base}/fail`, {})).toEqual({ ok: false, detail: "HTTP 500" });
    s.close();
    const down = await postWebhook("http://127.0.0.1:1/SECRET-TOKEN", {});
    expect(down.ok).toBe(false);
    expect(down.detail).not.toContain("SECRET");
    expect((await postWebhook("file:///etc/passwd", {})).ok).toBe(false);
    expect((await postWebhook("not a url SECRET", {})).detail).toBe("the webhook URL is not a valid URL");
  });

  it("the example workflow (docs/examples/importer-recheck.yml) is valid YAML, scheduled daily, read-only, and runs recheck with the secrets as env", async () => {
    const { parse } = await import("yaml");
    const wf = parse(readFileSync(`${root}docs/examples/importer-recheck.yml`, "utf8"));
    expect(wf.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.permissions).toEqual({ contents: "read" });
    const step = wf.jobs.recheck.steps.find((s: { name: string }) => s.name === "Re-check accepted values");
    expect(step.run).toContain("node carbon-lei/sdk/cli.ts recheck records --out recheck.json");
    expect(Object.keys(step.env)).toEqual(["CARBONLEI_RPC_URL", "CARBONLEI_RECHECK_WEBHOOK_URL"]);
  });

  it("redact keeps only the origin of a URL (an RPC API key in the path never reaches a log or a client)", () => {
    expect(redact("HTTP request failed. URL: https://eth-sepolia.g.alchemy.com/v2/KEY123 Details: 429")).toBe(
      "HTTP request failed. URL: https://eth-sepolia.g.alchemy.com/… Details: 429",
    );
    expect(redact('node "wss://u:p@node.example:8546/ws/KEY" closed')).not.toMatch(/KEY|u:p/);
  });
});

describe("carbonlei recheck (recorded Sepolia answers)", () => {
  it("re-checks the Buyer-tab record of the demo proof at one pinned block: BECAME_FINAL, exit 0; text, JSON and --out agree", async () => {
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, RPC_REPLAY: recording };
    const r = await run(process.execPath, ["--import", replay, cli, "recheck", `${root}fixtures/recheck/demo-accepted-record.json`, "--json", "--out", `${dir}rc.json`], { env });
    const doc = JSON.parse(r.stdout) as RecheckDocument;
    expect(recheckSchemaErrors(doc)).toEqual([]);
    expect(doc).toMatchObject({ kind: "carbonlei-recheck", chainId: 11155111, counts: { action: 0, info: 1, none: 0, error: 0 } });
    expect(doc.pinnedBlock).toBe(Number(BigInt(JSON.parse(readFileSync(recording, "utf8")).answers['eth_getBlockByNumber ["latest",false]'].result.number)));
    const [x] = doc.results;
    expect([x.mode, x.change, x.current?.overall, x.verdict?.chain.block, x.window]).toEqual(["full", "BECAME_FINAL", "VALID", doc.pinnedBlock, { closesAt: Date.parse("2026-10-06T05:15:36Z") / 1000, closed: true }]);
    expect(JSON.stringify(doc)).not.toContain("NLDEMO000000001");
    expect(JSON.parse(readFileSync(`${dir}rc.json`, "utf8"))).toEqual(doc);

    const text = await run(process.execPath, ["--import", replay, cli, "recheck", `${root}fixtures/recheck/demo-accepted-record.json`, "--webhook", "http://127.0.0.1:1/SECRET"], { env }).catch((e) => e);
    expect(text.stdout).toContain("INFO   BATCH-DEMO-2026-0001  BECAME_FINAL  accepted VALID → now VALID");
    expect(text.stdout).toContain("1 record(s): 0 need action, 1 for information, 0 unchanged, 0 could not be re-checked");
    // The webhook could not be delivered: exit 3 (alerting failed), and the URL is not printed.
    expect(text.code).toBe(3);
    expect(text.stderr).toContain("webhook: NOT delivered");
    expect(text.stderr).not.toContain("SECRET");

    const none = await run(process.execPath, [cli, "recheck", `${dir}records/c-junk.json`]).catch((e) => e);
    expect([none.code, none.stderr]).toEqual([1, expect.stringContaining("no accepted record to re-check")]);
  }, 60_000);
});
