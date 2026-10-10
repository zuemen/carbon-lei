import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { selectDisclosures, type Presentation } from "../../../sdk/disclosure.ts";
import { decodeDisclosure } from "../../../sdk/disclosure.ts";
import { DEMO_DISCLOSURE } from "../../../sdk/issue.ts";
import { REQUIRED_DISCLOSURES } from "../../../sdk/credential.ts";
import { scrollBelowTabbar, useApp } from "../App.tsx";
import { fmt, TabHead, TxLink } from "../components.tsx";
import { kgToT } from "../messages.ts";
import { short } from "../data.ts";
import { useLang, type Lang } from "../i18n.ts";
// The template panel renders when opened; the importer and the spreadsheet reader load only when a file is read.
import { TemplateImport } from "./TemplateImport.tsx";

const LABELS: Record<string, string> = {
  supplierLEI: "Supplier LEI",
  operatorId: "Operator ID",
  installationId: "Installation ID",
  installationName: "Installation name",
  unLocode: "UN/LOCODE",
  cnCode: "CN code",
  cbamRoute: "Production route code",
  productionRoute: "Process route",
  reportingPeriod: "Reporting period",
  verifiedTonnes: "Verified quantity (t)",
  specificEmbeddedEmissions_tCO2e_per_t: "Emissions intensity (tCO2e/t)",
  valueType: "Value type",
  methodologyNote: "Methodology note",
  verificationReportId: "Verification report ID",
  verifierLEI: "Verification body LEI",
  accreditationNumber: "Accreditation number",
  nabName: "Accreditation body",
  siteVisit: "Site visit",
  assuranceLevel: "Assurance level",
  materialityThreshold: "Materiality threshold",
  energyMix: "Energy mix",
  supplierCost: "Supplier cost",
  idSalt: "Identity salt",
  batchSalt: "Batch salt",
  issuedAt: "Issued at",
  validUntil: "Valid until",
};

/** Field labels in Traditional Chinese (Taiwan). The template panel keeps the English LABELS (it is not translated). */
const LABELS_ZH: Record<string, string> = {
  supplierLEI: "供應商 LEI",
  operatorId: "營運者 ID",
  installationId: "設施 ID",
  installationName: "設施名稱",
  unLocode: "UN/LOCODE",
  cnCode: "CN 代碼",
  cbamRoute: "生產路徑代碼",
  productionRoute: "製程路徑",
  reportingPeriod: "報告期間",
  verifiedTonnes: "經驗證數量（噸）",
  specificEmbeddedEmissions_tCO2e_per_t: "排放強度（tCO2e/t）",
  valueType: "數值類型",
  methodologyNote: "方法學說明",
  verificationReportId: "驗證報告 ID",
  verifierLEI: "驗證機構 LEI",
  accreditationNumber: "認證編號",
  nabName: "認證機構",
  siteVisit: "現場訪查",
  assuranceLevel: "保證等級",
  materialityThreshold: "重大性門檻",
  energyMix: "能源組合",
  supplierCost: "供應商成本",
  idSalt: "身分鹽值",
  batchSalt: "批次鹽值",
  issuedAt: "簽發時間",
  validUntil: "有效期限",
};

