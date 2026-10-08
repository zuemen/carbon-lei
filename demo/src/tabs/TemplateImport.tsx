// "Start from the Commission's Communication Template": reads the official xlsx in the browser with the SDK's
// deterministic importer and shows which credential fields it can fill. Rendered only when the panel is opened;
// the file is parsed in a Web Worker (with exceljs and fflate), created only when a file is read. Nothing is uploaded.
import { lazy, Suspense, useState } from "react";
import exampleUrl from "../../../fixtures/cbam-template/CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx?url";
import type { CredentialDraft, ParsedTemplate, SuppliedBy } from "../../../sdk/template.ts";
import type { TemplateResponse } from "./templateWorker.ts";

// The demo-key signing step and the verifier load only once a template has been read.
const SelfIssue = lazy(() => import("./SelfIssue.tsx"));

/** Same limit as MAX_TEMPLATE_BYTES in sdk/template.ts; checked before the file is read into memory. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LICENSES_URL = `${import.meta.env.BASE_URL}assets/third-party-licenses.txt`;

/** Parses the bytes in a fresh worker (transferred, not copied) and ends the worker when it answers. */
function parseInWorker(bytes: ArrayBuffer): Promise<{ t: ParsedTemplate; drafts: CredentialDraft[] }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./templateWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<TemplateResponse>) => {
      w.terminate();
      if (e.data.ok) resolve({ t: e.data.t, drafts: e.data.drafts });
      else reject(new Error(e.data.message));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "the spreadsheet reader did not load"));
    };
    w.postMessage({ bytes }, [bytes]);
  });
}

type State =
  | { kind: "idle" }
  | { kind: "reading"; what: string }
  | { kind: "done"; what: string; t: ParsedTemplate; drafts: CredentialDraft[] }
  | { kind: "error"; what: string; message: string };

const GROUPS: SuppliedBy[] = ["supplier", "verification body"];

