// Checks 6 and 7 run on evidence exported from the local KERI run (served next to the page).
// The checkers come from the SDK so the CLI and the page use the same code.
import { isSafeBundlePath, vleiCheckers } from "../../sdk/checkers.ts";
import type { EvidenceCheckers } from "../../sdk/verify.ts";
import type { DemoData } from "./data.ts";

// One download per evidence file per page load, for at most MAX_FILES files (the oldest is dropped).
// The checker still hashes the text against the proof on every verification, so a cached file is
// checked exactly like a fresh one.
const MAX_FILES = 8;
const files = new Map<string, Promise<string>>();

function loadEvidence(path: string): Promise<string> {
  // Only files under evidence/ are fetched. Check 7 refuses other paths before loading; this is a second guard.
  if (!isSafeBundlePath(path)) return Promise.reject(new Error("evidence path not allowed"));
  let text = files.get(path);
  if (!text) {
    const download = fetch(`${import.meta.env.BASE_URL}${path}`).then((res) => {
      if (!res.ok) throw new Error(`evidence file not found (HTTP ${res.status})`);
      return res.text();
    });
    while (files.size >= MAX_FILES) files.delete(files.keys().next().value as string);
    files.set(path, download);
    // A failed download is not kept: the next verification tries again.
    download.catch(() => {
      if (files.get(path) === download) files.delete(path);
    });
    text = download;
  }
  return text;
}

/** Starts downloading the evidence file a proof refers to (on "Load the demo proof"), before Verify is pressed. */
export function prefetchEvidence(authorityEvidence: unknown) {
  const ref = authorityEvidence as { bundle?: unknown } | undefined;
  if (isSafeBundlePath(ref?.bundle)) void loadEvidence(ref.bundle).catch(() => {});
}

export function evidenceCheckers(_data: DemoData): EvidenceCheckers {
  return vleiCheckers({ loadBundle: loadEvidence });
}
