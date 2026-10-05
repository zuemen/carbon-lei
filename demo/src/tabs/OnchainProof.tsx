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
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Transaction</th>
                <th scope="col">Block</th>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.txs.map((t) => (
                <tr key={t.hash}>
                  <td>{t.label}</td>
                  <td>
                    <TxLink hash={t.hash} />
                  </td>
                  <td>{t.block}</td>
                  <td>{t.time.replace("T", " ").slice(0, 16)}</td>
                  <td>{t.result === "success" ? "✓ Success (status 1)" : "✕ Reverted (status 0)"}</td>
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
