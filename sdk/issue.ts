// Issuing side: build and sign a credential, derive the registry input, build a presentation
// and the claim arguments. The SDK only prepares inputs; wallets send the transactions.
import type { LocalAccount } from "viem";
import {
  batchKeyOf,
  credScopeKeyOf,
  importerCommitOf,
  installationCommitOf,
  reportIdHashOf,
  reportKeyOf,
  reportScopeKeyOf,
  supplierCommitOf,
  auditorAidHashOf,
  ZERO32,
} from "./commitment.ts";
import { checkNormalForms, isoToSeconds, tonnesToKg, type CredentialClaims, type Hex } from "./credential.ts";
import {
  buildCredential,
  selectDisclosures,
  type IssueInput,
  type IssuedCredential,
  type Presentation,
  type ShipmentPart,
} from "./disclosure.ts";
import { signCredential } from "./eip712.ts";

export interface ReportInput {
  reportKey: Hex;
  reportIdHash: Hex;
  reportScopeKey: Hex;
  credScopeKey: Hex;
  auditorAidHash: Hex;
  kelSeq: bigint;
  supplier: Hex;
  supplierCommit: Hex;
  installationCommit: Hex;
  verifiedKg: bigint;
  validUntil: bigint;
  supersedes: Hex;
}

export interface SignedCredential extends IssuedCredential {
  claims: CredentialClaims;
  signature: Hex;
}

/** Builds the credential, fills its SAID and signs it with the verification body's key (EIP-712). */
export async function issueCredential(
  input: Omit<IssueInput, "verifierAddress"> & { signer: LocalAccount; registry: Hex; chainId?: number },
): Promise<SignedCredential> {
  const bad = checkNormalForms(input.claims);
  if (bad.length) throw new Error(`not in normal form: ${bad.join(", ")}`);
  const issued = buildCredential({ ...input, verifierAddress: input.signer.address });
  const signature = await signCredential(
    input.signer,
    input.registry,
    {
      credSAID: issued.core.d,
      supplierCommit: supplierCommitOf(input.claims.supplierLEI, input.claims.idSalt),
      verifiedKg: tonnesToKg(input.claims.verifiedTonnes),
      validUntil: isoToSeconds(input.claims.validUntil),
    },
    input.chainId,
  );
  return { ...issued, claims: input.claims, signature };
}

/** Registry input for `registerReport`. `supplier` is the supplier's wallet (not in the credential). */
export function reportInputOf(
  cred: SignedCredential,
  opts: { supplier: Hex; kelSeq: bigint; supersedes?: Hex },
): ReportInput {
  const c = cred.claims;
  return {
    reportKey: reportKeyOf(cred.core.d),
    reportIdHash: reportIdHashOf(c.verificationReportId),
    reportScopeKey: reportScopeKeyOf(c.installationId, c.reportingPeriod),
    credScopeKey: credScopeKeyOf(c.installationId, c.cnCode, c.cbamRoute, c.reportingPeriod),
    auditorAidHash: auditorAidHashOf(cred.core.issuer.auditorAID),
    kelSeq: opts.kelSeq,
    supplier: opts.supplier,
    supplierCommit: supplierCommitOf(c.supplierLEI, c.idSalt),
    installationCommit: installationCommitOf(c.installationId, c.idSalt),
    verifiedKg: tonnesToKg(c.verifiedTonnes),
    validUntil: isoToSeconds(c.validUntil),
    supersedes: opts.supersedes ?? ZERO32,
  };
}

/** Arguments of `claimShipment(reportKey, batchKey, quantityKg, importerCommit)`. */
export function claimArgsOf(
  cred: SignedCredential,
  shipment: { batchId: string; quantityTonnes: string; importerEORI: string; importerSalt: Hex },
): readonly [Hex, Hex, bigint, Hex] {
  const reportKey = reportKeyOf(cred.core.d);
  return [
    reportKey,
    batchKeyOf(reportKey, shipment.batchId, cred.claims.batchSalt),
    tonnesToKg(shipment.quantityTonnes),
    importerCommitOf(shipment.importerEORI, shipment.importerSalt),
  ] as const;
}

/** The supplier's proof: the signed core, the signature and the chosen disclosures. */
export function present(cred: SignedCredential, names: readonly string[], shipment?: ShipmentPart): Presentation {
  return {
    core: cred.coreJson,
    signature: cred.signature,
    disclosures: selectDisclosures(cred.disclosures, names),
    ...(shipment ? { shipment } : {}),
  };
}

/** What the demo supplier discloses to an importer (production route, energy mix and cost stay hidden). */
export const DEMO_DISCLOSURE = [
  "supplierLEI",
  "installationId",
  "unLocode",
  "cnCode",
  "cbamRoute",
  "reportingPeriod",
  "verifiedTonnes",
  "specificEmbeddedEmissions_tCO2e_per_t",
  "valueType",
  "methodologyNote",
  "verificationReportId",
  "verifierLEI",
  "accreditationNumber",
  "nabName",
  "siteVisit",
  "assuranceLevel",
  "materialityThreshold",
  "idSalt",
  "batchSalt",
  "issuedAt",
  "validUntil",
] as const;
