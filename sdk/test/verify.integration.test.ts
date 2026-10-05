// End-to-end on a local anvil chain: register, claim, then verify the supplier's proof,
// and check that each kind of tampering is caught by the right check.
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../commitment.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../disclosure.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../issue.ts";
import { verifyPresentation } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const salt = (s: string): Hex => keccak256(stringToBytes(`it:${s}`));
const AUDITOR_AID = "EDemoAuditorAidForIntegrationTests0000000000";
const EORI_1 = demo.entities.importers[0].eori as string;
const EORI_2 = demo.entities.importers[1].eori as string;

function claims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  const r = demo.reports[0];
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: s.installations[0].id,
    installationName: s.installations[0].name,
    unLocode: s.unLocode,
    cnCode: "7318",
    cbamRoute: "C",
    productionRoute: "BF-BOF wire rod (illustrative)",
    reportingPeriod: r.reportingPeriod,
    verifiedTonnes: "500",
    specificEmbeddedEmissions_tCO2e_per_t: "1.8",
    valueType: "actual",
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: "VR-DEMO-0001",
    verifierLEI: demo.entities.verifier.lei,
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
let cred: SignedCredential;
let proof: Presentation;
const shipment = { batchId: "BATCH-DEMO-2026-0001", quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: salt("imp") };

async function issue(over: Partial<CredentialClaims> = {}) {
  return issueCredential({
    claims: claims(over),
    auditorAID: AUDITOR_AID,
    signer: c.verifier,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    chainId: 31337,
  });
}

async function register(cr: SignedCredential, supersedes?: Hex) {
  return send(c, c.verifier, "registry", "registerReport", [
    reportInputOf(cr, { supplier: c.supplier.address, kelSeq: 1n, supersedes }),
  ]);
}

beforeAll(async () => {
  c = await startLocalChain(18545 + Math.floor(Math.random() * 1000));
  const lei = leiHashOf(demo.entities.verifier.lei);
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
  cred = await issue();
  await register(cred);
  await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cred, { ...shipment, importerEORI: EORI_1 }));
  proof = present(cred, DEMO_DISCLOSURE, shipment);
}, 60_000);

afterAll(() => c?.stop());

const codes = (r: Awaited<ReturnType<typeof verifyPresentation>>) =>
  Object.fromEntries(r.checks.map((x) => [x.index, `${x.status}:${x.code}`]));

