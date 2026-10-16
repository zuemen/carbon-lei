// Buyer tab, collapsed panel at the bottom: where each of the eight checks gets its data. The check list and
// the source labels come from the Buyer tab's own CHECKS list and SourceLabel, so the table cannot drift from
// the labels shown next to each check. English and Traditional Chinese.
import { useApp } from "../App.tsx";
import { SourceLabel, type Source } from "../components.tsx";
import { useLang } from "../i18n.ts";
import { CHECK_TEXT_ZH } from "./Buyer.tsx";

export interface CheckRow {
  n: number;
  text: string;
  source: Source;
}

/** The first clause of a check's text (before a parenthesis or a dash), used as its name in the table. */
const shortText = (text: string) => text.split(/ \(| — |（|——/)[0];

const T = {
  en: {
    summary: "Where each check gets its data",
    lede: "The source label shown next to each check above, and what it means for that check. In the offline view, the Sepolia reads are a cached result.",
    caption: "Data source of each of the eight checks",
    cols: ["Check", "Data source", "What that means"],
    meaning: (exportDate: string): Record<number, string> => ({
      1: "Recomputed from the proof on this page: the credential's content hash must equal its ID. Nothing is fetched.",
      2: "Each disclosed field is hashed on this page and matched to a digest in the signed credential. Hidden fields stay hidden.",
      3: "The signature is recovered on this page and must match the verification body named in the credential. Only the chain ID comes from the Sepolia node; the body's on-chain registration is read in check 4.",
      4: "Contract state read from Sepolia when you press Verify, all at one block. The auditor's authority was checked by the contract when the report was registered; it is not recomputed now.",
      5: "The shared tonnage ledger on Sepolia, read when you press Verify: the claim for this batch, its quantity and the importer it was declared to.",
      6: `The signature on the auditor's key event is re-checked on this page from the exported event (${exportDate}). Witnesses are not queried.`,
      7: `The vLEI credential chain is read from evidence exported on ${exportDate} and checked up to this page's pinned root. Witnesses are not queried. Check 7 also reads the allowlist on Sepolia (when the auditor was added and revoked, and when the body's accreditation ends) and judges authority at the report's registration time, as check 4 does.`,
      8: "A rule-based comparison of the report with the signed credential, on this page. A mismatch flags the proof for human review. Its sub-rules on the report itself (report date, site visit, accreditation on the report date, the operator's accreditation record) fail the check only when the auditor-signed report breaks a CBAM rule.",
    }),
  },
  "zh-TW": {
    summary: "每項檢查的資料從哪裡來",
    lede: "上方每項檢查旁的來源標籤，以及它對該檢查的意義。在離線檢視中，讀取 Sepolia 的部分是快取的結果。",
    caption: "八項檢查各自的資料來源",
    cols: ["檢查", "資料來源", "代表什麼"],
    meaning: (exportDate: string): Record<number, string> => ({
      1: "在本頁由證明重新計算：憑證的內容雜湊必須等於其 ID。不擷取任何資料。",
      2: "每個已揭露欄位都在本頁計算雜湊，並與已簽署憑證中的摘要比對。隱藏的欄位仍保持隱藏。",
      3: "在本頁還原簽章，且必須符合憑證中所指名的驗證機構。只有 chain ID 來自 Sepolia 節點；驗證機構的鏈上登記由檢查 4 讀取。",
      4: "按下 Verify 時從 Sepolia 讀取的合約狀態，全部在同一個區塊。查核員的權限在報告登記時已由合約檢查，現在不重新計算。",
      5: "按下 Verify 時讀取的 Sepolia 共享噸數帳本：此批次的申領、其數量，以及它所申報給的進口商。",
      6: `查核員金鑰事件上的簽章，在本頁依匯出的事件（${exportDate}）重新檢查。未查詢見證者（witnesses）。`,
      7: `vLEI 憑證鏈讀自 ${exportDate} 匯出的證據，並一路檢查到本頁釘選的根。未查詢見證者（witnesses）。檢查 7 也會讀取 Sepolia 上的允許清單（查核員何時加入與撤銷，以及驗證機構的認證何時到期），並與檢查 4 一樣，以報告登記時的時間判斷權限。`,
      8: "在本頁以規則比對報告與已簽署的憑證。不一致時會將證明標示為需人工審查。針對報告本身的子規則（報告日期、現場訪視、報告日期當時的認證、營運者的認證紀錄），只有在查核員簽署的報告違反 CBAM 規則時，才會使此檢查判定為失敗。",
    }),
  },
};

export function CheckSources({ checks }: { checks: CheckRow[] }) {
  const { data } = useApp();
  const { lang } = useLang();
  const t = T[lang];
  // What each check's source means for that check. Keyed by check number; the source itself is read from `checks`.
  const meaning = t.meaning(data.exportDate);
  const name = (c: CheckRow) => shortText(lang === "zh-TW" ? (CHECK_TEXT_ZH[c.n] ?? c.text) : c.text);
  return (
    <details className="sheet check-sources" id="check-sources">
      <summary>{t.summary}</summary>
      <p className="check-sources-lede">{t.lede}</p>
      <table className="ledger check-sources-table">
        <caption className="sr-only">{t.caption}</caption>
        <thead>
          <tr>
            {t.cols.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.n} data-source={c.source}>
              <td data-label={t.cols[0]}>
                {c.n}. {name(c)}
              </td>
              <td data-label={t.cols[1]}>
                <SourceLabel source={c.source} />
              </td>
              <td data-label={t.cols[2]}>{meaning[c.n] ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
