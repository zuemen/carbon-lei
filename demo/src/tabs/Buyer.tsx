import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../../../sdk/disclosure.ts";
import { exportPactFromProof, type PactProduct } from "../../../sdk/pact.ts";
import { disclosureCounts } from "../../../sdk/summary.ts";
import { verifyOffline, verifyPresentation, type CheckResult, type VerificationResult } from "../../../sdk/verify.ts";
import fixture from "../../../fixtures/demo.json";
import { scrollBelowTabbar, useApp } from "../App.tsx";
import { Badge, fmt, SourceLabel, TabHead, TxLink, type BadgeKind, type Source } from "../components.tsx";
import { comparisonFigures, proofComparison, whatIfFigures, type DemoData } from "../data.ts";
import { codeText } from "../messages.ts";
import { useLang, type Lang } from "../i18n.ts";
import { evidenceCheckers, prefetchEvidence } from "../evidence.ts";
import { CheckSources } from "./CheckSources.tsx";
import { SubRules } from "./VerifierRules.tsx";
import { PrecursorBuyer } from "./Precursor.tsx";
import { CarbonPriceSection } from "./CarbonPrice.tsx";
import { workbenchCounts } from "../workbench-data.ts";
import { lazyRetry } from "../lazy-load.tsx";

// The printable importer's file: loaded only when the importer asks for it.
const ImporterFile = lazyRetry(() => import("./ImporterFile.tsx"));

const CHECKS: { n: number; text: string; source: Source }[] = [
  { n: 1, text: "The credential has not been altered since it was issued (its content hash matches its ID)", source: "browser" },
  { n: 2, text: "No disclosed field was changed", source: "browser" },
  { n: 3, text: "Signed by the issuer address named in the credential (whether that address is registered is check 4)", source: "browser" },
  { n: 4, text: "The report is registered, valid for this shipment, and issued by this verification body and auditor", source: "sepolia" },
  { n: 5, text: "This batch was claimed for you, for this quantity", source: "sepolia" },
  {
    n: 6,
    text: "The auditor recorded this report in their own signed history (KERI key event log) — signature re-checked in your browser from the exported event; witnesses are not queried",
    source: "browser",
  },
  { n: 7, text: "The auditor is authorised by an accredited verification body", source: "evidence" },
  {
    n: 8,
    text: "The report matches the signed credential (rule-based check, covered by the auditor's signature) — it fails when the signed report itself breaks a CBAM rule (dated too early, accreditation expired, no physical first-year site visit); a report extract that is missing, changed after signing or partly hidden leaves it not decided (Not verified, never Verified); any other finding is flagged for human review",
    source: "advisory",
  },
];

/** The check names (CHECKS) in Traditional Chinese (Taiwan); check 0 is the structure check. */
export const CHECK_TEXT_ZH: Record<number, string> = {
  1: "憑證自簽發後未被更改（其內容雜湊與其 ID 相符）",
  2: "沒有任何已揭露欄位被更改",
  3: "由憑證中所指名的簽發者地址簽署（該地址是否已登記，由檢查 4 判定）",
  4: "報告已登記、對此批出貨有效，且由此驗證機構及查核員簽發",
  5: "此批次是為您、以此數量申領的",
  6: "查核員已將此報告記錄在其自己的簽署歷史中（KERI 金鑰事件日誌）——簽章由您的瀏覽器依匯出的事件重新檢查；未查詢見證者（witnesses）",
  7: "查核員獲得經認證的驗證機構授權",
  8: "報告與已簽署的憑證相符（規則式檢查，涵蓋於查核員的簽章內）——已簽署的報告本身違反 CBAM 規則（日期過早、認證已過期、首年未實地查訪）時判定為未通過；報告摘錄缺漏、簽署後遭更改或部分隱藏時無法判定（結果為未驗證，絕不會是已驗證）；其他發現則標示為需人工審查",
};

/** The check list's result badges in Traditional Chinese; other tabs keep the English badges. */
const BADGE_ZH: Record<BadgeKind, string> = {
  pass: "✓ 通過",
  fail: "✕ 未通過",
  review: "! 需審查",
  idle: "· 尚未執行",
  skip: "– 未執行",
};

/** How the checks that kept a result from VALID were left: not run, not decided (check 8 on a changed extract), or both. */
type NotRunHow = "run" | "decided" | "both";

/** Check numbers as a list: a run of three or more as a range ("4–8"), else "6 and 7" / "6, 8 and 10". */
function listNums(ns: number[], and: string): string {
  if (ns.length >= 3 && ns.every((n, i) => i === 0 || n === ns[i - 1] + 1)) return `${ns[0]}–${ns[ns.length - 1]}`;
  return ns.length === 1 ? `${ns[0]}` : `${ns.slice(0, -1).join(", ")}${and}${ns[ns.length - 1]}`;
}

/** The verdict's warnings that make a result INCOMPLETE (SHIPMENT_NOT_BOUND does not). */
const INCOMPLETE_CODES: string[] = ["EVIDENCE_NOT_CHECKED", "RECONCILIATION_NOT_CHECKED", "PRECURSORS_NOT_CHECKED", "CARBON_PRICE_NOT_CHECKED"];

/**
 * Why an INCOMPLETE result is not verified, read from the verdict itself: which checks were skipped (or not decided)
 * and the warnings that name the reason. The offline view (no warnings, checks 4–8 skipped) names the missing Sepolia
 * connection; a missing or changed report extract names check 8.
 */
function incompleteReason(result: VerificationResult, lang: Lang) {
  const v = VERDICT[lang];
  const skipped = result.checks.filter((c) => c.index > 0 && c.status === "skipped");
  const decided = skipped.filter((c) => c.detail.startsWith("not decided"));
  const how: NotRunHow = skipped.length && decided.length === skipped.length ? "decided" : decided.length ? "both" : "run";
  const codes = (result.warnings ?? []).map((w) => w.code).filter((c) => INCOMPLETE_CODES.includes(c));
  // Checks 6 and 7 that only warned are not skipped, but they are not checked either (EVIDENCE_NOT_CHECKED).
  const evidence = [6, 7].filter((i) => {
    const st = result.checks.find((c) => c.index === i)?.status;
    return st !== "pass" && st !== "fail";
  });
  const heads = [...new Set([...skipped.map((c) => c.index), ...(codes.includes("EVIDENCE_NOT_CHECKED") ? evidence : [])])].sort((a, b) => a - b);
  const reasons: string[] = [];
  for (const code of codes) {
    if (code === "RECONCILIATION_NOT_CHECKED") {
      const c8 = result.checks.find((c) => c.index === 8);
      reasons.push(c8 && /^no report extract/.test(c8.detail) ? v.why.extractMissing : v.why.extractChanged);
    } else if (code === "EVIDENCE_NOT_CHECKED") {
      reasons.push(v.why.evidence(v.checkList(evidence), evidence.length));
    } else if (code === "PRECURSORS_NOT_CHECKED") {
      reasons.push(v.why.precursors);
    } else if (code === "CARBON_PRICE_NOT_CHECKED") {
      reasons.push(v.why.carbonPrice);
    }
  }
  if (!reasons.length) reasons.push(heads.includes(4) || heads.includes(5) ? v.why.sepolia : v.why.other);
  return {
    head: heads.length ? v.incompleteHead(v.checkList(heads), heads.length, how) : v.stampNotVerified,
    reasons,
    codes,
  };
}

