// Check 8 sub-rules on the verification report (sdk/verification-rules.ts): report dates, site visit,
// accreditation at the report date, and the verifier's accreditation provenance. Positive and negative cases.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkReconciliation, reconcile, type ReconciledClaims, type ReportExtract } from "../consistency.ts";
import {
  activityGroupOf,
  FIRST_REPORT_DATE,
  provenanceRules,
  registryShapeProblem,
  reportRules,
  type AccreditationRegistry,
} from "../verification-rules.ts";

const root = new URL("../../fixtures/", import.meta.url);
const extract = JSON.parse(readFileSync(new URL("report-VR-DEMO-0001.json", root), "utf8")).extract as ReportExtract;
const registry = JSON.parse(readFileSync(new URL("accreditation-registry.json", root), "utf8")) as AccreditationRegistry;
const demo = JSON.parse(readFileSync(new URL("demo.json", root), "utf8"));
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
const LEI = demo.entities.verifier.lei as string;
const SAID_HASH = registry.records[0].accreditationSaidHash!;

/** Check 8 on an extract the auditor reconciled and signed (the hashes match). */
const signedCheck = (x: Partial<ReportExtract & { siteVisitReason: string; lastPhysicalSiteVisit: string }>, c: Partial<ReconciledClaims> = {}) => {
  const e = { ...extract, ...x } as ReportExtract;
  const cl = { ...claims, ...c };
  return checkReconciliation(e, cl, reconcile(e, cl).reconciliation, [], { registry, verifierLEI: LEI, accreditationSaidHash: SAID_HASH });
};
const rule = (r: ReturnType<typeof signedCheck>, name: string) => r.rules?.find((s) => s.rule === name);

describe("check 8 sub-rules: the demo report (VR-DEMO-0001, calendar 2026, dated 15 March 2027)", () => {
  it("passes every sub-rule; the Commission list is a note only, so check 8 stays a pass", () => {
    const r = signedCheck({});
    expect(r.status).toBe("pass");
    expect(r.rules?.filter((s) => s.status !== "pass" && s.status !== "note")).toEqual([]);
    expect(rule(r, "commission-list")).toMatchObject({ status: "note", code: "VERIFIER_PROVENANCE/COMMISSION_LIST_UNPUBLISHED" });
    expect(rule(r, "commission-list")?.detail).toContain("2026-10-16");
    expect(rule(r, "scope")?.detail).toContain("activity group VIII");
  });
  it("without a registry, only the report rules run (no provenance)", () => {
    const r = checkReconciliation(extract, claims, reconcile(extract, claims).reconciliation);
    expect(r.status).toBe("pass");
    expect(r.rules?.map((s) => s.rule)).toEqual(["first-report-date", "report-after-period", "accreditation-at-report-date", "site-visit"]);
  });
});

describe("rule 1: report timing", () => {
  it(`a report dated before ${FIRST_REPORT_DATE} fails check 8 when the auditor signed it (INVALID)`, () => {
    const r = signedCheck({ signedAt: "2026-12-20", reportingPeriod: "2026-01-01/2026-11-30" }, { reportingPeriod: "2026-01-01/2026-11-30" });
    expect(r.status).toBe("fail");
    expect(r.code).toBe("VERIFICATION_RULE/REPORT_BEFORE_FIRST_ISSUE_DATE");
  });
  it("a report dated before its reporting period ended fails (signed)", () => {
    const x = { ...extract, reportingPeriod: "2027-01-01/2027-12-31", signedAt: "2027-06-30" };
    const rules = reportRules(x, true);
    expect(rules.find((s) => s.rule === "first-report-date")?.status).toBe("pass");
    expect(rules.find((s) => s.rule === "report-after-period")).toMatchObject({ status: "fail", code: "VERIFICATION_RULE/REPORT_BEFORE_PERIOD_END" });
  });
  it("a report dated on the last day of the period fails: it must be after the period", () => {
    expect(reportRules({ ...extract, signedAt: "2026-12-31" }, true).find((s) => s.rule === "report-after-period")?.status).toBe("fail");
    expect(reportRules({ ...extract, signedAt: "2027-01-01" }, true).find((s) => s.rule === "report-after-period")?.status).toBe("pass");
  });
  it("the same breach in an unsigned extract is only a warning (advisory)", () => {
    const rules = reportRules({ ...extract, signedAt: "2026-12-20" }, false);
    expect(rules.find((s) => s.rule === "first-report-date")).toMatchObject({ status: "warn" });
    expect(rules.find((s) => s.rule === "first-report-date")?.detail).toContain("not covered by a signature");
    const r = checkReconciliation({ ...extract, signedAt: "2026-12-20" }, claims); // credential without a reconciliation proof
    expect(r.status).toBe("warn");
    expect(r.code).toBe("VERIFICATION_RULE/REPORT_BEFORE_FIRST_ISSUE_DATE");
  });
  it("an extract changed after signing keeps PROOF_MISMATCH and never fails", () => {
    const signed = reconcile(extract, claims).reconciliation;
    const r = checkReconciliation({ ...extract, signedAt: "2026-12-20" }, claims, signed);
    expect(r).toMatchObject({ status: "warn", code: "CONSISTENCY_WARNING/PROOF_MISMATCH" });
  });
  it("an unreadable report date is a warning", () => {
    expect(reportRules({ ...extract, signedAt: "soon" }, true).find((s) => s.rule === "report-after-period")?.status).toBe("warn");
  });
});

