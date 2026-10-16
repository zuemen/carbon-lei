// Supplier allocation book (sdk/allocation.ts): book parsing, reconciliation against a chain snapshot, share packs.
// Pure: the snapshots are built by hand. The registry side is tested on anvil in allocation.integration.test.ts.
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  BookError,
  batchKeysOf,
  buildSharePack,
  fieldsFor,
  parseBook,
  printAllocation,
  proofFileName,
  reconcile,
  reportRefOf,
  type AllocationBook,
  type AllocationSnapshot,
  type ReportRef,
} from "../allocation.ts";
import { batchKeyOf, importerCommitOf, reportKeyOf, ZERO32 } from "../commitment.ts";
import { REQUIRED_DISCLOSURES, type Hex } from "../credential.ts";
import { decodeDisclosure } from "../disclosure.ts";
import type { SignedCredential } from "../issue.ts";

const salt = (s: string): Hex => keccak256(stringToBytes(`alloc:${s}`));
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/sepolia-credential.json", import.meta.url), "utf8"));
const demoData = JSON.parse(readFileSync(new URL("../../demo/public/demo-data.json", import.meta.url), "utf8"));
const exampleBook = JSON.parse(readFileSync(new URL("../../docs/examples/allocation-book.json", import.meta.url), "utf8"));
const cred = { ...fixture, core: JSON.parse(fixture.coreJson) } as SignedCredential;

const REF: ReportRef = { credSAID: "EAllocationTestCredentialSaid0000000000000000", batchSalt: salt("batch") };
const RK = reportKeyOf(REF.credSAID);
const key = (batchId: string) => batchKeyOf(RK, batchId, REF.batchSalt);

function book(over: Partial<AllocationBook> = {}): AllocationBook {
  return {
    version: 1,
    importers: [
      { id: "a", name: "Importer A (fictional)", eori: "NLDEMO000000001" },
      { id: "b", name: "Importer B (fictional)", eori: "DEDEMO000000002", fields: ["specificEmbeddedEmissions_tCO2e_per_t"] },
    ],
    batches: [
      { batchId: "B-1", importer: "a", importerSalt: salt("1"), quantityTonnes: "200", shipmentDate: "2026-10-10", status: "claimed" },
      { batchId: "B-2", importer: "b", importerSalt: salt("2"), quantityTonnes: "200", shipmentDate: "2026-11-01", status: "planned" },
      { batchId: "B-3", importer: "b", importerSalt: salt("3"), quantityTonnes: "100", shipmentDate: "2026-11-02", status: "planned" },
    ],
    ...over,
  };
}

function snap(over: Partial<AllocationSnapshot> = {}, claims: Record<string, { kg: bigint; eori: string; salt: Hex }> = {}): AllocationSnapshot {
  const shipments: AllocationSnapshot["shipments"] = {};
  for (const b of book().batches) shipments[key(b.batchId)] = { reportKey: ZERO32, quantityKg: 0n, importerCommit: ZERO32, claimedAt: 0n, reportValid: false };
  for (const [id, c] of Object.entries(claims))
    shipments[key(id)] = { reportKey: RK, quantityKg: c.kg, importerCommit: importerCommitOf(c.eori, c.salt), claimedAt: 1_790_000_100n, reportValid: true };
  const claimed = Object.values(claims).reduce((a, c) => a + c.kg, 0n);
  return {
    blockNumber: 100n,
    blockTime: 1_790_000_500n,
    reportKey: RK,
    report: { verifiedKg: 500_000n, registeredAt: 1_790_000_000n, revokedAt: 0n, supersededBy: ZERO32, validUntil: 1_900_000_000n },
    claimable: true,
    remainingKg: 500_000n - claimed,
    ledgerClaimedKg: claimed,
    shipments,
    ...over,
  };
}

const B1 = { "B-1": { kg: 200_000n, eori: "NLDEMO000000001", salt: salt("1") } };