/** Verdict line, stamp and check list strings; the codes, check numbers and units stay as they are. */
const VERDICT = {
  en: {
    checkSr: (n: number) => `Check ${n}: `,
    counts: (passed: number, total: number, review: number, notRun: number) =>
      `${passed} of ${total} checks passed` +
      (review ? `, ${review} need${review === 1 ? "s" : ""} review` : "") +
      (notRun ? `, ${notRun} not run` : ""),
    unreadable: "the proof could not be read",
    checkFailed: (n: number) => `check ${n} failed`,
    rejected: (what: string) => `Rejected — ${what}`,
    noGap: "Do not rely on this proof's value: no declared-emissions gap is shown.",
    checkList: (ns: number[]) => `check${ns.length > 1 ? "s" : ""} ${listNums(ns, " and ")}`,
    incompleteHead: (list: string, n: number, how: NotRunHow) =>
      `Not verified — ${list} ${n === 1 ? "was" : "were"} ${{ run: "not run", decided: "not decided", both: "not run or not decided" }[how]}`,
    incompleteBody: (counts: string, reasons: string[]) =>
      ` — ${counts}. ${reasons.map((r) => r[0].toUpperCase() + r.slice(1)).join(". ")}. Do not rely on this proof's value: no declared-emissions gap is shown.`,
    why: {
      extractMissing:
        "the proof carries no report extract, although the credential commits to the one the auditor signed, so check 8 (the rules on the signed report) could not be applied",
      extractChanged:
        "the report extract in this proof is not the one the auditor signed (a field changed, added or removed, or the fields it reconciles are hidden), so check 8 (the rules on the signed report) could not be applied",
      evidence: (list: string, n: number) =>
        `${list} (the auditor's signed history and authority) ${n === 1 ? "was" : "were"} not run or not confirmed by an evidence checker`,
      precursors: "the credential commits to a precursor statement, but check 9 could not be decided",
      carbonPrice: "the proof carries a carbon price statement, but check 10 could not be decided",
      sepolia: "they need a live connection to Sepolia",
      other: "a check that decides validity was not run",
    },
    notDecided: "Not decided: ",
    warningsLabel: "Warnings from the verifier",
    reviewHead: "Needs review",
    reviewBody: (counts: string) =>
      ` — ${counts}. Do not rely on the verified value until a person has reviewed the report: no declared-emissions gap is shown.`,
    gap: (q: string, gap: string) => `declared-emissions gap for this ${q} t shipment: ${gap} tCO2e (gross, illustrative)`,
    intensity: (v: string) => `verified intensity ${v} tCO2e/t`,
    notDisclosed: "not disclosed",
    seeComparison: "See comparison ↓",
    humanReview: (detail: string) => `Needs human review: ${detail}`,
    stampVerified: "Verified",
    stampReview: "Needs review",
    stampNotVerified: "Not verified",
    stampRejected: "Rejected",
    hidden: (n: number, rejected: number) =>
      `${n} field${n === 1 ? "" : "s"} hidden by supplier${rejected ? ` · ${rejected} disclosure${rejected === 1 ? "" : "s"} rejected` : ""}.`,
    firstFailure: (code: string) => ` First failure: ${code}.`,
    scope:
      " These checks cover who signed the value, their authority (up to this demo's simulated root of trust) and the tonnage claim. They do not show that the emissions figure itself is correct, and they do not replace the verification report or the CBAM Registry.",
    tryBreak: "Try to break it →",
    nextWorkbench: (n: number, m: number) => `Next: see ${n} shipments from ${m} suppliers in the Importer workbench →`,
    head: "Check a supplier's proof",
    headLede: "An EU importer's compliance officer, or a downstream customer.",
    headStep: ["Step 2 of 3 — the supplier's side is already done in this demo. Load the demo proof, then press Verify.", "", "", ""],
  },
  "zh-TW": {
    checkSr: (n: number) => `檢查 ${n}：`,
    counts: (passed: number, total: number, review: number, notRun: number) =>
      `${total} 項檢查中 ${passed} 項通過` + (review ? `，${review} 項需審查` : "") + (notRun ? `，${notRun} 項未執行` : ""),
    unreadable: "無法讀取證明",
    checkFailed: (n: number) => `檢查 ${n} 未通過`,
    rejected: (what: string) => `已拒絕——${what}`,
    noGap: "請勿採信此證明的數值：不顯示申報排放差距。",
    checkList: (ns: number[]) => `檢查 ${listNums(ns, " 與 ")}`,
    incompleteHead: (list: string, _n: number, how: NotRunHow) =>
      `未驗證——${list} ${{ run: "未執行", decided: "無法判定", both: "未執行或無法判定" }[how]}`,
    incompleteBody: (counts: string, reasons: string[]) => `——${counts}。${reasons.join("。")}。請勿採信此證明的數值：不顯示申報排放差距。`,
    why: {
      extractMissing: "此證明未附報告摘錄，但憑證承諾了查核員所簽署的摘錄，因此無法套用檢查 8（針對已簽署報告的規則）",
      extractChanged:
        "此證明中的報告摘錄並非查核員所簽署者（有欄位遭更改、增加或刪除，或其比對的欄位遭隱藏），因此無法套用檢查 8（針對已簽署報告的規則）",
      evidence: (list: string, _n: number) => `${list}（查核員的簽署歷史與權限）未執行，或證據檢查器未確認`,
      precursors: "憑證承諾了前驅物聲明，但檢查 9 無法判定",
      carbonPrice: "此證明附有碳價聲明，但檢查 10 無法判定",
      sepolia: "這些檢查需要即時連線到 Sepolia",
      other: "有決定結果的檢查未執行",
    },
    notDecided: "無法判定：",
    warningsLabel: "驗證器的警告",
    reviewHead: "需審查",
    reviewBody: (counts: string) => `——${counts}。在有人審查報告之前，請勿採信經驗證的數值：不顯示申報排放差距。`,
    gap: (q: string, gap: string) => `此批 ${q} 噸出貨的申報排放差距：${gap} tCO2e（毛額，示意）`,
    intensity: (v: string) => `經驗證強度 ${v} tCO2e/t`,
    notDisclosed: "未揭露",
    seeComparison: "查看比較 ↓",
    humanReview: (detail: string) => `需人工審查：${detail}`,
    stampVerified: "已驗證",
    stampReview: "需審查",
    stampNotVerified: "未驗證",
    stampRejected: "已拒絕",
    hidden: (n: number, rejected: number) => `供應商隱藏了 ${n} 個欄位${rejected ? ` · ${rejected} 項揭露遭拒絕` : ""}。`,
    firstFailure: (code: string) => ` 第一個失敗：${code}。`,
    scope:
      " 這些檢查涵蓋誰簽署了數值、其權限（直到本示範模擬的信任根為止）以及噸數申領。它們不能證明排放數字本身正確，也不能取代驗證報告或 CBAM 登錄系統（CBAM Registry）。",
    tryBreak: "試著破解 →",
    nextWorkbench: (n: number, m: number) => `下一步：在進口商工作台查看來自 ${m} 家供應商的 ${n} 批出貨 →`,
    head: "檢查供應商的證明",
    headLede: "歐盟進口商的法遵人員，或下游客戶。",
    // The two buttons keep their English names (Load the demo proof, Verify); the sentence names them as shown.
    headStep: ["第 2 步（共 3 步）——在本示範中，供應商這一方已完成。按", "Load the demo proof", "，再按", "Verify"],
  },
} satisfies Record<Lang, unknown>;

/** proofComparison's English reasons (data.ts) in Traditional Chinese; an unknown reason shows the English. */
function noComparisonZh(why: string): string | null {
  if (why === "the supplier did not disclose the intensity") return "供應商未揭露排放強度";
  if (why === "no shipment quantity was confirmed on the ledger (check 5)") return "帳本上沒有確認的出貨數量（檢查 5）";
  const m = /^this demo lists the CBAM default for CN (\S+) only$/.exec(why);
  return m ? `本示範只列出 CN ${m[1]} 的 CBAM 預設值` : null;
}

