// "Sign this draft with a demo key": the draft read from a Communication Template is signed with a key made in this
// page (kept in memory only), and the proof goes through the same verifier as the Buyer tab. Loaded only when a
// template has been read. Sends no transaction: the only chain access is the verifier's reads and one dry run
// (eth_call) of a registration from the demo key. Every string has an English and a Traditional Chinese version;
// an SDK detail with no translation is shown in English, marked lang="en".
import { useRef, useState } from "react";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { reportInputOf } from "../../../sdk/issue.ts";
import { selfIssueDraft, SELF_ISSUED_LABEL, type SelfIssued } from "../../../sdk/selfissue.ts";
import type { CredentialDraft } from "../../../sdk/template.ts";
import { verifyOffline, verifyPresentation, type CheckResult, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, type BadgeKind } from "../components.tsx";
import { evidenceCheckers } from "../evidence.ts";
import { useLang, type Lang } from "../i18n.ts";
import { codeText, revertText } from "../messages.ts";
import { CHECK_NAME_ZH } from "../zh-details.ts";

/** Labels for the fields whose usual label would say more than a self-issued placeholder is. */
const OWN_LABELS: Record<Lang, Record<string, string>> = {
  en: { verifiedTonnes: "Quantity (t), the credential's verifiedTonnes field" },
  "zh-TW": { verifiedTonnes: "數量（t），即憑證的 verifiedTonnes 欄位" },
};

/** One sentence per outcome this proof can have, keyed by check, status and code; other outcomes show the SDK's text. */
const WHY: Record<Lang, Record<string, string>> = {
  en: {
    "0:pass:": "The proof has every part a verifier needs, in the expected form.",
    "1:pass:": "The credential ID was recomputed from its content in your browser and matches.",
    "2:pass:": "Each disclosed field was hashed again and found among the signed digests.",
    "3:pass:":
      "The signature is genuine and comes from the demo key the credential names; it shows who signed, not that this signer is allowed to sign, which checks 4 and 7 decide.",
    "4:fail:REPORT_INVALID/NOT_REGISTERED":
      "The shared ledger has no report under this credential ID: only a key on the allowlist can register one, and this key is not on it.",
    "4:skipped:": "Not run: it reads the shared ledger on Sepolia, and this view has no live connection.",
    "5:skipped:": "Not run: nothing was claimed, because a claim is a transaction on the shared ledger and this page sends none.",
    "6:fail:ANCHOR_NOT_FOUND": "The demo key has no KERI identifier, so no auditor's signed history records this report.",
    "6:skipped:": "Not run: it needs the auditor's signed history and a live connection, and this key has neither.",
    "7:fail:AUTHORITY_INVALID": "No vLEI chain leads from this key to the root of trust the page pins: a key made in a browser has none.",
    "7:skipped:": "Not run: there is no vLEI chain to check, and this view has no live connection.",
    "8:skipped:": "Not run (advisory): there is no verification report extract to reconcile.",
  },
  "zh-TW": {
    "0:pass:": "證明具備驗證器所需的每個部分，格式也符合預期。",
    "1:pass:": "憑證 ID 已在您的瀏覽器中依內容重新計算，結果相符。",
    "2:pass:": "每個揭露欄位都重新雜湊，並在已簽署的摘要中找到。",
    "3:pass:": "簽章屬實，來自憑證所指名的示範金鑰；這只說明是誰簽署的，不代表這位簽署者有權簽署——那由檢查 4 與檢查 7 判定。",
    "4:fail:REPORT_INVALID/NOT_REGISTERED": "共享帳本上沒有以此憑證 ID 登記的報告：只有允許清單上的金鑰才能登記，而這把金鑰不在清單上。",
    "4:skipped:": "未執行：這項檢查要讀取 Sepolia 上的共享帳本，而此檢視沒有即時連線。",
    "5:skipped:": "未執行：沒有任何申領，因為申領是共享帳本上的交易，而本頁不會送出任何交易。",
    "6:fail:ANCHOR_NOT_FOUND": "示範金鑰沒有 KERI 識別碼，因此沒有任何查核員的簽署歷史記錄這份報告。",
    "6:skipped:": "未執行：這項檢查需要查核員的簽署歷史與即時連線，這把金鑰兩者都沒有。",
    "7:fail:AUTHORITY_INVALID": "沒有任何 vLEI 鏈能從這把金鑰通往本頁釘選的信任根：在瀏覽器中產生的金鑰不會有這條鏈。",
    "7:skipped:": "未執行：沒有可檢查的 vLEI 鏈，而且此檢視沒有即時連線。",
    "8:skipped:": "未執行（僅供參考）：沒有可比對的驗證報告摘錄。",
  },
};

