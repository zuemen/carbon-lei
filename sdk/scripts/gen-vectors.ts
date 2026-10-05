// Generates fixtures/vectors.json: cross-language test vectors checked by both
// contracts/test/Vectors.t.sol (forge) and sdk/test/vectors.test.ts (vitest).
// Every salt and the signing key are fixed test values derived from labels; the key
// is for tests only and never holds funds.
// Run: node sdk/scripts/gen-vectors.ts
import { readFileSync, writeFileSync } from "node:fs";
import { hashTypedData, keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  auditorAidHashOf,
  batchKeyOf,
  credScopeKeyOf,
  importerCommitOf,
  installationCommitOf,
  leiHashOf,
  reportIdHashOf,
  reportKeyOf,
  reportScopeKeyOf,
  supplierCommitOf,
} from "../commitment.ts";
import { METHODOLOGY_NOTE, isoToSeconds, tonnesToKg, type CredentialClaims, type Hex } from "../credential.ts";
import { buildCredential, decodeDisclosure, disclosureDigest, encodeDisclosure } from "../disclosure.ts";
import { signCredential, typedDataOf } from "../eip712.ts";

const label = (s: string): Hex => keccak256(stringToBytes(`carbonlei-test-vector:${s}`));

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const report = demo.reports[0];
const supplier = demo.entities.supplier;
const verifier = demo.entities.verifier;
const installation = supplier.installations[0];

const TEST_SIGNER_KEY = label("signer-1");
const OTHER_SIGNER_KEY = label("signer-2");
const TEST_REGISTRY: Hex = "0x00000000000000000000000000000000ca7b0101";
const AUDITOR_AID = "EDemoAuditorAidForTestVectors000000000000000";

const signer = privateKeyToAccount(TEST_SIGNER_KEY);
const idSalt = label("idSalt");
const batchSalt = label("batchSalt");

const claims: CredentialClaims = {
  supplierLEI: supplier.lei,
  operatorId: supplier.operatorId,
  installationId: installation.id,
  installationName: installation.name,
  unLocode: supplier.unLocode,
  cnCode: demo.product.cnCode,
  cbamRoute: report.cbamRoute,
  productionRoute: "BF-BOF wire rod, cold heading (illustrative)",
  reportingPeriod: report.reportingPeriod,
  verifiedTonnes: report.verifiedTonnes,
  specificEmbeddedEmissions_tCO2e_per_t: report.specificEmbeddedEmissions_tCO2e_per_t,
  valueType: report.valueType,
  methodologyNote: METHODOLOGY_NOTE,
  verificationReportId: report.verificationReportId,
  verifierLEI: verifier.lei,
  accreditationNumber: verifier.accreditationNumber,
  nabName: demo.entities.nab.name,
  siteVisit: "physical",
  assuranceLevel: "reasonable",
  materialityThreshold: "5%",
  energyMix: "grid 70%, on-site solar 30% (illustrative)",
  supplierCost: "withheld (illustrative)",
  idSalt,
  batchSalt,
  issuedAt: report.issuedAt,
  validUntil: report.validUntil,
};

const salts = Object.fromEntries(Object.keys(claims).map((k) => [k, label(`disclosure:${k}`)]));
const cred = buildCredential({
  claims,
  verifierAddress: signer.address,
  auditorAID: AUDITOR_AID,
  reconciliation: {
    inputHash: label("reconciliation:input"),
    outputHash: label("reconciliation:output"),
    ruleVersionHash: label("reconciliation:rules-v1"),
  },
  salts,
});

const reportKey = reportKeyOf(cred.core.d);
const supplierCommit = supplierCommitOf(claims.supplierLEI, idSalt);
const message = {
  credSAID: cred.core.d,
  supplierCommit,
  verifiedKg: tonnesToKg(claims.verifiedTonnes),
  validUntil: isoToSeconds(claims.validUntil),
};
const signature = await signCredential(signer, TEST_REGISTRY, message);
const otherSignature = await signCredential(privateKeyToAccount(OTHER_SIGNER_KEY), TEST_REGISTRY, message);

