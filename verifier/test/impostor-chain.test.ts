// Attack 4 helpers: the synthetic impostor chain (no KERIA) is internally valid and fails check 7 only at
// the pinned root; the fixture and agent info come from fixtures/demo.json; the separation guard.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashString } from "../../sdk/commitment.ts";
import { DEMO_TRUST_ANCHOR, parseCesr, verifyAnchor, verifyAuthority, type AnchorEvidence } from "../../sdk/vlei.ts";
import {
  IMP_CRED_KEYS,
  IMP_KEYS,
  assertSeparateFromMain,
  impostorAgentInfo,
  syntheticImpostorChain,
} from "../src/impostor-chain.ts";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const demo = json("../../fixtures/demo.json");
const mainVlei = json("../../fixtures/vlei.json");
const accSchema: string = json("../schemas/cbam-verifier-accreditation.json").$id;

const chain = syntheticImpostorChain({ demo, accreditationSchema: accSchema });
const fx = chain.fixture;
const CRED = "EImpostorCredentialSaid00000000000000000000";

const expectFor = (trustAnchor: string) => ({
  trustAnchor,
  auditorAID: fx.agents.impAuditor.aid,
  verifierLEI: demo.entities.impostor.lei,
  cnCode: demo.product.cnCode,
  onchain: {
    leCredSaidHash: hashString(chain.saids.leBody),
    accreditationSaidHash: hashString(chain.saids.accreditation),
    ecrSaidHash: hashString(chain.saids.ecr),
  },
});

describe("attack 4: synthetic impostor chain", () => {
  it("is well formed under its own root: check 7 passes when that root is the one configured", () => {
    expect(verifyAuthority(chain.bundle, expectFor(fx.trustAnchor))).toMatchObject({ ok: true });
  });

  it("fails check 7 against the pinned demo root, with the pinned-root reason", () => {
    expect(fx.trustAnchor).not.toBe(DEMO_TRUST_ANCHOR);
    expect(verifyAuthority(chain.bundle, expectFor(DEMO_TRUST_ANCHOR))).toEqual({
      ok: false,
      code: "AUTHORITY_INVALID",
      detail: "QVI credential not issued by the configured root of trust",
    });
  });

  it("passes check 6: the anchor is signed with the key from the auditor's inception event in the ECR stream", () => {
    const anchor = chain.anchor(CRED) as AnchorEvidence;
    const icp = parseCesr(chain.cesr.ecr).find((m) => m.ked.t === "icp" && m.ked.i === anchor.auditor)?.raw;
    expect(icp).toBeDefined();
    const r = verifyAnchor({ ...anchor, establishmentRaw: icp }, {
      credSAID: CRED,
      auditorAID: fx.agents.impAuditor.aid,
      kelSeq: 1n,
      auditorAidHash: hashString(fx.agents.impAuditor.aid),
    });
    expect(r).toMatchObject({ ok: true });
  });

  it("is deterministic and separate from the demo chain", () => {
    const again = syntheticImpostorChain({ demo, accreditationSchema: accSchema });
    expect(again.saids).toEqual(chain.saids);
    expect(again.bundle).toEqual(chain.bundle);
    const aids = IMP_KEYS.map((k) => fx.agents[k].aid as string);
    expect(new Set(aids).size).toBe(5);
    expect(() => assertSeparateFromMain(mainVlei, aids, DEMO_TRUST_ANCHOR)).not.toThrow();
  });

  it("writes a public fixture with the demo.json fiction and no secrets", () => {
    expect(fx.synthetic).toBe(true);
    expect(fx.agents.impBody).toMatchObject({ name: "Demo Impostor Verifier", lei: "ZZZZ00FAKEVERFICT143" });
    expect(fx.credentials.ecr).toMatchObject({ issuer: "impBody", issuee: "impAuditor", privacy: true, parent: chain.saids.leBody });
    expect(fx.credentials.accreditation).toMatchObject({ issuer: "impNab", issuee: "impBody", parent: chain.saids.leNab });
    for (const k of IMP_CRED_KEYS) expect(fx.credentials[k].said).toMatch(/^E[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(fx)).not.toMatch(/"(bran|passcode|secret)\w*"\s*:/i);
    const acc = parseCesr(chain.cesr.accreditation).filter((m) => m.ked.v.startsWith("ACDC")).pop()!.ked;
    expect(acc.a.cnScope).toEqual([demo.product.cnCode]);
    expect(acc.s).toBe(accSchema);
  });
});

describe("attack 4: agent info and separation guard", () => {
  it("takes names and LEIs from fixtures/demo.json; every LEI has the ZZZZ prefix and valid ISO 17442 check digits", () => {
    const info = impostorAgentInfo(demo);
    expect(info.impBody.lei).toBe(demo.entities.impostor.lei);
    expect(info.impAuditor.role).toBe("CBAM Lead Auditor");
    const mod97 = (lei: string) => Number(BigInt([...lei].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("")) % 97n);
    const c = demo.entities.impostorChain;
    for (const lei of [info.impQvi.lei, info.impNab.lei, info.impBody.lei, c.supplier.lei] as string[]) {
      expect(lei.startsWith("ZZZZ")).toBe(true);
      expect(mod97(lei)).toBe(1);
    }
  });

  it("refuses AIDs shared with the demo agents and the pinned root as the impostor's root", () => {
    expect(() => assertSeparateFromMain(mainVlei, [mainVlei.agents.verifier.aid], DEMO_TRUST_ANCHOR)).toThrow(/overlap/);
    expect(() => assertSeparateFromMain(null, [DEMO_TRUST_ANCHOR], DEMO_TRUST_ANCHOR)).toThrow(/pinned root/);
  });
});
