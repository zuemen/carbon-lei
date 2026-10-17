# CBAM Registry export: what the Commission publishes, and why CarbonLEI has no Registry XML export

> **Short answer.** Several enterprise CBAM tools advertise a "Registry XML export". On 17 October 2026 the European Commission publishes one XML schema for CBAM Registry submissions: the **transitional-period quarterly report** (`QReport`, XSD version 18.30). The Commission has moved it to its CBAM archive as no longer applicable; it covers imports from Q4 2023 to Q4 2025. It has published **no** XML schema for the definitive-period annual CBAM declaration. Its Q&A of 15 October 2026 says the Registry module for submitting the declaration "will open in 2027". It has published no file-import format for O3CI, where non-EU operators enter emissions data on screen. What it does publish for the operator-to-importer exchange is an Excel **communication template** with a `Summary_Communication` sheet.
>
> CarbonLEI's portfolio planning starts at import year 2026 (`buildPortfolio` rejects earlier years), so no official schema covers the data CarbonLEI holds. We therefore built **no** Registry exporter and did not invent a schema. This page records what exists (§1) and what does not (§2), explains the decision (§3), and maps CarbonLEI's verdict and portfolio fields to the fields the Commission does publish (§4). When the Commission publishes the declaration's data structure, §5 says what we would build.

All sources were accessed on **17 October 2026**. SHA-256 hashes are of the files as downloaded that day, so anyone can check that the same file is meant. None of these files is in this repository.

## 1. What is official and published

