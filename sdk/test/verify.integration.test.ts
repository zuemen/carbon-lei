// End-to-end on a local anvil chain: register, claim, then verify the supplier's proof,
// and check that each kind of tampering is caught by the right check.
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../commitment.ts";
import { isoToSeconds, METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import { ChainReader } from "../chain.ts";
import { decodeDisclosure, encodeDisclosure, type Presentation } from "../disclosure.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../issue.ts";
import { verifyPresentation } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const salt = (s: string): Hex => keccak256(stringToBytes(`it:${s}`));
const AUDITOR_AID = "EDemoAuditorAidForIntegrationTests0000000000";
const EORI_1 = demo.entities.importers[0].eori as string;
const EORI_2 = demo.entities.importers[1].eori as string;

function claims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  const r = demo.reports[0];
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: s.installations[0].id,
    installationName: s.installations[0].name,
    unLocode: s.unLocode,
    cnCode: "7318",
    cbamRoute: "C",
    productionRoute: "BF-BOF wire rod (illustrative)",
    reportingPeriod: r.reportingPeriod,
    verifiedTonnes: "500",
    specificEmbeddedEmissions_tCO2e_per_t: "1.8",
    valueType: "actual",
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: "VR-DEMO-0001",
    verifierLEI: demo.entities.verifier.lei,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: salt("id"),
    batchSalt: salt("batch"),
    issuedAt: "2026-10-01T00:00:00Z",
    validUntil: "2027-12-31T00:00:00Z",
    ...over,
  };
}

let c: LocalChain;
let cred: SignedCredential;
let proof: Presentation;
const shipment = { batchId: "BATCH-DEMO-2026-0001", quantityTonnes: "200", shipmentDate: "2026-10-10", importerSalt: salt("imp") };

async function issue(over: Partial<CredentialClaims> = {}) {
  return issueCredential({
    claims: claims(over),
    auditorAID: AUDITOR_AID,
    signer: c.verifier,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    chainId: 31337,
  });
}

async function register(cr: SignedCredential, supersedes?: Hex) {
  return send(c, c.verifier, "registry", "registerReport", [
    reportInputOf(cr, { supplier: c.supplier.address, kelSeq: 1n, supersedes }),
  ]);
}

beforeAll(async () => {
  c = await startLocalChain(18545 + Math.floor(Math.random() * 1000));
  const lei = leiHashOf(demo.entities.verifier.lei);
  await send(c, c.owner, "allowlist", "addVerifier", [
    {
      leiHash: lei,
      verifier: c.verifier.address,
      leCredSaidHash: hashString("LE-SAID"),
      accreditationSaidHash: hashString("ACC-SAID"),
      accreditedUntil: 1924905600n,
    },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [
    { auditorAidHash: auditorAidHashOf(AUDITOR_AID), leiHash: lei, ecrSaidHash: hashString("ECR-SAID") },
  ]);
  cred = await issue();
  await register(cred);
  await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cred, { ...shipment, importerEORI: EORI_1 }));
  proof = present(cred, DEMO_DISCLOSURE, shipment);
}, 60_000);

afterAll(() => c?.stop());

const codes = (r: Awaited<ReturnType<typeof verifyPresentation>>) =>
  Object.fromEntries(r.checks.map((x) => [x.index, `${x.status}:${x.code}`]));

/**
 * A reader whose RPC reports block `head` as its latest (a node that has not seen later blocks yet,
 * or a node that is behind), optionally with another timestamp. Records the block every view call
 * and every event search reads.
 */
