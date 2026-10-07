# Mapping to PACT v3 `ProductFootprint`

> **If you do not know PACT.** PACT, WBCSD's Partnership for Carbon Transparency, publishes a JSON data model for exchanging product carbon footprints between companies [1].\
> We export each credential in that model, so software that already reads PACT can read the verified value without learning a CarbonLEI data model.\
> Where PACT has no field (who verified, under which accreditation, how many tonnes), the values travel in a declared extension (§1 and §4).\
> §3 lists where the meanings differ; the main difference is that a CBAM value for CN 7318 covers direct emissions only, not a full product footprint.

CarbonLEI exports each report credential as one WBCSD PACT `ProductFootprint` (Technical Specifications v3.0.3) [1]. The export is **field-compatible**: it is a JSON document that follows the PACT data model. CarbonLEI does not run a PACT API endpoint and is not connected to any PACT network.

**Where it is built.** The export function is `exportPact` in `sdk/pact.ts`. On the command line, `carbonlei export-pact` (`npm run carbonlei -- export-pact --proof <proof.json> --eori <EORI> …`) first runs the full verification, checks 0–8, with check 5 for the importer's own EORI (required) and the vLEI checkers, and exports nothing if check 1, 2, 3, 6 or 7 fails or checks 6 and 7 were not run; with the EORI, check 4 judges the report at the shipment's claim time only when the batch was declared to that importer, otherwise at the latest block, so a credential superseded or expired since an old claim for someone else exports as `Deprecated`. It then reads the report's on-chain record to set `status` and `precedingPfIds`. Only fields the supplier disclosed in the proof can enter the export.

**How it is validated.** The SDK test `sdk/test/pact.test.ts` downloads the OpenAPI definition `spec/v3/openapi.yaml` from the PACT repository at tag `v3.0.3` [1], takes the `ProductFootprint` schema and every schema it references, and validates the export with a JSON Schema 2020-12 validator (Ajv) with the standard formats (UUID, date-time, URI) checked. The specification file is cached locally for the test and is not included in this repository. The test passes. The same tests check that hidden fields never appear in an export, that `id` is deterministic, that `referencePeriodEnd` is exclusive, and the `status` rules in §2. The example in §4 is real output of `carbonlei export-pact` for the demo credential on Sepolia, and it validates against the same schema. The same test file validates the extension's `data` object, for the demo page's export and for the largest and smallest disclosure choices, against the published CarbonLEI extension schema (§4 notes), and checks that the schema rejects fields the exporter never writes.

All values below are illustrative. Companies and LEIs are fictional.

## Five design decisions

1. **`companyIds: ["urn:lei:<LEI>"]`.** PACT requires `companyIds` to be a non-empty set of URNs [1]. For product identifiers and classifications, PACT's URN guidance says an IANA-registered namespace SHOULD be used where one exists and applies (§8) [1]; it gives no such guidance for company identifiers and does not name a namespace for LEIs. We chose `urn:lei`, a URN namespace that GLEIF registered with IANA [2], following the same order of preference.
2. **Verification evidence goes into `extensions`.** In PACT v3, `pcf.verification.providerName` is a plain string with the verifier's name [1]. CarbonLEI adds cryptographic evidence (verifier LEI, accreditation number, auditor AID, KEL sequence number, on-chain registry key) in a `DataModelExtension`, and repeats the accreditation number, the NAB and the verification report ID as readable text in `pcf.verification.comments`.
3. **One credential, one footprint.** A credential covers exactly one (installation, CN code, CBAM production-route code `cbamRoute`, reporting period). Each credential is exported as its own `ProductFootprint`. When one verification report covers several products or routes, the verification body issues several credentials, and their footprints share `extensions.data.cbam.verificationReportId`.
4. **The footprint `id` is derived from the on-chain report key.** Exporting the same credential again gives the same `id`, so a later revision can point to it in `precedingPfIds` (§2). The `id` is a version 8 UUID (RFC 9562 [5]) built from the first 16 bytes of `keccak256("carbonlei-pact-id:" + reportKey)`, with the version and variant bits set; `reportKey` is `keccak256(credSAID)`.
5. **`crossSectoralStandards` is `["CarbonLEI-illustrative"]`, on purpose not a PACT-listed value.** PACT requires a non-empty array and says it SHOULD contain only the standards it lists (for example ISO 14067, the GHG Protocol Product Standard or PEF) [1]. The demo values are illustrative and were not calculated under any of those standards, so we do not name one. This departs from a SHOULD-level recommendation, not from the schema, which only requires strings.

