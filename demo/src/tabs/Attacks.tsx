import { useState } from "react";
import { verifyPresentation } from "../../../sdk/verify.ts";
import { useApp } from "../App.tsx";
import { TabHead, TxLink } from "../components.tsx";
import { CODE_TEXT, revertText } from "../messages.ts";
import { tamperedProof } from "./Buyer.tsx";

type Outcome = { stamp: string; text: string } | null;

export function Attacks() {
  const { data, reader, offline } = useApp();
  const [out, setOut] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState("");
  const a3 = data.attacks.attack3;
  const reg = data.txs.find((t) => t.step === "registerReport1");
  const waiting = !reader && !offline;
  const revoke = data.txs.find((t) => t.step === "revokeAuditor");

  async function attack1() {
    setBusy("a1");
    try {
      const p = tamperedProof(data.proof);
      if (!reader) throw new Error("not connected");
      const r = await verifyPresentation(p, reader, { importerEORI: data.importer.eori });
      const c2 = r.checks.find((c) => c.index === 2);
      setOut((o) => ({
        ...o,
        a1:
          c2?.status === "fail"
            ? { stamp: "Rejected", text: `Check 2 failed: ${CODE_TEXT.DISCLOSURE_TAMPERED}` }
            : { stamp: "Not caught", text: "Check 2 did not fail — please report this." },
      }));
    } catch (e) {
      setOut((o) => ({ ...o, a1: { stamp: "Error", text: (e as Error).message } }));
    } finally {
      setBusy("");
    }
  }

  async function dry(id: "a2a" | "a2b") {
    const spec = id === "a2a" ? data.attacks.sameBatch : data.attacks.secondImporter;
    if (offline || !reader) {
      const c = data.cached?.dryRuns[id === "a2a" ? "sameBatch" : "secondImporter"];
      setOut((o) => ({
        ...o,
        [id]: c
          ? { stamp: "Rejected", text: `Needs a live connection — shown here: the result recorded on ${data.cached?.time.slice(0, 10)}. Reverted: ${c.errorName} — ${revertText(c.errorName, c.args)}` }
          : { stamp: "Offline", text: "Needs a live connection." },
      }));
      return;
    }
    setBusy(id);
    const [reportKey, batchKey, qty, commit] = spec.args;
    const r = await reader.dryRun("claimShipment", [reportKey, batchKey, BigInt(qty), commit], spec.caller);
    setBusy("");
    setOut((o) => ({
      ...o,
      [id]: r.reverted
        ? { stamp: "Rejected", text: `Reverted: ${r.errorName} — ${revertText(r.errorName, r.args)}` }
        : { stamp: "Accepted", text: "The contract would accept this claim." },
    }));
  }

  const Result = ({ id }: { id: string }) => {
    const r = out[id];
    if (!r) return null;
    return (
      <div className="attack-result" role="status">
        <span className={`stamp ${r.stamp === "Rejected" ? "red" : ""}`}>{r.stamp}</span>
        <p>{r.text}</p>
      </div>
    );
  };

  return (
    <>
      <TabHead
        title="Try to break it"
        lede="Three attacks. Each one says how it is checked: in your browser, as a dry run against the live contract, or as a real transaction recorded on Sepolia."
      />
      {waiting && (
        <p className="conn" role="status">
          Connecting to Sepolia… the attack buttons unlock when the connection is ready.
        </p>
      )}
      <section className="sheet reveal" aria-label="Attacks">
        <div className="attack">
          <div>
            <h3>1 · Change one disclosed number</h3>
            <div className="how">Checked in your browser — no contract call</div>
            <p className="fine">The supplier's proof says 1.8 tCO2e/t. We change it to 1.2 and check the proof again.</p>
          </div>
          <button className="btn" disabled={busy === "a1" || waiting} onClick={attack1}>
            Change one disclosed number
          </button>
          <Result id="a1" />
        </div>

        <div className="attack">
          <div>
            <h3>2a · Claim the same batch again</h3>
            <div className="how">Dry run against the live Sepolia contract (eth_call) — no private key</div>
            <p className="fine">The supplier tries to sell batch {data.shipment.batchId} a second time, to another importer.</p>
          </div>
          <button className="btn" disabled={busy === "a2a" || waiting} onClick={() => dry("a2a")}>
            Claim the same batch again
          </button>
          <Result id="a2a" />
        </div>

        <div className="attack">
          <div>
            <h3>2b · The supplier claims {data.attacks.secondImporter.quantityTonnes} t more for a second importer</h3>
            <div className="how">Dry run against the live Sepolia contract (eth_call) — no private key</div>
            <p className="fine">
              Only {data.report.verifiedTonnes} t were verified and {data.shipment.quantityTonnes} t are already claimed. The
              ledger is shared by every importer.
            </p>
          </div>
          <button className="btn" disabled={busy === "a2b" || waiting} onClick={() => dry("a2b")}>
            Claim {data.attacks.secondImporter.quantityTonnes} t more
          </button>
          <Result id="a2b" />
        </div>

        <div className="attack">
          <div>
            <h3>3 · The auditor leaves the firm, then signs a new report</h3>
            <div className="how">
              Real Sepolia transaction — reverted, status 0 —{" "}
              {a3 ? <TxLink hash={a3.hash} label="view on explorer" /> : "not recorded yet"}
            </div>
            <p className="fine">This transaction was sent when the demo was set up; nothing is sent from your browser.</p>
          </div>
          <span />
          {a3 && (
            <div className="attack-result">
              <span className="stamp red">Rejected</span>
              <p>
                Reverted: <code>AuditorNotAuthorized</code> — {revertText("AuditorNotAuthorized")} The report registered
                before the revocation sync stays valid.
              </p>
            </div>
          )}
          <div className="timeline" style={{ gridColumn: "1 / -1" }}>
            <div>
              <div className="tl-k">✓ Valid</div>
              Registered more than 24 h before the revocation sync
              {reg && (
                <div className="fine">
                  Report 1: block {reg.block} · {reg.time.replace("T", " ").slice(0, 16)} UTC
                </div>
              )}
            </div>
            <div>
              <div className="tl-k">! Needs human review</div>
              Registered within 24 h before the sync (CONTESTED)
              {revoke && (
                <div className="fine">
                  Revocation synced: block {revoke.block} · {revoke.time.replace("T", " ").slice(0, 16)} UTC
                </div>
              )}
            </div>
            <div>
              <div className="tl-k">✕ Rejected</div>
              Registered after the sync
              {a3 && (
                <div className="fine">
                  Attack 3: block {a3.block} · {a3.time.replace("T", " ").slice(0, 16)} UTC
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