const intensity = decodeDisclosure(cred.disclosures.specificEmbeddedEmissions_tCO2e_per_t);
const tampered = encodeDisclosure({ ...intensity, value: "1.2" });
const importerSalt = label("importerSalt");

const vectors = {
  note: "Test vectors only. Keys and salts are derived from fixed labels; never use them with funds.",
  inputs: {
    supplierLEI: claims.supplierLEI,
    installationId: claims.installationId,
    cnCode: claims.cnCode,
    reportingPeriod: claims.reportingPeriod,
    verificationReportId: claims.verificationReportId,
    verifierLEI: claims.verifierLEI,
    auditorAID: AUDITOR_AID,
    batchId: demo.shipments[0].batchId,
    importerEORI1: demo.entities.importers[0].eori,
    importerEORI2: demo.entities.importers[1].eori,
    idSalt,
    idSalt2: label("idSalt-2"),
    batchSalt,
    importerSalt,
  },
  V1: {
    supplierCommit,
    installationCommit: installationCommitOf(claims.installationId, idSalt),
  },
  V2: { supplierCommitTamperedLei: supplierCommitOf(claims.supplierLEI.slice(0, -1) + "3", idSalt) },
  V3: { supplierCommitOtherSalt: supplierCommitOf(claims.supplierLEI, label("idSalt-2")) },
  V4: { reportKey, batchKey: batchKeyOf(reportKey, demo.shipments[0].batchId, batchSalt) },
  V5: {
    importerCommit1: importerCommitOf(demo.entities.importers[0].eori, importerSalt),
    importerCommit2: importerCommitOf(demo.entities.importers[1].eori, importerSalt),
  },
  V6: {
    reportScopeKey: reportScopeKeyOf(claims.installationId, claims.reportingPeriod),
    credScopeKeyRouteC: credScopeKeyOf(claims.installationId, claims.cnCode, "C", claims.reportingPeriod),
    credScopeKeyRouteE: credScopeKeyOf(claims.installationId, claims.cnCode, "E", claims.reportingPeriod),
  },
  V7: {
    coreJson: cred.coreJson,
    d: cred.core.d,
    crossCheck: "keripy 1.2.13 Saider.saidify(label='d', code=Blake3_256) gives the same d: sdk/scripts/check-said-keripy.sh",
  },
  V10: {
    registry: TEST_REGISTRY,
    chainId: 11155111,
    credSAID: message.credSAID,
    supplierCommit: message.supplierCommit,
    verifiedKg: message.verifiedKg.toString(),
    validUntil: message.validUntil.toString(),
    typedDataHash: hashTypedData(typedDataOf(TEST_REGISTRY, message)),
    signature,
    signer: signer.address,
  },
  V11: { otherSignature, otherSigner: privateKeyToAccount(OTHER_SIGNER_KEY).address },
  V13: {
    disclosure: cred.disclosures.specificEmbeddedEmissions_tCO2e_per_t,
    digest: disclosureDigest(cred.disclosures.specificEmbeddedEmissions_tCO2e_per_t),
    tamperedDisclosure: tampered,
    tamperedDigest: disclosureDigest(tampered),
  },
  V16: { "500": "500000", "0.5": "500", "0.0005": "reject", "79228162514264337593543951": "reject" },
  V17: {
    reportKey,
    reportIdHash: reportIdHashOf(claims.verificationReportId),
    auditorAidHash: auditorAidHashOf(AUDITOR_AID),
    verifierLeiHash: leiHashOf(claims.verifierLEI),
  },
  disclosures: cred.disclosures,
};

writeFileSync(new URL("../../fixtures/vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
console.log(`vectors written; credSAID ${cred.core.d}`);
