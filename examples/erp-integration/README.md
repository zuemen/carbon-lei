# ERP integration example

Enterprise CBAM tools read customs and purchase data from the importer's ERP. This folder shows the same flow with CarbonLEI's REST API (`carbonlei serve`, [`sdk/server.ts`](../../sdk/server.ts)): an ERP export goes in, a CSV the ERP can import comes back. It is an example on demo data, not a connector.

**The write-back is not a CBAM Registry filing.** It is not the Registry XML and not a CBAM declaration. It is a planning aid for the person who prepares the declaration. The title row of the CSV says so.

| File | What it is |
| --- | --- |
| [`erp-export.csv`](erp-export.csv) | A sample ERP export: five import lines. All companies are fictional. The proofs are the repository's demo fixtures. |
| [`erp-sync.ts`](erp-sync.ts) | The mapping and the API client. Node ≥ 22.18 runs it as is (TypeScript type stripping). It uses no npm dependency beyond the SDK files it imports. |
| [`../../sdk/test/erp-integration.test.ts`](../../sdk/test/erp-integration.test.ts) | 8 tests: the mapping, the HMAC check, the reason codes, and the whole flow on recorded Sepolia answers (no network). The regression tests of the third review of 17 October 2026 ([`secrev3-2026-10-17.test.ts`](../../sdk/test/secrev3-2026-10-17.test.ts), [SECURITY §16](../../docs/SECURITY.md#16-third-review-of-17-october-2026-our-own-ai-run-review-not-an-external-audit)) run the same flow behind a proxy that changes the plan or replays results. |

## Run it

```bash
npm ci                    # at the repository root, once
npm run erp:example       # = node examples/erp-integration/erp-sync.ts --eori NLDEMO000000001 --year 2026 --price 82.32 --out .cache/erp-writeback.csv
node examples/erp-integration/erp-sync.ts --help
```

By default the script starts the API in its own process on 127.0.0.1 and reads Sepolia through the default RPC nodes (`--rpc` or `CARBONLEI_RPC_URL` to change them). With `--api <url>` it calls a server that is already running instead. Run on 17 October 2026 against Sepolia, the sample gave 1 line on the verified value, 3 on defaults, 1 not planned, and 591 certificates (gross). The test checks the same figures on the recorded answers.

## Flow

1. **Read the ERP export.** Columns are found by name, in any order, and other columns are ignored. Each row is checked before anything is sent, including that the plan can find a default value for its origin and CN code (one row the plan cannot resolve would otherwise make the whole `/v1/portfolio` request fail). A row that fails is written back with `ERP_ROW_INVALID` and is never sent.
2. **Map to `POST /v1/verify-batch`.** One shipment per row: `id` = `<po_number>/<po_line>`, the proof object read from the proof folder, and the ERP's own quantity, CN code, origin, date and supplier. The request also carries `nonce`, 16 random bytes made for this run.
3. **Verify.** The server verifies every proof at one pinned block (it refuses a chain head older than its head-age limit). It returns the results with the nonce inside and `binding`, an HMAC-SHA256 over the document made with its key.
4. **Check the binding.** The script recomputes the HMAC with the key it shares with the server (`CARBONLEI_API_HMAC_KEY`). If the binding is missing or wrong, it stops: the results did not come from the expected server, or they were changed on the way. It then checks that the results are for this run: the EORI it asked about (results verified for another importer are refused), its own nonce (a recorded answer replayed to a later run is refused), and `verifiedAt` within the last 10 minutes (`maxResultAgeSec`). It also checks that the results list the lines it sent, in order.
5. **Plan.** `POST /v1/portfolio` with the results unchanged and the same nonce. The server plans them only because its own binding is intact, and binds the plan too. The script checks the plan's binding, its nonce, that `resultsBinding` is the binding of the results it just checked, and that `verdictSource` says "verified by this server". Then it checks every plan line against the bound results: the plan lists exactly the lines sent, each with the verdict the results give it and the quantity sent, and a line is on the verified value only when its verdict is VALID with check 5 passed, at the intensity that verdict discloses. Any difference stops the run before anything is written.
6. **Write back.** One CSV row per ERP row, in the ERP's order, plus a total row.

## Field mapping

| ERP column | Sent to `/v1/verify-batch` as | Check before sending |
| --- | --- | --- |
| `po_number`, `po_line` | `id` = `po_number/po_line` | Both present; one PO line once per file |
| `cn_code` | `cnCode` (spaces removed) | 4, 6 or 8 digits, or a 10-digit TARIC code; the built-in Annex I table must give a value for it and the origin (a short code whose lines differ needs the longer code) |
| `country_of_origin` | `country` | ISO 3166 alpha-2 (upper-cased; `UK` is read as GB). An origin not subject to CBAM (EU member state, Iceland, Liechtenstein, Norway, Switzerland) rejects the row |
| `supplier_name` | `supplier` | None; shown in the plan's supplier groups |
| `quantity_tonnes` | `quantityTonnes` (net mass) | Positive, at most 3 decimals (kg) |
| `import_date` | `importDate` (sets the quarter and the year) | A real date, `YYYY-MM-DD` |
| `proof_file` | `proof`: the JSON of that file, or `null` | A relative name inside the proof folder (default `fixtures/`). Symbolic links are resolved; a path outside the folder or an absolute path rejects the row. A file that is missing, or is not a proof, sends the line with no proof, so it goes on the default value with that reason. |
| (command line) `--eori` | `eori`, for check 5 | Required |

The ERP's values win over the proof's in the plan. The SDK compares them with what was verified: a CN code the credential does not cover, another origin country, or more tonnes than were claimed on the ledger each put the line on the default value.

## Write-back columns

`po_number`, `po_line`, `line_id`, `cn_code`, `country_of_origin`, `quantity_tonnes`, `import_date`; then the result:

- `verdict` and `primary_code`: the verdict of the proof (VALID, INVALID, CONTESTED, INCOMPLETE, ERROR, or NONE with no proof) and its code.
- `value_used`: `verified` or `default`. The verified value is used only for a VALID proof bound to the importer's EORI by check 5; otherwise the default value with the year's mark-up.
- `see_used_tco2e_per_t`: the intensity used.
- `reason_code` and `reason`. Codes: `VERIFIED`, `NO_PROOF`, `PROOF_FILE_MISSING`, `PROOF_FILE_UNREADABLE`, `PROOF_INVALID`, `PROOF_CONTESTED`, `PROOF_INCOMPLETE`, `VERIFY_ERROR`, `NOT_BOUND_TO_IMPORTER`, `CN_MISMATCH`, `ORIGIN_MISMATCH`, `QUANTITY_EXCEEDS_CLAIM`, `RECHECK_ACTION`, `NOT_ELIGIBLE`, `EXCLUDED` (another year), `ERP_ROW_INVALID`. Each is described in `REASON_CODES` in [`erp-sync.ts`](erp-sync.ts).
- `embedded_tco2e`, and `certificates_estimate_tco2e`: the line's gross obligation in tCO2e (one certificate per tCO2e). Whole certificates are counted only on the total row (the plan rounds the total obligation up). No free-allocation adjustment is applied in this example; `carbonlei portfolio --benchmarks` shows how to add it.
- `verification_report_id`, `credential_said`, `pinned_block`: what to keep for the audit trail.

## Trust boundary

- **The API sits behind the importer's own gateway.** `carbonlei serve` has no authentication and no TLS ([OPERATE › REST API](../../docs/OPERATE.md#rest-api-carbonlei-serve-deployment-and-security)). Started by this script, it listens on 127.0.0.1 only and stops when the run ends. A server for several systems must sit behind a gateway that adds authentication, TLS and rate limits. With `--api`, the script sends `CARBONLEI_API_GATEWAY_TOKEN`, when set, as `Authorization: Bearer` for that gateway; the CarbonLEI server itself ignores it.
- **Every answer is checked, not only the verdicts.** Both API answers carry the server's HMAC, the run's nonce and the EORI; the plan also names the results it was computed from, and each verified line is compared with its bound verdict. A gateway, proxy or anyone else on the path who does not hold the key cannot change a line, drop one, or replay an earlier answer (or another importer's) without the run stopping. Before the third review of 17 October 2026 the plan was not bound and the results' EORI was not checked ([SECURITY §16](../../docs/SECURITY.md#16-third-review-of-17-october-2026-our-own-ai-run-review-not-an-external-audit), H1 and M1).
- **The HMAC key is a shared secret.** The server binds its results with `CARBONLEI_API_HMAC_KEY` (at least 32 bytes); the script needs the same key to check them. Whoever holds the key can also make a binding the server accepts. So keep the key only in the importer's own systems, like any other secret: the ERP job and the server are on the same side of the boundary. With `--api` the key is required. Without it the script makes a random key for the run and gives it to the server it starts.
- **Files.** Proofs are read only from the proof folder and evidence bundles only from the evidence folder (`--evidence-dir`, default `fixtures/`). The server never sends a transaction and holds no wallet key.
- **What the verdict means.** The same as `carbonlei verify-batch`: checks 0–8 at one block on Sepolia. A planned figure is only as good as the ERP's quantities, dates and CN codes. The ledger checks the claimed tonnes, not the goods.

## Not done

- **No SAP, Oracle or other ERP connector.** The ERP side is a CSV file in a generic shape. Mapping a real ERP's tables (purchase orders, goods receipts, customs declarations) to these columns is the integrator's work.
- **No CBAM Registry XML and no filing.** Nothing is sent to the CBAM Registry, which is not open to the public.
- **At most 50 lines per run.** That is the API's verify-batch limit (one pinned block, one plan). Larger exports must be split, and each part is then planned on its own.
- **No write-back into the ERP.** The script writes a file; importing it is up to the ERP.
- **No re-check.** A value accepted soon after registration should be re-checked once the 24-hour CONTESTED window has passed: `POST /v1/recheck` or `carbonlei recheck` ([FAQ Q30](../../docs/FAQ.md)).
- **Demo data only.** The verified line is the Sepolia demo proof; the second line is its tampered copy. Every company and person is fictional.
