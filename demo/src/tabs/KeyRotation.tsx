// Trust chain tab, inside the check 6 panel, loaded on demand: check 6 on a key event log in which the
// identifier rotated its key. The KEL is a test identifier's, produced by keripy 1.2.13
// (sdk/test/fixtures/kel-rotation/SOURCE.md), not the demo auditor's, and it is not on Sepolia.
import { nextKeyDigest } from "../../../sdk/kel.ts";
import { anchorEvidenceFromKel, parseCesr, verifyAnchor } from "../../../sdk/vlei.ts";
import stream from "../../../sdk/test/fixtures/kel-rotation/kel.cesr?raw";
import cx from "../../../sdk/test/fixtures/kel-rotation/counter-examples.json";
import { short } from "../data.ts";
import { useLang, type Lang } from "../i18n.ts";

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

/** The block's strings in English and Traditional Chinese (Taiwan); the SDK's details stay English (lang="en"). */
const T = {
  en: {
    introStrong: "Offline KERI evidence from a test identifier (keripy 1.2.13), not on Sepolia.",
    intro: " Its key event log: inception, interaction, rotation, then an interaction event anchoring a test credential. Check 6 is re-run here in your browser.",
    aidLabel: "Identifier (AID), before and after",
    aidNote: "unchanged by the rotation at event #2",
    same: "✓ Same",
    keyLabel: "Signing key",
    keyNote: (d: string) => `the new key's digest ${d} was committed at inception (pre-rotation)`,
    committed: "✓ Committed",
    notCommitted: "✕ Not committed",
    anchorLabel: (sn: number) => `Anchor event #${sn}, signed with the key in force`,
    passes: "check 6 passes",
    fails: "check 6 fails",
    verified: "✓ Verified",
    failed: "✕ Failed",
    oldLabel: "The same event, signed with the rotated-out key",
    rejected: "check 6 rejected",
    accepted: "✕ Accepted",
    rejectedBadge: "✓ Rejected",
    tail: [
      "Allowlist transactions: 0. The allowlist lists an auditor by the hashes of its AID and its body's LEI, and a rotation does not change the AID; a change of a verification body's EVM address, by contrast, needs a ",
      " transaction from the allowlist owner key.",
    ],
  },
  "zh-TW": {
    introStrong: "來自測試識別碼（keripy 1.2.13）的離線 KERI 證據，不在 Sepolia 上。",
    intro: "它的金鑰事件日誌依序是：起始、互動、輪替，最後一個互動事件錨定一份測試憑證。檢查 6 會在您的瀏覽器中重新執行。",
    aidLabel: "識別碼（AID），輪替前後",
    aidNote: "事件 #2 的輪替沒有改變它",
    same: "✓ 相同",
    keyLabel: "簽署金鑰",
    keyNote: (d: string) => `新金鑰的摘要 ${d} 已在起始事件中預先承諾（預先輪替）`,
    committed: "✓ 已承諾",
    notCommitted: "✕ 未承諾",
    anchorLabel: (sn: number) => `錨定事件 #${sn}，以當時有效的金鑰簽署`,
    passes: "檢查 6 通過",
    fails: "檢查 6 未通過",
    verified: "✓ 已驗證",
    failed: "✕ 未通過",
    oldLabel: "同一個事件，改用已輪替掉的舊金鑰簽署",
    rejected: "檢查 6 拒絕",
    accepted: "✕ 被接受",
    rejectedBadge: "✓ 已拒絕",
    tail: [
      "允許清單交易：0 筆。允許清單是以查核員 AID 與其機構 LEI 的雜湊來登錄查核員，而輪替不會改變 AID；相對地，若要變更驗證機構的 EVM 地址，就需要由允許清單所有者金鑰送出一筆 ",
      " 交易。",
    ],
  },
} satisfies Record<Lang, unknown>;

export function KeyRotation() {
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const t = T[lang];
  return (
    <div className="pvv-rotation">
      <p className="pvv-text">
        <strong>{t.introStrong}</strong>
        {t.intro}
      </p>
      <ol className="pvv-rot-steps">
        <li>
          <span className="pvv-label">{t.aidLabel}</span>
          <span className="pvv-value">{short(aid, 8, 6)}</span>
          <span className="pvv-note">{t.aidNote}</span>
          <span className="badge pass">{t.same}</span>
        </li>
        <li>
          <span className="pvv-label">{t.keyLabel}</span>
          <span className="pvv-value">
            {short(before, 8, 6)} → {short(after, 8, 6)}
          </span>
          <span className="pvv-note">{t.keyNote(short(msgs[0].ked.n[0], 8, 6))}</span>
          <span className={`badge ${committed ? "pass" : "fail"}`}>{committed ? t.committed : t.notCommitted}</span>
        </li>
        <li>
          <span className="pvv-label">{t.anchorLabel(sn)}</span>
          <span className="pvv-value">{current.ok ? t.passes : t.fails}</span>
          <span className="pvv-note" lang={zh ? "en" : undefined}>
            {current.detail}
          </span>
          <span className={`badge ${current.ok ? "pass" : "fail"}`}>{current.ok ? t.verified : t.failed}</span>
        </li>
        <li>
          <span className="pvv-label">{t.oldLabel}</span>
          <span className="pvv-value">{old.ok ? t.passes : t.rejected}</span>
          <span className="pvv-note" lang={zh ? "en" : undefined}>
            {old.detail}
          </span>
          <span className={`badge ${old.ok ? "fail" : "pass"}`}>{old.ok ? t.accepted : t.rejectedBadge}</span>
        </li>
      </ol>
      <p className="pvv-text">
        {t.tail[0]}
        <code>rotateVerifierAddress</code>
        {t.tail[1]}
      </p>
    </div>
  );
}
