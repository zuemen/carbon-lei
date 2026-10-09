# CarbonLEI — hackathon facts

This repository is an entry to the **IEEE ClimateChain Global Hackathon 2026**, track **Sustainable Supply Chains**.
The repository was created on 2026-09-23 with documentation only. Work on the code started on 2026-10-05, about one
hour before the submission period opened (04:00 UTC); every code commit was made after it opened, as the commit history
shows. The rules do not restrict when work starts; we state it so the history reads as it happened.

| Item | Value |
|---|---|
| Hackathon | [IEEE ClimateChain Global Hackathon](https://ieee-climatechain-hack.devpost.com/) (IEEE Blockchain Technical Community, IEEE iGET) |
| Track | Sustainable Supply Chains |
| Submission period | 2026-10-05 04:00 UTC to 2026-10-25 14:00 UTC (online) |
| Judging | 2026-10-26 06:00 UTC to 2026-11-08 14:00 UTC |
| Winners announced | 2026-11-20 06:00 UTC |

## What the hackathon asks for
- Track alignment and how the project addresses the track's challenge
- Project description: problem, solution, target users, scalability, ease of adoption
- Demo video, 3–5 minutes
- Public code repository with source code and documentation
- A working prototype or proof of concept

Judging criteria: Climate Impact · Innovation & Creativity · Technical Execution · Practical Usefulness · Presentation & Communication.

## Ground rules we follow
- Code is written from scratch for this entry; no code is copied from other projects.
- All companies, people and LEIs in the demo are fictional (LEIs use the `ZZZZ` prefix, which no LEI issuer assigns).
- Emissions values are illustrative — not official CBAM methodology.
- Contracts are deployed to the Sepolia testnet only. Keys come from environment variables; `.env` is git-ignored.

## AI usage disclosure
During development we used Claude (Anthropic) as a coding and writing assistant under the team's direction: it drafted contract and SDK code, tests, documentation and the submission text, and ran our adversarial review of the verifier. Each change was run through the test suite and our pre-push checks before it was pushed, and CI reruns the contract and SDK tests on GitHub; the team set the scope and the rules the text must follow. The video narration is a synthetic voice (Microsoft Edge TTS). None of the eight checks in the product uses AI.

Two commit messages, `f1b1f29` ("after an external review") and `9b747f8` ("an outside review found"), refer to our own AI-run reviews, not to an outside party; no outside party has reviewed this project. We left the history as it is rather than rewrite it.
