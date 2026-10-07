// Checks 6 and 7 on vLEI evidence exported from a KERI run. Pure functions: runs in the browser
// (hosted page) and in Node (CLI, onboarding). Uses only @noble and the SDK's SAID code.
//
// Check 6 (anchor): the auditor's KERI interaction event that anchors the credential SAID.
//   - the event's SAID recomputes; it is an `ixn` by the auditor's AID at sequence number kelSeq (`s` in
//     KERI's form: lowercase hex, no leading zeros); its seals contain { d: credSAID };
//   - its Ed25519 signature verifies over the exact event bytes;
//   - the signing key is the auditor's key in force at kelSeq, walked by sdk/kel.ts keyStateAt from the
//     self-addressing inception through `kel` (the auditor's events #0 to #kelSeq-1: pre-rotation and
//     witness changes enforced, each event with its witness threshold). `kel` is required when kelSeq > 1;
//     without it check 6 fails, because a rotation before the anchor cannot be ruled out. At kelSeq 1
//     nothing comes between the inception and the anchor, and the inception event `establishmentRaw` is
//     enough;
//   - the anchor event under KERI's state rules (as keripy's Kever.update): its `p` is the SAID of event
//     #kelSeq-1, the KEL is not establishment-only, a next key is committed (not abandoned), and no other
//     event of the auditor in the evidence is at kelSeq (duplicity);
//   - witness receipts: at least `bt` of the witnesses in force at kelSeq signed the anchor event's exact
//     bytes (from `kelAttachment`), and each earlier event (from `kel`, or the inception's
//     `establishmentAttachment` at kelSeq 1).
//   Malformed evidence fails with a reason and never throws. Limits: witnesses and watchers are not
//   queried, so a rotation after kelSeq that the evidence leaves out is not seen, and for an AID without
//   witnesses (bt 0) a KEL cut before a rotation, with an ixn signed by the old key at that sequence
//   number, passes.
// Check 7 (authority): the credential chain QVI → LE (body) → ECR (auditor), plus the NAB's
//   accreditation of the body, from exported CESR streams: every ACDC SAID recomputes, schemas,
//   issuers, issuees, edges and LEIs line up, the QVI was issued by the configured root, the
//   accreditation has the CBAM accreditation schema (SCHEMA.ACCREDITATION, not the schema the evidence
//   names), its scope covers the CN code and its `validUntil` (required) covers the registration time,
//   each issuance has a TEL `iss` event, each issuer signed the KEL event anchoring its issuance
//   (sdk/kel.ts: Ed25519 over the event bytes, key state walked from the issuer's self-addressing
//   inception, so the QVI's anchor must be signed with the pinned root's key; every event walked also
//   carries the witness threshold of receipts), and the on-chain allowlist hashes equal the credential
//   SAID hashes.
//   Authority is judged at registration, as in check 4. From the allowlist (read at the verified block,
//   whose auditor and accreditation fields never change except `revokedAt`, which is set once): the
//   auditor was added at or before the registration time and not revoked before it, and the
//   accreditation (`accreditedUntil`) had not expired. A TEL revocation in the evidence counts only when
//   its issuer anchored it (sdk/kel.ts anchoredRevocation); it fails check 7 when its time (`dt`, written
//   by the issuer) is before the registration time, or when there is no registration time. An unsigned or
//   unanchored revocation is ignored. The evidence is chosen by the supplier, who can leave a revocation
//   out; the allowlist is not. Every time is read as ISO 8601 with a time zone (`Z` or an offset); a time
//   without one fails, never read in the machine's time zone.
import { ed25519 } from "@noble/curves/ed25519.js";
import { hashString } from "./commitment.ts";
import { isoSeconds, type Hex } from "./credential.ts";
import { utf8 } from "./encoding.ts";
import {
  anchoredRevocation,
  controllerSigs,
  decodeIndexedSig,
  decodeVerKey,
  keyStateAt,
  snOf,
  verifyIssuance,
  witnessState,
  witnessThreshold,
} from "./kel.ts";
import { computeSaid } from "./said.ts";

/** Moved to credential.ts (the credential core's times use it too); re-exported for existing callers. */
export { isoSeconds };

