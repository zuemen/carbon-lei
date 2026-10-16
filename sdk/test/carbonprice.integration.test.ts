// Check 10, carbon price paid (DRAFT CBAM Art 9 rules — not adopted, illustrative), on a local anvil chain: the wire-rod
// mill pays the Taiwan carbon fee, a fictional independent person certifies its statement (synthetic vLEI chain under
// the synthetic precursor root, pinned explicitly) and registers it in the same registry; the mill claims the wire
// rod it delivered to the screw maker against it. Covers the honest case (VALID, with the advisory on the exchange
// rate's year), and the attacks: a forged or wrong-role certifier, a certifier not on the allowlist, an operator
// signature from another key, double use of the same statement (over-claim reverts with ExceedsVerifiedTonnage;
// reuse without a claim, or with fewer tonnes than needed, fails), a manipulated exchange rate, a tampered or
// re-SAID'd statement, another period, a revoked statement, a revoked certifier (CONTESTED), and no pinned rate
// (INCOMPLETE). Nothing here runs on Sepolia.
import { BaseError, ContractFunctionRevertedError } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRAFT_LABEL, carbonPriceKeys, saidifyStatement, type CarbonPriceEvidence, type CarbonPriceStatement } from "../carbonprice.ts";
import { vleiCheckers } from "../checkers.ts";
import { auditorAidHashOf, leiHashOf } from "../commitment.ts";
import type { Presentation, ShipmentPart } from "../disclosure.ts";
import { newSalt } from "../encoding.ts";
import { claimArgsOf, type SignedCredential } from "../issue.ts";
import { exportPactFromProof } from "../pact.ts";
import { buildPortfolio } from "../portfolio.ts";
import type { PrecursorEvidence, PrecursorStatement } from "../precursor.ts";
import { toVerdict } from "../verdict.ts";
import { verifyPresentation, type VerificationResult } from "../verify.ts";
import { DEMO_TRUST_ANCHOR } from "../vlei.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";
import { IMPORTER_EORI, PC, SCREW_LEI, issueAs, millClaims, proofOf, register, screwClaims, statementOf, wireRodLine } from "../../scripts/precursor-scenario.ts";
import { claimAgainst, evidenceFor, millOverrides, registerStatement, setupCarbonWorld, statementFor, type CarbonWorld } from "../../scripts/carbonprice-scenario.ts";

const millInst = (n: number) => `TW-${PC.mill.lei}-000${n}`;
const screwInst = (n: number) => `TW-${SCREW_LEI}-000${n}`;
const SECOND_LEI: string = PC.secondScrewMaker.lei;
const c10 = (r: VerificationResult) => r.checks.find((x) => x.index === 10);

let c: LocalChain;
let w: CarbonWorld;
const mill: Record<string, SignedCredential> = {};
const screw: Record<string, SignedCredential> = {};
const pst: Record<string, PrecursorStatement> = {};
const wr: Record<string, ShipmentPart> = {};
const cps: Record<string, CarbonPriceStatement> = {};
const ev: Record<string, CarbonPriceEvidence> = {};
let shipment: ShipmentPart;
let overClaimError: unknown;
let impostorError: unknown;

const checkers = (over: Parameters<typeof vleiCheckers>[0] = {}) => vleiCheckers({ trustAnchor: w.chain.trustAnchor, ...over });
/** The screw proof of `s` (precursor tier: mill credential `m`, wire-rod batch `b`) with carbon price evidence `e`. */
const proof = (s: string, m: string, b: string, e?: CarbonPriceEvidence, ship?: ShipmentPart): Presentation => ({
  ...proofOf(w, "screw", screw[s], { ...(ship ? { shipment: ship } : {}), precursorEvidence: { statement: pst[s], proofs: [proofOf(w, "mill", mill[m], { shipment: wr[b] })] } as PrecursorEvidence }),
  ...(e ? { carbonPriceEvidence: e } : {}),
});
const verify = (p: Presentation, ch = checkers(), eori: string | null = IMPORTER_EORI) => verifyPresentation(p, c.reader, { ...(eori ? { importerEORI: eori } : {}), checkers: ch });
const revertName = (e: unknown) => (e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)?.data?.errorName : undefined);

