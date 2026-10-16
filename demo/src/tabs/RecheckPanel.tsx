// Importer workbench › Re-check accepted lines (sdk/recheck.ts, the same code as `carbonlei recheck`). Line 1, the
// demo proof, is re-verified live on Sepolia at one pinned block and compared with the verdict the tab accepted when
// it opened; lines 2–6 show precomputed illustrative outcomes (demo/src/recheck-data.ts). A line that needs action
// is handed back to the plan, which then declares it on the default value.
import { useState } from "react";
import { recheckRecords, recordsFromJson, type Change, type RecheckDocument, type Severity } from "../../../sdk/recheck.ts";
import type { Verdict } from "../../../sdk/verdict.ts";
import { useApp } from "../App.tsx";
import { Badge, type BadgeKind } from "../components.tsx";
import { evidenceCheckers } from "../evidence.ts";
import { useLang } from "../i18n.ts";
import { ILLUSTRATIVE_RECHECKS } from "../recheck-data.ts";

const S = {
  en: {
    title: "Re-check accepted lines",
    lede: "A value accepted today can later be revoked, superseded or become CONTESTED. Before you file, re-verify every accepted line at one block and see what changed since you accepted it.",
    button: "Re-check accepted lines",
    running: "Re-verifying line 1 live on Sepolia…",
    needLive: "Line 1 must be verified live first (see above).",
    done: (b: string) => `Line 1 re-verified live at block ${b}. Lines 2–5 are illustrative outcomes; line 6 had no proof, so nothing was accepted.`,
    failed: (m: string) => `Line 1 could not be re-checked (${m}): its accepted value is not confirmed.`,
    accepted: "accepted",
    now: "now",
    illustrative: "illustrative",
    live: (b: string) => `live, block ${b}`,
    planNote: "Lines that need action are now planned on the default value in the plan below.",
    cli: "In your own systems: carbonlei recheck <records> (daily, with a webhook), or POST /v1/recheck — docs/OPERATE.md › Importer re-check.",
    severity: { action: "Action needed", info: "Information", none: "No change", error: "Not re-checked" } as Record<Severity, string>,
    change: {
      UNCHANGED: "Unchanged: still VALID",
      BECAME_FINAL: "Became final: the CONTESTED window closed with no event",
      WINDOW_OPEN: "CONTESTED window still open",
      AUDITOR_REVOKED_OR_BODY_SUSPENDED: "Auditor revoked within 24 h of registration → review; default meanwhile",
      REPORT_REVOKED: "Report revoked → use the default",
      REPORT_SUPERSEDED: "Report superseded → ask the supplier for the new proof",
      STILL_NOT_VALID: "Still not on the verified value",
      RECHECK_FAILED: "Could not re-check",
    } as Partial<Record<Change, string>>,
  },
  "zh-TW": {
    title: "重新檢查已接受的行",
    lede: "今天接受的數值，日後可能遭撤銷、被取代或變成 CONTESTED。申報前，請在同一個區塊重新驗證每一個已接受的行，看看自接受以來有什麼改變。",
    button: "重新檢查已接受的行",
    running: "正在 Sepolia 上即時重新驗證第 1 行…",
    needLive: "第 1 行須先完成即時驗證（見上方）。",
    done: (b: string) => `第 1 行已於區塊 ${b} 即時重新驗證。第 2–5 行為示意結果；第 6 行沒有證明，因此沒有接受任何數值。`,
    failed: (m: string) => `第 1 行無法重新檢查（${m}）：先前接受的數值未獲確認。`,
    accepted: "接受時",
    now: "現在",
    illustrative: "示意",
    live: (b: string) => `即時，區塊 ${b}`,
    planNote: "需處理的行，已在下方規劃中改以預設值計算。",
    cli: "在您自己的系統中：carbonlei recheck <records>（每日執行並可設定 webhook），或 POST /v1/recheck — 見 docs/OPERATE.md › Importer re-check。",
    severity: { action: "需處理", info: "資訊", none: "無變更", error: "未完成重新檢查" } as Record<Severity, string>,
    change: {
      UNCHANGED: "未變更：仍為有效（VALID）",
      BECAME_FINAL: "已確定：CONTESTED 窗口結束且無事件",
      WINDOW_OPEN: "CONTESTED 窗口仍開啟",
      AUDITOR_REVOKED_OR_BODY_SUSPENDED: "登記後 24 小時內查核員遭撤銷 → 人工複核，期間用預設值",
      REPORT_REVOKED: "報告已撤銷 → 改用預設值",
      REPORT_SUPERSEDED: "報告已被取代 → 向供應商索取新證明",
      STILL_NOT_VALID: "仍未採用經驗證數值",
      RECHECK_FAILED: "無法重新檢查",
    } as Partial<Record<Change, string>>,
    action: {
      action: "接受後狀況改變：在供應商提供新的有效（VALID）證明之前，此行以預設值（含當年度加成）申報。",
      info: "無須變更：報告日後仍可能遭撤銷或取代，申報前請持續重新檢查。",
      none: "無須變更。",
      error: "無法重新檢查，因此無法確認先前接受的數值；請修正原因後再執行一次。",
    } as Record<Severity, string>,
  },
};

