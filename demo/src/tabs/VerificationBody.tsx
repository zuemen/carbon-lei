import { useState } from "react";
import { domainOf } from "../../../sdk/eip712.ts";
import { useApp } from "../App.tsx";
import { TabHead, TxLink } from "../components.tsx";
import { revertText } from "../messages.ts";

export function VerificationBody() {
  const { data, reader, offline } = useApp();
  const [dry, setDry] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const reg = data.txs.find((t) => t.step === "registerReport1");
  const core = JSON.parse(data.credential.coreJson);
  const domain = domainOf(data.deployment.contracts.EmissionsClaimRegistry.address, data.network.chainId);

  async function dryRevoke() {
    if (!reader || offline) {
      setDry("Needs a live connection to Sepolia.");
      return;
    }
    setBusy(true);
    const r = await reader.dryRun("revokeReport", [data.credential.reportKey], data.addresses.body);
    setBusy(false);
    setDry(
      r.reverted
        ? `Dry run: the contract would reject this — ${revertText(r.errorName, r.args)} (${r.errorName}). Nothing was written on-chain.`
        : "Dry run: the contract would accept this revocation from the issuing verification body. Nothing was written on-chain.",
    );
  }

  return (
    <>
      <TabHead
        title="Issue a verified emissions report"
        lede="The verification body issues the report here. To check a report, use the Buyer tab."
      />
      <div className="grid-2">
        <section className="sheet reveal" aria-labelledby="rep-h">
          <p className="sheet-kicker" id="rep-h">
            Pre-filled demo report (fictional)
          </p>
          <dl className="fields">
            <dt>Installation</dt>
            <dd>
              {data.report.installationName} · {data.report.installationId}
            </dd>
            <dt>CN code</dt>
            <dd>{data.report.cnCode}</dd>
            <dt>Reporting period</dt>
            <dd>{data.report.reportingPeriod}</dd>
            <dt>Verified quantity (t)</dt>
            <dd>{data.report.verifiedTonnes}</dd>
            <dt>Specific direct embedded emissions (tCO2e/t)</dt>
            <dd>
              {data.report.intensity} <span className="tag-illustrative">illustrative</span>
            </dd>
            <dt>Verification report ID</dt>
            <dd>{data.report.reportId}</dd>
            <dt>Accreditation number</dt>
            <dd>{data.report.accreditationNumber}</dd>
          </dl>
        </section>

        <section className="sheet reveal" aria-labelledby="steps-h">
          <p className="sheet-kicker" id="steps-h">
            These steps were run once to set up this demo
          </p>
          <p className="fine">Local mode lets you run them yourself.</p>
          <ul className="done-steps">
            <li>
              ✓ Signed (EIP-712) —{" "}
              <details style={{ display: "inline-block" }}>
                <summary>view signature</summary>
                <pre>
                  {JSON.stringify(
                    { domain, credSAID: core.d, signer: core.issuer.verifierAddress, signature: data.credential.signature },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </li>
            <li>
              ✓ Anchored in the auditor's signed history (KERI event #{data.credential.kelSeq}) —{" "}
              {data.evidence.anchor ? (
                <a href={`${import.meta.env.BASE_URL}${data.evidence.anchor}`}>view event</a>
              ) : (
                <span className="fine">event evidence not exported yet</span>
              )}
            </li>
            <li>✓ Registered on Sepolia — {reg ? <TxLink hash={reg.hash} label="view transaction" /> : "not recorded"}</li>
          </ul>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={dryRevoke}>
              Revoke report (dry run — shows the contract's response, no key)
            </button>
          </div>
          {dry && (
            <p className="fine" role="status">
              {dry}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
