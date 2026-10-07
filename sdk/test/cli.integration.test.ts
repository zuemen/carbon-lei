// The four CLI commands end to end on a local anvil chain (M2-8).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditorAidHashOf, hashString, leiHashOf } from "../commitment.ts";
import { METHODOLOGY_NOTE } from "../credential.ts";
import { claimArgsOf, type SignedCredential } from "../issue.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const run = promisify(execFile);
const dir = fileURLToPath(new URL("../../.cache/cli-test/", import.meta.url));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const AID = "EDemoAuditorAidForCliTests000000000000000000";
const EORI = demo.entities.importers[0].eori as string;

let c: LocalChain;
const env = () => ({ ...process.env, VERIFIER_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" });
const carbonlei = (...args: string[]) =>
  run(process.execPath, [cli, ...args, "--rpc", c.rpc, "--deployment", `${dir}deployment.json`], { env: env() });

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  c = await startLocalChain(19545 + Math.floor(Math.random() * 1000));
  writeFileSync(`${dir}deployment.json`, JSON.stringify(c.deployment));
  const lei = leiHashOf(demo.entities.verifier.lei);
  await send(c, c.owner, "allowlist", "addVerifier", [
    { leiHash: lei, verifier: c.verifier.address, leCredSaidHash: hashString("LE"), accreditationSaidHash: hashString("ACC"), accreditedUntil: 1924905600n },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(AID), leiHash: lei, ecrSaidHash: hashString("ECR") }]);
  const s = demo.entities.supplier;
  writeFileSync(
    `${dir}claims.json`,
    JSON.stringify({
      supplierLEI: s.lei, operatorId: s.operatorId, installationId: s.installations[0].id, installationName: s.installations[0].name,
      unLocode: s.unLocode, cnCode: "7318", cbamRoute: "C", productionRoute: "withheld", reportingPeriod: "2026-01-01/2026-12-31",
      verifiedTonnes: "500", specificEmbeddedEmissions_tCO2e_per_t: "1.8", valueType: "actual", methodologyNote: METHODOLOGY_NOTE,
      verificationReportId: "VR-DEMO-0001", verifierLEI: demo.entities.verifier.lei, accreditationNumber: "DEMO-ACC-CBAM-0001",
      nabName: demo.entities.nab.name, siteVisit: "physical", assuranceLevel: "reasonable", materialityThreshold: "5%",
      energyMix: "withheld", supplierCost: "withheld",
      idSalt: `0x${"11".repeat(32)}`, batchSalt: `0x${"22".repeat(32)}`,
      issuedAt: "2026-10-01T00:00:00Z", validUntil: "2027-12-31T00:00:00Z",
    }),
  );
}, 60_000);

afterAll(() => c?.stop());

describe("carbonlei CLI", () => {
  it("issue → register → claim → present → verify → export-pact", async () => {
    await carbonlei("issue", "--claims", `${dir}claims.json`, "--auditor-aid", AID, "--supplier", c.supplier.address, "--kel-seq", "1", "--out", `${dir}credential.json`);
    const issued = JSON.parse(readFileSync(`${dir}credential.json`, "utf8"));
    const cred = issued.credential as SignedCredential;
    expect(cred.core.d).toMatch(/^E/);

    const ri = issued.reportInput;
    await send(c, c.verifier, "registry", "registerReport", [
      { ...ri, kelSeq: BigInt(ri.kelSeq), verifiedKg: BigInt(ri.verifiedKg), validUntil: BigInt(ri.validUntil) },
    ]);
    const importerSalt = `0x${"33".repeat(32)}` as const;
    await send(c, c.supplier, "registry", "claimShipment",
      claimArgsOf(cred, { batchId: "BATCH-DEMO-2026-0001", quantityTonnes: "200", importerEORI: EORI, importerSalt }));

    await carbonlei("present", "--credential", `${dir}credential.json`, "--batch-id", "BATCH-DEMO-2026-0001", "--quantity", "200",
      "--shipment-date", "2026-10-10", "--importer-salt", importerSalt, "--out", `${dir}proof.json`);

    const verify = await carbonlei("verify", "--proof", `${dir}proof.json`, "--eori", EORI).catch((e) => e);
    // No vLEI evidence in this proof yet, so checks 6–7 fail and the exit code is 1.
    expect(verify.code).toBe(1);
    expect(verify.stdout).toMatch(/PASS {2}4 On-chain report/);
    expect(verify.stdout).toMatch(/PASS {2}5 Shipment claim/);
    expect(verify.stdout).toMatch(/FAIL {2}6 Auditor anchor \(KEL\) {2}\[ANCHOR_NOT_FOUND\]/);
    expect(verify.stdout).not.toContain("WARNING: check 5 skipped");

    // Without --eori, check 5 is skipped and the CLI says that nothing binds the proof to an importer.
    const unbound = await carbonlei("verify", "--proof", `${dir}proof.json`).catch((e) => e);
    expect(unbound.stdout).toMatch(/SKIP {2}5 Shipment claim/);
    expect(unbound.stdout).toContain("WARNING: check 5 skipped: pass --eori to bind the proof to an importer");

    // export-pact runs the full verification for the importer: it needs --eori, and exports nothing when a
    // check that decides authority (6, 7) fails, here because the proof carries no vLEI evidence yet.
    const pactArgs = ["export-pact", "--proof", `${dir}proof.json`, "--company-name", "Demo Fasteners Co. (fictional)",
      "--product-name", "Hex bolt (illustrative)", "--product-id", "hex-bolt-m10",
      "--product-description", "Hex bolts, carbon steel — CBAM direct embedded emissions only, not a full PCF (illustrative)",
      "--out", `${dir}pact.json`];
    rmSync(`${dir}pact.json`, { force: true });
    const noEori = await carbonlei(...pactArgs).catch((e) => e);
    expect([noEori.code, noEori.stderr]).toEqual([1, expect.stringContaining("export-pact needs --eori")]);
    const noEvidence = await carbonlei(...pactArgs, "--eori", EORI).catch((e) => e);
    expect([noEvidence.code, noEvidence.stderr]).toEqual([1, expect.stringContaining("the proof fails check 6 (ANCHOR_NOT_FOUND); nothing exported")]);
    expect(existsSync(`${dir}pact.json`)).toBe(false);
  }, 60_000);
});
