// Checks 6 and 7 against the evidence exported from the local KERI run (fixtures/evidence).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { isSafeBundlePath, sha256Hex, vleiCheckers } from "../checkers.ts";
import { hashString } from "../commitment.ts";
import { decodeDisclosure } from "../disclosure.ts";
import { base64url, utf8 } from "../encoding.ts";
import { controllerSigs, decodeIndexedSig, decodeVerKey, keyStateAt, parseAttachments, verifyIssuance } from "../kel.ts";
import { SAID_DUMMY, computeSaid } from "../said.ts";
import {
  anchorEvidenceFromKel,
  auditorKel,
  DEMO_TRUST_ANCHOR,
  parseCesr,
  verifyAnchor,
  verifyAuthority,
  type AnchorEvidence,
  type AuthorityEvidence,
  type Message,
} from "../vlei.ts";

const dir = new URL("../../fixtures/evidence/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const vlei = JSON.parse(readFileSync(new URL("../../fixtures/vlei.json", import.meta.url), "utf8"));
// The anchor of the Sepolia demo credential, so stray local anchor files cannot change the test.
const demoCredSaid: string = JSON.parse(readFileSync(new URL("../../fixtures/sepolia-credential.json", import.meta.url), "utf8")).credSAID;
const anchorFile = readdirSync(dir).find((f) => f === `anchor-${demoCredSaid}.json`) as string;
const anchor = JSON.parse(read(anchorFile)) as AnchorEvidence;
const auditorIcpMsg = parseCesr(read("cred-ecr.cesr")).find((m) => m.ked.t === "icp" && m.ked.i === anchor.auditor);
const auditorIcp = auditorIcpMsg?.raw;
/** The inception's attachment: its controller and witness signatures (the witness receipts check 6 needs). */
const auditorIcpAtc = auditorIcpMsg?.atc;
/**
 * The auditor's events #0 to #kelSeq-1 as exported, unchanged: #0 and #1 from kel-auditor.json, #2 from the
 * anchor export of the credential it anchors. The demo proof carries the same list as `kel`.
 */
const kelExport = JSON.parse(read("kel-auditor.json")) as { ked: Record<string, any>; atc: string }[];
const exportedKel = auditorKel(
  [
    ...kelExport.map((e) => ({ raw: JSON.stringify(e.ked), atc: e.atc })),
    ...readdirSync(dir)
      .filter((f) => f.startsWith("anchor-"))
      .map((f) => JSON.parse(read(f)))
      .filter((a) => a.auditor === anchor.auditor)
      .map((a) => ({ raw: a.event.raw as string, atc: a.kelAttachment as string })),
  ],
  anchor.auditor,
  anchor.kelSeq,
);
/** Event #1 of the auditor's KEL (kel-auditor.json) as evidence without `kel`: at kelSeq 1 the inception is enough. */
const ev1 = kelExport[1];
const legacy1 = {
  credSAID: ev1.ked.a[0].d,
  auditor: anchor.auditor,
  kelSeq: 1,
  event: { raw: JSON.stringify(ev1.ked) },
  signatures: [{ qb64: controllerSigs(ev1.atc).find((s) => s.index === 0)!.qb64, index: 0 }],
  signingKeys: [{ qb64: JSON.parse(auditorIcp as string).k[0] }],
  kelAttachment: ev1.atc,
  establishmentRaw: auditorIcp,
  establishmentAttachment: auditorIcpAtc,
} as AnchorEvidence;
const exp1 = { credSAID: legacy1.credSAID, auditorAID: anchor.auditor, kelSeq: 1n, auditorAidHash: hashString(anchor.auditor) };

const authority: AuthorityEvidence = {
  trustAnchor: vlei.trustAnchor,
  accreditationSchema: vlei.schemas.CBAMVerifierAccreditation,
  cesr: {
    qvi: read("cred-qvi.cesr"),
    leBody: read("cred-le-verifier.cesr"),
    leNab: read("cred-le-nab.cesr"),
    accreditation: read("cred-accreditation.cesr"),
    ecr: read("cred-ecr.cesr"),
  },
};
const expectAuth = {
  trustAnchor: vlei.trustAnchor,
  auditorAID: anchor.auditor,
  verifierLEI: "ZZZZ00EUVERIFDEMO152",
  cnCode: "7318",
  onchain: {
    leCredSaidHash: hashString(vlei.credentials.leVerifier.said),
    accreditationSaidHash: hashString(vlei.credentials.accreditation.said),
    ecrSaidHash: hashString(vlei.credentials.ecr.said),
  },
};

describe("check 6: KEL anchor", () => {
  const exp = { credSAID: anchor.credSAID, auditorAID: anchor.auditor, kelSeq: BigInt(anchor.kelSeq), auditorAidHash: hashString(anchor.auditor) };
  const withKel = { ...anchor, kel: exportedKel, establishmentRaw: auditorIcp, establishmentAttachment: auditorIcpAtc } as AnchorEvidence;
  it("verifies the exported anchor event, signature, the auditor's KEL #0 to #2 and witness receipts", () => {
    expect(auditorIcp).toBeDefined();
    expect(exportedKel.map((m) => JSON.parse(m.raw).s)).toEqual(["0", "1", "2"]);
    expect(verifyAnchor(withKel, exp)).toMatchObject({ ok: true });
  });
  it("the demo proof's `kel` is the exported events #0 to #2, unchanged", () => {
    const proof = JSON.parse(readFileSync(new URL("../../fixtures/sepolia-demo-proof.json", import.meta.url), "utf8"));
    expect(proof.anchorEvidence.kel).toEqual(exportedKel);
    expect(exportedKel[0].raw).toBe(auditorIcp);
  });
  it("evidence with the auditor's KEL and no rotation keeps the detail of d58380c word for word (the video shows it)", () => {
    expect(verifyAnchor(withKel, exp)).toEqual({
      ok: true,
      code: "",
      detail:
        "KERI event #3 by the auditor anchors this credential; Ed25519 signature verified with the key from the auditor's inception event; witness receipts: 3 of 3 on this event, 3 of 3 on the inception event (threshold 2)",
    });
  });
  it("H1: without `kel`, an anchor after event #1 fails, since a rotation before it cannot be ruled out", () => {
    expect(verifyAnchor({ ...anchor, establishmentRaw: auditorIcp, establishmentAttachment: auditorIcpAtc }, exp)).toEqual({
      ok: false,
      code: "ANCHOR_NOT_FOUND",
      detail: "the auditor's KEL events #0 to #2 are not in the evidence, so a key rotation before the anchor cannot be ruled out",
    });
  });
  it("without `kel`, event #1 is checked against the inception alone (nothing can come between them)", () => {
    expect(verifyAnchor(legacy1, exp1)).toEqual({
      ok: true,
      code: "",
      detail:
        "KERI event #1 by the auditor anchors this credential; Ed25519 signature verified with the key from the auditor's inception event; witness receipts: 3 of 3 on this event, 3 of 3 on the inception event (threshold 2)",
    });
  });
  it("rejects an anchor without the auditor's inception event (key not bound)", () => {
    const { establishmentRaw: _drop, ...noEst } = legacy1;
    expect(verifyAnchor(noEst as AnchorEvidence, exp1)).toEqual({
      ok: false,
      code: "ANCHOR_NOT_FOUND",
      detail: "the auditor's inception event is missing, so the signing key is not bound to the auditor",
    });
  });
  it("rejects a changed event, another credential, another sequence number, another key", () => {
    const changed = anchor.event.raw.replace(anchor.credSAID, anchor.credSAID.slice(0, -1) + "A");
    expect(verifyAnchor({ ...withKel, event: { raw: changed } }, exp).ok).toBe(false);
    expect(verifyAnchor(withKel, { ...exp, credSAID: "EOtherCredentialSaid000000000000000000000000" }).ok).toBe(false);
    expect(verifyAnchor(withKel, { ...exp, kelSeq: exp.kelSeq + 1n }).ok).toBe(false);
    const otherIcp = parseCesr(read("cred-ecr.cesr")).find((m) => m.ked.t === "icp" && m.ked.i !== anchor.auditor)?.raw;
    expect(verifyAnchor({ ...legacy1, establishmentRaw: otherIcp }, exp1).ok).toBe(false);
  });
  it("each fail-closed step reports its own reason", () => {
    const full = withKel;
    const reason = (ev: AnchorEvidence, x = exp) => {
      const r = verifyAnchor(ev, x);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("ANCHOR_NOT_FOUND");
      return r.detail;
    };
    const raw = anchor.event.raw;
    expect(reason({ ...full, event: { raw: raw.slice(0, -1) } })).toBe("anchor event is not valid JSON");
    expect(reason({ ...full, event: { raw: raw.replace('"t":"ixn"', '"t":"rot"') } })).toBe("anchor event is not an interaction event");
    expect(reason(full, { ...exp, auditorAID: "EAnotherAuditorAid00000000000000000000000000" })).toBe("anchor event is not from the credential's auditor");
    expect(reason(full, { ...exp, auditorAidHash: hashString("EAnotherAuditorAid00000000000000000000000000") })).toBe("auditor on-chain differs from the event's AID");
    expect(reason(full, { ...exp, kelSeq: exp.kelSeq + 1n })).toBe(`anchor is event #${exp.kelSeq}, the registry says #${exp.kelSeq + 1n}`);
    expect(reason(full, { ...exp, credSAID: "EOtherCredentialSaid000000000000000000000000" })).toBe("the event does not anchor this credential");
    const otherCred = anchor.credSAID.slice(0, -1) + (anchor.credSAID.endsWith("A") ? "B" : "A");
    expect(reason({ ...full, event: { raw: raw.replace(anchor.credSAID, otherCred) } }, { ...exp, credSAID: otherCred })).toBe(
      "the event's SAID does not match its content",
    );
    expect(reason({ ...full, event: { raw: raw + " " } })).toBe("event size differs from its version string");
    expect(reason({ ...full, signatures: [] })).toBe("signature or key missing");
    // Without `kel` (event #1 of the auditor's KEL, checked against the inception)
    expect(reason({ ...legacy1, signingKeys: [] }, exp1)).toBe("signature or key missing");
    const sig0 = legacy1.signatures.find((s) => s.index === 0)!.qb64;
    const badSig = sig0.slice(0, 40) + (sig0[40] === "A" ? "B" : "A") + sig0.slice(41);
    expect(reason({ ...legacy1, signatures: [{ index: 0, qb64: badSig }] }, exp1)).toBe("the event's signature does not verify");
    const otherIcp = parseCesr(read("cred-ecr.cesr")).find((m) => m.ked.t === "icp" && m.ked.i !== anchor.auditor)!.raw;
    expect(reason({ ...legacy1, establishmentRaw: otherIcp }, exp1)).toBe("inception event does not belong to the auditor");
    const editedIcp = auditorIcp!.replace(/"bt":"(\d)"/, (_m, d) => `"bt":"${d === "1" ? "2" : "1"}"`);
    expect(editedIcp).not.toBe(auditorIcp);
    expect(reason({ ...legacy1, establishmentRaw: editedIcp }, exp1)).toBe("the inception event's SAID does not match its content");
  });
});

describe("check 7: authority chain", () => {
  it("verifies root → QVI → body LE → auditor ECR and the NAB accreditation", () => {
    expect(verifyAuthority(authority, expectAuth)).toMatchObject({ ok: true });
  });
  it("rejects another LEI, a CN outside the scope, another auditor, mismatched on-chain hashes, another root", () => {
    expect(verifyAuthority(authority, { ...expectAuth, verifierLEI: "ZZZZ00EUOTHERBODY0042" }).ok).toBe(false);
    expect(verifyAuthority(authority, { ...expectAuth, cnCode: "7208" }).ok).toBe(false);
    expect(verifyAuthority(authority, { ...expectAuth, auditorAID: vlei.agents.importer.aid }).ok).toBe(false);
    expect(verifyAuthority(authority, { ...expectAuth, onchain: { ...expectAuth.onchain, ecrSaidHash: hashString("x") } }).ok).toBe(false);
    expect(verifyAuthority({ ...authority, trustAnchor: vlei.agents.qvi.aid }, expectAuth).ok).toBe(false);
    expect(verifyAuthority(authority, { ...expectAuth, trustAnchor: vlei.agents.qvi.aid }).ok).toBe(false);
  });
  it("rejects a credential whose content was changed", () => {
    const tampered = authority.cesr.ecr.replace('"CBAM Lead Auditor"', '"CBAM Lead Auditer"');
    expect(verifyAuthority({ ...authority, cesr: { ...authority.cesr, ecr: tampered } }, expectAuth).ok).toBe(false);
  });
  it("attack 4: a chain under another root fails with the pinned-root reason, whatever root the bundle names", () => {
    // Seen from a verifier that pins another root, this evidence is a self-made chain: its bundle names
    // its own root (the demo GEDA), and that root issued its QVI credential.
    const pinnedElsewhere = { ...expectAuth, trustAnchor: vlei.agents.qvi.aid };
    expect(authority.trustAnchor).not.toBe(pinnedElsewhere.trustAnchor);
    expect(verifyAuthority(authority, pinnedElsewhere)).toEqual({
      ok: false,
      code: "AUTHORITY_INVALID",
      detail: "QVI credential not issued by the configured root of trust",
    });
    // The same evidence passes with its own root pinned: only the root differs.
    expect(verifyAuthority(authority, expectAuth)).toMatchObject({ ok: true });
  });
});

// Helpers for the signature tests: streams are rebuilt from parsed messages, so edits stay byte-exact.
type CesrKey = keyof AuthorityEvidence["cesr"];
const rebuild = (msgs: Message[]) => msgs.map((m) => m.raw + (m.atc ?? "")).join("");
const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === "A" ? "B" : "A") + s.slice(at + 1);
const withCesr = (k: CesrKey, text: string): AuthorityEvidence => ({ ...authority, cesr: { ...authority.cesr, [k]: text } });
const invalid = (detail: string) => ({ ok: false, code: "AUTHORITY_INVALID", detail });
/** The KEL event in `stream` carrying the seal of `credSaid`'s TEL issuance. */
const anchorIn = (stream: string, credSaid: string) =>
  parseCesr(stream).find((m) => m.ked.t === "ixn" && m.ked.a.some((s: any) => s.i === credSaid && s.s === "0")) as Message;