describe("allocation book", () => {
  it("accepts the example book and rejects every malformed field at once", () => {
    expect(parseBook(exampleBook).batches).toHaveLength(3);
    const bad = { version: 1, importers: [{ id: "x", eori: "not an eori" }, { id: "x", eori: "NL1" }], batches: [
      { batchId: "Q", importer: "nobody", importerSalt: "0x12", quantityTonnes: "0", shipmentDate: "10/10/2026", status: "sent", fields: ["nope"] },
      { batchId: "Q", importer: "x", importerSalt: salt("q"), quantityTonnes: "1.0001", shipmentDate: "2026-10-10", status: "planned" },
    ] };
    let err: BookError | undefined;
    try {
      parseBook(bad);
    } catch (e) {
      err = e as BookError;
    }
    expect(err).toBeInstanceOf(BookError);
    const text = err!.problems.join("\n");
    for (const s of ["eori is not an EORI", "duplicate id x", "not in importers", "importerSalt", "zero quantity", "YYYY-MM-DD", "status must be", "unknown field nope", "duplicate batchId", "whole number of kilograms"])
      expect(text).toContain(s);
    expect(() => parseBook({ version: 2, importers: [], batches: [] })).toThrow(/version must be 1/);
  });

  it("fields: batch over importer over book default, the required fields always added, in claim order", () => {
    const b = book();
    const fb = fieldsFor(b, b.batches[1]);
    for (const r of REQUIRED_DISCLOSURES) expect(fb).toContain(r);
    expect(fb).toContain("specificEmbeddedEmissions_tCO2e_per_t");
    expect(fb).not.toContain("verifierLEI");
    expect(fb).toHaveLength(REQUIRED_DISCLOSURES.length + 1);
    expect(fieldsFor(b, b.batches[0])).toContain("verifierLEI"); // DEMO_DISCLOSURE default
    expect(fieldsFor(b, { ...b.batches[0], fields: ["energyMix"] })).toContain("energyMix");
  });

  it("vectors: batch key and importer commitment of the recorded Sepolia shipment and of attack 2b", () => {
    const parsed = parseBook(exampleBook);
    const [demoBatch] = batchKeysOf(parsed, reportRefOf(cred));
    const [reportKey, batchKey, , commit2] = demoData.attacks.sameBatch.args as Hex[];
    expect(reportKeyOf(cred.core.d)).toBe(reportKey);
    expect(demoBatch).toBe(batchKey);
    expect(importerCommitOf("DEDEMO000000002", fixture.importer2Salt)).toBe(commit2);
  });

  it("file names keep only safe characters", () => {
    expect(proofFileName("acme/eu", "../B 1")).toBe("acme_eu--__B_1--093d4357e8.proof.json");
    expect(proofFileName(".hidden", "B")).toBe("_hidden--B--994e969e54.proof.json");
  });
});

