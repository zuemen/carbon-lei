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
//   - witness receipts: each of those events carries Ed25519 signatures over its exact bytes by at least
//     `bt` distinct witnesses of the witness list in force at that event (`b` of the inception, changed by
//     a rotation's `br` cuts and `ba` adds), as indexed witness signatures (-B##, index i = i-th witness)
//     or non-transferable receipt couples (-C##); a signature by a key not in the list is not counted;
//   - the registry inception (`vcp`) names the issuer and is anchored in the same KEL.
// Supported key state: one key with threshold "1" (the demo AIDs). Other thresholds, delegated AIDs
// (dip, drt) and two different events at one sequence number fail closed. Witnesses are not queried:
// the receipts are those in the presented evidence.
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

/** A non-transferable receipt couple (-C group): the receiptor's AID, which is its Ed25519 key, and its signature. */
export interface ReceiptCouple {
  verfer: string;
  raw: Uint8Array;
}

/** The signatures attached to a KERI event. Indexed witness signatures refer to the event's witness list. */
export interface EventAttachments {
  controller: IndexedSig[];
  witness: IndexedSig[];
  receipts: ReceiptCouple[];
}

/** Raw 64 bytes of an Ed25519 signature in qb64 (two pad characters stand in for the code). */
const sigRaw = (qb64: string, codeLen: number) => fromBase64url("AA" + qb64.slice(codeLen)).slice(2);

/** One qb64 primitive of `size` characters whose code matches `code`; returns the position after it. */
function primitive(atc: string, i: number, code: RegExp, size: number, what: string): number {
  const q = atc.slice(i, i + size);
  if (q.length !== size || !code.test(q) || !/^[A-Za-z0-9_-]*$/.test(q)) throw new Error(`malformed ${what} in attachment`);
  return i + size;
}

/** Indexed Ed25519 signature: code A/B with a one-character index (88 chars), or 2A/2B with a two-character index (92 chars). */
function indexedSig(atc: string, i: number): [IndexedSig, number] {
  if (atc[i] === "A" || atc[i] === "B") {
    const qb64 = atc.slice(i, i + 88);
    if (!/^[AB][A-Za-z0-9_-]{87}$/.test(qb64)) throw new Error("malformed indexed signature in attachment");
    return [{ qb64, index: b64Int(qb64[1]), raw: sigRaw(qb64, 2) }, i + 88];
  }
  if (atc.startsWith("2A", i) || atc.startsWith("2B", i)) {
    const qb64 = atc.slice(i, i + 92);
    if (!/^2[AB][A-Za-z0-9_-]{90}$/.test(qb64)) throw new Error("malformed indexed signature in attachment");
    return [{ qb64, index: b64Int(qb64.slice(2, 4)), raw: sigRaw(qb64, 6) }, i + 92];
  }
  throw new Error(`unsupported indexed signature ${atc.slice(i, i + 2)}`);
}

/** Counter `-X##`: its code letter and count. */
function counter(atc: string, i: number): [string, number] {
  const c = atc.slice(i, i + 4);
  if (c.length !== 4 || c[0] !== "-") throw new Error(`unexpected attachment text ${atc.slice(i, i + 8)}...`);
  return [c[1], b64Int(c.slice(2))];
}

/** A nested `-A##` group (signatures of a transferable receiptor, not of the event's controller): skipped. */
function skipSigGroup(atc: string, i: number): number {
  const [code, n] = counter(atc, i);
  if (code !== "A") throw new Error("malformed signature group in attachment");
  i += 4;
  for (let k = 0; k < n; k++) i = indexedSig(atc, i)[1];
  return i;
}

const SEQNER = /^0A/;
const DATER = /^1AAG/;
const PREFIX = /^[A-Za-z]/;

