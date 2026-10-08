// "Sign this draft with a demo key": the draft read from a Communication Template is signed with a key made in this
// page (kept in memory only), and the proof goes through the same verifier as the Buyer tab. Loaded only when a
// template has been read. Sends no transaction: the only chain access is the verifier's reads and one dry run
// (eth_call) of a registration from the demo key.
import { useRef, useState } from "react";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { reportInputOf } from "../../../sdk/issue.ts";
import { selfIssueDraft, SELF_ISSUED_LABEL, type SelfIssued } from "../../../sdk/selfissue.ts";
import type { CredentialDraft } from "../../../sdk/template.ts";
import { verifyOffline, verifyPresentation, type CheckResult, type VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { Badge, type BadgeKind } from "../components.tsx";
import { evidenceCheckers } from "../evidence.ts";
import { CODE_TEXT, revertText } from "../messages.ts";

/** Labels for the fields whose usual label would say more than a self-issued placeholder is. */
const OWN_LABELS: Record<string, string> = { verifiedTonnes: "Quantity (t), the credential's verifiedTonnes field" };

/** One sentence per outcome this proof can have, keyed by check, status and code; other outcomes show the SDK's text. */
const WHY: Record<string, string> = {
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
};

const kindOf = (c: CheckResult): BadgeKind => (c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : c.status === "warn" ? "review" : "skip");
const whyOf = (c: CheckResult) => WHY[`${c.index}:${c.status}:${c.code}`] ?? CODE_TEXT[c.code] ?? c.detail;

type Dry = { reverted: false } | { reverted: true; errorName: string; args: readonly unknown[] } | { error: string };
type Run = { issued: SelfIssued; result: VerificationResult; live: boolean; note: string; dry: Dry | null };

export default function SelfIssue({ draft, labels, product }: { draft: CredentialDraft; labels: Record<string, string>; product: string }) {
  const { data, reader, offline } = useApp();
  // The demo key lives only in this component's memory: never stored, never sent, gone with the page.
  const key = useRef<PrivateKeyAccount | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const registry = data.deployment.contracts.EmissionsClaimRegistry.address;
  const chainId = data.network.chainId;

  async function start() {
    setError("");
    if (!reader && !offline) {
      setError("Still connecting to Sepolia — try again in a moment.");
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
      let note = "";
      let dry: Dry | null = null;
      if (reader && !offline) {
        try {
          result = await verifyPresentation(issued.proof, reader, { checkers: evidenceCheckers(data), proofText });
          live = true;
        } catch (e) {
          note = `The checks that read the chain could not run: ${(e as Error).message}`;
          result = await verifyOffline(issued.proof, { registry, chainId }, { proofText });
        }
        try {
          dry = await reader.dryRun("registerReport", [reportInputOf(issued.credential, { supplier: signer.address, kelSeq: 0n })], signer.address);
        } catch (e) {
          dry = { error: (e as Error).message };
        }
      } else {
        result = await verifyOffline(issued.proof, { registry, chainId }, { proofText });
        note = "Offline view: checks 0–3 ran in your browser; checks 4–8 need a live connection and were not run.";
      }
      setRun({ issued, result, live, note, dry });
    } catch (e) {
      setError(`Could not sign or check this draft: ${(e as Error).message}`);
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
  const list = (ns: number[]) => (ns.length ? ns.join(", ") : "none");

  return (
    <section className="self-issue" aria-labelledby="self-issue-h" data-testid="self-issue">
      <h3 id="self-issue-h">Sign this draft with a demo key and run the checks</h3>
      <p className="fine">
        What an importer's verifier would make of this draft ({product}) if the supplier signed it without a
        verification body. A key is generated in this page and signs the draft; the template's empty fields get marked
        placeholders. The proof then goes through the same checks, 0 to 8, as the Buyer tab. No transaction is sent and
        the key exists only in this page's memory.
      </p>
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={() => void start()} disabled={busy}>
          {run ? "Sign again with the same demo key and re-run" : "Sign with a demo key and run the checks"}
        </button>
      </div>
      <div aria-live="polite">
        {busy && <p className="fine">Signing and checking…</p>}
        {error && (
          <p className="verify-summary bad" role="alert">
            {error}
          </p>
        )}
        {run && r && !busy && (
          <div data-testid="self-issue-result">
            <p className="self-issue-key" data-testid="self-issue-key">
              <strong>Demo key {run.issued.credential.core.issuer.verifierAddress}</strong> — {SELF_ISSUED_LABEL}.
            </p>
            <details className="self-issue-fields">
              <summary>
                {placeholders.length} fields are placeholders, not from your file
              </summary>
              <ul className="fine">
                {placeholders.map((f) => (
                  <li key={f.field}>
                    {OWN_LABELS[f.field] ?? labels[f.field] ?? f.field}: <code>{f.value}</code>
                  </li>
                ))}
              </ul>
            </details>
            <ol className="checks" aria-label="Checks of the self-issued proof">
              {r.checks.map((c) => {
                const kind = kindOf(c);
                return (
                  <li key={c.index} className="check" data-check={c.index} data-status={c.status}>
                    <span className="check-num" aria-hidden="true">
                      {c.index}
                    </span>
                    <span className="check-text">
                      <span className="sr-only">Check {c.index}: </span>
                      {c.name}
                    </span>
                    <span className="check-result">
                      <Badge kind={kind} />
                    </span>
                    <span className={`check-detail ${kind === "fail" ? "bad" : ""}`}>
                      {whyOf(c)}
                      {c.code ? (
                        <>
                          {" "}
                          <code>{c.code}</code>
                        </>
                      ) : null}
                      {c.detail && whyOf(c) !== c.detail ? ` (${c.detail})` : ""}
                      {c.index === 4 && run.dry && (
                        <span className="self-issue-dry">
                          {"error" in run.dry
                            ? `A registration from this key, as a dry run (eth_call, no transaction), could not be sent: ${run.dry.error}`
                            : run.dry.reverted
                              ? (
                                <>
                                  A registration from this key, as a dry run against the live contract (eth_call, no transaction):
                                  reverted <code>{run.dry.errorName}</code> — {revertText(run.dry.errorName, run.dry.args)}
                                </>
                              )
                              : "A registration from this key, as a dry run (eth_call, no transaction), did not revert."}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
            {run.note && <p className="fine">{run.note}</p>}
            <p className="verify-summary bad" data-testid="self-issue-summary">
              <span aria-hidden="true">✕ </span>
              <strong>Not accepted (verifier result: {r.overall})</strong> —{" "}
              {refused
                ? "This is how far a self-issued report gets: the checks that need an authorised signer and the shared ledger refuse it."
                : "This is how far a self-issued report gets here: the checks that need an authorised signer and the shared ledger did not accept it."}{" "}
              Passed {list(passed)}; failed {list(failed)}; not run {list(notRun)}.
            </p>
            <p className="fine">
              A verification body on the allowlist would sign the values it checked, register the report on the
              shared ledger and carry a vLEI chain to the pinned root; then checks 4–7 have something to accept.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