---

## 1. Credential fields

Source: one CBAM Embedded Emissions Credential, which covers one (installation, CN code, `cbamRoute`, reporting period). It has 26 fields.

- "Disclosed" says what the supplier shows in its proof. "Required": every proof must disclose the field, because the checks recompute on-chain keys from it. "Yes": disclosed in the demo proof. "Optional": the supplier may disclose it; the demo hides it. "Never": the field stays with the verification body and the supplier. The demo proof discloses 21 fields and hides 5.
- "CBAM source" gives the point of the verification report template in the Annex to Implementing Regulation (EU) 2025/2546 [4] that the field corresponds to. 15 of the 26 fields correspond to a template point; the other 11 are identifiers, labels, salts, dates or business data that CarbonLEI adds (marked "CarbonLEI").

| # | CarbonLEI field | Example (fictional / illustrative) | Disclosed | PACT v3 target | Transformation / note | CBAM source |
|---|---|---|---|---|---|---|
| 1 | `supplierLEI` | `ZZZZ00TWSCREWDEMO185` (fictional) | Required | `companyIds` | `"urn:lei:" + supplierLEI` (our choice of namespace; see design decision 1) | CarbonLEI (the template identifies the operator by name and registration number, point 1.1(a)–(b)) |
| 2 | `operatorId` | `TWZZZZ00TWSCREWDEMO185` (`TW` followed by the LEI) | Optional | — (no equivalent) | `extensions` → `cbam.operatorId`, only if disclosed | CarbonLEI (CBAM Registry operator identifier; not a template point) |
| 3 | `installationId` | `TW-ZZZZ00TWSCREWDEMO185-0001` (demo format: country code, operator LEI, four-digit serial) | Required | — (no equivalent) | `extensions` → `cbam.installationId`. Also an input of the on-chain scope keys and of the salted installation commitment | Point 1.1(d)(2) |
| 4 | `installationName` | Demo Fasteners Plant 1 (fictional) | Optional | — (no equivalent) | `extensions` → `cbam.installationName`, only if disclosed | Point 1.1(d)(1) |
| 5 | `unLocode` | `TWKHH` | Yes | `pcf.geographyCountry` (partly) | Country = first two letters (`TW`). Full UN/LOCODE → `extensions` → `cbam.unLocode` | Point 1.1(d)(3) |
| 6 | `cnCode` | `7318` (4, 6 or 8 digits) | Required | `productClassifications` (optional in PACT; non-empty set of URNs) | `urn:pact:ec.europa.eu:cn:<cnCode>`, here `urn:pact:ec.europa.eu:cn:7318`. PACT lists no URN namespace for CN codes; its custom format is `urn:pact:$domain-of-issuer$:$type$:$value$`, where the domain is that of the organization that issues the code [1]. CN codes are maintained by the European Commission, hence `ec.europa.eu`. Also kept in `extensions` → `cbam.cnCode` | Point 2.4(b)(3) |
| 7 | `cbamRoute` | `C` (one upper-case letter; illustrative) | Required | — (no equivalent) | `extensions` → `cbam.cbamRoute`. Part of the credential scope key (`credScopeKey`); it must be disclosed so the importer can recompute that key. Each `cbamRoute` has its own credential and its own footprint, so two footprints can share installation, CN code and period and differ only in `cbamRoute` | Point 2.4(a)(1) |
| 8 | `reportingPeriod` | `2026-01-01/2026-12-31` | Required | `pcf.referencePeriodStart`, `pcf.referencePeriodEnd` | Split at `/`. Start: first day at `T00:00:00Z`. PACT treats `referencePeriodEnd` as exclusive, so the end is the day after the last day at `T00:00:00Z` (`2027-01-01T00:00:00Z`) [1] | Point 1.2(b) |
| 9 | `verifiedTonnes` | `500` | Required | — (no equivalent) | `extensions` → `cbam.verifiedTonnes` (string). PACT expresses intensity per declared unit, not volumes | Point 2.4(b)(3) |
| 10 | `specificEmbeddedEmissions_tCO2e_per_t` | `1.8` (illustrative) | Yes | `pcf.pcfExcludingBiogenicUptake`, `pcf.pcfIncludingBiogenicUptake` and `pcf.fossilGhgEmissions` (all required; kgCO2e per declared unit) | Declared unit = 1 kg: `declaredUnitOfMeasurement` `"kilogram"`, `declaredUnitAmount` `"1"` (PACT: for a product supplied in bulk with kilogram as the declared unit, the amount MUST be 1 [1]). 1.8 tCO2e/t = 1.8 kgCO2e/kg, so the value is copied unchanged as the string `"1.8"`. The two PCF values are equal because no biogenic CO2 uptake is declared. Boundary differs, see §3 | Point 2.4(b)(4) |
| 11 | `valueType` | `actual` | Yes | — (no equivalent) | `extensions` → `cbam.valueType`. `primaryDataShare` is not equivalent | CarbonLEI (a verification report covers actual values; the template has no separate field) |
| 12 | `methodologyNote` | illustrative — not official CBAM methodology | Required | `comment` | `comment` starts with this note (the SDK writes the fixed text), followed by the boundary sentence (see `comment` in §4) | CarbonLEI (demo label) |
| 13 | `verificationReportId` | `VR-DEMO-0001` | Required | — (no equivalent) | `extensions` → `cbam.verificationReportId`; also in the text of `pcf.verification.comments`. Shared by all credentials issued from the same verification report | Point 1.2(a) |
| 14 | `verifierLEI` | `ZZZZ00EUVERIFDEMO152` (fictional) | Yes | — (only the `pcf.verification.providerName` string) | `extensions` → `carbonlei.verifierLEI`, taken from the issuer block of the signed credential. `pcf.verification.providerName` (the verifier's legal name) is set only when the caller of `exportPact` supplies the name; `carbonlei export-pact` does not, so the example in §4 has none | CarbonLEI (the template names the verifier, point 1.3(a)) |
| 15 | `accreditationNumber` | `DEMO-ACC-CBAM-0001` (fictional) | Yes | — (no equivalent) | `extensions` → `cbam.accreditationNumber`; also in `pcf.verification.comments` | Point 1.3(d) |
| 16 | `nabName` | Demo Accreditation Body (fictional) | Yes | — (no equivalent) | `extensions` → `cbam.nabName`; also in `pcf.verification.comments` | Point 1.3(e) |
| 17 | `siteVisit` | `physical` | Yes | — (no equivalent) | `extensions` → `cbam.siteVisit` | Point 2.2 |
| 18 | `assuranceLevel` | `reasonable` | Yes | — (removed in v3) | v2 had `assurance.level`; v3 does not [1]. `extensions` → `cbam.assuranceLevel` | Point 2.6(a) |
| 19 | `materialityThreshold` | `5%` | Yes | — (no equivalent) | `extensions` → `cbam.materialityThreshold` | Point 2.3(f) |
| 20 | `idSalt` | 32-byte random value | Required | not exported | Lets the importer recompute the salted on-chain commitments to the supplier's LEI and to the installation. Not a footprint attribute | CarbonLEI |
| 21 | `batchSalt` | 32-byte random value | Required | not exported | Lets the importer recompute the on-chain key of a claimed batch. Not a footprint attribute | CarbonLEI |
| 22 | `issuedAt` | `2027-03-20T00:00:00Z` | Yes | `validityPeriodStart`, `pcf.verification.completedAt` | PACT defines `completedAt` as the date at which the verification was completed [1]. The credential carries no separate verification date; the verification body issues the credential after it completes the verification, so issuance is used as the closest available date | CarbonLEI (credential issuance; the report itself is dated and signed under point 2.6(h)) |
| 23 | `validUntil` | `2027-12-31T00:00:00Z` | Yes | `validityPeriodEnd` | Copied | CarbonLEI (credential validity; not in the template) |
| 24 | `productionRoute` | BF-BOF wire rod, cold heading (illustrative) | Never | not exported | Business-sensitive process description. Not part of any on-chain key; the route that distinguishes credentials is the disclosed regulatory code `cbamRoute` (row 7) | Point 2.4(a)(1) |
| 25 | `energyMix` | grid 70%, on-site solar 30% (illustrative) | Never | not exported | Business-sensitive | CarbonLEI (demo field; not a template point) |
| 26 | `supplierCost` | withheld (illustrative) | Never | not exported | Business-sensitive | CarbonLEI (not in the template) |

### Why thirteen fields have no PACT equivalent

Thirteen credential fields in the table above have no PACT v3 field (marked "—") and travel in the extension; `unLocode` maps only partly; five fields (rows 20, 21, 24, 25 and 26) are not exported at all. We leave those PACT fields empty on purpose and carry the values in a declared `DataModelExtension`.

- **The boundary is different.** For CN 7318, a CBAM value counts direct embedded emissions only. A PACT `ProductFootprint` describes a cradle-to-gate product carbon footprint. Forcing CBAM data into more PCF fields would invite a consumer to read a direct-emissions value as a full PCF. The one emissions value we do map is flagged in `comment`, `pcf.boundaryProcessesDescription` and `extensions.data.cbam.boundary`.
- **Most of these fields describe the CBAM verification, not the footprint.** The operator ID, installation ID and installation name, the CBAM production-route code, the verification report ID, the verifier's LEI, the accreditation number, the NAB, the site visit, the assurance level and the materiality threshold say who verified what under CBAM. PACT v3 keeps only an optional `verification` block (renamed from v2's `assurance`); the verifier appears there as the `providerName` string, with no field for accreditation, the NAB or evidence links [1].
- **Volume is not a footprint attribute.** `verifiedTonnes` is the tonnage that the verified value may cover. PACT expresses emissions per declared unit and does not model volumes.
- **Near matches are not equivalents.** `valueType` (actual or default value) is not `primaryDataShare`. We fill a PACT field only where the meaning is the same.

