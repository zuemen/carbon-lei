# Related work

CarbonLEI asks three questions of a verified CBAM emissions value: **(1) who signed it**, **(2) was the signer authorised at the time**, and **(3) has each verified tonne already been claimed**. This page lists existing systems and papers that touch one or more of these questions, says what each does and does not do relative to them, and gives one source per row that we opened on 2026-10-10 unless stated.

"Not stated" means we did not find it in the cited source, not that the system cannot do it. We compare by public description only; we have not run these systems, and nobody listed here has reviewed this comparison.

## Comparison

| System or paper | What it does | (1) Who signed | (2) Authorised at the time | (3) Tonne already claimed | Source |
|---|---|---|---|---|---|
| EU CBAM Registry | The official system: verifiers are granted access, operators share verified data with declarants, declarants submit declarations | EU Login accounts of the verifier and operator | Verifier access is granted after an accreditation check | Not stated as a cap; the Commission reviews declarations after submission (see [README — Where CarbonLEI sits](../README.md#where-carbonlei-sits-and-why-a-ledger)). Not open to the public | [1] |
| WBCSD PACT Technical Specifications v3.0.3 | Data model and API for exchanging product carbon footprints between companies | `verification.providerName` is a plain string; the API authenticates the client (OAuth 2.0 / OpenID token), not the footprint | Not stated | Not stated; PACT expresses emissions per declared unit and has no volume field ([PACT mapping](PACT_MAPPING.md)) | [2] |
| Catena-X PCF exchange (CX-0136) and the Catena-X / TfS PCF verification framework | Point-to-point PCF exchange between business partners through dataspace (EDC) connectors; partners identified by a Business Partner Number; a separate framework for third-party PCF verification | Data provider identified by BPN within the network | An appointment process for attestation providers (framework v2, per release note) | Not stated | [3], [4] |
| Catena-X CBAM Expert Group (call, July 2026) | A planned Catena-X standard for CBAM data exchange | Not stated in the call | Not stated in the call | Not stated in the call | [5] |
| UNTP (UN Transparency Protocol, UNECE): Digital Identity Anchor and chain-of-custody pattern | W3C VCs for product passports, conformity credentials and traceability events; an identity anchor binds an issuer's DID to a registered identity, and accreditation authorities can anchor conformity assessment bodies | Yes: DID-signed credentials, bound to a register entry by the anchor | Accreditation anchor for the assessment body; per-person role at signing time: not stated | **Partly.** The chain-of-custody pattern describes facility-level volume reconciliation by an auditor over the facility's traceability events, to detect volume inflation. It also notes that a signature "does not prove that the party has not issued a contradictory record to someone else", and relies on sample-based audit for that. We did not find a shared record that rejects an over-claim at the moment it is made. Status: work in progress toward v1.0 | [6], [7] |
| EU Digital Product Passport (ESPR, Regulation (EU) 2024/1781), iron and steel | Product information reached through a data carrier; iron and steel requirements to come in a future delegated act | Not yet defined for iron and steel | Not yet defined | Not yet defined | [8] |
| Hedera Guardian | Open-source policy workflow engine for digital MRV: policies encode a methodology's roles, approvals and calculations; credits are minted as tokens; a "TrustChain" links each token to the verifiable credentials behind it | Yes: VC-signed documents by role | Roles are assigned within a policy by its Standard Registry; rooting in an external legal-entity identity system: not stated | For issued tokens, yes: a token is a ledger unit. We did not find a CBAM or embedded-emissions policy in the repository's file tree (main branch, checked 2026-10-10) | [9], [10] |
| Energy Web Green Proofs | Book-and-claim registry framework for environmental commodities (sustainable aviation fuel, renewable electricity and others) | Registry participants | Registry-defined | Yes, within a registry: a unit claimed is retired. Not applied to CBAM verified values | [11] |
| Climate Action Data Trust (CAD Trust) | A neutral data platform to which carbon credit registries publish data, to increase transparency and safeguard against double counting of credits across registries | Not its focus (registries publish) | Not its focus | Yes, for carbon credits across registries; not for embedded emissions of goods | [12], [13] |
| OpenClimate (OpenEarth Foundation) | Open database and API for national, subnational and company emissions and pledges | Not its focus | Not its focus | Not its focus | [14] |
| Chainlink ACE cross-chain identity, with the GLEIF partnership | An on-chain identity registry (CCID) that links addresses to one identity and stores credential records; GLEIF announced vLEIs stored on-chain as CCIDs | Identity of the address holder | Credential record with expiry; a role at signing time: not stated | Not its focus (identity layer) | [15], [16] |
| Cardano CIP-0170 (Proposed) | A signer anchors a digest of signed data in its KERI KEL, with an on-chain attestation record | Yes: KERI AID | Not stated | Not its focus | [17] |
| GLEIF: vLEI signing of financial and ESG reports | GLEIF describes vLEI role credentials for signing financial and ESG reports | Yes: vLEI role credential holder | Yes, through credential status | Not its focus | [18] |
| MSC Trustgate (GLEIF vLEI Hackathon 2025 winner, Industry 4.0) | Verifies an organisation's authority with vLEI and binds it to electronic signatures on corporate PDFs | Yes | Yes, through vLEI | Not its focus | [19] |
| SiGREEN / Estainium (IEEE AIBThings 2023) | Verifier-issued PCF credentials with selective disclosure (AnonCreds) | Yes: credential issuer | Not compared: we did not check how the network admits verifiers | Not stated | [20] |
| Endoh, JAIT 17(6), 2026 | A VC framework for PCF sharing: a certified-provider scheme so downstream companies can check that data came from certified upstream companies, and watermarked data that can be tracked and revoked | Yes | Certification of the provider; per-person role at signing time: not stated in the abstract | Not stated in the abstract | [21] |
| Man et al., "Emission Impossible" (arXiv 2506.16347, 2025) | Zero-knowledge proofs that an emissions calculation was done correctly, without revealing the inputs | The prover | Not its focus | Not its focus | [22] |

## What is new here, and what is not

**Not new.** Each building block exists elsewhere: role credentials chained to GLEIF (vLEI, used for document signing by GLEIF and MSC Trustgate), KEL anchoring of signed data (CIP-0170), on-chain identity records next to off-chain credential checks (Chainlink ACE), "use once" ledgers for environmental units (Green Proofs, Guardian tokens, CAD Trust for credits), and auditor-based volume reconciliation (UNTP). Selective disclosure of verified footprints was shown by SiGREEN.

**What we did not find elsewhere** (public sources, as of 2026-10-10): a design that answers all three questions for one CBAM verified value in one check, namely

1. the signer's authority as a named role (`CBAM Lead Auditor`) issued by an accredited verification body, itself accredited by a national accreditation body for a CN scope, with the chain rooted in GLEIF's vLEI root (simulated in the demo);
2. that authority evaluated **at the registration block** on an allowlist that a watcher keeps in step with KERI revocations (with a sync window, see [SECURITY §4](SECURITY.md)); and
3. a shared, publicly readable cap on the tonnes of goods claimed against that value **across importers**, which rejects the claim that would exceed the verified quantity (`ExceedsVerifiedTonnage`) at the time it is made, instead of detecting it in a later audit.

The closest work on question 3 is UNTP's chain-of-custody pattern, which targets the same failure (volume inflation) by audit rather than by a shared ledger; the two could complement each other. We did not find a system that applies a claim cap to CBAM verified values. This does not mean none exists; non-public or commercial systems may do so.

**Limits of the comparison.** The cap only binds among buyers who check the same ledger, and the allowlist operator is still partly trusted ([ARCHITECTURE §1.1](ARCHITECTURE.md#11-why-a-blockchain-four-questions)). Where this page says "not stated", we read only the cited source.

## Sources

Opened on 2026-10-10 unless stated.

1. European Commission, CBAM Registry. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en
2. WBCSD PACT, Technical Specifications for PCF Data Exchange, version 3.0.3, 18 November 2025 (§4.12.1 `providerName`; §5.5 authentication flow). https://wbcsd.github.io/tr/2025/data-exchange-protocol-20251118/
3. Catena-X, CX-0136 Use Case PCF (EDC connectors, Business Partner Number). https://catenax-ev.github.io/docs/standards/CX-0136-UseCasePCF
4. Catena-X and Together for Sustainability, release of version 2 of the PCF verification and PCF program certification framework. https://catena-x.net/news/catena-x-and-together-for-sustainability-release-version-2-of-the-pcf-verification-and-pcf-program-certification-framework/
5. Catena-X, "Apply now: Expert Group Carbon Border Adjustment Mechanism (CBAM)", July 2026. https://catena-x.net/news/apply-now-expert-group-carbon-border-adjustment-mechanism-cbam/
6. UNECE, UN Transparency Protocol, Digital Identity Anchor (schema v0.8.0). https://untp.unece.org/docs/specification/DigitalIdentityAnchor/
7. UNECE, UN Transparency Protocol, Chain of Custody design pattern ("Version: Work in Progress"; sections "Volume reconciliation and mass balance are not the same thing" and "Privacy-Preserving Verification"). https://untp.unece.org/docs/design-patterns/ChainOfCustody
8. European Commission, The Digital Product Passport for Iron and Steel; Regulation (EU) 2024/1781 (ESPR). https://single-market-economy.ec.europa.eu/single-market/digital-product-passport/iron-steel_en ; https://eur-lex.europa.eu/eli/reg/2024/1781/oj/eng
9. Hedera Guardian documentation, Welcome (Policies, Tokens, TrustChain, Standard Registry). https://guardian.hedera.com/
10. hashgraph/guardian repository; file tree of `main` searched for "cbam" via the GitHub API, no match, 2026-10-10. https://github.com/hashgraph/guardian
11. Energy Web, Green Proofs ("Verifiable book-and-claim"). https://energyweb.org/green-proofs/
12. Climate Action Data Trust, home page. https://climateactiondata.org/
13. Climate Action Data Trust, Data Model Version 2.0 Connectivity Guide ("safeguard against double-counting"). https://climateactiondata.org/wp-content/uploads/2026/01/CAD-Trust-Connectivity-Deck-V2.pdf
14. OpenEarth Foundation, OpenClimate. https://www.openearth.org/projects/openclimate
15. Chainlink ACE documentation, Cross-Chain Identity. https://docs.chain.link/ace/concepts/cross-chain-identity
16. GLEIF press release, "GLEIF and Chainlink form strategic partnership…", 1 October 2025. https://www.gleif.org/en/newsroom/press-releases/gleif-and-chainlink-form-strategic-partnership-to-bring-institutional-grade-identity-solution-to-blockchain-industry
17. Cardano Foundation, CIP-0170 (status: Proposed). https://cips.cardano.org/cip/CIP-0170
18. GLEIF blog, "The Signing of Things to Come: How the vLEI Enables Digital Verifiability in Financial and ESG Reporting and Beyond", November 2023. https://www.gleif.org/en/newsroom/blog/the-signing-of-things-to-come-how-the-vlei-enables-digital-verifiability-in-financial-and-esg-reporting-and-beyond
19. GLEIF vLEI Hackathon 2025 winners, press release of 3 December 2025, as published by FinanceX Magazine. https://www.financexmagazine.com/post/gleif-announces-the-vlei-hackathon-winners-creating-digital-trust-in-industry-4-0
20. "Trustworthy Supply Chain Exchange for Product Carbon Footprint", IEEE AIBThings 2023. https://www.estainium.eco/files/media/public/downloads/sigreen-tsx-ieeeaibthings-2023.pdf
21. N. Endoh, "A Verifiable Credential Framework for Traceable and Scalable Data Sharing: Application to Product Carbon Footprint", *Journal of Advances in Information Technology* 17(6), 2026 (abstract read). https://www.jait.us/articles/2026/JAIT-V17N6-1211.pdf
22. J. Man, S. Jaffer, P. Ferris, M. Kleppmann, A. Madhavapeddy, "Emission Impossible: privacy-preserving carbon emissions claims", arXiv:2506.16347, 2025. https://arxiv.org/abs/2506.16347
