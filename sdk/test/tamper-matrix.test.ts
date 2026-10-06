// Tamper matrix: every attack below is run once against a local anvil chain, and the row
// records which layer stopped it and with which code. Layers: browser checks 0-3 (no chain),
// on-chain comparison checks 4-5, and contract reverts (dry run or mined transaction).
// Baseline: an importer who only reads the PDF report detects none of them (0 of N).
// The result is written to .cache/tamper-matrix.json.
// The same chain also runs the valid-variant matrix (inputs that are correct by design and must be
// VALID) and the contested matrix (must be CONTESTED, not INVALID); the confusion matrix of all three
// classes is written to .cache/accuracy-matrix.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeErrorResult, keccak256, stringToBytes, type Hex as ViemHex, type LocalAccount } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emissionsClaimRegistryAbi } from "../abi.ts";
import { ChainReader } from "../chain.ts";
import {
  auditorAidHashOf,
  credScopeKeyOf,
  hashString,
  leiHashOf,
  reportKeyOf,
  reportScopeKeyOf,
  supplierCommitOf,
} from "../commitment.ts";
import {
  DISCLOSABLE,
  isoToSeconds,
  METHODOLOGY_NOTE,
  REQUIRED_DISCLOSURES,
  tonnesToKg,
  type CredentialClaims,
  type Hex,
} from "../credential.ts";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../disclosure.ts";
import { signCredential } from "../eip712.ts";
import {
  claimArgsOf,
  DEMO_DISCLOSURE,
  issueCredential,
  present,
  reportInputOf,
  type SignedCredential,
} from "../issue.ts";
import { verifyPresentation, type CheckResult, type VerificationResult, type VerifyOptions } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const OUT = new URL("../../.cache/tamper-matrix.json", import.meta.url);
const ACCURACY_OUT = new URL("../../.cache/accuracy-matrix.json", import.meta.url);
const salt = (s: string): Hex => keccak256(stringToBytes(`tm:${s}`));

const AUDITOR_AID = "EDemoAuditorAidForTamperMatrixTests000000000";
const AUDITOR_AID_REVOKED = "EDemoAuditorAidRevokedBeforeRegistration0000";
// Second accredited body (fictional; ZZZZ prefix is never assigned by an LEI issuer).
const OTHER_BODY_LEI = "ZZZZ00EUSECONDBODY42";
const OTHER_BODY_AUDITOR_AID = "EDemoAuditorAidOfTheSecondVerificationBody00";
const EORI_1 = demo.entities.importers[0].eori as string;
const EORI_2 = demo.entities.importers[1].eori as string;
const PERIOD = demo.reports[0].reportingPeriod as string;
const BODY_LEI = demo.entities.verifier.lei as string;

/** Fictional installation IDs of the demo supplier; each registered case gets its own scope. */
const inst = (n: number) => `TW-ZZZZ00TWSCREWDEMO185-${String(n).padStart(4, "0")}`;

function claims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: inst(1),
    installationName: "Demo Fasteners Plant (fictional)",
    unLocode: s.unLocode,
    cnCode: "7318",
    cbamRoute: "C",
    productionRoute: "BF-BOF wire rod (illustrative)",
    reportingPeriod: PERIOD,
    verifiedTonnes: "500",
    specificEmbeddedEmissions_tCO2e_per_t: "1.8",
    valueType: "actual",
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: "VR-DEMO-0001",
    verifierLEI: BODY_LEI,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: salt("id"),
    batchSalt: salt("batch"),
    issuedAt: "2026-10-01T00:00:00Z",
    validUntil: "2027-12-31T00:00:00Z",
    ...over,
  };
}

let c: LocalChain;
let registry: Hex;
let cred: SignedCredential;
let proof: Presentation;
const shipment = {
  batchId: "BATCH-DEMO-2026-0001",
  quantityTonnes: "200",
  shipmentDate: "2026-10-10",
  importerSalt: salt("imp"),
};

async function issue(over: Partial<CredentialClaims> = {}, auditorAID = AUDITOR_AID) {
  return issueCredential({ claims: claims(over), auditorAID, signer: c.verifier, registry, chainId: 31337 });
}

/** A fresh credential of the demo supplier on its own installation (own report and credential scope). */
const fresh = (n: number, over: Partial<CredentialClaims> = {}, auditorAID = AUDITOR_AID) =>
  issue({ installationId: inst(n), verificationReportId: `VR-TAMPER-${String(n).padStart(4, "0")}`, ...over }, auditorAID);

const inputOf = (cr: SignedCredential) => reportInputOf(cr, { supplier: c.supplier.address, kelSeq: 1n });

// ------------------------------------------------------------------ matrix bookkeeping

interface Observed {
  layer: string;
  code: string;
}

const CHECK_NAMES = ["Structure", "Credential integrity (SAID)", "Disclosed fields", "Issuer signature", "On-chain report", "Shipment claim"];
const NOT_CAUGHT: Observed = { layer: "none", code: "" };
const checkLayer = (i: number) => `${i <= 3 ? "browser" : "on-chain"} (check ${i}: ${CHECK_NAMES[i]})`;
const contractLayer = (fn: string, mode: "dry run" | "transaction") => `contract revert (${fn}, ${mode})`;
const caughtBy = (i: number, code: string): Observed => ({ layer: checkLayer(i), code });
const revertedIn = (fn: string, mode: "dry run" | "transaction", errorName: string): Observed => ({
  layer: contractLayer(fn, mode),
  code: errorName,
});

