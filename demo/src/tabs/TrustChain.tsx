import { useEffect, useState } from "react";
import { auditorAidHashOf, leiHashOf } from "../../../sdk/commitment.ts";
import { useApp } from "../App.tsx";
import { EVIDENCE_WHY, TabHead } from "../components.tsx";
import { EVIDENCE_WHY_ZH, short } from "../data.ts";
import { PactVsVlei } from "./PactVsVlei.tsx";
import { PrecursorTrustChain } from "./Precursor.tsx";
import { VerifierLegitimacy } from "./VerifierRules.tsx";
import { useLang, useStrings } from "../i18n.ts";

/** The tab's strings in English and Traditional Chinese (Taiwan); names, LEIs, AIDs and SAIDs stay as they are. */
const H = {
  en: {
    title: "Who is allowed to sign",
    lede: "Background: who is allowed to sign. You can skip this on a first visit.",
    chain: "Credential chain",
    impostor: "Impostor",
    notInChain: "Not in the chain",
    writes: "Who writes the allowlist",
    note: (d: string) =>
      `Each node is a verifiable credential. Status shown as of the evidence export on ${d} (hosted demo); the anchoring event's signature is re-checked in your browser from that evidence. Signatures are Ed25519 (KERI) and secp256k1 ECDSA (Ethereum); neither is post-quantum safe.`,
    status: { valid: "✓ Valid", revoked: "✕ Revoked", suspended: "! Suspended", expired: "✕ Expired" },
    notListed: "Not listed",
    listed: "✓ Listed",
    revokedAt: (block?: number) => `✕ Revoked${block !== undefined ? ` at block ${block} — see attack 3` : ""}`,
    unavailable: "unavailable",
    credential: "credential",
    rawEvidence: "View raw evidence (CESR format)",
    auditorLine: (d: string, s: string, onChain: string) => `Credential (exported ${d}): ${s} · On-chain allowlist (live): ${onChain}`,
    anchorNote: (d: string) =>
      `The anchoring event's signature is verified live in your browser. The rest of the credential chain uses exported evidence (${d}) — why? `,
    impostorA4: (lei: string) =>
      `Posing as a verification body. Its vLEI chain leads to a root it controls, not to the root this page pins. In attack 4 a simulated theft of the allowlist owner key put it on the allowlist; check 7 rejects its proof and the watcher suspended it (Try to break it, card 4). LEI ${lei} (fictional).`,
    impostorText: (lei: string) => `Posing as a verification body: no vLEI, no accreditation — cannot join the allowlist. LEI ${lei} (fictional).`,
    writesBody:
      "In this demo, the allowlist owner key and the watcher key. The allowlist owner key (held by the trust-registry operator) adds verification bodies and auditors and can rotate a body's address; a separate watcher key syncs an auditor's revocation automatically (a watcher process polls the body's key event log) and, in this demo, sends suspensions by hand. Neither key can change a registered report's values, its registration time or the tonnage ledger. But a stolen allowlist owner key can rotate a body's address to its own, then register or revise reports in that body's name and revoke that body's reports, which nothing can undo; the verifier flags those revocations for review (CONTESTED) only once that address is rotated away again within 30 days of the rotation (SECURITY T10, CR1). Every allowlist write is an on-chain event, and each addition carries credential hashes (SAIDs) you can re-check. The contract trusts these keys: a stolen allowlist owner key can also list a fake body whose reports the contract accepts, and only the verifier's pinned root of trust catches it (Try to break it, card 4). Roadmap (a proposal; no organisation contacted): in a pilot the team holds this key in a multisig, then hands it to a governance body of NAB and QVI representatives.",
  },
  "zh-TW": {
    title: "誰有權簽署",
    lede: "背景資料：誰有權簽署。第一次瀏覽可以略過。",
    chain: "憑證鏈",
    impostor: "冒名者",
    notInChain: "不在鏈中",
    writes: "誰寫入允許清單",
    note: (d: string) =>
      `每個節點都是一份可驗證憑證。狀態以 ${d} 匯出證據時為準（託管示範）；錨定事件的簽章由您的瀏覽器依該證據重新檢查。簽章採用 Ed25519（KERI）與 secp256k1 ECDSA（Ethereum）；兩者都不具抗量子安全性。`,
    status: { valid: "✓ 有效", revoked: "✕ 已撤銷", suspended: "! 已暫停", expired: "✕ 已過期" },
    notListed: "未列入",
    listed: "✓ 已列入",
    revokedAt: (block?: number) => `✕ 已撤銷${block !== undefined ? `（區塊 ${block}，見攻擊 3）` : ""}`,
    unavailable: "無法取得",
    credential: "憑證",
    rawEvidence: "查看原始證據（CESR 格式）",
    auditorLine: (d: string, s: string, onChain: string) => `憑證（${d} 匯出）：${s} · 鏈上允許清單（即時）：${onChain}`,
    anchorNote: (d: string) => `錨定事件的簽章在您的瀏覽器中即時驗證。憑證鏈的其餘部分使用匯出的證據（${d}）——為什麼？`,
    impostorA4: (lei: string) =>
      `冒充驗證機構。它的 vLEI 鏈通往自己掌控的根，而不是本頁釘選的根。在攻擊 4 中，模擬遭竊的允許清單所有者金鑰把它加進了允許清單；檢查 7 拒絕了它的證明，監看者也暫停了它（「試著破解」卡片 4）。LEI ${lei}（虛構）。`,
    impostorText: (lei: string) => `冒充驗證機構：沒有 vLEI、沒有認證——無法加入允許清單。LEI ${lei}（虛構）。`,
    writesBody:
      "在本示範中，是允許清單所有者金鑰與監看者金鑰。允許清單所有者金鑰（由允許清單營運者持有）負責新增驗證機構與查核員，也能輪替機構的地址；另一把獨立的監看者金鑰會自動同步查核員的撤銷（由監看程式輪詢機構的金鑰事件日誌），在本示範中也以人工方式送出暫停。兩把金鑰都無法更改已登記報告的數值、登記時間或噸數帳本。但遭竊的允許清單所有者金鑰可以把某個機構的地址輪替成自己的，再以該機構名義登記或修訂報告，並撤銷該機構的報告，而這些撤銷無法復原；只有當該地址在輪替後 30 天內又被輪替掉時，驗證器才會把這些撤銷標示為需審查（CONTESTED）（SECURITY T10、CR1）。每一筆允許清單寫入都是鏈上事件，每次新增都附有您可以重新檢查的憑證雜湊（SAID）。合約信任這些金鑰：遭竊的允許清單所有者金鑰也能列入一個假機構，合約會接受它的報告，只有驗證器釘選的信任根能抓到它（「試著破解」卡片 4）。路線圖（僅為提案，尚未聯繫任何組織）：試行階段由團隊以多簽錢包持有這把金鑰，之後再移交給由 NAB 與 QVI 代表組成的治理機構。",
  },
};

