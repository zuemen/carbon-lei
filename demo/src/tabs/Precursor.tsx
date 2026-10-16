// "Precursor (wire rod)" sections of the Buyer, Trust chain and Try-to-break-it tabs. They read
// demo/public/precursor-data.json, written by scripts/precursor-local.ts on a LOCAL anvil chain (not Sepolia):
// the recorded check 9 result, and the exported evidence the browser re-checks off-chain (checkPrecursorsOffline).
// Every string has an English and a Traditional Chinese version.
import { useEffect, useState } from "react";
import type { Hex } from "../../../sdk/credential.ts";
import type { Presentation } from "../../../sdk/disclosure.ts";
import { checkPrecursorsOffline, type OfflineItem, type PrecursorEvidence, type PrecursorReport, type PrecursorStatement } from "../../../sdk/precursor.ts";
import type { CheckResult, Overall } from "../../../sdk/verify.ts";
import { Badge, type BadgeKind } from "../components.tsx";
import { short } from "../data.ts";
import { useLang, useStrings } from "../i18n.ts";
import { PRECURSOR_DEMO_TRUST_ANCHOR } from "../../../sdk/vlei.ts";

export interface PrecursorData {
  version: 1;
  mode: "local";
  label: string;
  chainId: number;
  deployment: { registry: Hex; allowlist: Hex };
  trustAnchor: string;
  entities: {
    root: { name: string };
    qvi: { name: string; lei: string };
    nab: { name: string; lei: string };
    mill: { name: string; lei: string; installation: { id: string; name: string } };
    millBody: { name: string; lei: string; aid: string; accreditationNumber: string; cnScope: string[]; leSaid: string; accreditationSaid: string };
    millAuditor: { name: string; role: string; aid: string; ecrSaid: string };
    screwBody: { name: string; lei: string; aid: string };
    screwAuditor: { name: string; aid: string };
    secondScrewMaker: { name: string; lei: string };
    screwMaker: { name: string; lei: string };
  };
  statement: PrecursorStatement;
  statementNote: string;
  good: { proof: Presentation & { precursorEvidence: PrecursorEvidence }; reportKey: Hex; kelSeq: string };
  mill: { credSAID: string; reportKey: Hex; verifiedTonnes: string; remainingKg: string };
  verification: { overall: Overall; primaryCode: string; checks: CheckResult[]; disclosed: Record<string, string>; precursors: PrecursorReport };
  secondMaker: {
    claim: { quantityTonnes: string; batchId: string; revert: { errorName: string; args: string[] } };
    verification: { overall: Overall; primaryCode: string; checks: CheckResult[]; precursors?: PrecursorReport };
  };
  txs: { step: string; label: string; hash: string; block: number; time: string; result: string }[];
}

