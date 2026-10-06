// Checks 6 and 7 against the evidence exported from the local KERI run (fixtures/evidence).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { hashString } from "../commitment.ts";
import { base64url, utf8 } from "../encoding.ts";
import { controllerSigs, parseAttachments, verifyIssuance } from "../kel.ts";
import { SAID_DUMMY, computeSaid } from "../said.ts";
import {
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
const anchorFile = readdirSync(dir).find((f) => f.startsWith("anchor-")) as string;
const anchor = JSON.parse(read(anchorFile)) as AnchorEvidence;
const auditorIcpMsg = parseCesr(read("cred-ecr.cesr")).find((m) => m.ked.t === "icp" && m.ked.i === anchor.auditor);
const auditorIcp = auditorIcpMsg?.raw;
/** The inception's attachment: its controller and witness signatures (the witness receipts check 6 needs). */
const auditorIcpAtc = auditorIcpMsg?.atc;

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
  it("verifies the exported anchor event, signature, key binding and witness receipts", () => {
    expect(auditorIcp).toBeDefined();
    const r = verifyAnchor({ ...anchor, establishmentRaw: auditorIcp, establishmentAttachment: auditorIcpAtc }, exp);
    expect(r).toMatchObject({ ok: true });
  });
  it("rejects an anchor without the auditor's inception event (key not bound)", () => {
    const { establishmentRaw: _drop, ...noEst } = { ...anchor, establishmentRaw: auditorIcp };
    expect(verifyAnchor(noEst as AnchorEvidence, exp)).toMatchObject({ ok: false, code: "ANCHOR_NOT_FOUND" });
  });
  it("rejects a changed event, another credential, another sequence number, another key", () => {
    const changed = anchor.event.raw.replace(anchor.credSAID, anchor.credSAID.slice(0, -1) + "A");
    expect(verifyAnchor({ ...anchor, event: { raw: changed } }, exp).ok).toBe(false);
    const full = { ...anchor, establishmentRaw: auditorIcp };
    expect(verifyAnchor(full, { ...exp, credSAID: "EOtherCredentialSaid000000000000000000000000" }).ok).toBe(false);
    expect(verifyAnchor(full, { ...exp, kelSeq: exp.kelSeq + 1n }).ok).toBe(false);
    const otherIcp = parseCesr(read("cred-ecr.cesr")).find((m) => m.ked.t === "icp" && m.ked.i !== anchor.auditor)?.raw;
    expect(verifyAnchor({ ...anchor, establishmentRaw: otherIcp }, exp).ok).toBe(false);
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
  const full = { ...anchor, establishmentRaw: auditorIcp, establishmentAttachment: auditorIcpAtc } as AnchorEvidence;
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
    expect(verifyAnchor({ ...full, establishmentAttachment: undefined }, exp)).toEqual(
      failing("the auditor's inception event: no witness receipts in the evidence"),
    );
    expect(verifyAnchor({ ...full, establishmentAttachment: rewitness(auditorIcpAtc as string, (s) => corrupt(s, 0, 1)) }, exp)).toEqual(
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