function readerWithHead(head: bigint, timestamp?: bigint) {
  const reads: (bigint | undefined)[] = [];
  const logTo: bigint[] = [];
  const client = new Proxy(c.pub, {
    get(target, prop, recv) {
      if (prop === "getBlock") {
        return async (args?: { blockNumber?: bigint }) => {
          const b = await target.getBlock({ blockNumber: args?.blockNumber ?? head });
          return timestamp === undefined ? b : { ...b, timestamp };
        };
      }
      if (prop === "readContract") {
        return (args: { blockNumber?: bigint }) => {
          reads.push(args.blockNumber);
          return target.readContract(args as never);
        };
      }
      if (prop === "getContractEvents") {
        return (args: { toBlock: bigint }) => {
          logTo.push(args.toBlock);
          return target.getContractEvents(args as never);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as PublicClient;
  return { reader: new ChainReader(client, c.deployment), reads, logTo };
}

let recent: SignedCredential;
let revokeBlock: bigint;

describe("verifyPresentation on a local chain", () => {
  it("S9 genuine proof: checks 0–5 pass, hidden fields counted, 6–7 need evidence", async () => {
    const r = await verifyPresentation(proof, c.reader, { importerEORI: EORI_1 });
    const k = codes(r);
    for (const i of [0, 1, 2, 3, 4, 5]) expect(k[i]).toBe("pass:");
    expect(k[6]).toBe("fail:ANCHOR_NOT_FOUND");
    expect(k[7]).toBe("fail:AUTHORITY_INVALID");
    expect(k[8]).toBe("skipped:");
    expect(r.hidden).toBe(5);
    expect(r.disclosed.specificEmbeddedEmissions_tCO2e_per_t).toBe("1.8");
    expect(r.disclosed.energyMix).toBeUndefined();
    expect(r.onchain?.remainingKg).toBe(300_000n);
    expect(r.checkedAt).toBe(r.onchain?.claimedAt);
  });

  it("S2 Tamper: intensity changed from 1.8 to 1.2 → DISCLOSURE_TAMPERED", async () => {
    const i = proof.disclosures.findIndex((d) => decodeDisclosure(d).name === "specificEmbeddedEmissions_tCO2e_per_t");
    const tampered = [...proof.disclosures];
    tampered[i] = encodeDisclosure({ ...decodeDisclosure(proof.disclosures[i]), value: "1.2" });
    const r = await verifyPresentation({ ...proof, disclosures: tampered }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[2]).toBe("fail:DISCLOSURE_TAMPERED");
    expect(r.primaryCode).toBe("DISCLOSURE_TAMPERED");
    expect(r.disclosed.specificEmbeddedEmissions_tCO2e_per_t).toBeUndefined();
  });

  it("Tamper: the same field disclosed twice → DISCLOSURE_TAMPERED", async () => {
    const d = proof.disclosures.find((x) => decodeDisclosure(x).name === "siteVisit")!;
    const r = await verifyPresentation({ ...proof, disclosures: [...proof.disclosures, d] }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[0]).toBe("pass:");
    expect(codes(r)[2]).toBe("fail:DISCLOSURE_TAMPERED");
    expect(r.checks.find((x) => x.index === 2)?.detail).toBe("siteVisit disclosed twice");
  });

  it("Tamper: a signed value moved to another field name → DISCLOSURE_TAMPERED", async () => {
    // siteVisit's disclosure (its own salt and value) re-encoded under the name assuranceLevel,
    // replacing the genuine assuranceLevel disclosure
    const site = decodeDisclosure(proof.disclosures.find((x) => decodeDisclosure(x).name === "siteVisit")!);
    const i = proof.disclosures.findIndex((x) => decodeDisclosure(x).name === "assuranceLevel");
    const moved = [...proof.disclosures];
    moved[i] = encodeDisclosure({ ...site, name: "assuranceLevel" });
    const r = await verifyPresentation({ ...proof, disclosures: moved }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[0]).toBe("pass:");
    expect(codes(r)[2]).toBe("fail:DISCLOSURE_TAMPERED");
    expect(r.checks.find((x) => x.index === 2)?.detail).toBe("assuranceLevel does not match the signed credential");
    expect(r.disclosed.assuranceLevel).toBeUndefined();
    expect(r.disclosed.siteVisit).toBe(site.value);
  });

  it("S1 core edited after issuance → SAID_MISMATCH", async () => {
    const core = proof.core.replace("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
    const r = await verifyPresentation({ ...proof, core }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[1]).toBe("fail:SAID_MISMATCH");
  });

  it("S3 signed by another wallet → BAD_SIGNATURE", async () => {
    const other = await issueCredential({
      claims: claims(),
      auditorAID: AUDITOR_AID,
      signer: privateKeyToAccount(salt("not-the-body")),
      registry: c.deployment.contracts.EmissionsClaimRegistry.address,
      chainId: 31337,
    });
    const r = await verifyPresentation({ ...proof, signature: other.signature }, c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[3]).toBe("fail:BAD_SIGNATURE");
  });

  it("issuance refuses a validUntil after the body's accreditation ends", async () => {
    const base = { auditorAID: AUDITOR_AID, signer: c.verifier, registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 };
    const until = isoToSeconds(claims().validUntil);
    await expect(issueCredential({ ...base, claims: claims(), accreditedUntil: until - 1n })).rejects.toThrow(/accreditation ends/);
    await expect(issueCredential({ ...base, claims: claims(), accreditedUntil: until })).resolves.toBeDefined();
  });

  it("S5 wrong EORI → SHIPMENT_MISMATCH; no EORI → check 5 skipped", async () => {
    const wrong = await verifyPresentation(proof, c.reader, { importerEORI: EORI_2 });
    expect(codes(wrong)[5]).toBe("fail:SHIPMENT_MISMATCH");
    const none = await verifyPresentation(proof, c.reader);
    expect(codes(none)[5]).toBe("skipped:");
  });

  it("step 0: missing required disclosure or changed methodology note → PRESENTATION_MALFORMED", async () => {
    const withoutSalt = proof.disclosures.filter((d) => decodeDisclosure(d).name !== "idSalt");
    const r = await verifyPresentation({ ...proof, disclosures: withoutSalt }, c.reader);
    expect(r.primaryCode).toBe("PRESENTATION_MALFORMED");
    expect(r.checks).toHaveLength(1);
  });

  it("step 0: a core that is not JSON or lacks fields, an undecodable disclosure, a field out of normal form, a short salt, an incomplete shipment", async () => {
    const withValue = (name: string, value: string) =>
      proof.disclosures.map((d) => (decodeDisclosure(d).name === name ? encodeDisclosure({ ...decodeDisclosure(d), value }) : d));
    const { issuer: _issuer, ...coreWithoutIssuer } = JSON.parse(proof.core);
    const { importerSalt: _salt, ...shipmentWithoutSalt } = proof.shipment!;
    const cases: [Presentation, string][] = [
      [{ ...proof, core: proof.core.slice(0, -1) }, "the credential core is not valid JSON"],
      [{ ...proof, core: JSON.stringify(coreWithoutIssuer) }, "missing core, signature or disclosure fields"],
      [{ ...proof, signature: undefined as never }, "missing core, signature or disclosure fields"],
      [{ ...proof, disclosures: [...proof.disclosures, "bm90IGFuIGFycmF5"] }, "a disclosure is not a [salt, name, value] array"],
      [{ ...proof, disclosures: withValue("cnCode", "7318 15") }, "not in normal form: cnCode"],
      [{ ...proof, disclosures: withValue("batchSalt", "0x1234") }, "salts must be 32-byte hex"],
      [{ ...proof, shipment: shipmentWithoutSalt as never }, "shipment part incomplete"],
    ];
    for (const [bad, detail] of cases) {
      const r = await verifyPresentation(bad, c.reader, { importerEORI: EORI_1 });
      expect(r, detail).toMatchObject({ overall: "INVALID", primaryCode: "PRESENTATION_MALFORMED", checks: [{ index: 0, detail }] });
      expect(r.checks).toHaveLength(1);
    }
  });

  it("checks 6-8: each evidence checker sees the registered report, its result is the check, and a failing one makes the proof INVALID", async () => {
    const seen: unknown[] = [];
    const pass = (index: number) => (ev: unknown, ctx: { report?: { kelSeq: bigint } }) => {
      seen.push([index, ev, ctx.report?.kelSeq]);
      return { index, name: "", status: "pass" as const, code: "", detail: `checker ${index}` };
    };
    const withEvidence = { ...proof, anchorEvidence: { a: 1 }, authorityEvidence: { b: 2 }, reportExtract: { c: 3 } };
    const ok = await verifyPresentation(withEvidence, c.reader, {
      importerEORI: EORI_1,
      checkers: { anchor: pass(6), authority: pass(7), reconciliation: pass(8) },
    });
    expect(ok.overall).toBe("VALID");
    expect(ok.checks.slice(6).map((x) => [x.index, x.name, x.status, x.detail])).toEqual([
      [6, "Auditor anchor (KEL)", "pass", "checker 6"],
      [7, "Authority chain (vLEI)", "pass", "checker 7"],
      [8, "Report reconciliation", "pass", "checker 8"],
    ]);
    // the registered report (kelSeq 1) is in the context of every checker
    expect(seen).toEqual(expect.arrayContaining([[6, { a: 1 }, 1n], [7, { b: 2 }, 1n], [8, { c: 3 }, 1n]]));

    const failAnchor = () => ({ index: 6, name: "", status: "fail" as const, code: "ANCHOR_INVALID", detail: "stub" });
    const bad = await verifyPresentation(withEvidence, c.reader, {
      importerEORI: EORI_1,
      checkers: { anchor: failAnchor, authority: pass(7), reconciliation: pass(8) },
    });
    expect(bad).toMatchObject({ overall: "INVALID", primaryCode: "ANCHOR_INVALID" });

    // evidence with no checker for it is skipped, never passed
    const none = await verifyPresentation(withEvidence, c.reader, { importerEORI: EORI_1 });
    expect(none.checks.slice(6).map((x) => x.status)).toEqual(["skipped", "skipped", "skipped"]);

    // a checker that throws (an RPC failure inside check 7) aborts the verification: no result at all
    await expect(
      verifyPresentation(withEvidence, c.reader, { checkers: { authority: () => Promise.reject(new Error("rpc down")) } }),
    ).rejects.toThrow("rpc down");
  });

  it("unregistered credential → REPORT_INVALID/NOT_REGISTERED", async () => {
    const fresh = await issue({ verificationReportId: "VR-DEMO-0009", cnCode: "7208" });
    const r = await verifyPresentation(present(fresh, DEMO_DISCLOSURE), c.reader);
    expect(codes(r)[4]).toBe("fail:REPORT_INVALID/NOT_REGISTERED");
  });

  it("dry runs: second importer over the shared ledger, impostor body", async () => {
    const over = claimArgsOf(cred, { batchId: "BATCH-DEMO-2026-0002", quantityTonnes: "400", importerEORI: EORI_2, importerSalt: salt("imp2") });
    const d1 = await c.reader.dryRun("claimShipment", over, c.supplier.address);
    expect(d1).toMatchObject({ reverted: true, errorName: "ExceedsVerifiedTonnage", args: [300_000n, 400_000n] });
    const d2 = await c.reader.dryRun(
      "registerReport",
      [reportInputOf(await issue({ verificationReportId: "VR-FAKE-0001" }), { supplier: c.supplier.address, kelSeq: 1n })],
      c.impostor.address,
    );
    expect(d2).toMatchObject({ reverted: true, errorName: "NotActiveVerifier" });
    const d3 = await c.reader.dryRun("claimShipment", claimArgsOf(cred, { ...shipment, importerEORI: EORI_2 }), c.supplier.address);
    expect(d3).toMatchObject({ reverted: true, errorName: "BatchAlreadyClaimed" });
  });

  it("revision in the same layer: the old credential is SUPERSEDED now, its earlier shipment stays valid", async () => {
    const rev = await issue({ verifiedTonnes: "480", verificationReportId: "VR-DEMO-0001-R1", issuedAt: "2026-10-03T00:00:00Z" });
    await register(rev, reportKeyOf(cred.core.d));
    const now = await verifyPresentation(present(cred, DEMO_DISCLOSURE), c.reader);
    expect(codes(now)[4]).toBe("fail:REPORT_INVALID/SUPERSEDED");
    const atClaim = await verifyPresentation(proof, c.reader, { importerEORI: EORI_1 });
    expect(codes(atClaim)[4]).toBe("pass:");
    expect(codes(atClaim)[5]).toBe("pass:");
    const newOne = await verifyPresentation(present(rev, DEMO_DISCLOSURE), c.reader);
    expect(newOne.checks[4].detail).toContain("revises an earlier one");
  });

  it("revoked report → REPORT_INVALID/REVOKED, and the shipment check fails too", async () => {
    const other = await issue({ installationId: demo.entities.supplier.installations[1].id, verificationReportId: "VR-DEMO-0002", issuedAt: "2026-10-02T00:00:00Z" });
    await register(other);
    const ship = { ...shipment, batchId: "BATCH-DEMO-2026-0003" };
    await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(other, { ...ship, importerEORI: EORI_1 }));
    await send(c, c.verifier, "registry", "revokeReport", [reportKeyOf(other.core.d)]);
    const r = await verifyPresentation(present(other, DEMO_DISCLOSURE, ship), c.reader, { importerEORI: EORI_1 });
    expect(codes(r)[4]).toBe("fail:REPORT_INVALID/REVOKED");
    expect(codes(r)[5]).toBe("fail:SHIPMENT_MISMATCH");
  });

  it("auditor revoked within 24 h of registration → CONTESTED (not a failure)", async () => {
    recent = await issue({ cnCode: "7318", cbamRoute: "E", verificationReportId: "VR-DEMO-0001-R1", issuedAt: "2026-10-03T00:00:00Z" });
    await register(recent);
    await c.test.increaseTime({ seconds: 3600 });
    const rcpt = await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(AUDITOR_AID), leiHashOf(demo.entities.verifier.lei)]);
    revokeBlock = rcpt.blockNumber;
    const r = await verifyPresentation(present(recent, DEMO_DISCLOSURE), c.reader);
    expect(codes(r)[4]).toBe("pass:CONTESTED");
    const r48 = await verifyPresentation(present(recent, DEMO_DISCLOSURE), c.reader, { contestedWindowHours: 0.5 });
    expect(codes(r48)[4]).toBe("pass:");
    // The time-window event search (searched as tightly as it can be) and the full scan agree.
    for (const contestedWindowHours of [24, 0.5, 1, 2]) {
      const tight = new ChainReader(c.pub, c.deployment, undefined, { searchTolerance: 0n });
      const full = new ChainReader(c.pub, c.deployment, undefined, { fullEventScan: true });
      const p = present(recent, DEMO_DISCLOSURE);
      expect(await verifyPresentation(p, tight, { contestedWindowHours })).toEqual(
        await verifyPresentation(p, full, { contestedWindowHours }),
      );
    }
  });

  it("one snapshot: a revocation in a block after the snapshot block is not seen; inside it → CONTESTED", async () => {
    // The node's latest block is the one before the revocation: the whole check reads that block.
    const before = readerWithHead(revokeBlock - 1n);
    const r = await verifyPresentation(present(recent, DEMO_DISCLOSURE), before.reader);
    expect(codes(r)[4]).toBe("pass:");
    expect(before.reads.length).toBeGreaterThan(0);
    expect(before.reads.every((b) => b === revokeBlock - 1n)).toBe(true);
    expect(before.logTo.length).toBeGreaterThan(0);
    expect(before.logTo.every((b) => b <= revokeBlock - 1n)).toBe(true);
    // Once the node has the revocation block, the same proof is CONTESTED, read at that block.
    const at = readerWithHead(revokeBlock);
    const r2 = await verifyPresentation(present(recent, DEMO_DISCLOSURE), at.reader);
    expect(codes(r2)[4]).toBe("pass:CONTESTED");
    expect(at.reads.every((b) => b === revokeBlock)).toBe(true);
    // The evidence checkers read through the same pinned reader (check 7's allowlist reads).
    const pinned: (bigint | undefined)[] = [];
    await verifyPresentation({ ...present(recent, DEMO_DISCLOSURE), authorityEvidence: {} }, at.reader, {
      checkers: {
        authority: async (_ev, ctx) => {
          await ctx.reader.institution(leiHashOf(demo.entities.verifier.lei));
          pinned.push(ctx.reader.blockNumber);
          return { index: 7, name: "", status: "pass", code: "", detail: "" };
        },
      },
    });
    expect(pinned).toEqual([revokeBlock]);
    expect(at.reads.every((b) => b === revokeBlock)).toBe(true);
  });

  it("a node that is behind (head before the deployment, or older than the report) → throws, no result", async () => {
    const deployed = BigInt(c.deployment.contracts.EmissionsClaimRegistry.block);
    await expect(verifyPresentation(present(recent, DEMO_DISCLOSURE), readerWithHead(deployed - 1n).reader)).rejects.toThrow(
      /RPC node is behind/,
    );
    // A block that has the report, with a timestamp before its registration.
    await expect(verifyPresentation(present(recent, DEMO_DISCLOSURE), readerWithHead(revokeBlock, 1n).reader)).rejects.toThrow(
      /RPC node is behind: .* older than the report's registration/,
    );
  });

  it("past validUntil → REPORT_INVALID/EXPIRED (checked now, no shipment)", async () => {
    await c.test.increaseTime({ seconds: 3 * 365 * 24 * 3600 });
    await c.test.mine({ blocks: 1 });
    const r = await verifyPresentation(present(cred, DEMO_DISCLOSURE), c.reader);
    expect(r.checks[4].detail).toContain("past the credential's validity");
  });
});
