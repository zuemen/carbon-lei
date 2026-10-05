import { useState } from "react";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../../../sdk/disclosure.ts";
import { verifyPresentation, type CheckResult, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, fmt, SourceLabel, TabHead, TxLink, type BadgeKind, type Source } from "../components.tsx";
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

export function Buyer() {
  const { data, reader, offline, proofText, setProofText, proofFromSupplier, go } = useApp();
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [tampered, setTampered] = useState(false);

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
      if (data.cached?.verification) setResult(data.cached.verification as VerificationResult);
      return;
    }
    if (!reader) {
      setError("Still connecting to Sepolia — try again in a moment.");
      return;
    }
    setRunning(true);
    try {
      setResult(await verifyPresentation(proof, reader, { importerEORI: data.importer.eori, checkers: evidenceCheckers(data) }));
    } catch (e) {
      setError(`Verification could not finish: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  const byIndex = new Map(result?.checks.map((c) => [c.index, c]));
  const malformed = result?.checks.find((c) => c.index === 0 && c.status === "fail");
  const cmp = data.comparison;
  const q = Number(cmp.quantityTonnes);
  const dq = Number(cmp.defaultValue) * q;
  const vq = Number(cmp.verifiedValue) * q;
  const gap = dq - vq;
  const eur = gap * Number(cmp.priceEur);
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
            Supplier's proof · {data.importer.name}
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
          {proofFromSupplier && <p className="fine">Proof loaded from the Supplier tab.</p>}
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

        <section className="sheet reveal" aria-labelledby="checks-h">
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

      <section className="sheet reveal" aria-labelledby="cmp-h" style={{ marginTop: 28 }}>
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
