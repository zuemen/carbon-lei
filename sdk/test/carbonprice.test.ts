// Check 10 without a chain (DRAFT CBAM Art 9 rules — not adopted, illustrative): the statement's shape and SAID, the
// price re-derivation of the draft's Annex I (eq. 5a, 6a, 11a, 12a, 15a) with a pinned exchange rate, the attacks that
// need no chain (exchange rate manipulated, rebates hidden, payment not evidenced, emissions inflated, overstated
// price), the reduction of draft Art 6(1), the portfolio's separate Art 9 block and the certifier's synthetic chain.
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  CARBON_PRICE_STATEMENT_TYPE,
  CARBON_PRICE_STATEMENT_VERSION,
  CERTIFIER_ACTIVITY,
  CERTIFIER_ROLE,
  DRAFT_LABEL,
  PINNED_FX,
  art9Reduction,
  art9Summary,
  carbonPriceKeys,
  checkCarbonPriceOffline,
  fmtRat,
  recomputePrice,
  saidifyStatement,
  statementProblem,
  type CarbonPriceReport,
  type CarbonPriceStatement,
} from "../carbonprice.ts";
import { computeSaid } from "../said.ts";
import { buildPortfolio } from "../portfolio.ts";
import type { Verdict } from "../verdict.ts";
import { reportScopeKeyOf, credScopeKeyOf } from "../commitment.ts";
import { AUDITOR_ROLE, DEMO_TRUST_ANCHOR, PRECURSOR_DEMO_TRUST_ANCHOR, verifyAuthority } from "../vlei.ts";
import { precursorChainInput, syntheticPrecursorChain } from "../../verifier/src/precursor-chain.ts";
import { demo } from "../../scripts/precursor-scenario.ts";
import { CP, exemptOf } from "../../scripts/carbonprice-scenario.ts";

const SAID = "E" + "A".repeat(43);
const base = (over: Partial<CarbonPriceStatement> = {}): CarbonPriceStatement =>
  saidifyStatement({
    type: CARBON_PRICE_STATEMENT_TYPE,
    version: CARBON_PRICE_STATEMENT_VERSION,
    notice: DRAFT_LABEL,
    operator: { name: "Demo Wire Rod Co. (fictional)", lei: "ZZZZ00TWWIRERDEMO108", installationId: "TW-ZZZZ00TWWIRERDEMO108-0001" },
    reportingPeriod: "2026-01-01/2026-12-31",
    cnCode: "7213",
    credentials: [SAID],
    mechanism: { country: "TW", name: "Taiwan carbon fee (碳費)", legalBasis: "test", form: "point-source carbon tax", covers: "direct" },
    currency: "TWD",
    ratePerTonne: "300",
    cpmEmissions: "576000",
    exemptEmissions: "460800",
    exemptBasis: "factor 0.2",
    adjustment: { thresholdK: "0", factor: "0.2" },
    refunds: "0",
    feePaid: "34560000",
    productionTonnes: "400000",
    emissionsPerTonne: "1.44",
    fx: { unitsPerEur: "35.196", year: 2025, source: "Eurostat" },
    effectivePriceEurPerTonne: "2.454824",
    materiality: "5%",
    rebatesChecked: true,
    certifier: { name: "Demo Carbon Price Certification GmbH (fictional)", lei: "ZZZZ00EUCPCERTDEMO77", auditorAID: "E" + "B".repeat(43), accreditationNumber: "DEMO-ACC-LIV-0001" },
    certificationReportId: "CPR-1",
    certifiedAt: "2027-06-30T00:00:00Z",
    validUntil: "2027-12-31T00:00:00Z",
    ...over,
  });
const codes = (r: ReturnType<typeof recomputePrice>) => r.problems.map((p) => `${p.status}:${p.code}`);