const sigOf = (m: Message) => controllerSigs(m.atc ?? "")[0].qb64;
const isKel = (m: Message) => m.ked.v.startsWith("KERI") && ["icp", "rot", "ixn"].includes(m.ked.t);

/** A KERI event with its version-string size and SAID filled in (`labels` share the SAID, as in icp). */
function keriEvent(body: Record<string, any>, labels = ["d"]): Record<string, any> {
  const ev: Record<string, any> = { v: "KERI10JSON000000_", ...body };
  for (const l of labels) ev[l] = SAID_DUMMY;
  ev.v = `KERI10JSON${utf8(JSON.stringify(ev)).length.toString(16).padStart(6, "0")}_`;
  const said = computeSaid(ev);
  for (const l of labels) ev[l] = said;
  return ev;
}
const signWith = (raw: string, secret: Uint8Array) => "-AAB" + base64url(new Uint8Array([0, 0, ...ed25519.sign(utf8(raw), secret)]));

describe("check 7: each issuance is signed in its issuer's KEL", () => {
  const credKeys: [CesrKey, string][] = [
    ["qvi", vlei.credentials.qvi.said],
    ["leNab", vlei.credentials.leNab.said],
    ["leBody", vlei.credentials.leVerifier.said],
    ["accreditation", vlei.credentials.accreditation.said],
    ["ecr", vlei.credentials.ecr.said],
  ];
  const qviAnchor = anchorIn(authority.cesr.qvi, vlei.credentials.qvi.said);

  it("the exported chain: every TEL issuance is anchored by an event its issuer signed", () => {
    for (const [k, said] of credKeys) {
      const msgs = parseCesr(authority.cesr[k]);
      expect(rebuild(msgs)).toBe(authority.cesr[k]);
      expect(verifyIssuance(msgs, msgs.find((m) => m.ked.d === said)!.ked)).toBe("");
    }
    expect(qviAnchor.ked.i).toBe(DEMO_TRUST_ANCHOR);
    expect(verifyAuthority(authority, expectAuth).detail).toContain("each issuance signed in its issuer's KEL");
  });

  it("rejects a tampered controller signature: the root's anchor of the QVI credential, the body's anchor of the ECR", () => {
    const sig = sigOf(qviAnchor);
    expect(verifyAuthority(withCesr("qvi", authority.cesr.qvi.replaceAll(sig, flip(sig, 40))), expectAuth)).toEqual(
      invalid(`QVI credential: event #${parseInt(qviAnchor.ked.s, 16)} of the issuer's KEL: the controller signature does not verify with the issuer's key`),
    );
    // The body's KEL appears twice in the ECR stream (as issuee, then as issuer); every copy is tampered.
    const ecrAnchor = anchorIn(authority.cesr.ecr, vlei.credentials.ecr.said);
    expect(ecrAnchor.ked.i).toBe(vlei.agents.verifier.aid);
    const ecrSig = sigOf(ecrAnchor);
    expect(verifyAuthority(withCesr("ecr", authority.cesr.ecr.replaceAll(ecrSig, flip(ecrSig, 40))), expectAuth)).toEqual(
      invalid(`ECR credential: event #${parseInt(ecrAnchor.ked.s, 16)} of the issuer's KEL: the controller signature does not verify with the issuer's key`),
    );
  });

  it("rejects a KEL event with one byte changed, and a root inception carrying another key", () => {
    const k = qviAnchor.ked;
    const changed = qviAnchor.raw.replace(`"p":"${k.p}"`, `"p":"${flip(k.p, 10)}"`);
    expect(changed).not.toBe(qviAnchor.raw);
    expect(verifyAuthority(withCesr("qvi", authority.cesr.qvi.replaceAll(qviAnchor.raw, changed)), expectAuth)).toEqual(
      invalid(`QVI credential: event #${parseInt(k.s, 16)} of the issuer's KEL: SAID does not match its content`),
    );
    const icp = parseCesr(authority.cesr.qvi).find((m) => m.ked.t === "icp" && m.ked.i === DEMO_TRUST_ANCHOR) as Message;
    const otherKey = "D" + base64url(new Uint8Array([0, ...ed25519.getPublicKey(new Uint8Array(32).fill(7))])).slice(1);
    const swapped = icp.raw.replace(icp.ked.k[0], otherKey);
    expect(verifyAuthority(withCesr("qvi", authority.cesr.qvi.replaceAll(icp.raw, swapped)), expectAuth)).toEqual(
      invalid("QVI credential: the issuer's inception event is not self-addressing (its SAID is not the issuer's AID)"),
    );
  });

  it("fails closed when the issuer's KEL, or its inception event, is missing from the stream", () => {
    const msgs = parseCesr(authority.cesr.qvi);
    const noKel = rebuild(msgs.filter((m) => !(isKel(m) && m.ked.i === DEMO_TRUST_ANCHOR)));
    expect(verifyAuthority(withCesr("qvi", noKel), expectAuth)).toEqual(invalid("QVI credential: issuance not anchored in the issuer's KEL"));
    const noIcp = rebuild(msgs.filter((m) => !(m.ked.t === "icp" && m.ked.i === DEMO_TRUST_ANCHOR)));
    expect(verifyAuthority(withCesr("qvi", noIcp), expectAuth)).toEqual(invalid("QVI credential: the issuer's inception event is not in the evidence"));
  });
});