A consumer that ignores the extension still gets the PACT fields and the boundary warning in `comment`.

### CarbonLEI evidence (not part of the report fields)

| Item | PACT v3 target | Source in CarbonLEI |
|---|---|---|
| `credSAID` | `extensions` → `carbonlei.credSAID` | The credential's self-addressing identifier |
| `auditorAID` | `extensions` → `carbonlei.auditorAID` | The lead auditor's KERI identifier, from the issuer block of the signed credential |
| `kelSeq` | `extensions` → `carbonlei.kelSeq` (string) | Sequence number of the auditor's KEL event that anchors the credential, read from the on-chain report |
| Registry: chain ID, contract address, `reportKey` | `extensions` → `carbonlei.registry` (`chainId` is a number) | The `EmissionsClaimRegistry` deployment the report was read from; `reportKey` = `keccak256(credSAID)` |

---

## 2. PACT fields with no source in the credential

| PACT v3 field | Value in export |
|---|---|
| `id` | Version 8 UUID derived from the on-chain `reportKey` (design decision 4). Same credential, same `id` on every export |
| `precedingPfIds` | Present only for a revision in the same credential layer (same installation, CN code, `cbamRoute` and reporting period): it lists the `id` of the credential the revision replaces. A report that replaces the whole verification report for the period (a new verification report ID for the same installation and period, registered by the original issuer or, once that issuer is no longer active, by another body) has no `precedingPfIds`, because it does not revise one specific credential |
| `specVersion` | `3.0.3` (required; format major.minor.patch) |
| `created` | Export time, UTC, to the second |
| `status` | `Active`; `Deprecated` when verification check 4 reports the credential as superseded. A revoked report is not exported: `exportPact` stops with an error. When the report has no on-chain record, the export is `Active` and `comment` adds "Exported offline; on-chain status not checked." |
| `companyName` | Supplied by the exporter (`--company-name`); in the demo, the supplier's legal name (fictional) |
| `productDescription`, `productNameCompany` | Supplied by the exporter. In the demo, `productDescription` also states the boundary: "Hex bolts, carbon steel — CBAM direct embedded emissions only, not a full PCF (illustrative)" |
| `productIds` | `urn:pact:zuemen.github.io:product-id:<product ID>` (`--product-id`). The demo uses the project's own domain because the fictional supplier has none; a real supplier would use the domain of the organization that assigns its product IDs |
| `validityPeriodStart`, `validityPeriodEnd` | From `issuedAt` and `validUntil` (§1, rows 22 and 23); omitted if those fields are not disclosed |
| `pcf.declaredUnitOfMeasurement`, `pcf.declaredUnitAmount`, `pcf.productMassPerDeclaredUnit` | `"kilogram"`, `"1"`, `"1"` (all three required). For a product supplied in bulk with kilogram as the declared unit, PACT requires `declaredUnitAmount` to be 1 [1]. `productMassPerDeclaredUnit` is the product mass in kg per declared unit, excluding packaging: 1 kg of product gives `"1"` |
| `pcf.geographyCountry` | First two letters of the disclosed `unLocode`; omitted if `unLocode` is not disclosed |
| `pcf.ipccCharacterizationFactors` | `["AR6"]` (required, non-empty), the version the PACT Methodology asks for [1]. The demo value is illustrative and was not calculated with any set of characterization factors; a real export must list the factors that the verified calculation used |
| `pcf.crossSectoralStandards` | `["CarbonLEI-illustrative"]` (required, non-empty); see design decision 5 |
| `pcf.fossilGhgEmissions` | Required (kgCO2e per declared unit). Set equal to `pcfExcludingBiogenicUptake` (`"1.8"` in the example): the emissions of a carbon-steel product are treated as entirely fossil, and no land-use, biogenic or removal terms are declared. Illustrative — not official CBAM methodology |
| `pcf.fossilCarbonContent` | Required (kgC per declared unit). Always `"0"`: a placeholder, not a measured value. The credential carries no carbon-content data, and carbon steel contains carbon, so a real export needs the product's fossil carbon content from another source. Known limitation |
| `pcf.exemptedEmissionsPercent` | Required. Always `"0"` (illustrative). It is the percentage of emissions excluded from the declared value; the CBAM boundary difference is stated in `comment`, `pcf.boundaryProcessesDescription` and the extension, not as an exemption percentage. We have not reviewed this against the PACT Methodology's exemption rules |
| `pcf.boundaryProcessesDescription` | "CBAM embedded direct emissions — not a full product carbon footprint" |
| `pcf.primaryDataShare`, `pcf.dqi` | Not exported. The schema does not require them; the PACT Methodology reporting rules mark `primaryDataShare` as SHALL and `dqi` as SHALL-2027 [1]. The credential has no source for either, and `valueType` is not a substitute (see §1). Known limitation |
| `pcf.verification.coverage`, `pcf.verification.standardName`, `pcf.verification.comments` | `product level` (one of the three allowed values); "CBAM verification, Implementing Regulation (EU) 2025/2546" (free text); "<accreditation number>; <NAB>; <verification report ID>" when all three are disclosed. The `verification` object and all its fields are optional in PACT |

