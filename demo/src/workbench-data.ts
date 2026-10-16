// Importer workbench: the demo portfolio. Line 1 is the demo shipment, whose proof the page verifies live on
// Sepolia; lines 2–6 are fictional shipments from fictional suppliers with precomputed verdicts — illustrative,
// not on-chain, never sent to any contract. Every value here is invented for the demo except the sourced
// regulatory inputs used by sdk/portfolio.ts (CN 7318 default from Taiwan, mark-ups, CBAM factor, benchmark).
import type { ShipmentInput } from "../../sdk/portfolio.ts";
import type { Verdict, VerdictCheck } from "../../sdk/verdict.ts";
import type { DemoData } from "./data.ts";

const CHECK_NAMES = ["Structure", "SAID", "Disclosures", "Signature", "On-chain report", "Shipment", "KEL anchor", "Authority chain", "Reconciliation"];

/** A precomputed verdict (format 2), with the given check statuses; all other checks passed. */
function fixtureVerdict(
  overall: Verdict["overall"],
  disclosed: Record<string, string>,
  special: Partial<Record<number, Pick<VerdictCheck, "status" | "code">>> = {},
): Verdict {
  const checks: VerdictCheck[] = CHECK_NAMES.map((name, id) => ({
    id,
    name,
    status: special[id]?.status ?? "pass",
    code: special[id]?.code ?? "",
    detail: special[id] ? "illustrative" : "",
  }));
  const primary = checks.find((c) => c.status === "fail")?.code ?? "";
  return {
    format: 2,
    overall,
    primaryCode: primary,
    checks,
    hidden: 4,
    rejected: special[2]?.status === "fail" ? 1 : 0,
    disclosed,
    credSAID: null,
    chain: { chainId: null, block: null },
    checkedAt: null,
    warnings: [],
    trustAnchor: null,
    tool: { name: "carbonlei", version: "0.1.0" },
  };
}

const ILLUSTRATIVE = "illustrative, not on-chain";

/** Fictional lines 2–6 (illustrative verdicts; not on-chain). */
export const FICTIONAL_LINES: (ShipmentInput & { supplierName: string })[] = [
  {
    id: "FNW-2026-014",
    supplierName: "Formosa Nut Works (fictional)",
    supplier: "Formosa Nut Works (fictional)",
    installation: "TW-FNW-0001 (fictional)",
    quantityTonnes: "120",
    claimedTonnes: "120",
    cnCode: "73181692",
    country: "TW",
    importDate: "2026-05-20",
    note: ILLUSTRATIVE,
    verdict: fixtureVerdict("VALID", {
      cnCode: "7318",
      unLocode: "TWTXG",
      specificEmbeddedEmissions_tCO2e_per_t: "2.1",
      valueType: "actual",
      verificationReportId: "VR-FNW-0007 (fictional)",
    }),
  },
  {
    id: "KRC-2026-003",
    supplierName: "Kaohsiung Rivet Co. (fictional)",
    supplier: "Kaohsiung Rivet Co. (fictional)",
    installation: "TW-KRC-0002 (fictional)",
    quantityTonnes: "60",
    claimedTonnes: "60",
    cnCode: "73182300",
    country: "TW",
    importDate: "2026-03-14",
    note: ILLUSTRATIVE,
    verdict: fixtureVerdict(
      "CONTESTED",
      { cnCode: "7318", unLocode: "TWKHH", specificEmbeddedEmissions_tCO2e_per_t: "1.7", valueType: "actual" },
      { 4: { status: "warn", code: "CONTESTED" } },
    ),
  },
  {
    id: "TWL-2026-021",
    supplierName: "Taichung Washer Ltd. (fictional)",
    supplier: "Taichung Washer Ltd. (fictional)",
    installation: "TW-TWL-0001 (fictional)",
    quantityTonnes: "35",
    claimedTonnes: "35",
    cnCode: "73182200",
    country: "TW",
    importDate: "2026-07-08",
    note: ILLUSTRATIVE,
    verdict: fixtureVerdict(
      "INVALID",
      { cnCode: "7318", unLocode: "TWTXG", valueType: "actual" },
      { 2: { status: "fail", code: "DISCLOSURE_TAMPERED" } },
    ),
  },
  {
    id: "HFC-2026-009",
    supplierName: "Hsinchu Fastener Corp. (fictional)",
    supplier: "Hsinchu Fastener Corp. (fictional)",
    installation: "TW-HFC-0003 (fictional)",
    quantityTonnes: "45",
    claimedTonnes: "40",
    cnCode: "73181568",
    country: "TW",
    importDate: "2026-08-02",
    note: ILLUSTRATIVE,
    verdict: fixtureVerdict("VALID", {
      cnCode: "7318",
      unLocode: "TWHSZ",
      specificEmbeddedEmissions_tCO2e_per_t: "1.55",
      valueType: "actual",
      verificationReportId: "VR-HFC-0002 (fictional)",
    }),
  },
  {
    id: "TBI-2026-030",
    supplierName: "Tainan Bolt Industries (fictional)",
    supplier: "Tainan Bolt Industries (fictional)",
    installation: "",
    quantityTonnes: "80",
    cnCode: "73181595",
    country: "TW",
    importDate: "2026-11-20",
    note: `${ILLUSTRATIVE}; no supplier proof`,
    verdict: null,
  },
];

/** The demo shipment (line 1), with the verdict of the live verification (null until it has run). */
export function demoLine(data: DemoData, verdict: Verdict | null, verifyError?: string): ShipmentInput {
  return {
    id: data.shipment.batchId,
    supplier: "Demo Fasteners Co. (fictional)",
    installation: data.report.installationId,
    quantityTonnes: data.shipment.quantityTonnes,
    claimedTonnes: data.shipment.quantityTonnes,
    cnCode: data.report.cnCode,
    country: "TW",
    importDate: data.shipment.shipmentDate,
    note: "demo proof, verified live on Sepolia",
    verdict,
    ...(verifyError ? { verifyError } : {}),
  };
}

/** The same lines imported one year later (a hypothetical, to show the 2027 mark-up and the quarterly holding). */
export const shiftYear = (s: ShipmentInput, years: number): ShipmentInput => ({
  ...s,
  importDate: `${Number(s.importDate.slice(0, 4)) + years}${s.importDate.slice(4)}`,
});

/**
 * Free-allocation benchmark used when the reader turns the adjustment on: Column B of IR (EU) 2025/2620, Annex point
 * 5.3, CN 7318 carbon steel, route (C) BF/BOF — the route IR (EU) 2026/1740 lists for Taiwan's CN 7318 lines.
 */
export const DEMO_BENCHMARKS = { "TW:7318": "1.364" };
