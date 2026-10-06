# Local vLEI setup

This guide reproduces, on your own machine, the KERI side of CarbonLEI: a KERIA agent server with three witnesses and a schema server, the demo vLEI credential chain, the auditor's KEL anchor of a report credential, and the evidence files that verification checks 6 and 7 read. The hosted demo verifies evidence exported from such a run on 2026-10-05; this guide is how to rebuild it.

Everything here is fictional. The root of trust is a simulated GLEIF root on local test keys, not GLEIF's production root, and the LEIs use the `ZZZZ` prefix and are not registered. For how the evidence fits into the verification pipeline, see [ARCHITECTURE.md](ARCHITECTURE.md#53-verification-pipeline-sdkverifyts).

Every command below is defined in `package.json` (root) or `verifier/package.json`, or is a script in `verifier/src/` or `scripts/`. Run them from the repository root.

---

## 1. Requirements

| Requirement | Why |
|---|---|
| Docker with the Compose v2 plugin (`docker compose`) | Runs the KERI stack in `verifier/docker-compose.yaml` |
| Node.js 22 (the repository pins 22.20.0 in `.nvmrc`; `package.json` accepts `>=22 <23`) | The scripts run `.ts` files directly with `node` |
| Ports 3901, 3902 and 3903 free on 127.0.0.1 | The only ports the stack publishes |
| Foundry (`forge`, `anvil`) | Only for the local chain demo in §8 |

Install the dependencies once:

```sh
git clone --recurse-submodules https://github.com/zuemen/carbon-lei
cd carbon-lei
npm ci
```

`signify-ts` 0.4.0, the KERIA client library, is a dependency of the `verifier` workspace only.

---

## 2. What the stack runs

| Service | Image | Reachable at |
|---|---|---|
| `keria` (agent server) | `weboftrust/keria:0.4.0` | 127.0.0.1:3901 (admin), 3902 (HTTP), 3903 (boot) |
| `witness-demo` (three witnesses `wan`, `wil`, `wes`) | `weboftrust/keri:1.2.13` | Compose network only |
| `vlei-server` (official vLEI schemas plus the custom accreditation schema) | `gleif/vlei:1.0.3` | Compose network only |

- The Compose project is named `carbonlei`, with two volumes, `keria-data` and `witness-data`.
- Only KERIA is published, and only on 127.0.0.1. The witnesses and the schema server stay on the Compose network, so the stack can run next to another KERI stack that already uses ports 5642–5644 or 7723 on the host.
- The scripts reach KERIA at `http://127.0.0.1:3901` and `http://127.0.0.1:3903`; the environment variables `KERIA_ADMIN_URL` and `KERIA_BOOT_URL` override these client URLs (`verifier/src/constants.ts`). The host ports themselves are fixed in `docker-compose.yaml`.
- Every AID is created with the three witnesses and a witness threshold (`toad`) of 2.

---

## 3. Start, stop, restart

```sh
npm run vlei:up
```

This runs `docker compose -f docker-compose.yaml -p carbonlei up -d --wait` in `verifier/`, which returns once all three containers report healthy (about 17 seconds in our run). KERIA starts only after the witnesses and the schema server are healthy.

| Action | Command | State |
|---|---|---|
| Stop | `npm run -w verifier vlei:down` | Kept in the volumes |
| Restart | `docker compose -f verifier/docker-compose.yaml -p carbonlei restart` | Kept; run `vlei:status` (§5) afterwards to confirm |
| Wipe | `docker compose -f verifier/docker-compose.yaml -p carbonlei down -v` | **Dropped.** The next `vlei:setup` builds a new chain whose credential SAIDs differ from the committed evidence |

---

## 4. Build the credential chain

```sh
npm run vlei:setup
```

`verifier/src/setup.ts` creates eight agents, one AID each, and the demo credential chain. In our run it took 73.5 seconds on a fresh stack (about 75 seconds including start-up); the script prints its time and flags any run over its 150-second budget. It is idempotent: agents, AIDs, registries and credentials that already exist are reused, so a re-run only checks the chain (about 7 seconds).