const declared: string[] = [];
const rows: (Observed & { case: string; detected: boolean })[] = [];

/** Defines one row: runs the attack, records what stopped it, and asserts layer and code. */
function tamperCase(name: string, expected: Observed, attack: () => Promise<Observed>) {
  declared.push(name);
  it(name, async () => {
    let got: Observed;
    try {
      got = await attack();
    } catch (e) {
      rows.push({ case: name, layer: "error", code: String((e as Error).message).slice(0, 160), detected: false });
      throw e;
    }
    rows.push({ case: name, ...got, detected: got.layer === expected.layer && got.code === expected.code });
    expect(got).toEqual(expected);
  }, 60_000);
}

/** First failing check among 0-5 (checks 6-7 always fail here: no vLEI evidence is attached). */
function firstCatch(checks: CheckResult[]): Observed {
  const f = checks.find((x) => x.index <= 5 && x.status === "fail");
  return f ? caughtBy(f.index, f.code) : NOT_CAUGHT;
}

/**
 * Verifies with the time-window event search (tolerance 0, so every bound is searched as tightly as
 * it can be) and with the full scan from the deployment block; both results must be identical.
 */
async function verifyBothWays(p: Presentation, opts: VerifyOptions = {}): Promise<VerificationResult> {
  const windowed = await verifyPresentation(p, new ChainReader(c.pub, c.deployment, undefined, { searchTolerance: 0n }), opts);
  const full = await verifyPresentation(p, new ChainReader(c.pub, c.deployment, undefined, { fullEventScan: true }), opts);
  expect(windowed).toEqual(full);
  return windowed;
}

async function viaVerify(p: Presentation, opts: VerifyOptions = {}): Promise<Observed> {
  return firstCatch((await verifyBothWays(p, opts)).checks);
}

async function viaDryRun(
  fn: "registerReport" | "claimShipment",
  args: readonly unknown[],
  from: Hex,
): Promise<Observed> {
  const d = await c.reader.dryRun(fn, args, from);
  return d.reverted ? revertedIn(fn, "dry run", d.errorName) : NOT_CAUGHT;
}

function replaceDisclosure(p: Presentation, name: string, value: string): Presentation {
  const i = p.disclosures.findIndex((d) => decodeDisclosure(d).name === name);
  if (i < 0) throw new Error(`no disclosure ${name}`);
  const disclosures = [...p.disclosures];
  disclosures[i] = encodeDisclosure({ ...decodeDisclosure(p.disclosures[i]), value });
  return { ...p, disclosures };
}

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  c = await startLocalChain(20545 + Math.floor(Math.random() * 1000));
  registry = c.deployment.contracts.EmissionsClaimRegistry.address;
  const lei = leiHashOf(BODY_LEI);
  await send(c, c.owner, "allowlist", "addVerifier", [
    {
      leiHash: lei,
      verifier: c.verifier.address,
      leCredSaidHash: hashString("LE-SAID"),
      accreditationSaidHash: hashString("ACC-SAID"),
      accreditedUntil: 1924905600n,
    },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [
    { auditorAidHash: auditorAidHashOf(AUDITOR_AID), leiHash: lei, ecrSaidHash: hashString("ECR-SAID") },
  ]);
  // Second accredited body, bound to the `other` account, with its own auditor.
  const otherLei = leiHashOf(OTHER_BODY_LEI);
  await send(c, c.owner, "allowlist", "addVerifier", [
    {
      leiHash: otherLei,
      verifier: c.other.address,
      leCredSaidHash: hashString("LE-SAID-2"),
      accreditationSaidHash: hashString("ACC-SAID-2"),
      accreditedUntil: 1924905600n,
    },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [
    { auditorAidHash: auditorAidHashOf(OTHER_BODY_AUDITOR_AID), leiHash: otherLei, ecrSaidHash: hashString("ECR-SAID-2") },
  ]);

  // Genuine credential: 500 t at 1.8 tCO2e/t, registered, 200 t claimed for importer 1.
  cred = await issue();
  await send(c, c.verifier, "registry", "registerReport", [inputOf(cred)]);
  await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cred, { ...shipment, importerEORI: EORI_1 }));
  proof = present(cred, DEMO_DISCLOSURE, shipment);
}, 120_000);

afterAll(() => c?.stop());

// ------------------------------------------------------------------ valid-variant and contested matrix
// The other side of the confusion matrix: inputs that are correct by design, on the same local
// chain. Each must come out VALID on checks 0-5 (with every contract call accepted); the CONTESTED
// rows must be flagged, neither accepted nor rejected. Checks 6-8 need vLEI evidence and have their
// own tests, as for the tamper rows. These rows run first and use their own installations, so the
// tamper rows below see the same state as before (the chain clock is about six weeks later).

type Verdict = "VALID" | "CONTESTED" | "INVALID";
interface Judged {
  verdict: Verdict;
  code: string;
}

const variantRows: { class: "valid" | "contested"; case: string; verdict: Verdict | "error"; code: string }[] = [];
const declaredVariants: { class: "valid" | "contested"; case: string }[] = [];

/** Verdict on checks 0-5: a failure is INVALID, check 4's CONTESTED flag is CONTESTED, otherwise VALID. */
function judge(r: VerificationResult): Judged {
  const f = r.checks.find((x) => x.index <= 5 && x.status === "fail");
  if (f) return { verdict: "INVALID", code: f.code };
  return r.checks[4]?.code === "CONTESTED" ? { verdict: "CONTESTED", code: "CONTESTED" } : { verdict: "VALID", code: "" };
}

