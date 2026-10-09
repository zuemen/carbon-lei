# Climate impact assessment

An EU importer that cannot check who signed a verified value, or whether its tonnes were already claimed, falls back on the CBAM default: 2.978 tCO2e per tonne for screws from Taiwan in 2026, against the 1.8 verified in the demo (illustrative). CarbonLEI makes the signer's authority and the remaining verified tonnage checkable, so for one 500 t report the verified value can be relied on instead, putting 589 tCO2e less on the declaration (about €48,486 gross at €82.32 per tCO2e). That is a declared-emissions gap, not a physical reduction: CarbonLEI claims no emission reduction, and the incentive to switch to lower-carbon steel is largely offset by free allocation until about 2030, so we do not quantify one.

> **Deliverable.** This document answers the requested "Climate impact assessment and carbon reduction projections": it reports the declared-emissions gap in tCO2e and € per tonne against the CBAM default value, for one report (Section 2) and for 10 / 100 / 1,000 installations (Section 4).\
> **Why no reduction projection.** A physical reduction would come mainly from producers switching to lower-carbon steel; free allocation largely offsets the CBAM incentive to do so until about 2030 (Section 2a), and we found no public case of a fastener producer switching because of CBAM (Section 6), so a projected tonnage would be invented.

All companies are fictional. All emissions values for the demo producer are illustrative — not official CBAM methodology. Money figures are gross and illustrative only. The free-allocation adjustment is deducted from both default and actual declarations, so it changes the gap between them only slightly; we show gross figures until the precursor benchmark is confirmed (Section 2a).

**Certificate price used.** All € figures use the Q3 2026 CBAM certificate price of €82.32 per tCO2e, published by the Commission on 5 October 2026 [7] (Q2 2026: €75.28; Q1 2026: €75.36).

## How it connects to climate outcomes

CBAM is meant to reduce global emissions "also by creating incentives for the reduction of emissions by operators in third countries" [23, Article 1(1)]. That incentive reaches a producer only through the numbers its buyers declare. In one sentence: **outside the Registry, CBAM's price rewards a producer's verified lower emissions only if buyers can trust who signed the verified value and it covers no more tonnes than were verified; CarbonLEI makes the signer's authority and the tonnes left machine-checkable for buyers that check the same ledger.** It does not check that the value itself is correct.

| Step | What the CBAM rules say | Where the link can break (our reading) | What CarbonLEI does |
|---|---|---|---|
| 1. The importer pays per declared tonne of CO2e | The declarant surrenders certificates corresponding to the embedded emissions declared and verified [23, Article 22(1)] | — | Nothing |
| 2. A producer's lower emissions count only through a verified actual value | Embedded emissions are determined from actual emissions or by reference to default values [23, Article 7(2)]; default values carry a mark-up because installation-specific data from third countries are hard to verify [1, recital 4] | A buyer that cannot check who signed the value may fall back on the default value, which is set conservatively high, and the producer's lower verified value then earns it nothing | Any buyer can check by software who signed the value and whether that body and auditor were authorised at the block that registered the report |
| 3. The reward is per verified tonne | Each 0.1 tCO2e/t of lower verified intensity accounts for about €8.23 per tonne of goods at €82.32 (gross, illustrative; Section 2) | If one low value covers more tonnes than were verified, goods no verifier covered could be declared, and priced, at the low value, contrary to the verification requirement of Article 8, unless a review under Article 19 catches it [23]: less embedded carbon is priced, and the reward is collected without verified emissions behind those tonnes | Each verified tonne can be claimed once among buyers that check the same ledger (Section 3) |
| 4. The producer decides whether to invest | — | Free allocation offsets much of the incentive until about 2030 (Section 2a); whether the value reaches the producer is commercial | Nothing |

Scenario, from Section 3 (illustrative): if the demo's 200 t were claimed a second time, goods no verifier covered would be declared at 1.8 tCO2e/t; assuming they emit at the unmarked default (A5 in Section 4.1), about 181.4 tCO2e (200 × 0.907) would go unpriced; against the marked-up default, 235.6 tCO2e less would be declared, of which the mark-up part is a surcharge, not emissions. That is one worked case, not a rate or a total.

**Limits.** CarbonLEI does not create the incentive, set the price, measure emissions or reduce them; it makes two conditions for that incentive checkable outside the Registry. Inside the CBAM Registry its added effect on declared emissions is about zero (Section 4.4). The tonnage cap is voluntary and binds only buyers that check the same ledger. We know of no observed rate of buyers falling back on defaults or of over-claiming (A4 in Section 4.1), so we give no figure for emissions kept in declarations and no tCO2e avoided.

## Summary

