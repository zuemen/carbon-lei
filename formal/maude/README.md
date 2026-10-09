# Protocol model in Maude

A rewriting-logic model of the CarbonLEI protocol, checked with Maude's breadth-first `search` and its LTL model checker on small instances. This is a **bounded model check of an abstract model**: it explores every reachable state of the instances below, under the abstractions below. It is not a proof that the protocol or the code is secure, and the model is not generated from the code: the correspondence in [Model and code](#model-and-code) was written by hand. Summary in [SECURITY.md §9.3](../../docs/SECURITY.md#93-protocol-model-maude).

| File | Content |
|---|---|
| `carbonlei.maude` | The model (module `CARBONLEI`), the properties as state predicates, the instances, the mutants, and the LTL propositions (module `CARBONLEI-LTL`) |
| `checks.maude` | 50 commands with their expected outcome, under 2 minutes |
| `checks-full.maude` | One larger instance (122,823 states, about 4.5 minutes, about 310 MB) |
| `run.sh` | Runs each command in its own Maude process under a memory watchdog and compares each result with its expectation |
| [`docs/data/maude-2026-10-10.txt`](../../docs/data/maude-2026-10-10.txt) | Full output of both files for the current model ([`maude-2026-10-09.txt`](../../docs/data/maude-2026-10-09.txt): the first version, nine properties and 10 mutant runs) |

## Running it