/** Verifies a proof; when it carries a shipment and an EORI is given, check 5 must really run and pass. */
async function judgeProof(p: Presentation, opts: VerifyOptions = {}): Promise<Judged & { result: VerificationResult }> {
  const result = await verifyBothWays(p, opts);
  const j = judge(result);
  if (p.shipment && opts.importerEORI && j.verdict !== "INVALID") expect(result.checks[5].status).toBe("pass");
  return { ...j, result };
}

function variantCase(cls: "valid" | "contested", name: string, run: () => Promise<Judged>) {
  const expected: Verdict = cls === "valid" ? "VALID" : "CONTESTED";
  declaredVariants.push({ class: cls, case: name });
  it(name, async () => {
    let got: Judged;
    try {
      got = await run();
    } catch (e) {
      variantRows.push({ class: cls, case: name, verdict: "error", code: String((e as Error).message).slice(0, 160) });
      throw e;
    }
    variantRows.push({ class: cls, case: name, verdict: got.verdict, code: got.code });
    expect(got.verdict).toBe(expected);
  }, 60_000);
}
const validCase = (name: string, run: () => Promise<Judged>) => variantCase("valid", name, run);
const contestedCase = (name: string, run: () => Promise<Judged>) => variantCase("contested", name, run);

const EORI_3 = "FRDEMO000000003"; // fictional third importer
const SUPPLIER2_LEI = "ZZZZ00TWBOLTDEMOAB27"; // fictional second supplier (ZZZZ prefix)
const THIRD_BODY_LEI = "ZZZZ00EUTHIRDBODY043"; // fictional third accredited body
const AUDITOR_LATE = "EDemoAuditorAidRevokedAfterTheWindow00000000";
const AUDITOR_C1 = "EDemoAuditorAidContestedOneHour0000000000000";
const AUDITOR_C2 = "EDemoAuditorAidContestedWindowEdge0000000000";
const AUDITOR_C4 = "EDemoAuditorAidContestedWithShipment00000000";
const AUDITOR_B3 = "EDemoAuditorAidOfTheThirdVerificationBody000";
const DAY = 24n * 3600n;

/** A fresh credential for the valid-variant rows, on its own installation and report ID. */
const vfresh = (n: number, over: Partial<CredentialClaims> = {}, auditorAID = AUDITOR_AID) =>
  issue({ installationId: inst(n), verificationReportId: `VR-VALID-${String(n).padStart(4, "0")}`, ...over }, auditorAID);

async function issueBy(signer: LocalAccount, verifierLEI: string, auditorAID: string, over: Partial<CredentialClaims>) {
  return issueCredential({ claims: claims({ verifierLEI, ...over }), auditorAID, signer, registry, chainId: 31337 });
}

/** Registers a credential (the transaction must succeed) and returns its registeredAt. */
async function register(
  cr: SignedCredential,
  o: { from?: PrivateKeyAccount; supersedes?: Hex; supplier?: PrivateKeyAccount } = {},
) {
  const input = reportInputOf(cr, { supplier: (o.supplier ?? c.supplier).address, kelSeq: 1n, supersedes: o.supersedes });
  await send(c, o.from ?? c.verifier, "registry", "registerReport", [input]);
  return (await c.reader.report(reportKeyOf(cr.core.d))).registeredAt;
}

const shipPart = (batchId: string, quantityTonnes: string, tag: string) => ({
  batchId,
  quantityTonnes,
  shipmentDate: "2026-10-20",
  importerSalt: salt(`v:${tag}`),
});

async function claim(
  cr: SignedCredential,
  part: ReturnType<typeof shipPart>,
  importerEORI: string,
  from: PrivateKeyAccount = c.supplier,
) {
  await send(c, from, "registry", "claimShipment", claimArgsOf(cr, { ...part, importerEORI }));
}

async function newAccount(tag: string) {
  const a = privateKeyToAccount(salt(`account:${tag}`));
  await c.test.setBalance({ address: a.address, value: 10n ** 20n });
  return a;
}

async function addAuditor(aid: string, lei = BODY_LEI) {
  await send(c, c.owner, "allowlist", "addAuditor", [
    { auditorAidHash: auditorAidHashOf(aid), leiHash: leiHashOf(lei), ecrSaidHash: hashString(`ECR-${aid}`) },
  ]);
}

async function revokeAt(aid: string, timestamp: bigint) {
  await c.test.setNextBlockTimestamp({ timestamp });
  await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(aid), leiHashOf(BODY_LEI)]);
}

