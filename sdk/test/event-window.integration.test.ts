// The CONTESTED event search on a long chain: after more than 100,000 blocks since the deployment,
// a verification still sends a constant number of eth_getLogs requests (the search covers only the
// blocks of [registeredAt, registeredAt + window], and of the windows around a bound shipment's claim and a
// revocation, found by interpolation search; one request per interval for all three allowlist events), and its
// result is identical to the full scan from the deployment block. Also: the window edges, a chain with
// irregular block times, and the fail-safe fallback when block reads fail.
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, stringToBytes, type PublicClient, type Transport } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainReader, LOG_CHUNK, SEARCH_ROUNDS, type ChainReaderOptions } from "../chain.ts";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf } from "../commitment.ts";
import { METHODOLOGY_NOTE, type CredentialClaims, type Hex } from "../credential.ts";
import { claimArgsOf, DEMO_DISCLOSURE, issueCredential, present, reportInputOf, type SignedCredential } from "../issue.ts";
import { verifyPresentation, type VerificationResult } from "../verify.ts";
import { send, startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));
const salt = (s: string): Hex => keccak256(stringToBytes(`ew:${s}`));
const BODY_LEI = demo.entities.verifier.lei as string;
const SECOND_BODY_LEI = "ZZZZ00EUSECONDBODY42"; // fictional (ZZZZ prefix is never assigned by an LEI issuer)
const THIRD_BODY_LEI = "ZZZZ00EUTHIRDBODY043"; // fictional
const DAY = 24n * 3600n;
const BLOCK_TIME = 12;
const EORI = demo.entities.importers[0].eori as string;
/** An address the second body is rotated to in the CR1 case (anvil's account #9; it never sends a transaction). */
const newAddress = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" as Hex;

let c: LocalChain;
let n = 0;

function claims(over: Partial<CredentialClaims> = {}): CredentialClaims {
  const s = demo.entities.supplier;
  n++;
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: `TW-ZZZZ00TWSCREWDEMO185-${String(7000 + n)}`,
    installationName: "Demo Fasteners Plant (fictional)",
    unLocode: s.unLocode,
    cnCode: "7318",
    cbamRoute: "C",
    productionRoute: "BF-BOF wire rod (illustrative)",
    reportingPeriod: demo.reports[0].reportingPeriod,
    verifiedTonnes: "500",
    specificEmbeddedEmissions_tCO2e_per_t: "1.8",
    valueType: "actual",
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: `VR-WINDOW-${String(n).padStart(4, "0")}`,
    verifierLEI: BODY_LEI,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: salt(`id:${n}`),
    batchSalt: salt(`batch:${n}`),
    issuedAt: "2026-09-01T00:00:00Z",
    validUntil: "2029-12-31T00:00:00Z",
    ...over,
  };
}

/** A reader whose client counts JSON-RPC requests per method (and can make block reads fail). */
function countingReader(options: ChainReaderOptions = {}, failGetBlock = false) {
  const counts: Record<string, number> = {};
  const base = http(c.rpc, { retryCount: 0 });
  const transport: Transport = (opts) => {
    const t = base(opts);
    return {
      ...t,
      request: (async (args: { method: string; params?: unknown[] }, o?: unknown) => {
        counts[args.method] = (counts[args.method] ?? 0) + 1;
        if (failGetBlock && args.method === "eth_getBlockByNumber" && args.params?.[0] !== "latest") {
          throw new Error("getBlock disabled by the test");
        }
        return (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, o);
      }) as typeof t.request,
    };
  };
  const client = createPublicClient({ chain: foundry, transport }) as PublicClient;
  return { reader: new ChainReader(client, c.deployment, undefined, options), counts };
}

async function addAuditor(aid: string, lei = BODY_LEI) {
  await send(c, c.owner, "allowlist", "addAuditor", [
    { auditorAidHash: auditorAidHashOf(aid), leiHash: leiHashOf(lei), ecrSaidHash: hashString(`ECR-${aid}`) },
  ]);
}

