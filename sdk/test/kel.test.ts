// sdk/kel.ts on hand-built KELs: the exported demo KELs have no rotation, so pre-rotation and the
// fail-closed cases (multi-key threshold, delegation, duplicity, establishment-only) are covered here.
// Events are built the way KERI builds them (field order, sizes, SAIDs, next-key digests over the qb64 key).
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { base64url, utf8 } from "../encoding.ts";
import { nextKeyDigest, verifyIssuance, verifyKel, type KelMessage } from "../kel.ts";
import { SAID_DUMMY, computeSaid } from "../said.ts";

type Json = Record<string, any>;

const secret = (n: number) => new Uint8Array(32).fill(n);
const keyOf = (n: number) => "D" + base64url(new Uint8Array([0, ...ed25519.getPublicKey(secret(n))])).slice(1);

function versioned(proto: "KERI" | "ACDC", body: Json, labels = ["d"]): Json {
  const ev: Json = { v: `${proto}10JSON000000_`, ...body };
  for (const l of labels) ev[l] = SAID_DUMMY;
  ev.v = `${proto}10JSON${utf8(JSON.stringify(ev)).length.toString(16).padStart(6, "0")}_`;
  const said = computeSaid(ev);
  for (const l of labels) ev[l] = said;
  return ev;
}

/** The event with an attachment group holding one controller signature (index 0) by key `n`. */
const signed = (ked: Json, n: number): KelMessage => {
  const raw = JSON.stringify(ked);
  return { raw, ked, atc: "-VAX-AAB" + base64url(new Uint8Array([0, 0, ...ed25519.sign(utf8(raw), secret(n))])) };
};
const unsigned = (ked: Json): KelMessage => ({ raw: JSON.stringify(ked), ked });

const icp = (key: number, next: number, extra: Json = {}) =>
  versioned("KERI", { t: "icp", d: "", i: "", s: "0", kt: "1", k: [keyOf(key)], nt: "1", n: [nextKeyDigest(keyOf(next))], bt: "0", b: [], c: [], a: [], ...extra }, ["d", "i"]);
const rot = (prior: Json, key: number, next: number) =>
  versioned("KERI", {
    t: "rot", d: "", i: prior.i, s: (parseInt(prior.s, 16) + 1).toString(16), p: prior.d,
    kt: "1", k: [keyOf(key)], nt: "1", n: [nextKeyDigest(keyOf(next))], bt: "0", br: [], ba: [], a: [],
  });
const ixn = (prior: Json, seals: Json[] = []) =>
  versioned("KERI", { t: "ixn", d: "", i: prior.i, s: (parseInt(prior.s, 16) + 1).toString(16), p: prior.d, a: seals });