const TXT = {
  en: {
    labels: LABELS,
    title: "Claim a shipment against the report",
    lede: "The supplier — here a fictional screw maker in Kaohsiung — claims part of its verified tonnage for one importer, then chooses what that importer may see.",
    tryTemplate: "Try your own Communication Template (.xlsx)",
    tryTemplateNote: "Read in this browser, nothing uploaded; then sign it with a demo key and see which checks refuse it.",
    report: "Report",
    batchId: "Batch ID",
    quantity: "Quantity (t)",
    importer: "Importer",
    preClaimed: "Pre-claimed in this demo; editable in local mode.",
    ledger: "Verified tonnage ledger",
    pctClaimed: (pct: number) => `${pct}% of the verified tonnes claimed`,
    revoked: "Remaining 0 t — this report was revoked",
    replaced: "Remaining 0 t — replaced by a revised report",
    verified: (t: string) => `Verified ${t} t`,
    claimed: (t: string) => `Claimed ${t} t`,
    remaining: (t: string) => `Remaining ${t} t`,
    claimedFor: (q: string, batch: string, importer: string) => `Claimed ${q} t for batch ${batch} → ${importer} — `,
    viewTx: "view transaction",
    hashOnly: "On-chain, the importer appears only as a hash commitment.",
    choose: "Choose what the importer can see",
    required: " (required)",
    create: "Create the supplier's proof",
    useInBuyer: "Use this proof in the Buyer tab →",
    proofSummary: (n: number) => `Supplier's proof (JSON) — ${n} fields disclosed`,
    passport: "Product passport card (demo) — a data carrier a product passport could reference · not an ESPR passport",
    verifiedIntensity: "Verified intensity",
    illustrative: "illustrative",
    bodyLei: "Verification body LEI",
    status: "Status",
    valid: "✓ Valid",
    revokedShort: "✕ Revoked",
    replacedShort: "✕ Replaced",
    credential: "Credential",
    qrAlt: "QR code: scan to verify on the hosted page",
    scan: "Scan to verify",
    desktop: "On a desktop?",
    openHere: "Open the same link here",
    passportNote: (t: string, period: string) =>
      `${t} t verified for ${period}. We do not claim conformance with ESPR or with any digital product passport specification.`,
    templateSummary: "Start from the Commission's Communication Template (official example)",
  },
  "zh-TW": {
    labels: LABELS_ZH,
    title: "依據報告申領一批出貨",
    lede: "供應商（此處為一家虛構的高雄螺絲製造商）為一家進口商申領其部分經驗證噸數，再選擇該進口商可以看到哪些資料。",
    tryTemplate: "試用您自己的通報範本（Communication Template，.xlsx）",
    tryTemplateNote: "只在此瀏覽器內讀取，不會上傳任何資料；接著以示範金鑰簽署，看看哪些檢查會拒絕它。",
    report: "報告",
    batchId: "批次編號",
    quantity: "數量（噸）",
    importer: "進口商",
    preClaimed: "本示範已預先申領；在本機模式中可編輯。",
    ledger: "經驗證噸數帳本",
    pctClaimed: (pct: number) => `經驗證噸數已申領 ${pct}%`,
    revoked: "剩餘 0 噸——此報告已被撤銷",
    replaced: "剩餘 0 噸——已由修訂後的報告取代",
    verified: (t: string) => `經驗證 ${t} 噸`,
    claimed: (t: string) => `已申領 ${t} 噸`,
    remaining: (t: string) => `剩餘 ${t} 噸`,
    claimedFor: (q: string, batch: string, importer: string) => `已為批次 ${batch} 申領 ${q} 噸 → ${importer} —— `,
    viewTx: "查看交易",
    hashOnly: "在鏈上，進口商只以雜湊承諾（hash commitment）呈現。",
    choose: "選擇進口商可以看到的內容",
    required: "（必須揭露）",
    create: "建立供應商的證明",
    useInBuyer: "在買方分頁使用此證明 →",
    proofSummary: (n: number) => `供應商的證明（JSON）—— 已揭露 ${n} 個欄位`,
    passport: "產品護照卡（示範）—— 產品護照可引用的資料載體 · 並非 ESPR 產品護照",
    verifiedIntensity: "經驗證強度",
    illustrative: "示意",
    bodyLei: "驗證機構 LEI",
    status: "狀態",
    valid: "✓ 有效",
    revokedShort: "✕ 已撤銷",
    replacedShort: "✕ 已取代",
    credential: "憑證",
    qrAlt: "QR 碼：掃描後在線上頁面驗證",
    scan: "掃描以驗證",
    desktop: "使用桌上型電腦？",
    openHere: "在此開啟相同連結",
    passportNote: (t: string, period: string) =>
      `${period} 經驗證 ${t} 噸。我們不聲稱符合 ESPR 或任何數位產品護照規範。`,
    templateSummary: "從歐盟執委會的通報範本開始（官方範例；面板內容僅有英文）",
  },
} satisfies Record<Lang, unknown>;

