// Every disclosure preset and allocation-book entry shipped in the repo must give a proof the buyer's verifier
// returns VALID. Since the credential core commits to a signed reconciliation, hiding a field check 8 reconciles
// leaves check 8 undecided (INCOMPLETE): a "minimal" preset that hides one is a preset that never verifies.
// The proofs are verified offline against the recorded Sepolia answers (sdk/test/fixtures/sepolia-demo-rpc.json),
// for the batch claimed on Sepolia, so only the field selection differs between the cases.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSharePack, DISCLOSURE_PRESETS, fieldsFor, parseBook, type AllocationBook } from "../allocation.ts";
import { ChainReader } from "../chain.ts";
import { vleiCheckers } from "../checkers.ts";
import { check8HiddenFields, RECONCILED_CLAIMS } from "../consistency.ts";
import { REQUIRED_DISCLOSURES } from "../credential.ts";
import type { Presentation } from "../disclosure.ts";
import type { SignedCredential } from "../issue.ts";
import { verifyPresentation } from "../verify.ts";
import { replayFetch } from "./helpers/rpc-replay.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const deployment = JSON.parse(read("contracts/deployments/11155111.json"));
const fixture = JSON.parse(read("fixtures/sepolia-credential.json"));
const cred = { ...fixture, core: JSON.parse(fixture.coreJson) } as SignedCredential;
const demoProof = JSON.parse(read("fixtures/sepolia-demo-proof.json")) as Presentation;
const exampleBook = parseBook(JSON.parse(read("docs/examples/allocation-book.json")));
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const head = JSON.parse(read("sdk/test/fixtures/sepolia-demo-rpc.json")).answers['eth_getBlockByNumber ["latest",false]'].result;
const now = () => Number(BigInt(head.timestamp)) * 1000 + 5_000;
const loadBundle = async (p: string) => read(`demo/public/${p}`);
const evidence = { anchorEvidence: demoProof.anchorEvidence, authorityEvidence: demoProof.authorityEvidence, reportExtract: demoProof.reportExtract };
const claimed = exampleBook.batches.find((b) => b.status === "claimed")!;
const claimedEori = exampleBook.importers.find((i) => i.id === claimed.importer)!.eori;

/** The proof of the batch claimed on Sepolia, disclosing `fields` (as the share pack builds it). */
function proofWith(fields: readonly string[]): Presentation {
  const book: AllocationBook = {
    ...exampleBook,
    importers: exampleBook.importers.map((i) => (i.id === claimed.importer ? { ...i, fields: [...fields] } : i)),
    batches: [claimed],
  };
  return buildSharePack(cred, book, { evidence, allowIncomplete: true }).proofs[0].proof;
}

async function overall(fields: readonly string[]) {
  vi.stubGlobal("fetch", replayFetch(recording));
  const r = await verifyPresentation(proofWith(fields), ChainReader.forSepolia(deployment), {
    importerEORI: claimedEori,
    now,
    checkers: vleiCheckers({ loadBundle }),
  });
  return r.overall;
}

afterEach(() => vi.unstubAllGlobals());

describe("disclosure presets and the example allocation book verify VALID", () => {
  it("the credential commits to a signed reconciliation (so check 8 must be decided)", () => {
    expect(cred.core.reconciliation).toBeDefined();
  });

  for (const [name, fields] of Object.entries(DISCLOSURE_PRESETS)) {
    it(`preset "${name}" (${fields.length} fields) hides no field check 8 needs and verifies VALID`, async () => {
      expect(await overall(fields)).toBe("VALID");
      expect(check8HiddenFields(cred.core, fields)).toEqual([]);
    }, 30_000);
  }

  for (const im of exampleBook.importers) {
    it(`docs/examples/allocation-book.json buyer ${im.id} verifies VALID`, async () => {
      const fields = fieldsFor(exampleBook, { ...claimed, importer: im.id });
      expect(await overall(fields)).toBe("VALID");
      expect(check8HiddenFields(cred.core, fields)).toEqual([]);
    }, 30_000);
  }

  it("the minimal preset is exactly the required fields plus the reconciled ones (nothing else disclosed)", () => {
    expect(new Set(DISCLOSURE_PRESETS.minimal)).toEqual(new Set([...REQUIRED_DISCLOSURES, ...RECONCILED_CLAIMS]));
    expect(DISCLOSURE_PRESETS.minimal).toHaveLength(18);
  });

  it("hiding one reconciled field (accreditation body) gives INCOMPLETE, and check8HiddenFields names it", async () => {
    const fields = DISCLOSURE_PRESETS.minimal.filter((f) => f !== "nabName");
    expect(check8HiddenFields(cred.core, fields)).toEqual(["nabName"]);
    expect(await overall(fields)).toBe("INCOMPLETE");
  }, 30_000);

  it("a credential without a signed reconciliation has no check 8 requirement", () => {
    expect(check8HiddenFields({}, [...REQUIRED_DISCLOSURES])).toEqual([]);
  });
});