const BADGE: Record<Severity, BadgeKind> = { action: "fail", error: "fail", info: "pass", none: "pass" };

type State = { kind: "idle" | "running" } | { kind: "done"; doc: RecheckDocument } | { kind: "failed"; message: string };

interface Row {
  n: number;
  id: string;
  severity: Severity;
  change: Change;
  accepted: string;
  now: string;
  where: string;
  detail: string;
  action: string;
}

/** `onDowngrades`: line id → reason, for the lines a re-check says need action (the plan puts them on the default). */
export function RecheckPanel({
  verdict,
  acceptedAt,
  lineIds,
  onDowngrades,
}: {
  verdict: Verdict | null;
  acceptedAt: string | null;
  lineIds: string[];
  onDowngrades: (d: Record<string, string>) => void;
}) {
  const { data, reader, offline } = useApp();
  const { lang } = useLang();
  const s = S[lang];
  const [state, setState] = useState<State>({ kind: "idle" });
  const canRun = !!verdict && !!reader && !offline && state.kind !== "running";

  async function run() {
    if (!verdict || !reader) return;
    setState({ kind: "running" });
    try {
      const { records } = recordsFromJson(
        [{ proof: data.proof, verdict, eori: data.importer.eori, acceptedAt, id: data.shipment.batchId }],
        "line 1",
      );
      const doc = await recheckRecords(records, reader, { checkers: evidenceCheckers(data), concurrency: 1 });
      setState({ kind: "done", doc });
      const d: Record<string, string> = {};
      const live = doc.results[0];
      if (live && (live.severity === "action" || live.severity === "error")) d[live.id] = `${live.change} (re-check at block ${doc.pinnedBlock})`;
      for (const x of ILLUSTRATIVE_RECHECKS) if (x.result.severity === "action") d[x.id] = `${x.result.change} (illustrative re-check)`;
      onDowngrades(d);
    } catch (e) {
      setState({ kind: "failed", message: (e as Error).message });
    }
  }

  const rows: Row[] = [];
  if (state.kind === "done") {
    const r = state.doc.results[0];
    rows.push({
      n: 1,
      id: r.id,
      severity: r.severity,
      change: r.change,
      accepted: r.accepted.overall,
      now: r.current?.overall ?? "—",
      where: s.live(String(state.doc.pinnedBlock ?? "—")),
      detail: r.reasons.join("; "),
      action: lang === "en" ? r.action : S["zh-TW"].action[r.severity],
    });
    for (const x of ILLUSTRATIVE_RECHECKS) {
      rows.push({
        n: lineIds.indexOf(x.id) + 1,
        id: x.id,
        severity: x.result.severity,
        change: x.result.change,
        accepted: x.result.accepted,
        now: x.result.now,
        where: s.illustrative,
        detail: x.story[lang],
        action: lang === "en" ? x.result.action : S["zh-TW"].action[x.result.severity],
      });
    }
    rows.sort((a, b) => a.n - b.n);
  }

  return (
    <section className="sheet reveal workbench" aria-labelledby="wb-recheck-h">
      <p className="sheet-kicker" id="wb-recheck-h">
        {s.title}
      </p>
      <p className="fine">{s.lede}</p>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost" onClick={() => void run()} disabled={!canRun}>
          {s.button}
        </button>
        {!verdict && <span className="fine">{s.needLive}</span>}
      </div>
      <p className={`fine wb-recheck-status ${state.kind === "failed" ? "bad" : ""}`} role="status">
        {state.kind === "running" ? s.running : state.kind === "done" ? s.done(String(state.doc.pinnedBlock ?? "—")) : state.kind === "failed" ? s.failed(state.message) : ""}
      </p>
      {rows.length > 0 && (
        <>
          <ul className="rc-list" aria-label={s.title}>
            {rows.map((r) => (
              <li key={r.id} className={`rc-row rc-${r.severity}`} data-line={r.id}>
                <p className="rc-head">
                  <span className="wb-n">{r.n}</span> <strong>{r.id}</strong>{" "}
                  <Badge kind={BADGE[r.severity]}>{s.severity[r.severity]}</Badge> <span className="fine">({r.where})</span>
                </p>
                <p className="rc-change">
                  {lang === "en" ? (S.en.change[r.change] ?? r.change) : (S["zh-TW"].change[r.change] ?? r.change)} <code>{r.change}</code>
                </p>
                <p className="fine">
                  {s.accepted} {r.accepted} → {s.now} {r.now}. {r.detail}
                </p>
                <p className="fine rc-action">→ {r.action}</p>
              </li>
            ))}
          </ul>
          <p className="fine">{s.planNote}</p>
        </>
      )}
      <p className="fine">{s.cli}</p>
    </section>
  );
}
