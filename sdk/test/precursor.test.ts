// Check 9 without a chain: decimal arithmetic, the statement's digest and shape rules, the CN and period rules, and
// the browser's offline re-check of a precursor tier (sdk/precursor.ts).
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../consistency.ts";
import { DEMO_DISCLOSURE, issueCredential, present } from "../issue.ts";
import {
  PRECURSOR_STATEMENT_TYPE,
  PRECURSOR_STATEMENT_VERSION,
  PRECURSOR_TOLERANCE,
  checkPrecursorsOffline,
  dec6,
  fmt12,
  periodFits,
  precursorDigestOf,
  relevantPrecursor,
  statementProblem,
  type PrecursorStatement,
} from "../precursor.ts";
import { verifyOffline } from "../verify.ts";
import { DEMO_TRUST_ANCHOR } from "../vlei.ts";
import { precursorChainInput, syntheticPrecursorChain } from "../../verifier/src/precursor-chain.ts";
import { PC, demo, millClaims, screwClaims, statementOf } from "../../scripts/precursor-scenario.ts";

const SAID = "E" + "A".repeat(43);
const line = { cnCode: "7213", massPerTonne: "1.125", source: "verified" as const, credSAID: SAID, batchId: "WR-1" };
const statement = (over: Partial<PrecursorStatement> = {}): PrecursorStatement => ({
  type: PRECURSOR_STATEMENT_TYPE,
  version: PRECURSOR_STATEMENT_VERSION,
  attributedDirect: "0.18",
  lines: [line],
  ...over,
});

describe("decimal arithmetic", () => {
  it("scales by 10^6 without floating point and formats 10^12-scaled values", () => {
    expect(dec6("1.125")).toBe(1_125_000n);
    expect(dec6("0")).toBe(0n);
    expect(fmt12(dec6("1.125") * dec6("1.44"))).toBe("1.62");
    expect(fmt12(dec6("0.18") * 1_000_000n + dec6("1.125") * dec6("1.44"))).toBe("1.8");
    expect(fmt12(-200_000_000_000n)).toBe("-0.2");
    expect(fmt12(1n)).toBe("0");
  });
  it("refuses signs, exponents, spaces, more than six places and leading zeros", () => {
    for (const bad of ["-1", "1e3", " 1", "1.1234567", "01.5", "", "1.", ".5"]) expect(() => dec6(bad)).toThrow();
  });
  it("the demo's numbers give the 1.8 headline exactly (illustrative)", () => {
    const { attributedDirect, massPerTonne } = PC.statement;
    const total = dec6(attributedDirect) * 1_000_000n + dec6(massPerTonne) * dec6(PC.report.specificEmbeddedEmissions_tCO2e_per_t);
    expect(fmt12(total)).toBe(demo.reports[0].specificEmbeddedEmissions_tCO2e_per_t);
    expect(PRECURSOR_TOLERANCE).toBe("0.01");
  });
});

