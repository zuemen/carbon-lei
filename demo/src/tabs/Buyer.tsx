import { Fragment, useEffect, useRef, useState } from "react";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../../../sdk/disclosure.ts";
import { exportPactFromProof, type PactProduct } from "../../../sdk/pact.ts";
import { disclosureCounts } from "../../../sdk/summary.ts";
import { verifyOffline, verifyPresentation, type CheckResult, type VerificationResult } from "../../../sdk/verify.ts";
import fixture from "../../../fixtures/demo.json";
import { scrollBelowTabbar, useApp } from "../App.tsx";
import { Badge, fmt, SourceLabel, TabHead, TxLink, type BadgeKind, type Source } from "../components.tsx";
import { comparisonFigures, proofComparison, whatIfFigures, type DemoData } from "../data.ts";
import { CODE_TEXT } from "../messages.ts";
import { evidenceCheckers, prefetchEvidence } from "../evidence.ts";
import { CheckSources } from "./CheckSources.tsx";

const CHECKS: { n: number; text: string; source: Source }[] = [
  { n: 1, text: "The credential has not been altered since it was issued (its content hash matches its ID)", source: "browser" },
  { n: 2, text: "No disclosed field was changed", source: "browser" },
  { n: 3, text: "Signed by the issuer address named in the credential (whether that address is registered is check 4)", source: "browser" },
  { n: 4, text: "The report is registered, valid for this shipment, and issued by this verification body and auditor", source: "sepolia" },
  { n: 5, text: "This batch was claimed for you, for this quantity", source: "sepolia" },
  {
    n: 6,
    text: "The auditor recorded this report in their own signed history (KERI key event log) — signature re-checked in your browser from the exported event; witnesses are not queried",
    source: "browser",
  },
  { n: 7, text: "The auditor is authorised by an accredited verification body", source: "evidence" },
  {
    n: 8,
    text: "The report matches the signed credential (rule-based check, covered by the auditor's signature) — advisory: a mismatch flags the report for human review, it does not fail the check list",
    source: "advisory",
  },
];

/**
 * The text shown for a check: the plain-language text of its code, else its detail. CONTESTED has several
 * reasons (SECURITY §4.2); the code's text describes the revocation-sync one, so any other reason shows its detail.
 */
function checkText(r: CheckResult): string {
  if (r.code === "CONTESTED" && !/; revoked or suspended within [\d.]+ h after$/.test(r.detail)) {
    return `Needs human review: ${r.detail}`;
  }
  return r.code && CODE_TEXT[r.code] ? CODE_TEXT[r.code] : r.detail;
}

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

/**
 * Product fields of the PACT export: the same arguments as the `carbonlei export-pact` example in
 * docs/PACT_MAPPING.md section 4, so the browser and the CLI produce the same file (only `created` differs).
 */
const PACT_PRODUCT: PactProduct = {
  companyName: fixture.entities.supplier.name,
  productNameCompany: fixture.product.productNameCompany,
  productDescription: `${fixture.product.description} — CBAM direct embedded emissions only, not a full PCF (illustrative)`,
  productId: "hex-bolt-m10",
};

/** Saves a JSON file built in the browser. */
function saveJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const eur2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * "What if" control in the comparison card: the same price and quantity as the card, for a hypothetical
 * verified intensity. Never changes the proof or the verified figures above it.
 */
