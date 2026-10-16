// Carbon price paid (check 10, DRAFT CBAM Art 9 rules — not adopted, illustrative) on a local anvil chain, on top of
// the precursor scenario (scripts/precursor-scenario.ts): the fictional wire-rod mill pays the Taiwan carbon fee; a
// fictional independent person (certifier body + certification lead auditor, synthetic vLEI chain under the same
// synthetic precursor root) certifies the mill's carbon price statement, anchors its SAID in the lead auditor's KEL
// and registers it in the same EmissionsClaimRegistry (separate key domain), with the mill's supplier wallet as the
// address that may claim against it; the mill signs the statement (EIP-191) and claims the tonnes of wire rod it
// delivered to the screw maker against it (importerCommit = the screw maker's LEI and its credential's SAID). Shared by
// sdk/test/carbonprice.integration.test.ts and scripts/carbonprice-local.ts. Local chain only: nothing here runs on
// Sepolia.
import { readFileSync } from "node:fs";
import type { PrivateKeyAccount } from "viem";
import {
  CARBON_PRICE_STATEMENT_TYPE,
  CARBON_PRICE_STATEMENT_VERSION,
  DRAFT_LABEL,
  carbonPriceKeys,
  fmtRat,
  recomputePrice,
  saidifyStatement,
  type CarbonPriceEvidence,
  type CarbonPriceStatement,
} from "../sdk/carbonprice.ts";
import { auditorAidHashOf, batchKeyOf, hashString, importerCommitOf, leiHashOf, precursorBeneficiaryOf, shipmentBeneficiaryOf } from "../sdk/commitment.ts";
import { isoToSeconds, tonnesToKg, type Hex } from "../sdk/credential.ts";
import { newSalt } from "../sdk/encoding.ts";
import type { SignedCredential } from "../sdk/issue.ts";
import { send, type LocalChain } from "../sdk/test/helpers/local-chain.ts";
import { precursorChainInput, syntheticPrecursorChain } from "../verifier/src/precursor-chain.ts";
import { PC, demo, type World } from "./precursor-scenario.ts";

export const CP = JSON.parse(readFileSync(new URL("../fixtures/carbonprice.json", import.meta.url), "utf8"));

export interface CarbonWorld extends World {
  /** The certifier body's allowlisted address (registers statements). */
  certifierSigner: PrivateKeyAccount;
}

/** Both verification bodies and the certifier on the allowlist; the chain includes the certifier (same synthetic root). */
export async function setupCarbonWorld(c: LocalChain): Promise<CarbonWorld> {
  const input = { ...precursorChainInput(demo), certifier: { name: CP.certifier.name, lei: CP.certifier.lei, accreditationNumber: CP.certifier.accreditationNumber, accreditedUntil: CP.certifier.accreditedUntil, cnScope: CP.certifier.cnScope, auditor: { name: CP.certifier.auditor.name } } };
  const chain = syntheticPrecursorChain(input);
  const w: CarbonWorld = {
    c,
    chain,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    signer: { screw: c.verifier, mill: c.extra[0] },
    screwSupplier: c.supplier,
    millSupplier: c.extra[1],
    secondSupplier: c.extra[2],
    certifierSigner: c.extra[3],
    issued: { screw: [], mill: [] },
  };
  const entries = [
    { b: chain.bodies.screw, signer: w.signer.screw, until: demo.entities.verifier.accreditedUntil },
    { b: chain.bodies.mill, signer: w.signer.mill, until: PC.body.accreditedUntil },
    { b: chain.certifier!, signer: w.certifierSigner, until: CP.certifier.accreditedUntil },
  ];
  for (const { b, signer, until } of entries) {
    await send(c, c.owner, "allowlist", "addVerifier", [
      { leiHash: leiHashOf(b.lei), verifier: signer.address, leCredSaidHash: hashString(b.saids.leBody), accreditationSaidHash: hashString(b.saids.accreditation), accreditedUntil: isoToSeconds(until) },
    ]);
    await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(b.auditorAid), leiHash: leiHashOf(b.lei), ecrSaidHash: hashString(b.saids.ecr) }]);
  }
  return w;
}

/** The mill's claims for this demo: an integrated route (its own emissions are the ones the fee is paid on). */
export const millOverrides = { productionRoute: CP.mill.productionRoute };

/** Exempted emissions for the demo's K and factor: C − round3((C − K) × factor). */
export function exemptOf(cpm: string, k: string = CP.fee.thresholdK, factor: string = CP.fee.factor): string {
  const chargeable = (Number(cpm) - Number(k)) * Number(factor);
  return String(Math.round((Number(cpm) - chargeable) * 1000) / 1000);
}

