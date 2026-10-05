// Tamper matrix: every attack below is run once against a local anvil chain, and the row
// records which layer stopped it and with which code. Layers: browser checks 0-3 (no chain),
// on-chain comparison checks 4-5, and contract reverts (dry run or mined transaction).
// Baseline: an importer who only reads the PDF report detects none of them (0 of N).
// The result is written to .cache/tamper-matrix.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeErrorResult, keccak256, stringToBytes, type Hex as ViemHex } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emissionsClaimRegistryAbi } from "../abi.ts";
import {
  auditorAidHashOf,
  credScopeKeyOf,
  hashString,
  leiHashOf,
  reportKeyOf,
  reportScopeKeyOf,
  supplierCommitOf,
} from "../commitment.ts";
import { isoToSeconds, METHODOLOGY_NOTE, tonnesToKg, type CredentialClaims, type Hex } from "../credential.ts";
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
import { verifyPresentation, type CheckResult, type VerifyOptions } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const OUT = new URL("../../.cache/tamper-matrix.json", import.meta.url);
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

async function viaVerify(p: Presentation, opts: VerifyOptions = {}): Promise<Observed> {
  return firstCatch((await verifyPresentation(p, c.reader, opts)).checks);
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