describe("reconcile", () => {
  it("claimed + planned within the remaining tonnes: OK, per-importer totals, share pack plan", () => {
    const r = reconcile(book({ batches: book().batches.slice(0, 2) }), REF, snap({}, B1));
    expect(r.ok).toBe(true);
    expect(r.batches.map((b) => b.state)).toEqual(["claimed", "planned"]);
    expect(r.importers).toEqual([
      { id: "a", name: "Importer A (fictional)", claimedKg: 200_000n, plannedKg: 0n, refusedKg: 0n, batches: 1 },
      { id: "b", name: "Importer B (fictional)", claimedKg: 0n, plannedKg: 200_000n, refusedKg: 0n, batches: 1 },
    ]);
    expect(r.totals).toMatchObject({ claimedKg: 200_000n, plannedKg: 200_000n, refusedKg: 0n, remainingAfterPlanKg: 100_000n, unaccountedKg: 0n });
    expect(r.sharePack[0].proofs[0]).toMatchObject({ file: "a--B-1--9be77812db.proof.json", ready: true });
    expect(r.sharePack[1].proofs[0].ready).toBe(false);
    expect(r.sharePack[1].fields).toHaveLength(REQUIRED_DISCLOSURES.length + 1);
  });

  it("a planned batch past the remaining tonnes is OVER_ALLOCATED (the contract would revert); later ones that fit stay planned", () => {
    const b = book();
    b.batches[1].quantityTonnes = "400";
    const r = reconcile(b, REF, snap({}, B1));
    expect(r.batches.map((x) => x.state)).toEqual(["claimed", "over-allocated", "planned"]);
    expect(r.issues.map((i) => i.code)).toEqual(["OVER_ALLOCATED"]);
    expect(r.issues[0].detail).toContain("400 t requested, 300 t left");
    expect(r.totals.remainingAfterPlanKg).toBe(200_000n);
    expect(r.importers[1].refusedKg).toBe(400_000n);
    expect(r.ok).toBe(false);
  });

  it("missing claim, wrong quantity, wrong importer commitment, stale book", () => {
    const b = book();
    b.batches[1].status = "claimed"; // B-2 never sent
    const s = snap({}, {
      "B-1": { kg: 150_000n, eori: "NLDEMO000000001", salt: salt("1") }, // quantity differs
      "B-3": { kg: 100_000n, eori: "NLDEMO000000001", salt: salt("3") }, // book says importer b, still planned
    });
    const r = reconcile(b, REF, s);
    expect(r.batches.map((x) => x.state)).toEqual(["mismatch", "missing", "mismatch"]);
    expect(r.issues.map((i) => `${i.code} ${i.batchId}`)).toEqual(["QUANTITY_MISMATCH B-1", "CLAIM_MISSING B-2", "IMPORTER_MISMATCH B-3"]);
    expect(r.batches[0].onchainQuantityKg).toBe(150_000n);
    expect(printAllocation(r)).toContain("[on-chain 150 t]");

    const stale = reconcile(book(), REF, snap({}, { ...B1, "B-3": { kg: 100_000n, eori: "DEDEMO000000002", salt: salt("3") } }));
    expect(stale.batches[2].state).toBe("claimed");
    expect(stale.issues.map((i) => i.code)).toEqual(["BOOK_STALE"]);
    expect(stale.ok).toBe(true);
  });

  it("report not claimable: revoked, replaced, expired, not registered; claimed batches of a revoked report are flagged", () => {
    const base = snap({}, B1);
    const revoked = reconcile(book(), REF, { ...base, report: { ...base.report, revokedAt: 1_790_000_300n }, claimable: false, remainingKg: 0n, shipments: { ...base.shipments, [key("B-1")]: { ...base.shipments[key("B-1")], reportValid: false } } });
    expect(revoked.report.state).toBe("revoked");
    expect(revoked.batches.map((b) => b.state)).toEqual(["claimed", "blocked", "blocked"]);
    expect(revoked.issues.map((i) => i.code)).toEqual(["REPORT_REVOKED", "REPORT_NOT_CLAIMABLE", "REPORT_NOT_CLAIMABLE"]);
    expect(revoked.sharePack[0].proofs[0].ready).toBe(false);
    expect(reconcile(book(), REF, { ...base, report: { ...base.report, supersededBy: salt("next") }, remainingKg: 0n }).report.state).toBe("replaced");
    expect(reconcile(book(), REF, { ...base, blockTime: 1_900_000_001n, claimable: false }).report.state).toBe("expired");
    expect(reconcile(book(), REF, { ...snap(), report: { ...base.report, registeredAt: 0n }, claimable: false }).report.state).toBe("not-registered");
    expect(() => reconcile(book(), { ...REF, credSAID: "Eother" }, base)).toThrow(/another credential/);
  });

  it("on-chain claims not in the book: listed from events (action), or counted from the ledger without events (warning)", () => {
    const base = snap({}, B1);
    const two = book({ batches: book().batches.slice(0, 2) }); // 200 t claimed + 200 t planned fit in the 270 t left
    const withEvents = reconcile(two, REF, {
      ...base,
      ledgerClaimedKg: 230_000n,
      remainingKg: 270_000n,
      events: [
        { batchKey: key("B-1"), quantityKg: 200_000n, importerCommit: ZERO32, cumulativeClaimedKg: 200_000n, claimedAt: 1n, blockNumber: 50n, txHash: `0x${"aa".repeat(32)}` },
        { batchKey: salt("stranger"), quantityKg: 30_000n, importerCommit: salt("c"), cumulativeClaimedKg: 230_000n, claimedAt: 2n, blockNumber: 60n, txHash: `0x${"bb".repeat(32)}` },
      ],
    });
    expect(withEvents.unknownClaims).toHaveLength(1);
    expect(withEvents.unknownClaims[0]).not.toHaveProperty("importerCommit");
    expect(withEvents.issues.map((i) => `${i.code}/${i.severity}`)).toEqual(["UNKNOWN_CLAIM/action"]);
    expect(withEvents.totals.unaccountedKg).toBe(30_000n);

    const noEvents = reconcile(two, REF, { ...base, ledgerClaimedKg: 230_000n, remainingKg: 270_000n });
    expect(noEvents.issues.map((i) => `${i.code}/${i.severity}`)).toEqual(["UNACCOUNTED_KG/warning"]);
    expect(noEvents.ok).toBe(true);
  });

  it("warns when two batches share an importer salt; the report never carries an EORI or a salt", () => {
    const b = book();
    b.batches[2].importerSalt = b.batches[1].importerSalt;
    const r = reconcile(b, REF, snap({}, B1));
    expect(r.issues.map((i) => `${i.code} ${i.batchId}`)).toEqual(["SALT_REUSED B-3"]);
    const text = JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + printAllocation(r);
    for (const secret of ["NLDEMO000000001", "DEDEMO000000002", salt("1"), salt("2"), REF.batchSalt]) expect(text).not.toContain(secret);
  });
});

