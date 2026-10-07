// Checks 6 and 7 on vLEI evidence exported from a KERI run. Pure functions: runs in the browser
// (hosted page) and in Node (CLI, onboarding). Uses only @noble and the SDK's SAID code.
//
// Check 6 (anchor): the auditor's KERI interaction event that anchors the credential SAID.
//   - the event's SAID recomputes; it is an `ixn` by the auditor's AID at sequence number kelSeq;
//     its seals contain { d: credSAID };
//   - its Ed25519 signature verifies over the exact event bytes;
//   - the signing key is the auditor's key in force at kelSeq. With `kel` (the auditor's events before
//     kelSeq) it is walked from the self-addressing inception by sdk/kel.ts keyStateAt (pre-rotation and
//     witness changes enforced, each event with its witness threshold); without it, it is the key of the
//     inception event `establishmentRaw`, and a rotation before kelSeq fails closed;
//   - witness receipts: at least `bt` of the witnesses in force at kelSeq signed the anchor event's exact
//     bytes (from `kelAttachment`), and the inception event (from `establishmentAttachment` or `kel`).
// Check 7 (authority): the credential chain QVI → LE (body) → ECR (auditor), plus the NAB's
//   accreditation of the body, from exported CESR streams: every ACDC SAID recomputes, schemas,
//   issuers, issuees, edges and LEIs line up, the QVI was issued by the configured root, the
//   accreditation scope covers the CN code, each issuance has a TEL `iss` event and no `rev`,
//   each issuer signed the KEL event anchoring its issuance (sdk/kel.ts: Ed25519 over the event bytes,
//   key state walked from the issuer's self-addressing inception, so the QVI's anchor must be signed
//   with the pinned root's key; every event walked also carries the witness threshold of receipts),
//   and the on-chain allowlist hashes equal the credential SAID hashes.
import { ed25519 } from "@noble/curves/ed25519.js";
import { hashString } from "./commitment.ts";
import type { Hex } from "./credential.ts";
import { utf8 } from "./encoding.ts";
import { controllerSigs, decodeIndexedSig, decodeVerKey, keyStateAt, verifyIssuance, witnessState, witnessThreshold } from "./kel.ts";
import { computeSaid } from "./said.ts";

export { decodeIndexedSig, decodeVerKey } from "./kel.ts";