| Agent | Role | LEI |
|---|---|---|
| `geda` | Simulated GLEIF root (Demo Root Authority) | — |
| `qvi` | Qualified vLEI Issuer (Demo QVI) | `ZZZZ00QVIISSRDEMO116` |
| `nab` | National accreditation body (Demo Accreditation Body) | `ZZZZ00NABACCRDEMO119` |
| `verifier` | Accredited CBAM verification body (Demo Verification GmbH) | `ZZZZ00EUVERIFDEMO152` |
| `auditor` | CBAM Lead Auditor (Lena Demo) | — |
| `supplier` | Installation operator (Demo Fasteners Co.) | `ZZZZ00TWSCREWDEMO185` |
| `importer` | CBAM declarant (Demo Imports B.V.) | `ZZZZ00EUIMPRTDEMO148` |
| `impostor` | Impostor verification body (Demo Impostor Verifier); holds no credential | `ZZZZ00FAKEVERFICT143` |

The steps, in order:

1. Connect (or boot) the eight agents and create their witnessed AIDs, in parallel.
2. Every agent resolves every other agent's OOBI and the four schemas (QVI, LE, ECR, CBAM Verifier Accreditation).
3. Create credential registries for the four issuers (`geda`, `qvi`, `nab`, `verifier`).
4. `geda` issues the QVI credential to `qvi`.
5. `qvi` issues LE vLEIs to `nab`, `verifier` and `supplier`.
6. `nab` issues the CBAM Verifier Accreditation credential to `verifier` (attributes `LEI`, `accreditationNumber`, `activity`, `cnScope` = `["7318"]`, `validUntil`; edge `nab` to the NAB's own LE vLEI). In parallel, `verifier` issues the ECR to `auditor` in privacy mode (`engagementContextRole` = `CBAM Lead Auditor`; edge `le` to the body's LE vLEI).
7. The holders present every credential to `importer` (IPEX grant and admit), parents first.
8. Confirm that `impostor` holds no credential.

```
geda --QVI--> qvi --LE--> nab ------Accreditation--> verifier --ECR--> auditor
                   \--LE--> verifier                    (CBAM Lead Auditor)
                   \--LE--> supplier
impostor: an AID with no credentials
```

Outputs:

| File | Content | In git |
|---|---|---|
| `fixtures/vlei.json` | Stack versions, witnesses, the trust anchor (the `geda` AID), schema SAIDs, every agent's AID and OOBI, every credential's SAID, issuer, issuee and edge, and `impostorCredentials: 0`. No secrets. | Yes |
| `verifier/.data/state.json` | The agents' passcodes, saved before anything is created so that an interrupted run can resume | No (git-ignored) |

The committed run produced these credentials (schema SAIDs: QVI `EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao`, LE `ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY`, ECR `EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw`, accreditation `EIyPVSpzpiV8PXfxjAhPdESlnvpUGZtBLeZ1jaoVRt8G`):

| Credential | Issuer → issuee | SAID |
|---|---|---|
| QVI | `geda` → `qvi` | `EAK_NBUr6LeB8DFkLPMv0cJyvF_ckjr-rJEPWxnKH_gm` |
| LE (NAB) | `qvi` → `nab` | `EGh9pElHjo-eBi0IQsn77dwNBj9dzjzBZjIuG4XSpKZ3` |
| LE (verification body) | `qvi` → `verifier` | `EF7MIyN2Gwo4vxzSGMhkBsqRcak62_9W45XARjVxtAas` |
| LE (supplier) | `qvi` → `supplier` | `EPk_jUxG4uuO-argTcGs4tpjYk6yJZKoZaBf88RGrD8b` |
| CBAM Verifier Accreditation | `nab` → `verifier` | `EFNX1xtexKD7MfhPZf3fVQAZvRZXvwO9tTw-W_iLXZJC` |
| ECR (CBAM Lead Auditor) | `verifier` → `auditor` | `ELKomHMFqcJ-Gjt5uDRbe1MztQWaX0MyuwSC6I4B32qN` |

The accreditation schema is `verifier/schemas/cbam-verifier-accreditation.json` ("CBAM Verifier Accreditation Credential (demo)"), served by the schema server next to the official vLEI schemas. `npm run -w verifier vlei:schema` rebuilds it from `verifier/scripts/build-schema.ts`; run it only if you change the schema, because its SAID, and every accreditation credential's schema reference, changes with it.

---

## 5. Check the stack

```sh
npm run -w verifier vlei:status
```

`verifier/src/status.ts` is read-only. It reconnects all eight agents with the passcodes in `verifier/.data/state.json` and checks that:

