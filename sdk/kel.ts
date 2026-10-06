// Issuer signatures behind check 7: a vLEI credential is issued when its issuer's KEL anchors the
// credential's TEL `iss` event, so "the issuer issued it" means "the issuer signed that KEL event".
// Pure functions over CESR messages (sdk/vlei.ts parseCesr); runs in the browser and in Node.
//
// verifyIssuance(), from the stream KERIA exports with a credential (credentials().get(said, true)):
//   - the TEL `iss` event of the credential: its SAID recomputes and it is in the credential's registry;
//   - the issuer's KEL event carrying the seal { i: credSAID, s: "0", d: <iss SAID> };
//   - the issuer's KEL from inception up to that event (verifyKel): the inception is self-addressing
//     (its SAID, with `d` and `i` blanked together, is the AID), every event's SAID and size recompute,
//     `s` counts up from 0, `p` links to the prior event, and each event carries an Ed25519 controller
//     signature over its exact bytes that verifies with the key of the latest establishment event;
//     a rotation must reveal the key committed to by the prior next-key digest and be signed by it;
//   - the registry inception (`vcp`) names the issuer and is anchored in the same KEL.
// Supported key state: one key with threshold "1" (the demo AIDs). Other thresholds, delegated AIDs
// (dip, drt) and two different events at one sequence number fail closed. Witness receipts are not checked.
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { base64url, fromBase64url, utf8 } from "./encoding.ts";
import { SAID_DUMMY, computeSaid } from "./said.ts";

/** A KERI or ACDC message from a CESR stream, with the attachment text that follows it. */
export interface KelMessage {
  raw: string;
  ked: Record<string, any>;
  atc?: string;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const KEL_TYPES = new Set(["icp", "rot", "ixn", "dip", "drt"]);

/** CESR qb64 with a one-character code over 32 bytes (Ed25519 verification keys 'D' / 'B'). */
export function decodeVerKey(qb64: string): Uint8Array {
  if (!/^[DB][A-Za-z0-9_-]{43}$/.test(qb64)) throw new Error("not an Ed25519 key");
  return fromBase64url("A" + qb64.slice(1)).slice(1);
}

/** CESR indexed Ed25519 signature: two-character code ('A' + index) over 64 bytes. */
export function decodeIndexedSig(qb64: string): Uint8Array {
  if (!/^A[A-Za-z0-9_-]{87}$/.test(qb64)) throw new Error("not an indexed Ed25519 signature");
  return fromBase64url("AA" + qb64.slice(2)).slice(2);
}

function b64Int(s: string): number {
  let n = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`bad base64 char ${ch}`);
    n = n * 64 + v;
  }
  return n;
}

export interface IndexedSig {
  qb64: string;
  index: number;
  raw: Uint8Array;
}

/**
 * Controller indexed Ed25519 signatures from a KEL record attachment: skips an optional
 * attachment-group counter (-V## / -0V#####), then reads -A## followed by ## signatures
 * (88 characters each; code A = both lists, code B = current list only; index in the 2nd char).
 */
export function controllerSigs(atc: string): IndexedSig[] {
  let i = 0;
  if (atc.startsWith("-V")) i = 4;
  else if (atc.startsWith("-0V")) i = 8;
  if (atc.slice(i, i + 2) !== "-A") throw new Error(`no controller signatures in attachment: ${atc.slice(0, 16)}...`);
  const count = b64Int(atc.slice(i + 2, i + 4));
  i += 4;
  const out: IndexedSig[] = [];
  for (let k = 0; k < count; k++) {
    const qb64 = atc.slice(i, i + 88);
    if (qb64.length !== 88 || (qb64[0] !== "A" && qb64[0] !== "B")) throw new Error(`unsupported indexed signature ${qb64.slice(0, 2)}`);
    out.push({ qb64, index: b64Int(qb64[1]), raw: fromBase64url("AA" + qb64.slice(2)).slice(2) });
    i += 88;
  }
  return out;
}