/**
 * The rest of the tab's strings (proof panel, legend, comparison card, what-if card, downloads), in English and
 * Traditional Chinese. The buttons the main path and the tests name (Load the demo proof, Verify, Tamper with one
 * number, Accept verified value) keep their English names, marked lang="en".
 */
const UI = {
  en: {
    proofFor: (name: string) => `Supplier's proof for ${name}`,
    waiting: "Waiting for a Sepolia node…",
    fromSupplier: "Proof loaded from the Supplier tab.",
    fromQr: (batch: string) => [`Proof loaded from the product passport QR code (${batch}). Press `, "Verify", "."],
    pasteLabel: "Paste the supplier's proof",
    pastePlaceholder: 'Paste the supplier\'s proof here, or click "Load the demo proof" above.',
    checkingAs: (eori: string) => `Checking as importer EORI ${eori} (fictional).`,
    tamperedNote: "Disclosed intensity changed from 1.8 to 1.2.",
    notJson: "This is not a supplier's proof (not valid JSON).",
    couldNotFinish: (m: string) => `Verification could not finish: ${m}`,
    stillConnecting: "Still connecting to Sepolia — try again in a moment.",
    loadFirst: "Load a proof first.",
    checksHead: "Eight checks: seven verification checks plus one rule-based reconciliation check",
    legendLabel: "Source labels",
    legend: (exportDate: string) => [
      "◉ live · Sepolia = contract state read from Sepolia now",
      "◎ live · your browser = recomputed on this page (check 3 takes only the chain ID from the Sepolia node)",
      `▤ exported evidence = from a local KERI run (${exportDate})`,
      "≡ rule-based · advisory = recomputed on this page; fails on a CBAM rule the signed report breaks, not decided when the signed extract is missing or changed, otherwise flags for review",
    ],
    offlineCached: (d: string) => `Offline view: the result recorded for the demo proof on ${d}; no check was re-run.`,
    offlineLocal: "Offline view: checks 0–3 were recomputed in your browser; checks 4–8 need a live connection and were not run.",
    revoked: (date: string, block: number) =>
      `This report's auditor was revoked later (${date}, synced on-chain in block ${block}). Checks 4 and 7 both judge authority at registration time: check 4 through the contract, check 7 from the allowlist on Sepolia, where the auditor's revocation is dated after this report's registration. So the report stays valid (Try to break it, card 3).`,
    cmpHeadDefault: "CBAM default",
    cmpHead: "Verified value vs CBAM default",
    defaultK: "CBAM default (with 2026 mark-up)",
    verifiedK: "Verified value (illustrative)",
    forQ: (q: string, t: string) => `For ${q} t: ${t} tCO2e`,
    noValueFailed: (check: number | null) =>
      `No verified value: the proof failed ${check ? `check ${check}` : "the structure check"}. The figures from the demo report are not shown as a result.`,
    noValueIncomplete: "No verified value: checks 4–8 were not run (offline view). The figures from the demo report are not shown as a result.",
    noGapContested:
      "No declared-emissions gap: the report needs review (check 4: the auditor was revoked or the body suspended soon after registration). Do not rely on the verified value until a person has reviewed the report.",
    noGapFor: "No declared-emissions gap for this proof: ",
    gapLine: (gap: string) => `Declared-emissions gap: ${gap} tCO2e`,
    gapEur: (eur: string, quarter: string, price: string) =>
      `≈ €${eur} gross at the ${quarter} CBAM certificate price of €${price} — illustrative, before free-allocation adjustment.`,
    notPhysical: "A gap in what is declared, not a physical reduction.",
    acceptFirst: ["Verify the proof first. Accepting stays in this browser: nothing is sent to the CBAM Registry or on-chain.", "", ""],
    accepted: "Accepted (demo).",
    declared: (vq: string, batch: string) => `Declared ${vq} tCO2e for batch ${batch}.`,
    verifiedFor: (v: string, batch: string) => `Verified value ${v} tCO2e/t${batch ? ` for batch ${batch}` : ""}.`,
    staysHere: "This choice stays in your browser — no transaction is sent. On-chain record for this batch: the supplier's claim",
    notRecorded: "(not recorded)",
    downloadRecord: "Download verification record (JSON)",
    recordNote: "For your own records: the checks, the credential ID and the on-chain claim. Not a CBAM document.",
    readingRecord: "Reading the on-chain record…",
    downloadPact: "Download PACT product footprint (JSON)",
    pactNote:
      "PACT data model v3.0.3, validated against the official schema in our tests. Not a conformance claim and not connected to any PACT network.",
    pactError: (m: string) => `No PACT file was created: ${m}`,
    print: "Print the importer's file",
    printNote:
      "One page with this result, the credential ID, the block the checks read and the on-chain claim — print it or save it as PDF for your own file. Not signed; not a CBAM document.",
    summaryFields: ["CN code", "Verified intensity", "Verified quantity", "Reporting period", "Verification body LEI"],
    summaryLabel: "What this proof states (not yet checked)",
    shipment: "Shipment",
    summaryNote: (disclosed: number, hidden: number) =>
      `${disclosed} field${disclosed === 1 ? "" : "s"} disclosed${hidden > 0 ? ` · ${hidden} hidden by the supplier` : ""} · what the proof states, not yet checked. Raw JSON below.`,
    wiDefault: (v: string) => `${v} (the CBAM default)`,
    wiHead: "What a lower verified intensity is worth",
    wiHypo: "Hypothetical",
    wiLabel: ["What if the verified value were ", " tCO2e/t?"],
    wiValueText: (label: string) => `${label} tCO2e per tonne, hypothetical`,
    wiScale: (d: string) => `${d} = CBAM default`,
    wiStarts: (v: string) => `Starts at this proof's verified value (${v}). Moving it changes nothing in the proof or in the figures above.`,
    wiGap: "Declared-emissions gap per tonne of goods",
    wiEurT: "Gross € value per tonne of goods",
    wiEurShip: (q: string) => `Gross € value of this ${q} t shipment`,
    wiSame: (quarter: string, price: string) =>
      `Same ${quarter} CBAM certificate price (€${price}) and quantity as above — gross, illustrative, before free-allocation adjustment.`,
    wiRate: ["At this certificate price, each ", "0.1 tCO2e/t", " of verified intensity accounts for about ", (eur: string) => `€${eur} per tonne of goods`, " (gross, illustrative)."] as const,
    wiPoint:
      "That value depends on the buyer trusting who signed the verified value and that its tonnes were not claimed before — what the checks above answer. Who captures it is a commercial matter between buyer and producer. CarbonLEI does not measure or change emissions: any physical effect depends on producers acting on that value, and this demo does not quantify it.",
  },
  "zh-TW": {
    proofFor: (name: string) => `供應商給 ${name} 的證明`,
    waiting: "正在等候 Sepolia 節點回應…",
    fromSupplier: "證明已從供應商分頁載入。",
    fromQr: (batch: string) => [`證明已從產品護照 QR code 載入（${batch}）。請按「`, "Verify", "」。"],
    pasteLabel: "貼上供應商的證明",
    pastePlaceholder: "在此貼上供應商的證明，或按上方的「Load the demo proof」。",
    checkingAs: (eori: string) => `以進口商 EORI ${eori}（虛構）的身分檢查。`,
    tamperedNote: "揭露的排放強度已從 1.8 改為 1.2。",
    notJson: "這不是供應商的證明（不是有效的 JSON）。",
    couldNotFinish: (m: string) => `驗證無法完成：${m}`,
    stillConnecting: "仍在連線到 Sepolia——請稍後再試。",
    loadFirst: "請先載入證明。",
    checksHead: "八項檢查：七項驗證檢查，加上一項規則式比對檢查",
    legendLabel: "來源標籤",
    legend: (exportDate: string) => [
      "◉ 即時 · Sepolia = 現在從 Sepolia 讀取的合約狀態",
      "◎ 即時 · 您的瀏覽器 = 在本頁重新計算（檢查 3 只從 Sepolia 節點取得 chain ID）",
      `▤ 匯出的證據 = 來自本機 KERI 執行（${exportDate}）`,
      "≡ 規則式 · 僅供參考 = 在本頁重新計算；已簽署的報告違反 CBAM 規則時判定未通過，已簽署的摘錄缺漏或遭更改時無法判定，其他發現則標示為需審查",
    ],
    offlineCached: (d: string) => `離線檢視：顯示 ${d} 為示範證明記錄的結果，沒有重新執行任何檢查。`,
    offlineLocal: "離線檢視：檢查 0–3 已在您的瀏覽器重新計算；檢查 4–8 需要即時連線，因此未執行。",
    revoked: (date: string, block: number) =>
      `此報告的查核員後來遭撤銷（${date}，於區塊 ${block} 同步上鏈）。檢查 4 與檢查 7 都以報告登記當時判斷權限：檢查 4 透過合約，檢查 7 依據 Sepolia 上的允許清單，其中查核員的撤銷時間晚於此報告的登記。因此報告仍然有效（見「試著破解」卡片 3）。`,
    cmpHeadDefault: "CBAM 預設值",
    cmpHead: "經查證值與 CBAM 預設值比較",
    defaultK: "CBAM 預設值（含 2026 年加成）",
    verifiedK: "經查證值（示意）",
    forQ: (q: string, t: string) => `${q} t 合計：${t} tCO2e`,
    noValueFailed: (check: number | null) =>
      `沒有經查證值：此證明未通過${check ? `檢查 ${check}` : "結構檢查"}。示範報告的數字不會當作結果顯示。`,
    noValueIncomplete: "沒有經查證值：檢查 4–8 未執行（離線檢視）。示範報告的數字不會當作結果顯示。",
    noGapContested:
      "不顯示申報排放差距：此報告需要審查（檢查 4：報告登記後不久，查核員遭撤銷或驗證機構遭暫停）。在有人審查報告之前，請勿採信經查證值。",
    noGapFor: "此證明不顯示申報排放差距：",
    gapLine: (gap: string) => `申報排放差距：${gap} tCO2e`,
    gapEur: (eur: string, quarter: string, price: string) => `以 ${quarter} CBAM 憑證價格 €${price} 計，毛額約 €${eur}——示意，未計入免費配額調整。`,
    notPhysical: "這是申報數字上的差距，不是實際減排。",
    acceptFirst: ["請先驗證證明。按下「", "Accept verified value", "」只記在此瀏覽器：不會傳送任何資料到 CBAM 登錄系統，也不會上鏈。"],
    accepted: "已採用經查證值（示範）。",
    declared: (vq: string, batch: string) => `批次 ${batch} 申報 ${vq} tCO2e。`,
    verifiedFor: (v: string, batch: string) => `${batch ? `批次 ${batch} 的` : ""}經查證值為 ${v} tCO2e/t。`,
    staysHere: "這個選擇只記在您的瀏覽器——不會送出任何交易。此批次的鏈上紀錄：供應商的申領",
    notRecorded: "（未記錄）",
    downloadRecord: "下載驗證紀錄（JSON）",
    recordNote: "供您自行留存：檢查結果、憑證 ID 與鏈上申領。不是 CBAM 文件。",
    readingRecord: "正在讀取鏈上紀錄…",
    downloadPact: "下載 PACT 產品碳足跡（JSON）",
    pactNote: "PACT 資料模型 v3.0.3，已在我們的測試中以官方 schema 驗證。這不是符合性聲明，也未連接任何 PACT 網路。",
    pactError: (m: string) => `未建立 PACT 檔案：${m}`,
    print: "列印進口商檔案",
    printNote: "一頁包含此結果、憑證 ID、檢查所讀取的區塊與鏈上申領——可列印或另存為 PDF，供您自行歸檔。未簽署；不是 CBAM 文件。",
    summaryFields: ["CN 代碼", "經查證排放強度", "經查證數量", "報告期間", "驗證機構 LEI"],
    summaryLabel: "此證明陳述的內容（尚未檢查）",
    shipment: "出貨",
    summaryNote: (disclosed: number, hidden: number) =>
      `已揭露 ${disclosed} 個欄位${hidden > 0 ? ` · 供應商隱藏了 ${hidden} 個` : ""} · 這是證明所陳述的內容，尚未檢查。原始 JSON 在下方。`,
    wiDefault: (v: string) => `${v}（CBAM 預設值）`,
    wiHead: "較低的經查證排放強度值多少",
    wiHypo: "假設情境",
    wiLabel: ["假如經查證值是 ", " tCO2e/t？"],
    wiValueText: (label: string) => `每噸 ${label} tCO2e，假設情境`,
    wiScale: (d: string) => `${d} = CBAM 預設值`,
    wiStarts: (v: string) => `起點是此證明的經查證值（${v}）。移動滑桿不會改變證明，也不會改變上方的任何數字。`,
    wiGap: "每噸貨物的申報排放差距",
    wiEurT: "每噸貨物的毛額價值（€）",
    wiEurShip: (q: string) => `這批 ${q} t 出貨的毛額價值（€）`,
    wiSame: (quarter: string, price: string) =>
      `採用與上方相同的 ${quarter} CBAM 憑證價格（€${price}）與數量——毛額、示意，未計入免費配額調整。`,
    wiRate: ["以此憑證價格計算，經查證排放強度每 ", "0.1 tCO2e/t", "，大約相當於", (eur: string) => `每噸貨物 €${eur}`, "（毛額，示意）。"] as const,
    wiPoint:
      "這個價值的前提是：買方信任簽署經查證值的人，並確認其噸數先前沒有被申領過——這正是上方檢查回答的問題。價值由誰取得，是買方與生產者之間的商業安排。CarbonLEI 不測量、也不改變排放：任何實際效果取決於生產者是否據此採取行動，本示範並未加以量化。",
  },
} satisfies Record<Lang, unknown>;

