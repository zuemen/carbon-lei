import { describe, expect, it } from "vitest";
import { applyRecheck, type RecheckDocument, type RecheckResult } from "../recheck.ts";
import type { BatchDocument } from "../batch.ts";
import type { Verdict } from "../verdict.ts";

// A tampered copy of a proof keeps the original's credSAID and batch id. A re-check result must not lift that copy
// to the original's VALID verdict (QA finding of 17 October 2026: `portfolio --recheck` planned the copy on 1.8).
const SAID = "EAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const verdict = (overall: string, primaryCode = overall === "VALID" ? "OK" : "DISCLOSURE_TAMPERED") =>
  ({ overall, primaryCode, credSAID: SAID, checks: [] }) as unknown as Verdict;
const line = (id: string) => ({ id, cnCode: "7318", country: "TW", quantityTonnes: "40", importDate: "2026-10-10" });
const batch = (): BatchDocument =>
  ({
    format: 1, kind: "carbonlei-batch", pinnedBlock: 100, chainId: 11155111, eori: "NLDEMO000000001", verifiedAt: "2026-10-16T00:00:00Z",
    counts: { VALID: 1, INVALID: 1, CONTESTED: 0, INCOMPLETE: 0, ERROR: 0, NO_PROOF: 0 },
    results: [
      { proof: "demo.json", line: line("DEMO"), verdict: verdict("VALID"), error: null, proofShipment: { batchId: "B-1", quantityTonnes: "40", shipmentDate: "2026-10-10" } },
      { proof: "tampered.json", line: line("TAMPERED-COPY"), verdict: verdict("INVALID"), error: null, proofShipment: { batchId: "B-1", quantityTonnes: "40", shipmentDate: "2026-10-10" } },
    ],
    tool: { name: "carbonlei", version: "0.1.0" },
  }) as unknown as BatchDocument;
const result = (source: string, id: string, overall: string, change = "UNCHANGED", severity = "none"): RecheckResult =>
  ({
    source, id, batchId: "B-1", credSAID: SAID, mode: "full",
    accepted: { overall, primaryCode: "OK", at: null, block: 90 }, current: { overall, primaryCode: "OK", block: 100 },
    change, severity, reasons: [], action: "", window: null, verdict: verdict(overall), error: null,
  }) as unknown as RecheckResult;
const doc = (results: RecheckResult[]): RecheckDocument =>
  ({ format: 1, kind: "carbonlei-recheck", pinnedBlock: 100, blockTime: 0, chainId: 11155111, checkedAt: "2026-10-17T00:00:00Z", windowHours: 24, counts: { action: 0, info: 0, none: results.length, error: 0 }, results, notes: [], tool: { name: "carbonlei", version: "0.1.0" } }) as unknown as RecheckDocument;

describe("applyRecheck matches lines safely", () => {
  it("a re-check of the original (another file) does not lift the tampered copy to VALID", () => {
    const out = applyRecheck(batch(), doc([result("accepted/demo-record.json", "B-1", "VALID")]));
    expect(out.results.map((r) => r.verdict?.overall)).toEqual(["VALID", "INVALID"]);
  });

  it("a re-check made from this results file maps line by line", () => {
    const out = applyRecheck(batch(), doc([result("results.json#1", "DEMO", "VALID"), result("results.json#2", "TAMPERED-COPY", "INVALID")]));
    expect(out.results.map((r) => r.verdict?.overall)).toEqual(["VALID", "INVALID"]);
  });

  it("a loose match may still make a line worse (revoked report), and marks it for the default", () => {
    const out = applyRecheck(batch(), doc([result("accepted/demo-record.json", "B-1", "INVALID", "REPORT_REVOKED", "action")]));
    expect(out.results[0].verdict?.overall).toBe("INVALID");
    expect(out.results[0].recheck).toMatchObject({ change: "REPORT_REVOKED", severity: "action" });
    expect(out.results[1].verdict?.overall).toBe("INVALID");
  });

  it("two loose candidates for one credential are ambiguous: the line is left as it was", () => {
    const out = applyRecheck(batch(), doc([result("a.json", "x", "VALID"), result("b.json", "y", "VALID")]));
    expect(out.results.map((r) => r.verdict?.overall)).toEqual(["VALID", "INVALID"]);
  });
});
