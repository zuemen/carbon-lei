// Check 9, the precursor chain of trust, on a local anvil chain: a wire-rod mill's verified report backs the demo screw
// report. Covers the cap one tier up (two screw makers cannot be backed by the same verified wire rod beyond its
// tonnes: ExceedsVerifiedTonnage on the mill's report) and the attacks: a precursor credential from a body that is
// not on the allowlist, a revoked precursor, a declared screw SEE below direct + precursor emissions, a precursor from
// a later period or outside the mill body's CN scope, a tampered statement, a batch claimed for another maker.
// vLEI evidence: the synthetic two-body chain of verifier/src/precursor-chain.ts (pinned explicitly: its root is not
// the demo root). Nothing here runs on Sepolia.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vleiCheckers } from "../checkers.ts";
import { reportKeyOf } from "../commitment.ts";
import type { Presentation, ShipmentPart } from "../disclosure.ts";
import { claimArgsOf, type SignedCredential } from "../issue.ts";
import { precursorDigestOf, type PrecursorEvidence, type PrecursorStatement } from "../precursor.ts";
import { verifyPresentation, type VerificationResult } from "../verify.ts";
import { toVerdict } from "../verdict.ts";
import { BOUNDARY, boundaryWithPrecursors, exportPactFromProof } from "../pact.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";
import {
  IMPORTER_EORI,
  PC,
  SCREW_LEI,
  claimFor,
  issueAs,
  millClaims,
  proofOf,
  register,
  screwClaims,
  setupWorld,
  statementOf,
  wireRodLine,
  type World,
} from "../../scripts/precursor-scenario.ts";
import { DEMO_TRUST_ANCHOR } from "../vlei.ts";
import { newSalt } from "../encoding.ts";

const run = promisify(execFile);
const status = (r: VerificationResult) => Object.fromEntries(r.checks.map((x) => [x.index, `${x.status}:${x.code}`]));
const millInst = (n: number) => `TW-${PC.mill.lei}-000${n}`;
const screwInst = (n: number) => `TW-${SCREW_LEI}-000${n}`;
const SECOND_LEI: string = PC.secondScrewMaker.lei;

let c: LocalChain;
let w: World;
const cred: Record<string, SignedCredential> = {};
const st: Record<string, PrecursorStatement> = {};
const ship: Record<string, ShipmentPart> = {};
let screwShipment: ShipmentPart;
let secondClaimError: unknown;

const checkers = () => vleiCheckers({ trustAnchor: w.chain.trustAnchor });
const verify = (p: Presentation, eori = IMPORTER_EORI, ch = checkers()) => verifyPresentation(p, c.reader, { importerEORI: eori, checkers: ch });
/** The screw proof of credential `s`, with the mill proof of `m` and the claimed batch shipment `b` as evidence. */
const screwProof = (s: string, lines: { m?: string; b?: string }[], shipment?: ShipmentPart, statement = st[s]): Presentation =>
  proofOf(w, "screw", cred[s], {
    ...(shipment ? { shipment } : {}),
    precursorEvidence: {
      statement,
      proofs: lines.map((l) => (l.m ? proofOf(w, "mill", cred[l.m], { shipment: ship[l.b!] }) : null)),
    } as PrecursorEvidence,
  });