function WhatIf({ cmp }: { cmp: DemoData["comparison"] }) {
  const verified = Number(cmp.verifiedValue);
  const def = Number(cmp.defaultValue);
  const min = Math.min(1, verified);
  // Steps of 0.1 from the minimum; the last step stands for the CBAM default itself.
  const max = Math.ceil(def * 10) / 10;
  const [pos, setPos] = useState(verified);
  const x = Math.min(pos, def);
  const { gapPerT, eurPerT, eurShipment, eurPerTenth } = whatIfFigures(cmp, x);
  const q = Number(cmp.quantityTonnes);
  const label = x === def ? `${fmt(x, 3)} (the CBAM default)` : fmt(x, 3);
  return (
    <div className="whatif" role="group" aria-labelledby="whatif-h">
      <p className="whatif-head" id="whatif-h">
        <span aria-hidden="true">◇ </span>What a lower verified intensity is worth <span className="tag-hypo">Hypothetical</span>
      </p>
      <label className="whatif-label" htmlFor="whatif-range">
        What if the verified value were <strong>{label}</strong> tCO2e/t?
      </label>
      <input
        id="whatif-range"
        className="whatif-range"
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={pos}
        aria-valuetext={`${label} tCO2e per tonne, hypothetical`}
        onChange={(e) => setPos(Math.round(Number(e.target.value) * 10) / 10)}
      />
      <div className="whatif-scale fine" aria-hidden="true">
        <span>{min.toFixed(1)}</span>
        <span>{fmt(def, 3)} = CBAM default</span>
      </div>
      <p className="fine">
        Starts at this proof's verified value ({cmp.verifiedValue}). Moving it changes nothing in the proof or in the
        figures above.
      </p>
      <dl className="whatif-out" aria-live="polite" aria-atomic="true">
        <div>
          <dt>Declared-emissions gap per tonne of goods</dt>
          <dd>{fmt(gapPerT, 3)} tCO2e</dd>
        </div>
        <div>
          <dt>Gross € value per tonne of goods</dt>
          <dd>€{eur2(eurPerT)}</dd>
        </div>
        <div>
          <dt>Gross € value of this {fmt(q)} t shipment</dt>
          <dd>€{fmt(eurShipment, 0)}</dd>
        </div>
      </dl>
      <p className="fine">
        Same {cmp.quarter} CBAM certificate price (€{cmp.priceEur}) and quantity as above — gross, illustrative,
        before free-allocation adjustment.
      </p>
      <p className="whatif-rate">
        At this certificate price, each <strong>0.1 tCO2e/t</strong> of verified intensity accounts for about{" "}
        <strong>€{eur2(eurPerTenth)} per tonne of goods</strong> (gross, illustrative).
      </p>
      <p className="whatif-point">
        That value depends on the buyer trusting who signed the verified value and that its tonnes were not claimed
        before — what the checks above answer. Who captures it is a commercial matter between buyer and producer. CarbonLEI does not measure or change
        emissions: any physical effect depends on producers acting on that value, and this demo does not quantify it.
      </p>
    </div>
  );
}

/**
 * One line under the Verify button: how many checks passed and, only for a valid proof, the declared-emissions gap
 * computed from that proof (`cmp`, null when it has nothing to compare).
 */
