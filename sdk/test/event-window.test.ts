// blockRangeForTimes on simulated chains (no node): a year of 12-second slots with missed slots
// whose rate changes over time, and a chain with abrupt changes of block time. The range must
// contain every block of [t0, t1], and the number of block reads must stay bounded.
import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { ChainReader, LOG_CHUNK, SEARCH_ROUNDS, SEARCH_TOLERANCE, type Deployment } from "../chain.ts";

const DAY = 86_400n;

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Timestamps of blocks 0..n-1 from a function giving the gap before each block. */
function chain(n: number, start: bigint, gap: (i: number) => number): bigint[] {
  const ts: bigint[] = new Array(n);
  ts[0] = start;
  for (let i = 1; i < n; i++) ts[i] = ts[i - 1] + BigInt(gap(i));
  return ts;
}

function fakeClient(ts: bigint[]) {
  let reads = 0;
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      reads++;
      const t = ts[Number(blockNumber)];
      if (t === undefined) throw new Error(`no block ${blockNumber}`);
      return { number: blockNumber, timestamp: t };
    },
    getBlockNumber: async () => BigInt(ts.length - 1),
  } as unknown as PublicClient;
  return { client, reads: () => reads };
}

const deployment = (block: number): Deployment => ({
  chainId: 1,
  contracts: {
    VerifierAllowlist: { address: "0x0000000000000000000000000000000000000001", block },
    EmissionsClaimRegistry: { address: "0x0000000000000000000000000000000000000002", block },
  },
});

/** First block with timestamp >= t, last block with timestamp <= t (binary search). */
function firstAtOrAfter(ts: bigint[], t: bigint) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m] >= t) hi = m;
    else lo = m + 1;
  }
  return lo;
}
const lastAtOrBefore = (ts: bigint[], t: bigint) => firstAtOrAfter(ts, t + 1n) - 1;

/** The deployment block, then per bound two reads per round. */
const MAX_READS = 1 + 2 * 2 * SEARCH_ROUNDS;

async function checkRanges(ts: bigint[], deployBlock: number, seed: number, cases = 60) {
  const r = rng(seed);
  const head = BigInt(ts.length - 1);
  const stats = { maxReads: 0, maxExtra: 0n, maxLogsPerEvent: 0 };
  for (let k = 0; k < cases; k++) {
    const t0 = ts[deployBlock] + BigInt(Math.floor(r() * Number(ts[ts.length - 1] - ts[deployBlock])));
    const t1 = t0 + DAY;
    const f = fakeClient(ts);
    const reader = new ChainReader(f.client, deployment(deployBlock)).at(head);
    const range = await reader.blockRangeForTimes(t0, t1, { number: head, timestamp: ts[ts.length - 1] });
    const b0 = Math.max(firstAtOrAfter(ts, t0), deployBlock);
    const b1 = Math.min(lastAtOrBefore(ts, t1), ts.length - 1);
    // Containment: every block with a timestamp in [t0, t1] (and in the deployment range) is in the range.
    expect(range.narrowed).toBe(true);
    expect(range.fromBlock).toBeGreaterThanOrEqual(BigInt(deployBlock));
    expect(range.toBlock).toBeLessThanOrEqual(head);
    if (b0 <= b1) {
      expect(range.fromBlock).toBeLessThanOrEqual(BigInt(b0));
      expect(range.toBlock).toBeGreaterThanOrEqual(BigInt(b1));
    }
    if (range.fromBlock > BigInt(deployBlock)) expect(ts[Number(range.fromBlock)]).toBeLessThan(t0);
    if (range.toBlock < head) expect(ts[Number(range.toBlock)]).toBeGreaterThan(t1);
    expect(f.reads()).toBeLessThanOrEqual(MAX_READS);
    const exact = BigInt(Math.max(0, b1 - b0 + 1));
    const size = range.toBlock - range.fromBlock + 1n;
    stats.maxReads = Math.max(stats.maxReads, f.reads());
    if (size - exact > stats.maxExtra) stats.maxExtra = size - exact;
    stats.maxLogsPerEvent = Math.max(stats.maxLogsPerEvent, Math.ceil(Number(size) / Number(LOG_CHUNK)));
  }
  return stats;
}

describe("blockRangeForTimes on simulated chains", () => {
  it("a year of 12 s slots with 0-8 % missed slots, varying by week: one getLogs chunk per event, few block reads", async () => {
    const r = rng(7);
    let missRate = 0.02;
    const ts = chain(2_628_000, 1_790_000_000n, (i) => {
      if (i % 50_400 === 0) missRate = r() * 0.08;
      let gap = 12;
      while (r() < missRate) gap += 12;
      return gap;
    });
    const stats = await checkRanges(ts, 1_000, 11);
    // The margin is at most a few tolerances; 24 h is about 7,000 blocks, so each event search is one request.
    expect(stats.maxExtra).toBeLessThanOrEqual(4n * SEARCH_TOLERANCE);
    expect(stats.maxLogsPerEvent).toBe(1);
  });

  it("abrupt changes of block time (1 s, 2 s, 60 s, 12 s stretches): ranges stay safe", async () => {
    const ts = chain(400_000, 1_790_000_000n, (i) => {
      const phase = Math.floor(i / 25_000) % 4;
      return [12, 1, 60, 2][phase];
    });
    await checkRanges(ts, 0, 5, 80);
  });

  it("equal timestamps over long stretches (a node that does not advance time): ranges stay safe", async () => {
    const ts = chain(200_000, 1_790_000_000n, (i) => (i % 1000 < 900 ? 0 : 120));
    await checkRanges(ts, 10, 3, 40);
  });

  it("read errors and a short chain give the whole range from the deployment block", async () => {
    const ts = chain(100_000, 1_790_000_000n, () => 12);
    const head = BigInt(ts.length - 1);
    const failing = {
      getBlock: async () => {
        throw new Error("rate limited");
      },
    } as unknown as PublicClient;
    const r1 = await new ChainReader(failing, deployment(5)).at(head).blockRangeForTimes(ts[50_000], ts[50_000] + DAY, {
      number: head,
      timestamp: ts[ts.length - 1],
    });
    expect(r1).toEqual({ fromBlock: 5n, toBlock: head, narrowed: false });
    const short = fakeClient(ts.slice(0, 300));
    const r2 = await new ChainReader(short.client, deployment(5)).at(299n).blockRangeForTimes(ts[100], ts[100] + DAY);
    expect(r2).toEqual({ fromBlock: 5n, toBlock: 299n, narrowed: false });
    expect(short.reads()).toBe(0);
    const full = fakeClient(ts);
    const r3 = await new ChainReader(full.client, deployment(5), undefined, { fullEventScan: true })
      .at(head)
      .blockRangeForTimes(ts[50_000], ts[50_000] + DAY);
    expect(r3).toEqual({ fromBlock: 5n, toBlock: head, narrowed: false });
  });
});