describe("carbon price statement: shape, SAID and keys", () => {
  it("a well-formed statement has no problem and a SAID over its content", () => {
    const s = base();
    expect(statementProblem(s)).toBeNull();
    expect(computeSaid(s as unknown as Record<string, unknown>)).toBe(s.d);
    expect(computeSaid({ ...s, effectivePriceEurPerTonne: "9" } as unknown as Record<string, unknown>)).not.toBe(s.d);
  });
  it.each([
    [{ notice: "final" }, "notice"],
    [{ rebatesChecked: false }, "rebates and compensation were checked"],
    [{ materiality: "2%" as "5%" }, "materiality"],
    [{ exemptEmissions: "600000" }, "exceed cpmEmissions"],
    [{ mechanism: { country: "TW", name: "x", legalBasis: "y", form: "ETS" as "point-source carbon tax", covers: "direct" as const } }, "point-source carbon tax"],
    [{ credentials: [] }, "credentials"],
    [{ fx: { unitsPerEur: "0", year: 2025, source: "x" } }, "fx"],
    [{ productionTonnes: "1.2345" }, "productionTonnes"],
    [{ adjustment: { thresholdK: "0", factor: "1.5" } }, "adjustment"],
  ])("rejects %j", (over, why) => {
    expect(statementProblem(base(over as Partial<CarbonPriceStatement>))).toContain(why);
  });
  it("registry keys live in their own domain: never an emissions report's scope keys", () => {
    const s = base();
    const k = carbonPriceKeys(s);
    expect(k.reportScopeKey).not.toBe(reportScopeKeyOf(s.operator.installationId, s.reportingPeriod));
    expect(k.credScopeKey).not.toBe(credScopeKeyOf(s.operator.installationId, s.cnCode, "C", s.reportingPeriod));
    expect(carbonPriceKeys(base({ reportingPeriod: "2027-01-01/2027-12-31" })).reportScopeKey).not.toBe(k.reportScopeKey);
  });
});

describe("carbon price re-derivation (draft Annex I)", () => {
  it("Taiwan fee, NT$300 × factor 0.2: NT$86.4 per t of wire rod, €2.454824 at the pinned 35.196 (= €1.704739/tCO2e)", () => {
    const r = recomputePrice(base(), { seeCap: "1.44" });
    expect(fmtRat(r.paidShare)).toBe("0.2");
    expect(fmtRat(r.paidEmissionsPerTonne)).toBe("0.288");
    expect(fmtRat(r.localPerTonne)).toBe("86.4");
    expect(fmtRat(r.eurPerTonne!)).toBe("2.454824");
    expect(fmtRat(r.eurPerTCO2e!)).toBe("1.704739");
    expect(r.fx).toMatchObject({ pinned: true, unitsPerEur: "35.196", year: 2025 });
    // The 2025 rate for a 2026 period: advisory only.
    expect(codes(r)).toEqual(["warn:CARBON_PRICE_WARNING/FX_YEAR"]);
    // vs the €82.32 CBAM price: about 2 %
    expect(Number(fmtRat(r.eurPerTCO2e!)) / 82.32).toBeCloseTo(0.0207, 4);
  });
  it("the preferential NT$100 and NT$50 rates and the next period's factor 0.4 scale it linearly", () => {
    const at = (rate: string, factor: string) => {
      const cpm = "576000";
      const s = base({ ratePerTonne: rate, adjustment: { thresholdK: "0", factor }, exemptEmissions: exemptOf(cpm, "0", factor), feePaid: String(Number(cpm) * Number(factor) * Number(rate)) });
      return fmtRat(recomputePrice(s).eurPerTonne!);
    };
    expect(at("100", "0.2")).toBe("0.818275"); // 1.44 × 0.2 × 100 / 35.196
    expect(at("50", "0.2")).toBe("0.409137");
    expect(at("300", "0.4")).toBe("4.909649");
  });
  it("refunds reduce the rate (eq. 5a, 6a)", () => {
    const r = recomputePrice(base({ refunds: "5760000" })); // 10 TWD per tonne of CPM emissions
    expect(fmtRat(r.localPerTonne)).toBe("83.52"); // 0.288 × (300 − 10)
  });
  it("FX manipulation: a rate other than the pinned one fails; no pinned rate leaves it undecided", () => {
    expect(codes(recomputePrice(base({ fx: { unitsPerEur: "30", year: 2025, source: "made up" } })))).toContain("fail:CARBON_PRICE_INVALID/FX_MISMATCH");
    // the € value uses the pinned rate, never the statement's
    expect(fmtRat(recomputePrice(base({ fx: { unitsPerEur: "30", year: 2025, source: "made up" } })).eurPerTonne!)).toBe("2.454824");
    const none = recomputePrice(base(), { fxTable: [] });
    expect(none.eurPerTonne).toBeNull();
    expect(codes(none)).toContain("skipped:");
    expect(PINNED_FX.find((r) => r.currency === "TWD")?.source).toContain("Eurostat ert_bil_eur_a");
  });
  it("rebates hidden: an exemption smaller than the scheme's own K and factor give fails", () => {
    expect(codes(recomputePrice(base({ exemptEmissions: "0", feePaid: "172800000" })))).toContain("fail:CARBON_PRICE_INVALID/REBATES_UNDERSTATED");
  });
  it("rebates hidden without parameters: the implied payment above the official record fails", () => {
    const { adjustment: _a, ...rest } = base();
    const s = saidifyStatement({ ...rest, exemptEmissions: "0" });
    expect(codes(recomputePrice(s))).toContain("fail:CARBON_PRICE_INVALID/PAYMENT_NOT_EVIDENCED");
  });
  it("emissions inflated: more attributed to the good than the mechanism covered (+5 %) fails", () => {
    expect(codes(recomputePrice(base({ emissionsPerTonne: "1.6" })))).toContain("fail:CARBON_PRICE_INVALID/EMISSIONS_EXCEED_CPM");
    expect(codes(recomputePrice(base({ emissionsPerTonne: "1.5" })))).not.toContain("fail:CARBON_PRICE_INVALID/EMISSIONS_EXCEED_CPM"); // within 5 %
  });
  it("paid emissions are capped at the credential's embedded emissions (advisory)", () => {
    const r = recomputePrice(base(), { seeCap: "0.2" });
    expect(fmtRat(r.coveredEmissionsPerTonne)).toBe("0.2");
    expect(codes(r)).toContain("warn:CARBON_PRICE_WARNING/CAPPED");
  });
  it("the demo fixture's numbers are the ones above", () => {
    expect(exemptOf(CP.mill.cpmEmissions)).toBe("460800");
    expect(Number(CP.fee.feePaid)).toBe(115200 * 300);
    expect(Number(CP.mill.emissionsPerTonne) * Number(CP.mill.productionTonnes)).toBe(Number(CP.mill.cpmEmissions));
  });
});

