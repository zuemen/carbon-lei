// Traditional Chinese (Taiwan) versions of the SDK's English detail strings that the precursor and carbon price
// sections show: check 9 and check 10 as recorded, and the items of the in-browser re-checks. Each function
// rebuilds the sentence from the result's own values (taken from the structured report, or read back out of the
// English detail it replaces) and returns null for a case it does not know; the page then shows the English
// detail, marked lang="en". Codes, hashes, LEIs and units stay as they are.
import type { CarbonPriceOfflineItem, CarbonPriceReport } from "../../sdk/carbonprice.ts";
import { DRAFT_LABEL_ZH } from "../../sdk/carbonprice.ts";
import type { OfflineItem, PrecursorReport } from "../../sdk/precursor.ts";
import type { CheckResult } from "../../sdk/verify.ts";

/** Check 9 as recorded, when it passed. */
export function precursorCheckZh(c: CheckResult | undefined, p: PrecursorReport): string | null {
  if (!c || c.status !== "pass" || c.code) return null;
  const verified = p.lines.filter((l) => l.source !== "default").length;
  const defaults = p.lines.length - verified;
  return (
    `重新計算 ${p.attributedDirect} + ${p.precursorTotal} = ${p.recomputed} tCO2e/t，申報 ${p.declared}，差距在 ${p.tolerance} 以內；` +
    `${verified} 份經查證的前驅物憑證，皆已在共享帳本上為此製造商申領` +
    (defaults ? `；${defaults} 行採用預設值` : "")
  );
}