// ------------------------------------------------------------------ witness receipts (exported evidence)
// Every exported KEL event carries `-VBq-AAB<controller sig>-BAD<3 witness sigs>-EAB<first seen>`;
// the AIDs name 3 witnesses with threshold 2 (bt "2").
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const cnt = (n: number) => B64[n >> 6] + B64[n & 63];
/** Rewrites the witness signatures of an exported attachment (and adds `extra` groups), keeping the rest byte-exact. */
function rewitness(atc: string, fn: (sigs: string[]) => string[], extra = ""): string {
  expect(atc.startsWith("-V") && atc.slice(4, 8) === "-AAB" && atc.slice(96, 98) === "-B").toBe(true);
  const inner = atc.slice(4);
  const n = parseAttachments(atc).witness.length;
  const sigs = parseAttachments(atc).witness.map((s) => s.qb64);
  const next = fn(sigs);
  const body = inner.slice(0, 92) + (next.length ? "-B" + cnt(next.length) + next.join("") : "") + extra + inner.slice(96 + 88 * n);
  return "-V" + cnt(body.length / 4) + body;
}
/** A valid Ed25519 signature over `raw` at witness index `i`, by a key that is not a witness. */
const outsiderSig = (raw: string, i: number) => "A" + B64[i] + base64url(new Uint8Array([0, 0, ...ed25519.sign(utf8(raw), new Uint8Array(32).fill(9))])).slice(2);
const corrupt = (sigs: string[], ...at: number[]) => sigs.map((s, k) => (at.includes(k) ? flip(s, 40) : s));
/** The stream with the attachment of every copy of the KEL event `raw` rewritten. */
const editAtc = (stream: string, raw: string, fn: (atc: string) => string) =>
  rebuild(parseCesr(stream).map((m) => (m.raw === raw ? { ...m, atc: fn(m.atc ?? "") } : m)));

