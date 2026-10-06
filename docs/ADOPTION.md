# Implementation and adoption strategy, and scalability roadmap

All companies are fictional. CarbonLEI is a hackathon prototype on a public testnet. Nothing here is connected to the CBAM Registry, Chainlink ACE or any PACT network.

## Summary

- **First users:** EU-accredited verification bodies, third-country operators (starting with Taiwanese fastener makers) and EU importers who declare CBAM goods. Only the verification body and its lead auditors need vLEI credentials (and an accreditation body, if it issues the accreditation credential itself); an operator needs no vLEI (its LEI identifies it; it needs an EVM wallet to claim shipments), and an importer needs no vLEI and no wallet to verify a proof.
- **Why they would use it:** CarbonLEI is built for use outside the CBAM Registry, which is not open to the general public: wherever a verified report travels (downstream buyers, banks, product passports, the e-signed PDF copy in 2027), the verifier's authority stays machine-checkable, and one verified report can be reused with several EU customers up to its verified tonnage, a cap across importers for which we found no public mechanism. The importer can check both before relying on actual values and can cite the on-chain claim record for its shipment; for reports that stay inside the Registry, CarbonLEI adds a machine-checkable record and no new emissions data (§1.1).
- **What it does not replace:** the CBAM Registry, the verification itself, or accreditation. How CarbonLEI relates to the Registry is set out in §1.1.
- **When:** the first CBAM verification reports are expected in January 2027 [1].

---

## 1. What CarbonLEI replaces and what it does not

| Existing element | Role | CarbonLEI |
|---|---|---|
| CBAM Registry (including the portal for third-country operators) | Official channel. From 1 January 2027, verifiers issue verification reports in the Registry [3]; operators share emissions data and reports with declarants; declarations; certificates [2]. Not open to the general public [16]. | **Not replaced.** A portable check of the same report for parties outside the Registry (customers, banks, product passports). Export is field-compatible with the report data; there is no connection to the Registry. See §1.1. |
| Verification by an accredited verifier | Checks the emissions data | **Not replaced.** CarbonLEI proves who signed and whether they had authority |
| NAB accreditation | Grants, suspends, withdraws accreditation [3] | **Not replaced.** Mirrored as a revocable credential issued by the NAB |
| GLEIF, QVIs, LEI | Global legal entity identity | Used as is: the operator's LEI; LE vLEI and ECR credentials for verification bodies and their lead auditors |
| PACT data exchange | PCF exchange between companies | CarbonLEI exports a PACT v3 `ProductFootprint` (field-compatible); see [PACT_MAPPING.md](PACT_MAPPING.md) |

### 1.1 Relationship to the CBAM Registry

The CBAM Registry is the official channel, and CarbonLEI does not change it. This section sets out what the Registry already does, what we could not find in public documents, and where CarbonLEI sits. Sources were read on 24 September 2026.

**What the Registry already does**

- From 1 January 2027, the verifier issues the verification report in the CBAM Registry (Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3 [3]).
- Verifiers use the Registry through EU Login accounts with two-factor authentication. When the account is requested, the verifier submits proof of representation, such as a power of attorney, and staff acting under delegation have the same permissions (CBAM Registry access documents for verifiers, p.14 [19]). Inside the Registry, the question "does this person act for this verifier?" is handled at account level.
- A verifier shall not issue a verification report where one already covers the same reporting period for the same installation. At the operator's request, the verifier may issue a revised version (Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3 [3]).
- A registered operator can upload its data once and share it with all declarants (CBAM guidance document No. 2, p.5 [20]). It may choose to disclose only the summary of its emissions report to a declarant (Implementing Regulation (EU) 2025/2547, recital 17 [17]).
- Customs cross-checks are carried out for each CBAM declarant (Regulation (EU) 2023/956 as amended, Art 25(3) [22]), and CBAM declarations can be reviewed after submission (Art 19 [22]).

**Access and format**

- "The CBAM Registry is not available to the general public, nor to operators that have not yet registered" (Guidance on CBAM verification and accreditation for verifiers and National Accreditation Bodies, 24 August 2026, p.124, §10.2 [16]). The sentence appears in the section on the database of accredited verifiers.
- An operator that has not registered receives a copy of the verification report "in a standardised electronic format … for information purposes only" (Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3 [3]). The Commission's guidance describes this copy as an electronically signed PDF (p.68, §4.15 [16]).
- In 2027, operators are not required to register and may send the information to declarants outside the CBAM Registry (CBAM Q&A, p.44 [21]; legal basis: Implementing Regulation (EU) 2025/2547, Art 10(3) [17]). The declarant then uploads the e-signed PDF (verification guidance, p.68 [16]).
- The operator manual marks the Registry's verification report function as reserved for future functionality, so the signature format is not yet public (O3CI manual, p.126 [18]).