/**
 * The text shown for a check: the plain-language text of its code, else its detail. CONTESTED has several
 * reasons (SECURITY §4.2); the code's text describes the revocation-sync one, so any other reason shows its detail.
 */
function checkText(r: CheckResult, lang: Lang = "en"): string {
  if (r.code === "CONTESTED" && !/; revoked or suspended within [\d.]+ h after$/.test(r.detail)) {
    return VERDICT[lang].humanReview(r.detail);
  }
  return codeText(r.code, lang === "zh-TW") ?? r.detail;
}

/** checkText for the page: in Traditional Chinese, an English detail the SDK wrote (no translated code text) is marked lang="en". */
function CheckText({ r, lang }: { r: CheckResult; lang: Lang }) {
  if (lang !== "zh-TW") return <>{checkText(r, lang)}</>;
  if (r.code === "CONTESTED" && !/; revoked or suspended within [\d.]+ h after$/.test(r.detail)) {
    return (
      <>
        {VERDICT[lang].humanReview("")}
        <span lang="en">{r.detail}</span>
      </>
    );
  }
  const t = codeText(r.code, true);
  return t ? <>{t}</> : <span lang="en">{r.detail}</span>;
}

export function kindOf(c?: CheckResult): BadgeKind {
  if (!c) return "idle";
  if (c.status === "fail") return "fail";
  if (c.status === "warn" || c.code === "CONTESTED") return "review";
  if (c.status === "skipped") return "skip";
  return "pass";
}

