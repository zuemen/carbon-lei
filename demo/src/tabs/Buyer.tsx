import { useEffect, useRef, useState } from "react";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../../../sdk/disclosure.ts";
import { verifyPresentation, type CheckResult, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, fmt, SourceLabel, TabHead, TxLink, type BadgeKind, type Source } from "../components.tsx";
import { comparisonFigures } from "../data.ts";
import { CODE_TEXT } from "../messages.ts";
import { evidenceCheckers } from "../evidence.ts";

const CHECKS: { n: number; text: string; source: Source }[] = [
  { n: 1, text: "The credential has not been altered since it was issued (its content hash matches its ID)", source: "browser" },
  { n: 2, text: "No disclosed field was changed", source: "browser" },
  { n: 3, text: "Signed by the registered verification body", source: "sepolia" },
  { n: 4, text: "The report is registered, valid for this shipment, and issued by this verification body and auditor", source: "sepolia" },
  { n: 5, text: "This batch was claimed for you, for this quantity", source: "sepolia" },
  {
    n: 6,
    text: "The auditor recorded this report in their own signed history (KERI key event log) — signature re-checked live in your browser",
    source: "browser",
  },
  { n: 7, text: "The auditor is authorised by an accredited verification body", source: "evidence" },
  {
    n: 8,
    text: "The report matches the signed credential (rule-based check, covered by the auditor's signature) — advisory: a mismatch flags the report for human review, it does not fail the check list",
    source: "advisory",
  },
];

export function kindOf(c?: CheckResult): BadgeKind {
  if (!c) return "idle";
  if (c.status === "fail") return "fail";
  if (c.status === "warn" || c.code === "CONTESTED") return "review";
  if (c.status === "skipped") return "skip";
  return "pass";
}

/** Replaces the disclosed emissions intensity with another value (the "Tamper" action and attack 1). */
export function tamperedProof(p: Presentation, value = "1.2"): Presentation {
  return {
    ...p,
    disclosures: p.disclosures.map((d) => {
      const x = decodeDisclosure(d);
      return x.name === "specificEmbeddedEmissions_tCO2e_per_t" ? encodeDisclosure({ ...x, value }) : d;
    }),
  };
}

/** Scrolls an element to just below the sticky tab bar (its height depends on the screen width). */
function scrollBelowTabbar(el: HTMLElement) {
  const bar = document.querySelector(".tabbar")?.getBoundingClientRect().height ?? 0;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - bar - 12, behavior: smooth ? "smooth" : "auto" });
}

/** One line under the Verify button: how many checks passed and, only for a valid proof, the declared-emissions gap. */
function VerifySummary({ result, onSeeComparison }: { result: VerificationResult; onSeeComparison: () => void }) {
  const { data } = useApp();
  const f = comparisonFigures(data.comparison);
  const kinds = CHECKS.map((c) => kindOf(result.checks.find((r) => r.index === c.n)));
  const passed = kinds.filter((k) => k === "pass").length;
  const review = kinds.filter((k) => k === "review").length;
  const notRun = kinds.filter((k) => k === "skip" || k === "idle").length;
  const counts =
    `${passed} of ${CHECKS.length} checks passed` +
    (review ? `, ${review} need${review === 1 ? "s" : ""} review` : "") +
    (notRun ? `, ${notRun} not run` : "");

  if (result.overall === "INVALID") {
    const first = result.checks.find((c) => c.status === "fail");
    const what = !first || first.index === 0 ? "the proof could not be read" : `check ${first.index} failed`;
    const why = first ? (CODE_TEXT[first.code] ?? first.detail) : "";
    return (
      <p className="verify-summary bad">
        <span aria-hidden="true">✕ </span>
        <strong>Rejected — {what}</strong>
        {why ? `: ${why}` : "."} {counts}. Do not rely on this proof's value: no declared-emissions gap is shown.
      </p>
    );
  }
  if (result.overall === "CONTESTED") {
    return (
      <p className="verify-summary review">
        <span aria-hidden="true">! </span>
        <strong>Needs review</strong> — {counts}. Do not rely on the verified value until a person has reviewed the
        report: no declared-emissions gap is shown.
      </p>
    );
  }
  return (
    <p className="verify-summary ok">
      <span aria-hidden="true">✓ </span>
      <strong>{counts}</strong> · declared-emissions gap for this {fmt(f.q)} t shipment: {fmt(f.gap)} tCO2e (≈ €
      {fmt(f.eur, 0)} gross, illustrative){" "}
      <button type="button" className="link-btn" onClick={onSeeComparison}>
        See comparison ↓
      </button>
    </p>
  );
}