**What CarbonLEI contributes.** CarbonLEI protects the integrity of verified embedded-emissions data in CBAM supply chains: each verified tonne of goods can be claimed only once within this deployment, per credential, across importers (this does not show that the physical goods are unique; a second report for the same installation and reporting period reverts with `PeriodAlreadyCovered` unless it names the report it supersedes), and software can check who signed a value and whether the body and its auditor were authorised at the block that registered the report (revocations count from the block in which the watcher syncs them; a report registered within 24 hours before a sync is flagged CONTESTED). That is environmental transparency and carbon tracking that a PDF copy of a verification report cannot give, offered outside the Registry as supplementary evidence. Its limits, and how it differs from the figures below, are in Section 4.4.

**Headline (one 500 t report, illustrative).** Declaring the verified 1.8 tCO2e/t instead of the 2026 default of 2.978 puts 589 tCO2e less on the CBAM declaration: 453.5 tCO2e of difference to the unmarked default plus 135.5 tCO2e of mark-up. At the Q3 2026 certificate price of €82.32 that is about €48,486, gross. This is a declared-emissions gap, not a physical reduction, and it comes from the verified value itself; what CarbonLEI adds is set out in Section 4.4. The tonnage ledger caps total claims against the report at its verified 500 t of goods.

CarbonLEI bears on emissions accounting in three ways: more accurate declarations, no over-claiming of verified tonnage, and a value attached to a lower verified intensity. Only the third one could lead to a physical reduction, and we do not quantify it.

Over-claiming of verified tonnage means declaring more tonnes of goods against one verified report than it verified. Here we mean one verified tonnage being claimed by more declarations than it covers, not the double counting discussed in emission inventories. Under CBAM, several importers may rely on the same verified intensity, as long as their tonnes together stay within what the report verified.

| Effect | What changes | Physical reduction? |
|---|---|---|
| 1. Trusted actual values replace default values | Declared embedded emissions reflect the verified plant, not a marked-up default | It changes what is declared; no physical reduction by itself |
| 2. Over-claiming of verified tonnage is blocked | A verified low value cannot cover more tonnes than the report verified | The cap holds within this deployment, per credential; no physical reduction by itself |
| 3. A lower verified intensity has a value | Effects 1 and 2 give a lower verified intensity a value in CBAM terms: each 0.1 tCO2e/t accounts for about €8.23 per tonne of goods at €82.32 (gross, illustrative). Who captures it is a commercial matter between buyer and producer; where it reaches the producer, it is an incentive to invest | Incentive only. Largely offset by free allocation until about 2030; full from 2034. Not quantified |

Unit: the declared-emissions gap in tCO2e per tonne of goods, and its value in € per tonne at the certificate price. Baseline: the CBAM default value with mark-up.

In the demo, the ledger rejects a 400 t claim for a second importer against the 500 t report, which has 300 t left after a 200 t claim: the contract reverts with `ExceedsVerifiedTonnage` (300,000 kg remaining, 400,000 kg requested). The hosted demo shows this as a dry run against the live Sepolia contract, and the same case is one of the 19 tampering cases in the SDK test suite (Section 3).

---

## 1. Why trustworthy actual values matter

**Default values carry a mark-up.** Under CBAM, an importer declares embedded emissions using either verified actual values or the Commission's default values. For CN 7318 goods (screws, bolts, nuts) from Taiwan, the default direct emission value is 2.707 tCO2e per tonne. The mark-up is 10% for 2026, 20% for 2027 and 30% from 2028 [1]. That gives 2.978 in 2026, about 3.25 in 2027 and 3.519 from 2028. Since Implementing Regulation (EU) 2026/1740, the CBAM Registry computes the marked-up values from the unmarked default; its rounding rule is not published [1].

**Why there is a mark-up.** Default values include a mark-up "to account for the deviations of an individual installation with emission levels higher than the relevant average emission intensity of the producer country". Because of "the difficulties to verify that installation-specific data from third countries is of a sufficiently high quality", the Commission estimates that deviation from Union installations [1, recital 4].

**Verification capacity is scarce.** Actual values need an accredited verifier. In the Commission's state of play of 29 September 2026, 24 EU/EEA national accreditation bodies had agreed to offer CBAM accreditation, but only 5 were accepting applications from verifiers outside the EU; on 7 October 2026 the Commission had not yet published its list of accredited verifiers. The first verification reports are expected in January 2027 [2]. The Commission phased the mark-up in because "the number of verifiers may increase in the first years", so that declarants can "use default values in those first years, and rely on actual emissions subsequently" [1, recital 5]. In a press release of 9 March 2026, the European Fastener Distributor Association (EFDA) called CBAM "a drastic punitive tariff on imported screws, nuts and other fasteners". The missing verification capacity was one of the reasons it gave [3].

