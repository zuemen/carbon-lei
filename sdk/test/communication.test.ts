// `carbonlei export-communication` (sdk/communication.ts): the Summary_Communication fields of the Commission's
// communication template v2.1.1 that a verified proof fills, offline against the recorded Sepolia answers.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChainReader, type Deployment } from "../chain.ts";
import { decodeDisclosure, type Presentation } from "../disclosure.ts";
import { sha256Hex } from "../encoding.ts";
import { verdictFor, type Verdict } from "../verdict.ts";
import {
  COMMUNICATION_COLUMNS,
  COMMUNICATION_TEMPLATE,
  NOT_VALIDATED,
  SUMMARY_COMMUNICATION_FIELDS,
  communicationCsv,
  communicationRows,
} from "../communication.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const replay = fileURLToPath(new URL("./helpers/rpc-replay.ts", import.meta.url));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(`${root}${path}`, "utf8"));
const proofText = readFileSync(`${root}fixtures/sepolia-demo-proof.json`, "utf8");
const proof = JSON.parse(proofText) as Presentation;
const tampered = readJson("fixtures/sepolia-demo-proof.tampered.json") as Presentation;
const deployment = readJson("contracts/deployments/11155111.json") as Deployment;
const loadBundle = (path: string) => readFileSync(`${root}demo/public/${path}`, "utf8");
const head = readJson("sdk/test/fixtures/sepolia-demo-rpc.json").answers['eth_getBlockByNumber ["latest",false]'].result;
const now = () => Number(BigInt(head.timestamp)) * 1000 + 5_000;
const EORI = "NLDEMO000000001";
const dir = `${root}.cache/communication-test/`;

const verdict = (p: Presentation) => verdictFor(p, ChainReader.forSepolia(deployment), { importerEORI: EORI, loadBundle, now });
const row = (rows: ReturnType<typeof communicationRows>, cell: string) => rows.find((r) => r.cell === cell)!;

describe("Summary_Communication labels", () => {
  it("every label and cell is the cached text of the published v2.1.1 workbook (fixtures/cbam-template), in sheet order", async () => {
    const file = `${root}fixtures/cbam-template/CBAM_Communication_template_for_installations_en_20241213.xlsx`;
    const bytes = readFileSync(file);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(COMMUNICATION_TEMPLATE.sha256);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(COMMUNICATION_TEMPLATE.sheet)!;
    const text = (ref: string) => {
      const v = ws.getCell(ref).value as unknown;
      return typeof v === "object" && v !== null && "result" in v ? String((v as { result: unknown }).result) : String(v);
    };
    for (const f of SUMMARY_COMMUNICATION_FIELDS) expect([f.cell, text(f.cell)]).toEqual([f.cell, f.field]);
    // Version 2.1.1 of 13 December 2024 is listed on the workbook's version sheet.
    const versions = wb.getWorksheet("0_Versions")!;
    const listed: string[] = [];
    versions.eachRow((r) => listed.push(String(r.getCell("E").value ?? "")));
    expect(listed).toContain(COMMUNICATION_TEMPLATE.version);
    // Every product column header of row 25 between D and AZ is covered (merged continuation cells have no label).
    const covered = new Set(SUMMARY_COMMUNICATION_FIELDS.filter((f) => f.cell.endsWith("25")).map((f) => f.cell));
    const headers: string[] = [];
    ws.getRow(25).eachCell((c) => {
      const isMaster = !c.isMerged || c.master.address === c.address;
      if (Number(c.col) >= 4 && Number(c.col) <= 52 && c.text.trim() && isMaster) headers.push(c.address);
    });
    expect(headers).toEqual([...covered]);
  }, 60_000);
});

