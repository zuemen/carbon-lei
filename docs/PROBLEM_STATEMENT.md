# Problem statement and solution overview

> "Please note that so-called verification certificates which are already in circulation are not […] suitable for the required verification."
> European Fastener Distributor Association (EFDA), *Why verifying CBAM emissions data is crucial for suppliers*, June 2026, p.4 [1]

The same guide expects "that few companies will be granted the status of accredited verifier at least in the first year" (p.2) [1]. All companies in the CarbonLEI demo are fictional, and its emissions values are illustrative.

## The problem

From 2026, an EU importer of steel screws pays for the emissions embedded in them. It may declare a verified actual value, or fall back on the Commission's default value with a mark-up. For CN 7318 goods from Taiwan the default is 2.707 tCO2e per tonne, 2.978 with the 2026 mark-up and 3.519 from 2028 [2]. A verified value is worth something only if the importer can trust it, and that comes down to three questions:

1. **Who signed it, and were they authorised?** The report must carry the signature of "an authorised person on behalf of the verifier" [3]. Inside the CBAM Registry, that authority is checked when the verifier's account is opened. A copy outside the Registry carries a name, not proof that software can check.
2. **Is the authority still valid?** Accreditation can be suspended or withdrawn, and auditors change employers [4].
3. **Have these tonnes already been used?** One report covers a period of production. The rules allow one report per installation and period [4], but nothing in the report records how many of its verified tonnes have been declared already. We call this risk **over-claiming of verified tonnage**. It is not double counting in the GHG Protocol or PACT sense (two companies counting the same emissions): under CBAM several importers may rely on one verified value, as long as their tonnes add up to no more than it verified.

## Who is affected, and which decision

| Who | Decision |
|---|---|
| EU importer's compliance officer | Accept the supplier's verified value instead of the default for this shipment |
| Supplier's export lead (third-country producer) | Which batch and which importer get how many of the verified tonnes |
| Downstream buyer or bank, outside the Registry | Rely on the value in product data or a financing decision |

Customs and national CBAM authorities benefit from declarations backed by checkable evidence; they do not use CarbonLEI in this prototype.

## Why now

- **Verifiers are only now being accredited.** In the Commission's state of play of 29 September 2026, 24 EU/EEA national accreditation bodies had agreed to offer CBAM accreditation, and 5 were accepting applications from verifiers outside the EU. On 7 October 2026 the Commission's list of accredited verifiers had not yet been published [5]. Verification reports for 2026 imports are due before the first annual declaration, by 30 September 2027 [1].
- **The corridor is large.** Taiwan supplied 20.3% of extra-EU imports of CN 7318 by weight in 2025 [6].
- **The scope is moving.** The extension to downstream goods (Council position 12 June 2026; Parliament position 15 September 2026, as reported by cbamguide.com) is in negotiation and would apply from 1 January 2028 at the earliest [7]. CN 7318 is already in scope.

## What CarbonLEI does, and what it does not

CarbonLEI links a CBAM verification report to the verifiable LEI (vLEI) of the accredited verification body, the role credential of the lead auditor who signed, and an Ethereum Sepolia ledger of how many verified tonnes have been claimed. A buyer runs eight checks in a browser, with no wallet, and sees only the fields the supplier chose to disclose.

It does **not** replace the CBAM Registry or submit to it, repeat the verification, or make a wrong number right. CBAM does not recognise vLEI or on-chain records. The Commission receives every declaration and can review it after submission [8]; CarbonLEI adds a cap that a buyer outside the Registry can check for itself, before relying on the value. We claim no physical emission reduction and no conformance with any product passport standard.

## How existing channels compare

"not stated" means we found nothing on it in the cited source; it does not mean the feature cannot exist.

| Channel | Who signed | Tonnage cap across importers | Selective disclosure |
|---|---|---|---|
| CBAM Registry | Verifier's EU Login account; proof of representation given when the account is requested (Registry page, "Accredited verifiers", step 2) [9] | No public cap; the Commission can review declarations after submission (Reg. 2023/956, Art 19) [8] | Operator may disclose only the summary of its emissions report (Reg. 2025/2547, recital 17) [10] |
| PACT Tech Spec v3.0.3 | `providerName` is a plain string (§4.12); OAuth 2.0 at transport level only (§5.5) [11] | not stated | not stated |
| Catena-X / TfS PCF verification framework v2 | Appointment process for attestation providers (Chapter 7, per the release note) [12] | not stated | not stated |
| UNTP Digital Identity Anchor | "Accreditation authorities issue DIA to assert that a conformity assessment body is accredited" [13] | not stated | not stated |
| DPP, prEN 18246 (draft) | not stated (draft text not public to us) [14] | not stated | not stated (access rights: prEN 18239, draft) [14] |
| EU Business Wallet, COM(2025) 838 | LEI and EORI as wallet attributes (recital 25); a signer's role for a report: not stated [15] | not stated | not stated |

