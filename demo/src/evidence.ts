// Checks 6 and 7 run on evidence exported from the local KERI run (served next to the page).
// The checkers come from the SDK so the CLI and the page use the same code.
import type { EvidenceCheckers } from "../../sdk/verify.ts";
import type { DemoData } from "./data.ts";

export function evidenceCheckers(_data: DemoData): EvidenceCheckers {
  return {};
}
