// Importer workbench › Re-check accepted lines: illustrative outcomes for the fictional lines 2–6. Each outcome is
// computed by the SDK's own classifier (`classify` in sdk/recheck.ts) from an illustrative "accepted" verdict and an
// illustrative "now" verdict — nothing here is on-chain, and every time below is invented for the demo. Line 1 is
// re-verified live on Sepolia by the tab itself (`recheckRecords`).
import { classify, type RecheckResult } from "../../sdk/recheck.ts";
import type { Verdict } from "../../sdk/verdict.ts";
import { FICTIONAL_LINES, fixtureVerdict } from "./workbench-data.ts";

const sec = (iso: string) => Date.parse(iso) / 1000;
/** Illustrative time of the re-check (head block time). */
const NOW = sec("2026-10-16T08:00:00Z");

export interface IllustrativeRecheck {
  id: string;
  result: Pick<RecheckResult, "change" | "severity" | "reasons" | "action" | "window"> & { accepted: string; now: string };
  /** One-line story of what happened, in English and Traditional Chinese (illustrative). */
  story: { en: string; "zh-TW": string };
}

const line = (id: string) => {
  const l = FICTIONAL_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no fictional line ${id}`);
  return l;
};

/** A verdict like `accepted` with check 4 turned into the given CONTESTED detail. */
function contested(accepted: Verdict, detail: string): Verdict {
  const v = fixtureVerdict("CONTESTED", accepted.disclosed, { 4: { status: "pass", code: "CONTESTED" } });
  v.checks[4] = { ...v.checks[4], detail };
  return v;
}

function outcome(
  id: string,
  times: { registeredAt: string; acceptedAt: string },
  now: Verdict | null | undefined,
  story: IllustrativeRecheck["story"],
): IllustrativeRecheck | null {
  const accepted = line(id).verdict;
  if (!accepted || !now) return null;
  const c = classify(
    { overall: accepted.overall, primaryCode: accepted.primaryCode, block: null, at: times.acceptedAt },
    now,
    { headTime: NOW, registeredAt: sec(times.registeredAt) },
  );
  return { id, result: { ...c, accepted: accepted.overall, now: now.overall }, story };
}

const fnw = line("FNW-2026-014").verdict!;

/** Illustrative re-check outcomes of the fictional lines that had a proof (line 6 had none: nothing was accepted). */
export const ILLUSTRATIVE_RECHECKS: IllustrativeRecheck[] = [
  outcome(
    "FNW-2026-014",
    { registeredAt: "2026-05-18T09:00:00Z", acceptedAt: "2026-05-18T12:00:00Z" },
    contested(fnw, "registered by an authorized auditor (checked by the contract at registration); revoked or suspended within 24 h after"),
    {
      en: "Accepted 3 h after registration; 11 h after registration the watcher revoked the auditor (illustrative).",
      "zh-TW": "於登記後 3 小時接受；登記後 11 小時監看者撤銷了該查核員（示意）。",
    },
  ),
  outcome("KRC-2026-003", { registeredAt: "2026-03-10T08:00:00Z", acceptedAt: "2026-03-14T10:00:00Z" }, line("KRC-2026-003").verdict, {
    en: "Already needed review when accepted; still CONTESTED, still on the default (illustrative).",
    "zh-TW": "接受時即需審查；仍為 CONTESTED，仍採預設值（示意）。",
  }),
  outcome("TWL-2026-021", { registeredAt: "2026-07-01T08:00:00Z", acceptedAt: "2026-07-08T10:00:00Z" }, line("TWL-2026-021").verdict, {
    en: "Rejected when received; still rejected (illustrative).",
    "zh-TW": "收到時即遭拒絕；仍遭拒絕（示意）。",
  }),
  outcome("HFC-2026-009", { registeredAt: "2026-08-01T06:00:00Z", acceptedAt: "2026-08-01T15:00:00Z" }, line("HFC-2026-009").verdict, {
    en: "Accepted inside the 24 h window; the window closed with no event (illustrative). The line stays on the default for its 45 t vs 40 t claimed.",
    "zh-TW": "於 24 小時窗口內接受；窗口結束時沒有任何事件（示意）。此行仍因申報 45 公噸、僅申領 40 公噸而採預設值。",
  }),
].filter((x): x is IllustrativeRecheck => x !== null);
