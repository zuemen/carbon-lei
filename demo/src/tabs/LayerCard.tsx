import { useId, useState } from "react";
import type { VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { SourceLabel } from "../components.tsx";
import { fmt } from "../data.ts";
import { codeText, kgToT, revertText } from "../messages.ts";
import { useLang, type Lang } from "../i18n.ts";

/** Attack 2b's dry-run outcome, as the 2b card got it (live), or null when that card has not been run here. */
export type DryOutcome = { errorName: string; args: readonly unknown[] } | null;

type Ledger = "separate" | "shared";
type Layer = "with" | "without";

/** A two-option switch built from native radio buttons (arrow keys move between them, Tab leaves the group). */
function Switch<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="layer-switch">
      <legend>{legend}</legend>
      {options.map(([v, label]) => (
        <label key={v} className={value === v ? "on" : ""}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** The card's strings in English and Traditional Chinese (Taiwan); names, figures and codes stay as they are. */
const T = {
  en: {
    none: "none",
    fromCard: "from your dry run in card 2b above",
    recordedOn: (d: string) => `dry run recorded on ${d}`,
    v4Before: (b: number) => `recorded at block ${b}, before the watcher's suspension`,
    v4Built: "recorded when the demo data was built",
    title: "What if one layer were missing?",
    noteStrong: "What-if in this page only — the verifier itself never switches a check off.",
    note: " Nothing here is sent to the contract: the figures come from the demo data and from the attack results above.",
    ledgerH: "The shared ledger · attack 2b",
    ledgerLede: (first: string, ft: string, v: string, st: string, second: string) =>
      `${first} has claimed ${ft} t of the ${v} t verified. The supplier then asks ${st} t for ${second}.`,
    ledgerLegend: "Where the claims are recorded",
    separate: "Two importers, separate databases (simulated)",
    sharedOpt: "One shared ledger (the live contract)",
    caption: (v: string) => `Claims against the ${v} t verified report`,
    cols: ["Claim", "Checked against", "Result"],
    claimFor: (t: string, name: string) => `${t} t for ${name}`,
    ownDb: (t: string, v: string) => `its own database: ${t} of ${v} t`,
    ownDbBlind: (t: string, v: string, ft: string, name: string) => `its own database: ${t} of ${v} t — it cannot see the ${ft} t claimed for ${name}`,
    sharedLedger: "the shared ledger",
    left: (l: string) => `: ${l} t left`,
    recorded: "⧗ recorded",
    accepted: "Accepted",
    rejected: "Rejected",
    notCaught: "Not caught",
    dash: " — ",
    runFirst: "Run attack 2b above.",
    sumVerified: "Verified report",
    sumAccepted: "Accepted, all importers",
    sumOver: "Over the verified tonnes",
    verdictSeparate: (total: string, v: string) => `Both databases accept: ${total} t are declared against a report that verified ${v} t.`,
    verdictRefused: (total: string, v: string) => `The second claim is refused: ${total} t accepted, within the ${v} t verified.`,
    verdictAccepts: (total: string) => `The contract would accept the second claim: ${total} t accepted.`,
    verdictRun: "Run attack 2b above to see the shared ledger's answer.",
    jointDb: "A database run jointly by one operator could enforce this too, if every party trusts that operator: ",
    whyChain: "why a blockchain ↗",
    c7H: "Check 7, the vLEI chain · attack 4",
    c7Lede: (when: string) => `The impostor body's proof, as the verifier checked it (${when}). The contract had already accepted its registration: the allowlist said yes.`,
    c7Legend: "The verifier's check 7",
    with7: "With check 7 (as deployed)",
    without7: "Without check 7 (what-if)",
    c7Status: (failed: boolean, status: string) => `Check 7 ${failed ? "failed" : `was ${status}`}: `,
    alsoFailed: (l: string) => `Checks ${l} also failed, so the proof is still rejected.`,
    onlyFailed: "Check 7 was the only check that failed, so no other check stops the impostor.",
    others: (l: string) => ` The other checks: passed ${l}`,
    review: (l: string) => `; needs review ${l}`,
    notRun: "; not run ",
  },
  "zh-TW": {
    none: "無",
    fromCard: "來自您在上方卡片 2b 的試算",
    recordedOn: (d: string) => `${d} 記錄的試算`,
    v4Before: (b: number) => `於區塊 ${b} 記錄，監看者暫停之前`,
    v4Built: "建置示範資料時記錄",
    title: "如果少了一層會怎樣？",
    noteStrong: "這只是本頁的假設情境——驗證器本身從不關閉任何檢查。",
    note: "這裡不會送出任何東西到合約：數字來自示範資料與上方的攻擊結果。",
    ledgerH: "共享帳本 · 攻擊 2b",
    ledgerLede: (first: string, ft: string, v: string, st: string, second: string) =>
      `${first} 已在經查證的 ${v} t 中申領 ${ft} t。接著供應商又要為 ${second} 申領 ${st} t。`,
    ledgerLegend: "申領記錄在哪裡",
    separate: "兩家進口商、各自的資料庫（模擬）",
    sharedOpt: "一本共享帳本（即時合約）",
    caption: (v: string) => `對經查證 ${v} t 報告的申領`,
    cols: ["申領", "比對對象", "結果"],
    claimFor: (t: string, name: string) => `為 ${name} 申領 ${t} t`,
    ownDb: (t: string, v: string) => `自己的資料庫：${v} t 中的 ${t} t`,
    ownDbBlind: (t: string, v: string, ft: string, name: string) => `自己的資料庫：${v} t 中的 ${t} t——它看不到已為 ${name} 申領的 ${ft} t`,
    sharedLedger: "共享帳本",
    left: (l: string) => `：剩餘 ${l} t`,
    recorded: "⧗ 已記錄",
    accepted: "已接受",
    rejected: "已拒絕",
    notCaught: "未攔截",
    dash: "——",
    runFirst: "請先執行上方的攻擊 2b。",
    sumVerified: "經查證報告",
    sumAccepted: "所有進口商合計接受",
    sumOver: "超出經查證噸數",
    verdictSeparate: (total: string, v: string) => `兩個資料庫都接受：一份只查證 ${v} t 的報告，被拿來申報了 ${total} t。`,
    verdictRefused: (total: string, v: string) => `第二筆申領遭拒：共接受 ${total} t，未超出經查證的 ${v} t。`,
    verdictAccepts: (total: string) => `合約會接受第二筆申領：共接受 ${total} t。`,
    verdictRun: "執行上方的攻擊 2b，就能看到共享帳本的回應。",
    jointDb: "如果各方都信任同一個營運者，由它共同經營的資料庫也能做到這點：",
    whyChain: "為什麼用區塊鏈 ↗",
    c7H: "檢查 7（vLEI 鏈）· 攻擊 4",
    c7Lede: (when: string) => `冒名機構的證明，以驗證器當時的檢查結果為準（${when}）。合約早已接受它的登記：允許清單放行了。`,
    c7Legend: "驗證器的檢查 7",
    with7: "有檢查 7（目前部署）",
    without7: "沒有檢查 7（假設情境）",
    c7Status: (failed: boolean, status: string) => `檢查 7 ${failed ? "未通過" : `的結果為 ${status}`}：`,
    alsoFailed: (l: string) => `檢查 ${l} 也未通過，因此證明仍會遭拒。`,
    onlyFailed: "檢查 7 是唯一未通過的檢查，所以沒有其他檢查能擋下冒名者。",
    others: (l: string) => `其他檢查：通過 ${l}`,
    review: (l: string) => `；需審查 ${l}`,
    notRun: "；未執行 ",
  },
} satisfies Record<Lang, unknown>;

/**
 * "What if one layer were missing?": a what-if shown on this page only. Every figure comes from the demo data or from
 * results the attack cards above already have (attack 2b's dry run, attack 4's recorded verification); this card sends
 * no call and no transaction, and the verifier itself never skips a check.
 */
export default function LayerCard({ a2b }: { a2b: DryOutcome }) {
  const { data } = useApp();
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const t = T[lang];
  const list = (ns: number[]) => (ns.length ? ns.join(", ") : t.none);
  const [ledger, setLedger] = useState<Ledger>("shared");
  const [layer7, setLayer7] = useState<Layer>("with");

  const verified = Number(data.report.verifiedTonnes);
  const first = { name: data.importer.name, t: Number(data.shipment.quantityTonnes) };
  const second = { name: data.secondImporter.name, t: Number(data.attacks.secondImporter.quantityTonnes) };

  // Shared ledger: the 2b dry run's own answer, live from the card above or as recorded when the data was built.
  const recorded = data.cached?.dryRuns.secondImporter;
  const shared = a2b ?? recorded ?? null;
  const sharedSource = a2b ? t.fromCard : recorded ? t.recordedOn(String(data.cached?.time.slice(0, 10))) : "";
  const sharedRejected = !!shared?.errorName;
  const left = shared?.errorName === "ExceedsVerifiedTonnage" && shared.args.length >= 2 ? kgToT(shared.args[0]) : null;

  // Separate databases (simulated): each importer's database knows only the claims made to that importer.
  const acceptsAlone = (t: number) => t <= verified;
  const sepAccepted = [first, second].filter((c) => acceptsAlone(c.t)).reduce((s, c) => s + c.t, 0);
  const sharedAccepted = first.t + (shared && !sharedRejected ? second.t : 0);
  const total = ledger === "separate" ? sepAccepted : sharedAccepted;
  const over = Math.max(0, total - verified);

  // Attack 4: the verification recorded before the watcher's suspension (the attack as it happened), else the latest.
  const a4 = data.attacks.attack4;
  const v4 = (a4?.beforeSuspension?.verification ?? a4?.verification) as VerificationResult | undefined;
  const v4When = a4?.beforeSuspension ? t.v4Before(a4.beforeSuspension.block) : t.v4Built;
  const c7 = v4?.checks.find((c) => c.index === 7);
  const others = v4?.checks.filter((c) => c.index !== 7) ?? [];
  const otherFailed = others.filter((c) => c.status === "fail").map((c) => c.index);
  const otherReview = others.filter((c) => c.status === "warn" || c.code === "CONTESTED").map((c) => c.index);
  const otherPassed = others.filter((c) => c.status === "pass" && c.code !== "CONTESTED").map((c) => c.index);
  const otherSkipped = others.filter((c) => c.status === "skipped");

  return (
    <section className="sheet reveal layer-card" aria-labelledby="layer-card-h">
      <h3 id="layer-card-h">{t.title}</h3>
      <p className="layer-note">
        <strong>{t.noteStrong}</strong>
        {t.note}
      </p>

      <div className="layer-row" id="layer-ledger">
        <h4>{t.ledgerH}</h4>
        <p className="fine">{t.ledgerLede(first.name, fmt(first.t), fmt(verified), fmt(second.t), second.name)}</p>
        <Switch
          legend={t.ledgerLegend}
          value={ledger}
          options={[
            ["separate", t.separate],
            ["shared", t.sharedOpt],
          ]}
          onChange={setLedger}
        />
        <div className="layer-out" role="status" aria-live="polite" data-mode={ledger}>
          <table className="layer-table">
            <caption className="sr-only">{t.caption(fmt(verified))}</caption>
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
              <tr>
                <td>{t.claimFor(fmt(first.t), first.name)}</td>
                <td>{ledger === "separate" ? t.ownDb(fmt(first.t), fmt(verified)) : t.sharedLedger}</td>
                <td>
                  <span className="stamp">{t.accepted}</span>
                </td>
              </tr>
              <tr>
                <td>{t.claimFor(fmt(second.t), second.name)}</td>
                {ledger === "separate" ? (
                  <>
                    <td>
                      {t.ownDbBlind(fmt(second.t), fmt(verified), fmt(first.t), first.name)}
                    </td>
                    <td>
                      <span className="stamp">{acceptsAlone(second.t) ? t.accepted : t.rejected}</span>
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      {t.sharedLedger}
                      {left ? t.left(left) : ""}
                      {sharedSource ? (
                        <>
                          {" "}
                          {a2b ? <SourceLabel source="sepolia" /> : <span className="source">{t.recorded}</span>}{" "}
                          <span className="fine">{sharedSource}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {shared ? (
                        <>
                          <span className={`stamp ${sharedRejected ? "red" : ""}`}>{sharedRejected ? t.rejected : t.accepted}</span>
                          {sharedRejected && (
                            <span className="fine layer-revert">
                              <code>{shared.errorName}</code>
                              {t.dash}
                              {revertText(shared.errorName, shared.args, zh)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="fine">{t.runFirst}</span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
          <dl className="whatif-out layer-sum">
            <div>
              <dt>{t.sumVerified}</dt>
              <dd>{fmt(verified)} t</dd>
            </div>
            <div>
              <dt>{t.sumAccepted}</dt>
              <dd data-testid="layer-total">{fmt(total)} t</dd>
            </div>
            <div>
              <dt>{t.sumOver}</dt>
              <dd data-testid="layer-over" className={over > 0 ? "bad" : ""}>
                {fmt(over)} t
              </dd>
            </div>
          </dl>
          <p className="layer-verdict">
            {ledger === "separate"
              ? t.verdictSeparate(fmt(total), fmt(verified))
              : shared
                ? sharedRejected
                  ? t.verdictRefused(fmt(total), fmt(verified))
                  : t.verdictAccepts(fmt(total))
                : t.verdictRun}
          </p>
        </div>
        <p className="fine">
          {t.jointDb}
          <a href="https://github.com/zuemen/carbon-lei/blob/main/docs/ARCHITECTURE.md#11-why-a-blockchain-four-questions">{t.whyChain}</a>
        </p>
      </div>

      {a4 && v4 && c7 && (
        <div className="layer-row" id="layer-check7">
          <h4>{t.c7H}</h4>
          <p className="fine">{t.c7Lede(v4When)}</p>
          <Switch
            legend={t.c7Legend}
            value={layer7}
            options={[
              ["with", t.with7],
              ["without", t.without7],
            ]}
            onChange={setLayer7}
          />
          <div className="layer-out" role="status" aria-live="polite" data-mode={layer7}>
            {layer7 === "with" ? (
              <div className="attack-result">
                <span className={`stamp ${c7.status === "fail" ? "red" : ""}`}>{c7.status === "fail" ? t.rejected : t.notCaught}</span>
                <p>
                  {t.c7Status(c7.status === "fail", c7.status)}
                  {zh ? (codeText(c7.code, true) ?? <span lang="en">{c7.detail}.</span>) : `${c7.detail}.`}
                </p>
              </div>
            ) : (
              <div className="attack-result">
                <span className={`stamp ${otherFailed.length ? "red" : ""}`}>{otherFailed.length ? t.rejected : t.notCaught}</span>
                <p>
                  {otherFailed.length ? t.alsoFailed(list(otherFailed)) : t.onlyFailed}
                  {t.others(list(otherPassed))}
                  {otherReview.length ? t.review(list(otherReview)) : ""}
                  {otherSkipped.length ? (
                    <>
                      {t.notRun}
                      {otherSkipped.map((c, i) => (
                        <span key={c.index}>
                          {i ? ", " : ""}
                          {c.index} (<span lang={zh ? "en" : undefined}>{c.detail}</span>)
                        </span>
                      ))}
                    </>
                  ) : (
                    ""
                  )}
                  {zh ? "。" : "."}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