**Verification itself can be gamed.** In 2024 the German Environment Agency refused to approve certificates for around 215,000 tonnes of CO2; they concerned upstream emission reduction projects under Germany's fuel greenhouse-gas quota scheme, not CBAM or the EU ETS [4]. CarbonLEI does not prevent a wrong number; it makes the signer and their authority checkable.

**What CarbonLEI adds.** Outside the Registry, as supplementary evidence, CarbonLEI lets a buyer check three things about a verified value in software:

1. it was signed by an authorised person on behalf of an accredited verifier [5];
2. that authority was valid at the block that registered the report (revocations count from the block in which the watcher syncs them; a report registered within 24 hours before a sync is flagged CONTESTED);
3. the verified tonnes have not been claimed before, within this deployment, per credential.

It does not measure emissions and does not replace the verification.

---

## 2. Worked example: one report (illustrative)

The demo producer, Demo Fasteners Co. (fictional), has a verified report for 500 t of CN 7318 goods at 1.8 tCO2e/t (illustrative).

**Demo timeline.** The demo follows the CBAM calendar. The reporting period is the calendar year 2026: for goods imported in 2026, the reporting period is the year 2026 [19]. The fictional verification report is signed on 15 March 2027 and the credential is issued on 20 March 2027, valid until 31 December 2027; the first annual CBAM declaration, for 2026, is due by 30 September 2027 [20]. The Sepolia transactions were sent in October 2026 to build the demo, so their block times are earlier than the dates inside the credential.

### Per tonne

| Basis | tCO2e per t | Difference to verified 1.8 | Verified value is lower by |
|---|---|---|---|
| Verified actual (illustrative) | 1.8 | — | — |
| Default, direct, no mark-up | 2.707 | 0.907 | 33.5% |
| Default with 2026 mark-up | 2.978 | 1.178 | 39.6% |
| Default with 2027 mark-up (2.707 × 1.2) | about 3.25 (3.2484) | 1.448 | 44.6% |
| Default with mark-up from 2028 | 3.519 | 1.719 | 48.8% |

### Sensitivity to the verified value

The gap depends on the verified value. At 1.5 tCO2e/t the 2026 gap is about 1.48 tCO2e per tonne; at 2.5, about 0.48 tCO2e.

| Verified value (tCO2e/t, illustrative) | Gap to 2026 default of 2.978 | Gap to default of 3.519 from 2028 | 2026 gap for the demo's 200 t shipment (tCO2e, gross) |
|---|---|---|---|
| 1.5 | 1.478 | 2.019 | 295.6 |
| 1.8 (demo) | 1.178 | 1.719 | 235.6 |
| 2.5 | 0.478 | 1.019 | 95.6 |

### Per 500 t report

| Basis | Declared tCO2e for 500 t | Gap to verified |
|---|---|---|
| Verified actual (illustrative) | 900 | — |
| Default, direct, no mark-up | 1,353.5 | 453.5 |
| Default, 2026 | 1,489 | 589 |
| Default, 2027 (3.2484) | 1,624.2 | 724.2 |
| Default, from 2028 | 1,759.5 | 859.5 |

How to read the gap:

- **453.5 tCO2e** is the difference between this plant's (illustrative) intensity and the unmarked default reference.
- The rest of the gap (for example 589 − 453.5 = 135.5 tCO2e in 2026) is the mark-up. It is a regulatory surcharge for missing verified data, not emissions.
- **Money, gross and illustrative:** multiply the gap by the CBAM certificate price P (€ per tCO2e) for the period. At the Q3 2026 price of €82.32 [7], the 2026 gap is about €97 per tonne, or about €48,486 for the 500 t report; from 2028 it is about €142 per tonne at the Q3 2026 price, held constant. Before the free-allocation adjustment, which is deducted in both cases and changes the gap only slightly (Section 2a). Not adjusted for any carbon price paid in the country of origin.

The Buyer tab of the hosted demo (EU importer or downstream customer) shows the same comparison for the demo shipment of 200 t: 595.6 tCO2e at the 2026 default of 2.978 against 360 tCO2e at the verified 1.8, a declared-emissions gap of 235.6 tCO2e, or about €19,395 gross at the Q3 2026 price of €82.32. The card labels the figure as illustrative, before the free-allocation adjustment, and as a gap in what is declared, not a physical reduction. Below it, a hypothetical card, "What a lower verified intensity is worth", lets the reader move the verified intensity: each 0.1 tCO2e/t of verified intensity accounts for about €8.23 per tonne of goods (gross, illustrative; 0.1 × €82.32). That value depends on the buyer trusting who signed the verified value and that its tonnes were not claimed before. Who captures it is a commercial matter between buyer and producer.