Maude 3.5.1 from the [official release](https://github.com/maude-lang/Maude/releases/tag/Maude3.5.1). For macOS on Apple silicon, `Maude-3.5.1-macos-arm64.zip`, whose SHA-256 is `95851274f57b3853aab833674e2b770ed800f38fb1f3d03c97dcac56346c13dc` (the digest GitHub lists for the asset); for Linux, `Maude-3.5.1-linux-x86_64.zip`, `72ed1ca87e3b3d0dfc6ee1436baf154bf04c45ff97d521bec040c5e8dfc8f92c`. Unzip it anywhere; it needs no installation.

```bash
MAUDE=/path/to/maude npm run formal:maude              # checks.maude
MAUDE=/path/to/maude npm run formal:maude:full         # checks-full.maude
MAUDE=/path/to/maude npm run formal:maude -- revInst   # only the lines containing "revInst"
```

CI (job `maude` in `.github/workflows/ci.yml`) downloads the Linux release, checks its SHA-256 and runs `checks.maude` on every push (the 32 commands of the first version took about 90 s there, with the same state counts as on macOS; the 50 commands now take 102 s on the development machine).

`run.sh` exits non-zero if any result differs from the expectation written on its line, or if the watchdog stops Maude: it kills Maude above 3 GB of resident memory (`MAUDE_MAX_RSS_MB`), and on macOS also when the system-wide free memory reported by `memory_pressure` is below 15 % (`MAUDE_MIN_FREE_PCT`) while Maude holds more than 256 MB (`MAUDE_FREE_CHECK_MIN_RSS_MB`). Only one Maude process runs at a time.

## What is modelled

The state is a multiset of facts. Time is a tick counter from 0 to a bound; `delta` is the CONTESTED window of check 4 and also the watcher's sync bound of assumption A-Watch (SECURITY §9), both in ticks (one tick stands for 24 hours, the default `contestedWindowHours`).

| Actor | Actions (rules) | Notes |
|---|---|---|
| Verification body | `register-new`: registers a credential it signed into an empty ledger slot, under the slot label it chooses; `register-revise`: registers a revision of the slot's latest credential | The contract's guard is applied at the current tick: the body active (`isVerifierActiveAt`: accreditation not expired, not suspended or suspension lifted), the auditor listed under it and not revoked on the allowlist (`isAuthorizedAt`), and for a revision: by another body only while the original body is inactive (`NotReportIssuer`), and the new `verifiedKg` covers the claimed quantity (`SupersedeOverClaimed`) |
| Auditor | — | Its credential's anchor is assumed valid (check 6 passes). A departed auditor keeps its KERI keys, so a credential it anchors after its ECR revocation is as well formed as any other (T2) |
| Body, in KERI | `keri-revoke`: revokes the auditor's ECR (the auditor leaves) | The off-chain truth, recorded with its time |
| Watcher | `watcher-sync`: `revokeAuditor` for a pending KERI revocation; `suspend`, `lift` (sent by hand with the watcher key) | Three modes: `up` (syncs within `delta` of the KERI event: time cannot pass a pending revocation's deadline), `late` (syncs at any later time, or never), `down` (never syncs) |
| Allowlist owner | — | The allowlist is fixed at tick 0. Attack 4 is modelled by listing an impostor body whose vLEI chain is under another root, as a stolen owner key can (T10) |
| Supplier | `claim`: claims a batch against a slot's latest credential, declared to either importer | The contract's cap: `claimedKg + q ≤ verifiedKg` of the slot's latest credential |
| Importer (verifier) | Verifies any proof at any time | Not a rule: every reached state is closed under acceptance (below) |
| Attacker | Re-uses any genuine object | Presents a claimed batch attached to any credential, to any importer (replay to another importer), stating the claimed quantity or one tonne more (over-claim); leaves revocations out of the evidence; registers a credential under another slot label (T19 (8)); registers with a revoked or departed auditor; times its registration against revocations and suspensions; acts through the impostor body. It cannot forge a signature, a SAID or a KEL anchor, and holds no key other than the impostor's |

**Acceptance.** An importer may verify any proof at any reached state. Rather than branching on every verification, an equation closes each state under acceptance: every proof that the verifier would accept there (VALID or CONTESTED) is recorded with its batch. The recorded set is therefore exactly "accepted by some importer at some reached state", so properties about tonnes accepted across importers can be stated as state invariants.

**The verdict** follows `sdk/verify.ts`, restricted to what the model represents:

- check 4: registered; the slot label it was registered under is its true slot (4j, `SCOPE_MISMATCH`); not superseded at `t`, where `t` is the claim time for the importer the batch was declared to and the latest block otherwise, with the same-block exception (4d); CONTESTED when the auditor's on-chain revocation or the body's suspension falls in `[registeredAt, registeredAt + delta]` (4l);
- check 5: the batch was claimed against this credential, for this importer, with this quantity;
- check 7: the body's chain is under the pinned root; the allowlist's `revokedAt` is not before `registeredAt`; `registeredAt` is not after `accreditedUntil`; and, when the supplier includes it, an anchored ECR revocation in the evidence dated before `registeredAt` fails;
- overall INVALID if any check fails, else CONTESTED if 4l flagged it, else VALID. A proof without a batch skips check 5 and is judged at the latest block.

## Model and code

| Model | Code |
|---|---|
| `activeNow`, `audAuthNow` in the registration rules (the guards) | `VerifierAllowlist.isVerifierActiveAt`, `isAuthorizedAt`, called from `EmissionsClaimRegistry._checkCommon` |
| slot `(label, latest, claimedKg)` | `credScopes[reportScopeKey][credScopeKey]` (`latestReportKey`, `claimedKg`); the two keys are one label |
| `register-new` / `register-revise` | `registerReport` branches (a) and (b); `_checkRevision` (`SupersedeMismatch`, `SupersedeOverClaimed`, `NotReportIssuer`) |
| `claim` | `claimShipment` (`ExceedsVerifiedTonnage`; only the latest credential of a slot is claimable, as `isValidAt` makes a superseded one) |
| `keri-revoke`, `watcher-sync` | the body's TEL revocation of the ECR; `verifier/src/watch.ts` and `revokeAuditor` |
| `suspend`, `lift` | `suspendVerifier`, `liftSuspension` |
| `check4fail`, `contested` | `sdk/verify.ts` check 4: 4d, 4j, 4l (`contestedWindowHours`) |
| `check5fail` | `sdk/verify.ts` check 5 (`shipmentStatus`: report, quantity, `importerCommit`) |
| `check7fail` | `sdk/vlei.ts` `verifyAuthority`: pinned root, allowlist `auditorRevokedAt < registeredAt`, `accreditedUntil`, `anchoredRevocation` with `dt < registeredAt` |
| `s…` functions, ghosts `gReg`, `gRev` and the flags of `reg` | Not code: the specification side. The properties are written with these helpers only (below) |

### Contract guards and the properties that cover them

Every guard of `registerReport` and `claimShipment` (and `revokeReport`, which the model leaves out), whether the model applies it, which property fails without it, and the mutant that removes it. "—" means no property: the guard is not modelled, or the model applies it but nothing checks it.

| Guard (error) | In the model | Property that fails without it | Mutant |
|---|---|---|---|
| `NotActiveVerifier`: body suspended and not lifted | `activeNow` | `regInactiveBad`, `authBad` | `noSuspGuard` |
| `NotActiveVerifier`: accreditation expired | `activeNow` | `regInactiveBad` (the verifier's check 7 also rejects it, so `authBad` does not fail) | `noExpiryGuard` |
| `NotActiveVerifier`: address not bound or rotated away | not modelled (address rotation) | — | — |
| `AuditorNotAuthorized`: auditor revoked on the allowlist | `audAuthNow` | `regAfterRevBad` (check 7 also rejects it, so `authBad` does not fail) | `noAuthGuard` |
| `AuditorNotAuthorized`: auditor not listed under the body | `aud(A, B)` | — (every credential names its own body's auditor, so the instances never exercise it) | — |
| `ReportExists` | `not isReg(R, S)` | — (each credential has one path to registration in the instances) | — |
| `ZeroQuantity`, `InvalidExpiry`, `InvalidInput` | not modelled (`verifiedKg` ≥ 1, no `validUntil`, no zero keys) | — | — |
| `ReportIdRetired`, `PeriodAlreadyCovered`, report-layer `NotReportIssuer` | not modelled (one slot per product, no report layer) | — | — |
| `ReportNotFound` (`supersedes`), `SupersedeMismatch` | structural: `register-revise` matches the slot's latest credential | — | — |
| `CredScopeAlreadyCovered` (branch a) | `not hasSlot(L, S)` | `ledgerBad` | `noCovered` |
| `NotReportIssuer` in `_checkIssuerOrInactive` (branch b): another body only while the issuer is suspended or past its accreditation | last condition of `register-revise` | `foreignReviseBad` | `noIssuerGuard` |
| `SupersedeOverClaimed` (branch b) | `V >= C` in `register-revise` | `p1Bad` | `noOverClaimed` |
| Branch (c), takeover | not modelled | — | — |
| `ExceedsVerifiedTonnage` | `C + Q <= vkg(R, S)` in `claim` | `p1Bad`, `ledgerBad` | `noClaimCap` |
| `ReportInvalid` in `claimShipment` (superseded, revoked, expired, scope moved) | only the slot's latest credential is claimable; revocation and expiry not modelled | — | — |
| `BatchAlreadyClaimed` | a batch is consumed by its claim | — (claiming one batch twice only adds to `claimedKg`) | — |
| `NotSupplier`, `ZeroQuantity` (claim) | not modelled (one supplier, batches of 1 t) | — | — |
| `revokeReport`: `NotActiveVerifier`, `NotReportIssuer` (only the issuing body, while active, with no exception for an inactive issuer) | not modelled (report revocation) | — | — |

The verifier's check 7 tests of the allowlist (`auditorRevokedAt < registeredAt`) and of `accreditedUntil` have no mutant: in the model the contract guards above already exclude those registrations, so removing either check alone changes no verdict.

## Abstractions

- **Cryptography is perfect.** Hashes, SAIDs, EIP-712 and Ed25519 signatures and KEL anchors cannot be forged, so checks 0–3 and 6 pass for every genuine object and are not modelled. KERI is reduced to one fact, "the ECR was revoked at time k".
- **Time is discrete.** Events in the same tick are interleaved in every order, which models the order of transactions within one block (CR6). The window and the watcher bound are equal (`delta`). The window is a closed interval, `[registeredAt, registeredAt + delta]`, and the argument behind `keriBad` (sync ≤ KERI time + δ ≤ `registeredAt` + δ) does not depend on the size of a tick. The boundary in seconds (24 h against 24 h + 1 s) is not represented; the SDK tests C02 and V25 in `sdk/test/tamper-matrix.test.ts` cover it.
- **Identifiers are abstract.** Two bodies, two auditors, two credentials, three anonymous batches of 1 t (symmetric, so not named), two importers; `verifiedKg` is 1 or 2 t. Salts, commitments, EORIs and batch keys are not modelled; check 5's binding is "same credential, importer and quantity".
- **One ledger slot per product.** The two-level key is one label; the report-scope takeover (branch (c)), report-ID retirement and frozen slots are not modelled.
- **Not modelled at all:** report revocation and the revoking-address and rotation rules of CR1 and CR9; address rotation; credential expiry (`validUntil`); the revision-chain rules of CR3; more than one suspension per body (CR5); KEL rotation, forks and witnesses (T11, T12); RPC behaviour (T20, T21); privacy (P5); checks 1–3, 6 and 8.

## Instances

All with `delta` = 1 tick, three batches of 1 t and two importers. Every search is exhaustive (no depth bound); the depth column is the longest path, confirmed by a depth-bounded search that reaches the same number of states.

| Instance | Content | Ticks | States | Depth |
|---|---|---|---|---|
| `keriInst(W, 4)` | b1 (pinned root) with auditor a1, whose ECR may be revoked in KERI at any tick; b2 an impostor listed by a stolen owner key (attack 4) with auditor a2; r1 by b1, r2 by b2, 2 t each; watcher mode W | 0–4 | 16,662 (W = `up`); 22,152 with `delta` = 2 | 11 |
| `suspInst(3)` | as above without KERI revocation; b1 may be suspended and the suspension lifted, b2 suspended | 0–3 | 31,378 (also with `delta` = 2: without a KERI revocation, `delta` changes only the verdict, not the reachable states) | 11 |
| `revInst(4)` | two accredited bodies; r2 by b2 revises b1's r1 downwards (2 t to 1 t), possible only while b1 is suspended or after its accreditation expires at tick 2; claim times recorded | 0–4 | 7,096 | ≤ 9 |
| `dupInst(4)` | one body signs two 2 t credentials for the same product; the second can be registered under the true slot (refused) or another label | 0–4 | 1,760 | 9 |
| `fullInst(up, 1)` (`checks-full.maude`) | `keriInst` and `suspInst` together, both auditors revocable in KERI | 0–1 | 122,823 | 13 |

## Properties

Each property is a predicate on states that is true in a bad state; "holds" means `search` finds no reachable bad state.

**Stated independently of the model.** The predicates are written from the specification (SECURITY §3, §4 and §9, the contract's NatSpec, the verdict rules of `sdk/verify.ts`) with their own helper functions, all named `s…` (`sKg`, `sSlot`, `sBody`, `sInactiveAt`, `sEventIn`, `sKeriBefore`, …). They call no helper of the rules or of the verifier (`activeNow`, `inWindow`, `chainTime`, `evidenceRevokedBefore`, `vkg`, …). The only model functions they call are `verdictShip` and `verdictCred`, the verdict under test. The ghost values a property needs at the moment of registration (the auditor already revoked, the body inactive, a revision of another body's credential while that body was active) are written by the rules with the same `s…` helpers, not with the guards. So a mutation of a guard or a verifier helper does not change the property with it. In the first version, `windowBad` used the verifier's own `inWindow`, and an outside reviewer's off-by-one mutant of `inWindow` survived in `suspInst`.

| Predicate | Property | Source |
|---|---|---|
| `p1Bad` | Every slot's `claimedKg` ≤ `verifiedKg` of its latest credential | P1 |
| `ledgerBad` | For every product, the tonnes accepted by importers, summed over every batch, every importer and every accepted proof (VALID or CONTESTED), ≤ `verifiedKg` of the latest credential registered under the product's slot | goal "single use", T6, T19 (8) jointly with check 4 |
| `replayBad` | No batch is accepted by two different importers | T4 (b), T5 |
| `authBad` | An accepted proof's credential was registered by a body under the pinned root that was active at that moment (not suspended, not past its accreditation), naming an auditor not revoked on the allowlist at that moment | P3, T1, attack 4 |
| `regAfterRevBad` | No registration with an auditor already revoked on the allowlist | P3, P6 |
| `regInactiveBad` | No registration by a body that was suspended (and not lifted) or past its accreditation at the registration block | P3 |
| `foreignReviseBad` | No credential is revised by another body while its own body is active | `NotReportIssuer` in revision path (2) of T19 |
| `evidenceBad` | A proof whose evidence carries an anchored ECR revocation dated before registration is INVALID | T2, check 7 |
| `windowBad` | A credential whose auditor was revoked on-chain, or whose body was suspended, at a tick in `[registeredAt, registeredAt + delta]` is never VALID (alone, or with a batch shown to the importer it was declared to) | P6, T2, T3 |
| `supersededBad` | A superseded credential presented alone is INVALID | T4 (a) |
| `keriBad` | Under A-Watch: a credential registered after its auditor's ECR was revoked in KERI is never VALID once the watcher's deadline (KERI time + `delta`) has passed | A-Watch, T2, T18 |

`safetyBad` is the disjunction of all eleven. `p1Bad`, `regAfterRevBad`, `regInactiveBad` and `foreignReviseBad` are on-chain properties close to one guard each; the others combine the contract and the verifier.

**LTL** (module `CARBONLEI-LTL`, propositions written with the same `s…` helpers):

| Formula | Instance | Kind |
|---|---|---|
| `[] (keriRevokedP(a1) -> <> chainRevokedP(a1))`: the watcher eventually mirrors a KERI revocation | `keriInst(up, 3)` true; `keriInst(down, 3)` counterexample | Evidence, but weak: it rules out a watcher that never syncs |
| the same formula | `keriInst(late, 3)`: true | **Sanity.** It holds with the watcher `late` as well: the formula does not check the bound `delta`, which the `tick` rule assumes (A-Watch) |
| `[] (contestedP(r1) -> [] ~ validP(r1))`: a CONTESTED credential never becomes VALID again | `keriInst(up, 3)`, `suspInst(2)` | **Sanity.** Holds by construction: no rule removes a revocation or a suspension, and `registeredAt` never changes |
| `[] (chainRevokedP(a1) -> [] chainRevokedP(a1))`: an on-chain revocation is permanent (P6) | `keriInst(up, 3)` | **Sanity.** Holds by construction, as above. P6 in the code rests on the Halmos `check_P6_*` checks and the fuzz tests (SECURITY §9.1, §9.2) |
| `[] safeP` | `keriInst(up, 3)`, `revInst(3)` | **Sanity.** The same as the searches of `safetyBad` |

## Mutants

15 mutants, each removing or weakening one guard of the contract or one check of the verifier, in 26 runs (`checks.maude`, section E). Each run searches for a state that breaks the named property; each finds one. We wrote them, so they show that the properties can fail, not that the model covers every guard: the [guard table](#contract-guards-and-the-properties-that-cover-them) lists what no property covers. The three marked "reviewer" were written by an outside reviewer against the first version, where two of them survived and the third was caught in one instance only.

| # | Mutant | What it removes or changes | Caught by (instance: property, states) |
|---|---|---|---|
| 1 | `noClaimCap` | the cap of `claimShipment` (`ExceedsVerifiedTonnage`) | `dupInst(4)`: `p1Bad`, 125 |
| 2 | `noOverClaimed` | `SupersedeOverClaimed` | `revInst(4)`: `p1Bad`, 290 |
| 3 | `noCovered` | `CredScopeAlreadyCovered` (a second credential into an occupied slot) | `dupInst(4)`: `ledgerBad`, 368 |
| 4 | `noAuthGuard` | the auditor test of `isAuthorizedAt` | `keriInst(up, 4)`: `regAfterRevBad`, 42 |
| 5 | `noSuspGuard` (reviewer) | the suspension test of `isInstitutionActiveAt` | `suspInst(3)`: `regInactiveBad`, 15; `authBad`, 66; `safetyBad`, 15. `revInst(4)`: `regInactiveBad`, 10 |
| 6 | `noExpiryGuard` | the `accreditedUntil` test of `isInstitutionActiveAt` | `revInst(4)`: `regInactiveBad`, 42 |
| 7 | `noIssuerGuard` (reviewer) | `NotReportIssuer` in `_checkIssuerOrInactive` | `revInst(4)`: `foreignReviseBad`, 12; `safetyBad`, 12 |
| 8 | `noCheck5` | check 5 | `keriInst(up, 4)`: `replayBad`, 17; `ledgerBad`, 17 |
| 9 | `noRoot` | the pinned root of check 7 | `keriInst(up, 4)`: `authBad`, 20 |
| 10 | `noScope` | the scope keys of check 4 (4j) | `dupInst(4)`: `ledgerBad`, 18 |
| 11 | `noContested` | the CONTESTED window (4l) | `keriInst(up, 4)`: `windowBad`, 44. `suspInst(3)`: `windowBad`, 19 |
| 12 | `winLeftOpen` | 4l window opened on the left (`registeredAt < e` instead of `≤`) | `keriInst(up, 4)`: `windowBad`, 44. `suspInst(3)`: `windowBad`, 19 |
| 13 | `winRightOpen` (reviewer) | 4l window opened on the right (`e < registeredAt + delta` instead of `≤`) | `keriInst(up, 4)`: `windowBad`, 145; `keriBad`, 426. `suspInst(3)`: `windowBad`, 68; `safetyBad`, 68. `revInst(4)`: `windowBad`, 28 |
| 14 | `noEvidenceRev` | the anchored revocation in the evidence (check 7) | `keriInst(up, 4)`: `evidenceBad`, 39 |
| 15 | `noSupersede` | supersession (4d) | `revInst(4)`: `supersededBad`, 32 |

`noCap` of the first version removed two guards at once; it is now `noClaimCap` and `noOverClaimed`.

## Results (10 October 2026 revision)

Maude 3.5.1 on the development machine (Apple M4, 16 GB). Times are Maude's CPU time; peak memory is sampled by `run.sh` every 0.5 s. Full output: [`docs/data/maude-2026-10-10.txt`](../../docs/data/maude-2026-10-10.txt). The state counts are the same as in the first version: the new ghosts are written once per registration and add no states.

| Check | Expected | Result | States | Time | Memory |
|---|---|---|---|---|---|
| `safetyBad`, `keriInst(up, 4)` | none | no solution | 16,662 | 8.5 s | 48 MB |
| `safetyBad`, `keriInst(up, 4)`, `delta` = 2 | none | no solution | 22,152 | 12.2 s | 60 MB |
| `safetyBad`, `suspInst(3)` (also with `delta` = 2) | none | no solution | 31,378 | 18.2 s, 18.4 s | 81 MB |
| `safetyBad`, `revInst(4)` | none | no solution | 7,096 | 1.1 s | 26 MB |
| `safetyBad`, `dupInst(4)` | none | no solution | 1,760 | 0.6 s | 16 MB |
| `safetyBad`, `fullInst(up, 1)` (`checks-full.maude`) | none | no solution | 122,823 | 254.9 s | 309 MB |
| Non-vacuity: a downward revision by b2 during b1's suspension, with b1's earlier batch still accepted by its importer (`revWitness`); a credential registered after the KERI revocation that ends up CONTESTED (`contestedAfterKeri`); one credential's cap shared by batches accepted by two importers (`twoImporters`); a registration after a lifted suspension, accepted by an importer (`regAfterLift`) | found | found | 98 / 44 / 67 / 548 | < 35 ms | — |
| Sanity counterexample: `keriBad` with the watcher `down`, and `late` | found | found | 122 / 136 | < 10 ms | — |
| Documented limits: `keriRace` (T2, T18), `onchainSumBad` (T19 (8)), `viewsBad` (CR6), `impostorRegistered` (attack 4 on-chain) | found | found | 12 / 268 / 44 / 5 | < 30 ms | — |
| 26 mutant runs of 15 mutants (above) | found | found, each | 10–426 | < 40 ms each | — |
| LTL: eventual sync (`up`, and `late` as a sanity check); the sanity formulas above | true | true | — | 0.4–4.0 s each | ≤ 39 MB |
| LTL: eventual sync with the watcher `down` | counterexample | counterexample | — | < 1 ms | — |

All 51 results (50 in `checks.maude`, 1 in `checks-full.maude`) match their expectation. `checks.maude` takes 102 s wall time in total.

### Sanity counterexample: the watcher stopped

With the watcher `down`, `search` finds, at depth 4 (`keriInst(down, 4)`, state 121 of 122):

1. `keri-revoke`: the body revokes a1's ECR in KERI at tick 0; the watcher never mirrors it.
2. `tick`, `tick`.
3. `register-new`: at tick 2, b1 registers r1 naming a1. The contract accepts it: on the allowlist a1 is still authorised.

At tick 2 the KERI deadline (0 + `delta`) has passed, and the verifier returns VALID for r1: check 4 sees no `AuditorRevoked` event, so nothing is CONTESTED; check 7 reads the same allowlist, and the supplier leaves the KERI revocation out of the evidence. With the watcher `late` the same path is found (136 states). This is the known limitation of T18: the property holds only under A-Watch. The LTL counterexample with the watcher `down` is the matching liveness failure: the revocation is never mirrored on-chain.

### Documented limits the model reproduces

- **Sync window (T2, T18).** With the watcher `up`, a credential registered after the KERI revocation but verified before the sync is VALID (`keriRace`: `keri-revoke`, then `register-new` in the same tick). After the sync, which A-Watch puts within `delta`, the same credential is CONTESTED (`contestedAfterKeri`), and it never returns to VALID (a sanity LTL check: the model has no rule that could undo it). So a VALID result obtained less than `delta` after the registration, or after a KERI revocation that the importer cannot see, can still become CONTESTED; it is final only once that time has passed.
- **On-chain sum across slots (T19 (8)).** One body registers a second 2 t credential for the same product under another slot label; the contract accepts it into a ledger of its own, and 3 t end up claimed on-chain for a product verified at 2 t. Check 4 rejects every proof of the mis-registered credential (`SCOPE_MISMATCH`), so `ledgerBad` still holds: the cap is a joint guarantee of the contract and check 4.
- **Same-block order (CR6).** A registration and the watcher's revocation in the same tick: the contract accepted the registration, so the revocation came after it, but the allowlist views at `registeredAt` answer "not authorised". The verifier treats the same-tick revocation as after the registration and reports CONTESTED.
- **Attack 4 on-chain.** The impostor body's credential is registered (the contract accepts what the allowlist lists), and no proof of it is accepted (check 7, pinned root).

The model found no violation that is not already described in SECURITY §4 and §11. The two properties added on 10 October (`regInactiveBad`, `foreignReviseBad`) and the stronger `authBad` hold on every instance.

## Not covered

Everything listed under [Abstractions](#abstractions) as not modelled, and in particular: the code itself (the model is a hand-written abstraction, so a bug in `sdk/verify.ts` or the contracts that the abstraction does not mirror is not found; the Halmos checks of SECURITY §9.2 and the tests cover the code); instances larger than the bounds above (more bodies, credentials, batches, importers or ticks); `delta` other than 1 and 2, and a window different from the watcher bound; any adversary who holds a key other than the impostor body's (stolen body key, auditor key, watcher key or rotated owner key, T10, T11, T13, CR1); every property of exported vLEI evidence beyond "ECR revoked at time k"; an importer that gives no EORI (the model always runs check 5, so `replayBad` assumes every importer gives its EORI; the code then skips the binding and can return VALID with the warning `SHIPMENT_NOT_BOUND`); report revocation, so the `revokeReport` rule that only the issuing body, while active, may revoke its report; the report layer (`PeriodAlreadyCovered`, `ReportIdRetired`, its own `NotReportIssuer`) and the takeover of branch (c); and the guards marked "—" in the [guard table](#contract-guards-and-the-properties-that-cover-them). The LTL formula for eventual sync rules out only a watcher that never syncs: the bound `delta` is an assumption built into the `tick` rule (A-Watch), not a checked result. The 15 mutants were written by us (three of them following an outside reviewer); they show that each property can fail, not that every guard is covered.