describe("export-communication on the demo proof (recorded Sepolia answers)", () => {
  afterEach(() => vi.unstubAllGlobals());
  let v: Verdict;
  beforeAll(async () => {
    vi.stubGlobal("fetch", replayFetch(recording));
    v = await verdict(proof);
    vi.unstubAllGlobals();
  }, 30_000);

  it("maps the verified fields per REGISTRY_EXPORT §4; the hidden installation name is marked, the rest is blank and not held", () => {
    expect(v.overall).toBe("VALID");
    const rows = communicationRows(v);
    expect(rows.map((r) => r.cell)).toEqual(SUMMARY_COMMUNICATION_FIELDS.map((f) => f.cell));
    const filled = rows.filter((r) => r.status === "from verified proof").map((r) => [r.cell, r.value]);
    expect(filled).toEqual([
      ["D16", "TW"],
      ["D17", "TWKHH"],
      ["D20", "2026-01-01"],
      ["D21", "2026-12-31"],
      ["F25", "7318"],
      ["I25", "1.8"],
      ["L25", "tCO2e/t"],
    ]);
    expect(row(rows, "D12")).toMatchObject({ value: "", status: "hidden by supplier", source: "signed field installationName, not disclosed in this proof" });
    expect(row(rows, "F25").source).toMatch(/4-digit heading.*8-digit CN codes/);
    expect(row(rows, "I25").source).toMatch(/^signed field specificEmbeddedEmissions_tCO2e_per_t, direct embedded emissions \(verified: check 2\)$/);
    for (const cell of ["D13", "D15", "D18", "J11", "AA15", "J25", "K25", "M25", "O25", "R25", "AM25", "AR25", "AZ25"]) {
      expect(row(rows, cell)).toMatchObject({ value: "", status: "not held" });
    }
    expect(row(rows, "AM25").source).toMatch(/no carbon price statement/);
    expect(rows.filter((r) => r.status === "not held").every((r) => r.value === "")).toBe(true);
  });

  it("the CSV: template version, the not-validated note, proof SHA-256 and pinned block, then the rows in template order", () => {
    const csv = communicationCsv(v, sha256Hex(proofText));
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("v2.1.1 (2024-12-13), sheet Summary_Communication");
    expect(lines[1]).toBe(`"# ${NOT_VALIDATED}"`);
    expect(NOT_VALIDATED).toBe("not validated by the Commission; a copy for the declarant's records, not a Registry submission");
    expect(lines[2]).toContain(`proof SHA-256 ${sha256Hex(proofText)}`);
    expect(lines[2]).toContain(`pinned block ${Number(BigInt(head.number))}`);
    expect(SUMMARY_COMMUNICATION_FIELDS.length).toBe(76);
    expect(lines[3]).toBe('"# 76 fields: 7 from the verified proof, 1 hidden by the supplier, 68 not held (blank)"');
    expect(lines[4]).toBe(COMMUNICATION_COLUMNS.join(","));
    expect(lines[5]).toBe('Name of the installation (English name):,,"signed field installationName, not disclosed in this proof",hidden by supplier,Summary_Communication!D12');
    expect(csv).toContain('SEE (direct),1.8,');
    // The label with a line break stays one quoted field.
    expect(csv).toContain('"Product name \n(used for communication with reporting declarant, e.g. on invoices)",,');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("a carbon price certified for this good fills the §4.3 fields; one for a precursor does not", () => {
    const cp = {
      draft: "Draft implementing act, not adopted — illustrative",
      target: { kind: "good", credSAID: v.credSAID, cnCode: "7318", massPerTonne: "1", seeCap: "1.8" },
      mechanism: "carbon fee",
      currency: "TWD",
      localPerTonne: "540",
      paidShare: "0.8",
      coveredEmissionsPerTonne: "1.44",
    } as unknown as NonNullable<Verdict["carbonPrice"]>;
    const withCp = (c: typeof cp, status: "pass" | "warn" = "pass"): Verdict => ({
      ...v,
      checks: [...v.checks, { id: 10, name: "Carbon price", status, code: "", detail: "" }],
      carbonPrice: c,
    });
    const rows = communicationRows(withCp(cp));
    expect(["AM25", "AN25", "AO25", "AQ25", "AR25"].map((c) => row(rows, c).value)).toEqual(["carbon fee", "0.8", "1.44", "TWD", "540"]);
    expect(row(rows, "AR25").source).toContain("Draft implementing act, not adopted");
    expect(row(rows, "AX25").status).toBe("not held");
    const pre = communicationRows(withCp({ ...cp, target: { ...cp.target!, kind: "precursor", line: 0 } }));
    expect(row(pre, "AM25")).toMatchObject({ value: "", status: "not held" });
    expect(row(pre, "AM25").source).toMatch(/for a precursor/);
    expect(row(communicationRows(withCp(cp, "warn")), "AM25").status).toBe("not held");
  });
});

describe("export-communication refuses what did not verify", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the tampered proof is INVALID: nothing exported", async () => {
    vi.stubGlobal("fetch", replayFetch(recording));
    const v = await verdict(tampered);
    expect(v.overall).toBe("INVALID");
    expect(() => communicationRows(v)).toThrow(/did not verify \(INVALID, DISCLOSURE_TAMPERED\); nothing exported/);
    expect(() => communicationCsv(v, "x")).toThrow(/nothing exported/);
  }, 30_000);

  it("a VALID result without check 5 (no EORI), or with no pinned block, is not exported either", async () => {
    vi.stubGlobal("fetch", replayFetch(recording));
    const v = await verdict(proof);
    const skip5: Verdict = { ...v, checks: v.checks.map((c) => (c.id === 5 ? { ...c, status: "skipped" as const } : c)) };
    expect(() => communicationRows(skip5)).toThrow(/check 5 did not bind the shipment to your EORI \(skipped\); nothing exported/);
    expect(() => communicationRows({ ...v, chain: { chainId: 11155111, block: null } })).toThrow(/no pinned block; nothing exported/);
    for (const overall of ["CONTESTED", "INCOMPLETE"] as const) expect(() => communicationRows({ ...v, overall })).toThrow(`did not verify (${overall}); nothing exported`);
  }, 30_000);

  it("a proof that withholds the UN/LOCODE: Country and UNLOCODE are marked hidden by supplier and the value appears nowhere", async () => {
    vi.stubGlobal("fetch", replayFetch(recording));
    const name = (d: string) => decodeDisclosure(d).name;
    const withheld = { ...proof, disclosures: proof.disclosures.filter((d) => name(d) !== "unLocode") };
    expect(withheld.disclosures.length).toBe(proof.disclosures.length - 1);
    const v = await verdict(withheld);
    expect(v.overall).toBe("VALID");
    const rows = communicationRows(v);
    for (const cell of ["D16", "D17"]) {
      expect(row(rows, cell)).toMatchObject({ value: "", status: "hidden by supplier", source: "signed field unLocode, not disclosed in this proof" });
    }
    expect(row(rows, "I25")).toMatchObject({ value: "1.8", status: "from verified proof" });
    const csv = communicationCsv(v, sha256Hex(JSON.stringify(withheld)));
    expect(csv).not.toContain("TWKHH");
    expect(csv).not.toMatch(/,TW,/);
    expect(csv).toContain("5 from the verified proof, 3 hidden by the supplier");
  }, 30_000);

  it("a proof that withholds the emissions value is INCOMPLETE (check 8 cannot reconcile): nothing exported", async () => {
    vi.stubGlobal("fetch", replayFetch(recording));
    const withheld = { ...proof, disclosures: proof.disclosures.filter((d) => decodeDisclosure(d).name !== "specificEmbeddedEmissions_tCO2e_per_t") };
    const v = await verdict(withheld);
    expect(v.overall).toBe("INCOMPLETE");
    expect(() => communicationRows(v)).toThrow(/did not verify \(INCOMPLETE\); nothing exported/);
  }, 30_000);
});