/** KERI next-key commitment: Blake3-256 over the key's qb64 text, as qb64 (code 'E'). */
export function nextKeyDigest(keyQb64: string): string {
  return "E" + base64url(new Uint8Array([0, ...blake3(utf8(keyQb64), { dkLen: 32 })])).slice(1);
}

/** Self-addressing event (icp, vcp): `d` and the prefix `i` hold the SAID and are blanked together. */
export function selfAddressing(ked: Record<string, any>): boolean {
  return typeof ked.d === "string" && ked.d === ked.i && computeSaid({ ...ked, i: SAID_DUMMY }) === ked.d;
}

const snOf = (ked: Record<string, any>) => (typeof ked.s === "string" && /^(0|[1-9a-f][0-9a-f]*)$/.test(ked.s) ? parseInt(ked.s, 16) : NaN);
const sizeOk = (m: KelMessage) => typeof m.ked.v === "string" && parseInt(m.ked.v.slice(10, 16), 16) === utf8(m.raw).length;
const hasSeal = (m: KelMessage, seal: { i: string; s: string; d: string }) =>
  Array.isArray(m.ked.a) && m.ked.a.some((x: any) => x && x.i === seal.i && x.s === seal.s && x.d === seal.d);

/** True if one of the attachment's controller signatures with index 0 verifies over the event bytes. */
function signedBy(m: KelMessage, key: string): boolean {
  if (!m.atc) return false;
  try {
    const pub = decodeVerKey(key);
    const bytes = utf8(m.raw);
    return controllerSigs(m.atc).some((s) => s.index === 0 && ed25519.verify(s.raw, bytes, pub));
  } catch {
    return false;
  }
}

export type KelResult = { ok: true; keys: string[] } | { ok: false; reason: string };

/** The KEL events of `aid` in the messages, by sequence number (an event repeated in the stream is kept once per copy). */
function kelOf(msgs: readonly KelMessage[], aid: string): Map<number, KelMessage[]> {
  const bySn = new Map<number, KelMessage[]>();
  for (const m of msgs) {
    if (m.ked.i !== aid || !KEL_TYPES.has(m.ked.t)) continue;
    const sn = snOf(m.ked);
    bySn.set(sn, [...(bySn.get(sn) ?? []), m]);
  }
  return bySn;
}

/**
 * Verifies `aid`'s KEL in the messages from inception through event `upTo` and returns the signing keys
 * at that event, or the reason the key state cannot be established. Fails closed on anything outside the
 * supported key state (one key, threshold "1"; no delegation).
 */
