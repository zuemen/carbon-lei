// PACT v3.0.3 ProductFootprint export of a credential's disclosed fields.
// The export is a data envelope in PACT format, not a full product carbon footprint:
// it carries CBAM direct embedded emissions only, and says so in `comment`,
// `productDescription`, `pcf.boundaryProcessesDescription` and the extension.
// Hidden fields never enter an export.
// Browser-safe (no Node APIs): used by `carbonlei export-pact` and by the hosted demo's Buyer tab.
import { keccak256, stringToBytes } from "viem";
import type { ChainReader } from "./chain.ts";
import { reportKeyOf } from "./commitment.ts";
import { METHODOLOGY_NOTE, splitReportingPeriod, type Hex } from "./credential.ts";
import type { Presentation } from "./disclosure.ts";
import { onlySuperseded, type VerificationResult } from "./verify.ts";

export const PACT_SPEC_VERSION = "3.0.3";
export const EXTENSION_SPEC_VERSION = "2.0.0";
/** Not one of PACT's listed standards on purpose: the values are illustrative and follow none of them. */
export const CROSS_SECTORAL_STANDARD = "CarbonLEI-illustrative";
export const PRODUCT_ID_DOMAIN = "zuemen.github.io";
/** CN codes are maintained by the European Commission; the URN uses the issuer's domain. */
export const CN_ISSUER_DOMAIN = "ec.europa.eu";
export const BOUNDARY = "CBAM embedded direct emissions — not a full product carbon footprint";
export const EXTENSION_SCHEMA_URL = "https://zuemen.github.io/carbon-lei/schemas/carbonlei-extension-0.1.0.json";
export const DOCUMENTATION_URL = "https://github.com/zuemen/carbon-lei/blob/main/docs/PACT_MAPPING.md";
const ZERO32 = `0x${"0".repeat(64)}`;

