import { lazy, Suspense, useState } from "react";
import { verifyPresentation, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, SourceLabel, TabHead, TxLink } from "../components.tsx";
import { fmt, short, type Attack4 } from "../data.ts";
import { evidenceCheckers } from "../evidence.ts";
import { codeText, revertText } from "../messages.ts";
import { useLang, type Lang } from "../i18n.ts";
import { CHECKS, kindOf, tamperedProof } from "./Buyer.tsx";
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
      setError(`Verification could not finish: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const c7 = result?.checks.find((c) => c.index === 7);
  const c4 = result?.checks.find((c) => c.index === 4);
  const before = a4.beforeSuspension?.verification as VerificationResult | undefined;
  const c4Before = before?.checks.find((c) => c.index === 4);
  const evidenceLabel = a4.evidence === "synthetic" ? "▤ synthetic evidence · local test" : `▤ exported evidence · ${a4.exportDate}`;

  return (
    <div className="attack">
      <div>
        <h3>4 · The owner key is stolen: an impostor body is put on the allowlist</h3>
        <div className="how">
          Real transactions, simulated compromise of the allowlist owner key — the proof is checked in your browser with the same verifier
          as the Buyer tab
        </div>
        <p className="fine">
          We simulated a stolen allowlist owner key. With it, {a4.body.name} (LEI {a4.body.lei}) and its auditor were
          added to the allowlist (<TxLink hash={a4.txs.addVerifier.hash} label="body" />,{" "}
          <TxLink hash={a4.txs.addAuditor.hash} label="auditor" />
          ). The impostor had built its own vLEI chain: well-formed credentials under a root it controls. It signed a
          credential for {a4.supplier.installationName} and registered it, and the contract accepted it (
          <TxLink hash={a4.txs.register.hash} label="registration, status 1" />
          ): the contract checks the allowlist, not vLEI facts. All entities fictional.
        </p>
        {a4.evidence === "synthetic" && (
          <p className="fine">Local test run: the impostor's credential chain here is synthetic, generated without KERIA.</p>
        )}
      </div>
      <button className="btn" disabled={busy || waiting} onClick={verify}>
        {busy ? "Verifying…" : "Verify the impostor's proof"}
      </button>
      {error && (
        <p className="check-detail bad" role="alert" style={{ gridColumn: "1 / -1" }}>
          {error}
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
          <ol className="checks a4-checks" aria-label="Checks on the impostor's proof" style={{ gridColumn: "1 / -1" }}>
            {CHECKS.map((c) => {
              const r = result.checks.find((x) => x.index === c.n);
              const kind = kindOf(r);
              return (
                <li key={c.n} className="check">
                  <span className="check-num" aria-hidden="true">
                    {c.n}
                  </span>
                  <span className="check-text">
                    <span className="sr-only">Check {c.n}: </span>
                    {r?.name ?? c.text}
                  </span>
                  <span className="check-result">
                    <Badge kind={kind} />
                  </span>
                  <span className={`check-detail ${kind === "fail" ? "bad" : ""}`}>
                    {c.n === 7 ? <span className="source">{evidenceLabel}</span> : <SourceLabel source={c.source} />}{" "}
                    {r?.code ? <code>{r.code}</code> : null}
                    {r?.code ? " — " : " "}
                    {r?.detail ?? ""}
                  </span>
                </li>
              );
            })}
          </ol>
          {c4?.code === "CONTESTED" && (
            <p className="fine" style={{ gridColumn: "1 / -1" }}>
              Check 4 needs review now because the watcher suspended this body within 24 h after the registration.
              {a4.beforeSuspension && c4Before
                ? ` Before the suspension, check 4 ${c4Before.status === "pass" && !c4Before.code ? "passed" : `was ${c4Before.status}`} and check 7 ${before?.checks.find((c) => c.index === 7)?.status === "fail" ? "failed" : "did not fail"} (recorded at block ${a4.beforeSuspension.block}, ${utc(a4.beforeSuspension.time)}).`
                : ""}
            </p>
          )}
          <div className="timeline" style={{ gridColumn: "1 / -1" }}>
            <div>
              <div className="tl-k">✓ Accepted on-chain</div>
              The contract registered the impostor's report: the allowlist said yes.
              <div className="fine">
                Block {a4.txs.register.block} · {utc(a4.txs.register.time)}
              </div>
            </div>
            <div>
              <div className="tl-k">✕ Rejected by check 7</div>
              The vLEI chain does not lead to the pinned root of trust.
            </div>
            <div>
              <div className="tl-k">■ Suspended</div>
              Then the watcher suspended the body (a manual step in this demo): <TxLink hash={a4.txs.suspend.hash} />
              <div className="fine">
                Block {a4.txs.suspend.block} · {utc(a4.txs.suspend.time)}
              </div>
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

  const Result = ({ id }: { id: string }) => {
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
      <TabHead
        title="Try to break it"
        lede={`${["Four", "Five", "Six"][(a4 ? 1 : 0) + (precursorData ? 1 : 0)]} attacks. Each one says how it is checked: in your browser, as a dry run against the live contract, or as a real transaction recorded on Sepolia${precursorData ? "; card 5 was run on a local chain, not on Sepolia" : ""}.`}
      />
      {waiting && (
        <p className="conn" role="status">
          Connecting to Sepolia… the attack buttons unlock when the connection is ready.
        </p>
      )}
      <section className="sheet reveal attacks" aria-label={zh ? "攻擊" : "Attacks"}>
        <div className="attack">
          <div>
            <h3>1 · Change one disclosed number</h3>
            <div className="how">Checked in your browser — no contract call</div>
            <p className="fine">The supplier's proof says 1.8 tCO2e/t. We change it to 1.2 and check the proof again.</p>
          </div>
          <button className="btn" disabled={busy === "a1" || waiting} onClick={attack1}>
            Change one disclosed number
          </button>
          <Result id="a1" />
        </div>

        <div className="attack">
          <div>
            <h3>2a · Claim the same batch again</h3>
            <div className="how">Dry run against the live Sepolia contract (eth_call) — no private key</div>
            <p className="fine">The supplier tries to sell batch {data.shipment.batchId} a second time, to another importer.</p>
          </div>
          <button className="btn" disabled={busy === "a2a" || waiting} onClick={() => dry("a2a")}>
            Claim the same batch again
          </button>
          <Result id="a2a" />
        </div>

        {/* The first screen's ledger strip links here (focus target). */}
        <div className="attack" id="attack-2b" tabIndex={-1}>
          <div>
            <h3>2b · The supplier claims {data.attacks.secondImporter.quantityTonnes} t more for a second importer</h3>
            <div className="how">Dry run against the live Sepolia contract (eth_call) — no private key</div>
            <p className="fine">
              Only {data.report.verifiedTonnes} t were verified and {data.shipment.quantityTonnes} t are already claimed. The
              ledger is shared by every importer.
            </p>
            {over && (
              <p className="fine overclaim-note" data-testid="overclaim-note">
                If accepted: {fmt(over.excess)} t beyond the {fmt(over.verified)} t verified →{" "}
                <strong>{fmt(over.tco2e)} tCO2e</strong> less declared than the CBAM default ({fmt(over.excess)} × (
                {data.comparison.defaultValue} − {data.comparison.verifiedValue})), with no verified emissions behind it.
                Gross, illustrative; contrary to CBAM Art. 8, not a normal outcome.
              </p>
            )}
          </div>
          <button className="btn" disabled={busy === "a2b" || waiting} onClick={() => dry("a2b")}>
            Claim {data.attacks.secondImporter.quantityTonnes} t more
          </button>
          <Result id="a2b" />
        </div>

        <div className="attack">
          <div>
            <h3>3 · The auditor leaves the firm, then signs a new report</h3>
            <div className="how">
              Real Sepolia transaction — reverted, status 0 —{" "}
              {a3 ? <TxLink hash={a3.hash} label="view on explorer" /> : "not recorded yet"}
            </div>
            <p className="fine">This transaction was sent when the demo was set up; nothing is sent from your browser.</p>
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
              <div className="tl-k">✓ Valid</div>
              Registered more than 24 h before the revocation sync
              {reg && (
                <div className="fine">
                  Report 1: block {reg.block} · {reg.time.replace("T", " ").slice(0, 16)} UTC
                </div>
              )}
            </div>
            <div>
              <div className="tl-k">! Needs human review</div>
              Registered within 24 h before the sync (CONTESTED)
              {revoke && (
                <div className="fine">
                  Revocation synced: block {revoke.block} · {revoke.time.replace("T", " ").slice(0, 16)} UTC
                </div>
              )}
            </div>
            <div>
              <div className="tl-k">✕ Rejected</div>
              Registered after the sync
              {a3 && (
                <div className="fine">
                  Attack 3: block {a3.block} · {a3.time.replace("T", " ").slice(0, 16)} UTC
                </div>
              )}
            </div>
          </div>
        </div>

        {a4 && <Attack4Card a4={a4} waiting={waiting} />}
        <PrecursorAttack />
        <ReportDateAttack />
      </section>
      <Suspense fallback={<p aria-live="polite">Loading…</p>}>
        <LayerCard a2b={a2bLive} />
      </Suspense>
    </>
  );
}
