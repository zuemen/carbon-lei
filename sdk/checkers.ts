// Checkers for verification checks 6 and 7 (vLEI evidence), shared by the CLI and the hosted page.
// The authority evidence can travel inline in the proof or as a reference to a bundle file
// ({ bundle, sha256 }); the caller supplies how to load a bundle (fetch in the browser, fs in Node).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8 } from "./encoding.ts";
import type { CheckResult, EvidenceCheckers, EvidenceContext } from "./verify.ts";
import { DEMO_TRUST_ANCHOR, verifyAnchor, verifyAuthority, type AnchorEvidence, type AuthorityEvidence } from "./vlei.ts";
import { checkReconciliation, type ReportExtract } from "./consistency.ts";

export interface BundleRef {
  bundle: string;
  sha256: string;
}

const isRef = (x: unknown): x is BundleRef =>
  typeof x === "object" && x !== null && typeof (x as BundleRef).bundle === "string" && typeof (x as BundleRef).sha256 === "string";

/**
 * A bundle reference may only name a file under `evidence/`: letters, digits and `_ . / -`,
 * no `..` segment and no leading `/`. Anything else is never loaded (check 7 fails).
 */
export function isSafeBundlePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /^evidence\/[A-Za-z0-9_./-]+$/.test(path) &&
    !path.includes("..") &&
    !path.startsWith("/")
  );
}

export const sha256Hex = (text: string) => bytesToHex(sha256(utf8(text)));

function result(index: number, ok: boolean, code: string, detail: string): CheckResult {
  return { index, name: "", status: ok ? "pass" : "fail", code: ok ? "" : code, detail };
}

export function vleiCheckers(
  opts: { loadBundle?: (path: string) => Promise<string>; trustAnchor?: string } = {},
): EvidenceCheckers {
  const trustAnchor = opts.trustAnchor ?? DEMO_TRUST_ANCHOR;
  return {
    anchor: (ev: unknown, ctx: EvidenceContext) => {
      if (!ctx.report) return result(6, false, "ANCHOR_NOT_FOUND", "the report is not registered, so there is no anchor to check");
      const r = verifyAnchor(ev as AnchorEvidence, {
        credSAID: ctx.core.d,
        auditorAID: ctx.core.issuer.auditorAID,
        kelSeq: ctx.report.kelSeq,
        auditorAidHash: ctx.report.auditorAidHash,
      });
      return result(6, r.ok, r.code, r.detail);
    },
    authority: async (ev: unknown, ctx: EvidenceContext) => {
      // The two allowlist reads start together with the bundle load; awaited only after the hash check.
      const report = ctx.report;
      const instP = report ? ctx.reader.institution(report.issuerLeiHash) : undefined;
      const audP = report ? ctx.reader.auditor(report.auditorAidHash, report.issuerLeiHash) : undefined;
      instP?.catch(() => {});
      audP?.catch(() => {});
      let bundle: AuthorityEvidence;
      if (isRef(ev)) {
        if (!opts.loadBundle) return result(7, false, "AUTHORITY_INVALID", "authority evidence is a reference and cannot be loaded here");
        if (!isSafeBundlePath(ev.bundle)) {
          return result(
            7,
            false,
            "AUTHORITY_INVALID",
            "the authority evidence path is not allowed (it must be a file under evidence/, without '..'); not loaded",
          );
        }
        const text = await opts.loadBundle(ev.bundle);
        if (sha256Hex(text) !== ev.sha256.toLowerCase()) {
          return result(7, false, "AUTHORITY_INVALID", "the authority evidence file does not match its hash in the proof");
        }
        bundle = JSON.parse(text) as AuthorityEvidence;
      } else {
        bundle = ev as AuthorityEvidence;
      }
      let onchain;
      if (instP && audP) {
        const inst = await instP;
        const aud = await audP;
        onchain = {
          leCredSaidHash: inst.leCredSaidHash,
          accreditationSaidHash: inst.accreditationSaidHash,
          ecrSaidHash: aud.ecrSaidHash,
        };
      }
      const r = verifyAuthority(bundle, {
        trustAnchor,
        auditorAID: ctx.core.issuer.auditorAID,
        verifierLEI: ctx.core.issuer.verifierLEI,
        cnCode: ctx.disclosed.cnCode ?? "",
        registeredAt: ctx.report?.registeredAt,
        onchain,
      });
      return result(7, r.ok, r.code, r.detail);
    },
    reconciliation: (extract: Record<string, unknown>, ctx: EvidenceContext) => {
      const r = checkReconciliation(extract as unknown as ReportExtract, ctx.disclosed, ctx.core.reconciliation, ctx.rejected);
      return { index: 8, name: "", status: r.status, code: r.code, detail: r.detail };
    },
  };
}
