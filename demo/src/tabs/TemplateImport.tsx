// "Start from the Commission's Communication Template": reads the official xlsx in the browser with the SDK's
// deterministic importer and shows which credential fields it can fill. Rendered only when the panel is opened;
// the file is parsed in a Web Worker (with exceljs and fflate), created only when a file is read. Nothing is uploaded.
// The panel's own text is in English and Traditional Chinese; what the SDK writes (rules, reasons, warnings, errors)
// and the values read from the workbook stay as they are, marked lang="en" in Chinese.
import { lazy, Suspense, useState } from "react";
import exampleUrl from "../../../fixtures/cbam-template/CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx?url";
import type { CredentialDraft, ParsedTemplate, SuppliedBy } from "../../../sdk/template.ts";
import { useLang, type Lang } from "../i18n.ts";
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

/** `what`: a file name, or null for the Commission's example (named in the page's language). */
type State =
  | { kind: "idle" }
  | { kind: "reading"; what: string | null }
  | { kind: "done"; what: string | null; t: ParsedTemplate; drafts: CredentialDraft[] }
  | { kind: "error"; what: string | null; message: string; tooBig?: number };

const GROUPS: SuppliedBy[] = ["supplier", "verification body"];

const T = {
  en: {
    lede:
      "The Commission publishes an Excel template that operators of installations outside the EU use to send embedded emissions to importers, with filled examples. This panel reads such a file in your browser with a fixed cell map (template versions 2.1 and 2.1.1) and shows which credential fields it can fill. The template is the Commission's transitional-period template and the example and its plant are fictional. The demo's credentials and proofs are still demo data; no imported draft was used to issue them. This is not a CBAM Registry integration and does not show compliance.",
    loadExample: "Load the Commission's example",
    ownFile: "or read your own .xlsx (read in this browser; nothing is uploaded)",
    example: "the Commission's example (screws and nuts, template V2.1)",
    reading: (what: string) => `Reading ${what}…`,
    couldNotRead: (what: string) => `Could not read ${what}: `,
    tooBig: (size: number) => `file larger than ${MAX_FILE_BYTES} bytes (${size}); it was not read`,
    summary: (what: string, version: string) => [`Read ${what}: template version ${version}, `, ", "] as const,
    period: (start: string, end: string, n: number) => `${start} to ${end}, ${n} product${n === 1 ? "" : "s"}. sha256 `,
    productRow: "Product row",
    warningsLabel: "Warnings",
    warning: "Warning: ",
    sheetNote: "Template cells are on the sheet Summary_Communication unless another sheet is named.",
    tableLabel: "Template value to credential field",
    cols: ["Credential field", "Value", "Template cell", "Rule"],
    seeOther: (ind: string, tot: string) =>
      `The template also gives SEE (indirect) ${ind} and SEE (total) ${tot} tCO2e/t; the credential carries SEE (direct), for the reason in the intensity row above.`,
    see7318: (ind: string, tot: string) =>
      `The template also gives SEE (indirect) ${ind} and SEE (total) ${tot} tCO2e/t; the credential carries SEE (direct) because CN 7318 counts direct emissions only for CBAM certificates in the definitive period (transitional reports also listed indirect emissions).`,
    by: { supplier: "supplier", "verification body": "verification body" } as Record<SuppliedBy, string>,
    toSupply: (by: string, n: number) => `Still to be supplied by the ${by} (${n})`,
    setAtIssuance: (list: string) => `Set by the SDK when the credential is issued: ${list}.`,
    listSep: ", ",
    loading: "Loading…",
    product: (i: number, cn: string) => `product row ${i}, CN ${cn}`,
    footer: ["Example file and template: © European Union, CC BY 4.0 (file renamed); see ", ". The reader uses exceljs (MIT, bundles JSZip, MIT or GPLv3) and fflate (MIT): ", "third-party licenses", "."],
  },
  "zh-TW": {
    lede:
      "歐盟執委會發布了一份 Excel 範本，供歐盟以外設施的營運者向進口商提供內含排放，並附有填寫範例。這個面板在您的瀏覽器內以固定的儲存格對照表（範本 2.1 與 2.1.1 版）讀取這類檔案，並列出它能填入哪些憑證欄位。此範本是執委會過渡期的範本，範例及其工廠皆為虛構。本示範的憑證與證明仍是示範資料，沒有使用任何匯入的草稿來簽發。這不是與 CBAM 登錄系統的整合，也不代表符合法規。",
    loadExample: "載入執委會的範例",
    ownFile: "或讀取您自己的 .xlsx（在此瀏覽器內讀取，不會上傳任何資料）",
    example: "執委會的範例（螺絲與螺帽，範本 V2.1）",
    reading: (what: string) => `正在讀取${what}…`,
    couldNotRead: (what: string) => `無法讀取${what}：`,
    tooBig: (size: number) => `檔案超過 ${MAX_FILE_BYTES} 位元組（${size}），因此未讀取`,
    summary: (what: string, version: string) => [`已讀取${what}：範本版本 ${version}，`, "，"] as const,
    period: (start: string, end: string, n: number) => `${start} 至 ${end}，${n} 項產品。sha256 `,
    productRow: "產品列",
    warningsLabel: "警告",
    warning: "警告：",
    sheetNote: "除非另外標明工作表，範本儲存格都位於 Summary_Communication 工作表。",
    tableLabel: "範本數值與憑證欄位的對照",
    cols: ["憑證欄位", "數值", "範本儲存格", "規則"],
    seeOther: (ind: string, tot: string) =>
      `範本另外列出 SEE（間接）${ind} 與 SEE（總計）${tot} tCO2e/t；憑證記載的是 SEE（直接），原因見上方排放強度那一列。`,
    see7318: (ind: string, tot: string) =>
      `範本另外列出 SEE（間接）${ind} 與 SEE（總計）${tot} tCO2e/t；憑證記載的是 SEE（直接），因為在正式實施期，CN 7318 計算 CBAM 憑證時只計入直接排放（過渡期報告也會列出間接排放）。`,
    by: { supplier: "供應商", "verification body": "驗證機構" } as Record<SuppliedBy, string>,
    toSupply: (by: string, n: number) => `尚待${by}提供（${n}）`,
    setAtIssuance: (list: string) => `簽發憑證時由 SDK 設定：${list}。`,
    listSep: "、",
    loading: "載入中…",
    product: (i: number, cn: string) => `產品列 ${i}，CN ${cn}`,
    footer: ["範例檔與範本：© European Union，CC BY 4.0（檔名已更改）；見 ", "。讀取器使用 exceljs（MIT，內含 JSZip，MIT 或 GPLv3）與 fflate（MIT）：", "第三方授權", "。"],
  },
} satisfies Record<Lang, unknown>;

