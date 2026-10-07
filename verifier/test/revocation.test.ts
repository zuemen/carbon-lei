// Revocation detection on KEL data, without revoking anything: the exported verifier KEL and the
// ECR's CESR stream (real KERIA output, ECR issued but not revoked), plus hand-built events that
// carry the rev seal { i: ECR SAID, s: "1", d: ... }.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { base64url } from "../../sdk/encoding.ts";
import { SAID_DUMMY, computeSaid } from "../../sdk/said.ts";
import { parseCesr } from "../../sdk/vlei.ts";
import {
  checkSealEvent,
  controllerSigs,
  findCredentialSeal,
  findIssuanceSeal,
  findRevocationSeal,
  type Json,
} from "../src/revocation.ts";

const fixture = (p: string) => readFileSync(new URL(`../../fixtures/${p}`, import.meta.url), "utf8");
const vlei = JSON.parse(fixture("vlei.json"));
const ECR = vlei.credentials.ecr.said as string;
const VERIFIER = vlei.agents.verifier.aid as string;
const kel = JSON.parse(fixture("evidence/kel-verifier.json")) as { ked: Json; atc: string }[];
const FAKE_REV_SAID = "EFakeRevEventSaidForTestsOnly0000000000000000";

/** A KERI 1.0 JSON event with a correct version-string size and SAID (`labels` share the SAID, as in icp). */
function keriEvent(body: Json, labels: string[] = ["d"]): Json {
  const ev: Json = { v: "KERI10JSON000000_", ...body };
  for (const l of labels) ev[l] = SAID_DUMMY;
  const size = new TextEncoder().encode(JSON.stringify(ev)).length;
  ev.v = `KERI10JSON${size.toString(16).padStart(6, "0")}_`;
  const said = computeSaid(ev);
  for (const l of labels) ev[l] = said;
  return ev;
}

function revIxn(prior: Json, credSaid = ECR, revSaid = FAKE_REV_SAID): Json {
  const sn = (parseInt(prior.s, 16) + 1).toString(16);
  return keriEvent({ t: "ixn", d: "", i: prior.i, s: sn, p: prior.d, a: [{ i: credSaid, s: "1", d: revSaid }] });
}

describe("real verifier KEL (ECR issued, not revoked)", () => {
  it("finds the ECR issuance seal and no revocation seal", () => {
    expect(kel.map((e) => e.ked.t)).toEqual(["icp", "ixn", "ixn"]);
    const iss = findIssuanceSeal(kel, ECR, { issuer: VERIFIER });
    expect(iss?.sn).toBe(2);
    expect(iss?.seal.i).toBe(ECR);
    expect(iss?.seal.s).toBe("0");
    expect(findRevocationSeal(kel, ECR, { issuer: VERIFIER })).toBeUndefined();
    expect(findRevocationSeal(kel, ECR)).toBeUndefined();
  });

  it("re-checks the issuance event: SAID, size, prior link and the controller signature", () => {
    const iss = findIssuanceSeal(kel, ECR)!;
    const c = checkSealEvent(iss, kel);
    expect(c).toMatchObject({ saidRecomputed: true, sizeMatchesVersion: true, priorLinked: true, signatureValid: true });
    expect(c.establishmentEvent).toEqual({ sn: 0, said: VERIFIER });
    expect(c.signingKeys).toEqual(kel[0].ked.k);
  });

  it("ignores events by another controller", () => {
    expect(findIssuanceSeal(kel, ECR, { issuer: vlei.agents.qvi.aid })).toBeUndefined();
  });
});