describe("check 6: witness receipts on the anchor event and the auditor's inception", () => {
  const exp = { credSAID: anchor.credSAID, auditorAID: anchor.auditor, kelSeq: BigInt(anchor.kelSeq), auditorAidHash: hashString(anchor.auditor) };
  const full = { ...anchor, kel: exportedKel, establishmentRaw: auditorIcp, establishmentAttachment: auditorIcpAtc } as AnchorEvidence;
  const withAnchorWits = (fn: (s: string[]) => string[], extra = "") => ({ ...full, kelAttachment: rewitness(anchor.kelAttachment as string, fn, extra) });
  const failing = (detail: string) => ({ ok: false, code: "ANCHOR_NOT_FOUND", detail });

  it("the exported anchor and inception carry 3 of 3 witness signatures (threshold 2)", () => {
    expect(verifyAnchor(full, exp).detail).toContain("witness receipts: 3 of 3 on this event, 3 of 3 on the inception event (threshold 2)");
  });
  it("one receipt removed or corrupted: 2 of 3 still meet the threshold", () => {
    expect(verifyAnchor(withAnchorWits((s) => s.slice(1)), exp)).toMatchObject({ ok: true, detail: expect.stringContaining("2 of 3 on this event") });
    expect(verifyAnchor(withAnchorWits((s) => corrupt(s, 1)), exp)).toMatchObject({ ok: true, detail: expect.stringContaining("2 of 3 on this event") });
  });
  it("two corrupted, or a signature by a key outside the witness list: below the threshold", () => {
    expect(verifyAnchor(withAnchorWits((s) => corrupt(s, 0, 2)), exp)).toEqual(failing("anchor event: 1 of 3 witness signatures verify, the threshold is 2"));
    const raw = anchor.event.raw;
    expect(verifyAnchor(withAnchorWits((s) => [s[0], outsiderSig(raw, 1), outsiderSig(raw, 2)]), exp)).toEqual(
      failing("anchor event: 1 of 3 witness signatures verify, the threshold is 2"),
    );
    // a receipt couple by the outsider's own (non-witness) AID is not counted either
    const outsider = "B" + base64url(new Uint8Array([0, ...ed25519.getPublicKey(new Uint8Array(32).fill(9))])).slice(1);
    const couple = "-CAB" + outsider + "0B" + outsiderSig(raw, 0).slice(2);
    expect(verifyAnchor(withAnchorWits((s) => [s[0]], couple), exp)).toEqual(failing("anchor event: 1 of 3 witness signatures verify, the threshold is 2"));
  });
  it("no receipts: stripped from the anchor event, no attachment at all, or none for the inception", () => {
    expect(verifyAnchor(withAnchorWits(() => []), exp)).toEqual(failing("anchor event: no witness receipts in the evidence"));
    expect(verifyAnchor({ ...full, kelAttachment: undefined }, exp)).toEqual(failing("anchor event: no witness receipts in the evidence"));
    // the inception's receipts: in `kel` (event #0), or, for event #1 without `kel`, in establishmentAttachment
    const kelIcp = (fn: (s: string[]) => string[]) => ({ ...full, kel: exportedKel.map((m, i) => (i === 0 ? { ...m, atc: rewitness(m.atc as string, fn) } : m)) });
    expect(verifyAnchor(kelIcp(() => []), exp)).toEqual(failing("event #0 of the auditor's KEL: no witness receipts in the evidence"));
    expect(verifyAnchor(kelIcp((s) => corrupt(s, 0, 1)), exp)).toEqual(failing("event #0 of the auditor's KEL: 1 of 3 witness signatures verify, the threshold is 2"));
    expect(verifyAnchor({ ...legacy1, establishmentAttachment: undefined }, exp1)).toEqual(
      failing("the auditor's inception event: no witness receipts in the evidence"),
    );
    expect(verifyAnchor({ ...legacy1, establishmentAttachment: rewitness(auditorIcpAtc as string, (s) => corrupt(s, 0, 1)) }, exp1)).toEqual(
      failing("the auditor's inception event: 1 of 3 witness signatures verify, the threshold is 2"),
    );
  });
});