const T = {
  en: {
    stillConnecting: "Still connecting to Sepolia — try again in a moment.",
    chainFailed: (m: string) => `The checks that read the chain could not run: ${m}`,
    offline: "Offline view: checks 0–3 ran in your browser; checks 4–8 need a live connection and were not run.",
    couldNot: (m: string) => `Could not sign or check this draft: ${m}`,
    none: "none",
    sep: ", ",
    title: "Sign this draft with a demo key and run the checks",
    lede: (product: string) =>
      `What an importer's verifier would make of this draft (${product}) if the supplier signed it without a verification body. A key is generated in this page and signs the draft; the template's empty fields get marked placeholders. The proof then goes through the same checks, 0 to 8, as the Buyer tab. No transaction is sent and the key exists only in this page's memory.`,
    again: "Sign again with the same demo key and re-run",
    sign: "Sign with a demo key and run the checks",
    busy: "Signing and checking…",
    demoKey: (addr: string) => `Demo key ${addr}`,
    selfLabel: SELF_ISSUED_LABEL,
    end: ".",
    placeholders: (n: number) => `${n} fields are placeholders, not from your file`,
    checksLabel: "Checks of the self-issued proof",
    checkSr: (n: number) => `Check ${n}: `,
    dryError: (m: string) => `A registration from this key, as a dry run (eth_call, no transaction), could not be sent: ${m}`,
    dryReverted: "A registration from this key, as a dry run against the live contract (eth_call, no transaction): reverted ",
    dash: " — ",
    dryOk: "A registration from this key, as a dry run (eth_call, no transaction), did not revert.",
    notAccepted: (overall: string) => `Not accepted (verifier result: ${overall})`,
    refused: "This is how far a self-issued report gets: the checks that need an authorised signer and the shared ledger refuse it.",
    notAcceptedHere:
      "This is how far a self-issued report gets here: the checks that need an authorised signer and the shared ledger did not accept it.",
    tally: (p: string, f: string, n: string) => `Passed ${p}; failed ${f}; not run ${n}.`,
    closing:
      "A verification body on the allowlist would sign the values it checked, register the report on the shared ledger and carry a vLEI chain to the pinned root; then checks 4–7 have something to accept.",
  },
  "zh-TW": {
    stillConnecting: "仍在連線到 Sepolia——請稍後再試。",
    chainFailed: (m: string) => `需要讀取鏈上資料的檢查無法執行：${m}`,
    offline: "離線檢視：檢查 0–3 已在您的瀏覽器執行；檢查 4–8 需要即時連線，因此未執行。",
    couldNot: (m: string) => `無法簽署或檢查這份草稿：${m}`,
    none: "無",
    sep: "、",
    title: "以示範金鑰簽署這份草稿並執行檢查",
    lede: (product: string) =>
      `如果供應商不經驗證機構、自行簽署這份草稿（${product}），進口商的驗證器會怎麼判斷。本頁會產生一把金鑰來簽署草稿；範本中的空白欄位會填入標示清楚的預留值。接著證明會經過與買方分頁相同的檢查 0 到 8。不會送出任何交易，金鑰也只存在於本頁的記憶體中。`,
    again: "以同一把示範金鑰重新簽署並再次執行",
    sign: "以示範金鑰簽署並執行檢查",
    busy: "正在簽署與檢查…",
    demoKey: (addr: string) => `示範金鑰 ${addr}`,
    selfLabel: "在本頁產生的示範金鑰；不是驗證機構；未在 Sepolia 登記",
    end: "。",
    placeholders: (n: number) => `${n} 個欄位是預留值，並非來自您的檔案`,
    checksLabel: "自行簽發證明的檢查",
    checkSr: (n: number) => `檢查 ${n}：`,
    dryError: (m: string) => `以這把金鑰登記的試算（dry run，eth_call，不送出交易）無法送出：${m}`,
    dryReverted: "以這把金鑰對即時合約試算登記（dry run，eth_call，不送出交易）：已退回 ",
    dash: "——",
    dryOk: "以這把金鑰登記的試算（dry run，eth_call，不送出交易）沒有被退回。",
    notAccepted: (overall: string) => `不予採用（驗證器結果：${overall}）`,
    refused: "自行簽發的報告最多只能走到這裡：需要獲授權簽署者與共享帳本的檢查會拒絕它。",
    notAcceptedHere: "自行簽發的報告在這裡最多只能走到這一步：需要獲授權簽署者與共享帳本的檢查沒有接受它。",
    tally: (p: string, f: string, n: string) => `通過：${p}；未通過：${f}；未執行：${n}。`,
    closing: "允許清單上的驗證機構會簽署它檢查過的數值、在共享帳本上登記報告，並附上通往釘選根的 vLEI 鏈；這樣檢查 4–7 才有可以接受的依據。",
  },
} satisfies Record<Lang, unknown>;