/** Reads the counted groups in atc[i, end) into `out`. */
function readGroups(atc: string, i: number, end: number, out: EventAttachments): void {
  const nested = (n: number) => {
    if (i + n * 4 > end) throw new Error("attachment group longer than the attachment");
    readGroups(atc, i, i + n * 4, out);
    i += n * 4;
  };
  while (i < end) {
    if (atc.startsWith("-0V", i)) {
      const n = b64Int(atc.slice(i + 3, i + 8));
      i += 8;
      nested(n);
      continue;
    }
    if (atc.startsWith("-_AAA", i)) {
      i = primitive(atc, i, /^-_AAA/, 8, "version code");
      continue;
    }
    const [code, n] = counter(atc, i);
    i += 4;
    switch (code) {
      case "V": // attachment group, counted in quadlets
        nested(n);
        break;
      case "A": // controller indexed signatures
      case "B": // witness indexed signatures
        for (let k = 0; k < n; k++) {
          const [sig, j] = indexedSig(atc, i);
          (code === "A" ? out.controller : out.witness).push(sig);
          i = j;
        }
        break;
      case "C": // non-transferable receipt couples: the receiptor's key, an Ed25519 signature
        for (let k = 0; k < n; k++) {
          const verfer = atc.slice(i, i + 44);
          i = primitive(atc, i, /^[BD]/, 44, "receipt couple key");
          const cigar = atc.slice(i, i + 88);
          i = primitive(atc, i, /^0B/, 88, "receipt couple signature");
          out.receipts.push({ verfer, raw: sigRaw(cigar, 2) });
        }
        break;
      case "D": // receipts by transferable AIDs: prefix, sn, digest, signature (not witness receipts)
        for (let k = 0; k < n; k++) {
          i = primitive(atc, i, PREFIX, 44, "receipt prefix");
          i = primitive(atc, i, SEQNER, 24, "sequence number");
          i = primitive(atc, i, PREFIX, 44, "digest");
          i = indexedSig(atc, i)[1];
        }
        break;
      case "E": // first-seen replay couples: sn, date-time
        for (let k = 0; k < n; k++) i = primitive(atc, primitive(atc, i, SEQNER, 24, "sequence number"), DATER, 36, "date-time");
        break;
      case "F": // signature groups of transferable AIDs: prefix, sn, digest, -A## group
        for (let k = 0; k < n; k++) {
          i = primitive(atc, i, PREFIX, 44, "signer prefix");
          i = primitive(atc, i, SEQNER, 24, "sequence number");
          i = primitive(atc, i, PREFIX, 44, "digest");
          i = skipSigGroup(atc, i);
        }
        break;
      case "G": // seal source couples: sn, digest
        for (let k = 0; k < n; k++) i = primitive(atc, primitive(atc, i, SEQNER, 24, "sequence number"), PREFIX, 44, "digest");
        break;
      case "H": // last-establishment signature groups: prefix, -A## group
        for (let k = 0; k < n; k++) i = skipSigGroup(atc, primitive(atc, i, PREFIX, 44, "signer prefix"));
        break;
      case "I": // seal source triples: prefix, sn, digest
        for (let k = 0; k < n; k++) {
          i = primitive(atc, i, PREFIX, 44, "seal prefix");
          i = primitive(atc, i, SEQNER, 24, "sequence number");
          i = primitive(atc, i, PREFIX, 44, "digest");
        }
        break;
      case "L": // pathed material, counted in quadlets
        i += n * 4;
        break;
      default:
        throw new Error(`unsupported attachment group -${code}`);
    }
  }
  if (i !== end) throw new Error("attachment group does not end where its count says");
}

/**
 * Signatures attached to a KERI event, as KERIA exports them: an optional attachment group
 * (-V## / -0V#####) holding controller indexed signatures (-A##), witness indexed signatures (-B##),
 * non-transferable receipt couples (-C##), and groups that carry no signature by the event's
 * controller or witnesses (first-seen couples -E##, seal sources, receipts by transferable AIDs),
 * which are skipped. Anything else throws.
 */
export function parseAttachments(atc: string): EventAttachments {
  const text = atc.replace(/\s+$/, "");
  const out: EventAttachments = { controller: [], witness: [], receipts: [] };
  readGroups(text, 0, text.length, out);
  return out;
}

