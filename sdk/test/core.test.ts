import { readFileSync } from "node:fs";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
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
import {
  checkNormalForms,
  isCbamRoute,
  isInstallationId,
  isReportingPeriod,
  isoToSeconds,
  splitReportingPeriod,
  tonnesToKg,
  type Hex,
} from "../credential.ts";
import { buildCredential, decodeDisclosure, disclosureDigest, encodeDisclosure, selectDisclosures, sortDigests } from "../disclosure.ts";
import { recoverIssuer, typedDataOf } from "../eip712.ts";
import { base64url, fromBase64url, newSalt } from "../encoding.ts";
import { SAID_DUMMY, computeSaid, saidify, verifySaid } from "../said.ts";

const v = JSON.parse(readFileSync(new URL("../../fixtures/vectors.json", import.meta.url), "utf8"));
const inp = v.inputs;

describe("cross-language vectors (S7, same values as contracts/test/Vectors.t.sol)", () => {
  it("V1 supplier and installation commitments", () => {
    expect(supplierCommitOf(inp.supplierLEI, inp.idSalt)).toBe(v.V1.supplierCommit);
    expect(installationCommitOf(inp.installationId, inp.idSalt)).toBe(v.V1.installationCommit);
  });
  it("V2 one changed LEI character changes the commitment", () => {
    expect(supplierCommitOf(inp.supplierLEI.slice(0, -1) + "3", inp.idSalt)).toBe(v.V2.supplierCommitTamperedLei);
    expect(v.V2.supplierCommitTamperedLei).not.toBe(v.V1.supplierCommit);
  });
  it("V3 another salt gives an unlinkable commitment", () => {
    expect(supplierCommitOf(inp.supplierLEI, inp.idSalt2)).toBe(v.V3.supplierCommitOtherSalt);
    expect(v.V3.supplierCommitOtherSalt).not.toBe(v.V1.supplierCommit);
  });
  it("V4 batch key is deterministic and bound to the report", () => {
    expect(reportKeyOf(v.V7.d)).toBe(v.V4.reportKey);
    expect(batchKeyOf(v.V4.reportKey, inp.batchId, inp.batchSalt)).toBe(v.V4.batchKey);
    expect(batchKeyOf(v.V17.reportIdHash, inp.batchId, inp.batchSalt)).not.toBe(v.V4.batchKey);
  });
  it("V5 importer commitments differ per EORI", () => {
    expect(importerCommitOf(inp.importerEORI1, inp.importerSalt)).toBe(v.V5.importerCommit1);
    expect(importerCommitOf(inp.importerEORI2, inp.importerSalt)).toBe(v.V5.importerCommit2);
  });
  it("V6 one report scope, two credential layers for two routes", () => {
    expect(reportScopeKeyOf(inp.installationId, inp.reportingPeriod)).toBe(v.V6.reportScopeKey);
    expect(credScopeKeyOf(inp.installationId, inp.cnCode, "C", inp.reportingPeriod)).toBe(v.V6.credScopeKeyRouteC);
    expect(credScopeKeyOf(inp.installationId, inp.cnCode, "E", inp.reportingPeriod)).toBe(v.V6.credScopeKeyRouteE);
  });
  it("V17 string hashes", () => {
    expect(reportKeyOf(v.V7.d)).toBe(v.V17.reportKey);
    expect(reportIdHashOf(inp.verificationReportId)).toBe(v.V17.reportIdHash);
    expect(auditorAidHashOf(inp.auditorAID)).toBe(v.V17.auditorAidHash);
    expect(leiHashOf(inp.verifierLEI)).toBe(v.V17.verifierLeiHash);
  });
});

describe("SAID (S1)", () => {
  it("V7 recomputes the core SAID (cross-checked with keripy 1.2.13)", () => {
    expect(verifySaid(v.V7.coreJson)).toBe(true);
    expect(computeSaid(JSON.parse(v.V7.coreJson))).toBe(v.V7.d);
    expect(v.V7.d).toMatch(/^E[A-Za-z0-9_-]{43}$/);
  });
  it("V8 reordering two keys changes the SAID", () => {
    const core = JSON.parse(v.V7.coreJson);
    const { type, version, ...rest } = core;
    const reordered = JSON.stringify({ version, type, ...rest });
    expect(verifySaid(reordered)).toBe(false);
  });
  it("V9 one second in issuedAt changes the SAID", () => {
    const core = JSON.parse(v.V7.coreJson);
    core.issuedAt = "2026-10-01T00:00:01Z";
    expect(verifySaid(JSON.stringify(core))).toBe(false);
  });
  it("a `d` that is missing, not a string or not 44 characters never verifies; saidify fills a `d` that does", () => {
    const { d, ...noD } = JSON.parse(v.V7.coreJson);
    expect(verifySaid(JSON.stringify(noD))).toBe(false);
    expect(verifySaid(JSON.stringify({ d: 1, ...noD }))).toBe(false);
    expect(verifySaid(JSON.stringify({ d: d.slice(0, 43), ...noD }))).toBe(false);
    // the dummy itself is 44 characters but is not the digest
    expect(verifySaid(JSON.stringify({ d: SAID_DUMMY, ...noD }))).toBe(false);
    expect(() => computeSaid(noD)).toThrow("object has no 'd' field");
    expect(() => saidify(noD)).toThrow("object has no 'd' field");
    const filled = saidify({ d: "", ...noD });
    expect(filled.d).toBe(d);
    expect(verifySaid(JSON.stringify(filled))).toBe(true);
  });
});