describe("verifyPresentation on a local chain", () => {
  it("S9 genuine proof: checks 0–5 pass, hidden fields counted, 6–7 need evidence", async () => {
    const r = await verifyPresentation(proof, c.reader, { importerEORI: EORI_1 });
    const k = codes(r);
    for (const i of [0, 1, 2, 3, 4, 5]) expect(k[i]).toBe("pass:");
    expect(k[6]).toBe("fail:ANCHOR_NOT_FOUND");
    expect(k[7]).toBe("fail:AUTHORITY_INVALID");
    expect(k[8]).toBe("skipped:");
    expect(r.hidden).toBe(5);
    expect(r.disclosed.specificEmbeddedEmissions_tCO2e_per_t).toBe("1.8");
    expect(r.disclosed.energyMix).toBeUndefined();
    expect(r.onchain?.remainingKg).toBe(300_000n);
    expect(r.checkedAt).toBe(r.onchain?.claimedAt);
  });

  it("S2 Tamper: intensity changed from 1.8 to 1.2 → DISCLOSURE_TAMPERED", async () => {
    const i = proof.disclosures.findIndex((d) => decodeDisclosure(d).name === "specificEmbeddedEmissions_tCO2e_per_t");
    const tampered = [...proof.disclosures];
    tampered[i] = encodeDisclosure({ ...decodeDisclosure(proof.disclosures[i]), value: "1.2" });
    const r = await verifyPresentation({ ...proof, disclosures: tampered }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[2]).toBe("fail:DISCLOSURE_TAMPERED");
    expect(r.primaryCode).toBe("DISCLOSURE_TAMPERED");
    expect(r.disclosed.specificEmbeddedEmissions_tCO2e_per_t).toBeUndefined();
  });

  it("S1 core edited after issuance → SAID_MISMATCH", async () => {
    const core = proof.core.replace("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
    const r = await verifyPresentation({ ...proof, core }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[1]).toBe("fail:SAID_MISMATCH");
  });

  it("S3 signed by another wallet → BAD_SIGNATURE", async () => {
    const other = await issueCredential({
      claims: claims(),
      auditorAID: AUDITOR_AID,
      signer: privateKeyToAccount(salt("not-the-body")),
      registry: c.deployment.contracts.EmissionsClaimRegistry.address,
      chainId: 31337,
    });
    const r = await verifyPresentation({ ...proof, signature: other.signature }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[3]).toBe("fail:BAD_SIGNATURE");
  });

  it("S5 wrong EORI → SHIPMENT_MISMATCH; no EORI → check 5 skipped", async () => {
    const wrong = await verifyPresentation(proof, c.reader, { importerEORI: EORI_2 });
    expect(codes(wrong)[5]).toBe("fail:SHIPMENT_MISMATCH");
    const none = await verifyPresentation(proof, c.reader);
    expect(codes(none)[5]).toBe("skipped:");
  });

  it("step 0: missing required disclosure or changed methodology note → PRESENTATION_MALFORMED", async () => {
    const withoutSalt = proof.disclosures.filter((d) => decodeDisclosure(d).name !== "idSalt");
    const r = await verifyPresentation({ ...proof, disclosures: withoutSalt }, c.reader);
    expect(r.primaryCode).toBe("PRESENTATION_MALFORMED");
    expect(r.checks).toHaveLength(1);
  });

  it("unregistered credential → REPORT_INVALID/NOT_REGISTERED", async () => {
    const fresh = await issue({ verificationReportId: "VR-DEMO-0009", cnCode: "7208" });
    const r = await verifyPresentation(present(fresh, DEMO_DISCLOSURE), c.reader);
    expect(codes(r)[4]).toBe("fail:REPORT_INVALID/NOT_REGISTERED");
  });

  it("dry runs: second importer over the shared ledger, impostor body", async () => {
    const over = claimArgsOf(cred, { batchId: "BATCH-DEMO-2026-0002", quantityTonnes: "400", importerEORI: EORI_2, importerSalt: salt("imp2") });
    const d1 = await c.reader.dryRun("claimShipment", over, c.supplier.address);
    expect(d1).toMatchObject({ reverted: true, errorName: "ExceedsVerifiedTonnage", args: [300_000n, 400_000n] });
    const d2 = await c.reader.dryRun(
      "registerReport",
      [reportInputOf(await issue({ verificationReportId: "VR-FAKE-0001" }), { supplier: c.supplier.address, kelSeq: 1n })],
      c.impostor.address,
    );
    expect(d2).toMatchObject({ reverted: true, errorName: "NotActiveVerifier" });
    const d3 = await c.reader.dryRun("claimShipment", claimArgsOf(cred, { ...shipment, importerEORI: EORI_2 }), c.supplier.address);
    expect(d3).toMatchObject({ reverted: true, errorName: "BatchAlreadyClaimed" });
  });

  it("revision in the same layer: the old credential is SUPERSEDED now, its earlier shipment stays valid", async () => {
    const rev = await issue({ verifiedTonnes: "480", verificationReportId: "VR-DEMO-0001-R1", issuedAt: "2026-10-03T00:00:00Z" });
    await register(rev, reportKeyOf(cred.core.d));
    const now = await verifyPresentation(present(cred, DEMO_DISCLOSURE), c.reader);
    expect(codes(now)[4]).toBe("fail:REPORT_INVALID/SUPERSEDED");
    const atClaim = await verifyPresentation(proof, c.reader, { importerEORI: EORI_1 });
    expect(codes(atClaim)[4]).toBe("pass:");
    expect(codes(atClaim)[5]).toBe("pass:");
    const newOne = await verifyPresentation(present(rev, DEMO_DISCLOSURE), c.reader);
    expect(newOne.checks[4].detail).toContain("revises an earlier one");
  });

  it("revoked report → REPORT_INVALID/REVOKED, and the shipment check fails too", async () => {
    const other = await issue({ installationId: demo.entities.supplier.installations[1].id, verificationReportId: "VR-DEMO-0002", issuedAt: "2026-10-02T00:00:00Z" });
    await register(other);
    const ship = { ...shipment, batchId: "BATCH-DEMO-2026-0003" };
    await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(other, { ...ship, importerEORI: EORI_1 }));
    await send(c, c.verifier, "registry", "revokeReport", [reportKeyOf(other.core.d)]);
    const r = await verifyPresentation(present(other, DEMO_DISCLOSURE, ship), c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[4]).toBe("fail:REPORT_INVALID/REVOKED");
    expect(codes(r)[5]).toBe("fail:SHIPMENT_MISMATCH");
  });

  it("auditor revoked within 24 h of registration → CONTESTED (not a failure)", async () => {
    const recent = await issue({ cnCode: "7318", cbamRoute: "E", verificationReportId: "VR-DEMO-0001-R1", issuedAt: "2026-10-03T00:00:00Z" });
    await register(recent);
    await c.test.increaseTime({ seconds: 3600 });
    await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(AUDITOR_AID), leiHashOf(demo.entities.verifier.lei)]);
    const r = await verifyPresentation(present(recent, DEMO_DISCLOSURE), c.reader);
    expect(codes(r)[4]).toBe("pass:CONTESTED");
    const r48 = await verifyPresentation(present(recent, DEMO_DISCLOSURE), c.reader, { contestedWindowHours: 0.5 });
    expect(codes(r48)[4]).toBe("pass:");
  });

  it("past validUntil → REPORT_INVALID/EXPIRED (checked now, no shipment)", async () => {
    await c.test.increaseTime({ seconds: 3 * 365 * 24 * 3600 });
    await c.test.mine({ blocks: 1 });
    const r = await verifyPresentation(present(cred, DEMO_DISCLOSURE), c.reader);
    expect(r.checks[4].detail).toContain("past the credential's validity");
  });
});
