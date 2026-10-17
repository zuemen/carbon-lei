// Importer workbench: many suppliers' proofs → one year's CBAM declaration plan (sdk/portfolio.ts, the same code as
// `carbonlei portfolio`). Line 1 is the demo proof, verified live; lines 2–6 are illustrative fixtures.
import { useEffect, useMemo, useState } from "react";
import { buildPortfolio, ROUNDING_RULES, worksheetCsv, type PortfolioSummary, type ShipmentLine } from "../../../sdk/portfolio.ts";
import { toVerdict, type Verdict } from "../../../sdk/verdict.ts";
import { verifyPresentation } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, TabHead, type BadgeKind } from "../components.tsx";
import { evidenceCheckers } from "../evidence.ts";
import { useLang, type Lang } from "../i18n.ts";
import { DEMO_BENCHMARKS, demoLine, FICTIONAL_LINES, shiftYear } from "../workbench-data.ts";
import { RecheckPanel } from "./RecheckPanel.tsx";
import "../workbench.css";

/**
 * The plan's rounding rules (sdk/portfolio.ts ROUNDING_RULES) in Traditional Chinese, keyed by the SDK's English
 * text: a rule added or reworded in the SDK fails the type check here until it is translated.
 */
const ROUNDING_ZH: Record<(typeof ROUNDING_RULES)[number], string> = {
  "Quantities are read exactly to the kilogram (at most 3 decimals); intensities to 6 decimals.":
    "數量精確讀到公斤（最多 3 位小數）；強度讀到 6 位小數。",
  "Marked-up default = unmarked default × (1 + mark-up), rounded half up to 3 decimals (our convention: the CBAM Registry computes it and its rounding is not published).":
    "加成後預設值 = 未加成預設值 × (1 + 加成)，四捨五入到 3 位小數（本專案的慣例：此值由 CBAM 登錄系統計算，其捨入方式未公布）。",
  "Default free allocation per tonne = CBAM factor × CSCF × benchmark, kept to 6 decimals (rounded half up).":
    "每噸的預設免費配額 = CBAM 係數 × CSCF × 基準值，保留 6 位小數（四捨五入）。",
  "Per line: tCO2e = tonnes × intensity, rounded half up to 3 decimals (kg CO2e); totals and groups are sums of the rounded lines.":
    "每一行：tCO2e = 噸數 × 強度，四捨五入到 3 位小數（kg CO2e）；總計與分組是各行捨入後數值的加總。",
  "Certificates = total obligation in tCO2e rounded up to a whole certificate; quarterly holding likewise (a purchase plan, not a Registry rule).":
    "憑證數 = 以 tCO2e 計的總義務無條件進位到整張憑證；每季持有量亦同（這是購買規劃，不是登錄系統的規則）。",
  "Gross € = Σ line obligation × price of its quarter, rounded half up to the cent.":
    "毛額 € = Σ 各行義務 × 該行所屬季度的價格，四捨五入到分。",
};

/** A rounding rule in the page's language; a rule without a translation stays in English, marked as such. */
function roundingText(rule: string, lang: Lang): { text: string; en: boolean } {
  if (lang !== "zh-TW") return { text: rule, en: false };
  const zh = (ROUNDING_ZH as Record<string, string>)[rule];
  return zh ? { text: zh, en: false } : { text: rule, en: true };
}

const PRICE = "82.32";