- every AID equals the one in `fixtures/vlei.json` (it prints each AID with its sequence number and witness count);
- every credential is held by its issuee and was presented to `importer`, and each chained credential's edge points to its parent;
- the importer, querying the witnesses, sees the auditor's latest key state at the auditor's own sequence number (so the witnesses kept the auditor's KEL);
- `impostor` holds no credential.

It ends with `OK: all AIDs and credentials present`, or prints `FAIL` with the list of problems and exits with code 1. Run it after a restart to confirm that no state was lost.

---

## 6. Export the evidence

```sh
npm run -w verifier vlei:export
node verifier/src/build-authority-bundle.ts
```

`verifier/src/export-evidence.ts` writes, to `fixtures/evidence/`, the CESR stream of each credential as its holder's agent serves it (including the issuer KEL and TEL events and the chained sources), the KEL of every issuing or anchoring AID, and `index.json` with each file's size and sha256. It notes files over 20 KB: the accreditation and ECR streams are about 22 KB because they carry the whole upstream KEL and TEL; that is expected.

`verifier/src/build-authority-bundle.ts` then packs the trust anchor, the accreditation schema SAID and five of the CESR streams (QVI, the body's LE, the NAB's LE, accreditation, ECR) into `fixtures/evidence/authority-bundle.json`, the input of check 7. Run it after every export.

---

## 7. Anchor a report credential

```sh
npm run -w verifier vlei:anchor -- <credSAID>
```

`verifier/src/anchor.ts` makes the auditor's agent create a KEL interaction event whose seal is `{ d: credSAID }`, and prints `{ credSAID, aid, kelSeq, eventSAID }`. `credSAID` must be a 44-character CESR Blake3 SAID starting with `E`. If the credential is already anchored, the existing event is exported and no new event is created; add `--force` to anchor it again.

It writes `fixtures/evidence/anchor-<credSAID>.json`: the raw event, its controller signatures, the signing keys, the signing threshold, the establishment event's sequence number and SAID, the KEL attachment, and the results of its own checks (SAID recomputed, size matches the version string, Ed25519 signature valid, event equals the one submitted). If any of those checks fails, it exits with code 1.

`kelSeq` is the event's sequence number and goes into `registerReport`. `scripts/demo-scenario.ts` takes it from `--kel-seq <n>`, otherwise from `fixtures/evidence/anchor-<credSAID>.json`, otherwise, on a local chain only, uses 1. The Sepolia demo credential `ELXG3ZjKZ5rsmJ8WljbM2vW2PJL9FesRnlVgh0hVTZvx` is anchored at `kelSeq` 3.

---

## 8. Onboarding check and local chain demo

**Onboarding check.** Before the allowlist owner key adds a verification body and its auditor to the allowlist, the vLEI chain is checked off-chain:

```sh
node verifier/src/onboard-check.ts
node verifier/src/onboard-check.ts impostor
```

The first command (argument `body`, the default) runs the check 7 logic (`verifyAuthority` in `sdk/vlei.ts`) on the exported evidence in `fixtures/evidence/` and prints `OK` with the five hashes that go on-chain: `leiHash`, `leCredSaidHash`, `accreditationSaidHash` (for `addVerifier`), and `auditorAidHash`, `ecrSaidHash` (for `addAuditor`). The second prints `REFUSED: not added to the allowlist` for the impostor, which holds no credential, and exits with code 1; that refusal is the expected result. Neither command needs the KERI stack to be running.

**Local chain demo.**

```sh
forge build
npm run demo:local
npm run dev -w demo
```

`forge build` compiles the contracts into `contracts/out/`, which the scenario reads to deploy them. `npm run demo:local` (`scripts/demo-local.ts`) starts `anvil` on port 8545 (or reuses one already running there, if it is an anvil chain), deploys the contracts if they are missing, runs the scenario (add the verification body and the auditor, register report 1, claim a shipment), moves the chain 25 hours ahead, syncs the auditor's revocation, sends attack 3, and builds `demo/public/demo-data.json`. It ends with an acceptance summary (checks 0–5 pass, the two dry runs revert with `BatchAlreadyClaimed` and `ExceedsVerifiedTonnage`, attack 3 reverted, 300 t remaining) and leaves `anvil` running, printing its process ID and how to stop it. Use `npm run demo:local -- --port <port>` for another port. `npm run dev -w demo` then serves the page against the local chain.

`npm run demo:local` reads `fixtures/vlei.json` and `fixtures/evidence/`; it does not need the KERI stack to be running.

**Revocation and the watcher.** These need the stack running.

```sh
npm run vlei:watch -- --once         # one poll: issuance seal found, no revocation yet
npm run vlei:revoke                  # dry run: prints what it would revoke
npm run vlei:revoke -- --confirm     # revokes the auditor's ECR as the verification body
npm run vlei:watch:sepolia           # polls every 15 s; on detection sends revokeAuditor on Sepolia
```

`vlei:revoke` (`verifier/src/revoke-ecr.ts`) makes the verification body's agent revoke the ECR: a TEL `rev` event and an interaction event in the body's KEL with the seal `{ i: <ECR SAID>, s: "1" }`. It is a dry run unless `--confirm` is given, and `--confirm` is refused before 24 hours after the Sepolia report registration (`--not-before none` lifts this on a local run). Revocation cannot be undone; the auditor would need a new AID and a new ECR.

`vlei:watch` (`verifier/src/watch.ts`) does not trust a local credential status. Each poll, the importer's agent asks the witnesses for the body's key state and scans the body's KEL for that seal, and re-checks the event's SAID, prior link and signature. On detection it writes `fixtures/evidence/revocation-<ECR SAID>.json` (detection time, sequence number, raw event) and, only with `--send`, runs the `revokeAuditor` step of `scripts/demo-scenario.ts` with the WATCHER key (three attempts at most). `vlei:watch:sepolia` reads `WATCHER_PRIVATE_KEY` and `SEPOLIA_RPC_URL` from `.env`.

**Attack 4: the impostor's own chain.** Attack 4 needs a vLEI chain that is well formed but leads to a root the impostor controls. With the stack running:

```sh
npm run vlei:impostor:setup     # five new agents and their chain; writes fixtures/vlei-impostor.json
npm run vlei:impostor:export    # CESR streams, KELs, index.json, authority-bundle.json -> fixtures/evidence/impostor/
npm run vlei:impostor:anchor    # anchors the impostor's credential in its auditor's KEL
```

`verifier/src/setup-impostor.ts` creates five new agents, all fictional: Self-Made Root, Self-Made QVI, Self-Made Accreditation Body, the impostor body (Demo Impostor Verifier) and its auditor. Self-Made Root issues the QVI credential; Self-Made QVI issues LE vLEIs to the accreditation body and the impostor body; the accreditation body issues the CBAM accreditation (CN 7318) to the impostor body, which issues the ECR (`CBAM Lead Auditor`) to its auditor. Their passcodes go to a private state file, `verifier/.data/state-impostor.json` (git-ignored); the eight demo agents, `verifier/.data/state.json` and `fixtures/vlei.json` are not written, and the script refuses AIDs shared with the demo agents. In our run on 2026-10-05 the setup took 37.3 seconds. `export` writes `fixtures/evidence/impostor/` and then runs check 7 on it twice: it must pass with the impostor's own root configured and fail with the pinned demo root. `anchor` takes the `credSAID` from `fixtures/sepolia-credential-impostor.json`, written by the `impostorIssue` step of `scripts/demo-scenario.ts` (the order of the attack 4 steps is in that script's header), and writes `fixtures/evidence/impostor/anchor-<credSAID>.json`. Without KERIA, `scripts/demo-scenario.ts --network local --synthetic-impostor` generates a synthetic chain in `fixtures/local-impostor/` (git-ignored); it is refused on Sepolia.