/** Replaces the disclosed emissions intensity with another value (the "Tamper" action and attack 1). */
export function tamperedProof(p: Presentation, value = "1.2"): Presentation {
  return {
    ...p,
    disclosures: p.disclosures.map((d) => {
      const x = decodeDisclosure(d);
      return x.name === "specificEmbeddedEmissions_tCO2e_per_t" ? encodeDisclosure({ ...x, value }) : d;
    }),
  };
}

/**
 * Product fields of the PACT export: the same arguments as the `carbonlei export-pact` example in
 * docs/PACT_MAPPING.md section 4, so the browser and the CLI produce the same file (only `created` differs).
 */
const PACT_PRODUCT: PactProduct = {
  companyName: fixture.entities.supplier.name,
  productNameCompany: fixture.product.productNameCompany,
  productDescription: `${fixture.product.description} — CBAM direct embedded emissions only, not a full PCF (illustrative)`,
  productId: "hex-bolt-m10",
};

/** Saves a JSON file built in the browser. */
function saveJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const eur2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * "What if" control in the comparison card: the same price and quantity as the card, for a hypothetical
 * verified intensity. Never changes the proof or the verified figures above it.
 */
function WhatIf({ cmp }: { cmp: DemoData["comparison"] }) {
  const verified = Number(cmp.verifiedValue);
  const def = Number(cmp.defaultValue);
  const min = Math.min(1, verified);
  // Steps of 0.1 from the minimum; the last step stands for the CBAM default itself.
  const max = Math.ceil(def * 10) / 10;
  const [pos, setPos] = useState(verified);
  const x = Math.min(pos, def);
  const { gapPerT, eurPerT, eurShipment, eurPerTenth } = whatIfFigures(cmp, x);
  const q = Number(cmp.quantityTonnes);
  const u = UI[useLang().lang];
  const label = x === def ? u.wiDefault(fmt(x, 3)) : fmt(x, 3);
  return (
    <div className="whatif" role="group" aria-labelledby="whatif-h">
      <p className="whatif-head" id="whatif-h">
        <span aria-hidden="true">◇ </span>
        {u.wiHead} <span className="tag-hypo">{u.wiHypo}</span>
      </p>
      <label className="whatif-label" htmlFor="whatif-range">
        {u.wiLabel[0]}
        <strong>{label}</strong>
        {u.wiLabel[1]}
      </label>
      <input
        id="whatif-range"
        className="whatif-range"
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={pos}
        aria-valuetext={u.wiValueText(label)}
        onChange={(e) => setPos(Math.round(Number(e.target.value) * 10) / 10)}
      />
      <div className="whatif-scale fine" aria-hidden="true">
        <span>{min.toFixed(1)}</span>
        <span>{u.wiScale(fmt(def, 3))}</span>
      </div>
      <p className="fine">{u.wiStarts(cmp.verifiedValue)}</p>
      <dl className="whatif-out" aria-live="polite" aria-atomic="true">
        <div>
          <dt>{u.wiGap}</dt>
          <dd>{fmt(gapPerT, 3)} tCO2e</dd>
        </div>
        <div>
          <dt>{u.wiEurT}</dt>
          <dd>€{eur2(eurPerT)}</dd>
        </div>
        <div>
          <dt>{u.wiEurShip(fmt(q))}</dt>
          <dd>€{fmt(eurShipment, 0)}</dd>
        </div>
      </dl>
      <p className="fine">{u.wiSame(cmp.quarter, cmp.priceEur)}</p>
      <p className="whatif-rate">
        {u.wiRate[0]}
        <strong>{u.wiRate[1]}</strong>
        {u.wiRate[2]}
        <strong>{u.wiRate[3](eur2(eurPerTenth))}</strong>
        {u.wiRate[4]}
      </p>
      <p className="whatif-point">{u.wiPoint}</p>
    </div>
  );
}

/**
 * One line under the Verify button: how many checks passed and, only for a valid proof, the declared-emissions gap
 * computed from that proof (`cmp`, null when it has nothing to compare).
 */
function VerifySummary({
  result,
  cmp,
  onSeeComparison,
}: {
  result: VerificationResult;
  cmp: DemoData["comparison"] | null;
  onSeeComparison: () => void;
}) {
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const v = VERDICT[lang];
  const kinds = CHECKS.map((c) => kindOf(result.checks.find((r) => r.index === c.n)));
  const passed = kinds.filter((k) => k === "pass").length;
  const review = kinds.filter((k) => k === "review").length;
  const notRun = kinds.filter((k) => k === "skip" || k === "idle").length;
  const counts = v.counts(passed, CHECKS.length, review, notRun);

  if (result.overall === "INVALID") {
    const first = result.checks.find((c) => c.status === "fail");
    const what = !first || first.index === 0 ? v.unreadable : v.checkFailed(first.index);
    const why = first ? (codeText(first.code, zh) ?? first.detail) : "";
    return (
      <p className="verify-summary bad">
        <span aria-hidden="true">✕ </span>
        <strong>{v.rejected(what)}</strong>
        {zh ? (why ? `：${why}` : "。") : why ? `: ${why}` : "."} {counts}
        {zh ? "。" : ". "}
        {v.noGap}
      </p>
    );
  }
  if (result.overall === "INCOMPLETE") {
    const why = incompleteReason(result, lang);
    return (
      <p className="verify-summary review">
        <span aria-hidden="true">! </span>
        <strong>{why.head}</strong>
        {v.incompleteBody(counts, why.reasons)}
      </p>
    );
  }
  if (result.overall === "CONTESTED") {
    return (
      <p className="verify-summary review">
        <span aria-hidden="true">! </span>
        <strong>{v.reviewHead}</strong>
        {v.reviewBody(counts)}
      </p>
    );
  }
  const f = cmp ? comparisonFigures(cmp) : null;
  return (
    <p className="verify-summary ok">
      <span aria-hidden="true">✓ </span>
      <strong>{counts}</strong> ·{" "}
      {f ? <>{v.gap(fmt(f.q), fmt(f.gap))}</> : <>{v.intensity(result.disclosed.specificEmbeddedEmissions_tCO2e_per_t ?? v.notDisclosed)}</>}{" "}
      <button type="button" className="link-btn" onClick={onSeeComparison}>
        {v.seeComparison}
      </button>
    </p>
  );
}

/** Under a VALID result, after the check list: what the verified value is worth under CBAM's price. */
function ClimateLink({ cmp, onSeeComparison }: { cmp: DemoData["comparison"]; onSeeComparison: () => void }) {
  const { lang } = useLang();
  const per = eur2(whatIfFigures(cmp, 0).eurPerTenth);
  if (lang === "zh-TW")
    return (
      <p className="verify-climate">
        <strong>氣候連結：</strong>CBAM 的價格只有在買方信任查證值、而不是較高的預設值時，才會獎勵較低的查證排放。以 €{cmp.priceEur}/tCO2e
        計，每低 0.1 tCO2e/t，每噸貨物約值 €{per}（毛額、示意）。{" "}
        <button type="button" className="link-btn" onClick={onSeeComparison}>
          價格表與滑桿 ↓
        </button>
      </p>
    );
  return (
    <p className="verify-climate">
      <strong>Climate link:</strong> CBAM's price rewards lower verified emissions only if buyers trust the verified
      value instead of the higher default. At €{cmp.priceEur}/tCO2e, each 0.1 tCO2e/t lower is worth about €
      {per} per tonne of goods (gross, illustrative).{" "}
      <button type="button" className="link-btn" onClick={onSeeComparison}>
        Price table and slider ↓
      </button>
    </p>
  );
}

/** Field and unit; the labels are UI[lang].summaryFields, in the same order. */
const SUMMARY_FIELDS: [string, string][] = [
  ["cnCode", ""],
  ["specificEmbeddedEmissions_tCO2e_per_t", " tCO2e/t"],
  ["verifiedTonnes", " t"],
  ["reportingPeriod", ""],
  ["verifierLEI", ""],
];

