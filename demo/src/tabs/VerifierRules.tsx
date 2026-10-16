// Check 8's sub-rules on the verification report (sdk/verification-rules.ts): the list shown under check 8 on the
// Buyer tab, the "Verifier legitimacy" panel of the Trust chain tab, and attack card 6 (a report dated before
// verifiers could issue). Every result comes from the SDK functions the CLI uses; nothing is computed here.
import { useState } from "react";
import { hashString } from "../../../sdk/commitment.ts";
import { checkReconciliation, pickReconciledClaims, reconcile, type ReportExtract } from "../../../sdk/consistency.ts";
import { decodeDisclosure } from "../../../sdk/disclosure.ts";
import { FIRST_REPORT_DATE, type AccreditationRegistry, type SubRule } from "../../../sdk/verification-rules.ts";
import registryJson from "../../../fixtures/accreditation-registry.json";
import { useApp } from "../App.tsx";
import { useLang, type Lang } from "../i18n.ts";
import "../verifier-rules.css";

/** The allowlist operator's accreditation records (fictional demo body; the Commission list status is real). */
export const ACCREDITATION_REGISTRY = registryJson as AccreditationRegistry;

const LABEL: Record<string, { en: string; "zh-TW": string }> = {
  "first-report-date": { en: `Not dated before verifiers could issue reports (${FIRST_REPORT_DATE})`, "zh-TW": `報告日期不早於驗證機構可簽發報告之日（${FIRST_REPORT_DATE}）` },
  "report-after-period": { en: "Dated after the reporting period ended", "zh-TW": "報告日期晚於報告期間結束" },
  "accreditation-at-report-date": { en: "Accreditation valid on the report date", "zh-TW": "報告日期當天認證仍有效" },
  "site-visit": { en: "Site visit (physical in the first verified period)", "zh-TW": "現場查訪（首個查證期間須實地查訪）" },
  "allowlist-record": { en: "Operator's accreditation record for this body", "zh-TW": "名單營運者對此機構的認證紀錄" },
  "record-matches-report": { en: "Record matches the report's accreditation", "zh-TW": "紀錄與報告中的認證相符" },
  "record-credential": { en: "Record names the allowlist's accreditation credential", "zh-TW": "紀錄所指的認證憑證與鏈上名單相同" },
  "nab-member-state": { en: "Accreditation body in an EU Member State", "zh-TW": "認證機構位於歐盟會員國" },
  standard: { en: "Accredited to EN ISO/IEC 17029", "zh-TW": "依 EN ISO/IEC 17029 認證" },
  scope: { en: "CN code and activity group in scope", "zh-TW": "CN 碼與活動群組在認證範圍內" },
  "valid-at-report": { en: "Recorded accreditation valid on the report date", "zh-TW": "紀錄中的認證於報告日期有效" },
  "commission-list": { en: "Commission list of accredited CBAM verifiers", "zh-TW": "執委會的 CBAM 認證驗證機構名單" },
};

const MARK: Record<SubRule["status"], { sym: string; en: string; "zh-TW": string }> = {
  pass: { sym: "✓", en: "passed", "zh-TW": "通過" },
  fail: { sym: "✕", en: "failed", "zh-TW": "未通過" },
  warn: { sym: "!", en: "needs review", "zh-TW": "需審查" },
  note: { sym: "i", en: "note", "zh-TW": "說明" },
};

const T = {
  en: {
    heading: "Rules on the report itself",
    signedNote: "A rule fails only when the report extract is the one the auditor signed; otherwise it is advisory.",
  },
  "zh-TW": {
    heading: "針對報告本身的規則",
    signedNote: "只有當報告摘錄正是查核員所簽署者時，規則才會判定未通過；否則僅供參考。",
  },
} satisfies Record<Lang, unknown>;

/** The sub-rules of a check, listed under it (Buyer tab, check 8). */
export function SubRules({ rules, compact = false }: { rules: SubRule[]; compact?: boolean }) {
  const { lang } = useLang();
  return (
    <div className="subrules">
      {!compact && <p className="subrules-head">{T[lang].heading}</p>}
      <ul aria-label={T[lang].heading}>
        {rules.map((s) => (
          <li key={s.rule} className={`subrule ${s.status}`} data-rule={s.rule}>
            <span className="subrule-mark" aria-hidden="true">
              {MARK[s.status].sym}
            </span>
            <span className="sr-only">{MARK[s.status][lang]}: </span>
            <span className="subrule-label">{LABEL[s.rule]?.[lang] ?? s.rule}</span>
            {s.code && <code className="subrule-code">{s.code}</code>}
            <span className="subrule-detail">{s.detail}</span>
          </li>
        ))}
      </ul>
      {!compact && <p className="fine">{T[lang].signedNote}</p>}
    </div>
  );
}

