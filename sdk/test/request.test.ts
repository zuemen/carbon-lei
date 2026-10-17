// Supplier data requests (sdk/request.ts): the importer's request, the supplier's answer built from it, and the
// importer's check of that answer with the same verifier as verify-batch. The proofs are verified offline against
// the recorded Sepolia answers (sdk/test/fixtures/sepolia-demo-rpc.json) with the real vLEI checkers, for the batch
// claimed on Sepolia, so the request and its answer are judged by the checks that judge any proof.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MINIMAL_VERIFIABLE_DISCLOSURE } from "../allocation.ts";
import { batchDocument, shipmentsFromBatch } from "../batch.ts";
import { ChainReader, type Deployment } from "../chain.ts";
import { COMMUNICATION_CLAIMS } from "../communication.ts";
import { RECONCILED_CLAIMS } from "../consistency.ts";
import { REQUIRED_DISCLOSURES, SUPPLIER_PRIVATE } from "../credential.ts";
import type { Presentation } from "../disclosure.ts";
import { present, type SignedCredential } from "../issue.ts";
import { buildPortfolio } from "../portfolio.ts";
import {
  answerFields,
  buildRequests,
  checkResponse,
  defaultRequestFields,
  lineCredentialProblems,
  matchResponse,
  parseRequest,
  requestedFields,
  responseCsv,
  responseExitCode,
  responseResults,
  type DataRequest,
  type RequestLine,
} from "../request.ts";
import type { Verdict } from "../verdict.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const replay = fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(`${root}${path}`, "utf8"));
const deployment = readJson("contracts/deployments/11155111.json") as Deployment;
const fixture = readJson("fixtures/sepolia-credential.json");
const cred = { ...fixture, core: JSON.parse(fixture.coreJson) } as SignedCredential;
const demoProof = readJson("fixtures/sepolia-demo-proof.json") as Presentation;
const tampered = readJson("fixtures/sepolia-demo-proof.tampered.json") as Presentation;
const evidence = { anchorEvidence: demoProof.anchorEvidence, authorityEvidence: demoProof.authorityEvidence, reportExtract: demoProof.reportExtract };
const loadBundle = (path: string) => readFileSync(`${root}demo/public/${path}`, "utf8");
const head = readJson("sdk/test/fixtures/sepolia-demo-rpc.json").answers['eth_getBlockByNumber ["latest",false]'].result;
const now = () => Number(BigInt(head.timestamp)) * 1000 + 5_000;
const EORI = "NLDEMO000000001";
const LEI = cred.claims.supplierLEI;
const OTHER_LEI = "ZZZZ00TWBOLTSDEMO277";
const BATCH = demoProof.shipment!.batchId;
const dir = `${root}.cache/request-test/`;
const env = { ...process.env, RPC_REPLAY: recording };

const line = (over: Partial<RequestLine> = {}): Partial<RequestLine> => ({
  supplierLEI: LEI,
  cnCode: "73181590",
  country: "TW",
  quantityTonnes: "200",
  reference: BATCH,
  dueDate: "2026-11-15",
  importDate: "2026-10-10",
  ...over,
});
const request = (lines: Partial<RequestLine>[] = [line()], extraFields?: string[]): DataRequest =>
  buildRequests(lines, { eori: EORI, importYear: 2026, ...(extraFields ? { extraFields } : {}), now: new Date(now()) })[0];
/** The supplier's answer to `r` for the batch claimed on Sepolia, with the evidence checks 6-8 read. */
const answer = (r: DataRequest, opts: { fields?: string[]; overDisclose?: boolean } = {}): Presentation => ({
  ...present(cred, answerFields(r, cred, opts), demoProof.shipment),
  ...evidence,
});
async function check(r: DataRequest, proofs: Presentation[]) {
  vi.stubGlobal("fetch", replayFetch(recording));
  return checkResponse(
    r,
    JSON.stringify(r),
    proofs.map((p, i) => ({ name: `p${i}.json`, text: JSON.stringify(p), loadBundle })),
    ChainReader.forSepolia(deployment),
    { now },
  );
}
const fail = (e: { code: number; stdout: string; stderr: string }) => e;

afterEach(() => vi.unstubAllGlobals());

