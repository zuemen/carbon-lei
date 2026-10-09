# Protocol model in Maude

A rewriting-logic model of the CarbonLEI protocol, checked with Maude's breadth-first `search` and its LTL model checker on small instances. This is a **bounded model check of an abstract model**: it explores every reachable state of the instances below, under the abstractions below. It is not a proof that the protocol or the code is secure, and the model is not generated from the code: the correspondence in [Model and code](#model-and-code) was written by hand. Summary in [SECURITY.md §9.3](../../docs/SECURITY.md#93-protocol-model-maude).

| File | Content |
|---|---|
| `carbonlei.maude` | The model (module `CARBONLEI`), the properties as state predicates, the instances, the mutants, and the LTL propositions (module `CARBONLEI-LTL`) |
| `checks.maude` | 32 commands with their expected outcome, under 2 minutes |
| `checks-full.maude` | One larger instance (122,823 states, about 4 minutes, about 300 MB) |
| `run.sh` | Runs each command in its own Maude process under a memory watchdog and compares each result with its expectation |
| [`docs/data/maude-2026-10-09.txt`](../../docs/data/maude-2026-10-09.txt) | Full output of both files |

## Running it

Maude 3.5.1 from the [official release](https://github.com/maude-lang/Maude/releases/tag/Maude3.5.1). For macOS on Apple silicon, `Maude-3.5.1-macos-arm64.zip`, whose SHA-256 is `95851274f57b3853aab833674e2b770ed800f38fb1f3d03c97dcac56346c13dc` (the digest GitHub lists for the asset); for Linux, `Maude-3.5.1-linux-x86_64.zip`, `72ed1ca87e3b3d0dfc6ee1436baf154bf04c45ff97d521bec040c5e8dfc8f92c`. Unzip it anywhere; it needs no installation.

```bash
MAUDE=/path/to/maude npm run formal:maude              # checks.maude
MAUDE=/path/to/maude npm run formal:maude:full         # checks-full.maude
MAUDE=/path/to/maude npm run formal:maude -- revInst   # only the lines containing "revInst"
```

CI (job `maude` in `.github/workflows/ci.yml`) downloads the Linux release, checks its SHA-256 and runs `checks.maude` on every push (about 90 s, with the same state counts as on macOS).

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
| `activeNow`, `audAuthNow` in the registration rules | `VerifierAllowlist.isVerifierActiveAt`, `isAuthorizedAt`, called from `EmissionsClaimRegistry._checkCommon` |
| slot `(label, latest, claimedKg)` | `credScopes[reportScopeKey][credScopeKey]` (`latestReportKey`, `claimedKg`); the two keys are one label |
| `register-new` / `register-revise` | `registerReport` branches (a) and (b); `_checkRevision` (`SupersedeMismatch`, `SupersedeOverClaimed`, `NotReportIssuer`) |
| `claim` | `claimShipment` (`ExceedsVerifiedTonnage`; only the latest credential of a slot is claimable, as `isValidAt` makes a superseded one) |
| `keri-revoke`, `watcher-sync` | the body's TEL revocation of the ECR; `verifier/src/watch.ts` and `revokeAuditor` |
| `suspend`, `lift` | `suspendVerifier`, `liftSuspension` |
| `check4fail`, `contested` | `sdk/verify.ts` check 4: 4d, 4j, 4l (`contestedWindowHours`) |
| `check5fail` | `sdk/verify.ts` check 5 (`shipmentStatus`: report, quantity, `importerCommit`) |
| `check7fail` | `sdk/vlei.ts` `verifyAuthority`: pinned root, allowlist `auditorRevokedAt < registeredAt`, `accreditedUntil`, `anchoredRevocation` with `dt < registeredAt` |

## Abstractions

- **Cryptography is perfect.** Hashes, SAIDs, EIP-712 and Ed25519 signatures and KEL anchors cannot be forged, so checks 0–3 and 6 pass for every genuine object and are not modelled. KERI is reduced to one fact, "the ECR was revoked at time k".
- **Time is discrete.** Events in the same tick are interleaved in every order, which models the order of transactions within one block (CR6). The window and the watcher bound are equal (`delta`).
- **Identifiers are abstract.** Two bodies, two auditors, two credentials, three anonymous batches of 1 t (symmetric, so not named), two importers; `verifiedKg` is 1 or 2 t. Salts, commitments, EORIs and batch keys are not modelled; check 5's binding is "same credential, importer and quantity".
- **One ledger slot per product.** The two-level key is one label; the report-scope takeover (branch (c)), report-ID retirement and frozen slots are not modelled.
- **Not modelled at all:** report revocation and the revoking-address and rotation rules of CR1 and CR9; address rotation; credential expiry (`validUntil`); the revision-chain rules of CR3; more than one suspension per body (CR5); KEL rotation, forks and witnesses (T11, T12); RPC behaviour (T20, T21); privacy (P5); checks 1–3, 6 and 8.

## Instances

All with `delta` = 1 tick, three batches of 1 t and two importers. Every search is exhaustive (no depth bound); the depth column is the longest path, confirmed by a depth-bounded search that reaches the same number of states.

| Instance | Content | Ticks | States | Depth |
|---|---|---|---|---|
| `keriInst(W, 4)` | b1 (pinned root) with auditor a1, whose ECR may be revoked in KERI at any tick; b2 an impostor listed by a stolen owner key (attack 4) with auditor a2; r1 by b1, r2 by b2, 2 t each; watcher mode W | 0–4 | 16,662 (W = `up`); 22,152 with `delta` = 2 | 11 |
| `suspInst(3)` | as above without KERI revocation; b1 may be suspended and the suspension lifted, b2 suspended | 0–3 | 31,378 | 11 |
| `revInst(4)` | two accredited bodies; r2 by b2 revises b1's r1 downwards (2 t to 1 t), possible only while b1 is suspended or after its accreditation expires at tick 2; claim times recorded | 0–4 | 7,096 | ≤ 9 |
| `dupInst(4)` | one body signs two 2 t credentials for the same product; the second can be registered under the true slot (refused) or another label | 0–4 | 1,760 | 9 |
| `fullInst(up, 1)` (`checks-full.maude`) | `keriInst` and `suspInst` together, both auditors revocable in KERI | 0–1 | 122,823 | 13 |

## Properties

Each property is a predicate on states that is true in a bad state; "holds" means `search` finds no reachable bad state.

| Predicate | Property | Source |
|---|---|---|
| `p1Bad` | Every slot's `claimedKg` ≤ `verifiedKg` of its latest credential | P1 |
| `ledgerBad` | For every product, the tonnes accepted by importers, summed over every batch, every importer and every accepted proof (VALID or CONTESTED), ≤ `verifiedKg` of the latest credential registered under the product's slot | goal "single use", T6, T19 (8) jointly with check 4 |
| `replayBad` | No batch is accepted by two different importers | T4 (b), T5 |
| `authBad` | An accepted proof's credential was registered, with an auditor not revoked on the allowlist at that moment, by a body under the pinned root | P3, T1, attack 4 |
| `regAfterRevBad` | No registration with an auditor already revoked on the allowlist | P3, P6 |
| `evidenceBad` | A proof whose evidence carries an anchored ECR revocation dated before registration is INVALID | T2, check 7 |
| `windowBad` | A credential whose auditor was revoked on-chain, or whose body was suspended, within `delta` after its registration is never VALID (alone, or with a batch shown to its own importer) | P6, T2, T3 |
| `supersededBad` | A superseded credential presented alone is INVALID | T4 (a) |
| `keriBad` | Under A-Watch: a credential registered after its auditor's ECR was revoked in KERI is never VALID once the watcher's deadline (KERI time + `delta`) has passed | A-Watch, T2, T18 |

`safetyBad` is the disjunction of all nine. LTL formulas (module `CARBONLEI-LTL`): `[] (keriRevokedP(a1) -> <> chainRevokedP(a1))` (the watcher eventually mirrors a KERI revocation), `[] (contestedP(r1) -> [] ~ validP(r1))` (a CONTESTED credential never becomes VALID again), `[] (chainRevokedP(a1) -> [] chainRevokedP(a1))` (P6), `[] safeP`.

## Results (9 October 2026)

Maude 3.5.1 on the development machine (Apple M4, 16 GB). Times are Maude's CPU time; peak memory is sampled by `run.sh` every 0.5 s.

| Check | Expected | Result | States | Time | Memory |
|---|---|---|---|---|---|
| `safetyBad`, `keriInst(up, 4)` | none | no solution | 16,662 | 8.0 s | 46 MB |
| `safetyBad`, `keriInst(up, 4)`, `delta` = 2 | none | no solution | 22,152 | 12.0 s | 59 MB |
| `safetyBad`, `suspInst(3)` (also with `delta` = 2) | none | no solution | 31,378 | 17.8 s | 78 MB |
| `safetyBad`, `revInst(4)` | none | no solution | 7,096 | 1.0 s | 26 MB |
| `safetyBad`, `dupInst(4)` | none | no solution | 1,760 | 0.6 s | 15 MB |
| `safetyBad`, `fullInst(up, 1)` | none | no solution | 122,823 | 216.6 s | 302 MB |
| Non-vacuity: a downward revision by b2 during b1's suspension, with b1's earlier batch still accepted by its importer (`revWitness`); a credential registered after the KERI revocation that ends up CONTESTED (`contestedAfterKeri`); one credential's cap shared by batches accepted by two importers (`twoImporters`) | found | found | 98 / 44 / 67 | < 5 ms | — |
| Sanity counterexample: `keriBad` with the watcher `down`, and `late` | found | found | 122 / 136 | < 5 ms | — |
| Documented limits: `keriRace` (T2, T18), `onchainSumBad` (T19 (8)), `viewsBad` (CR6), `impostorRegistered` (attack 4 on-chain) | found | found | 12 / 268 / 44 / 5 | < 30 ms | — |
| 10 mutant checks (below) | found | found, each | 17–125 | < 5 ms each | — |
| LTL: eventual sync (`up`); CONTESTED never VALID again (`keriInst(up, 3)`, `suspInst(2)`); P6; `[] safeP` (`keriInst(up, 3)`, `revInst(3)`) | true | true | — | 0.4–3.6 s each | ≤ 36 MB |
| LTL: eventual sync with the watcher `down` | counterexample | counterexample | — | < 1 ms | — |

All 33 results match their expectation.

**The checks can fail.** Each mutant removes one guard or check, and the matching search finds a counterexample: `noCap` (the claim cap and `SupersedeOverClaimed`) breaks P1; `noAuthGuard` (the auditor test of `isAuthorizedAt`) lets a revoked auditor register; `noCheck5` lets a batch be accepted by a second importer and over-claimed; `noRoot` accepts the impostor; `noScope` accepts a credential registered under another slot label and breaks the ledger sum; `noContested` turns the window into VALID, for a revocation and for a suspension; `noEvidenceRev` accepts evidence carrying a revocation before registration; `noSupersede` accepts a superseded credential.

### Sanity counterexample: the watcher stopped

With the watcher `down`, `search` finds, at depth 4 (`keriInst(down, 4)`, state 121 of 122):

1. `keri-revoke`: the body revokes a1's ECR in KERI at tick 0; the watcher never mirrors it.
2. `tick`, `tick`.
3. `register-new`: at tick 2, b1 registers r1 naming a1. The contract accepts it: on the allowlist a1 is still authorised.

At tick 2 the KERI deadline (0 + `delta`) has passed, and the verifier returns VALID for r1: check 4 sees no `AuditorRevoked` event, so nothing is CONTESTED; check 7 reads the same allowlist, and the supplier leaves the KERI revocation out of the evidence. With the watcher `late` the same path is found (136 states). This is the known limitation of T18: the property holds only under A-Watch. The LTL counterexample with the watcher `down` is the matching liveness failure: the revocation is never mirrored on-chain.

### Documented limits the model reproduces

- **Sync window (T2, T18).** With the watcher `up`, a credential registered after the KERI revocation but verified before the sync is VALID (`keriRace`: `keri-revoke`, then `register-new` in the same tick). After the sync, which A-Watch puts within `delta`, the same credential is CONTESTED (`contestedAfterKeri`), and the LTL check shows it never returns to VALID. So a VALID result obtained less than `delta` after the registration, or after a KERI revocation that the importer cannot see, can still become CONTESTED; it is final only once that time has passed.
- **On-chain sum across slots (T19 (8)).** One body registers a second 2 t credential for the same product under another slot label; the contract accepts it into a ledger of its own, and 3 t end up claimed on-chain for a product verified at 2 t. Check 4 rejects every proof of the mis-registered credential (`SCOPE_MISMATCH`), so `ledgerBad` still holds: the cap is a joint guarantee of the contract and check 4.
- **Same-block order (CR6).** A registration and the watcher's revocation in the same tick: the contract accepted the registration, so the revocation came after it, but the allowlist views at `registeredAt` answer "not authorised". The verifier treats the same-tick revocation as after the registration and reports CONTESTED.
- **Attack 4 on-chain.** The impostor body's credential is registered (the contract accepts what the allowlist lists), and no proof of it is accepted (check 7, pinned root).

The model found no violation that is not already described in SECURITY §4 and §11.

## Not covered

Everything listed under [Abstractions](#abstractions) as not modelled, and in particular: the code itself (the model is a hand-written abstraction, so a bug in `sdk/verify.ts` or the contracts that the abstraction does not mirror is not found; the Halmos checks of SECURITY §9.2 and the tests cover the code); instances larger than the bounds above (more bodies, credentials, batches, importers or ticks); `delta` other than 1 and 2; any adversary who holds a key other than the impostor body's (stolen body key, auditor key, watcher key or rotated owner key, T10, T11, T13, CR1); and every property of exported vLEI evidence beyond "ECR revoked at time k".