let cache: Promise<PrecursorData | null> | undefined;
/** The precursor demo data, fetched once; null when the file is missing (the sections then stay hidden). */
export function usePrecursorData(): PrecursorData | null {
  const [d, setD] = useState<PrecursorData | null>(null);
  useEffect(() => {
    cache ??= fetch(`${import.meta.env.BASE_URL}precursor-data.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<PrecursorData>) : null))
      .catch(() => null);
    let live = true;
    void cache.then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, []);
  return d;
}

const kgT = (kg: string) => {
  const n = BigInt(kg);
  const f = (n % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${n / 1000n}${f ? `.${f}` : ""}`;
};
const kindOf = (status: string): BadgeKind => (status === "pass" ? "pass" : status === "fail" ? "fail" : status === "warn" ? "review" : "skip");
const BADGE_ZH: Record<BadgeKind, string> = { pass: "✓ 通過", fail: "✕ 未通過", review: "! 需審查", idle: "· 尚未執行", skip: "– 未執行" };

const T = {
  en: {
    kicker: "Precursor (wire rod)",
    where:
      "Second tier, shown on a local chain. The wire-rod mill's credential, its registration and its claim for the screw maker are on a local anvil chain (chain ID 31337), not on Sepolia; the Sepolia demo proof above carries no precursor statement. The precursor cap is shown on that local chain only. The vLEI evidence of this tier is synthetic (test keys, no KERI agents). All companies fictional; values illustrative.",
    title: (see: string) => `How the ${see} tCO2e/t of the screws splits`,
    lede: "SEE of the screws = the screw process's own direct emissions + the mass of wire rod consumed per tonne of screws × the wire rod's verified SEE (Commission Guidance No. 3, section 4.2.2.3, Equations 59–63). The mass consumed includes the wire rod cut away as scrap (Guidance No. 3, p. 34; Guidance No. 5d, p. 14).",
    tableCaption: "Direct and precursor contributions to the screws' specific embedded emissions (illustrative)",
    cols: ["Part", "Calculation", "tCO2e per t of screws", "Share"],
    direct: "Screw process (direct)",
    directCalc: "attributed direct emissions",
    precursorRow: (cn: string, mill: string) => `Wire rod, CN ${cn} (${mill})`,
    defaultRow: (cn: string) => `CN ${cn} (default value)`,
    total: "Recomputed total",
    declared: (v: string, tol: string) => `Declared and signed in the screw credential: ${v} tCO2e/t (tolerance ${tol})`,
    bar: (d: string, p: string) => `Direct ${d}%, precursor ${p}%`,
    recorded: "Check 9 result recorded on the local chain when the data was built",
    millProof: (o: string) => `The mill's proof, verified with checks 0–8 on the same registry: ${o}`,
    ledger: (v: string, c: string, n: string, m: string, g: string, r: string) =>
      `Mill report: ${v} t of wire rod verified; ${c} t claimed for the screw maker (needed: ${n} t = ${m} t/t × ${g} t of screws); ${r} t left. A second claim of more than ${r} t reverts (Try to break it, card 5).`,
    recheck: "Re-check the off-chain parts in this browser",
    rechecking: "Checking…",
    recheckNote:
      "Recomputed here from the exported evidence: the statement's digest against the signed screw credential, the mill proof's checks 0–3, its KEL anchor and vLEI chain (pinned to the synthetic root of this tier), the CN and period rules and the mass balance. Registration, authorisation at the registering block, revocation and the claim are on-chain facts of the local chain; they are not re-read here.",
    ok: "✓ holds",
    bad: "✕ fails",
    open: "– on-chain, not re-read",
    source: "▤ checked off-chain from exported evidence · precursor cap on a local chain, not on Sepolia",
    trustKicker: "Second tier: the wire-rod mill",
    trustLede:
      "The same trust model one tier up: the mill's report is signed by its own verification body and lead auditor, both on the allowlist of the same registry, and the mill's claim for the screw maker counts against the mill's verified tonnes. Local chain and synthetic vLEI evidence (see the Buyer tab).",
    nodes: {
      root: "synthetic root of this tier (not the root the Sepolia demo pins)",
      qvi: "issues the bodies' LE vLEIs",
      body: (cn: string, acc: string) => `verification body of the mill · accredited for CN ${cn} (${acc}) by the demo accreditation body`,
      auditor: "lead auditor (ECR vLEI) · anchors the mill's credential in their KEL",
      mill: (id: string) => `wire-rod mill · report VR-DEMO-WR-0001 for installation ${id}`,
      screw: (t: string) => `claimed ${t} t of the mill's verified wire rod · its own report is signed by`,
    },
    attackTitle: "5 · The same wire rod backs two screw makers",
    attackHow: "Dry run (eth_call) on the local anvil chain when the demo data was built — not on Sepolia",
    attackText: (c: string, q: string, who: string, r: string) =>
      `After ${c} t were claimed for the first screw maker, the mill tries to claim ${q} t of the same report for ${who}. Only ${r} t are left.`,
    rejected: "Rejected",
    attackResult: (err: string, rem: string, req: string, code: string) =>
      `Reverted: ${err} (${rem} t left, ${req} t requested). The second screw maker's proof then fails check 9 (${code}): its precursor batch was never claimed.`,
  },
  "zh-TW": {
    kicker: "前驅物（線材）",
    where:
      "第二層，於本機鏈上展示。線材廠的憑證、其登記，以及為螺絲廠所做的申領，都在本機 anvil 鏈（chain ID 31337）上，不在 Sepolia；上方的 Sepolia 示範證明並未包含前驅物聲明。前驅物上限只在該本機鏈上展示。此層的 vLEI 證據為合成資料（測試金鑰，未使用 KERI 代理）。所有公司皆為虛構；數值僅為示意。",
    title: (see: string) => `螺絲的 ${see} tCO2e/t 如何拆分`,
    lede: "螺絲的 SEE = 螺絲製程本身的直接排放 + 每噸螺絲所消耗的線材質量 × 線材經查證的 SEE（歐盟執委會 Guidance No. 3，第 4.2.2.3 節，公式 59–63）。消耗質量包含切除成為廢料的線材（Guidance No. 3 第 34 頁；Guidance No. 5d 第 14 頁）。",
    tableCaption: "螺絲特定隱含排放中的直接與前驅物貢獻（示意）",
    cols: ["部分", "計算", "每噸螺絲 tCO2e", "占比"],
    direct: "螺絲製程（直接）",
    directCalc: "歸屬的直接排放",
    precursorRow: (cn: string, mill: string) => `線材，CN ${cn}（${mill}）`,
    defaultRow: (cn: string) => `CN ${cn}（預設值）`,
    total: "重新計算的總和",
    declared: (v: string, tol: string) => `螺絲憑證中申報並簽署的值：${v} tCO2e/t（容許誤差 ${tol}）`,
    bar: (d: string, p: string) => `直接 ${d}%，前驅物 ${p}%`,
    recorded: "建置資料時在本機鏈上記錄的檢查 9 結果",
    millProof: (o: string) => `線材廠的證明，在同一登記合約上以檢查 0–8 驗證：${o}`,
    ledger: (v: string, c: string, n: string, m: string, g: string, r: string) =>
      `線材廠報告：經查證 ${v} t 線材；已為螺絲廠申領 ${c} t（所需：${n} t = 每噸螺絲 ${m} t × ${g} t 螺絲）；剩餘 ${r} t。超過 ${r} t 的第二次申領會被退回（試著攻破它，第 5 張卡）。`,
    recheck: "在此瀏覽器重新檢查鏈下部分",
    rechecking: "檢查中…",
    recheckNote:
      "由匯出的證據在此重新計算：聲明摘要與已簽署螺絲憑證的比對、線材廠證明的檢查 0–3、其 KEL 錨定與 vLEI 鏈（釘選此層的合成根）、CN 與期間規則，以及質量平衡。登記、登記區塊當時的授權、撤銷與申領是本機鏈上的鏈上事實，這裡不重新讀取。",
    ok: "✓ 成立",
    bad: "✕ 不成立",
    open: "– 鏈上事實，未重新讀取",
    source: "▤ 依匯出證據於鏈下檢查 · 前驅物上限在本機鏈上，不在 Sepolia",
    trustKicker: "第二層：線材廠",
    trustLede:
      "同一套信任模型往上一層：線材廠的報告由其自己的驗證機構與主任查核員簽署，兩者都在同一登記合約的允許清單上；線材廠為螺絲廠所做的申領，會從線材廠經查證的噸數中扣除。本機鏈與合成 vLEI 證據（見買方分頁）。",
    nodes: {
      root: "此層的合成根（不是 Sepolia 示範所釘選的根）",
      qvi: "簽發驗證機構的 LE vLEI",
      body: (cn: string, acc: string) => `線材廠的驗證機構 · 由示範認證機構認證涵蓋 CN ${cn}（${acc}）`,
      auditor: "主任查核員（ECR vLEI）· 在其 KEL 中錨定線材廠的憑證",
      mill: (id: string) => `線材廠 · 設施 ${id} 的報告 VR-DEMO-WR-0001`,
      screw: (t: string) => `申領了線材廠經查證的 ${t} t 線材 · 其自身報告的簽署者為`,
    },
    attackTitle: "5 · 同一批線材替兩家螺絲廠背書",
    attackHow: "建置示範資料時在本機 anvil 鏈上的試算（eth_call）——不在 Sepolia",
    attackText: (c: string, q: string, who: string, r: string) => `第一家螺絲廠已申領 ${c} t 之後，線材廠試圖以同一份報告為 ${who} 申領 ${q} t。剩餘只有 ${r} t。`,
    rejected: "已拒絕",
    attackResult: (err: string, rem: string, req: string, code: string) =>
      `已退回：${err}（剩餘 ${rem} t，申請 ${req} t）。第二家螺絲廠的證明因此在檢查 9 失敗（${code}）：其前驅物批次從未被申領。`,
  },
};

/** Buyer tab: the precursor breakdown of the demo screw report, the recorded check 9 and an off-chain re-check. */
export function PrecursorBuyer() {
  const d = usePrecursorData();
  const t = useStrings(T);
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const [items, setItems] = useState<OfflineItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const p = d.verification.precursors;
  const c9 = d.verification.checks.find((c) => c.index === 9);
  const decl = Number(p.declared);
  const share = (x: string | null) => (x === null || !decl ? "—" : `${Math.round((Number(x) / decl) * 100)}%`);
  const directPct = Math.round((Number(p.attributedDirect) / decl) * 100);
  const line = p.lines[0];
  const millOverall = line?.verification?.overall;

  async function recheck() {
    if (!d) return;
    setBusy(true);
    try {
      const { verifyOffline } = await import("../../../sdk/verify.ts");
      const off = await verifyOffline(d.good.proof, { registry: d.deployment.registry, chainId: d.chainId });
      const core = JSON.parse(d.good.proof.core) as { precursorDigest?: string };
      // The root is pinned in the page code (sdk/vlei.ts), never taken from the data file.
      setItems(await checkPrecursorsOffline(core, off.disclosed, d.good.proof.precursorEvidence, { trustAnchor: PRECURSOR_DEMO_TRUST_ANCHOR, deployment: { registry: d.deployment.registry, chainId: d.chainId } }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sheet reveal precursor" id="precursor" aria-labelledby="precursor-h" style={{ marginTop: 28 }}>
      <p className="sheet-kicker" id="precursor-h">
        {t.kicker}
      </p>
      <p className="precursor-where" role="note" data-testid="precursor-where">
        {t.where}
      </p>
      <h3>{t.title(p.declared ?? "—")}</h3>
      <p className="fine">{t.lede}</p>
      <div className="pc-scroll">
        <table className="pc-table">
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
              <th scope="row">{t.direct}</th>
              <td>{t.directCalc}</td>
              <td className="num">{p.attributedDirect}</td>
              <td className="num">{share(p.attributedDirect)}</td>
            </tr>
            {p.lines.map((l) => (
              <tr key={l.index}>
                <th scope="row">{l.source === "default" ? t.defaultRow(l.cnCode) : t.precursorRow(l.cnCode, d.entities.mill.name)}</th>
                <td>
                  {l.massPerTonne} t/t × {l.see} tCO2e/t
                </td>
                <td className="num">{l.contribution}</td>
                <td className="num">{share(l.contribution)}</td>
              </tr>
            ))}
            <tr className="pc-total">
              <th scope="row">{t.total}</th>
              <td>
                {p.attributedDirect} + {p.precursorTotal}
              </td>
              <td className="num">{p.recomputed}</td>
              <td className="num">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="pc-bar" aria-hidden="true">
        <span className="pc-bar-direct" style={{ width: `${directPct}%` }} />
        <span className="pc-bar-pre" style={{ width: `${100 - directPct}%` }} />
      </div>
      <p className="fine">
        {t.bar(String(directPct), String(100 - directPct))} · {t.declared(p.declared ?? "—", p.tolerance)}
      </p>
      <p className="fine">{t.ledger(d.mill.verifiedTonnes, line?.claimedTonnes ?? "—", line?.neededTonnes ?? "—", line?.massPerTonne ?? "—", p.goodVerifiedTonnes ?? "—", kgT(d.mill.remainingKg))}</p>

      <div className="pc-result">
        <p className="fine">
          <strong>{t.recorded}:</strong>{" "}
          <Badge kind={kindOf(c9?.status ?? "skipped")}>{zh ? BADGE_ZH[kindOf(c9?.status ?? "skipped")] : undefined}</Badge> {c9?.code ? <code>{c9.code}</code> : null}{" "}
          <span lang={zh ? "en" : undefined}>{c9?.detail}</span>
        </p>
        {millOverall && (
          <p className="fine">
            {t.millProof(millOverall)}
          </p>
        )}
        {line?.verification && (
          <ol className="pc-mini" aria-label={zh ? "線材廠證明的各項檢查" : "The mill proof's checks"}>
            {line.verification.checks.map((c) => (
              <li key={c.index} className={`pc-mini-${kindOf(c.status)}`}>
                {c.index} {c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : c.status === "warn" ? "!" : "–"}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={() => void recheck()} disabled={busy}>
          {busy ? t.rechecking : t.recheck}
        </button>
        <span className="source pc-source">{t.source}</span>
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
      <p className="fine">
        {t.source}. <span lang={zh ? "en" : undefined}>{d.label}</span>
      </p>
    </section>
  );
}

/** Trust chain tab: the mill's tier of the chain. */
export function PrecursorTrustChain() {
  const d = usePrecursorData();
  const t = useStrings(T);
  if (!d) return null;
  const e = d.entities;
  const claimed = d.verification.precursors.lines[0]?.claimedTonnes ?? "—";
  const nodes: { name: string; role: string; meta?: string }[] = [
    { name: e.root.name, role: t.nodes.root, meta: `AID ${short(PRECURSOR_DEMO_TRUST_ANCHOR, 8, 6)}` },
    { name: e.qvi.name, role: t.nodes.qvi, meta: `LEI ${e.qvi.lei}` },
    { name: e.millBody.name, role: t.nodes.body(e.millBody.cnScope.join(", "), e.millBody.accreditationNumber), meta: `LEI ${e.millBody.lei} · LE ${short(e.millBody.leSaid, 8, 6)}` },
    { name: e.millAuditor.name, role: t.nodes.auditor, meta: `AID ${short(e.millAuditor.aid, 8, 6)} · ECR ${short(e.millAuditor.ecrSaid, 8, 6)}` },
    { name: e.mill.name, role: t.nodes.mill(e.mill.installation.id), meta: `LEI ${e.mill.lei} · credential ${short(d.mill.credSAID, 8, 6)}` },
    { name: e.screwMaker.name, role: `${t.nodes.screw(claimed)} ${e.screwBody.name}`, meta: `LEI ${e.screwBody.lei}` },
  ];
  return (
    <section className="sheet reveal" aria-labelledby="precursor-trust-h" id="precursor-trust" style={{ marginTop: 28 }}>
      <p className="sheet-kicker" id="precursor-trust-h">
        {t.trustKicker}
      </p>
      <p className="precursor-where" role="note">
        {t.where}
      </p>
      <p className="fine">{t.trustLede}</p>
      <ol className="chain">
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
    </section>
  );
}

/** Try to break it: card 5, the second screw maker's claim on the same wire rod (recorded on the local chain). */
export function PrecursorAttack() {
  const d = usePrecursorData();
  const t = useStrings(T);
  if (!d) return null;
  const r = d.secondMaker.claim.revert;
  const [rem, req] = r.args.map((a) => kgT(a));
  return (
    <div className="attack" id="attack-5" data-testid="attack-precursor">
      <div>
        <h3>{t.attackTitle}</h3>
        <div className="how">{t.attackHow}</div>
        <p className="fine">{t.attackText(d.verification.precursors.lines[0]?.claimedTonnes ?? "—", d.secondMaker.claim.quantityTonnes, d.entities.secondScrewMaker.name, rem)}</p>
      </div>
      <span />
      <div className="attack-result">
        <span className="stamp red">{t.rejected}</span>
        <p>
          {t.attackResult(r.errorName, rem, req, d.secondMaker.verification.primaryCode)}
        </p>
      </div>
    </div>
  );
}
