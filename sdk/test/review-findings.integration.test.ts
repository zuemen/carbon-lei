// Regression tests for findings 3–6 and the fan-out finding of the review of 17 October 2026 (our own AI-run review,
// not an external audit). Each test failed on the code before the fix (main 1b6b5c9) and passes after it. Local anvil
// chain only; nothing here runs on Sepolia.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CarbonPriceEvidence, CarbonPriceStatement } from "../carbonprice.ts";
import { vleiCheckers } from "../checkers.ts";
import { batchKeyOf, reportKeyOf } from "../commitment.ts";
import { pickReconciledClaims, reconcile, type ReportExtract } from "../consistency.ts";
import type { CredentialClaims } from "../credential.ts";
import type { Presentation, ShipmentPart } from "../disclosure.ts";
import { newSalt } from "../encoding.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, type SignedCredential } from "../issue.ts";
import type { PrecursorEvidence, PrecursorLineResult, PrecursorReport, PrecursorStatement } from "../precursor.ts";
import { verifyPresentation, type VerificationResult } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";
import { IMPORTER_EORI, PC, SCREW_LEI, claimFor, issueAs, millClaims, proofOf, register, screwClaims, statementOf, wireRodLine } from "../../scripts/precursor-scenario.ts";
import { claimAgainst, evidenceFor, millOverrides, registerStatement, setupCarbonWorld, statementFor, type CarbonWorld } from "../../scripts/carbonprice-scenario.ts";

const status = (r: VerificationResult, i: number) => {
  const x = r.checks.find((c) => c.index === i);
  return `${x?.status}:${x?.code}`;
};
const screwInst = (n: number) => `TW-${SCREW_LEI}-00${String(n).padStart(2, "0")}`;
const millInst = (n: number) => `TW-${PC.mill.lei}-00${String(n).padStart(2, "0")}`;

let c: LocalChain;
let w: CarbonWorld;
const ch = () => vleiCheckers({ trustAnchor: w.chain.trustAnchor });
const verify = (p: Presentation, eori: string | undefined = IMPORTER_EORI) =>
  verifyPresentation(p, c.reader, { ...(eori ? { importerEORI: eori } : {}), checkers: ch() });

beforeAll(async () => {
  c = await startLocalChain(26545 + Math.floor(Math.random() * 1000));
  w = await setupCarbonWorld(c);
}, 120_000);
afterAll(() => c?.stop());

describe("finding 3: one claimed precursor batch backs one good credential", () => {
  it("two screw credentials of the same maker cannot rely on the same claimed wire-rod batch", async () => {
    const M1 = await issueAs(w, "mill", millClaims({ installationId: millInst(31), verificationReportId: "VR-REV-M31" }));
    const st = statementOf([wireRodLine(M1, "WR-A")]);
    const S1 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(31), verificationReportId: "VR-REV-S31" }), { statement: st }); // 500 t, needs 562.5 t
    const S9 = await issueAs(w, "screw", screwClaims({ installationId: screwInst(39), verificationReportId: "VR-REV-S39" }), { statement: st }); // another 500 t
    await register(w, "mill", M1, w.millSupplier);
    await register(w, "screw", S1, w.screwSupplier);
    await register(w, "screw", S9, w.screwSupplier);
    // The mill claims 562.5 t once, for the screw maker and the credential S1.
    const wr = await claimFor(w, M1, { batchId: "WR-A", quantityTonnes: PC.delivery.quantityTonnes, makerLei: SCREW_LEI, goodSAID: S1.core.d });
    const pr = (s: SignedCredential): Presentation => proofOf(w, "screw", s, { precursorEvidence: { statement: st, proofs: [proofOf(w, "mill", M1, { shipment: wr })] } });
    const r1 = await verify(pr(S1));
    const r9 = await verify(pr(S9));
    console.log("S1", r1.overall, status(r1, 9), "S9", r9.overall, status(r9, 9), r9.precursors?.lines[0].verification?.checks.find((x) => x.index === 5)?.detail);
    expect(r1.overall).toBe("VALID");
    expect(r1.precursors!.lines[0]).toMatchObject({ claimedTonnes: "562.5", neededTonnes: "562.5" });
    expect(r9.overall).toBe("INVALID");
    expect(status(r9, 9)).toBe("fail:PRECURSOR_INVALID/CREDENTIAL");
    expect(r9.precursors!.lines[0].verification!.checks.find((x) => x.index === 5)).toMatchObject({ status: "fail", detail: "the batch was not declared to your EORI" });
  }, 120_000);
});

