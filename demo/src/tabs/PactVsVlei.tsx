// Trust chain tab, collapsed panel: the verifier as a name field (PDF report, PACT ProductFootprint)
// next to the same verifier as a vLEI signature chain. Every value is read from the demo data and the
// exported evidence; checks 6 and 7 (the SDK's functions) are re-run in the browser when the panel opens.
import { useState } from "react";
import { sha256Hex } from "../../../sdk/checkers.ts";
import { witnessState, witnessThreshold } from "../../../sdk/kel.ts";
import { DEMO_TRUST_ANCHOR, parseCesr, verifyAnchor, verifyAuthority, type AnchorEvidence, type AuthorityEvidence } from "../../../sdk/vlei.ts";
import fixture from "../../../fixtures/demo.json";
import { useApp } from "../App.tsx";
import { short } from "../data.ts";

interface Acdc {
  d: string;
  i: string;
  a: Record<string, any>;
}

interface ChainView {
  le: Acdc;
  ecr: Acdc;
  authority: { ok: boolean; detail: string };
  anchor: { ok: boolean; detail: string; sn: number; eventSaid: string };
  witnesses: { verified: number; total: number; toad: number };
}

/** The credential an exported CESR stream is about: its last ACDC (as check 7 reads it). */
function lastAcdc(stream: string): Acdc {
  const acdcs = parseCesr(stream).filter((m) => m.ked.v.startsWith("ACDC"));
  if (!acdcs.length) throw new Error("no credential in the evidence");
  return acdcs[acdcs.length - 1].ked as Acdc;
}