beforeAll(async () => {
  c = await startLocalChain(21545 + Math.floor(Math.random() * 1000));
  w = await setupWorld(c);
  // ---- mill credentials (CN 7213 unless stated)
  cred.M1 = await issueAs(w, "mill", millClaims());
  cred.M2 = await issueAs(w, "mill", millClaims({ installationId: millInst(2), verificationReportId: "VR-DEMO-WR-0002", verifiedTonnes: "100" }));
  cred.M3 = await issueAs(w, "mill", millClaims({ installationId: millInst(3), verificationReportId: "VR-DEMO-WR-0003", verifiedTonnes: "100", reportingPeriod: "2027-01-01/2027-12-31" }));
  cred.M4 = await issueAs(w, "mill", millClaims({ installationId: millInst(4), verificationReportId: "VR-DEMO-WR-0004", verifiedTonnes: "100", cnCode: "7208" }));
  // signed by a key whose body is not on the allowlist (same auditor AID, so only the signer differs)
  cred.MX = await issueAs(w, "mill", millClaims({ installationId: millInst(5), verificationReportId: "VR-DEMO-WR-0005", verifiedTonnes: "100" }), { signer: c.other });

  // ---- screw credentials (each with its own installation, so each has its own report scope)
  st.S1 = statementOf([wireRodLine(cred.M1, "WR-A")]);
  cred.S1 = await issueAs(w, "screw", screwClaims(), { statement: st.S1 });
  st.S2 = statementOf([wireRodLine(cred.M1, "WR-U")]);
  cred.S2 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(2), verificationReportId: "VR-DEMO-T2", verifiedTonnes: "40", specificEmbeddedEmissions_tCO2e_per_t: "1.6" }), { statement: st.S2 });
  st.S3 = statementOf([wireRodLine(cred.M2, "WR-R")]);
  cred.S3 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(3), verificationReportId: "VR-DEMO-T3", verifiedTonnes: "40" }), { statement: st.S3 });
  st.S4 = statementOf([wireRodLine(cred.M3, "WR-P")]);
  cred.S4 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(4), verificationReportId: "VR-DEMO-T4", verifiedTonnes: "40" }), { statement: st.S4 });
  st.S5 = statementOf([wireRodLine(cred.M4, "WR-C")]);
  cred.S5 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(5), verificationReportId: "VR-DEMO-T5", verifiedTonnes: "40" }), { statement: st.S5 });
  st.S6 = statementOf([wireRodLine(cred.MX, "WR-X")]);
  cred.S6 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(6), verificationReportId: "VR-DEMO-T6", verifiedTonnes: "40" }), { statement: st.S6 });
  st.S7 = statementOf([{ cnCode: "7213", massPerTonne: "1.125", source: "default", defaultSEE: "1.44", defaultBasis: "test value (illustrative), not the Default Values Act" }]);
  cred.S7 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(7), verificationReportId: "VR-DEMO-T7", verifiedTonnes: "40" }), { statement: st.S7 });
  st.S8 = statementOf([wireRodLine(cred.M1, "WR-O")]);
  cred.S8 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(8), verificationReportId: "VR-DEMO-T8", verifiedTonnes: "40", specificEmbeddedEmissions_tCO2e_per_t: "2.1" }), { statement: st.S8 });
  // the second screw maker: 400 t at 1.25 t of wire rod per t (500 t of wire rod) from the same mill report
  st.B = statementOf([wireRodLine(cred.M1, PC.secondScrewMaker.batchId, "1.25")]);
  cred.B = await issueAs(
    w,
    "screw",
    screwClaims({
      supplierLEI: SECOND_LEI,
      operatorId: `TW${SECOND_LEI}`,
      installationId: PC.secondScrewMaker.installation.id,
      installationName: PC.secondScrewMaker.installation.name,
      verificationReportId: "VR-DEMO-T9",
      verifiedTonnes: "400",
      specificEmbeddedEmissions_tCO2e_per_t: "1.98",
    }),
    { statement: st.B },
  );

  // ---- registrations
  for (const m of ["M1", "M2", "M3", "M4"]) await register(w, "mill", cred[m], w.millSupplier);
  for (const s of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]) await register(w, "screw", cred[s], w.screwSupplier);
  await register(w, "screw", cred.B, w.secondSupplier);

  // ---- the mill's claims for the screw maker (importerCommit = the screw maker's LEI and the SAID of the screw credential that relies on the batch)
  ship["WR-A"] = await claimFor(w, cred.M1, { batchId: "WR-A", quantityTonnes: PC.delivery.quantityTonnes, makerLei: SCREW_LEI, goodSAID: cred.S1.core.d });
  ship["WR-U"] = await claimFor(w, cred.M1, { batchId: "WR-U", quantityTonnes: "45", makerLei: SCREW_LEI, goodSAID: cred.S2.core.d });
  ship["WR-O"] = await claimFor(w, cred.M1, { batchId: "WR-O", quantityTonnes: "45", makerLei: SCREW_LEI, goodSAID: cred.S8.core.d });
  ship["WR-R"] = await claimFor(w, cred.M2, { batchId: "WR-R", quantityTonnes: "45", makerLei: SCREW_LEI, goodSAID: cred.S3.core.d });
  ship["WR-P"] = await claimFor(w, cred.M3, { batchId: "WR-P", quantityTonnes: "45", makerLei: SCREW_LEI, goodSAID: cred.S4.core.d });
  ship["WR-C"] = await claimFor(w, cred.M4, { batchId: "WR-C", quantityTonnes: "45", makerLei: SCREW_LEI, goodSAID: cred.S5.core.d });
  ship["WR-X"] = { batchId: "WR-X", quantityTonnes: "45", shipmentDate: "2026-06-30", importerSalt: newSalt() }; // never claimable
  // the second maker's 500 t: more than the 1000 − 562.5 − 45 − 45 = 347.5 t left on the mill's report
  ship[PC.secondScrewMaker.batchId] = { batchId: PC.secondScrewMaker.batchId, quantityTonnes: PC.secondScrewMaker.quantityTonnes, shipmentDate: "2026-07-15", importerSalt: newSalt() };
  try {
    await send(c, w.millSupplier, "registry", "claimShipment", claimArgsOf(cred.M1, { batchId: PC.secondScrewMaker.batchId, quantityTonnes: PC.secondScrewMaker.quantityTonnes, importerEORI: SECOND_LEI, importerSalt: ship[PC.secondScrewMaker.batchId].importerSalt }));
  } catch (e) {
    secondClaimError = e;
  }

  // ---- the screw maker's own shipment to the EU importer, and the mill revoking report M2 after its claim
  screwShipment = { batchId: "BATCH-DEMO-2026-0001", quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: newSalt() };
  await send(c, w.screwSupplier, "registry", "claimShipment", claimArgsOf(cred.S1, { ...screwShipment, importerEORI: IMPORTER_EORI }));
  await send(c, w.signer.mill, "registry", "revokeReport", [reportKeyOf(cred.M2.core.d)]);
}, 120_000);