/** Deterministic footprint id from the on-chain reportKey (UUID version 8, RFC 9562). */
export function pactIdOf(reportKey: Hex): string {
  const h = keccak256(stringToBytes(`carbonlei-pact-id:${reportKey.toLowerCase()}`)).slice(2, 34).split("");
  h[12] = "8"; // version 8 (custom)
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // RFC 9562 variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** referencePeriodEnd is exclusive in PACT: the day after the last day of the period. */
export function exclusiveEnd(lastDay: string): string {
  const d = new Date(`${lastDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().replace(".000Z", "Z");
}

export interface PactContext {
  /** Disclosed fields only (output of verification step 2). */
  disclosed: Record<string, string>;
  credSAID: string;
  auditorAID: string;
  verifierLEI: string;
  reportKey: Hex;
  kelSeq: bigint;
  registry: Hex;
  chainId: number;
  /** On-chain state; omit for an offline export (then status is Active and the comment says so). */
  onchain?: { revoked: boolean; replaced: boolean; supersedes?: Hex; supersedesSameLayer?: boolean };
  companyName: string;
  productNameCompany: string;
  productDescription: string;
  productId: string;
  verifierName?: string;
  extensionSchemaUrl: string;
  documentationUrl: string;
  created?: string;
}

const CBAM_FIELDS = [
  "operatorId",
  "installationId",
  "installationName",
  "unLocode",
  "cnCode",
  "cbamRoute",
  "verifiedTonnes",
  "valueType",
  "verificationReportId",
  "accreditationNumber",
  "nabName",
  "siteVisit",
  "assuranceLevel",
  "materialityThreshold",
] as const;

export function exportPact(ctx: PactContext): Record<string, unknown> {
  const d = ctx.disclosed;
  if (ctx.onchain?.revoked) throw new Error("revoked reports are not exported");
  for (const f of ["supplierLEI", "cnCode", "reportingPeriod", "specificEmbeddedEmissions_tCO2e_per_t"]) {
    if (!d[f]) throw new Error(`export needs the disclosed field ${f}`);
  }
  const intensity = d.specificEmbeddedEmissions_tCO2e_per_t; // tCO2e/t equals kgCO2e/kg
  const { start, end } = splitReportingPeriod(d.reportingPeriod);
  const cbam: Record<string, string> = { boundary: "direct embedded emissions" };
  for (const f of CBAM_FIELDS) if (d[f] !== undefined) cbam[f] = d[f];

  const status = ctx.onchain?.replaced ? "Deprecated" : "Active";
  const comment =
    `${METHODOLOGY_NOTE}. CBAM direct embedded emissions, not a full PCF.` +
    (ctx.onchain ? "" : " Exported offline; on-chain status not checked.");

  const pf: Record<string, unknown> = {
    id: pactIdOf(ctx.reportKey),
    specVersion: PACT_SPEC_VERSION,
    ...(ctx.onchain?.supersedes && ctx.onchain.supersedesSameLayer
      ? { precedingPfIds: [pactIdOf(ctx.onchain.supersedes)] }
      : {}),
    created: ctx.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    status,
    ...(d.issuedAt ? { validityPeriodStart: d.issuedAt } : {}),
    ...(d.validUntil ? { validityPeriodEnd: d.validUntil } : {}),
    companyName: ctx.companyName,
    companyIds: [`urn:lei:${d.supplierLEI}`],
    productDescription: ctx.productDescription,
    productIds: [`urn:pact:${PRODUCT_ID_DOMAIN}:product-id:${ctx.productId}`],
    productClassifications: [`urn:pact:${CN_ISSUER_DOMAIN}:cn:${d.cnCode}`],
    productNameCompany: ctx.productNameCompany,
    comment,
    pcf: {
      declaredUnitOfMeasurement: "kilogram",
      declaredUnitAmount: "1",
      productMassPerDeclaredUnit: "1",
      referencePeriodStart: `${start}T00:00:00Z`,
      referencePeriodEnd: exclusiveEnd(end),
      ...(d.unLocode ? { geographyCountry: d.unLocode.slice(0, 2) } : {}),
      pcfExcludingBiogenicUptake: intensity,
      pcfIncludingBiogenicUptake: intensity,
      fossilGhgEmissions: intensity,
      fossilCarbonContent: "0",
      ipccCharacterizationFactors: ["AR6"],
      crossSectoralStandards: [CROSS_SECTORAL_STANDARD],
      exemptedEmissionsPercent: "0",
      boundaryProcessesDescription: BOUNDARY,
      verification: {
        coverage: "product level",
        ...(ctx.verifierName ? { providerName: ctx.verifierName } : {}),
        ...(d.issuedAt ? { completedAt: d.issuedAt } : {}),
        standardName: "CBAM verification, Implementing Regulation (EU) 2025/2546",
        ...(d.accreditationNumber && d.nabName && d.verificationReportId
          ? { comments: `${d.accreditationNumber}; ${d.nabName}; ${d.verificationReportId}` }
          : {}),
      },
    },
    extensions: [
      {
        specVersion: EXTENSION_SPEC_VERSION,
        dataSchema: ctx.extensionSchemaUrl,
        documentation: ctx.documentationUrl,
        data: {
          cbam,
          carbonlei: {
            credSAID: ctx.credSAID,
            verifierLEI: ctx.verifierLEI,
            auditorAID: ctx.auditorAID,
            kelSeq: ctx.kelSeq.toString(),
            registry: { chainId: ctx.chainId, contract: ctx.registry, reportKey: ctx.reportKey },
          },
        },
      },
    ],
  };
  return pf;
}

/** What the exporter supplies about the product; the rest comes from the proof and the chain. */
export type PactProduct = Pick<PactContext, "companyName" | "productNameCompany" | "productDescription" | "productId"> &
  Partial<Pick<PactContext, "verifierName" | "extensionSchemaUrl" | "documentationUrl" | "created">>;

/**
 * Export of a verified proof. Exports nothing unless every check that decides validity passed, with one exception:
 * a credential whose only failure is that check 4 found it superseded is exported with `status` `Deprecated`.
 * In detail it refuses a result in which
 * - check 0, 1, 2, 3, 5, 6 or 7 failed;
 * - check 4 failed for any other reason (revoked, expired, issuer, supplier or scope mismatch, ...), or for that
 *   reason as well as supersession;
 * - check 6 or 7 did not pass (not run, so INCOMPLETE, or only a warning);
 * - the overall result is CONTESTED (it needs a person's review first).
 * `r` should come from a verification with the importer's EORI (check 5), so that check 4 judged the claim time only
 * for the importer the batch was declared to. Reads the report's on-chain record for `status`, `precedingPfIds` and
 * the KEL sequence number.
 */
export async function exportPactFromProof(
  proof: Presentation,
  r: VerificationResult,
  rd: ChainReader,
  product: PactProduct,
): Promise<Record<string, unknown>> {
  const check = (i: number) => r.checks.find((c) => c.index === i);
  if (check(0)?.status === "fail") {
    throw new Error(`the proof is malformed (check 0: ${check(0)?.detail}); nothing exported`);
  }
  if ([1, 2, 3].some((i) => check(i)?.status === "fail")) {
    throw new Error(`the proof does not pass checks 1–3 (${r.primaryCode}); nothing exported`);
  }
  // Checks 6 and 7 decide whether the auditor was authorised; a result without them, or with one failed, says
  // nothing a footprint's `status` could carry (status only follows the on-chain record of check 4).
  if (r.overall === "INCOMPLETE") {
    throw new Error("the verification did not run every check (INCOMPLETE: checks 6 and 7 need the evidence checkers); nothing exported");
  }
  const failedEvidence = r.checks.find((c) => (c.index === 6 || c.index === 7) && c.status === "fail");
  if (failedEvidence) {
    throw new Error(`the proof fails check ${failedEvidence.index} (${failedEvidence.code}); nothing exported`);
  }
  const unconfirmed = [6, 7].find((i) => check(i)?.status !== "pass");
  if (unconfirmed !== undefined) {
    throw new Error(`check ${unconfirmed} did not pass (${check(unconfirmed)?.status ?? "missing"}); nothing exported`);
  }
  // Check 4: `Deprecated` is only for a credential that was valid and has been replaced. Anything else check 4
  // found (expired, revoked, a mismatch with the signed credential) means the footprint would state a value the
  // registry does not support, so nothing is exported rather than an `Active` footprint.
  const c4 = check(4);
  if (c4?.status === "fail" && !onlySuperseded(c4)) {
    throw new Error(`the proof fails check 4 (${c4.code}: ${c4.detail}); nothing exported`);
  }
  // Check 5: with an EORI, the shipment must have been declared to that importer.
  if (check(5)?.status === "fail") {
    throw new Error(`the proof fails check 5 (${check(5)?.code}: ${check(5)?.detail}); nothing exported`);
  }
  if (r.overall === "CONTESTED") {
    throw new Error(
      `the result is CONTESTED (check ${r.checks.find((c) => c.code === "CONTESTED")?.index ?? 4}: ${r.checks.find((c) => c.code === "CONTESTED")?.detail ?? "see checks 4 and 5"}); it needs a person's review, nothing exported`,
    );
  }
  const core = JSON.parse(proof.core);
  const reportKey = reportKeyOf(core.d);
  const rep = await rd.report(reportKey);
  let supersedesSameLayer: boolean | undefined;
  if (rep.registeredAt !== 0n && rep.supersedes !== ZERO32) {
    supersedesSameLayer = (await rd.report(rep.supersedes)).credScopeKey === rep.credScopeKey;
  }
  return exportPact({
    extensionSchemaUrl: EXTENSION_SCHEMA_URL,
    documentationUrl: DOCUMENTATION_URL,
    ...product,
    disclosed: r.disclosed,
    credSAID: core.d,
    auditorAID: core.issuer.auditorAID,
    verifierLEI: core.issuer.verifierLEI,
    reportKey,
    kelSeq: rep.kelSeq,
    registry: rd.registry,
    chainId: await rd.client.getChainId(),
    onchain:
      rep.registeredAt === 0n
        ? undefined
        : {
            revoked: rep.revokedAt !== 0n,
            replaced: onlySuperseded(check(4)),
            supersedes: supersedesSameLayer === undefined ? undefined : rep.supersedes,
            supersedesSameLayer,
          },
  });
}
