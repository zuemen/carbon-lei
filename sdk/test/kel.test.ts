// sdk/kel.ts on hand-built KELs: the exported demo KELs have no rotation, so pre-rotation, witness
// rotation (br/ba) and the fail-closed cases (multi-key threshold, delegation, duplicity,
// establishment-only, witness threshold) are covered here.
// Events are built the way KERI builds them (field order, sizes, SAIDs, next-key digests over the qb64 key).
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { base64url, utf8 } from "../encoding.ts";
import {
  controllerSigs,
  decodeIndexedSig,
  decodeVerKey,
  nextKeyDigest,
  parseAttachments,
  verifyIssuance,
  verifyKel,
  type KelMessage,
} from "../kel.ts";
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

// ------------------------------------------------------------------ witness receipts
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const cnt = (n: number) => B64[n >> 6] + B64[n & 63];
/** Non-transferable witness AID ('B' + Ed25519 key) of secret `n`. */
const witOf = (n: number) => "B" + base64url(new Uint8Array([0, ...ed25519.getPublicKey(secret(n))])).slice(1);
const sigBody = (raw: string, n: number) => base64url(new Uint8Array([0, 0, ...ed25519.sign(utf8(raw), secret(n))])).slice(2);
/** Indexed signature (code A, index `i`) over `raw` by secret `n`. */
const idxSig = (raw: string, n: number, i: number) => "A" + B64[i] + sigBody(raw, n);
/** Non-transferable receipt couple: the AID of secret `n` and its signature (code 0B). */
const couple = (raw: string, n: number) => witOf(n) + "0B" + sigBody(raw, n);
/** An attachment group as KERIA exports it: controller signature, witness signatures, extra groups, first-seen couple. */
function attach(raw: string, ctrl: number, wits: [n: number, i: number][], extra = ""): string {
  const firstSeen = "-EAB" + "0A" + "A".repeat(22) + "1AAG" + "2026-10-05T04c33c05d917302p00c00";
  const witGroup = wits.length ? "-B" + cnt(wits.length) + wits.map(([n, i]) => idxSig(raw, n, i)).join("") : "";
  const body = "-AAB" + idxSig(raw, ctrl, 0) + witGroup + extra + firstSeen;
  return "-V" + cnt(body.length / 4) + body;
}
const witnessed = (ked: Json, ctrl: number, wits: [number, number][], extra = (_raw: string) => ""): KelMessage => {
  const raw = JSON.stringify(ked);
  return { raw, ked, atc: attach(raw, ctrl, wits, extra(raw)) };
};

describe("parseAttachments: CESR attachment groups", () => {
  const raw = JSON.stringify({ v: "KERI10JSON000000_" });
  it("reads controller signatures, witness signatures (index = position in the witness list) and receipt couples; skips first-seen couples", () => {
    const atc = attach(raw, 1, [[21, 0], [23, 2]], "-CAB" + couple(raw, 22));
    const a = parseAttachments(atc);
    expect(a.controller.map((s) => s.index)).toEqual([0]);
    expect(a.witness.map((s) => s.index)).toEqual([0, 2]);
    expect(a.receipts.map((r) => r.verfer)).toEqual([witOf(22)]);
    expect(controllerSigs(atc).map((x) => x.qb64)).toEqual(a.controller.map((x) => x.qb64));
    // the same groups without the -V wrapper, and with a trailing newline
    expect(parseAttachments(atc.slice(4) + "\n").witness).toHaveLength(2);
  });
  it("fails on an unknown group, a group count past the end, or text that is not a counter", () => {
    expect(() => parseAttachments("-ZAB" + idxSig(raw, 1, 0))).toThrow("unsupported attachment group -Z");
    expect(() => parseAttachments("-VAZ-AAB" + idxSig(raw, 1, 0))).toThrow("longer than the attachment");
    expect(() => parseAttachments("-AAB" + idxSig(raw, 1, 0) + "xyz")).toThrow("unexpected attachment text");
    expect(() => controllerSigs("-BAB" + idxSig(raw, 21, 0))).toThrow("no controller signatures");
  });
  it("a KEL event whose attachment cannot be read has no witness receipts counted", () => {
    const e0 = icp(1, 2, { bt: "1", b: [witOf(21)] });
    const m = witnessed(e0, 1, [[21, 0]]);
    expect(verifyKel([m], e0.i, 0).ok).toBe(true);
    // a wrong group count: the controller signature still reads (controllerSigs skips the counter), the receipts do not
    expect(verifyKel([{ ...m, atc: "-VAj" + m.atc!.slice(4) }], e0.i, 0)).toEqual({
      ok: false,
      reason: "event #0 of the issuer's KEL: its attachment cannot be read, so no witness receipt is counted",
    });
  });
});