/** A mill credential on installation `n`, its screw credential, the wire-rod claim for the screw maker. */
async function tier(n: number, opts: { screwTonnes?: string } = {}) {
  const k = String(n);
  mill[k] = await issueAs(w, "mill", millClaims({ ...millOverrides, ...(n > 1 ? { installationId: millInst(n), verificationReportId: `VR-DEMO-WR-CP${n}` } : {}) }));
  pst[k] = statementOf([wireRodLine(mill[k], `WR-${n}`)]);
  screw[k] = await issueAs(w, "screw", screwClaims({ ...(n > 1 ? { installationId: screwInst(n), verificationReportId: `VR-DEMO-CP${n}` } : {}), verifiedTonnes: opts.screwTonnes ?? "500" }), { statement: pst[k] });
  await register(w, "mill", mill[k], w.millSupplier);
  await register(w, "screw", screw[k], w.screwSupplier);
  const need = (Number(opts.screwTonnes ?? "500") * 1.125).toString();
  const importerSalt = newSalt();
  await send(c, w.millSupplier, "registry", "claimShipment", claimArgsOf(mill[k], { batchId: `WR-${n}`, quantityTonnes: need, importerEORI: SCREW_LEI, importerSalt }));
  wr[k] = { batchId: `WR-${n}`, quantityTonnes: need, shipmentDate: "2026-06-30", importerSalt };
}