const S = {
  en: {
    title: "Importer workbench",
    lede: "One importer, many suppliers: the year's CBAM declaration plan. Each line uses the supplier's verified value only when its proof is VALID and bound to you; otherwise the CBAM default with the year's mark-up, and the reason.",
    illustrative: "Illustrative",
    illustrativeNote:
      "Line 1 is the demo proof, verified live on Sepolia in your browser. Lines 2–6 are fictional shipments from fictional suppliers with precomputed verdicts: illustrative, not on-chain. All quantities, dates and prices are illustrative.",
    planFor: "Plan for",
    year2026: "2026 imports (demo dates)",
    year2027: "2027 imports (same shipments a year later, hypothetical)",
    fa: "Deduct the free-allocation adjustment on default lines (benchmark 1.364 tCO2e/t, CN 7318 carbon steel, route C)",
    faNote:
      "Lines on verified values stay gross: the operator's verified free-allocation figure (SEFA) is not in the credential.",
    live: {
      waiting: "Waiting for the Sepolia connection to verify line 1…",
      running: "Verifying line 1 (the demo proof) live on Sepolia…",
      done: (b: string) => `Line 1 verified live at block ${b}.`,
      offline: "Offline view: line 1 is not verified live, so it is planned on the default.",
      failed: (m: string) => `Line 1 could not be verified (${m}); it is planned on the default.`,
    },
    shipments: "Shipments",
    cols: ["Line", "Supplier", "CN · origin", "Imported", "Net mass", "Proof", "Basis", "tCO2e/t", "Embedded"],
    basis: { actual: "verified", default: "default" },
    verdictText: { VALID: "Valid", INVALID: "Rejected", CONTESTED: "Needs review", INCOMPLETE: "Incomplete", ERROR: "Not run", NONE: "No proof" } as Record<string, string>,
    reason: "Why default:",
    totals: "Declaration plan",
    netMass: "Net mass imported",
    embedded: "Embedded emissions to declare",
    allDefault: "If every line were on defaults",
    gap: "Declared-emissions gap of the verified values",
    gapNote: "a gap in what is declared, not a physical reduction",
    adjustment: "Free-allocation adjustment deducted",
    certificates: "CBAM certificates to surrender",
    allDefaultCerts: (n: number) => `${n.toLocaleString("en-US")} if every line were on defaults`,
    eur: "Gross value at €82.32",
    eurAllDefault: (e: string) => `€${e} if every line were on defaults`,
    saved: "Difference against all-default",
    priceNote:
      "€82.32 is the Q3 2026 CBAM certificate price, applied here to every quarter for illustration. 2026 goods are priced at the average of their quarter of importation (Q1 €75.36, Q2 €75.28, Q3 €82.32; Q4 not yet published). Gross: Art 9 carbon price not deducted.",
    deMinimis: "50 t de minimis",
    exempt: (t: string) => `${t} t net mass: within 50 t, exempt for the year as long as no more CBAM goods are imported.`,
    exceeded: (t: string, id: string, d: string) => `${t} t net mass: exceeded on ${d} by line ${id}, so every line of the year is in scope.`,
    holding: "Quarterly holding (certificates on account at quarter end)",
    holdingLede:
      "At the end of each quarter, at least 50 % of the year-to-date embedded emissions, counted on default values without the mark-up, minus the free-allocation adjustment.",
    notRequired: "not required",
    hold: (n: number) => `hold ≥ ${n} certificates`,
    csv: "Download the declaration worksheet (CSV)",
    csvNote: "One row per line: CN code, origin, installation, net mass, intensity, default or actual, embedded emissions, verifier and report reference. A worksheet, not the CBAM Registry XML schema.",
    rules: "Rounding rules",
    sources: "Sources: docs/OPERATE.md › Importer workbench.",
  },
  "zh-TW": {
    title: "進口商工作台",
    lede: "一家進口商、多家供應商：整年度的 CBAM 申報規劃。每一行只有在供應商證明為有效（VALID）且綁定於您時，才採用其經驗證的數值；否則採用當年度加成後的 CBAM 預設值，並列出原因。",
    illustrative: "示意",
    illustrativeNote:
      "第 1 行是示範證明，由您的瀏覽器在 Sepolia 上即時驗證。第 2–6 行是虛構供應商的虛構出貨，判定結果為預先計算：僅供示意，未上鏈。所有數量、日期與價格均為示意。",
    planFor: "規劃年度",
    year2026: "2026 年進口（示範日期）",
    year2027: "2027 年進口（相同出貨延後一年，假設情境）",
    fa: "於預設值的各行扣除免費配額調整（基準值 1.364 tCO2e/t，CN 7318 碳鋼，路徑 C）",
    faNote: "採經驗證數值的各行維持毛額：憑證中沒有營運者經驗證的免費配額數值（SEFA）。",
    live: {
      waiting: "等待連線至 Sepolia 以驗證第 1 行…",
      running: "正在 Sepolia 上即時驗證第 1 行（示範證明）…",
      done: (b: string) => `第 1 行已於區塊 ${b} 即時驗證。`,
      offline: "離線檢視：第 1 行未即時驗證，因此以預設值規劃。",
      failed: (m: string) => `第 1 行無法驗證（${m}）；以預設值規劃。`,
    },
    shipments: "出貨",
    cols: ["行", "供應商", "CN · 原產地", "進口日", "淨重", "證明", "依據", "tCO2e/t", "內含排放"],
    basis: { actual: "經驗證", default: "預設值" },
    verdictText: { VALID: "有效", INVALID: "已拒絕", CONTESTED: "需審查", INCOMPLETE: "不完整", ERROR: "未執行", NONE: "無證明" } as Record<string, string>,
    reason: "採預設值原因：",
    totals: "申報規劃",
    netMass: "進口淨重",
    embedded: "應申報內含排放",
    allDefault: "若每一行都採預設值",
    gap: "經驗證數值帶來的申報排放差距",
    gapNote: "這是申報數字的差距，不是實際減排",
    adjustment: "已扣除的免費配額調整",
    certificates: "應繳回的 CBAM 憑證",
    allDefaultCerts: (n: number) => `若每一行都採預設值：${n} 張`,
    eur: "以 €82.32 計算的毛額",
    eurAllDefault: (e: string) => `若每一行都採預設值：€${e}`,
    saved: "與全部採預設值的差額",
    priceNote:
      "€82.32 是 2026 年第 3 季的 CBAM 憑證價格，此處為示意套用於每一季。2026 年的貨物依進口當季的平均價格計價（第 1 季 €75.36、第 2 季 €75.28、第 3 季 €82.32；第 4 季尚未公布）。毛額：未扣除第 9 條的已付碳價。",
    deMinimis: "50 公噸微量豁免",
    exempt: (t: string) => `淨重 ${t} 公噸：未超過 50 公噸，只要當年不再進口 CBAM 貨物即可豁免。`,
    exceeded: (t: string, id: string, d: string) => `淨重 ${t} 公噸：於 ${d} 由第 ${id} 行超過門檻，因此當年每一行都適用。`,
    holding: "每季持有（季末帳戶中的憑證）",
    holdingLede: "每季結束時，至少持有年初至今內含排放的 50%，以不含加成的預設值計算，並扣除免費配額調整。",
    notRequired: "無須持有",
    hold: (n: number) => `持有 ≥ ${n} 張憑證`,
    csv: "下載申報工作表（CSV）",
    csvNote: "每一行一列：CN 代碼、原產地、設施、淨重、排放強度、預設或實際值、內含排放、查證機構與報告編號。這是工作表，不是 CBAM 登錄系統的 XML 格式。",
    rules: "四捨五入規則",
    sources: "資料來源：docs/OPERATE.md › Importer workbench。",
  },
};

