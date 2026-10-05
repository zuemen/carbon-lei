// Checkers for verification checks 6 and 7 (vLEI evidence), shared by the CLI and the hosted page.
// The authority evidence can travel inline in the proof or as a reference to a bundle file
// ({ bundle, sha256 }); the caller supplies how to load a bundle (fetch in the browser, fs in Node).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8 } from "./encoding.ts";
import type { CheckResult, EvidenceCheckers, EvidenceContext } from "./verify.ts";
import { verifyAnchor, verifyAuthority, type AnchorEvidence, type AuthorityEvidence } from "./vlei.ts";

export interface BundleRef {
  bundle: string;
  sha256: string;
}

const isRef = (x: unknown): x is BundleRef =>
  typeof x === "object" && x !== null && typeof (x as BundleRef).bundle === "string" && typeof (x as BundleRef).sha256 === "string";

export const sha256Hex = (text: string) => bytesToHex(sha256(utf8(text)));

function result(index: number, ok: boolean, code: string, detail: string): CheckResult {
  return { index, name: "", status: ok ? "pass" : "fail", code: ok ? "" : code, detail };
}

export function vleiCheckers(opts: { loadBundle?: (path: string) => Promise<string> } = {}): EvidenceCheckers {
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
      let bundle: AuthorityEvidence;
      if (isRef(ev)) {
        if (!opts.loadBundle) return result(7, false, "AUTHORITY_INVALID", "authority evidence is a reference and cannot be loaded here");
        const text = await opts.loadBundle(ev.bundle);
        if (sha256Hex(text) !== ev.sha256.toLowerCase()) {
          return result(7, false, "AUTHORITY_INVALID", "the authority evidence file does not match its hash in the proof");
        }
        bundle = JSON.parse(text) as AuthorityEvidence;
      } else {
        bundle = ev as AuthorityEvidence;
      }
      let onchain;
      if (ctx.report) {
        const inst = await ctx.reader.institution(ctx.report.issuerLeiHash);
        const aud = await ctx.reader.auditor(ctx.report.auditorAidHash, ctx.report.issuerLeiHash);
        onchain = {
          leCredSaidHash: inst.leCredSaidHash,
          accreditationSaidHash: inst.accreditationSaidHash,
          ecrSaidHash: aud.ecrSaidHash,
        };
      }
      const r = verifyAuthority(bundle, {
        auditorAID: ctx.core.issuer.auditorAID,
        verifierLEI: ctx.core.issuer.verifierLEI,
        cnCode: ctx.disclosed.cnCode ?? "",
        registeredAt: ctx.report?.registeredAt,
        onchain,
      });
      return result(7, r.ok, r.code, r.detail);
    },
  };
}