export function TemplateImport({ labels }: { labels: Record<string, string> }) {
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const s = T[lang];
  /** lang="en" on text the SDK or the workbook wrote, in Chinese only. */
  const en = zh ? "en" : undefined;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [index, setIndex] = useState(0);

  async function read(what: string | null, bytes: () => Promise<ArrayBuffer>) {
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
      setState({ kind: "error", what: f.name, message: "", tooBig: f.size });
      return;
    }
    void read(f.name, () => f.arrayBuffer());
  }

  const draft = state.kind === "done" ? state.drafts[index] : null;
  // A file name keeps its spelling (and is marked as such in Chinese); the example is named in the page's language.
  const whatOf = (what: string | null) => (what === null ? s.example : what);
  const What = ({ what }: { what: string | null }) => (what === null ? <>{s.example}</> : <span lang={en}>{what}</span>);

  const loadExample = () =>
    read(null, async () => {
      const res = await fetch(exampleUrl);
      if (!res.ok) throw new Error(`could not fetch the example file (HTTP ${res.status})`);
      return res.arrayBuffer();
    });

  return (
    <div className="template-import" style={{ marginTop: 12, maxWidth: "100%" }}>
      <p className="pvv-lede">{s.lede}</p>
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={loadExample} disabled={state.kind === "reading"}>
          {s.loadExample}
        </button>
        <label className="fine">
          {s.ownFile}{" "}
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
        {state.kind === "reading" && (
          <p className="fine">
            {zh ? (
              <>
                正在讀取<What what={state.what} />…
              </>
            ) : (
              s.reading(whatOf(state.what))
            )}
          </p>
        )}
        {state.kind === "error" && (
          <p className="verify-summary bad" role="alert">
            {zh ? (
              <>
                無法讀取<What what={state.what} />：
              </>
            ) : (
              s.couldNotRead(whatOf(state.what))
            )}
            {state.tooBig !== undefined ? s.tooBig(state.tooBig) : <span lang={en}>{state.message}</span>}
          </p>
        )}
        {state.kind === "done" && draft && (
          <>
            <p className="fine" data-testid="template-summary">
              {zh ? (
                <>
                  已讀取<What what={state.what} />：範本版本 {state.t.templateVersion}，
                </>
              ) : (
                s.summary(whatOf(state.what), state.t.templateVersion)[0]
              )}
              <span lang={en}>{state.t.installation.name}</span>
              {s.summary("", "")[1]}
              {s.period(state.t.reportingPeriod.start, state.t.reportingPeriod.end, state.t.products.length)}
              <span className="hash">{state.t.sha256.slice(0, 16)}…</span>
            </p>
            {state.t.products.length > 1 && (
              <label className="fine">
                {s.productRow}{" "}
                <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                  {state.t.products.map((p, i) => (
                    // The product name is the workbook's own text (English in the Commission's example).
                    <option key={p.row} value={i} lang={zh && p.productName ? "en" : undefined}>
                      {i + 1}: CN {p.cnCode}
                      {p.productName ? ` · ${p.productName}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {state.t.warnings.length > 0 && (
              <ul className="fine template-warnings" aria-label={s.warningsLabel}>
                {state.t.warnings.map((w) => (
                  <li key={w}>
                    {s.warning}
                    <span lang={en}>{w}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="fine">{s.sheetNote}</p>
            <div className="table-wrap">
              <table className="ledger" aria-label={s.tableLabel}>
                <thead>
                  <tr>
                    {s.cols.map((c) => (
                      <th key={c} scope="col">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.rows.map((r) => (
                    <tr key={r.field}>
                      <td>{labels[r.field] ?? r.field}</td>
                      <td style={{ minWidth: "12ch" }} lang={en}>
                        {r.value}
                      </td>
                      <td>{r.source.replaceAll("Summary_Communication!", "")}</td>
                      <td lang={en}>{r.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {draft.fields.specificEmbeddedEmissions_tCO2e_per_t && !draft.product.cnCode.startsWith("7318") && (
              <p className="fine">{s.seeOther(state.t.products[index].seeIndirect, state.t.products[index].seeTotal)}</p>
            )}
            {draft.fields.specificEmbeddedEmissions_tCO2e_per_t && draft.product.cnCode.startsWith("7318") && (
              <p className="fine">{s.see7318(state.t.products[index].seeIndirect, state.t.products[index].seeTotal)}</p>
            )}
            {GROUPS.map((by) => {
              const list = draft.toBeSupplied.filter((x) => x.by === by);
              return (
                <div key={by}>
                  <p className="sheet-kicker" style={{ marginTop: 16 }}>
                    {s.toSupply(s.by[by], list.length)}
                  </p>
                  <ul className="fine" style={{ margin: "6px 0 12px", paddingLeft: 18 }}>
                    {list.map((x) => (
                      <li key={x.field}>
                        {labels[x.field] ?? x.field} — <span lang={en}>{x.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <p className="fine">{s.setAtIssuance(draft.setAtIssuance.map((f) => labels[f] ?? f).join(s.listSep))}</p>
            <Suspense fallback={<p className="fine">{s.loading}</p>}>
              <SelfIssue
                key={`${state.t.sha256}:${index}`}
                draft={draft}
                labels={labels}
                product={s.product(index + 1, draft.product.cnCode)}
              />
            </Suspense>
          </>
        )}
      </div>
      <p className="fine">
        {s.footer[0]}
        <a href="https://github.com/zuemen/carbon-lei/blob/main/fixtures/cbam-template/SOURCE.md">SOURCE.md</a>
        {s.footer[1]}
        <a href={LICENSES_URL}>{s.footer[2]}</a>
        {s.footer[3]}
      </p>
    </div>
  );
}
