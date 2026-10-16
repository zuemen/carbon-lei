// "Carbon price paid (CBAM Art 9)" section of the Buyer tab, under the precursor section. DRAFT RULES: the Commission's
// draft implementing act on CBAM Art 9 is not adopted; the section says so first. It reads
// demo/public/carbonprice-data.json, written by scripts/carbonprice-local.ts on a LOCAL anvil chain (not Sepolia): the
// mill's certified Taiwan carbon fee statement, the recorded check 10, the double-use attempts, and the exported
// evidence the browser re-checks off-chain (checkCarbonPriceOffline, root and exchange rate pinned in the page code).
// Every string has an English and a Traditional Chinese version.
import { useEffect, useState } from "react";
import type { CheckResult, Overall } from "../../../sdk/verify.ts";
import {
  DRAFT_LABEL,
  DRAFT_LABEL_ZH,
  PINNED_FX,
  checkCarbonPriceOffline,
  type CarbonPriceEvidence,
  type CarbonPriceOfflineItem,
  type CarbonPriceReport,
  type CarbonPriceStatement,
} from "../../../sdk/carbonprice.ts";
import { PRECURSOR_DEMO_TRUST_ANCHOR } from "../../../sdk/vlei.ts";
import { Badge, type BadgeKind } from "../components.tsx";
import { short } from "../data.ts";
import { useLang, useStrings } from "../i18n.ts";
import "../carbonprice.css";

export interface CarbonPriceData {
  version: 1;
  mode: "local";
  draft: string;
  draftRef: string;
  label: string;
  chainId: number;
  trustAnchor: string;
  entities: {
    mill: { name: string; lei: string; installation: { id: string; name: string } };
    screwMaker: { name: string; lei: string };
    secondScrewMaker: { name: string; lei: string };
    root: { name: string };
    qvi: { name: string; lei: string };
    nab: { name: string; lei: string };
    certifierBody: { name: string; lei: string; aid: string; accreditationNumber: string; cnScope: string[]; leSaid: string; accreditationSaid: string };
    certifierAuditor: { name: string; role: string; aid: string; ecrSaid: string };
  };
  statement: CarbonPriceStatement;
  evidence: CarbonPriceEvidence;
  statementKey: string;
  shipment: { quantityTonnes: string; see: string; obligationT: string };
  refPriceEur: string;
  refPriceNote: string;
  reductionCertificates: string;
  verification: { overall: Overall; primaryCode: string; checks: CheckResult[]; carbonPrice: CarbonPriceReport };
  doubleUse: {
    overClaim: { quantityTonnes: string; remainingKg: string; revert: { errorName: string; args: string[] } };
    reused: { overall: Overall; primaryCode: string };
  };
  sources: { what: string; url: string; accessed: string }[];
}

