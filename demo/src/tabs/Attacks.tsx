import { useState } from "react";
import { verifyPresentation, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, SourceLabel, TabHead, TxLink } from "../components.tsx";
import { short, type Attack4 } from "../data.ts";
import { evidenceCheckers } from "../evidence.ts";
import { CODE_TEXT, revertText } from "../messages.ts";
import { CHECKS, kindOf, tamperedProof } from "./Buyer.tsx";

type Outcome = { stamp: string; text: string } | null;

const BIGINT_FIELDS = new Set(["kelSeq", "verifiedKg", "validUntil"]);
const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

/**
 * Attack 4: a simulated owner-key compromise lists an impostor body whose vLEI chain leads to its own root.
 * The contract accepts its report; the page's verifier (pinned root, same code as the Buyer tab) rejects
 * the proof at check 7. Then the watcher's suspension and a dry run of a new registration.
 */
function Attack4Card({ a4, waiting }: { a4: Attack4; waiting: boolean }) {
  const { data, reader, offline } = useApp();
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
          Real transactions, simulated owner-key compromise — the proof is checked in your browser with the same verifier
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
            <span className={`stamp ${c7?.status === "fail" ? "red" : ""}`}>{c7?.status === "fail" ? "Rejected" : "Not caught"}</span>
            <p>
              {c7?.status === "fail" ? (
                <>
                  Check 7 failed: {c7.detail}. The impostor's chain leads to {a4.impostorRoot.name} (
                  <span className="hash" title={a4.impostorRoot.aid}>
                    {short(a4.impostorRoot.aid)}
                  </span>
                  ), not to the root this page pins (
                  <span className="hash" title={a4.pinnedRoot}>
                    {short(a4.pinnedRoot)}
                  </span>
                  ).
                </>
              ) : (
                "Check 7 did not fail — please report this."
              )}
              {cachedOn ? ` Needs a live connection — shown here: the result recorded on ${cachedOn}.` : ""}
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
              <span className={`stamp ${dry.errorName ? "red" : ""}`}>{dry.errorName ? "Rejected" : "Accepted"}</span>
              <p>
                <SourceLabel source="sepolia" /> A new registration from the impostor now, as a dry run:{" "}
                {dry.errorName ? (
                  <>
                    reverted <code>{dry.errorName}</code> — {revertText(dry.errorName, dry.args)}
                  </>
                ) : (
                  "the contract would accept it."
                )}
                {dry.cached ? " (recorded result; needs a live connection)" : ""}
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
  const [out, setOut] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState("");
  const a3 = data.attacks.attack3;
  const a4 = data.attacks.attack4;
  const reg = data.txs.find((t) => t.step === "registerReport1");
  const waiting = !reader && !offline;
  const revoke = data.txs.find((t) => t.step === "revokeAuditor");

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
            ? { stamp: "Rejected", text: `Check 2 failed: ${CODE_TEXT.DISCLOSURE_TAMPERED}` }
            : { stamp: "Not caught", text: "Check 2 did not fail — please report this." },
      }));
    } catch (e) {
      setOut((o) => ({ ...o, a1: { stamp: "Error", text: (e as Error).message } }));
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
          ? { stamp: "Rejected", text: `Needs a live connection — shown here: the result recorded on ${data.cached?.time.slice(0, 10)}. Reverted: ${c.errorName} — ${revertText(c.errorName, c.args)}` }
          : { stamp: "Offline", text: "Needs a live connection." },
      }));
      return;
    }
    setBusy(id);
    const [reportKey, batchKey, qty, commit] = spec.args;
    const r = await reader.dryRun("claimShipment", [reportKey, batchKey, BigInt(qty), commit], spec.caller);
    setBusy("");
    setOut((o) => ({
      ...o,
      [id]: r.reverted
        ? { stamp: "Rejected", text: `Reverted: ${r.errorName} — ${revertText(r.errorName, r.args)}` }
        : { stamp: "Accepted", text: "The contract would accept this claim." },
    }));
  }

  const Result = ({ id }: { id: string }) => {
    const r = out[id];
    if (!r) return null;
    return (
      <div className="attack-result" role="status">
        <span className={`stamp ${r.stamp === "Rejected" ? "red" : ""}`}>{r.stamp}</span>
        <p>{r.text}</p>
      </div>
    );
  };

  return (
    <>
      <TabHead
        title="Try to break it"
        lede={`${a4 ? "Four" : "Three"} attacks. Each one says how it is checked: in your browser, as a dry run against the live contract, or as a real transaction recorded on Sepolia.`}
      />
      {waiting && (
        <p className="conn" role="status">
          Connecting to Sepolia… the attack buttons unlock when the connection is ready.
        </p>
      )}
      <section className="sheet reveal" aria-label="Attacks">
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

        <div className="attack">
          <div>
            <h3>2b · The supplier claims {data.attacks.secondImporter.quantityTonnes} t more for a second importer</h3>
            <div className="how">Dry run against the live Sepolia contract (eth_call) — no private key</div>
            <p className="fine">
              Only {data.report.verifiedTonnes} t were verified and {data.shipment.quantityTonnes} t are already claimed. The
              ledger is shared by every importer.
            </p>
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
              <span className="stamp red">Rejected</span>
              <p>
                Reverted: <code>AuditorNotAuthorized</code> — {revertText("AuditorNotAuthorized")} The report registered
                before the revocation sync stays valid on-chain.
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
      </section>
    </>
  );
}
