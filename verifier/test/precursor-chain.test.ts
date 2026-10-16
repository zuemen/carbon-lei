// The synthetic two-body chain of the precursor demo (verifier/src/precursor-chain.ts): both bodies' authority
// evidence verifies under the chain's own (explicitly pinned) root and fails under the demo root; one KEL per shared
// AID (the QVI's and the NAB's events are the same in both bundles); the auditors' anchors verify; nothing overlaps
// the demo's KERI agents.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashString } from "../../sdk/commitment.ts";
import { DEMO_TRUST_ANCHOR, PRECURSOR_DEMO_TRUST_ANCHOR, parseCesr, verifyAnchor, verifyAuthority, type AnchorEvidence } from "../../sdk/vlei.ts";
import { BODY_KEYS, precursorChainInput, syntheticPrecursorChain } from "../src/precursor-chain.ts";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const demo = json("../../fixtures/demo.json");
const mainVlei = json("../../fixtures/vlei.json");
const input = precursorChainInput(demo);
const chain = syntheticPrecursorChain(input);

const expectFor = (k: (typeof BODY_KEYS)[number], trustAnchor: string, cnCode: string) => {
  const b = chain.bodies[k];
  return {
    trustAnchor,
    auditorAID: b.auditorAid,
    verifierLEI: b.lei,
    cnCode,
    registeredAt: 2n,
    onchain: {
      leCredSaidHash: hashString(b.saids.leBody),
      accreditationSaidHash: hashString(b.saids.accreditation),
      ecrSaidHash: hashString(b.saids.ecr),
      accreditedUntil: 4_000_000_000n,
      auditorAddedAt: 1n,
      auditorRevokedAt: 0n,
    },
  };
};

describe("precursor demo: synthetic two-body vLEI chain", () => {
  it("is deterministic and names the fictional mill body and the demo screw body", () => {
    expect(syntheticPrecursorChain(input).trustAnchor).toBe(chain.trustAnchor);
    // the constant the hosted page pins for the precursor sections
    expect(chain.trustAnchor).toBe(PRECURSOR_DEMO_TRUST_ANCHOR);
    expect(chain.bodies.mill.lei).toBe(demo.entities.precursorChain.body.lei);
    expect(chain.bodies.screw.lei).toBe(demo.entities.verifier.lei);
    expect(input.bodies.mill.cnScope).toEqual(["7213"]);
  });

  it("each body's evidence verifies under the chain's root for its own CN scope only", () => {
    expect(verifyAuthority(chain.bodies.screw.bundle, expectFor("screw", chain.trustAnchor, "7318"))).toMatchObject({ ok: true });
    expect(verifyAuthority(chain.bodies.mill.bundle, expectFor("mill", chain.trustAnchor, "7213"))).toMatchObject({ ok: true });
    expect(verifyAuthority(chain.bodies.mill.bundle, expectFor("mill", chain.trustAnchor, "7318"))).toMatchObject({ ok: false, detail: "accreditation scope does not include CN 7318" });
  });

  it("fails under the demo's pinned root: the synthetic root must be pinned explicitly", () => {
    for (const k of BODY_KEYS) {
      expect(verifyAuthority(chain.bodies[k].bundle, expectFor(k, DEMO_TRUST_ANCHOR, k === "mill" ? "7213" : "7318"))).toMatchObject({
        ok: false,
        detail: "QVI credential not issued by the configured root of trust",
      });
    }
    expect(chain.trustAnchor).not.toBe(DEMO_TRUST_ANCHOR);
  });

  it("the QVI and NAB have one KEL each, identical in both bundles", () => {
    const events = (cesr: string, aid: string) => parseCesr(cesr).filter((m) => m.ked.v.startsWith("KERI") && m.ked.i === aid && ["icp", "ixn"].includes(m.ked.t)).map((m) => m.raw);
    for (const [aid, key] of [[chain.qviAid, "leBody"], [chain.nabAid, "accreditation"]] as const) {
      const a = events(chain.bodies.screw.bundle.cesr[key], aid);
      const b = events(chain.bodies.mill.bundle.cesr[key], aid);
      expect(a.length).toBeGreaterThan(1);
      expect(a).toEqual(b);
    }
  });

  it("each auditor's event #1 anchors several credential SAIDs and verifies", () => {
    const saids = ["E" + "B".repeat(43), "E" + "C".repeat(43)];
    for (const k of BODY_KEYS) {
      const ev = chain.bodies[k].anchor(saids) as AnchorEvidence;
      for (const credSAID of saids) expect(verifyAnchor(ev, { credSAID, auditorAID: chain.bodies[k].auditorAid, kelSeq: 1n })).toMatchObject({ ok: true });
      expect(verifyAnchor(ev, { credSAID: "E" + "D".repeat(43), auditorAID: chain.bodies[k].auditorAid, kelSeq: 1n }).ok).toBe(false);
    }
  });

  it("the optional carbon price certifier (check 10) only appends events: no KEL forks, its anchor verifies", () => {
    const cp = json("../../fixtures/carbonprice.json");
    const withCert = syntheticPrecursorChain({ ...input, certifier: { ...cp.certifier, auditor: { name: cp.certifier.auditor.name } } });
    const cert = withCert.certifier!;
    // Every event of the QVI and the NAB without the certifier is the same event, at the same place, with it.
    for (const [aid, stream] of [
      [chain.qviAid, (b: typeof chain) => b.bodies.mill.bundle.cesr.leBody],
      [chain.nabAid, (b: typeof chain) => b.bodies.mill.bundle.cesr.accreditation],
    ] as const) {
      const before = parseCesr(stream(chain)).filter((m) => m.ked.i === aid && m.ked.t !== undefined && m.ked.s !== undefined).map((m) => m.raw);
      const after = parseCesr(stream(withCert)).filter((m) => m.ked.i === aid && m.ked.t !== undefined && m.ked.s !== undefined).map((m) => m.raw);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.length).toBe(before.length + 1);
    }
    const said = "E" + "S".repeat(43);
    expect(verifyAnchor(cert.anchor([said]) as AnchorEvidence, { credSAID: said, auditorAID: cert.auditorAid, kelSeq: 1n })).toMatchObject({ ok: true });
    expect(new Set([cert.bodyAid, cert.auditorAid, ...BODY_KEYS.flatMap((k) => [chain.bodies[k].bodyAid, chain.bodies[k].auditorAid])]).size).toBe(6);
  });

  it("shares no AID with the demo's KERI agents", () => {
    const main = new Set<string>([mainVlei.trustAnchor, ...Object.values<any>(mainVlei.agents).map((a) => a.aid)]);
    const ours = [chain.trustAnchor, chain.qviAid, chain.nabAid, ...BODY_KEYS.flatMap((k) => [chain.bodies[k].bodyAid, chain.bodies[k].auditorAid])];
    expect(ours.filter((a) => main.has(a))).toEqual([]);
    expect(new Set(ours).size).toBe(ours.length);
  });
});
