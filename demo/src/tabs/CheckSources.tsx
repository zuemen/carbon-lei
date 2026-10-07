// Buyer tab, collapsed panel at the bottom: where each of the eight checks gets its data. The check list and
// the source labels come from the Buyer tab's own CHECKS list and SourceLabel, so the table cannot drift from
// the labels shown next to each check.
import { useApp } from "../App.tsx";
import { SourceLabel, type Source } from "../components.tsx";

export interface CheckRow {
  n: number;
  text: string;
  source: Source;
}

/** The first clause of a check's text (before a parenthesis or a dash), used as its name in the table. */
const shortText = (text: string) => text.split(/ \(| — /)[0];

export function CheckSources({ checks }: { checks: CheckRow[] }) {
  const { data } = useApp();
  // What each check's source means for that check. Keyed by check number; the source itself is read from `checks`.
  const meaning: Record<number, string> = {
    1: "Recomputed from the proof on this page: the credential's content hash must equal its ID. Nothing is fetched.",
    2: "Each disclosed field is hashed on this page and matched to a digest in the signed credential. Hidden fields stay hidden.",
    3: "The signature is recovered on this page and must match the verification body named in the credential. Only the chain ID comes from the Sepolia node; the body's on-chain registration is read in check 4.",
    4: "Contract state read from Sepolia when you press Verify, all at one block. The auditor's authority was checked by the contract when the report was registered; it is not recomputed now.",
    5: "The shared tonnage ledger on Sepolia, read when you press Verify: the claim for this batch, its quantity and the importer it was declared to.",
    6: `The signature on the auditor's key event is re-checked on this page from the exported event (${data.exportDate}). Witnesses are not queried.`,
    7: `The vLEI credential chain is read from evidence exported on ${data.exportDate} and checked up to this page's pinned root. Witnesses are not queried. Check 7 also reads the allowlist on Sepolia (when the auditor was added and revoked, and when the body's accreditation ends) and judges authority at the report's registration time, as check 4 does.`,
    8: "A rule-based comparison of the report with the signed credential, on this page. A mismatch flags the proof for human review; it never fails the check list.",
  };
  return (
    <details className="sheet check-sources" id="check-sources">
      <summary>Where each check gets its data</summary>
      <p className="check-sources-lede">
        The source label shown next to each check above, and what it means for that check. In the offline view, the
        Sepolia reads are a cached result.
      </p>
      <table className="ledger check-sources-table">
        <caption className="sr-only">Data source of each of the eight checks</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Data source</th>
            <th scope="col">What that means</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.n} data-source={c.source}>
              <td data-label="Check">
                {c.n}. {shortText(c.text)}
              </td>
              <td data-label="Data source">
                <SourceLabel source={c.source} />
              </td>
              <td data-label="What that means">{meaning[c.n] ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