async function issueAndRegister(auditorAID: string, over: Partial<CredentialClaims> = {}, from = c.verifier) {
  const cr = await issueCredential({
    claims: claims(over),
    auditorAID,
    signer: from,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    chainId: 31337,
  });
  const rcpt = await send(c, from, "registry", "registerReport", [
    reportInputOf(cr, { supplier: c.supplier.address, kelSeq: 1n }),
  ]);
  const at = (await c.pub.getBlock({ blockNumber: rcpt.blockNumber })).timestamp;
  return { cr, at };
}

/** Mines `blocks` empty blocks, `BLOCK_TIME` seconds apart. */
const mine = async (blocks: number, interval = BLOCK_TIME) => {
  // anvil_mine of many blocks can take longer than the default request timeout; mine in batches.
  for (let left = blocks; left > 0; left -= 10_000) await c.test.mine({ blocks: Math.min(left, 10_000), interval });
};

async function revokeAt(aid: string, timestamp: bigint, lei = BODY_LEI) {
  await c.test.setNextBlockTimestamp({ timestamp });
  await send(c, c.watcher, "allowlist", "revokeAuditor", [auditorAidHashOf(aid), leiHashOf(lei)]);
}

/** Verifies with the default (windowed) reader and with the full scan; returns both, and the request counts. */
async function both(cr: SignedCredential, opts: { contestedWindowHours?: number } = {}) {
  const w = countingReader();
  const f = countingReader({ fullEventScan: true });
  const windowed = await verifyPresentation(present(cr, DEMO_DISCLOSURE), w.reader, opts);
  const full = await verifyPresentation(present(cr, DEMO_DISCLOSURE), f.reader, opts);
  return { windowed, full, w: w.counts, f: f.counts };
}

const check4 = (r: VerificationResult) => `${r.checks[4].status}:${r.checks[4].code}`;
const span = async () => (await c.pub.getBlockNumber({ cacheTime: 0 })) - BigInt(c.deployment.contracts.VerifierAllowlist.block) + 1n;
const fullScanLogs = (blocks: bigint) => Math.ceil(Number(blocks) / Number(LOG_CHUNK));
/** Upper bound on getBlock reads: block B and the deployment block, then per bound two reads per round. */
const MAX_GET_BLOCK = 2 + 2 * 2 * SEARCH_ROUNDS;
/** The same with `n` disjoint time intervals (registration, claim, revocation), each searched on its own. */
const maxGetBlock = (n: number) => 2 + n * 2 * 2 * SEARCH_ROUNDS;

beforeAll(async () => {
  // Cancun (the contracts' EVM version) and no historical states: anvil then mines 100,000 empty blocks in
  // seconds (with Prague's block-hash history contract it takes minutes).
  c = await startLocalChain(21545 + Math.floor(Math.random() * 1000), ["--hardfork", "cancun", "--prune-history"]);
  for (const [lei, verifier, tag] of [
    [BODY_LEI, c.verifier, "1"],
    [SECOND_BODY_LEI, c.other, "2"],
  ] as const) {
    await send(c, c.owner, "allowlist", "addVerifier", [
      {
        leiHash: leiHashOf(lei),
        verifier: verifier.address,
        leCredSaidHash: hashString(`LE-SAID-${tag}`),
        accreditationSaidHash: hashString(`ACC-SAID-${tag}`),
        accreditedUntil: 1924905600n,
      },
    ]);
  }
  // A long history before anything is checked: 120,000 blocks, 12 s apart (about 16.7 days).
  await mine(120_000);
}, 120_000);

afterAll(() => c?.stop());