---

## 2a. Free-allocation adjustment

**Takeaway:** the free-allocation deduction applies to both default and verified declarations, so it changes the gap only slightly; it does offset much of the incentive to switch to lower-carbon steel until about 2030, and part of it until 2034, which is why we do not project a physical reduction.

Both kinds of declaration deduct an amount for free allocation, but not the same amount. A declaration based on default values deducts a default benchmark for the production route of the country of origin. A declaration based on actual values deducts the benchmark for the good itself plus an amount for its precursor, here the steel wire rod; if the wire rod producer provides no verified value, the precursor amount also follows the default route of the country of origin [11]. Under our assumptions (one tonne of wire rod per tonne of screws; the precursor benchmark approximated by the value for CN 7318), the two deductions are close, so the adjustment changes the per-tonne gap only slightly. The precursor benchmark has not been confirmed, so this document reports gross figures only, before the free-allocation adjustment.

The adjustment matters more for the incentive to buy lower-carbon steel. Wire rod from scrap-based electric arc furnaces would lower a producer's actual embedded emissions. Where the wire rod producer provides a verified value, it would also lower the precursor deduction, which offsets part of the benefit. Free allocation is phased out: the CBAM factor applied to the deduction is 97.5% in 2026, 51.5% in 2030 and 0% from 2034 [12]. The incentive to switch is therefore largely offset until about 2030 and becomes complete in 2034. We do not quantify it.

---

## 3. Over-claiming of verified tonnage: what the ledger prevents

| Step | Action | Ledger | Contract result | In the demo |
|---|---|---|---|---|
| 1 | Report registered: 500 t at 1.8 tCO2e/t | verified 500 t, claimed 0 t | `ReportRegistered` | Sepolia transaction, 5 October 2026 [21] |
| 2 | Claim batch BATCH-DEMO-2026-0001, 200 t, for importer 1 | claimed 200 t, remaining 300 t | `ShipmentClaimed` | Sepolia transaction, 5 October 2026 [21] |
| 3 | Claim batch BATCH-DEMO-2026-0001 again for importer 2 | unchanged | revert `BatchAlreadyClaimed` | Dry run (`eth_call`) against the live Sepolia contract in the "Try to break it" tab; no transaction is sent |
| 4 | Claim new batch BATCH-DEMO-2026-0002, 400 t, for importer 2 | unchanged | revert `ExceedsVerifiedTonnage` (300,000 kg remaining, 400,000 kg requested) | Dry run, as step 3 |

Steps 3 and 4 are also among the 19 tampering cases of the SDK test suite, which runs them against a local test chain; all 19 cases are rejected.

What step 3 would hide without the ledger: 200 t of goods not covered by the report would be declared at 1.8 instead of a default.

| Reference for the uncovered goods | Hidden emissions for 200 t |
|---|---|
| Default, direct, no mark-up (2.707) | 200 × 0.907 = **181.4 tCO2e** |
| Default with 2026 mark-up (2.978) | 200 × 1.178 = **235.6 tCO2e** declared |

The 235.6 tCO2e here is the same calculation, 200 × 1.178, as the 235.6 tCO2e shown in the demo's Buyer tab for the 200 t shipment that is claimed legitimately: there it is the declared-emissions gap the importer obtains with the verified value; here it is what a duplicate claim would hide. The two are one figure read two ways and are not additive.

If the whole 500 t report were reused once more, 453.5 tCO2e would be hidden against the unmarked default. The contract caps total claims at 500 t, whatever the order of claims: an invariant fuzz test calls the contracts in random sequences (256 runs of 128 calls each) and checks that the tonnes claimed against each credential never exceed the verified tonnes of its latest version and always equal the sum of the successful claims; it found no violation.

The cap also holds across reports: a second report for the same installation and reporting period is rejected unless it is a revision, and a revision carries over the tonnes already claimed. This covers reports registered in the same contract deployment (see [SECURITY.md](SECURITY.md), T19).

---

## 4. Scenario projections (10 / 100 / 1,000 installations)

These are **scenarios under stated assumptions, not forecasts.** Every input marked "Assumption" is ours. Change any of them and the results scale linearly.

### 4.1 Assumptions

