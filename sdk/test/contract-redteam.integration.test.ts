// Verifier-side mitigations of the contract red-team review (2026-10-07), on a local anvil chain, one case per
// finding the verifier can see, built on the review's forge PoCs (RedTeam.t.sol). No contract changes:
//   CR1  a stolen body key (or an owner key used to rotate the body's address) revokes every report of the body;
//       a revocation within 24 h of a suspension or rotation of the body → CONTESTED, not INVALID;
//       a shipment claimed within 24 h of such a key incident → CONTESTED.
//   CR9  the registering address rotated away within 24 h after registration → CONTESTED.
//   CR3  a revision by another body (after the earlier body's accreditation expired) that raises the verified
//       tonnage or names another supplier → CONTESTED, also when the raise comes one revision later.
//   CR2  a shipment claimed shortly before a revision of its credential → a note (a reverted correction leaves
//       nothing on-chain to see).
// Each rule is checked against the full scan from the deployment block (fullEventScan) as well.
// Checks 6 and 7 are stubbed as passing; they are not what these cases are about.
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, stringToBytes, type PublicClient, type Transport } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainReader } from "../chain.ts";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../commitment.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import type { Presentation } from "../disclosure.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../issue.ts";
import {
  CLAIM_UNDER_INCIDENT,
  CLAIMED_BEFORE_REVISION,
  CROSS_BODY_DETAIL,
  REVOKED_UNDER_INCIDENT,
  verifyPresentation,
  type CheckResult,
  type VerificationResult,
  type VerifyOptions,
} from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const salt = (s: string): Hex => keccak256(stringToBytes(`redteam:${s}`));
const EORI_1 = demo.entities.importers[0].eori as string;
const EORI_2 = demo.entities.importers[1].eori as string;
const HOUR = 3600n;
const DAY = 24n * HOUR;
const BASE = "registered by an authorized auditor (checked by the contract at registration)";

const stub = (index: number) => (): CheckResult => ({ index, name: "", status: "pass", code: "", detail: "stub" });
const STUBS = { anchor: stub(6), authority: stub(7) };
const withEv = (p: Presentation): Presentation => ({ ...p, anchorEvidence: { stub: true }, authorityEvidence: { stub: true } });
const check = (r: VerificationResult, i: number) => r.checks.find((x) => x.index === i)!;
const line = (r: VerificationResult, i: number) => `${check(r, i).status}:${check(r, i).code}`;

let c: LocalChain;
let seq = 0;

interface Body {
  lei: string;
  key: PrivateKeyAccount;
  aid: string;
}

async function account(): Promise<PrivateKeyAccount> {
  const a = privateKeyToAccount(generatePrivateKey());
  await c.test.setBalance({ address: a.address, value: 10n ** 20n });
  return a;
}

async function addBody(tag: string, accreditedUntil = 1924905600n): Promise<Body> {
  const lei = `ZZZZ00EURT${tag.padEnd(8, "X")}${String(10 + (seq++ % 90))}`;
  const key = await account();
  const aid = `ERedTeamAuditor${tag}`.padEnd(44, "0");
  await send(c, c.owner, "allowlist", "addVerifier", [
    { leiHash: leiHashOf(lei), verifier: key.address, leCredSaidHash: hashString(`LE-${tag}`), accreditationSaidHash: hashString(`ACC-${tag}`), accreditedUntil },
  ]);
  await send(c, c.owner, "allowlist", "addAuditor", [{ auditorAidHash: auditorAidHashOf(aid), leiHash: leiHashOf(lei), ecrSaidHash: hashString(`ECR-${tag}`) }]);
  return { lei, key, aid };
}