export { decodeIndexedSig, decodeVerKey } from "./kel.ts";

export const SCHEMA = {
  QVI: "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
  LE: "ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY",
  ECR: "EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw",
  /** CBAM verifier accreditation (verifier/schemas/cbam-verifier-accreditation.json). */
  ACCREDITATION: "EIyPVSpzpiV8PXfxjAhPdESlnvpUGZtBLeZ1jaoVRt8G",
} as const;
export const AUDITOR_ROLE = "CBAM Lead Auditor";
/** Root of trust of the demo: the simulated GLEIF root (GEDA) of the local KERI stack (fixtures/vlei.json).
 * A production verifier pins GLEIF's root AID here instead. */
export const DEMO_TRUST_ANCHOR = "EGR6VINAm0lwO9RuEFJCQFtJ3Kn3CCB3YT58ZayE_JBB";

export interface Message {
  raw: string;
  ked: Record<string, any>;
  /** Attachment text after the message (signatures, seal references), as transmitted. */
  atc?: string;
}

/** Splits a CESR text stream into its JSON messages (KERI events and ACDCs), each with the attachments that follow it. */
export function parseCesr(stream: string): Message[] {
  const out: Message[] = [];
  let i = 0;
  let end = 0;
  while (true) {
    const j = stream.indexOf('{"v":"', i);
    if (j < 0) break;
    const vs = stream.slice(j + 6, j + 23);
    const m = /^(KERI|ACDC)10JSON([0-9a-f]{6})_$/.exec(vs);
    if (!m) {
      i = j + 1;
      continue;
    }
    if (out.length) out[out.length - 1].atc = stream.slice(end, j);
    const size = parseInt(m[2], 16);
    const raw = stream.slice(j, j + size);
    out.push({ raw, ked: JSON.parse(raw) });
    i = end = j + size;
  }
  if (out.length) out[out.length - 1].atc = stream.slice(end);
  return out;
}

const saidOk = (m: Message) => computeSaid(m.ked) === m.ked.d;

export interface CheckOutcome {
  ok: boolean;
  code: string;
  detail: string;
}

const fail = (code: string, detail: string): CheckOutcome => ({ ok: false, code, detail });

// ---------------------------------------------------------------------- check 6

export interface AnchorEvidence {
  credSAID: string;
  auditor: string;
  kelSeq: number;
  event: { raw: string };
  signatures: { qb64: string; index: number }[];
  signingKeys: { qb64: string }[];
  /** The auditor's inception event (raw JSON), binding the signing key to the AID. */
  establishmentRaw?: string;
  /** CESR attachment of the anchor event as exported: controller and witness signatures. */
  kelAttachment?: string | null;
  /** CESR attachment of the auditor's inception event: its witness receipts. */
  establishmentAttachment?: string;
  /** The auditor's KEL events #0 to #kelSeq-1, each with its attachment; check 6 then walks rotations. */
  kel?: { raw: string; atc?: string }[];
}

/**
 * Check 6 evidence from a KEL stream as `kli export` writes it: event #kelSeq (the anchor) with its
 * attachment and controller signature, and the auditor's events #0 to #kelSeq-1 as `kel`. Throws when the
 * stream has no event #kelSeq or two different ones (duplicity), so a fork is never dropped here.
 */
export function anchorEvidenceFromKel(stream: string, auditor: string, kelSeq: number, credSAID: string): AnchorEvidence {
  const msgs = parseCesr(stream).filter((m) => m.ked.i === auditor);
  const atSn = msgs.filter((m) => m.ked.s === kelSeq.toString(16));
  if (!atSn.length) throw new Error(`the KEL has no event #${kelSeq}`);
  if (new Set(atSn.map((m) => m.raw)).size > 1) throw new Error(`the KEL has two different events at #${kelSeq}`);
  const anchor = atSn[0];
  const sig = controllerSigs(anchor.atc ?? "").find((s) => s.index === 0);
  return {
    credSAID,
    auditor,
    kelSeq,
    event: { raw: anchor.raw },
    signatures: sig ? [{ qb64: sig.qb64, index: 0 }] : [],
    signingKeys: [],
    kelAttachment: anchor.atc,
    kel: auditorKel(msgs, auditor, kelSeq),
  };
}