describe("verifyKel: witness receipts", () => {
  const W = [21, 22, 23];
  const e0 = icp(1, 2, { bt: "2", b: W.map(witOf) });
  const e1 = ixn(e0, [{ d: "EAnchoredSaidForTheWitnessTest00000000000000" }]);
  const all: [number, number][] = [[21, 0], [22, 1], [23, 2]];
  const below = (sn: number, n: number) => ({ ok: false, reason: `event #${sn} of the issuer's KEL: ${n} of 3 witness signatures verify, the threshold is 2` });

  it("passes with all witness signatures, and with 2 of 3 when one is missing or corrupt (threshold 2)", () => {
    expect(verifyKel([witnessed(e0, 1, all), witnessed(e1, 1, all)], e0.i, 1)).toEqual({ ok: true, keys: [keyOf(1)] });
    expect(verifyKel([witnessed(e0, 1, all), witnessed(e1, 1, [[21, 0], [23, 2]])], e0.i, 1).ok).toBe(true);
    // index 1 signed by witness 23: it does not verify with the second witness's key, so 2 of 3 remain
    expect(verifyKel([witnessed(e0, 1, all), witnessed(e1, 1, [[21, 0], [23, 1], [23, 2]])], e0.i, 1).ok).toBe(true);
  });

  it("fails below the threshold, and without receipts", () => {
    expect(verifyKel([witnessed(e0, 1, all), witnessed(e1, 1, [[21, 0], [21, 1], [21, 2]])], e0.i, 1)).toEqual(below(1, 1));
    const none = { ok: false, reason: "event #0 of the issuer's KEL: no witness receipts in the evidence" };
    expect(verifyKel([witnessed(e0, 1, []), witnessed(e1, 1, all)], e0.i, 1)).toEqual(none);
    expect(verifyKel([signed(e0, 1)], e0.i, 0)).toEqual(none);
  });

  it("does not count a signature by a key outside the witness list, nor one witness twice", () => {
    // a valid signature by key 9 (not a witness) at index 1
    expect(verifyKel([witnessed(e0, 1, [[21, 0], [9, 1]])], e0.i, 0)).toEqual(below(0, 1));
    // the first witness twice at index 0
    expect(verifyKel([witnessed(e0, 1, [[21, 0], [21, 0]])], e0.i, 0)).toEqual(below(0, 1));
    // receipt couples: one by a witness counts, one by another key does not
    const rct = (n: number) => (r: string) => "-CAB" + couple(r, n);
    expect(verifyKel([witnessed(e0, 1, [[21, 0]], rct(23))], e0.i, 0).ok).toBe(true);
    expect(verifyKel([witnessed(e0, 1, [[21, 0]], rct(9))], e0.i, 0)).toEqual(below(0, 1));
  });

  it("counts receipts across copies of the same event", () => {
    expect(verifyKel([witnessed(e0, 1, [[21, 0]]), witnessed(e0, 1, [[22, 1]])], e0.i, 0).ok).toBe(true);
  });

  it("follows a rotation's witness cuts and adds: indices refer to the new list", () => {
    const rotWith = (extra: Json) =>
      versioned("KERI", { t: "rot", d: "", i: e0.i, s: "1", p: e0.d, kt: "1", k: [keyOf(2)], nt: "1", n: [nextKeyDigest(keyOf(3))], bt: "2", br: [], ba: [], a: [], ...extra });
    // cut witness 21, add witness 24: the list becomes [22, 23, 24]
    const r1 = rotWith({ br: [witOf(21)], ba: [witOf(24)] });
    const r2 = ixn(r1);
    const kel = (wits: [number, number][]) => [witnessed(e0, 1, all), witnessed(r1, 2, [[22, 0], [24, 2]]), witnessed(r2, 2, wits)];
    expect(verifyKel(kel([[22, 0], [23, 1], [24, 2]]), e0.i, 2)).toEqual({ ok: true, keys: [keyOf(2)] });
    // the cut witness no longer counts, wherever its signature sits
    expect(verifyKel(kel([[21, 0], [22, 0]]), e0.i, 2)).toEqual(below(2, 1));
    // the pre-rotation positions (22 at index 1, 23 at index 2) do not verify against the new list
    expect(verifyKel(kel([[22, 1], [23, 2]]), e0.i, 2)).toEqual(below(2, 0));

    const at1 = (reason: string) => ({ ok: false, reason: `event #1 of the issuer's KEL: ${reason}` });
    expect(verifyKel([witnessed(e0, 1, all), witnessed(rotWith({ br: [witOf(9)] }), 2, all)], e0.i, 1)).toEqual(
      at1("the rotation removes a witness that is not in the witness list"),
    );
    expect(verifyKel([witnessed(e0, 1, all), witnessed(rotWith({ ba: [witOf(22)] }), 2, all)], e0.i, 1)).toEqual(
      at1("the rotation adds a witness that is already in the witness list"),
    );
    const { br: _br, ...noCuts } = rotWith({});
    expect(verifyKel([witnessed(e0, 1, all), witnessed(versioned("KERI", noCuts), 2, all)], e0.i, 1)).toEqual(
      at1("the rotation's witness changes are not readable"),
    );
  });

  it("fails closed on a witness threshold that does not fit the list", () => {
    const over = icp(1, 2, { bt: "4", b: W.map(witOf) });
    expect(verifyKel([witnessed(over, 1, all)], over.i, 0)).toEqual({ ok: false, reason: `event #0 of the issuer's KEL: the witness threshold "4" does not fit 3 witnesses` });
    const zero = icp(1, 2, { bt: "0", b: W.map(witOf) });
    expect(verifyKel([witnessed(zero, 1, all)], zero.i, 0)).toEqual({ ok: false, reason: `event #0 of the issuer's KEL: the witness threshold "0" does not fit 3 witnesses` });
  });

  it("fails closed on a witness list that is not a list, names a witness twice, or names a transferable key", () => {
    const notList = icp(1, 2, { bt: "1", b: witOf(21) });
    expect(verifyKel([witnessed(notList, 1, [[21, 0]])], notList.i, 0)).toEqual({ ok: false, reason: "event #0 of the issuer's KEL: the witness list is not readable" });
    const twice = icp(1, 2, { bt: "1", b: [witOf(21), witOf(21)] });
    expect(verifyKel([witnessed(twice, 1, [[21, 0]])], twice.i, 0)).toEqual({ ok: false, reason: "event #0 of the issuer's KEL: the witness list names a witness twice" });
    // a witness must be a non-transferable AID ('B'); a 'D' key with a valid signature is not counted
    const transferable = icp(1, 2, { bt: "1", b: [keyOf(21)] });
    expect(verifyKel([witnessed(transferable, 1, [[21, 0]])], transferable.i, 0)).toEqual({
      ok: false,
      reason: "event #0 of the issuer's KEL: 0 of 1 witness signatures verify, the threshold is 1",
    });
  });
});

