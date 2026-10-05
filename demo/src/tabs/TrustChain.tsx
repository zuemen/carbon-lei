import { useEffect, useState } from "react";
import { auditorAidHashOf, leiHashOf } from "../../../sdk/commitment.ts";
import { useApp } from "../App.tsx";
import { EVIDENCE_WHY, TabHead } from "../components.tsx";
import { short } from "../data.ts";

const STATUS = { valid: "✓ Valid", revoked: "✕ Revoked", suspended: "! Suspended", expired: "✕ Expired" } as const;

export function TrustChain() {
  const { data, reader, offline } = useApp();
  const [auditorOnChain, setAuditorOnChain] = useState<string>("…");
  const auditor = data.trustChain.find((n) => n.id === "auditor");
  const body = data.trustChain.find((n) => n.id === "body");
  const revoke = data.txs.find((t) => t.step === "revokeAuditor");

  useEffect(() => {
    if (!reader || offline || !auditor?.aid || !body?.lei) return;
    reader
      .client.readContract({
        address: reader.allowlist,
        abi: [
          {
            type: "function",
            name: "auditors",
            stateMutability: "view",
            inputs: [{ type: "bytes32" }, { type: "bytes32" }],
            outputs: [{ type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
          },
        ] as const,
        functionName: "auditors",
        args: [auditorAidHashOf(auditor.aid), leiHashOf(body.lei)],
      })
      .then(([, added, revoked]) =>
        setAuditorOnChain(added === 0n ? "Not listed" : revoked === 0n ? "✓ Listed" : `✕ Revoked${revoke ? ` at block ${revoke.block} — see attack 3` : ""}`),
      )
      .catch(() => setAuditorOnChain("unavailable"));
  }, [reader, offline, auditor, body, revoke]);

  return (
    <>
      <TabHead title="Who is allowed to sign" lede="Background: who is allowed to sign. You can skip this on a first visit.">
        <p className="fine">
          Each node is a verifiable credential. Status shown as of the evidence export on {data.exportDate} (hosted demo);
          the anchoring event is re-verified live in your browser.
        </p>
      </TabHead>
      <div className="grid-2">
        <section className="sheet reveal" aria-label="Credential chain">
          <ol className="chain">
            {data.trustChain.map((n, i) => (
              <li key={n.id} className="node">
                <span className="node-dot" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <div className="node-name">{n.name}</div>
                  <div className="node-role">{n.role}</div>
                </div>
                <span className={`badge ${n.status === "valid" ? "pass" : n.status === "suspended" ? "review" : "fail"}`}>
                  {STATUS[n.status]}
                </span>
                <div className="node-meta">
                  {n.lei && <>LEI {n.lei} · </>}
                  {n.aid && <>AID {short(n.aid, 8, 6)} · </>}
                  {n.credentialSaid && <>credential {short(n.credentialSaid, 8, 6)}</>}
                  {n.evidenceFile && (
                    <>
                      {" "}
                      · <a href={`${import.meta.env.BASE_URL}${n.evidenceFile}`}>View raw evidence (CESR format)</a>
                    </>
                  )}
                  {n.id === "auditor" && (
                    <div>
                      Credential (exported {data.exportDate}): {STATUS[n.status]} · On-chain allowlist (live): {auditorOnChain}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="fine" title={EVIDENCE_WHY}>
            The anchoring event's signature is verified live in your browser. The rest of the credential chain uses
            exported evidence ({data.exportDate}) — why? {EVIDENCE_WHY}
          </p>
        </section>
        <div>
          <section className="sheet reveal" aria-label="Impostor">
            <p className="sheet-kicker">Not in the chain</p>
            <h3>{data.impostor.name}</h3>
            {data.attacks.attack4 ? (
              <p>
                Posing as a verification body. Its vLEI chain leads to a root it controls, not to the root this page
                pins. In attack 4 a simulated theft of the operator key put it on the allowlist; check 7 rejects its
                proof and the watcher suspended it (Try to break it, card 4). LEI {data.impostor.lei} (fictional).
              </p>
            ) : (
              <p>
                Posing as a verification body: no vLEI, no accreditation — cannot join the allowlist. LEI {data.impostor.lei}{" "}
                (fictional).
              </p>
            )}
          </section>
          <section className="sheet reveal" aria-label="Who writes the allowlist">
            <p className="sheet-kicker">Who writes the allowlist</p>
            <p className="fine">
              In this demo, two operator keys. The trust-registry operator adds verification bodies and auditors and can
              rotate a body's address; a separate revocation watcher syncs suspensions and auditor revocations. Neither key
              can edit, revoke or re-assign a report or its tonnage. Every allowlist write is an on-chain event, and each
              addition carries credential hashes (SAIDs) you can re-check. Roadmap: a multisig of accreditation bodies.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
