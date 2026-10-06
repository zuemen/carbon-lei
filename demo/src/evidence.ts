// Checks 6 and 7 run on evidence exported from the local KERI run (served next to the page).
// The checkers come from the SDK so the CLI and the page use the same code.
import { vleiCheckers } from "../../sdk/checkers.ts";
import type { EvidenceCheckers } from "../../sdk/verify.ts";
import type { DemoData } from "./data.ts";

// One download per evidence file per page load. The checker still hashes the text against the
// proof on every verification, so a cached file is checked exactly like a fresh one.
const files = new Map<string, Promise<string>>();

function loadEvidence(path: string): Promise<string> {
  let text = files.get(path);
  if (!text) {
    text = fetch(`${import.meta.env.BASE_URL}${path}`).then((res) => {
      if (!res.ok) throw new Error(`evidence file not found (HTTP ${res.status})`);
      return res.text();
    });
    files.set(path, text);
    // A failed download is not kept: the next verification tries again.
    text.catch(() => files.delete(path));
  }
  return text;
}

/** Starts downloading the evidence file a proof refers to (on "Load the demo proof"), before Verify is pressed. */
export function prefetchEvidence(authorityEvidence: unknown) {
  const ref = authorityEvidence as { bundle?: unknown } | undefined;
  if (typeof ref?.bundle === "string") void loadEvidence(ref.bundle).catch(() => {});
}

export function evidenceCheckers(_data: DemoData): EvidenceCheckers {
  return vleiCheckers({ loadBundle: loadEvidence });
}