/** The demo carbon price statement for the mill credential `millCred` (overrides for the attack tests). */
export function statementFor(w: CarbonWorld, millCred: SignedCredential, over: Partial<CarbonPriceStatement> = {}): CarbonPriceStatement {
  const cert = w.chain.certifier!;
  const base: Omit<CarbonPriceStatement, "d"> = {
    type: CARBON_PRICE_STATEMENT_TYPE,
    version: CARBON_PRICE_STATEMENT_VERSION,
    notice: DRAFT_LABEL,
    operator: { name: PC.mill.name, lei: PC.mill.lei, installationId: PC.report.installation },
    reportingPeriod: CP.statement.reportingPeriod,
    cnCode: PC.report.cnCode,
    credentials: [millCred.core.d],
    mechanism: { country: CP.fee.country, name: CP.fee.name, legalBasis: CP.fee.legalBasis, form: "point-source carbon tax", covers: "direct" },
    currency: CP.fee.currency,
    ratePerTonne: CP.fee.ratePerTonne,
    cpmEmissions: CP.mill.cpmEmissions,
    exemptEmissions: exemptOf(CP.mill.cpmEmissions),
    exemptBasis: CP.fee.exemptBasis,
    adjustment: { thresholdK: CP.fee.thresholdK, factor: CP.fee.factor },
    refunds: CP.fee.refunds,
    feePaid: CP.fee.feePaid,
    productionTonnes: CP.mill.productionTonnes,
    emissionsPerTonne: CP.mill.emissionsPerTonne,
    fx: { unitsPerEur: CP.fx.unitsPerEur, year: CP.fx.year, source: "Eurostat ert_bil_eur_a, annual average 2025 (Commission yearly rates of draft Art 5 not yet published)" },
    effectivePriceEurPerTonne: "0",
    materiality: "5%",
    rebatesChecked: true,
    certifier: { name: cert.name, lei: cert.lei, auditorAID: cert.auditorAid, accreditationNumber: CP.certifier.accreditationNumber },
    certificationReportId: CP.statement.certificationReportId,
    certifiedAt: CP.statement.certifiedAt,
    validUntil: CP.statement.validUntil,
  };
  const merged = { ...base, ...over } as Omit<CarbonPriceStatement, "d">;
  if (over.effectivePriceEurPerTonne === undefined) merged.effectivePriceEurPerTonne = eurOf(merged);
  return saidifyStatement(merged);
}

/** € per tonne of good of a statement's own fields at its own FX (what an honest certifier states), 6 decimals. */
function eurOf(s: Omit<CarbonPriceStatement, "d">): string {
  const own = [{ currency: s.currency, year: s.fx.year, unitsPerEur: s.fx.unitsPerEur, source: s.fx.source }];
  const r = recomputePrice({ ...s, d: "" } as CarbonPriceStatement, { fxTable: own });
  return fmtRat(r.eurPerTonne!);
}

/** Registers `st` from the certifier body's address; `supplier` is the operator wallet that may claim against it. */
export async function registerStatement(w: CarbonWorld, st: CarbonPriceStatement, opts: { supplier?: PrivateKeyAccount; signer?: PrivateKeyAccount; supersedes?: Hex } = {}) {
  const k = carbonPriceKeys(st);
  return send(w.c, opts.signer ?? w.certifierSigner, "registry", "registerReport", [
    {
      reportKey: k.reportKey,
      reportIdHash: k.reportIdHash,
      reportScopeKey: k.reportScopeKey,
      credScopeKey: k.credScopeKey,
      auditorAidHash: auditorAidHashOf(st.certifier.auditorAID),
      kelSeq: 1n,
      supplier: (opts.supplier ?? w.millSupplier).address,
      supplierCommit: k.supplierCommit,
      installationCommit: k.installationCommit,
      verifiedKg: tonnesToKg(st.productionTonnes),
      validUntil: isoToSeconds(st.validUntil),
      supersedes: opts.supersedes ?? `0x${"0".repeat(64)}`,
    },
  ]);
}

/**
 * The operator claims `quantityTonnes` of good against `st` for `beneficiary`: a maker's LEI with `goodSAID`, the
 * maker's credential that relies on the statement (precursorBeneficiaryOf), or the importer's EORI with
 * `shipmentBatchKey`, the one shipment of the good the claim covers (shipmentBeneficiaryOf). Without either, the
 * claim commits to the bare LEI or EORI, which check 10 does not accept (kept for the attack tests).
 */
export async function claimAgainst(
  w: CarbonWorld,
  st: CarbonPriceStatement,
  s: { batchId: string; quantityTonnes: string; beneficiary: string; goodSAID?: string; shipmentBatchKey?: Hex; from?: PrivateKeyAccount },
) {
  const batchSalt = newSalt();
  const beneficiarySalt = newSalt();
  const reportKey = carbonPriceKeys(st).reportKey;
  const who = s.goodSAID ? precursorBeneficiaryOf(s.beneficiary, s.goodSAID) : s.shipmentBatchKey ? shipmentBeneficiaryOf(s.beneficiary, s.shipmentBatchKey) : s.beneficiary;
  const args = [reportKey, batchKeyOf(reportKey, s.batchId, batchSalt), tonnesToKg(s.quantityTonnes), importerCommitOf(who, beneficiarySalt)] as const;
  const receipt = await send(w.c, s.from ?? w.millSupplier, "registry", "claimShipment", args);
  return { claim: { batchId: s.batchId, quantityTonnes: s.quantityTonnes, batchSalt, beneficiarySalt }, args, receipt };
}

/** The evidence the screw maker attaches: the statement, the mill's signature, the certifier's anchor and chain. */
export async function evidenceFor(w: CarbonWorld, st: CarbonPriceStatement, claim: CarbonPriceEvidence["claim"], opts: { signer?: PrivateKeyAccount; anchored?: string[] } = {}): Promise<CarbonPriceEvidence> {
  const cert = w.chain.certifier!;
  const signer = opts.signer ?? w.millSupplier;
  return {
    statement: st,
    operatorSignature: await signer.signMessage({ message: st.d }),
    anchorEvidence: { ...cert.anchor(opts.anchored ?? [st.d]), credSAID: st.d },
    authorityEvidence: cert.bundle,
    claim,
  };
}
