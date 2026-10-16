// Precursor chain of trust on a local anvil chain: a fictional wire-rod mill (CN 7213) with its own verification body
// and lead auditor registers its verified report in the same EmissionsClaimRegistry; the mill's supplier wallet claims
// the wire rod it delivered to the screw maker against that report (importerCommit = the screw maker's LEI with a
// salt), so the same verified tonnes of wire rod cannot back two screw makers; the screw maker's verification body
// signs a precursor statement (sdk/precursor.ts) into the screw credential. Shared by
// sdk/test/precursor.integration.test.ts and scripts/precursor-local.ts. Local chain only: nothing here runs on
// Sepolia. vLEI evidence: the synthetic two-body chain of verifier/src/precursor-chain.ts.
import { readFileSync } from "node:fs";
import type { PrivateKeyAccount } from "viem";
import { hashString, importerCommitOf, leiHashOf, auditorAidHashOf } from "../sdk/commitment.ts";
import { METHODOLOGY_NOTE, isoToSeconds, type CredentialClaims, type Hex } from "../sdk/credential.ts";
import type { Presentation, ShipmentPart } from "../sdk/disclosure.ts";
import { newSalt } from "../sdk/encoding.ts";
import { DEMO_DISCLOSURE, claimArgsOf, issueCredential, present, reportInputOf, type SignedCredential } from "../sdk/issue.ts";
import {
  PRECURSOR_STATEMENT_TYPE,
  PRECURSOR_STATEMENT_VERSION,
  precursorDigestOf,
  type PrecursorEvidence,
  type PrecursorLine,
  type PrecursorStatement,
} from "../sdk/precursor.ts";
import { send, type LocalChain } from "../sdk/test/helpers/local-chain.ts";
import { precursorChainInput, syntheticPrecursorChain, type BodyKey, type PrecursorChain } from "../verifier/src/precursor-chain.ts";

export const demo = JSON.parse(readFileSync(new URL("../fixtures/demo.json", import.meta.url), "utf8"));
export const PC = demo.entities.precursorChain;
export const REPORT_1 = demo.reports[0];
export const SCREW_LEI: string = demo.entities.supplier.lei;
export const IMPORTER_EORI: string = demo.entities.importers[0].eori;

export interface World {
  c: LocalChain;
  chain: PrecursorChain;
  registry: Hex;
  signer: Record<BodyKey, PrivateKeyAccount>;
  screwSupplier: PrivateKeyAccount;
  millSupplier: PrivateKeyAccount;
  secondSupplier: PrivateKeyAccount;
  /** Credential SAIDs per body, in issuance order: each auditor anchors all of its body's SAIDs in KEL event #1. */
  issued: Record<BodyKey, string[]>;
}

/** Puts both verification bodies and their lead auditors on the allowlist (their synthetic vLEI SAIDs). */
export async function setupWorld(c: LocalChain): Promise<World> {
  const chain = syntheticPrecursorChain(precursorChainInput(demo));
  const w: World = {
    c,
    chain,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    signer: { screw: c.verifier, mill: c.extra[0] },
    screwSupplier: c.supplier,
    millSupplier: c.extra[1],
    secondSupplier: c.extra[2],
    issued: { screw: [], mill: [] },
  };
  for (const k of ["screw", "mill"] as const) {
    const b = chain.bodies[k];
    const accreditedUntil = k === "screw" ? demo.entities.verifier.accreditedUntil : PC.body.accreditedUntil;
    await send(c, c.owner, "allowlist", "addVerifier", [
      {
        leiHash: leiHashOf(b.lei),
        verifier: w.signer[k].address,
        leCredSaidHash: hashString(b.saids.leBody),
        accreditationSaidHash: hashString(b.saids.accreditation),
        accreditedUntil: isoToSeconds(accreditedUntil),
      },
    ]);
    await send(c, c.owner, "allowlist", "addAuditor", [
      { auditorAidHash: auditorAidHashOf(b.auditorAid), leiHash: leiHashOf(b.lei), ecrSaidHash: hashString(b.saids.ecr) },
    ]);
  }
  return w;
}

/** The demo screw report's claims (fixtures/demo.json reports[0]), with test overrides. */
export function screwClaims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  const inst = s.installations.find((i: { id: string }) => i.id === REPORT_1.installation);
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: inst.id,
    installationName: inst.name,
    unLocode: s.unLocode,
    cnCode: demo.product.cnCode,
    cbamRoute: REPORT_1.cbamRoute,
    productionRoute: "purchased carbon-steel wire rod, cold heading (illustrative)",
    reportingPeriod: REPORT_1.reportingPeriod,
    verifiedTonnes: REPORT_1.verifiedTonnes,
    specificEmbeddedEmissions_tCO2e_per_t: REPORT_1.specificEmbeddedEmissions_tCO2e_per_t,
    valueType: REPORT_1.valueType,
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: REPORT_1.verificationReportId,
    verifierLEI: demo.entities.verifier.lei,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: newSalt(),
    batchSalt: newSalt(),
    issuedAt: REPORT_1.issuedAt,
    validUntil: REPORT_1.validUntil,
    ...over,
  };
}