describe("verifyKel: the event chain itself fails closed", () => {
  const e0 = icp(1, 2);
  const e1 = ixn(e0, [{ d: "EAnchoredSaidForTheChainTest0000000000000000" }]);
  const fail = (reason: string) => ({ ok: false, reason });
  const at = (sn: number, reason: string) => fail(`event #${sn} of the issuer's KEL${reason}`);

  it("the genuine two-event KEL passes (control)", () => {
    expect(verifyKel([signed(e0, 1), signed(e1, 1)], e0.i, 1)).toEqual({ ok: true, keys: [keyOf(1)] });
  });

  it("no event of the AID, an invalid sequence number, or no inception", () => {
    expect(verifyKel([signed(e0, 1)], "EAnotherAidThatHasNoEventsInThisStream000000", 0)).toEqual(fail("the issuer's KEL is not in the evidence"));
    const leadingZero = versioned("KERI", { t: "ixn", d: "", i: e0.i, s: "01", p: e0.d, a: [] });
    expect(verifyKel([signed(e0, 1), signed(leadingZero, 1)], e0.i, 1)).toEqual(fail("the issuer's KEL has an event with an invalid sequence number"));
    expect(verifyKel([signed(e0, 1)], e0.i, -1)).toEqual(fail("the issuer's KEL has an event with an invalid sequence number"));
    expect(verifyKel([signed(e0, 1)], e0.i, 0.5)).toEqual(fail("the issuer's KEL has an event with an invalid sequence number"));
    expect(verifyKel([signed(e1, 1)], e0.i, 1)).toEqual(fail("the issuer's inception event is not in the evidence"));
  });

  it("a size that differs from the version string, an inception that is not self-addressing, a KEL starting with a rotation", () => {
    const resized = { ...e0, v: "KERI10JSON000001_" };
    expect(verifyKel([signed(resized, 1)], e0.i, 0)).toEqual(at(0, ": size differs from its version string"));
    // same size, `d` = `i`, one field changed: the SAID no longer recomputes to the AID
    const changed = { ...e0, nt: "2" };
    expect(verifyKel([signed(changed, 1)], e0.i, 0)).toEqual(
      fail("the issuer's inception event is not self-addressing (its SAID is not the issuer's AID)"),
    );
    // an inception whose prefix is not its SAID (only `d` is self-addressing)
    const fixedPrefix = versioned("KERI", { t: "icp", d: "", i: "EFixedPrefixNotDerivedFromTheInception000000", s: "0", kt: "1", k: [keyOf(1)], nt: "1", n: [nextKeyDigest(keyOf(2))], bt: "0", b: [], c: [], a: [] });
    expect(verifyKel([signed(fixedPrefix, 1)], fixedPrefix.i, 0)).toEqual(
      fail("the issuer's inception event is not self-addressing (its SAID is not the issuer's AID)"),
    );
    const rot0 = versioned("KERI", { t: "rot", d: "", i: e0.i, s: "0", p: "", kt: "1", k: [keyOf(1)], nt: "1", n: [nextKeyDigest(keyOf(2))], bt: "0", br: [], ba: [], a: [] });
    expect(verifyKel([signed(rot0, 1)], e0.i, 0)).toEqual(fail("the issuer's KEL does not start with an inception event"));
  });

  it("a later event whose SAID does not recompute, that does not link to the prior event, a second inception, an unsupported type", () => {
    // same size, signed over its changed bytes: only the SAID gives it away
    const edited = { ...e1, a: [{ d: "EAnchoredSaidForTheChainTest0000000000000001" }] };
    expect(verifyKel([signed(e0, 1), signed(edited, 1)], e0.i, 1)).toEqual(at(1, ": SAID does not match its content"));
    const unlinked = versioned("KERI", { t: "ixn", d: "", i: e0.i, s: "1", p: "EPriorEventThatIsNotInThisKel000000000000000", a: [] });
    expect(verifyKel([signed(e0, 1), signed(unlinked, 1)], e0.i, 1)).toEqual(at(1, " does not link to the prior event"));
    const icp1 = versioned("KERI", { t: "icp", d: "", i: e0.i, s: "1", p: e0.d, kt: "1", k: [keyOf(1)], nt: "1", n: [nextKeyDigest(keyOf(2))], bt: "0", b: [], c: [], a: [] });
    expect(verifyKel([signed(e0, 1), signed(icp1, 1)], e0.i, 1)).toEqual(at(1, " is a second inception event"));
    const drt = versioned("KERI", { t: "drt", d: "", i: e0.i, s: "1", p: e0.d, kt: "1", k: [keyOf(2)], nt: "1", n: [nextKeyDigest(keyOf(3))], bt: "0", br: [], ba: [], a: [] });
    expect(verifyKel([signed(e0, 1), signed(drt, 2)], e0.i, 1)).toEqual(at(1, ": event type drt is not supported"));
  });

  it("an inception without a next-key list cannot be rotated (no pre-rotation commitment)", () => {
    const noNext = icp(1, 2, { n: "ENotAList000000000000000000000000000000000000" });
    expect(verifyKel([signed(noNext, 1)], noNext.i, 0).ok).toBe(true);
    expect(verifyKel([signed(noNext, 1), signed(rot(noNext, 2, 3), 2)], noNext.i, 1)).toEqual(
      at(1, ": the rotation's key is not the one committed to by the prior next-key digest"),
    );
  });
});