describe("findings 4 and 5: check 10", () => {
  let M1: SignedCredential, U: SignedCredential;
  let wr: ShipmentPart, b1: ShipmentPart, b2: ShipmentPart;
  let ev: CarbonPriceEvidence;
  let good: CarbonPriceStatement;
  beforeAll(async () => {
    M1 = await issueAs(w, "mill", millClaims({ ...millOverrides }));
    U = await issueAs(w, "screw", screwClaims({ installationId: screwInst(41), verificationReportId: "VR-REV-U41", verifiedTonnes: "500" })); // NO precursorDigest
    await register(w, "mill", M1, w.millSupplier);
    await register(w, "screw", U, w.screwSupplier);
    const importerSalt = newSalt();
    await send(c, w.millSupplier, "registry", "claimShipment", claimArgsOf(M1, { batchId: "WR-U", quantityTonnes: "1000", importerEORI: SCREW_LEI, importerSalt }));
    wr = { batchId: "WR-U", quantityTonnes: "1000", shipmentDate: "2026-06-30", importerSalt };
    const cps = statementFor(w, M1);
    await registerStatement(w, cps);
    ev = await evidenceFor(w, cps, (await claimAgainst(w, cps, { batchId: "CP-U", quantityTonnes: "1000", beneficiary: SCREW_LEI })).claim);
    good = statementFor(w, M1, {
      operator: { name: "Demo Fasteners Co. (fictional)", lei: SCREW_LEI, installationId: screwInst(41) },
      cnCode: "7318",
      credentials: [U.core.d],
      cpmEmissions: "27000",
      exemptEmissions: "25000",
      adjustment: { thresholdK: "25000", factor: "1" },
      feePaid: "600000",
      productionTonnes: "150000",
      emissionsPerTonne: "0.18",
      certificationReportId: "CPR-REV-GOOD",
    });
    await registerStatement(w, good, { supplier: w.screwSupplier });
    b1 = { batchId: "B1", quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: newSalt() };
    b2 = { batchId: "B2", quantityTonnes: "200", shipmentDate: "2026-10-11", importerSalt: newSalt() };
    await send(c, w.screwSupplier, "registry", "claimShipment", claimArgsOf(U, { ...b1, importerEORI: IMPORTER_EORI }));
    await send(c, w.screwSupplier, "registry", "claimShipment", claimArgsOf(U, { ...b2, importerEORI: IMPORTER_EORI }));
  }, 240_000);

  it("finding 4: an unsigned precursor statement cannot set the mass factor of the deduction (m = 1.125 or 2)", async () => {
    const pe = (m: string) => ({ statement: statementOf([wireRodLine(M1, "WR-U", m)]), proofs: [proofOf(w, "mill", M1, { shipment: wr })] }) as PrecursorEvidence;
    for (const m of ["1.125", "2"]) {
      const p: Presentation = { ...proofOf(w, "screw", U, { shipment: b1, precursorEvidence: pe(m) }), carbonPriceEvidence: ev };
      const r = await verify(p);
      console.log(`m=${m}`, r.overall, status(r, 9), status(r, 10), r.carbonPrice?.deductibleEurPerTonneGood);
      expect(status(r, 9)).toBe("warn:PRECURSOR_WARNING/UNSIGNED");
      expect(status(r, 10)).toBe("skipped:");
      expect(r.overall).toBe("INCOMPLETE");
      expect(r.warnings?.map((x) => x.code)).toContain("CARBON_PRICE_NOT_CHECKED");
      expect(r.carbonPrice?.deductibleEurPerTonneGood ?? null).toBeNull();
    }
  }, 120_000);

  it("finding 5: one carbon price claim on the good covers one shipment, not two", async () => {
    const reportKey = reportKeyOf(U.core.d);
    const bk = (s: ShipmentPart) => batchKeyOf(reportKey, s.batchId, U.claims.batchSalt);
    // A claim bound to shipment B1 (the importer's EORI and B1's batch key).
    const bound = await evidenceFor(w, good, (await claimAgainst(w, good, { batchId: "CP-G1", quantityTonnes: "200", beneficiary: IMPORTER_EORI, shipmentBatchKey: bk(b1), from: w.screwSupplier })).claim, { signer: w.screwSupplier });
    const out: Record<string, VerificationResult> = {};
    for (const s of [b1, b2]) {
      out[s.batchId] = await verify({ ...proofOf(w, "screw", U, { shipment: s }), carbonPriceEvidence: bound });
      console.log(s.batchId, out[s.batchId].overall, status(out[s.batchId], 10), out[s.batchId].carbonPrice?.claim);
    }
    expect(out.B1.overall).toBe("VALID");
    expect(out.B1.checks.find((x) => x.index === 10)?.status).toMatch(/^(pass|warn)$/); // advisory FX_YEAR at most
    expect(out.B2.overall).toBe("INVALID");
    expect(status(out.B2, 10)).toBe("fail:CARBON_PRICE_INVALID/NOT_CLAIMED");
    // A claim committed to the importer's EORI alone (the format before the fix) covers no shipment.
    const loose = await evidenceFor(w, good, (await claimAgainst(w, good, { batchId: "CP-G", quantityTonnes: "200", beneficiary: IMPORTER_EORI, from: w.screwSupplier })).claim, { signer: w.screwSupplier });
    const r = await verify({ ...proofOf(w, "screw", U, { shipment: b2 }), carbonPriceEvidence: loose });
    expect(status(r, 10)).toBe("fail:CARBON_PRICE_INVALID/NOT_CLAIMED");
  }, 120_000);
});