---

## 3. Semantic differences

| Topic | CBAM credential | PACT v3 | How the export handles it |
|---|---|---|---|
| System boundary | CBAM specific embedded emissions; for CN 7318 direct emissions only | Cradle-to-gate product carbon footprint | The value is flagged in `comment`, `productDescription`, `pcf.boundaryProcessesDescription` and `extensions.data.cbam.boundary`. Consumers must not treat it as a full PCF. Software that maps this value into a PCF database must read the boundary; we cannot prevent misuse by software that ignores it. The same boundary difference is the main reason many credential fields have no PACT equivalent; see §1, "Why thirteen fields have no PACT equivalent". |
| Unit | tCO2e per tonne | kgCO2e per declared unit | Declared unit = 1 kg (`declaredUnitAmount` `"1"`, as PACT requires for a product supplied in bulk by kilogram). 1 tCO2e/t = 1 kgCO2e/kg, so the number is carried over unchanged: 1.8 tCO2e/t → `"1.8"` kgCO2e per kg |
| Verifier identity | LEI, accreditation number, NAB, signed by an authorised auditor | `providerName` string | Evidence in `extensions`; accreditation number, NAB and report ID also as text in `pcf.verification.comments` |
| Assurance level | `reasonable`, materiality 5% | Not in v3 | `extensions` |
| Volume | `verifiedTonnes`, on-chain tonnage ledger | Not modelled | `extensions`; live status on-chain |
| Revocation | `revokeReport` on-chain | New footprint with `precedingPfIds`; old one `Deprecated` | Revocation is not the same as supersession. A revoked report is not exported. A document exported before the revocation is not changed; a consumer checks current status on-chain with `extensions.data.carbonlei.registry.reportKey`. A revised credential is registered with `supersedes`, pointing to the previous credential for the same `credScopeKey` (installation, CN code, `cbamRoute` and reporting period); its footprint lists the previous footprint's `id` in `precedingPfIds`. A footprint of a superseded credential, if exported again, has `status` `Deprecated`; copies exported earlier are not changed. |
| Selective disclosure | Undisclosed fields hidden | All fields in the document are visible | The export contains disclosed fields only; the three fields marked "Never" in §1 and the two salts are never exported |

