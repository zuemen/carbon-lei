// carbonlei CLI: issue, present, present-batch, allocate, verify, verify-batch, portfolio, recheck, audit-pack,
// verify-pack, serve, export-pact, export-communication, import-template.
// Run with Node 22: node sdk/cli.ts <command> [options]
// The CLI never sends transactions; registration and claims are sent by the wallets that own them.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ChainReader, rpcUrlsFrom, type Deployment } from "./chain.ts";
import { newSalt, sha256Hex } from "./encoding.ts";
import type { CredentialClaims, Hex } from "./credential.ts";
import type { Presentation } from "./disclosure.ts";
import { DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "./issue.ts";
import { exportPactFromProof } from "./pact.ts";
import { communicationCsv } from "./communication.ts";
import { verifyPresentation } from "./verify.ts";
import { EXIT, exitCodeOf, verdictError, verdictFor } from "./verdict.ts";
import { disclosureSummary } from "./summary.ts";
import {
  batchDocument,
  batchExitCode,
  DEFAULT_CONCURRENCY,
  loadBatchInput,
  printBatch,
  pinnedToHead,
  printPortfolio,
  proofShipmentOf,
  readMap,
  runLimited,
  shipmentsFromBatch,
  type BatchDocument,
  type BatchResult,
} from "./batch.ts";
import { buildPortfolio, worksheetCsv } from "./portfolio.ts";
import { loadRecords } from "./recheck-files.ts";
import { applyRecheck, postWebhook, printRecheck, recheckExitCode, recheckRecords, webhookPayload, type RecheckDocument } from "./recheck.ts";
import { createAuditPack, printVerifyPack, verifyPackExitCode, verifyPackOffline, verifyPackOnChain } from "./audit-pack.ts";
import { createApiServer, DEFAULTS as SERVE_DEFAULTS, isLoopback } from "./server.ts";
import { vleiCheckers } from "./checkers.ts";
import type { AccreditationRegistry } from "./verification-rules.ts";
import { check8HiddenFields, extractShapeProblem, pickReconciledClaims, runRules, type ReportExtract } from "./consistency.ts";
import type { PrecursorReport } from "./precursor.ts";
import { art9Text, carbonPriceLines } from "./carbonprice.ts";
import { basename, dirname, resolve } from "node:path";
import { allocationExitCode, buildSharePack, printAllocation, readAllocationSnapshot, reconcile, reportRefOf } from "./allocation.ts";
import { evidenceFrom, loadBook, writeSharePack } from "./allocation-files.ts";
import {
  draftCredentialFields,
  MAX_TEMPLATE_BYTES,
  parseTemplate,
  TemplateError,
  type CredentialDraft,
  type ParsedTemplate,
} from "./template.ts";

const USAGE = `carbonlei <command> [options]

  issue        --claims <claims.json> --auditor-aid <AID> --supplier <0x…> [--kel-seq <n>] [--supersedes <0x…>]
               [--out <credential.json>]            signs with VERIFIER_PRIVATE_KEY (EIP-712)
  present      --credential <credential.json> [--fields a,b,…] [--batch-id <id> --quantity <t>
               --shipment-date <YYYY-MM-DD> [--importer-salt <0x…>]] [--out <proof.json>] [--allow-incomplete]
                                                    refuses --fields that hide a field check 8 needs (the proof would
                                                    verify INCOMPLETE), unless --allow-incomplete (then it warns)
  present-batch <book.json> --out <dir> [--credential <credential.json>] [--evidence-from <proof.json>] [--check]
               [--allow-incomplete] [--json] [--rpc <url>] [--deployment <file>]
                                                    one proof per claimed batch of the allocation book, each with
                                                    its buyer's fields, and share-pack.json (no EORI, no salt).
                                                    --check reconciles with the registry first and writes only the
                                                    batches whose claim matches. A batch whose fields hide one check 8
                                                    needs is skipped (its proof would verify INCOMPLETE), unless
                                                    --allow-incomplete (then written, with a warning). Exit 0 if a
                                                    proof was written, 1 if none, 3 if --check could not read the
                                                    registry
  allocate     <book.json> [--credential <credential.json>] [--json] [--out <report.json>] [--no-events]
               [--from-block <n>] [--rpc <url>] [--deployment <file>]
                                                    reconciles the supplier's allocation book with the registry at
                                                    one pinned block: per-importer tonnes, remaining tonnes, missing
                                                    or mismatched claims, planned batches the contract would refuse,
                                                    on-chain claims not in the book, and the share-pack plan.
                                                    Exit 0 if nothing needs action, 1 if something does, 3 if the
                                                    reconciliation could not run
  verify       --proof <proof.json> [--rpc <url>] [--deployment <file>]
                                                    RPC: --rpc, else CARBONLEI_RPC_URL (comma-separated URLs), else
                                                    the public Sepolia nodes; each request times out after 8 s
               [--eori <EORI>]                      your EORI: binds the shipment to you (check 5); only then is
                                                    the report judged at the shipment's claim time
               [--trust-anchor <AID>]               root of trust for check 7 (default: the demo root)
               [--precursor-trust-anchor <AID>]     root of trust for check 7 of the precursor tiers (check 9;
                                                    default: --trust-anchor)
               [--max-head-age <s>]                 refuse an RPC whose latest block is older (default 300 on Sepolia)
               [--accreditation-registry <file>]    the allowlist operator's accreditation records (e.g.
                                                    fixtures/accreditation-registry.json): check 8 adds the
                                                    verifier's provenance sub-rules
               [--json]                             print the verdict as JSON (docs/schemas/verdict.schema.json);
                                                    exit 0 VALID, 1 INVALID, 2 CONTESTED, 3 error, 4 INCOMPLETE
               [--expect-invalid <CODE>]            exit 0 only if the proof is INVALID with a check failing on CODE
  verify-batch <folder | manifest.json> [--eori <EORI>] [--concurrency <1-4>] [--out <results.json>] [--json]
               [--rpc <url>] [--deployment <file>] [--trust-anchor <AID>] [--max-head-age <s>]
                                                    verifies many proofs (a folder of proof files, or a manifest
                                                    listing proofs with net mass, CN code, origin and import date);
                                                    every proof is read at one pinned block; default concurrency 2.
                                                    Exit 3 if a verification could not run, else 1 if any INVALID,
                                                    2 if any CONTESTED, 4 if any INCOMPLETE, else 0
  portfolio    <results.json> --year <YYYY> [--price <EUR>] [--csv <worksheet.csv>] [--json] [--out <summary.json>]
               [--defaults <map.json>] [--benchmarks <map.json>]
                                                    declaration plan from verify-batch results: verified value only
                                                    when VALID and bound by check 5, else the default with the year's
                                                    mark-up; totals, 50 t de minimis, quarterly holding, certificates,
                                                    gross EUR; --benchmarks deducts the free-allocation adjustment
                                                    (docs/OPERATE.md). The CSV is a worksheet, not the Registry XML.
                                                    Defaults: Annex I of IR (EU) 2026/1740 for every listed country
                                                    and CN code is built in; --defaults ({"VN:7318": "3.000"}) wins
               [--art9-ref-price <EUR>]             adds the carbon price deduction of check 10 (DRAFT Art 9
                                                    rules, not adopted: illustrative), apart from the totals
               [--recheck <recheck.json>]           a line a later re-check says needs action is planned on the default
  recheck      <records-folder | record.json | results.json> [--json] [--out <recheck.json>] [--webhook <URL>]
               [--proofs <folder>] [--window <hours>] [--concurrency <1-4>] [--rpc <url>] [--deployment <file>]
               [--trust-anchor <AID>] [--max-head-age <s>]
                                                    re-verifies values you accepted earlier (Buyer-tab records,
                                                    verify-batch results) at one pinned block and says what changed:
                                                    revoked, superseded, CONTESTED, claim gone, window closed.
                                                    Exit 3 if a record could not be re-checked, else 1 if any needs
                                                    action, else 0. --webhook (or CARBONLEI_RECHECK_WEBHOOK_URL) POSTs
                                                    the changed lines only, without EORI; schema docs/schemas/recheck.schema.json
  audit-pack   <results.json> --out <dir> [--year <YYYY>] [--recheck <recheck.json>] [--portfolio <summary.json>]
               [--csv <worksheet.csv>] [--proofs <folder>] [--proofs-root <folder>] [--block-hash <0x…>] [--json]
               [--rpc <url>] [--deployment <file>]
                                                    writes the year's audit evidence pack to a new folder: the results,
                                                    every proof a line was verified from (its bytes must hash to the
                                                    line's proofSha256), their evidence, chain ID, contract addresses,
                                                    the pinned block and its hash (read once from the RPC unless
                                                    --block-hash), tool, import year and the retention date (31 Dec of
                                                    year + 5: Reg. (EU) 2023/956 Art 7(6)), lines.csv, README.txt and
                                                    manifest.json (SHA-256 and size of every file). Proof names are
                                                    relative to --proofs (default: the results file's folder) and must
                                                    stay inside --proofs-root (default: --proofs). Not a signature, not
                                                    a legal opinion, not a Registry submission
  verify-pack  <dir> [--offline] [--expect-manifest <sha256>] [--json] [--concurrency <1-4>] [--rpc <url>]
               [--deployment <file>]
                                                    recomputes every hash of an audit pack (missing, extra, changed
                                                    files, links, ../ paths are failures); unless --offline, confirms
                                                    the pinned block's hash and re-verifies every proof at that block:
                                                    MATCH or DIFFERS per line. Exit 1 on any change or difference,
                                                    else 3 if a re-verification could not run, else 0
  serve        [--port 8787] [--host 127.0.0.1] [--cors-origin <origin>] [--evidence-dir <dir>] [--max-body <bytes>]
               [--timeout <s>] [--body-timeout <s>] [--max-concurrent <n>] [--rpc <url>] [--deployment <file>]
               [--trust-anchor <AID>]
                                                    REST API (docs/schemas/openapi.json): POST /v1/verify, /v1/verify-batch,
                                                    /v1/portfolio, /v1/recheck; GET /v1/health; GET / and
                                                    /v1/openapi.json return the OpenAPI document. NO authentication: keep it
                                                    on 127.0.0.1 or behind your own gateway (docs/OPERATE.md).
                                                    /v1/portfolio plans only results this server bound with its HMAC key
                                                    (CARBONLEI_API_HMAC_KEY, else a key generated per process)
  export-pact  --proof <proof.json> --eori <EORI> --company-name <name> --product-name <name> --product-id <id>
               --product-description <text> [--rpc <url>] [--deployment <file>] [--trust-anchor <AID>]
               [--precursor-trust-anchor <AID>] [--max-head-age <s>] [--out <pact.json>]
                                                    verifies the proof first, with check 5 for your EORI: checks
                                                    0-8, plus 9 and 10 when it carries a precursor or carbon-price
                                                    statement
  export-communication <proof.json> --eori <EORI> [--out <communication.csv>] [--rpc <url>] [--deployment <file>]
               [--trust-anchor <AID>] [--precursor-trust-anchor <AID>] [--max-head-age <s>]
                                                    verifies the proof first (as verify --eori); only a VALID result
                                                    is exported: a CSV of the Summary_Communication fields of the
                                                    Commission's communication template v2.1.1, in template order,
                                                    with value, source and status (from verified proof, hidden by
                                                    supplier, not held). Not validated by the Commission, not a
                                                    Registry submission; for any other result nothing is written
  import-template <file.xlsx> [--product N] [--out <draft.json>]
               reads a filled CBAM Communication Template (V2.1 or V2.1.1) and prints a draft of the
               credential fields it can fill; the rest is left to the supplier and the verification body
`;

function printTemplate(t: ParsedTemplate, d: CredentialDraft, n: number): string {
  const L: string[] = [];
  L.push(`CBAM Communication Template v${t.templateVersion} (${t.templateVersionDate ?? "date not listed"})  sha256 ${t.sha256}`);
  L.push(`Installation   ${t.installation.name} · ${[t.installation.city, t.installation.country].filter(Boolean).join(", ")} · UN/LOCODE ${t.installation.unLocode ?? "—"}`);
  L.push(`Period         ${t.reportingPeriod.start} to ${t.reportingPeriod.end}`);
  L.push(`Verifier       ${t.verifier.name ?? "blank (optional in the transitional period)"}`);
  L.push(`Products       ${t.products.length}`);
  t.products.forEach((p, i) =>
    L.push(
      `  ${i + 1}${i + 1 === n ? "*" : " "} row ${p.row}  CN ${p.cnCode}  ${p.productName ?? ""}  SEE direct ${p.seeDirect} · indirect ${p.seeIndirect} · total ${p.seeTotal} tCO2e/t`,
    ),
  );
  L.push("", `Credential field draft for product ${n} (CN ${d.product.cnCode}):`);
  const w = Math.max(...d.rows.map((r) => r.field.length));
  for (const r of d.rows) L.push(`  ${r.field.padEnd(w)}  ${r.value}   ← ${r.source}  (${r.rule})`);
  for (const by of ["supplier", "verification body"] as const) {
    const list = d.toBeSupplied.filter((s) => s.by === by);
    L.push("", `Still to be supplied by the ${by} (${list.length}):`);
    for (const s of list) L.push(`  ${s.field} — ${s.reason}`);
  }
  if (t.warnings.length) {
    L.push("", `Warnings (${t.warnings.length}):`);
    for (const w of t.warnings) L.push(`  ${w}`);
  }
  L.push("", `Set by the SDK at issuance: ${d.setAtIssuance.join(", ")}`);
  L.push("This is a draft from the operator's template, not verified data.");
  return L.join("\n");
}

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string | undefined, data: unknown) =>
  path ? writeFileSync(path, json(data) + "\n") : process.stdout.write(json(data) + "\n");