describe("verifyIssuance fails closed on the TEL and registry events", () => {
  const e0 = icp(1, 2);
  const OTHER_AID = "EAnotherIssuerAidForTheRegistryTest000000000";
  const vcpOf = (ii: string) =>
    versioned("KERI", { t: "vcp", d: "", i: "", ii, s: "0", c: ["NB"], bt: "0", b: [], n: "A" + base64url(new Uint8Array([0, ...secret(8).slice(0, 16)])).slice(1) }, ["d", "i"]);
  /** e0, an event anchoring the registry (or nothing), then the issuance anchor; with the TEL events and the credential. */
  function build(o: { vcp?: Json; anchorVcp?: boolean; iss?: (acdc: Json, ri: string) => Json } = {}) {
    const vcp = o.vcp ?? vcpOf(e0.i);
    const e1 = ixn(e0, o.anchorVcp === false ? [] : [{ i: vcp.i, s: "0", d: vcp.d }]);
    const acdc = versioned("ACDC", { d: "", i: e0.i, ri: vcp.i, s: "ESchemaSaidForTheTest00000000000000000000000", a: { i: "EIssueeAidForTheTest000000000000000000000000" } });
    const iss = (o.iss ?? ((a, ri) => versioned("KERI", { t: "iss", d: "", i: a.d, s: "0", ri, dt: "2026-10-06T00:00:00.000000+00:00" })))(acdc, vcp.i);
    const e2 = ixn(e1, [{ i: acdc.d, s: "0", d: iss.d }]);
    return { acdc, kel: [signed(e0, 1), signed(e1, 1), signed(e2, 1)], tel: [unsigned(vcp), unsigned(iss)], all: [signed(e0, 1), signed(e1, 1), signed(e2, 1), unsigned(vcp), unsigned(iss), unsigned(acdc)] };
  }

  it("the genuine stream passes (control)", () => {
    const b = build();
    expect(verifyIssuance(b.all, b.acdc)).toBe("");
  });

  it("no issuance event, an issuance whose SAID does not recompute, an issuance in another registry", () => {
    const b = build();
    expect(verifyIssuance(b.all.filter((m) => m.ked.t !== "iss"), b.acdc)).toBe("no TEL issuance event to check against the issuer's KEL");
    const editedIss = build({ iss: (a, ri) => ({ ...versioned("KERI", { t: "iss", d: "", i: a.d, s: "0", ri, dt: "2026-10-06T00:00:00.000000+00:00" }), dt: "2026-10-07T00:00:00.000000+00:00" }) });
    expect(verifyIssuance(editedIss.all, editedIss.acdc)).toBe("TEL issuance event: SAID does not match its content");
    const otherRegistry = build({ iss: (a) => versioned("KERI", { t: "iss", d: "", i: a.d, s: "0", ri: "EAnotherRegistryForTheTest00000000000000000", dt: "2026-10-06T00:00:00.000000+00:00" }) });
    expect(verifyIssuance(otherRegistry.all, otherRegistry.acdc)).toBe("TEL issuance event is in another registry than the credential");
  });

  it("the issuer's KEL missing from the stream", () => {
    const b = build();
    expect(verifyIssuance([...b.tel, unsigned(b.acdc)], b.acdc)).toBe("the issuer's KEL is not in the evidence");
  });

  it("a registry missing, incepted by another AID, or not anchored in the issuer's KEL", () => {
    const b = build();
    expect(verifyIssuance(b.all.filter((m) => m.ked.t !== "vcp"), b.acdc)).toBe("the credential's registry was not incepted by the issuer");
    const other = build({ vcp: vcpOf(OTHER_AID) });
    expect(verifyIssuance(other.all, other.acdc)).toBe("the credential's registry was not incepted by the issuer");
    const unanchored = build({ anchorVcp: false });
    expect(verifyIssuance(unanchored.all, unanchored.acdc)).toBe("the registry inception is not anchored in the issuer's KEL");
  });
});

