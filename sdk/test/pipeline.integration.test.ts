// From the supplier's Excel file to the buyer's machine-readable verdict, end to end on a local anvil
// chain, through the CLI: import-template (the official CBAM screws-and-nuts example) → draft fields →
// the rest filled with test values → issue → register and claim → present → verify --json, checked
// against docs/schemas/verdict.schema.json, then the exit codes of INVALID, CONTESTED and an RPC error.
//
// Checks 6 and 7 need vLEI evidence. Without a KERI stack, the evidence here is the synthetic test chain
// of verifier/src/impostor-chain.ts (deterministic test keys, real SAIDs and Ed25519 signatures), and
// verify is run with --trust-anchor set to that chain's root. With the default (demo) root, the same
// proof fails check 7, which is the INVALID case below. Test values only; nothing here is real data.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../checkers.ts";
import { auditorAidHashOf, hashString, leiHashOf } from "../commitment.ts";
import { METHODOLOGY_NOTE, checkNormalForms, type CredentialClaims } from "../credential.ts";
import type { CredentialDraft } from "../template.ts";
import { claimArgsOf, type SignedCredential } from "../issue.ts";
import { parseCesr } from "../vlei.ts";
import { DEMO_TRUST_ANCHOR } from "../vlei.ts";
import { syntheticImpostorChain } from "../../verifier/src/impostor-chain.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";

const run = promisify(execFile);
const dir = fileURLToPath(new URL("../../.cache/pipeline-test/", import.meta.url));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const xlsx = fileURLToPath(new URL("../../fixtures/cbam-template/CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx", import.meta.url));
const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const accreditationSchema = JSON.parse(
  readFileSync(new URL("../../verifier/schemas/cbam-verifier-accreditation.json", import.meta.url), "utf8"),
).$id as string;
const EORI = demo.entities.importers[0].eori as string;
const BATCH = "BATCH-PIPELINE-0001";
const importerSalt = `0x${"44".repeat(32)}` as const;