describe("ECR CESR stream (parseCesr)", () => {
  const msgs = parseCesr(fixture("evidence/cred-ecr.cesr"));

  it("finds the issuance seal in the verifier's KEL inside the stream, no revocation", () => {
    const iss = findIssuanceSeal(msgs, ECR, { issuer: VERIFIER });
    expect(iss?.sn).toBe(2);
    expect(iss?.eventSaid).toBe(kel[2].ked.d);
    // raw comes from the stream itself, byte for byte
    expect(iss?.raw).toBe(msgs.find((m) => m.ked.d === kel[2].ked.d)!.raw);
    expect(findRevocationSeal(msgs, ECR, { issuer: VERIFIER })).toBeUndefined();
  });

  it("does not mistake the TEL iss event (i = ECR SAID, s = 0, no seals) for a seal", () => {
    const tel = msgs.filter((m) => m.ked.t === "iss" && m.ked.i === ECR);
    expect(tel).toHaveLength(1);
    expect(findCredentialSeal(tel, ECR, "0")).toBeUndefined();
  });
});

describe("hand-built ixn with the rev seal", () => {
  const ixn = revIxn(kel[2].ked);
  const events: Json[] = [...kel, { ked: ixn }];

  it("is found at the next sequence number with the exact seal", () => {
    const hit = findRevocationSeal(events, ECR, { issuer: VERIFIER });
    expect(hit).toBeDefined();
    expect(hit!.sn).toBe(3);
    expect(hit!.eventType).toBe("ixn");
    expect(hit!.eventSaid).toBe(ixn.d);
    expect(hit!.seal).toEqual({ i: ECR, s: "1", d: FAKE_REV_SAID });
    expect(JSON.parse(hit!.raw)).toEqual(ixn);
    // the issuance seal is still found at sn 2
    expect(findIssuanceSeal(events, ECR)?.sn).toBe(2);
  });

  it("works on bare event dicts and parseCesr messages too", () => {
    expect(findRevocationSeal(events.map((e) => e.ked), ECR)?.sn).toBe(3);
    const stream = kel.map((e) => JSON.stringify(e.ked) + e.atc).join("") + JSON.stringify(ixn);
    const hit = findRevocationSeal(parseCesr(stream), ECR, { issuer: VERIFIER });
    expect(hit?.sn).toBe(3);
    expect(hit?.raw).toBe(JSON.stringify(ixn));
  });

  it("is structurally valid but has no valid signature (an unsigned forgery is flagged)", () => {
    const hit = findRevocationSeal(events, ECR)!;
    const c = checkSealEvent(hit, events);
    expect(c).toMatchObject({ saidRecomputed: true, sizeMatchesVersion: true, priorLinked: true, signatureValid: false });
    // a signature lifted from another event does not verify either
    const forged = [...kel, { ked: ixn, atc: kel[2].atc }];
    const c2 = checkSealEvent(findRevocationSeal(forged, ECR)!, forged);
    expect(c2.signatures.length).toBe(1);
    expect(c2.signatureValid).toBe(false);
  });

  it("ignores near misses: other credential, TEL sn 0 or 2, missing d, TEL rev event itself", () => {
    const other = revIxn(kel[2].ked, vlei.credentials.leVerifier.said);
    const sn0 = keriEvent({ t: "ixn", d: "", i: VERIFIER, s: "3", p: kel[2].ked.d, a: [{ i: ECR, s: "0", d: FAKE_REV_SAID }] });
    const sn2 = keriEvent({ t: "ixn", d: "", i: VERIFIER, s: "3", p: kel[2].ked.d, a: [{ i: ECR, s: "2", d: FAKE_REV_SAID }] });
    const noD = keriEvent({ t: "ixn", d: "", i: VERIFIER, s: "3", p: kel[2].ked.d, a: [{ i: ECR, s: "1" }] });
    const telRev = { v: "KERI10JSON000000_", t: "rev", d: FAKE_REV_SAID, i: ECR, s: "1", ri: "Ex", p: "Ey", dt: "2026-10-06T05:20:00.000000+00:00" };
    for (const e of [other, sn2, noD, telRev]) expect(findRevocationSeal([...kel, e], ECR)).toBeUndefined();
    expect(findRevocationSeal([...kel, sn0], ECR)).toBeUndefined();
  });

  it("with the seal repeated, reports the lowest sequence number", () => {
    const later = revIxn(ixn);
    const hit = findRevocationSeal([...kel, { ked: later }, { ked: ixn }], ECR);
    expect(hit?.sn).toBe(3);
  });

  it("a broken prior link or tampered bytes are flagged", () => {
    const unlinked = keriEvent({ t: "ixn", d: "", i: VERIFIER, s: "3", p: kel[1].ked.d, a: [{ i: ECR, s: "1", d: FAKE_REV_SAID }] });
    const evs = [...kel, unlinked];
    expect(checkSealEvent(findRevocationSeal(evs, ECR)!, evs).priorLinked).toBe(false);
    const hit = findRevocationSeal(events, ECR)!;
    const tampered = { ...hit, raw: hit.raw.replace(FAKE_REV_SAID, FAKE_REV_SAID.replace("Fake", "Faux")) };
    expect(checkSealEvent(tampered, events).saidRecomputed).toBe(false);
  });
});

