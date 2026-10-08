import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Presentation } from "../../../sdk/disclosure.ts";
import type { VerificationResult } from "../../../sdk/verify.ts";
import type { DemoData } from "../data.ts";

const OVERALL_TEXT: Record<string, string> = {
  VALID: "Verified: every check that applies passed",
  INVALID: "Rejected: a check failed",
  CONTESTED: "Needs review by a person",
  INCOMPLETE: "Not verified: checks that decide validity were not run",
};

const STATUS_TEXT: Record<string, string> = { pass: "Passed", fail: "Failed", skipped: "Not run", warn: "Warning" };

export interface ImporterFileProps {
  data: DemoData;
  result: VerificationResult;
  proof: Presentation;
  /** When this result was produced; for the offline view, when the cached result was recorded. */
  verifiedAt: string;
  cached: boolean;
  /** The block the chain reads were pinned to (for the offline view, the block of the recorded snapshot). */
  pinnedBlock?: string;
  claim?: { hash: string; block: number; time: string };
  explorer: (kind: "tx" | "address", value: string) => string | null;
}

/**
 * A one-page, printable copy of this page's checks for the importer's own file. It is rendered outside the app and
 * shown only while printing; mounting it opens the browser's print dialog (print, or save as PDF).
 * Built from the verification result on screen; not signed.
 */
export default function ImporterFile({ data, result, proof, verifiedAt, cached, pinnedBlock, claim, explorer }: ImporterFileProps) {
  // One print dialog per mount, also when development mode runs the effect twice.
  const printed = useRef(false);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("printing-file");
    const done = () => root.classList.remove("printing-file");
    window.addEventListener("afterprint", done, { once: true });
    if (!printed.current) {
      printed.current = true;
      window.print();
    }
    return () => {
      window.removeEventListener("afterprint", done);
      done();
    };
  }, []);

  let credSAID = "";
  try {
    credSAID = (JSON.parse(proof.core) as { d: string }).d;
  } catch {
    // a malformed proof: the checks below report it
  }
  const registry = data.deployment.contracts.EmissionsClaimRegistry.address;
  const allowlist = data.deployment.contracts.VerifierAllowlist.address;
  const claimUrl = claim ? explorer("tx", claim.hash) : null;
  const regUrl = explorer("address", registry);

  return createPortal(
    <div className="importer-file" data-testid="importer-file">
      <h1>Importer's file: CarbonLEI verification (demo)</h1>
      <p className="if-notice">
        Fictional demo data: every company, LEI and EORI is fictional. Generated in the browser from the checks on the
        CarbonLEI demo page; not signed. Not a filing to the CBAM Registry and not a CBAM declaration; it does not
        replace any document the rules require. Emissions values are gross and illustrative, not CBAM methodology. This
        is our assessment, not a regulatory position.
      </p>
      <table className="if-table">
        <tbody>
          <tr>
            <th scope="row">Result</th>
            <td>
              {result.overall} — {OVERALL_TEXT[result.overall] ?? result.overall}
              {result.primaryCode ? ` (first failure: ${result.primaryCode})` : ""}
            </td>
          </tr>
          <tr>
            <th scope="row">{cached ? "Recorded" : "Verified"}</th>
            <td>{verifiedAt}{cached ? " (offline view: the recorded result; no check was re-run)" : ""}</td>
          </tr>
          <tr>
            <th scope="row">Credential ID (SAID)</th>
            <td><code>{credSAID || "—"}</code></td>
          </tr>
          <tr>
            <th scope="row">Shipment batch</th>
            <td>{proof.shipment?.batchId ? `${proof.shipment.batchId}, ${proof.shipment.quantityTonnes} t, shipped ${proof.shipment.shipmentDate}` : "— (no shipment in this proof)"}</td>
          </tr>
          <tr>
            <th scope="row">Importer EORI</th>
            <td>{data.importer.eori} (fictional)</td>
          </tr>
          <tr>
            <th scope="row">Network</th>
            <td>{data.network.name} (chain ID {data.network.chainId}), a test network</td>
          </tr>
          <tr>
            <th scope="row">Chain reads pinned to</th>
            <td>{pinnedBlock ? `block ${pinnedBlock}` : "— (checks 4–8 did not read the chain)"}</td>
          </tr>
          <tr>
            <th scope="row">Report key</th>
            <td><code>{result.onchain?.reportKey ?? "—"}</code></td>
          </tr>
          <tr>
            <th scope="row">Contracts</th>
            <td>
              EmissionsClaimRegistry <code>{registry}</code>
              {regUrl ? ` (${regUrl})` : ""}
              <br />
              VerifierAllowlist <code>{allowlist}</code>
            </td>
          </tr>
          <tr>
            <th scope="row">On-chain claim</th>
            <td>
              {claim ? (
                <>
                  <code>{claim.hash}</code>, block {claim.block}, {claim.time}
                  {claimUrl ? (
                    <>
                      <br />
                      Etherscan: {claimUrl}
                    </>
                  ) : null}
                </>
              ) : (
                "— (not recorded for this proof)"
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <h2>Checks</h2>
      <table className="if-table if-checks">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {result.checks.map((c) => (
            <tr key={c.index}>
              <td>{c.index}</td>
              <td>{c.name}</td>
              <td>{STATUS_TEXT[c.status] ?? c.status}</td>
              <td>
                {c.code ? <code>{c.code}</code> : null}
                {c.code && c.detail ? " — " : ""}
                {c.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="if-notice">
        These checks cover who signed the value, their authority (up to this demo's simulated root of trust) and the
        tonnage claim. They do not show that the emissions figure itself is correct, and they do not replace the
        verification report or the CBAM Registry.
      </p>
    </div>,
    document.body,
  );
}