/** Node roles and the auditor's note from demo-data.json in Traditional Chinese; null keeps the English (lang="en"). */
function roleZh(id: string, role: string): string | null {
  const paren = /\(([^)]+)\)$/.exec(role)?.[1];
  switch (id) {
    case "root":
      return role === "simulated GLEIF root" ? "模擬的 GLEIF 根" : null;
    case "qvi":
      return role === "Qualified vLEI Issuer" ? "合格 vLEI 簽發者（QVI）" : null;
    case "nab":
      return paren && /^National accreditation body/.test(role) ? `國家認證機構（${paren === "DE" ? "德國" : paren}）` : null;
    case "body":
      return paren && /^Accredited CBAM verification body/.test(role) ? `經認證的 CBAM 驗證機構（${paren}）` : null;
    case "auditor":
      return role === "CBAM Lead Auditor (ECR)" ? "CBAM 主任查核員（ECR）" : null;
    default:
      return null;
  }
}
function auditorNoteZh(note: string): string | null {
  const m = /synced it on-chain on (\S+) \(block (\d+)\)/.exec(note);
  return m && /^Revoked by the verification body after this export/.test(note)
    ? `此次匯出後遭驗證機構撤銷；監看者於 ${m[1]} 將撤銷同步上鏈（區塊 ${m[2]}）。早於撤銷同步 24 小時以上登記的報告（例如報告 1）在鏈上仍然有效。`
    : null;
}