export const SCHEMA = {
  QVI: "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
  LE: "ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY",
  ECR: "EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw",
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
 * attachment and controller signature, and the auditor's events #0 to #kelSeq-1 as `kel`.
 */
export function anchorEvidenceFromKel(stream: string, auditor: string, kelSeq: number, credSAID: string): AnchorEvidence {
  const msgs = parseCesr(stream).filter((m) => m.ked.i === auditor);
  const anchor = msgs.find((m) => m.ked.s === kelSeq.toString(16));
  if (!anchor) throw new Error(`the KEL has no event #${kelSeq}`);
  const sig = controllerSigs(anchor.atc ?? "").find((s) => s.index === 0);
  return {
    credSAID,
    auditor,
    kelSeq,
    event: { raw: anchor.raw },
    signatures: sig ? [{ qb64: sig.qb64, index: 0 }] : [],
    signingKeys: [],
    kelAttachment: anchor.atc,
    kel: msgs.filter((m) => parseInt(m.ked.s, 16) < kelSeq).map((m) => ({ raw: m.raw, atc: m.atc })),
  };
}

/** Check 6 with the auditor's KEL: the key and witnesses in force at kelSeq, walked from inception. */
function verifyAnchorWithKel(ev: AnchorEvidence, event: Message, auditorAID: string): CheckOutcome {
  const code = "ANCHOR_NOT_FOUND";
  const sn = parseInt(event.ked.s, 16);
  let msgs: Message[];
  try {
    msgs = (ev.kel ?? []).map((m) => ({ raw: m.raw, ked: JSON.parse(m.raw), atc: m.atc }));
  } catch {
    return fail(code, "the auditor's KEL is not valid JSON");
  }
  if (msgs.some((m) => m.ked.i === auditorAID && m.ked.s === event.ked.s && m.raw !== event.raw)) {
    return fail(code, `the auditor's KEL has another event at #${sn}`);
  }
  const st = keyStateAt(msgs, auditorAID, sn - 1, "auditor");
  if (!st.ok) return fail(code, st.reason);
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
  const receipts = wit.toad
    ? `; witness receipts: ${onAnchor.verified} of ${wit.wits.length} on this event (threshold ${wit.toad}), and the threshold on each earlier event`
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
  let event: Message;
  try {
    event = { raw: ev.event.raw, ked: JSON.parse(ev.event.raw) };
  } catch {
    return fail(code, "anchor event is not valid JSON");
  }
  const k = event.ked;
  if (k.t !== "ixn") return fail(code, "anchor event is not an interaction event");
  if (k.i !== expect.auditorAID) return fail(code, "anchor event is not from the credential's auditor");
  if (expect.auditorAidHash && hashString(k.i) !== expect.auditorAidHash) {
    return fail(code, "auditor on-chain differs from the event's AID");
  }
  if (BigInt(parseInt(k.s, 16)) !== expect.kelSeq) {
    return fail(code, `anchor is event #${parseInt(k.s, 16)}, the registry says #${expect.kelSeq}`);
  }
  if (!Array.isArray(k.a) || !k.a.some((s: any) => s && s.d === expect.credSAID)) {
    return fail(code, "the event does not anchor this credential");
  }
  if (!saidOk(event)) return fail(code, "the event's SAID does not match its content");
  if (parseInt(k.v.slice(10, 16), 16) !== utf8(event.raw).length) return fail(code, "event size differs from its version string");
  if (ev.kel) return verifyAnchorWithKel(ev, event, expect.auditorAID);

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
    if (est.ked.t !== "icp" || est.ked.i !== expect.auditorAID || est.ked.d !== est.ked.i) {
      return fail(code, "inception event does not belong to the auditor");
    }
    // Self-addressing inception: both `d` and the prefix `i` hold the SAID and are blanked together.
    if (computeSaid({ ...est.ked, i: "#".repeat(44) }) !== est.ked.d) {
      return fail(code, "the inception event's SAID does not match its content");
    }
    if (!Array.isArray(est.ked.k) || est.ked.k[0] !== key || est.ked.kt !== "1") {
      return fail(code, "the signing key is not the auditor's key");
    }
    // Witness receipts, with the witnesses and threshold of the auditor's inception event.
    const wit = witnessState(est.ked);
    if (typeof wit === "string") return fail(code, `the auditor's inception event: ${wit}`);
    const onAnchor = witnessThreshold([{ ...event, atc: ev.kelAttachment ?? undefined }], wit);
    if (onAnchor.reason) return fail(code, `anchor event: ${onAnchor.reason}`);
    const onEst = witnessThreshold([{ ...est, atc: ev.establishmentAttachment }], wit);
    if (onEst.reason) return fail(code, `the auditor's inception event: ${onEst.reason}`);
    const n = wit.wits.length;
    const receipts = wit.toad
      ? `; witness receipts: ${onAnchor.verified} of ${n} on this event, ${onEst.verified} of ${n} on the inception event (threshold ${wit.toad})`
      : "; the auditor's AID has no witnesses";
    return {
      ok: true,
      code: "",
      detail: `KERI event #${parseInt(k.s, 16)} by the auditor anchors this credential; Ed25519 signature verified with the key from the auditor's inception event${receipts}`,
    };
  }
}

// ---------------------------------------------------------------------- check 7

export interface AuthorityEvidence {
  /** Root of trust (simulated GLEIF root in the demo). */
  trustAnchor: string;
  accreditationSchema: string;
  /** CESR streams of the credentials, as exported (`credentials().get(said, true)`). */
  cesr: { qvi: string; leBody: string; leNab: string; accreditation: string; ecr: string };
}