describe("the reduction (draft Art 6(1)) and the portfolio's separate Art 9 block", () => {
  it("200 t of screws × (1.125 × €2.454824) ÷ €82.32 = 6.709 certificates, rounded down, capped at the obligation", () => {
    expect(art9Reduction("2.761677", "82.32", "200")).toBe("6.709");
    expect(art9Reduction("2.761677", "82.32", "200", "360")).toBe("6.709");
    expect(art9Reduction("500", "82.32", "200", "360")).toBe("360.000");
  });
  const report = (eur: string): CarbonPriceReport =>
    ({ draft: DRAFT_LABEL, statementSAID: SAID, mechanism: "Taiwan carbon fee (碳費) (TW)", deductibleEurPerTonneGood: eur, steps: [] }) as unknown as CarbonPriceReport;
  const verdict = (over: Partial<Verdict> = {}): Verdict =>
    ({
      overall: "VALID",
      primaryCode: "",
      checks: [
        { id: 5, name: "", status: "pass", code: "", detail: "" },
        { id: 10, name: "", status: "warn", code: "CARBON_PRICE_WARNING/FX_YEAR", detail: "" },
      ],
      disclosed: { specificEmbeddedEmissions_tCO2e_per_t: "1.8", valueType: "actual", cnCode: "7318", unLocode: "TWKHH" },
      credSAID: SAID,
      chain: { block: 1 },
      carbonPrice: report("2.761677"),
      ...over,
    }) as unknown as Verdict;
  const ship = (id: string, v: Verdict | null, q = "200") => ({ id, verdict: v, quantityTonnes: q, cnCode: "7318", country: "TW", importDate: "2026-10-10" });

  it("is absent unless asked for, and never changes the totals", () => {
    const without = buildPortfolio([ship("A", verdict())], { year: 2026, priceEur: "82.32" });
    expect(without.art9).toBeUndefined();
    const withIt = buildPortfolio([ship("A", verdict())], { year: 2026, priceEur: "82.32", art9: { refPriceEur: "82.32" } });
    expect(withIt.totals).toEqual(without.totals);
    expect(withIt.art9).toMatchObject({
      draft: DRAFT_LABEL,
      totalReduction: "6.709",
      obligationT: "360.000",
      netObligationT: "353.291",
      netCertificates: 354,
      lines: [{ id: "A", reductionCertificates: "6.709", eurPerTonneGood: "2.761677" }],
    });
    expect(withIt.art9!.basis).toContain("Ares(2026)4841230");
  });
  it("lines on default values or with a failed check 10 get no deduction, with the reason", () => {
    const bad = verdict({ overall: "INVALID", primaryCode: "CARBON_PRICE_INVALID/FX_MISMATCH", checks: [{ id: 10, name: "", status: "fail", code: "CARBON_PRICE_INVALID/FX_MISMATCH", detail: "" }] } as Partial<Verdict>);
    const p = buildPortfolio([ship("A", verdict()), ship("B", bad)], { year: 2026, art9: { refPriceEur: "82.32" } });
    expect(p.art9!.lines.map((l) => l.id)).toEqual(["A"]);
    expect(p.art9!.notUsed).toEqual([{ id: "B", reason: expect.stringContaining("default values") }]);
    const s = art9Summary([{ id: "C", basis: "actual", quantityTonnes: "10", obligationT: "18" }], new Map([["C", bad as never]]), { refPriceEur: "82.32" }, "18");
    expect(s.notUsed[0].reason).toContain("check 10 fail");
  });
});