| # | Parameter | Value | Type | Basis |
|---|---|---|---|---|
| A1 | EU-bound volume per installation | 500 t per year | Assumption | Same as the demo report. For scale only: 371,270 t divided by the about 2,600 firms that Taiwan's Ministry of Environment counts as affected is about 143 t per firm; that count is not limited to exporters of CN 7318, and export concentration is unknown |
| A2 | Verified intensity of participating installations | 1.8 tCO2e/t | Assumption (illustrative) | Demo value; see the sensitivity table in Section 2 |
| A3 | Default reference | 2.707 tCO2e/t direct; 2.978 with 2026 mark-up; about 3.25 in 2027; 3.519 from 2028 | Regulatory value | IR (EU) 2025/2621 as replaced by 2026/1740, CN 7318, Taiwan [1] |
| A4 | Share of verified tonnage that would be claimed a second time without a shared ledger | 1% (low), 5% (high) | Sensitivity parameter (no empirical basis) | We found no public statistic; the first verified CBAM reports are expected only from January 2027 |
| A5 | True intensity of goods wrongly covered by an over-claim | 2.707 tCO2e/t | Assumption | Unmarked default used as a proxy |
| A6 | Scaling | Linear; no interaction, rebound or leakage effects | Assumption | Simplification |

### 4.2 Results per year

V = installations × 500 t. P = €82.32, the Q3 2026 certificate price, held fixed (assumption).

| Scenario | Volume V (t) | Declared-emissions gap vs 2026 default (tCO2e) | Gap vs default from 2028 (tCO2e) | Price signal, gross, 2026 (€ million per year at P = €82.32) | Price signal, gross, from 2028 (€ million per year at P = €82.32, held constant) |
|---|---|---|---|---|---|
| 10 installations | 5,000 | 5,890 | 8,595 | 0.48 | 0.71 |
| 100 installations | 50,000 | 58,900 | 85,950 | 4.85 | 7.08 |
| 1,000 installations (more than all 2025 EU imports of CN 7318 from Taiwan; Section 4.3) | 500,000 | 589,000 | 859,500 | 48.49 | 70.75 |

Formulas:

- Declared-emissions gap = V × (default − 1.8). Not a physical reduction.
- Price signal, gross and illustrative = gap × P, before the free-allocation adjustment.
- Emissions kept in declarations = V × A4 × (A5 − 1.8): real emissions that would otherwise vanish from CBAM declarations through over-claiming of verified tonnage. We do not tabulate it, because A4 has no empirical basis; the tonnage ledger's effect is not quantified.

Per 1,000 t of verified goods, each percentage point of tonnage claimed a second time would hide 11.78 tCO2e against the 2026 marked-up default (9.07 against the unmarked default, the A5 value used in the formula above). We know of no observed over-claiming rate, so we state no total.

These totals are the declared-emissions gap at stake wherever verified values replace default values. They are not CarbonLEI's own contribution; see Section 4.4.

Physical reductions are not quantified. See Section 2a for why the CBAM incentive to switch to lower-carbon steel is largely offset until about 2030.

### 4.3 Scale check

1,000 installations × 500 t = 500,000 t per year. That is more than all EU imports of CN 7318 goods from Taiwan in 2025, 371,270 t [6]. The 1,000-installation scenario therefore implies other countries or other CBAM goods, not Taiwanese fasteners alone.

### 4.4 Attribution: what CarbonLEI itself adds

What CarbonLEI itself adds is the integrity of verified data: software can check who signed a verified value and whether they were authorised at the block that registered the report (as far as the watcher has synced revocations), wherever the value travels, and the tonnage ledger lets each verified tonne of goods be claimed only once within this deployment, per credential, across importers (a second report for the same installation and reporting period reverts with `PeriodAlreadyCovered` unless it names the report it supersedes); it does not show that the physical goods are unique. That is its contribution to environmental transparency and carbon tracking. The figures in Sections 2 and 4.2 are a different thing: the effect of declaring a verified value instead of a default value, which any verified CBAM value has, with or without CarbonLEI. CarbonLEI's own contribution is stated below in qualitative terms only; we give no figure for it.

#### Where the effect falls

| | Inside the CBAM Registry | Outside the CBAM Registry |
|---|---|---|
| Who receives the verified value | Declarants that receive the operator's data and report through the Registry | Downstream buyers, banks, product passports, and declarants that receive the e-signed PDF copy from an unregistered operator in 2027 |
| What CarbonLEI adds | A machine-checkable record of who signed and with what authority; no new emissions data | The verification body's authority stays machine-checkable wherever the report travels, and buyers can apply a voluntary tonnage cap across importers |
| Effect on declared emissions | The contribution there is the checkable record in the row above; CarbonLEI's added effect on declared emissions is about zero at the margin, because the verified value already replaces the default value there | Not quantified: we cannot estimate how many verified values will travel outside the Registry |