/**
 * The auditor's events #0 to #kelSeq-1 for `kel`, from exported messages (several exports may hold the same
 * event): sorted by sequence number, each distinct message (event and attachment) once. Events are taken
 * as exported; nothing in them is changed.
 */
export function auditorKel(msgs: readonly { raw: string; atc?: string }[], auditor: string, kelSeq: number): { raw: string; atc?: string }[] {
  const seen = new Set<string>();
  const out: { raw: string; atc?: string; sn: number }[] = [];
  for (const m of msgs) {
    const ked = JSON.parse(m.raw);
    const sn = snOf(ked);
    // An event with a malformed `s` is kept (last), so that check 6 rejects it rather than not seeing it.
    if (ked.i !== auditor || !KEL_EVENT.has(ked.t) || sn >= kelSeq) continue;
    const key = JSON.stringify([m.raw, m.atc ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m.raw, ...(m.atc !== undefined ? { atc: m.atc } : {}), sn });
  }
  const order = (x: number) => (Number.isNaN(x) ? Infinity : x);
  return out.sort((a, b) => order(a.sn) - order(b.sn)).map(({ sn: _sn, ...m }) => m);
}

const KEL_EVENT = new Set(["icp", "rot", "ixn", "dip", "drt"]);

/** `kel` as messages: undefined when it is not a list of { raw, atc? } with string fields, null when a raw is not a JSON object. */
function kelMessages(kel: unknown): Message[] | undefined | null {
  if (!Array.isArray(kel)) return undefined;
  const out: Message[] = [];
  for (const m of kel) {
    if (!m || typeof m !== "object" || typeof m.raw !== "string" || (m.atc !== undefined && typeof m.atc !== "string")) return undefined;
    let ked: unknown;
    try {
      ked = JSON.parse(m.raw);
    } catch {
      return null;
    }
    if (!ked || typeof ked !== "object" || Array.isArray(ked)) return null;
    out.push({ raw: m.raw, ked: ked as Record<string, any>, atc: m.atc });
  }
  return out;
}

const NO_NEXT_KEY = "the auditor's AID has no next key (non-transferable or abandoned), so no later event is valid";
const EO_KEL = "the auditor's KEL is establishment-only, so an interaction event cannot anchor";

/** Check 6 with the auditor's KEL: the key and witnesses in force at kelSeq, walked from inception. */
function verifyAnchorWithKel(ev: AnchorEvidence, event: Message, sn: number, auditorAID: string): CheckOutcome {
  const code = "ANCHOR_NOT_FOUND";
  const msgs = kelMessages(ev.kel);
  if (msgs === undefined) return fail(code, "the auditor's KEL is not a list of KERI events");
  if (msgs === null) return fail(code, "the auditor's KEL is not valid JSON");
  // Duplicity: another event of the auditor at the anchor's sequence number (compared as numbers).
  if (msgs.some((m) => m.ked.i === auditorAID && snOf(m.ked) === sn && m.raw !== event.raw)) {
    return fail(code, `the auditor's KEL has another event at #${sn}`);
  }
  const st = keyStateAt(msgs, auditorAID, sn - 1, "auditor");
  if (!st.ok) return fail(code, st.reason);
  // The anchor event itself, under the state rules keripy applies to it (Kever.update).
  if (event.ked.p !== st.last) return fail(code, `the anchor event does not link to event #${sn - 1} of the auditor's KEL`);
  if (st.establishmentOnly) return fail(code, EO_KEL);
  if (!st.transferable) return fail(code, NO_NEXT_KEY);
  const sig = ev.signatures?.find((s) => s.index === 0)?.qb64;
  if (!sig) return fail(code, "signature or key missing");
  let sigOk = false;
  try {
    sigOk = ed25519.verify(decodeIndexedSig(sig), utf8(event.raw), decodeVerKey(st.keys[0]));
  } catch {
    sigOk = false;
  }
  const rotations = `${st.rotations} rotation${st.rotations === 1 ? "" : "s"} since inception`;
  if (!sigOk) return fail(code, `the event's signature does not verify with the auditor's key in force at event #${sn} (${rotations})`);
  const wit = st.witnesses;
  const onAnchor = witnessThreshold([{ ...event, atc: ev.kelAttachment ?? undefined }], wit);
  if (onAnchor.reason) return fail(code, `anchor event: ${onAnchor.reason}`);
  const n = wit.wits.length;
  if (st.rotations === 0) {
    // No rotation: the key and witnesses are the inception's, and the detail is the one evidence without
    // rotations has always shown (recorded in the demo video), word for word.
    const icps = msgs.filter((m) => m.ked.i === auditorAID && m.ked.t === "icp" && m.ked.s === "0");
    const onIcp = witnessThreshold(icps, wit);
    const receipts = wit.toad
      ? `; witness receipts: ${onAnchor.verified} of ${n} on this event, ${onIcp.verified} of ${n} on the inception event (threshold ${wit.toad})`
      : "; the auditor's AID has no witnesses";
    return {
      ok: true,
      code: "",
      detail: `KERI event #${sn} by the auditor anchors this credential; Ed25519 signature verified with the key from the auditor's inception event${receipts}`,
    };
  }
  const receipts = wit.toad
    ? `; witness receipts: ${onAnchor.verified} of ${n} on this event (threshold ${wit.toad}), and the threshold on each earlier event`
    : "; the auditor's AID has no witnesses";
  return {
    ok: true,
    code: "",
    detail: `KERI event #${sn} by the auditor anchors this credential; Ed25519 signature verified with the key in force at event #${sn} (${rotations})${receipts}`,
  };
}

