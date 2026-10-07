// Verifier hardening on a local anvil chain, one case per finding of the verifier red-team review (2026-10-07):
// claim time only for the importer the batch was declared to (H2), a node that is behind (M1), evidence checks
// that were not run (L1), repeated keys and "__proto__" in the core (L2), the deployment's chain ID (L3), the
// shipment fields (L4), a malformed report extract (L7), and checks 0-3 without a chain (offline view); and the
// second round (N-M1, N-L2, N-L3, N-L6): what the PACT export refuses, checkers that only warn, strict times, and
// repeated keys in the proof text.
// Checks 6 and 7 are stubbed as passing where a case is about the other checks.
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../commitment.ts";
import { ChainReader } from "../chain.ts";
import { sha256Hex, vleiCheckers } from "../checkers.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import type { Presentation } from "../disclosure.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../issue.ts";
import { exportPactFromProof } from "../pact.ts";
import { verdictFor, exitCodeOf } from "../verdict.ts";
import { verifyOffline, verifyPresentation, type CheckResult, type VerificationResult } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";
import { verdictSchemaErrors } from "./helpers/verdict-schema.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const salt = (s: string): Hex => keccak256(stringToBytes(`hardening:${s}`));
const AUDITOR_AID = "EDemoAuditorAidForIntegrationTests0000000000";
const EORI_1 = demo.entities.importers[0].eori as string;
const EORI_2 = demo.entities.importers[1].eori as string;
const YEAR = 365 * 24 * 3600;

function claims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: s.installations[0].id,
    installationName: s.installations[0].name,
    unLocode: s.unLocode,
    cnCode: "7318",
    cbamRoute: "C",
    productionRoute: "BF-BOF (illustrative)",
    reportingPeriod: demo.reports[0].reportingPeriod,
    verifiedTonnes: "500",
    specificEmbeddedEmissions_tCO2e_per_t: "1.8",
    valueType: "actual",
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: "VR-HARD-0001",
    verifierLEI: demo.entities.verifier.lei,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld",
    supplierCost: "withheld",
    idSalt: salt("id"),
    batchSalt: salt("batch"),
    issuedAt: "2026-10-01T00:00:00Z",
    validUntil: "2027-12-31T00:00:00Z",
    ...over,
  };
}

const stub = (index: number) => (): CheckResult => ({ index, name: "", status: "pass", code: "", detail: "stub" });
const STUBS = { anchor: stub(6), authority: stub(7) };
const withEv = (p: Presentation): Presentation => ({ ...p, anchorEvidence: { stub: true }, authorityEvidence: { stub: true } });
const line = (r: VerificationResult) => r.checks.map((x) => `${x.index}:${x.status}${x.code ? `(${x.code})` : ""}`);
const check = (r: VerificationResult, i: number) => r.checks.find((x) => x.index === i)!;

let c: LocalChain;
const issue = (over: Partial<CredentialClaims> = {}) =>
  issueCredential({
    claims: claims(over),
    auditorAID: AUDITOR_AID,
    signer: c.verifier,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    chainId: 31337,
  });
const register = (cr: SignedCredential, supersedes?: Hex) =>
  send(c, c.verifier, "registry", "registerReport", [reportInputOf(cr, { supplier: c.supplier.address, kelSeq: 1n, supersedes })]);
const claim = (cr: SignedCredential, s: { batchId: string; quantityTonnes: string; importerSalt: Hex }, eori: string) =>
  send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cr, { ...s, importerEORI: eori }));

beforeAll(async () => {
  c = await startLocalChain(24545 + Math.floor(Math.random() * 1000));
  const lei = leiHashOf(demo.entities.verifier.lei);
  await send(c, c.owner, "allowlist", "addVerifier", [
    { leiHash: lei, verifier: c.verifier.address, leCredSaidHash: hashString("LE"), accreditationSaidHash: hashString("ACC"), accreditedUntil: 1924905600n },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(AUDITOR_AID), leiHash: lei, ecrSaidHash: hashString("ECR") }]);
}, 60_000);

afterAll(() => c?.stop());