describe("finding 6: check 8 on a credential that commits to a reconciliation", () => {
  const extract = JSON.parse(readFileSync(new URL("../../fixtures/report-VR-DEMO-0001.json", import.meta.url), "utf8")).extract as ReportExtract;
  /** A screw credential whose core carries the reconciliation of `x` (as the body signs it at issuance). */
  async function issueReconciled(n: number, over: Partial<CredentialClaims>, x: Partial<ReportExtract>) {
    const claims = screwClaims({ installationId: screwInst(n), verificationReportId: `VR-REV-R${n}`, ...over });
    const ex = { ...extract, installationId: claims.installationId, reportId: claims.verificationReportId, reportingPeriod: claims.reportingPeriod, ...x } as ReportExtract;
    const cred = await issueCredential({
      claims,
      auditorAID: w.chain.bodies.screw.auditorAid,
      signer: w.signer.screw,
      registry: w.registry,
      chainId: 31337,
      reconciliation: reconcile(ex, pickReconciledClaims(claims as unknown as Record<string, string>)!).reconciliation,
    });
    w.issued.screw.push(cred.core.d);
    await register(w, "screw", cred, w.screwSupplier);
    return { cred, ex };
  }
  const proofWith = (cred: SignedCredential, reportExtract?: unknown): Presentation => {
    const { reportExtract: _, ...p } = { ...proofOf(w, "screw", cred), reportExtract };
    return reportExtract === undefined ? p : { ...p, reportExtract: reportExtract as Record<string, unknown> };
  };

  it("a compliant signed extract stays VALID", async () => {
    const { cred, ex } = await issueReconciled(61, {}, {});
    const r = await verify(proofWith(cred, ex), undefined);
    expect(status(r, 8)).toBe("pass:");
    expect(r.overall).toBe("VALID");
  }, 120_000);

  it("a signed extract that breaks a sub-rule cannot be turned VALID by changing or dropping the extract", async () => {
    // A "verification statement" for a period ending 30 November 2026, dated 20 December 2026 (before January 2027).
    const { cred, ex } = await issueReconciled(62, { reportingPeriod: "2026-01-01/2026-11-30" }, { signedAt: "2026-12-20" });
    const signed = await verify(proofWith(cred, ex), undefined);
    expect(status(signed, 8)).toBe("fail:VERIFICATION_RULE/REPORT_BEFORE_FIRST_ISSUE_DATE");
    expect(signed.overall).toBe("INVALID");
    const hidden = present(cred, DEMO_DISCLOSURE.filter((n) => n !== "materialityThreshold")).disclosures;
    const variants: [string, unknown, string[]?][] = [
      ["one extra field", { ...ex, note: "x" }],
      ["signedAt moved to 2027-03-15", { ...ex, signedAt: "2027-03-15" }],
      ["extract dropped", undefined],
      ["a reconciled field hidden", ex, hidden],
    ];
    for (const [label, x, disclosures] of variants) {
      const r = await verify({ ...proofWith(cred, x), ...(disclosures ? { disclosures } : {}) }, undefined);
      console.log(label.padEnd(30), r.overall, status(r, 8));
      expect(r.overall, label).not.toBe("VALID");
      expect(r.overall, label).toBe("INCOMPLETE");
      expect(status(r, 8), label).toBe("skipped:");
      // Not decided: no sub-rule is reported, not even a "pass" computed on the changed extract.
      expect(r.checks.find((c) => c.index === 8)?.rules, label).toBeUndefined();
      expect(r.warnings?.map((x) => x.code), label).toContain("RECONCILIATION_NOT_CHECKED");
    }
  }, 120_000);

  it("check 8 not decided reports no sub-rule, not even a pass computed on the changed extract", async () => {
    // QA 17 October: a compliant signed extract with one field changed showed check 8 "not run" but kept every
    // sub-rule computed from the changed extract as "passed" (the CLI printed pass lines under SKIP 8).
    const { cred, ex } = await issueReconciled(63, {}, {});
    const signed = await verify(proofWith(cred, ex), undefined);
    expect(status(signed, 8)).toBe("pass:");
    expect(signed.checks.find((c) => c.index === 8)?.rules?.length).toBeGreaterThan(0);
    for (const [label, x] of [
      ["signedAt moved", { ...ex, signedAt: "2027-03-20" }],
      ["one extra field", { ...ex, note: "x" }],
    ] as [string, unknown][]) {
      const r = await verify(proofWith(cred, x), undefined);
      const c8 = r.checks.find((c) => c.index === 8);
      expect(r.overall, label).toBe("INCOMPLETE");
      expect(c8?.status, label).toBe("skipped");
      expect(c8?.detail, label).toMatch(/^not decided/);
      expect(c8?.rules, label).toBeUndefined();
    }
  }, 120_000);
});

