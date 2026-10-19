import { lazy, Suspense, useState } from "react";
import { verifyPresentation, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, SourceLabel, TabHead, TxLink } from "../components.tsx";
import { fmt, short, type Attack4 } from "../data.ts";
import { evidenceCheckers } from "../evidence.ts";
import { codeText, revertText } from "../messages.ts";
import { useLang, type Lang } from "../i18n.ts";
import { CHECK_TEXT_ZH, CHECKS, kindOf, tamperedProof } from "./Buyer.tsx";
import type { DryOutcome } from "./LayerCard.tsx";
import { PrecursorAttack, usePrecursorData } from "./Precursor.tsx";
import { ReportDateAttack } from "./VerifierRules.tsx";

// The "What if one layer were missing?" card loads after the attack cards.
const LayerCard = lazy(() => import("./LayerCard.tsx"));

/** A result, rendered in the page's language when shown (so switching the language re-renders it). */
type Outcome = { red: boolean; show: (zh: boolean) => { stamp: string; text: string } } | null;

/** The result stamps and texts of the attack cards, in English and Traditional Chinese (Taiwan). */
const R = {
  en: {
    rejected: "Rejected",
    accepted: "Accepted",
    notCaught: "Not caught",
    error: "Error",
    offline: "Offline",
    checkFailed: (n: number, why: string) => `Check ${n} failed: ${why}`,
    notFailed: (n: number) => `Check ${n} did not fail — please report this.`,
    needsLive: "Needs a live connection.",
    recorded: (d: string) => `Needs a live connection — shown here: the result recorded on ${d}.`,
    reverted: (err: string, why: string) => `Reverted: ${err} — ${why}`,
    wouldAccept: "The contract would accept this claim.",
    a3Reverted: "Reverted:",
    a3Tail: " The report registered before the revocation sync stays valid on-chain.",
    a4Chain: (root: string) => [`The impostor's chain leads to ${root} (`, "), not to the root this page pins (", ")."],
    a4Dry: "A new registration from the impostor now, as a dry run:",
    a4DryReverted: "reverted",
    a4DryAccepted: "the contract would accept it.",
    a4DryCached: " (recorded result; needs a live connection)",
    // Card texts (English as recorded in the v5.2 video; Traditional Chinese below).
    lede: (n: number, pre: boolean) =>
      `${["Four", "Five", "Six"][n]} attacks. Each one says how it is checked: in your browser, as a dry run against the live contract, or as a real transaction recorded on Sepolia${pre ? "; card 5 was run on a local chain, not on Sepolia" : ""}.`,
    title: "Try to break it",
    connecting: "Connecting to Sepolia… the attack buttons unlock when the connection is ready.",
    browserHow: "Checked in your browser — no contract call",
    dryHow: "Dry run against the live Sepolia contract (eth_call) — no private key",
    a1Title: "1 · Change one disclosed number",
    a1Note: "The supplier's proof says 1.8 tCO2e/t. We change it to 1.2 and check the proof again.",
    a1Button: "Change one disclosed number",
    a2aTitle: "2a · Claim the same batch again",
    a2aNote: (b: string) => `The supplier tries to sell batch ${b} a second time, to another importer.`,
    a2aButton: "Claim the same batch again",
    a2bTitle: (q: string) => `2b · The supplier claims ${q} t more for a second importer`,
    a2bNote: (v: string, c: string) => `Only ${v} t were verified and ${c} t are already claimed. The ledger is shared by every importer.`,
    a2bOverA: (x: string, v: string) => `If accepted: ${x} t beyond the ${v} t verified → `,
    a2bOverB: " less declared than the CBAM default (",
    a2bOverC: "), with no verified emissions behind it. Gross, illustrative; contrary to CBAM Art. 8, not a normal outcome.",
    a2bButton: (q: string) => `Claim ${q} t more`,
    a3Title: "3 · The auditor leaves the firm, then signs a new report",
    a3How: "Real Sepolia transaction — reverted, status 0 —",
    a3Explorer: "view on explorer",
    a3NotRecorded: "not recorded yet",
    a3Note: "This transaction was sent when the demo was set up; nothing is sent from your browser.",
    tlValid: "✓ Valid",
    tlValidBody: "Registered more than 24 h before the revocation sync",
    tlReport1: (b: number, t: string) => `Report 1: block ${b} · ${t} UTC`,
    tlReview: "! Needs human review",
    tlReviewBody: "Registered within 24 h before the sync (CONTESTED)",
    tlSynced: (b: number, t: string) => `Revocation synced: block ${b} · ${t} UTC`,
    tlRejected: "✕ Rejected",
    tlRejectedBody: "Registered after the sync",
    tlA3: (b: number, t: string) => `Attack 3: block ${b} · ${t} UTC`,
    loading: "Loading…",
    // Card 4
    a4CouldNotFinish: "Verification could not finish: ",
    a4Synthetic: "▤ synthetic evidence · local test",
    a4Exported: (d: string) => `▤ exported evidence · ${d}`,
    a4Title: "4 · The owner key is stolen: an impostor body is put on the allowlist",
    a4Takeaway: "Even with the allowlist key stolen, the buyer still catches the impostor: check 7 finds that its vLEI chain does not lead to the root of trust this page pins.",
    a4How: "Real transactions, simulated compromise of the allowlist owner key — the proof is checked in your browser with the same verifier as the Buyer tab",
    a4Story: [
      (name: string, lei: string) => `We simulated a stolen allowlist owner key. With it, ${name} (LEI ${lei}) and its auditor were added to the allowlist (`,
      "body",
      ", ",
      "auditor",
      (inst: string) => `). The impostor had built its own vLEI chain: well-formed credentials under a root it controls. It signed a credential for ${inst} and registered it, and the contract accepted it (`,
      "registration, status 1",
      "): the contract checks the allowlist, not vLEI facts. All entities fictional.",
    ] as const,
    a4LocalTest: "Local test run: the impostor's credential chain here is synthetic, generated without KERIA.",
    a4Verifying: "Verifying…",
    a4Button: "Verify the impostor's proof",
    a4ChecksLabel: "Checks on the impostor's proof",
    checkSr: (n: number) => `Check ${n}: `,
    a4Contested: "Check 4 needs review now because the watcher suspended this body within 24 h after the registration.",
    a4Before: (c4: string, c7failed: boolean, block: number, time: string) =>
      ` Before the suspension, check 4 ${c4} and check 7 ${c7failed ? "failed" : "did not fail"} (recorded at block ${block}, ${time}).`,
    a4C4Passed: "passed",
    a4C4Was: (s: string) => `was ${s}`,
    tlAccepted: "✓ Accepted on-chain",
    tlAcceptedBody: "The contract registered the impostor's report: the allowlist said yes.",
    tlBlock: (b: number, t: string) => `Block ${b} · ${t}`,
    tlCheck7: "✕ Rejected by check 7",
    tlCheck7Body: "The vLEI chain does not lead to the pinned root of trust.",
    tlSuspended: "■ Suspended",
    tlSuspendedBody: "Then the watcher suspended the body (a manual step in this demo): ",
  },
  "zh-TW": {
    rejected: "已拒絕",
    accepted: "已接受",
    notCaught: "未攔截",
    error: "錯誤",
    offline: "離線",
    checkFailed: (n: number, why: string) => `檢查 ${n} 未通過：${why}`,
    notFailed: (n: number) => `檢查 ${n} 沒有失敗——請回報此問題。`,
    needsLive: "需要即時連線。",
    recorded: (d: string) => `需要即時連線——此處顯示 ${d} 記錄的結果。`,
    reverted: (err: string, why: string) => `已退回：${err}——${why}`,
    wouldAccept: "合約會接受這筆申領。",
    a3Reverted: "已退回：",
    a3Tail: "在撤銷同步之前登記的報告，在鏈上仍然有效。",
    a4Chain: (root: string) => [`冒名者的鏈通往 ${root}（`, "），而不是本頁釘選的根（", "）。"],
    a4Dry: "冒名者現在再登記一筆，以試算（dry run）執行：",
    a4DryReverted: "已退回",
    a4DryAccepted: "合約會接受。",
    a4DryCached: "（記錄的結果；需要即時連線）",
    lede: (n: number, pre: boolean) =>
      `${["四", "五", "六"][n]}種攻擊。每一張卡片都註明檢查方式：在您的瀏覽器中檢查、對即時合約做試算（dry run），或是記錄在 Sepolia 上的真實交易${pre ? "；卡片 5 是在本機鏈上執行，不在 Sepolia" : ""}。`,
    title: "試著破解",
    connecting: "正在連線到 Sepolia…連線就緒後，攻擊按鈕就能使用。",
    browserHow: "在您的瀏覽器中檢查——不呼叫合約",
    dryHow: "對 Sepolia 上的即時合約試算（eth_call）——不需私鑰",
    a1Title: "1 · 竄改一個已揭露的數值",
    a1Note: "供應商的證明寫的是 1.8 tCO2e/t。我們把它改成 1.2，再檢查一次證明。",
    a1Button: "竄改一個已揭露的數值",
    a2aTitle: "2a · 同一批次再申領一次",
    a2aNote: (b: string) => `供應商想把批次 ${b} 再賣一次，賣給另一家進口商。`,
    a2aButton: "同一批次再申領一次",
    a2bTitle: (q: string) => `2b · 供應商為第二家進口商多申領 ${q} t`,
    a2bNote: (v: string, c: string) => `經查證的只有 ${v} t，且已申領 ${c} t。這本帳由所有進口商共用。`,
    a2bOverA: (x: string, v: string) => `如果被接受：比經查證的 ${v} t 多出 ${x} t → 比 CBAM 預設值少申報 `,
    a2bOverB: "（",
    a2bOverC: "），背後卻沒有任何經查證的排放。毛額，示意；這違反 CBAM 第 8 條，不是正常結果。",
    a2bButton: (q: string) => `多申領 ${q} t`,
    a3Title: "3 · 查核員離職後，又簽了一份新報告",
    a3How: "Sepolia 上的真實交易——已退回，status 0——",
    a3Explorer: "在區塊瀏覽器查看",
    a3NotRecorded: "尚未記錄",
    a3Note: "這筆交易是在建置示範時送出的；您的瀏覽器不會送出任何東西。",
    tlValid: "✓ 有效",
    tlValidBody: "在撤銷同步前超過 24 小時登記",
    tlReport1: (b: number, t: string) => `報告 1：區塊 ${b} · ${t} UTC`,
    tlReview: "! 需人工審查",
    tlReviewBody: "在撤銷同步前 24 小時內登記（CONTESTED）",
    tlSynced: (b: number, t: string) => `撤銷已同步：區塊 ${b} · ${t} UTC`,
    tlRejected: "✕ 拒絕",
    tlRejectedBody: "在撤銷同步之後登記",
    tlA3: (b: number, t: string) => `攻擊 3：區塊 ${b} · ${t} UTC`,
    loading: "載入中…",
    a4CouldNotFinish: "驗證無法完成：",
    a4Synthetic: "▤ 合成證據 · 本機測試",
    a4Exported: (d: string) => `▤ 匯出的證據 · ${d}`,
    a4Title: "4 · 所有者金鑰遭竊：冒名機構被加進允許清單",
    a4Takeaway: "就算允許清單的金鑰被偷，買方還是抓得到冒名者：檢查 7 發現它的 vLEI 鏈通往的不是本頁釘選的信任根。",
    a4How: "真實交易，模擬允許清單所有者金鑰外洩——證明在您的瀏覽器中，以和買方分頁相同的驗證器檢查",
    a4Story: [
      (name: string, lei: string) => `我們模擬允許清單的所有者金鑰遭竊。冒名者用它把 ${name}（LEI ${lei}）及其查核員加進允許清單（`,
      "機構",
      "、",
      "查核員",
      (inst: string) => `）。冒名者事先建好自己的 vLEI 鏈：格式完全正確的憑證，但根由它自己掌控。它為 ${inst} 簽署了一份憑證並登記，合約也接受了（`,
      "登記，status 1",
      "）：合約只檢查允許清單，不檢查 vLEI 事實。所有單位皆為虛構。",
    ] as const,
    a4LocalTest: "本機測試執行：此處冒名者的憑證鏈是合成的，未使用 KERIA 產生。",
    a4Verifying: "驗證中…",
    a4Button: "驗證冒名者的證明",
    a4ChecksLabel: "對冒名者證明的檢查",
    checkSr: (n: number) => `檢查 ${n}：`,
    a4Contested: "檢查 4 現在需要審查，因為監看者在登記後 24 小時內暫停了這個機構。",
    a4Before: (c4: string, c7failed: boolean, block: number, time: string) =>
      `暫停之前，檢查 4 ${c4}，檢查 7 ${c7failed ? "未通過" : "沒有失敗"}（記錄於區塊 ${block}，${time}）。`,
    a4C4Passed: "通過",
    a4C4Was: (s: string) => `的結果為 ${s}`,
    tlAccepted: "✓ 鏈上已接受",
    tlAcceptedBody: "合約登記了冒名者的報告：允許清單放行了。",
    tlBlock: (b: number, t: string) => `區塊 ${b} · ${t}`,
    tlCheck7: "✕ 被檢查 7 拒絕",
    tlCheck7Body: "這條 vLEI 鏈沒有通往釘選的信任根。",
    tlSuspended: "■ 已暫停",
    tlSuspendedBody: "接著監看者暫停了該機構（本示範中為人工步驟）：",
  },
} satisfies Record<Lang, unknown>;