/** The demo mill report's claims (fixtures/demo.json entities.precursorChain.report), with test overrides. */
export function millClaims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const m = PC.mill;
  const r = PC.report;
  const inst = m.installations.find((i: { id: string }) => i.id === r.installation);
  return {
    supplierLEI: m.lei,
    operatorId: m.operatorId,
    installationId: inst.id,
    installationName: inst.name,
    unLocode: m.unLocode,
    cnCode: r.cnCode,
    cbamRoute: r.cbamRoute,
    productionRoute: "wire rod rolling from purchased billets (illustrative)",
    reportingPeriod: r.reportingPeriod,
    verifiedTonnes: r.verifiedTonnes,
    specificEmbeddedEmissions_tCO2e_per_t: r.specificEmbeddedEmissions_tCO2e_per_t,
    valueType: r.valueType,
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: r.verificationReportId,
    verifierLEI: PC.body.lei,
    accreditationNumber: PC.body.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: newSalt(),
    batchSalt: newSalt(),
    issuedAt: r.issuedAt,
    validUntil: r.validUntil,
    ...over,
  };
}

/** A precursor statement (the demo's numbers unless overridden). */
export function statementOf(lines: PrecursorLine[], attributedDirect: string = PC.statement.attributedDirect): PrecursorStatement {
  return { type: PRECURSOR_STATEMENT_TYPE, version: PRECURSOR_STATEMENT_VERSION, attributedDirect, lines };
}

/** One verified wire-rod line for the mill credential `millCred` and batch `batchId`. */
export const wireRodLine = (millCred: SignedCredential, batchId: string, massPerTonne: string = PC.statement.massPerTonne): PrecursorLine => ({
  cnCode: PC.report.cnCode,
  massPerTonne,
  source: "verified",
  credSAID: millCred.core.d,
  batchId,
});

/** Issues a credential signed by `body`'s key (or `signer`), with a precursor statement's digest when given. */
export async function issueAs(
  w: World,
  body: BodyKey,
  claims: CredentialClaims,
  opts: { statement?: PrecursorStatement; signer?: PrivateKeyAccount } = {},
): Promise<SignedCredential> {
  const cred = await issueCredential({
    claims,
    auditorAID: w.chain.bodies[body].auditorAid,
    signer: opts.signer ?? w.signer[body],
    registry: w.registry,
    chainId: 31337,
    ...(opts.statement ? { precursorDigest: precursorDigestOf(opts.statement) } : {}),
  });
  w.issued[body].push(cred.core.d);
  return cred;
}

/** Registers `cred` from its body's address, with `supplier` as the wallet that may claim against it. */
export async function register(w: World, body: BodyKey, cred: SignedCredential, supplier: PrivateKeyAccount, signer?: PrivateKeyAccount) {
  const ri = reportInputOf(cred, { supplier: supplier.address, kelSeq: 1n });
  return send(w.c, signer ?? w.signer[body], "registry", "registerReport", [ri]);
}

/**
 * The mill's supplier claims `quantityTonnes` of `millCred` for the maker with LEI `makerLei` (the claim's
 * importerCommit). Returns the shipment part the maker presents in the mill's proof.
 */
export async function claimFor(
  w: World,
  millCred: SignedCredential,
  s: { batchId: string; quantityTonnes: string; makerLei: string; shipmentDate?: string; importerSalt?: Hex },
): Promise<ShipmentPart> {
  const importerSalt = s.importerSalt ?? newSalt();
  await send(w.c, w.millSupplier, "registry", "claimShipment", claimArgsOf(millCred, { batchId: s.batchId, quantityTonnes: s.quantityTonnes, importerEORI: s.makerLei, importerSalt }));
  return { batchId: s.batchId, quantityTonnes: s.quantityTonnes, shipmentDate: s.shipmentDate ?? PC.delivery.shipmentDate, importerSalt };
}

/** A proof of `cred` with the KEL anchor of its body's auditor and the body's vLEI chain inline. */
export function proofOf(
  w: World,
  body: BodyKey,
  cred: SignedCredential,
  opts: { shipment?: ShipmentPart; precursorEvidence?: PrecursorEvidence } = {},
): Presentation {
  const b = w.chain.bodies[body];
  return {
    ...present(cred, DEMO_DISCLOSURE, opts.shipment),
    anchorEvidence: { ...b.anchor(w.issued[body]), credSAID: cred.core.d },
    authorityEvidence: b.bundle,
    ...(opts.precursorEvidence ? { precursorEvidence: opts.precursorEvidence } : {}),
  };
}

/** The importer commitment of `importerCommitOf` for a maker's LEI, re-exported for the tests. */
export const makerCommit = (lei: string, salt: Hex) => importerCommitOf(lei, salt);
