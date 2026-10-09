# Pilot readiness

What a first pilot of CarbonLEI would need, who would provide it, and what it would measure. **No partner has been contacted, and no organisation has agreed to take part.** Everything below is a plan built on the prototype. The figures in it come from the prototype's measurements in the [README](../README.md#measurements) and [ADOPTION](ADOPTION.md); none is a pilot result.

The pilot is phase 1 of the [adoption path](ADOPTION.md#5-adoption-path): around the first verified CBAM reports, from January 2027, alongside the official CBAM Registry flow. CarbonLEI does not submit anything to the Registry and does not replace it.

## The ask (dated 2026-10-07)

No organisation has been contacted; this is the request we would send.

**Who we are looking for.** One corridor, CN 7318 (screws, bolts and nuts) from Taiwan into the EU, and on it:

- **one verification body** accredited for CBAM by an EU national accreditation body, with one or two lead auditors;
- **one to three Taiwanese operators** whose CBAM reports that body verifies;
- **one or two EU importers** that buy from the same operator (a third can join later, see §1).

The pilot also needs a qualified vLEI issuer and the body's accreditation body to issue credentials (§2); we would approach them once a verification body has agreed.

**What each partner would do.**

| Partner | Does | Weeks active (of the 12-week plan in §5) |
|---|---|---|
| Verification body | Obtains a Legal Entity vLEI and ECRs for its lead auditors; issues one or two real reports as credentials and registers them; takes part in one revocation drill; comments on check 8's warnings | 1–9 and the review in week 12 |
| Operator | Gives its LEI and an EVM wallet; chooses which fields to disclose; claims its shipments against the verified tonnage | 1–2, then 5–9 and week 12 |
| Importer | Verifies each pilot shipment in the browser or the CLI (no wallet, nothing to install); times the check; tries the PACT export in its CBAM declaration software; says what it would need to rely on the result | 1–2, then 7–12 |

**What we provide.** The contracts deployed on a test network with a multisig owner; onboarding of the body and its auditors (`onboard-check`, `addVerifier`, `addAuditor`); the CLI, the SDK and the hosted verifier page; one or more watchers; written instructions for each step; and the results of §4, shared with every partner before anything is published.

**How long.** Twelve weeks from a signed scope (§5). Most weeks need only one partner; each partner's active weeks are in the table. The pilot runs alongside the official CBAM Registry flow and changes nothing in it.

We are not asking for money and not offering any. No partner has expressed interest so far.

## 1. Scope

| Item | Pilot scope |
|---|---|
| Corridor | One: screws, bolts and nuts (CN 7318) from Taiwan into the EU, the corridor the prototype is built for |
| Verification body | One EU-accredited CBAM verification body, with one or two lead auditors |
| Accreditation | The one national accreditation body (NAB) that accredits that verification body |
| vLEI issuer | One qualified vLEI issuer (QVI) |
| Operators | One or a few Taiwanese producers whose reports that body verifies |
| Importers | Two or three EU importers buying from the same operator, so that the tonnage ledger is shared by more than one importer (one importer is enough to start, see [ADOPTION §2.1](ADOPTION.md#21-benefits-with-a-single-importer)) |
| Chain | An EVM test network first; the production chain (an L2 or a permissioned EVM chain, [ADOPTION §6.1](ADOPTION.md#61-technical)) is a pilot decision |

## 2. Roles and what each must provide

| Role | Must provide | Does in the pilot |
|---|---|---|
| QVI | Legal Entity vLEIs for the verification body, and for the NAB if it issues credentials itself | Issues them under the production GLEIF root of trust (the prototype simulates that root) |
| NAB | A Legal Entity vLEI; willingness to issue a CBAM accreditation credential under our proposed schema (no NAB issues one today) | Issues the accreditation credential to the verification body; revokes it if accreditation is suspended or withdrawn |
| Verification body | A Legal Entity vLEI, the accreditation credential, an EVM wallet | Issues an ECR with the role `CBAM Lead Auditor` (our proposal) to each lead auditor; issues each report credential (`carbonlei issue`, EIP-712 signature) and registers it (`registerReport`) |
| Lead auditor | An ECR and a KERI identifier with its key event log | Anchors each credential's SAID in that log before registration |
| Operator (supplier) | Its existing LEI and an EVM wallet; no vLEI | Chooses the fields to disclose (`carbonlei present`); claims each shipment (`claimShipment`) |
| Importers | Their EORI number or a salted hash of it, for the on-chain claim | Verify each pilot shipment in the browser or with `carbonlei verify`; no wallet, nothing to install |
| Trust-registry operator (the CarbonLEI team during the pilot) | A multisig allowlist owner key instead of the prototype's single key; one or more watcher processes | Checks each body's vLEI chain before listing it (`node verifier/src/onboard-check.ts`), then `addVerifier` and `addAuditor`; runs the watcher (`verifier/src/watch.ts`) |

## 3. What runs where

| Component | Prototype | Pilot |
|---|---|---|
| Contracts (`VerifierAllowlist`, `EmissionsClaimRegistry`) | Ethereum Sepolia, source verified | A fresh deployment on the pilot chain; a multisig owner |
| vLEI chain (KERI agents, credentials) | Local KERIA stack, simulated GLEIF root, fictional parties | Real credentials from the QVI and the NAB; where the body's and auditor's KERI agents are hosted is to be agreed with the body |
| Verification (eight checks) | In the browser (GitHub Pages), the SDK and the CLI | The same code; a hosted verifier API is on the roadmap |
| Watcher | One process, ECR revocations only; suspensions sent by hand | Several independent watchers with liveness alerts (roadmap item to build for the pilot) |
| vLEI evidence for check 7 | Exported once from the local agents; witness receipts verified from the exported evidence, witnesses not queried | Exported from the real agents; querying the witnesses at verification time is on the roadmap ([SECURITY §4.1](SECURITY.md#41-limits-of-the-vlei-checks-in-the-prototype)) |
| PACT export | `carbonlei export-pact`, validated against the PACT v3.0.3 schema | Each importer tries the JSON in its existing CBAM declaration software (not tested with any specific tool so far) |

## 4. Success metrics

The pilot would measure these. We set no targets here: the prototype has no real users, so a target would be a guess. Where the prototype has a reference value, it is given, labelled as such.

| Metric | How the pilot measures it | Prototype reference |
|---|---|---|
| Verification time per shipment | Time from opening the supplier's proof to the importer's accept-or-default decision, against the importer's current check of the PDF copy (timed in the pilot) | Not measured |
| Share of shipments with a checkable verified value | Pilot shipments whose proof passes all seven verification checks, out of all pilot shipments from the pilot operators | — |
| Double-claim attempts blocked | Claims reverted by the contract (`ExceedsVerifiedTonnage`, batch already claimed) and proofs rejected by checks 4–5 | The demo's 400 t over-claim against 300 t left reverts |
| Revocation sync delay | Time from a revocation in KERI to the block of the on-chain sync, in a planned drill on a test credential | 16 seconds from detection to block, one Sepolia run |
| Onboarding time per role | Calendar time from a party's start to its first registered report, first claim or first verification; machine time recorded separately | 73.5 seconds of machine time to set up the simulated credential chain; excludes obtaining real LEIs and vLEIs |
| Checks not run | Verifications in which checks 6–7 failed for missing evidence or were skipped (a verifier without the vLEI checker reports them as skipped, never as passed) | — |
| Check 8 warnings | Advisory warnings, each reviewed by the verification body as useful or a false alarm | — |
| Cost per report | Gas for one registration and its claims on the pilot chain | 524,065 gas for one registration and one claim on Sepolia |

## 5. Twelve-week plan

| Weeks | Work | Done when |
|---|---|---|
| 1–2 | Agree scope, data shown on-chain and contacts; set up the multisig owner; choose the test network | Written scope signed off by every partner |
| 3–4 | QVI issues Legal Entity vLEIs; NAB issues the accreditation credential; body issues ECRs; onboarding check; `addVerifier`, `addAuditor` | The body and its lead auditors are listed on the pilot deployment |
| 5–6 | The body issues and registers its first pilot report; the auditor anchors it; the operator builds proofs | Report registered; a proof passes all seven verification checks |
| 7–9 | The operator claims shipments for two or three importers; importers verify each one; watchers run; one revocation drill on a test auditor credential | Every pilot shipment verified; the drill's sync delay recorded |
| 10–11 | Importers try the PACT export in their declaration software; the metrics in §4 are collected | Each importer has reported whether the import worked |
| 12 | Review with all partners: results, open risks, the production chain and governance (multisig of accreditation bodies, then shared governance) | A written go or no-go for phase 2 ([ADOPTION §5](ADOPTION.md#5-adoption-path)) |

## 6. Costs: test network and production chain

| Operation | Gas (Sepolia receipts) | When it is paid |
|---|---|---|
| `addVerifier` / `addAuditor` | 163,521 / 75,119 | Once per body / once per lead auditor |
| `registerReport` | 368,616 | Once per report |
| `claimShipment` | 155,449 | Once per shipment |
| `revokeReport` | 62,345 (median in the test suite) | Only if a report is revoked |
| One report's on-chain life (registration and one claim) | 524,065; 0.00052 ETH at an assumed 1 gwei. If deployed on mainnet: about US$0.32 at one 2026-10-07 block's base fee, about US$0.43 at the median of the 1,024 blocks before it; base fee only ([inputs](data/gas-usd-2026-10-07.json)) | — |
| The same on a public L2 (estimate, not a deployment) | Base: US$0.0066 (US$0.0079 with the suggested tip). OP Mainnet: US$0.00002 (US$0.0013 with the suggested tip). Arbitrum One: US$0.026. Median of six samples, 2026-10-09 09:23–09:35 UTC, ETH US$2,504 (CoinGecko); L2 execution fee plus L1 data fee ([raw](data/l2-fees-2026-10-09.json)) | — |

- **Test network:** test ether has no market value, so the pilot's chain cost is zero in money.
- **Production chain:** the cost depends on the chain chosen and its gas price. For Ethereum mainnet, the row above. For three public L2s, an estimate from a fork and each chain's own fee oracle at 2026-10-09 09:23–09:35 UTC; not a deployment, and fees vary. Method (`npm run bench:l2fees`, [`scripts/l2-fee-estimate.ts`](../scripts/l2-fee-estimate.ts)): the six Sepolia demo transactions (two deployments, `addVerifier`, `addAuditor`, `registerReport`, `claimShipment`) replayed with the same senders and calldata on `anvil --fork-url` of each chain, which used exactly the Sepolia gas; then, from the live chain, the latest block's base fee and, on Base and OP Mainnet, the L1 data fee from the GasPriceOracle predeploy (`getL1Fee` on the unsigned transaction, Fjord formula; operator fee read and zero), on Arbitrum One the L1 component from NodeInterface `gasEstimateL1Component`. Per operation (base fee only, median): `registerReport` US$0.0046 / 0.000013 / 0.019 and `claimShipment` US$0.0020 / 0.000006 / 0.0078 on Base / OP Mainnet / Arbitrum One; the two deployments together US$0.033 / 0.00029 / 0.13. The L1 data fee was under 1% of the total on Base and Arbitrum One (0.2–0.6% and 0.4–0.9% per operation, median) and over 90% on OP Mainnet, whose L2 base fee was about 1,000 wei. The base fees on Base (0.005 gwei) and Arbitrum One (about 0.02 gwei) barely moved across the samples, so the run shows little variance, and says nothing about busy periods. The OP Mainnet node suggests a 0.001 gwei tip, 1,000 times its base fee, which is why its two figures differ so much; what tip a wallet actually needs was not tested. Credentials, selective disclosure and the vLEI chain stay off-chain, so the gas count above does not grow with them.
- **Not estimated:** vLEI issuance fees, which each QVI sets and which fall on the verification body (and on an accreditation body that issues credentials itself); hosting of KERI agents and watchers. Who pays in the main case (our inference, not tested): the verification body pays registration gas and vLEI fees inside its verification fee, and the supplier (operator) pays claim gas ([ADOPTION §3](ADOPTION.md#3-who-pays), [OPERATE](OPERATE.md#operating-model-at-a-glance)).

## 7. Risks

| Risk | What the pilot does about it |
|---|---|
| No NAB issues an accreditation credential under our schema | Checks 1–5 need no KERI evidence and still run; check 7, which needs that credential, fails or is reported as skipped, never as passed, and the results say so |
| vLEI uptake cannot be measured publicly (GLEIF listed 8 QVIs on 23 September 2026) | Only the body, its lead auditors and the NAB need vLEIs; the operator uses its LEI |
| CBAM does not recognise vLEI or on-chain records | The Registry flow stays unchanged; the claim record is supporting evidence in the importer's own file only |
| Cold start: the tonnage cap protects only importers that check the same report | Two or three importers of the same operator; single-importer benefits ([ADOPTION §2.1](ADOPTION.md#21-benefits-with-a-single-importer)) |
| Volumes visible on-chain | Salted identifiers; the operator agrees in weeks 1–2 to what is shown; a permissioned chain is an option |
| A single owner or watcher key | Multisig owner from week 1; more than one watcher |
| Checks 6 and 7 do not query witnesses (the receipts come from the presented evidence) | Build witness queries before the drill in weeks 7–9, or report checks 6 and 7 with that limit |
| Batch IDs are not bound to the physical goods | Try binding a batch to the customs declaration or mill heat numbers with one importer |
| No external audit of the contracts | Audit before any production use; Slither runs in CI |

## 8. What we ask from partners

- **Verification body:** a Legal Entity vLEI, ECRs for one or two lead auditors, an EVM wallet, one or two real reports to issue as credentials, time for one revocation drill, and feedback on check 8's warnings.
- **NAB:** review of our proposed accreditation credential schema and, if it agrees, issuance of one credential.
- **QVI:** Legal Entity vLEIs for the body (and the NAB), and advice on whether an ECR or an official organisational role (OOR) credential fits the lead auditor's signature.
- **Operator:** its LEI, an EVM wallet, its choice of disclosed fields, and consent to the salted on-chain record of its claimed tonnage.
- **Importers:** to verify each pilot shipment, time the check, try the PACT export in their CBAM declaration software, and tell us what they would need to rely on it.

None of these has been requested yet. We will update this page only when a partner has agreed in writing.
