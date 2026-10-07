# Operating CarbonLEI: who runs what

This document says who runs which part of CarbonLEI in a deployment, and what each role sends and pays for.

Each row names code in this repository or a section of these docs. Gas per operation is in [PILOT §6](PILOT.md#6-costs-test-network-and-production-chain); this page gives no money amounts.

## Roles

| Role | Runs what | What it sends or receives | Cost driver |
|---|---|---|---|
| Supplier (operator) | `carbonlei import-template` and `present` ([`sdk/cli.ts`](../sdk/cli.ts)); an EVM wallet ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)) | Receives its signed credential from the body; sends `claimShipment` once per shipment and the proof to each buyer | Claim gas, once per shipment |
| Verification body | A KERI agent holding its LE vLEI ([VLEI_SETUP](VLEI_SETUP.md)); `carbonlei issue` (EIP-712) and an EVM wallet | Sends `registerReport` once per report; sends the credential to the supplier | Registration gas; vLEI issuance fees set by each QVI ([ADOPTION §3](ADOPTION.md#3-who-pays)) |
| Lead auditor | A KERI identifier with its key event log ([`verifier/src/anchor.ts`](../verifier/src/anchor.ts)) | Anchors each credential's SAID in that log before registration | Hosting of the KERI agent, not estimated ([PILOT §6](PILOT.md#6-costs-test-network-and-production-chain)) |
| Trust-registry operator (allowlist owner key) | [`verifier/src/onboard-check.ts`](../verifier/src/onboard-check.ts), then `addVerifier` and `addAuditor` ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)) | Sends allowlist transactions; receives each body's vLEI chain to check | Gas per listed body and auditor; key custody (a single test key in the prototype, a multisig proposed for the pilot) |
| Watcher | [`verifier/src/watch.ts`](../verifier/src/watch.ts), a polling process with the watcher key | Reads the body's KEL through the witnesses; sends `revokeAuditor`; suspensions are sent by hand ([ARCHITECTURE](ARCHITECTURE.md)) | An always-on process and the gas of each sync |
| Importer | The hosted page or `carbonlei verify` (`--json` for a [machine-readable verdict](schemas/verdict.schema.json)) | Receives the proof; sends only read requests to an RPC node; no wallet ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)) | None on-chain |
| Bank or downstream buyer | The same verifier as the importer ([ADOPTION §5.1](ADOPTION.md#51-participation-when-the-cap-binds)) | Receives the proof the supplier chooses to share | None on-chain |
| RPC providers | Public Sepolia nodes listed in `SEPOLIA_RPCS` ([`sdk/chain.ts`](../sdk/chain.ts)), or `--rpc` | Answer view calls and event searches; a node that fails is skipped ([README](../README.md#terminal-check-nodejs-2218-or-later-nvmrc-22200-no-docker-wallet-or-key)) | The provider's own limits; not measured |
| KERI witnesses | Local containers in [`verifier/docker-compose.yaml`](../verifier/docker-compose.yaml) in the prototype | Receipt KEL events; the verifier checks the receipts in the exported evidence and does not query witnesses ([PILOT §3](PILOT.md#3-what-runs-where)) | Hosting, not estimated |

## Static, browser-only, no server

- The hosted page: a static build on GitHub Pages ([`.github/workflows/pages.yml`](../.github/workflows/pages.yml)) that runs the checks in the browser and reads Sepolia through public RPC nodes ([ADOPTION §8](ADOPTION.md#8-current-status-by-area)).
- The Communication Template importer in the Supplier tab, which parses the file in a Web Worker and uploads nothing ([README](../README.md#start-from-the-commissions-communication-template)).
- `carbonlei verify`, which never sends a transaction ([`sdk/cli.ts`](../sdk/cli.ts)).

## Needs an operator

KERI agents of the body and its auditors, the watcher process and its key, the allowlist owner key, and a wallet for each party that sends a transaction ([PILOT §3](PILOT.md#3-what-runs-where)).

## Not built

- ERP or EDI connectors: the inputs are an Excel template and JSON files ([`sdk/cli.ts`](../sdk/cli.ts)).
- A connection to any PACT network: the export is field-compatible JSON ([PACT_MAPPING](PACT_MAPPING.md); [ADOPTION §8](ADOPTION.md#8-current-status-by-area)).
- Witness operation beyond the local containers ([PILOT §3](PILOT.md#3-what-runs-where)).
- Custodial wallets: each party signs with its own key ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)).
- Gas sponsorship: each sender pays its own gas ([PILOT §6](PILOT.md#6-costs-test-network-and-production-chain)).

## Next pilot step (plan, not a claim)

Weeks 1–2 of the [pilot plan](PILOT.md#5-twelve-week-plan): agree scope with a verification body, one operator and two or three importers, and set up the multisig owner. Which party has a reason to enforce the tonnage cap is in [ADOPTION §5.1](ADOPTION.md#51-participation-when-the-cap-binds). No organisation has been contacted.