describe("CLI: present and present-batch refuse a proof that would verify INCOMPLETE, unless --allow-incomplete", () => {
  const run = promisify(execFile);
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const dir = fileURLToPath(new URL("../../.cache/disclosure-presets/", import.meta.url));
  const credFile = fileURLToPath(new URL("../../fixtures/sepolia-credential.json", import.meta.url));
  const fail = (e: { code: number; stdout: string; stderr: string }) => e;

  it("present-batch skips the batch, names the hidden fields; with --allow-incomplete writes it and warns", async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const book = structuredClone(JSON.parse(read("docs/examples/allocation-book.json")));
    delete book.credential;
    book.importers[0].fields = [...REQUIRED_DISCLOSURES, "specificEmbeddedEmissions_tCO2e_per_t"];
    writeFileSync(`${dir}book.json`, JSON.stringify(book));
    const refused = await run(process.execPath, [cli, "present-batch", `${dir}book.json`, "--credential", credFile, "--out", `${dir}a/`]).then(() => null, fail);
    expect(refused?.code).toBe(1);
    expect(refused?.stdout).toMatch(/skipped BATCH-DEMO-2026-0001 — hides accreditationNumber, nabName, .*Not verified \(INCOMPLETE\)/);
    expect(refused?.stdout).toContain("0 proof(s)");

    const allowed = await run(process.execPath, [cli, "present-batch", `${dir}book.json`, "--credential", credFile, "--out", `${dir}b/`, "--allow-incomplete"]);
    expect(allowed.stdout).toContain("1 proof(s)");
    expect(allowed.stderr).toMatch(/warning: demo-imports--BATCH-DEMO-2026-0001--.*\.proof\.json hides accreditationNumber, .*Not verified \(INCOMPLETE\)/);
    expect(readdirSync(`${dir}b/`)).toHaveLength(2);

    // The example book as shipped: every claimed batch is written, no warning.
    const ok = await run(process.execPath, [cli, "present-batch", fileURLToPath(new URL("../../docs/examples/allocation-book.json", import.meta.url)), "--out", `${dir}c/`]);
    expect(ok.stdout).toContain("1 proof(s)");
    expect(ok.stderr).not.toContain("INCOMPLETE");
  }, 30_000);

  it("present --fields hiding a reconciled field exits with an error; --allow-incomplete writes the proof and warns", async () => {
    mkdirSync(dir, { recursive: true });
    const fields = DISCLOSURE_PRESETS.minimal.filter((f) => f !== "siteVisit").join(",");
    const refused = await run(process.execPath, [cli, "present", "--credential", credFile, "--fields", fields, "--out", `${dir}p1.json`]).then(() => null, fail);
    expect(refused?.code).not.toBe(0);
    expect(refused?.stderr).toMatch(/hides siteVisit, which check 8 needs .*Not verified \(INCOMPLETE\); add the fields to --fields or pass --allow-incomplete/);
    expect(existsSync(`${dir}p1.json`)).toBe(false);
    const allowed = await run(process.execPath, [cli, "present", "--credential", credFile, "--fields", fields, "--out", `${dir}p2.json`, "--allow-incomplete"]);
    expect(allowed.stderr).toMatch(/warning: the proof hides siteVisit/);
    expect(JSON.parse(readFileSync(`${dir}p2.json`, "utf8")).disclosures).toHaveLength(17);
    const minimal = await run(process.execPath, [cli, "present", "--credential", credFile, "--fields", DISCLOSURE_PRESETS.minimal.join(","), "--out", `${dir}p3.json`]);
    expect(minimal.stderr).toBe("");
  }, 30_000);
});
