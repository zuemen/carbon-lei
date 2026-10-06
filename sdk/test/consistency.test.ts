// Check 8 (rule-based reconciliation, advisory) — V18 and the extract-tampering case.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkReconciliation, cnInScope, reconcile, RECONCILED_CLAIMS, type ReconciledClaims, type ReportExtract } from "../consistency.ts";

const extract = JSON.parse(readFileSync(new URL("../../fixtures/report-VR-DEMO-0001.json", import.meta.url), "utf8")).extract as ReportExtract;
const claims: ReconciledClaims = {
  verifiedTonnes: "500",
  specificEmbeddedEmissions_tCO2e_per_t: "1.8",
  verificationReportId: "VR-DEMO-0001",
  reportingPeriod: "2026-01-01/2026-12-31",
  installationId: "TW-ZZZZ00TWSCREWDEMO185-0001",
  accreditationNumber: "DEMO-ACC-CBAM-0001",
  nabName: "Demo Accreditation Body (fictional)",
  cnCode: "7318",
  siteVisit: "physical",
  assuranceLevel: "reasonable",
  materialityThreshold: "5%",
  issuedAt: "2027-03-20T00:00:00Z",
  validUntil: "2027-12-31T00:00:00Z",
};

describe("check 8: reconciliation", () => {
  it("a matching report passes all rules and the signed hashes", () => {
    const { findings, reconciliation } = reconcile(extract, claims);
    expect(findings.every((f) => f.ok)).toBe(true);
    expect(checkReconciliation(extract, claims, reconciliation)).toMatchObject({ status: "pass" });
  });

  it("V18: the report says 480 t but the credential 500 t → FIELD_MISMATCH (advisory warning)", () => {
    const report480 = { ...extract, quantityPerCn: [{ cnCode: "7318", quantity: "480" }] };
    const signed = reconcile(report480, claims).reconciliation; // the body signed despite the mismatch
    expect(checkReconciliation(report480, claims, signed)).toMatchObject({ status: "warn", code: "CONSISTENCY_WARNING/FIELD_MISMATCH" });
  });

  it("an extract changed after signing → PROOF_MISMATCH", () => {
    const signed = reconcile(extract, claims).reconciliation;
    const changed = { ...extract, specificEmbeddedEmissionsPerCn: [{ cnCode: "7318", value: "1.2" }] };
    expect(checkReconciliation(changed, claims, signed)).toMatchObject({ status: "warn", code: "CONSISTENCY_WARNING/PROOF_MISMATCH" });
  });

  it("each regulatory rule can flag", () => {
    const one = (x: Partial<ReportExtract>, c: Partial<ReconciledClaims> = {}) => {
      const e = { ...extract, ...x };
      const cl = { ...claims, ...c };
      return checkReconciliation(e, cl, reconcile(e, cl).reconciliation).code;
    };
    expect(one({ accreditationScope: ["CN 7208"] })).toBe("CONSISTENCY_WARNING/CN_NOT_IN_SCOPE");
    expect(one({ siteVisit: "virtual" }, { siteVisit: "virtual" })).toBe("CONSISTENCY_WARNING/FIRST_YEAR_NOT_PHYSICAL");
    expect(one({ assuranceLevel: "limited" }, { assuranceLevel: "limited" })).toBe("CONSISTENCY_WARNING/ASSURANCE_NOT_REASONABLE");
    expect(one({ materialityThreshold: "10%" }, { materialityThreshold: "10%" })).toBe("CONSISTENCY_WARNING/MATERIALITY_NOT_5");
    expect(one({ signedAt: "2026-10-20" })).toBe("CONSISTENCY_WARNING/PERIOD_ORDER"); // before the period ended
  });

  it("skips when the needed fields are not disclosed or the credential has no proof", () => {
    const partial = Object.fromEntries(Object.entries(claims).filter(([k]) => k !== RECONCILED_CLAIMS[0]));
    expect(checkReconciliation(extract, partial).status).toBe("skipped");
    expect(checkReconciliation(extract, claims, undefined).status).toBe("skipped");
  });

  it("says why it skipped: not disclosed, or disclosed but rejected by check 2", () => {
    const partial = Object.fromEntries(Object.entries(claims).filter(([k]) => k !== RECONCILED_CLAIMS[0]));
    expect(checkReconciliation(extract, partial).detail).toMatch(/not disclosed/);
    expect(checkReconciliation(extract, partial, undefined, []).detail).toMatch(/not disclosed/);
    expect(checkReconciliation(extract, partial, undefined, ["unrelatedField"]).detail).toMatch(/not disclosed/);
    const r = checkReconciliation(extract, partial, undefined, [RECONCILED_CLAIMS[0]]);
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("a disclosed field needed for the reconciliation was rejected by check 2");
  });

  it("CN scope matching by chapter, heading or full code", () => {
    expect(cnInScope("7318", ["CN 7318"])).toBe(true);
    expect(cnInScope("731815", ["73"])).toBe(true);
    expect(cnInScope("7318", ["7208"])).toBe(false);
  });
});