describe("selective disclosure (S2)", () => {
  it("V13 digest of a disclosure; the Tamper value 1.2 gives another digest", () => {
    expect(disclosureDigest(v.V13.disclosure)).toBe(v.V13.digest);
    expect(decodeDisclosure(v.V13.disclosure).value).toBe("1.8");
    expect(disclosureDigest(v.V13.tamperedDisclosure)).toBe(v.V13.tamperedDigest);
    expect(v.V13.tamperedDigest).not.toBe(v.V13.digest);
    expect(JSON.parse(v.V7.coreJson).digests).toContain(v.V13.digest);
    expect(JSON.parse(v.V7.coreJson).digests).not.toContain(v.V13.tamperedDigest);
    expect(v.V13.digest).toHaveLength(43);
  });
  it("V14 digest order does not depend on input order", () => {
    const ds = Object.values(v.disclosures as Record<string, string>).map(disclosureDigest);
    expect(sortDigests([...ds].reverse())).toEqual(sortDigests(ds));
    expect(sortDigests(ds)).toEqual(JSON.parse(v.V7.coreJson).digests);
  });
  it("every claim has a disclosure whose digest is in the core", () => {
    const digests = new Set(JSON.parse(v.V7.coreJson).digests);
    for (const [name, enc] of Object.entries(v.disclosures as Record<string, string>)) {
      expect(decodeDisclosure(enc).name).toBe(name);
      expect(digests.has(disclosureDigest(enc))).toBe(true);
    }
  });
  it("round-trips a disclosure and rejects malformed ones", () => {
    const d = { salt: newSalt(), name: "cnCode", value: "7318" };
    expect(decodeDisclosure(encodeDisclosure(d))).toEqual(d);
    expect(() => decodeDisclosure(base64url(new TextEncoder().encode('["0x12","a","b"]')))).toThrow();
  });
  it("issuance refuses a missing claim, and a supplier cannot select a disclosure that was never issued", () => {
    const claims: Record<string, string> = Object.fromEntries(
      Object.values(v.disclosures as Record<string, string>).map((enc) => [decodeDisclosure(enc).name, decodeDisclosure(enc).value]),
    );
    const input = { verifierAddress: JSON.parse(v.V7.coreJson).issuer.verifierAddress, auditorAID: inp.auditorAID };
    expect(buildCredential({ claims: claims as never, ...input }).core.digests).toHaveLength(Object.keys(claims).length);
    delete claims.cnCode;
    expect(() => buildCredential({ claims: claims as never, ...input })).toThrow("claim cnCode missing");
    expect(() => selectDisclosures(v.disclosures, ["cnCode", "noSuchField"])).toThrow("no disclosure for noSuchField");
  });
});

describe("EIP-712 (S3)", () => {
  const message = {
    credSAID: v.V10.credSAID,
    supplierCommit: v.V10.supplierCommit as Hex,
    verifiedKg: BigInt(v.V10.verifiedKg),
    validUntil: BigInt(v.V10.validUntil),
  };
  it("V10 typed-data hash and signer", async () => {
    expect(hashTypedData(typedDataOf(v.V10.registry, message))).toBe(v.V10.typedDataHash);
    expect((await recoverIssuer(v.V10.registry, message, v.V10.signature)).toLowerCase()).toBe(
      v.V10.signer.toLowerCase(),
    );
  });
  it("V11 another wallet's signature recovers another address", async () => {
    expect((await recoverIssuer(v.V10.registry, message, v.V11.otherSignature)).toLowerCase()).not.toBe(
      v.V10.signer.toLowerCase(),
    );
  });
  it("V12 a changed verified quantity changes the recovered address", async () => {
    const changed = { ...message, verifiedKg: 600_000n };
    expect((await recoverIssuer(v.V10.registry, changed, v.V10.signature)).toLowerCase()).not.toBe(
      v.V10.signer.toLowerCase(),
    );
  });
});

describe("units and normal forms", () => {
  it("V16 tonnes to kilograms", () => {
    expect(tonnesToKg("500")).toBe(500_000n);
    expect(tonnesToKg("0.5")).toBe(500n);
    expect(tonnesToKg("1.250")).toBe(1_250n);
    expect(() => tonnesToKg("0.0005")).toThrow();
    expect(() => tonnesToKg("79228162514264337593543951")).toThrow();
    expect(() => tonnesToKg("-1")).toThrow();
    expect(() => tonnesToKg("0")).toThrow();
    expect(() => tonnesToKg("1e3")).toThrow();
  });
  it("ISO times to seconds", () => {
    expect(isoToSeconds("2027-12-31T00:00:00Z")).toBe(1830211200n);
    expect(() => isoToSeconds("31/12/2027")).toThrow();
  });
  it("identifier normal forms (I20)", () => {
    expect(isInstallationId("TW-ZZZZ00TWSCREWDEMO185-0001")).toBe(true);
    expect(isInstallationId("tw-ZZZZ00TWSCREWDEMO185-0001")).toBe(false);
    expect(isReportingPeriod("2026-01-01/2026-12-31")).toBe(true);
    expect(isReportingPeriod("2026")).toBe(false);
    expect(isReportingPeriod("2026-12-31/2026-01-01")).toBe(false);
    expect(isReportingPeriod("2026-02-30/2026-12-31")).toBe(false);
    expect(splitReportingPeriod("2026-01-01/2026-12-31")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(isCbamRoute("C")).toBe(true);
    expect(isCbamRoute("(C)")).toBe(false);
    expect(checkNormalForms({ cnCode: "7318 15" })).toEqual(["cnCode"]);
  });
  it("base64url round trip", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 0xff);
      expect(fromBase64url(base64url(bytes))).toEqual(bytes);
    }
  });
});