/** Claims of a credential on installation `inst` (each case uses its own installation, so its own report scope). */
function claims(body: Body, inst: number, over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: `TW-ZZZZ00TWSCREWDEMO185-${String(8000 + inst)}`,
    installationName: "Demo Fasteners Plant (fictional)",
    unLocode: s.unLocode,
    cnCode: "7318",
    cbamRoute: "C",
    productionRoute: "BF-BOF wire rod (illustrative)",
    reportingPeriod: demo.reports[0].reportingPeriod,
    verifiedTonnes: "1000",
    specificEmbeddedEmissions_tCO2e_per_t: "1.8",
    valueType: "actual",
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: `VR-REDTEAM-${String(inst).padStart(4, "0")}`,
    verifierLEI: body.lei,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld",
    supplierCost: "withheld",
    idSalt: salt(`id:${inst}:${seq++}`),
    batchSalt: salt(`batch:${inst}:${seq++}`),
    issuedAt: "2026-10-01T00:00:00Z",
    validUntil: "2029-12-31T00:00:00Z",
    ...over,
  };
}

async function issueAndRegister(
  body: Body,
  inst: number,
  opts: { over?: Partial<CredentialClaims>; signer?: PrivateKeyAccount; supplier?: Hex; supersedes?: SignedCredential } = {},
) {
  const signer = opts.signer ?? body.key;
  const cr = await issueCredential({
    claims: claims(body, inst, opts.over),
    auditorAID: body.aid,
    signer,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    chainId: 31337,
  });
  await send(c, signer, "registry", "registerReport", [
    reportInputOf(cr, {
      supplier: opts.supplier ?? c.supplier.address,
      kelSeq: 1n,
      supersedes: opts.supersedes ? reportKeyOf(opts.supersedes.core.d) : undefined,
    }),
  ]);
  return cr;
}

async function ship(cr: SignedCredential, batchId: string, quantityTonnes: string, eori = EORI_1, supplier = c.supplier) {
  const s = { batchId, quantityTonnes, shipmentDate: "2026-10-10", importerSalt: salt(`imp:${batchId}`) };
  await send(c, supplier, "registry", "claimShipment", claimArgsOf(cr, { ...s, importerEORI: eori }));
  return withEv(present(cr, DEMO_DISCLOSURE, s));
}

const at = async (offset: bigint) => {
  const now = (await c.pub.getBlock()).timestamp;
  await c.test.setNextBlockTimestamp({ timestamp: now + offset });
};
const rotate = (body: Body, to: Hex) => send(c, c.owner, "allowlist", "rotateVerifierAddress", [leiHashOf(body.lei), to]);
const suspend = (body: Body) => send(c, c.watcher, "allowlist", "suspendVerifier", [leiHashOf(body.lei)]);
const revoke = (from: PrivateKeyAccount, cr: SignedCredential) => send(c, from, "registry", "revokeReport", [reportKeyOf(cr.core.d)]);

function countingReader(fullEventScan = false) {
  const counts: Record<string, number> = {};
  const base = http(c.rpc, { retryCount: 0 });
  const transport: Transport = (o) => {
    const t = base(o);
    return {
      ...t,
      request: (async (args: { method: string }, x?: unknown) => {
        counts[args.method] = (counts[args.method] ?? 0) + 1;
        return (t.request as (a: unknown, x?: unknown) => Promise<unknown>)(args, x);
      }) as typeof t.request,
    };
  };
  const client = createPublicClient({ chain: foundry, transport }) as PublicClient;
  return { reader: new ChainReader(client, c.deployment, undefined, { fullEventScan }), counts };
}

/** Verifies with the windowed search and with the full scan from the deployment block; both must agree. */
async function verify(p: Presentation, opts: VerifyOptions = {}) {
  const w = countingReader();
  const r = await verifyPresentation(p, w.reader, { checkers: STUBS, ...opts });
  const full = await verifyPresentation(p, countingReader(true).reader, { checkers: STUBS, ...opts });
  expect(r).toEqual(full);
  return { r, counts: w.counts };
}

beforeAll(async () => {
  c = await startLocalChain(25545 + Math.floor(Math.random() * 1000));
}, 60_000);

afterAll(() => c?.stop());