/**
 * Controller indexed Ed25519 signatures from a KEL record attachment: skips an optional
 * attachment-group counter (-V## / -0V#####) without checking its count, then reads -A## followed by
 * ## signatures (88 characters each; code A = both lists, code B = current list only; index in the 2nd
 * char). Lenient on purpose (the watcher reads live KERIA attachments with it); witness receipts are
 * read with the strict parseAttachments.
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

/** Witness list (`b`) and witness threshold (`bt`, the "toad") in force at an event. */
export interface WitnessState {
  wits: string[];
  toad: number;
}

const isList = (x: unknown): x is string[] => Array.isArray(x) && x.every((w) => typeof w === "string");

/**
 * The witness state set by an establishment event: an inception names its witnesses (`b`); a rotation
 * removes `br` from the current list, then appends `ba` (KERI keeps the order, so index i is the i-th
 * witness of the resulting list). Returns the reason when the configuration is not valid.
 */
export function witnessState(ked: Record<string, any>, current?: WitnessState): WitnessState | string {
  let wits: string[];
  if (ked.t === "icp") {
    if (!isList(ked.b)) return "the witness list is not readable";
    wits = ked.b;
  } else if (ked.t === "rot") {
    if (!current || !isList(ked.br) || !isList(ked.ba)) return "the rotation's witness changes are not readable";
    if (new Set(ked.br).size !== ked.br.length || ked.br.some((w) => !current.wits.includes(w))) {
      return "the rotation removes a witness that is not in the witness list";
    }
    const kept = current.wits.filter((w) => !ked.br.includes(w));
    if (ked.ba.some((w) => kept.includes(w))) return "the rotation adds a witness that is already in the witness list";
    wits = [...kept, ...ked.ba];
  } else {
    return `event type ${ked.t} does not set witnesses`;
  }
  if (new Set(wits).size !== wits.length) return "the witness list names a witness twice";
  const toad = typeof ked.bt === "string" && /^(0|[1-9a-f][0-9a-f]*)$/.test(ked.bt) ? parseInt(ked.bt, 16) : NaN;
  if (!Number.isInteger(toad) || toad > wits.length || (wits.length > 0 && toad < 1)) {
    return `the witness threshold ${JSON.stringify(ked.bt)} does not fit ${wits.length} witnesses`;
  }
  return { wits, toad };
}

/** Ed25519 signature by a witness: a non-transferable AID ('B'), which is its own verification key. */
function witnessSigned(wit: string, sig: Uint8Array, bytes: Uint8Array): boolean {
  if (!/^B[A-Za-z0-9_-]{43}$/.test(wit)) return false;
  try {
    return ed25519.verify(sig, bytes, decodeVerKey(wit));
  } catch {
    return false;
  }
}

/**
 * The witnesses in `state` whose signature over the exact event bytes is attached to one of the copies:
 * indexed witness signatures (index i = the i-th witness of the list) and non-transferable receipt
 * couples whose AID is in the list. Each witness counts once; a signature by any other key is not counted.
 * Stops verifying once `enough` witnesses are found.
 */
export function witnessReceipts(
  copies: readonly KelMessage[],
  state: WitnessState,
  enough = Infinity,
): { verified: string[]; present: number; unreadable: boolean } {
  const ok = new Set<string>();
  let present = 0;
  let unreadable = false;
  const check = (w: string | undefined, sig: Uint8Array, bytes: Uint8Array) => {
    if (w !== undefined && ok.size < enough && !ok.has(w) && witnessSigned(w, sig, bytes)) ok.add(w);
  };
  for (const c of copies) {
    if (!c.atc) continue;
    let att: EventAttachments;
    try {
      att = parseAttachments(c.atc);
    } catch {
      unreadable = true;
      continue;
    }
    present += att.witness.length + att.receipts.length;
    const bytes = utf8(c.raw);
    for (const s of att.witness) check(state.wits[s.index], s.raw, bytes);
    for (const r of att.receipts) check(state.wits.includes(r.verfer) ? r.verfer : undefined, r.raw, bytes);
  }
  return { verified: [...ok], present, unreadable };
}