export function verifyKel(msgs: readonly KelMessage[], aid: string, upTo: number): KelResult {
  const err = (reason: string): KelResult => ({ ok: false, reason });
  const bySn = kelOf(msgs, aid);
  if (!bySn.size) return err("the issuer's KEL is not in the evidence");
  if (bySn.has(NaN) || !Number.isInteger(upTo) || upTo < 0) return err("the issuer's KEL has an event with an invalid sequence number");
  let keys: string[] = [];
  let next: string[] = [];
  let establishmentOnly = false;
  let prior: KelMessage | undefined;
  for (let sn = 0; sn <= upTo; sn++) {
    const copies = bySn.get(sn);
    if (!copies) return err(sn === 0 ? "the issuer's inception event is not in the evidence" : `the issuer's KEL has no event #${sn}`);
    if (new Set(copies.map((c) => c.raw)).size > 1) return err(`the issuer's KEL has two different events at #${sn}`);
    const m = copies[0];
    const k = m.ked;
    const at = `event #${sn} of the issuer's KEL`;
    if (!sizeOk(m)) return err(`${at}: size differs from its version string`);
    if (sn === 0) {
      if (k.t === "dip") return err("the issuer is a delegated identifier, which is not supported");
      if (k.t !== "icp") return err("the issuer's KEL does not start with an inception event");
      if (!selfAddressing(k)) return err("the issuer's inception event is not self-addressing (its SAID is not the issuer's AID)");
    } else {
      if (computeSaid(k) !== k.d) return err(`${at}: SAID does not match its content`);
      if (!prior || k.p !== prior.ked.d) return err(`${at} does not link to the prior event`);
    }
    if (k.t === "icp" || k.t === "rot") {
      if (sn > 0 && k.t === "icp") return err(`${at} is a second inception event`);
      if (k.kt !== "1" || !Array.isArray(k.k) || k.k.length !== 1) {
        return err(`${at}: only one signing key with threshold "1" is supported (kt ${JSON.stringify(k.kt)})`);
      }
      // Pre-rotation: the new key must be the one the prior establishment event committed to.
      if (k.t === "rot" && (next.length !== 1 || nextKeyDigest(k.k[0]) !== next[0])) {
        return err(`${at}: the rotation's key is not the one committed to by the prior next-key digest`);
      }
      keys = k.k;
      next = Array.isArray(k.n) ? k.n : [];
      if (k.t === "icp") establishmentOnly = Array.isArray(k.c) && k.c.includes("EO");
    } else if (k.t === "ixn") {
      if (establishmentOnly) return err(`${at}: interaction event in an establishment-only KEL`);
    } else {
      return err(`${at}: event type ${k.t} is not supported`);
    }
    if (!copies.some((c) => signedBy(c, keys[0]))) return err(`${at}: the controller signature does not verify with the issuer's key`);
    prior = m;
  }
  return { ok: true, keys };
}

/** Lowest-numbered event of `aid`'s KEL carrying `seal`. */
function anchorOf(msgs: readonly KelMessage[], aid: string, seal: { i: string; s: string; d: string }): KelMessage | undefined {
  let best: KelMessage | undefined;
  for (const m of msgs) {
    if (m.ked.i !== aid || !KEL_TYPES.has(m.ked.t) || !hasSeal(m, seal)) continue;
    if (!best || snOf(m.ked) < snOf(best.ked)) best = m;
  }
  return best;
}

/**
 * Checks that the credential's issuer signed its issuance: returns "" when it did, else the reason.
 * `msgs` is the credential's CESR stream; `acdc` the credential (its `i` is the issuer).
 */
export function verifyIssuance(msgs: readonly KelMessage[], acdc: Record<string, any>): string {
  const issuer: string = acdc.i;
  const iss = msgs.find((m) => m.ked.t === "iss" && m.ked.i === acdc.d && m.ked.s === "0");
  if (!iss) return "no TEL issuance event to check against the issuer's KEL";
  if (!sizeOk(iss) || computeSaid(iss.ked) !== iss.ked.d) return "TEL issuance event: SAID does not match its content";
  if (iss.ked.ri !== acdc.ri) return "TEL issuance event is in another registry than the credential";
  if (!kelOf(msgs, issuer).size) return "the issuer's KEL is not in the evidence";
  const anchor = anchorOf(msgs, issuer, { i: acdc.d, s: "0", d: iss.ked.d });
  if (!anchor) return "the issuer's KEL does not anchor this issuance";
  const vcp = msgs.find((m) => m.ked.t === "vcp" && m.ked.i === acdc.ri);
  const vcpAnchor = vcp && anchorOf(msgs, issuer, { i: vcp.ked.i, s: "0", d: vcp.ked.d });
  // The issuance first: whoever signed its anchor decides; the registry is checked against the same KEL.
  const kel = verifyKel(msgs, issuer, Math.max(snOf(anchor.ked), vcpAnchor ? snOf(vcpAnchor.ked) : 0));
  if (!kel.ok) return kel.reason;
  if (!vcp || vcp.ked.ii !== issuer || !sizeOk(vcp) || !selfAddressing(vcp.ked)) return "the credential's registry was not incepted by the issuer";
  if (!vcpAnchor) return "the registry inception is not anchored in the issuer's KEL";
  return "";
}