describe("fan-out: precursor recursion is bounded", () => {
  /** Counts every producer proof verification in a check 9 breakdown, all tiers. */
  const nested = (p: PrecursorReport | undefined): number =>
    (p?.lines ?? []).reduce((n: number, l: PrecursorLineResult) => n + (l.verification ? 1 + nested(l.verification.precursors) : 0), 0);

  it("unsigned precursor evidence (no precursorDigest) is advisory and verifies no producer proof", async () => {
    const M = await issueAs(w, "mill", millClaims({ installationId: millInst(71), verificationReportId: "VR-REV-M71" }));
    const U = await issueAs(w, "screw", screwClaims({ installationId: screwInst(71), verificationReportId: "VR-REV-U71" }));
    const tree = (b: string, fan: number, depth: number): Presentation => {
      const base = proofOf(w, "mill", M, { shipment: { batchId: b, quantityTonnes: "1", shipmentDate: "2026-06-30", importerSalt: newSalt() } });
      if (depth === 0) return base;
      const ids = Array.from({ length: fan }, (_, i) => `${b}.${i}`);
      return { ...base, precursorEvidence: { statement: statementOf(ids.map((id) => wireRodLine(M, id))), proofs: ids.map((id) => tree(id, fan, depth - 1)) } as PrecursorEvidence };
    };
    const ids = Array.from({ length: 16 }, (_, i) => `X${i}`);
    const p: Presentation = { ...proofOf(w, "screw", U), precursorEvidence: { statement: statementOf(ids.map((id) => wireRodLine(M, id))), proofs: ids.map((id) => tree(id, 16, 1)) } as PrecursorEvidence };
    const r = await verify(p, undefined);
    console.log("unsigned 16×16:", r.overall, status(r, 9), "producer verifications:", nested(r.precursors));
    expect(status(r, 9)).toBe("warn:PRECURSOR_WARNING/UNSIGNED");
    expect(nested(r.precursors)).toBe(0);
  }, 300_000);

  it("a signed 16 × 16 precursor tree stops at MAX_PRECURSOR_NODES producer verifications (the rest not checked)", async () => {
    const { MAX_PRECURSOR_NODES } = (await import("../precursor.ts")) as { MAX_PRECURSOR_NODES?: number };
    const M = await issueAs(w, "mill", millClaims({ installationId: millInst(81), verificationReportId: "VR-REV-M81" }));
    const qs = Array.from({ length: 16 }, (_, j) => `Q${j}`);
    const stMp: PrecursorStatement = statementOf(qs.map((q) => wireRodLine(M, q, "0.01")), "1.4");
    const Mp = await issueAs(w, "mill", millClaims({ installationId: millInst(82), verificationReportId: "VR-REV-M82" }), { statement: stMp });
    const ps = Array.from({ length: 16 }, (_, i) => `P${i}`);
    const stG: PrecursorStatement = statementOf(ps.map((b) => wireRodLine(Mp, b, "0.01")), "1.5");
    const G = await issueAs(w, "screw", screwClaims({ installationId: screwInst(81), verificationReportId: "VR-REV-G81" }), { statement: stG });
    const mp = (b: string): Presentation => ({
      ...proofOf(w, "mill", Mp, { shipment: { batchId: b, quantityTonnes: "1", shipmentDate: "2026-06-30", importerSalt: newSalt() } }),
      precursorEvidence: { statement: stMp, proofs: qs.map((q) => proofOf(w, "mill", M, { shipment: { batchId: q, quantityTonnes: "1", shipmentDate: "2026-06-30", importerSalt: newSalt() } })) },
    });
    const p: Presentation = proofOf(w, "screw", G, { precursorEvidence: { statement: stG, proofs: ps.map(mp) } });
    const r = await verify(p, undefined);
    const n = nested(r.precursors);
    console.log("signed 16×16:", r.overall, status(r, 9), "producer verifications:", n);
    expect(MAX_PRECURSOR_NODES).toBe(32);
    expect(n).toBeLessThanOrEqual(32);
    expect(r.overall).not.toBe("VALID");
    expect(JSON.stringify(r.precursors)).toContain(`limit of ${MAX_PRECURSOR_NODES} producer proofs`);
  }, 600_000);
});
