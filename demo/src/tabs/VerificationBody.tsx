import { useState } from "react";
import { domainOf } from "../../../sdk/eip712.ts";
import { useApp } from "../App.tsx";
import { TabHead, TxLink } from "../components.tsx";
import { revertText } from "../messages.ts";
import { useLang, type Lang } from "../i18n.ts";

/** The tab's strings in English and Traditional Chinese (Taiwan); field values, IDs and codes stay as they are. */
const T = {
  en: {
    needsLive: "Needs a live connection to Sepolia.",
    dryRejected: (why: string, err: string) => `Dry run: the contract would reject this — ${why} (${err}). Nothing was written on-chain.`,
    dryAccepted: "Dry run: the contract would accept this revocation from the issuing verification body. Nothing was written on-chain.",
    title: "Issue a verified emissions report",
    lede: "The verification body issues the report here. To check a report, use the Buyer tab.",
    timeline:
      "Demo timeline: the report covers calendar year 2026 (goods imported in 2026 use the 2026 reporting period), so the verification report and the credential are dated March 2027, before the declaration deadline of 30 September 2027. The Sepolia transactions were recorded in October 2026 to build this demo.",
    reportKicker: "Pre-filled demo report (fictional)",
    installation: "Installation",
    cn: "CN code",
    period: "Reporting period",
    quantity: "Verified quantity (t)",
    intensity: "Specific direct embedded emissions (tCO2e/t)",
    illustrative: "illustrative",
    reportId: "Verification report ID",
    accreditation: "Accreditation number",
    stepsKicker: "These steps were run once to set up this demo",
    localMode: "Local mode lets you run them yourself.",
    signed: "✓ Signed (EIP-712) —",
    viewSignature: "view signature",
    anchored: (seq: string) => `✓ Anchored in the auditor's signed history (KERI event #${seq}) —`,
    viewEvent: "view event",
    notExported: "event evidence not exported yet",
    registered: "✓ Registered on Sepolia —",
    viewTx: "view transaction",
    notRecorded: "not recorded",
    revoke: "Revoke report (dry run — shows the contract's response, no key)",
  },
  "zh-TW": {
    needsLive: "需要即時連線到 Sepolia。",
    dryRejected: (why: string, err: string) => `試算結果：合約會拒絕——${why}（${err}）。鏈上沒有寫入任何資料。`,
    dryAccepted: "試算結果：簽發此報告的驗證機構提出撤銷，合約會接受。鏈上沒有寫入任何資料。",
    title: "簽發經查證的排放報告",
    lede: "驗證機構在這裡簽發報告。要檢查報告，請到買方分頁。",
    timeline:
      "示範時間軸：報告涵蓋 2026 曆年（2026 年進口的貨物適用 2026 報告期間），所以查證報告與憑證的日期是 2027 年 3 月，早於 2027 年 9 月 30 日的申報截止日。這些 Sepolia 交易是 2026 年 10 月為了建置本示範而記錄的。",
    reportKicker: "預先填好的示範報告（虛構）",
    installation: "設施",
    cn: "CN 碼",
    period: "報告期間",
    quantity: "經查證數量（t）",
    intensity: "特定直接內含排放（tCO2e/t）",
    illustrative: "示意",
    reportId: "查證報告編號",
    accreditation: "認證編號",
    stepsKicker: "以下步驟已在建置本示範時執行過一次",
    localMode: "本機模式可以讓您自己執行。",
    signed: "✓ 已簽署（EIP-712）——",
    viewSignature: "查看簽章",
    anchored: (seq: string) => `✓ 已錨定在查核員的簽署歷史中（KERI 事件 #${seq}）——`,
    viewEvent: "查看事件",
    notExported: "事件證據尚未匯出",
    registered: "✓ 已在 Sepolia 登記——",
    viewTx: "查看交易",
    notRecorded: "未記錄",
    revoke: "撤銷報告（試算：顯示合約的回應，不需金鑰）",
  },
} satisfies Record<Lang, unknown>;

export function VerificationBody() {
  const { data, reader, offline } = useApp();
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const t = T[lang];
  // The result is kept as data and worded when shown, so switching the language re-renders it.
  const [dry, setDry] = useState<{ needsLive: true } | { errorName: string; args: readonly unknown[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const reg = data.txs.find((t) => t.step === "registerReport1");
  const core = JSON.parse(data.credential.coreJson);
  const domain = domainOf(data.deployment.contracts.EmissionsClaimRegistry.address, data.network.chainId);

  async function dryRevoke() {
    if (!reader || offline) {
      setDry({ needsLive: true });
      return;
    }
    setBusy(true);
    const r = await reader.dryRun("revokeReport", [data.credential.reportKey], data.addresses.body);
    setBusy(false);
    setDry(r.reverted ? { errorName: r.errorName, args: r.args } : { errorName: "", args: [] });
  }
  const dryText = !dry
    ? ""
    : "needsLive" in dry
      ? t.needsLive
      : dry.errorName
        ? t.dryRejected(revertText(dry.errorName, dry.args, zh), dry.errorName)
        : t.dryAccepted;

  return (
    <>
      <TabHead title={t.title} lede={t.lede}>
        <p className="fine">{t.timeline}</p>
      </TabHead>
      <div className="grid-2">
        <section className="sheet reveal" aria-labelledby="rep-h">
          <p className="sheet-kicker" id="rep-h">
            {t.reportKicker}
          </p>
          <dl className="fields">
            <dt>{t.installation}</dt>
            <dd>
              {data.report.installationName} · {data.report.installationId}
            </dd>
            <dt>{t.cn}</dt>
            <dd>{data.report.cnCode}</dd>
            <dt>{t.period}</dt>
            <dd>{data.report.reportingPeriod}</dd>
            <dt>{t.quantity}</dt>
            <dd>{data.report.verifiedTonnes}</dd>
            <dt>{t.intensity}</dt>
            <dd>
              {data.report.intensity} <span className="tag-illustrative">{t.illustrative}</span>
            </dd>
            <dt>{t.reportId}</dt>
            <dd>{data.report.reportId}</dd>
            <dt>{t.accreditation}</dt>
            <dd>{data.report.accreditationNumber}</dd>
          </dl>
        </section>

        <section className="sheet reveal" aria-labelledby="steps-h">
          <p className="sheet-kicker" id="steps-h">
            {t.stepsKicker}
          </p>
          <p className="fine">{t.localMode}</p>
          <ul className="done-steps">
            <li>
              {t.signed}
              {zh ? "" : " "}
              <details style={{ display: "inline-block" }}>
                <summary>{t.viewSignature}</summary>
                <pre>
                  {JSON.stringify(
                    { domain, credSAID: core.d, signer: core.issuer.verifierAddress, signature: data.credential.signature },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </li>
            <li>
              {t.anchored(String(data.credential.kelSeq))}
              {zh ? "" : " "}
              {data.evidence.anchor ? (
                <a href={`${import.meta.env.BASE_URL}${data.evidence.anchor}`}>{t.viewEvent}</a>
              ) : (
                <span className="fine">{t.notExported}</span>
              )}
            </li>
            <li>
              {t.registered}
              {zh ? "" : " "}
              {reg ? <TxLink hash={reg.hash} label={t.viewTx} /> : t.notRecorded}
            </li>
          </ul>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={dryRevoke}>
              {t.revoke}
            </button>
          </div>
          {dryText && (
            <p className="fine" role="status">
              {dryText}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
