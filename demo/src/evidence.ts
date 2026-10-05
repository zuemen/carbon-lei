// Checks 6 and 7 run on evidence exported from the local KERI run (served next to the page).
// The checkers come from the SDK so the CLI and the page use the same code.
import { vleiCheckers } from "../../sdk/checkers.ts";
import type { EvidenceCheckers } from "../../sdk/verify.ts";
import type { DemoData } from "./data.ts";

export function evidenceCheckers(_data: DemoData): EvidenceCheckers {
  return vleiCheckers({
    loadBundle: async (path) => {
      const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
      if (!res.ok) throw new Error(`evidence file not found (HTTP ${res.status})`);
      return res.text();
    },
  });
}