/** Fields of a proof's disclosures, by name. */
function disclosedFields(disclosures: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of disclosures) {
    try {
      const { name, value } = decodeDisclosure(d);
      out[name] = value;
    } catch {
      // a malformed disclosure is check 2's to report
    }
  }
  return out;
}

const PANEL = {
  en: {
    kicker: "Verifier legitimacy",
    lede: "Who accredited the verification body that signed this report, recorded by the allowlist operator next to the on-chain entry, and checked against the report.",
    body: "Verification body",
    acc: "Accreditation number",
    nab: "Accreditation body",
    standard: "Standard",
    scope: "Scope",
    validity: "Valid",
    measures: "Suspensions or withdrawals",
    none: "none recorded",
    link: "Allowlist link",
    report: (id: string, at: string) => `Report ${id}, dated ${at}`,
    listHead: "Commission list not yet published",
    list: (checked: string) =>
      `As of ${checked} the Commission had not published its list of accredited CBAM verifiers ("will be published on this page"). The record relies on the accreditation body's own register. As of 13 October 2026, five verification bodies were documented as accredited, all established in the EU. Accredited verifiers can issue the first CBAM verification reports from January 2027.`,
    trust:
      "The record is operator data, not signed by the accreditation body: a difference makes check 8 ask for review, never pass. The accreditation body's signed part is the accreditation credential that check 7 verifies.",
    sources: "Sources",
  },
  "zh-TW": {
    kicker: "驗證機構的正當性",
    lede: "簽署此報告的驗證機構由誰認證：由名單營運者記錄在鏈上名單旁，並與報告比對。",
    body: "驗證機構",
    acc: "認證編號",
    nab: "認證機構",
    standard: "標準",
    scope: "範圍",
    validity: "有效期間",
    measures: "暫停或撤銷",
    none: "無紀錄",
    link: "鏈上名單連結",
    report: (id: string, at: string) => `報告 ${id}，日期 ${at}`,
    listHead: "執委會名單尚未公布",
    list: (checked: string) =>
      `截至 ${checked}，歐盟執委會尚未公布 CBAM 認證驗證機構名單（「將於本頁公布」）。此紀錄依據認證機構自己的登錄。截至 2026 年 10 月 13 日，有五家驗證機構被記載為已獲認證，全部設立於歐盟。認證驗證機構自 2027 年 1 月起才能簽發首批 CBAM 驗證報告。`,
    trust: "此紀錄是營運者的資料，並非由認證機構簽署：若有差異，檢查 8 會要求人工審查，而不會判定通過。認證機構簽署的部分是檢查 7 所驗證的認證憑證。",
    sources: "資料來源",
  },
} satisfies Record<Lang, unknown>;