const BIGINT_FIELDS = new Set(["kelSeq", "verifiedKg", "validUntil"]);
const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

/**
 * Attack 4: a simulated compromise of the allowlist owner key lists an impostor body whose vLEI chain leads to its own root.
 * The contract accepts its report; the page's verifier (pinned root, same code as the Buyer tab) rejects
 * the proof at check 7. Then the watcher's suspension and a dry run of a new registration.
 */
function Attack4Card({ a4, waiting }: { a4: Attack4; waiting: boolean }) {
  const { data, reader, offline } = useApp();
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const rt = R[lang];
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [cachedOn, setCachedOn] = useState("");
  const [dry, setDry] = useState<{ errorName: string; args: readonly unknown[]; cached: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function verify() {
    setError("");
    if (offline || !reader) {
      setResult(a4.verification as VerificationResult);
      setCachedOn(data.cached?.time.slice(0, 10) ?? "");
      const c = data.cached?.dryRuns.impostorAfterSuspension;
      setDry(c ? { ...c, cached: true } : null);
      return;
    }
    setBusy(true);
    try {
      // The same verifier and checkers as the Buyer tab: the root of trust is the page's pinned root,
      // never the one the impostor's bundle names.
      setResult(await verifyPresentation(a4.proof, reader, { checkers: evidenceCheckers(data) }));
      setCachedOn("");
      const input = Object.fromEntries(
        Object.entries(a4.dryRun.input).map(([k, v]) => [k, BIGINT_FIELDS.has(k) ? BigInt(v) : v]),
      );
      const r = await reader.dryRun("registerReport", [input], a4.dryRun.caller);
      setDry(r.reverted ? { errorName: r.errorName, args: r.args, cached: false } : { errorName: "", args: [], cached: false });
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const c7 = result?.checks.find((c) => c.index === 7);
  const c4 = result?.checks.find((c) => c.index === 4);
  const before = a4.beforeSuspension?.verification as VerificationResult | undefined;
  const c4Before = before?.checks.find((c) => c.index === 4);
  const evidenceLabel = a4.evidence === "synthetic" ? rt.a4Synthetic : rt.a4Exported(a4.exportDate);
  const story = rt.a4Story;

  return (
    <div className="attack">
      <div>
        <h3>{rt.a4Title}</h3>
        <p className="takeaway">
          <strong>{rt.a4Takeaway}</strong>
        </p>
        <div className="how">{rt.a4How}</div>
        <p className="fine">
          {story[0](a4.body.name, a4.body.lei)}
          <TxLink hash={a4.txs.addVerifier.hash} label={story[1]} />
          {story[2]}
          <TxLink hash={a4.txs.addAuditor.hash} label={story[3]} />
          {story[4](a4.supplier.installationName)}
          <TxLink hash={a4.txs.register.hash} label={story[5]} />
          {story[6]}
        </p>
        {a4.evidence === "synthetic" && <p className="fine">{rt.a4LocalTest}</p>}
      </div>
      <button className="btn" disabled={busy || waiting} onClick={verify}>
        {busy ? rt.a4Verifying : rt.a4Button}
      </button>
      {error && (
        <p className="check-detail bad" role="alert" style={{ gridColumn: "1 / -1" }}>
          {rt.a4CouldNotFinish}
          <span lang={zh ? "en" : undefined}>{error}</span>
        </p>
      )}
      {result && !busy && (
        <>
          <div className="attack-result" role="status">
            <span className={`stamp ${c7?.status === "fail" ? "red" : ""}`}>{c7?.status === "fail" ? rt.rejected : rt.notCaught}</span>
            <p>
              {c7?.status === "fail" ? (
                <>
                  {zh ? rt.checkFailed(7, codeText(c7.code, true) ?? c7.detail) : `${rt.checkFailed(7, c7.detail)}. `}
                  {rt.a4Chain(a4.impostorRoot.name)[0]}
                  <span className="hash" title={a4.impostorRoot.aid}>
                    {short(a4.impostorRoot.aid)}
                  </span>
                  {rt.a4Chain(a4.impostorRoot.name)[1]}
                  <span className="hash" title={a4.pinnedRoot}>
                    {short(a4.pinnedRoot)}
                  </span>
                  {rt.a4Chain(a4.impostorRoot.name)[2]}
                </>
              ) : (
                rt.notFailed(7)
              )}
              {cachedOn ? `${zh ? "" : " "}${rt.recorded(cachedOn)}` : ""}
            </p>
          </div>
          <ol className="checks a4-checks" aria-label={rt.a4ChecksLabel} style={{ gridColumn: "1 / -1" }}>
            {CHECKS.map((c) => {
              const r = result.checks.find((x) => x.index === c.n);
              const kind = kindOf(r);
              return (
                <li key={c.n} className="check">
                  <span className="check-num" aria-hidden="true">
                    {c.n}
                  </span>
                  <span className="check-text">
                    <span className="sr-only">{rt.checkSr(c.n)}</span>
                    {zh ? CHECK_TEXT_ZH[c.n] : (r?.name ?? c.text)}
                  </span>
                  <span className="check-result">
                    <Badge kind={kind} />
                  </span>
                  <span className={`check-detail ${kind === "fail" ? "bad" : ""}`}>
                    {c.n === 7 ? <span className="source">{evidenceLabel}</span> : <SourceLabel source={c.source} />}{" "}
                    {r?.code ? <code>{r.code}</code> : null}
                    {r?.code ? (zh ? "——" : " — ") : " "}
                    {zh ? (codeText(r?.code, true) ?? (r?.detail ? <span lang="en">{r.detail}</span> : "")) : (r?.detail ?? "")}
                  </span>
                </li>
              );
            })}
          </ol>
          {c4?.code === "CONTESTED" && (
            <p className="fine" style={{ gridColumn: "1 / -1" }}>
              {rt.a4Contested}
              {a4.beforeSuspension && c4Before
                ? rt.a4Before(
                    c4Before.status === "pass" && !c4Before.code ? rt.a4C4Passed : rt.a4C4Was(c4Before.status),
                    before?.checks.find((c) => c.index === 7)?.status === "fail",
                    a4.beforeSuspension.block,
                    utc(a4.beforeSuspension.time),
                  )
                : ""}
            </p>
          )}
          <div className="timeline" style={{ gridColumn: "1 / -1" }}>
            <div>
              <div className="tl-k">{rt.tlAccepted}</div>
              {rt.tlAcceptedBody}
              <div className="fine">{rt.tlBlock(a4.txs.register.block, utc(a4.txs.register.time))}</div>
            </div>
            <div>
              <div className="tl-k">{rt.tlCheck7}</div>
              {rt.tlCheck7Body}
            </div>
            <div>
              <div className="tl-k">{rt.tlSuspended}</div>
              {rt.tlSuspendedBody}
              <TxLink hash={a4.txs.suspend.hash} />
              <div className="fine">{rt.tlBlock(a4.txs.suspend.block, utc(a4.txs.suspend.time))}</div>
            </div>
          </div>
          {dry && (
            <div className="attack-result">
              <span className={`stamp ${dry.errorName ? "red" : ""}`}>{dry.errorName ? rt.rejected : rt.accepted}</span>
              <p>
                <SourceLabel source="sepolia" /> {rt.a4Dry}
                {zh ? "" : " "}
                {dry.errorName ? (
                  <>
                    {rt.a4DryReverted} <code>{dry.errorName}</code>
                    {zh ? "——" : " — "}
                    {revertText(dry.errorName, dry.args, zh)}
                  </>
                ) : (
                  rt.a4DryAccepted
                )}
                {dry.cached ? rt.a4DryCached : ""}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Attacks() {
  const { data, reader, offline } = useApp();
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const rt = R[lang];
  const precursorData = usePrecursorData();
  const [out, setOut] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState("");
  // Attack 2b's live dry-run answer, which the layer card reads (it sends no call of its own).
  const [a2bLive, setA2bLive] = useState<DryOutcome>(null);
  const a3 = data.attacks.attack3;
  const a4 = data.attacks.attack4;
  const reg = data.txs.find((t) => t.step === "registerReport1");
  const waiting = !reader && !offline;
  const revoke = data.txs.find((t) => t.step === "revokeAuditor");
  // Card 2b's excess, from the demo data only: tonnes the second claim would put beyond the verified report, and
  // the declared-emissions gap (default minus verified intensity) those tonnes would carry without verification.
  const over = (() => {
    const verified = Number(data.report.verifiedTonnes);
    const excess = Number(data.shipment.quantityTonnes) + Number(data.attacks.secondImporter.quantityTonnes) - verified;
    const gapPerT = Number(data.comparison.defaultValue) - Number(data.comparison.verifiedValue);
    return excess > 0 && gapPerT > 0 ? { verified, excess, tco2e: excess * gapPerT } : null;
  })();

  async function attack1() {
    setBusy("a1");
    try {
      const p = tamperedProof(data.proof);
      if (!reader) throw new Error("not connected");
      const r = await verifyPresentation(p, reader, { importerEORI: data.importer.eori });
      const c2 = r.checks.find((c) => c.index === 2);
      setOut((o) => ({
        ...o,
        a1:
          c2?.status === "fail"
            ? { red: true, show: (z) => ({ stamp: R[z ? "zh-TW" : "en"].rejected, text: R[z ? "zh-TW" : "en"].checkFailed(2, codeText("DISCLOSURE_TAMPERED", z)!) }) }
            : { red: false, show: (z) => ({ stamp: R[z ? "zh-TW" : "en"].notCaught, text: R[z ? "zh-TW" : "en"].notFailed(2) }) },
      }));
    } catch (e) {
      const message = (e as Error).message;
      setOut((o) => ({ ...o, a1: { red: false, show: (z) => ({ stamp: R[z ? "zh-TW" : "en"].error, text: message }) } }));
    } finally {
      setBusy("");
    }
  }

  async function dry(id: "a2a" | "a2b") {
    const spec = id === "a2a" ? data.attacks.sameBatch : data.attacks.secondImporter;
    if (offline || !reader) {
      const c = data.cached?.dryRuns[id === "a2a" ? "sameBatch" : "secondImporter"];
      setOut((o) => ({
        ...o,
        [id]: c
          ? {
              red: true,
              show: (z) => {
                const x = R[z ? "zh-TW" : "en"];
                return { stamp: x.rejected, text: `${x.recorded(data.cached?.time.slice(0, 10) ?? "")}${z ? "" : " "}${x.reverted(c.errorName, revertText(c.errorName, c.args, z))}` };
              },
            }
          : { red: false, show: (z) => ({ stamp: R[z ? "zh-TW" : "en"].offline, text: R[z ? "zh-TW" : "en"].needsLive }) },
      }));
      return;
    }
    setBusy(id);
    const [reportKey, batchKey, qty, commit] = spec.args;
    const r = await reader.dryRun("claimShipment", [reportKey, batchKey, BigInt(qty), commit], spec.caller);
    setBusy("");
    if (id === "a2b") setA2bLive(r.reverted ? { errorName: r.errorName, args: r.args } : { errorName: "", args: [] });
    setOut((o) => ({
      ...o,
      [id]: r.reverted
        ? { red: true, show: (z) => ({ stamp: R[z ? "zh-TW" : "en"].rejected, text: R[z ? "zh-TW" : "en"].reverted(r.errorName, revertText(r.errorName, r.args, z)) }) }
        : { red: false, show: (z) => ({ stamp: R[z ? "zh-TW" : "en"].accepted, text: R[z ? "zh-TW" : "en"].wouldAccept }) },
    }));
  }

  // A plain function, not a component defined here: a component type created on every render would be remounted on
  // every re-render, restarting the stamp's fade-in and re-announcing the status region (CI axe, 2026-10-17).
  const result = (id: string) => {
    const o = out[id];
    if (!o) return null;
    const r = o.show(zh);
    return (
      <div className="attack-result" role="status">
        <span className={`stamp ${o.red ? "red" : ""}`}>{r.stamp}</span>
        <p>{r.text}</p>
      </div>
    );
  };

  return (
    <>
      <TabHead title={rt.title} lede={rt.lede((a4 ? 1 : 0) + (precursorData ? 1 : 0), !!precursorData)} />
      {waiting && (
        <p className="conn" role="status">
          {rt.connecting}
        </p>
      )}
      <section className="sheet reveal attacks" aria-label={zh ? "攻擊" : "Attacks"}>
        <div className="attack">
          <div>
            <h3>{rt.a1Title}</h3>
            <div className="how">{rt.browserHow}</div>
            <p className="fine">{rt.a1Note}</p>
          </div>
          <button className="btn" disabled={busy === "a1" || waiting} onClick={attack1}>
            {rt.a1Button}
          </button>
          {result("a1")}
        </div>

        <div className="attack">
          <div>
            <h3>{rt.a2aTitle}</h3>
            <div className="how">{rt.dryHow}</div>
            <p className="fine">{rt.a2aNote(data.shipment.batchId)}</p>
          </div>
          <button className="btn" disabled={busy === "a2a" || waiting} onClick={() => dry("a2a")}>
            {rt.a2aButton}
          </button>
          {result("a2a")}
        </div>

        {/* The first screen's ledger strip links here (focus target). */}
        <div className="attack" id="attack-2b" tabIndex={-1}>
          <div>
            <h3>{rt.a2bTitle(data.attacks.secondImporter.quantityTonnes)}</h3>
            <div className="how">{rt.dryHow}</div>
            <p className="fine">{rt.a2bNote(data.report.verifiedTonnes, data.shipment.quantityTonnes)}</p>
            {over && (
              <p className="fine overclaim-note" data-testid="overclaim-note">
                {rt.a2bOverA(fmt(over.excess), fmt(over.verified))}
                <strong>{fmt(over.tco2e)} tCO2e</strong>
                {rt.a2bOverB}
                {fmt(over.excess)} × ({data.comparison.defaultValue} − {data.comparison.verifiedValue})
                {rt.a2bOverC}
              </p>
            )}
          </div>
          <button className="btn" disabled={busy === "a2b" || waiting} onClick={() => dry("a2b")}>
            {rt.a2bButton(data.attacks.secondImporter.quantityTonnes)}
          </button>
          {result("a2b")}
        </div>

        <div className="attack">
          <div>
            <h3>{rt.a3Title}</h3>
            <div className="how">
              {rt.a3How}
              {zh ? "" : " "}
              {a3 ? <TxLink hash={a3.hash} label={rt.a3Explorer} /> : rt.a3NotRecorded}
            </div>
            <p className="fine">{rt.a3Note}</p>
          </div>
          <span />
          {a3 && (
            <div className="attack-result">
              <span className="stamp red">{rt.rejected}</span>
              <p>
                {rt.a3Reverted} <code>AuditorNotAuthorized</code>
                {zh ? "——" : " — "}
                {revertText("AuditorNotAuthorized", [], zh)}
                {rt.a3Tail}
              </p>
            </div>
          )}
          <div className="timeline" style={{ gridColumn: "1 / -1" }}>
            <div>
              <div className="tl-k">{rt.tlValid}</div>
              {rt.tlValidBody}
              {reg && <div className="fine">{rt.tlReport1(reg.block, reg.time.replace("T", " ").slice(0, 16))}</div>}
            </div>
            <div>
              <div className="tl-k">{rt.tlReview}</div>
              {rt.tlReviewBody}
              {revoke && <div className="fine">{rt.tlSynced(revoke.block, revoke.time.replace("T", " ").slice(0, 16))}</div>}
            </div>
            <div>
              <div className="tl-k">{rt.tlRejected}</div>
              {rt.tlRejectedBody}
              {a3 && <div className="fine">{rt.tlA3(a3.block, a3.time.replace("T", " ").slice(0, 16))}</div>}
            </div>
          </div>
        </div>

        {a4 && <Attack4Card a4={a4} waiting={waiting} />}
        <PrecursorAttack />
        <ReportDateAttack />
      </section>
      <Suspense fallback={<p aria-live="polite">{rt.loading}</p>}>
        <LayerCard a2b={a2bLive} />
      </Suspense>
    </>
  );
}
