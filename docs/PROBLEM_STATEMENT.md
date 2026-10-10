# Problem statement and solution overview

This document states the problem CarbonLEI addresses: a CBAM verified value is only usable if an importer can check who signed it, whether they were authorised, and whether its tonnes were already claimed. It then says what CarbonLEI does and does not do, and how existing channels compare.

EFDA warns that "so-called verification certificates which are already in circulation" do not meet CBAM's verification requirements and are "not suitable for the required verification" (p. 4) [1]. The same guide expects "that few companies will be granted the status of accredited verifier at least in the first year" (p. 2).

## The problem

From 2026, an EU importer of steel screws pays for their embedded emissions, declaring a verified actual value or the default with a mark-up: for CN 7318 from Taiwan, 2.707 tCO2e/t, 2.978 in 2026 and 3.519 from 2028 [2]. A verified value is worth something only if the importer can answer three questions:

1. **Who signed it, and were they authorised?** The report must carry the signature of "an authorised person on behalf of the verifier" [3]. Inside the CBAM Registry, proof of that authority is submitted when the verifier's account is requested [9]; a copy outside it carries a name, not proof that software can check.
2. **Is the authority still valid?** Accreditation can be suspended or withdrawn [19], and auditors change employers.
3. **Have these tonnes already been used?** The rules allow one report per installation and period [4], but nothing in the report records how many of its verified tonnes have been declared. We call this risk **over-claiming of verified tonnage**: one verified tonnage being claimed by more declarations than it covers, not the double counting discussed in emission inventories. Several importers may share one value within its tonnage.

**Who decides.** The EU importer's compliance officer accepts the verified value instead of the default; the supplier's export lead allocates verified tonnes to batches and importers; a downstream buyer or bank outside the Registry relies on the value. Customs and national CBAM authorities benefit but do not use the prototype.

## Why now

- **Verifiers are only now being accredited.** On 7 October 2026, 24 EU/EEA accreditation bodies had agreed to offer CBAM accreditation and 7 were accepting applications from verifiers outside the EU; on 10 October 2026 the Commission's list of accredited verifiers was not yet published, though two bodies had announced their own accreditation [5]. Reports for 2026 imports are needed for the first declaration, due 30 September 2027 [1].
- **The corridor is large.** Taiwan supplied 20.3% of extra-EU imports of CN 7318 by weight in 2025 [6].
- **The scope is moving.** After the Council (12 June 2026) and Parliament (15 September 2026) positions, the downstream extension heads into trilogue negotiations between Parliament and Council; not yet agreed. It would apply from 1 January 2028 at the earliest [7]; CN 7318 is already in scope.

## What CarbonLEI does, and what it does not

CarbonLEI links a CBAM verification report to the verifiable LEI (vLEI) of the accredited verification body, the role credential of the lead auditor who signed, and an Ethereum Sepolia ledger of how many verified tonnes have been claimed. A buyer runs eight checks in a browser, with no wallet, and sees only the fields the supplier disclosed. It does **not** replace or submit to the CBAM Registry, repeat the verification, or make a wrong number right; CBAM does not recognise vLEI or on-chain records. The Commission can review declarations after submission [8]; CarbonLEI adds a cap that a buyer outside the Registry can check beforehand. We claim no physical emission reduction and no product passport conformance.

## How existing channels compare

Tonnage cap across importers: none of the six channels states one; the CBAM Registry has no public cap, and the Commission can review declarations after submission [8]. "not stated": nothing found in the cited source, not that the feature cannot exist.

| Channel | Who signed | Selective disclosure |
|---|---|---|
| CBAM Registry | EU Login account; proof of representation when the account is requested [9] | Operator may disclose only its report summary (recital 17) [10] |
| PACT Tech Spec v3.0.3 | `providerName` is a plain string (§4.12.1); OAuth 2.0 for API client authentication only (§5.5) [11] | not stated |
| Catena-X / TfS PCF framework v2 | Appointment process for attestation providers (Ch. 7, per release note) [12] | not stated |
| UNTP Digital Identity Anchor | "Accreditation authorities issue DIA to assert that a conformity assessment body is accredited" [13] | not stated |
| DPP, prEN 18246 (draft) | not stated (draft not public to us) [14] | not stated |
| EU Business Wallet, COM(2025) 838 | LEI and EORI as attributes (recital 25); mandates and role-based authorisation for representatives (recital 18); a role for signing a CBAM verification report: not stated [15] | Yes, for owner identification data and attestation attributes (Art 5(1)(b)) [15] |

## Academic position

Vilkov and Tian's systematic review of blockchain in carbon markets found no use cases in industrial manufacturing [16]; CarbonLEI addresses manufacturing, though for CBAM compliance data rather than a carbon market. Jenkins et al. track Scope 1–3 emissions with NFTs and smart contracts [17], and Patro et al. analyse the cost and security of footprint tracing on Ethereum [18]; CarbonLEI adds a machine-checkable test of whether the signer was authorised.