beforeAll(async () => {
  c = await startLocalChain(23545 + Math.floor(Math.random() * 1000));
  w = await setupCarbonWorld(c);
  for (const n of [1, 2, 3, 4]) await tier(n);
  shipment = { batchId: "BATCH-CP-1", quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: newSalt() };
  await send(c, w.screwSupplier, "registry", "claimShipment", claimArgsOf(screw["1"], { ...shipment, importerEORI: IMPORTER_EORI }));

  // 1: the honest statement, claimed for the screw maker (562.5 t of wire rod)
  cps["1"] = statementFor(w, mill["1"]);
  await registerStatement(w, cps["1"]);
  ev["1"] = await evidenceFor(w, cps["1"], (await claimAgainst(w, cps["1"], { batchId: "CP-1", quantityTonnes: "562.5", beneficiary: SCREW_LEI })).claim);
  // double use: the same statement claimed beyond the 400,000 t it covers
  try {
    await claimAgainst(w, cps["1"], { batchId: "CP-1-over", quantityTonnes: "399438", beneficiary: SECOND_LEI });
  } catch (e) {
    overClaimError = e;
  }

  // 2: a small statement (600 t produced): 500 t claimed for the screw maker (562.5 t needed); a second maker's 150 t
  cps["2"] = statementFor(w, mill["2"], { operator: { name: PC.mill.name, lei: PC.mill.lei, installationId: millInst(2) }, productionTonnes: "600", cpmEmissions: "864", exemptEmissions: "691.2", feePaid: "51840", certificationReportId: "CPR-CP-2" });
  await registerStatement(w, cps["2"]);
  ev["2"] = await evidenceFor(w, cps["2"], (await claimAgainst(w, cps["2"], { batchId: "CP-2", quantityTonnes: "500", beneficiary: SCREW_LEI })).claim);

  // 3: revoked by the certifier body after registration
  cps["3"] = statementFor(w, mill["3"], { operator: { name: PC.mill.name, lei: PC.mill.lei, installationId: millInst(3) }, certificationReportId: "CPR-CP-3" });
  await registerStatement(w, cps["3"]);
  ev["3"] = await evidenceFor(w, cps["3"], (await claimAgainst(w, cps["3"], { batchId: "CP-3", quantityTonnes: "562.5", beneficiary: SCREW_LEI })).claim);
  await send(c, w.certifierSigner, "registry", "revokeReport", [carbonPriceKeys(cps["3"]).reportKey]);

  // 4: FX manipulated (30 TWD/EUR instead of the pinned 35.196), certified and registered as such
  cps["4"] = statementFor(w, mill["4"], { operator: { name: PC.mill.name, lei: PC.mill.lei, installationId: millInst(4) }, fx: { unitsPerEur: "30", year: 2025, source: "made up" }, certificationReportId: "CPR-CP-4" });
  await registerStatement(w, cps["4"]);
  ev["4"] = await evidenceFor(w, cps["4"], (await claimAgainst(w, cps["4"], { batchId: "CP-4", quantityTonnes: "562.5", beneficiary: SCREW_LEI })).claim);

  // another period for installation 1 (2027): registered, but the credential is for 2026
  cps.period = statementFor(w, mill["1"], { reportingPeriod: "2027-01-01/2027-12-31", certificationReportId: "CPR-CP-2027" });
  await registerStatement(w, cps.period);
  ev.period = await evidenceFor(w, cps.period, (await claimAgainst(w, cps.period, { batchId: "CP-P", quantityTonnes: "562.5", beneficiary: SCREW_LEI })).claim);

  // hypothetical: a statement on the screws themselves (a screw maker above the 25,000 t threshold), claimed for the importer
  cps.good = statementFor(w, mill["1"], {
    operator: { name: "Demo Fasteners Co. (fictional)", lei: SCREW_LEI, installationId: screwInst(1) },
    cnCode: "7318",
    credentials: [screw["1"].core.d],
    cpmEmissions: "27000",
    exemptEmissions: "25000",
    adjustment: { thresholdK: "25000", factor: "1" },
    feePaid: "600000",
    productionTonnes: "150000",
    emissionsPerTonne: "0.18",
    certificationReportId: "CPR-CP-SCREW",
  });
  await registerStatement(w, cps.good, { supplier: w.screwSupplier });
  ev.good = await evidenceFor(w, cps.good, (await claimAgainst(w, cps.good, { batchId: "CP-G", quantityTonnes: "200", beneficiary: IMPORTER_EORI, from: w.screwSupplier })).claim, { signer: w.screwSupplier });

  // a certifier not on the allowlist tries to register a statement
  cps.impostor = statementFor(w, mill["1"], { certificationReportId: "CPR-IMPOSTOR" });
  try {
    await registerStatement(w, cps.impostor, { signer: c.impostor });
  } catch (e) {
    impostorError = e;
  }
}, 240_000);

afterAll(() => c?.stop());

