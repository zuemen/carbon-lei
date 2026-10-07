// Machine-readable verdict of a proof verification: what `carbonlei verify --json` prints.
// It only reshapes what `verifyPresentation` returned and adds the chain snapshot the checks read;
// it does not change any check or result. Schema: docs/schemas/verdict.schema.json.
import type { ChainReader } from "./chain.ts";
import { vleiCheckers } from "./checkers.ts";
import type { Presentation } from "./disclosure.ts";
import { disclosureCounts } from "./summary.ts";
import { DEMO_TRUST_ANCHOR } from "./vlei.ts";
import { verifyPresentation, type EvidenceCheckers, type VerificationResult, type VerifyOptions } from "./verify.ts";

/** Version of the verdict format; a change that breaks a consumer increases it. */
export const VERDICT_FORMAT = 1;
/** Kept equal to sdk/package.json `version` (tested). */
export const TOOL = { name: "carbonlei", version: "0.1.0" } as const;

/** Exit codes of `carbonlei verify --json`. Without --json, a run that throws exits 1 (unchanged). */
export const EXIT = { VALID: 0, INVALID: 1, CONTESTED: 2, ERROR: 3 } as const;

export interface VerdictCheck {
  /** Check number, 0 to 8 (sdk/verify.ts). */
  id: number;
  name: string;
  status: "pass" | "fail" | "warn" | "skipped";
  code: string;
  detail: string;
}

export interface Verdict {
  format: typeof VERDICT_FORMAT;
  overall: "VALID" | "INVALID" | "CONTESTED";
  /** Code of the first failing check; "" when no check failed. */
  primaryCode: string;
  checks: VerdictCheck[];
  /** Signed fields the importer did not get because the supplier withheld them. */
  hidden: number;
  /** Disclosures presented but rejected by check 2 (they reveal no signed value). */
  rejected: number;
  /** Field values that matched the signed credential. */
  disclosed: Record<string, string>;
  credSAID: string | null;
  /** The block every chain read was pinned to; null when the run stopped before reading the chain. */
  chain: { chainId: number | null; block: number | null };
  /** Time used for checks 4 and 5 (UNIX seconds): the shipment's claim time, or the block time. */
  checkedAt: number | null;
  /** Root of trust check 7 was run with; null when the caller supplied its own checkers. */
  trustAnchor: string | null;
  tool: { name: string; version: string };
}

export interface VerdictError {
  format: typeof VERDICT_FORMAT;
  error: string;
  tool: { name: string; version: string };
}

export interface VerdictOptions extends Omit<VerifyOptions, "checkers"> {
  /** Checks 6-8; default: the vLEI checkers with `loadBundle` and `trustAnchor`. */
  checkers?: EvidenceCheckers;
  loadBundle?: (path: string) => Promise<string> | string;
  /** Root of trust for check 7 (default: the demo root, DEMO_TRUST_ANCHOR). */
  trustAnchor?: string;
}

const num = (x: bigint | undefined) => (x === undefined ? null : Number(x));

/** The verdict of a result `verifyPresentation` returned for `proof`. */
export function toVerdict(
  proof: Presentation,
  r: VerificationResult,
  ctx: { chainId?: number; block?: bigint; trustAnchor?: string | null },
): Verdict {
  const { hidden, rejected } = disclosureCounts(proof, r);
  let credSAID: string | null = null;
  try {
    const d = JSON.parse(proof.core)?.d;
    if (typeof d === "string") credSAID = d;
  } catch {}
  return {
    format: VERDICT_FORMAT,
    overall: r.overall,
    primaryCode: r.primaryCode,
    checks: r.checks.map((c) => ({ id: c.index, name: c.name, status: c.status, code: c.code, detail: c.detail })),
    hidden,
    rejected,
    disclosed: { ...r.disclosed },
    credSAID,
    chain: { chainId: ctx.chainId ?? null, block: num(ctx.block) },
    checkedAt: num(r.checkedAt),
    trustAnchor: ctx.trustAnchor ?? null,
    tool: { ...TOOL },
  };
}

/** Exit code of a verdict: VALID 0, INVALID 1, CONTESTED 2. */
export const exitCodeOf = (v: Pick<Verdict, "overall">) => EXIT[v.overall];

export function verdictError(err: unknown): VerdictError {
  return { format: VERDICT_FORMAT, error: (err as Error)?.message ?? String(err), tool: { ...TOOL } };
}

/**
 * Verifies `proof` against `reader` and returns its verdict. The block number is the one
 * `verifyPresentation` pinned its reads to (it asks the reader for the latest block once), and the
 * chain ID the one it read for check 3; no extra request is sent.
 */
export async function verdictFor(proof: Presentation, reader: ChainReader, opts: VerdictOptions = {}): Promise<Verdict> {
  let block: bigint | undefined;
  let chainId: number | undefined;
  const client = new Proxy(reader.client, {
    get(target, prop) {
      if (prop === "getChainId") {
        return async () => (chainId = await target.getChainId());
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const watched = new Proxy(reader, {
    get(target, prop) {
      if (prop === "client") return client;
      if (prop === "latestBlock") {
        return async () => {
          const b = await target.latestBlock();
          block = b.number;
          return b;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { checkers, loadBundle, trustAnchor, ...rest } = opts;
  const r = await verifyPresentation(proof, watched, {
    ...rest,
    checkers:
      checkers ??
      vleiCheckers({
        ...(loadBundle ? { loadBundle: async (p: string) => loadBundle(p) } : {}),
        ...(trustAnchor ? { trustAnchor } : {}),
      }),
  });
  return toVerdict(proof, r, { chainId, block, trustAnchor: checkers ? (trustAnchor ?? null) : (trustAnchor ?? DEMO_TRUST_ANCHOR) });
}
