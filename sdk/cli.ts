// carbonlei CLI: issue, present, verify, export-pact, import-template.
// Run with Node 22: node sdk/cli.ts <command> [options]
// The CLI never sends transactions; registration and claims are sent by the wallets that own them.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ChainReader, type Deployment } from "./chain.ts";
import { newSalt } from "./encoding.ts";
import type { CredentialClaims, Hex } from "./credential.ts";
import type { Presentation } from "./disclosure.ts";
import { DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "./issue.ts";
import { exportPactFromProof } from "./pact.ts";
import { verifyPresentation } from "./verify.ts";
import { vleiCheckers } from "./checkers.ts";
import { pickReconciledClaims, runRules, type ReportExtract } from "./consistency.ts";
import { dirname, resolve } from "node:path";
import { draftCredentialFields, parseTemplate, type CredentialDraft, type ParsedTemplate } from "./template.ts";

const USAGE = `carbonlei <command> [options]

  issue        --claims <claims.json> --auditor-aid <AID> --supplier <0x…> [--kel-seq <n>] [--supersedes <0x…>]
               [--out <credential.json>]            signs with VERIFIER_PRIVATE_KEY (EIP-712)
  present      --credential <credential.json> [--fields a,b,…] [--batch-id <id> --quantity <t>
               --shipment-date <YYYY-MM-DD> [--importer-salt <0x…>]] [--out <proof.json>]
  verify       --proof <proof.json> [--eori <EORI>] [--rpc <url>] [--deployment <file>]
               [--expect-invalid <CODE>]            exit 0 only if the proof is INVALID with a check failing on CODE
  export-pact  --proof <proof.json> --company-name <name> --product-name <name> --product-id <id>
               --product-description <text> [--rpc <url>] [--deployment <file>] [--out <pact.json>]
  import-template <file.xlsx> [--product N] [--out <draft.json>]
               reads a filled CBAM Communication Template (V2.1 or V2.1.1) and prints a draft of the
               credential fields it can fill; the rest is left to the verification body
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
  L.push("", `Still to be supplied by the verification body (${d.toBeSupplied.length}):`);
  for (const s of d.toBeSupplied) L.push(`  ${s.field} — ${s.reason}`);
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
  return values.rpc ? ChainReader.forRpc(deployment, [values.rpc as string], sepolia) : ChainReader.forSepolia(deployment);
}

/** Summary note for a check 8 warning, with the number of reconciliation rules the received extract fails. */
function advisoryNote(proof: Presentation, disclosed: Record<string, string>, code: string): string {
  const claims = pickReconciledClaims(disclosed);
  const n = claims && proof.reportExtract ? runRules(proof.reportExtract as unknown as ReportExtract, claims).filter((f) => !f.ok).length : 0;
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
    case "verify": {
      const proof = readJson(values.proof as string) as Presentation;
      // Evidence bundles referenced by the proof are read relative to the proof file, then to the demo's public folder.
      const loadBundle = async (p: string) => {
        for (const base of [dirname(values.proof as string), fileURLToPath(new URL("../demo/public/", import.meta.url))]) {
          try {
            return readFileSync(resolve(base, p), "utf8");
          } catch {}
        }
        throw new Error(`evidence file ${p} not found`);
      };
      const r = await verifyPresentation(proof, reader(values), {
        importerEORI: values.eori as string | undefined,
        checkers: vleiCheckers({ loadBundle }),
      });
      for (const c of r.checks) {
        const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", skipped: "SKIP" }[c.status];
        console.log(`${mark}  ${c.index} ${c.name}${c.code ? `  [${c.code}]` : ""}${c.detail ? ` — ${c.detail}` : ""}`);
      }
      const summary = [`${r.overall}${r.primaryCode ? ` (${r.primaryCode})` : ""}`, `${r.hidden} field(s) hidden by supplier`];
      const advisory = r.checks.find((c) => c.index === 8 && c.status === "warn");
      if (advisory) summary.push(`check 8 advisory: ${advisoryNote(proof, r.disclosed, advisory.code)}`);
      console.log(`\n${summary.join("; ")}`);
      const expected = values["expect-invalid"] as string | undefined;
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
      return r.overall === "VALID" ? 0 : r.overall === "CONTESTED" ? 2 : 1;
    }
    case "export-pact": {
      const proof = readJson(values.proof as string) as Presentation;
      const rd = reader(values);
      const r = await verifyPresentation(proof, rd);
      const pf = await exportPactFromProof(proof, r, rd, {
        companyName: values["company-name"] as string,
        productNameCompany: values["product-name"] as string,
        productDescription: values["product-description"] as string,
        productId: values["product-id"] as string,
      });
      write(values.out, pf);
      return 0;
    }
    case "import-template": {
      const file = positionals[0];
      if (!file) throw new Error("usage: carbonlei import-template <file.xlsx> [--product N]");
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
    default:
      process.stdout.write(USAGE);
      return command ? 64 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  },
);