const kindOf = (c: CheckResult): BadgeKind => (c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : c.status === "warn" ? "review" : "skip");
/** The sentence for this outcome, else the code's plain-language text; undefined when only the SDK's detail is left. */
const whyOf = (c: CheckResult, lang: Lang) => WHY[lang][`${c.index}:${c.status}:${c.code}`] ?? codeText(c.code, lang === "zh-TW");

type Dry = { reverted: false } | { reverted: true; errorName: string; args: readonly unknown[] } | { error: string };
// `note`: a key into T (with the error message, if any), so the note follows the page's language.
type Run = { issued: SelfIssued; result: VerificationResult; live: boolean; note: { kind: "chain"; m: string } | { kind: "offline" } | null; dry: Dry | null };

export default function SelfIssue({ draft, labels, product }: { draft: CredentialDraft; labels: Record<string, string>; product: string }) {
  const { data, reader, offline } = useApp();
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const t = T[lang];
  const en = zh ? "en" : undefined;
  // The demo key lives only in this component's memory: never stored, never sent, gone with the page.
  const key = useRef<PrivateKeyAccount | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: "connecting" } | { kind: "failed"; m: string } | null>(null);

  const registry = data.deployment.contracts.EmissionsClaimRegistry.address;
  const chainId = data.network.chainId;

  async function start() {
    setError(null);
    if (!reader && !offline) {
      setError({ kind: "connecting" });
      return;
    }
    setBusy(true);
    try {
      key.current ??= privateKeyToAccount(generatePrivateKey());
      const signer = key.current;
      const issued = await selfIssueDraft(draft, { signer, registry, chainId });
      const proofText = JSON.stringify(issued.proof);
      let result: VerificationResult;
      let live = false;
      let note: Run["note"] = null;
      let dry: Dry | null = null;
      if (reader && !offline) {
        try {
          result = await verifyPresentation(issued.proof, reader, { checkers: evidenceCheckers(data), proofText });
          live = true;
        } catch (e) {
          note = { kind: "chain", m: (e as Error).message };
          result = await verifyOffline(issued.proof, { registry, chainId }, { proofText });
        }
        try {
          dry = await reader.dryRun("registerReport", [reportInputOf(issued.credential, { supplier: signer.address, kelSeq: 0n })], signer.address);
        } catch (e) {
          dry = { error: (e as Error).message };
        }
      } else {
        result = await verifyOffline(issued.proof, { registry, chainId }, { proofText });
        note = { kind: "offline" };
      }
      setRun({ issued, result, live, note, dry });
    } catch (e) {
      setError({ kind: "failed", m: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const r = run?.result;
  const failed = r?.checks.filter((c) => c.status === "fail").map((c) => c.index) ?? [];
  const passed = r?.checks.filter((c) => c.status === "pass").map((c) => c.index) ?? [];
  const notRun = r?.checks.filter((c) => c.status === "skipped").map((c) => c.index) ?? [];
  const refused = !!r && run.live && [4, 6, 7].every((i) => failed.includes(i));
  const placeholders = run?.issued.fields.filter((f) => f.from === "placeholder") ?? [];
  const list = (ns: number[]) => (ns.length ? ns.join(t.sep) : t.none);
  const noteText = run?.note ? (run.note.kind === "offline" ? t.offline : t.chainFailed(run.note.m)) : "";

  return (
    <section className="self-issue" aria-labelledby="self-issue-h" data-testid="self-issue">
      <h3 id="self-issue-h">{t.title}</h3>
      <p className="fine">{t.lede(product)}</p>
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={() => void start()} disabled={busy}>
          {run ? t.again : t.sign}
        </button>
      </div>
      <div aria-live="polite">
        {busy && <p className="fine">{t.busy}</p>}
        {error && (
          <p className="verify-summary bad" role="alert">
            {error.kind === "connecting" ? t.stillConnecting : t.couldNot(error.m)}
          </p>
        )}
        {run && r && !busy && (
          <div data-testid="self-issue-result">
            <p className="self-issue-key" data-testid="self-issue-key">
              <strong>{t.demoKey(run.issued.credential.core.issuer.verifierAddress)}</strong>
              {t.dash}
              {t.selfLabel}
              {t.end}
            </p>
            <details className="self-issue-fields">
              <summary>{t.placeholders(placeholders.length)}</summary>
              <ul className="fine">
                {placeholders.map((f) => (
                  <li key={f.field}>
                    {OWN_LABELS[lang][f.field] ?? labels[f.field] ?? f.field}: <code>{f.value}</code>
                  </li>
                ))}
              </ul>
            </details>
            <ol className="checks" aria-label={t.checksLabel}>
              {r.checks.map((c) => {
                const kind = kindOf(c);
                const why = whyOf(c, lang);
                return (
                  <li key={c.index} className="check" data-check={c.index} data-status={c.status}>
                    <span className="check-num" aria-hidden="true">
                      {c.index}
                    </span>
                    <span className="check-text">
                      <span className="sr-only">{t.checkSr(c.index)}</span>
                      {zh ? (CHECK_NAME_ZH[c.index] ?? <span lang="en">{c.name}</span>) : c.name}
                    </span>
                    <span className="check-result">
                      <Badge kind={kind} />
                    </span>
                    <span className={`check-detail ${kind === "fail" ? "bad" : ""}`}>
                      {why ?? <span lang={en}>{c.detail}</span>}
                      {c.code ? (
                        <>
                          {" "}
                          <code>{c.code}</code>
                        </>
                      ) : null}
                      {c.detail && why !== undefined && why !== c.detail ? (
                        <>
                          {" "}(<span lang={en}>{c.detail}</span>)
                        </>
                      ) : (
                        ""
                      )}
                      {c.index === 4 && run.dry && (
                        <span className="self-issue-dry">
                          {"error" in run.dry ? (
                            t.dryError(run.dry.error)
                          ) : run.dry.reverted ? (
                            <>
                              {t.dryReverted}
                              <code>{run.dry.errorName}</code>
                              {t.dash}
                              {revertText(run.dry.errorName, run.dry.args, zh)}
                            </>
                          ) : (
                            t.dryOk
                          )}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
            {noteText && <p className="fine">{noteText}</p>}
            <p className="verify-summary bad" data-testid="self-issue-summary">
              <span aria-hidden="true">✕ </span>
              <strong>{t.notAccepted(r.overall)}</strong>
              {zh ? "——" : " — "}
              {refused ? t.refused : t.notAcceptedHere}
              {zh ? "" : " "}
              {t.tally(list(passed), list(failed), list(notRun))}
            </p>
            <p className="fine">{t.closing}</p>
          </div>
        )}
      </div>
    </section>
  );
}
