# Judging criteria and where the evidence is

Two sets of criteria apply: the five on the Devpost page, and the weighted criteria and deliverables on the organiser's hackathon page (read 2026-10-07). Each row links to the evidence in this repository. Where we have nothing to show, we say so.

## Devpost criteria

| Criterion | Evidence |
|---|---|
| Climate Impact | Declared-emissions gap per tonne and per report against the CBAM default, not a physical reduction: [CLIMATE_IMPACT — Summary](CLIMATE_IMPACT.md#summary); scenarios for 10 / 100 / 1,000 installations: [CLIMATE_IMPACT §4](CLIMATE_IMPACT.md#4-scenario-projections-10--100--1000-installations); our own footprint: [Footprint of CarbonLEI](CLIMATE_IMPACT.md#footprint-of-carbonlei) |
| Innovation & Creativity | vLEI role authority plus a tonnage ledger shared across importers: [README — Related work](../README.md#related-work-and-what-is-new); comparison with six existing channels: [PROBLEM_STATEMENT — How existing channels compare](PROBLEM_STATEMENT.md#how-existing-channels-compare) |
| Technical Execution | Source-verified contracts and Sepolia transactions: [README — On-chain proof](../README.md#on-chain-proof); tests, coverage, gas: [README — Measurements](../README.md#measurements); verification pipeline: [ARCHITECTURE §5.3](ARCHITECTURE.md#53-verification-pipeline-sdkverifyts) |
| Practical Usefulness | Users and the decision each makes: [README — Who uses CarbonLEI](../README.md#who-uses-carbonlei); relation to the CBAM Registry: [ADOPTION §1.1](ADOPTION.md#11-relationship-to-the-cbam-registry); pilot plan (no partner contacted): [PILOT](PILOT.md) |
| Presentation & Communication | Live page, no wallet: [README — Hosted](../README.md#hosted-for-reviewers-no-installation); [Problem statement](PROBLEM_STATEMENT.md); [FAQ](FAQ.md); video: submitted on Devpost, not linked from this repository |

## Organiser's weighted criteria

The organiser's page gives these weights. It also gives a second split (70% technical innovation and blockchain implementation, 20% climate impact, 10% scalability); we list the evidence once.

| Criterion | Weight | Evidence |
|---|---|---|
| Climate Impact & Environmental Benefit | 30% | As Climate Impact above |
| Technical Innovation & Blockchain Implementation | 30% | [ARCHITECTURE §1.1 — Why a blockchain](ARCHITECTURE.md#11-why-a-blockchain-four-questions); [README — On-chain proof](../README.md#on-chain-proof) |
| Feasibility & Implementation Quality | 10% | [README — Current status vs roadmap](../README.md#current-status-vs-roadmap); [ADOPTION §8](ADOPTION.md#8-current-status-by-area) |
| Data Security & Transparency | 10% | [SECURITY — Threat model](SECURITY.md#4-threat-model); [SECURITY — Privacy of on-chain data](SECURITY.md#7-privacy-of-on-chain-data) |
| User Experience & Design | 10% | [README — Hosted](../README.md#hosted-for-reviewers-no-installation); scripted task timing below |
| Scalability & Sustainability | 10% | [ADOPTION §6 — Scalability roadmap](ADOPTION.md#6-scalability-roadmap); [Footprint of CarbonLEI](CLIMATE_IMPACT.md#footprint-of-carbonlei) |

## Organiser's deliverables

| Deliverable | Where |
|---|---|
| Working prototype on a test network | [Live demo](https://zuemen.github.io/carbon-lei/); [README — On-chain proof](../README.md#on-chain-proof) |
| Source code with documentation | This repository; [README — Quick start](../README.md#quick-start) |
| Architecture diagram and technical specification | [README — Architecture](../README.md#architecture); [ARCHITECTURE](ARCHITECTURE.md) |
| 3-minute video | Submitted on Devpost; not linked from this repository |
| Security and data integrity assessment | [SECURITY](SECURITY.md) |
| Problem statement and solution overview (max 2 pages) | [PROBLEM_STATEMENT](PROBLEM_STATEMENT.md) |
| Climate impact assessment and carbon reduction projections | We do not project reductions; we report a declared-emissions gap: [CLIMATE_IMPACT](CLIMATE_IMPACT.md) |
| Implementation and adoption strategy | [ADOPTION — Adoption path](ADOPTION.md#5-adoption-path) |
| Scalability and sustainability roadmap | [ADOPTION — Scalability roadmap](ADOPTION.md#6-scalability-roadmap) |
| User testing results (if applicable) | No user testing was done; no partner was contacted. A scripted timing is below |

## Scripted task timing (not user testing)

**Open the page → Load → Verify → "8 of 8 checks passed": 2 clicks, median 3.0 s (n = 5, range 2.5–4.2 s).** A second session of n = 5 on the same day gave median 3.1 s (3.0–4.0 s); an earlier one gave median 10.6 s (6.0–11.6 s). We did not isolate the cause of the spread; checks 4 and 5 read live from public Sepolia endpoints.

Method: `node scripts/time-task.mjs` ([script](../scripts/time-task.mjs)), Playwright 1.63 with headless Chromium, a fresh browser context per run, against https://zuemen.github.io/carbon-lei/ on 2026-10-06 between 16:49 and 16:55 UTC, from one macOS laptop. The timer starts before page navigation and stops when "8 of 8" is visible. The script clicks as soon as each button is ready and reads nothing, so the time is a lower bound for a person; it says nothing about whether a person understands the result.
