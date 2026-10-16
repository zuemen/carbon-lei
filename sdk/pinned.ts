// One snapshot for many verifications, and a small concurrency limiter. No file system: used by `verify-batch`
// (sdk/batch.ts re-exports both), `recheck` (sdk/recheck.ts) and the browser demo.
import type { ChainReader } from "./chain.ts";

/** Concurrency limit: public RPC nodes rate-limit, so at most this many proofs are verified at once. */
export const MAX_CONCURRENCY = 4;

/**
 * A reader whose `latestBlock` always returns `head`: every verification of a batch then pins its reads to that one
 * block (`verifyPresentation` reads the head once and continues on `reader.at(head.number)`), so all proofs of a
 * run are judged against the same chain state. Everything else is the reader's own.
 */
export function pinnedToHead(reader: ChainReader, head: { number: bigint; timestamp: bigint }): ChainReader {
  const r = Object.create(reader) as ChainReader;
  r.latestBlock = async () => ({ number: head.number, timestamp: head.timestamp });
  return r;
}

/** Runs `fn` on every item, at most `concurrency` at a time, and returns the results in input order. */
export async function runLimited<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}, got ${concurrency}`);
  }
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
