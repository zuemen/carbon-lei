# Judging criteria and where the evidence is

One-page judge brief (PDF): [docs/judge-brief.pdf](judge-brief.pdf)

Two sets of criteria apply: the five on the [Devpost page](https://ieee-climatechain-hack.devpost.com/), and the weighted criteria and deliverables on the [organiser's hackathon page](https://cmte.ieee.org/turkiye-blockchain/hackatlon/) (IEEE Blockchain Türkiye; both read 2026-10-07). Each row links to the evidence in this repository. Where we have nothing to show, we say so.

## Five-minute path for reviewers

One pass through the live demo, the product passport QR code and the terminal, with what you should see at each step. All companies, people and LEIs are fictional, emissions values are illustrative and the vLEI root is simulated. How long each step took us: [Our walk-through](#our-walk-through-not-user-testing).

| Step | Time | Do this | You should see |
|---|---|---|---|
| 1 | 0:00–1:00 | Open the [live demo](https://zuemen.github.io/carbon-lei/) (read-only, no wallet). It opens on the **Buyer** tab. Press **Load the demo proof**, then **Verify**. | "✓ 8 of 8 checks passed · declared-emissions gap for this 200 t shipment: 235.6 tCO2e (gross, illustrative)". Checks 4 and 5 are labelled "live · Sepolia", check 7 "exported evidence" and check 8 "rule-based · advisory". |
| 2 | 1:00–1:45 | Open the **Supplier** tab and scroll to the product passport card. On a phone, scan the QR code ("Scan to verify"); on a desktop, click **Open the same link here** under it. Press **Verify**. | The Buyer tab with the proof loaded and not yet checked ("Shipment BATCH-DEMO-2026-0001 · 200 t", "what the proof states, not yet checked"); on a phone, or in a fresh tab, the page also says "Proof loaded from the product passport QR code (BATCH-DEMO-2026-0001). Press Verify." After Verify: "8 of 8 checks passed" again. The QR code holds `https://zuemen.github.io/carbon-lei/#buyer?said=ELXG3ZjKZ5rsmJ8WljbM2vW2PJL9FesRnlVgh0hVTZvx&batch=BATCH-DEMO-2026-0001`. |
| 3 | 1:45–3:00 | Open **Try to break it** (on a phone the tab reads "Break it"). On card 1, press **Change one disclosed number**. On card 4, press **Verify the impostor's proof**. | Card 1: "REJECTED" and "Check 2 failed: A disclosed value was changed after the supplier created the proof." Card 4: "REJECTED" and "Check 7 failed: QVI credential not issued by the configured root of trust", then a timeline: "ACCEPTED ON-CHAIN" (the allowlist said yes), "REJECTED BY CHECK 7", "SUSPENDED". The contract said yes; the credential said no. |
| 4 | 3:00–3:30 | On the same tab, open two Etherscan links: card 3's "view on explorer ↗" and card 4's "registration, status 1 ↗". | Attack 3, [0xa8b6b8a8…fc5](https://sepolia.etherscan.io/tx/0xa8b6b8a8ba067de0ffda301688d64ff6c8c7662563930881c7fecc82e1e65fc5): Status "Fail with Custom Error 'AuditorNotAuthorized …'", block 11854366. Attack 4, [0x295abe6c…013](https://sepolia.etherscan.io/tx/0x295abe6cb63e3df44e942b07397ba926dcff815a6e1e2e05870f21d0dc3d0013): Status "Success", block 11849378. Etherscan may first show a bot check. |
| 5 | 3:30–4:30 | In a terminal with Node.js 22.18 or later (no Docker, wallet or key): `git clone https://github.com/zuemen/carbon-lei`, `cd carbon-lei`, `npm ci`, then the three commands `npm run verify:demo`, `npm run verify:tampered` and `npm run audit:onchain`. | `verify:demo`: nine lines from "PASS  0 Structure" to "PASS  8 Report reconciliation", then "VALID; 5 field(s) hidden by supplier". `verify:tampered`: "FAIL  2 Disclosed fields  [DISCLOSURE_TAMPERED]", then "INVALID as expected: check 2 failed with DISCLOSURE_TAMPERED (exit 0 because of --expect-invalid)". `audit:onchain`: one "OK" line per transaction and contract, then "12 of 12 transactions, 2 of 2 contracts match". Each command exits 0. |
| 6 | 4:30–5:00 | Read the [SECURITY summary](SECURITY.md#summary) and the [residual risk summary](SECURITY.md#11-residual-risk-summary). | One table of threat categories with their status (fixed, mitigated, or a design limit that needs a redeployment) and the section with the details; then each remaining risk with its level, the highest being the physical origin of goods within the verified tonnage (High). |

### Our walk-through (not user testing)

On 2026-10-07 we followed steps 1–5 with a Playwright script against the live page and a fresh clone of commit `631998c`, from one macOS laptop, and checked each "You should see" text above against what appeared. Every step matched. Machine time per step: 1, 3.1 s; 2, 4.3 s on a desktop and 3.2 s on a phone (iPhone 13 emulation in Chromium; the QR code was decoded in the browser and holds the link above); 3, 4.1 s; 4, 3.8 s (Etherscan shows a bot check to headless browsers, so this step ran in a visible Chrome window); 5, 14.2 s (clone 1.6 s, `npm ci` 3.1 s with the npm cache in place and 4.2 s with an empty cache in a separate run, `verify:demo` 2.7 s, `verify:tampered` 2.1 s, `audit:onchain` 4.7 s). Step 6 was checked against this repository's files. The script clicks as soon as a button is ready and reads nothing, so a person needs longer; the time budget above allows for reading.

## Devpost criteria

| Criterion | Evidence |
|---|---|
| Climate Impact | How checkable verified data carries CBAM's incentive to reduce emissions, with limits: [CLIMATE_IMPACT — How it connects to climate outcomes](CLIMATE_IMPACT.md#how-it-connects-to-climate-outcomes); declared-emissions gap per tonne and per report against the CBAM default, not a physical reduction: [CLIMATE_IMPACT — Summary](CLIMATE_IMPACT.md#summary); scenarios for 10 / 100 / 1,000 installations: [CLIMATE_IMPACT §4](CLIMATE_IMPACT.md#4-scenario-projections-10--100--1000-installations); our own footprint: [Footprint of CarbonLEI](CLIMATE_IMPACT.md#footprint-of-carbonlei) |
| Innovation & Creativity | vLEI role authority plus a tonnage ledger shared across importers: [README — Related work](../README.md#related-work-and-what-is-new); comparison with six existing channels: [PROBLEM_STATEMENT — How existing channels compare](PROBLEM_STATEMENT.md#how-existing-channels-compare) |
| Technical Execution | Source-verified contracts and Sepolia transactions: [README — On-chain proof](../README.md#on-chain-proof); tests, coverage, gas: [README — Measurements](../README.md#measurements); verification pipeline: [ARCHITECTURE §5.3](ARCHITECTURE.md#53-verification-pipeline-sdkverifyts); bounded symbolic checks (Halmos) of P1, P2, P3 and P6: [SECURITY §9.2](SECURITY.md#92-symbolic-and-bounded-checking) |
| Practical Usefulness | Users and the decision each makes: [README — Who uses CarbonLEI](../README.md#who-uses-carbonlei); relation to the CBAM Registry: [ADOPTION §1.1](ADOPTION.md#11-relationship-to-the-cbam-registry); pilot plan (no partner contacted): [PILOT](PILOT.md) |
| Presentation & Communication | Live page, no wallet: [README — Hosted](../README.md#hosted-for-reviewers-no-installation); [Problem statement](PROBLEM_STATEMENT.md); [FAQ](FAQ.md); video: embedded on the Devpost submission page |

## Organiser's weighted criteria

The organiser's page gives these weights under "Evaluation Criteria (Weighted)". The same page also lists "Submission Categories" (70% technical innovation and blockchain implementation, 20% climate impact, 10% scalability) under its submission requirements; that list is not labelled as a scoring weight, so we map the evidence to the weighted criteria only.

| Criterion | Weight | Evidence |
|---|---|---|
| Climate Impact & Environmental Benefit | 30% | As Climate Impact above |
| Technical Innovation & Blockchain Implementation | 30% | [ARCHITECTURE §1.1 — Why a blockchain](ARCHITECTURE.md#11-why-a-blockchain-four-questions); [README — On-chain proof](../README.md#on-chain-proof) |
| Feasibility & Implementation Quality | 10% | [README — Current status vs roadmap](../README.md#current-status-vs-roadmap); [ADOPTION §8](ADOPTION.md#8-current-status-by-area) |
| Data Security & Transparency | 10% | [SECURITY — Threat model](SECURITY.md#4-threat-model); [SECURITY — Privacy of on-chain data](SECURITY.md#7-privacy-of-on-chain-data); [SECURITY — Security properties P1–P6](SECURITY.md#9-security-properties), with bounded symbolic checks of P1, P2, P3 and P6 in [§9.2](SECURITY.md#92-symbolic-and-bounded-checking) (fixed call sequences, not all sequences) |
| User Experience & Design | 10% | [README — Hosted](../README.md#hosted-for-reviewers-no-installation); scripted task timing below |
| Scalability & Sustainability | 10% | [ADOPTION §6 — Scalability roadmap](ADOPTION.md#6-scalability-roadmap); [Footprint of CarbonLEI](CLIMATE_IMPACT.md#footprint-of-carbonlei) |

## Organiser's deliverables

| Deliverable | Where |
|---|---|
| Working prototype on a test network | [Live demo](https://zuemen.github.io/carbon-lei/); [README — On-chain proof](../README.md#on-chain-proof) |
| Source code with documentation | This repository; [README — Quick start](../README.md#quick-start) |
| Architecture diagram and technical specification | [README — Architecture](../README.md#architecture); [ARCHITECTURE](ARCHITECTURE.md) |
| Video (Devpost: 3–5 minutes; organiser's page: 3 minutes) | Embedded on the Devpost submission page (deadline 25 October 2026); the YouTube link is added here once it is public |
| Security and data integrity assessment | [SECURITY](SECURITY.md) |
| Problem statement and solution overview (max 2 pages) | [PROBLEM_STATEMENT](PROBLEM_STATEMENT.md) |
| Climate impact assessment and carbon reduction projections | We do not project reductions; we report a declared-emissions gap: [CLIMATE_IMPACT](CLIMATE_IMPACT.md) |
| Implementation and adoption strategy | [ADOPTION — Adoption path](ADOPTION.md#5-adoption-path) |
| Scalability and sustainability roadmap | [ADOPTION — Scalability roadmap](ADOPTION.md#6-scalability-roadmap) |
| User testing results (if applicable) | No user testing was done; no partner was contacted. A scripted timing is below |

## Scripted task timing (not user testing)

**Open the page → Load → Verify → "8 of 8 checks passed": 2 clicks; median 3.0 s (2.5–4.2 s) and 3.1 s (3.0–4.0 s) in two sessions of n = 5 with `scripts/time-task.mjs`.** An earlier session the same day, the first of the three and run with a draft of the script, gave a median of 10.6 s (6.0–11.6 s). Every run's time: [`data/task-timing-2026-10-07.json`](data/task-timing-2026-10-07.json). We did not isolate the cause of the spread (a cold browser, CDN or RPC cache is possible but was not tested); checks 4 and 5 read live from public Sepolia endpoints.

Method: `node scripts/time-task.mjs` ([script](../scripts/time-task.mjs)) for sessions 2 and 3, and an earlier draft of it with the same steps and stop condition for session 1; Playwright 1.63 with headless Chromium, a fresh browser context per run, against https://zuemen.github.io/carbon-lei/ on 2026-10-06 between 16:48 and 16:55 UTC, from one macOS laptop. The timer starts before page navigation and stops when "8 of 8" is visible. The script clicks as soon as each button is ready and reads nothing, so the time is a lower bound for a person; it says nothing about whether a person understands the result.