All demo companies are fictional; emissions values are illustrative. Details: [README](../README.md) · [Security](SECURITY.md) · [Climate impact](CLIMATE_IMPACT.md) · [Adoption](ADOPTION.md).

## Sources (not counted in the two pages)

Accessed 2026-10-07 unless stated.

1. European Fastener Distributor Association (EFDA), "Why verifying CBAM emissions data is crucial for suppliers", June 2026, pp. 2 and 4. PDF authored by EFDA, hosted on the NFDA website (nfda-fastener.org). https://www.nfda-fastener.org/assets/docs/EFDA%20-%20CBAM%20supplier%20guide%20on%20verification_2606.pdf
2. Commission Implementing Regulation (EU) 2025/2621, Annex I (Taiwan), as replaced by Implementing Regulation (EU) 2026/1740. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202601740
3. Commission Implementing Regulation (EU) 2025/2546, Annex. https://eur-lex.europa.eu/eli/reg_impl/2025/2546/oj
4. Commission Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3. https://eur-lex.europa.eu/eli/reg_del/2025/2551/oj
5. European Commission, "CBAM verification" page and "State-of-play CBAM accreditation", 7 October 2026, accessed 2026-10-10. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en ; announcements: https://emicert.com/cbam-accreditation-announcement/ ; https://group.bureauveritas.com/newsroom/bureau-veritas-receives-accreditation-cbam-verification-services
6. Eurostat Comext DS-045409, CN 7318, 2025; share computed by the team. https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409?format=JSON&freq=A&reporter=EU&partner=TW&product=7318&flow=1&time=2025
7. COM(2025) 989. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A52025PC0989 ; EPRS, 7 September 2026. https://eprs.europarl.europa.eu/contents/publications/EPRS/2026/09/EPRS_ATA(2026)791461.html ; European Parliament press release, 15 September 2026: https://www.europarl.europa.eu/news/en/press-room/20260911IPR47450/strengthening-the-eu-carbon-border-adjustment-mechanism-and-closing-loopholes
8. Regulation (EU) 2023/956, as amended, Art 19. http://data.europa.eu/eli/reg/2023/956/oj
9. European Commission, "CBAM Registry" page, section "Accredited verifiers", step 2, accessed 2026-09-24. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en
10. Commission Implementing Regulation (EU) 2025/2547, recital 17. http://data.europa.eu/eli/reg_impl/2025/2547/oj
11. PACT Technical Specifications v3.0.3, 18 November 2025. https://docs.carbon-transparency.org/tr/data-exchange-protocol/latest/
12. Catena-X, release of version 2 of the PCF verification and program certification framework. https://catena-x.net/news/catena-x-and-together-for-sustainability-release-version-2-of-the-pcf-verification-and-pcf-program-certification-framework/
13. UNECE, UN Transparency Protocol, Digital Identity Anchor. https://untp.unece.org/docs/specification/DigitalIdentityAnchor/
14. CEN-CENELEC, 15 July 2026. https://www.cencenelec.eu/news-events/news/2026/en-in-the-spotlight/2026-07-15-dpp/ ; Implementing Decision (EU) 2026/1736. https://eur-lex.europa.eu/eli/dec_impl/2026/1736/oj
15. COM(2025) 838, recitals 18 and 25, Art 5(1)(b). https://digital-strategy.ec.europa.eu/en/library/proposal-regulation-establishment-european-business-wallets
16. A. Vilkov, G. Tian, "Blockchain's Scope and Purpose in Carbon Markets: A Systematic Literature Review", *Sustainability* 15(11):8495, 2023. https://doi.org/10.3390/su15118495
17. J. G. Jenkins, E. M. Negangard, M. D. Sheldon, "Using Blockchain, Non-Fungible Tokens, and Smart Contracts to Track and Report Greenhouse Gas Emissions", *The Accounting Review*, 2025. https://doi.org/10.2308/tar-2023-0222
18. P. K. Patro, R. Jayaraman, A. Acquaye, K. Salah, A. Musamih, "Blockchain-based solution to enhance carbon footprint traceability, accounting, and offsetting in the passenger aviation industry", *Int. J. Production Research*, 2025. https://doi.org/10.1080/00207543.2024.2441450
19. Regulation (EU) 2025/2083 amending Regulation (EU) 2023/956, Art 18(2), OJ 17 October 2025. https://eur-lex.europa.eu/eli/reg/2025/2083/oj/eng ; Commission Delegated Regulation (EU) 2025/2551 (accreditation of verifiers). https://eur-lex.europa.eu/eli/reg_del/2025/2551/oj