afterAll(() => c?.stop());

describe("check 9: precursor chain of trust (local anvil)", () => {
  it("the demo screw report backed by the mill's verified wire rod: VALID, 1.8 = 0.18 + 1.125 × 1.44", async () => {
    const r = await verify(screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment));
    expect(status(r)).toEqual({ 0: "pass:", 1: "pass:", 2: "pass:", 3: "pass:", 4: "pass:", 5: "pass:", 6: "pass:", 7: "pass:", 8: "skipped:", 9: "pass:" });
    expect(r.overall).toBe("VALID");
    const p = r.precursors!;
    expect(p).toMatchObject({ signed: true, attributedDirect: "0.18", declared: "1.8", precursorTotal: "1.62", recomputed: "1.8", difference: "0", goodVerifiedTonnes: "500" });
    const line = p.lines[0];
    expect(line).toMatchObject({ status: "pass", see: "1.44", contribution: "1.62", claimedTonnes: "562.5", neededTonnes: "562.5", producer: { lei: PC.mill.lei, cnCode: "7213", verifierLEI: PC.body.lei } });
    expect(line.verification!.overall).toBe("VALID");
    expect(line.verification!.checks.find((x) => x.index === 5)?.detail).toBe("562.5 t declared to you on the shared ledger");
    expect(r.checks[9].detail).toContain("1 verified precursor credential");
    // the verdict carries check 9 and the breakdown, and conforms to the schema
    const v = toVerdict(screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment), r, { chainId: 31337, block: r.atBlock, trustAnchor: w.chain.trustAnchor });
    expect(verdictSchemaErrors(v)).toEqual([]);
    expect(v.checks.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(v.precursors?.recomputed).toBe("1.8");
  });

  it("cap one tier up: a second screw maker's 500 t of the same wire rod reverts with ExceedsVerifiedTonnage on the mill's report", async () => {
    expect(secondClaimError).toBeInstanceOf(BaseError);
    const revert = (secondClaimError as BaseError).walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError;
    expect(revert.data?.errorName).toBe("ExceedsVerifiedTonnage");
    expect(revert.data?.args).toEqual([347_500n, 500_000n]);
    expect(await c.reader.remainingKg(reportKeyOf(cred.M1.core.d))).toBe(347_500n);
    // the second maker's proof names a batch that was never claimed: its precursor tier fails
    const r = await verify(screwProof("B", [{ m: "M1", b: PC.secondScrewMaker.batchId }]));
    expect(r.overall).toBe("INVALID");
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/CREDENTIAL");
    expect(r.precursors!.lines[0].verification!.checks.find((x) => x.index === 5)).toMatchObject({ status: "fail", code: "SHIPMENT_MISMATCH", detail: "no claim for this batch on the registry" });
  });

  it("the second maker cannot reuse the first maker's claimed batch: the claim is committed to the first maker's LEI", async () => {
    // Even with its own body signing a statement that names the first maker's batch WR-A, the claim's importerCommit is
    // the first maker's LEI and credential, so check 5 of the mill's proof (bound to the second maker's LEI and credential) fails.
    const s = statementOf([wireRodLine(cred.M1, "WR-A", "1.25")]);
    const bad = await issueAs(w, "screw", screwClaims({ supplierLEI: SECOND_LEI, operatorId: `TW${SECOND_LEI}`, installationId: `TW-${SECOND_LEI}-0002`, verificationReportId: "VR-DEMO-T10", verifiedTonnes: "400", specificEmbeddedEmissions_tCO2e_per_t: "1.98" }), { statement: s });
    const p = proofOf(w, "screw", bad, { precursorEvidence: { statement: s, proofs: [proofOf(w, "mill", cred.M1, { shipment: ship["WR-A"] })] } });
    const r = await verify(p);
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/CREDENTIAL");
    expect(r.precursors!.lines[0].verification!.checks.find((x) => x.index === 5)).toMatchObject({ status: "fail", detail: "the batch was not declared to your EORI" });
  });

  it("precursor credential signed by a body that is not on the allowlist: it cannot be registered, so check 9 fails", async () => {
    await expect(register(w, "mill", cred.MX, w.millSupplier, c.other)).rejects.toThrow(/NotActiveVerifier/);
    const r = await verify(screwProof("S6", [{ m: "MX", b: "WR-X" }]));
    expect(r.overall).toBe("INVALID");
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/CREDENTIAL");
    const mill = r.precursors!.lines[0].verification!;
    expect(mill.overall).toBe("INVALID");
    expect(mill.checks.find((x) => x.index === 4)?.code).toBe("REPORT_INVALID/NOT_REGISTERED");
    expect(r.checks[9].detail).toContain("REPORT_INVALID/NOT_REGISTERED");
  });

  it("precursor report revoked by the mill's body after the claim: check 9 fails", async () => {
    const r = await verify(screwProof("S3", [{ m: "M2", b: "WR-R" }]));
    expect(r.overall).toBe("INVALID");
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/CREDENTIAL");
    const mill = r.precursors!.lines[0].verification!;
    expect(mill.checks.find((x) => x.index === 4)?.code).toBe("REPORT_INVALID/REVOKED");
    expect(mill.checks.find((x) => x.index === 5)?.detail).toBe("the report was revoked after the claim");
  });

  it("declared screw SEE below direct + precursor emissions (1.6 < 1.8): INVALID, SEE_UNDERSTATED", async () => {
    const r = await verify(screwProof("S2", [{ m: "M1", b: "WR-U" }]));
    expect(r.overall).toBe("INVALID");
    expect(r.primaryCode).toBe("PRECURSOR_INVALID/SEE_UNDERSTATED");
    expect(r.precursors).toMatchObject({ declared: "1.6", recomputed: "1.8", difference: "-0.2" });
    expect(r.precursors!.lines[0].status).toBe("pass");
  });

  it("declared screw SEE above the recomputation (2.1 > 1.8): advisory SEE_OVERSTATED, overall unchanged", async () => {
    const r = await verify(screwProof("S8", [{ m: "M1", b: "WR-O" }]));
    expect(status(r)[9]).toBe("warn:PRECURSOR_WARNING/SEE_OVERSTATED");
    expect(r.overall).toBe("VALID");
  });

  it("precursor from a later period than the screw report: SCOPE", async () => {
    const r = await verify(screwProof("S4", [{ m: "M3", b: "WR-P" }]));
    expect(r.overall).toBe("INVALID");
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/SCOPE");
    expect(r.precursors!.lines[0].verification!.overall).toBe("VALID");
    expect(r.checks[9].detail).toContain("2027-01-01/2027-12-31 starts after the good's period 2026-01-01/2026-12-31 ends");
  });

  it("precursor outside the mill body's CN scope (7208, accredited for 7213 only): its check 7 and the CN rule fail", async () => {
    const r = await verify(screwProof("S5", [{ m: "M4", b: "WR-C" }]));
    expect(r.overall).toBe("INVALID");
    const line = r.precursors!.lines[0];
    expect(line.verification!.checks.find((x) => x.index === 7)).toMatchObject({ status: "fail", detail: "accreditation scope does not include CN 7208" });
    expect(["PRECURSOR_INVALID/CREDENTIAL", "PRECURSOR_INVALID/SCOPE"]).toContain(line.code);
  });

  it("claimed wire rod below m × the screw tonnes: MASS_NOT_COVERED", async () => {
    // a 500 t screw credential backed by a 45 t claim (562.5 t needed): its own batch WR-T, claimed for it
    const s = statementOf([wireRodLine(cred.M1, "WR-T")]);
    const thin = await issueAs(w, "screw", screwClaims({ installationId: screwInst(9), verificationReportId: "VR-DEMO-T11" }), { statement: s });
    await register(w, "screw", thin, w.screwSupplier);
    const sh = await claimFor(w, cred.M1, { batchId: "WR-T", quantityTonnes: "45", makerLei: SCREW_LEI, goodSAID: thin.core.d });
    const r = await verify(proofOf(w, "screw", thin, { precursorEvidence: { statement: s, proofs: [proofOf(w, "mill", cred.M1, { shipment: sh })] } }));
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/MASS_NOT_COVERED");
    expect(r.precursors!.lines[0]).toMatchObject({ claimedTonnes: "45", neededTonnes: "562.5" });
  });

  it("tampered statement (another mass per tonne): DIGEST_MISMATCH", async () => {
    const r = await verify(screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment, statementOf([wireRodLine(cred.M1, "WR-A", "1.0")])));
    expect(r.overall).toBe("INVALID");
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/DIGEST_MISMATCH");
  });

  it("statement withheld by the supplier: check 9 not run, INCOMPLETE with PRECURSORS_NOT_CHECKED", async () => {
    const p = proofOf(w, "screw", cred.S1, { shipment: screwShipment });
    const r = await verify(p);
    expect(status(r)[9]).toBe("skipped:");
    expect(r.overall).toBe("INCOMPLETE");
    expect(r.warnings?.map((x) => x.code)).toEqual(["PRECURSORS_NOT_CHECKED"]);
  });

  it("producer's proof withheld: INCOMPLETE", async () => {
    const r = await verify(screwProof("S1", [{}], screwShipment));
    expect(status(r)[9]).toBe("skipped:");
    expect(r.overall).toBe("INCOMPLETE");
  });

  it("precursor default used: advisory flag, the mass balance still recomputed", async () => {
    const r = await verify(screwProof("S7", [{}]));
    expect(status(r)[9]).toBe("warn:PRECURSOR_WARNING/DEFAULT_USED");
    expect(r.overall).toBe("VALID");
    expect(r.checks[9].detail).toContain("precursor default used for CN 7213");
    expect(r.precursors!.recomputed).toBe("1.8");
  });

  it("the mill tier pinned to the demo root instead of the synthetic one: its check 7 fails (no second root is trusted silently)", async () => {
    const r = await verify(screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment), IMPORTER_EORI, vleiCheckers({ trustAnchor: w.chain.trustAnchor, precursorTrustAnchor: DEMO_TRUST_ANCHOR }));
    expect(status(r)[9]).toBe("fail:PRECURSOR_INVALID/CREDENTIAL");
    expect(r.precursors!.lines[0].verification!.checks.find((x) => x.index === 7)?.detail).toBe("QVI credential not issued by the configured root of trust");
  });

  it("without a precursor checker, a committed statement leaves the result INCOMPLETE", async () => {
    const { precursors: _, ...noPrecursors } = checkers();
    const r = await verify(screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment), IMPORTER_EORI, noPrecursors);
    expect(status(r)[9]).toBe("skipped:");
    expect(r.overall).toBe("INCOMPLETE");
  });

  it("CLI: verify --json carries check 9 and the breakdown (schema-valid, exit 0); the text output lists the precursor lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "carbonlei-precursor-"));
    try {
      writeFileSync(join(dir, "deployment.json"), JSON.stringify(c.deployment));
      writeFileSync(join(dir, "proof.json"), JSON.stringify(screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment)));
      const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
      const args = ["verify", "--proof", join(dir, "proof.json"), "--rpc", c.rpc, "--deployment", join(dir, "deployment.json"), "--eori", IMPORTER_EORI, "--trust-anchor", w.chain.trustAnchor];
      const j = await run(process.execPath, [cli, ...args, "--json"]);
      const v = JSON.parse(j.stdout);
      expect(verdictSchemaErrors(v)).toEqual([]);
      expect(v.overall).toBe("VALID");
      expect(v.checks[9]).toMatchObject({ id: 9, name: "Precursors", status: "pass" });
      expect(v.precursors.lines[0].verification.checks.map((x: { id: number }) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const t = await run(process.execPath, [cli, ...args]);
      expect(t.stdout).toContain("PASS  9 Precursors");
      expect(t.stdout).toContain("+ CN 7213: 1.125 t/t × 1.44 = 1.62 tCO2e/t  [PASS]");
      expect(t.stdout).toContain("= 1.8 recomputed vs 1.8 declared (tolerance 0.01)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PACT export: the boundary note says precursors are included when check 9 passed; a failed check 9 exports nothing", async () => {
    const product = { companyName: "Demo Fasteners Co. (fictional)", productNameCompany: "Hex bolt (illustrative)", productDescription: "Hex bolts (illustrative)", productId: "HB-1" };
    const good = screwProof("S1", [{ m: "M1", b: "WR-A" }], screwShipment);
    const pf = (await exportPactFromProof(good, await verify(good), c.reader, product)) as { pcf: { boundaryProcessesDescription: string; pcfExcludingBiogenicUptake: string } };
    expect(pf.pcf.boundaryProcessesDescription).toBe(boundaryWithPrecursors(1, 0));
    expect(pf.pcf.boundaryProcessesDescription).toContain("including the precursors' embedded direct emissions (1 from verified precursor credential");
    expect(pf.pcf.pcfExcludingBiogenicUptake).toBe("1.8");
    const low = screwProof("S2", [{ m: "M1", b: "WR-U" }]);
    await expect(exportPactFromProof(low, await verify(low), c.reader, product)).rejects.toThrow(/fails check 9 \(PRECURSOR_INVALID\/SEE_UNDERSTATED/);
    const withheld = proofOf(w, "screw", cred.S1, { shipment: screwShipment });
    await expect(exportPactFromProof(withheld, await verify(withheld), c.reader, product)).rejects.toThrow(/INCOMPLETE/);
    expect(BOUNDARY).toBe("CBAM embedded direct emissions — not a full product carbon footprint");
  });

  it("evidence on a credential without a precursorDigest: advisory UNSIGNED, overall decided by checks 0–8 alone", async () => {
    const plain = await issueAs(w, "screw", screwClaims({ installationId: `TW-${SCREW_LEI}-0010`, verificationReportId: "VR-DEMO-T12" }));
    await register(w, "screw", plain, w.screwSupplier);
    const p = proofOf(w, "screw", plain, { precursorEvidence: { statement: st.S1, proofs: [proofOf(w, "mill", cred.M1, { shipment: ship["WR-A"] })] } });
    const r = await verify(p);
    expect(status(r)[9]).toBe("warn:PRECURSOR_WARNING/UNSIGNED");
    expect(r.overall).toBe("VALID");
    expect(precursorDigestOf(st.S1)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("check 9: a CONTESTED precursor makes the good CONTESTED", () => {
  let c2: LocalChain;
  afterAll(() => c2?.stop());
  it("the mill's auditor is revoked within 24 h after the mill report's registration", async () => {
    c2 = await startLocalChain(22645 + Math.floor(Math.random() * 1000));
    const w2 = await setupWorld(c2);
    const m = await issueAs(w2, "mill", millClaims());
    const s = statementOf([wireRodLine(m, "WR-A")]);
    const sc = await issueAs(w2, "screw", screwClaims(), { statement: s });
    await register(w2, "mill", m, w2.millSupplier);
    await register(w2, "screw", sc, w2.screwSupplier);
    const sh = await claimFor(w2, m, { batchId: "WR-A", quantityTonnes: "562.5", makerLei: SCREW_LEI, goodSAID: sc.core.d });
    const { auditorAidHashOf, leiHashOf } = await import("../commitment.ts");
    await send(c2, c2.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(w2.chain.bodies.mill.auditorAid), leiHashOf(PC.body.lei)]);
    const p = proofOf(w2, "screw", sc, { precursorEvidence: { statement: s, proofs: [proofOf(w2, "mill", m, { shipment: sh })] } });
    const r = await verifyPresentation(p, c2.reader, { checkers: vleiCheckers({ trustAnchor: w2.chain.trustAnchor }) });
    expect(status(r)[9]).toBe("warn:CONTESTED");
    expect(r.overall).toBe("CONTESTED");
    expect(r.precursors!.lines[0].verification!.overall).toBe("CONTESTED");
  }, 60_000);
});