/** One item of the precursor re-check (sdk/precursor.ts checkPrecursorsOffline). */
export function precursorItemZh(i: OfflineItem): string | null {
  const d = i.detail;
  const kind = i.id.replace(/^line\d+:/, "");
  let m: RegExpExecArray | null;
  switch (kind) {
    case "digest":
      return i.ok ? "聲明的摘要與已簽署憑證核心中的摘要相符" : "聲明的摘要與已簽署的憑證核心不符";
    case "default":
      return (m = /^precursor default used for CN (\S+): (\S+) tCO2e\/t$/.exec(d)) ? `CN ${m[1]} 採用前驅物預設值：${m[2]} tCO2e/t` : null;
    case "proof":
      return "未提出生產者的證明";
    case "checks0-3":
      return i.ok ? "生產者的證明：結構、SAID、揭露欄位及其驗證機構的簽章（檢查 0–3）" : null;
    case "bound":
      return (m = /^the producer's proof is for credential (\S+) and batch (\S+)$/.exec(d)) ? `生產者的證明對應憑證 ${m[1]} 與批次 ${m[2]}` : null;
    case "anchor":
      return i.ok ? "生產者的主任查核員已在其 KEL 中錨定該憑證（已檢查簽章）" : null;
    case "authority":
      return i.ok && (m = /\(LEI (\S+)\) to the pinned root, accredited for CN (\S+)$/.exec(d))
        ? `生產者驗證機構的 vLEI 鏈（LEI ${m[1]}）通往釘選的根，並獲認證涵蓋 CN ${m[2]}`
        : null;
    case "scope":
      return (m = /^CN (\S+) \(statement: (\S+)\), period (\S+) \(good: (\S+)\)$/.exec(d)) ? `CN ${m[1]}（聲明：${m[2]}），期間 ${m[3]}（貨物：${m[4]}）` : null;
    case "onchain":
      return "登記、登記區塊當時的授權、撤銷與為此製造商的申領：屬鏈上事實，此處不重新讀取";
    case "balance":
      if ((m = /^(.+) = (\S+) tCO2e\/t recomputed, (\S+) declared \(tolerance (\S+)\)$/.exec(d))) return `重新計算 ${m[1]} = ${m[2]} tCO2e/t，申報 ${m[3]}（容許誤差 ${m[4]}）`;
      return i.ok === null ? "重新計算所需的數值缺漏" : null;
    default:
      return null;
  }
}

/** Check 10 as recorded: a pass, or the advisory warnings the demo statement can carry (FX_YEAR, CAPPED). */
export function carbonPriceCheckZh(c: CheckResult | undefined, r: CarbonPriceReport): string | null {
  if (!c || !r.deductibleEurPerTonneGood || (c.status !== "pass" && c.status !== "warn")) return null;
  const warns: string[] = [];
  if (c.status === "warn") {
    for (const part of c.detail.split("; ")) {
      let m: RegExpExecArray | null;
      if ((m = /the (\d{4}) average rate is used for a (\d{4}) period/.exec(part))) {
        warns.push(`${m[2]} 年的期間採用 ${m[1]} 年的平均匯率；草案要求採用報告期間所屬年度的匯率（第 5(1) 條），該匯率尚未公布`);
      } else if ((m = /^paid emissions (\S+) tCO2e\/t capped at the credential's embedded emissions (\S+) tCO2e\/t$/.exec(part))) {
        warns.push(`已付排放 ${m[1]} tCO2e/t 以憑證的隱含排放 ${m[2]} tCO2e/t 為上限`);
      }
    }
    const expected = (c.code.includes("FX_YEAR") ? 1 : 0) + (c.code.includes("CAPPED") ? 1 : 0);
    if (!warns.length || warns.length < expected) return null;
  }
  const mechanism = r.currency === "TWD" ? "台灣碳費（TW）" : r.mechanism;
  const pass =
    `${mechanism}：${r.ratePerTonne} ${r.currency}/tCO2e，計費比例 ${r.paidShare} → 每噸排放 €${r.eurPerTCO2e}，每噸 CN ${r.target?.cnCode} €${r.eurPerTonne}；` +
    `申報貨物每噸 €${r.deductibleEurPerTonneGood}；由 ${r.certifier?.name ?? "—"} 查證；以此聲明申領 ${r.claim?.claimedTonnes ?? "?"} t（所需 ${r.claim?.neededTonnes ?? "?"} t）`;
  return `［${DRAFT_LABEL_ZH}］${warns.length ? `${warns.join("；")}；` : ""}${pass}`;
}

/** One item of the carbon price re-check (sdk/carbonprice.ts checkCarbonPriceOffline). */
export function carbonPriceItemZh(i: CarbonPriceOfflineItem): string | null {
  const d = i.detail;
  let m: RegExpExecArray | null;
  switch (i.id) {
    case "said":
      return i.ok ? ((m = /SAID (\S+) matches its content$/.exec(d)) ? `聲明的 SAID ${m[1]} 與其內容相符` : null) : "聲明的 SAID 與其內容不符";
    case "operator":
      return i.ok
        ? (m = /with address (0x[0-9a-fA-F]{40})/.exec(d))
          ? `營運者以地址 ${m[1]} 簽署了 SAID（該地址是否為與聲明一同登記的供應商，以及憑證本身，於鏈上檢查）`
          : null
        : "無法讀取營運者的簽章";
    case "anchor":
      if (!i.ok || !/^the certification lead auditor anchored the statement in their KEL \(Ed25519 signature verified with the key from the auditor's inception event(; the auditor's AID has no witnesses)?\)$/.test(d)) return null;
      return `查證的主任查核員已在其 KEL 中錨定該聲明（已以查核員起始事件中的金鑰驗證 Ed25519 簽章${/has no witnesses/.test(d) ? "；查核員的 AID 沒有見證者（witnesses）" : ""}）`;
    case "authority":
      return i.ok && (m = /\(LEI (\S+)\) to the pinned root: root → QVI → certifier body \(LE vLEI\) → lead auditor \(ECR, [^)]*\); accredited by the NAB for "Certification of the carbon price effectively paid [^"]*", CN (\S+); each issuance signed in its issuer's KEL/.exec(d))
        ? `獨立查證人的 vLEI 鏈（LEI ${m[1]}）通往釘選的根：根 → QVI → 查證機構（LE vLEI）→ 主任查核員（ECR）；由 NAB 認證從事「有效已付碳價之查證」（CBAM 活動類別 LIV，執行法草案；示範），CN ${m[2]}；每次簽發皆簽署於其簽發者的 KEL${/every event with its witness threshold of receipts/.test(d) ? "，每個事件都附有達到門檻的見證者收據" : ""}`
        : null;
    case "price": {
      if (!i.ok) return null;
      const ch = /chargeable emissions = \((\S+) − K (\S+)\) × (\S+) = (\S+) t; exempt = (\S+) t/.exec(d);
      const local = /= (\S+) (\S+) per t of good \(eq\. 12a\)/.exec(d);
      const eur = /÷ (\S+) (\S+)\/EUR = €(\S+) per t of good/.exec(d);
      if (!ch || !local || !eur) return null;
      return (
        `應計費排放 =（${ch[1]} − K ${ch[2]}）× ${ch[3]} = ${ch[4]} t；免計 ${ch[5]} t（公式 5a、6a）；` +
        `每噸貨物 ${local[1]} ${local[2]}（公式 12a）；÷ ${eur[1]} ${eur[2]}/EUR = 每噸貨物 €${eur[3]}（公式 15a；Eurostat 2025 年平均匯率，本頁程式碼釘選）`
      );
    }
    case "stated":
      if ((m = /^€(\S+) per t stated, €(\S+) recomputed at the pinned rate(?: → €(\S+) per t of the declared good \(× (\S+) t\/t\))?$/.exec(d))) {
        return `聲明每噸 €${m[1]}，以釘選匯率重新計算為 €${m[2]}${m[3] ? ` → 申報貨物每噸 €${m[3]}（× ${m[4]} t/t）` : ""}`;
      }
      return null;
    case "onchain":
      return "由允許清單上的查證人登記、撤銷、取代與為此製造商的申領：屬鏈上事實，此處不重新讀取";
    default:
      return null;
  }
}