describe("CR1: mass revocation with a stolen body key or a stolen owner key", { timeout: 60_000 }, () => {
  it("CR1a: stolen body key revokes, the body rotates 1 h later → CONTESTED (checks 4 and 5), not INVALID", async () => {
    const body = await addBody("MONEA");
    const x = await issueAndRegister(body, 1);
    const p1 = await ship(x, "M1A-1", "600", EORI_1);
    const p2 = await ship(x, "M1A-2", "400", EORI_2);
    await at(2n * DAY);
    await revoke(body.key, x); // sent with the stolen key
    await at(HOUR);
    await rotate(body, (await account()).address); // incident response: a clean key
    for (const [p, eori] of [[p1, EORI_1], [p2, EORI_2]] as const) {
      const { r } = await verify(p, { importerEORI: eori });
      expect(r.overall).toBe("CONTESTED");
      expect(line(r, 4)).toBe("warn:CONTESTED");
      expect(check(r, 4).detail).toBe(`the verification body revoked this report; ${REVOKED_UNDER_INCIDENT(24)}`);
      expect(line(r, 5)).toBe("warn:CONTESTED");
      expect(check(r, 5).detail).toMatch(/declared to you on the shared ledger; the report was revoked after the claim, within 24 h of a suspension/);
    }
    // Without the EORI the shipment is not bound to the verifier: check 4 alone, still CONTESTED.
    const { r: unbound } = await verify(p1);
    expect([unbound.overall, line(unbound, 4), check(unbound, 5).status]).toEqual(["CONTESTED", "warn:CONTESTED", "skipped"]);
  });

  it("CR1a control: a revocation with no key incident, or with the rotation 24 h + 1 s later, stays INVALID", async () => {
    const body = await addBody("MONEB");
    const x = await issueAndRegister(body, 2);
    const p = await ship(x, "M1B-1", "100");
    const y = await issueAndRegister(body, 3);
    const q = await ship(y, "M1B-2", "100");
    await at(2n * DAY);
    await revoke(body.key, x);
    const { r } = await verify(p, { importerEORI: EORI_1 });
    expect([r.overall, line(r, 4), line(r, 5)]).toEqual(["INVALID", "fail:REPORT_INVALID/REVOKED", "fail:SHIPMENT_MISMATCH"]);
    expect(check(r, 5).detail).toBe("the report was revoked after the claim");
    await at(0n);
    await revoke(body.key, y);
    const revokedAt = (await c.pub.getBlock()).timestamp;
    await c.test.setNextBlockTimestamp({ timestamp: revokedAt + DAY + 1n });
    await rotate(body, (await account()).address);
    const { r: late } = await verify(q, { importerEORI: EORI_1 });
    expect([late.overall, line(late, 4)]).toEqual(["INVALID", "fail:REPORT_INVALID/REVOKED"]);
    // A wider window takes the late rotation in.
    const { r: wide } = await verify(q, { importerEORI: EORI_1, contestedWindowHours: 25 });
    expect([wide.overall, line(wide, 4)]).toEqual(["CONTESTED", "warn:CONTESTED"]);
    expect(check(wide, 4).detail).toContain(REVOKED_UNDER_INCIDENT(25));
  });

  it("CR1a: a revocation that is not the only failure (also expired) stays INVALID", async () => {
    const body = await addBody("MONEC");
    const x = await issueAndRegister(body, 4, { over: { validUntil: "2027-12-31T00:00:00Z" } });
    const p = await ship(x, "M1C-1", "100");
    await revoke(body.key, x);
    await suspend(body);
    // Without the EORI, judged at the head block, which is past validUntil.
    await c.test.setNextBlockTimestamp({ timestamp: 1830297600n + DAY });
    await c.test.mine({ blocks: 1 });
    const { r } = await verify(p);
    expect(r.overall).toBe("INVALID");
    expect(check(r, 4).detail).toBe("the verification body revoked this report; past the credential's validity");
  });

  it("CR1b: stolen owner key rotates the body to the thief, who revokes Xe and redirects X to itself → CONTESTED", async () => {
    const body = await addBody("MONED");
    const x = await issueAndRegister(body, 5);
    const xe = await issueAndRegister(body, 6);
    const px = await ship(x, "M1D-1", "300");
    const pe = await ship(xe, "M1D-2", "100");
    await at(3n * DAY);
    const thief = await account();
    await rotate(body, thief.address); // owner key stolen
    await at(60n);
    await revoke(thief, xe);
    // The honest Xe shipment: revoked within 24 h after a rotation → CONTESTED.
    const { r: re } = await verify(pe, { importerEORI: EORI_1 });
    expect([re.overall, line(re, 4), line(re, 5)]).toEqual(["CONTESTED", "warn:CONTESTED", "warn:CONTESTED"]);
    // The thief revises X as the same body: its own supplier address, 9,000 t, and claims 8,700 t at once.
    const xt = await issueAndRegister(body, 5, { signer: thief, supplier: thief.address, supersedes: x, over: { verifiedTonnes: "9000" } });
    const pt = await ship(xt, "M1D-3", "8700", EORI_2, thief);
    const { r: rt } = await verify(pt, { importerEORI: EORI_2 });
    expect([rt.overall, line(rt, 4), check(rt, 5).status]).toEqual(["CONTESTED", "pass:CONTESTED", "pass"]);
    expect(check(rt, 4).detail).toBe(`${BASE}; ${CLAIM_UNDER_INCIDENT(24)}`);
    // The honest X shipment, claimed three days before the rotation, is not affected.
    const { r: rx } = await verify(px, { importerEORI: EORI_1 });
    expect(rx.overall).toBe("VALID");
  });
});