/**
 * Whether at least the threshold (`bt`) of the witnesses signed the event: `reason` is "" when they did.
 * `verified` counts the witnesses whose signature verifies (all of them unless `all` is false, in which
 * case verification stops at the threshold).
 */
export function witnessThreshold(copies: readonly KelMessage[], state: WitnessState, all = true): { verified: number; reason: string } {
  if (state.toad === 0) return { verified: 0, reason: "" };
  const r = witnessReceipts(copies, state, all ? Infinity : state.toad);
  const verified = r.verified.length;
  if (verified >= state.toad) return { verified, reason: "" };
  if (!r.present) return { verified, reason: r.unreadable ? "its attachment cannot be read, so no witness receipt is counted" : "no witness receipts in the evidence" };
  return { verified, reason: `${verified} of ${state.wits.length} witness signatures verify, the threshold is ${state.toad}` };
}

export type KelResult = { ok: true; keys: string[] } | { ok: false; reason: string };

/** Key state at an event: signing keys, witness state and the number of rotations since inception. */
export type KeyState = { ok: true; keys: string[]; witnesses: WitnessState; rotations: number } | { ok: false; reason: string };

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
  const st = keyStateAt(msgs, aid, upTo);
  return st.ok ? { ok: true, keys: st.keys } : st;
}

/**
 * verifyKel, also returning the witness state in force at `upTo` and the rotations walked. `role` names
 * the controller in the reasons ("issuer" for check 7, "auditor" for check 6).
 */
export function keyStateAt(msgs: readonly KelMessage[], aid: string, upTo: number, role = "issuer"): KeyState {
  const err = (reason: string): KeyState => ({ ok: false, reason });
  const bySn = kelOf(msgs, aid);
  if (!bySn.size) return err(`the ${role}'s KEL is not in the evidence`);
  if (bySn.has(NaN) || !Number.isInteger(upTo) || upTo < 0) return err(`the ${role}'s KEL has an event with an invalid sequence number`);
  let keys: string[] = [];
  let next: string[] = [];
  let establishmentOnly = false;
  let wit: WitnessState | undefined;
  let prior: KelMessage | undefined;
  let rotations = 0;
  for (let sn = 0; sn <= upTo; sn++) {
    const copies = bySn.get(sn);
    if (!copies) return err(sn === 0 ? `the ${role}'s inception event is not in the evidence` : `the ${role}'s KEL has no event #${sn}`);
    if (new Set(copies.map((c) => c.raw)).size > 1) return err(`the ${role}'s KEL has two different events at #${sn}`);
    const m = copies[0];
    const k = m.ked;
    const at = `event #${sn} of the ${role}'s KEL`;
    if (!sizeOk(m)) return err(`${at}: size differs from its version string`);
    if (sn === 0) {
      if (k.t === "dip") return err(`the ${role} is a delegated identifier, which is not supported`);
      if (k.t !== "icp") return err(`the ${role}'s KEL does not start with an inception event`);
      if (!selfAddressing(k)) return err(`the ${role}'s inception event is not self-addressing (its SAID is not the ${role}'s AID)`);
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
      const w = witnessState(k, wit);
      if (typeof w === "string") return err(`${at}: ${w}`);
      wit = w;
      keys = k.k;
      next = Array.isArray(k.n) ? k.n : [];
      if (k.t === "icp") establishmentOnly = Array.isArray(k.c) && k.c.includes("EO");
      else rotations++;
    } else if (k.t === "ixn") {
      if (establishmentOnly) return err(`${at}: interaction event in an establishment-only KEL`);
    } else {
      return err(`${at}: event type ${k.t} is not supported`);
    }
    if (!copies.some((c) => signedBy(c, keys[0]))) return err(`${at}: the controller signature does not verify with the ${role}'s key`);
    // Witness receipts: at least `bt` of the witnesses in force at this event signed its exact bytes.
    const receipts = witnessThreshold(copies, wit as WitnessState, false);
    if (receipts.reason) return err(`${at}: ${receipts.reason}`);
    prior = m;
  }
  return { ok: true, keys, witnesses: wit as WitnessState, rotations };
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