describe("carbonlei export-communication (CLI, recorded Sepolia answers)", () => {
  const env = { ...process.env, RPC_REPLAY: recording };
  it("writes the CSV for the demo proof; for the tampered proof exits 1 and writes nothing", async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const out = `${dir}communication.csv`;
    const ok = await run(process.execPath, ["--import", replay, cli, "export-communication", `${root}fixtures/sepolia-demo-proof.json`, "--eori", EORI, "--out", out], { env });
    expect(ok.stderr).toContain(`wrote ${out} (VALID at block`);
    const csv = readFileSync(out, "utf8");
    expect(csv.split("\r\n")[2]).toContain(`proof SHA-256 ${sha256Hex(proofText)}`);
    expect(csv).toContain("UNLOCODE:,TWKHH,");

    const bad = `${dir}tampered.csv`;
    const r = await run(process.execPath, ["--import", replay, cli, "export-communication", `${root}fixtures/sepolia-demo-proof.tampered.json`, "--eori", EORI, "--out", bad], { env }).catch((e) => e);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/did not verify \(INVALID, DISCLOSURE_TAMPERED\); nothing exported/);
    expect(existsSync(bad)).toBe(false);

    const noEori = await run(process.execPath, ["--import", replay, cli, "export-communication", `${root}fixtures/sepolia-demo-proof.json`], { env }).catch((e) => e);
    expect([noEori.code, noEori.stdout]).toEqual([1, ""]);
    expect(noEori.stderr).toContain("needs --eori");
  }, 60_000);
});