describe("share pack", () => {
  it("one proof per claimed batch, each with its buyer's fields and shipment; planned batches skipped", () => {
    const b = parseBook(exampleBook);
    b.batches[2].status = "claimed";
    const evidence = { anchorEvidence: { x: 1 }, reportExtract: { y: 2 } };
    const { proofs, skipped } = buildSharePack(cred, b, { evidence });
    expect(proofs.map((p) => p.file)).toEqual(["demo-imports--BATCH-DEMO-2026-0001--7ff0d9a847.proof.json", "demo-nordic--BATCH-DEMO-2026-0003--b516fb340b.proof.json"]);
    expect(skipped).toEqual([{ batchId: "BATCH-DEMO-2026-0002", reason: "planned: send the claim first" }]);
    const [full, minimal] = proofs;
    expect(full.proof.disclosures).toHaveLength(21);
    expect(minimal.proof.disclosures.map((d) => decodeDisclosure(d).name)).toEqual(minimal.fields);
    expect(minimal.fields).not.toContain("verifierLEI");
    expect(full.proof.shipment).toEqual({ batchId: "BATCH-DEMO-2026-0001", quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: fixture.importerSalt });
    expect(full.proof.anchorEvidence).toEqual({ x: 1 });
    expect(full.proof.core).toBe(cred.coreJson);
    // The demo proof recorded on Sepolia discloses the same 21 fields for the same batch.
    const demoProof = JSON.parse(readFileSync(new URL("../../fixtures/sepolia-demo-proof.json", import.meta.url), "utf8"));
    expect([...full.proof.disclosures].sort()).toEqual([...demoProof.disclosures].sort());
    expect(buildSharePack(cred, b, { only: (x) => x.batchId !== "BATCH-DEMO-2026-0003" }).skipped[1].reason).toMatch(/not READY/);
  });
});
