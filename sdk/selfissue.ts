// Self-issued demo proof from a Communication Template draft: what the page's "own template" walk-through signs
// with a key made on the spot, to show which checks a report without a verification body gets through.
// The key signs under the deployment's signing domain like any body's key would; nothing is registered or claimed,
// so the checks that read the shared ledger and the vLEI chain have nothing to accept.
import type { LocalAccount } from "viem";
import { CLAIM_ORDER, METHODOLOGY_NOTE, type ClaimName, type CredentialClaims, type Hex } from "./credential.ts";
import type { Presentation } from "./disclosure.ts";
import { newSalt } from "./encoding.ts";
import { DEMO_DISCLOSURE, issueCredential, present, type SignedCredential } from "./issue.ts";
import type { CredentialDraft } from "./template.ts";

/** The label every self-issued demo proof carries on the page. */
export const SELF_ISSUED_LABEL = "demo key generated in this page; not a verification body; not registered on Sepolia";

/** The auditor identifier of a self-issued proof: there is no KERI identifier behind the demo key. */
export const SELF_ISSUED_AUDITOR_AID = "none: demo key generated in this page, no KERI identifier";

const NOT_SUPPLIED = "not supplied (placeholder)";

/**
 * Placeholder values for the fields a Communication Template cannot fill. Fields that feed on-chain keys must be in
 * normal form, so they get fixed, visibly fictional values (LEIs with the ZZZZ prefix the demo uses for fictional
 * entities); every other missing field is the text "not supplied (placeholder)".
 */
const PLACEHOLDER: Partial<Record<ClaimName, string>> = {
  supplierLEI: "ZZZZ00SELFISSUEDSP00",
  verifierLEI: "ZZZZ00SELFISSUEDVB00",
  installationId: "ZZ-ZZZZ00SELFISSUEDSP00-0001",
  cbamRoute: "Z",
  // A credential needs a positive quantity; the template's activity data is not a verified quantity.
  verifiedTonnes: "1",
  verificationReportId: "SELF-ISSUED-PLACEHOLDER",
};

/** Days from issuance to the placeholder validUntil (the template has no validity; a body would set it). */
export const SELF_ISSUED_VALID_DAYS = 30;

export interface SelfIssuedField {
  field: ClaimName;
  value: string;
  /** "template": read from the file; "placeholder": filled by this function; "issuance": set when signing. */
  from: "template" | "placeholder" | "issuance";
}

export interface SelfIssued {
  credential: SignedCredential;
  /** The proof a supplier would hand over: the demo disclosure set, no shipment (nothing was claimed). */
  proof: Presentation;
  fields: SelfIssuedField[];
}

/** Every claim of a self-issued credential: the draft's values, placeholders for the rest, and the issuance fields. */
export function selfIssuedClaims(draft: CredentialDraft, now: Date): { claims: CredentialClaims; fields: SelfIssuedField[] } {
  const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const validUntil = new Date(issuedAt.getTime() + SELF_ISSUED_VALID_DAYS * 86_400_000);
  const issuance: Partial<Record<ClaimName, string>> = {
    methodologyNote: METHODOLOGY_NOTE,
    idSalt: newSalt(),
    batchSalt: newSalt(),
    issuedAt: issuedAt.toISOString().replace(".000Z", "Z"),
  };
  const fields: SelfIssuedField[] = CLAIM_ORDER.map((field) => {
    const t = draft.fields[field];
    if (t !== undefined) return { field, value: t, from: "template" };
    const s = issuance[field];
    if (s !== undefined) return { field, value: s, from: "issuance" };
    if (field === "validUntil") return { field, value: validUntil.toISOString().replace(".000Z", "Z"), from: "placeholder" };
    return { field, value: PLACEHOLDER[field] ?? NOT_SUPPLIED, from: "placeholder" };
  });
  const claims = Object.fromEntries(fields.map((f) => [f.field, f.value])) as unknown as CredentialClaims;
  return { claims, fields };
}

/**
 * Signs a draft with `signer` (a key the caller made for this purpose) under the registry's signing domain and
 * builds the supplier's proof. Sends nothing: no registration, no claim.
 */
export async function selfIssueDraft(
  draft: CredentialDraft,
  opts: { signer: LocalAccount; registry: Hex; chainId: number; now?: Date },
): Promise<SelfIssued> {
  const { claims, fields } = selfIssuedClaims(draft, opts.now ?? new Date());
  const credential = await issueCredential({
    claims,
    auditorAID: SELF_ISSUED_AUDITOR_AID,
    signer: opts.signer,
    registry: opts.registry,
    chainId: opts.chainId,
  });
  return { credential, proof: present(credential, DEMO_DISCLOSURE), fields };
}
