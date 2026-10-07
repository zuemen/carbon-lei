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

## Incident procedures

Steps that avoid the contract red-team findings on the deployed contracts, which are not redeployed for them ([SECURITY §4.2](SECURITY.md#42-findings-of-the-contract-red-team-review-7-october-2026)). The contract does not enforce any of them.

1. **A body's EVM key may have leaked: suspend first, then rotate (CR1, CR9).** The watcher sends `suspendVerifier` for the body at once: a suspended body cannot register or revoke, so the stolen key can no longer revoke the body's reports, and a revocation cannot be undone. Only then does the allowlist owner send `rotateVerifierAddress` to the body's new key, and the watcher sends `liftSuspension` once the new key is in place. Rotating first leaves the stolen key able to revoke until the rotation is mined. The verifier marks reports the stolen key registered within 24 hours before the suspension or rotation as CONTESTED, and a revocation sent from an address that is rotated away within 24 hours after it. A suspension alone does not contest a revocation (a legitimate revocation of a falsified report often comes with one), so the rotation is part of the response.
   **Detection limits.** The rules on the revoking address and on reports registered just before the response look at the time between the theft and the response, and a thief can wait: a body key found more than 24 hours after a revocation it sent leaves that revocation INVALID, and reports it registered more than 24 hours before the response VALID unless they changed the supplier address (the verifier contests any revision chain with another supplier address, whenever it happened). An address that a stolen owner key rotated in is judged by its tenure instead: if the owner rotates it away within 30 days of its rotation in (`minAddressTenureDays`), every report it registered or revoked is CONTESTED, whenever the thief acted. So the watcher alerts on every `VerifierAddressRotated` and `ReportRevoked` of the bodies it watches, and the owner answers an unexpected rotation within 30 days and an unexpected revocation within 24 hours. A larger `contestedWindowHours` or `minAddressTenureDays` gives more time, at the cost of more false positives from routine rotations (below). While the body is suspended, any other active body can take over its periods (T19 (7)), so the watcher tells the replacing bodies first. The body keeps its signing key for revocations in a separate wallet from its day-to-day registration key, where its tooling allows it.
2. **Before a body's accreditation expires: hand over (CR3).** An accreditation cannot be renewed on this deployment, and after `accreditedUntil` any active body can revise the body's credentials for good, with another supplier or more tonnes. Before that date the body, an agreed successor and the watcher hand over: the watcher suspends the body, and the successor at once revises each open credential, under its own verification report ID, with the same supplier address and the same `verifiedKg` (a takeover is first-come, T19 (7)). From then on the successor is the active issuer of those credentials and no third body can revise them. The verifier does not flag such a revision, nor the shipments claimed before it; it marks one by another body that moves the credential to another layer (CN code or route), raises the tonnes or changes the supplier address as CONTESTED. The suspension does flag the body's reports registered within the 24 hours before it (4l), so the body registers nothing in the day before the handover.
3. **Before a downward correction: freeze first (CR2).** A revision below the quantity already claimed reverts, and the supplier can claim the rest ahead of it. The body first registers a revision whose `verifiedKg` equals the quantity claimed so far (it cannot revert for over-claiming), then settles the difference with the supplier and its importers, or revokes. On a production chain it sends corrections through a private transaction channel.
4. **When the allowlist owner changes: remove leftover watchers (CR4).** `transferOwnership` does not remove WATCHER holders, and the contract cannot list them. The new owner lists every holder from the allowlist's `RoleGranted` and `RoleRevoked` events for `WATCHER_ROLE` and revokes each one it does not keep.

## Routine key rotation

A body's address is rotated on a schedule (yearly or quarterly) or when staff with access leave. Done this way it raises no CONTESTED result:

1. The new address is a fresh key, used for nothing before.
2. In the 24 hours before the rotation the body registers no report and revokes none with the old address: a report registered within 24 hours before its address is rotated away is CONTESTED (CR9), and so is a revocation (CR1), because that is what the response to a stolen key looks like.
3. The owner sends `rotateVerifierAddress`.
4. In the 24 hours after the rotation the body registers no report that its supplier claims at once: a shipment claimed within 24 hours after the registering address was rotated in is CONTESTED.
5. The new address stays in use for at least 30 days. An address rotated in and away again within 30 days is treated as one a stolen owner key installed: its reports and revocations are CONTESTED for good. A rotation done by mistake is therefore left in place for 30 days, or its reports are re-issued after review.

Shipments of reports the old address registered stay VALID across the rotation; the verifier no longer flags claims near a rotation or a suspension of the body. A suspension by the NAB flags only the reports registered within 24 hours before it (4l); a revocation it follows stays INVALID.

**False-positive estimate** (assumes registrations, claims and revocations spread evenly over the year, and nothing else unusual): without the procedure, each rotation or suspension makes about 24 h / 365 days ≈ 0.27 % of the body's yearly reports CONTESTED; the earlier rules (before 7 October 2026) also flagged every claim within 48 hours around the event, about 0.55 % of all the body's claims per event (2.2 % a year with quarterly rotation). With steps 2 and 4, none.

## Not built

- ERP or EDI connectors: the inputs are an Excel template and JSON files ([`sdk/cli.ts`](../sdk/cli.ts)).
- A connection to any PACT network: the export is field-compatible JSON ([PACT_MAPPING](PACT_MAPPING.md); [ADOPTION §8](ADOPTION.md#8-current-status-by-area)).
- Witness operation beyond the local containers ([PILOT §3](PILOT.md#3-what-runs-where)).
- Custodial wallets: each party signs with its own key ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)).
- Gas sponsorship: each sender pays its own gas ([PILOT §6](PILOT.md#6-costs-test-network-and-production-chain)).

## Next pilot step (plan, not a claim)

Weeks 1–2 of the [pilot plan](PILOT.md#5-twelve-week-plan): agree scope with a verification body, one operator and two or three importers, and set up the multisig owner. Which party has a reason to enforce the tonnage cap is in [ADOPTION §5.1](ADOPTION.md#51-participation-when-the-cap-binds). No organisation has been contacted.