describe("statement digest and shape", () => {
  it("the digest is keccak256 of canonical JSON: key order does not matter, any value change does", () => {
    const s = statement();
    const reordered = JSON.parse(canonicalJson(s));
    expect(precursorDigestOf(reordered)).toBe(precursorDigestOf(s));
    expect(precursorDigestOf(statement({ attributedDirect: "0.19" }))).not.toBe(precursorDigestOf(s));
    expect(precursorDigestOf(s)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("accepts verified and default lines; refuses malformed ones", () => {
    expect(statementProblem(statement())).toBeNull();
    expect(statementProblem(statement({ lines: [{ cnCode: "7213", massPerTonne: "1.1", source: "default", defaultSEE: "1.5" }] }))).toBeNull();
    const cases: [unknown, RegExp][] = [
      [null, /not a JSON object/],
      [{ ...statement(), version: "9" }, /type or version/],
      [statement({ attributedDirect: "-1" }), /attributedDirect/],
      [statement({ lines: [] }), /1 to 16/],
      [statement({ lines: [{ ...line, cnCode: "72 13" }] }), /cnCode/],
      [statement({ lines: [{ ...line, massPerTonne: "0" }] }), /massPerTonne/],
      [statement({ lines: [{ ...line, credSAID: "nope" }] }), /credSAID/],
      [statement({ lines: [{ ...line, batchId: "" }] }), /batchId/],
      [statement({ lines: [line, { ...line }] }), /repeats the credential and batch/],
      [statement({ lines: [{ cnCode: "7213", massPerTonne: "1", source: "default" }] }), /defaultSEE/],
      [statement({ lines: [{ ...line, source: "estimated" as never }] }), /source/],
    ];
    for (const [s, re] of cases) expect(statementProblem(s)).toMatch(re);
  });
});

describe("CN and period rules", () => {
  it("iron or steel products take chapter 72/73 precursors except 7204 scrap; aluminium takes 76; others: no rule", () => {
    expect(relevantPrecursor("7318", "7213")).toBe(true);
    expect(relevantPrecursor("7318", "7207")).toBe(true);
    expect(relevantPrecursor("7318", "7204")).toBe(false);
    expect(relevantPrecursor("7318", "7601")).toBe(false);
    expect(relevantPrecursor("7616", "7601")).toBe(true);
    expect(relevantPrecursor("2716", "7213")).toBeNull();
  });
  it("a precursor period may not start after the good's period ends", () => {
    expect(periodFits("2026-01-01/2026-12-31", "2026-01-01/2026-12-31")).toBe(true);
    expect(periodFits("2025-01-01/2025-12-31", "2026-01-01/2026-12-31")).toBe(true);
    expect(periodFits("2027-01-01/2027-12-31", "2026-01-01/2026-12-31")).toBe(false);
    expect(periodFits("2026", "2026-01-01/2026-12-31")).toBe(false);
  });
});

describe("offline re-check (what the hosted page runs)", () => {
  const registry = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
  const deployment = { registry, chainId: 31337 };
  const chain = syntheticPrecursorChain(precursorChainInput(demo));
  const body = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const millKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");

  async function bundle(over: { see?: string } = {}) {
    const mill = await issueCredential({ claims: millClaims(), auditorAID: chain.bodies.mill.auditorAid, signer: millKey, registry, chainId: 31337 });
    const st = statementOf([{ cnCode: "7213", massPerTonne: "1.125", source: "verified", credSAID: mill.core.d, batchId: "WR-1" }]);
    const screw = await issueCredential({
      claims: screwClaims(over.see ? { specificEmbeddedEmissions_tCO2e_per_t: over.see } : {}),
      auditorAID: chain.bodies.screw.auditorAid,
      signer: body,
      registry,
      chainId: 31337,
      precursorDigest: precursorDigestOf(st),
    });
    const millProof = {
      ...present(mill, DEMO_DISCLOSURE, { batchId: "WR-1", quantityTonnes: "562.5", shipmentDate: "2026-06-30", importerSalt: `0x${"11".repeat(32)}` as const }),
      anchorEvidence: chain.bodies.mill.anchor([mill.core.d]),
      authorityEvidence: chain.bodies.mill.bundle,
    };
    const screwProof = present(screw, DEMO_DISCLOSURE);
    const off = await verifyOffline(screwProof, deployment);
    return { screw, off, evidence: { statement: st, proofs: [millProof] } };
  }

  it("every off-chain part holds; on-chain facts are left open (null), never claimed", async () => {
    const { screw, off, evidence } = await bundle();
    const items = await checkPrecursorsOffline(screw.core, off.disclosed, evidence, { trustAnchor: chain.trustAnchor, deployment });
    expect(items.filter((i) => i.ok === false)).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(["digest", "line0:checks0-3", "line0:bound", "line0:anchor", "line0:authority", "line0:scope", "line0:onchain", "balance"]);
    expect(items.find((i) => i.id === "line0:onchain")?.ok).toBeNull();
    expect(items.find((i) => i.id === "balance")?.detail).toBe("0.18 + 1.62 = 1.8 tCO2e/t recomputed, 1.8 declared (tolerance 0.01)");
  });

  it("the demo root pinned for the mill tier fails its vLEI chain; an understated SEE fails the balance; a changed statement fails the digest", async () => {
    const a = await bundle();
    const pinnedDemo = await checkPrecursorsOffline(a.screw.core, a.off.disclosed, a.evidence, { trustAnchor: DEMO_TRUST_ANCHOR, deployment });
    expect(pinnedDemo.find((i) => i.id === "line0:authority")).toMatchObject({ ok: false, detail: "QVI credential not issued by the configured root of trust" });
    const low = await bundle({ see: "1.6" });
    expect((await checkPrecursorsOffline(low.screw.core, low.off.disclosed, low.evidence, { trustAnchor: chain.trustAnchor, deployment })).find((i) => i.id === "balance")?.ok).toBe(false);
    const changed = { ...a.evidence, statement: { ...a.evidence.statement, attributedDirect: "0.1" } };
    expect((await checkPrecursorsOffline(a.screw.core, a.off.disclosed, changed, { trustAnchor: chain.trustAnchor, deployment }))[0].ok).toBe(false);
  });

  it("offline verification lists check 9 as not run, so the result stays INCOMPLETE", async () => {
    const { off } = await bundle();
    expect(off.checks.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(off.checks[9].status).toBe("skipped");
    expect(off.overall).toBe("INCOMPLETE");
  });

  it("check 0 refuses a precursorDigest that is not 32-byte lower-case hex", async () => {
    const { screw } = await bundle();
    const core = JSON.parse(screw.coreJson);
    core.precursorDigest = "0xABC";
    const r = await verifyOffline({ ...present(screw, DEMO_DISCLOSURE), core: JSON.stringify(core) }, deployment);
    expect(r.checks[0]).toMatchObject({ status: "fail", code: "PRESENTATION_MALFORMED" });
  });
});