export function Buyer() {
  const { data, reader, offline, proofText, setProofText, proofFromSupplier, go } = useApp();
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [fromQr, setFromQr] = useState(false);
  // Bumped when a verification finishes; on narrow screens the checks are then scrolled into view.
  const [finished, setFinished] = useState(0);
  const checksRef = useRef<HTMLElement>(null);
  const cmpRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!finished || !window.matchMedia("(max-width: 600px)").matches) return;
    if (checksRef.current) scrollBelowTabbar(checksRef.current);
  }, [finished]);

  function seeComparison() {
    const el = cmpRef.current;
    if (!el) return;
    scrollBelowTabbar(el);
    el.focus({ preventScroll: true });
  }

  // The product passport QR opens #buyer?said=<credSAID>&batch=<batchId>: load the matching demo proof.
  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const said = q.get("said");
    if (!said || proofText) return;
    if (said === JSON.parse(data.proof.core).d && (!q.get("batch") || q.get("batch") === data.shipment.batchId)) {
      setProofText(JSON.stringify(data.proof, null, 2));
      setFromQr(true);
    }
  }, [data, proofText, setProofText]);

  async function run(text: string) {
    setError("");
    setAccepted(false);
    let proof: Presentation;
    try {
      proof = JSON.parse(text) as Presentation;
    } catch {
      setError("This is not a supplier's proof (not valid JSON).");
      return;
    }
    if (offline) {
      if (data.cached?.verification) {
        setResult(data.cached.verification as VerificationResult);
        setFinished((n) => n + 1);
      }
      return;
    }
    if (!reader) {
      setError("Still connecting to Sepolia — try again in a moment.");
      return;
    }
    setRunning(true);
    try {
      setResult(await verifyPresentation(proof, reader, { importerEORI: data.importer.eori, checkers: evidenceCheckers(data) }));
      setFinished((n) => n + 1);
    } catch (e) {
      setError(`Verification could not finish: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  const byIndex = new Map(result?.checks.map((c) => [c.index, c]));
  const malformed = result?.checks.find((c) => c.index === 0 && c.status === "fail");
  const cmp = data.comparison;
  const { q, dq, vq, gap, eur } = comparisonFigures(cmp);
  const claimTx = data.txs.find((t) => t.step === "claim1");

  return (
    <>
      <TabHead title="Check a supplier's proof" lede="An EU importer's compliance officer, or a downstream customer.">
        <p className="fine">
          Step 2 of 3 — the supplier's side is already done in this demo. Load the demo proof, then press Verify.
        </p>
      </TabHead>
      <div className="grid-2">
        <section className="sheet reveal" aria-labelledby="proof-h">
          <p className="sheet-kicker" id="proof-h">
            Supplier's proof for {data.importer.name}
          </p>
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setProofText(JSON.stringify(data.proof, null, 2));
                setResult(null);
                setTampered(false);
              }}
            >
              Load the demo proof
            </button>
            <button className="btn" disabled={running || !proofText || (!reader && !offline)} onClick={() => run(proofText)}>
              {running ? "Verifying…" : "Verify"}
            </button>
          </div>
          <div className="verify-summary-slot" role="status">
            {result && !running && <VerifySummary result={result} onSeeComparison={seeComparison} />}
          </div>
          {proofFromSupplier && <p className="fine">Proof loaded from the Supplier tab.</p>}
          {fromQr && <p className="fine">Proof loaded from the product passport QR code ({data.shipment.batchId}). Press Verify.</p>}
          <label className="field-label" htmlFor="proof-in">
            Paste the supplier's proof
          </label>
          <textarea
            id="proof-in"
            className="proof"
            spellCheck={false}
            placeholder={'Paste the supplier\'s proof here, or click "Load the demo proof" above.'}
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
          />
          <p className="fine">Checking as importer EORI {data.importer.eori} (fictional).</p>
          {proofText && (
            <div className="btn-row">
              <button
                className="btn btn-ghost"
                disabled={running || (!reader && !offline)}
                onClick={() => {
                  try {
                    const p = tamperedProof(JSON.parse(proofText) as Presentation);
                    const text = JSON.stringify(p, null, 2);
                    setProofText(text);
                    setTampered(true);
                    void run(text);
                  } catch {
                    setError("Load a proof first.");
                  }
                }}
              >
                Tamper with one number
              </button>
              {tampered && <span className="fine">Disclosed intensity changed from 1.8 to 1.2.</span>}
            </div>
          )}
        </section>

        <section className="sheet reveal" aria-labelledby="checks-h" ref={checksRef}>
          <p className="sheet-kicker" id="checks-h">
            Eight checks: seven verification checks plus one rule-based reconciliation check
          </p>
          <div className="legend" aria-label="Source labels">
            <span>◉ live · Sepolia = read from the contract now</span>
            <span>◎ live · your browser = recomputed on this page</span>
            <span>▤ exported evidence = from a local KERI run ({data.exportDate})</span>
            <span>≡ rule-based · advisory = can flag, never fails</span>
          </div>
          {error && (
            <p className="check-detail bad" role="alert">
              {error}
            </p>
          )}
          {malformed && (
            <p className="check-detail bad" role="alert">
              ✕ {CODE_TEXT[malformed.code] ?? malformed.code} {malformed.detail}
            </p>
          )}
          <ol className="checks" aria-live="polite">
            {CHECKS.map((c) => {
              const r = byIndex.get(c.n);
              const kind = running ? "idle" : kindOf(r);
              return (
                <li key={c.n} className="check">
                  <span className="check-num" aria-hidden="true">
                    {c.n}
                  </span>
                  <span className="check-text">
                    <span className="sr-only">Check {c.n}: </span>
                    {c.text}
                  </span>
                  <span className="check-result">
                    <Badge kind={kind} />
                  </span>
                  <span className={`check-detail ${kind === "fail" ? "bad" : ""}`}>
                    <SourceLabel source={c.source} />{" "}
                    {r && r.code ? <code>{r.code}</code> : null}
                    {r && r.code ? " — " : " "}
                    {r ? (r.code && CODE_TEXT[r.code] ? CODE_TEXT[r.code] : r.detail) : ""}
                  </span>
                </li>
              );
            })}
          </ol>
          {result && !running && (
            <div className="overall">
              {result.overall === "VALID" ? (
                <span className="stamp green">Verified</span>
              ) : result.overall === "CONTESTED" ? (
                <span className="stamp" style={{ color: "var(--amber)" }}>
                  Needs review
                </span>
              ) : (
                <span className="stamp red">Rejected</span>
              )}
              <p>
                {result.hidden} field{result.hidden === 1 ? "" : "s"} hidden by supplier.
                {result.primaryCode ? ` First failure: ${result.primaryCode}.` : ""}
              </p>
              <button className="btn btn-ghost" onClick={() => go("try-to-break-it")}>
                Try to break it →
              </button>
            </div>
          )}
        </section>
      </div>

      <section
        className="sheet reveal"
        id="comparison"
        aria-labelledby="cmp-h"
        style={{ marginTop: 28 }}
        ref={cmpRef}
        tabIndex={-1}
      >
        <p className="sheet-kicker" id="cmp-h">
          Verified value vs CBAM default
        </p>
        <div className="compare">
          <div>
            <div className="k">CBAM default (with 2026 mark-up)</div>
            <div className="v">{cmp.defaultValue} tCO2e/t</div>
            <div className="fine">For {fmt(q)} t: {fmt(dq)} tCO2e</div>
          </div>
          <div>
            <div className="k">Verified value (illustrative)</div>
            <div className="v">{cmp.verifiedValue} tCO2e/t</div>
            <div className="fine">For {fmt(q)} t: {fmt(vq)} tCO2e</div>
          </div>
        </div>
        <p className="gap-line">Declared-emissions gap: {fmt(gap)} tCO2e</p>
        <p className="fine">
          ≈ €{fmt(eur, 0)} gross at the {cmp.quarter} CBAM certificate price of €{cmp.priceEur} — illustrative, before
          free-allocation adjustment.
        </p>
        <p className="fine">A gap in what is declared, not a physical reduction.</p>
        <div className="btn-row">
          <button className="btn" onClick={() => setAccepted(true)} disabled={!result || result.overall !== "VALID"}>
            Accept verified value
          </button>
          {!result && <span className="fine">Verify the proof first.</span>}
        </div>
        {accepted && (
          <p className="fine" role="status">
            Accepted (demo). Declared {fmt(vq)} tCO2e for batch {data.shipment.batchId}. This choice stays in your browser
            — no transaction is sent. On-chain record for this batch: the supplier's claim{" "}
            {claimTx ? <TxLink hash={claimTx.hash} /> : "(not recorded)"}
          </p>
        )}
      </section>
    </>
  );
}

export { CHECKS };
