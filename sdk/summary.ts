// Wording of the CLI's one-line verification summary. It only counts what `verifyPresentation`
// returned and what the proof carries; it does not change any check or result.
import { decodeDisclosure, type Presentation } from "./disclosure.ts";
import type { VerificationResult } from "./verify.ts";

/**
 * Splits the fields the importer did not get into the ones the supplier withheld and the ones whose
 * disclosure was presented but rejected by check 2 (it does not match a signed digest), counted per
 * field name. `result.hidden` counts both, since a rejected disclosure reveals no signed value.
 */
export function disclosureCounts(proof: Presentation, result: VerificationResult): { hidden: number; rejected: number } {
  const rejected = new Set<string>();
  // Check 0 stops a malformed proof before check 2, so there is nothing to split.
  if (!result.checks.some((c) => c.index === 2)) return { hidden: result.hidden, rejected: 0 };
  for (const enc of Array.isArray(proof.disclosures) ? proof.disclosures : []) {
    try {
      const { name } = decodeDisclosure(enc);
      if (!Object.hasOwn(result.disclosed, name)) rejected.add(name);
    } catch {
      // malformed disclosures stop at check 0, which reports them
    }
  }
  return { hidden: Math.max(0, result.hidden - rejected.size), rejected: rejected.size };
}

/** "5 field(s) hidden by supplier", followed by "; 1 disclosure(s) rejected" when check 2 rejected any. */
export function disclosureSummary(proof: Presentation, result: VerificationResult): string {
  const { hidden, rejected } = disclosureCounts(proof, result);
  return `${hidden} field(s) hidden by supplier${rejected ? `; ${rejected} disclosure(s) rejected` : ""}`;
}