function reader(values: Record<string, unknown>): ChainReader {
  const deployment = readJson(
    (values.deployment as string) ?? fileURLToPath(new URL("../contracts/deployments/11155111.json", import.meta.url)),
  ) as Deployment;
  // `--rpc`, else CARBONLEI_RPC_URL (one URL or a comma-separated list), else the default list (SEPOLIA_RPCS).
  const { urls } = rpcUrlsFrom(values.rpc as string | undefined, process.env.CARBONLEI_RPC_URL);
  return ChainReader.forRpc(deployment, urls, sepolia);
}

/** Longest a command waits for the RPC nodes in all (each request to one node times out after 8 s). */
const RPC_DEADLINE_SEC = 60;

/** `p`, or an error once the RPC nodes have taken `RPC_DEADLINE_SEC` in all. */
function withinDeadline<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the RPC nodes did not answer within ${RPC_DEADLINE_SEC} s in all; try again or use another RPC (--rpc <url> or CARBONLEI_RPC_URL)`)),
      RPC_DEADLINE_SEC * 1000,
    );
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Reads an evidence bundle a proof refers to: relative to the proof file, then to the demo's public folder. */
function bundleLoader(proofPath: string) {
  return async (p: string) => {
    for (const base of [dirname(proofPath), fileURLToPath(new URL("../demo/public/", import.meta.url))]) {
      try {
        return readFileSync(resolve(base, p), "utf8");
      } catch {}
    }
    throw new Error(`evidence file ${p} not found`);
  };
}

/** `--max-head-age` in seconds, or undefined for the chain's default. */
function maxHeadAge(values: Record<string, unknown>): number | undefined {
  const v = values["max-head-age"] as string | undefined;
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || Number.isNaN(n) || n < 0) throw new Error(`--max-head-age must be a number of seconds ≥ 0, got ${v}`);
  return n;
}

/** Check 9's breakdown as indented lines under the check list (one per precursor, then the mass balance). */
function precursorLines(p: PrecursorReport, indent = "      "): string[] {
  const out: string[] = [];
  out.push(`${indent}direct (own process) ${p.attributedDirect ?? "?"} tCO2e/t${p.signed ? "" : " — statement not signed into this credential"}`);
  for (const l of p.lines) {
    const who = l.source === "default" ? "default value" : `${l.producer?.lei ?? "producer"} ${l.credSAID ?? ""}, batch ${l.batchId ?? "?"}${l.claimedTonnes ? `, ${l.claimedTonnes} t claimed for this maker (${l.neededTonnes} t needed)` : ""}`;
    out.push(`${indent}+ CN ${l.cnCode}: ${l.massPerTonne} t/t × ${l.see ?? "?"} = ${l.contribution ?? "?"} tCO2e/t  [${l.status.toUpperCase()}${l.code ? ` ${l.code}` : ""}] ${who}${l.verification ? `; its proof: ${l.verification.overall}${l.verification.primaryCode ? ` (${l.verification.primaryCode})` : ""}` : ""}`);
  }
  out.push(`${indent}= ${p.recomputed ?? "?"} recomputed vs ${p.declared ?? "?"} declared (tolerance ${p.tolerance})`);
  return out;
}

/** Summary note for a check 8 warning, with the number of reconciliation rules the received extract fails. */
function advisoryNote(proof: Presentation, disclosed: Record<string, string>, code: string): string {
  const claims = pickReconciledClaims(disclosed);
  const n = claims && proof.reportExtract && !extractShapeProblem(proof.reportExtract) ? runRules(proof.reportExtract as unknown as ReportExtract, claims).filter((f) => !f.ok).length : 0;
  const rules = `${n} rule${n === 1 ? "" : "s"}`;
  return code === "CONSISTENCY_WARNING/PROOF_MISMATCH"
    ? `the unsigned report extract differs from the signed credential (${rules})`
    : `the auditor-signed reconciliation is flagged by ${rules}; needs human review`;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      product: { type: "string", default: "1" },
      claims: { type: "string" },
      "auditor-aid": { type: "string" },
      supplier: { type: "string" },
      "kel-seq": { type: "string", default: "0" },
      supersedes: { type: "string" },
      credential: { type: "string" },
      fields: { type: "string" },
      "batch-id": { type: "string" },
      quantity: { type: "string" },
      "shipment-date": { type: "string" },
      "importer-salt": { type: "string" },
      proof: { type: "string" },
      eori: { type: "string" },
      rpc: { type: "string" },
      deployment: { type: "string" },
      "company-name": { type: "string" },
      "product-name": { type: "string" },
      "product-id": { type: "string" },
      "product-description": { type: "string" },
      out: { type: "string" },
      "expect-invalid": { type: "string" },
      "trust-anchor": { type: "string" },
      "precursor-trust-anchor": { type: "string" },
      "accreditation-registry": { type: "string" },
      "max-head-age": { type: "string" },
      json: { type: "boolean", default: false },
      concurrency: { type: "string" },
      year: { type: "string" },
      price: { type: "string" },
      csv: { type: "string" },
      defaults: { type: "string" },
      benchmarks: { type: "string" },
      recheck: { type: "string" },
      webhook: { type: "string" },
      proofs: { type: "string" },
      window: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "cors-origin": { type: "string" },
      "evidence-dir": { type: "string" },
      "max-body": { type: "string" },
      "body-timeout": { type: "string" },
      timeout: { type: "string" },
      "max-concurrent": { type: "string" },
      "art9-ref-price": { type: "string" },
      "no-events": { type: "boolean", default: false },
      "from-block": { type: "string" },
      "evidence-from": { type: "string" },
      check: { type: "boolean", default: false },
      "allow-incomplete": { type: "boolean", default: false },
      portfolio: { type: "string" },
      "proofs-root": { type: "string" },
      "block-hash": { type: "string" },
      offline: { type: "boolean", default: false },
      "expect-manifest": { type: "string" },
    },
  });

  switch (command) {
    case "issue": {
      const key = process.env.VERIFIER_PRIVATE_KEY as Hex | undefined;
      if (!key) throw new Error("VERIFIER_PRIVATE_KEY is not set");
      const deployment = reader(values);
      const claims = readJson(values.claims as string) as CredentialClaims;
      const signer = privateKeyToAccount(key);
      const binding = await deployment.addressBinding(signer.address);
      const institution = binding.leiHash === `0x${"0".repeat(64)}` ? undefined : await deployment.institution(binding.leiHash);
      const cred = await issueCredential({
        claims,
        auditorAID: values["auditor-aid"] as string,
        signer,
        registry: deployment.registry,
        chainId: await deployment.client.getChainId(),
        accreditedUntil: institution?.accreditedUntil,
      });
      const reportInput = reportInputOf(cred, {
        supplier: values.supplier as Hex,
        kelSeq: BigInt(values["kel-seq"] as string),
        supersedes: values.supersedes as Hex | undefined,
      });
      write(values.out, { credential: cred, reportInput });
      return 0;
    }
    case "present": {
      const file = readJson(values.credential as string);
      const cred = (file.credential ?? file) as SignedCredential;
      const fields = values.fields ? (values.fields as string).split(",") : [...DEMO_DISCLOSURE];
      const hidden = check8HiddenFields(cred.core ?? JSON.parse(cred.coreJson), fields);
      if (hidden.length) {
        const msg = `the proof hides ${hidden.join(", ")}, which check 8 needs (the credential commits to a signed reconciliation): the buyer's verifier will return Not verified (INCOMPLETE)`;
        if (!values["allow-incomplete"]) throw new Error(`${msg}; add the fields to --fields or pass --allow-incomplete`);
        console.error(`warning: ${msg}`);
      }
      const shipment = values["batch-id"]
        ? {
            batchId: values["batch-id"] as string,
            quantityTonnes: values.quantity as string,
            shipmentDate: values["shipment-date"] as string,
            importerSalt: ((values["importer-salt"] as string) ?? newSalt()) as Hex,
          }
        : undefined;
      write(values.out, present(cred, fields, shipment));
      return 0;
    }
    case "allocate": {
      const target = positionals[0];
      if (!target) throw new Error("usage: carbonlei allocate <book.json> [--credential <credential.json>] [--json]");
      // Exit 3 for any failure (bad book, unreadable credential, RPC), so a script can tell it from "needs action" (1).
      try {
        const { book, cred } = loadBook(target, values.credential as string | undefined);
        const ref = reportRefOf(cred);
        const fromBlock = values["from-block"] === undefined ? undefined : BigInt(values["from-block"] as string);
        const snap = await withinDeadline(readAllocationSnapshot(reader(values), book, ref, { events: !values["no-events"], fromBlock }));
        const report = reconcile(book, ref, snap);
        if (values.out) write(values.out as string, report);
        if (values.json) process.stdout.write(json(report) + "\n");
        else console.log(printAllocation(report));
        return allocationExitCode(report);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        if (values.json) process.stdout.write(json({ error: (err as Error).message }) + "\n");
        return EXIT.ERROR;
      }
    }
    case "present-batch": {
      const target = positionals[0];
      if (!target || !values.out) throw new Error("usage: carbonlei present-batch <book.json> --out <dir> [--credential <credential.json>]");
      const { book, cred } = loadBook(target, values.credential as string | undefined);
      const evidence = values["evidence-from"] ? evidenceFrom(values["evidence-from"] as string, cred) : undefined;
      let ready: Set<string> | undefined;
      if (values.check) {
        try {
          const ref = reportRefOf(cred);
          const snap = await withinDeadline(readAllocationSnapshot(reader(values), book, ref, { events: false }));
          ready = new Set(reconcile(book, ref, snap).sharePack.flatMap((s) => s.proofs.filter((p) => p.ready).map((p) => p.batchId)));
        } catch (err) {
          console.error(`error: could not reconcile with the registry: ${(err as Error).message}`);
          return EXIT.ERROR;
        }
      }
      const allowIncomplete = values["allow-incomplete"] as boolean;
      const pack = buildSharePack(cred, book, { ...(evidence ? { evidence } : {}), ...(ready ? { only: (b) => ready!.has(b.batchId) } : {}), allowIncomplete });
      for (const p of pack.proofs.filter((x) => x.incomplete))
        console.error(`warning: ${p.file} hides ${p.incomplete!.join(", ")}, which check 8 needs: the buyer's verifier will return Not verified (INCOMPLETE)`);
      const manifest = writeSharePack(values.out as string, book, cred, pack);
      if (values.json) process.stdout.write(json(manifest) + "\n");
      else {
        for (const p of manifest.proofs) console.log(`wrote ${p.file}  (${p.importer}, batch ${p.batchId}, ${p.fields.length} fields)`);
        for (const k of manifest.skipped) console.log(`skipped ${k.batchId} — ${k.reason}`);
        console.log(`${manifest.proofs.length} proof(s) and share-pack.json in ${values.out}${evidence ? "" : "; no evidence attached (--evidence-from <proof.json> adds the anchor and authority evidence checks 6-8 read)"}`);
      }
      return manifest.proofs.length ? 0 : 1;
    }
    case "verify": {
      const proofText = readFileSync(values.proof as string, "utf8");
      const proof = JSON.parse(proofText) as Presentation;
      // Evidence bundles referenced by the proof are read relative to the proof file, then to the demo's public folder.
      const loadBundle = bundleLoader(values.proof as string);
      const trustAnchor = values["trust-anchor"] as string | undefined;
      const precursorTrustAnchor = values["precursor-trust-anchor"] as string | undefined;
      const expected = values["expect-invalid"] as string | undefined;
      const maxHeadAgeSec = maxHeadAge(values);
      const accreditationRegistry = values["accreditation-registry"]
        ? (JSON.parse(readFileSync(values["accreditation-registry"] as string, "utf8")) as AccreditationRegistry)
        : undefined;
      if (values.json) {
        // Machine-readable verdict on stdout only; a run that throws exits 3 (see the handler at the end).
        const v = await withinDeadline(verdictFor(proof, reader(values), {
          importerEORI: values.eori as string | undefined,
          loadBundle,
          trustAnchor,
          precursorTrustAnchor,
          maxHeadAgeSec,
          proofText,
          ...(accreditationRegistry ? { accreditationRegistry } : {}),
        }));
        process.stdout.write(json(v) + "\n");
        if (expected) return v.overall === "INVALID" && v.checks.some((c) => c.status === "fail" && c.code === expected) ? 0 : 1;
        return exitCodeOf(v);
      }
      const r = await withinDeadline(verifyPresentation(proof, reader(values), {
        importerEORI: values.eori as string | undefined,
        checkers: vleiCheckers({
          loadBundle,
          ...(trustAnchor ? { trustAnchor } : {}),
          ...(precursorTrustAnchor ? { precursorTrustAnchor } : {}),
          ...(accreditationRegistry ? { accreditationRegistry } : {}),
        }),
        maxHeadAgeSec,
        proofText,
      }));
      for (const c of r.checks) {
        const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", skipped: "SKIP" }[c.status];
        console.log(`${mark}  ${c.index} ${c.name}${c.code ? `  [${c.code}]` : ""}${c.detail ? ` — ${c.detail}` : ""}`);
        for (const s of c.rules ?? []) {
          const m = { pass: "pass", fail: "FAIL", warn: "warn", note: "note" }[s.status];
          console.log(`        ${m}  ${s.rule}${s.code ? `  [${s.code}]` : ""} — ${s.detail}`);
        }
      }
      if (r.precursors) for (const l of precursorLines(r.precursors)) console.log(l);
      if (r.carbonPrice) for (const l of carbonPriceLines(r.carbonPrice)) console.log(l);
      // The EIP-712 signature does not name the importer; only check 5 binds the proof to one (SECURITY.md T4).
      for (const w of r.warnings ?? []) {
        console.log(
          w.code === "SHIPMENT_NOT_BOUND"
            ? "\nWARNING: check 5 skipped: pass --eori to bind the proof to an importer; without it, check 4 judged the report at the latest block's time, not at the shipment's claim time"
            : `\nWARNING: ${w.detail}`,
        );
      }
      const summary = [`${r.overall}${r.primaryCode ? ` (${r.primaryCode})` : ""}`, disclosureSummary(proof, r)];
      const advisory = r.checks.find((c) => c.index === 8 && c.status === "warn");
      if (advisory) summary.push(`check 8 advisory: ${advisoryNote(proof, r.disclosed, advisory.code)}`);
      console.log(`\n${summary.join("; ")}`);
      if (expected) {
        const hit = r.overall === "INVALID" ? r.checks.find((c) => c.status === "fail" && c.code === expected) : undefined;
        console.log(
          hit
            ? `INVALID as expected: check ${hit.index} failed with ${expected} (exit 0 because of --expect-invalid)`
            : `UNEXPECTED: wanted INVALID with a check failing on ${expected}, got ${r.overall}`,
        );
        return hit ? 0 : 1;
      }
      // Check 8 is advisory: a warning shows in the summary but does not change the exit code.
      return EXIT[r.overall];
    }
    case "verify-batch": {
      const target = positionals[0];
      if (!target) throw new Error("usage: carbonlei verify-batch <folder | manifest.json> [--eori <EORI>]");
      const { entries, eori: manifestEori, skipped } = loadBatchInput(target);
      const eori = (values.eori as string | undefined) ?? manifestEori;
      const concurrency = values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency);
      const trustAnchor = values["trust-anchor"] as string | undefined;
      const maxHeadAgeSec = maxHeadAge(values);
      // One snapshot for the whole run: every proof is checked against the same block.
      const rd = reader(values);
      const head = await withinDeadline(rd.latestBlock());
      const pinned = pinnedToHead(rd, head);
      let chainId: number | undefined;
      const results = await runLimited(entries, concurrency, async (e): Promise<BatchResult> => {
        const proofName = e.line.proof ?? null;
        if (!e.proofPath) return { proof: null, line: e.line, verdict: null, error: null, proofShipment: null };
        let proof: Presentation | undefined;
        let proofSha256: string | null = null;
        try {
          const proofText = readFileSync(e.proofPath, "utf8");
          // The digest of the very bytes verified: recheck re-verifies only a file with the same digest.
          proofSha256 = sha256Hex(proofText);
          proof = JSON.parse(proofText) as Presentation;
          const v = await withinDeadline(
            verdictFor(proof, pinned, { importerEORI: eori, loadBundle: bundleLoader(e.proofPath), trustAnchor, maxHeadAgeSec, proofText }),
          );
          chainId ??= v.chain.chainId ?? undefined;
          return { proof: proofName, line: e.line, verdict: v, error: null, proofShipment: proofShipmentOf(proof), proofSha256 };
        } catch (err) {
          return { proof: proofName, line: e.line, verdict: null, error: (err as Error).message, proofShipment: proof ? proofShipmentOf(proof) : null, proofSha256 };
        }
      });
      const doc = batchDocument(results, { pinnedBlock: head.number, chainId, eori });
      if (values.out) write(values.out, doc);
      if (values.json) process.stdout.write(json(doc) + "\n");
      else {
        console.log(printBatch(doc));
        if (skipped.length) console.log(`Skipped (not a proof): ${skipped.join(", ")}`);
      }
      return batchExitCode(doc);
    }
    case "portfolio": {
      const file = positionals[0];
      if (!file || values.year === undefined) throw new Error("usage: carbonlei portfolio <results.json> --year <YYYY> [--price <EUR>] [--csv <file>]");
      if (!/^\d{4}$/.test(values.year as string)) throw new Error(`--year must be a four-digit year, got ${values.year}`);
      let doc = readJson(file) as BatchDocument;
      if (values.recheck) doc = applyRecheck(doc, readJson(values.recheck as string) as RecheckDocument);
      const bm = values.benchmarks ? readMap(values.benchmarks as string, "--benchmarks") : undefined;
      const { cbamFactor, cscf, ...benchmarks } = bm ?? {};
      const summary = buildPortfolio(shipmentsFromBatch(doc), {
        year: Number(values.year),
        ...(values.price !== undefined ? { priceEur: values.price as string } : {}),
        ...(values.defaults ? { defaults: readMap(values.defaults as string, "--defaults") } : {}),
        ...(bm ? { freeAllocation: { benchmarks, ...(cbamFactor ? { cbamFactor } : {}), ...(cscf ? { cscf } : {}) } } : {}),
        ...(values["art9-ref-price"] !== undefined ? { art9: { refPriceEur: values["art9-ref-price"] as string } } : {}),
        // This command plans from the verdicts in the file; it does not verify any proof again.
        verdictSource: `taken from the input file ${basename(file)}${values.recheck ? ` and the re-check ${basename(values.recheck as string)}` : ""}, not re-verified by this command (run verify-batch and recheck yourself, and keep the files where only you can change them)`,
      });
      if (values.csv) writeFileSync(values.csv as string, worksheetCsv(summary));
      if (values.out) write(values.out, summary);
      if (values.json) process.stdout.write(json(summary) + "\n");
      else if (!values.out) console.log(printPortfolio(summary) + (summary.art9 ? art9Text(summary.art9) : "") + (values.csv ? `\n\nWorksheet written to ${values.csv}` : ""));
      return 0;
    }
    case "recheck": {
      const target = positionals[0];
      if (!target) throw new Error("usage: carbonlei recheck <records-folder | record.json | results.json> [--json] [--webhook <URL>]");
      const { records, skipped } = loadRecords(target, { proofsDir: values.proofs as string | undefined });
      if (!records.length) throw new Error(`no accepted record to re-check in ${target}${skipped.length ? `: ${skipped.join("; ")}` : ""}`);
      const windowHours = values.window === undefined ? undefined : Number(values.window);
      if (windowHours !== undefined && (!Number.isFinite(windowHours) || windowHours < 0)) throw new Error(`--window must be a number of hours ≥ 0, got ${values.window}`);
      const doc = await recheckRecords(records, reader(values), {
        trustAnchor: values["trust-anchor"] as string | undefined,
        maxHeadAgeSec: maxHeadAge(values),
        loadBundleFor: (r) => (r.proofPath ? bundleLoader(r.proofPath) : undefined),
        ...(windowHours !== undefined ? { windowHours } : {}),
        concurrency: values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency),
        within: withinDeadline,
      });
      if (values.out) write(values.out, doc);
      if (values.json) process.stdout.write(json(doc) + "\n");
      else console.log(printRecheck(doc, skipped));
      let code = recheckExitCode(doc);
      // The webhook URL may carry a secret token: it is never printed, only whether the POST went through.
      const hook = (values.webhook as string | undefined) ?? process.env.CARBONLEI_RECHECK_WEBHOOK_URL;
      const payload = hook ? webhookPayload(doc) : null;
      if (hook && payload) {
        const sent = await postWebhook(hook, payload);
        console.error(sent.ok ? `webhook: sent ${(payload.changes as unknown[]).length} change(s) (${sent.detail})` : `webhook: NOT delivered (${sent.detail})`);
        if (!sent.ok) code = EXIT.ERROR;
      } else if (hook) console.error("webhook: nothing changed, nothing sent");
      return code;
    }
    case "audit-pack": {
      const file = positionals[0];
      if (!file || !values.out) throw new Error("usage: carbonlei audit-pack <results.json> --out <dir> [--year <YYYY>] [--recheck <recheck.json>] [--portfolio <summary.json>]");
      if (values.year !== undefined && !/^\d{4}$/.test(values.year as string)) throw new Error(`--year must be a four-digit year, got ${values.year}`);
      const deployment = readJson((values.deployment as string) ?? fileURLToPath(new URL("../contracts/deployments/11155111.json", import.meta.url))) as Deployment;
      // The pinned block's hash is read once from the RPC, unless the caller gives it.
      const rd = values["block-hash"] ? undefined : reader(values);
      const { manifest, pack, manifestSha256 } = await withinDeadline(
        createAuditPack({
          outDir: values.out as string,
          resultsPath: file,
          ...(values.year !== undefined ? { year: Number(values.year) } : {}),
          ...(values.proofs ? { proofsDir: values.proofs as string } : {}),
          ...(values["proofs-root"] ? { proofsRoot: values["proofs-root"] as string } : {}),
          evidenceDirs: [fileURLToPath(new URL("../demo/public/", import.meta.url))],
          ...(values.recheck ? { recheckPath: values.recheck as string } : {}),
          ...(values.portfolio ? { portfolioPath: values.portfolio as string } : {}),
          ...(values.csv ? { worksheetPath: values.csv as string } : {}),
          deployment,
          ...(values["block-hash"] ? { blockHash: values["block-hash"] as Hex } : {}),
          ...(rd ? { reader: rd } : {}),
        }),
      );
      if (values.json) process.stdout.write(json({ manifestSha256, manifest, pack }) + "\n");
      else {
        console.log(`wrote ${manifest.files.length + 1} file(s) to ${values.out}: ${pack.lines.filter((l) => l.packedAs).length} proof(s), ${pack.lines.length} line(s)`);
        console.log(`import year ${pack.importYear}: keep until ${pack.retainUntil} (declaration in ${pack.declarationYear}; Reg. (EU) 2023/956 Art 7(6), Art 9(2)-(3))`);
        console.log(`pinned block ${pack.chain.pinnedBlock ?? "—"}, hash ${pack.chain.blockHash ?? "—"}${pack.chain.blockHashSource === "given" ? " (given, not checked)" : ""}`);
        for (const l of pack.lines.filter((x) => x.evidenceMissing.length)) {
          console.log(`warning: line ${l.line} ${l.id}: evidence not found with the hash its proof names: ${l.evidenceMissing.join(", ")}`);
        }
        console.log(`manifest SHA-256 ${manifestSha256}: record it in your archive system; the manifest detects changes but is not a signature or a timestamp`);
      }
      return 0;
    }
    case "verify-pack": {
      const dir = positionals[0];
      if (!dir) throw new Error("usage: carbonlei verify-pack <dir> [--offline] [--expect-manifest <sha256>] [--json]");
      const off = verifyPackOffline(dir, values["expect-manifest"] ? { expectManifest: values["expect-manifest"] as string } : {});
      // Fail closed: a pack whose files do not match its manifest is not re-verified against the chain.
      let chain;
      if (off.ok && !values.offline) {
        try {
          chain = await verifyPackOnChain(dir, reader(values), {
            concurrency: values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency),
            within: withinDeadline,
          });
        } catch (err) {
          console.error(`error: could not re-check the pack against the chain: ${(err as Error).message}`);
          if (values.json) process.stdout.write(json({ offline: off, error: (err as Error).message }) + "\n");
          return EXIT.ERROR;
        }
      }
      if (values.json) process.stdout.write(json({ offline: off, ...(chain ? { chain } : {}) }) + "\n");
      else console.log(printVerifyPack(dir, off, chain));
      return verifyPackExitCode(off, chain);
    }
    case "serve": {
      const host = (values.host as string | undefined) ?? SERVE_DEFAULTS.host;
      const port = Number(values.port ?? SERVE_DEFAULTS.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got ${values.port}`);
      const posInt = (k: string, scale = 1) => {
        const v = values[k as keyof typeof values] as string | undefined;
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number, got ${v}`);
        return Math.round(n * scale);
      };
      const { urls } = rpcUrlsFrom(values.rpc as string | undefined, process.env.CARBONLEI_RPC_URL);
      const server = createApiServer({
        reader: reader(values),
        rpcUrls: urls,
        evidenceDir: (values["evidence-dir"] as string | undefined) ?? fileURLToPath(new URL("../demo/public/", import.meta.url)),
        trustAnchor: values["trust-anchor"] as string | undefined,
        maxHeadAgeSec: maxHeadAge(values),
        corsOrigin: values["cors-origin"] as string | undefined,
        maxBodyBytes: posInt("max-body"),
        timeoutMs: posInt("timeout", 1000),
        bodyTimeoutMs: posInt("body-timeout", 1000),
        maxConcurrent: posInt("max-concurrent"),
      });
      await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, host, () => ok()));
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      process.stderr.write(
        JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "listening", url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}`, auth: "none", cors: values["cors-origin"] ? "one origin" : "off" }) + "\n",
      );
      if (!isLoopback(host)) {
        console.error(`WARNING: listening on ${host}, not a loopback address. This API has no authentication and no TLS: put it behind your own gateway.`);
      }
      const stop = () => server.close(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return new Promise<number>(() => undefined);
    }
    case "export-pact": {
      const proofText = readFileSync(values.proof as string, "utf8");
      const proof = JSON.parse(proofText) as Presentation;
      // The export states the credential's status for this importer: it runs the full verification, with
      // check 5 bound to the importer's EORI (the claim time applies only then) and the vLEI checkers for 6 and 7.
      if (!values.eori) throw new Error("export-pact needs --eori <EORI>: the importer the shipment was declared to");
      const rd = reader(values);
      const trustAnchor = values["trust-anchor"] as string | undefined;
      const precursorTrustAnchor = values["precursor-trust-anchor"] as string | undefined;
      const pf = await withinDeadline(
        verifyPresentation(proof, rd, {
          importerEORI: values.eori as string,
          checkers: vleiCheckers({
            loadBundle: bundleLoader(values.proof as string),
            ...(trustAnchor ? { trustAnchor } : {}),
            ...(precursorTrustAnchor ? { precursorTrustAnchor } : {}),
          }),
          maxHeadAgeSec: maxHeadAge(values),
          proofText,
        }).then((r) =>
          exportPactFromProof(proof, r, rd, {
            companyName: values["company-name"] as string,
            productNameCompany: values["product-name"] as string,
            productDescription: values["product-description"] as string,
            productId: values["product-id"] as string,
          }),
        ),
      );
      write(values.out, pf);
      return 0;
    }
    case "export-communication": {
      const file = positionals[0] ?? (values.proof as string | undefined);
      if (!file) throw new Error("usage: carbonlei export-communication <proof.json> --eori <EORI> [--out <communication.csv>]");
      // Check 5 binds the shipment to this importer; without it the result says nothing about this importer.
      if (!values.eori) throw new Error("export-communication needs --eori <EORI>: the importer the shipment was declared to");
      const proofText = readFileSync(file, "utf8");
      const proof = JSON.parse(proofText) as Presentation;
      const v = await withinDeadline(
        verdictFor(proof, reader(values), {
          importerEORI: values.eori as string,
          loadBundle: bundleLoader(file),
          trustAnchor: values["trust-anchor"] as string | undefined,
          precursorTrustAnchor: values["precursor-trust-anchor"] as string | undefined,
          maxHeadAgeSec: maxHeadAge(values),
          proofText,
        }),
      );
      // communicationCsv refuses anything but VALID with check 5 passed, before anything is written.
      const csv = communicationCsv(v, sha256Hex(proofText));
      if (values.out) {
        writeFileSync(values.out as string, csv);
        console.error(`wrote ${values.out} (${v.overall} at block ${v.chain.block}; not validated by the Commission, not a Registry submission)`);
      } else process.stdout.write(csv);
      return 0;
    }
    case "import-template": {
      const file = positionals[0];
      if (!file) throw new Error("usage: carbonlei import-template <file.xlsx> [--product N]");
      // Refuse an oversized file before reading it into memory.
      if (statSync(file).size > MAX_TEMPLATE_BYTES) throw new TemplateError(`file larger than ${MAX_TEMPLATE_BYTES} bytes`);
      const t = await parseTemplate(readFileSync(file));
      const n = Number(values.product);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--product must be a positive integer, got ${values.product}`);
      const draft = draftCredentialFields(t, n - 1);
      if (values.out) {
        write(values.out, { template: t, draft });
        return 0;
      }
      console.log(printTemplate(t, draft, n));
      return 0;
    }
    default: {
      const help = !command || ["help", "--help", "-h"].includes(command);
      if (!help) console.error(`unknown command: ${command}`);
      process.stdout.write(USAGE);
      return help ? 0 : 64;
    }
  }
}

const args = process.argv.slice(2);
// `verify --json`: any error (unreadable proof, RPC failure, bad option) prints an error object on
// stdout and exits 3, so a caller can tell it from INVALID. Every other run that throws exits 1, as before.
const jsonVerify = (args[0] === "verify" || args[0] === "verify-batch" || args[0] === "recheck") && args.includes("--json");
main(args).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${(err as Error).message}`);
    if (jsonVerify) process.stdout.write(json(verdictError(err)) + "\n");
    process.exit(jsonVerify ? EXIT.ERROR : 1);
  },
);