export function verifyAnchor(
  ev: AnchorEvidence,
  expect: { credSAID: string; auditorAID: string; kelSeq: bigint; auditorAidHash?: Hex },
): CheckOutcome {
  const code = "ANCHOR_NOT_FOUND";
  // Malformed evidence fails with a reason; it never throws out of check 6.
  try {
    return verifyAnchorEvidence(ev, expect);
  } catch (e) {
    return fail(code, `the anchor evidence could not be read: ${(e as Error).message}`);
  }
}

function verifyAnchorEvidence(
  ev: AnchorEvidence,
  expect: { credSAID: string; auditorAID: string; kelSeq: bigint; auditorAidHash?: Hex },
): CheckOutcome {
  const code = "ANCHOR_NOT_FOUND";
  let event: Message;
  try {
    event = { raw: ev.event.raw, ked: JSON.parse(ev.event.raw) };
  } catch {
    return fail(code, "anchor event is not valid JSON");
  }
  const k = event.ked;
  if (!k || typeof k !== "object") return fail(code, "anchor event is not valid JSON");
  if (k.t !== "ixn") return fail(code, "anchor event is not an interaction event");
  if (k.i !== expect.auditorAID) return fail(code, "anchor event is not from the credential's auditor");
  if (expect.auditorAidHash && hashString(k.i) !== expect.auditorAidHash) {
    return fail(code, "auditor on-chain differs from the event's AID");
  }
  // KERI's `s`: lowercase hex without leading zeros, so "02" is not event #2.
  const sn = snOf(k);
  if (!Number.isInteger(sn)) return fail(code, "anchor event has an invalid sequence number");
  if (BigInt(sn) !== expect.kelSeq) {
    return fail(code, `anchor is event #${sn}, the registry says #${expect.kelSeq}`);
  }
  if (sn === 0) return fail(code, "event #0 of a KEL is its inception, not an interaction event");
  if (!Array.isArray(k.a) || !k.a.some((s: any) => s && s.d === expect.credSAID)) {
    return fail(code, "the event does not anchor this credential");
  }
  if (!saidOk(event)) return fail(code, "the event's SAID does not match its content");
  if (parseInt(k.v.slice(10, 16), 16) !== utf8(event.raw).length) return fail(code, "event size differs from its version string");
  if (ev.kel != null) return verifyAnchorWithKel(ev, event, sn, expect.auditorAID);
  // Without `kel` only the inception is known: that is enough for event #1 (nothing can come between),
  // not for a later one, where a rotation in between would go unseen.
  if (sn > 1) {
    return fail(code, `the auditor's KEL events #0 to #${sn - 1} are not in the evidence, so a key rotation before the anchor cannot be ruled out`);
  }

  const key = ev.signingKeys?.[0]?.qb64;
  const sig = ev.signatures?.find((s) => s.index === 0)?.qb64;
  if (!key || !sig) return fail(code, "signature or key missing");
  let sigOk = false;
  try {
    sigOk = ed25519.verify(decodeIndexedSig(sig), utf8(event.raw), decodeVerKey(key));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail(code, "the event's signature does not verify");

  // The signing key must be bound to the auditor's AID; without the inception event it is not.
  if (!ev.establishmentRaw) return fail(code, "the auditor's inception event is missing, so the signing key is not bound to the auditor");
  {
    const est: Message = { raw: ev.establishmentRaw, ked: JSON.parse(ev.establishmentRaw) };
    if (!est.ked || est.ked.t !== "icp" || est.ked.i !== expect.auditorAID || est.ked.d !== est.ked.i) {
      return fail(code, "inception event does not belong to the auditor");
    }
    // Self-addressing inception: both `d` and the prefix `i` hold the SAID and are blanked together.
    if (computeSaid({ ...est.ked, i: "#".repeat(44) }) !== est.ked.d) {
      return fail(code, "the inception event's SAID does not match its content");
    }
    if (!Array.isArray(est.ked.k) || est.ked.k[0] !== key || est.ked.kt !== "1") {
      return fail(code, "the signing key is not the auditor's key");
    }
    // Event #1 under the inception's state: it links to it, the KEL allows interaction events, and a
    // next key is committed (the same rules the `kel` walk applies).
    if (k.p !== est.ked.d) return fail(code, "the anchor event does not link to event #0 of the auditor's KEL");
    if (Array.isArray(est.ked.c) && est.ked.c.includes("EO")) return fail(code, EO_KEL);
    const n = est.ked.n;
    if (!Array.isArray(n) || n.length !== 1 || est.ked.nt !== "1") {
      return fail(code, n?.length === 0 ? NO_NEXT_KEY : `the auditor's inception: only one next key with threshold "1" is supported (nt ${JSON.stringify(est.ked.nt)})`);
    }
    // Witness receipts, with the witnesses and threshold of the auditor's inception event.
    const wit = witnessState(est.ked);
    if (typeof wit === "string") return fail(code, `the auditor's inception event: ${wit}`);
    const onAnchor = witnessThreshold([{ ...event, atc: ev.kelAttachment ?? undefined }], wit);
    if (onAnchor.reason) return fail(code, `anchor event: ${onAnchor.reason}`);
    const onEst = witnessThreshold([{ ...est, atc: ev.establishmentAttachment }], wit);
    if (onEst.reason) return fail(code, `the auditor's inception event: ${onEst.reason}`);
    const nw = wit.wits.length;
    const receipts = wit.toad
      ? `; witness receipts: ${onAnchor.verified} of ${nw} on this event, ${onEst.verified} of ${nw} on the inception event (threshold ${wit.toad})`
      : "; the auditor's AID has no witnesses";
    return {
      ok: true,
      code: "",
      detail: `KERI event #${sn} by the auditor anchors this credential; Ed25519 signature verified with the key from the auditor's inception event${receipts}`,
    };
  }
}

// ---------------------------------------------------------------------- check 7

export interface AuthorityEvidence {
  /** Root of trust (simulated GLEIF root in the demo). */
  trustAnchor: string;
  /** Informational: check 7 compares the accreditation's schema with SCHEMA.ACCREDITATION, not with this. */
  accreditationSchema?: string;
  /** CESR streams of the credentials, as exported (`credentials().get(said, true)`). */
  cesr: { qvi: string; leBody: string; leNab: string; accreditation: string; ecr: string };
}

export interface AuthorityExpect {
  /** Root of trust configured by the verifier (never taken from the evidence). */
  trustAnchor: string;
  auditorAID: string;
  verifierLEI: string;
  cnCode: string;
  /** Registration time (seconds); the accreditation must cover it, and authority is judged at it. */
  registeredAt?: bigint;
  /**
   * The allowlist records of the body and the auditor, read at the verified block. With them,
   * `registeredAt` is required.
   */
  onchain?: {
    leCredSaidHash: Hex;
    accreditationSaidHash: Hex;
    ecrSaidHash: Hex;
    /** The body's `accreditedUntil` (seconds). */
    accreditedUntil: bigint;
    /** The auditor's `addedAt` and `revokedAt` (seconds; `revokedAt` 0 = not revoked). */
    auditorAddedAt: bigint;
    auditorRevokedAt: bigint;
  };
}

function acdcOf(stream: string, said?: string): { acdc: Message; all: Message[] } {
  const all = parseCesr(stream);
  const acdcs = all.filter((m) => m.ked.v.startsWith("ACDC"));
  const acdc = said ? acdcs.find((m) => m.ked.d === said) : acdcs[acdcs.length - 1];
  if (!acdc) throw new Error("credential not found in the evidence");
  return { acdc, all };
}

/** The issuance's TEL event and an anchoring seal are present (verified later by verifyIssuance). Revocations: see anchoredRevocation. */
function issued(all: Message[], said: string): string {
  if (!all.some((m) => m.ked.i === said && (m.ked.t === "iss" || m.ked.t === "bis"))) return "no issuance event";
  const anchored = all.some(
    (m) => m.ked.t === "ixn" && Array.isArray(m.ked.a) && m.ked.a.some((s: any) => s && s.i === said && s.s === "0"),
  );
  return anchored ? "" : "issuance not anchored in the issuer's KEL";
}

export function verifyAuthority(ev: AuthorityEvidence, x: AuthorityExpect): CheckOutcome {
  const code = "AUTHORITY_INVALID";
  try {
    const ecr = acdcOf(ev.cesr.ecr);
    const leBody = acdcOf(ev.cesr.leBody);
    const qvi = acdcOf(ev.cesr.qvi);
    const acc = acdcOf(ev.cesr.accreditation);
    const leNab = acdcOf(ev.cesr.leNab);
    for (const [name, c] of [["ECR", ecr], ["body LE", leBody], ["QVI", qvi], ["accreditation", acc], ["NAB LE", leNab]] as const) {
      if (!saidOk(c.acdc)) return fail(code, `${name} credential: SAID does not match its content`);
      const st = issued(c.all, c.acdc.ked.d);
      if (st) return fail(code, `${name} credential: ${st}`);
    }
    const E = ecr.acdc.ked, L = leBody.acdc.ked, Q = qvi.acdc.ked, A = acc.acdc.ked, N = leNab.acdc.ked;
    // ECR: auditor's role, issued by the body, chained to the body's LE
    if (E.s !== SCHEMA.ECR) return fail(code, "auditor credential is not an ECR vLEI");
    if (E.a?.i !== x.auditorAID) return fail(code, "the role credential was issued to another AID");
    if (E.a?.engagementContextRole !== AUDITOR_ROLE) return fail(code, `role is not "${AUDITOR_ROLE}"`);
    if (E.a?.LEI !== x.verifierLEI) return fail(code, "role credential names another LEI");
    if (E.e?.le?.n !== L.d) return fail(code, "role credential does not chain to the body's LE vLEI");
    if (E.i !== L.a?.i) return fail(code, "role credential not issued by the verification body");
    // LE of the body, issued by the QVI
    if (L.s !== SCHEMA.LE || L.a?.LEI !== x.verifierLEI) return fail(code, "body LE vLEI missing or for another LEI");
    if (L.e?.qvi?.n !== Q.d || L.i !== Q.a?.i) return fail(code, "body LE vLEI not issued by the QVI");
    // QVI, issued by the root of trust. The issuer is checked first: for a chain built under another
    // root (attack 4) that is the reason that matters, whatever root the bundle names.
    if (Q.s !== SCHEMA.QVI || Q.i !== x.trustAnchor) return fail(code, "QVI credential not issued by the configured root of trust");
    if (ev.trustAnchor && ev.trustAnchor !== x.trustAnchor) return fail(code, "the evidence names another root of trust");
    // Accreditation by the NAB, covering the CN code
    if (A.s !== SCHEMA.ACCREDITATION) return fail(code, "accreditation credential has another schema");
    if (A.a?.i !== L.a?.i || A.a?.LEI !== x.verifierLEI) return fail(code, "accreditation issued to another body");
    if (!Array.isArray(A.a?.cnScope) || !A.a.cnScope.includes(x.cnCode)) return fail(code, `accreditation scope does not include CN ${x.cnCode}`);
    if (A.e?.nab?.n !== N.d || A.i !== N.a?.i) return fail(code, "accreditation not issued by the accreditation body");
    if (N.s !== SCHEMA.LE || N.e?.qvi?.n !== Q.d) return fail(code, "accreditation body has no LE vLEI from the QVI");
    if (A.a?.validUntil === undefined) return fail(code, "accreditation credential has no validUntil");
    const until = isoSeconds(A.a.validUntil);
    if (until === undefined) return fail(code, "accreditation validUntil is not an ISO 8601 time with a time zone");
    if (x.registeredAt !== undefined && x.registeredAt > until) return fail(code, "accreditation had expired at registration");
    // Each issuance signed by its issuer (sdk/kel.ts), root first: a chain that claims the pinned root
    // without the root's key fails on the QVI credential.
    for (const [name, c] of [["QVI", qvi], ["NAB LE", leNab], ["body LE", leBody], ["accreditation", acc], ["ECR", ecr]] as const) {
      const r = verifyIssuance(c.all, c.acdc.ked);
      if (r) return fail(code, `${name} credential: ${r}`);
    }
    // Revocations in the evidence, only those the issuer anchored (verified like the issuance).
    const revokedAfter: string[] = [];
    for (const [name, c] of [["QVI", qvi], ["NAB LE", leNab], ["body LE", leBody], ["accreditation", acc], ["ECR", ecr]] as const) {
      const rev = anchoredRevocation(c.all, c.acdc.ked);
      if (!rev) continue;
      if (x.registeredAt === undefined) return fail(code, `${name} credential: revoked`);
      const at = isoSeconds(rev.ked.dt);
      if (at === undefined) return fail(code, `${name} credential: revoked, at a time that is not ISO 8601 with a time zone`);
      if (at < x.registeredAt) return fail(code, `${name} credential: revoked before registration`);
      revokedAfter.push(name);
    }
    if (x.onchain) {
      const o = x.onchain;
      if (hashString(L.d) !== o.leCredSaidHash) return fail(code, "allowlist LE hash differs from the body's LE vLEI");
      if (hashString(A.d) !== o.accreditationSaidHash) return fail(code, "allowlist accreditation hash differs");
      if (hashString(E.d) !== o.ecrSaidHash) return fail(code, "allowlist ECR hash differs from the auditor's role credential");
      // Authority at registration, from the allowlist. The contract checked the same at registration
      // (isAuthorizedAt: added at or before t, t < revokedAt; t <= accreditedUntil). A revocation in the
      // registration's own block (revokedAt = registeredAt) came after it, or the registration would
      // have reverted: check 4 shows it as CONTESTED, as any revocation after registration.
      const t = x.registeredAt;
      if (t === undefined) return fail(code, "no registration time to check the allowlist records against");
      if (typeof o.accreditedUntil !== "bigint" || typeof o.auditorAddedAt !== "bigint" || typeof o.auditorRevokedAt !== "bigint") {
        return fail(code, "the allowlist records of the body and the auditor were not read");
      }
      if (o.auditorAddedAt === 0n || o.auditorAddedAt > t) return fail(code, "the auditor was not on the allowlist at registration");
      if (o.auditorRevokedAt !== 0n && o.auditorRevokedAt < t) return fail(code, "the auditor's ECR was revoked on the allowlist before registration");
      if (t > o.accreditedUntil) return fail(code, "accreditation (on-chain accreditedUntil) had expired at registration");
    }
    const after = revokedAfter.length ? `; revoked after registration in the evidence: ${revokedAfter.join(", ")}` : "";
    return {
      ok: true,
      code: "",
      detail: `root → QVI → verification body (LE vLEI) → auditor (ECR, ${AUDITOR_ROLE}); accredited by the NAB for CN ${x.cnCode}; each issuance signed in its issuer's KEL, every event with its witness threshold of receipts${x.onchain ? "; hashes match the on-chain allowlist" : ""}${after}`,
    };
  } catch (e) {
    return fail(code, `evidence could not be read: ${(e as Error).message}`);
  }
}
