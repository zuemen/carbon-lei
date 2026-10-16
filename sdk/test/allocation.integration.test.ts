// Supplier allocation book against the registry on a local anvil chain: one verified report, claims for several
// importers (one sent with another salt than the book's, one never sent, one not in the book), the reconciliation at
// a pinned block, the contract refusing what `reconcile` calls OVER_ALLOCATED, the share pack verified per buyer
// (check 5 binds each proof to its own EORI), and the two CLI commands end to end.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keccak256, stringToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSharePack, readAllocationSnapshot, reconcile, reportRefOf, type AllocationBook } from "../allocation.ts";
import { auditorAidHashOf, hashString, leiHashOf } from "../commitment.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import { claimArgsOf, issueCredential, reportInputOf, type SignedCredential } from "../issue.ts";
import { verdictFor } from "../verdict.ts";
import type { EvidenceCheckers } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const run = promisify(execFile);
const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const dir = fileURLToPath(new URL("../../.cache/allocation-test/", import.meta.url));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const salt = (s: string): Hex => keccak256(stringToBytes(`alloc-it:${s}`));
const AID = "EDemoAuditorAidForAllocationTests00000000000";
const EORI_A = "NLDEMO000000001";
const EORI_B = "DEDEMO000000002";
const EORI_C = "SEDEMO000000003";

const pass = (index: number) => async () => ({ index, name: "", status: "pass" as const, code: "", detail: "stand-in" });
const checkers: EvidenceCheckers = { anchor: pass(6), authority: pass(7), reconciliation: pass(8) };
const evidence = { anchorEvidence: { a: 1 }, authorityEvidence: { b: 1 }, reportExtract: { c: 3, quantityPerCn: [], specificEmbeddedEmissionsPerCn: [], accreditationScope: [], signedAt: "" } };

let c: LocalChain;
let cred: SignedCredential;

const batch = (batchId: string, importer: string, t: string, status: "planned" | "claimed", s = batchId) =>
  ({ batchId, importer, importerSalt: salt(s), quantityTonnes: t, shipmentDate: "2026-10-12", status });

function book(): AllocationBook {
  return {
    version: 1,
    credential: "credential.json",
    importers: [
      { id: "a", name: "Importer A (fictional)", eori: EORI_A },
      { id: "b", name: "Importer B (fictional)", eori: EORI_B, fields: ["specificEmbeddedEmissions_tCO2e_per_t"] },
      { id: "c", name: "Importer C (fictional)", eori: EORI_C },
    ],
    batches: [
      batch("A-1", "a", "150", "claimed"),
      batch("B-1", "b", "100", "claimed"), // sent on-chain with another salt
      batch("C-1", "c", "40", "claimed"), // never sent
      batch("B-2", "b", "200", "planned"),
      batch("C-2", "c", "100", "planned"), // past the remaining tonnes
    ],
  };
}