## Academic position

- Vilkov and Tian's systematic review found no blockchain use cases in industrial manufacturing among carbon-market applications [16]; CarbonLEI is one, for steel fasteners.
- Jenkins, Negangard and Sheldon build a prototype that tracks Scope 1–3 emissions with NFTs and smart contracts [17]; CarbonLEI adds a machine-checkable test of whether the signer was authorised.
- Patro et al. build Ethereum smart contracts for aviation footprint traceability, with cost and security analysis [18]; CarbonLEI reports gas per operation and a threat model in the same way, for CBAM verification reports.

Details: [README](../README.md) · [Security](SECURITY.md) · [Climate impact](CLIMATE_IMPACT.md) · [Adoption](ADOPTION.md).

## Sources

Accessed 2026-10-07 unless stated.

1. EFDA, "Why verifying CBAM emissions data is crucial for suppliers", June 2026, pp.2–4. https://www.nfda-fastener.org/assets/docs/EFDA%20-%20CBAM%20supplier%20guide%20on%20verification_2606.pdf
2. Commission Implementing Regulation (EU) 2025/2621, Annex I (Taiwan), as replaced by Implementing Regulation (EU) 2026/1740. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202601740
3. Commission Implementing Regulation (EU) 2025/2546, Annex. https://eur-lex.europa.eu/eli/reg_impl/2025/2546/oj
4. Commission Delegated Regulation (EU) 2025/2551, Annex II, point 2.17.3. https://eur-lex.europa.eu/eli/reg_del/2025/2551/oj
5. European Commission, "CBAM verification" page and "State-of-play CBAM accreditation", 29 September 2026. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en
6. Eurostat Comext DS-045409, CN 7318, 2025; share computed by the team. https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409?format=JSON&freq=A&reporter=EU&partner=TW&product=7318&flow=1&time=2025
7. COM(2025) 989. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A52025PC0989 ; EPRS, 7 September 2026. https://eprs.europarl.europa.eu/contents/publications/EPRS/2026/09/EPRS_ATA(2026)791461.html ; secondary: https://cbamguide.com/news/2026-09-15-ep-plenary-adopts-cbam-downstream-mandate-464-50/
8. Regulation (EU) 2023/956, as amended, Art 19. http://data.europa.eu/eli/reg/2023/956/oj
9. European Commission, "CBAM Registry" page, accessed 2026-09-24. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en
10. Commission Implementing Regulation (EU) 2025/2547, recital 17. http://data.europa.eu/eli/reg_impl/2025/2547/oj
11. PACT Technical Specifications v3.0.3, 18 November 2025. https://docs.carbon-transparency.org/tr/data-exchange-protocol/latest/
12. Catena-X, release of version 2 of the PCF verification and program certification framework. https://catena-x.net/news/catena-x-and-together-for-sustainability-release-version-2-of-the-pcf-verification-and-pcf-program-certification-framework/
13. UNTP, Digital Identity Anchor. https://spec-untp-fbb45f.opensource.unicc.org/docs/specification/DigitalIdentityAnchor
14. CEN-CENELEC, 15 July 2026. https://www.cencenelec.eu/news-events/news/2026/en-in-the-spotlight/2026-07-15-dpp/ ; Implementing Decision (EU) 2026/1736. https://eur-lex.europa.eu/eli/dec_impl/2026/1736/oj
15. COM(2025) 838. https://digital-strategy.ec.europa.eu/en/library/proposal-regulation-establishment-european-business-wallets
16. A. Vilkov, G. Tian, "Blockchain's Scope and Purpose in Carbon Markets: A Systematic Literature Review", *Sustainability* 15(11):8495, 2023. https://doi.org/10.3390/su15118495
17. J. G. Jenkins, E. M. Negangard, M. D. Sheldon, "Using Blockchain, Non-Fungible Tokens, and Smart Contracts to Track and Report Greenhouse Gas Emissions", *The Accounting Review*, 2025. https://doi.org/10.2308/tar-2023-0222
18. P. K. Patro, R. Jayaraman, A. Acquaye, K. Salah, A. Musamih, "Blockchain-based solution to enhance carbon footprint traceability, accounting, and offsetting in the passenger aviation industry", *Int. J. Production Research*, 2025. https://doi.org/10.1080/00207543.2024.2441450
