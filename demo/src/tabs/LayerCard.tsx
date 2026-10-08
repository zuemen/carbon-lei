import { useId, useState } from "react";
import type { VerificationResult } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { SourceLabel } from "../components.tsx";
import { fmt } from "../data.ts";
import { kgToT, revertText } from "../messages.ts";

/** Attack 2b's dry-run outcome, as the 2b card got it (live), or null when that card has not been run here. */
export type DryOutcome = { errorName: string; args: readonly unknown[] } | null;

type Ledger = "separate" | "shared";
type Layer = "with" | "without";

/** A two-option switch built from native radio buttons (arrow keys move between them, Tab leaves the group). */
function Switch<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="layer-switch">
      <legend>{legend}</legend>
      {options.map(([v, label]) => (
        <label key={v} className={value === v ? "on" : ""}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

const list = (ns: number[]) => (ns.length ? ns.join(", ") : "none");

/**
 * "What if one layer were missing?": a what-if shown on this page only. Every figure comes from the demo data or from
 * results the attack cards above already have (attack 2b's dry run, attack 4's recorded verification); this card sends
 * no call and no transaction, and the verifier itself never skips a check.
 */
export default function LayerCard({ a2b }: { a2b: DryOutcome }) {
  const { data } = useApp();
  const [ledger, setLedger] = useState<Ledger>("shared");
  const [layer7, setLayer7] = useState<Layer>("with");

  const verified = Number(data.report.verifiedTonnes);
  const first = { name: data.importer.name, t: Number(data.shipment.quantityTonnes) };
  const second = { name: data.secondImporter.name, t: Number(data.attacks.secondImporter.quantityTonnes) };

  // Shared ledger: the 2b dry run's own answer, live from the card above or as recorded when the data was built.
  const recorded = data.cached?.dryRuns.secondImporter;
  const shared = a2b ?? recorded ?? null;
  const sharedSource = a2b ? "from your dry run in card 2b above" : recorded ? `dry run recorded on ${data.cached?.time.slice(0, 10)}` : "";
  const sharedRejected = !!shared?.errorName;
  const left = shared?.errorName === "ExceedsVerifiedTonnage" && shared.args.length >= 2 ? kgToT(shared.args[0]) : null;

  // Separate databases (simulated): each importer's database knows only the claims made to that importer.
  const acceptsAlone = (t: number) => t <= verified;
  const sepAccepted = [first, second].filter((c) => acceptsAlone(c.t)).reduce((s, c) => s + c.t, 0);
  const sharedAccepted = first.t + (shared && !sharedRejected ? second.t : 0);
  const total = ledger === "separate" ? sepAccepted : sharedAccepted;
  const over = Math.max(0, total - verified);

  // Attack 4: the verification recorded before the watcher's suspension (the attack as it happened), else the latest.
  const a4 = data.attacks.attack4;
  const v4 = (a4?.beforeSuspension?.verification ?? a4?.verification) as VerificationResult | undefined;
  const v4When = a4?.beforeSuspension ? `recorded at block ${a4.beforeSuspension.block}, before the watcher's suspension` : "recorded when the demo data was built";
  const c7 = v4?.checks.find((c) => c.index === 7);
  const others = v4?.checks.filter((c) => c.index !== 7) ?? [];
  const otherFailed = others.filter((c) => c.status === "fail").map((c) => c.index);
  const otherReview = others.filter((c) => c.status === "warn" || c.code === "CONTESTED").map((c) => c.index);
  const otherPassed = others.filter((c) => c.status === "pass" && c.code !== "CONTESTED").map((c) => c.index);
  const otherSkipped = others.filter((c) => c.status === "skipped");

  return (
    <section className="sheet reveal layer-card" aria-labelledby="layer-card-h">
      <h3 id="layer-card-h">What if one layer were missing?</h3>
      <p className="layer-note">
        <strong>What-if in this page only — the verifier itself never switches a check off.</strong> Nothing here is sent
        to the contract: the figures come from the demo data and from the attack results above.
      </p>

      <div className="layer-row" id="layer-ledger">
        <h4>The shared ledger · attack 2b</h4>
        <p className="fine">
          {first.name} has claimed {fmt(first.t)} t of the {fmt(verified)} t verified. The supplier then asks {fmt(second.t)} t
          for {second.name}.
        </p>
        <Switch
          legend="Where the claims are recorded"
          value={ledger}
          options={[
            ["separate", "Two importers, separate databases (simulated)"],
            ["shared", "One shared ledger (the live contract)"],
          ]}
          onChange={setLedger}
        />
        <div className="layer-out" role="status" aria-live="polite" data-mode={ledger}>
          <table className="layer-table">
            <caption className="sr-only">Claims against the {fmt(verified)} t verified report</caption>
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Checked against</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {fmt(first.t)} t for {first.name}
                </td>
                <td>{ledger === "separate" ? `its own database: ${fmt(first.t)} of ${fmt(verified)} t` : "the shared ledger"}</td>
                <td>
                  <span className="stamp">Accepted</span>
                </td>
              </tr>
              <tr>
                <td>
                  {fmt(second.t)} t for {second.name}
                </td>
                {ledger === "separate" ? (
                  <>
                    <td>
                      its own database: {fmt(second.t)} of {fmt(verified)} t — it cannot see the {fmt(first.t)} t claimed for{" "}
                      {first.name}
                    </td>
                    <td>
                      <span className="stamp">{acceptsAlone(second.t) ? "Accepted" : "Rejected"}</span>
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      the shared ledger{left ? `: ${left} t left` : ""}
                      {sharedSource ? (
                        <>
                          {" "}
                          {a2b ? <SourceLabel source="sepolia" /> : <span className="source">⧗ recorded</span>}{" "}
                          <span className="fine">{sharedSource}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {shared ? (
                        <>
                          <span className={`stamp ${sharedRejected ? "red" : ""}`}>{sharedRejected ? "Rejected" : "Accepted"}</span>
                          {sharedRejected && (
                            <span className="fine layer-revert">
                              <code>{shared.errorName}</code> — {revertText(shared.errorName, shared.args)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="fine">Run attack 2b above.</span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
          <dl className="whatif-out layer-sum">
            <div>
              <dt>Verified report</dt>
              <dd>{fmt(verified)} t</dd>
            </div>
            <div>
              <dt>Accepted, all importers</dt>
              <dd data-testid="layer-total">{fmt(total)} t</dd>
            </div>
            <div>
              <dt>Over the verified tonnes</dt>
              <dd data-testid="layer-over" className={over > 0 ? "bad" : ""}>
                {fmt(over)} t
              </dd>
            </div>
          </dl>
          <p className="layer-verdict">
            {ledger === "separate"
              ? `Both databases accept: ${fmt(total)} t are declared against a report that verified ${fmt(verified)} t.`
              : shared
                ? sharedRejected
                  ? `The second claim is refused: ${fmt(total)} t accepted, within the ${fmt(verified)} t verified.`
                  : `The contract would accept the second claim: ${fmt(total)} t accepted.`
                : "Run attack 2b above to see the shared ledger's answer."}
          </p>
        </div>
        <p className="fine">
          A database run jointly by one operator could enforce this too, if every party trusts that operator:{" "}
          <a href="https://github.com/zuemen/carbon-lei/blob/main/docs/ARCHITECTURE.md#11-why-a-blockchain-four-questions">
            why a blockchain ↗
          </a>
        </p>
      </div>

      {a4 && v4 && c7 && (
        <div className="layer-row" id="layer-check7">
          <h4>Check 7, the vLEI chain · attack 4</h4>
          <p className="fine">
            The impostor body's proof, as the verifier checked it ({v4When}). The contract had already accepted its
            registration: the allowlist said yes.
          </p>
          <Switch
            legend="The verifier's check 7"
            value={layer7}
            options={[
              ["with", "With check 7 (as deployed)"],
              ["without", "Without check 7 (what-if)"],
            ]}
            onChange={setLayer7}
          />
          <div className="layer-out" role="status" aria-live="polite" data-mode={layer7}>
            {layer7 === "with" ? (
              <div className="attack-result">
                <span className={`stamp ${c7.status === "fail" ? "red" : ""}`}>{c7.status === "fail" ? "Rejected" : "Not caught"}</span>
                <p>
                  Check 7 {c7.status === "fail" ? "failed" : `was ${c7.status}`}: {c7.detail}.
                </p>
              </div>
            ) : (
              <div className="attack-result">
                <span className={`stamp ${otherFailed.length ? "red" : ""}`}>{otherFailed.length ? "Rejected" : "Not caught"}</span>
                <p>
                  {otherFailed.length
                    ? `Checks ${list(otherFailed)} also failed, so the proof is still rejected.`
                    : "Check 7 was the only check that failed, so no other check stops the impostor."}{" "}
                  The other checks: passed {list(otherPassed)}
                  {otherReview.length ? `; needs review ${list(otherReview)}` : ""}
                  {otherSkipped.length ? `; not run ${otherSkipped.map((c) => `${c.index} (${c.detail})`).join(", ")}` : ""}.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