const claim = (batchId: string, t: string, eori: string, importerSalt: Hex) =>
  send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cred, { batchId, quantityTonnes: t, importerEORI: eori, importerSalt }));

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  c = await startLocalChain(21545 + Math.floor(Math.random() * 1000));
  writeFileSync(`${dir}deployment.json`, JSON.stringify(c.deployment));
  const lei = leiHashOf(demo.entities.verifier.lei);
  await send(c, c.owner, "allowlist", "addVerifier", [
    { leiHash: lei, verifier: c.verifier.address, leCredSaidHash: hashString("LE"), accreditationSaidHash: hashString("ACC"), accreditedUntil: 1924905600n },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(AID), leiHash: lei, ecrSaidHash: hashString("ECR") }]);
  const s = demo.entities.supplier;
  const claims: CredentialClaims = {
    supplierLEI: s.lei, operatorId: s.operatorId, installationId: s.installations[0].id, installationName: s.installations[0].name,
    unLocode: s.unLocode, cnCode: "7318", cbamRoute: "C", productionRoute: "withheld", reportingPeriod: "2026-01-01/2026-12-31",
    verifiedTonnes: "500", specificEmbeddedEmissions_tCO2e_per_t: "1.8", valueType: "actual", methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: "VR-ALLOC-0001", verifierLEI: demo.entities.verifier.lei, accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name, siteVisit: "physical", assuranceLevel: "reasonable", materialityThreshold: "5%",
    energyMix: "withheld", supplierCost: "withheld", idSalt: salt("id"), batchSalt: salt("batch"),
    issuedAt: "2026-09-01T00:00:00Z", validUntil: "2027-12-31T00:00:00Z",
  };
  cred = await issueCredential({ claims, auditorAID: AID, signer: c.verifier, registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 });
  await send(c, c.verifier, "registry", "registerReport", [reportInputOf(cred, { supplier: c.supplier.address, kelSeq: 1n })]);
  writeFileSync(`${dir}credential.json`, JSON.stringify({ credential: cred }));
  writeFileSync(`${dir}book.json`, JSON.stringify(book()));
  await claim("A-1", "150", EORI_A, salt("A-1"));
  await claim("B-1", "100", EORI_B, salt("not the book's salt"));
  await claim("X-9", "30", EORI_C, salt("X-9")); // not in the book
}, 90_000);

afterAll(() => c?.stop());