describe("CR9: rotation as the response to a stolen key", { timeout: 60_000 }, () => {
  it("the registering address rotated away 2 h after registration → CONTESTED; 24 h + 1 s → VALID", async () => {
    const body = await addBody("LSIXA");
    const x = await issueAndRegister(body, 7); // sent with the stolen key
    const regAt = (await c.pub.getBlock()).timestamp;
    await at(2n * HOUR);
    await rotate(body, (await account()).address);
    const { r } = await verify(withEv(present(x, DEMO_DISCLOSURE)));
    expect([r.overall, line(r, 4)]).toEqual(["CONTESTED", "pass:CONTESTED"]);
    expect(check(r, 4).detail).toBe(`${BASE}; the registering address was rotated within 24 h after`);

    const late = await addBody("LSIXB");
    const y = await issueAndRegister(late, 8);
    const yAt = (await c.pub.getBlock()).timestamp;
    await c.test.setNextBlockTimestamp({ timestamp: yAt + DAY + 1n });
    await rotate(late, (await account()).address);
    const { r: ry } = await verify(withEv(present(y, DEMO_DISCLOSURE)));
    expect([ry.overall, line(ry, 4)]).toEqual(["VALID", "pass:"]);
    expect(regAt).toBeLessThan(yAt);
  });

  it("a rotation and a suspension both in the window: both reasons, the earlier wording first and unchanged", async () => {
    const body = await addBody("LSIXC");
    const x = await issueAndRegister(body, 9);
    await at(HOUR);
    await rotate(body, (await account()).address);
    await at(HOUR);
    await suspend(body);
    const { r } = await verify(withEv(present(x, DEMO_DISCLOSURE)));
    expect(check(r, 4).detail).toBe(`${BASE}; revoked or suspended within 24 h after; the registering address was rotated within 24 h after`);
  });
});