describe("CONTESTED event search on a chain more than 100,000 blocks past the deployment", { timeout: 120_000 }, () => {
  it("revocation 1 h after registration → CONTESTED with 1 eth_getLogs; the full scan gives the same result", async () => {
    const aid = "EDemoAuditorAidEventWindowOneHour00000000000";
    await addAuditor(aid);
    const { cr, at } = await issueAndRegister(aid);
    await mine(200);
    await revokeAt(aid, at + 3600n);
    await mine(50);
    expect(await span()).toBeGreaterThan(100_000n);
    const r = await both(cr);
    expect(check4(r.windowed)).toBe("pass:CONTESTED");
    expect(r.windowed).toEqual(r.full);
    expect(r.w.eth_getLogs).toBe(1);
    expect(r.w.eth_getBlockByNumber).toBeLessThanOrEqual(MAX_GET_BLOCK);
    expect(r.f.eth_getLogs).toBe(fullScanLogs(await span()));
    expect(r.f.eth_getLogs).toBeGreaterThan(10);
    // A second verification on the same reader reuses the deployment block and the searched blocks:
    // the only block read is block B (the blocks searched are more than 128 blocks below it).
    await mine(1_000);
    const again = countingReader();
    await verifyPresentation(present(cr, DEMO_DISCLOSURE), again.reader);
    again.counts.eth_getBlockByNumber = 0;
    again.counts.eth_getLogs = 0;
    expect(check4(await verifyPresentation(present(cr, DEMO_DISCLOSURE), again.reader))).toBe("pass:CONTESTED");
    expect(again.counts.eth_getBlockByNumber).toBe(1);
    expect(again.counts.eth_getLogs).toBe(1);
  });

  it("another 100,000 blocks later: still 1 eth_getLogs, for a new report and for the earlier one", async () => {
    await mine(100_000);
    const aid = "EDemoAuditorAidEventWindowLaterReport0000000";
    await addAuditor(aid);
    const { cr, at } = await issueAndRegister(aid);
    await mine(100);
    await revokeAt(aid, at + 7200n);
    const r = await both(cr);
    expect(check4(r.windowed)).toBe("pass:CONTESTED");
    expect(r.windowed).toEqual(r.full);
    expect(r.w.eth_getLogs).toBe(1);
    expect(r.w.eth_getBlockByNumber).toBeLessThanOrEqual(MAX_GET_BLOCK);
    expect(r.f.eth_getLogs).toBe(fullScanLogs(await span()));
  });

  it("window edges with full days of blocks in between: exactly 24 h → CONTESTED, 24 h + 1 s → VALID", async () => {
    const edge = "EDemoAuditorAidEventWindowEdgeExactly0000000";
    const late = "EDemoAuditorAidEventWindowEdgePlusOneSecond0";
    await addAuditor(edge);
    await addAuditor(late);
    const a = await issueAndRegister(edge);
    const b = await issueAndRegister(late);
    // About 24 h of 12-second blocks (7,190 blocks) between the registrations and the revocations.
    await mine(7_190);
    await revokeAt(edge, a.at + DAY);
    await revokeAt(late, b.at + DAY + 1n);
    await mine(3_000);
    const ra = await both(a.cr);
    expect(check4(ra.windowed)).toBe("pass:CONTESTED");
    expect(ra.windowed).toEqual(ra.full);
    expect(ra.w.eth_getLogs).toBe(1);
    const rb = await both(b.cr);
    expect(check4(rb.windowed)).toBe("pass:");
    expect(rb.windowed.overall).toBe(rb.full.overall);
    expect(rb.windowed).toEqual(rb.full);
    expect(rb.w.eth_getLogs).toBe(1);
    // A wider window takes the later revocation in, through the same constant search.
    const rb2 = await both(b.cr, { contestedWindowHours: 25 });
    expect(check4(rb2.windowed)).toBe("pass:CONTESTED");
    expect(rb2.windowed).toEqual(rb2.full);
    expect(rb2.w.eth_getLogs).toBe(1);
  });

  it("suspension of the body 3 h after registration, with irregular block times → CONTESTED, same as the full scan", async () => {
    const aid = "EDemoAuditorAidEventWindowSecondBody00000000";
    await addAuditor(aid, SECOND_BODY_LEI);
    const { cr, at } = await issueAndRegister(aid, { verifierLEI: SECOND_BODY_LEI }, c.other);
    // Irregular block times: bursts of 1-second blocks, then 60-second gaps.
    await mine(3_000, 1);
    await mine(100, 60);
    await c.test.setNextBlockTimestamp({ timestamp: at + 3n * 3600n });
    await send(c, c.watcher, "allowlist", "suspendVerifier", [leiHashOf(SECOND_BODY_LEI)]);
    await mine(5_000, 2);
    const r = await both(cr);
    expect(check4(r.windowed)).toBe("pass:CONTESTED");
    expect(r.windowed).toEqual(r.full);
    expect(r.w.eth_getLogs).toBeLessThanOrEqual(2);
    // Searched as tightly as it can be, it still agrees.
    const tight = await verifyPresentation(present(cr, DEMO_DISCLOSURE), countingReader({ searchTolerance: 0n }).reader);
    expect(tight).toEqual(r.full);
  });

  it("a revocation far outside the window (an old report) → VALID with 1 eth_getLogs", async () => {
    const aid = "EDemoAuditorAidEventWindowOldReport000000000";
    await addAuditor(aid);
    const { cr, at } = await issueAndRegister(aid);
    await mine(20_000);
    // One block time after the last mined block (anvil can add wall-clock seconds between mining batches
    // on a loaded machine, so the time is read from the chain rather than computed from `at`).
    const last = (await c.pub.getBlock()).timestamp;
    expect(last - at).toBeGreaterThanOrEqual(20_000n * BigInt(BLOCK_TIME));
    await revokeAt(aid, last + BigInt(BLOCK_TIME));
    const r = await both(cr);
    expect(check4(r.windowed)).toBe("pass:");
    expect(r.windowed).toEqual(r.full);
    expect(r.w.eth_getLogs).toBe(1);
  });

  it("a shipment claimed 10 days after registration: two intervals, 3 eth_getLogs (1 + 2 for the 48 h around the claim); check 4 passes, same as the full scan", async () => {
    const aid = "EDemoAuditorAidEventWindowLateClaim000000000";
    await addAuditor(aid);
    const { cr } = await issueAndRegister(aid);
    await mine(72_000); // 10 days of 12-second blocks
    const s = { batchId: "EW-LATE-1", quantityTonnes: "100", shipmentDate: "2026-10-10", importerSalt: salt("late:1") };
    await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cr, { ...s, importerEORI: EORI }));
    await mine(20_000);
    const w = countingReader();
    const f = countingReader({ fullEventScan: true });
    const p = present(cr, DEMO_DISCLOSURE, s);
    const windowed = await verifyPresentation(p, w.reader, { importerEORI: EORI });
    expect(windowed).toEqual(await verifyPresentation(p, f.reader, { importerEORI: EORI }));
    // (checks 6 and 7 have no evidence here; checks 4 and 5 are what this case is about)
    expect([check4(windowed), windowed.checks[5].status]).toEqual(["pass:", "pass"]);
    expect(w.counts.eth_getLogs).toBe(3);
    expect(w.counts.eth_getBlockByNumber).toBeLessThanOrEqual(maxGetBlock(2));
  });

  it("CR1 on a long chain: revoked 5 days after the claim, the body rotated 1 h later → checks 4 and 5 CONTESTED; three intervals, 5 eth_getLogs (1 + 2 + 2)", async () => {
    // A third body (the second one was suspended by an earlier case).
    await send(c, c.owner, "allowlist", "addVerifier", [
      {
        leiHash: leiHashOf(THIRD_BODY_LEI),
        verifier: c.impostor.address,
        leCredSaidHash: hashString("LE-SAID-3"),
        accreditationSaidHash: hashString("ACC-SAID-3"),
        accreditedUntil: 1924905600n,
      },
    ]);
    const aid = "EDemoAuditorAidEventWindowRevokedRotate00000";
    await addAuditor(aid, THIRD_BODY_LEI);
    const { cr } = await issueAndRegister(aid, { verifierLEI: THIRD_BODY_LEI }, c.impostor);
    await mine(72_000);
    const s = { batchId: "EW-CR1-1", quantityTonnes: "100", shipmentDate: "2026-10-10", importerSalt: salt("m1:1") };
    await send(c, c.supplier, "registry", "claimShipment", claimArgsOf(cr, { ...s, importerEORI: EORI }));
    await mine(36_000);
    const rcpt = await send(c, c.impostor, "registry", "revokeReport", [reportKeyOf(cr.core.d)]);
    const revokedAt = (await c.pub.getBlock({ blockNumber: rcpt.blockNumber })).timestamp;
    await mine(200);
    await c.test.setNextBlockTimestamp({ timestamp: revokedAt + 3600n });
    await send(c, c.owner, "allowlist", "rotateVerifierAddress", [leiHashOf(THIRD_BODY_LEI), newAddress]);
    await mine(20_000);
    const w = countingReader();
    const f = countingReader({ fullEventScan: true });
    const p = present(cr, DEMO_DISCLOSURE, s);
    const windowed = await verifyPresentation(p, w.reader, { importerEORI: EORI });
    expect(windowed).toEqual(await verifyPresentation(p, f.reader, { importerEORI: EORI }));
    expect([check4(windowed), `${windowed.checks[5].status}:${windowed.checks[5].code}`]).toEqual([
      "warn:CONTESTED",
      "warn:CONTESTED",
    ]);
    expect(w.counts.eth_getLogs).toBe(5);
    expect(w.counts.eth_getBlockByNumber).toBeLessThanOrEqual(maxGetBlock(3));
  });

  it("fail-safe: when block reads fail, the search falls back to the full scan and the result is unchanged", async () => {
    const aid = "EDemoAuditorAidEventWindowFailSafe0000000000";
    await addAuditor(aid);
    const { cr, at } = await issueAndRegister(aid);
    await mine(40);
    await revokeAt(aid, at + 600n);
    // Reading the latest block (block B) succeeds; every read of a numbered block (the search) fails.
    const broken = countingReader({}, true);
    const r = await verifyPresentation(present(cr, DEMO_DISCLOSURE), broken.reader);
    const full = await verifyPresentation(present(cr, DEMO_DISCLOSURE), countingReader({ fullEventScan: true }).reader);
    expect(check4(r)).toBe("pass:CONTESTED");
    expect(r).toEqual(full);
    expect(broken.counts.eth_getLogs).toBe(fullScanLogs(await span()));
  });

  it("blockRangeForTimes: every block in [t0, t1] lies inside the range, bounds are outside it", async () => {
    const head = await c.pub.getBlock();
    const reader = new ChainReader(c.pub, c.deployment).at(head.number);
    const tight = new ChainReader(c.pub, c.deployment, undefined, { searchTolerance: 0n }).at(head.number);
    const first = await c.pub.getBlock({ blockNumber: reader.fromBlock });
    const ts = async (b: bigint) => (await c.pub.getBlock({ blockNumber: b })).timestamp;
    const spanT = head.timestamp - first.timestamp;
    for (const frac of [0n, 1n, 13n, 250n, 500n, 777n, 999n, 1000n]) {
      const t0 = first.timestamp + (spanT * frac) / 1000n;
      for (const t1 of [t0, t0 + 3600n, t0 + DAY]) {
        for (const rd of [reader, tight]) {
          const r = await rd.blockRangeForTimes(t0, t1, { number: head.number, timestamp: head.timestamp });
          expect(r.narrowed).toBe(true);
          expect(r.fromBlock).toBeGreaterThanOrEqual(reader.fromBlock);
          expect(r.toBlock).toBeLessThanOrEqual(head.number);
          if (r.fromBlock > reader.fromBlock) expect(await ts(r.fromBlock)).toBeLessThan(t0);
          if (r.toBlock < head.number) expect(await ts(r.toBlock)).toBeGreaterThan(t1);
        }
      }
    }
  });
});