/** What a pasted proof says, in words, before anyone reads the JSON. Nothing here is checked yet. */
function ProofSummary({ text }: { text: string }) {
  const u = UI[useLang().lang];
  const fields: Record<string, string> = {};
  let disclosed = 0;
  let total = 0;
  let batch = "";
  try {
    const p = JSON.parse(text) as Presentation;
    const core = JSON.parse(p.core) as { digests?: unknown[] };
    for (const d of p.disclosures ?? []) {
      try {
        const x = decodeDisclosure(d);
        fields[x.name] = x.value;
      } catch {
        // a malformed field is reported by check 2
      }
    }
    disclosed = (p.disclosures ?? []).length;
    total = Array.isArray(core.digests) ? core.digests.length : 0;
    batch = p.shipment ? `${p.shipment.batchId} · ${p.shipment.quantityTonnes} t` : "";
  } catch {
    return null;
  }
  return (
    <div className="proof-summary" role="group" aria-label={u.summaryLabel}>
      <dl className="fields">
        {SUMMARY_FIELDS.map(([k, unit], i) => [k, u.summaryFields[i], unit] as const)
          .filter(([k]) => fields[k] !== undefined)
          .map(([k, label, unit]) => (
          <Fragment key={k}>
            <dt>{label}</dt>
            <dd>
              {fields[k]}
              {unit}
            </dd>
          </Fragment>
        ))}
        {batch && (
          <>
            <dt>{u.shipment}</dt>
            <dd>{batch}</dd>
          </>
        )}
      </dl>
      <p className="fine">{u.summaryNote(disclosed, total - disclosed)}</p>
    </div>
  );
}

