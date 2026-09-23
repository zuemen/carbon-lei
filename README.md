# CarbonLEI

**vLEI-verified embedded-emissions credentials for CBAM supply chains.**

> 🚧 Under development for the **IEEE ClimateChain Global Hackathon 2026** — Track 3: Sustainable Supply Chains.
> See [HACKATHON.md](HACKATHON.md) for scope, deadlines and rules.

## Problem
Under the EU Carbon Border Adjustment Mechanism (CBAM), importers must report the embedded emissions of goods such as
iron and steel products, and those figures must be verified. Today a buyer cannot easily answer three questions:

1. **Which company** actually produced the goods and owns the emissions data?
2. **Which accredited verifier** signed the number — and was the signer authorized to sign for that verifier?
3. **Has the claim been revoked, or already used** for another shipment (double claiming)?

Suppliers also do not want to hand over process data, energy bills or costs just to prove a number.

## Approach
| Layer | What it does |
|---|---|
| **GLEIF vLEI** | Legal Entity vLEIs for supplier and verifier; an Engagement Context Role (ECR) credential proves the auditor may sign for the verifier |
| **Emissions credential** | The verifier issues a selectively-disclosable credential to the supplier (product, batch, tCO₂e per tonne, method, validity) |
| **On-chain registry** | Credential hash, shipment batch and revocation status are anchored on-chain, so a batch cannot be claimed twice |
| **Verifier view** | The EU importer sees only the disclosed fields plus the validity of the vLEI chain — not the supplier's trade secrets |
| **AI consistency check** *(stretch)* | Flags inconsistencies between the claimed figure and uploaded activity data (greenwashing signals) |

vLEI chains (KERI / ACDC) are verified **off-chain**; only hashes and status are written on-chain.

## Demo scenario
A fictional Taiwanese fastener manufacturer ships a batch of steel screws to a fictional EU importer.
A fictional accredited verifier signs the batch's embedded emissions. The demo then shows three failures:
a credential signed by a verifier without a valid vLEI chain, a second claim on the same batch, and a revoked credential.

*All companies and figures in the demo are fictional and illustrative; they do not follow the official CBAM calculation methodology.*

## AI usage disclosure
Parts of this project are developed with AI coding assistants (Claude). All code is reviewed and owned by the team.

## License
MIT — see [LICENSE](LICENSE).