---

## 4. Example export (illustrative)

Real output of `carbonlei export-pact` for the demo proof, read against the Sepolia deployment on 5 October 2026 (`--eori NLDEMO000000001 --company-name "Demo Fasteners Co. (fictional)" --product-name "Hex bolt (illustrative)" --product-id hex-bolt-m10`, and the product description shown; `--eori` is required since 7 October 2026 and does not change this output). Only `created` changes between runs, as long as the on-chain state is unchanged.

```json
{
  "id": "94ac92cd-0a3c-846a-b7ab-62ec918ac204",
  "specVersion": "3.0.3",
  "created": "2026-10-05T05:35:32Z",
  "status": "Active",
  "validityPeriodStart": "2027-03-20T00:00:00Z",
  "validityPeriodEnd": "2027-12-31T00:00:00Z",
  "companyName": "Demo Fasteners Co. (fictional)",
  "companyIds": [
    "urn:lei:ZZZZ00TWSCREWDEMO185"
  ],
  "productDescription": "Hex bolts, carbon steel — CBAM direct embedded emissions only, not a full PCF (illustrative)",
  "productIds": [
    "urn:pact:zuemen.github.io:product-id:hex-bolt-m10"
  ],
  "productClassifications": [
    "urn:pact:ec.europa.eu:cn:7318"
  ],
  "productNameCompany": "Hex bolt (illustrative)",
  "comment": "illustrative — not official CBAM methodology. CBAM direct embedded emissions, not a full PCF.",
  "pcf": {
    "declaredUnitOfMeasurement": "kilogram",
    "declaredUnitAmount": "1",
    "productMassPerDeclaredUnit": "1",
    "referencePeriodStart": "2026-01-01T00:00:00Z",
    "referencePeriodEnd": "2027-01-01T00:00:00Z",
    "geographyCountry": "TW",
    "pcfExcludingBiogenicUptake": "1.8",
    "pcfIncludingBiogenicUptake": "1.8",
    "fossilGhgEmissions": "1.8",
    "fossilCarbonContent": "0",
    "ipccCharacterizationFactors": [
      "AR6"
    ],
    "crossSectoralStandards": [
      "CarbonLEI-illustrative"
    ],
    "exemptedEmissionsPercent": "0",
    "boundaryProcessesDescription": "CBAM embedded direct emissions — not a full product carbon footprint",
    "verification": {
      "coverage": "product level",
      "completedAt": "2027-03-20T00:00:00Z",
      "standardName": "CBAM verification, Implementing Regulation (EU) 2025/2546",
      "comments": "DEMO-ACC-CBAM-0001; Demo Accreditation Body (fictional); VR-DEMO-0001"
    }
  },
  "extensions": [
    {
      "specVersion": "2.0.0",
      "dataSchema": "https://zuemen.github.io/carbon-lei/schemas/carbonlei-extension-0.1.0.json",
      "documentation": "https://github.com/zuemen/carbon-lei/blob/main/docs/PACT_MAPPING.md",
      "data": {
        "cbam": {
          "boundary": "direct embedded emissions",
          "installationId": "TW-ZZZZ00TWSCREWDEMO185-0001",
          "unLocode": "TWKHH",
          "cnCode": "7318",
          "cbamRoute": "C",
          "verifiedTonnes": "500",
          "valueType": "actual",
          "verificationReportId": "VR-DEMO-0001",
          "accreditationNumber": "DEMO-ACC-CBAM-0001",
          "nabName": "Demo Accreditation Body (fictional)",
          "siteVisit": "physical",
          "assuranceLevel": "reasonable",
          "materialityThreshold": "5%"
        },
        "carbonlei": {
          "credSAID": "ELXG3ZjKZ5rsmJ8WljbM2vW2PJL9FesRnlVgh0hVTZvx",
          "verifierLEI": "ZZZZ00EUVERIFDEMO152",
          "auditorAID": "EGHjZo9vQa0uxcbQIr2fgWdCglUH0vj5Rva3UZuhDwHE",
          "kelSeq": "3",
          "registry": {
            "chainId": 11155111,
            "contract": "0xEA52a50d3753bACD835DCd47892754b65a90ca19",
            "reportKey": "0x4ed7588537cff1c445880821e44f2df65f517199f7edbe26f9e59cd4724a4ab8"
          }
        }
      }
    }
  ]
}
```