describe("data request: what the importer asks for", () => {
  it("asks by default for the fields of checks 3-5, check 8 and the communication export, taken from the existing lists", () => {
    const { fields, why } = defaultRequestFields();
    expect(new Set(fields)).toEqual(new Set([...REQUIRED_DISCLOSURES, ...RECONCILED_CLAIMS, ...COMMUNICATION_CLAIMS]));
    expect(fields).toHaveLength(20);
    for (const f of MINIMAL_VERIFIABLE_DISCLOSURE) expect(fields).toContain(f);
    for (const f of SUPPLIER_PRIVATE) expect(fields).not.toContain(f);
    expect(why.installationName).toMatch(/COMMUNICATION_CLAIMS/);
    expect(why.nabName).toMatch(/RECONCILED_CLAIMS/);
    const r = request([line()], ["valueType", "verifierLEI"]);
    expect(r.fields.extra).toEqual(["valueType", "verifierLEI"]);
    expect(requestedFields(r)).toHaveLength(22);
    expect(r.requestId).toMatch(/^req-[0-9a-f]{32}$/);
    expect(r.notice).toMatch(/not a CBAM Registry message and not a function of the Commission's O3CI portal/);
  });

  it("refuses bad lines and fields, listing every problem; parseRequest refuses an edited request", () => {
    let err: unknown;
    try {
      buildRequests(
        [line({ country: "DE", reference: "B-1" }), line({ supplierLEI: "NOT-AN-LEI", reference: "B-2" }), line(), line(), line({ reference: "B-3", importDate: "2027-01-02" })],
        { eori: EORI, importYear: 2026, extraFields: ["productionRoute"] },
      );
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    expect(msg).toMatch(/field productionRoute is never disclosed to an importer/);
    expect(msg).toMatch(/line 1 .*Germany \(DE\) are not subject to CBAM/);
    expect(msg).toMatch(/line 2 \(B-2\): supplier LEI "NOT-AN-LEI" is not an LEI/);
    expect(msg).toMatch(/line 4 .*reference BATCH-DEMO-2026-0001 is used twice/);
    expect(msg).toMatch(/line 5 \(B-3\): import date 2027-01-02 is not in import year 2026/);

    const r = request();
    expect(parseRequest(JSON.parse(JSON.stringify(r)))).toEqual(r);
    const edited = structuredClone(r);
    edited.lines[0].supplierLEI = OTHER_LEI;
    edited.fields.required = edited.fields.required.filter((f) => f !== "idSalt");
    expect(() => parseRequest(edited)).toThrow(/must ask for idSalt.*differs from the request's supplier/s);
  });

  it("CLI: one request file per supplier LEI from a CSV of two suppliers; never overwrites", async () => {
    rmSync(dir, { recursive: true, force: true });
    const out = `${dir}requests/`;
    const csv = `${root}docs/examples/request-lines.csv`;
    const { stdout } = await run(process.execPath, [cli, "request", csv, "--eori", EORI, "--year", "2026", "--out", out, "--json"]);
    const listed = JSON.parse(stdout) as { file: string; requestId: string; lines: number }[];
    expect(readdirSync(out).sort()).toEqual([`request-${OTHER_LEI}.json`, `request-${LEI}.json`]);
    expect(listed.map((l) => l.lines)).toEqual([2, 1]);
    expect(new Set(listed.map((l) => l.requestId)).size).toBe(2);
    const a = parseRequest(JSON.parse(readFileSync(`${out}request-${LEI}.json`, "utf8")));
    const b = parseRequest(JSON.parse(readFileSync(`${out}request-${OTHER_LEI}.json`, "utf8")));
    expect(a.lines.map((l) => `${l.lineId}:${l.reference}`)).toEqual([`L1:${BATCH}`, "L2:BATCH-DEMO-2026-0004"]);
    expect([a.supplier.name, b.supplier.name, b.lines[0].cnCode]).toEqual(["Demo Fasteners Co. (fictional)", "Demo Bolt Works Ltd. (fictional)", "73181595"]);
    const before = readFileSync(`${out}request-${LEI}.json`, "utf8");
    const again = await run(process.execPath, [cli, "request", csv, "--eori", EORI, "--year", "2026", "--out", out]).then(() => null, fail);
    expect(again?.code).toBe(1);
    expect(again?.stderr).toMatch(/already exists; write the requests to a new folder \(nothing written\)/);
    expect(readFileSync(`${out}request-${LEI}.json`, "utf8")).toBe(before);
  }, 30_000);
});

describe("data request: the supplier's answer", () => {
  it("discloses exactly what was asked; refuses another supplier's request, a missing field, an unrequested or private field", () => {
    const r = request();
    expect(answerFields(r, cred)).toEqual(requestedFields(r));
    expect(() => answerFields(request([line({ supplierLEI: OTHER_LEI })]), cred)).toThrow(`the credential is for supplier ${LEI}, the request is addressed to ${OTHER_LEI}`);
    const { installationName: _, ...rest } = cred.disclosures;
    expect(() => answerFields(r, { ...cred, disclosures: rest })).toThrow(/no disclosure for installationName, which the request asks for: it cannot answer this request/);
    const more = [...requestedFields(r), "valueType"];
    expect(() => answerFields(r, cred, { fields: more })).toThrow(/--fields adds valueType, which the request does not ask for; .*--over-disclose/);
    expect(answerFields(r, cred, { fields: more, overDisclose: true })).toContain("valueType");
    expect(() => answerFields(r, cred, { fields: [...more, "supplierCost"], overDisclose: true })).toThrow(/supplierCost is supplier-private/);
    expect(lineCredentialProblems(request([line({ cnCode: "7208", country: "VN" })]).lines[0], cred)).toEqual([
      "line L1 asks for CN 7208; the credential is for CN 7318",
      "line L1 asks for origin VN; the credential's installation is in TW (UN/LOCODE TWKHH)",
    ]);
  });

  it("CLI present --request: LEI mismatch and a missing field are refused with nothing written; over-disclosure only with the flag", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}r-other.json`, JSON.stringify(request([line({ supplierLEI: OTHER_LEI })])));
    writeFileSync(`${dir}r.json`, JSON.stringify(request()));
    const { installationName: _, ...rest } = fixture.disclosures;
    writeFileSync(`${dir}cred-lacking.json`, JSON.stringify({ ...fixture, disclosures: rest }));
    const credFile = `${root}fixtures/sepolia-credential.json`;
    const args = (req: string, out: string, c = credFile) => [cli, "present", "--credential", c, "--request", req, "--importer-salt", demoProof.shipment!.importerSalt, "--out", out];

    const lei = await run(process.execPath, args(`${dir}r-other.json`, `${dir}a1.json`)).then(() => null, fail);
    expect(lei?.stderr).toContain(`the request is addressed to ${OTHER_LEI}`);
    const lacking = await run(process.execPath, args(`${dir}r.json`, `${dir}a2.json`, `${dir}cred-lacking.json`)).then(() => null, fail);
    expect(lacking?.stderr).toMatch(/no disclosure for installationName/);
    expect([existsSync(`${dir}a1.json`), existsSync(`${dir}a2.json`)]).toEqual([false, false]);

    const fields = [...requestedFields(request()), "valueType"].join(",");
    const over = await run(process.execPath, [...args(`${dir}r.json`, `${dir}a3.json`), "--fields", fields]).then(() => null, fail);
    expect(over?.stderr).toMatch(/--fields adds valueType/);
    const ok = await run(process.execPath, [...args(`${dir}r.json`, `${dir}a4.json`), "--fields", fields, "--over-disclose"]);
    expect(ok.stderr).toMatch(/answers line L1 \(batch BATCH-DEMO-2026-0001, 200 t\) of req-[0-9a-f]{32}: 21 fields \(more than requested: --over-disclose\)/);
    const p = JSON.parse(readFileSync(`${dir}a4.json`, "utf8")) as Presentation;
    expect([p.disclosures.length, p.shipment?.batchId, p.shipment?.shipmentDate]).toEqual([21, BATCH, "2026-10-10"]);
  }, 30_000);

  it("CLI present-batch --request: the requesting importer's requested batch only, with the requested fields; another EORI is refused", async () => {
    mkdirSync(dir, { recursive: true });
    const r = request([line(), line({ reference: "NOT-IN-BOOK-1", quantityTonnes: "5" })]);
    writeFileSync(`${dir}rb.json`, JSON.stringify(r));
    const book = `${root}docs/examples/allocation-book.json`;
    const out = `${dir}pack/`;
    rmSync(out, { recursive: true, force: true });
    const res = await run(process.execPath, [cli, "present-batch", book, "--request", `${dir}rb.json`, "--evidence-from", `${root}fixtures/sepolia-demo-proof.json`, "--out", out]);
    expect(res.stderr).toContain("warning: line L2 (NOT-IN-BOOK-1): no batch with this ID in the book; the importer will see it MISSING");
    const manifest = JSON.parse(readFileSync(`${out}share-pack.json`, "utf8"));
    expect(manifest.request).toEqual({ requestId: r.requestId, notInBook: [{ lineId: "L2", reference: "NOT-IN-BOOK-1", reason: "no batch with this ID in the book" }] });
    expect(manifest.proofs).toHaveLength(1);
    expect(manifest.proofs[0].fields).toEqual(requestedFields(r));

    writeFileSync(`${dir}rx.json`, JSON.stringify(buildRequests([line()], { eori: "FRDEMO000000009", importYear: 2026 })[0]));
    const other = await run(process.execPath, [cli, "present-batch", book, "--request", `${dir}rx.json`, "--out", `${dir}pack2/`]).then(() => null, fail);
    expect(other?.stderr).toMatch(/no importer in the allocation book has the request's EORI/);
    expect(existsSync(`${dir}pack2/`)).toBe(false);
  }, 30_000);
});

describe("data request: the importer checks the answer with the same verifier (recorded Sepolia answers)", () => {
  it("happy path: the answer verifies VALID, every requested field is disclosed, and the line feeds portfolio on the verified value", async () => {
    const r = request();
    const c = await check(r, [answer(r)]);
    expect(c.lines[0]).toMatchObject({ status: "ANSWERED", issues: [], overall: "VALID", provenTonnes: "200", usable: true });
    expect(c.pinnedBlock).toBe(Number(BigInt(head.number)));
    expect(responseExitCode(c)).toBe(0);
    const plan = buildPortfolio(shipmentsFromBatch(batchDocument(responseResults(c), { pinnedBlock: BigInt(c.pinnedBlock!), eori: EORI })), { year: 2026 });
    expect(plan.shipments[0]).toMatchObject({ id: "L1", basis: "actual", seeUsed: "1.8" });
  }, 30_000);

  it("over-disclosure is flagged (EXTRA_FIELDS, a warning); a requested field left out needs action", async () => {
    const r = request();
    const over = await check(r, [answer(r, { fields: [...requestedFields(r), "valueType", "verifierLEI"], overDisclose: true })]);
    expect(over.lines[0].status).toBe("ANSWERED");
    expect(over.lines[0].issues).toEqual([{ code: "EXTRA_FIELDS", severity: "warning", detail: "disclosed but not requested: valueType, verifierLEI", fields: ["valueType", "verifierLEI"] }]);
    expect(responseExitCode(over)).toBe(0);
    // The demo proof was not made for this request: it hides installationName and shows two fields not asked for.
    const demo = await check(r, [demoProof]);
    expect(demo.lines[0].status).toBe("NEEDS_ACTION");
    expect(demo.lines[0].issues.map((i) => `${i.code}:${i.fields?.join("+")}`)).toEqual(["FIELD_NOT_DISCLOSED:installationName", "EXTRA_FIELDS:valueType+verifierLEI"]);
    expect(responseExitCode(demo)).toBe(1);
  }, 30_000);

  it("quantity short: the ledger claim covers 200 t of the 250 t asked; portfolio plans that line on the default", async () => {
    const r = request([line({ quantityTonnes: "250" })]);
    const c = await check(r, [answer(r)]);
    expect(c.lines[0]).toMatchObject({ status: "NEEDS_ACTION", provenTonnes: "200", usable: true });
    expect(c.lines[0].issues.map((i) => i.code)).toEqual(["QUANTITY_SHORT"]);
    const plan = buildPortfolio(shipmentsFromBatch(batchDocument(responseResults(c), { eori: EORI })), { year: 2026 });
    expect(plan.shipments[0].basis).toBe("default");
  }, 30_000);

  it("a VALID proof of another supplier or CN code needs action and is not handed to portfolio", async () => {
    const r = request([line({ supplierLEI: OTHER_LEI, cnCode: "7208" })]);
    const c = await check(r, [answer(request())]);
    expect(c.lines[0].overall).toBe("VALID");
    expect(c.lines[0].issues.map((i) => i.code)).toEqual(["WRONG_SUPPLIER", "WRONG_CN"]);
    expect(c.lines[0].usable).toBe(false);
    const [res] = responseResults(c);
    expect([res.verdict, res.proof]).toEqual([null, null]);
    expect(res.line.note).toMatch(/NEEDS_ACTION WRONG_SUPPLIER, WRONG_CN; proof not used/);
  }, 30_000);

  it("a tampered response is NOT_VERIFIED; next to a good proof for the same line it is reported as a duplicate", async () => {
    const r = request();
    const bad = await check(r, [tampered]);
    expect(bad.lines[0]).toMatchObject({ status: "NOT_VERIFIED", overall: "INVALID", primaryCode: "DISCLOSURE_TAMPERED", usable: false });
    expect(responseExitCode(bad)).toBe(1);
    const both = await check(r, [tampered, answer(r)]);
    expect(both.lines[0]).toMatchObject({ status: "ANSWERED", proof: "p1.json" });
    expect(both.unmatched).toEqual([{ proof: "p0.json", batchId: BATCH, reason: "DUPLICATE", detail: "line L1 is answered by p1.json; this proof: INVALID (DISCLOSURE_TAMPERED)" }]);
    expect(responseCsv(both).split("\r\n")[2]).toMatch(/^,BATCH-DEMO-2026-0001,.*,DUPLICATE,/);
  }, 60_000);

  it("matching without a chain: missing and overdue, no shipment part, not requested, and an error exits 3", () => {
    const r = request([line(), line({ reference: "B-2", dueDate: "2026-10-01" })]);
    const valid = { overall: "VALID", primaryCode: "", checks: [{ id: 5, status: "pass" }], disclosed: {} } as unknown as Verdict;
    const c = matchResponse(
      r,
      [
        { name: "x.json", sha256: null, verdict: valid, error: null, shipment: null },
        { name: "y.json", sha256: null, verdict: valid, error: null, shipment: { batchId: "B-9", quantityTonnes: "1", shipmentDate: "2026-10-01" } },
        { name: "z.json", sha256: null, verdict: null, error: "rpc down", shipment: { batchId: BATCH, quantityTonnes: "200", shipmentDate: "2026-10-10" } },
      ],
      { requestSha256: "00", now: new Date("2026-10-17T00:00:00Z") },
    );
    expect(c.lines.map((l) => l.status)).toEqual(["ERROR", "MISSING"]);
    expect(c.lines[1].issues.map((i) => `${i.code}/${i.severity}`)).toEqual(["MISSING/action", "OVERDUE/info"]);
    expect(c.unmatched.map((u) => u.reason)).toEqual(["NO_SHIPMENT", "NOT_REQUESTED"]);
    expect(responseExitCode(c)).toBe(3);
  });

  it("CLI end to end: request from CSV, the answer, check-response (JSON, CSV, results), portfolio; the second supplier's request stays MISSING", async () => {
    const out = `${dir}e2e/`;
    rmSync(out, { recursive: true, force: true });
    await run(process.execPath, [cli, "request", `${root}docs/examples/request-lines.csv`, "--eori", EORI, "--year", "2026", "--out", out]);
    const reqA = `${out}request-${LEI}.json`;
    await run(process.execPath, [cli, "present", "--credential", `${root}fixtures/sepolia-credential.json`, "--request", reqA, "--line", "L1", "--importer-salt", demoProof.shipment!.importerSalt, "--evidence-from", `${root}fixtures/sepolia-demo-proof.json`, "--out", `${out}answer-L1.json`]);
    const checkA = await run(
      process.execPath,
      ["--import", replay, cli, "check-response", "--request", reqA, `${out}answer-L1.json`, "--csv", `${out}check.csv`, "--results", `${out}results.json`, "--json"],
      { env },
    ).then(() => null, fail);
    expect(checkA?.code).toBe(1); // L2 was never answered
    const doc = JSON.parse(checkA!.stdout);
    expect(doc.lines.map((l: { status: string }) => l.status)).toEqual(["ANSWERED", "MISSING"]);
    expect(readFileSync(`${out}check.csv`, "utf8").split("\r\n")[1]).toMatch(/^L1,BATCH-DEMO-2026-0001,ZZZZ00TWSCREWDEMO185,73181590,TW,200,200,2026-11-15,ANSWERED,,.*answer-L1\.json,VALID,$/);
    const results = JSON.parse(readFileSync(`${out}results.json`, "utf8"));
    expect([results.kind, results.results[0].proof, results.counts.VALID, results.counts.NO_PROOF]).toEqual(["carbonlei-batch", "answer-L1.json", 1, 1]);
    const plan = await run(process.execPath, [cli, "portfolio", `${out}results.json`, "--year", "2026", "--json"]);
    expect(JSON.parse(plan.stdout).shipments.map((s: { basis: string }) => s.basis)).toEqual(["actual", "default"]);

    const checkB = await run(process.execPath, ["--import", replay, cli, "check-response", "--request", `${out}request-${OTHER_LEI}.json`, `${out}answer-L1.json`], { env }).then(() => null, fail);
    expect(checkB?.code).toBe(1);
    expect(checkB?.stdout).toMatch(/MISSING +L1 +BOLT-2026-0042/);
    expect(checkB?.stdout).toMatch(/NOT_REQUESTED — batch BATCH-DEMO-2026-0001 is not a reference of request/);

    writeFileSync(`${out}broken.json`, "{}");
    const broken = await run(process.execPath, ["--import", replay, cli, "check-response", "--request", `${out}broken.json`, `${out}answer-L1.json`], { env }).then(() => null, fail);
    expect(broken?.code).toBe(3);
    expect(broken?.stderr).toMatch(/data request: schema must be "carbonlei-data-request"/);
  }, 90_000);
});