**The tonnage ledger** has an accounting-integrity effect: it stops one verified value from covering more tonnes than were verified, within this deployment, per credential; it does not change what any plant emits. We found no public mechanism that caps, across declarants, how many tonnes one verified value may cover. The Commission receives every declaration and can review it after submission under the CBAM rules; CarbonLEI lets buyers outside the Registry add a cap they can check for themselves, before relying on the value. We do not quantify the ledger's effect, because we found no empirical rate of over-claiming (A4 in Section 4.1).

---

## 5. Taiwan exposure

| Fact | Value | Source |
|---|---|---|
| EU imports of CN 7318 from Taiwan, 2025 | about €1.22 billion and 371,270 t | [6] |
| Taiwan's share of extra-EU imports of CN 7318, 2025 | 18.6% by value, 20.3% by weight; second after China | [6] |
| Declarations that rest on a default or on a verifier's signature | If all 371,270 t were declared at the 2026 default: about 1.11 MtCO2e of declared embedded emissions (371,270 × 2.978). Each 1% of that tonnage declared on a verified value instead moves about 11,060 tCO2e of declaration (3,712.7 t × 2.978) from the default onto verifiers' signatures. These are declared amounts, not emissions avoided and not a gap; 2025 tonnes (transitional period) are a proxy for 2026, the 50 t de minimis threshold makes them an upper bound, and the default applies to Taiwan only, so it must not be multiplied by extra-EU tonnes | [1], [6] |
| Goods the same checks are designed for | The template importer maps direct emissions for the CN codes of Annex II of Regulation (EU) 2023/956 (iron and steel, aluminium, hydrogen; electricity left out, it is per MWh). EU imports of those codes in 2025: about 67.4 Mt from outside the EU, of which about 2.39 Mt from Taiwan. The demo runs on CN 7318 only; for the other codes the importer has parsed the Commission's filled examples, nothing more. Gross trade tonnes, an upper bound (the 50 t threshold and some customs procedures are not netted out); no default value is applied to them, so no tCO2e total is given. Reproduce with `npm run data:annex2` | [22] |
| Default value, CN 7318 from Taiwan | 2.707 tCO2e/t direct; 2.978 in 2026; about 3.25 in 2027; 3.519 from 2028 | [1] |
| Company identifier | The Commission's guidance lists LEI as an accepted operator identifier for operators from countries such as Taiwan | [10] |
| Verification capacity | 5 of 24 EU/EEA national accreditation bodies accepting non-EU verifier applications on 29 September 2026 | [2] |
| Firms affected in Taiwan | About 2,600 small and medium-sized enterprises, mainly makers of steel products and metal fasteners (Taiwan Ministry of Environment) | [8] |
| Taiwan's rank among CBAM source countries | 13th during the CBAM transitional period (2023–2025), as cited by Taiwan's Ministry of Environment from Commission data | [9] |
| Taiwan carbon fee | NT$300 per tCO2e (preferential rates NT$50 and NT$100), in force since 1 January 2025; applies to installations above 25,000 tCO2e per year, so most fastener SMEs pay none and have no carbon price to deduct under CBAM Article 9. The Commission's Article 9 implementing rules were still a draft in May 2026 | [13], [14] |

---

## 6. Limits of this estimate

