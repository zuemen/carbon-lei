import { useApp } from "../App.tsx";
import { AddrLink, TabHead, TxLink } from "../components.tsx";
import { useLang, type Lang } from "../i18n.ts";

/** Traditional Chinese labels of the recorded transactions, by step ({t}: the tonnes in the English label from demo-data.json). */
const TX_LABEL_ZH: Record<string, string> = {
  addVerifier: "驗證機構加入允許清單",
  addAuditor: "新增查核員",
  registerReport1: "報告已登記",
  claim1: "批次已申領（{t} t）",
  impostorAddVerifier: "攻擊 4（模擬所有者金鑰外洩）：冒名機構加入允許清單",
  impostorAddAuditor: "攻擊 4（模擬所有者金鑰外洩）：新增冒名機構的查核員",
  impostorRegister: "攻擊 4：冒名者登記自己的報告——被接受（status 1）",
  impostorSuspend: "攻擊 4：監看者暫停冒名機構",
  revokeAuditor: "查核員撤銷已同步",
  attack3: "攻擊 3：撤銷後的新報告——已退回（status 0）",
};

const T = {
  en: {
    title: "On-chain proof",
    lede: "Every transaction behind this demo, with links to the block explorer.",
    contracts: "Contracts",
    deployedIn: "Deployed in",
    sourceVerified: "✓ Source verified on Etherscan",
    txs: "Transactions behind this demo",
    cached: (d: string) => ` (cached ${d})`,
    cols: ["Step", "Transaction", "Block", "Time (UTC)", "Result"],
    ok: "✓ Success (status 1)",
    bad: "✕ Reverted (status 0)",
    dryNote: (a4: boolean) => `Attacks 2a and 2b${a4 ? ", and attack 4's registration after the suspension," : ""} are dry runs (eth_call) and leave no transaction.`,
    ownerNote: " Attack 4's allowlist additions use the allowlist owner key to simulate its theft.",
    scopeLabel: "Data scope",
    scope:
      "Network: Sepolia — proof-of-stake testnet. On-chain: hashes, addresses, timestamps, status and tonnage. Off-chain: the report itself, emissions values and importer names.",
    reproduce: "Reproduce: ",
  },
  "zh-TW": {
    title: "鏈上證明",
    lede: "本示範背後的每一筆交易，都附上區塊瀏覽器的連結。",
    contracts: "合約",
    deployedIn: "部署交易",
    sourceVerified: "✓ 原始碼已在 Etherscan 驗證",
    txs: "本示範背後的交易",
    cached: (d: string) => `（快取 ${d}）`,
    cols: ["步驟", "交易", "區塊", "時間（UTC）", "結果"],
    ok: "✓ 成功（status 1）",
    bad: "✕ 已退回（status 0）",
    dryNote: (a4: boolean) => `攻擊 2a、2b${a4 ? "，以及攻擊 4 在暫停後的登記，" : ""}都是試算（eth_call），不會留下交易。`,
    ownerNote: "攻擊 4 加入允許清單的兩筆交易，是用允許清單的所有者金鑰來模擬金鑰遭竊。",
    scopeLabel: "資料範圍",
    scope: "網路：Sepolia（權益證明測試網）。鏈上：雜湊、地址、時間戳記、狀態與噸數。鏈下：報告本身、排放數值與進口商名稱。",
    reproduce: "自行重現：",
  },
} satisfies Record<Lang, unknown>;

export function OnchainProof() {
  const { data, offline } = useApp();
  const c = data.deployment.contracts;
  const { lang } = useLang();
  const zh = lang === "zh-TW";
  const t = T[lang];
  const [cStep, cTx, cBlock, cTime, cResult] = t.cols;
  return (
    <>
      <TabHead title={t.title} lede={t.lede} />
      <section className="sheet reveal" aria-labelledby="contracts-h">
        <p className="sheet-kicker" id="contracts-h">
          {t.contracts}
        </p>
        <dl className="fields">
          <dt>VerifierAllowlist</dt>
          <dd>
            <AddrLink address={c.VerifierAllowlist.address} label={c.VerifierAllowlist.address} />
          </dd>
          <dt>EmissionsClaimRegistry</dt>
          <dd>
            <AddrLink address={c.EmissionsClaimRegistry.address} label={c.EmissionsClaimRegistry.address} />
          </dd>
          <dt>{t.deployedIn}</dt>
          <dd>
            <TxLink hash={data.deployment.deployTxs.VerifierAllowlist} />, <TxLink hash={data.deployment.deployTxs.EmissionsClaimRegistry} />
          </dd>
        </dl>
        {data.deployment.sourceVerified && <p className="fine">{t.sourceVerified}</p>}
      </section>

      <section className="sheet reveal" aria-labelledby="tx-h">
        <p className="sheet-kicker" id="tx-h">
          {t.txs}
          {offline && data.cached ? t.cached(data.cached.time.slice(0, 10)) : ""}
        </p>
        {/* Explicit roles keep the table semantics when narrow screens restyle each row as a card. */}
        <div className="table-wrap">
          <table className="ledger tx-ledger" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">{cStep}</th>
                <th scope="col" role="columnheader">{cTx}</th>
                <th scope="col" role="columnheader">{cBlock}</th>
                <th scope="col" role="columnheader">{cTime}</th>
                <th scope="col" role="columnheader">{cResult}</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {data.txs.map((x) => (
                <tr key={x.hash} role="row">
                  <td role="cell" data-label={cStep}>
                    {!zh
                      ? x.label
                      : (TX_LABEL_ZH[x.step]?.replace("{t}", /\(([\d.]+) t\)/.exec(x.label)?.[1] ?? "?") ?? <span lang="en">{x.label}</span>)}
                  </td>
                  <td role="cell" data-label={cTx}>
                    <TxLink hash={x.hash} />
                  </td>
                  <td role="cell" data-label={cBlock}>
                    {x.block}
                  </td>
                  <td role="cell" data-label={cTime}>
                    {x.time.replace("T", " ").slice(0, 16)}
                  </td>
                  <td role="cell" data-label={cResult} className={x.result === "success" ? "tx-ok" : "tx-bad"}>
                    {x.result === "success" ? t.ok : t.bad}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">
          {t.dryNote(!!data.attacks.attack4)}
          {data.attacks.attack4 ? t.ownerNote : ""}
        </p>
      </section>

      <section className="sheet reveal" aria-label={t.scopeLabel}>
        <p className="fine">{t.scope}</p>
        <p className="fine">
          {t.reproduce}
          <a lang={zh ? "en" : undefined} href="https://github.com/zuemen/carbon-lei#quick-start">
            README › Quick start
          </a>
        </p>
      </section>
    </>
  );
}