describe("hand-built KEL signed with a test key", () => {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  const key = "D" + base64url(new Uint8Array([0, ...pub])).slice(1);
  const sign = (ev: Json) => "-AAB" + base64url(new Uint8Array([0, 0, ...ed25519.sign(new TextEncoder().encode(JSON.stringify(ev)), secret)]));
  const icp = keriEvent(
    { t: "icp", d: "", i: "", s: "0", kt: "1", k: [key], nt: "0", n: [], bt: "0", b: [], c: [], a: [] },
    ["d", "i"],
  );
  const ixn = revIxn(icp);
  const events = [
    { ked: icp, atc: sign(icp) },
    { ked: ixn, atc: "-VAj" + sign(ixn) },
  ];

  it("parses the controller signature behind an attachment-group counter", () => {
    const sigs = controllerSigs(events[1].atc);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].index).toBe(0);
    expect(sigs[0].raw.length).toBe(64);
  });

  it("verifies the rev-seal event's signature against the inception key", () => {
    const hit = findRevocationSeal(events, ECR, { issuer: icp.i })!;
    expect(hit.sn).toBe(1);
    const c = checkSealEvent(hit, events);
    expect(c).toMatchObject({ saidRecomputed: true, sizeMatchesVersion: true, priorLinked: true, signatureValid: true });
    expect(c.signingKeys).toEqual([key]);
  });

  it("rejects the signature when the event bytes change", () => {
    const hit = findRevocationSeal(events, ECR)!;
    const tampered = { ...hit, raw: hit.raw.replace(`"s":"1"`, `"s":"1" `) };
    const c = checkSealEvent(tampered, events);
    expect(c.signatureValid).toBe(false);
    expect(c.sizeMatchesVersion).toBe(false);
  });

  it("a valid signature at an index past the key list, an unreadable attachment, or raw that is not JSON is not a valid seal event", () => {
    const hit = findRevocationSeal(events, ECR)!;
    // the inception's key signed, but the signature claims index 1 of a one-key list
    const atIndex1 = "-AAB" + "AB" + sign(ixn).slice(6);
    const c1 = checkSealEvent({ ...hit, atc: atIndex1 }, events);
    expect(c1.signatures).toEqual([{ qb64: atIndex1.slice(4), index: 1, valid: false }]);
    expect(c1.signatureValid).toBe(false);
    const c2 = checkSealEvent({ ...hit, atc: "-ZAB" + "A".repeat(88) }, events);
    expect(c2).toMatchObject({ signatures: [], signatureValid: false });
    expect(checkSealEvent({ ...hit, raw: hit.raw.slice(0, -1) }, events)).toMatchObject({ saidRecomputed: false, sizeMatchesVersion: false });
    // a key that is not an Ed25519 key in the establishment event: the signature cannot verify
    const badKeyIcp = { ...icp, k: ["Dnot-a-key"] };
    const c3 = checkSealEvent(hit, [{ ked: badKeyIcp, atc: sign(icp) }, events[1]]);
    expect(c3).toMatchObject({ signatureValid: false, signatures: [{ index: 0, valid: false }] });
  });
});
