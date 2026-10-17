import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Presentation } from "../../../sdk/disclosure.ts";
import type { VerificationResult } from "../../../sdk/verify.ts";
import type { DemoData } from "../data.ts";
import { useLang, type Lang } from "../i18n.ts";
import { codeText } from "../messages.ts";
import { CHECK_NAME_ZH } from "../zh-details.ts";

/**
 * The file's strings in English and Traditional Chinese (Taiwan). Codes, hashes, addresses, block numbers and the
 * contract names stay as they are; in Chinese, a check detail the SDK wrote in English is marked lang="en".
 */
const T = {
  en: {
    overall: {
      VALID: "Verified: every check that applies passed",
      INVALID: "Rejected: a check failed",
      CONTESTED: "Needs review by a person",
      INCOMPLETE: "Not verified: checks that decide validity were not run",
    } as Record<string, string>,
    status: { pass: "Passed", fail: "Failed", skipped: "Not run", warn: "Warning" } as Record<string, string>,
    title: "Importer's file: CarbonLEI verification (demo)",
    notice:
      "Fictional demo data: every company, LEI and EORI is fictional. Generated in the browser from the checks on the CarbonLEI demo page; not signed. Not a filing to the CBAM Registry and not a CBAM declaration; it does not replace any document the rules require. Emissions values are gross and illustrative, not CBAM methodology. This is our assessment, not a regulatory position.",
    result: "Result",
    firstFailure: (code: string) => ` (first failure: ${code})`,
    recorded: "Recorded",
    verified: "Verified",
    offline: " (offline view: the recorded result; no check was re-run)",
    credential: "Credential ID (SAID)",
    batch: "Shipment batch",
    batchLine: (id: string, t: string, date: string) => `${id}, ${t} t, shipped ${date}`,
    noBatch: "— (no shipment in this proof)",
    eori: "Importer EORI",
    fictional: " (fictional)",
    network: "Network",
    networkLine: (name: string, id: number) => `${name} (chain ID ${id}), a test network`,
    pinned: "Chain reads pinned to",
    pinnedBlock: (b: string) => `block ${b}`,
    notPinned: "— (checks 4–8 did not read the chain)",
    reportKey: "Report key",
    contracts: "Contracts",
    claim: "On-chain claim",
    claimBlock: (b: number, t: string) => `, block ${b}, ${t}`,
    noClaim: "— (not recorded for this proof)",
    checks: "Checks",
    cols: ["#", "Check", "Result", "Detail"],
    scope:
      "These checks cover who signed the value, their authority (up to this demo's simulated root of trust) and the tonnage claim. They do not show that the emissions figure itself is correct, and they do not replace the verification report or the CBAM Registry.",
  },
  "zh-TW": {
    overall: {
      VALID: "已驗證：所有適用的檢查皆通過",
      INVALID: "已拒絕：有檢查未通過",
      CONTESTED: "需由人員審查",
      INCOMPLETE: "未驗證：決定有效性的檢查未執行",
    } as Record<string, string>,
    status: { pass: "通過", fail: "未通過", skipped: "未執行", warn: "警告" } as Record<string, string>,
    title: "進口商檔案：CarbonLEI 驗證（示範）",
    notice:
      "虛構的示範資料：所有公司、LEI 與 EORI 皆為虛構。由瀏覽器依 CarbonLEI 示範頁面上的檢查產生；未簽署。這不是向 CBAM 登錄系統提交的文件，也不是 CBAM 申報；不能取代法規要求的任何文件。排放數值為毛額、僅供示意，並非 CBAM 方法學。這是我們的評估，不是主管機關的立場。",
    result: "結果",
    firstFailure: (code: string) => `（第一個失敗：${code}）`,
    recorded: "記錄時間",
    verified: "驗證時間",
    offline: "（離線檢視：記錄的結果；未重新執行任何檢查）",
    credential: "憑證 ID（SAID）",
    batch: "出貨批次",
    batchLine: (id: string, t: string, date: string) => `${id}，${t} t，出貨日 ${date}`,
    noBatch: "—（此證明不含出貨）",
    eori: "進口商 EORI",
    fictional: "（虛構）",
    network: "網路",
    networkLine: (name: string, id: number) => `${name}（chain ID ${id}），測試網路`,
    pinned: "鏈上讀取固定於",
    pinnedBlock: (b: string) => `區塊 ${b}`,
    notPinned: "—（檢查 4–8 未讀取鏈上資料）",
    reportKey: "報告鍵值（report key）",
    contracts: "合約",
    claim: "鏈上申領",
    claimBlock: (b: number, t: string) => `，區塊 ${b}，${t}`,
    noClaim: "—（此證明沒有記錄）",
    checks: "檢查",
    cols: ["#", "檢查", "結果", "說明"],
    scope:
      "這些檢查涵蓋誰簽署了數值、其權限（直到本示範模擬的信任根為止）以及噸數申領。它們不能證明排放數字本身正確，也不能取代驗證報告或 CBAM 登錄系統（CBAM Registry）。",
  },
} satisfies Record<Lang, unknown>;