describe("the certifier's synthetic vLEI chain (verifier/src/precursor-chain.ts)", () => {
  const input = precursorChainInput(demo);
  const withCert = syntheticPrecursorChain({ ...input, certifier: { ...CP.certifier, auditor: { name: CP.certifier.auditor.name } } });
  const without = syntheticPrecursorChain(input);
  const cert = withCert.certifier!;
  it("adds the certifier without changing the root or any body's credentials", () => {
    expect(withCert.trustAnchor).toBe(PRECURSOR_DEMO_TRUST_ANCHOR);
    expect(withCert.bodies.mill.saids).toEqual(without.bodies.mill.saids);
    expect(withCert.bodies.screw.saids).toEqual(without.bodies.screw.saids);
    expect(without.certifier).toBeUndefined();
  });
  const expectOf = (over = {}) => ({ trustAnchor: PRECURSOR_DEMO_TRUST_ANCHOR, auditorAID: cert.auditorAid, verifierLEI: cert.lei, cnCode: "7213", role: CERTIFIER_ROLE, activity: CERTIFIER_ACTIVITY, ...over });
  it("verifies as a certifier (role and accreditation activity), and only as one", () => {
    expect(verifyAuthority(cert.bundle, expectOf())).toMatchObject({ ok: true });
    expect(verifyAuthority(cert.bundle, expectOf()).detail).toContain(CERTIFIER_ROLE);
    // the certifier cannot pass as an emissions verification body's lead auditor, nor the reverse
    expect(verifyAuthority(cert.bundle, expectOf({ role: undefined, activity: undefined })).detail).toContain(`role is not "${AUDITOR_ROLE}"`);
    const mill = withCert.bodies.mill;
    expect(verifyAuthority(mill.bundle, expectOf({ auditorAID: mill.auditorAid, verifierLEI: mill.lei })).detail).toContain(`role is not "${CERTIFIER_ROLE}"`);
    // pinned to another root: fails
    expect(verifyAuthority(cert.bundle, expectOf({ trustAnchor: DEMO_TRUST_ANCHOR })).ok).toBe(false);
  });
  it("the browser's offline re-check: SAID, operator signature, KEL anchor, certifier chain and price hold; on-chain facts left open", async () => {
    const st = base({ certifier: { name: cert.name, lei: cert.lei, auditorAID: cert.auditorAid, accreditationNumber: "DEMO-ACC-LIV-0001" } });
    const op = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const evidence = { statement: st, operatorSignature: await op.signMessage({ message: st.d }), anchorEvidence: cert.anchor([st.d]), authorityEvidence: cert.bundle, claim: { batchId: "x", quantityTonnes: "1", batchSalt: `0x${"0".repeat(64)}`, beneficiarySalt: `0x${"0".repeat(64)}` } } as const;
    const items = await checkCarbonPriceOffline(evidence as never, { trustAnchor: PRECURSOR_DEMO_TRUST_ANCHOR, seeCap: "1.44", massPerTonne: "1.125" });
    expect(items.map((i) => [i.id, i.ok])).toEqual([["said", true], ["operator", true], ["anchor", true], ["authority", true], ["price", true], ["stated", true], ["onchain", null]]);
    expect(items.find((i) => i.id === "operator")!.detail).toContain(op.address);
    expect(items.find((i) => i.id === "stated")!.detail).toContain("€2.761677 per t of the declared good");
    const other = await checkCarbonPriceOffline(evidence as never, { trustAnchor: DEMO_TRUST_ANCHOR });
    expect(other.find((i) => i.id === "authority")!.ok).toBe(false);
    const tampered = await checkCarbonPriceOffline({ ...evidence, statement: { ...st, ratePerTonne: "3000" } } as never, { trustAnchor: PRECURSOR_DEMO_TRUST_ANCHOR });
    expect(tampered.find((i) => i.id === "said")!.ok).toBe(false);
  });
  it("the mill body's existing bundle still verifies with the certifier's events appended to the QVI's and NAB's KELs", () => {
    const mill = withCert.bodies.mill;
    expect(verifyAuthority(mill.bundle, { trustAnchor: PRECURSOR_DEMO_TRUST_ANCHOR, auditorAID: mill.auditorAid, verifierLEI: mill.lei, cnCode: "7213" }).ok).toBe(true);
  });
});