describe("verifyKel: key state from the issuer's KEL", () => {
  const e0 = icp(1, 2);
  const e1 = rot(e0, 2, 3);
  const e2 = ixn(e1, [{ i: "ECredentialSaidForTheTest000000000000000000", s: "0", d: "EIssEventSaidForTheTest000000000000000000000" }]);

  it("walks a rotation: the new key is the one the inception committed to, and it signs the events after it", () => {
    expect(verifyKel([signed(e0, 1), signed(e1, 2), signed(e2, 2)], e0.i, 2)).toEqual({ ok: true, keys: [keyOf(2)] });
  });

  it("rejects a rotation to a key the prior event did not commit to, and an event signed with the rotated-out key", () => {
    const bad = rot(e0, 3, 4);
    expect(verifyKel([signed(e0, 1), signed(bad, 3)], e0.i, 1)).toEqual({
      ok: false,
      reason: "event #1 of the issuer's KEL: the rotation's key is not the one committed to by the prior next-key digest",
    });
    expect(verifyKel([signed(e0, 1), signed(e1, 1)], e0.i, 1)).toMatchObject({ ok: false, reason: expect.stringContaining("#1 of the issuer's KEL: the controller signature does not verify") });
    expect(verifyKel([signed(e0, 1), signed(e1, 2), signed(e2, 1)], e0.i, 2)).toMatchObject({ ok: false, reason: expect.stringContaining("#2 of the issuer's KEL: the controller signature does not verify") });
    expect(verifyKel([signed(e0, 1), signed(e1, 2), unsigned(e2)], e0.i, 2)).toMatchObject({ ok: false, reason: expect.stringContaining("#2 of the issuer's KEL: the controller signature") });
  });

  it("fails closed outside the supported key state: two keys, delegation, two events at one sn, ixn in an establishment-only KEL", () => {
    const twoKeys = versioned("KERI", { t: "icp", d: "", i: "", s: "0", kt: "1", k: [keyOf(1), keyOf(5)], nt: "1", n: [nextKeyDigest(keyOf(2))], bt: "0", b: [], c: [], a: [] }, ["d", "i"]);
    expect(verifyKel([signed(twoKeys, 1)], twoKeys.i, 0)).toMatchObject({ ok: false, reason: expect.stringContaining('only one signing key with threshold "1"') });
    const kt2 = icp(1, 2, { kt: "2" });
    expect(verifyKel([signed(kt2, 1)], kt2.i, 0)).toMatchObject({ ok: false, reason: expect.stringContaining('(kt "2")') });
    const dip = versioned("KERI", { t: "dip", d: "", i: "", s: "0", kt: "1", k: [keyOf(1)], nt: "1", n: [nextKeyDigest(keyOf(2))], bt: "0", b: [], c: [], a: [], di: e0.i }, ["d", "i"]);
    expect(verifyKel([signed(dip, 1)], dip.i, 0)).toEqual({ ok: false, reason: "the issuer is a delegated identifier, which is not supported" });
    const fork = ixn(e0, [{ d: "EOtherSealForTheTest000000000000000000000000" }]);
    expect(verifyKel([signed(e0, 1), signed(ixn(e0), 1), signed(fork, 1)], e0.i, 1)).toEqual({ ok: false, reason: "the issuer's KEL has two different events at #1" });
    const eo = icp(1, 2, { c: ["EO"] });
    expect(verifyKel([signed(eo, 1), signed(ixn(eo), 1)], eo.i, 1)).toEqual({ ok: false, reason: "event #1 of the issuer's KEL: interaction event in an establishment-only KEL" });
    expect(verifyKel([signed(e0, 1), signed(e2, 2)], e0.i, 2)).toEqual({ ok: false, reason: "the issuer's KEL has no event #1" });
  });
});

describe("verifyIssuance: registry and issuance anchored across a rotation", () => {
  const e0 = icp(1, 2);
  const vcp = versioned("KERI", { t: "vcp", d: "", i: "", ii: e0.i, s: "0", c: ["NB"], bt: "0", b: [], n: "A" + base64url(new Uint8Array([0, ...secret(8).slice(0, 16)])).slice(1) }, ["d", "i"]);
  const e1 = ixn(e0, [{ i: vcp.i, s: "0", d: vcp.d }]);
  const e2 = rot(e1, 2, 3);
  const acdc = versioned("ACDC", { d: "", i: e0.i, ri: vcp.i, s: "ESchemaSaidForTheTest00000000000000000000000", a: { i: "EIssueeAidForTheTest000000000000000000000000" } });
  const iss = versioned("KERI", { t: "iss", d: "", i: acdc.d, s: "0", ri: vcp.i, dt: "2026-10-06T00:00:00.000000+00:00" });
  const e3 = ixn(e2, [{ i: acdc.d, s: "0", d: iss.d }]);
  const stream = (anchor: KelMessage) => [signed(e0, 1), signed(e1, 1), signed(e2, 2), anchor, unsigned(vcp), unsigned(iss), unsigned(acdc)];

  it("passes when the post-rotation key signs the anchor of the issuance", () => {
    expect(verifyIssuance(stream(signed(e3, 2)), acdc)).toBe("");
  });

  it("rejects the anchor signed with the pre-rotation key, and an issuance no KEL event anchors", () => {
    expect(verifyIssuance(stream(signed(e3, 1)), acdc)).toBe("event #3 of the issuer's KEL: the controller signature does not verify with the issuer's key");
    expect(verifyIssuance(stream(signed(ixn(e2), 2)), acdc)).toBe("the issuer's KEL does not anchor this issuance");
  });
});