function VerifySummary({
  result,
  cmp,
  onSeeComparison,
}: {
  result: VerificationResult;
  cmp: DemoData["comparison"] | null;
  onSeeComparison: () => void;
}) {
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
  if (result.overall === "INCOMPLETE") {
    return (
      <p className="verify-summary review">
        <span aria-hidden="true">! </span>
        <strong>Not verified — checks 4–8 were not run</strong> — {counts}. They need a live connection to Sepolia. Do
        not rely on this proof's value: no declared-emissions gap is shown.
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
  const f = cmp ? comparisonFigures(cmp) : null;
  return (
    <p className="verify-summary ok">
      <span aria-hidden="true">✓ </span>
      <strong>{counts}</strong> ·{" "}
      {f ? (
        <>
          declared-emissions gap for this {fmt(f.q)} t shipment: {fmt(f.gap)} tCO2e (gross, illustrative)
        </>
      ) : (
        <>verified intensity {result.disclosed.specificEmbeddedEmissions_tCO2e_per_t ?? "not disclosed"} tCO2e/t</>
      )}{" "}
      <button type="button" className="link-btn" onClick={onSeeComparison}>
        See comparison ↓
      </button>
    </p>
  );
}

const SUMMARY_FIELDS: [string, string, string][] = [
  ["cnCode", "CN code", ""],
  ["specificEmbeddedEmissions_tCO2e_per_t", "Verified intensity", " tCO2e/t"],
  ["verifiedTonnes", "Verified quantity", " t"],
  ["reportingPeriod", "Reporting period", ""],
  ["verifierLEI", "Verification body LEI", ""],
];

/** What a pasted proof says, in words, before anyone reads the JSON. Nothing here is checked yet. */
function ProofSummary({ text }: { text: string }) {
  const fields: Record<string, string> = {};
  let disclosed = 0;
  let total = 0;
  let batch = "";
  try {
    const p = JSON.parse(text) as Presentation;
    const core = JSON.parse(p.core) as { digests?: unknown[] };
    for (const d of p.disclosures ?? []) {
      try {
        const x = decodeDisclosure(d);
        fields[x.name] = x.value;
      } catch {
        // a malformed field is reported by check 2
      }
    }
    disclosed = (p.disclosures ?? []).length;
    total = Array.isArray(core.digests) ? core.digests.length : 0;
    batch = p.shipment ? `${p.shipment.batchId} · ${p.shipment.quantityTonnes} t` : "";
  } catch {
    return null;
  }
  return (
    <div className="proof-summary" role="group" aria-label="What this proof states (not yet checked)">
      <dl className="fields">
        {SUMMARY_FIELDS.filter(([k]) => fields[k] !== undefined).map(([k, label, unit]) => (
          <Fragment key={k}>
            <dt>{label}</dt>
            <dd>
              {fields[k]}
              {unit}
            </dd>
          </Fragment>
        ))}
        {batch && (
          <>
            <dt>Shipment</dt>
            <dd>{batch}</dd>
          </>
        )}
      </dl>
      <p className="fine">
        {disclosed} field{disclosed === 1 ? "" : "s"} disclosed{total > disclosed ? ` · ${total - disclosed} hidden by the supplier` : ""} ·
        what the proof states, not yet checked. Raw JSON below.
      </p>
    </div>
  );
}

export function Buyer() {
  const { data, reader, offline, proofText, setProofText, proofFromSupplier, go, explorer, demoVerify, setDemoVerify } = useApp();
  // The last verification: the text it read, that text's proof and the result. It is shown only while the text box
  // still holds that same text, so editing, loading or tampering never leaves an earlier result on screen.
  const [verified, setVerified] = useState<{ text: string; proof: Presentation; result: VerificationResult; cached: boolean } | null>(null);
  const current = verified && verified.text === proofText ? verified : null;
  const result = current?.result ?? null;
  const [running, setRunning] = useState(false);
  // Verify has waited more than about 3 s for the chain: a progress line is shown until it finishes.
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [tampered, setTampered] = useState(false);
  const [fromQr, setFromQr] = useState(false);
  // The proof behind `result`; used by the PACT export and the verification record.
  const checked = current?.proof ?? null;
  const [pactBusy, setPactBusy] = useState(false);
  const [pactError, setPactError] = useState("");
  // Bumped when a verification finishes; on narrow screens the summary line under Verify is then scrolled into view.
  const [finished, setFinished] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const cmpRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!finished || !window.matchMedia("(max-width: 600px)").matches) return;
    if (summaryRef.current) scrollBelowTabbar(summaryRef.current);
  }, [finished]);

  function seeComparison() {
    const el = cmpRef.current;
    if (!el) return;
    scrollBelowTabbar(el);
    el.focus({ preventScroll: true });
  }

  // A proof in the box (loaded, pasted, from the Supplier tab or the QR code): fetch its evidence file now,
  // so Verify does not wait for the download. Verify still checks the file's hash against the proof.
  useEffect(() => {
    try {
      prefetchEvidence((JSON.parse(proofText) as Presentation).authorityEvidence);
    } catch {
      // not a proof (yet); Verify reports it
    }
  }, [proofText]);

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

  // "Verify the demo proof" on the first screen put the demo proof in the box: verify it once the chain is
  // reachable (or the cached view is chosen). Any other text in the box by then cancels the request.
  useEffect(() => {
    if (!demoVerify || running || (!reader && !offline)) return;
    setDemoVerify(false);
    if (proofText !== JSON.stringify(data.proof, null, 2)) return;
    setAccepted(false);
    setTampered(false);
    void run(proofText);
  }, [demoVerify, running, reader, offline, proofText]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(text: string) {
    setError("");
    setAccepted(false);
    setPactError("");
    let proof: Presentation;
    try {
      proof = JSON.parse(text) as Presentation;
    } catch {
      setError("This is not a supplier's proof (not valid JSON).");
      return;
    }
    if (offline) {
      // The cached result belongs to the demo proof only: it is shown for that exact text (as "Load the demo proof"
      // puts it in the box). Any other text gets checks 0-3 in this browser, under the deployment's signing domain;
      // checks 4-8 need the chain, so the result is never VALID.
      if (data.cached?.verification && text === JSON.stringify(data.proof, null, 2)) {
        setVerified({ text, proof, result: data.cached.verification as VerificationResult, cached: true });
      } else {
        try {
          const r = await verifyOffline(
            proof,
            { registry: data.deployment.contracts.EmissionsClaimRegistry.address, chainId: data.network.chainId },
            { proofText: text },
          );
          setVerified({ text, proof, result: r, cached: false });
        } catch (e) {
          setError(`Verification could not finish: ${(e as Error).message}`);
          return;
        }
      }
      setFinished((n) => n + 1);
      return;
    }
    if (!reader) {
      setError("Still connecting to Sepolia — try again in a moment.");
      return;
    }
    setRunning(true);
    const slowTimer = window.setTimeout(() => setSlow(true), 3000);
    try {
      const r = await verifyPresentation(proof, reader, {
        importerEORI: data.importer.eori,
        checkers: evidenceCheckers(data),
        proofText: text,
      });
      setVerified({ text, proof, result: r, cached: false });
      setFinished((n) => n + 1);
    } catch (e) {
      setError(`Verification could not finish: ${(e as Error).message}`);
    } finally {
      window.clearTimeout(slowTimer);
      setSlow(false);
      setRunning(false);
    }
  }

  const byIndex = new Map(result?.checks.map((c) => [c.index, c]));
  const counts = result && checked ? disclosureCounts(checked, result) : null;
  const hiddenN = counts ? counts.hidden : (result?.hidden ?? 0);
  const hiddenText = `${hiddenN} field${hiddenN === 1 ? "" : "s"} hidden by supplier${counts?.rejected ? ` · ${counts.rejected} disclosure${counts.rejected === 1 ? "" : "s"} rejected` : ""}.`;
  const rejectedProof = !!result && !running && result.overall === "INVALID";
  const incomplete = !!result && !running && result.overall === "INCOMPLETE";
  // CONTESTED: the summary says no declared-emissions gap is shown, so the card shows none either.
  const contested = !!result && !running && result.overall === "CONTESTED";
  const rejectedCheck = rejectedProof ? result?.checks.find((c) => c.status === "fail") : undefined;
  const malformed = result?.checks.find((c) => c.index === 0 && c.status === "fail");
  // Before any verification the card shows the demo report's figures (illustrative); after one, the verified
  // proof's own figures, or none.
  const fromProof = result && !rejectedProof && !incomplete && !contested ? proofComparison(data.comparison, data.report.cnCode, result, checked?.shipment) : null;
  const cmp = fromProof ? fromProof.cmp : data.comparison;
  const noComparison = fromProof && !fromProof.cmp ? fromProof.why : "";
  const { q, dq, vq, gap, eur } = comparisonFigures(cmp ?? data.comparison);
  const verifiedValue = result?.disclosed.specificEmbeddedEmissions_tCO2e_per_t;
  const claimTx = data.txs.find((t) => t.step === "claim1");
  const revokeTx = data.txs.find((t) => t.step === "revokeAuditor" && t.result === "success");
  const isDemoProof = (() => {
    try {
      return !!checked && JSON.parse(checked.core).d === JSON.parse(data.proof.core).d;
    } catch {
      return false;
    }
  })();
  const batchId = checked?.shipment?.batchId ?? "";
  const acceptedNow = accepted && result?.overall === "VALID";

  // A file the importer can keep with its own records. Built in the browser from this page's checks; not signed.
  function downloadRecord() {
    if (!result || !checked) return;
    let credSAID = "";
    try {
      credSAID = JSON.parse(checked.core).d;
    } catch {
      // the checks above already reported a malformed proof
    }
    const claim = claimTx && batchId === data.shipment.batchId ? claimTx : undefined;
    const record = {
      kind: "CarbonLEI verification record (demo)",
      notice:
        "Generated in your browser from the checks below. Not signed, not a CBAM Registry document and not a CBAM declaration. All companies are fictional; emissions values are illustrative.",
      createdAt: new Date().toISOString(),
      network: {
        name: data.network.name,
        chainId: data.network.chainId,
        registry: data.deployment.contracts.EmissionsClaimRegistry.address,
      },
      credSAID,
      batchId,
      importerEORI: data.importer.eori,
      overall: result.overall,
      checks: result.checks.map(({ index, name, status, code, detail }) => ({ index, name, status, code, detail })),
      accepted: cmp
        ? { quantityTonnes: q, verifiedIntensity_tCO2e_per_t: cmp.verifiedValue, declared_tCO2e: vq }
        : { quantityTonnes: null, verifiedIntensity_tCO2e_per_t: verifiedValue ?? null, declared_tCO2e: null },
      onChainClaim: claim ? { tx: claim.hash, block: claim.block, time: claim.time, url: explorer("tx", claim.hash) } : null,
    };
    saveJson(record, `carbonlei-verification-${batchId || "record"}.json`);
  }

  // PACT v3.0.3 ProductFootprint of the verified credential, built in the browser by the SDK's export
  // (the same function as `carbonlei export-pact`). Only for a VALID result with a live connection.
  const canExportPact = result?.overall === "VALID" && !!checked && !!reader && !offline;
  async function downloadPact() {
    if (!canExportPact || !checked || !reader || !result) return;
    setPactBusy(true);
    setPactError("");
    try {
      const pf = await exportPactFromProof(checked, result, reader, PACT_PRODUCT);
      const id = checked.shipment?.batchId || (JSON.parse(checked.core) as { d: string }).d;
      saveJson(pf, `carbonlei-pact-${id}.json`);
    } catch (e) {
      setPactError(`No PACT file was created: ${(e as Error).message}`);
    } finally {
      setPactBusy(false);
    }
  }

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
                setAccepted(false);
                setTampered(false);
              }}
            >
              Load the demo proof
            </button>
            <button className="btn" disabled={running || !proofText || (!reader && !offline)} onClick={() => run(proofText)}>
              {running ? "Verifying…" : "Verify"}
            </button>
          </div>
          <div className="verify-summary-slot" role="status" ref={summaryRef}>
            {running && slow && <p className="conn">Waiting for a Sepolia node…</p>}
            {result && !running && <VerifySummary result={result} cmp={fromProof ? fromProof.cmp : null} onSeeComparison={seeComparison} />}
          </div>
          {proofFromSupplier && <p className="fine">Proof loaded from the Supplier tab.</p>}
          {fromQr && <p className="fine">Proof loaded from the product passport QR code ({data.shipment.batchId}). Press Verify.</p>}
          {proofText && <ProofSummary text={proofText} />}
          <label className="field-label" htmlFor="proof-in">
            Paste the supplier's proof
          </label>
          <textarea
            id="proof-in"
            className="proof"
            spellCheck={false}
            placeholder={'Paste the supplier\'s proof here, or click "Load the demo proof" above.'}
            value={proofText}
            onChange={(e) => {
              setProofText(e.target.value);
              setAccepted(false);
            }}
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
          <div className="legend" role="group" aria-label="Source labels">
            <span>◉ live · Sepolia = contract state read from Sepolia now</span>
            <span>◎ live · your browser = recomputed on this page (check 3 takes only the chain ID from the Sepolia node)</span>
            <span>▤ exported evidence = from a local KERI run ({data.exportDate})</span>
            <span>≡ rule-based · advisory = can flag, never fails</span>
          </div>
          {error && (
            <p className="check-detail bad" role="alert">
              {error}
            </p>
          )}
          {offline && result && !running && (
            <p className="fine" role="note">
              {current?.cached
                ? `Offline view: the result recorded for the demo proof on ${data.cached?.time.slice(0, 10)}; no check was re-run.`
                : "Offline view: checks 0–3 were recomputed in your browser; checks 4–8 need a live connection and were not run."}
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
                    {r ? checkText(r) : ""}
                  </span>
                </li>
              );
            })}
          </ol>
          {result && !running && revokeTx && isDemoProof && (
            <p className="fine">
              This report's auditor was revoked later ({revokeTx.time.slice(0, 10)}, synced on-chain in block {revokeTx.block}).
              Checks 4 and 7 both judge authority at registration time: check 4 through the contract, check 7 from the
              allowlist on Sepolia, where the auditor's revocation is dated after this report's registration. So the
              report stays valid (Try to break it, card 3).
            </p>
          )}
          {result && !running && (
            <div className="overall">
              {result.overall === "VALID" ? (
                <span className="stamp green">Verified</span>
              ) : result.overall === "CONTESTED" ? (
                <span className="stamp" style={{ color: "var(--amber)" }}>
                  Needs review
                </span>
              ) : result.overall === "INCOMPLETE" ? (
                <span className="stamp" style={{ color: "var(--amber)" }}>
                  Not verified
                </span>
              ) : (
                <span className="stamp red">Rejected</span>
              )}
              <p>
                {hiddenText}
                {result.primaryCode ? ` First failure: ${result.primaryCode}.` : ""} These checks cover who signed the value, their authority (up to this demo's simulated root of trust) and
                the tonnage claim. They do not show that the emissions figure itself is correct, and they do not replace
                the verification report or the CBAM Registry.
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
          {rejectedProof || incomplete || contested ? "CBAM default" : "Verified value vs CBAM default"}
        </p>
        <div className="compare">
          <div>
            <div className="k">CBAM default (with 2026 mark-up)</div>
            <div className="v">{data.comparison.defaultValue} tCO2e/t</div>
            {cmp && <div className="fine">For {fmt(q)} t: {fmt(dq)} tCO2e</div>}
          </div>
          {!rejectedProof && !incomplete && !contested && (
            <div>
              <div className="k">Verified value (illustrative)</div>
              <div className="v">{cmp ? cmp.verifiedValue : (verifiedValue ?? "—")} tCO2e/t</div>
              {cmp && <div className="fine">For {fmt(q)} t: {fmt(vq)} tCO2e</div>}
            </div>
          )}
        </div>
        {rejectedProof ? (
          <p className="fine no-verified-value" role="status">
            No verified value: the proof failed {rejectedCheck && rejectedCheck.index > 0 ? `check ${rejectedCheck.index}` : "the structure check"}. The
            figures from the demo report are not shown as a result.
          </p>
        ) : incomplete ? (
          <p className="fine no-verified-value" role="status">
            No verified value: checks 4–8 were not run (offline view). The figures from the demo report are not shown as
            a result.
          </p>
        ) : contested ? (
          <p className="fine no-verified-value" role="status">
            No declared-emissions gap: the report needs review (check 4: the auditor was revoked or the body suspended
            soon after registration). Do not rely on the verified value until a person has reviewed the report.
          </p>
        ) : noComparison ? (
          <p className="fine no-verified-value" role="status">
            No declared-emissions gap for this proof: {noComparison}.
          </p>
        ) : (
          <>
            <p className="gap-line">Declared-emissions gap: {fmt(gap)} tCO2e</p>
            <p className="fine">
              ≈ €{fmt(eur, 0)} gross at the {data.comparison.quarter} CBAM certificate price of €{data.comparison.priceEur} — illustrative, before
              free-allocation adjustment.
            </p>
            <p className="fine">A gap in what is declared, not a physical reduction.</p>
          </>
        )}
        <div className="btn-row">
          <button className="btn" onClick={() => setAccepted(true)} disabled={!result || result.overall !== "VALID"}>
            Accept verified value
          </button>
          {!result && <span className="fine">Verify the proof first. Accepting stays in this browser: nothing is sent to the CBAM Registry or on-chain.</span>}
        </div>
        {acceptedNow && (
          <p className="fine" role="status">
            Accepted (demo).{" "}
            {cmp ? `Declared ${fmt(vq)} tCO2e for batch ${batchId}.` : `Verified value ${verifiedValue ?? "—"} tCO2e/t${batchId ? ` for batch ${batchId}` : ""}.`}{" "}
            This choice stays in your browser — no transaction is sent. On-chain record for this batch: the supplier's
            claim{" "}
            {claimTx && batchId === data.shipment.batchId ? <TxLink hash={claimTx.hash} /> : "(not recorded)"}
          </p>
        )}
        {acceptedNow && (
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={downloadRecord}>
              Download verification record (JSON)
            </button>
            <span className="fine">For your own records: the checks, the credential ID and the on-chain claim. Not a CBAM document.</span>
          </div>
        )}
        {acceptedNow && canExportPact && (
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={() => void downloadPact()} disabled={pactBusy}>
              {pactBusy ? "Reading the on-chain record…" : "Download PACT product footprint (JSON)"}
            </button>
            <span className="fine">
              PACT data model v3.0.3, validated against the official schema in our tests. Not a conformance claim and not
              connected to any PACT network.
            </span>
          </div>
        )}
        {pactError && (
          <p className="check-detail bad" role="alert">
            ✕ {pactError}
          </p>
        )}
        {!rejectedProof && !incomplete && !contested && cmp && <WhatIf key={`${cmp.verifiedValue}/${cmp.quantityTonnes}`} cmp={cmp} />}
      </section>

      <CheckSources checks={CHECKS} />
    </>
  );
}

export { CHECKS };