describe("valid-variant matrix on a local chain (each must be VALID)", () => {
  let f1: SignedCredential;
  let s1: ReturnType<typeof shipPart>;
  const f1Proof = (names: readonly string[]) => present(f1, names, s1);

  // ---- disclosure choices of the supplier (one credential, 200 t claimed for importer 1)

  validCase("V01 demo disclosure (21 fields) with a shipment, checked by its importer", async () => {
    f1 = await vfresh(201);
    await register(f1);
    s1 = shipPart("BATCH-VALID-0201-A", "200", "v01");
    await claim(f1, s1, EORI_1);
    return judgeProof(f1Proof(DEMO_DISCLOSURE), { importerEORI: EORI_1 });
  });

  validCase("V02 minimal disclosure: only the 10 required fields", () =>
    judgeProof(f1Proof(REQUIRED_DISCLOSURES), { importerEORI: EORI_1 }),
  );

  validCase("V03 full disclosure: all 23 disclosable fields", async () => {
    const r = await judgeProof(f1Proof(DISCLOSABLE), { importerEORI: EORI_1 });
    expect(r.result.hidden).toBe(3);
    return r;
  });

  validCase("V04 audit details hidden (accreditation number, NAB, site visit, assurance, materiality)", () =>
    judgeProof(
      f1Proof(
        DEMO_DISCLOSURE.filter(
          (n) => !["accreditationNumber", "nabName", "siteVisit", "assuranceLevel", "materialityThreshold"].includes(n),
        ),
      ),
      { importerEORI: EORI_1 },
    ),
  );

  validCase("V05 emissions intensity and value type hidden (optional fields)", () =>
    judgeProof(
      f1Proof(DEMO_DISCLOSURE.filter((n) => n !== "specificEmbeddedEmissions_tCO2e_per_t" && n !== "valueType")),
      { importerEORI: EORI_1 },
    ),
  );

  validCase("V06 disclosures handed over in reverse order", () => {
    const p = f1Proof(DEMO_DISCLOSURE);
    return judgeProof({ ...p, disclosures: [...p.disclosures].reverse() }, { importerEORI: EORI_1 });
  });

  validCase("V07 report-only proof (no shipment, no EORI)", () => judgeProof(present(f1, DEMO_DISCLOSURE)));

  // ---- shipments, batches and importers on the shared ledger (500 t)

  validCase("V08 second shipment of the same credential to importer 2 (100 t)", async () => {
    const s = shipPart("BATCH-VALID-0201-B", "100", "v08");
    await claim(f1, s, EORI_2);
    return judgeProof(present(f1, DEMO_DISCLOSURE, s), { importerEORI: EORI_2 });
  });

  validCase("V09 third importer with its own EORI (150 t)", async () => {
    const s = shipPart("BATCH-VALID-0201-C", "150", "v09");
    await claim(f1, s, EORI_3);
    return judgeProof(present(f1, DEMO_DISCLOSURE, s), { importerEORI: EORI_3 });
  });

  validCase("V10 claim of exactly the remaining 50 t (ledger at 0 kg afterwards)", async () => {
    const s = shipPart("BATCH-VALID-0201-D", "50", "v10");
    await claim(f1, s, EORI_1);
    const r = await judgeProof(present(f1, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
    expect(r.result.onchain?.remainingKg).toBe(0n);
    const more = claimArgsOf(f1, { ...shipPart("BATCH-VALID-0201-E", "0.001", "v10b"), importerEORI: EORI_1 });
    expect(await c.reader.dryRun("claimShipment", more, c.supplier.address)).toMatchObject({
      reverted: true,
      errorName: "ExceedsVerifiedTonnage",
    });
    return r;
  });

  let f2: SignedCredential;
  validCase("V11 fractional quantity (12.345 t, whole kilograms)", async () => {
    f2 = await vfresh(202);
    await register(f2);
    const s = shipPart("BATCH-VALID-0202-A", "12.345", "v11");
    await claim(f2, s, EORI_1);
    return judgeProof(present(f2, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
  });

  validCase("V12 batch ID with spaces, a slash and non-ASCII characters", async () => {
    const s = shipPart("LOT 2026/Ä-07 · line 3", "10", "v12");
    await claim(f2, s, EORI_2);
    return judgeProof(present(f2, DEMO_DISCLOSURE, s), { importerEORI: EORI_2 });
  });

  validCase("V13 same batch ID string as another credential's batch (batch keys are per report)", async () => {
    const s = shipPart("BATCH-VALID-0201-A", "10", "v13");
    await claim(f2, s, EORI_2);
    return judgeProof(present(f2, DEMO_DISCLOSURE, s), { importerEORI: EORI_2 });
  });

  validCase("V14 one shipment claims the whole verified tonnage (75,000.5 t)", async () => {
    const f3 = await vfresh(203, { verifiedTonnes: "75000.5" });
    await register(f3);
    const s = shipPart("BATCH-VALID-0203-A", "75000.5", "v14");
    await claim(f3, s, EORI_1);
    const r = await judgeProof(present(f3, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
    expect(r.result.onchain?.remainingKg).toBe(0n);
    return r;
  });

  // ---- more credentials under the same report, other periods, other suppliers and bodies

  validCase("V15 second CN code under the same installation and report ID (6-digit CN 731815)", async () => {
    const cr = await vfresh(201, { cnCode: "731815" });
    await register(cr);
    const s = shipPart("BATCH-VALID-0201-CN6", "40", "v15");
    await claim(cr, s, EORI_1);
    return judgeProof(present(cr, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
  });

  validCase("V16 second production route (E) under the same installation and report ID", async () => {
    const cr = await vfresh(201, { cbamRoute: "E" });
    await register(cr);
    return judgeProof(present(cr, DEMO_DISCLOSURE));
  });

  let f5: SignedCredential;
  let r5: SignedCredential;
  let s5: ReturnType<typeof shipPart>;
  validCase("V17 revision in the same layer (500 t -> 480 t, same report ID): the new credential", async () => {
    f5 = await vfresh(205);
    await register(f5);
    s5 = shipPart("BATCH-VALID-0205-A", "100", "v17");
    await claim(f5, s5, EORI_1);
    r5 = await vfresh(205, { verifiedTonnes: "480", issuedAt: "2026-10-03T00:00:00Z" });
    await register(r5, { supersedes: reportKeyOf(f5.core.d) });
    const r = await judgeProof(present(r5, DEMO_DISCLOSURE));
    expect(r.result.checks[4].detail).toContain("revises an earlier one");
    return r;
  });

  validCase("V18 shipment claimed against the revised credential (claimed tonnage carried over)", async () => {
    const s = shipPart("BATCH-VALID-0205-B", "200", "v18");
    await claim(r5, s, EORI_2);
    const r = await judgeProof(present(r5, DEMO_DISCLOSURE, s), { importerEORI: EORI_2 });
    expect(r.result.onchain?.remainingKg).toBe(180_000n);
    return r;
  });

  validCase("V19 shipment claimed before the revision, checked after it (valid when shipped)", () =>
    judgeProof(present(f5, DEMO_DISCLOSURE, s5), { importerEORI: EORI_1 }),
  );

  validCase("V20 revision with a new verification report ID (report scope moves to it)", async () => {
    const f6 = await vfresh(206);
    await register(f6);
    const r6 = await vfresh(206, { verificationReportId: "VR-VALID-0206-R1", issuedAt: "2026-10-04T00:00:00Z" });
    await register(r6, { supersedes: reportKeyOf(f6.core.d) });
    return judgeProof(present(r6, DEMO_DISCLOSURE));
  });

  validCase("V21 whole-report revision into an empty credential layer (take-over by the same body)", async () => {
    const f7 = await vfresh(207);
    await register(f7);
    const t7 = await vfresh(207, { cnCode: "731816", verificationReportId: "VR-VALID-0207-R1" });
    await register(t7, { supersedes: reportKeyOf(f7.core.d) });
    const r = await judgeProof(present(t7, DEMO_DISCLOSURE));
    expect(r.result.checks[4].detail).toContain("report-scope takeover");
    return r;
  });

  validCase("V22 credential of the second accredited body, with its own auditor", async () => {
    const cr = await issueBy(c.other, OTHER_BODY_LEI, OTHER_BODY_AUDITOR_AID, {
      installationId: inst(222),
      verificationReportId: "VR-OTHER-0222",
    });
    await register(cr, { from: c.other });
    const s = shipPart("BATCH-VALID-0222-A", "300", "v22");
    await claim(cr, s, EORI_2);
    return judgeProof(present(cr, DEMO_DISCLOSURE, s), { importerEORI: EORI_2 });
  });

  validCase("V23 same installation, next reporting period (2027)", async () => {
    const cr = await vfresh(201, {
      reportingPeriod: "2027-01-01/2027-12-31",
      verificationReportId: "VR-VALID-0201-2027",
      validUntil: "2028-06-30T00:00:00Z",
    });
    await register(cr);
    const s = shipPart("BATCH-VALID-0201-2027", "250", "v23");
    await claim(cr, s, EORI_1);
    return judgeProof(present(cr, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
  });

  validCase("V24 another supplier company with its own wallet", async () => {
    const supplier2 = await newAccount("supplier-2");
    const cr = await issue({
      supplierLEI: SUPPLIER2_LEI,
      operatorId: `TW${SUPPLIER2_LEI}`,
      installationId: `TW-${SUPPLIER2_LEI}-0001`,
      installationName: "Demo Bolts Plant (fictional)",
      verificationReportId: "VR-VALID-0224",
    });
    await register(cr, { supplier: supplier2 });
    const s = shipPart("BATCH-VALID-0224-A", "120", "v24");
    await claim(cr, s, EORI_1, supplier2);
    return judgeProof(present(cr, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
  });

  // ---- time boundaries (these move the chain clock forward)

  validCase("V25 auditor revoked 24 h + 1 s after registration (outside the CONTESTED window)", async () => {
    await addAuditor(AUDITOR_LATE);
    const cr = await vfresh(225, {}, AUDITOR_LATE);
    const at = await register(cr);
    await revokeAt(AUDITOR_LATE, at + DAY + 1n);
    return judgeProof(present(cr, DEMO_DISCLOSURE));
  });

  const SHORT_UNTIL = "2026-11-01T00:00:00Z";
  let short: SignedCredential;
  let sShort: ReturnType<typeof shipPart>;
  validCase("V26 checked one second before validUntil", async () => {
    short = await vfresh(226, { validUntil: SHORT_UNTIL });
    await register(short);
    sShort = shipPart("BATCH-VALID-0226-A", "50", "v26");
    await claim(short, sShort, EORI_1);
    const until = isoToSeconds(SHORT_UNTIL);
    await c.test.setNextBlockTimestamp({ timestamp: until - 1n });
    await c.test.mine({ blocks: 1 });
    const r = await judgeProof(present(short, DEMO_DISCLOSURE));
    expect(r.result.checkedAt).toBe(until - 1n);
    return r;
  });

  validCase("V27 checked exactly at validUntil (validity is inclusive)", async () => {
    const until = isoToSeconds(SHORT_UNTIL);
    await c.test.setNextBlockTimestamp({ timestamp: until });
    await c.test.mine({ blocks: 1 });
    const r = await judgeProof(present(short, DEMO_DISCLOSURE));
    expect(r.result.checkedAt).toBe(until);
    return r;
  });

  validCase("V28 shipment claimed while valid, checked after validUntil (checked at the claim time)", async () => {
    await c.test.setNextBlockTimestamp({ timestamp: isoToSeconds(SHORT_UNTIL) + 3600n });
    await c.test.mine({ blocks: 1 });
    const now = await judgeProof(present(short, DEMO_DISCLOSURE));
    expect(now.code).toBe("REPORT_INVALID/EXPIRED");
    return judgeProof(present(short, DEMO_DISCLOSURE, sShort), { importerEORI: EORI_1 });
  });
});

describe("contested matrix on a local chain (each must be CONTESTED, not INVALID)", () => {
  contestedCase("C01 auditor revoked 1 h after registration", async () => {
    await addAuditor(AUDITOR_C1);
    const cr = await vfresh(301, {}, AUDITOR_C1);
    const at = await register(cr);
    await revokeAt(AUDITOR_C1, at + 3600n);
    return judgeProof(present(cr, DEMO_DISCLOSURE));
  });

  contestedCase("C02 auditor revoked exactly 24 h after registration (window edge)", async () => {
    await addAuditor(AUDITOR_C2);
    const cr = await vfresh(302, {}, AUDITOR_C2);
    const at = await register(cr);
    await revokeAt(AUDITOR_C2, at + DAY);
    return judgeProof(present(cr, DEMO_DISCLOSURE));
  });

  contestedCase("C03 verification body suspended 1 h after registration", async () => {
    const body3 = await newAccount("body-3");
    const lei = leiHashOf(THIRD_BODY_LEI);
    await send(c, c.owner, "allowlist", "addVerifier", [
      {
        leiHash: lei,
        verifier: body3.address,
        leCredSaidHash: hashString("LE-SAID-3"),
        accreditationSaidHash: hashString("ACC-SAID-3"),
        accreditedUntil: 1924905600n,
      },
    ]);
    await addAuditor(AUDITOR_B3, THIRD_BODY_LEI);
    const cr = await issueBy(body3, THIRD_BODY_LEI, AUDITOR_B3, {
      installationId: inst(303),
      verificationReportId: "VR-THIRD-0303",
    });
    const at = await register(cr, { from: body3 });
    await c.test.setNextBlockTimestamp({ timestamp: at + 3600n });
    await send(c, c.watcher, "allowlist", "suspendVerifier", [lei]);
    return judgeProof(present(cr, DEMO_DISCLOSURE));
  });

  contestedCase("C04 shipment proof; auditor revoked 2 h after registration and claim", async () => {
    await addAuditor(AUDITOR_C4);
    const cr = await vfresh(304, {}, AUDITOR_C4);
    const at = await register(cr);
    const s = shipPart("BATCH-CONTESTED-0304", "100", "c04");
    await claim(cr, s, EORI_1);
    await revokeAt(AUDITOR_C4, at + 7200n);
    return judgeProof(present(cr, DEMO_DISCLOSURE, s), { importerEORI: EORI_1 });
  });
});

// ------------------------------------------------------------------ matrix

describe("tamper matrix on a local chain", () => {
  it("control: the genuine proof passes checks 0-5 and legitimate calls do not revert", async () => {
    expect(await viaVerify(proof, { importerEORI: EORI_1 })).toEqual(NOT_CAUGHT);
    const legitClaim = claimArgsOf(cred, {
      batchId: "BATCH-DEMO-2026-0100",
      quantityTonnes: "100",
      importerEORI: EORI_2,
      importerSalt: salt("imp-control"),
    });
    expect(await c.reader.dryRun("claimShipment", legitClaim, c.supplier.address)).toEqual({ reverted: false });
    const legitReport = inputOf(await fresh(99));
    expect(await c.reader.dryRun("registerReport", [legitReport], c.verifier.address)).toEqual({ reverted: false });
  }, 60_000);

  // ---- browser-side checks 0-3 (no chain needed)

  tamperCase("T01 disclosed emissions intensity changed 1.8 -> 1.2", caughtBy(2, "DISCLOSURE_TAMPERED"), () =>
    viaVerify(replaceDisclosure(proof, "specificEmbeddedEmissions_tCO2e_per_t", "1.2"), { importerEORI: EORI_1 }),
  );

  tamperCase("T02 disclosed verified tonnes changed 500 -> 600 (disclosure re-encoded)", caughtBy(2, "DISCLOSURE_TAMPERED"), () =>
    viaVerify(replaceDisclosure(proof, "verifiedTonnes", "600"), { importerEORI: EORI_1 }),
  );

  tamperCase("T03 credential core edited after issuance (issuedAt)", caughtBy(1, "SAID_MISMATCH"), async () => {
    const core = proof.core.replace('"issuedAt":"2026-10-01T00:00:00Z"', '"issuedAt":"2026-10-02T00:00:00Z"');
    expect(core).not.toBe(proof.core);
    return viaVerify({ ...proof, core }, { importerEORI: EORI_1 });
  });

  tamperCase("T04 signature from another wallet", caughtBy(3, "BAD_SIGNATURE"), async () => {
    // Same EIP-712 message as the genuine credential, signed by a wallet that is not the body.
    const signature = await signCredential(
      c.impostor,
      registry,
      {
        credSAID: cred.core.d,
        supplierCommit: supplierCommitOf(cred.claims.supplierLEI, cred.claims.idSalt),
        verifiedKg: tonnesToKg(cred.claims.verifiedTonnes),
        validUntil: isoToSeconds(cred.claims.validUntil),
      },
      31337,
    );
    return viaVerify({ ...proof, signature }, { importerEORI: EORI_1 });
  });

  tamperCase(
    "T05 disclosures swapped in from another credential of the same supplier",
    caughtBy(2, "DISCLOSURE_TAMPERED"),
    async () => {
      // A genuine, body-signed credential of the same supplier (plant 2) with a lower intensity.
      const plant2 = await issue({
        installationId: inst(2),
        verificationReportId: "VR-DEMO-0002",
        specificEmbeddedEmissions_tCO2e_per_t: "1.2",
        issuedAt: "2026-10-02T00:00:00Z",
      });
      const name = "specificEmbeddedEmissions_tCO2e_per_t";
      const i = proof.disclosures.findIndex((d) => decodeDisclosure(d).name === name);
      const disclosures = [...proof.disclosures];
      disclosures[i] = plant2.disclosures[name];
      return viaVerify({ ...proof, disclosures }, { importerEORI: EORI_1 });
    },
  );

  // ---- on-chain comparison, check 5 (shipment)

  tamperCase("T06 shipment batch ID changed", caughtBy(5, "SHIPMENT_MISMATCH"), () =>
    viaVerify({ ...proof, shipment: { ...shipment, batchId: "BATCH-DEMO-2026-0099" } }, { importerEORI: EORI_1 }),
  );

  tamperCase("T07 shipment quantity changed", caughtBy(5, "SHIPMENT_MISMATCH"), () =>
    viaVerify({ ...proof, shipment: { ...shipment, quantityTonnes: "300" } }, { importerEORI: EORI_1 }),
  );

  tamperCase("T08 proof checked by an importer whose EORI was not declared", caughtBy(5, "SHIPMENT_MISMATCH"), () =>
    viaVerify(proof, { importerEORI: EORI_2 }),
  );

  // ---- contract reverts (dry run)

  tamperCase(
    "T09 same batch claimed again (dry run)",
    revertedIn("claimShipment", "dry run", "BatchAlreadyClaimed"),
    () =>
      viaDryRun(
        "claimShipment",
        claimArgsOf(cred, { ...shipment, importerEORI: EORI_2, importerSalt: salt("imp2") }),
        c.supplier.address,
      ),
  );

  tamperCase(
    "T10 second importer claims more than the remaining verified tonnes (dry run)",
    revertedIn("claimShipment", "dry run", "ExceedsVerifiedTonnage"),
    async () => {
      const over = claimArgsOf(cred, {
        batchId: "BATCH-DEMO-2026-0002",
        quantityTonnes: "400",
        importerEORI: EORI_2,
        importerSalt: salt("imp2"),
      });
      const d = await c.reader.dryRun("claimShipment", over, c.supplier.address);
      if (d.reverted && d.errorName === "ExceedsVerifiedTonnage") expect(d.args).toEqual([300_000n, 400_000n]);
      return d.reverted ? revertedIn("claimShipment", "dry run", d.errorName) : NOT_CAUGHT;
    },
  );

  tamperCase(
    "T11 impostor body registers a report (dry run)",
    revertedIn("registerReport", "dry run", "NotActiveVerifier"),
    async () =>
      viaDryRun("registerReport", [inputOf(await fresh(11, { verificationReportId: "VR-FAKE-0001" }))], c.impostor.address),
  );

  // ---- contract revert (mined transaction)

  tamperCase(
    "T12 report registered after the auditor was revoked (mined transaction)",
    revertedIn("registerReport", "transaction", "AuditorNotAuthorized"),
    async () => {
      const lei = leiHashOf(BODY_LEI);
      const aid = auditorAidHashOf(AUDITOR_AID_REVOKED);
      await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: aid, leiHash: lei, ecrSaidHash: hashString("ECR-R") }]);
      await send(c, c.watcher, "allowlist", "revokeAuditor", [aid, lei]);
      const cr = await fresh(12, {}, AUDITOR_AID_REVOKED);
      // Fixed gas skips estimation, so the transaction is really sent and mined.
      const hash = await c.wallet(c.verifier).writeContract({
        address: registry,
        abi: emissionsClaimRegistryAbi,
        functionName: "registerReport",
        args: [inputOf(cr)],
        account: c.verifier,
        chain: foundry,
        gas: 3_000_000n,
      } as never);
      const receipt = await c.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "reverted") return NOT_CAUGHT;
      expect((await c.reader.report(reportKeyOf(cr.core.d))).registeredAt).toBe(0n);
      const trace = (await c.pub.request({
        method: "debug_traceTransaction",
        params: [hash, { tracer: "callTracer" }],
      } as never)) as { output?: ViemHex };
      const { errorName } = decodeErrorResult({ abi: emissionsClaimRegistryAbi, data: trace.output as ViemHex });
      return revertedIn("registerReport", "transaction", errorName);
    },
  );

  // ---- on-chain comparison, check 4 (report record)

  tamperCase("T13 revoked report", caughtBy(4, "REPORT_INVALID/REVOKED"), async () => {
    const cr = await fresh(13);
    await send(c, c.verifier, "registry", "registerReport", [inputOf(cr)]);
    await send(c, c.verifier, "registry", "revokeReport", [reportKeyOf(cr.core.d)]);
    return viaVerify(present(cr, DEMO_DISCLOSURE));
  });

  tamperCase(
    "T14 another accredited body registers this body's credential (contract accepts it)",
    caughtBy(4, "REPORT_INVALID/REGISTRANT_MISMATCH"),
    async () => {
      const cr = await fresh(14);
      // The registry does not verify the EIP-712 signature, so this registration succeeds.
      const receipt = await send(c, c.other, "registry", "registerReport", [
        { ...inputOf(cr), auditorAidHash: auditorAidHashOf(OTHER_BODY_AUDITOR_AID) },
      ]);
      expect(receipt.status).toBe("success");
      return viaVerify(present(cr, DEMO_DISCLOSURE));
    },
  );

  tamperCase(
    "T15 body registers 600 t on-chain for a credential signed for 500 t",
    caughtBy(4, "REPORT_INVALID/ISSUER_MISMATCH"),
    async () => {
      const cr = await fresh(15);
      const receipt = await send(c, c.verifier, "registry", "registerReport", [{ ...inputOf(cr), verifiedKg: 600_000n }]);
      expect(receipt.status).toBe("success");
      return viaVerify(present(cr, DEMO_DISCLOSURE));
    },
  );

  tamperCase(
    "T16 credential registered under another installation's scope keys",
    caughtBy(4, "REPORT_INVALID/SCOPE_MISMATCH"),
    async () => {
      const cr = await fresh(16);
      // Registered under plant 2's report and credential scope, leaving installation 0016's scope free.
      const receipt = await send(c, c.verifier, "registry", "registerReport", [
        {
          ...inputOf(cr),
          reportScopeKey: reportScopeKeyOf(inst(2), PERIOD),
          credScopeKey: credScopeKeyOf(inst(2), "7318", "C", PERIOD),
        },
      ]);
      expect(receipt.status).toBe("success");
      return viaVerify(present(cr, DEMO_DISCLOSURE));
    },
  );

  // ---- structure, check 0

  tamperCase("T17a methodology note removed", caughtBy(0, "PRESENTATION_MALFORMED"), () =>
    viaVerify(
      { ...proof, disclosures: proof.disclosures.filter((d) => decodeDisclosure(d).name !== "methodologyNote") },
      { importerEORI: EORI_1 },
    ),
  );

  tamperCase("T17b methodology note changed", caughtBy(0, "PRESENTATION_MALFORMED"), () =>
    viaVerify(replaceDisclosure(proof, "methodologyNote", "official CBAM default methodology"), { importerEORI: EORI_1 }),
  );

  // ---- last: moves the chain clock forward

  tamperCase("T18 past validUntil", caughtBy(4, "REPORT_INVALID/EXPIRED"), async () => {
    await c.test.increaseTime({ seconds: 3 * 365 * 24 * 3600 });
    await c.test.mine({ blocks: 1 });
    // Without a shipment the report is checked at the current time.
    return viaVerify(present(cred, DEMO_DISCLOSURE));
  });

  it("writes .cache/tamper-matrix.json and every attack was stopped", () => {
    const total = declared.length;
    const detected = rows.filter((r) => r.detected).length;
    mkdirSync(new URL(".", OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          total,
          detected,
          baseline: { method: "PDF only", detected: 0 },
          rows: rows.map(({ case: name, layer, code }) => ({ case: name, layer, code })),
        },
        null,
        2,
      ) + "\n",
    );
    expect(rows).toHaveLength(total);
    expect(detected).toBe(total);
  });
});

describe("detection coverage on inputs we wrote (confusion matrix)", () => {
  it("writes .cache/accuracy-matrix.json: tampered, valid and contested inputs", () => {
    const count = (cls: "valid" | "contested", v: Verdict) =>
      variantRows.filter((r) => r.class === cls && r.verdict === v).length;
    const tamperedTotal = declared.length;
    const tamperedDetected = rows.filter((r) => r.detected).length;
    const validTotal = declaredVariants.filter((d) => d.class === "valid").length;
    const contestedTotal = declaredVariants.filter((d) => d.class === "contested").length;
    const valid = {
      total: validTotal,
      accepted: count("valid", "VALID"),
      falselyRejected: validTotal - count("valid", "VALID") - count("valid", "CONTESTED"),
      flaggedContested: count("valid", "CONTESTED"),
    };
    const contested = {
      total: contestedTotal,
      flagged: count("contested", "CONTESTED"),
      accepted: count("contested", "VALID"),
      rejected: contestedTotal - count("contested", "CONTESTED") - count("contested", "VALID"),
    };
    mkdirSync(new URL(".", ACCURACY_OUT), { recursive: true });
    writeFileSync(
      ACCURACY_OUT,
      JSON.stringify(
        {
          scope: "checks 0-5 and contract calls on a local anvil chain; checks 6-8 need vLEI evidence and have their own tests",
          note: "every input was written by the team: detection coverage of known cases, not a statistical accuracy",
          tampered: { total: tamperedTotal, detected: tamperedDetected, missed: tamperedTotal - tamperedDetected },
          valid,
          contested,
          rows: variantRows,
        },
        null,
        2,
      ) + "\n",
    );
    expect(tamperedDetected).toBe(tamperedTotal);
    expect(valid).toEqual({ total: validTotal, accepted: validTotal, falselyRejected: 0, flaggedContested: 0 });
    expect(contested).toEqual({ total: contestedTotal, flagged: contestedTotal, accepted: 0, rejected: 0 });
  });
});
