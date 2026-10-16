// Machine-readable verdict of a proof verification: what `carbonlei verify --json` prints.
// It only reshapes what `verifyPresentation` returned and adds the chain snapshot the checks read;
// it does not change any check or result. Schema: docs/schemas/verdict.schema.json.
import type { ChainReader } from "./chain.ts";
import { vleiCheckers } from "./checkers.ts";
import type { AccreditationRegistry } from "./verification-rules.ts";
import type { Presentation } from "./disclosure.ts";
import { disclosureCounts } from "./summary.ts";
import { DEMO_TRUST_ANCHOR } from "./vlei.ts";
import type { PrecursorLineResult, PrecursorReport } from "./precursor.ts";
import type { CarbonPriceReport } from "./carbonprice.ts";
import {
  verifyPresentation,
  type EvidenceCheckers,
  type Overall,
  type VerificationResult,
  type VerificationWarning,
  type VerifyOptions,
} from "./verify.ts";

/**
 * Version of the verdict format; a change that breaks a consumer increases it.
 * 2: `overall` can be INCOMPLETE (exit 4); `warnings` added; `checkedAt` is the claim time only when check 5
 * binds the shipment to the given EORI. Check 9 (precursors) and `precursors` were added within format 2: they appear
 * only for a proof whose credential commits to a precursor statement or that carries precursor evidence, so the
 * verdict of any other proof is unchanged.
 */
export const VERDICT_FORMAT = 2;
/** Kept equal to sdk/package.json `version` (tested). */
export const TOOL = { name: "carbonlei", version: "0.1.0" } as const;

/** Exit codes of `carbonlei verify --json`. Without --json, a run that throws exits 1 (unchanged). */
export const EXIT = { VALID: 0, INVALID: 1, CONTESTED: 2, ERROR: 3, INCOMPLETE: 4 } as const;

export interface VerdictCheck {
  /** Check number, 0 to 9 (sdk/verify.ts; 9 only when the proof has a precursor part). */
  id: number;
  name: string;
  status: "pass" | "fail" | "warn" | "skipped";
  code: string;
  detail: string;
  /** Check 8's sub-rules (sdk/verification-rules.ts), when they ran. */
  rules?: { rule: string; status: "pass" | "fail" | "warn" | "note"; code: string; detail: string }[];
}

export interface Verdict {
  format: typeof VERDICT_FORMAT;
  overall: Overall;
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
  /**
   * Time used for checks 4 and 5 (UNIX seconds): the shipment's claim time when check 5 bound the shipment to the
   * given EORI, otherwise the block time.
   */
  checkedAt: number | null;
  /** How the checks were run, when the caller should know (for example SHIPMENT_NOT_BOUND without an EORI). */
  warnings: VerificationWarning[];
  /** Root of trust check 7 was run with; null when the caller supplied its own checkers. */
  trustAnchor: string | null;
  /** Check 9's breakdown, when check 9 ran: direct and precursor contributions, each producer's verification. */
  precursors?: VerdictPrecursors;
  /** Check 10's breakdown, when check 10 ran (draft CBAM Art 9 rules, not adopted: illustrative). */
  carbonPrice?: CarbonPriceReport;
  tool: { name: string; version: string };
}

export type VerdictPrecursorLine = Omit<PrecursorLineResult, "verification"> & {
  verification?: { overall: Overall; primaryCode: string; checks: VerdictCheck[]; precursors?: VerdictPrecursors };
};
export type VerdictPrecursors = Omit<PrecursorReport, "lines"> & { lines: VerdictPrecursorLine[] };

const toVerdictChecks = (cs: VerificationResult["checks"]): VerdictCheck[] =>
  cs.map((c) => ({ id: c.index, name: c.name, status: c.status, code: c.code, detail: c.detail, ...(c.rules ? { rules: c.rules } : {}) }));

function toVerdictPrecursors(p: PrecursorReport): VerdictPrecursors {
  return {
    ...p,
    lines: p.lines.map(({ verification, ...l }) => ({
      ...l,
      ...(verification
        ? {
            verification: {
              overall: verification.overall,
              primaryCode: verification.primaryCode,
              checks: toVerdictChecks(verification.checks),
              ...(verification.precursors ? { precursors: toVerdictPrecursors(verification.precursors) } : {}),
            },
          }
        : {}),
    })),
  };
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
  /** Root of trust for check 7 of the precursor tiers (check 9; default: `trustAnchor`). */
  precursorTrustAnchor?: string;
  /** Root of trust for the carbon price certifier (check 10; default: `precursorTrustAnchor`, then `trustAnchor`). */
  carbonPriceTrustAnchor?: string;
  /** The allowlist operator's accreditation records: check 8's provenance sub-rules (sdk/verification-rules.ts). */
  accreditationRegistry?: AccreditationRegistry;
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
    checks: toVerdictChecks(r.checks),
    hidden,
    rejected,
    disclosed: { ...r.disclosed },
    credSAID,
    chain: { chainId: ctx.chainId ?? null, block: num(ctx.block) },
    checkedAt: num(r.checkedAt),
    warnings: (r.warnings ?? []).map((w) => ({ ...w })),
    trustAnchor: ctx.trustAnchor ?? null,
    ...(r.precursors ? { precursors: toVerdictPrecursors(r.precursors) } : {}),
    ...(r.carbonPrice ? { carbonPrice: r.carbonPrice } : {}),
    tool: { ...TOOL },
  };
}

/** Exit code of a verdict: VALID 0, INVALID 1, CONTESTED 2, INCOMPLETE 4. */
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
  const { checkers, loadBundle, trustAnchor, precursorTrustAnchor, carbonPriceTrustAnchor, accreditationRegistry, ...rest } = opts;
  const r = await verifyPresentation(proof, watched, {
    ...rest,
    checkers:
      checkers ??
      vleiCheckers({
        ...(loadBundle ? { loadBundle: async (p: string) => loadBundle(p) } : {}),
        ...(trustAnchor ? { trustAnchor } : {}),
        ...(precursorTrustAnchor ? { precursorTrustAnchor } : {}),
        ...(carbonPriceTrustAnchor ? { carbonPriceTrustAnchor } : {}),
        ...(accreditationRegistry ? { accreditationRegistry } : {}),
      }),
  });
  return toVerdict(proof, r, { chainId, block, trustAnchor: checkers ? (trustAnchor ?? null) : (trustAnchor ?? DEMO_TRUST_ANCHOR) });
}