export interface AuthorityExpect {
  /** Root of trust configured by the verifier (never taken from the evidence). */
  trustAnchor: string;
  auditorAID: string;
  verifierLEI: string;
  cnCode: string;
  /** Registration time (seconds); the accreditation must cover it. */
  registeredAt?: bigint;
  onchain?: { leCredSaidHash: Hex; accreditationSaidHash: Hex; ecrSaidHash: Hex };
}

function acdcOf(stream: string, said?: string): { acdc: Message; all: Message[] } {
  const all = parseCesr(stream);
  const acdcs = all.filter((m) => m.ked.v.startsWith("ACDC"));
  const acdc = said ? acdcs.find((m) => m.ked.d === said) : acdcs[acdcs.length - 1];
  if (!acdc) throw new Error("credential not found in the evidence");
  return { acdc, all };
}

function issuedNotRevoked(all: Message[], said: string): string {
  const tel = all.filter((m) => m.ked.i === said && (m.ked.t === "iss" || m.ked.t === "rev" || m.ked.t === "bis" || m.ked.t === "brv"));
  if (!tel.some((m) => m.ked.t === "iss" || m.ked.t === "bis")) return "no issuance event";
  if (tel.some((m) => m.ked.t === "rev" || m.ked.t === "brv")) return "revoked";
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
      const st = issuedNotRevoked(c.all, c.acdc.ked.d);
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
    if (A.s !== ev.accreditationSchema) return fail(code, "accreditation credential has another schema");
    if (A.a?.i !== L.a?.i || A.a?.LEI !== x.verifierLEI) return fail(code, "accreditation issued to another body");
    if (!Array.isArray(A.a?.cnScope) || !A.a.cnScope.includes(x.cnCode)) return fail(code, `accreditation scope does not include CN ${x.cnCode}`);
    if (A.e?.nab?.n !== N.d || A.i !== N.a?.i) return fail(code, "accreditation not issued by the accreditation body");
    if (N.s !== SCHEMA.LE || N.e?.qvi?.n !== Q.d) return fail(code, "accreditation body has no LE vLEI from the QVI");
    if (x.registeredAt !== undefined && A.a?.validUntil) {
      const until = BigInt(Math.floor(Date.parse(A.a.validUntil) / 1000));
      if (x.registeredAt > until) return fail(code, "accreditation had expired at registration");
    }
    // Each issuance signed by its issuer (sdk/kel.ts), root first: a chain that claims the pinned root
    // without the root's key fails on the QVI credential.
    for (const [name, c] of [["QVI", qvi], ["NAB LE", leNab], ["body LE", leBody], ["accreditation", acc], ["ECR", ecr]] as const) {
      const r = verifyIssuance(c.all, c.acdc.ked);
      if (r) return fail(code, `${name} credential: ${r}`);
    }
    if (x.onchain) {
      if (hashString(L.d) !== x.onchain.leCredSaidHash) return fail(code, "allowlist LE hash differs from the body's LE vLEI");
      if (hashString(A.d) !== x.onchain.accreditationSaidHash) return fail(code, "allowlist accreditation hash differs");
      if (hashString(E.d) !== x.onchain.ecrSaidHash) return fail(code, "allowlist ECR hash differs from the auditor's role credential");
    }
    return {
      ok: true,
      code: "",
      detail: `root → QVI → verification body (LE vLEI) → auditor (ECR, ${AUDITOR_ROLE}); accredited by the NAB for CN ${x.cnCode}; each issuance signed in its issuer's KEL, every event with its witness threshold of receipts${x.onchain ? "; hashes match the on-chain allowlist" : ""}`,
    };
  } catch (e) {
    return fail(code, `evidence could not be read: ${(e as Error).message}`);
  }
}