export interface ImporterFileProps {
  data: DemoData;
  result: VerificationResult;
  proof: Presentation;
  /** When this result was produced; for the offline view, when the cached result was recorded. */
  verifiedAt: string;
  cached: boolean;
  /** The block the chain reads were pinned to (for the offline view, the block of the recorded snapshot). */
  pinnedBlock?: string;
  claim?: { hash: string; block: number; time: string };
  explorer: (kind: "tx" | "address", value: string) => string | null;
}

/**
 * A one-page, printable copy of this page's checks for the importer's own file. It is rendered outside the app and
 * shown only while printing; mounting it opens the browser's print dialog (print, or save as PDF).
 * Built from the verification result on screen; not signed.
 */
export default function ImporterFile({ data, result, proof, verifiedAt, cached, pinnedBlock, claim, explorer }: ImporterFileProps) {
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const t = T[lang];
  // One print dialog per mount, also when development mode runs the effect twice.
  const printed = useRef(false);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("printing-file");
    const done = () => root.classList.remove("printing-file");
    window.addEventListener("afterprint", done, { once: true });
    if (!printed.current) {
      printed.current = true;
      window.print();
    }
    return () => {
      window.removeEventListener("afterprint", done);
      done();
    };
  }, []);

  let credSAID = "";
  try {
    credSAID = (JSON.parse(proof.core) as { d: string }).d;
  } catch {
    // a malformed proof: the checks below report it
  }
  const registry = data.deployment.contracts.EmissionsClaimRegistry.address;
  const allowlist = data.deployment.contracts.VerifierAllowlist.address;
  const claimUrl = claim ? explorer("tx", claim.hash) : null;
  const regUrl = explorer("address", registry);

  return createPortal(
    <div className="importer-file" data-testid="importer-file">
      <h1>{t.title}</h1>
      <p className="if-notice">{t.notice}</p>
      <table className="if-table">
        <tbody>
          <tr>
            <th scope="row">{t.result}</th>
            <td>
              {result.overall} — {t.overall[result.overall] ?? result.overall}
              {result.primaryCode ? t.firstFailure(result.primaryCode) : ""}
            </td>
          </tr>
          <tr>
            <th scope="row">{cached ? t.recorded : t.verified}</th>
            <td>{verifiedAt}{cached ? t.offline : ""}</td>
          </tr>
          <tr>
            <th scope="row">{t.credential}</th>
            <td><code>{credSAID || "—"}</code></td>
          </tr>
          <tr>
            <th scope="row">{t.batch}</th>
            <td>{proof.shipment?.batchId ? t.batchLine(proof.shipment.batchId, proof.shipment.quantityTonnes, proof.shipment.shipmentDate) : t.noBatch}</td>
          </tr>
          <tr>
            <th scope="row">{t.eori}</th>
            <td>{data.importer.eori}{t.fictional}</td>
          </tr>
          <tr>
            <th scope="row">{t.network}</th>
            <td>{t.networkLine(data.network.name, data.network.chainId)}</td>
          </tr>
          <tr>
            <th scope="row">{t.pinned}</th>
            <td>{pinnedBlock ? t.pinnedBlock(pinnedBlock) : t.notPinned}</td>
          </tr>
          <tr>
            <th scope="row">{t.reportKey}</th>
            <td><code>{result.onchain?.reportKey ?? "—"}</code></td>
          </tr>
          <tr>
            <th scope="row">{t.contracts}</th>
            <td>
              EmissionsClaimRegistry <code>{registry}</code>
              {regUrl ? ` (${regUrl})` : ""}
              <br />
              VerifierAllowlist <code>{allowlist}</code>
            </td>
          </tr>
          <tr>
            <th scope="row">{t.claim}</th>
            <td>
              {claim ? (
                <>
                  <code>{claim.hash}</code>
                  {t.claimBlock(claim.block, claim.time)}
                  {claimUrl ? (
                    <>
                      <br />
                      Etherscan: {claimUrl}
                    </>
                  ) : null}
                </>
              ) : (
                t.noClaim
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <h2>{t.checks}</h2>
      <table className="if-table if-checks">
        <thead>
          <tr>
            {t.cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.checks.map((c) => {
            // In Chinese: the code's translated text when there is one, else the SDK's English detail, marked as English.
            const zhText = zh ? codeText(c.code, true) : undefined;
            return (
              <tr key={c.index}>
                <td>{c.index}</td>
                <td>{zh ? (CHECK_NAME_ZH[c.index] ?? <span lang="en">{c.name}</span>) : c.name}</td>
                <td>{t.status[c.status] ?? c.status}</td>
                <td>
                  {c.code ? <code>{c.code}</code> : null}
                  {c.code && (zhText ?? c.detail) ? (zh ? "——" : " — ") : ""}
                  {zh ? (zhText ?? (c.detail ? <span lang="en">{c.detail}</span> : null)) : c.detail}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="if-notice">{t.scope}</p>
    </div>,
    document.body,
  );
}