---

## 9. Evidence files

`fixtures/evidence/` (all files tracked in git; the committed set was exported on 2026-10-05):

| File | Content | Used by |
|---|---|---|
| `cred-qvi.cesr` | QVI credential, with the root's KEL and the issuance TEL | Check 7, onboarding check |
| `cred-le-verifier.cesr` | The verification body's LE vLEI | Check 7, onboarding check |
| `cred-le-nab.cesr` | The NAB's LE vLEI | Check 7, onboarding check |
| `cred-le-supplier.cesr` | The supplier's LE vLEI (optional; no check uses it) | — |
| `cred-accreditation.cesr` | CBAM Verifier Accreditation credential, NAB to body | Check 7, onboarding check |
| `cred-ecr.cesr` | The auditor's ECR, body to auditor; also carries the auditor's inception event | Check 7, onboarding check; check 6 (the inception event binds the signing key to the AID) |
| `kel-geda.json`, `kel-qvi.json`, `kel-nab.json`, `kel-verifier.json`, `kel-auditor.json` | The KEL of each issuing or anchoring AID, as KERIA serves it | Published for inspection |
| `index.json` | Export time; for each credential file its SAID, schema, issuer and issuee; for each KEL file its AID and event count; every file's size and sha256 | `scripts/build-demo-data.ts` |
| `authority-bundle.json` | Trust anchor, accreditation schema SAID and the five CESR streams check 7 reads | Check 7 (the proof carries its sha256) |
| `anchor-ELXG3ZjKZ5rsmJ8WljbM2vW2PJL9FesRnlVgh0hVTZvx.json` | The auditor's KEL event anchoring the Sepolia demo credential, `kelSeq` 3 | Check 6; `kelSeq` for the scenario |
| `anchor-EL2PgLIfKJDQ3agamrlTAuMbPOjl7otkRbcxruF-ZBK5.json` | The anchor of the credential used by the earlier deployment (`fixtures/archive/`), `kelSeq` 2 | Archive |