describe("parseAttachments: groups that carry no witness signature are skipped, never counted", () => {
  const W1 = icp(1, 2, { bt: "1", b: [witOf(21)] });
  const raw = JSON.stringify(W1);
  const seqner = "0A" + "A".repeat(22);
  const sigGroup = (n: number) => "-AAB" + idxSig(raw, n, 0);
  /** -0V##### wrapper (five-character count) around the groups. */
  const big = (inner: string) => "-0V" + "AAA" + cnt(inner.length / 4) + inner;

  it("transferable receipts (-D), signer groups (-F, -H), seal sources (-G, -I) and pathed material (-L) are read and skipped", () => {
    const body =
      sigGroup(1) +
      "-DAB" + witOf(21) + seqner + W1.d + idxSig(raw, 21, 0) +
      "-FAB" + witOf(21) + seqner + W1.d + sigGroup(21) +
      "-GAB" + seqner + W1.d +
      "-HAB" + witOf(21) + sigGroup(21) +
      "-IAB" + witOf(21) + seqner + W1.d +
      "-LAB" + "AAAA";
    const a = parseAttachments(big(body));
    expect(a.controller).toHaveLength(1);
    expect(a.witness).toHaveLength(0);
    expect(a.receipts).toHaveLength(0);
    // a CESR version code (-_AAA) ahead of the groups is read and skipped as well
    expect(parseAttachments(big("-_AAABAA" + body)).controller).toHaveLength(1);
    // the witness's key signed in each of those groups, yet the event has no witness receipt
    const m: KelMessage = { raw, ked: W1, atc: big(body) };
    expect(verifyKel([m], W1.i, 0)).toEqual({ ok: false, reason: "event #0 of the issuer's KEL: no witness receipts in the evidence" });
    expect(controllerSigs(big(body))).toHaveLength(1);
  });

  it("reads a witness signature in the two-character-index form (2A)", () => {
    const bigSig = "2A" + "AA" + "AA" + sigBody(raw, 21);
    expect(bigSig).toHaveLength(92);
    const a = parseAttachments(sigGroup(1) + "-BAB" + bigSig);
    expect(a.witness.map((s) => s.index)).toEqual([0]);
    expect(verifyKel([{ raw, ked: W1, atc: sigGroup(1) + "-BAB" + bigSig }], W1.i, 0)).toEqual({ ok: true, keys: [keyOf(1)] });
  });

  it("throws on malformed primitives, signatures and counters", () => {
    expect(() => parseAttachments("-AAB" + idxSig(raw, 1, 0).slice(0, 80))).toThrow("malformed indexed signature");
    expect(() => parseAttachments("-BAB" + "2AAAAA" + "!".repeat(86))).toThrow("malformed indexed signature");
    expect(() => parseAttachments("-BAB" + "0Bxx")).toThrow("unsupported indexed signature 0B");
    expect(() => parseAttachments("-DAB" + witOf(21) + "1A" + "A".repeat(22))).toThrow("malformed sequence number in attachment");
    expect(() => parseAttachments("-CAB" + witOf(21) + "0A" + "A".repeat(86))).toThrow("malformed receipt couple signature");
    expect(() => parseAttachments("-HAB" + witOf(21) + "-BAB" + idxSig(raw, 21, 0))).toThrow("malformed signature group");
    expect(() => parseAttachments("-A!B")).toThrow("bad base64 char !");
    expect(() => controllerSigs("-AAB" + "0B" + "A".repeat(86))).toThrow("unsupported indexed signature 0B");
    expect(() => decodeVerKey("E" + "A".repeat(43))).toThrow("not an Ed25519 key");
    expect(() => decodeIndexedSig("B" + "A".repeat(87))).toThrow("not an indexed Ed25519 signature");
  });
});