| # | Item | Version and date | Where (official) | Status | What it contains |
|---|---|---|---|---|---|
| R1 | CBAM Quarterly Report structure, XSD and `stypes.xsd` (ZIP) | `QReport_18.30.xsd` with `stypes_17.03.xsd` and an "XML Guidance Document"; page date 10 September 2024; SHA-256 `d86c5f71caddbd49c59c82bc5fddd10ed2715bf7dc9d633d825bbc2a01bcffd3` | [CBAM archive](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-archive_en), section "Quarterly report"; [direct download](https://taxation-customs.ec.europa.eu/document/download/b473e58d-655b-4d21-a4ef-144d48e9877a_en?filename=CBAM%20XSD%20version%2018.30.zip) | **Archived.** The page says it holds "information on CBAM that is no longer applicable", and that the CBAM Transitional Registry "was in use from October 2023 to December 2025" | Root element `QReport` in namespace `http://xmlns.ec.eu/BusinessObjects/CBAM/Types/V1`: `ReportingPeriod` (Q1–Q4), `Year`, `Declarant`, `Importer`, `Signatures`, and up to 99,999 `ImportedGood` blocks, each with `CommodityCode`, `OriginCountry`, `ImportedQuantity` (customs procedure, area of import, net mass) and up to 999 `GoodsEmissions` blocks (installation, operator, `DirectEmissions`, `IndirectEmissions`, production method and qualifying parameters, `CarbonPriceDue`) |
| R2 | CBAM Quarterly Report structure (XLSX) | "Report Structure ver 18.30"; page date 10 September 2024; SHA-256 `3fbce8d792adfcf43a635fee25c89f7f1a48b8364dbedb6daf7094b816ea7890` | Same archive section; [direct download](https://taxation-customs.ec.europa.eu/document/download/d3cc400c-ce53-43df-87ed-2b4bcaed4bb9_en?filename=Report%20Structure%20ver%2018.30.xlsx) | Archived, with R1 | Mandatory and optional fields, validation rules and code lists. Examples: determination type `01` actual data, `02` estimated values including default values; reporting methodology `TOM01` Commission rules, `TOM02` other methods, `TOM03` Commission default values; production method `P34` "Iron or steel products", which the mapping sheet assigns to CN chapter 73 |
| R3 | Quarterly report sample files (importer, representative) | `ver1.3.0.0`, 12 September 2024 | Same archive section | Archived, with R1 | A sample `export.xml` with attachments that the transitional registry accepted for upload |
| R4 | CBAM communication template for installations (XLSX) | Template version 2.1.1 of 13 December 2024 (its `0_Versions` sheet; issued by Umweltbundesamt for the Commission); page date 18 December 2024; SHA-256 `5a4e28fdbccfdca45a2c0520184b551a20c0c7bba3db79f87d78c9e58a6c0917` | [CBAM communication and news](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-communication-and-news_en), section "Communication"; [direct download](https://taxation-customs.ec.europa.eu/document/download/2c15cd0e-2447-4ef8-ab70-68b80b66ede8_en?filename=CBAM%20Communication%20template%20for%20installations_en_20241213.xlsx); filled-in examples per sector in a ZIP on the same page | **Current page, not archived.** The workbook's own guidelines sheet cites the transitional Implementing Regulation (EU) 2023/1773. The Commission's Q&A (R6) presents it as the template for the definitive-period methodology of IR (EU) 2025/2547 | An operator's calculation workbook. Its sheet `Summary_Communication` holds what goes to the importer: installation details (section 1) and one row per product (section 2), with specific embedded emissions (SEE) direct, indirect and total, embedded electricity and its emission factor, qualifying parameters and carbon price. Field list in §4 |
| R5 | CBAM Registry user manuals, Release 3.2 | Declarants Portal v6.00 EN (dated 16/06/2026); Installation Operators and Accredited Verifiers Portal (O3CI) v4.00 EN (dated 16/07/2026) | [CBAM Registry](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en), "Additional documents" (listed 21 and 27 August 2026) | Current | **Declarants:** "the first CBAM declaration will be submitted during 2027", and the declaration screens "will not contain any data at this stage" (§2.1). **O3CI:** the operator enters emissions information on screen per installation and production year (goods produced by HS/CN code, up to nine production routes, specific direct emissions, electricity consumed and emission factor, qualifying parameters, carbon price in the country of origin) and can **export** it as CSV (§4.5). The manual names no upload format |
| R6 | CBAM Questions and Answers | Last updated 15 October 2026 | [CBAM communication and news](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-communication-and-news_en); [direct download](https://taxation-customs.ec.europa.eu/document/download/013fa763-5dce-4726-a204-69fec04d5ce2_en?filename=CBAM_Questions%20and%20Answers.pdf) | Current | Q1.15: the Excel template "is not compulsory but recommended"; its `Summary_Communication` worksheet "contains all information needed by the reporting declarant". Q5.10: in 2027 operators need not register in the Registry and may send data to declarants outside it, in which case "the declarant will then have to upload this information in the CBAM Registry as part of the submission of the CBAM declaration. The CBAM registry module for the submission of the CBAM declaration will open in 2027." |

## 2. What is not published (as of 17 October 2026)

- **A data structure, XSD or file format for the definitive-period CBAM declaration** (Art 6 of Regulation (EU) 2023/956; the first declaration covers 2026 imports). We found none on the [CBAM Registry](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en), [definitive regime](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-definitive-regime_en), [legislation and guidance](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-legislation-and-guidance_en) or [communication](https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-communication-and-news_en) pages, and the Release 3.2 declarant manual (R5) and the Q&A (R6) say the declaration module opens in 2027.
- **An import format for O3CI emissions data.** The operator manual (R5) describes on-screen entry and a CSV export. It mentions an appendix file `CBAM_O3CI_Data_Elements.xlsx` (§6.1), but that file is not attached to the published PDF and we did not find it on the Registry page.
- **A system-to-system interface for declarants or operators.** We found no published API or message specification for either.

## 3. Decision: no exporter, documentation only

We build only what an official, public specification grounds. The one official XML schema (R1) does not match the data CarbonLEI holds:

1. **Wrong period.** `QReport` is the transitional quarterly report for imports from Q4 2023 to Q4 2025, and the Commission has archived it as no longer applicable. CarbonLEI plans declarations for import years from 2026 (`buildPortfolio` rejects a year before 2026), and the demo report covers 2026. A `QReport` file for 2026 goods would target a registry that no longer takes them.
2. **Codes that would misstate the data.** For a line on default values, the only fitting code is `TOM03`, "default values made available and published by the Commission". In the transitional rules that meant the transitional default values, which could be used only until July 2024 (as the CBAM archive page states). The 2026 defaults of IR (EU) 2026/1740 with their mark-up are a different thing. For a line on the supplier's verified value, `TOM01` "Commission rules" would assert a methodology that the demo report itself labels "illustrative — not official CBAM methodology".
3. **Identifiers that do not fit.** `OperatorId` and `InstallationId` are at most 17 characters (`an..17`). A supplier LEI has 20, and the demo installation ID `TW-ZZZZ00TWSCREWDEMO185-0001` has 28.

The definitive declaration has no published structure (§2). An exporter for it would be an invented schema, which this project does not ship. The importer's outputs therefore stay as they are: the CSV declaration worksheet (`carbonlei portfolio`, not a Registry format), the PACT export (`carbonlei export-pact`), and the verdict JSON. §4 tells a declarant or an integrator where each CarbonLEI field goes in the published templates.

## 4. Mapping CarbonLEI fields to the published fields

Columns:

- **CarbonLEI source**: a field the supplier disclosed in the proof (`verdict.disclosed.<name>`; list in [PACT_MAPPING §1](PACT_MAPPING.md#1-credential-fields)), or a portfolio line field (`ShipmentLine.<name>` in [`sdk/portfolio.ts`](../sdk/portfolio.ts); schema [portfolio.schema.json](schemas/portfolio.schema.json)).
- **Communication template (R4)**: the `Summary_Communication` field in template v2.1.1. This is the operator-to-importer format the Commission recommends today (R6).
- **O3CI (R5)**: the field name in the operator manual. O3CI is where a registered operator enters the same data on screen.
- **QReport 18.30 (R1)**: the element path, for reference only. The schema is archived (§3).

"Not held" means CarbonLEI has no value for the field: the operator or the declarant must supply it.

### 4.1 Installation and operator

| CarbonLEI source | Communication template (R4), `Summary_Communication` §1 | O3CI (R5) | QReport 18.30 (R1), for reference | Note |
|---|---|---|---|---|
| `disclosed.installationId` | — (no ID field; the template names the installation) | Installation ID (read-only, "filled by the system" when the installation is registered, R5 §4.3) | `GoodsEmissions/Installation/InstallationId` (`an..17`) | CarbonLEI's ID is the operator's own identifier, not a Registry installation ID |
| `disclosed.installationName` (optional) | "Name of the installation (English name)" | Installation name | `…/Installation/InstallationName` | The demo proof hides it |
| `disclosed.unLocode` | "UNLOCODE" | (part of the installation address) | `…/Installation/Address/UNLOCODE` | |
| first two letters of `disclosed.unLocode`; `ShipmentLine.country` is the customs origin | "Country" | Country of establishment | `…/Installation/Address/EstablishmentCountry`; `ImportedGood/OriginCountry/Country` | Origin (customs) and country of the installation can differ |
| `disclosed.supplierLEI` | — | — (O3CI identifies the operator by company registration number) | `…/InstallationOperator/OperatorId` (`an..17`; an LEI has 20 characters) | No CBAM field takes an LEI. CarbonLEI keeps it as the cryptographic identity of the operator |
| `disclosed.operatorId` (optional) | — | — (the manual names no operator ID field) | `…/InstallationOperator/OperatorId` | Only if the supplier discloses it |
| `disclosed.reportingPeriod` | "Reporting period start", "Reporting period end" | Production year | — (`QReport/Year` is the import year) | |
| — | Street, economic activity, coordinates of the main emission source | Address, coordinates | `…/Installation/Address/*`, `EconomicActivity` | Not held |

### 4.2 Product and emissions

| CarbonLEI source | Communication template (R4), `Summary_Communication` §2 | O3CI (R5) | QReport 18.30 (R1), for reference | Note |
|---|---|---|---|---|
| `disclosed.cnCode` (4, 6 or 8 digits); `ShipmentLine.cnCode` | "CN Codes"; "CN Name" | HS sub-heading code, Combined nomenclature code | `ImportedGood/CommodityCode/HsCode` (6), `CnCode` (8) | The demo discloses `7318` (4 digits): neither the 6-digit HS nor the 8-digit CN field can be filled from it |
| — | "Type of aggregated good or precursor" | — | — | For CN 7318 the official code lists (R2) give "Iron or steel products"; CarbonLEI does not store it |
| `disclosed.cbamRoute` (letter of the default-value table, e.g. `C`) | — | Route ID (code list "Production method") | `GoodsEmissions/ProdMethodQualifyingParams/MethodId` | Different code systems: CarbonLEI's letter is the production-route column of IR (EU) 2026/1740; the Registry uses method codes (`P34` for chapter 73 in R2). No conversion is defined, so we map none |
| `disclosed.specificEmbeddedEmissions_tCO2e_per_t`; `ShipmentLine.seeVerified` | "SEE (direct)"; "Unit" (t CO2e/t) | Specific direct emissions (t CO2 per unit, `n..16,7`) | `GoodsEmissions/DirectEmissions/SpecificEmbeddedEmissions`, `MeasurementUnit` `EMU1` | For CN 7318 the verified value is direct emissions only, as the CBAM default values for that CN code |
| — | "SEE (indirect)", "SEE (total)", "Embedded electricity (MWh/t)", "Electricity EF (tCO2/MWh)", "Source for electricity EF" | Electricity consumed, emission factor known, emission factor | `GoodsEmissions/IndirectEmissions/*` | Not held: CarbonLEI's credential carries no indirect emissions |
| `ShipmentLine.basis` and `reason`; `seeUsed`, `defaultValue`, `defaultMarkedUp` | "Share of emissions by default value" (100 % when the importer falls back to the default for the whole line) | — | `DirectEmissions/DeterminationType` `01`/`02` | The template field is the operator's share of default values in its own calculation, not the importer's fallback. CarbonLEI's default line is an importer-side decision and keeps its reason |
| `disclosed.valueType` (`actual`) | — | — | `DirectEmissions/DeterminationType` `01` actual data | |
| `ShipmentLine.quantityTonnes`, `importDate`, `quarter` | — (the template is per installation and product, not per consignment) | — | `ImportedGood/ImportedQuantity/MeasureProcedureImported/NetMass`; `MeasureImported/NetMass` | Customs data the declarant already holds |
| `disclosed.verifiedTonnes` | — | — | — | Tonnes covered by the verified report; CarbonLEI uses it for the tonnage ledger, CBAM has no such field |
| Qualifying parameters (steel mill number, % Mn, % Cr, % Ni, % other alloys, % carbon, scrap per t, …) | Columns "Steel mill identification number" to "% N in other (organic) forms" | Emissions qualifying parameters (shared only with the Commission and NCAs) | `ProdMethodQualifyingParams/*QualifyingParameters` | Not held. R2 marks several of them for CN chapter 73 as required |
| Precursors: `verdict.precursors` (check 9) | Sheet `E_PurchPrec` and "The main reducing agent of the precursor" | — | — | CarbonLEI checks a precursor statement and the producers' verification; the template asks for each precursor's quantity and SEE, which a verified precursor credential provides |

### 4.3 Carbon price paid (CarbonLEI check 10, draft Art 9 rules)

| CarbonLEI source (`verdict.carbonPrice`) | Communication template (R4) | O3CI (R5) | QReport 18.30 (R1), for reference |
|---|---|---|---|
| `mechanism` | "Type of instrument (carbon pricing)" | Form of carbon price | `CarbonPriceDue/InstrumentType` |
| `currency` | "Currency" | Currency | `CarbonPriceDue/Currency` |
| `localPerTonne` | "Carbon price (CP) due (per produced t or MWh)" | Effective carbon price due | `CarbonPriceDue/Amount` |
| `coveredEmissionsPerTonne` | "Embedded emissions covered by the carbon price" | Embedded emissions covered by the carbon price | `CarbonPriceDue/ProductsCovered/QuantityCovered` |
| `paidShare` | "Share of total embedded emissions covered by the carbon price" | — | — |
| — (refunds net out in `paidShare`) | "Type of rebate", "Amount of rebate" | Embedded emissions covered by rebate | — |

Check 10 follows the Commission's **draft** implementing act on the carbon price paid, which is not adopted, so its figures are illustrative ([OPERATE](OPERATE.md)). A declarant should treat this row as a pointer to where the data would go, not as a deduction to claim.

### 4.4 Verification

| CarbonLEI source | Where CBAM expects it | Note |
|---|---|---|
| `disclosed.verificationReportId`, `verifierLEI`, `accreditationNumber`, `nabName`, `assuranceLevel`, `siteVisit`, `materialityThreshold` | Verification report of the accredited verifier (template in the Annex to IR (EU) 2025/2546); in the Registry, the verifier issues it through O3CI (R5) | The communication template has no verification fields |
| `verdict.credSAID`, `verdict.chain.block`, `verdict.overall` | — | CarbonLEI evidence: which signed credential was checked, at which block, with what result. No CBAM field; keep it with the declaration's supporting documents |

## 5. What would change this decision

- **The Commission publishes the declaration's data structure** (XSD, XLSX structure or API), most likely with the 2027 declaration module. We would then write an exporter from a portfolio to that structure: fill only fields with a CarbonLEI source in §4, leave the rest blank and list them, state the version of the specification in the file, and validate it against the published schema in tests if its licence allows us to include it.
- **O3CI gets an import format.** A supplier could then turn a verified credential into an O3CI upload. Until then, a supplier types the §4 values into O3CI or into the communication template.
- **CarbonLEI writes the communication template.** That needs no new schema: `Summary_Communication` (R4) is published. It would fill only the §4 rows that have a CarbonLEI source, and most required cells, such as indirect emissions and qualifying parameters, would stay blank. It is not built, because a mostly blank template would add little to the CSV worksheet and the PACT export. We would build it when a supplier's credential carries those fields.