export function Supplier() {
  const { lang } = useLang();
  const t = TXT[lang];
  const { data, reader, offline, setProofText, go } = useApp();
  const allNames = useMemo(() => Object.keys(data.credential.disclosures), [data]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(DEMO_DISCLOSURE));
  const [proof, setProof] = useState<Presentation | null>(null);
  const [qr, setQr] = useState("");
  const [remaining, setRemaining] = useState<bigint | null>(null);
  const [state, setState] = useState<"valid" | "revoked" | "replaced" | "unknown">("unknown");
  const [templateOpen, setTemplateOpen] = useState(false);
  const templateRef = useRef<HTMLDetailsElement>(null);

  /** The button at the top of the tab: opens the template panel below and moves focus to it. */
  function openTemplate() {
    const d = templateRef.current;
    if (!d) return;
    d.open = true;
    setTemplateOpen(true);
    scrollBelowTabbar(d);
    d.querySelector("summary")?.focus({ preventScroll: true });
  }

  const verifiedKg = BigInt(Math.round(Number(data.report.verifiedTonnes) * 1000));
  const claimTx = data.txs.find((t) => t.step === "claim1");
  const passportUrl = `https://zuemen.github.io/carbon-lei/#buyer?said=${encodeURIComponent(JSON.parse(data.credential.coreJson).d)}&batch=${encodeURIComponent(data.shipment.batchId)}`;

  useEffect(() => {
    if (offline && data.cached) {
      setRemaining(BigInt(data.cached.remainingKg));
      setState(data.cached.reportValid ? "valid" : "unknown");
      return;
    }
    if (!reader) return;
    let live = true;
    (async () => {
      const [rem, rep, valid] = await Promise.all([
        reader.remainingKg(data.credential.reportKey),
        reader.report(data.credential.reportKey),
        reader.isValidAt(data.credential.reportKey, await reader.latestTimestamp()),
      ]);
      if (!live) return;
      setRemaining(rem);
      setState(rep.revokedAt !== 0n ? "revoked" : rep.supersededBy !== `0x${"0".repeat(64)}` ? "replaced" : valid ? "valid" : "unknown");
    })().catch(() => setState("unknown"));
    return () => {
      live = false;
    };
  }, [reader, offline, data]);

  useEffect(() => {
    QRCode.toDataURL(passportUrl, { margin: 1, width: 264, color: { dark: "#1e2420", light: "#fffdf8" } }).then(setQr, () => setQr(""));
  }, [passportUrl]);

  const claimed = remaining === null ? null : verifiedKg - remaining;
  const pct = claimed === null ? 0 : Number((claimed * 1000n) / verifiedKg) / 10;

  function create() {
    const names = allNames.filter((n) => chosen.has(n));
    const p: Presentation = {
      core: data.credential.coreJson,
      signature: data.credential.signature,
      disclosures: selectDisclosures(data.credential.disclosures, names),
      shipment: data.shipment,
      ...(data.proof.anchorEvidence ? { anchorEvidence: data.proof.anchorEvidence } : {}),
      ...(data.proof.authorityEvidence ? { authorityEvidence: data.proof.authorityEvidence } : {}),
      ...(data.proof.reportExtract ? { reportExtract: data.proof.reportExtract } : {}),
    };
    setProof(p);
  }

  return (
    <>
      <TabHead title={t.title} lede={t.lede}>
        <div className="btn-row own-template-entry">
          <button className="btn btn-ghost" aria-controls="template-import" aria-expanded={templateOpen} onClick={openTemplate}>
            {t.tryTemplate}
          </button>
          <span className="fine">{t.tryTemplateNote}</span>
        </div>
      </TabHead>
      <div className="grid-2">
        <section className="sheet reveal" aria-labelledby="claim-h">
          <p className="sheet-kicker" id="claim-h">
            {t.report} {data.report.reportId} · {data.report.installationName}
          </p>
          <dl className="fields">
            <dt>{t.batchId}</dt>
            <dd>{data.shipment.batchId}</dd>
            <dt>{t.quantity}</dt>
            <dd>{data.shipment.quantityTonnes}</dd>
            <dt>{t.importer}</dt>
            <dd>{data.importer.name}</dd>
          </dl>
          <p className="fine">{t.preClaimed}</p>
          <div className="tonnage" role="group" aria-label={t.ledger}>
            <div className="tonnage-bar" role="img" aria-label={t.pctClaimed(pct)}>
              <div className="tonnage-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="tonnage-legend">
              {state === "revoked" ? (
                <span>{t.revoked}</span>
              ) : state === "replaced" ? (
                <span>{t.replaced}</span>
              ) : (
                <>
                  <span>{t.verified(data.report.verifiedTonnes)}</span>
                  <span>{t.claimed(claimed === null ? "…" : kgToT(claimed))}</span>
                  <span>{t.remaining(remaining === null ? "…" : kgToT(remaining))}</span>
                </>
              )}
            </div>
          </div>
          {claimTx && (
            <p className="fine">
              {t.claimedFor(data.shipment.quantityTonnes, data.shipment.batchId, data.importer.name)}
              <TxLink hash={claimTx.hash} label={t.viewTx} />
              <br />
              {t.hashOnly}
            </p>
          )}
        </section>

        <section className="sheet reveal" aria-labelledby="disc-h">
          <p className="sheet-kicker" id="disc-h">
            {t.choose}
          </p>
          <ul className="checkbox-list">
            {allNames.map((n) => {
              const required = (REQUIRED_DISCLOSURES as readonly string[]).includes(n);
              return (
                <li key={n}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(n)}
                      disabled={required}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(n);
                        else next.delete(n);
                        setChosen(next);
                        setProof(null);
                      }}
                    />
                    <span>
                      {t.labels[n] ?? n}
                      {required ? t.required : ""}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={create}>
              {t.create}
            </button>
            {proof && (
              <button
                className="btn"
                onClick={() => {
                  setProofText(JSON.stringify(proof, null, 2), true);
                  go("buyer");
                }}
              >
                {t.useInBuyer}
              </button>
            )}
          </div>
          {proof && (
            <details style={{ marginTop: 12 }}>
              <summary>{t.proofSummary(proof.disclosures.length)}</summary>
              <pre>{JSON.stringify(proof, null, 2)}</pre>
            </details>
          )}
        </section>
      </div>

      <section className="sheet reveal" aria-labelledby="pp-h" style={{ marginTop: 28 }}>
        <p className="sheet-kicker" id="pp-h">
          {t.passport}
        </p>
        <div className="passport">
          <dl className="fields">
            <dt>CN</dt>
            <dd>{data.report.cnCode}</dd>
            <dt>{t.verifiedIntensity}</dt>
            <dd>
              {data.report.intensity} tCO2e/t <span className="tag-illustrative">{t.illustrative}</span>
            </dd>
            <dt>{t.bodyLei}</dt>
            <dd>{decodeDisclosure(data.credential.disclosures.verifierLEI).value}</dd>
            <dt>{t.status}</dt>
            <dd>{state === "valid" ? t.valid : state === "revoked" ? t.revokedShort : state === "replaced" ? t.replacedShort : "…"}</dd>
            <dt>{t.credential}</dt>
            <dd>{short(JSON.parse(data.credential.coreJson).d, 10, 6)}</dd>
          </dl>
          <div>
            {qr && <img src={qr} alt={t.qrAlt} />}
            <p className="fine" style={{ textAlign: "center", margin: "4px 0 0" }}>
              {t.scan}
            </p>
            <p className="fine" style={{ textAlign: "center", margin: "2px 0 0" }}>
              {t.desktop} <a href={passportUrl.slice(passportUrl.indexOf("#"))}>{t.openHere}</a>
            </p>
          </div>
        </div>
        <p className="fine">
          {t.passportNote(fmt(Number(data.report.verifiedTonnes)), data.report.reportingPeriod)}
        </p>
      </section>

      <details
        ref={templateRef}
        id="template-import"
        className="sheet pvv"
        onToggle={(e) => setTemplateOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>{t.templateSummary}</summary>
        {templateOpen && <TemplateImport labels={LABELS} />}
      </details>
    </>
  );
}