describe("rule 1b: accreditation valid on the report date (not only at registration)", () => {
  it("expired before the report date → fail (signed)", () => {
    const r = signedCheck({ accreditedUntil: "2027-02-28" });
    expect(r.status).toBe("fail");
    expect(r.code).toBe("VERIFICATION_RULE/ACCREDITATION_EXPIRED_AT_REPORT");
  });
  it("valid on the report date → pass", () => {
    expect(reportRules({ ...extract, accreditedUntil: "2027-03-15" }, true).find((s) => s.rule === "accreditation-at-report-date")?.status).toBe("pass");
  });
  it("no expiry date → warning", () => {
    expect(reportRules({ ...extract, accreditedUntil: "" }, true).find((s) => s.rule === "accreditation-at-report-date")?.status).toBe("warn");
  });
});

describe("rule 2: site visit (IR 2025/2546 Art 2-4)", () => {
  const sv = (x: Record<string, unknown>, signed = true) => reportRules({ ...extract, ...x } as ReportExtract, signed).find((s) => s.rule === "site-visit")!;
  it("first period, physical → pass", () => expect(sv({}).status).toBe("pass"));
  it("first period, virtual without a force-majeure reason → fail (signed): Art 3 needs an earlier physical visit", () => {
    expect(sv({ siteVisit: "virtual" })).toMatchObject({ status: "fail", code: "VERIFICATION_RULE/FIRST_PERIOD_NO_PHYSICAL_VISIT" });
    const r = signedCheck({ siteVisit: "virtual" }, { siteVisit: "virtual" });
    expect(r.status).toBe("fail");
  });
  it("first period, waived → fail (signed); warning when unsigned", () => {
    expect(sv({ siteVisit: "waived" }).status).toBe("fail");
    expect(sv({ siteVisit: "waived" }, false).status).toBe("warn");
  });
  it("virtual for force majeure (Art 4) → warning: a person reads the reasons", () => {
    expect(sv({ siteVisit: "virtual", siteVisitReason: "force-majeure" })).toMatchObject({ status: "warn", code: "VERIFICATION_RULE/SITE_VISIT_FORCE_MAJEURE" });
  });
  it("site visit not stated → warning, not a failure", () => {
    expect(sv({ siteVisit: "" })).toMatchObject({ status: "warn", code: "VERIFICATION_RULE/SITE_VISIT_NOT_STATED" });
    expect(sv({ siteVisit: undefined })).toMatchObject({ status: "warn" });
  });
  it("later period, virtual with a physical visit in the preceding period → pass; without → warning", () => {
    const later = { firstVerifiedPeriod: false, reportingPeriod: "2027-01-01/2027-12-31", signedAt: "2028-03-01", siteVisit: "virtual" };
    expect(sv({ ...later, lastPhysicalSiteVisit: "2027-02-08" }).status).toBe("pass"); // visit for the 2026 period, in its verification
    expect(sv({ ...later, lastPhysicalSiteVisit: "2026-11-08" }).status).toBe("pass"); // visit during the 2026 period
    expect(sv({ ...later, lastPhysicalSiteVisit: "2025-02-08" })).toMatchObject({ status: "warn", code: "VERIFICATION_RULE/SITE_VISIT_VIRTUAL_UNSUPPORTED" });
    expect(sv(later)).toMatchObject({ status: "warn", code: "VERIFICATION_RULE/SITE_VISIT_VIRTUAL_UNSUPPORTED" });
    expect(sv({ ...later, siteVisit: "waived" })).toMatchObject({ status: "warn", code: "VERIFICATION_RULE/SITE_VISIT_WAIVED" });
  });
});