Notes:

- The demo proof hides `operatorId` and `installationName`, so `extensions.data.cbam` has neither; `verifierName` is not supplied by the command, so `pcf.verification` has no `providerName`.
- `extensions` is a top-level array of the `ProductFootprint`. Each element is a `DataModelExtension` with the required properties `specVersion`, `dataSchema` and `data` (§4.8) [1]. `specVersion` is `2.0.0`, the version of the Data Model Extensions specification, and `dataSchema` and `documentation` must be HTTPS URLs [3]. In this document, `extensions.data.cbam.*` and `extensions.data.carbonlei.*` refer to the `data` object of the CarbonLEI element; the shorthand "`extensions` → `cbam.x`" in §1 means the same.
- `dataSchema` is the URL of the JSON Schema (draft 2020-12) of the CarbonLEI extension, version 0.1.0. The file is `demo/public/schemas/carbonlei-extension-0.1.0.json`, served at that URL by the GitHub Pages deployment of the demo, with the URL as its `$id`. It describes the `data` object exactly as `exportPact` writes it: `cbam` and `carbonlei` with their required fields, string values (`chainId` an integer), the fixed `boundary` value, and the normal forms the verifier checks before any export (installation ID, CN code, route code); any other field is rejected. What a field means, and rules a schema cannot express, are in this document, as the Data Model Extensions specification asks [3].
- The example contains every property that the v3.0.3 OpenAPI definition marks as required for `ProductFootprint` (10), `CarbonFootprint` (12) and `DataModelExtension` (3), and it validates against `components/schemas/ProductFootprint` with the standard formats (UUID, date-time, URI) checked. PACT's own format names `urn` and `decimal` are not known to the validator and are not checked as formats.
- Tonnages and the KEL sequence number inside the extension are strings, as in the credential and in PACT decimals; `chainId` is a number.
- The PACT required-field list and field names used above come from v3.0.3 §4.6–4.8 and §4.12 and the `openapi.yaml` published with it [1].