- **Illustrative inputs.** 1.8 tCO2e/t and 500 t are demo values. They are not measurements of any real plant and not official CBAM methodology.
- **Declared gap is not a reduction.** Effects 1 and 2 change what is declared. Only effect 3 reduces emissions, and only if producers invest.
- **Causal chain for effect 3.** Where a verified value is checkable, a buyer can rely on it, so a lower verified intensity carries a value in CBAM terms; whether that value reaches the producer or leads to investment is a commercial matter we do not quantify, free allocation offsets much of it until about 2030 (Section 2a), and we project no emission reduction.
- **No empirical over-claiming rate.** A4 is a sensitivity parameter.
- **Incentive to switch steel.** The incentive to switch production routes is reduced by the free-allocation adjustment until 2034 (Section 2a). We found no public case of a fastener producer switching steel sources because of CBAM.
- **Price.** The € figures use the Q3 2026 certificate price. CBAM certificates are priced quarterly in 2026 and weekly from 2027 [7], so the € figures move with the price; the tCO2e figures do not.
- **Scope.** The default values used here are direct emissions only, as listed for CN 7318 [1]. A full product carbon footprint has a wider boundary (see [PACT_MAPPING.md](PACT_MAPPING.md#3-semantic-differences)).
- **Regulation changes.** Default values and mark-ups can be revised.
- **Linear model.** No rebound, leakage or market-share effects.
- **Dependence on verification quality.** CarbonLEI checks authority and single use on its ledger. It cannot make a wrong measurement right.

---

## Footprint of CarbonLEI

The contracts run on Ethereum Sepolia, a proof-of-stake testnet; Ethereum mainnet is also proof-of-stake. Sepolia has no official energy data, and its validators are a permissioned set run by client and testing teams [18]. We therefore use a published 2022 average for Ethereum mainnet as a proxy, not a measurement [15].

| Item | Value | Basis |
|---|---|---|
| Energy per transaction, average | 6.29 Wh | Ethereum mainnet, CCRI 2022 [15]. Mainnet reference value, not measured on Sepolia |
| Emissions per transaction, average | about 2.1 gCO2e | 6.29 Wh × about 334 gCO2e/kWh, the intensity implied by CCRI 2022 (869.78 tCO2e ÷ 2,600.86 MWh per year) [15] |
| Energy per transaction, marginal | about 0.32 Wh | Our estimate from CCRI 2023 parameters: 0.1055 W per transaction per second per node × 10,856 nodes [16] |
| Transactions per report | 1 registration transaction plus 1 per shipment | Contract design |
| Gas per operation | `registerReport` 368,616; `claimShipment` 155,449; `addVerifier` 163,521; `addAuditor` 75,119; deployment of `VerifierAllowlist` 1,305,144 and of `EmissionsClaimRegistry` 1,296,067; `revokeAuditor` 32,029; a reverted `registerReport` (attack 3) 41,315 | Sepolia transaction receipts of the current deployment, 5–6 October 2026 [21] |
| Transactions sent for the demo | 22 in total, 7,523,182 gas: 13 for the current deployment (2 contract deployments, adding the verification body and its auditor, registering the report, claiming one shipment, the auditor's revocation sync and the rejected report of attack 3, and for attack 4 one transfer of test ether, adding the impostor body and its auditor, the impostor's report and its suspension) and 9 for an earlier deployment of the same contracts (the same first 6 steps plus 3 transfers of test ether to the demo wallets) | `gasUsed` from the Sepolia receipts recorded in `fixtures/sepolia-tx.json`, `fixtures/archive/sepolia-v1-tx.json` and the deployment files, 5–6 October 2026. Transactions sent after 6 October 2026 are not included |
| Energy and emissions of those transactions, allocated | about 138 Wh and about 46 gCO2e (22 × 6.29 Wh; 22 × about 2.1 gCO2e) | Mainnet reference values applied to Sepolia transactions |
| For comparison: declared-emissions gap per tonne of screws, 2026 | about 1.18 tCO2e (illustrative) | Section 2 |

Per-transaction figures are an allocation, not a causal effect: "the energy required to propose and validate a block is independent of the number of transactions within it" [17]. The read-only checks of the hosted demo (contract calls and dry runs) send no transaction. The vLEI agents (KERIA) run locally or at the verification body. No token is issued. Verification runs no AI model: all eight checks (seven verification checks and one advisory reconciliation check) are deterministic code, and check 8, which reconciles the verification report with the credential, applies 12 fixed rules. There is no model inference to report.

---

## Sources

Accessed 2026-09-23 unless stated.

1. Commission Implementing Regulation (EU) 2025/2621, Annex I (Taiwan) and recitals, OJ 31 December 2025; Annex I replaced in full by Implementing Regulation (EU) 2026/1740, OJ 31 July 2026 (CN 7318 values unchanged; mark-up rule in the opening paragraph of 1740 Annex I; marked-up values computed by the CBAM Registry). https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32025R2621 ; https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202601740
2. European Commission, "CBAM verification" page and "State-of-play CBAM accreditation", 29 September 2026, accessed 2026-10-07. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en ; https://taxation-customs.ec.europa.eu/document/download/a782dacf-ab68-44cc-986c-28fd1b4daa94_en
3. European Fastener Distributor Association (EFDA), press release, 9 March 2026. http://www.efda-fastenerdistributors.org/content/files/EFDA%20PRESS%20RELEASE_260309%281%29.pdf
4. German Environment Agency (UBA), press release No. 36/2024, 6 September 2024. https://www.umweltbundesamt.de/en/press/pressinformation/uba-refuses-to-approve-certificates-for-eight-uer
5. Commission Implementing Regulation (EU) 2025/2546, Annex (template of the verification report), point 2.6(h). https://eur-lex.europa.eu/eli/reg_impl/2025/2546/oj
6. Eurostat Comext DS-045409, CN 7318, reporter EU, partners TW and extra-EU, 2025 (dataset updated 15 September 2026); shares computed by the team. https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409?format=JSON&freq=A&reporter=EU&partner=TW&product=7318&flow=1&time=2025 ; extra-EU: https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409?format=JSON&freq=A&reporter=EU&partner=EXT_EU&product=7318&flow=1&time=2025 (accessed 2026-10-07)
7. European Commission, "Price of CBAM certificates" (Q1 2026: €75.36, published 7 April 2026; Q2 2026: €75.28, published 6 July 2026; Q3 2026: €82.32, published 5 October 2026), accessed 2026-10-05. https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/price-cbam-certificates_en
8. Taiwan Ministry of Environment, press meeting, 2 April 2026. https://www.moenv.gov.tw/policies-and-laws/meetings/35593.html
9. Taiwan Ministry of Environment, press release, 1 March 2026. https://enews.moenv.gov.tw/page/3b3c62c78849f32f/29e658c3-eba2-4087-a3bd-c9808640fc67
10. European Commission, "Guidance on access request procedure – for CBAM operators, non-EU companies", v3.00, 26 January 2026, pp. 10 and 19. https://taxation-customs.ec.europa.eu/document/download/9361fade-6f19-4799-b2ef-f6a4ff681af2_en
11. Commission Implementing Regulation (EU) 2025/2620, Articles 2 and 3 and Annex, points 3.3, 4 and 5 (free-allocation benchmarks and precursors), accessed 2026-09-24. http://data.europa.eu/eli/reg_impl/2025/2620/oj
12. European Commission, CBAM Guidance Document No. 4 (free allocation adjustment), 14 August 2026, accessed 2026-09-24. https://taxation-customs.ec.europa.eu/document/download/3aa2c730-4f1b-4524-8f71-d9cfe4880ac7_en
13. Taiwan Ministry of Environment, carbon fee rates and Carbon Fee Collection Regulations (Article 3), in force since 1 January 2025, accessed 2026-09-24. https://oaout.moenv.gov.tw/law/LawContent.aspx?id=GL007921 ; https://oaout.moenv.gov.tw/law/LawContent.aspx?id=GL007914
14. European Commission, "Carbon price paid in third countries", news, 13 May 2026. https://taxation-customs.ec.europa.eu/news/carbon-price-paid-third-countries-2026-05-13_en
15. Crypto Carbon Ratings Institute (CCRI), report on the electricity consumption and carbon footprint of Ethereum after the switch to proof-of-stake, September 2022, accessed 2026-09-24. https://carbon-ratings.com/dl/eth-report-2022
16. Crypto Carbon Ratings Institute (CCRI), report on proof-of-stake networks, October 2023, accessed 2026-09-24. https://carbon-ratings.com/dl/pos-report-2023
17. ethereum.org, "Ethereum energy consumption", updated 28 July 2026, accessed 2026-09-24. https://ethereum.org/en/energy-consumption/
18. ethereum.org, "Networks" (developer documentation, Sepolia), accessed 2026-09-24. https://ethereum.org/en/developers/docs/networks/
19. Commission Implementing Regulation (EU) 2025/2547, Article 1(5) (definition of the reporting period as a calendar year) and Article 7(1) ("Where a good was imported during the year 2026, the reporting period shall be the year 2026"), accessed 2026-10-05. https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=OJ:L_202502547
20. Regulation (EU) 2023/956, Article 6(1), as amended by Regulation (EU) 2025/2083 (annual CBAM declaration by 30 September, for the first time in 2027 for the year 2026), accessed 2026-10-05. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R2083
21. Sepolia transactions of the demo, 5 October 2026: report registration https://sepolia.etherscan.io/tx/0x5cba53bb5a438883252721407dba8e58962ef71f1f91493c266a4ae561981de2 ; shipment claim https://sepolia.etherscan.io/tx/0x2f873bd582ac399f83fcea28ffb048100d4d002f9a03e43b61e46991ae288484 ; contracts `EmissionsClaimRegistry` https://sepolia.etherscan.io/address/0xEA52a50d3753bACD835DCd47892754b65a90ca19 and `VerifierAllowlist` https://sepolia.etherscan.io/address/0xF7AD0cbe867eb9CE4847Af3717C2d27f6434Ea5C
22. Eurostat Comext DS-045409, reporter EU, partners extra-EU and TW, imports, 2025 (dataset updated 15 September 2026), product codes from `DIRECT_ONLY_CN_PREFIXES` minus `ANNEX_II_EXCEPT` in [sdk/template.ts](../sdk/template.ts), accessed 2026-10-08; totals computed by `scripts/eurostat-annex2.ts`. https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409
23. Regulation (EU) 2023/956, Article 1(1) (not amended by Regulation (EU) 2025/2083), Article 8 (verification of declared embedded emissions), Article 19 (review of CBAM declarations), and Articles 7(2) and 22(1) as replaced by Regulation (EU) 2025/2083, Article 1, points (6) and (18), accessed 2026-10-09. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R0956 ; https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R2083
