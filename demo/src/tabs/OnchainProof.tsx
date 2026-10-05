import { useApp } from "../App.tsx";
import { AddrLink, TabHead, TxLink } from "../components.tsx";

export function OnchainProof() {
  const { data, offline } = useApp();
  const c = data.deployment.contracts;
  return (
    <>
      <TabHead title="On-chain proof" lede="Every transaction behind this demo, with links to the block explorer." />
      <section className="sheet reveal" aria-labelledby="contracts-h">
        <p className="sheet-kicker" id="contracts-h">
          Contracts
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
          <dt>Deployed in</dt>
          <dd>
            <TxLink hash={data.deployment.deployTxs.VerifierAllowlist} />, <TxLink hash={data.deployment.deployTxs.EmissionsClaimRegistry} />
          </dd>
        </dl>
        {data.deployment.sourceVerified && <p className="fine">✓ Source verified on Etherscan</p>}
      </section>

      <section className="sheet reveal" aria-labelledby="tx-h">
        <p className="sheet-kicker" id="tx-h">
          Transactions behind this demo{offline && data.cached ? ` (cached ${data.cached.time.slice(0, 10)})` : ""}
        </p>
        {/* Explicit roles keep the table semantics when narrow screens restyle each row as a card. */}
        <div className="table-wrap">
          <table className="ledger tx-ledger" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">Step</th>
                <th scope="col" role="columnheader">Transaction</th>
                <th scope="col" role="columnheader">Block</th>
                <th scope="col" role="columnheader">Time (UTC)</th>
                <th scope="col" role="columnheader">Result</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {data.txs.map((t) => (
                <tr key={t.hash} role="row">
                  <td role="cell" data-label="Step">
                    {t.label}
                  </td>
                  <td role="cell" data-label="Transaction">
                    <TxLink hash={t.hash} />
                  </td>
                  <td role="cell" data-label="Block">
                    {t.block}
                  </td>
                  <td role="cell" data-label="Time (UTC)">
                    {t.time.replace("T", " ").slice(0, 16)}
                  </td>
                  <td role="cell" data-label="Result" className={t.result === "success" ? "tx-ok" : "tx-bad"}>
                    {t.result === "success" ? "✓ Success (status 1)" : "✕ Reverted (status 0)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">Attacks 2a and 2b are dry runs (eth_call) and leave no transaction.</p>
      </section>

      <section className="sheet reveal" aria-label="Data scope">
        <p className="fine">
          Network: Sepolia — proof-of-stake testnet. On-chain: hashes, addresses, timestamps, status and tonnage.
          Off-chain: the report itself, emissions values and importer names.
        </p>
        <p className="fine">
          Reproduce: <a href="https://github.com/zuemen/carbon-lei#quick-start">README › Quick start</a>
        </p>
      </section>
    </>
  );
}
