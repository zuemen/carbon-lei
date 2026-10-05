// Checks 6 and 7 against the evidence exported from the local KERI run (fixtures/evidence).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashString } from "../commitment.ts";
import {
  DEMO_TRUST_ANCHOR,
  parseCesr,
  verifyAnchor,
  verifyAuthority,
  type AnchorEvidence,
  type AuthorityEvidence,
} from "../vlei.ts";

const dir = new URL("../../fixtures/evidence/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const vlei = JSON.parse(readFileSync(new URL("../../fixtures/vlei.json", import.meta.url), "utf8"));
const anchorFile = readdirSync(dir).find((f) => f.startsWith("anchor-")) as string;
const anchor = JSON.parse(read(anchorFile)) as AnchorEvidence;
const auditorIcp = parseCesr(read("cred-ecr.cesr")).find((m) => m.ked.t === "icp" && m.ked.i === anchor.auditor)?.raw;

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
  it("verifies the exported anchor event, signature and key binding", () => {
    expect(auditorIcp).toBeDefined();
    const r = verifyAnchor({ ...anchor, establishmentRaw: auditorIcp }, exp);
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
    const icp = parseCesr(readFileSync(new URL("cred-ecr.cesr", impDir), "utf8")).find((m) => m.ked.t === "icp" && m.ked.i === a.auditor)?.raw;
    expect(a.auditor).toBe(iv.agents.impAuditor.aid);
    const r = verifyAnchor({ ...a, establishmentRaw: icp }, {
      credSAID: a.credSAID,
      auditorAID: a.auditor,
      kelSeq: BigInt(a.kelSeq),
      auditorAidHash: hashString(a.auditor),
    });
    expect(r).toMatchObject({ ok: true });
  });
});
