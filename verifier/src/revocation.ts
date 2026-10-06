// Pure helpers for finding a credential's issuance or revocation in the issuer's KEL.
// A vLEI credential's TEL has event 0 (`iss`) and, once revoked, event 1 (`rev`). Each TEL event is
// anchored in the issuer's KEL by a seal { i: credSAID, s: <TEL sn>, d: <TEL event SAID> }, so a
// revocation is visible to anyone who reads the issuer's witnessed KEL, regardless of what a local
// credential `status` says. No KERIA access here: the functions take keyEvents().get() records
// ({ ked, atc }), bare event dicts, or messages from sdk parseCesr() ({ raw, ked }).
import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64url } from "../../sdk/encoding.ts";
import { controllerSigs } from "../../sdk/kel.ts";
import { computeSaid } from "../../sdk/said.ts";

// Shared with check 7 (sdk/kel.ts), which runs in the browser too.
export { controllerSigs, type IndexedSig } from "../../sdk/kel.ts";

export type Json = Record<string, any>;

/** A KEL event as KERIA serves it ({ ked, atc }), as parseCesr returns it ({ raw, ked }), or a bare dict. */
export type KelInput = { ked: Json; atc?: string; raw?: string } | Json;

export interface CredentialSeal {
  i: string;
  s: string;
  d: string;
}

export interface SealHit {
  /** KEL sequence number of the event carrying the seal. */
  sn: number;
  eventSaid: string;
  eventType: string;
  seal: CredentialSeal;
  ked: Json;
  /** Event bytes: the parsed stream's raw text when available, else the JSON serialization of `ked`. */
  raw: string;
  atc?: string;
}

const ESTABLISHMENT = new Set(["icp", "rot", "dip", "drt"]);

function isRecord(e: KelInput): e is { ked: Json; atc?: string; raw?: string } {
  return !!e && typeof e === "object" && !!e.ked && typeof e.ked === "object";
}

function kedOf(e: KelInput): Json {
  return isRecord(e) ? e.ked : e;
}

function snOf(ked: Json): number {
  return typeof ked?.s === "string" && /^[0-9a-f]+$/.test(ked.s) ? parseInt(ked.s, 16) : NaN;
}

/**
 * First (lowest sn) event in `events` with a seal { i: credSaid, s: telSn, d: <string> } in its
 * anchor list `a`. With `issuer`, events by any other controller are ignored.
 */
export function findCredentialSeal(
  events: readonly KelInput[],
  credSaid: string,
  telSn: string,
  opts: { issuer?: string } = {},
): SealHit | undefined {
  let best: SealHit | undefined;
  for (const e of events) {
    const ked = kedOf(e);
    if (!ked || !Array.isArray(ked.a)) continue;
    if (opts.issuer && ked.i !== opts.issuer) continue;
    const seal = ked.a.find(
      (s: Json) => s && typeof s === "object" && s.i === credSaid && s.s === telSn && typeof s.d === "string",
    );
    if (!seal) continue;
    const sn = snOf(ked);
    if (Number.isNaN(sn)) continue;
    if (best && best.sn <= sn) continue;
    best = {
      sn,
      eventSaid: ked.d,
      eventType: ked.t,
      seal: { i: seal.i, s: seal.s, d: seal.d },
      ked,
      raw: isRecord(e) && typeof e.raw === "string" ? e.raw : JSON.stringify(ked),
      atc: isRecord(e) ? e.atc : undefined,
    };
  }
  return best;
}

/** The KEL event anchoring the credential's TEL `rev` event: seal { i: credSaid, s: "1" }. */
export function findRevocationSeal(events: readonly KelInput[], credSaid: string, opts: { issuer?: string } = {}) {
  return findCredentialSeal(events, credSaid, "1", opts);
}

/** The KEL event anchoring the credential's TEL `iss` event: seal { i: credSaid, s: "0" }. */
export function findIssuanceSeal(events: readonly KelInput[], credSaid: string, opts: { issuer?: string } = {}) {
  return findCredentialSeal(events, credSaid, "0", opts);
}

function verKeyRaw(qb64: string): Uint8Array {
  if (!/^[DB][A-Za-z0-9_-]{43}$/.test(qb64)) throw new Error(`not an Ed25519 verification key: ${qb64}`);
  return fromBase64url("A" + qb64.slice(1)).slice(1);
}

export interface SealEventChecks {
  /** SAID of the event recomputes over `raw`. */
  saidRecomputed: boolean;
  /** UTF-8 length of `raw` equals the size in the version string. */
  sizeMatchesVersion: boolean;
  /** The event's `p` equals the SAID of the event at sn - 1 in the same KEL. */
  priorLinked: boolean;
  /** Enough controller signatures verify against the keys of the latest establishment event. */
  signatureValid: boolean;
  signingKeys: string[];
  signatures: { qb64: string; index: number; valid: boolean }[];
  establishmentEvent: { sn: number; said: string } | null;
}

/**
 * Re-checks the event that carries a seal against the rest of its KEL: SAID, declared size, link to
 * the prior event, and the controller signatures under the keys of the latest establishment event
 * at or before it. Signatures need the KERIA attachment (`atc`); without it signatureValid is false.
 */
export function checkSealEvent(hit: SealHit, events: readonly KelInput[]): SealEventChecks {
  const keds = events.map(kedOf).filter((k) => k && k.i === hit.ked.i);
  const bytes = new TextEncoder().encode(hit.raw);
  let saidRecomputed = false;
  try {
    saidRecomputed = computeSaid(JSON.parse(hit.raw)) === hit.ked.d;
  } catch {
    saidRecomputed = false;
  }
  const declared = typeof hit.ked.v === "string" ? parseInt(hit.ked.v.slice(10, 16), 16) : NaN;
  const prior = keds.find((k) => snOf(k) === hit.sn - 1);
  const priorLinked = hit.sn === 0 ? true : !!prior && prior.d === hit.ked.p;

  const est = keds
    .filter((k) => ESTABLISHMENT.has(k.t) && snOf(k) <= hit.sn)
    .sort((a, b) => snOf(b) - snOf(a))[0];
  const keys: string[] = Array.isArray(est?.k) ? est.k : [];
  let signatures: SealEventChecks["signatures"] = [];
  if (hit.atc && keys.length) {
    try {
      signatures = controllerSigs(hit.atc).map((s) => {
        let valid = false;
        try {
          valid = s.index < keys.length && ed25519.verify(s.raw, bytes, verKeyRaw(keys[s.index]));
        } catch {
          valid = false;
        }
        return { qb64: s.qb64, index: s.index, valid };
      });
    } catch {
      signatures = [];
    }
  }
  const threshold = typeof est?.kt === "string" && /^[0-9a-f]+$/.test(est.kt) ? parseInt(est.kt, 16) : keys.length;
  const validCount = signatures.filter((s) => s.valid).length;
  const signatureValid = signatures.length > 0 && signatures.every((s) => s.valid) && validCount >= Math.max(threshold, 1);

  return {
    saidRecomputed,
    sizeMatchesVersion: bytes.length === declared,
    priorLinked,
    signatureValid,
    signingKeys: keys,
    signatures,
    establishmentEvent: est ? { sn: snOf(est), said: est.d } : null,
  };
}
