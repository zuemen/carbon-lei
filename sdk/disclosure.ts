// Selective disclosure (SD-JWT style): one salted disclosure per claim; the core carries only
// sorted digests. A presentation hands over the core, the signature and the chosen disclosures.
import { sha256 } from "@noble/hashes/sha2.js";
import {
  CLAIM_ORDER,
  CREDENTIAL_TYPE,
  CREDENTIAL_VERSION,
  type ClaimName,
  type CredentialClaims,
  type Hex,
} from "./credential.ts";
import { base64url, fromBase64url, isSalt, newSalt, utf8 } from "./encoding.ts";
import { computeSaid } from "./said.ts";

export interface Disclosure {
  salt: Hex;
  name: string;
  value: string;
}

export interface Reconciliation {
  inputHash: Hex;
  outputHash: Hex;
  ruleVersionHash: Hex;
}

/** Signed credential core. Strings only, so any language serialises it identically. */
export interface CredentialCore {
  d: string;
  type: string;
  version: string;
  issuer: { verifierAddress: Hex; verifierLEI: string; auditorAID: string };
  digests: string[];
  reconciliation?: Reconciliation;
  issuedAt: string;
  validUntil: string;
}

export interface ShipmentPart {
  batchId: string;
  quantityTonnes: string;
  shipmentDate: string;
  importerSalt: Hex;
}

export interface Presentation {
  /** The core exactly as signed; keep this text, do not re-serialise it. */
  core: string;
  signature: Hex;
  disclosures: string[];
  shipment?: ShipmentPart;
  anchorEvidence?: unknown;
  authorityEvidence?: unknown;
  reportExtract?: Record<string, unknown>;
}

/** Encoded disclosure: base64url of the compact JSON array [salt, name, value]. */
export function encodeDisclosure(d: Disclosure): string {
  return base64url(utf8(JSON.stringify([d.salt, d.name, d.value])));
}

export function decodeDisclosure(encoded: string): Disclosure {
  const arr = JSON.parse(new TextDecoder().decode(fromBase64url(encoded)));
  if (
    !Array.isArray(arr) ||
    arr.length !== 3 ||
    !isSalt(arr[0]) ||
    typeof arr[1] !== "string" ||
    typeof arr[2] !== "string"
  ) {
    throw new Error("malformed disclosure");
  }
  return { salt: arr[0], name: arr[1], value: arr[2] };
}

/** Digest of an encoded disclosure: base64url(sha256(utf8(encoded))). */
export function disclosureDigest(encoded: string): string {
  return base64url(sha256(utf8(encoded)));
}

/** Byte order of the base64url strings (ASCII only), independent of claim names. */
export function sortDigests(digests: string[]): string[] {
  return [...digests].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface IssueInput {
  claims: CredentialClaims;
  verifierAddress: Hex;
  auditorAID: string;
  reconciliation?: Reconciliation;
  /** Fixed salts for test vectors; random otherwise. */
  salts?: Partial<Record<ClaimName, Hex>>;
}

export interface IssuedCredential {
  core: CredentialCore;
  coreJson: string;
  /** All encoded disclosures keyed by claim name, hidden ones included. */
  disclosures: Record<string, string>;
}

/** Builds the core with the digest of every claim and fills its SAID. Signing is separate (eip712.ts). */
export function buildCredential(input: IssueInput): IssuedCredential {
  const disclosures: Record<string, string> = {};
  for (const name of CLAIM_ORDER) {
    const value = input.claims[name];
    if (typeof value !== "string") throw new Error(`claim ${name} missing`);
    const salt = input.salts?.[name] ?? newSalt();
    disclosures[name] = encodeDisclosure({ salt, name, value });
  }
  const core: CredentialCore = {
    d: "",
    type: CREDENTIAL_TYPE,
    version: CREDENTIAL_VERSION,
    issuer: {
      verifierAddress: input.verifierAddress,
      verifierLEI: input.claims.verifierLEI,
      auditorAID: input.auditorAID,
    },
    digests: sortDigests(Object.values(disclosures).map(disclosureDigest)),
    ...(input.reconciliation ? { reconciliation: input.reconciliation } : {}),
    issuedAt: input.claims.issuedAt,
    validUntil: input.claims.validUntil,
  };
  core.d = computeSaid(core as unknown as Record<string, unknown>);
  return { core, coreJson: JSON.stringify(core), disclosures };
}

/** Picks the disclosures a supplier hands over. */
export function selectDisclosures(all: Record<string, string>, names: readonly string[]): string[] {
  return names.map((n) => {
    const d = all[n];
    if (!d) throw new Error(`no disclosure for ${n}`);
    return d;
  });
}