const BADGE: Record<string, BadgeKind> = { VALID: "pass", INVALID: "fail", ERROR: "fail", CONTESTED: "review", INCOMPLETE: "review", NONE: "skip" };

const num = (s: string, lang: Lang, digits = 3) =>
  Number(s).toLocaleString(lang === "zh-TW" ? "zh-TW" : "en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
const eur = (s: string, lang: Lang) =>
  Number(s).toLocaleString(lang === "zh-TW" ? "zh-TW" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The SDK's reason for a default line, in Traditional Chinese (codes and figures kept). */
function zhReason(r: string): string {
  let m: RegExpExecArray | null;
  if (r === "no supplier proof") return "沒有供應商證明";
  if ((m = /^re-checked after acceptance: (\S+) \(illustrative re-check\)$/.exec(r))) return `接受後重新檢查：${m[1]}（示意重新檢查）`;
  if ((m = /^re-checked after acceptance: (.*)$/.exec(r))) return `接受後重新檢查：${m[1]}`;
  if ((m = /^proof (\w+)(?: \((.+)\))?$/.exec(r))) return `證明判定為 ${m[1]}${m[2] ? `（${m[2]}）` : ""}`;
  if ((m = /^verification did not run: (.*)$/.exec(r))) {
    return `驗證未執行：${m[1] === "not verified yet" ? "尚未驗證" : m[1] === "offline view" ? "離線檢視" : m[1]}`;
  }
  if ((m = /^(\S+) t declared but only (\S+) t claimed on the ledger$/.exec(r))) return `申報 ${m[1]} 公噸，但帳本上只申領了 ${m[2]} 公噸`;
  if (/^check 5 did not bind/.test(r)) return "檢查 5 未將此批出貨綁定於您的 EORI";
  if (r === "the supplier did not disclose the intensity") return "供應商未揭露排放強度";
  if ((m = /^the credential covers CN (\S+), not CN (\S+)$/.exec(r))) return `憑證涵蓋 CN ${m[1]}，而非 CN ${m[2]}`;
  if ((m = /^the installation is in (\w+), not (\w+)$/.exec(r))) return `設施位於 ${m[1]}，而非 ${m[2]}`;
  return r;
}

/** Why the quarterly holding does or does not apply, in Traditional Chinese (mirrors sdk/portfolio.ts). */
function zhWhy(q: PortfolioSummary["quarterlyHolding"][number], p: PortfolioSummary): string {
  if (q.applies) return "≥ 50%，以不含加成的預設值計算";
  if (p.year < 2027) return "2026 年進口不適用：每季持有自 2027 年起適用（憑證自 2027 年 2 月 1 日起出售）";
  const x = p.deMinimis.exceededBy;
  if (!x) return "無須持有：淨重仍在 50 公噸微量門檻內";
  return q.quarter < x.quarter ? `尚未需要：於第 ${x.quarter} 季超過 50 公噸門檻` : "尚未需要：本季超過門檻，須於下一季結束前遵守（第 22(2a) 條）";
}

type Live = { kind: "waiting" | "running" | "offline" } | { kind: "done"; verdict: Verdict; at: string } | { kind: "failed"; message: string };

function saveCsv(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Workbench() {
  const { data, reader, offline } = useApp();
  const { lang } = useLang();
  const s = S[lang];
  const [live, setLive] = useState<Live>({ kind: offline ? "offline" : "waiting" });
  const [year, setYear] = useState<2026 | 2027>(2026);
  const [withFa, setWithFa] = useState(false);
  // Lines a re-check (RecheckPanel) says need action → planned on the default, with the re-check as the reason.
  const [downgrades, setDowngrades] = useState<Record<string, string>>({});

  // Line 1: the demo proof, verified live once the chain reader is ready (the Buyer tab's checks, same SDK call).
  useEffect(() => {
    if (offline) {
      setLive({ kind: "offline" });
      return;
    }
    if (!reader) return;
    let on = true;
    setLive({ kind: "running" });
    verifyPresentation(data.proof, reader, { importerEORI: data.importer.eori, checkers: evidenceCheckers(data) }).then(
      (r) => on && setLive({ kind: "done", verdict: toVerdict(data.proof, r, { chainId: data.network.chainId, block: r.atBlock }), at: new Date().toISOString() }),
      (e: Error) => on && setLive({ kind: "failed", message: e.message }),
    );
    return () => {
      on = false;
    };
  }, [reader, offline, data]);

  const plan: PortfolioSummary = useMemo(() => {
    const first = demoLine(
      data,
      live.kind === "done" ? live.verdict : null,
      live.kind === "failed" ? live.message : live.kind === "offline" ? "offline view" : live.kind !== "done" ? "not verified yet" : undefined,
    );
    const lines = [first, ...FICTIONAL_LINES.map(({ supplierName: _, ...l }) => l)]
      .map((l) => (downgrades[l.id] ? { ...l, downgradedBy: downgrades[l.id] } : l))
      .map((l) => shiftYear(l, year - 2026));
    return buildPortfolio(lines, { year, priceEur: PRICE, ...(withFa ? { freeAllocation: { benchmarks: DEMO_BENCHMARKS } } : {}) });
  }, [data, live, year, withFa, downgrades]);

  const t = plan.totals;
  const maxReq = Math.max(1, ...plan.quarterlyHolding.map((q) => Number(q.cumulativeBasisT) / 2));
  const liveText =
    live.kind === "done"
      ? s.live.done(String(live.verdict.chain.block ?? "—"))
      : live.kind === "failed"
        ? s.live.failed(live.message)
        : s.live[live.kind];

  return (
    <>
      <TabHead title={s.title} lede={s.lede} />
      <section className="sheet reveal workbench" aria-labelledby="wb-lines-h">
        <p className="sheet-kicker" id="wb-lines-h">
          {s.shipments} <span className="tag-hypo">{s.illustrative}</span>
        </p>
        <p className="fine wb-illustrative">{s.illustrativeNote}</p>
        <p className={`fine wb-live ${live.kind === "failed" ? "bad" : ""}`} role="status">
          {liveText}
        </p>
        <div className="wb-controls">
          <fieldset className="wb-year">
            <legend>{s.planFor}</legend>
            {([2026, 2027] as const).map((y) => (
              <label key={y} className="wb-radio">
                <input type="radio" name="wb-year" value={y} checked={year === y} onChange={() => setYear(y)} />{" "}
                {y === 2026 ? s.year2026 : s.year2027}
              </label>
            ))}
          </fieldset>
          <label className="wb-check">
            <input type="checkbox" checked={withFa} onChange={(e) => setWithFa(e.target.checked)} /> {s.fa}
          </label>
          {withFa && <p className="fine">{s.faNote}</p>}
        </div>
        <div className="table-wrap">
          <table className="ledger wb-ledger" role="table" aria-labelledby="wb-lines-h">
            <thead role="rowgroup">
              <tr role="row">
                {s.cols.map((c) => (
                  <th key={c} scope="col" role="columnheader">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup">
              {plan.shipments.map((l, i) => (
                <Row key={l.id} l={l} n={i + 1} lang={lang} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <RecheckPanel
        verdict={live.kind === "done" ? live.verdict : null}
        acceptedAt={live.kind === "done" ? live.at : null}
        lineIds={plan.shipments.map((l) => l.id)}
        onDowngrades={setDowngrades}
      />

      <section className="sheet reveal workbench" aria-labelledby="wb-plan-h">
        <p className="sheet-kicker" id="wb-plan-h">
          {s.totals} · {year} <span className="tag-hypo">{s.illustrative}</span>
        </p>
        <dl className="wb-totals">
          <div>
            <dt>{s.netMass}</dt>
            <dd className="wb-net">{num(t.quantityTonnes, lang)} t</dd>
          </div>
          <div>
            <dt>{s.embedded}</dt>
            <dd className="wb-embedded">{num(t.embeddedT, lang)} tCO2e</dd>
            <dd className="fine">
              {s.allDefault}: {num(t.allDefaultT, lang)} tCO2e
            </dd>
          </div>
          <div>
            <dt>{s.gap}</dt>
            <dd className="wb-gap">{num(t.gapT, lang)} tCO2e</dd>
            <dd className="fine">{s.gapNote}</dd>
          </div>
          {plan.freeAllocation.applied !== "none" && (
            <div>
              <dt>{s.adjustment}</dt>
              <dd className="wb-adjustment">{num(t.adjustmentT, lang)} tCO2e</dd>
            </div>
          )}
          <div>
            <dt>{s.certificates}</dt>
            <dd className="wb-certs">{t.certificates.toLocaleString("en-US")}</dd>
            <dd className="fine">{s.allDefaultCerts(t.allDefaultCertificates)}</dd>
          </div>
          <div>
            <dt>{s.eur}</dt>
            <dd className="wb-eur">€{eur(t.grossEur ?? "0", lang)}</dd>
            <dd className="fine">{s.eurAllDefault(eur(t.allDefaultGrossEur ?? "0", lang))}</dd>
          </div>
          <div>
            <dt>{s.saved}</dt>
            <dd className="wb-saved">€{eur(t.savedEur ?? "0", lang)}</dd>
          </div>
        </dl>
        <p className="fine">{s.priceNote}</p>

        <h3 className="wb-h">{s.deMinimis}</h3>
        <p className={`wb-deminimis ${plan.deMinimis.exempt ? "" : "over"}`}>
          {plan.deMinimis.exempt
            ? s.exempt(num(plan.deMinimis.netMassTonnes, lang))
            : s.exceeded(num(plan.deMinimis.netMassTonnes, lang), plan.deMinimis.exceededBy!.id, plan.deMinimis.exceededBy!.importDate)}
        </p>

        <h3 className="wb-h" id="wb-holding-h">
          {s.holding}
        </h3>
        <p className="fine">{s.holdingLede}</p>
        <ol className="wb-holding" aria-labelledby="wb-holding-h">
          {plan.quarterlyHolding.map((q) => (
            <li key={q.quarter} className={q.applies ? "applies" : ""}>
              <span className="wb-q">Q{q.quarter}</span>
              <span className="wb-bar" aria-hidden="true">
                <span style={{ width: `${(Number(q.requiredT) / maxReq) * 100}%` }} />
              </span>
              <span className="wb-hold">
                <strong>{q.applies ? s.hold(q.requiredCertificates) : s.notRequired}</strong>{" "}
                <span className="fine">{lang === "en" ? q.why : zhWhy(q, plan)}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={() => saveCsv(worksheetCsv(plan), `carbonlei-worksheet-${year}.csv`)}>
            {s.csv}
          </button>
          <span className="fine">{s.csvNote}</span>
        </div>
        <details className="wb-rules">
          <summary>{s.rules}</summary>
          <ul className="fine">
            {plan.rounding.map((r) => {
              const t = roundingText(r, lang);
              return (
                <li key={r} lang={t.en ? "en" : undefined}>
                  {t.text}
                </li>
              );
            })}
          </ul>
          <p className="fine">{s.sources}</p>
        </details>
      </section>
    </>
  );
}

function Row({ l, n, lang }: { l: ShipmentLine; n: number; lang: Lang }) {
  const s = S[lang];
  const cols = s.cols;
  return (
    <tr role="row" className={`wb-row wb-${l.basis}`}>
      <td role="cell" data-label={cols[0]}>
        <span className="wb-n">{n}</span> {l.id}
        {n > 1 && <span className="wb-illus fine">{s.illustrative.toLowerCase()}</span>}
      </td>
      <td role="cell" data-label={cols[1]}>{l.supplier}</td>
      <td role="cell" data-label={cols[2]}>
        {l.cnCode} · {l.country}
      </td>
      <td role="cell" data-label={cols[3]}>
        {l.importDate} (Q{l.quarter})
      </td>
      <td role="cell" data-label={cols[4]}>{num(l.quantityTonnes, lang)} t</td>
      <td role="cell" data-label={cols[5]}>
        <Badge kind={BADGE[l.verdict] ?? "skip"}>{s.verdictText[l.verdict] ?? l.verdict}</Badge>
        {l.primaryCode && (
          <>
            {" "}
            <code>{l.primaryCode}</code>
          </>
        )}
      </td>
      <td role="cell" data-label={cols[6]}>
        <strong className="wb-basis">{s.basis[l.basis]}</strong>
        {l.reason && (
          <span className="fine wb-reason">
            {" "}
            {s.reason} {lang === "en" ? l.reason : zhReason(l.reason)}
          </span>
        )}
      </td>
      <td role="cell" data-label={cols[7]}>{l.seeUsed}</td>
      <td role="cell" data-label={cols[8]} className="wb-emb">
        {num(l.embeddedT, lang)}
      </td>
    </tr>
  );
}