export function PactVsVlei() {
  const { data } = useApp();
  const [view, setView] = useState<ChainView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const core = JSON.parse(data.proof.core);
  const extract = (data.proof.reportExtract ?? {}) as Record<string, unknown>;
  const verifierName = String(extract.verifierName ?? "");
  const companyName = fixture.entities.supplier.name;
  const qvi = data.trustChain.find((n) => n.id === "qvi");
  const root = data.trustChain.find((n) => n.id === "root");

  async function load() {
    if (view || loading) return;
    setLoading(true);
    setError("");
    try {
      const ref = data.proof.authorityEvidence as { bundle: string; sha256: string };
      const res = await fetch(`${import.meta.env.BASE_URL}${ref.bundle}`);
      if (!res.ok) throw new Error(`evidence file not found (HTTP ${res.status})`);
      const text = await res.text();
      if (sha256Hex(text) !== ref.sha256.toLowerCase()) throw new Error("the authority evidence file does not match its hash in the proof");
      const bundle = JSON.parse(text) as AuthorityEvidence;
      const authority = verifyAuthority(bundle, {
        trustAnchor: DEMO_TRUST_ANCHOR,
        auditorAID: core.issuer.auditorAID,
        verifierLEI: core.issuer.verifierLEI,
        cnCode: data.report.cnCode,
      });
      const ev = data.proof.anchorEvidence as AnchorEvidence;
      const anchor = verifyAnchor(ev, { credSAID: core.d, auditorAID: core.issuer.auditorAID, kelSeq: BigInt(data.credential.kelSeq) });
      const event = JSON.parse(ev.event.raw);
      const est = JSON.parse(ev.establishmentRaw ?? "{}");
      const wit = witnessState(est);
      const witnesses =
        typeof wit === "string"
          ? { verified: 0, total: 0, toad: 0 }
          : {
              verified: witnessThreshold([{ raw: ev.event.raw, ked: event, atc: ev.kelAttachment ?? undefined }], wit).verified,
              total: wit.wits.length,
              toad: wit.toad,
            };
      setView({
        le: lastAcdc(bundle.cesr.leBody),
        ecr: lastAcdc(bundle.cesr.ecr),
        authority,
        anchor: { ...anchor, sn: parseInt(event.s, 16), eventSaid: event.d },
        witnesses,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const mark = (ok: boolean) => <span className={`badge ${ok ? "pass" : "fail"}`}>{ok ? "✓ Verified" : "✕ Failed"}</span>;

  return (
    <details
      className="sheet pvv"
      id="name-vs-chain"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary>What a name field shows vs what a signature chain shows</summary>
      <p className="pvv-lede">
        The same verification body, written two ways. PACT carries the footprint data; it is not designed to prove who
        the provider is. A vLEI chain adds that. Values below are read from this page's demo data and evidence (all
        fictional).
      </p>
      <div className="pvv-grid">
        <section className="pvv-col" aria-labelledby="pvv-left">
          <h3 id="pvv-left">As a name field: PDF report or PACT ProductFootprint</h3>
          <ul className="pvv-rows">
            <li>
              <span className="pvv-label">Verification report (PDF), verifier</span>
              <span className="pvv-value">"{verifierName}"</span>
              <span className="pvv-note">text on a page</span>
            </li>
            <li>
              <span className="pvv-label">
                PACT v3.0.3 <code>pcf.verification.providerName</code>
              </span>
              <span className="pvv-value">"{verifierName}"</span>
              <span className="pvv-note">type string, optional</span>
            </li>
            <li>
              <span className="pvv-label">
                PACT v3.0.3 <code>companyName</code> (the supplier)
              </span>
              <span className="pvv-value">"{companyName}"</span>
              <span className="pvv-note">type non-empty string</span>
            </li>
          </ul>
          <p className="pvv-text">
            The ProductFootprint schema has no signature field, and PACT's API authenticates the connection between
            partners (OAuth 2.0 client credentials), not the document. So PACT itself does not sign who the provider
            is: any name typed into <code>providerName</code>, for example "{data.impostor.name}", is equally valid
            against the schema.
          </p>
        </section>
        <section className="pvv-col" aria-labelledby="pvv-right">
          <h3 id="pvv-right">As a signature chain: the same verifier in CarbonLEI</h3>
          {loading && <p className="pvv-text">Re-checking the evidence in your browser…</p>}
          {error && (
            <p className="pvv-text pvv-error" role="alert">
              ✕ The evidence could not be checked: {error}
            </p>
          )}
          {view && (
            <>
              <ol className="pvv-steps">
                <li>
                  <span className="pvv-label">1 · LE vLEI (legal entity)</span>
                  <span className="pvv-value">LEI {view.le.a.LEI}</span>
                  <span className="pvv-note">
                    issued by {qvi?.name ?? "the QVI"} to AID {short(view.le.a.i, 8, 6)} · credential {short(view.le.d, 8, 6)}
                  </span>
                  {mark(view.authority.ok)}
                </li>
                <li>
                  <span className="pvv-label">2 · ECR vLEI (role)</span>
                  <span className="pvv-value">
                    {view.ecr.a.engagementContextRole}, {view.ecr.a.personLegalName}
                  </span>
                  <span className="pvv-note">
                    issued by AID {short(view.ecr.i, 8, 6)} (the LE holder above) to AID {short(view.ecr.a.i, 8, 6)} ·
                    credential {short(view.ecr.d, 8, 6)}
                  </span>
                  {mark(view.authority.ok)}
                </li>
                <li>
                  <span className="pvv-label">3 · KEL anchor</span>
                  <span className="pvv-value">auditor's key event #{view.anchor.sn}</span>
                  <span className="pvv-note">
                    event {short(view.anchor.eventSaid, 8, 6)} seals report credential {short(core.d, 8, 6)}; Ed25519
                    signature checked with the key from the auditor's inception event
                  </span>
                  {mark(view.anchor.ok)}
                </li>
                <li>
                  <span className="pvv-label">4 · Witnesses</span>
                  <span className="pvv-value">
                    witnesses {view.witnesses.verified}/{view.witnesses.total}
                  </span>
                  <span className="pvv-note">
                    receipts on the anchor event that verify (threshold {view.witnesses.toad})
                  </span>
                  {mark(view.witnesses.total > 0 && view.witnesses.verified >= view.witnesses.toad)}
                </li>
              </ol>
              <p className="pvv-text">
                Re-checked in your browser when this panel opened (the SDK code of checks 6 and 7, up to the pinned root,{" "}
                {root?.name ?? "simulated root"}). The checks compare LEIs, AIDs and signatures, not names. Evidence
                exported {data.exportDate}; witnesses are not queried. The auditor's ECR was revoked later (attack 3).
              </p>
            </>
          )}
        </section>
      </div>
      <p className="fine">
        CarbonLEI's PACT export keeps the verifier's LEI, the auditor's AID and the KEL sequence number in a declared
        extension (docs/PACT_MAPPING.md).
      </p>
    </details>
  );
}