describe("rule 3: accreditation provenance (the allowlist operator's record)", () => {
  const prov = (reg: AccreditationRegistry, x: Partial<ReportExtract> = {}, cnCode = "7318", saidHash: string | undefined = SAID_HASH) =>
    provenanceRules(reg, { ...extract, ...x }, { verifierLEI: LEI, cnCode, ...(saidHash ? { accreditationSaidHash: saidHash } : {}) });
  const withRec = (patch: Record<string, unknown>): AccreditationRegistry => ({ ...registry, records: [{ ...registry.records[0], ...patch }] });
  const codes = (rs: ReturnType<typeof prov>) => rs.filter((s) => s.status === "warn").map((s) => s.code);

  it("the demo record matches the report: nothing to review", () => expect(codes(prov(registry))).toEqual([]));
  it("no record for the body", () => expect(codes(prov({ ...registry, records: [] }))).toEqual(["VERIFIER_PROVENANCE/NO_RECORD"]));
  it("another accreditation number or NAB than the report", () => {
    expect(codes(prov(withRec({ accreditationNumber: "OTHER-1" })))).toContain("VERIFIER_PROVENANCE/RECORD_MISMATCH");
  });
  it("a record that names another accreditation credential than the allowlist", () => {
    expect(codes(prov(registry, {}, "7318", "0xdead"))).toContain("VERIFIER_PROVENANCE/RECORD_MISMATCH");
  });
  it("an accreditation body outside the EU", () => {
    expect(codes(prov(withRec({ nab: { name: "Demo Accreditation Body (fictional)", country: "TW" } })))).toContain("VERIFIER_PROVENANCE/NAB_NOT_EU");
  });
  it("no EN ISO/IEC 17029", () => expect(codes(prov(withRec({ standards: ["ISO 14064-3"] })))).toContain("VERIFIER_PROVENANCE/STANDARD"));
  it("CN code or activity group out of scope", () => {
    expect(codes(prov(withRec({ cnScope: ["7208"] })))).toContain("VERIFIER_PROVENANCE/OUT_OF_SCOPE");
    expect(codes(prov(withRec({ activityGroups: ["V"] })))).toContain("VERIFIER_PROVENANCE/OUT_OF_SCOPE");
  });
  it("not valid on the report date, or a suspension in force then", () => {
    expect(codes(prov(withRec({ validFrom: "2027-04-01" })))).toContain("VERIFIER_PROVENANCE/NOT_VALID_AT_REPORT");
    expect(codes(prov(withRec({ administrativeMeasures: [{ type: "suspension", from: "2027-03-01" }] })))).toContain("VERIFIER_PROVENANCE/MEASURE_IN_FORCE");
    expect(codes(prov(withRec({ administrativeMeasures: [{ type: "suspension", from: "2027-01-01", until: "2027-02-01" }] })))).toEqual([]);
  });
  it("a validity longer than five years (Art 51 AVR-DA)", () => {
    expect(codes(prov(withRec({ validFrom: "2024-01-01", validUntil: "2030-12-31" })))).toContain("VERIFIER_PROVENANCE/DATES");
  });
  it("record warnings make check 8 a warning (advisory), never a failure", () => {
    const e = extract;
    const r = checkReconciliation(e, claims, reconcile(e, claims).reconciliation, [], { registry: withRec({ cnScope: ["7208"] }), verifierLEI: LEI });
    expect(r).toMatchObject({ status: "warn", code: "VERIFIER_PROVENANCE/OUT_OF_SCOPE" });
  });
  it("once the Commission publishes its list, the note says so", () => {
    const pub = { ...registry, commissionList: { ...registry.commissionList, published: true } };
    expect(prov(pub).find((s) => s.rule === "commission-list")).toMatchObject({ status: "note", code: "" });
  });
  it("a malformed registry is a warning", () => {
    expect(registryShapeProblem({ records: "x" })).toBeTruthy();
    expect(registryShapeProblem(registry)).toBeNull();
    const r = checkReconciliation(extract, claims, reconcile(extract, claims).reconciliation, [], { registry: { records: "x" } as never, verifierLEI: LEI });
    expect(r.status).toBe("warn");
  });
  it("activity groups for the mapped CN codes", () => {
    expect(activityGroupOf("7318")).toBe("VIII");
    expect(activityGroupOf("2716")).toBe("LI");
    expect(activityGroupOf("7208")).toBeUndefined();
  });
});