describe("check 7: witness receipts on every KEL event walked", () => {
  const qviAnchor = anchorIn(authority.cesr.qvi, vlei.credentials.qvi.said);
  const sn = parseInt(qviAnchor.ked.s, 16);
  const rootIcp = parseCesr(authority.cesr.qvi).find((m) => m.ked.t === "icp" && m.ked.i === DEMO_TRUST_ANCHOR) as Message;
  const qviWith = (raw: string, fn: (s: string[]) => string[]) => withCesr("qvi", editAtc(authority.cesr.qvi, raw, (a) => rewitness(a, fn)));

  it("the exported chain: every walked event carries the threshold of witness signatures", () => {
    expect(qviAnchor.ked.i).toBe(DEMO_TRUST_ANCHOR);
    expect(parseAttachments(qviAnchor.atc ?? "").witness.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(verifyAuthority(authority, expectAuth).detail).toContain("every event with its witness threshold of receipts");
  });
  it("one receipt removed or corrupted on the root's anchor of the QVI credential: still 2 of 3", () => {
    expect(verifyAuthority(qviWith(qviAnchor.raw, (s) => s.slice(0, 2)), expectAuth)).toMatchObject({ ok: true });
    expect(verifyAuthority(qviWith(qviAnchor.raw, (s) => corrupt(s, 2)), expectAuth)).toMatchObject({ ok: true });
  });
  it("two corrupted: fails with the threshold reason", () => {
    expect(verifyAuthority(qviWith(qviAnchor.raw, (s) => corrupt(s, 0, 1)), expectAuth)).toEqual(
      invalid(`QVI credential: event #${sn} of the issuer's KEL: 1 of 3 witness signatures verify, the threshold is 2`),
    );
  });
  it("receipts stripped from the root's inception: fails", () => {
    expect(verifyAuthority(qviWith(rootIcp.raw, () => []), expectAuth)).toEqual(invalid("QVI credential: event #0 of the issuer's KEL: no witness receipts in the evidence"));
  });
  it("signatures by a key outside the witness list are not counted (the body's anchor of the ECR, every copy)", () => {
    const ecrAnchor = anchorIn(authority.cesr.ecr, vlei.credentials.ecr.said);
    const raw = ecrAnchor.raw;
    const forged = editAtc(authority.cesr.ecr, raw, (a) => rewitness(a, (s) => [outsiderSig(raw, 0), s[1], outsiderSig(raw, 2)]));
    expect(verifyAuthority(withCesr("ecr", forged), expectAuth)).toEqual(
      invalid(`ECR credential: event #${parseInt(ecrAnchor.ked.s, 16)} of the issuer's KEL: 1 of 3 witness signatures verify, the threshold is 2`),
    );
  });
});

// Attack 4 evidence exported from the local KERI run (verifier/src/setup-impostor.ts); skipped until it exists.
const impDir = new URL("../../fixtures/evidence/impostor/", import.meta.url);
const impVleiUrl = new URL("../../fixtures/vlei-impostor.json", import.meta.url);
const hasImpostor = existsSync(new URL("authority-bundle.json", impDir)) && existsSync(impVleiUrl);

describe.skipIf(!hasImpostor)("attack 4: the impostor's exported chain (fixtures/evidence/impostor)", () => {
  const imp = () => {
    const iv = JSON.parse(readFileSync(impVleiUrl, "utf8"));
    const bundle = JSON.parse(readFileSync(new URL("authority-bundle.json", impDir), "utf8")) as AuthorityEvidence;
    const x = {
      auditorAID: iv.agents.impAuditor.aid as string,
      verifierLEI: iv.agents.impBody.lei as string,
      cnCode: "7318",
      onchain: {
        leCredSaidHash: hashString(iv.credentials.leBody.said),
        accreditationSaidHash: hashString(iv.credentials.accreditation.said),
        ecrSaidHash: hashString(iv.credentials.ecr.said),
      },
    };
    return { iv, bundle, x };
  };
  it("is a well-formed chain under the impostor's own root, and fails against the pinned root with the pinned-root reason", () => {
    const { iv, bundle, x } = imp();
    expect(iv.synthetic).toBeUndefined();
    expect(bundle.trustAnchor).toBe(iv.trustAnchor);
    expect(iv.trustAnchor).not.toBe(DEMO_TRUST_ANCHOR);
    expect(verifyAuthority(bundle, { ...x, trustAnchor: iv.trustAnchor })).toMatchObject({ ok: true });
    expect(verifyAuthority(bundle, { ...x, trustAnchor: DEMO_TRUST_ANCHOR })).toEqual({
      ok: false,
      code: "AUTHORITY_INVALID",
      detail: "QVI credential not issued by the configured root of trust",
    });
  });
  it("its exported anchor (when present) passes check 6 with the key from the impostor auditor's inception event", () => {
    const { iv } = imp();
    const f = readdirSync(impDir).find((n) => n.startsWith("anchor-"));
    if (!f) return;
    const a = JSON.parse(readFileSync(new URL(f, impDir), "utf8")) as AnchorEvidence;
    const icp = parseCesr(readFileSync(new URL("cred-ecr.cesr", impDir), "utf8")).find((m) => m.ked.t === "icp" && m.ked.i === a.auditor);
    expect(a.auditor).toBe(iv.agents.impAuditor.aid);
    const r = verifyAnchor({ ...a, establishmentRaw: icp?.raw, establishmentAttachment: icp?.atc }, {
      credSAID: a.credSAID,
      auditorAID: a.auditor,
      kelSeq: BigInt(a.kelSeq),
      auditorAidHash: hashString(a.auditor),
    });
    // the impostor's anchor carries 2 witness signatures, which meets its threshold of 2
    expect(r).toMatchObject({ ok: true, detail: expect.stringContaining("2 of 3 on this event") });
  });

  /**
   * A forger's rewrite of the streams: substitutes SAIDs as text, then gives every message that changed a
   * fresh SAID (its edge block too) and substitutes those, until nothing changes. Signatures are left as
   * they were; self-addressing messages (icp, vcp) keep their identifier.
   */
  function reSaid(cesr: AuthorityEvidence["cesr"], subst: Map<string, string>): AuthorityEvidence["cesr"] {
    const out = { ...cesr };
    for (let map = subst; map.size; ) {
      const next = new Map<string, string>();
      for (const k of Object.keys(out) as CesrKey[]) {
        let text = out[k];
        for (const [a, b] of map) text = text.replaceAll(a, b);
        const msgs = parseCesr(text).map((m) => {
          const ked = m.ked;
          if (ked.d === ked.i) return m;
          if (ked.e?.d) ked.e.d = computeSaid(ked.e);
          const d = computeSaid(ked);
          if (d !== ked.d) next.set(ked.d, d);
          ked.d = d;
          return { ...m, raw: JSON.stringify(ked) };
        });
        out[k] = rebuild(msgs);
      }
      map = next;
    }
    return out;
  }

  /** The impostor's chain with its QVI credential rewritten to name the pinned root as issuer, every SAID downstream recomputed. */
  const claimPinnedRoot = () => {
    const { iv, bundle } = imp();
    const q = parseCesr(bundle.cesr.qvi).filter((m) => m.ked.v.startsWith("ACDC")).at(-1) as Message;
    const ked: Record<string, any> = { ...q.ked, i: DEMO_TRUST_ANCHOR };
    ked.d = computeSaid(ked);
    const raw = JSON.stringify(ked);
    const swapped = Object.fromEntries(Object.entries(bundle.cesr).map(([k, s]) => [k, s.replaceAll(q.raw, raw)])) as AuthorityEvidence["cesr"];
    const cesr = reSaid(swapped, new Map([[q.ked.d, ked.d]]));
    const x = { trustAnchor: DEMO_TRUST_ANCHOR, auditorAID: iv.agents.impAuditor.aid as string, verifierLEI: iv.agents.impBody.lei as string, cnCode: "7318" };
    return { forged: { ...bundle, trustAnchor: DEMO_TRUST_ANCHOR, cesr }, x, qviSaid: ked.d, impRoot: q.ked.i as string };
  };

  it("a chain forged to claim the pinned root fails without the root's signature, whatever KEL it carries", () => {
    const { forged, x, qviSaid, impRoot } = claimPinnedRoot();
    expect(impRoot).not.toBe(DEMO_TRUST_ANCHOR);
    // Everything but the root's signature lines up: with no KEL of the pinned root, that is the reason.
    expect(verifyAuthority(forged, x)).toEqual(invalid("QVI credential: the issuer's KEL is not in the evidence"));

    // The root's real KEL (public), extended by an event anchoring the forged issuance, signed with another key.
    const rootKel = parseCesr(authority.cesr.qvi).filter((m) => isKel(m) && m.ked.i === DEMO_TRUST_ANCHOR);
    const last = rootKel[rootKel.length - 1].ked;
    const iss = parseCesr(forged.cesr.qvi).find((m) => m.ked.t === "iss" && m.ked.i === qviSaid) as Message;
    const sn = parseInt(last.s, 16) + 1;
    const ixn = keriEvent({ t: "ixn", d: "", i: DEMO_TRUST_ANCHOR, s: sn.toString(16), p: last.d, a: [{ i: qviSaid, s: "0", d: iss.ked.d }] });
    const ixnRaw = JSON.stringify(ixn);
    const withRootKel = rebuild(rootKel) + ixnRaw + signWith(ixnRaw, new Uint8Array(32).fill(9)) + forged.cesr.qvi;
    expect(verifyAuthority({ ...forged, cesr: { ...forged.cesr, qvi: withRootKel } }, x)).toEqual(
      invalid(`QVI credential: event #${sn} of the issuer's KEL: the controller signature does not verify with the issuer's key`),
    );

    // The impostor root's own KEL relabelled as the pinned root's: its inception no longer hashes to the AID.
    const relabelled = reSaid(forged.cesr, new Map([[impRoot, DEMO_TRUST_ANCHOR]]));
    expect(verifyAuthority({ ...forged, cesr: relabelled }, x)).toEqual(
      invalid("QVI credential: the issuer's inception event is not self-addressing (its SAID is not the issuer's AID)"),
    );
  });
});

describe("check 7: the bundle path in the proof", () => {
  const ctx = {
    core: { issuer: { auditorAID: anchor.auditor, verifierLEI: "ZZZZ00EUVERIFDEMO152" } },
    disclosed: { cnCode: "7318" },
    reader: {},
  } as never;

  it("a path outside evidence/ is refused before anything is loaded", async () => {
    const bad = [
      "../secret.json",
      "/evidence/authority-bundle.json",
      "evidence/../../etc/passwd",
      "evidence/..",
      "https://attacker.example/evidence/x.json",
      "//attacker.example/evidence/x.json",
      "evidence/a b.json",
      "evidence/%2e%2e/x.json",
      "evidence\\x.json",
      "evidence/",
      "authority-bundle.json",
    ];
    for (const path of bad) {
      expect(isSafeBundlePath(path), path).toBe(false);
      const loadBundle = vi.fn(async () => "{}");
      const r = await vleiCheckers({ loadBundle }).authority!({ bundle: path, sha256: sha256Hex("{}") }, ctx);
      expect(r, path).toMatchObject({ status: "fail", code: "AUTHORITY_INVALID" });
      expect(r.detail).toContain("path is not allowed");
      expect(loadBundle).not.toHaveBeenCalled();
    }
  });

  it("the demo's paths are allowed and loaded", async () => {
    for (const path of ["evidence/authority-bundle.json", "evidence/impostor/authority-bundle.json"]) {
      expect(isSafeBundlePath(path)).toBe(true);
      const loadBundle = vi.fn(async () => "{}");
      const r = await vleiCheckers({ loadBundle }).authority!({ bundle: path, sha256: "00" }, ctx);
      expect(loadBundle).toHaveBeenCalledWith(path);
      expect(r.detail).toContain("does not match its hash");
    }
  });
});

// vleiCheckers is what the CLI and the hosted page plug into verifyPresentation for checks 6-8;
// here it runs in process on the Sepolia demo proof, with the registered report and the allowlist
// reads stubbed.
describe("checks 6-8: vleiCheckers on the Sepolia demo proof", () => {
  const fixtures = new URL("../../fixtures/", import.meta.url);
  const proof = JSON.parse(readFileSync(new URL("sepolia-demo-proof.json", fixtures), "utf8"));
  const core = JSON.parse(proof.core);
  const disclosed = Object.fromEntries(proof.disclosures.map((d: string) => [decodeDisclosure(d).name, decodeDisclosure(d).value]));
  const ref = proof.authorityEvidence as { bundle: string; sha256: string };
  const bundleText = readFileSync(new URL(ref.bundle, fixtures), "utf8");
  const loadBundle = async (path: string) => readFileSync(new URL(path, fixtures), "utf8");
  const report = {
    kelSeq: BigInt(proof.anchorEvidence.kelSeq),
    auditorAidHash: hashString(core.issuer.auditorAID),
    issuerLeiHash: hashString("issuer LEI hash (stub)"),
    registeredAt: BigInt(Date.parse("2026-10-06T00:00:00Z") / 1000),
  };
  const allowlist = (over: Partial<typeof expectAuth.onchain> = {}) => {
    const o = { ...expectAuth.onchain, ...over };
    return {
      institution: vi.fn(async () => ({ leCredSaidHash: o.leCredSaidHash, accreditationSaidHash: o.accreditationSaidHash })),
      auditor: vi.fn(async () => ({ ecrSaidHash: o.ecrSaidHash })),
    };
  };
  const ctxOf = (over: Record<string, unknown> = {}) => ({ core, disclosed, rejected: [], report, reader: allowlist(), ...over }) as never;

  it("check 6: the proof's anchor passes against the registered kelSeq and auditor; another kelSeq, another auditor or no report fails", () => {
    const anchor6 = vleiCheckers().anchor!;
    expect(anchor6(proof.anchorEvidence, ctxOf())).toMatchObject({ index: 6, status: "pass", code: "" });
    expect(anchor6(proof.anchorEvidence, ctxOf({ report: { ...report, kelSeq: report.kelSeq + 1n } }))).toMatchObject({ status: "fail", code: "ANCHOR_NOT_FOUND" });
    expect(anchor6(proof.anchorEvidence, ctxOf({ report: { ...report, auditorAidHash: hashString("EAnotherAuditor") } }))).toMatchObject({ status: "fail" });
    expect(anchor6(proof.anchorEvidence, ctxOf({ report: undefined }))).toMatchObject({ status: "fail", code: "ANCHOR_NOT_FOUND" });
  });

  it("check 7: the referenced bundle (hash-checked) and the same bundle inline pass, with the on-chain allowlist hashes compared", async () => {
    expect(sha256Hex(bundleText)).toBe(ref.sha256);
    const reader = allowlist();
    const r = await vleiCheckers({ loadBundle }).authority!(ref, ctxOf({ reader }));
    expect(r).toMatchObject({ index: 7, status: "pass", detail: expect.stringContaining("hashes match the on-chain allowlist") });
    expect(reader.institution).toHaveBeenCalledWith(report.issuerLeiHash);
    expect(reader.auditor).toHaveBeenCalledWith(report.auditorAidHash, report.issuerLeiHash);
    // an uppercase hash in the proof is the same hash
    expect(await vleiCheckers({ loadBundle }).authority!({ ...ref, sha256: ref.sha256.toUpperCase() }, ctxOf())).toMatchObject({ status: "pass" });
    // inline evidence needs no loader
    expect(await vleiCheckers().authority!(JSON.parse(bundleText), ctxOf())).toMatchObject({ status: "pass" });
  });

  it("check 7: fails on an allowlist hash that differs, an accreditation expired at registration, a changed file, or a reference with no loader", async () => {
    const auth = vleiCheckers({ loadBundle }).authority!;
    for (const [over, reason] of [
      [{ ecrSaidHash: hashString("another ECR") }, "allowlist ECR hash differs"],
      [{ leCredSaidHash: hashString("another LE") }, "allowlist LE hash differs"],
      [{ accreditationSaidHash: hashString("another accreditation") }, "allowlist accreditation hash differs"],
    ] as const) {
      expect(await auth(ref, ctxOf({ reader: allowlist(over) }))).toMatchObject({ status: "fail", code: "AUTHORITY_INVALID", detail: expect.stringContaining(reason) });
    }
    const late = { ...report, registeredAt: BigInt(Date.parse("2100-01-01T00:00:00Z") / 1000) };
    expect(await auth(ref, ctxOf({ report: late }))).toMatchObject({ status: "fail", detail: "accreditation had expired at registration" });
    expect(await vleiCheckers({ loadBundle: async () => bundleText + " " }).authority!(ref, ctxOf())).toMatchObject({
      status: "fail",
      detail: "the authority evidence file does not match its hash in the proof",
    });
    expect(await vleiCheckers().authority!(ref, ctxOf())).toMatchObject({ status: "fail", detail: expect.stringContaining("cannot be loaded here") });
  });

  it("check 7: a failed allowlist read is an error, never a pass, and is not left unhandled when the bundle check fails first", async () => {
    const down = { institution: () => Promise.reject(new Error("rpc down")), auditor: () => Promise.reject(new Error("rpc down")) };
    await expect(vleiCheckers({ loadBundle }).authority!(ref, ctxOf({ reader: down }))).rejects.toThrow("rpc down");
    const r = await vleiCheckers({ loadBundle }).authority!({ ...ref, sha256: "00" }, ctxOf({ reader: down }));
    expect(r).toMatchObject({ status: "fail", detail: expect.stringContaining("does not match its hash") });
  });

  it("check 7 without a registered report: the chain is checked, without the allowlist comparison", async () => {
    const reader = allowlist();
    const r = await vleiCheckers({ loadBundle }).authority!(ref, ctxOf({ report: undefined, reader }));
    expect(r.status).toBe("pass");
    expect(r.detail).not.toContain("on-chain allowlist");
    expect(reader.institution).not.toHaveBeenCalled();
  });

  it("check 8: the proof's report extract reconciles; a changed extract is flagged for review", () => {
    const rec = vleiCheckers().reconciliation!;
    expect(rec(proof.reportExtract, ctxOf())).toMatchObject({ index: 8, status: "pass", code: "" });
    const changed = { ...proof.reportExtract, specificEmbeddedEmissionsPerCn: [{ cnCode: "7318", value: "1.2" }] };
    expect(rec(changed, ctxOf())).toMatchObject({ index: 8, status: "warn", code: expect.stringMatching(/^CONSISTENCY_WARNING/) });
  });
});

// A TEST identifier's KEL produced by keripy 1.2.13 (sdk/test/fixtures/kel-rotation/SOURCE.md): icp with
// witnesses [wan, wil] (bt 2), ixn, rot cutting wil and adding wes, ixn #3 anchoring `credSAID`. The two
// counter-example signatures over event #3 were made by keripy too: by the rotated-out key, and by wil.
describe("check 6: the auditor's key state walked through a rotation (keripy test KEL)", () => {
  const rdir = new URL("./fixtures/kel-rotation/", import.meta.url);
  const stream = readFileSync(new URL("kel.cesr", rdir), "utf8");
  const cx = JSON.parse(readFileSync(new URL("counter-examples.json", rdir), "utf8"));
  const msgs = parseCesr(stream);
  const aid: string = msgs[0].ked.i;
  const ev = anchorEvidenceFromKel(stream, aid, 3, cx.credSAID);
  const exp = { credSAID: cx.credSAID, auditorAID: aid, kelSeq: 3n, auditorAidHash: hashString(aid) };
  const failing = (detail: string) => ({ ok: false, code: "ANCHOR_NOT_FOUND", detail });
  const [icpKey, rotKey] = [msgs[0].ked.k[0], msgs[2].ked.k[0]];
  /** The KEL with event #sn replaced (its SAID recomputed, as an attacker would), or dropped. */
  const withEvent = (sn: number, edit: ((k: Record<string, any>) => void) | null) => ({
    ...ev,
    kel: ev.kel!.flatMap((m) => {
      const ked = JSON.parse(m.raw);
      if (parseInt(ked.s, 16) !== sn) return [m];
      if (!edit) return [];
      edit(ked);
      ked.d = computeSaid(ked);
      return [{ raw: JSON.stringify(ked), atc: m.atc }];
    }),
  });

  it("the fixture is a rotation: same AID, key changed at event #2, witness wil replaced by wes", () => {
    expect(msgs.map((m) => m.ked.t)).toEqual(["icp", "ixn", "rot", "ixn"]);
    expect(rotKey).not.toBe(icpKey);
    expect(msgs[2].ked).toMatchObject({ br: [cx.witnesses.wil], ba: [cx.witnesses.wes], bt: "2" });
  });
  it("1: the anchor after the rotation passes with the key in force at event #3", () => {
    const r = verifyAnchor(ev, exp);
    expect(r).toEqual({
      ok: true,
      code: "",
      detail:
        "KERI event #3 by the auditor anchors this credential; Ed25519 signature verified with the key in force at event #3 (1 rotation since inception); witness receipts: 2 of 2 on this event (threshold 2), and the threshold on each earlier event",
    });
  });
  it("2: an anchor signed with the rotated-out key is rejected; without `kel` an anchor after event #1 fails", () => {
    // the counter-example is a genuine signature by the inception key over event #3
    expect(ed25519.verify(decodeIndexedSig(cx.oldKeySignatureOnEvent3), utf8(ev.event.raw), decodeVerKey(icpKey))).toBe(true);
    const old = { ...ev, signatures: [{ qb64: cx.oldKeySignatureOnEvent3, index: 0 }], signingKeys: [{ qb64: icpKey }] };
    expect(verifyAnchor(old, exp)).toEqual(
      failing("the event's signature does not verify with the auditor's key in force at event #3 (1 rotation since inception)"),
    );
    const { kel: _k, ...legacy } = ev;
    expect(verifyAnchor({ ...legacy, signingKeys: [{ qb64: rotKey }], establishmentRaw: msgs[0].raw, establishmentAttachment: msgs[0].atc }, exp)).toEqual(
      failing("the auditor's KEL events #0 to #2 are not in the evidence, so a key rotation before the anchor cannot be ruled out"),
    );
  });
  it("L4 (H1 regression): no `kel`, the rotated-out key and the inception's witnesses, wil included, still fail", () => {
    // The downgrade of the 2026-10-07 review: the evidence leaves the KEL out and presents the inception, the
    // inception key's signature over #3 and receipts from the inception's list [wan, wil]. Before the fix
    // this passed ("2 of 2 on this event"); every signature here is a genuine keripy signature.
    const wan = parseAttachments(ev.kelAttachment!).witness.find((s) => s.index === 0)!.qb64;
    const { kel: _k, ...legacy } = ev;
    const downgrade = {
      ...legacy,
      signatures: [{ qb64: cx.oldKeySignatureOnEvent3, index: 0 }],
      signingKeys: [{ qb64: icpKey }],
      kelAttachment: "-BAC" + wan + "AB" + cx.removedWitnessWilSignatureOnEvent3.slice(2),
      establishmentRaw: msgs[0].raw,
      establishmentAttachment: msgs[0].atc,
    };
    expect(verifyAnchor(downgrade, exp)).toEqual(
      failing("the auditor's KEL events #0 to #2 are not in the evidence, so a key rotation before the anchor cannot be ruled out"),
    );
    // and with the KEL, the same signature and receipts fail on the key in force
    expect(verifyAnchor({ ...downgrade, kel: ev.kel }, exp)).toEqual(
      failing("the event's signature does not verify with the auditor's key in force at event #3 (1 rotation since inception)"),
    );
  });
  it("3: an event after inception changed (its SAID no longer matches) is rejected", () => {
    const tampered = { ...ev, kel: ev.kel!.map((m, i) => (i === 1 ? { ...m, raw: m.raw.replace(cx.sealBeforeRotation, cx.credSAID) } : m)) };
    expect(verifyAnchor(tampered, exp)).toEqual(failing("event #1 of the auditor's KEL: SAID does not match its content"));
  });
  it("4: the rotation left out: the sequence has a gap", () => {
    expect(verifyAnchor(withEvent(2, null), exp)).toEqual(failing("the auditor's KEL has no event #2"));
  });
  it("5: a rotation revealing a key other than the committed next key is rejected (pre-rotation)", () => {
    expect(verifyAnchor(withEvent(2, (k) => (k.k = [icpKey])), exp)).toEqual(
      failing("event #2 of the auditor's KEL: the rotation's key is not the one committed to by the prior next-key digest"),
    );
  });
  it("6: receipts count against the witness list after the rotation; wil, cut by it, is not counted", () => {
    const wan = parseAttachments(ev.kelAttachment!).witness.find((s) => s.index === 0)!.qb64;
    expect(ed25519.verify(decodeIndexedSig(cx.removedWitnessWilSignatureOnEvent3), utf8(ev.event.raw), decodeVerKey(cx.witnesses.wil))).toBe(true);
    const ctrl = "-AAB" + ev.signatures[0].qb64;
    // wan + wil meet bt 2 under the inception's list [wan, wil], not under the list in force [wan, wes]
    const oldList = ctrl + "-BAB" + wan + "-CAB" + cx.witnesses.wil + "0B" + cx.removedWitnessWilSignatureOnEvent3.slice(2);
    expect(verifyAnchor({ ...ev, kelAttachment: oldList }, exp)).toEqual(failing("anchor event: 1 of 2 witness signatures verify, the threshold is 2"));
    // the same signature at index 1 of the old list reads as wes's in the new one, and does not verify
    const indexed = ctrl + "-BAC" + wan + "AB" + cx.removedWitnessWilSignatureOnEvent3.slice(2);
    expect(verifyAnchor({ ...ev, kelAttachment: indexed }, exp)).toEqual(failing("anchor event: 1 of 2 witness signatures verify, the threshold is 2"));
  });
  it("7: kelSeq pointing at the rotation itself is rejected: the anchor must be an interaction event", () => {
    const atRot = anchorEvidenceFromKel(stream, aid, 2, cx.credSAID);
    expect(verifyAnchor(atRot, { ...exp, kelSeq: 2n })).toEqual(failing("anchor event is not an interaction event"));
  });
  it("another event at #3 in the KEL than the anchor, or a KEL that is not JSON, is rejected", () => {
    const fork = { ...ev, kel: [...ev.kel!, { raw: ev.event.raw.replace(cx.credSAID, cx.sealBeforeRotation) }] };
    expect(verifyAnchor(fork, exp)).toEqual(failing("the auditor's KEL has another event at #3"));
    expect(verifyAnchor({ ...ev, kel: [{ raw: "{" }] }, exp)).toEqual(failing("the auditor's KEL is not valid JSON"));
    expect(verifyAnchor({ ...ev, kel: [] }, exp)).toEqual(failing("the auditor's KEL is not in the evidence"));
  });
});

// NEGATIVE TESTS for the check 6 review of 2026-10-07 (M1, L1-L3). Each malicious KEL or anchor below is a real
// keripy event with fields changed (kel-rotation/kel.cesr), or the keripy-made material of kel-states/ (an
// event keripy refuses, built from event #3 of kel-rotation and signed by `kli sign`, SOURCE.md). None is evidence.
describe("check 6: KERI state rules on the anchor and the KEL (negative tests from keripy events)", () => {
  const rdir = new URL("./fixtures/kel-rotation/", import.meta.url);
  const sdir = new URL("./fixtures/kel-states/", import.meta.url);
  const stream = readFileSync(new URL("kel.cesr", rdir), "utf8");
  const cx = JSON.parse(readFileSync(new URL("counter-examples.json", rdir), "utf8"));
  const crafted = JSON.parse(readFileSync(new URL("crafted.json", sdir), "utf8"));
  const msgs = parseCesr(stream);
  const aid: string = msgs[0].ked.i;
  const ev = anchorEvidenceFromKel(stream, aid, 3, cx.credSAID);
  const exp = { credSAID: cx.credSAID, auditorAID: aid, kelSeq: 3n };
  const failing = (detail: string) => ({ ok: false, code: "ANCHOR_NOT_FOUND", detail });
  /** The event with fields changed and its size and SAID recomputed, as an attacker would. */
  const remade = (raw: string, edit: (k: Record<string, any>) => void): string => {
    const k = JSON.parse(raw);
    edit(k);
    k.d = SAID_DUMMY;
    k.v = `KERI10JSON${utf8(JSON.stringify(k)).length.toString(16).padStart(6, "0")}_`;
    k.d = computeSaid(k);
    return JSON.stringify(k);
  };
  /** ev with KEL event #sn replaced by `raw` (its attachment kept). */
  const kelWith = (sn: number, raw: string) => ({ ...ev, kel: ev.kel!.map((m) => (JSON.parse(m.raw).s === sn.toString(16) ? { ...m, raw } : m)) });
  /** A kel-states identifier's KEL and its crafted anchor, as evidence with or without `kel`. */
  const stateCase = (name: "eo" | "abandoned") => {
    const c = crafted[name];
    const kel = parseCesr(readFileSync(new URL(`${name}.cesr`, sdir), "utf8"));
    const evidence: AnchorEvidence = {
      credSAID: crafted.credSAID,
      auditor: c.aid,
      kelSeq: c.sn,
      event: { raw: c.raw },
      signatures: [{ qb64: c.signature, index: 0 }],
      signingKeys: [{ qb64: kel[kel.length - 1].ked.k[0] }],
      establishmentRaw: kel[0].raw,
      establishmentAttachment: kel[0].atc,
      kel: kel.map((m) => ({ raw: m.raw, atc: m.atc })),
    };
    return { c, kel, evidence, x: { credSAID: crafted.credSAID, auditorAID: c.aid, kelSeq: BigInt(c.sn) } };
  };

  it("M1 T1: an anchor whose `p` is not the SAID of event #sn-1 is rejected (keripy: prior digest mismatch)", () => {
    const raw = remade(ev.event.raw, (k) => (k.p = msgs[1].ked.d));
    expect(verifyAnchor({ ...ev, event: { raw } }, exp)).toEqual(failing("the anchor event does not link to event #2 of the auditor's KEL"));
  });
  it("M1 T2: an interaction event of an establishment-only AID is rejected, with or without `kel` (keripy rejects it too)", () => {
    const { c, kel, evidence, x } = stateCase("eo");
    expect(kel[0].ked.c).toEqual(["EO"]);
    expect(c.keripy).toContain("Unexpected non-establishment event");
    // a genuine signature by the AID's key: only the state rule rejects it
    expect(ed25519.verify(decodeIndexedSig(c.signature), utf8(c.raw), decodeVerKey(kel[0].ked.k[0]))).toBe(true);
    const eo = "the auditor's KEL is establishment-only, so an interaction event cannot anchor";
    expect(verifyAnchor(evidence, x)).toEqual(failing(eo));
    const { kel: _k, ...noKel } = evidence;
    expect(verifyAnchor(noKel, x)).toEqual(failing(eo));
  });
  it("M1 T3: any event after an abandonment (rotation with no next key) is rejected, in check 6 and in check 7's walk", () => {
    const { c, kel, evidence, x } = stateCase("abandoned");
    expect(kel.map((m) => [m.ked.t, m.ked.n])).toEqual([["icp", kel[0].ked.n], ["rot", []]]);
    expect(c.keripy).toContain("nontransferable  or abandoned state");
    expect(ed25519.verify(decodeIndexedSig(c.signature), utf8(c.raw), decodeVerKey(kel[1].ked.k[0]))).toBe(true);
    expect(verifyAnchor(evidence, x)).toEqual(failing("the auditor's AID has no next key (non-transferable or abandoned), so no later event is valid"));
    // check 7 walks the same code: the crafted event as the issuer's event #2
    const walked = [...kel, { raw: c.raw, ked: JSON.parse(c.raw), atc: "-AAB" + c.signature }];
    expect(keyStateAt(walked, c.aid, 2)).toEqual({
      ok: false,
      reason: "event #2 of the issuer's KEL: the issuer's AID has no next key (non-transferable or abandoned) before this event",
    });
    expect(keyStateAt(kel, c.aid, 1)).toMatchObject({ ok: true, transferable: false, rotations: 1, last: kel[1].ked.d });
  });
  it("L1 T4: a rotation that cuts and adds the same witness is rejected (keripy: intersecting cuts and adds)", () => {
    const raw = remade(msgs[2].raw, (k) => (k.ba = [...k.ba, cx.witnesses.wil]));
    expect(verifyAnchor(kelWith(2, raw), exp)).toEqual(failing("event #2 of the auditor's KEL: the rotation cuts and adds the same witness"));
  });
  it("L1 T5: a next-key threshold the next keys cannot meet is rejected", () => {
    const raw = remade(msgs[2].raw, (k) => (k.nt = "2"));
    expect(verifyAnchor(kelWith(2, raw), exp)).toEqual(
      failing('event #2 of the auditor\'s KEL: only one next key with threshold "1", or none with threshold "0", is supported (nt "2")'),
    );
  });
  it("L2: a malformed `kel` or inception fails with a reason and never throws", () => {
    const cases: [unknown, string][] = [
      [{}, "the auditor's KEL is not a list of KERI events"],
      ["x", "the auditor's KEL is not a list of KERI events"],
      [[null], "the auditor's KEL is not a list of KERI events"],
      [[{ raw: msgs[0].raw, atc: 5 }], "the auditor's KEL is not a list of KERI events"],
      [[{ raw: "null" }], "the auditor's KEL is not valid JSON"],
      [[{ raw: "[]" }], "the auditor's KEL is not valid JSON"],
      [[{ raw: "{" }], "the auditor's KEL is not valid JSON"],
      [[{ raw: `{"i":"${aid}","t":"icp","s":"0"}` }], "event #0 of the auditor's KEL: size differs from its version string"],
    ];
    for (const [kel, detail] of cases) expect(verifyAnchor({ ...ev, kel } as unknown as AnchorEvidence, exp), JSON.stringify(kel)).toEqual(failing(detail));
    // an event without `d` reaches the SAID code, which throws; check 6 reports it instead
    const noD = (m: { raw: string }) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(m.raw)).filter(([k]) => k !== "d")));
    expect(verifyAnchor({ ...ev, kel: ev.kel!.map((m, i) => (i === 1 ? { ...m, raw: noD(m) } : m)) }, exp)).toMatchObject({
      ok: false,
      code: "ANCHOR_NOT_FOUND",
    });
    expect(verifyAnchor({ ...legacy1, establishmentRaw: "null" }, exp1)).toEqual(failing("inception event does not belong to the auditor"));
    expect(verifyAnchor({ ...legacy1, establishmentRaw: "{" }, exp1)).toMatchObject({ ok: false, detail: expect.stringContaining("could not be read") });
    expect(verifyAnchor({ ...ev, event: { raw: "null" } }, exp)).toEqual(failing("anchor event is not valid JSON"));
  });
  it("L3: `s` must be lowercase hex without leading zeros, on the anchor and in the KEL", () => {
    expect(verifyAnchor({ ...ev, event: { raw: remade(ev.event.raw, (k) => (k.s = "03")) } }, exp)).toEqual(failing("anchor event has an invalid sequence number"));
    expect(verifyAnchor({ ...ev, event: { raw: remade(ev.event.raw, (k) => (k.s = "0x3")) } }, exp)).toEqual(failing("anchor event has an invalid sequence number"));
    expect(verifyAnchor(kelWith(2, remade(msgs[2].raw, (k) => (k.s = "02"))), exp)).toEqual(
      failing("the auditor's KEL has an event with an invalid sequence number"),
    );
  });
  it("L3: two different events at the anchor's sequence number (duplicity) fail in the helper and in check 6", () => {
    const fork = remade(ev.event.raw, (k) => (k.a = [{ d: cx.sealBeforeRotation }]));
    const forked = stream + fork + (msgs[3].atc ?? "");
    expect(() => anchorEvidenceFromKel(forked, aid, 3, cx.credSAID)).toThrow("the KEL has two different events at #3");
    expect(verifyAnchor({ ...ev, kel: [...ev.kel!, { raw: fork }] }, exp)).toEqual(failing("the auditor's KEL has another event at #3"));
  });
});