---

## Sources

Accessed 2026-09-29 unless stated.

1. WBCSD PACT, Technical Specifications for PCF Data Exchange, Version 3.0.3, 18 November 2025 (§4.4 PACT Methodology Reporting Rules, §4.6 ProductFootprint, §4.7 CarbonFootprint, §4.8 DataModelExtension, §4.12 Verification, §8 Product Identification and Classification, Appendix A Changelog). https://wbcsd.github.io/tr/2025/data-exchange-protocol-20251118/ ; OpenAPI definition: https://wbcsd.github.io/tr/2025/data-exchange-protocol-20251118/openapi.yaml ; the copy the SDK tests download, from the PACT repository at tag v3.0.3 (accessed 2026-10-05): https://raw.githubusercontent.com/wbcsd/data-exchange-protocol/v3.0.3/spec/v3/openapi.yaml
2. IANA, URN formal namespace "LEI", registrant: Global Legal Entity Identifier Foundation (GLEIF), registered 22 December 2021. https://www.iana.org/assignments/urn-namespaces/urn-formal/lei
3. WBCSD PACT, Technical Specification for Data Model Extensions, Living Document, 27 June 2024. https://wbcsd.github.io/data-model-extensions/spec/
4. Commission Implementing Regulation (EU) 2025/2546, Annex (template of the verification report), points 1.1–1.3 and 2.1–2.6, OJ L, 22 December 2025, accessed 2026-10-05. https://eur-lex.europa.eu/eli/reg_impl/2025/2546/oj
5. IETF, RFC 9562, "Universally Unique IDentifiers (UUIDs)", May 2024 (UUID version 8). https://www.rfc-editor.org/rfc/rfc9562