describe("check 10 on a local chain (draft Art 9 rules)", () => {
  it("the honest statement: VALID, check 10 advisory only for the 2025 rate on a 2026 period; €2.761677 per t of screws", async () => {
    const r = await verify(proof("1", "1", "1", ev["1"], shipment));
    expect(r.overall).toBe("VALID");
    expect(c10(r)).toMatchObject({ status: "warn", code: "CARBON_PRICE_WARNING/FX_YEAR", name: "Carbon price paid (draft Art 9)" });
    expect(c10(r)!.detail.startsWith(`[${DRAFT_LABEL}]`)).toBe(true);
    expect(r.carbonPrice).toMatchObject({
      draft: DRAFT_LABEL,
      localPerTonne: "86.4",
      eurPerTonne: "2.454824",
      eurPerTCO2e: "1.704739",
      deductibleEurPerTonneGood: "2.761677",
      target: { kind: "precursor", line: 0, cnCode: "7213", massPerTonne: "1.125" },
      claim: { claimedTonnes: "562.5", neededTonnes: "562.5" },
      certifier: { role: "CBAM Certification Lead Auditor" },
    });
    const v = toVerdict(proof("1", "1", "1", ev["1"], shipment), r, { chainId: 31337, block: r.atBlock, trustAnchor: null });
    expect(verdictSchemaErrors(v)).toEqual([]);
    expect(v.carbonPrice?.deductibleEurPerTonneGood).toBe("2.761677");
    // the portfolio's separate Art 9 block: 200 t → 6.709 certificates of 360 tCO2e
    const p = buildPortfolio([{ id: "S1", verdict: v, quantityTonnes: "200", cnCode: "7318", country: "TW", importDate: "2026-10-10", claimedTonnes: "200" }], { year: 2026, priceEur: "82.32", art9: { refPriceEur: "82.32" } });
    expect(p.art9).toMatchObject({ totalReduction: "6.709", obligationT: "360.000", netCertificates: 354 });
  });

  it("a statement on the good itself (hypothetical screw maker above 25,000 t): claimed for the importer, capped at its own direct emissions", async () => {
    const r = await verify(proof("1", "1", "1", ev.good, shipment));
    expect(r.overall).toBe("VALID");
    expect(r.carbonPrice).toMatchObject({ target: { kind: "good", massPerTonne: "1", seeCap: "0.18" }, localPerTonne: "4", deductibleEurPerTonneGood: "0.113649", claim: { claimedTonnes: "200", neededTonnes: "200" } });
    // without the importer's EORI the claim cannot be checked: INCOMPLETE
    const noEori = await verify(proof("1", "1", "1", ev.good, shipment), checkers(), null);
    expect(noEori.overall).toBe("INCOMPLETE");
  });

  it("double use: a claim beyond the tonnes the statement covers reverts (ExceedsVerifiedTonnage)", () => {
    expect(revertName(overClaimError)).toBe("ExceedsVerifiedTonnage");
  });

  it("double use: the same statement presented for a maker it was not claimed for fails (NOT_CLAIMED)", async () => {
    const reused = { ...ev["1"], claim: { ...ev["1"].claim, beneficiarySalt: newSalt() } };
    const r = await verify(proof("1", "1", "1", reused, shipment));
    expect(r.overall).toBe("INVALID");
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/NOT_CLAIMED");
  });

  it("double use: fewer tonnes claimed against the statement than the screws need fails; a second maker's claim beyond what is left reverts", async () => {
    const r = await verify(proof("2", "2", "2", ev["2"]), checkers(), null);
    expect(c10(r)).toMatchObject({ status: "fail", code: "CARBON_PRICE_INVALID/TONNES_NOT_COVERED" });
    expect(c10(r)!.detail).toContain("500 t claimed against the statement for this maker, 562.5 t needed");
    await expect(claimAgainst(w, cps["2"], { batchId: "CP-2-second", quantityTonnes: "150", beneficiary: SECOND_LEI })).rejects.toSatisfy((e: unknown) => revertName(e) === "ExceedsVerifiedTonnage");
  });

  it("forged certifier: the mill's own verification body (role CBAM Lead Auditor) is not an independent person", async () => {
    const forged = { ...ev["1"], authorityEvidence: w.chain.bodies.mill.bundle };
    const r = await verify(proof("1", "1", "1", forged, shipment));
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/CERTIFIER_AUTHORITY");
  });

  it("forged certifier: a chain pinned to another root fails", async () => {
    const r = await verify(proof("1", "1", "1", ev["1"], shipment), checkers({ carbonPriceTrustAnchor: DEMO_TRUST_ANCHOR }));
    expect(c10(r)).toMatchObject({ status: "fail", code: "CARBON_PRICE_INVALID/CERTIFIER_AUTHORITY" });
    expect(c10(r)!.detail).toContain("root of trust");
  });

  it("forged certifier: a KEL anchor of another SAID fails", async () => {
    const other = await evidenceFor(w, cps["1"], ev["1"].claim, { anchored: [cps["2"].d] });
    const r = await verify(proof("1", "1", "1", other, shipment));
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/CERTIFIER_ANCHOR");
  });

  it("a certifier not on the allowlist cannot register; its statement is NOT_REGISTERED", async () => {
    expect(["NotActiveVerifier", "AuditorNotAuthorized"]).toContain(revertName(impostorError));
    const e = await evidenceFor(w, cps.impostor, ev["1"].claim);
    const r = await verify(proof("1", "1", "1", e, shipment));
    expect(r.overall).toBe("INVALID");
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/NOT_REGISTERED");
  });

  it("operator signature from another key than the mill's supplier address fails", async () => {
    const e = await evidenceFor(w, cps["1"], ev["1"].claim, { signer: w.screwSupplier });
    const r = await verify(proof("1", "1", "1", e, shipment));
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/OPERATOR_SIGNATURE");
  });

  it("tampered statement: an edited price breaks the SAID; a re-SAID'd edit is not the registered statement", async () => {
    const edited = { ...ev["1"], statement: { ...cps["1"], effectivePriceEurPerTonne: "20" } };
    expect(c10(await verify(proof("1", "1", "1", edited, shipment)))?.code).toBe("CARBON_PRICE_INVALID/SAID");
    const resaid = saidifyStatement({ ...cps["1"], effectivePriceEurPerTonne: "20" });
    const r = await verify(proof("1", "1", "1", { ...ev["1"], statement: resaid }, shipment));
    expect(r.checks.find((x) => x.index === 10)?.status).toBe("fail");
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/NOT_REGISTERED");
  });

  it("FX manipulation: a statement certified at 30 TWD/EUR fails against the pinned 35.196", async () => {
    const r = await verify(proof("4", "4", "4", ev["4"]), checkers(), null);
    expect(r.overall).toBe("INVALID");
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/FX_MISMATCH");
    expect(r.carbonPrice?.eurPerTonne).toBe("2.454824"); // recomputed at the pinned rate, never the statement's
  });

  it("another period than the credential's fails (draft Art 3(3))", async () => {
    const r = await verify(proof("1", "1", "1", ev.period, shipment));
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/NOT_BOUND");
  });

  it("a statement the certifier revoked fails", async () => {
    const r = await verify(proof("3", "3", "3", ev["3"]), checkers(), null);
    expect(c10(r)?.code).toBe("CARBON_PRICE_INVALID/REVOKED");
  });

  it("no pinned exchange rate: INCOMPLETE with CARBON_PRICE_NOT_CHECKED, not a pass", async () => {
    const ch = checkers();
    const { carbonPriceChecker } = await import("../carbonprice.ts");
    const r = await verify(proof("1", "1", "1", ev["1"], shipment), { ...ch, carbonPrice: carbonPriceChecker({ trustAnchor: w.chain.trustAnchor, fxTable: [] }) });
    expect(r.overall).toBe("INCOMPLETE");
    expect(r.warnings?.map((x) => x.code)).toContain("CARBON_PRICE_NOT_CHECKED");
  });

  it("without carbon price evidence there is no check 10 and nothing changes", async () => {
    const r = await verify(proof("1", "1", "1", undefined, shipment));
    expect(r.overall).toBe("VALID");
    expect(c10(r)).toBeUndefined();
    expect(r.carbonPrice).toBeUndefined();
  });

  it("PACT export refuses a proof whose carbon price claim fails", async () => {
    const p = proof("4", "4", "4", ev["4"]);
    const r = await verify(p, checkers(), null);
    await expect(exportPactFromProof(p, r, c.reader, { companyName: "x", productNameCompany: "y", productDescription: "z", productId: "urn:x" })).rejects.toThrow(/check (10|5)/);
  });

  it("revoked certifier (lead auditor revoked on the allowlist after certifying): CONTESTED", async () => {
    const cert = w.chain.certifier!;
    await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(cert.auditorAid), leiHashOf(cert.lei)]);
    const r = await verify(proof("1", "1", "1", ev["1"], shipment));
    expect(c10(r)?.code).toBe("CONTESTED");
    expect(r.overall).toBe("CONTESTED");
  });
});
