import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { selectDisclosures, type Presentation } from "../../../sdk/disclosure.ts";
import { decodeDisclosure } from "../../../sdk/disclosure.ts";
import { DEMO_DISCLOSURE } from "../../../sdk/issue.ts";
import { REQUIRED_DISCLOSURES } from "../../../sdk/credential.ts";
import { useApp } from "../App.tsx";
import { fmt, TabHead, TxLink } from "../components.tsx";
import { kgToT } from "../messages.ts";
import { short } from "../data.ts";
// The template panel renders when opened; the importer and the spreadsheet reader load only when a file is read.
import { TemplateImport } from "./TemplateImport.tsx";

const LABELS: Record<string, string> = {
  supplierLEI: "Supplier LEI",
  operatorId: "Operator ID",
  installationId: "Installation ID",
  installationName: "Installation name",
  unLocode: "UN/LOCODE",
  cnCode: "CN code",
  cbamRoute: "Production route code",
  productionRoute: "Process route",
  reportingPeriod: "Reporting period",
  verifiedTonnes: "Verified quantity (t)",
  specificEmbeddedEmissions_tCO2e_per_t: "Emissions intensity (tCO2e/t)",
  valueType: "Value type",
  methodologyNote: "Methodology note",
  verificationReportId: "Verification report ID",
  verifierLEI: "Verification body LEI",
  accreditationNumber: "Accreditation number",
  nabName: "Accreditation body",
  siteVisit: "Site visit",
  assuranceLevel: "Assurance level",
  materialityThreshold: "Materiality threshold",
  energyMix: "Energy mix",
  supplierCost: "Supplier cost",
  idSalt: "Identity salt",
  batchSalt: "Batch salt",
  issuedAt: "Issued at",
  validUntil: "Valid until",
};