let c: LocalChain;
const env = () => ({ ...process.env, VERIFIER_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" });
const carbonlei = (args: string[], rpc = c.rpc) =>
  run(process.execPath, [cli, ...args, "--rpc", rpc, "--deployment", `${dir}deployment.json`], { env: env() }).then(
    (r) => ({ code: 0, stdout: r.stdout }),
    (e) => ({ code: e.code as number, stdout: e.stdout as string }),
  );

beforeAll(async () => {
  mkdirSync(`${dir}evidence`, { recursive: true });
  c = await startLocalChain(23545 + Math.floor(Math.random() * 1000));
  writeFileSync(`${dir}deployment.json`, JSON.stringify(c.deployment));
}, 60_000);

afterAll(() => c?.stop());

describe("Excel template to machine-readable verdict", () => {
  it("import-template → issue → register and claim → present → verify --json is VALID and matches the schema", async () => {
    // 1. The supplier's Communication Template, as the operator fills it today.
    const imp = await run(process.execPath, [cli, "import-template", xlsx, "--out", `${dir}draft.json`]);
    expect(imp.stdout).toBe("");
    const { draft } = JSON.parse(readFileSync(`${dir}draft.json`, "utf8")) as { draft: CredentialDraft };
    expect(draft.fields.cnCode).toBe("73181542");
    expect(draft.fields.specificEmbeddedEmissions_tCO2e_per_t).toBe("2.00694");

    // 2. The vLEI chain of the test verification body (synthetic, with the template's CN code in scope).
    const chain = syntheticImpostorChain({ demo: { ...demo, product: { ...demo.product, cnCode: draft.fields.cnCode } }, accreditationSchema });
    const bodyLei = chain.fixture.agents.impBody.lei as string;
    const auditorAid = chain.fixture.agents.impAuditor.aid as string;
    const root = chain.fixture.trustAnchor as string;
    expect(root).not.toBe(DEMO_TRUST_ANCHOR);
    const lei = leiHashOf(bodyLei);
    await send(c, c.owner, "allowlist", "addVerifier", [
      {
        leiHash: lei,
        verifier: c.verifier.address,
        leCredSaidHash: hashString(chain.saids.leBody),
        accreditationSaidHash: hashString(chain.saids.accreditation),
        accreditedUntil: 1924905600n,
      },
    ]);
    await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(auditorAid), leiHash: lei, ecrSaidHash: hashString(chain.saids.ecr) }]);

    // 3. Fields the template has no cell for, filled with test values by the supplier and the body.
    const s = demo.entities.supplier;
    const filled = {
      supplierLEI: s.lei,
      operatorId: s.operatorId,
      installationId: s.installations[0].id,
      cbamRoute: "C",
      energyMix: "withheld (test value)",
      supplierCost: "withheld (test value)",
      verifiedTonnes: "500",
      verificationReportId: "VR-PIPELINE-0001",
      verifierLEI: bodyLei,
      siteVisit: "physical",
      assuranceLevel: "reasonable",
      materialityThreshold: "5%",
      validUntil: "2027-12-31T00:00:00Z",
      nabName: "Test Accreditation Body (fictional)",
      accreditationNumber: "TEST-ACC-0001",
      methodologyNote: METHODOLOGY_NOTE,
      idSalt: `0x${"11".repeat(32)}`,
      batchSalt: `0x${"22".repeat(32)}`,
      issuedAt: "2026-10-01T00:00:00Z",
    };
    expect(Object.keys(filled)).toEqual(expect.arrayContaining(draft.toBeSupplied.map((f) => f.field)));
    const claims = { ...filled, ...draft.fields } as CredentialClaims;
    expect(checkNormalForms(claims)).toEqual([]);
    writeFileSync(`${dir}claims.json`, JSON.stringify(claims));

    // 4. The body signs (EIP-712), registers the report; the supplier claims one shipment.
    await carbonlei(["issue", "--claims", `${dir}claims.json`, "--auditor-aid", auditorAid, "--supplier", c.supplier.address, "--kel-seq", "1", "--out", `${dir}credential.json`]);
    const issued = JSON.parse(readFileSync(`${dir}credential.json`, "utf8"));
    const cred = issued.credential as SignedCredential;
    const ri = issued.reportInput;
    await send(c, c.verifier, "registry", "registerReport", [
      { ...ri, kelSeq: BigInt(ri.kelSeq), verifiedKg: BigInt(ri.verifiedKg), validUntil: BigInt(ri.validUntil) },
    ]);
    await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cred, { batchId: BATCH, quantityTonnes: "200", importerEORI: EORI, importerSalt }));

    // 5. The supplier's proof, with the auditor's KEL anchor and a hashed reference to the authority bundle
    //    (in a KERI deployment these come from verifier/src/anchor.ts and export-evidence.ts).
    await carbonlei(["present", "--credential", `${dir}credential.json`, "--batch-id", BATCH, "--quantity", "200", "--shipment-date", "2026-10-10", "--importer-salt", importerSalt, "--out", `${dir}proof.json`]);
    const anchor = chain.anchor(cred.core.d);
    const icp = parseCesr(chain.cesr.ecr).find((m) => m.ked.t === "icp" && m.ked.i === auditorAid);
    expect(icp).toBeDefined();
    const bundleText = JSON.stringify(chain.bundle) + "\n";
    writeFileSync(`${dir}evidence/authority-bundle.json`, bundleText);
    const proof = JSON.parse(readFileSync(`${dir}proof.json`, "utf8"));
    writeFileSync(
      `${dir}proof.json`,
      JSON.stringify({
        ...proof,
        anchorEvidence: { ...anchor, establishmentRaw: icp!.raw, ...(icp!.atc ? { establishmentAttachment: icp!.atc } : {}) },
        authorityEvidence: { bundle: "evidence/authority-bundle.json", sha256: sha256Hex(bundleText) },
      }),
    );

    // 6. The buyer's machine-readable verdict.
    const verify = (...extra: string[]) => carbonlei(["verify", "--proof", `${dir}proof.json`, "--eori", EORI, "--json", ...extra]);
    const ok = await verify("--trust-anchor", root);
    const v = JSON.parse(ok.stdout);
    expect(verdictSchemaErrors(v)).toEqual([]);
    expect(v.checks.filter((x: { status: string }) => x.status === "fail")).toEqual([]);
    expect(v.overall).toBe("VALID");
    expect(ok.code).toBe(0);
    expect(v.primaryCode).toBe("");
    expect(v.checks.map((x: { id: number }) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.disclosed.cnCode).toBe("73181542");
    expect(v.disclosed.specificEmbeddedEmissions_tCO2e_per_t).toBe("2.00694");
    expect(v.credSAID).toBe(cred.core.d);
    expect(v.chain).toEqual({ chainId: 31337, block: Number(await c.pub.getBlockNumber()) });
    expect(v.trustAnchor).toBe(root);
    expect(v.hidden + Object.keys(v.disclosed).length).toBe(JSON.parse(cred.coreJson).digests.length);

    // INVALID (exit 1): the default root of trust does not accept this chain.
    const bad = await verify();
    const vb = JSON.parse(bad.stdout);
    expect(verdictSchemaErrors(vb)).toEqual([]);
    expect([vb.overall, vb.primaryCode, bad.code]).toEqual(["INVALID", "AUTHORITY_INVALID", 1]);

    // RPC error (exit 3 with --json, an error object on stdout; exit 1 without --json, as before).
    const dead = "http://127.0.0.1:9";
    const err = await carbonlei(["verify", "--proof", `${dir}proof.json`, "--json"], dead);
    expect(err.code).toBe(3);
    const ve = JSON.parse(err.stdout);
    expect(verdictSchemaErrors(ve)).toEqual([]);
    expect(ve.error).toBeTruthy();
    expect((await carbonlei(["verify", "--proof", `${dir}proof.json`], dead)).code).toBe(1);

    // CONTESTED (exit 2): the watcher syncs the auditor's revocation within 24 hours of registration.
    await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(auditorAid), lei]);
    const contested = await verify("--trust-anchor", root);
    const vc = JSON.parse(contested.stdout);
    expect(verdictSchemaErrors(vc)).toEqual([]);
    expect([vc.overall, vc.primaryCode, contested.code]).toEqual(["CONTESTED", "", 2]);
  }, 90_000);
});