describe("allocation book on anvil", () => {
  it("reconciles at one pinned block: matched, mismatched, missing, planned, over-allocated and unknown claims", async () => {
    const ref = reportRefOf(cred);
    const snap = await readAllocationSnapshot(c.reader, book(), ref, { events: true });
    expect(snap.remainingKg).toBe(220_000n);
    expect(snap.ledgerClaimedKg).toBe(280_000n);
    expect(snap.events).toHaveLength(3);
    const r = reconcile(book(), ref, snap);
    expect(r.report.state).toBe("claimable");
    expect(r.batches.map((b) => `${b.batchId}:${b.state}`)).toEqual(["A-1:claimed", "B-1:mismatch", "C-1:missing", "B-2:planned", "C-2:over-allocated"]);
    expect(r.issues.map((i) => i.code)).toEqual(["IMPORTER_MISMATCH", "CLAIM_MISSING", "OVER_ALLOCATED", "UNKNOWN_CLAIM"]);
    expect(r.unknownClaims[0].quantityKg).toBe(30_000n);
    expect(r.totals).toMatchObject({ claimedKg: 150_000n, plannedKg: 200_000n, refusedKg: 100_000n, remainingAfterPlanKg: 20_000n, unaccountedKg: 30_000n });
    expect(r.ok).toBe(false);

    // The contract agrees: B-2 fits now; after it, C-2 reverts with ExceedsVerifiedTonnage(20 t left, 100 t asked).
    const args = (id: string, t: string, eori: string) => claimArgsOf(cred, { batchId: id, quantityTonnes: t, importerEORI: eori, importerSalt: salt(id) });
    expect(await c.reader.dryRun("claimShipment", args("B-2", "200", EORI_B), c.supplier.address)).toEqual({ reverted: false });
    await claim("B-2", "200", EORI_B, salt("B-2"));
    const refused = await c.reader.dryRun("claimShipment", args("C-2", "100", EORI_C), c.supplier.address);
    expect(refused).toEqual({ reverted: true, errorName: "ExceedsVerifiedTonnage", args: [20_000n, 100_000n] });

    // The book still says planned for B-2: claimed on-chain, flagged stale (a warning).
    const after = reconcile(book(), ref, await readAllocationSnapshot(c.reader, book(), ref, { events: true }));
    expect(after.batches[3].state).toBe("claimed");
    expect(after.issues.map((i) => `${i.code}/${i.severity}`)).toContain("BOOK_STALE/warning");
  });

  it("share pack: each proof verifies for its own buyer only (check 5), with that buyer's fields", async () => {
    const ref = reportRefOf(cred);
    const b = book();
    const r = reconcile(b, ref, await readAllocationSnapshot(c.reader, b, ref));
    const ready = new Set(r.sharePack.flatMap((s) => s.proofs.filter((p) => p.ready).map((p) => p.batchId)));
    expect([...ready]).toEqual(["A-1", "B-2"]);
    b.batches[3].status = "claimed";
    const { proofs, skipped } = buildSharePack(cred, b, { evidence, only: (x) => ready.has(x.batchId) });
    expect(proofs.map((p) => p.batchId)).toEqual(["A-1", "B-2"]);
    expect(skipped.map((s) => s.batchId)).toEqual(["B-1", "C-1", "C-2"]);
    const [pa, pb] = proofs;
    expect((await verdictFor(pa.proof, c.reader, { importerEORI: EORI_A, checkers })).overall).toBe("VALID");
    const vb = await verdictFor(pb.proof, c.reader, { importerEORI: EORI_B, checkers });
    expect(vb.overall).toBe("VALID");
    expect(pb.proof.disclosures.length).toBeLessThan(pa.proof.disclosures.length);
    // Buyer B forwarding A's proof as its own: check 5 refuses it.
    const reused = await verdictFor(pa.proof, c.reader, { importerEORI: EORI_B, checkers });
    expect(reused.overall).toBe("INVALID");
    expect(reused.primaryCode).toBe("SHIPMENT_MISMATCH");
  });

  it("CLI: allocate exits 1 with the JSON report; present-batch --check writes only the matching batches; a bad book exits 3", async () => {
    const opts = ["--rpc", c.rpc, "--deployment", `${dir}deployment.json`];
    const fail = await run(process.execPath, [cli, "allocate", `${dir}book.json`, "--json", ...opts]).then(
      () => null,
      (e: { code: number; stdout: string }) => e,
    );
    expect(fail?.code).toBe(1);
    const report = JSON.parse(fail!.stdout);
    expect(report.issues.map((i: { code: string }) => i.code)).toContain("OVER_ALLOCATED");
    for (const secret of [EORI_A, EORI_B, EORI_C, salt("A-1")]) expect(fail!.stdout).not.toContain(secret);

    const out = `${dir}pack/`;
    const { stdout } = await run(process.execPath, [cli, "present-batch", `${dir}book.json`, "--check", "--out", out, ...opts]);
    expect(stdout).toContain("1 proof(s)");
    expect(readdirSync(out).sort()).toEqual(["a--A-1--bab566e4ab.proof.json", "share-pack.json"]);
    const manifest = readFileSync(`${out}share-pack.json`, "utf8");
    expect(manifest).not.toContain(EORI_A);
    expect(JSON.parse(readFileSync(`${out}a--A-1--bab566e4ab.proof.json`, "utf8")).shipment.batchId).toBe("A-1");

    writeFileSync(`${dir}bad.json`, JSON.stringify({ version: 1, importers: [], batches: [{ batchId: "Z" }] }));
    const bad = await run(process.execPath, [cli, "allocate", `${dir}bad.json`, "--json", ...opts]).then(() => null, (e: { code: number; stdout: string }) => e);
    expect(bad?.code).toBe(3);
    expect(JSON.parse(bad!.stdout).error).toMatch(/allocation book/);
  });

  it("a revoked report: planned batches are blocked and claimed batches are flagged", async () => {
    await send(c, c.verifier, "registry", "revokeReport", [claimArgsOf(cred, { batchId: "x", quantityTonnes: "1", importerEORI: EORI_A, importerSalt: salt("x") })[0]]);
    const ref = reportRefOf(cred);
    const r = reconcile(book(), ref, await readAllocationSnapshot(c.reader, book(), ref));
    expect(r.report.state).toBe("revoked");
    expect(r.batches.find((b) => b.batchId === "C-2")?.state).toBe("blocked");
    expect(r.issues.filter((i) => i.code === "REPORT_REVOKED").map((i) => i.batchId)).toEqual(["A-1", "B-1", "B-2"]);
    expect(r.sharePack.flatMap((s) => s.proofs).every((p) => !p.ready)).toBe(true);
  });
});