let cache: Promise<CarbonPriceData | null> | undefined;
/** The carbon price demo data, fetched once; null when the file is missing (the section then stays hidden). */
export function useCarbonPriceData(): CarbonPriceData | null {
  const [d, setD] = useState<CarbonPriceData | null>(null);
  useEffect(() => {
    cache ??= fetch(`${import.meta.env.BASE_URL}carbonprice-data.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<CarbonPriceData>) : null))
      .catch(() => null);
    let live = true;
    void cache.then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, []);
  return d;
}

const kindOf = (status: string): BadgeKind => (status === "pass" ? "pass" : status === "fail" ? "fail" : status === "warn" ? "review" : "skip");
const BADGE_ZH: Record<BadgeKind, string> = { pass: "✓ 通過", fail: "✕ 未通過", review: "! 需審查", idle: "· 尚未執行", skip: "– 未執行" };
const kgT = (kg: string) => {
  const n = BigInt(kg);
  const f = (n % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${n / 1000n}${f ? `.${f}` : ""}`;
};
const nf = (x: number, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

const T = {
  en: {
    kicker: "Carbon price paid (CBAM Art 9)",
    draftTitle: DRAFT_LABEL,
    draftText:
      "The rules applied here come from the Commission's working draft implementing act on the carbon price paid in a third country (Ref. Ares(2026)4841230, published 13 May 2026; feedback closed 10 June 2026). It is not adopted, it can still change, and no country's carbon price has been recognised under it. Taiwan's environment minister said the EU confirmed the carbon fee is deductible; we found no EU text that says so.",
    where:
      "Shown on a local anvil chain (chain ID 31337), not on Sepolia. The certifier and its lead auditor are fictional, with synthetic vLEI evidence under the same synthetic root as the precursor tier. The mill's emissions and output are invented; the Taiwan fee rules and the exchange rate are real (sources below).",
    title: (eur: string, ref: string) => `NT$300 × 0.2 → €${eur} per tonne emitted, against €${ref}`,
    lede:
      "Most screw makers emit far below Taiwan's 25,000 t threshold and pay no carbon fee. The wire-rod mill does: it is a high-leakage steel plant, so it pays on 20 % of its emissions. Under the draft, a certified carbon price paid on a precursor counts for the good made from it (Annex I, sections 6.2 and 6.3).",
    tableCaption: "From the Taiwan carbon fee to the CBAM certificates it removes (draft rules, illustrative)",
    cols: ["Step", "Calculation", "Result"],
    rows: {
      rate: "Fee rate (standard)",
      rateCalc: "Regulations Governing the Collection of Carbon Fees; preferential NT$100 or NT$50 with an approved reduction plan",
      paid: "Emissions the fee is charged on",
      paidCalc: (cpm: string, f: string) => `${cpm} t × factor ${f} (high carbon leakage, Art 6; K = 0, Art 5); the other 80 % count as a rebate (draft Art 8(1)(b))`,
      perT: "Per tonne of wire rod",
      perTCalc: (em: string, share: string) => `${em} tCO2e/t × ${share} × NT$300 (draft Annex I, eq. 12a)`,
      eur: "In euro",
      eurCalc: (fx: string) => `÷ ${fx} TWD per EUR (Eurostat 2025 annual average; the Commission's yearly rates are not published yet)`,
      screw: "Per tonne of screws",
      screwCalc: (m: string) => `× ${m} t of wire rod per t of screws (eq. 14a)`,
      cert: "Certificates removed",
      certCalc: (q: string, ref: string) => `× ${q} t ÷ €${ref} (draft Art 6(1))`,
    },
    of: (red: string, obl: string, pct: string) => `${red} of ${obl} certificates for this shipment: ${pct} %. The honest number is small.`,
    barLabel: (a: string, b: string, pct: string) => `€${a} paid per tonne emitted, €${b} per CBAM certificate: ${pct} %`,
    refNote: "€82.32 is the Q3 2026 CBAM certificate price, as a stand-in: the draft divides by the yearly average of the year of import, not yet known for 2026.",
    sensTitle: "The same tonne at other rates",
    sensCaption: "Euro paid per tonne emitted, by fee rate and emission adjustment factor, and as a share of €82.32 (2025 rate of 35.196 TWD per EUR)",
    sensCols: ["Rate", "Factor 0.2 (now)", "Factor 0.4 (next period)", "Factor 1 (not high-leakage)"],
    chainTitle: "Who certified it",
    chainLede:
      "The same trust model as the emissions value: the mill signs its statement with the address that claims its wire rod; an independent person, accredited for the draft's activity group LIV, has its lead auditor anchor the statement in their KEL; the certifier's body, on the same allowlist as the verification bodies, registers it in the same registry.",
    nodes: {
      root: "synthetic root (pinned in this page's code)",
      qvi: "issues the certifier's LE vLEI",
      body: (acc: string, cn: string) => `independent person · accredited for "Certification of the carbon price effectively paid" (${acc}), CN ${cn}`,
      auditor: (role: string) => `${role} (ECR vLEI) · anchors the statement's SAID in their KEL`,
      statement: (id: string) => `carbon price statement ${id} · signed by the mill, registered by the certifier`,
    },
    recorded: "Check 10 result recorded on the local chain when the data was built",
    doubleTitle: "The same statement cannot be used twice",
    doubleText: (over: string, rem: string, err: string, code: string) =>
      `The mill tries to claim ${over} t of wire rod against the statement, more than the ${rem} t it still covers: reverted with ${err}. The same statement shown for a maker it was never claimed for: INVALID (${code}).`,
    recheck: "Re-check the statement in this browser",
    rechecking: "Checking…",
    recheckNote:
      "Recomputed here from the exported evidence: the statement's SAID, the mill's signature, the lead auditor's KEL anchor and the certifier's vLEI chain (pinned to the synthetic root in the page code), and the price with the exchange rate pinned in the page code. Registration, revocation and the claim are on-chain facts of the local chain; they are not re-read here.",
    ok: "✓ holds",
    bad: "✕ fails",
    open: "– on-chain, not re-read",
    sources: "Sources (accessed 2026-10-16)",
  },
  "zh-TW": {
    kicker: "已付碳價（CBAM 第 9 條）",
    draftTitle: DRAFT_LABEL_ZH,
    draftText:
      "此處採用的規則出自歐盟執委會關於第三國已付碳價的執行法工作草案（Ref. Ares(2026)4841230，2026 年 5 月 13 日公布；意見徵詢已於 2026 年 6 月 10 日截止）。它尚未通過、仍可能修改，也還沒有任何國家的碳價依此獲得認可。台灣環境部長表示歐盟已確認碳費可以抵減；我們沒有找到任何如此表示的歐盟文件。",
    where:
      "於本機 anvil 鏈（chain ID 31337）上展示，不在 Sepolia。查證人及其主任查核員皆為虛構，其 vLEI 證據為合成資料，與前驅物層使用同一個合成根。線材廠的排放與產量是編造的；台灣碳費規則與匯率是真實的（來源見下方）。",
    title: (eur: string, ref: string) => `NT$300 × 0.2 → 每噸排放 €${eur}，對照 €${ref}`,
    lede:
      "多數螺絲廠的排放遠低於台灣 25,000 公噸的門檻，不必繳碳費。線材廠要繳：它屬於高碳洩漏風險的鋼鐵廠，只就排放量的 20% 繳費。依草案，前驅物已付且經查證的碳價，可計入以其製成的貨物（附件 I 第 6.2 與 6.3 節）。",
    tableCaption: "從台灣碳費到其抵減的 CBAM 憑證（草案規則，僅供示意）",
    cols: ["步驟", "計算", "結果"],
    rows: {
      rate: "費率（一般）",
      rateCalc: "碳費收費辦法；自主減量計畫核定者適用優惠費率 NT$100 或 NT$50",
      paid: "計費的排放量",
      paidCalc: (cpm: string, f: string) => `${cpm} t × 調整係數 ${f}（高碳洩漏，第 6 條；K = 0，第 5 條）；其餘 80% 視為補償（草案第 8(1)(b) 條）`,
      perT: "每噸線材",
      perTCalc: (em: string, share: string) => `${em} tCO2e/t × ${share} × NT$300（草案附件 I，公式 12a）`,
      eur: "換算歐元",
      eurCalc: (fx: string) => `÷ ${fx} TWD/EUR（Eurostat 2025 年平均；執委會的年度匯率尚未公布）`,
      screw: "每噸螺絲",
      screwCalc: (m: string) => `× 每噸螺絲 ${m} t 線材（公式 14a）`,
      cert: "抵減的憑證",
      certCalc: (q: string, ref: string) => `× ${q} t ÷ €${ref}（草案第 6(1) 條）`,
    },
    of: (red: string, obl: string, pct: string) => `這批貨 ${obl} 張憑證中抵減 ${red} 張：${pct}%。誠實的數字很小。`,
    barLabel: (a: string, b: string, pct: string) => `每噸排放已付 €${a}，每張 CBAM 憑證 €${b}：${pct}%`,
    refNote: "€82.32 是 2026 年第 3 季的 CBAM 憑證價格，暫作替代：草案除以進口年度的年平均價，2026 年的數值尚未確定。",
    sensTitle: "同一噸在其他費率下",
    sensCaption: "依費率與排放量調整係數，每噸排放所付歐元，以及占 €82.32 的比例（2025 年匯率 35.196 TWD/EUR）",
    sensCols: ["費率", "係數 0.2（現行）", "係數 0.4（下一期）", "係數 1（非高碳洩漏）"],
    chainTitle: "誰查證的",
    chainLede:
      "與排放值相同的信任模型：線材廠以申領其線材的同一地址簽署聲明；一位經認證、屬草案第 LIV 類活動的獨立查證人，由其主任查核員在 KEL 中錨定該聲明；查證人的機構與驗證機構在同一份允許清單上，並在同一登記合約中登記此聲明。",
    nodes: {
      root: "合成根（釘選在本頁程式碼中）",
      qvi: "簽發查證人的 LE vLEI",
      body: (acc: string, cn: string) => `獨立查證人 · 經認證從事「有效已付碳價之查證」（${acc}），CN ${cn}`,
      auditor: (role: string) => `${role}（ECR vLEI）· 在其 KEL 中錨定聲明的 SAID`,
      statement: (id: string) => `碳價聲明 ${id} · 由線材廠簽署、由查證人登記`,
    },
    recorded: "建置資料時在本機鏈上記錄的檢查 10 結果",
    doubleTitle: "同一份聲明不能用兩次",
    doubleText: (over: string, rem: string, err: string, code: string) =>
      `線材廠試圖以這份聲明申領 ${over} t 線材，超過它尚能涵蓋的 ${rem} t：以 ${err} 退回。同一份聲明若拿去給從未為其申領的螺絲廠使用：INVALID（${code}）。`,
    recheck: "在此瀏覽器重新檢查聲明",
    rechecking: "檢查中…",
    recheckNote:
      "由匯出的證據在此重新計算：聲明的 SAID、線材廠的簽章、主任查核員的 KEL 錨定與查證人的 vLEI 鏈（釘選本頁程式碼中的合成根），以及以本頁程式碼釘選之匯率計算的價格。登記、撤銷與申領是本機鏈上的鏈上事實，這裡不重新讀取。",
    ok: "✓ 成立",
    bad: "✕ 不成立",
    open: "– 鏈上事實，未重新讀取",
    sources: "來源（存取日期 2026-10-16）",
  },
};

/** Buyer tab: the draft Art 9 deduction of the demo screws, from the mill's certified Taiwan carbon fee statement. */
export function CarbonPriceSection() {
  const d = useCarbonPriceData();
  const t = useStrings(T);
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const [items, setItems] = useState<CarbonPriceOfflineItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const cp = d.verification.carbonPrice;
  const st = d.statement;
  const c10 = d.verification.checks.find((c) => c.index === 10);
  const fx = PINNED_FX.find((r) => r.currency === st.currency && r.year === st.fx.year);
  const perT = Number(cp.eurPerTCO2e);
  const ref = Number(d.refPriceEur);
  const pct = (perT / ref) * 100;
  const red = Number(d.reductionCertificates);
  const obl = Number(d.shipment.obligationT);
  const chargeable = Number(st.cpmEmissions) - Number(st.exemptEmissions);
  const line = d.verification.carbonPrice.target;
  const sens = [300, 100, 50].map((rate) => ({ rate, cells: [0.2, 0.4, 1].map((f) => (rate * f) / Number(fx?.unitsPerEur ?? st.fx.unitsPerEur)) }));

  async function recheck() {
    if (!d) return;
    setBusy(true);
    try {
      // The root and the exchange rate are pinned in the page code (sdk/vlei.ts, sdk/carbonprice.ts), never read from the data file.
      setItems(await checkCarbonPriceOffline(d.evidence, { trustAnchor: PRECURSOR_DEMO_TRUST_ANCHOR, fxTable: PINNED_FX, seeCap: line?.seeCap ?? null, massPerTonne: line?.massPerTonne }));
    } finally {
      setBusy(false);
    }
  }

  const e = d.entities;
  const nodes: { name: string; role: string; meta?: string }[] = [
    { name: e.root.name, role: t.nodes.root, meta: `AID ${short(PRECURSOR_DEMO_TRUST_ANCHOR, 8, 6)}` },
    { name: e.qvi.name, role: t.nodes.qvi, meta: `LEI ${e.qvi.lei}` },
    { name: e.certifierBody.name, role: t.nodes.body(e.certifierBody.accreditationNumber, e.certifierBody.cnScope.join(", ")), meta: `LEI ${e.certifierBody.lei} · LE ${short(e.certifierBody.leSaid, 8, 6)}` },
    { name: e.certifierAuditor.name, role: t.nodes.auditor(e.certifierAuditor.role), meta: `AID ${short(e.certifierAuditor.aid, 8, 6)} · ECR ${short(e.certifierAuditor.ecrSaid, 8, 6)}` },
    { name: e.mill.name, role: t.nodes.statement(st.certificationReportId), meta: `SAID ${short(st.d, 8, 6)} · LEI ${e.mill.lei}` },
  ];
  const r = d.doubleUse.overClaim;

  return (
    <section className="sheet reveal carbon-price" id="carbon-price" aria-labelledby="carbon-price-h" style={{ marginTop: 28 }}>
      <p className="sheet-kicker" id="carbon-price-h">
        {t.kicker}
      </p>
      <div className="cp-draft" role="note" data-testid="cp-draft">
        <strong>{t.draftTitle}</strong>
        <p>{t.draftText}</p>
      </div>
      <p className="precursor-where" role="note" data-testid="cp-where">
        {t.where}
      </p>
      <h3>{t.title(nf(perT), d.refPriceEur)}</h3>
      <p className="fine">{t.lede}</p>

      <div className="pc-scroll">
        <table className="pc-table cp-table">
          <caption className="sr-only">{t.tableCaption}</caption>
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
            <tr>
              <th scope="row">{t.rows.rate}</th>
              <td>{t.rows.rateCalc}</td>
              <td className="num">NT${st.ratePerTonne} / tCO2e</td>
            </tr>
            <tr>
              <th scope="row">{t.rows.paid}</th>
              <td>{t.rows.paidCalc(Number(st.cpmEmissions).toLocaleString("en-US"), st.adjustment?.factor ?? "—")}</td>
              <td className="num">{chargeable.toLocaleString("en-US")} t</td>
            </tr>
            <tr>
              <th scope="row">{t.rows.perT}</th>
              <td>{t.rows.perTCalc(st.emissionsPerTonne, cp.paidShare ?? "—")}</td>
              <td className="num">NT${cp.localPerTonne}</td>
            </tr>
            <tr>
              <th scope="row">{t.rows.eur}</th>
              <td>{t.rows.eurCalc(fx?.unitsPerEur ?? "—")}</td>
              <td className="num">€{cp.eurPerTonne}</td>
            </tr>
            <tr>
              <th scope="row">{t.rows.screw}</th>
              <td>{t.rows.screwCalc(line?.massPerTonne ?? "—")}</td>
              <td className="num">€{cp.deductibleEurPerTonneGood}</td>
            </tr>
            <tr className="pc-total">
              <th scope="row">{t.rows.cert}</th>
              <td>{t.rows.certCalc(d.shipment.quantityTonnes, d.refPriceEur)}</td>
              <td className="num">{d.reductionCertificates}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="fine" data-testid="cp-of">
        <strong>{t.of(d.reductionCertificates, nf(obl, 0), nf((red / obl) * 100))}</strong>
      </p>
      <div className="cp-bar" aria-hidden="true">
        <span className="cp-bar-paid" style={{ width: `${Math.max(pct, 0.8)}%` }} />
      </div>
      <p className="fine">{t.barLabel(nf(perT), d.refPriceEur, nf(pct))}</p>
      <p className="fine">{t.refNote}</p>

      <h4 className="cp-h4">{t.sensTitle}</h4>
      <div className="pc-scroll">
        <table className="pc-table">
          <caption className="sr-only">{t.sensCaption}</caption>
          <thead>
            <tr>
              {t.sensCols.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sens.map((s) => (
              <tr key={s.rate}>
                <th scope="row">NT${s.rate}</th>
                {s.cells.map((v, i) => (
                  <td key={i} className="num">
                    €{nf(v)} · {nf((v / ref) * 100, 1)}%
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">{t.sensCaption}.</p>

      <h4 className="cp-h4">{t.chainTitle}</h4>
      <p className="fine">{t.chainLede}</p>
      <ol className="chain" aria-label={t.chainTitle}>
        {nodes.map((n, i) => (
          <li key={n.name} className="node">
            <span className="node-dot" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <div className="node-name">{n.name}</div>
              <div className="node-role">{n.role}</div>
            </div>
            <span />
            {n.meta && <div className="node-meta">{n.meta}</div>}
          </li>
        ))}
      </ol>

      <div className="pc-result">
        <p className="fine">
          <strong>{t.recorded}:</strong> <Badge kind={kindOf(c10?.status ?? "skipped")}>{zh ? BADGE_ZH[kindOf(c10?.status ?? "skipped")] : undefined}</Badge>{" "}
          {c10?.code ? <code>{c10.code}</code> : null} <span lang={zh ? "en" : undefined}>{c10?.detail}</span>
        </p>
      </div>

      <div className="attack cp-attack" data-testid="cp-double-use">
        <div>
          <h4 className="cp-h4">{t.doubleTitle}</h4>
          <p className="fine">{t.doubleText(r.quantityTonnes, kgT(r.remainingKg), r.revert.errorName, d.doubleUse.reused.primaryCode)}</p>
        </div>
      </div>

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={() => void recheck()} disabled={busy}>
          {busy ? t.rechecking : t.recheck}
        </button>
      </div>
      <p className="fine">{t.recheckNote}</p>
      <div role="status" aria-live="polite">
        {items && (
          <ul className="pc-items" aria-label={t.recheck}>
            {items.map((i) => (
              <li key={i.id} data-ok={String(i.ok)}>
                <span className={i.ok === true ? "pc-ok" : i.ok === false ? "pc-bad" : "pc-open"}>{i.ok === true ? t.ok : i.ok === false ? t.bad : t.open}</span>{" "}
                <span lang={zh ? "en" : undefined}>{i.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h4 className="cp-h4">{t.sources}</h4>
      <ul className="cp-sources">
        {d.sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.what}
            </a>
          </li>
        ))}
      </ul>
      <p className="fine">
        <span lang={zh ? "en" : undefined}>{d.label}</span>
      </p>
    </section>
  );
}