**Data fields**

- Neither the operator's emissions information in the Registry nor the summary of the emissions report has a production-quantity field (O3CI manual, §4.5, pp.96–101 [18]; Implementing Regulation (EU) 2025/2547, Annex IV, point 1.2 [17]).
- The summary does include the total direct emissions of the installation and per production process (Implementing Regulation (EU) 2025/2547, Annex IV, point 1.2, item (5) [17]), so production can be roughly estimated from it. Production quantities appear in the full verification report (Implementing Regulation (EU) 2025/2546, Annex, point 2.4(b)(3) [8]).
- CBAM embedded emissions differ in scope from an ISO 14067 product carbon footprint (CBAM guidance document No. 2, p.6 [20]).

**What we did not find**

- We found no public mechanism that caps the total tonnage claimed against one verified report across declarants. The Commission receives every declaration and can review it after submission (Art 19 [22]); what we did not find is a cap that a buyer outside the Registry can check for itself before relying on the value. The one-report rule above concerns issuing a second report for the same installation and period, not how many declarations rely on one report. We searched Regulations (EU) 2023/956 and 2025/2083, Implementing Regulations (EU) 2024/3210, 2025/2546, 2025/2547 and 2025/2550, Delegated Regulation (EU) 2025/2551, the verification guidance, the Registry manuals for operators, verifiers and declarants, CBAM guidance document No. 2 and the Commission's Q&A.
- The documents we reviewed do not describe a channel for passing verified values to downstream customers, banks, PACT data exchange or product passports.

**Where CarbonLEI sits**

- For reports that stay inside the Registry, CarbonLEI adds a machine-checkable record and no new emissions data. It does not replace the Registry's proof-of-representation step or its one-report rule.
- Outside the Registry, CarbonLEI lets a party without Registry access check by machine who signed a report and whether the signer had authority, and lets buyers apply a voluntary tonnage cap across importers. Both are voluntary uses, not CBAM requirements.
- CarbonLEI has no connection to the Registry. Its export follows the fields of the verification report template [8].

---

## 2. First users

| User | Current pain | What CarbonLEI gives them | What they must do |
|---|---|---|---|
| EU-accredited verification body | Inside the CBAM Registry, its proof of representation is submitted when its EU Login account is requested [19]. Outside the Registry, what travels is an electronically signed PDF [16], and we found no public mechanism that lets a customer or bank check by machine that the signer still acts for the body | A machine-checkable deliverable: report credential signed by the body, anchored by the lead auditor, registered on-chain. Why a body would take this on (our inference, not tested): it can set the body apart when competing for non-EU clients; it gives the body a tamper-evident record of exactly what it signed and when, which limits disputes over altered copies; and it lets the body revoke a report or an auditor's credential in a way downstream users can check | Hold an LE vLEI; issue ECRs to lead auditors; hold an EVM wallet; register reports |
| Third-country operator (e.g. Taiwanese fastener maker) | Must share verified data with several EU customers; wants to keep process data private; customers outside the Registry receive only a PDF copy | One verified report reused across customers up to the verified tonnage; selective disclosure of fields | Hold an LEI, which is already accepted as an operator identifier for operators from countries such as Taiwan [4]. An LE vLEI is optional: the local demo issues one to the supplier, but none of the eight checks requires it. Hold an EVM wallet; claim shipments |
| Buyer (EU importer or downstream customer) | Must decide whether to trust an actual value; for the demo's illustrative verified value, the gap to the marked-up default accounts for about €97 per tonne of goods in 2026, gross, at the Q3 2026 certificate price of €82.32 ([CLIMATE_IMPACT.md](CLIMATE_IMPACT.md), Section 2) | The eight checks in a browser (seven verification checks and one advisory reconciliation check), no wallet needed; default vs verified comparison; an on-chain record of each claim made for it, useful even when it is the only importer taking part (§2.1) | Verify the supplier's proof; give the supplier its EORI number, or a salted hash of it, for the on-chain claim |
| Bank or other financier of the trade | Relies on emissions data from an electronically signed PDF whose signer's authority it cannot check by machine; has no access to the CBAM Registry | The same eight checks in a browser, no wallet needed; the on-chain claim record of the batch it finances | Verify proofs the supplier shares with it |
| National accreditation body | Accreditation status is not visible to downstream users in machine-readable form | A credential it can revoke, mirrored on-chain as a suspension with the watcher key (sent manually in the prototype) | Hold an LE vLEI; issue accreditation credentials |
| QVI | — | Demand for LE vLEIs and ECRs from verification bodies. GLEIF's website listed 8 QVIs on 23 September 2026 [15]; GLEIF does not publish how many vLEIs have been issued | Existing vLEI issuance |