export function Buyer() {
  const { lang } = useLang();
  const vt = VERDICT[lang];
  const ui = UI[lang];
  const zh = lang === "zh-TW";
  const { data, reader, offline, proofText, setProofText, proofFromSupplier, go, explorer, demoVerify, setDemoVerify } = useApp();
  const wbCounts = workbenchCounts(data);
  // The last verification: the text it read, that text's proof and the result. It is shown only while the text box
  // still holds that same text, so editing, loading or tampering never leaves an earlier result on screen.
  const [verified, setVerified] = useState<{ text: string; proof: Presentation; result: VerificationResult; cached: boolean; at: string } | null>(null);
  const current = verified && verified.text === proofText ? verified : null;
  const result = current?.result ?? null;
  const [running, setRunning] = useState(false);
  // Verify has waited more than about 3 s for the chain: a progress line is shown until it finishes.
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<{ f: (u: (typeof UI)[Lang]) => string } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [fromQr, setFromQr] = useState(false);
  // The proof behind `result`; used by the PACT export and the verification record.
  const checked = current?.proof ?? null;
  const [pactBusy, setPactBusy] = useState(false);
  // "Print the importer's file": each press mounts the printable page again (n), which opens the print dialog. It
  // belongs to the verification it was pressed for (at), so a later result never opens the dialog by itself.
  const [printReq, setPrintReq] = useState<{ n: number; at: string } | null>(null);
  const [pactError, setPactError] = useState("");
  // Bumped when a verification finishes; on narrow screens the summary line under Verify is then scrolled into view.
  const [finished, setFinished] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const cmpRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!finished || !window.matchMedia("(max-width: 600px)").matches) return;
    if (summaryRef.current) scrollBelowTabbar(summaryRef.current);
  }, [finished]);

  function seeComparison() {
    const el = cmpRef.current;
    if (!el) return;
    scrollBelowTabbar(el);
    el.focus({ preventScroll: true });
  }

  // A proof in the box (loaded, pasted, from the Supplier tab or the QR code): fetch its evidence file now,
  // so Verify does not wait for the download. Verify still checks the file's hash against the proof.
  useEffect(() => {
    try {
      prefetchEvidence((JSON.parse(proofText) as Presentation).authorityEvidence);
    } catch {
      // not a proof (yet); Verify reports it
    }
  }, [proofText]);

  // The product passport QR opens #buyer?said=<credSAID>&batch=<batchId>: load the matching demo proof.
  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const said = q.get("said");
    if (!said || proofText) return;
    if (said === JSON.parse(data.proof.core).d && (!q.get("batch") || q.get("batch") === data.shipment.batchId)) {
      setProofText(JSON.stringify(data.proof, null, 2));
      setFromQr(true);
    }
  }, [data, proofText, setProofText]);

  // "Verify the demo proof" on the first screen put the demo proof in the box: verify it once the chain is
  // reachable (or the cached view is chosen). Any other text in the box by then cancels the request.
  useEffect(() => {
    if (!demoVerify || running || (!reader && !offline)) return;
    setDemoVerify(false);
    if (proofText !== JSON.stringify(data.proof, null, 2)) return;
    setAccepted(false);
    setTampered(false);
    void run(proofText);
  }, [demoVerify, running, reader, offline, proofText]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(text: string) {
    setError(null);
    setAccepted(false);
    setPactError("");
    let proof: Presentation;
    try {
      proof = JSON.parse(text) as Presentation;
    } catch {
      setError({ f: (u) => u.notJson });
      return;
    }
    if (offline) {
      // The cached result belongs to the demo proof only: it is shown for that exact text (as "Load the demo proof"
      // puts it in the box). Any other text gets checks 0-3 in this browser, under the deployment's signing domain;
      // checks 4-8 need the chain, so the result is never VALID.
      if (data.cached?.verification && text === JSON.stringify(data.proof, null, 2)) {
        setVerified({ text, proof, result: data.cached.verification as VerificationResult, cached: true, at: data.cached.time });
      } else {
        try {
          const r = await verifyOffline(
            proof,
            { registry: data.deployment.contracts.EmissionsClaimRegistry.address, chainId: data.network.chainId },
            { proofText: text },
          );
          setVerified({ text, proof, result: r, cached: false, at: new Date().toISOString() });
        } catch (e) {
          { const m = (e as Error).message; setError({ f: (u) => u.couldNotFinish(m) }); }
          return;
        }
      }
      setFinished((n) => n + 1);
      return;
    }
    if (!reader) {
      setError({ f: (u) => u.stillConnecting });
      return;
    }
    setRunning(true);
    const slowTimer = window.setTimeout(() => setSlow(true), 3000);
    try {
      const r = await verifyPresentation(proof, reader, {
        importerEORI: data.importer.eori,
        checkers: evidenceCheckers(data),
        proofText: text,
      });
      setVerified({ text, proof, result: r, cached: false, at: new Date().toISOString() });
      setFinished((n) => n + 1);
    } catch (e) {
      { const m = (e as Error).message; setError({ f: (u) => u.couldNotFinish(m) }); }
    } finally {
      window.clearTimeout(slowTimer);
      setSlow(false);
      setRunning(false);
    }
  }

  const byIndex = new Map(result?.checks.map((c) => [c.index, c]));
  const counts = result && checked ? disclosureCounts(checked, result) : null;
  const hiddenN = counts ? counts.hidden : (result?.hidden ?? 0);
  const hiddenText = vt.hidden(hiddenN, counts?.rejected ?? 0);
  const incompleteCodes = result && !running && result.overall === "INCOMPLETE" ? incompleteReason(result, lang).codes : [];
  const rejectedProof = !!result && !running && result.overall === "INVALID";
  const incomplete = !!result && !running && result.overall === "INCOMPLETE";
  // CONTESTED: the summary says no declared-emissions gap is shown, so the card shows none either.
  const contested = !!result && !running && result.overall === "CONTESTED";
  const rejectedCheck = rejectedProof ? result?.checks.find((c) => c.status === "fail") : undefined;
  const malformed = result?.checks.find((c) => c.index === 0 && c.status === "fail");
  // Before any verification the card shows the demo report's figures (illustrative); after one, the verified
  // proof's own figures, or none.
  const fromProof = result && !rejectedProof && !incomplete && !contested ? proofComparison(data.comparison, data.report.cnCode, result, checked?.shipment) : null;
  const cmp = fromProof ? fromProof.cmp : data.comparison;
  const noComparison = fromProof && !fromProof.cmp ? fromProof.why : "";
  const { q, dq, vq, gap, eur } = comparisonFigures(cmp ?? data.comparison);
  const verifiedValue = result?.disclosed.specificEmbeddedEmissions_tCO2e_per_t;
  const claimTx = data.txs.find((t) => t.step === "claim1");
  const revokeTx = data.txs.find((t) => t.step === "revokeAuditor" && t.result === "success");
  const isDemoProof = (() => {
    try {
      return !!checked && JSON.parse(checked.core).d === JSON.parse(data.proof.core).d;
    } catch {
      return false;
    }
  })();
  const batchId = checked?.shipment?.batchId ?? "";
  const acceptedNow = accepted && result?.overall === "VALID";

  // A file the importer can keep with its own records. Built in the browser from this page's checks; not signed.
  function downloadRecord() {
    if (!result || !checked) return;
    let credSAID = "";
    try {
      credSAID = JSON.parse(checked.core).d;
    } catch {
      // the checks above already reported a malformed proof
    }
    const claim = claimTx && batchId === data.shipment.batchId ? claimTx : undefined;
    const record = {
      kind: "CarbonLEI verification record (demo)",
      notice:
        "Generated in your browser from the checks below. Not signed, not a CBAM Registry document and not a CBAM declaration. All companies are fictional; emissions values are illustrative.",
      createdAt: new Date().toISOString(),
      network: {
        name: data.network.name,
        chainId: data.network.chainId,
        registry: data.deployment.contracts.EmissionsClaimRegistry.address,
      },
      credSAID,
      batchId,
      importerEORI: data.importer.eori,
      overall: result.overall,
      checks: result.checks.map(({ index, name, status, code, detail }) => ({ index, name, status, code, detail })),
      accepted: cmp
        ? { quantityTonnes: q, verifiedIntensity_tCO2e_per_t: cmp.verifiedValue, declared_tCO2e: vq }
        : { quantityTonnes: null, verifiedIntensity_tCO2e_per_t: verifiedValue ?? null, declared_tCO2e: null },
      onChainClaim: claim ? { tx: claim.hash, block: claim.block, time: claim.time, url: explorer("tx", claim.hash) } : null,
      // The proof itself, so `carbonlei recheck` can re-verify this record later (docs/OPERATE.md › Importer re-check).
      proof: checked,
    };
    saveJson(record, `carbonlei-verification-${batchId || "record"}.json`);
  }

  // PACT v3.0.3 ProductFootprint of the verified credential, built in the browser by the SDK's export
  // (the same function as `carbonlei export-pact`). Only for a VALID result with a live connection.
  const canExportPact = result?.overall === "VALID" && !!checked && !!reader && !offline;
  async function downloadPact() {
    if (!canExportPact || !checked || !reader || !result) return;
    setPactBusy(true);
    setPactError("");
    try {
      const pf = await exportPactFromProof(checked, result, reader, PACT_PRODUCT);
      const id = checked.shipment?.batchId || (JSON.parse(checked.core) as { d: string }).d;
      saveJson(pf, `carbonlei-pact-${id}.json`);
    } catch (e) {
      const m = (e as Error).message;
      setPactError(UI[lang].pactError(m));
    } finally {
      setPactBusy(false);
    }
  }

  return (
    <>
      <TabHead title={vt.head} lede={vt.headLede}>
        <p className="fine">
          {vt.headStep[0]}
          {vt.headStep[1] && (
            <>
              「<span lang="en">{vt.headStep[1]}</span>」{vt.headStep[2]}「<span lang="en">{vt.headStep[3]}</span>」。
            </>
          )}
        </p>
      </TabHead>
      <div className="grid-2">
        <section className="sheet reveal" aria-labelledby="proof-h">
          <p className="sheet-kicker" id="proof-h">
            {ui.proofFor(data.importer.name)}
          </p>
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setProofText(JSON.stringify(data.proof, null, 2));
                setAccepted(false);
                setTampered(false);
              }}
              lang={lang === "zh-TW" ? "en" : undefined}
            >
              Load the demo proof
            </button>
            <button
              className="btn"
              disabled={running || !proofText || (!reader && !offline)}
              onClick={() => run(proofText)}
              lang={lang === "zh-TW" ? "en" : undefined}
            >
              {running ? "Verifying…" : "Verify"}
            </button>
          </div>
          <div className="verify-summary-slot" role="status" ref={summaryRef}>
            {running && slow && <p className="conn">{ui.waiting}</p>}
            {result && !running && <VerifySummary result={result} cmp={fromProof ? fromProof.cmp : null} onSeeComparison={seeComparison} />}
          </div>
          {proofFromSupplier && <p className="fine">{ui.fromSupplier}</p>}
          {fromQr && (
            <p className="fine">
              {ui.fromQr(data.shipment.batchId)[0]}
              <span lang={zh ? "en" : undefined}>{ui.fromQr(data.shipment.batchId)[1]}</span>
              {ui.fromQr(data.shipment.batchId)[2]}
            </p>
          )}
          {proofText && <ProofSummary text={proofText} />}
          <label className="field-label" htmlFor="proof-in">
            {ui.pasteLabel}
          </label>
          <textarea
            id="proof-in"
            className="proof"
            spellCheck={false}
            placeholder={ui.pastePlaceholder}
            lang={lang === "zh-TW" ? "en" : undefined}
            value={proofText}
            onChange={(e) => {
              setProofText(e.target.value);
              setAccepted(false);
            }}
          />
          <p className="fine">{ui.checkingAs(data.importer.eori)}</p>
          {proofText && (
            <div className="btn-row">
              <button
                className="btn btn-ghost"
                disabled={running || (!reader && !offline)}
                onClick={() => {
                  try {
                    const p = tamperedProof(JSON.parse(proofText) as Presentation);
                    const text = JSON.stringify(p, null, 2);
                    setProofText(text);
                    setTampered(true);
                    void run(text);
                  } catch {
                    setError({ f: (u) => u.loadFirst });
                  }
                }}
                lang={zh ? "en" : undefined}
              >
                Tamper with one number
              </button>
              {tampered && <span className="fine">{ui.tamperedNote}</span>}
            </div>
          )}
        </section>

        <section className="sheet reveal" aria-labelledby="checks-h">
          <p className="sheet-kicker" id="checks-h">
            {ui.checksHead}
          </p>
          <div className="legend" role="group" aria-label={ui.legendLabel}>
            {ui.legend(data.exportDate).map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
          {error && (
            <p className="check-detail bad" role="alert">
              {error.f(ui)}
            </p>
          )}
          {offline && result && !running && (
            <p className="fine" role="note">
              {current?.cached ? ui.offlineCached(data.cached?.time.slice(0, 10) ?? "") : ui.offlineLocal}
            </p>
          )}
          {malformed && (
            <p className="check-detail bad" role="alert">
              ✕ {codeText(malformed.code, zh) ?? malformed.code} <span lang={zh ? "en" : undefined}>{malformed.detail}</span>
            </p>
          )}
          <ol className="checks" aria-live="polite">
            {CHECKS.map((c) => {
              const r = byIndex.get(c.n);
              const kind = running ? "idle" : kindOf(r);
              return (
                <li key={c.n} className="check">
                  <span className="check-num" aria-hidden="true">
                    {c.n}
                  </span>
                  <span className="check-text">
                    <span className="sr-only">{vt.checkSr(c.n)}</span>
                    {lang === "zh-TW" ? CHECK_TEXT_ZH[c.n] : c.text}
                  </span>
                  <span className="check-result">
                    <Badge kind={kind}>{lang === "zh-TW" ? BADGE_ZH[kind] : undefined}</Badge>
                  </span>
                  <span className={`check-detail ${kind === "fail" ? "bad" : ""}`}>
                    <SourceLabel source={c.source} />{" "}
                    {r && r.code ? <code>{r.code}</code> : null}
                    {r && r.code ? " — " : " "}
                    {r ? <CheckText r={r} lang={lang} /> : ""}
                  </span>
                  {r?.rules && r.rules.length > 0 && r.status !== "skipped" && !running && <SubRules rules={r.rules} />}
                </li>
              );
            })}
          </ol>
          {result && !running && result.overall === "VALID" && fromProof?.cmp && (
            <ClimateLink cmp={fromProof.cmp} onSeeComparison={seeComparison} />
          )}
          {result && !running && revokeTx && isDemoProof && (
            <p className="fine">{ui.revoked(revokeTx.time.slice(0, 10), revokeTx.block)}</p>
          )}
          {result && !running && (
            <div className="overall">
              {result.overall === "VALID" ? (
                <span className="stamp green">{vt.stampVerified}</span>
              ) : result.overall === "CONTESTED" ? (
                <span className="stamp" style={{ color: "var(--amber)" }}>
                  {vt.stampReview}
                </span>
              ) : result.overall === "INCOMPLETE" ? (
                <span className="stamp" style={{ color: "var(--amber)" }}>
                  {vt.stampNotVerified}
                </span>
              ) : (
                <span className="stamp red">{vt.stampRejected}</span>
              )}
              <p>
                {hiddenText}
                {result.primaryCode ? vt.firstFailure(result.primaryCode) : ""}
                {incompleteCodes.length > 0 && (
                  <span className="overall-reason">
                    {" "}
                    {vt.notDecided}
                    {incompleteCodes.map((c, i) => (
                      <Fragment key={c}>
                        {i > 0 && ", "}
                        <code>{c}</code>
                      </Fragment>
                    ))}
                    {lang === "zh-TW" ? "。" : "."}
                  </span>
                )}
                {vt.scope}
              </p>
              {result.warnings && result.warnings.length > 0 && (
                <ul className="overall-warnings" aria-label={vt.warningsLabel}>
                  {result.warnings.map((w) => (
                    <li key={w.code}>
                      <code>{w.code}</code> — <span lang={lang === "zh-TW" ? "en" : undefined}>{w.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              <button className="btn btn-ghost" onClick={() => go("try-to-break-it")}>
                {vt.tryBreak}
              </button>
              {result.overall === "VALID" && (
                <p className="fine next-workbench">
                  <button type="button" className="link-btn" onClick={() => go("importer-workbench")}>
                    {vt.nextWorkbench(wbCounts.shipments, wbCounts.suppliers)}
                  </button>
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <section
        className="sheet reveal"
        id="comparison"
        aria-labelledby="cmp-h"
        style={{ marginTop: 28 }}
        ref={cmpRef}
        tabIndex={-1}
      >
        <p className="sheet-kicker" id="cmp-h">
          {rejectedProof || incomplete || contested ? ui.cmpHeadDefault : ui.cmpHead}
        </p>
        <div className="compare">
          <div>
            <div className="k">{ui.defaultK}</div>
            <div className="v">{data.comparison.defaultValue} tCO2e/t</div>
            {cmp && <div className="fine">{ui.forQ(fmt(q), fmt(dq))}</div>}
          </div>
          {!rejectedProof && !incomplete && !contested && (
            <div>
              <div className="k">{ui.verifiedK}</div>
              <div className="v">{cmp ? cmp.verifiedValue : (verifiedValue ?? "—")} tCO2e/t</div>
              {cmp && <div className="fine">{ui.forQ(fmt(q), fmt(vq))}</div>}
            </div>
          )}
        </div>
        {rejectedProof ? (
          <p className="fine no-verified-value" role="status">
            {ui.noValueFailed(rejectedCheck && rejectedCheck.index > 0 ? rejectedCheck.index : null)}
          </p>
        ) : incomplete ? (
          <p className="fine no-verified-value" role="status">
            {ui.noValueIncomplete}
          </p>
        ) : contested ? (
          <p className="fine no-verified-value" role="status">
            {ui.noGapContested}
          </p>
        ) : noComparison ? (
          <p className="fine no-verified-value" role="status">
            {ui.noGapFor}
            {zh ? (noComparisonZh(noComparison) ?? <span lang="en">{noComparison}</span>) : noComparison}
            {zh ? "。" : "."}
          </p>
        ) : (
          <>
            <p className="gap-line">{ui.gapLine(fmt(gap))}</p>
            <p className="fine">{ui.gapEur(fmt(eur, 0), data.comparison.quarter, data.comparison.priceEur)}</p>
            <p className="fine">{ui.notPhysical}</p>
          </>
        )}
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => setAccepted(true)}
            disabled={!result || result.overall !== "VALID"}
            lang={lang === "zh-TW" ? "en" : undefined}
          >
            Accept verified value
          </button>
          {!result && (
            <span className="fine">
              {ui.acceptFirst[0]}
              {ui.acceptFirst[1] && <span lang="en">{ui.acceptFirst[1]}</span>}
              {ui.acceptFirst[2]}
            </span>
          )}
        </div>
        {acceptedNow && (
          <p className="fine" role="status">
            {ui.accepted}
            {zh ? "" : " "}
            {cmp ? ui.declared(fmt(vq), batchId) : ui.verifiedFor(verifiedValue ?? "—", batchId)}
            {zh ? "" : " "}
            {ui.staysHere}
            {zh ? "" : " "}
            {claimTx && batchId === data.shipment.batchId ? <TxLink hash={claimTx.hash} /> : ui.notRecorded}
          </p>
        )}
        {acceptedNow && (
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={downloadRecord}>
              {ui.downloadRecord}
            </button>
            <span className="fine">{ui.recordNote}</span>
          </div>
        )}
        {acceptedNow && canExportPact && (
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={() => void downloadPact()} disabled={pactBusy}>
              {pactBusy ? ui.readingRecord : ui.downloadPact}
            </button>
            <span className="fine">{ui.pactNote}</span>
          </div>
        )}
        {pactError && (
          <p className="check-detail bad" role="alert">
            ✕ {pactError}
          </p>
        )}
        {!rejectedProof && !incomplete && !contested && cmp && <WhatIf key={`${cmp.verifiedValue}/${cmp.quantityTonnes}`} cmp={cmp} />}
        {result && checked && current && !running && (
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={() => setPrintReq((r) => ({ n: (r?.n ?? 0) + 1, at: current.at }))}>
              {ui.print}
            </button>
            <span className="fine">{ui.printNote}</span>
          </div>
        )}
        {printReq && result && checked && current && printReq.at === current.at && (
          <Suspense fallback={null}>
            <ImporterFile
              key={printReq.n}
              data={data}
              result={result}
              proof={checked}
              verifiedAt={current.at}
              cached={current.cached}
              pinnedBlock={current.cached ? (data.cached ? String(data.cached.block) : undefined) : result.atBlock?.toString()}
              claim={claimTx && batchId === data.shipment.batchId ? claimTx : undefined}
              explorer={explorer}
            />
          </Suspense>
        )}
      </section>

      <PrecursorBuyer />

      <CarbonPriceSection />

      <CheckSources checks={CHECKS} />
    </>
  );
}

export { CHECKS };
