// Trust chain tab, inside the check 6 panel, loaded on demand: check 6 on a key event log in which the
// identifier rotated its key. The KEL is a test identifier's, produced by keripy 1.2.13
// (sdk/test/fixtures/kel-rotation/SOURCE.md), not the demo auditor's, and it is not on Sepolia.
import { nextKeyDigest } from "../../../sdk/kel.ts";
import { anchorEvidenceFromKel, parseCesr, verifyAnchor } from "../../../sdk/vlei.ts";
import stream from "../../../sdk/test/fixtures/kel-rotation/kel.cesr?raw";
import cx from "../../../sdk/test/fixtures/kel-rotation/counter-examples.json";
import { short } from "../data.ts";

const msgs = parseCesr(stream);
const aid: string = msgs[0].ked.i;
const sn = 3;
const ev = anchorEvidenceFromKel(stream, aid, sn, cx.credSAID);
const expect = { credSAID: cx.credSAID, auditorAID: aid, kelSeq: BigInt(sn) };
const before: string = msgs[0].ked.k[0];
const after: string = msgs[2].ked.k[0];
const committed = nextKeyDigest(after) === msgs[0].ked.n[0];
const current = verifyAnchor(ev, expect);
const old = verifyAnchor({ ...ev, signatures: [{ qb64: cx.oldKeySignatureOnEvent3, index: 0 }] }, expect);

export function KeyRotation() {
  return (
    <div className="pvv-rotation">
      <p className="pvv-text">
        <strong>Offline KERI evidence from a test identifier (keripy 1.2.13), not on Sepolia.</strong> Its key event log:
        inception, interaction, rotation, then an interaction event anchoring a test credential. Check 6 is re-run here in
        your browser.
      </p>
      <ol className="pvv-rot-steps">
        <li>
          <span className="pvv-label">Identifier (AID), before and after</span>
          <span className="pvv-value">{short(aid, 8, 6)}</span>
          <span className="pvv-note">unchanged by the rotation at event #2</span>
          <span className="badge pass">✓ Same</span>
        </li>
        <li>
          <span className="pvv-label">Signing key</span>
          <span className="pvv-value">
            {short(before, 8, 6)} → {short(after, 8, 6)}
          </span>
          <span className="pvv-note">
            the new key's digest {short(msgs[0].ked.n[0], 8, 6)} was committed at inception (pre-rotation)
          </span>
          <span className={`badge ${committed ? "pass" : "fail"}`}>{committed ? "✓ Committed" : "✕ Not committed"}</span>
        </li>
        <li>
          <span className="pvv-label">Anchor event #{sn}, signed with the key in force</span>
          <span className="pvv-value">check 6 {current.ok ? "passes" : "fails"}</span>
          <span className="pvv-note">{current.detail}</span>
          <span className={`badge ${current.ok ? "pass" : "fail"}`}>{current.ok ? "✓ Verified" : "✕ Failed"}</span>
        </li>
        <li>
          <span className="pvv-label">The same event, signed with the rotated-out key</span>
          <span className="pvv-value">check 6 {old.ok ? "passes" : "rejected"}</span>
          <span className="pvv-note">{old.detail}</span>
          <span className={`badge ${old.ok ? "fail" : "pass"}`}>{old.ok ? "✕ Accepted" : "✓ Rejected"}</span>
        </li>
      </ol>
      <p className="pvv-text">
        Allowlist transactions: 0. The allowlist lists an auditor by the hashes of its AID and its body's LEI, and a
        rotation does not change the AID; a change of a verification body's EVM address, by contrast, needs a <code>rotateVerifierAddress</code>{" "}
        transaction from the allowlist owner key.
      </p>
    </div>
  );
}