Downstream customers and banks work outside the CBAM Registry, which is not open to the general public. For them, CarbonLEI keeps the verification body's authority machine-checkable and offers a voluntary cap, across importers, on the tonnes claimed against one verified value. In the demo, EU importers and downstream customers use the same tab, 'Buyer'.

### Why these users first

- Taiwan is the EU's second-largest external source of CN 7318 goods: 20.3% of extra-EU imports by weight in 2025 [5].
- Verification capacity looks like the bottleneck (our reading of the accreditation figures): in the Commission's state of play of 29 September 2026, only 5 of the 24 EU/EEA national accreditation bodies offering CBAM accreditation were accepting non-EU verifier applications, and on 7 October 2026 the Commission had not yet published its list of accredited verifiers [1].
- Taiwan's Ministry of Environment counts about 2,600 affected small and medium-sized enterprises, mainly makers of steel products and metal fasteners [14].
- In a press release of 9 March 2026, Europe's fastener distributors called CBAM "a drastic punitive tariff on imported screws, nuts and other fasteners"; missing verification capacity was one of the reasons given [6].

### 2.1 Benefits with a single importer

The tonnage ledger stops over-use across importers only when the importers that rely on the same report check it. Adoption will start with one importer at a time, so the first importer needs a reason of its own.

- **Checks before accepting an actual value.** The importer runs the eight checks in a browser before it accepts the supplier's verified value instead of the default value.
- **An on-chain claim record (the importer's receipt).** When the supplier claims a shipment for the importer, the claim is recorded on-chain together with the report it draws on, the tonnage and the block time. The importer can cite this record, which shows the report and the tonnes its shipment drew on, in case its CBAM declaration is reviewed after submission under Art 19 of Regulation (EU) 2023/956, as amended by Regulation (EU) 2025/2083 [22]. This is our assessment, not a regulatory position: CBAM does not recognise on-chain records (§7), so the receipt supports the importer's own file and does not replace any document the rules require. On the hosted page, after accepting the verified value, the importer can download a verification record (JSON, built in the browser and not signed) with the check results, the credential ID and a link to this claim transaction, for that file.
- **Protection across importers grows with adoption.** Each additional importer that checks the same report extends the tonnage cap to more of that report's use. With a single importer, the cap limits only that importer's own claims.

---

## 3. Who pays

Options for a pilot. None is tested. Main case (our inference): the verification body folds the cost into its verification fee, because it is the party that registers the report and it already has a fee relationship with the operator. The other rows are alternatives.

| Option | Payer | What they pay for |
|---|---|---|
| Per registered report | Verification body, passed into its verification fee (main case; inference, not tested) | Anchoring, registration gas, credential issuance |
| Per verification | EU importer | Hosted verification API and evidence archive |
| Per claim | Operator | Claim gas and hosting of the supplier's proof |
| Public infrastructure | Trade or climate agencies | Allowlist governance and watchers as a shared service |

Measured gas on Sepolia (transaction receipts of the demo, 5 October 2026): `registerReport` 368,616 gas and `claimShipment` 155,449 gas; the medians in the contract test suite's gas report are 368,604 and 155,425. Adding a verification body (`addVerifier`) took 163,521 gas and adding an auditor (`addAuditor`) 75,119 gas. What this costs in money depends on the production chain and its gas price (§6.1); Sepolia test ether has no value. vLEI issuance fees are set by each QVI and are not estimated here. They fall on verification bodies (and on an accreditation body that chooses to issue credentials), not on operators or importers.

---

## 4. How easy it is to adopt

| Factor | Why it lowers the barrier |
|---|---|
| No new identifier | LEI is already listed in the Commission's guidance as an accepted operator identifier for operators from countries such as Taiwan [4]; `urn:lei` is an IANA-registered URN namespace [7]. Operators need only the LEI; vLEI credentials are needed only by verification bodies and their lead auditors (and by an accreditation body that issues the accreditation credential itself) |
| Importers need no wallet | Verification is read-only: in the browser on the hosted page, or with `carbonlei verify` on the command line |
| Fits existing data exchange | PACT v3 JSON export with `companyIds: ["urn:lei:…"]` (`carbonlei export-pact`). First pilot step: feed this JSON into the CBAM declaration software the importer already uses (not tested with any specific tool). The hosted demo builds the same export in the browser after a valid verification ("Download PACT product footprint (JSON)" on the Buyer tab), with the same function as the CLI; it is not a conformance claim and is not connected to any PACT network |
| Graceful degradation | Checks 1–5 (credential integrity, disclosed fields, the verification body's EIP-712 signature, the on-chain report and the shipment claim) need no KERI evidence. A proof that carries no KERI or vLEI evidence fails checks 6 and 7 (`ANCHOR_NOT_FOUND`, `AUTHORITY_INVALID`); a verifier without the vLEI checker reports them as skipped, never as passed, so the buyer sees what was not checked |
| Open source | MIT license; contract source verified on Etherscan: [`VerifierAllowlist`](https://sepolia.etherscan.io/address/0xF7AD0cbe867eb9CE4847Af3717C2d27f6434Ea5C#code), [`EmissionsClaimRegistry`](https://sepolia.etherscan.io/address/0xEA52a50d3753bACD835DCd47892754b65a90ca19#code) |
| Standards-based | ISO 17442 (LEI), ISO 17442-3 (vLEI), PACT v3.0.3, EIP-712 |
| Aligned with CBAM data | Credential fields follow the verification report template: accreditation number, NAB, site visit, materiality, assurance level, report ID [8] |

Onboarding steps for each role, as built in the prototype. The operator's steps do not include obtaining a vLEI.

| Role | Steps in the prototype |
|---|---|
| Trust-registry operator (allowlist owner key) | Check the body's vLEI chain off-chain before adding it (`node verifier/src/onboard-check.ts`; the demo's impostor body, which has no LE vLEI and no accreditation in the demo chain, is refused; attack 4 simulates a stolen allowlist owner key that skips this check); add the body with `addVerifier` (LEI hash, wallet address, hashes of its LE vLEI and accreditation credentials, accreditation expiry) and each lead auditor with `addAuditor` (AID hash, hash of the ECR credential) |
| Verification body | Hold an LE vLEI and an accreditation credential; issue an ECR to each lead auditor; hold an EVM wallet; issue each report credential (`carbonlei issue`, EIP-712 signature with the body's key) and register it with `registerReport` |
| Lead auditor | Hold an ECR; anchor each credential's SAID in the auditor's KEL before registration |
| Operator (supplier) | Hold an LEI and an EVM wallet; build a proof with the fields it chooses to disclose (`carbonlei present`); claim each shipment with `claimShipment` |
| Buyer or bank | Nothing to install; open the proof on the hosted page or run `carbonlei verify` |

Measured time: setting up the whole simulated credential chain locally (8 KERIA agents: simulated GLEIF root, QVI, NAB, verification body, lead auditor, supplier, importer and the impostor body) took 73.5 seconds with `npm run vlei:setup` (see [VLEI_SETUP.md](VLEI_SETUP.md)). This is machine time for the simulated chain. It does not include obtaining a real LEI or real vLEI credentials from a QVI, which depends on the QVI.

---

## 5. Adoption path

| Phase | When | Scope | Exit criterion |
|---|---|---|---|
| 0. Prototype | Hackathon, October 2026 | Sepolia; fictional parties; simulated GLEIF root; single allowlist key | Demo flow and four counterexamples: hosted demo at https://zuemen.github.io/carbon-lei/; locally, `npm run demo:local` reproduces the first three, and attack 4 runs with `scripts/demo-scenario.ts --synthetic-impostor` (see the [README](../README.md) and [VLEI_SETUP.md](VLEI_SETUP.md)) |
| 1. Pilot | Around the first verified reports, from January 2027 | One verification body holding a real LE vLEI and ECRs from a QVI; a few operators using their LEI; one or two importers (one is enough to start, see §2.1); multisig allowlist. First step: the importer feeds the PACT JSON export into its existing CBAM declaration software | Reports used in real declarations alongside the official Registry flow |
| 2. Network | After pilot | Several verification bodies and NABs; governance body with NAB and QVI representatives; several watchers; production chain decision (EVM L2 or permissioned EVM) | Independent operation without the project team |
| 3. Extension | Later | Other CBAM goods, product passports, business wallets (see §6) | — |

---

## 6. Scalability roadmap

### 6.1 Technical

| Item | Plan |
|---|---|
| Throughput and cost | Per report: one registration; per shipment: one claim. State grows linearly with reports and shipments. Measured on Sepolia: 368,616 gas per `registerReport` and 155,449 gas per `claimShipment` (§3) |
| Chain choice | Any EVM chain. Sepolia for the prototype; an L2 or a permissioned EVM for production |
| Watchers | Several independent watchers; alerts on sync delay |
| Allowlist governance | Multisig → timelocked governance; watcher role limited to suspend, lift and revoke |
| Signature verification on-chain | P-256 precompile path (see [SECURITY.md](SECURITY.md#future-on-chain-verification-of-keri-signatures)) |
| Interoperability | `credentialRecord(address)` returns `(credType, expiresAt, credHash)`, in the pattern of Chainlink CCID credential records [9]. Not integrated; Chainlink ACE is in beta |

### 6.2 Other CBAM goods and countries

- **Same model, other goods.** The credential carries a CN code, a production route and a reporting period. Nothing is specific to fasteners.
- **Cement from Türkiye.** Türkiye has its own operator identifier, the tax number (VKN), listed in the Commission's guidance [4]. There the Operator ID stays the VKN, and the LEI travels as an additional attribute.
- **Downstream goods.** The Commission has proposed extending CBAM to downstream goods with anti-circumvention measures, from 1 January 2028, COM(2025) 989 [10]. The Council adopted its position on 12 June 2026 and the Parliament adopted its position on 15 September 2026 (as reported by cbamguide.com) [23]; the file heads into trilogue negotiations between Parliament and Council; not yet agreed. CN 7318 is already in scope; the extension concerns other goods. A tonnage ledger fits its focus on evidence of origin.
- **Carbon price paid in the country of origin.** CBAM allows a deduction for a carbon price effectively paid. The same credential pattern could carry evidence of such payments; this is not built.

### 6.3 Digital Product Passport (ESPR)

- The Ecodesign for Sustainable Products Regulation (EU) 2024/1781 sets up digital product passports; iron and steel is a priority product group [11].
- ESPR requires unique operator and facility identifiers under specified standards. It does not name the LEI. Implementing Decision (EU) 2026/1736 of 14 July 2026 cites six harmonised standards for digital product passports: EN 18216, EN 18219 (unique identifiers), EN 18220, EN 18221, EN 18222 and EN 18223 [24]. The standard on data authentication, reliability and integrity, prEN 18246, is still a draft, as is prEN 18239 on access rights and business confidentiality [24]. We have not read the text of EN 18219, so whether an LEI is accepted as operator identifier there is open. CarbonLEI's report credential can be referenced from a passport by `credSAID`. We claim no DPP conformance.
- The demo's Supplier tab shows a 'Product passport card (demo) — a data carrier a product passport could reference · not an ESPR passport'. Its QR code opens the hosted verification page with the `credSAID` and the batch ID; the card lists the CN code, the verified emissions intensity, the verification body's LEI and the current validity status. We do not claim conformance with ESPR or with any DPP specification.

### 6.4 EU Business Wallet

- The Commission's proposal for European Business Wallets, COM(2025) 838, lists the LEI and the EORI among attributes a wallet can carry (recital 25) [12]. It does not mention vLEI or CBAM. The Council adopted its negotiating position on 9 June 2026 [25]; it is not yet law.
- CarbonLEI already carries the supplier's LEI in the credential and the importer's EORI hash in the on-chain claim, so a wallet-issued attestation could become an alternative entry point for onboarding.

### 6.5 UN Transparency Protocol (UNTP)

- UNTP's Digital Identity Anchor links a DID to a registered identity and lets accreditation bodies attest accredited conformity assessment bodies [13].
- CarbonLEI's NAB accreditation credential follows the same idea. Roadmap: express the report as a UNTP conformity credential and use the vLEI as the identity anchor.

---

## 7. Adoption risks

| Risk | Mitigation |
|---|---|
| vLEI uptake cannot be measured publicly. GLEIF's website listed 8 QVIs on 23 September 2026 [15], and GLEIF does not publish how many vLEIs have been issued | Only verification bodies and their lead auditors need vLEI credentials (plus an accreditation body that issues the accreditation credential itself); operators need no vLEI (their LEI identifies them); checks 1–5 need no KERI evidence (§4); verification bodies are few and concentrated |
| CBAM does not recognise vLEI or on-chain records | Position as a complementary verification layer; keep the official Registry flow unchanged (§1.1). On-chain receipts are offered as supporting evidence only (§2.1) |
| Cold start. The tonnage ledger can stop over-use across importers only when the importers relying on the same report check it | Single-importer benefits (§2.1); cross-importer protection grows with adoption; start with one verification body and its customers |
| Volumes visible on-chain | Salted identifiers; roadmap for commitments or a permissioned ledger (see [SECURITY.md](SECURITY.md#7-privacy-of-on-chain-data)) |
| Central allowlist operator | Multisig and governance roadmap |
| Regulation changes (default values, downstream scope) | Data model uses CN codes and periods; mapping updates without contract changes |

---

## 8. Current status by area

Status of each area at submission. The README keeps a shorter version of this table.

| Area | Hackathon scope | Status | Roadmap |
|---|---|---|---|
| Contracts (`VerifierAllowlist`, `EmissionsClaimRegistry`) | Sepolia deployment, Etherscan-verified source | Built. Deployed on Sepolia on 5 October 2026, source verified on Etherscan; 278 contract tests, including invariant fuzzing; line coverage 100% for both contracts | Independent audit; production chain choice |
| Allowlist governance | Allowlist owner key (held by the trust-registry operator) adds verification bodies and auditors and can rotate a body's address; a separate watcher key can only suspend a body, lift a suspension or revoke an auditor. Neither key can edit reports, tonnage or claims, and every addition carries evidence hashes that anyone can re-check | Built, with a single allowlist owner key and a single watcher key | Multisig, then governance with NAB and QVI representatives; several independent watchers |
| Credential, selective disclosure, EIP-712 | Full | Built. 26 credential fields; the demo proof discloses 21 and hides 5; the credential's SAID matches the KERI reference implementation (keripy 1.2.13) on the test vector; EIP-712 signature by the verification body | Decoy digests to hide field count |
| vLEI chain (LE, ECR, NAB accreditation), KEL anchoring, revocation detection | Local KERIA; the API flow was validated in an internal feasibility test on 2026-09-23, not part of this repository | Built locally: 8 KERIA agents (`npm run vlei:up`, `npm run vlei:setup`); the lead auditor anchors the credential in its KEL; evidence exported on 5 October 2026. Check 7 reads each credential's status from the exported evidence (issued, not revoked); detection of a later revocation is in the Watcher row | Real vLEIs from a QVI in a pilot |
| GLEIF root | Simulated locally with test keys | By design | Production GLEIF root of trust |
| Hosted demo | Read-only; checks 1–3 and 8 in the browser (check 3 takes only the chain ID from the Sepolia node and reads no contract state, so the page labels it "live · your browser"), checks 4–5 live against Sepolia; checks 6 and 7 in the browser on evidence exported from the local KERI run, labelled as such | Live at https://zuemen.github.io/carbon-lei/ (six tabs). It tries a backup Sepolia endpoint when the first does not answer; if neither answers, the viewer can show results cached on 5 October 2026, labelled as an offline view | Hosted verifier API |
| Watcher | A separate watcher key mirrors revocations on-chain; a report registered within 24 h before a revocation or suspension is marked CONTESTED | Built: the watcher role in the contract, the 24-hour CONTESTED window in the SDK's verification, and a watcher process that polls the body's KEL for the ECR revocation and sends `revokeAuditor` with the watcher key automatically; suspensions are sent manually with the watcher key | Watching accreditation withdrawals; several independent watchers; liveness alerts; backdate revocation to the KERI event time |
| PACT v3 export | JSON export; the example in PACT_MAPPING.md is real output of the export | Built: `sdk/pact.ts` and `carbonlei export-pact`; the SDK tests validate the export against the `ProductFootprint` schema of the PACT 3.0.3 OpenAPI definition | PACT API endpoint; publish the extension's JSON Schema |
| On-chain verification of KERI signatures | Not in scope | Roadmap | See [SECURITY.md](SECURITY.md#future-on-chain-verification-of-keri-signatures) |
| One verification report per installation and reporting period | Enforced on-chain across verification bodies with two key layers. Installation and period: bound to one verification report ID; revocation does not release it; a report with another ID must name the report it replaces in `supersedes`, else `PeriodAlreadyCovered`. Installation, CN code, production-route code and period, kept under the first layer: holds the claimed tonnage; a second credential for the same layer reverts with `CredScopeAlreadyCovered` unless it is a revision, which carries the claimed tonnage over and reverts with `SupersedeOverClaimed` if its `verifiedKg` is below it. Rule source: Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3 | Built (contract) | Review the privacy trade-off of the unsalted scope keys (SECURITY.md §7) |
| Physical link between goods and batch ID | Batch ID chosen by supplier | Known limitation | Bind to customs declaration or heat numbers |
| Check 8 (rule-based reconciliation) | Deterministic rules compare the structured fields of the verification report (a report extract, not the PDF itself) with the signed credential, plus regulatory checks (CN code within the accreditation scope, physical site visit in the first verified period, reasonable assurance, 5% materiality, and the date order of reporting period, report signature, credential issue and expiry). The attestation (input hash, output hash, rule-version hash) is part of the credential core, so it is covered by the credential's SAID, which the lead auditor anchors, and by the verification body's signature; check 8 recomputes and compares it. Warns only, never rejects. No AI model | Built: rule set `carbonlei-reconciliation/1`, 12 rules (`sdk/consistency.ts`); runs in the browser and in the CLI | An optional local, fixed-weight model for semantic checks (for example free-text accreditation scopes), with weights hash and runtime version in the attestation |
| Legal recognition | CBAM does not recognise vLEI; CarbonLEI does not submit to the CBAM Registry | By design | Field-compatible export for Registry workflows |
| Physical emission reductions | Not quantified | By design | See [CLIMATE_IMPACT.md](CLIMATE_IMPACT.md) |

## Sources

Accessed 23–24 September 2026 unless stated.

1. European Commission, "CBAM verification" page and "State-of-play CBAM accreditation", 29 September 2026, accessed 2026-10-07. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en ; https://taxation-customs.ec.europa.eu/document/download/a782dacf-ab68-44cc-986c-28fd1b4daa94_en
2. European Commission, CBAM Registry. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en
3. Regulation (EU) 2025/2083, Art. 18(2). https://eur-lex.europa.eu/eli/reg/2025/2083/oj/eng ; Commission Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3. https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32025R2551
4. European Commission, "Guidance on access request procedure – for CBAM operators, non-EU companies", v3.00, 26 January 2026, pp. 10 and 19. https://taxation-customs.ec.europa.eu/document/download/9361fade-6f19-4799-b2ef-f6a4ff681af2_en
5. Eurostat Comext DS-045409, CN 7318, 2025 (dataset updated 15 September 2026); share computed by the team. https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409?format=JSON&freq=A&reporter=EU&partner=TW&product=7318&flow=1&time=2025
6. European Fastener Distributor Association (EFDA), press release, 9 March 2026. http://www.efda-fastenerdistributors.org/content/files/EFDA%20PRESS%20RELEASE_260309%281%29.pdf
7. IANA, URN namespace "LEI". https://www.iana.org/assignments/urn-namespaces/urn-formal/lei
8. Commission Implementing Regulation (EU) 2025/2546, Annex (template of the verification report). https://eur-lex.europa.eu/eli/reg_impl/2025/2546/oj
9. Chainlink ACE, Cross-Chain Identity. https://docs.chain.link/ace/concepts/cross-chain-identity ; release notes https://docs.chain.link/ace/release-notes ; GLEIF press release, 1 October 2025. https://www.gleif.org/en/newsroom/press-releases/gleif-and-chainlink-form-strategic-partnership-to-bring-institutional-grade-identity-solution-to-blockchain-industry
10. European Commission, COM(2025) 989, 17 December 2025. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A52025PC0989
11. Regulation (EU) 2024/1781 (ESPR). https://eur-lex.europa.eu/eli/reg/2024/1781/oj/eng ; European Commission, Digital Product Passport, iron and steel. https://single-market-economy.ec.europa.eu/single-market/digital-product-passport/iron-steel_en
12. European Commission, Proposal for a Regulation on the establishment of European Business Wallets, COM(2025) 838, 19 November 2025. https://digital-strategy.ec.europa.eu/en/library/proposal-regulation-establishment-european-business-wallets
13. UNECE, UN Transparency Protocol, Digital Identity Anchor. https://untp.unece.org/docs/specification/DigitalIdentityAnchor/
14. Taiwan Ministry of Environment, press meeting, 2 April 2026. https://www.moenv.gov.tw/policies-and-laws/meetings/35593.html
15. GLEIF, "Get a vLEI" page listing Qualified vLEI Issuers, read 23 September 2026. https://www.gleif.org/en/organizational-identity/get-an-lei-vlei/get-a-vlei
16. European Commission, DG TAXUD, Guidance on CBAM verification and accreditation for verifiers and National Accreditation Bodies, 24 August 2026, p.68 (§4.15) and p.124 (§10.2). https://taxation-customs.ec.europa.eu/document/download/030fe146-38e5-46b8-82b5-5f72da089a7b_en
17. Commission Implementing Regulation (EU) 2025/2547, Art 10(1) and 10(3), recital 17, Annex IV point 1.2. http://data.europa.eu/eli/reg_impl/2025/2547/oj
18. European Commission, DG TAXUD, User Interface Manual – CBAM Accredited Verifiers and Operators of 3rd Country Installations Portal (O3CI), version 4.00 EN, 16 July 2026, §4.5, pp.96–101, and p.126. https://taxation-customs.ec.europa.eu/document/download/fdefe841-6058-47fe-962b-0e6e8d904f69_en
19. European Commission, "CBAM Registry Access Request Procedure for the Accredited Verifiers", version 1.00, 25 August 2026, p.14 ("Permissions are the same"); and the CBAM Registry page, section "Accredited verifiers", step 2 (proof of representation), accessed 24 September 2026. https://taxation-customs.ec.europa.eu/document/download/bf7a956b-3cf5-4508-83bd-507395ce44a2_en?filename=CBAM-Accredited_Verifiers_Guidance-on-access-request-procedure-v1.00_EN.pdf ; https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en
20. European Commission, "Guidance Document 2: Quick Guide for Non-EU Operators on CBAM Implementation", 14 August 2026, pp.5, 6 and 14. https://taxation-customs.ec.europa.eu/document/download/91e1056c-4524-4705-aaa7-e25c1439a87a_en?filename=Guidance%20No.%202%20-%20Quick%20guide%20for%20non-EU%20operators%20on%20CBAM%20implementation.pdf
21. European Commission, "Carbon Border Adjustment Mechanism (CBAM) Questions and Answers", last updated 27 May 2026, p.44. https://taxation-customs.ec.europa.eu/document/download/013fa763-5dce-4726-a204-69fec04d5ce2_en?filename=CBAM_Questions%20and%20Answers.pdf
22. Regulation (EU) 2023/956, as amended by Regulation (EU) 2025/2083, Art 19 and Art 25(3). http://data.europa.eu/eli/reg/2023/956/oj ; https://eur-lex.europa.eu/eli/reg/2025/2083/oj/eng
23. Council of the EU, press release, 12 June 2026. https://www.consilium.europa.eu/en/press/press-releases/2026/06/12/council-moves-to-strengthen-the-eu-s-carbon-border-adjustment-mechanism/ ; EPRS, "Extension of CBAM scope to downstream goods and anti-circumvention measures", 7 September 2026. https://eprs.europarl.europa.eu/contents/publications/EPRS/2026/09/EPRS_ATA(2026)791461.html ; Parliament plenary vote of 15 September 2026, secondary source: https://cbamguide.com/news/2026-09-15-ep-plenary-adopts-cbam-downstream-mandate-464-50/ ; accessed 2026-10-07.
24. Commission Implementing Decision (EU) 2026/1736 of 14 July 2026, OJ 15 July 2026. https://eur-lex.europa.eu/eli/dec_impl/2026/1736/oj ; CEN-CENELEC, news, 15 July 2026 (the eight standards of the series; six cited in the OJ). https://www.cencenelec.eu/news-events/news/2026/en-in-the-spotlight/2026-07-15-dpp/ ; accessed 2026-10-07.
25. Council of the EU, press release on the European Business Wallets negotiating position, 9 June 2026, accessed 2026-10-07. https://www.consilium.europa.eu/en/press/press-releases/2026/06/09/european-business-wallets-council-adopts-negotiating-position/