describe("CR3: takeover after the accreditation expired", { timeout: 60_000 }, () => {
  it("another body revises with another supplier and 10× the tonnes → CONTESTED with both reasons", async () => {
    const now = (await c.pub.getBlock()).timestamp;
    const l3 = await addBody("MTHRA", now + 30n * DAY);
    const l2 = await addBody("MTHRB");
    const x3 = await issueAndRegister(l3, 10);
    await ship(x3, "M3A-1", "200");
    // Past the accreditation (a block is mined at that time, so the dry run of the takeover sees it too).
    await c.test.setNextBlockTimestamp({ timestamp: now + 31n * DAY });
    await c.test.mine({ blocks: 1 });
    const supplier2 = await account();
    const h = await issueAndRegister(l2, 10, { supplier: supplier2.address, supersedes: x3, over: { verifiedTonnes: "10000", verificationReportId: "VR-REDTEAM-0010-CR5" } });
    await at(30n * DAY); // claimed well outside any key-incident window
    const ph = await ship(h, "M3A-2", "9800", EORI_2, supplier2);
    const { r } = await verify(ph, { importerEORI: EORI_2 });
    expect([r.overall, line(r, 4)]).toEqual(["CONTESTED", "pass:CONTESTED"]);
    expect(check(r, 4).detail).toBe(`${BASE}; ${CROSS_BODY_DETAIL.raised("1000", "10000")}; ${CROSS_BODY_DETAIL.supplier}`);
  });

  it("a takeover at the same tonnes and supplier is VALID; the same body raising it one revision later is CONTESTED", async () => {
    const now = (await c.pub.getBlock()).timestamp;
    const l3 = await addBody("MTHRC", now + 30n * DAY);
    const l2 = await addBody("MTHRD");
    const x3 = await issueAndRegister(l3, 11);
    // Past the accreditation (a block is mined at that time, so the dry run of the takeover sees it too).
    await c.test.setNextBlockTimestamp({ timestamp: now + 31n * DAY });
    await c.test.mine({ blocks: 1 });
    // Another body cannot reuse the earlier body's report ID (NotReportIssuer): the takeover names its own.
    const h = await issueAndRegister(l2, 11, { supersedes: x3, over: { verificationReportId: "VR-REDTEAM-0011-CR5" } });
    const { r } = await verify(withEv(present(h, DEMO_DISCLOSURE)));
    expect([r.overall, line(r, 4)]).toEqual(["VALID", "pass:"]);
    expect(check(r, 4).detail).toBe(`${BASE}; this credential revises an earlier one in the same layer`);
    const h2 = await issueAndRegister(l2, 11, { supersedes: h, over: { verifiedTonnes: "5000", verificationReportId: "VR-REDTEAM-0011-CR5" } });
    const { r: r2 } = await verify(withEv(present(h2, DEMO_DISCLOSURE)));
    expect([r2.overall, line(r2, 4)]).toEqual(["CONTESTED", "pass:CONTESTED"]);
    expect(check(r2, 4).detail).toBe(`${BASE}; ${CROSS_BODY_DETAIL.raised("1000", "5000")}`);
    // A same-body revision with no change of body in its chain is not affected.
    const own = await addBody("MTHRE");
    const a = await issueAndRegister(own, 12);
    const b = await issueAndRegister(own, 12, { supersedes: a, over: { verifiedTonnes: "5000" } });
    const { r: rb } = await verify(withEv(present(b, DEMO_DISCLOSURE)));
    expect(rb.overall).toBe("VALID");
  });
});

describe("CR2: a claim shortly before a revision", { timeout: 60_000 }, () => {
  it("claimed 10 min before a revision → VALID with a note; 24 h + 1 s before → no note", async () => {
    const body = await addBody("MTWOA");
    const x = await issueAndRegister(body, 13);
    await ship(x, "M2A-1", "500");
    await at(60n);
    // The supplier front-runs the body's downward correction (600 t), which then reverts SupersedeOverClaimed …
    const rushed = await ship(x, "M2A-2", "500", EORI_2);
    await at(600n);
    // … and the body registers a revision it can still make (here, a freeze at the claimed 1,000 t).
    await issueAndRegister(body, 13, { supersedes: x });
    const { r } = await verify(rushed, { importerEORI: EORI_2 });
    expect([r.overall, line(r, 4)]).toEqual(["VALID", "pass:"]);
    expect(check(r, 4).detail).toBe(`${BASE}; ${CLAIMED_BEFORE_REVISION(24)}`);

    const y = await issueAndRegister(body, 14);
    const early = await ship(y, "M2B-1", "100");
    const claimedAt = (await c.pub.getBlock()).timestamp;
    await c.test.setNextBlockTimestamp({ timestamp: claimedAt + DAY + 1n });
    await issueAndRegister(body, 14, { supersedes: y });
    const { r: r2 } = await verify(early, { importerEORI: EORI_1 });
    expect([r2.overall, check(r2, 4).detail]).toEqual(["VALID", BASE]);
  });
});

describe("request count", { timeout: 60_000 }, () => {
  it("registration and claim within a day: one eth_getLogs for all CONTESTED events (two before this change)", async () => {
    const body = await addBody("COUNT");
    const x = await issueAndRegister(body, 15);
    const p = await ship(x, "CNT-1", "100");
    const { r, counts } = await verify(p, { importerEORI: EORI_1 });
    expect(r.overall).toBe("VALID");
    expect(counts.eth_getLogs).toBe(1);
  });
});