export function Supplier() {
  const { data, reader, offline, setProofText, go } = useApp();
  const allNames = useMemo(() => Object.keys(data.credential.disclosures), [data]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(DEMO_DISCLOSURE));
  const [proof, setProof] = useState<Presentation | null>(null);
  const [qr, setQr] = useState("");
  const [remaining, setRemaining] = useState<bigint | null>(null);
  const [state, setState] = useState<"valid" | "revoked" | "replaced" | "unknown">("unknown");
  const [templateOpen, setTemplateOpen] = useState(false);

  const verifiedKg = BigInt(Math.round(Number(data.report.verifiedTonnes) * 1000));
  const claimTx = data.txs.find((t) => t.step === "claim1");
  const passportUrl = `https://zuemen.github.io/carbon-lei/#buyer?said=${encodeURIComponent(JSON.parse(data.credential.coreJson).d)}&batch=${encodeURIComponent(data.shipment.batchId)}`;

  useEffect(() => {
    if (offline && data.cached) {
      setRemaining(BigInt(data.cached.remainingKg));
      setState(data.cached.reportValid ? "valid" : "unknown");
      return;
    }
    if (!reader) return;
    let live = true;
    (async () => {
      const [rem, rep, valid] = await Promise.all([
        reader.remainingKg(data.credential.reportKey),
        reader.report(data.credential.reportKey),
        reader.isValidAt(data.credential.reportKey, await reader.latestTimestamp()),
      ]);
      if (!live) return;
      setRemaining(rem);
      setState(rep.revokedAt !== 0n ? "revoked" : rep.supersededBy !== `0x${"0".repeat(64)}` ? "replaced" : valid ? "valid" : "unknown");
    })().catch(() => setState("unknown"));
    return () => {
      live = false;
    };
  }, [reader, offline, data]);

  useEffect(() => {
    QRCode.toDataURL(passportUrl, { margin: 1, width: 264, color: { dark: "#1e2420", light: "#fffdf8" } }).then(setQr, () => setQr(""));
  }, [passportUrl]);

  const claimed = remaining === null ? null : verifiedKg - remaining;
  const pct = claimed === null ? 0 : Number((claimed * 1000n) / verifiedKg) / 10;

  function create() {
    const names = allNames.filter((n) => chosen.has(n));
    const p: Presentation = {
      core: data.credential.coreJson,
      signature: data.credential.signature,
      disclosures: selectDisclosures(data.credential.disclosures, names),
      shipment: data.shipment,
      ...(data.proof.anchorEvidence ? { anchorEvidence: data.proof.anchorEvidence } : {}),
      ...(data.proof.authorityEvidence ? { authorityEvidence: data.proof.authorityEvidence } : {}),
      ...(data.proof.reportExtract ? { reportExtract: data.proof.reportExtract } : {}),
    };
    setProof(p);
  }

  return (
    <>
      <TabHead title="Claim a shipment against the report" lede="The supplier — here a fictional screw maker in Kaohsiung — claims part of its verified tonnage for one importer, then chooses what that importer may see." />
      <div className="grid-2">
        <section className="sheet reveal" aria-labelledby="claim-h">
          <p className="sheet-kicker" id="claim-h">
            Report {data.report.reportId} · {data.report.installationName}
          </p>
          <dl className="fields">
            <dt>Batch ID</dt>
            <dd>{data.shipment.batchId}</dd>
            <dt>Quantity (t)</dt>
            <dd>{data.shipment.quantityTonnes}</dd>
            <dt>Importer</dt>
            <dd>{data.importer.name}</dd>
          </dl>
          <p className="fine">Pre-claimed in this demo; editable in local mode.</p>
          <div className="tonnage" role="group" aria-label="Verified tonnage ledger">
            <div className="tonnage-bar" role="img" aria-label={`${pct}% of the verified tonnes claimed`}>
              <div className="tonnage-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="tonnage-legend">
              {state === "revoked" ? (
                <span>Remaining 0 t — this report was revoked</span>
              ) : state === "replaced" ? (
                <span>Remaining 0 t — replaced by a revised report</span>
              ) : (
                <>
                  <span>Verified {data.report.verifiedTonnes} t</span>
                  <span>Claimed {claimed === null ? "…" : kgToT(claimed)} t</span>
                  <span>Remaining {remaining === null ? "…" : kgToT(remaining)} t</span>
                </>
              )}
            </div>
          </div>
          {claimTx && (
            <p className="fine">
              Claimed {data.shipment.quantityTonnes} t for batch {data.shipment.batchId} → {data.importer.name} —{" "}
              <TxLink hash={claimTx.hash} label="view transaction" />
              <br />
              On-chain, the importer appears only as a hash commitment.
            </p>
          )}
        </section>

        <section className="sheet reveal" aria-labelledby="disc-h">
          <p className="sheet-kicker" id="disc-h">
            Choose what the importer can see
          </p>
          <ul className="checkbox-list">
            {allNames.map((n) => {
              const required = (REQUIRED_DISCLOSURES as readonly string[]).includes(n);
              return (
                <li key={n}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(n)}
                      disabled={required}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(n);
                        else next.delete(n);
                        setChosen(next);
                        setProof(null);
                      }}
                    />
                    <span>
                      {LABELS[n] ?? n}
                      {required ? " (required)" : ""}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={create}>
              Create the supplier's proof
            </button>
            {proof && (
              <button
                className="btn"
                onClick={() => {
                  setProofText(JSON.stringify(proof, null, 2), true);
                  go("buyer");
                }}
              >
                Use this proof in the Buyer tab →
              </button>
            )}
          </div>
          {proof && (
            <details style={{ marginTop: 12 }}>
              <summary>Supplier's proof (JSON) — {proof.disclosures.length} fields disclosed</summary>
              <pre>{JSON.stringify(proof, null, 2)}</pre>
            </details>
          )}
        </section>
      </div>

      <section className="sheet reveal" aria-labelledby="pp-h" style={{ marginTop: 28 }}>
        <p className="sheet-kicker" id="pp-h">
          Product passport card (demo) — a data carrier a product passport could reference · not an ESPR passport
        </p>
        <div className="passport">
          <dl className="fields">
            <dt>CN</dt>
            <dd>{data.report.cnCode}</dd>
            <dt>Verified intensity</dt>
            <dd>
              {data.report.intensity} tCO2e/t <span className="tag-illustrative">illustrative</span>
            </dd>
            <dt>Verification body LEI</dt>
            <dd>{decodeDisclosure(data.credential.disclosures.verifierLEI).value}</dd>
            <dt>Status</dt>
            <dd>{state === "valid" ? "✓ Valid" : state === "revoked" ? "✕ Revoked" : state === "replaced" ? "✕ Replaced" : "…"}</dd>
            <dt>Credential</dt>
            <dd>{short(JSON.parse(data.credential.coreJson).d, 10, 6)}</dd>
          </dl>
          <div>
            {qr && <img src={qr} alt="QR code: scan to verify on the hosted page" />}
            <p className="fine" style={{ textAlign: "center", margin: "4px 0 0" }}>
              Scan to verify
            </p>
            <p className="fine" style={{ textAlign: "center", margin: "2px 0 0" }}>
              On a desktop? <a href={passportUrl.slice(passportUrl.indexOf("#"))}>Open the same link here</a>
            </p>
          </div>
        </div>
        <p className="fine">
          {fmt(Number(data.report.verifiedTonnes))} t verified for {data.report.reportingPeriod}. We do not claim
          conformance with ESPR or with any digital product passport specification.
        </p>
      </section>

      <details
        id="template-import"
        className="sheet pvv"
        onToggle={(e) => setTemplateOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Start from the Commission's Communication Template (official example)</summary>
        {templateOpen && <TemplateImport labels={LABELS} />}
      </details>
    </>
  );
}