export function TrustChain() {
  const { data, reader, offline } = useApp();
  // The allowlist's answer, kept as data and worded when shown (so switching the language re-renders it).
  const [auditorOnChain, setAuditorOnChain] = useState<"…" | "notListed" | "listed" | "revoked" | "unavailable">("…");
  const auditor = data.trustChain.find((n) => n.id === "auditor");
  const body = data.trustChain.find((n) => n.id === "body");
  const revoke = data.txs.find((t) => t.step === "revokeAuditor");
  const h = useStrings(H);
  const zh = useLang().lang === "zh-TW";
  const onChainText =
    auditorOnChain === "…" ? "…" : auditorOnChain === "revoked" ? h.revokedAt(revoke?.block) : h[auditorOnChain];

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
        setAuditorOnChain(added === 0n ? "notListed" : revoked === 0n ? "listed" : "revoked"),
      )
      .catch(() => setAuditorOnChain("unavailable"));
  }, [reader, offline, auditor, body, revoke]);

  return (
    <>
      <TabHead title={h.title} lede={h.lede}>
        <p className="fine">{h.note(data.exportDate)}</p>
      </TabHead>
      <div className="grid-2">
        <section className="sheet reveal" aria-label={h.chain}>
          <ol className="chain">
            {data.trustChain.map((n, i) => (
              <li key={n.id} className="node">
                <span className="node-dot" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <div className="node-name">{n.name}</div>
                  <div className="node-role">{zh ? (roleZh(n.id, n.role) ?? <span lang="en">{n.role}</span>) : n.role}</div>
                </div>
                <span className={`badge ${n.status === "valid" ? "pass" : n.status === "suspended" ? "review" : "fail"}`}>
                  {h.status[n.status]}
                </span>
                <div className="node-meta">
                  {n.lei && <>LEI {n.lei} · </>}
                  {n.aid && <>AID {short(n.aid, 8, 6)} · </>}
                  {n.credentialSaid && (
                    <>
                      {h.credential} {short(n.credentialSaid, 8, 6)}
                    </>
                  )}
                  {n.evidenceFile && (
                    <>
                      {" "}
                      · <a href={`${import.meta.env.BASE_URL}${n.evidenceFile}`}>{h.rawEvidence}</a>
                    </>
                  )}
                  {n.id === "auditor" && (
                    <div>
                      {h.auditorLine(data.exportDate, h.status[n.status], onChainText)}
                      {n.note && (
                        <div className="fine">{zh ? (auditorNoteZh(n.note) ?? <span lang="en">{n.note}</span>) : n.note}</div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="fine" title={zh ? EVIDENCE_WHY_ZH : EVIDENCE_WHY}>
            {h.anchorNote(data.exportDate)}
            {zh ? EVIDENCE_WHY_ZH : EVIDENCE_WHY}
          </p>
        </section>
        <div>
          <section className="sheet reveal" aria-label={h.impostor}>
            <p className="sheet-kicker">{h.notInChain}</p>
            <h3>{data.impostor.name}</h3>
            {data.attacks.attack4 ? <p>{h.impostorA4(data.impostor.lei)}</p> : <p>{h.impostorText(data.impostor.lei)}</p>}
          </section>
          <section className="sheet reveal" aria-label={h.writes}>
            <p className="sheet-kicker">{h.writes}</p>
            <p className="fine">{h.writesBody}</p>
          </section>
        </div>
      </div>
      <VerifierLegitimacy />
      <PrecursorTrustChain />
      <PactVsVlei />
    </>
  );
}
