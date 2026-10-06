// "Start from the Commission's Communication Template": reads the official xlsx in the browser with the SDK's
// deterministic importer and shows which credential fields it can fill. Rendered only when the panel is opened;
// the importer and exceljs load only when a file is read. Nothing is uploaded.
import { useState } from "react";
import exampleUrl from "../../../fixtures/cbam-template/CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx?url";
import exceljsUrl from "exceljs/dist/exceljs.min.js?url";
import type { CredentialDraft, ExcelModule, ParsedTemplate } from "../../../sdk/template.ts";

/** exceljs's prebuilt browser file, added as a script the first time a file is read (it defines window.ExcelJS). */
let excel: Promise<ExcelModule> | null = null;
function browserExcel(): Promise<ExcelModule> {
  excel ??= new Promise<ExcelModule>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = exceljsUrl;
    s.async = true;
    s.onload = () => {
      const m = (window as unknown as { ExcelJS?: ExcelModule }).ExcelJS;
      if (m) resolve(m);
      else reject(new Error("the spreadsheet reader did not load"));
    };
    s.onerror = () => {
      excel = null;
      reject(new Error("could not load the spreadsheet reader"));
    };
    document.head.appendChild(s);
  });
  return excel;
}

type State =
  | { kind: "idle" }
  | { kind: "reading"; what: string }
  | { kind: "done"; what: string; t: ParsedTemplate }
  | { kind: "error"; what: string; message: string };

export function TemplateImport({ labels }: { labels: Record<string, string> }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<CredentialDraft | null>(null);

  async function read(what: string, bytes: () => Promise<Uint8Array>) {
    setState({ kind: "reading", what });
    setDraft(null);
    try {
      const { parseTemplate, draftCredentialFields } = await import("../../../sdk/template.ts");
      const t = await parseTemplate(await bytes(), { excel: browserExcel });
      setIndex(0);
      setDraft(draftCredentialFields(t, 0));
      setState({ kind: "done", what, t });
    } catch (e) {
      setState({ kind: "error", what, message: (e as Error).message });
    }
  }

  async function pick(i: number) {
    if (state.kind !== "done") return;
    const { draftCredentialFields } = await import("../../../sdk/template.ts");
    setIndex(i);
    setDraft(draftCredentialFields(state.t, i));
  }

  const loadExample = () =>
    read("the Commission's example (screws and nuts, template V2.1)", async () => {
      const res = await fetch(exampleUrl);
      if (!res.ok) throw new Error(`could not fetch the example file (HTTP ${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    });

  return (
    <div style={{ marginTop: 12, maxWidth: "100%" }}>
      <p className="pvv-lede">
        The Commission publishes an Excel template that operators of installations outside the EU use to send embedded
        emissions to importers, with filled examples. This panel reads such a file in your browser with a fixed cell
        map (template versions 2.1 and 2.1.1) and shows which credential fields it can fill. The template is the
        Commission's transitional-period template, the example and its plant are fictional, and the credential in this
        demo is still demo data. This is not a CBAM Registry integration and does not show compliance.
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
              if (f) void read(f.name, async () => new Uint8Array(await f.arrayBuffer()));
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
                <select value={index} onChange={(e) => void pick(Number(e.target.value))}>
                  {state.t.products.map((p, i) => (
                    <option key={p.row} value={i}>
                      {i + 1}: CN {p.cnCode}
                      {p.productName ? ` · ${p.productName}` : ""}
                    </option>
                  ))}
                </select>
              </label>
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
            {draft.fields.specificEmbeddedEmissions_tCO2e_per_t && (
              <p className="fine">
                The template also gives SEE (indirect) {state.t.products[index].seeIndirect} and SEE (total){" "}
                {state.t.products[index].seeTotal} tCO2e/t; the credential carries SEE (direct) because CN 7318 counts
                direct emissions only.
              </p>
            )}
            <p className="sheet-kicker" style={{ marginTop: 16 }}>
              Still to be supplied by the verification body ({draft.toBeSupplied.length})
            </p>
            <ul className="fine" style={{ margin: "6px 0 12px", paddingLeft: 18 }}>
              {draft.toBeSupplied.map((s) => (
                <li key={s.field}>
                  {labels[s.field] ?? s.field} — {s.reason}
                </li>
              ))}
            </ul>
            <p className="fine">Set by the SDK when the credential is issued: {draft.setAtIssuance.map((f) => labels[f] ?? f).join(", ")}.</p>
          </>
        )}
      </div>
    </div>
  );
}