`fixtures/evidence/impostor/` holds the same kinds of files for attack 4 (five CESR streams, the KELs of the five impostor agents, `index.json`, `authority-bundle.json` and the anchor of the impostor's credential), exported on 2026-10-05.

The hosted page serves a copy in `demo/public/evidence/`, which `scripts/build-demo-data.ts` regenerates from `fixtures/evidence/` (keeping only the anchors of the demo credentials).

---

## 10. Common problems

- **Agent OOBIs come back empty.** The KERIA `--name` must equal the `keria` section of `verifier/config/keria.json`; otherwise the agent's `curls` are never loaded. The Compose file already starts KERIA with `--name keria`; keep the two in step if you edit either.
- **Witness health checks fail on `localhost`.** The witnesses listen on IPv4 only, and `localhost` can resolve to `::1`. The health checks use `127.0.0.1`.
- **Witnesses publish no endpoints, or empty witness configs appear in the repository.** The image ships empty witness configs, so `verifier/config/witness-demo/` provides `wan.json`, `wil.json` and `wes.json`. They are mounted file by file because `witness demo` also creates empty configs for `wit`, `wub` and `wyz`, which must stay inside the container.
- **`no verifier/.data/state.json; run "npm run vlei:setup" first`.** `vlei:status`, `vlei:export` and `vlei:anchor` reconnect to the agents with the passcodes that `vlei:setup` saved. Keep that file; without it the agents on the stack cannot be reached.
- **An operation times out.** Every KERIA long-running operation is awaited for at most 60 seconds (`OP_TIMEOUT_MS` in `verifier/src/keri.ts`). Check that the stack is up and healthy (`npm run vlei:up` waits for health), then re-run: `vlei:setup` resumes where it stopped.
- **Parsing controller signatures from a KEL attachment.** The group counter is `-A` followed by a two-character count, not `-AA`. `controllerSigs` in `verifier/src/anchor.ts` reads it this way.
- **Writing your own signify-ts script.** Await `ready()` before calling `randomPasscode()`; `setup.ts` does this.
- **The accreditation schema SAID changed.** Key order is part of every SAID, so `verifier/schemas/cbam-verifier-accreditation.json` must not be reformatted after `vlei:schema` writes it.
- **Re-running the chain changes tracked files.** `vlei:setup`, `vlei:export`, `build-authority-bundle.ts` and `vlei:anchor` overwrite `fixtures/vlei.json` and files in `fixtures/evidence/`. A chain built on a new stack has new credential SAIDs, which no longer match the evidence hashes on the Sepolia allowlist, so check 7 against Sepolia would fail with that evidence. Use `git diff fixtures/` to see what changed and `git restore fixtures/` to return to the committed evidence.
- **`npm run demo:local` rewrites `demo/public/demo-data.json`** with local data. `npm run demo:data:sepolia` rebuilds the Sepolia version.
- **`anvil did not start (is Foundry on PATH?)`**, or the port answers with another chain ID: `demo:local` only reuses an anvil chain (chain ID 31337) on its port.
- **A local credential names another auditor and is already registered on the local chain.** The scenario stops with a message to stop `anvil` and delete `fixtures/local-*.json` to start over.
