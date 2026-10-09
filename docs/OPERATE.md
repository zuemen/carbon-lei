# Operating CarbonLEI: who runs what

This document says who runs which part of CarbonLEI in a deployment, and what each role sends and pays for.

Each row names code in this repository or a section of these docs. Gas per operation, and its price at mainnet and estimated L2 fees, is in [PILOT §6](PILOT.md#6-costs-test-network-and-production-chain); this page gives no money amounts.

## Operating model at a glance

Only the first column describes what exists. The pilot column restates the plan in [PILOT §2](PILOT.md#2-roles-and-what-each-must-provide); the production column lists options from [ADOPTION §3](ADOPTION.md#3-who-pays) and [§5.1](ADOPTION.md#51-participation-when-the-cap-binds). No organisation has agreed to any of it, and none has been contacted.

| | Hackathon demo (now) | Pilot (plan) | Production network (options) |
|---|---|---|---|
| Runs the allowlist (owner key) | The team, with a single test key in `.env` ([SECURITY §6](SECURITY.md#6-key-management-prototype)) | The team as trust-registry operator, with a multisig owner key; checks each body's vLEI chain before listing it | A governance body with NAB and QVI representatives ([ADOPTION §5](ADOPTION.md#5-adoption-path), phase 2); other candidates: a consortium of verification bodies, an accreditation body, an industry association, a trade or climate agency |
| Deploys the contracts | The team, on Sepolia; no proxy, so nobody can upgrade them ([SECURITY §5](SECURITY.md#5-smart-contract-assurance)) | The team, on an EVM test network first | The allowlist operator, on the chain chosen by the criteria in [ADOPTION §6.1](ADOPTION.md#61-technical); still not upgradeable |
| Runs the watcher (watcher key) | The team: one process for ECR revocations; suspensions sent by hand | The team: one or more watcher processes | Several independent watchers, each holding the watcher role the owner grants |
| Holds other keys | Demo wallets and KERI test passcodes, all held by the team | Verification body: its LE vLEI in a KERI agent, an EVM registration key and, where its tooling allows, a separate revocation wallet (incident procedure 1); lead auditor: a KERI identifier and its ECR; supplier: an EVM wallet; importer: no key | Same as the pilot |
| Pays | The team, in Sepolia test ether, which has no value | No chain cost in money on a test network; vLEI fees fall on the verification body | Main case (our inference, not tested): the body folds registration gas into its verification fee; the supplier pays claim gas; who funds the allowlist and the watchers is open (the "public infrastructure" row of ADOPTION §3 is one option) |
| Importer plugs in through | The hosted page, `carbonlei verify --json`, the PACT JSON export and the printable importer's file | The same; first step: feed the PACT JSON into the importer's own declaration software (not tested with any tool) | The same, plus a hosted verifier API (roadmap, [ADOPTION §8](ADOPTION.md#8-current-status-by-area)) |

**Recommended default (our proposal).** For the pilot, the team holds the allowlist owner key in a multisig, runs the watcher, and lists only bodies whose vLEI chain passes the onboarding check. The verification body pays its registration gas inside its fee, the supplier pays its claim gas, and importers pay nothing on-chain. Before the network phase, the team hands the allowlist to a governance body with `transferOwnership` to that body's multisig, and the new owner removes the watchers it does not keep (incident procedure 4). This is a proposal for discussion, not an arrangement anyone has agreed to.

## Roles

| Role | Runs what | What it sends or receives | Cost driver |
|---|---|---|---|
| Supplier (operator) | `carbonlei import-template` and `present` ([`sdk/cli.ts`](../sdk/cli.ts)); an EVM wallet ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)) | Receives its signed credential from the body; sends `claimShipment` once per shipment and the proof to each buyer | Claim gas, once per shipment |
| Verification body | A KERI agent holding its LE vLEI ([VLEI_SETUP](VLEI_SETUP.md)); `carbonlei issue` (EIP-712) and an EVM wallet | Sends `registerReport` once per report; sends the credential to the supplier | Registration gas; vLEI issuance fees set by each QVI ([ADOPTION §3](ADOPTION.md#3-who-pays)) |
| Lead auditor | A KERI identifier with its key event log ([`verifier/src/anchor.ts`](../verifier/src/anchor.ts)) | Anchors each credential's SAID in that log before registration | Hosting of the KERI agent, not estimated ([PILOT §6](PILOT.md#6-costs-test-network-and-production-chain)) |
| Trust-registry operator (allowlist owner key) | [`verifier/src/onboard-check.ts`](../verifier/src/onboard-check.ts), then `addVerifier` and `addAuditor` ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)) | Sends allowlist transactions; receives each body's vLEI chain to check | Gas per listed body and auditor; key custody (a single test key in the prototype, a multisig proposed for the pilot) |
| Watcher | [`verifier/src/watch.ts`](../verifier/src/watch.ts), a polling process with the watcher key. It syncs revocations on-chain; it is not a KERI watcher and does no duplicity detection | Reads the body's KEL through the witnesses; sends `revokeAuditor`; suspensions are sent by hand ([ARCHITECTURE](ARCHITECTURE.md)) | An always-on process and the gas of each sync |
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

## If the operator stops

Here "operator" means the trust-registry operator, which holds the allowlist owner key and the watcher key, and whoever hosts the static page; in the prototype and the pilot that is the team. This section is derived from the contract source and has not been tested as a scenario.

**What keeps working**

- **The records stay readable and cannot be changed.** The contracts have no proxy, no upgrade function and no pause ([SECURITY §5](SECURITY.md#5-smart-contract-assurance), "Why the contracts are not upgradeable"). `EmissionsClaimRegistry` has no owner; it holds only an immutable reference to the allowlist. Registered reports, the tonnage ledger, claims and revocations stay on the chain for as long as the chain runs, and no key can edit them.
- **Anyone can still verify.** `carbonlei verify` (MIT licence) runs checks 1–5 against any node of the chain (`--rpc`) and checks 6–7 on the evidence carried in the proof. The hosted page is a static build that anyone can rebuild from this repository and host elsewhere. No server of the operator is involved.
- **Listed bodies keep registering, revoking and being claimed against.** `registerReport` and `revokeReport` need only an active body (until its `accreditedUntil`) and, for registration, an auditor authorised on the allowlist; `claimShipment` needs only the report's supplier. None of them calls the owner or the watcher.
- **An importer can still** verify each proof, read the remaining tonnage, cite its claim transaction, export the PACT JSON and print the importer's file.

**What stops**

- **Listing and address changes.** Only the owner can call `addVerifier`, `addAuditor` and `rotateVerifierAddress`. No new body or auditor can be listed, a body that loses its EVM key cannot move to a new one, and an auditor who leaves cannot be replaced. An accreditation cannot be renewed on this deployment in any case (incident procedure 2), so once every listed body's `accreditedUntil` has passed, the deployment accepts no new reports.
- **Incident response.** Without the watcher key nobody can suspend a body, so the first step of incident procedure 1 is impossible, and a body that is suspended stays suspended, because nobody can lift it.
- **Revocation sync.** If the watcher stops, ECR revocations and accreditation withdrawals are no longer mirrored on-chain. A verifier then sees a report registered under an auditor whose ECR was revoked off-chain pass on-chain and pass check 4. Check 7 reads the auditor's status from the allowlist at the registering block, so it passes as well, unless the presented evidence itself carries a signed, anchored revocation dated before the registration ([SECURITY T18](SECURITY.md#4-threat-model)). The CONTESTED window is measured from a sync, so with no sync nothing is flagged. The chain shows no sign that the watcher has stopped, and nothing alerts anyone.

**Handing over**

- **Planned.** The owner calls `transferOwnership` to a successor's key, which also hands over the administration of the watcher role, and the successor removes leftover watchers (incident procedure 4). This needs the old owner key: if the operator disappears without handing over, nobody can take over this allowlist.
- **Unplanned.** The only route is a new deployment ([SECURITY §5, redeployment procedure](SECURITY.md#5-smart-contract-assurance)): new addresses and a new EIP-712 domain, so every credential in use is signed again, and reports with claimed shipments stay on the old contracts, because moving them would start a second tonnage ledger. The contracts do not link reports across deployments (`supersedes` names a report in the same registry only). Without the old watcher key the old deployment cannot be closed to new registrations either, because that step suspends every body on the old allowlist; its bodies can keep registering there until their `accreditedUntil`.
- **The chain itself.** Records last only as long as the chain they are on. Sepolia is a test network; the same question applies to whichever production chain is chosen.

## Not built

- ERP or EDI connectors: the inputs are an Excel template and JSON files ([`sdk/cli.ts`](../sdk/cli.ts)).
- A connection to any PACT network: the export is field-compatible JSON ([PACT_MAPPING](PACT_MAPPING.md); [ADOPTION §8](ADOPTION.md#8-current-status-by-area)).
- Witness operation beyond the local containers ([PILOT §3](PILOT.md#3-what-runs-where)).
- Custodial wallets: each party signs with its own key ([PILOT §2](PILOT.md#2-roles-and-what-each-must-provide)).
- Gas sponsorship: each sender pays its own gas ([PILOT §6](PILOT.md#6-costs-test-network-and-production-chain)).

## Next pilot step (plan, not a claim)

Weeks 1–2 of the [pilot plan](PILOT.md#5-twelve-week-plan): agree scope with a verification body, one operator and two or three importers, and set up the multisig owner. Which party has a reason to enforce the tonnage cap is in [ADOPTION §5.1](ADOPTION.md#51-participation-when-the-cap-binds). No organisation has been contacted.