/** Trust chain tab: the accreditation provenance of the demo body and the sub-rules run on the demo report. */
export function VerifierLegitimacy() {
  const { data } = useApp();
  const { lang } = useLang();
  const t = PANEL[lang];
  const reg = ACCREDITATION_REGISTRY;
  const body = data.trustChain.find((n) => n.id === "body");
  const rec = reg.records.find((r) => r.verifierLEI === body?.lei) ?? reg.records[0];
  const extract = data.proof.reportExtract as ReportExtract | undefined;
  const fields = disclosedFields(data.proof.disclosures);
  // Check 8 as on the Buyer tab, with the signed reconciliation of the demo credential: the sub-rules on the
  // report and the provenance rules on the operator's record. No chain read: the allowlist link is the hash of the
  // accreditation credential's SAID from the exported evidence.
  let rules: SubRule[] = [];
  if (extract) {
    let signed;
    try {
      signed = (JSON.parse(data.proof.core) as { reconciliation?: Parameters<typeof checkReconciliation>[2] }).reconciliation;
    } catch {
      signed = undefined;
    }
    rules =
      checkReconciliation(extract, fields, signed, [], {
        registry: reg,
        verifierLEI: body?.lei ?? "",
        ...(body?.credentialSaid ? { accreditationSaidHash: hashString(body.credentialSaid) } : {}),
      }).rules ?? [];
  }
  return (
    <section className="sheet reveal verifier-legitimacy" aria-labelledby="verifier-legitimacy-h">
      <p className="sheet-kicker" id="verifier-legitimacy-h">
        {t.kicker}
      </p>
      <p className="fine">{t.lede}</p>
      <dl className="vl-grid">
        <dt>{t.body}</dt>
        <dd>
          {rec.verifierName} · {rec.countryOfEstablishment} · LEI {rec.verifierLEI}
        </dd>
        <dt>{t.acc}</dt>
        <dd>{rec.accreditationNumber}</dd>
        <dt>{t.nab}</dt>
        <dd>
          {rec.nab.name} · {rec.nab.country}
          {rec.nab.lei ? ` · LEI ${rec.nab.lei}` : ""}
        </dd>
        <dt>{t.standard}</dt>
        <dd>{rec.standards.join(" + ")}</dd>
        <dt>{t.scope}</dt>
        <dd>
          CN {rec.cnScope.join(", ")} · activity group {rec.activityGroups.join(", ")} (Delegated Reg. (EU) 2025/2551 Annex I)
        </dd>
        <dt>{t.validity}</dt>
        <dd>
          {rec.validFrom} → {rec.validUntil}
        </dd>
        <dt>{t.measures}</dt>
        <dd>{rec.administrativeMeasures.length ? rec.administrativeMeasures.map((m) => `${m.type} ${m.from}–${m.until ?? ""}`).join("; ") : t.none}</dd>
        <dt>{t.link}</dt>
        <dd>
          <code>{rec.accreditationSaidHash ? `${rec.accreditationSaidHash.slice(0, 10)}…` : "—"}</code> = hash(accreditation credential SAID)
        </dd>
      </dl>
      {extract && <p className="subrules-head">{t.report(extract.reportId, extract.signedAt)}</p>}
      <SubRules rules={rules} compact />
      <div className="vl-advisory" role="note">
        <strong>{t.listHead}.</strong> {t.list(reg.commissionList.checkedAt)}
      </div>
      <p className="fine">{t.trust}</p>
      <p className="fine">
        {t.sources}:{" "}
        <a href="https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en">European Commission, CBAM verification</a>{" "}
        ·{" "}
        <a href="https://taxation-customs.ec.europa.eu/document/download/030fe146-38e5-46b8-82b5-5f72da089a7b_en">
          Guidance on CBAM verification and accreditation (24 Aug 2026)
        </a>{" "}
        · <a href="https://cbamguide.com/compliance/verification/">cbamguide.com (accredited bodies, 13 Oct 2026)</a> (accessed 2026-10-16)
      </p>
    </section>
  );
}

/** The date the attack card puts on the report: inside calendar 2026, before verifiers could issue reports. */
export const EARLY_DATE = "2026-12-15";

/**
 * Attack card 6: a "verification statement" dated 15 December 2026 for calendar 2026. The reconciliation is
 * recomputed as if the auditor had signed that date (in the browser; nothing is signed with a real key or
 * registered), then check 8 runs exactly as on the Buyer tab.
 */
export function ReportDateAttack() {
  const { data } = useApp();
  const [out, setOut] = useState<{ status: string; code: string; detail: string; rules: SubRule[] } | null>(null);
  function run() {
    const extract = data.proof.reportExtract as ReportExtract | undefined;
    const fields = disclosedFields(data.proof.disclosures);
    const claims = pickReconciledClaims(fields);
    if (!extract || !claims) {
      setOut({ status: "skipped", code: "", detail: "the demo proof has no report extract", rules: [] });
      return;
    }
    const early = { ...extract, signedAt: EARLY_DATE };
    const r = checkReconciliation(early, fields, reconcile(early, claims).reconciliation);
    setOut({ status: r.status, code: r.code, detail: r.detail, rules: r.rules ?? [] });
  }
  return (
    <div className="attack" id="attack-6">
      <div>
        <h3>6 · A verification report dated before verifiers could issue</h3>
        <div className="how">Checked in your browser — check 8's rules, no contract call</div>
        <p className="fine">
          A "verification statement" for calendar 2026 dated {EARLY_DATE}: before the reporting period ended and before
          January 2027, when accredited verifiers could first issue CBAM verification reports. We recompute the
          reconciliation hashes as if the auditor had signed this date (nothing is signed with a real key or registered)
          and run check 8.
        </p>
      </div>
      <button className="btn" onClick={run}>
        Date the report {EARLY_DATE}
      </button>
      {out && (
        <div className="attack-result" role="status">
          <span className={`stamp ${out.status === "fail" ? "red" : ""}`}>{out.status === "fail" ? "Rejected" : "Not caught"}</span>
          <p>
            {out.status === "fail" ? (
              <>
                Check 8 failed: <code>{out.code}</code> — {out.detail}
              </>
            ) : (
              `Check 8 did not fail (${out.status}) — please report this.`
            )}
          </p>
          {out.rules.length > 0 && <SubRules rules={out.rules} compact />}
        </div>
      )}
    </div>
  );
}