export function TemplateImport({ labels }: { labels: Record<string, string> }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [index, setIndex] = useState(0);

  async function read(what: string, bytes: () => Promise<ArrayBuffer>) {
    setState({ kind: "reading", what });
    try {
      const { t, drafts } = await parseInWorker(await bytes());
      setIndex(0);
      setState({ kind: "done", what, t, drafts });
    } catch (e) {
      setState({ kind: "error", what, message: (e as Error).message });
    }
  }

  function readFile(f: File) {
    if (f.size > MAX_FILE_BYTES) {
      setState({ kind: "error", what: f.name, message: `file larger than ${MAX_FILE_BYTES} bytes (${f.size}); it was not read` });
      return;
    }
    void read(f.name, () => f.arrayBuffer());
  }

  const draft = state.kind === "done" ? state.drafts[index] : null;

  const loadExample = () =>
    read("the Commission's example (screws and nuts, template V2.1)", async () => {
      const res = await fetch(exampleUrl);
      if (!res.ok) throw new Error(`could not fetch the example file (HTTP ${res.status})`);
      return res.arrayBuffer();
    });

  return (
    <div className="template-import" style={{ marginTop: 12, maxWidth: "100%" }}>
      <p className="pvv-lede">
        The Commission publishes an Excel template that operators of installations outside the EU use to send embedded
        emissions to importers, with filled examples. This panel reads such a file in your browser with a fixed cell
        map (template versions 2.1 and 2.1.1) and shows which credential fields it can fill. The template is the
        Commission's transitional-period template and the example and its plant are fictional. The demo's credentials
        and proofs are still demo data; no imported draft was used to issue them. This is not a CBAM Registry
        integration and does not show compliance.
      </p>
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={loadExample} disabled={state.kind === "reading"}>
          Load the Commission's example
        </button>
        <label className="fine">
          or read your own .xlsx (read in this browser; nothing is uploaded){" "}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
            }}
          />
        </label>
      </div>
      <div aria-live="polite">
        {state.kind === "reading" && <p className="fine">Reading {state.what}…</p>}
        {state.kind === "error" && (
          <p className="verify-summary bad" role="alert">
            Could not read {state.what}: {state.message}
          </p>
        )}
        {state.kind === "done" && draft && (
          <>
            <p className="fine" data-testid="template-summary">
              Read {state.what}: template version {state.t.templateVersion}, {state.t.installation.name},{" "}
              {state.t.reportingPeriod.start} to {state.t.reportingPeriod.end}, {state.t.products.length} product
              {state.t.products.length === 1 ? "" : "s"}. sha256 <span className="hash">{state.t.sha256.slice(0, 16)}…</span>
            </p>
            {state.t.products.length > 1 && (
              <label className="fine">
                Product row{" "}
                <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                  {state.t.products.map((p, i) => (
                    <option key={p.row} value={i}>
                      {i + 1}: CN {p.cnCode}
                      {p.productName ? ` · ${p.productName}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {state.t.warnings.length > 0 && (
              <ul className="fine template-warnings" aria-label="Warnings">
                {state.t.warnings.map((w) => (
                  <li key={w}>Warning: {w}</li>
                ))}
              </ul>
            )}
            <p className="fine">Template cells are on the sheet Summary_Communication unless another sheet is named.</p>
            <div className="table-wrap">
              <table className="ledger" aria-label="Template value to credential field">
                <thead>
                  <tr>
                    <th scope="col">Credential field</th>
                    <th scope="col">Value</th>
                    <th scope="col">Template cell</th>
                    <th scope="col">Rule</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.rows.map((r) => (
                    <tr key={r.field}>
                      <td>{labels[r.field] ?? r.field}</td>
                      <td style={{ minWidth: "12ch" }}>{r.value}</td>
                      <td>{r.source.replaceAll("Summary_Communication!", "")}</td>
                      <td>{r.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {draft.fields.specificEmbeddedEmissions_tCO2e_per_t && !draft.product.cnCode.startsWith("7318") && (
              <p className="fine">
                The template also gives SEE (indirect) {state.t.products[index].seeIndirect} and SEE (total){" "}
                {state.t.products[index].seeTotal} tCO2e/t; the credential carries SEE (direct), for the reason in the
                intensity row above.
              </p>
            )}
            {draft.fields.specificEmbeddedEmissions_tCO2e_per_t && draft.product.cnCode.startsWith("7318") && (
              <p className="fine">
                The template also gives SEE (indirect) {state.t.products[index].seeIndirect} and SEE (total){" "}
                {state.t.products[index].seeTotal} tCO2e/t; the credential carries SEE (direct) because CN 7318 counts
                direct emissions only for CBAM certificates in the definitive period (transitional reports also listed
                indirect emissions).
              </p>
            )}
            {GROUPS.map((by) => {
              const list = draft.toBeSupplied.filter((s) => s.by === by);
              return (
                <div key={by}>
                  <p className="sheet-kicker" style={{ marginTop: 16 }}>
                    Still to be supplied by the {by} ({list.length})
                  </p>
                  <ul className="fine" style={{ margin: "6px 0 12px", paddingLeft: 18 }}>
                    {list.map((s) => (
                      <li key={s.field}>
                        {labels[s.field] ?? s.field} — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <p className="fine">Set by the SDK when the credential is issued: {draft.setAtIssuance.map((f) => labels[f] ?? f).join(", ")}.</p>
            <Suspense fallback={<p className="fine">Loading…</p>}>
              <SelfIssue
                key={`${state.t.sha256}:${index}`}
                draft={draft}
                labels={labels}
                product={`product row ${index + 1}, CN ${draft.product.cnCode}`}
              />
            </Suspense>
          </>
        )}
      </div>
      <p className="fine">
        Example file and template: © European Union, CC BY 4.0 (file renamed); see{" "}
        <a href="https://github.com/zuemen/carbon-lei/blob/main/fixtures/cbam-template/SOURCE.md">SOURCE.md</a>. The
        reader uses exceljs (MIT, bundles JSZip, MIT or GPLv3) and fflate (MIT):{" "}
        <a href={LICENSES_URL}>third-party licenses</a>.
      </p>
    </div>
  );
}