/**
 * The carbon price sources in Traditional Chinese, keyed by a fragment of their URL. `title` is a title or
 * publisher kept in its original language (shown with its own lang); `text` is the explanation, translated.
 */
export const CP_SOURCES_ZH: { match: string; title?: { text: string; lang: string }; text: string }[] = [
  { match: "14830-Carbon-border-adjustment-mechanism", title: { text: "CBAM Art 9 draft implementing regulation", lang: "en" }, text: "（公式：附件 I 公式 1–17，第 5、6、8、9、16 條，附件 II–IV）" },
  { match: "cbamguide.com", text: "狀態：2026 年 5 月 13 日的工作草案，意見徵詢期為 2026 年 5 月 13 日至 6 月 10 日，截至 2026 年 10 月 12 日尚未通過" },
  { match: "moenv.gov.tw", title: { text: "碳費收費辦法", lang: "zh-Hant-TW" }, text: "：碳費 =（排放量 − K）× 調整係數 × 費率；K 為 25,000 t（高碳洩漏風險者為 0）；係數 0.2／0.4／0.6" },
  { match: "taipeitimes.com", title: { text: "Taipei Times", lang: "en" }, text: "：首次繳費（2026 年 5 月，2025 年排放）新台幣 49.7 億元；一般費率 NT$300/t；優惠費率 NT$50 與 NT$100；29 家鋼鐵廠共新台幣 4 億元" },
  { match: "e-info.org.tw", title: { text: "環境資訊中心", lang: "zh-Hant-TW" }, text: "：224 家高碳洩漏風險廠以排放量 × 0.2 計費；下一期為 0.4" },
  { match: "ert_bil_eur_a", title: { text: "Eurostat ert_bil_eur_a", lang: "en" }, text: "：2025 年 EUR/TWD 年平均匯率 = 35.196（資料集 2026-07-08 更新）" },
];

/** The SDK's short check names (sdk/verify.ts NAMES) in Traditional Chinese: the importer's file and the self-issued proof. */
export const CHECK_NAME_ZH: Record<number, string> = {
  0: "結構",
  1: "憑證完整性（SAID）",
  2: "揭露欄位",
  3: "簽發者簽章",
  4: "鏈上報告",
  5: "出貨申領",
  6: "查核員錨定（KEL）",
  7: "授權鏈（vLEI）",
  8: "報告比對",
  9: "前驅物",
  10: "已付碳價（第 9 條草案）",
};
