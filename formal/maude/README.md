# Protocol model in Maude

A rewriting-logic model of the CarbonLEI protocol, checked with Maude's breadth-first `search` and its LTL model checker on small instances. This is a **bounded model check of an abstract model**: it explores every reachable state of the instances below, under the abstractions below. It is not a proof that the protocol or the code is secure, and the model is not generated from the code: the correspondence in [Model and code](#model-and-code) was written by hand. Summary in [SECURITY.md §9.3](../../docs/SECURITY.md#93-protocol-model-maude).

| File | Content |
|---|---|
| `carbonlei.maude` | The protocol model (module `CARBONLEI`), the properties as state predicates, the instances, the mutants, and the LTL propositions (module `CARBONLEI-LTL`); and a separate model of CR1, owner-key compromise against the V1 and V2 rotation and revocation rules (module `CARBONLEI-CR1`, [below](#cr1-model-owner-key-compromise-v1-and-v2)) |
| `checks.maude` | 81 commands with their expected outcome (59 for the protocol model, 22 for the CR1 model), about 2 minutes. On branch `c1-fix-prototype` (not merged): the CR1 model mirrors the prototype fix for finding C1 ([below](#c1-prototype-fix-branch-c1-fix-prototype-not-merged)); on `main`, 77 commands, 18 for the CR1 model |
| `checks-full.maude` | One larger instance (122,823 states, about 5 minutes, about 300 MB) |
| `run.sh` | Runs each command in its own Maude process under a memory watchdog and compares each result with its expectation |
| [`docs/data/maude-2026-10-14.txt`](../../docs/data/maude-2026-10-14.txt) | Full output of both files for the current model: twelve properties in `safetyBad`, two of them also searched on their own, 32 mutant runs, and the CR1 model with WATCHER grants and lifts, 5 mutant runs; the counterexample paths of section G, with every state for finding C1, in [`maude-2026-10-14-cr1-traces.txt`](../../docs/data/maude-2026-10-14-cr1-traces.txt) ([`maude-2026-10-11.txt`](../../docs/data/maude-2026-10-11.txt): the CR1 model without role grants, 2 mutant runs; [`maude-2026-10-10-v2.txt`](../../docs/data/maude-2026-10-10-v2.txt): eleven properties, 26 mutant runs, with the CR1 model; [`maude-2026-10-09b.txt`](../../docs/data/maude-2026-10-09b.txt): before the CR1 model; [`maude-2026-10-09.txt`](../../docs/data/maude-2026-10-09.txt): the first version, nine properties and 10 mutant runs). The property `notReportIssuerBad` is called `foreignReviseBad` in the older outputs |

## Running it

Maude 3.5.1 from the [official release](https://github.com/maude-lang/Maude/releases/tag/Maude3.5.1). For macOS on Apple silicon, `Maude-3.5.1-macos-arm64.zip`, whose SHA-256 is `95851274f57b3853aab833674e2b770ed800f38fb1f3d03c97dcac56346c13dc` (the digest GitHub lists for the asset); for Linux, `Maude-3.5.1-linux-x86_64.zip`, `72ed1ca87e3b3d0dfc6ee1436baf154bf04c45ff97d521bec040c5e8dfc8f92c`. Unzip it anywhere; it needs no installation.

```bash
MAUDE=/path/to/maude npm run formal:maude              # checks.maude
MAUDE=/path/to/maude npm run formal:maude:full         # checks-full.maude
MAUDE=/path/to/maude npm run formal:maude -- revInst   # only the lines containing "revInst"
```

CI (job `maude` in `.github/workflows/ci.yml`) downloads the Linux release, checks its SHA-256 and runs `checks.maude` on every push (the 50 commands of sections A–F as of 10 October took about 105 s there, with the same state counts as on macOS; section G's 18 commands take under 0.6 s of CPU each. All 77 take 134 s on the development machine).

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
| `s…` functions, ghosts `gReg`, `gSusp`, `gRev` and the flags of `reg` | Not code: the specification side. The properties are written with these helpers only (below) |

### Contract guards and the properties that cover them

Every guard of `registerReport` and `claimShipment` (and `revokeReport`, which the model leaves out), whether the model applies it, which property fails without it, and the mutant that removes it. "—" means no property: the guard is not modelled, or the model applies it but nothing checks it.

| Guard (error) | In the model | Property that fails without it | Mutant |
|---|---|---|---|
| `NotActiveVerifier`: body suspended and not lifted | `activeNow` | `regSuspendedBad`, `regInactiveBad`, `authBad` | `noSuspGuard`; `suspSameTick` (the test off by one tick) |
| `NotActiveVerifier`: accreditation expired | `activeNow` | `regInactiveBad` (the verifier's check 7 also rejects it, so `authBad` does not fail) | `noExpiryGuard` |
| `NotActiveVerifier`: address not bound or rotated away | not in the protocol model; in the CR1 model for `revokeReport` and `executeRevocation` (`activeAddr`) | `cr1Bad` (CR1 model, V2) | `noLapse` |
| `AuditorNotAuthorized`: auditor revoked on the allowlist | `audAuthNow` | `regAfterRevBad` (check 7 also rejects it, so `authBad` does not fail) | `noAuthGuard` |
| `AuditorNotAuthorized`: auditor not listed under the body | `aud(A, B)` | — (every credential names its own body's auditor, so the instances never exercise it) | — |
| `ReportExists` | `not isReg(R, S)` | — (each credential has one path to registration in the instances) | — |
| `ZeroQuantity`, `InvalidExpiry`, `InvalidInput` | not modelled (`verifiedKg` ≥ 1, no `validUntil`, no zero keys) | — | — |
| `ReportIdRetired`, `PeriodAlreadyCovered`, report-layer `NotReportIssuer` | not modelled (one slot per product, no report layer) | — | — |
| `ReportNotFound` (`supersedes`), `SupersedeMismatch` | structural: `register-revise` matches the slot's latest credential | — | — |
| `CredScopeAlreadyCovered` (branch a) | `not hasSlot(L, S)` | `ledgerBad` | `noCovered` |
| `NotReportIssuer` in `_checkIssuerOrInactive` (branch b): another body only while the issuer is suspended or past its accreditation | last condition of `register-revise` | `notReportIssuerBad` | `noIssuerGuard`; `issuerIgnoresLift` (the issuer counted as inactive after a lifted suspension) |
| `SupersedeOverClaimed` (branch b) | `V >= C` in `register-revise` | `p1Bad` | `noOverClaimed` |
| Branch (c), takeover | not modelled | — | — |
| `ExceedsVerifiedTonnage` | `C + Q <= vkg(R, S)` in `claim` | `p1Bad`, `ledgerBad` | `noClaimCap` |
| `ReportInvalid` in `claimShipment` (superseded, revoked, expired, scope moved) | only the slot's latest credential is claimable; revocation and expiry not modelled | — | — |
| `BatchAlreadyClaimed` | a batch is consumed by its claim | — (claiming one batch twice only adds to `claimedKg`) | — |
| `NotSupplier`, `ZeroQuantity` (claim) | not modelled (one supplier, batches of 1 t) | — | — |
| `revokeReport`: `NotActiveVerifier`, `NotReportIssuer` (only the issuing body, while active, with no exception for an inactive issuer) | not in the protocol model; in the CR1 model only the attacker revokes, through the body's current address | `cr1Bad` (CR1 model) | — |
| V2 only: `REVOKE_HOLD` in `revokeReport`; `ROTATION_DELAY` in `executeRotation` | CR1 model (`revoke-queue`, `exec-rotation`) | `cr1Bad` | `noHold` (the hold); the rotation delay has no mutant |
| V2 only: `RoleGrantNeedsDelay` in `grantRole`; `RoleGrantNotReady` in `executeRoleGrant`; `NotAllowedToCancel` in `cancelRoleGrant` (a current watcher or the owner) | CR1 model (`propose-grant`, `exec-grant`, `cancel-grant`) | `cr1Bad` (with the watcher cancelling grants) | `grantNow` (no delay); `noGrantCancel` (the watcher cannot cancel) |
| `liftSuspension`: `onlyRole(WATCHER_ROLE)` | CR1 model (`lift`, only by an account holding the role) | `cr1Bad` | `liftByOwner` |
| V2 only: `cancelRotation` refused to a suspended body's address (M2) | CR1 model (`cancel-rotation`) | — (M2 enables the finding below; no property requires it) | — |
| V2, branch `c1-fix-prototype` only: `RoleRevokeNeedsDelay` in `revokeRole`; `RoleRevokeNotReady` and `LastWatcher` in `executeRoleRevoke`; `cancelRoleRevoke` not open to the watcher being revoked | CR1 model (`propose-drop`, `exec-drop`; no cancel rule, since only the attacker's account or the owner could cancel) | `cr1Bad` (with the watcher cancelling grants) | `revokeNow` (revoked at once, the code before the fix); `noLastGuard` (no `LastWatcher`) |

The verifier's check 7 tests of the allowlist (`auditorRevokedAt < registeredAt`) and of `accreditedUntil` have no mutant: in the model the contract guards above already exclude those registrations, so removing either check alone changes no verdict.

## Abstractions

- **Cryptography is perfect.** Hashes, SAIDs, EIP-712 and Ed25519 signatures and KEL anchors cannot be forged, so checks 0–3 and 6 pass for every genuine object and are not modelled. KERI is reduced to one fact, "the ECR was revoked at time k".
- **Time is discrete.** Events in the same tick are interleaved in every order, which models the order of transactions within one block (CR6). The window and the watcher bound are equal (`delta`). The window is a closed interval, `[registeredAt, registeredAt + delta]`, and the argument behind `keriBad` (sync ≤ KERI time + δ ≤ `registeredAt` + δ) does not depend on the size of a tick. The boundary in seconds (24 h against 24 h + 1 s) is not represented; the SDK tests C02 and V25 in `sdk/test/tamper-matrix.test.ts` cover it.
- **Identifiers are abstract.** Two bodies, two auditors, two credentials, three anonymous batches of 1 t (symmetric, so not named), two importers; `verifiedKg` is 1 or 2 t. Salts, commitments, EORIs and batch keys are not modelled; check 5's binding is "same credential, importer and quantity".
- **One ledger slot per product.** The two-level key is one label; the report-scope takeover (branch (c)), report-ID retirement and frozen slots are not modelled.
- **Not modelled at all** in the protocol model: report revocation and the revoking-address and rotation rules of CR1 and CR9; address rotation (the separate [CR1 model](#cr1-model-owner-key-compromise-v1-and-v2) covers rotation and revocation, but not the verifier's CR1 and CR9 rules); credential expiry (`validUntil`); the revision-chain rules of CR3; more than one suspension per body (CR5); KEL rotation, forks and witnesses (T11, T12); RPC behaviour (T20, T21); privacy (P5); checks 1–3, 6 and 8.

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

**Stated independently of the model.** The predicates are written from the specification (SECURITY §3, §4 and §9, the contract's NatSpec, the verdict rules of `sdk/verify.ts`) with their own helper functions, all named `s…` (`sKg`, `sSlot`, `sBody`, `sInactiveAt`, `sEventIn`, `sKeriBefore`, …). They call no helper of the rules or of the verifier (`activeNow`, `inWindow`, `chainTime`, `evidenceRevokedBefore`, `vkg`, …). The only model functions they call are `verdictShip` and `verdictCred`, the verdict under test. The ghost values a property needs at the moment of registration (the auditor already revoked, the body inactive, the body suspended, a revision of another body's credential while that body was active) are written by the rules with the same `s…` helpers, not with the guards. So a mutation of a guard or a verifier helper does not change the property with it. In the first version, `windowBad` used the verifier's own `inWindow`, and an off-by-one mutant of `inWindow` from our own red-team review survived in `suspInst`. `windowBad` now uses its own `sEventIn`, and the off-by-one mutants of `inWindow` at either end (`winLeftOpen`, `winRightOpen`) are each caught by `windowBad` in all three instances that have a revocation or a suspension (`keriInst`, `suspInst`, `revInst`; `dupInst` has neither, and `fullInst` is not run with mutants).

| Predicate | Property | Source |
|---|---|---|
| `p1Bad` | Every slot's `claimedKg` ≤ `verifiedKg` of its latest credential | P1 |
| `ledgerBad` | For every product, the tonnes accepted by importers, summed over every batch, every importer and every accepted proof (VALID or CONTESTED), ≤ `verifiedKg` of the latest credential registered under the product's slot | goal "single use", T6, T19 (8) jointly with check 4 |
| `replayBad` | No batch is accepted by two different importers | T4 (b), T5 |
| `authBad` | An accepted proof's credential was registered by a body under the pinned root that was active at that moment (not suspended, not past its accreditation), naming an auditor not revoked on the allowlist at that moment | P3, T1, attack 4 |
| `regAfterRevBad` | No registration with an auditor already revoked on the allowlist | P3, P6 |
| `regInactiveBad` | No registration by a body that was suspended (and not lifted) or past its accreditation at the registration block | P3 |
| `regSuspendedBad` | Registration during suspension is rejected: no registration by a body that was suspended and not lifted at the registration block (suspension only, from the ghost `gSusp`; also searched on its own in `suspInst(3)` and `revInst(4)`) | P3, T3; `NotActiveVerifier` |
| `notReportIssuerBad` | `NotReportIssuer`: no credential is revised by another body while its own body is active (not suspended, or the suspension lifted, and within its accreditation); also searched on its own in `revInst(4)`. Called `foreignReviseBad` until 10 October | `NotReportIssuer` in revision path (2) of T19 |
| `evidenceBad` | A proof whose evidence carries an anchored ECR revocation dated before registration is INVALID | T2, check 7 |
| `windowBad` | A credential whose auditor was revoked on-chain, or whose body was suspended, at a tick in `[registeredAt, registeredAt + delta]` is never VALID (alone, or with a batch shown to the importer it was declared to) | P6, T2, T3 |
| `supersededBad` | A superseded credential presented alone is INVALID | T4 (a) |
| `keriBad` | Under A-Watch: a credential registered after its auditor's ECR was revoked in KERI is never VALID once the watcher's deadline (KERI time + `delta`) has passed | A-Watch, T2, T18 |

`safetyBad` is the disjunction of all twelve. A thirteenth property, `cr1Bad`, is checked on the separate [CR1 model](#cr1-model-owner-key-compromise-v1-and-v2). `regSuspendedBad` and `notReportIssuerBad` are also searched on their own, so that each is a named result of its own and not only part of `safetyBad`; their non-vacuity witnesses are `regAfterLift` (a registration after a lifted suspension is not ruled out) and `revWitness` (a revision by another body during a suspension is not ruled out). `p1Bad`, `regAfterRevBad`, `regInactiveBad`, `regSuspendedBad` and `notReportIssuerBad` are on-chain properties close to one guard each; the others combine the contract and the verifier.

**LTL** (module `CARBONLEI-LTL`, propositions written with the same `s…` helpers):

| Formula | Instance | Kind |
|---|---|---|
| `[] (keriRevokedP(a1) -> <> chainRevokedP(a1))`: the watcher eventually mirrors a KERI revocation | `keriInst(up, 3)` true; `keriInst(down, 3)` counterexample | Evidence, but weak: it rules out a watcher that never syncs. The only LTL result that is evidence |
| the same formula | `keriInst(late, 3)`: true | **Sanity, not a security claim.** It holds with the watcher `late` as well: the formula does not check the bound `delta`, which the `tick` rule assumes (A-Watch) |
| `[] (contestedP(r1) -> [] ~ validP(r1))`: a CONTESTED credential never becomes VALID again | `keriInst(up, 3)`, `suspInst(2)` | **Sanity, not a security claim.** Holds by construction: no rule removes a revocation or a suspension, and `registeredAt` never changes |
| `[] (chainRevokedP(a1) -> [] chainRevokedP(a1))`: an on-chain revocation is permanent (P6) | `keriInst(up, 3)` | **Sanity, not a security claim.** Holds by construction, as above. P6 in the code rests on the Halmos `check_P6_*` checks and the fuzz tests (SECURITY §9.1, §9.2) |
| `[] safeP` | `keriInst(up, 3)`, `revInst(3)` | **Sanity, not a security claim.** The same as the searches of `safetyBad` |

## Mutants

17 mutants of the protocol model, each removing or weakening one guard of the contract or one check of the verifier, in 32 runs (`checks.maude`, section E), and 5 mutants of the V2 contracts in the CR1 model, in 5 runs (section G; mutants 20–22, for the WATCHER grant and the lift, added on 14 October): 22 mutants in 37 runs. Each run searches for a state that breaks the named property; each finds one. We wrote them, so they show that the properties can fail, not that the model covers every guard: the [guard table](#contract-guards-and-the-properties-that-cover-them) lists what no property covers. The three marked "red team" come from our own red-team review of the first version (an AI reviewer we ran, not an outside party), where two of them survived and the third was caught in one instance only. Mutants 16 and 17 were added on 11 October, one for each of the two properties that are now also searched on their own; on the unmutated model the same searches find no solution.

| # | Mutant | What it removes or changes | Caught by (instance: property, states) |
|---|---|---|---|
| 1 | `noClaimCap` | the cap of `claimShipment` (`ExceedsVerifiedTonnage`) | `dupInst(4)`: `p1Bad`, 125 |
| 2 | `noOverClaimed` | `SupersedeOverClaimed` | `revInst(4)`: `p1Bad`, 290 |
| 3 | `noCovered` | `CredScopeAlreadyCovered` (a second credential into an occupied slot) | `dupInst(4)`: `ledgerBad`, 368 |
| 4 | `noAuthGuard` | the auditor test of `isAuthorizedAt` | `keriInst(up, 4)`: `regAfterRevBad`, 42 |
| 5 | `noSuspGuard` (red team) | the suspension test of `isInstitutionActiveAt` | `suspInst(3)`: `regInactiveBad`, 15; `authBad`, 66; `safetyBad`, 15; `regSuspendedBad`, 15. `revInst(4)`: `regInactiveBad`, 10 |
| 6 | `noExpiryGuard` | the `accreditedUntil` test of `isInstitutionActiveAt` | `revInst(4)`: `regInactiveBad`, 42 |
| 7 | `noIssuerGuard` (red team) | `NotReportIssuer` in `_checkIssuerOrInactive` | `revInst(4)`: `notReportIssuerBad`, 12; `safetyBad`, 12 |
| 8 | `noCheck5` | check 5 | `keriInst(up, 4)`: `replayBad`, 17; `ledgerBad`, 17 |
| 9 | `noRoot` | the pinned root of check 7 | `keriInst(up, 4)`: `authBad`, 20 |
| 10 | `noScope` | the scope keys of check 4 (4j) | `dupInst(4)`: `ledgerBad`, 18 |
| 11 | `noContested` | the CONTESTED window (4l) | `keriInst(up, 4)`: `windowBad`, 44. `suspInst(3)`: `windowBad`, 19. `revInst(4)`: `windowBad`, 11 |
| 12 | `winLeftOpen` | 4l window opened on the left (`registeredAt < e` instead of `≤`) | `keriInst(up, 4)`: `windowBad`, 44. `suspInst(3)`: `windowBad`, 19. `revInst(4)`: `windowBad`, 11 |
| 13 | `winRightOpen` (red team) | 4l window opened on the right (`e < registeredAt + delta` instead of `≤`) | `keriInst(up, 4)`: `windowBad`, 145; `keriBad`, 426. `suspInst(3)`: `windowBad`, 68; `safetyBad`, 68. `revInst(4)`: `windowBad`, 28 |
| 14 | `noEvidenceRev` | the anchored revocation in the evidence (check 7) | `keriInst(up, 4)`: `evidenceBad`, 39 |
| 15 | `noSupersede` | supersession (4d) | `revInst(4)`: `supersededBad`, 32 |
| 16 | `suspSameTick` | the suspension test of `isInstitutionActiveAt` off by one (`t <= suspendedAt` counts as active): a body registers in the tick of its own suspension | `suspInst(3)`: `regSuspendedBad`, 15. `revInst(4)`: `regSuspendedBad`, 10 |
| 17 | `issuerIgnoresLift` | `NotReportIssuer` with the issuer counted as inactive whenever it was ever suspended (the `liftedAt` test left out): another body revises after the suspension was lifted | `revInst(4)`: `notReportIssuerBad`, 72 |
| 18 | `noHold` (V2, CR1 model) | `REVOKE_HOLD`: a revocation by a freshly bound address is applied at once | `cr1Inst(v2, bNone, wOnRotation, gCancel, false, 10)`: `cr1Bad`, 218 |
| 19 | `noLapse` (V2, CR1 model) | `executeRevocation` does not check that the requester is still the body's active address | same: `cr1Bad`, 1,895 |
| 20 | `grantNow` (V2, CR1 model) | `RoleGrantNeedsDelay`: WATCHER_ROLE granted at once, as before the H2 fix | same: `cr1Bad`, 1,498 |
| 21 | `noGrantCancel` (V2, CR1 model) | `cancelRoleGrant` open only to the owner, not to a current watcher | same: `cr1Bad`, 5,011 |
| 22 | `liftByOwner` (V2, CR1 model) | `onlyRole(WATCHER_ROLE)` on `liftSuspension`: the owner key lifts without the role | same: `cr1Bad`, 2,720 |
| 23 | `revokeNow` (V2, CR1 model; branch `c1-fix-prototype`) | the C1 fix: `revokeRole(WATCHER_ROLE, …)` at once, as on `main` | `cr1Inst(v2, bWatch, wNone, gCancel, true, 10)`: `cr1Bad`, 4,759 |
| 24 | `noLastGuard` (V2, CR1 model; branch `c1-fix-prototype`) | the `LastWatcher` guard of `executeRoleRevoke` (the delay kept) | same: `cr1Bad`, 12,643 |

`noCap` of the first version removed two guards at once; it is now `noClaimCap` and `noOverClaimed`.

## CR1 model: owner-key compromise, V1 and V2

Module `CARBONLEI-CR1` in `carbonlei.maude`, checked in section G of `checks.maude`. It is a separate, smaller model: adding it left the protocol model and its commands (sections A–F) unchanged, with the same state counts. It covers what CR1 (SECURITY §4.2, T10) and the V2 mitigation (SECURITY §13.1, `contracts/src/v2/`) are about, and nothing else. On 14 October it was extended to the two paths of review finding H2, the WATCHER grant and the suspension lift, and to the M2 rule of `cancelRotation`; the extension found an attack on the V2 code ([below](#finding-of-14-october-the-body-alone-cannot-stop-the-rotation)).

- **State.** One body b1 with one report r1 registered honestly before tick 0; the body's current address and the tick it was bound (`institutions[b].currentAddress`, `leiOfAddress[addr].boundAt`); suspension; pending rotations and queued revocations; revocations with the revoking address; a pending WATCHER grant to the attacker's account (`pendingRoleGrants[WATCHER_ROLE][tw]`) and whether that account holds the role.
- **Attacker.** Holds the allowlist owner key and one fresh EVM key `tk`. It does not hold the body's key `hk` and cannot forge the body's EIP-712 consent (cryptography is perfect), so the consent path `executeRotationSigned` is treated as closed to it and is not modelled. For the V2 code as first written this was wrong: after a rotation by delay, `tk` is the body's current address and could sign the consent for a second rotation at once (finding H1 of our own AI-run review, SECURITY §13.1). Since the fix, consent counts only from an address bound at least `ROTATION_DELAY` (3 ticks, equal to `REVOKE_HOLD`); from that tick `tk` can already revoke at once, which the model includes, so leaving the consent path out no longer hides an attack the model would otherwise find. This is an argument about the model, not a checked result: the consent path is still not modelled. V1: `rotateVerifierAddress` to `tk` at once. V2: `proposeRotation` (again after each cancellation), `executeRotation` once `readyAt` has passed. Then `revokeReport` through `tk` while it is the body's active address: in V1 at once; in V2 at once only if `tk` was bound at least `REVOKE_HOLD` ago, otherwise queued, and `executeRevocation` after `REVOKE_HOLD` only while the requester is still the body's active address (not suspended, not rotated away). With `dropOK` the owner key can also revoke the WATCHER role (`revokeRole`, not delayed). In V2 it can `proposeRoleGrant(WATCHER_ROLE, tw)` for an account of its own (`grantRole` for that role reverts, `RoleGrantNeedsDelay`), again after each cancellation, and `executeRoleGrant` once `ROTATION_DELAY` has passed; with the role, `tw` can `suspendVerifier` and `liftSuspension` (no delay; the owner cannot lift without the role). Role grants are modelled for V2 only: V1 falls without them.
- **Defenders.** The body's current address cancels a pending rotation unless the body is suspended (`cancelRotation`, `bodyMayCancel`, M2); the WATCHER cancels a pending rotation, a queued revocation (`cancelRevocation`) and a pending WATCHER grant (`cancelRoleGrant`), and suspends the body. The honest owner, who could also cancel, is not modelled. These actions are enabled at every tick at which the code allows them.
- **Time.** One tick stands for 24 hours; `ROTATION_DELAY` and `REVOKE_HOLD` are 72 hours, 3 ticks. Ticks 0 to 10 (0 to 7 for `cr1BadBefore(6)`, which needs no later tick). Every action can happen at any tick, in any order within a tick, so a lift and the revocation it enables can be in one block.
- **Monitoring, an explicit assumption.** Stated as a constraint on time, like A-Watch in the protocol model: the clock may not reach a deadline while the obligation is unmet. The actions that meet the obligation are enabled whenever it is pending, so the constraint cannot stop time by itself (the three non-vacuity searches below reach the last tick). `bWatch`: the body or the watcher cancels a pending rotation before `readyAt`, as long as one of them can (when the body is suspended and the watcher has lost its role, nobody honest can, and time passes). `wOnRotation`: while the watcher holds its role, it suspends the body within `REVOKE_HOLD` of a rotation (`VerifierAddressRotated`). `wOnQueued`: the same, but only within `REVOKE_HOLD` of the first `RevocationQueued`. `gCancel`: while the watcher holds its role, it cancels a pending WATCHER grant before its `readyAt` (the `RoleGrantProposed` rule of `verifier/src/watch-v2.ts`). `bNone`, `wNone`, `gNone`: no obligation; the body and the watcher may still act at any time, or never. The monitor's re-suspension after a foreign lift is not modelled as an obligation: it would come after the lift, and the revocation can be in the same block.
- **Not modelled here.** The honest owner, registration, claims, the verifier and its CR1 and CR9 rules, `effectiveFrom`, more than one report or body, the timelock owner, accreditation expiry; the consent path (above); grants of roles other than WATCHER, and more than one attacker account for it (a second account would need its own grant, cancellable in the same way); new bodies added by the owner; supersede and takeover by the attacker's address (review finding M1); `revokeAuditor`; a stolen body or watcher key; the monitor's handling of chains of rotations, reorganisations and RPC limits. Those are covered only by the Foundry and monitor tests of SECURITY §13.1.

**Property** `cr1Bad`, written with its own `s…` helpers: a report is revoked by an address its issuing body did not control. `cr1BadBefore(k)`: the same, at a tick before `k`. `cr1BadThiefSusp`: `cr1Bad` on a path where the honest watcher never suspended the body (a ghost records its suspensions).

| Command (`cr1Inst(contract, body monitoring, watcher monitoring, grant monitoring, dropOK, last tick)`) | Expected | Result | States | What it shows |
|---|---|---|---|---|
| `cr1Bad`, `cr1Inst(v1, bWatch, wOnRotation, gCancel, false, 10)` | found | found | 5 | V1: rotation and revocation in one block (`v1-rotate`, `revoke-now` at tick 0), so no monitoring helps |
| `cr1Bad`, `cr1Inst(v2, bWatch, wNone, gNone, false, 10)` | none | no solution | 3,304 | V2: if the body or the watcher cancels each rotation proposal within `ROTATION_DELAY` and the watcher keeps its role, no report is revoked by the attacker, even if the attacker gets a WATCHER role of its own and suspends the body |
| `cr1Bad`, `cr1Inst(v2, bNone, wOnRotation, gCancel, false, 10)` | none | no solution | 8,840 | V2: the body misses the rotation; the watcher keeps its role, cancels the attacker's WATCHER grants and suspends the body within `REVOKE_HOLD` of the rotation: no report is revoked by the attacker |
| `cr1Bad`, `cr1Inst(v2, bWatch, wNone, gNone, true, 10)` | found | found | 6,242 | **Finding** (No solution, 232 states, while the model left role grants and M2 out): once the owner key has dropped the watcher, the body's cancellation is not enough. Path: `propose` and the honest watcher's `suspend` at tick 0, `drop-watcher`, `propose-grant`; `exec-rotation` and `exec-grant` at tick 3 (the suspended body cannot cancel, nobody else is left), `lift`; `revoke-now` at tick 6 |
| `cr1BadThiefSusp`, same instance | found | found | 8,082 | The same without any suspension by the honest watcher: `drop-watcher`, `propose-grant` at tick 0; `propose` at tick 1; `exec-grant`, `thief-suspend` at tick 3, before the body cancels; `exec-rotation`, `lift` at tick 4; `revoke-now` at tick 7. If the body cancels at once, the attacker suspends first and proposes in the same block (tick 3), and the revocation executes at tick 9 (216 h); that path is the Foundry test below, not a separate Maude search |
| `cr1Bad`, `cr1Inst(v2, bNone, wNone, gNone, true, 10)` | found | found | 2,140 | V2 without monitoring: the attack completes. Path: `propose` at tick 0, three ticks, `exec-rotation` at tick 3, three ticks, `revoke-now` at tick 6 |
| `cr1BadBefore(6)`, `cr1Inst(v2, bNone, wNone, gNone, true, 7)` | none | no solution | 27,744 | ... but not before tick 6, i.e. 144 hours after the first event |
| `cr1Bad`, `cr1Inst(v2, bNone, wOnQueued, gCancel, false, 10)` | found | found | 902 | A watcher that reacts only to `RevocationQueued` does not stop it: the attacker never queues; it waits `REVOKE_HOLD` after the rotation, when its address is no longer freshly bound, and revokes at once (same path as above) |
| `cr1Bad`, `cr1Inst(v2, bNone, wOnRotation, gCancel, true, 10)` | found | found | 2,518 | If the owner key first drops the watcher's role (`drop-watcher` at tick 0), only the body's own cancellation is left |
| `cr1Bad`, `cr1Inst(v2, bNone, wOnRotation, gNone, false, 10)` | found | found | 7,364 | A watcher that suspends after the rotation but does not cancel the attacker's WATCHER grant: `propose`, `suspend`, `propose-grant` at tick 0; `exec-rotation`, `exec-grant` at tick 3; `lift` and `revoke-now` in one block at tick 6. Cancelling grants is needed, not only re-suspending after a foreign lift |
| Non-vacuity: `cancelWitness`, `cr1Inst(v2, bWatch, wNone, gNone, false, 10)` | found | found | 1,827 | A rotation proposal was cancelled, nothing rotated, and time reached tick 10 |
| Non-vacuity: `suspendWitness`, `cr1Inst(v2, bNone, wOnRotation, gCancel, false, 10)` | found | found | 4,672 | The rotation went through, the attacker's revocation is queued, the body is suspended, and time reached tick 10 |
| Non-vacuity: `grantCancelWitness`, same instance | found | found | 2,947 | A WATCHER grant to the attacker was cancelled, the attacker never held the role, and time reached tick 10 |
| Mutant `noHold`, `cr1Bad`, same instance | found | found | 218 | Without the hold, the attacker revokes in the block of the rotation (tick 3) |
| Mutant `noLapse`, `cr1Bad`, same instance | found | found | 1,895 | Without the requester check, the queued revocation executes at tick 6 although the watcher suspended the body at tick 3 |
| Mutant `grantNow`, `cr1Bad`, same instance | found | found | 1,498 | WATCHER granted at once (no `RoleGrantNeedsDelay`, the code before the H2 fix): the watcher has nothing to cancel; the attacker's account lifts the watcher's suspension at tick 6 and the revocation follows in the same block |
| Mutant `noGrantCancel`, `cr1Bad`, same instance | found | found | 5,011 | `cancelRoleGrant` open only to the owner: the watcher cannot cancel, the grant executes at tick 3, lift and revocation at tick 6 |
| Mutant `liftByOwner`, `cr1Bad`, same instance | found | found | 2,720 | `liftSuspension` without `onlyRole(WATCHER_ROLE)`, open to the owner key: lift and revocation at tick 6, with no grant at all |

Each command takes under 0.2 s of CPU, except `cr1BadBefore(6)` (0.55 s, about 100 MB). V1 falls in one block; V2 holds within the bound under a monitoring assumption in which the watcher keeps its role; without monitoring the attack completes after both delays, 144 hours after the first event. The results also make two points of §13.1 more precise. When the body misses the rotation, cancelling the attacker's queued revocations is not enough, and neither is reacting only to `RevocationQueued`, because an address bound for `REVOKE_HOLD` revokes at once: the watcher has to suspend the body (as `test_CR1_V2_rotationMissed_watcherCancelsHeldRevocations` does after cancelling) within `REVOKE_HOLD` of the rotation. And it has to cancel WATCHER grants to accounts it does not expect, because a granted account lifts the suspension in the block of the revocation. This is a bounded check of an abstract model with perfect cryptography, not a proof about the V2 code; the V2 code is covered by its Foundry and Halmos tests (SECURITY §13.1).

### Finding of 14 October: the body alone cannot stop the rotation

SECURITY §13.1 said that once a stolen owner key (not behind a timelock) has revoked the watcher's role, "only the body itself can stop the rotation". With role grants and M2 in the model, the body cannot: the same key proposes WATCHER_ROLE for an account of its own, which nobody left can cancel (`cancelRoleGrant` is open to a current watcher and the owner), suspends the body with it 72 hours later, and a suspended body's current address cannot cancel a rotation (M2). The rotation executes, the attacker's watcher lifts the suspension, and the attacker's address revokes. `test_CR1_V2_residual_ownerKeyRemovesWatcher_selfGrantedWatcherBlocksBodyCancel` in `contracts/test/v2/CR1Attack.t.sol` reproduces it against the V2 code: revoke the watcher and propose the grant at t0; execute the grant, suspend the body and propose the rotation at t0 + 72 h (the body's `cancelRotation` reverts `NotAllowedToCancel`); execute the rotation, lift and queue the revocations at t0 + 144 h; execute them at t0 + 216 h. The precondition is the residual risk §13.1 already names (an owner key that can revoke the watcher at once); what changes is that a body that watches its own rotations no longer stops the attack in that case. A `TimelockController` owner with a separate canceller (the deployment §13.1 recommends) delays the `revokeRole` too. Found by our own model run, not by an external audit; the contracts on `main` are not changed (a prototype fix is on branch `c1-fix-prototype`, [below](#c1-prototype-fix-branch-c1-fix-prototype-not-merged)).

### C1 prototype fix (branch `c1-fix-prototype`, not merged)

On branch `c1-fix-prototype` the V2 allowlist revokes WATCHER_ROLE in two steps, as it grants it: `revokeRole` for that role reverts `RoleRevokeNeedsDelay`; the owner calls `proposeRoleRevoke`, anyone calls `executeRoleRevoke` after `ROTATION_DELAY`, and only while another account holds the role (`LastWatcher`); any watcher other than the one being revoked, or the owner, can cancel; `renounceRole` stays immediate. The model mirrors it: `drop-watcher` (immediate) remains only for V1 and the mutant `revokeNow`; V2 has `propose-drop` and `exec-drop`, which needs the attacker's account `tw` to hold the role; there is no cancel rule, because the honest watcher, the only one modelled, cannot cancel its own revocation. Results (section G, 22 commands, all as expected):

| Command | Expected | States | What it shows |
|---|---|---|---|
| `cr1Bad`, `cr1Inst(v2, bWatch, wNone, gCancel, true, 10)` | none | 9,496 | The C1 instance: a body that cancels its rotations and a watcher that cancels unexpected WATCHER grants. Before the fix this is found (mutant `revokeNow`, 4,759 states: `propose`, `suspend`, `drop-watcher`, `propose-grant` at tick 0; `exec-rotation`, `exec-grant` at 3; `lift`, `revoke-now` at 6) |
| `dropWitness`, same instance | found | 4,144 | Non-vacuity: the owner key proposed the revocation, the watcher kept its role, time reached tick 10 |
| `cr1Bad`, `cr1Inst(v2, bNone, wOnRotation, gCancel, true, 10)` | none | 83,096 | Was found (2,518) before the fix: the owner key can no longer drop the watcher first |
| `cr1Bad` and `cr1BadThiefSusp`, `cr1Inst(v2, bWatch, wNone, gNone, true, 10)` | found | 25,301; 25,934 | **Residual.** A watcher that does not cancel grants: `suspend`, `propose-drop`, `propose-grant` at tick 0; `propose` at 1; `exec-grant`, `exec-drop` at 3; `exec-rotation`, `lift` at 4; `revoke-now` at 7. The body alone still cannot stop the attack; this was the C1 command before the fix |
| `cr1Bad`, `cr1Inst(v2, bNone, wNone, gNone, true, 10)`; `cr1BadBefore(6)`, same with tick 7 | found; none | 4,636; 114,016 | Unchanged outcomes, more states (the two-step revocation adds interleavings); `cr1BadBefore(6)` peaks at about 420 MB |
| Mutant `noLastGuard`, C1 instance | found | 12,643 | Without `LastWatcher`, the delay alone does not help: `suspend`, `propose-drop` at 0; `propose`, `propose-grant` at 1; `exec-drop` at 3 (the watcher is gone before the grant is due, so it no longer cancels it); `exec-rotation`, `exec-grant`, `lift` at 4; `revoke-now` at 7 |

The other section G commands give the same outcomes and state counts as on `main` (dropOK false, so the new rules do not fire). Output: [`docs/data/maude-2026-10-16-c1fix.txt`](../../docs/data/maude-2026-10-16-c1fix.txt). What the model does not cover of the fix: a second honest watcher, `renounceRole`, the honest owner cancelling, and the new risk of a stolen watcher key that stays 72 hours (the model has no stolen watcher key); those are Foundry tests (`contracts/test/v2/C1Fix.t.sol`).

## Results (11 October 2026 revision; CR1 model 14 October)

Maude 3.5.1 on the development machine (Apple M4, 16 GB). Times are Maude's CPU time; peak memory is sampled by `run.sh` every 0.5 s. Full output: [`docs/data/maude-2026-10-11.txt`](../../docs/data/maude-2026-10-11.txt) for the times below; [`docs/data/maude-2026-10-14.txt`](../../docs/data/maude-2026-10-14.txt), after the CR1 extension, gives the same outcomes and state counts for sections A–F and `checks-full.maude`. The state counts are the same as in the first version: the ghosts (`gReg`, `gRev`, and `gSusp` added on 11 October) are written once per registration and add no states. The earlier runs ([`maude-2026-10-09b.txt`](../../docs/data/maude-2026-10-09b.txt), [`maude-2026-10-10-v2.txt`](../../docs/data/maude-2026-10-10-v2.txt)) give the same state counts and outcomes for every command they share with this one; the CR1 results are in the [section above](#cr1-model-owner-key-compromise-v1-and-v2).

| Check | Expected | Result | States | Time | Memory |
|---|---|---|---|---|---|
| `safetyBad`, `keriInst(up, 4)` | none | no solution | 16,662 | 8.7 s | 49 MB |
| `safetyBad`, `keriInst(up, 4)`, `delta` = 2 | none | no solution | 22,152 | 12.6 s | 62 MB |
| `safetyBad`, `suspInst(3)` (also with `delta` = 2) | none | no solution | 31,378 | 18.5 s, 18.9 s | 83 MB |
| `safetyBad`, `revInst(4)` | none | no solution | 7,096 | 1.1 s | 26 MB |
| `safetyBad`, `dupInst(4)` | none | no solution | 1,760 | 0.6 s | 16 MB |
| `regSuspendedBad` on its own, `suspInst(3)`; `revInst(4)` | none | no solution | 31,378; 7,096 | 13.0 s; 0.6 s | 83 MB; 26 MB |
| `notReportIssuerBad` on its own, `revInst(4)` | none | no solution | 7,096 | 0.6 s | 26 MB |
| `safetyBad`, `fullInst(up, 1)` (`checks-full.maude`) | none | no solution | 122,823 | 279.5 s | 301 MB |
| Non-vacuity: a downward revision by b2 during b1's suspension, with b1's earlier batch still accepted by its importer (`revWitness`); a credential registered after the KERI revocation that ends up CONTESTED (`contestedAfterKeri`); one credential's cap shared by batches accepted by two importers (`twoImporters`); a registration after a lifted suspension, accepted by an importer (`regAfterLift`) | found | found | 98 / 44 / 67 / 548 | < 35 ms | — |
| Sanity counterexample: `keriBad` with the watcher `down`, and `late` | found | found | 122 / 136 | < 10 ms | — |
| Documented limits: `keriRace` (T2, T18), `onchainSumBad` (T19 (8)), `viewsBad` (CR6), `impostorRegistered` (attack 4 on-chain) | found | found | 12 / 268 / 44 / 5 | < 30 ms | — |
| 32 mutant runs of 17 mutants (above) | found | found, each | 10–426 | ≤ 40 ms each | — |
| LTL: eventual sync (`up`, and `late` as a sanity check); the sanity formulas above | true | true | — | 0.4–4.0 s each | ≤ 40 MB |
| LTL: eventual sync with the watcher `down` | counterexample | counterexample | — | < 1 ms | — |

All 78 results (77 in `checks.maude`, 59 of them for the protocol model and 18 for the CR1 model; 1 in `checks-full.maude`) match their expectation. `checks.maude` took 129 s wall time in total on 11 October (70 commands) and 134 s on 14 October (77 commands).

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

The protocol model found no violation that is not already described in SECURITY §4 and §11. The CR1 model found one on 14 October, against the V2 contracts, which are not deployed ([above](#finding-of-14-october-the-body-alone-cannot-stop-the-rotation)). The two properties added on 10 October (`regInactiveBad`, and `foreignReviseBad`, now `notReportIssuerBad`), the stronger `authBad`, and `regSuspendedBad` (11 October) hold on every instance.

## Not covered

Everything listed under [Abstractions](#abstractions) as not modelled, and in particular: the code itself (the model is a hand-written abstraction, so a bug in `sdk/verify.ts` or the contracts that the abstraction does not mirror is not found; the Halmos checks of SECURITY §9.2 and the tests cover the code); instances larger than the bounds above (more bodies, credentials, batches, importers or ticks); `delta` other than 1 and 2, and a window different from the watcher bound; in the protocol model, any adversary who holds a key other than the impostor body's (stolen body key, auditor key, watcher key or rotated owner key, T10, T11, T13; the CR1 model covers a stolen owner key that rotates and revokes, but not a stolen long-held body key, CR1a); every property of exported vLEI evidence beyond "ECR revoked at time k"; an importer that gives no EORI (the model always runs check 5, so `replayBad` assumes every importer gives its EORI; the code then skips the binding and can return VALID with the warning `SHIPMENT_NOT_BOUND`); report revocation in the protocol model (the CR1 model has it only for the attacker); the report layer (`PeriodAlreadyCovered`, `ReportIdRetired`, its own `NotReportIssuer`) and the takeover of branch (c); and the guards marked "—" in the [guard table](#contract-guards-and-the-properties-that-cover-them). The LTL formula for eventual sync rules out only a watcher that never syncs: the bound `delta` is an assumption built into the `tick` rule (A-Watch), not a checked result. The 22 mutants were written by us (three of them from our own red-team review); they show that each property can fail, not that every guard is covered.