describe("claim time only for the importer the batch was declared to", () => {
  it("a superseded credential with an old shipment for someone else: INVALID without an EORI or with another EORI; valid when shipped for the importer it was declared to; then expired the same way", async () => {
    const credA = await issue();
    await register(credA);
    const ship = { batchId: "BATCH-HARD-0001", quantityTonnes: "100", shipmentDate: "2026-10-10", importerSalt: salt("imp1") };
    await claim(credA, ship, EORI_1);
    // The verification body revises the credential: 1.8 → 2.6, superseding A.
    const credB = await issue({ specificEmbeddedEmissions_tCO2e_per_t: "2.6", verificationReportId: "VR-HARD-0001-R1", issuedAt: "2026-10-03T00:00:00Z" });
    await register(credB, reportKeyOf(credA.core.d));
    await c.test.increaseTime({ seconds: 3600 });
    await c.test.mine({ blocks: 1 });
    const oldShip = withEv(present(credA, DEMO_DISCLOSURE, ship));
    const head = (await c.pub.getBlock()).timestamp;

    // No EORI: before the fix VALID (claimedAt used); now judged at the head block → superseded.
    const noEori = await verifyPresentation(oldShip, c.reader, { checkers: STUBS });
    expect([noEori.overall, noEori.primaryCode]).toEqual(["INVALID", "REPORT_INVALID/SUPERSEDED"]);
    expect(check(noEori, 5).status).toBe("skipped");
    expect(noEori.checkedAt).toBe(head);
    expect(noEori.warnings?.map((w) => w.code)).toEqual(["SHIPMENT_NOT_BOUND"]);
    // The verdict (`verify --json` without --eori): INVALID, exit 1, with the warning, schema-valid.
    const v = await verdictFor(oldShip, c.reader, { checkers: STUBS });
    expect([v.overall, exitCodeOf(v), v.warnings.map((w) => w.code)]).toEqual(["INVALID", 1, ["SHIPMENT_NOT_BOUND"]]);
    expect(verdictSchemaErrors(v)).toEqual([]);
    // Another importer's EORI: check 5 fails, and check 4 is judged at the head block too.
    const other = await verifyPresentation(oldShip, c.reader, { importerEORI: EORI_2, checkers: STUBS });
    expect(line(other).slice(4, 6)).toEqual(["4:fail(REPORT_INVALID/SUPERSEDED)", "5:fail(SHIPMENT_MISMATCH)"]);
    // The importer it was declared to: valid when shipped (T4), at the claim time.
    const mine = await verifyPresentation(oldShip, c.reader, { importerEORI: EORI_1, checkers: STUBS });
    expect([mine.overall, check(mine, 5).status]).toEqual(["VALID", "pass"]);
    expect(mine.checkedAt).toBeLessThan(head);
    expect(mine.warnings).toEqual([]);

    // The PACT export of the superseded credential states Deprecated for anyone but the importer it was declared to;
    // with another importer's EORI check 5 fails as well, and nothing is exported (red-team round 2, N-M1).
    const prod = { companyName: "X", productNameCompany: "Y", productDescription: "Z", productId: "p" };
    expect((await exportPactFromProof(oldShip, noEori, c.reader, prod)).status).toBe("Deprecated");
    await expect(exportPactFromProof(oldShip, other, c.reader, prod)).rejects.toThrow("the proof fails check 5 (SHIPMENT_MISMATCH");
    expect((await exportPactFromProof(oldShip, mine, c.reader, prod)).status).toBe("Active");

    // Three years later both credentials are past validUntil.
    await c.test.increaseTime({ seconds: 3 * YEAR });
    await c.test.mine({ blocks: 1 });
    const later = await verifyPresentation(oldShip, c.reader, { checkers: STUBS });
    expect(later.overall).toBe("INVALID");
    expect(check(later, 4).code).toBe("REPORT_INVALID/SUPERSEDED");
    expect(check(later, 4).detail).toContain("past the credential's validity");
    // Superseded and expired: not only superseded, so not exported as Deprecated either.
    await expect(exportPactFromProof(oldShip, later, c.reader, prod)).rejects.toThrow("the proof fails check 4 (REPORT_INVALID/SUPERSEDED");
    expect((await verifyPresentation(oldShip, c.reader, { importerEORI: EORI_1, checkers: STUBS })).overall).toBe("VALID");
  });

  it("an expired credential (not superseded) with an old shipment for someone else: REPORT_INVALID/EXPIRED without the importer's EORI", async () => {
    const now = (await c.pub.getBlock()).timestamp;
    const until = new Date(Number(now + 30n * 24n * 3600n) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const cr = await issue({
      installationId: demo.entities.supplier.installations[1].id,
      verificationReportId: "VR-HARD-0002",
      reportingPeriod: "2029-01-01/2029-12-31",
      issuedAt: "2029-01-02T00:00:00Z",
      validUntil: until,
    });
    await register(cr);
    const ship = { batchId: "BATCH-HARD-0002", quantityTonnes: "50", shipmentDate: "2029-01-10", importerSalt: salt("imp2") };
    await claim(cr, ship, EORI_1);
    await c.test.increaseTime({ seconds: 60 * 24 * 3600 });
    await c.test.mine({ blocks: 1 });
    const p = withEv(present(cr, DEMO_DISCLOSURE, ship));
    const unbound = await verifyPresentation(p, c.reader, { checkers: STUBS });
    expect([unbound.overall, unbound.primaryCode]).toEqual(["INVALID", "REPORT_INVALID/EXPIRED"]);
    const wrong = await verifyPresentation(p, c.reader, { importerEORI: EORI_2, checkers: STUBS });
    expect(check(wrong, 4).code).toBe("REPORT_INVALID/EXPIRED");
    expect((await verifyPresentation(p, c.reader, { importerEORI: EORI_1, checkers: STUBS })).overall).toBe("VALID");
    // Red-team round 2 (N-M1): an expired credential is not exported (before the fix: status Active).
    const prod = { companyName: "X", productNameCompany: "Y", productDescription: "Z", productId: "p" };
    for (const r of [unbound, wrong]) {
      await expect(exportPactFromProof(p, r, c.reader, prod)).rejects.toThrow("the proof fails check 4 (REPORT_INVALID/EXPIRED");
    }
    const noShip = await verifyPresentation(withEv(present(cr, DEMO_DISCLOSURE)), c.reader, { importerEORI: EORI_2, checkers: STUBS });
    expect([noShip.primaryCode, check(noShip, 5).status]).toEqual(["REPORT_INVALID/EXPIRED", "skipped"]);
    await expect(exportPactFromProof(p, noShip, c.reader, prod)).rejects.toThrow("the proof fails check 4 (REPORT_INVALID/EXPIRED");
  });
});

describe("fail closed on the reader", () => {
  let cr: SignedCredential;
  beforeAll(async () => {
    cr = await issue({
      installationId: demo.entities.supplier.installations[1].id,
      verificationReportId: "VR-HARD-0003",
      reportingPeriod: "2030-01-01/2030-12-31",
      issuedAt: "2030-01-02T00:00:00Z",
      validUntil: "2035-12-31T00:00:00Z",
    });
    await register(cr);
  });

  it("a node behind the revocation: refused with the head-age limit; without a limit it would read the old state", async () => {
    const before = await c.pub.getBlock();
    await send(c, c.verifier, "registry", "revokeReport", [reportKeyOf(cr.core.d)]);
    await c.test.increaseTime({ seconds: 6 * 3600 });
    await c.test.mine({ blocks: 1 });
    const head = await c.pub.getBlock();
    // A node that stopped at the block before the revocation (behind a load balancer).
    const lagging = new Proxy(c.pub, {
      get(t, prop, recv) {
        if (prop === "getBlock") return (a?: { blockNumber?: bigint }) => t.getBlock({ blockNumber: a?.blockNumber ?? before.number });
        return Reflect.get(t, prop, recv);
      },
    });
    const lagReader = new ChainReader(lagging as never, c.deployment);
    const p = withEv(present(cr, DEMO_DISCLOSURE));
    const clock = () => Number(head.timestamp) * 1000;
    expect((await verifyPresentation(p, c.reader, { checkers: STUBS, maxHeadAgeSec: 300, now: clock })).primaryCode).toBe("REPORT_INVALID/REVOKED");
    await expect(verifyPresentation(p, lagReader, { checkers: STUBS, maxHeadAgeSec: 300, now: clock })).rejects.toThrow(
      `RPC node is behind: its latest block ${before.number} is ${head.timestamp - before.timestamp} s old, more than the 300 s allowed`,
    );
    // The limit is the protection: with none (the default on a local chain) the lagging node shows the old state.
    expect((await verifyPresentation(p, lagReader, { checkers: STUBS })).overall).toBe("VALID");
  });

  it("no checkers for evidence the proof carries: INCOMPLETE (exit 4), never VALID", async () => {
    const fresh = await issue({
      installationId: demo.entities.supplier.installations[1].id,
      verificationReportId: "VR-HARD-0004",
      reportingPeriod: "2031-01-01/2031-12-31",
      issuedAt: "2031-01-02T00:00:00Z",
      validUntil: "2036-12-31T00:00:00Z",
    });
    await register(fresh);
    const p = { ...present(fresh, DEMO_DISCLOSURE), anchorEvidence: "garbage", authorityEvidence: 0 } as unknown as Presentation;
    const r = await verifyPresentation(p, c.reader);
    expect([r.overall, r.primaryCode]).toEqual(["INCOMPLETE", ""]);
    expect(line(r).slice(6, 8)).toEqual(["6:skipped", "7:skipped"]);
    expect(r.warnings?.map((w) => w.code)).toEqual(["EVIDENCE_NOT_CHECKED"]);
    const v = await verdictFor(p, c.reader, { checkers: {} });
    expect([v.overall, exitCodeOf(v)]).toEqual(["INCOMPLETE", 4]);
    expect(verdictSchemaErrors(v)).toEqual([]);
    const prod = { companyName: "X", productNameCompany: "Y", productDescription: "Z", productId: "p" };
    await expect(exportPactFromProof(p, r, c.reader, prod)).rejects.toThrow(/INCOMPLETE/);
  });

  it("an RPC on another chain than the deployment names: refused, not checked", async () => {
    const wrong = new ChainReader(c.pub, { ...c.deployment, chainId: 11155111 });
    await expect(verifyPresentation(present(cr, DEMO_DISCLOSURE), wrong, { maxHeadAgeSec: Infinity })).rejects.toThrow(
      "RPC is on chain 31337, but the deployment is for chain 11155111",
    );
  });
});

describe("the proof's own text", () => {
  let cr: SignedCredential;
  const ship = { batchId: "BATCH-HARD-0005", quantityTonnes: "50", shipmentDate: "2026-10-10", importerSalt: salt("imp5") };
  beforeAll(async () => {
    cr = await issue({
      installationId: demo.entities.supplier.installations[1].id,
      verificationReportId: "VR-HARD-0005",
      reportingPeriod: "2032-01-01/2032-12-31",
      issuedAt: "2032-01-02T00:00:00Z",
      validUntil: "2037-12-31T00:00:00Z",
    });
    await register(cr);
    await claim(cr, ship, EORI_1);
  });

  it("a repeated key or a top-level __proto__ key in the core fails check 1, the unchanged core passes", async () => {
    const p = present(cr, DEMO_DISCLOSURE);
    const real = JSON.parse(p.core).validUntil;
    const dup = { ...p, core: p.core.replace(`"validUntil":"${real}"`, `"validUntil":"2099-12-31T00:00:00Z","validUntil":"${real}"`) };
    const proto = { ...p, core: p.core.replace(/^\{/, '{"__proto__":{"note":"unsigned text"},') };
    const nested = { ...p, core: p.core.replace(/"issuer":\{/, '"issuer":{"verifierLEI":"FAKE",') };
    for (const [q, detail] of [
      [dup, 'the credential core repeats the key "validUntil"'],
      [proto, 'the credential core has a top-level "__proto__" key'],
      [nested, 'the credential core repeats the key "verifierLEI"'],
    ] as const) {
      const r = await verifyPresentation(q, c.reader);
      expect(check(r, 1)).toMatchObject({ status: "fail", code: "SAID_MISMATCH", detail });
      expect(r.overall).toBe("INVALID");
    }
    expect(check(await verifyPresentation(p, c.reader), 1).status).toBe("pass");
  });

  it("shipment fields in normal form only; check 5 shows the on-chain quantity", async () => {
    const good = present(cr, DEMO_DISCLOSURE, ship);
    const ok = await verifyPresentation(good, c.reader, { importerEORI: EORI_1 });
    expect(check(ok, 5)).toMatchObject({ status: "pass", detail: "50 t declared to you on the shared ledger" });
    // Same quantity in another form: before the fix it passed and echoed " 0050.000  t".
    for (const [field, value] of [
      ["quantityTonnes", " 0050.000 "],
      ["quantityTonnes", "050"],
      ["quantityTonnes", "50.0000"],
      ["quantityTonnes", "+50"],
      ["shipmentDate", "1999-01-01 (any text)"],
      ["shipmentDate", "2026-02-30"],
      ["shipmentDate", "2026-10-10T00:00:00Z"],
      ["batchId", " BATCH-HARD-0005"],
      ["batchId", "BATCH\nHARD"],
    ] as const) {
      const r = await verifyPresentation({ ...good, shipment: { ...ship, [field]: value } }, c.reader, { importerEORI: EORI_1 });
      expect(r.checks).toEqual([
        { index: 0, name: "Structure", status: "fail", code: "PRESENTATION_MALFORMED", detail: `shipment fields not in normal form: ${field}` },
      ]);
    }
    // "50.000" is a normal form of 50 t; the detail shows the ledger's quantity.
    const zeros = await verifyPresentation({ ...good, shipment: { ...ship, quantityTonnes: "50.000" } }, c.reader, { importerEORI: EORI_1 });
    expect(check(zeros, 5).detail).toBe("50 t declared to you on the shared ledger");
  });

  it("a malformed report extract gives INVALID (check 0), not an exception", async () => {
    const p = present(cr, DEMO_DISCLOSURE);
    for (const extract of [{ quantityPerCn: 1 }, [], "x", { quantityPerCn: [], specificEmbeddedEmissionsPerCn: [{ cnCode: 7318, value: "1" }], accreditationScope: [], signedAt: "" }]) {
      const r = await verifyPresentation({ ...p, reportExtract: extract } as unknown as Presentation, c.reader);
      expect([r.overall, r.primaryCode]).toEqual(["INVALID", "PRESENTATION_MALFORMED"]);
      expect(check(r, 0).detail).toMatch(/^report extract fields of the wrong type|^the report extract is not a JSON object/);
    }
  });
});

describe("checks 0-3 without a chain (the demo's offline view)", () => {
  it("runs checks 0-3 against the deployment's registry and chain ID; 4-8 not run; INCOMPLETE or INVALID, never VALID", async () => {
    const cr = await issue({ verificationReportId: "VR-HARD-0006", installationId: demo.entities.supplier.installations[1].id, reportingPeriod: "2033-01-01/2033-12-31", issuedAt: "2033-01-02T00:00:00Z", validUntil: "2038-12-31T00:00:00Z" });
    const dep = { registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 };
    const p = present(cr, DEMO_DISCLOSURE);
    const r = await verifyOffline(p, dep);
    expect(r.overall).toBe("INCOMPLETE");
    expect(line(r)).toEqual(["0:pass", "1:pass", "2:pass", "3:pass", "4:skipped", "5:skipped", "6:skipped", "7:skipped", "8:skipped"]);
    expect(check(r, 4).detail).toBe("not run: needs a live connection to the chain");
    // Tampered disclosure → check 2 fails; another chain ID → check 3 fails; not JSON-shaped → check 0.
    const enc = p.disclosures.map((d) => d.replace(/.$/, (ch) => (ch === "A" ? "B" : "A")));
    expect((await verifyOffline({ ...p, disclosures: [enc[0], ...p.disclosures.slice(1)] }, dep)).overall).toBe("INVALID");
    expect(check(await verifyOffline(p, { ...dep, chainId: 1 }), 3).code).toBe("BAD_SIGNATURE");
    const junk = await verifyOffline({ core: "{}", note: "not a proof" } as unknown as Presentation, dep);
    expect([junk.overall, junk.primaryCode]).toEqual(["INVALID", "PRESENTATION_MALFORMED"]);
  });
});

describe("authority evidence that is not JSON", () => {
  it("a bundle file that matches its hash but is not JSON fails check 7 (INVALID), not an exception", async () => {
    const cr = await issue({ verificationReportId: "VR-HARD-0007", installationId: demo.entities.supplier.installations[1].id, reportingPeriod: "2034-01-01/2034-12-31", issuedAt: "2034-01-02T00:00:00Z", validUntil: "2039-12-31T00:00:00Z" });
    await register(cr);
    const text = "not json {";
    const p = { ...present(cr, DEMO_DISCLOSURE), anchorEvidence: { stub: true }, authorityEvidence: { bundle: "evidence/broken.json", sha256: sha256Hex(text) } };
    const r = await verifyPresentation(p, c.reader, { checkers: { ...vleiCheckers({ loadBundle: async () => text }), anchor: stub(6) } });
    expect(check(r, 7)).toMatchObject({ status: "fail", code: "AUTHORITY_INVALID", detail: "the authority evidence file is not valid JSON" });
    expect([r.overall, r.primaryCode]).toEqual(["INVALID", "AUTHORITY_INVALID"]);
    const v = await verdictFor(p, c.reader, { loadBundle: () => text });
    expect([v.overall, exitCodeOf(v)]).toEqual(["INVALID", 1]);
  });
});

describe("red-team round 2", () => {
  const prod = { companyName: "X", productNameCompany: "Y", productDescription: "Z", productId: "p" };
  const AUDITOR_2 = "EDemoAuditorTwoForIntegrationTests000000000";

  it("N-L2: CONTESTED without evidence checkers, or with a checker that only warns: export refused; warn alone is INCOMPLETE, not VALID", async () => {
    const lei = leiHashOf(demo.entities.verifier.lei);
    await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(AUDITOR_2), leiHash: lei, ecrSaidHash: hashString("ECR2") }]);
    const cr = await issueCredential({
      claims: claims({ installationId: demo.entities.supplier.installations[1].id, verificationReportId: "VR-HARD-0101", reportingPeriod: "2040-01-01/2040-12-31", issuedAt: "2040-01-02T00:00:00Z", validUntil: "2045-12-31T00:00:00Z" }),
      auditorAID: AUDITOR_2,
      signer: c.verifier,
      registry: c.deployment.contracts.EmissionsClaimRegistry.address,
      chainId: 31337,
    });
    await register(cr);
    // A checker of the caller's own that answers `warn` for checks 6 and 7 (before the revocation: no CONTESTED).
    const warn = (index: number) => (): CheckResult => ({ index, name: "", status: "warn", code: "", detail: "maybe" });
    const warnCk = { anchor: warn(6), authority: warn(7) };
    const p = withEv(present(cr, DEMO_DISCLOSURE));
    const warned = await verifyPresentation(p, c.reader, { checkers: warnCk });
    expect(warned.overall).toBe("INCOMPLETE");
    expect(warned.warnings).toEqual([
      { code: "EVIDENCE_NOT_CHECKED", detail: "checks 6 and 7 gave only a warning: the evidence checker did not confirm the evidence" },
    ]);
    const mixed = await verifyPresentation(p, c.reader, { checkers: { anchor: warn(6) } });
    expect(mixed.warnings?.find((w) => w.code === "EVIDENCE_NOT_CHECKED")?.detail).toBe(
      "check 7 not run: no evidence checker was supplied; check 6 gave only a warning: the evidence checker did not confirm the evidence",
    );
    await expect(exportPactFromProof(p, warned, c.reader, prod)).rejects.toThrow(/INCOMPLETE/);

    // The auditor is revoked within 24 h of the registration: check 4 CONTESTED.
    await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(AUDITOR_2), lei]);
    const bare = { ...present(cr, DEMO_DISCLOSURE), anchorEvidence: "garbage", authorityEvidence: 0 } as unknown as Presentation;
    const contested = await verifyPresentation(bare, c.reader);
    expect([contested.overall, check(contested, 4).code]).toEqual(["CONTESTED", "CONTESTED"]);
    expect(line(contested).slice(6, 8)).toEqual(["6:skipped", "7:skipped"]);
    expect(contested.warnings?.map((w) => w.code)).toEqual(["EVIDENCE_NOT_CHECKED"]);
    // Before the fix: exported with status Active.
    await expect(exportPactFromProof(bare, contested, c.reader, prod)).rejects.toThrow("check 6 did not pass (skipped)");
    const contestedWarn = await verifyPresentation(p, c.reader, { checkers: warnCk });
    expect(contestedWarn.overall).toBe("CONTESTED");
    await expect(exportPactFromProof(p, contestedWarn, c.reader, prod)).rejects.toThrow("check 6 did not pass (warn)");
    const contestedFull = await verifyPresentation(p, c.reader, { checkers: STUBS });
    expect(contestedFull.overall).toBe("CONTESTED");
    await expect(exportPactFromProof(p, contestedFull, c.reader, prod)).rejects.toThrow(/CONTESTED/);
  });

  it("N-L6: a proof text that repeats a key outside the core fails check 0 (CLI, verdict, offline view); the same proof without the text is unchanged", async () => {
    const cr = await issue({ installationId: demo.entities.supplier.installations[1].id, verificationReportId: "VR-HARD-0102", reportingPeriod: "2041-01-01/2041-12-31", issuedAt: "2041-01-02T00:00:00Z", validUntil: "2046-12-31T00:00:00Z" });
    await register(cr);
    const ship = { batchId: "BATCH-HARD-0102", quantityTonnes: "10", shipmentDate: "2041-02-01", importerSalt: salt("imp102") };
    const p = withEv(present(cr, DEMO_DISCLOSURE, ship));
    const text = JSON.stringify(p, null, 2);
    const twoShipments = text.replace('{\n  "core"', `{\n  "shipment": ${JSON.stringify({ ...ship, quantityTonnes: "999" })},\n  "core"`);
    expect(twoShipments).not.toBe(text);
    const parsed = JSON.parse(twoShipments) as Presentation;
    const detail = 'the proof repeats the key "shipment"';
    const r = await verifyPresentation(parsed, c.reader, { checkers: STUBS, proofText: twoShipments });
    expect(r.checks).toEqual([{ index: 0, name: "Structure", status: "fail", code: "PRESENTATION_MALFORMED", detail }]);
    const v = await verdictFor(parsed, c.reader, { checkers: STUBS, proofText: twoShipments });
    expect([v.overall, exitCodeOf(v), v.checks[0].detail]).toEqual(["INVALID", 1, detail]);
    const dep = { registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 };
    expect((await verifyOffline(parsed, dep, { proofText: twoShipments })).checks[0].detail).toBe(detail);
    // A nested repeat (inside the evidence) is refused too.
    const nested = text.replace('"anchorEvidence": {', '"anchorEvidence": {\n    "stub": false,');
    expect((await verifyPresentation(JSON.parse(nested), c.reader, { checkers: STUBS, proofText: nested })).checks[0].detail).toBe(
      'the proof repeats the key "stub"',
    );
    // The original text passes as before.
    expect((await verifyPresentation(p, c.reader, { checkers: STUBS, importerEORI: EORI_1, proofText: text })).checks[0].status).toBe("pass");
  });

  it("N-L3: the core's validUntil needs a time zone and a real date (check 0); issuance refuses such times too", async () => {
    const cr = await issue({ installationId: demo.entities.supplier.installations[1].id, verificationReportId: "VR-HARD-0103", reportingPeriod: "2042-01-01/2042-12-31", issuedAt: "2042-01-02T00:00:00Z", validUntil: "2047-12-31T00:00:00Z" });
    const p = present(cr, DEMO_DISCLOSURE);
    for (const bad of ["2047-12-31T00:00:00", "2047-02-30T00:00:00Z", "2047-12-31T24:00:00Z", "2047-12-31"]) {
      const q = { ...p, core: p.core.replace('"validUntil":"2047-12-31T00:00:00Z"', `"validUntil":"${bad}"`) };
      expect(q.core).not.toBe(p.core);
      const r = await verifyOffline(q, { registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 });
      expect(r.checks).toEqual([
        { index: 0, name: "Structure", status: "fail", code: "PRESENTATION_MALFORMED", detail: "the credential core's validUntil is not an ISO 8601 time with a time zone" },
      ]);
      await expect(issue({ validUntil: bad })).rejects.toThrow(/validUntil/);
    }
    await expect(issue({ issuedAt: "2026-02-30T00:00:00Z" })).rejects.toThrow(/issuedAt/);
    // The unchanged core passes check 0.
    expect((await verifyOffline(p, { registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 })).checks[0].status).toBe("pass");
  });
});
