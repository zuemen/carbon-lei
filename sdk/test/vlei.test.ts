// Checks 6 and 7 against the evidence exported from the local KERI run (fixtures/evidence).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashString } from "../commitment.ts";
import { parseCesr, verifyAnchor, verifyAuthority, type AnchorEvidence, type AuthorityEvidence } from "../vlei.ts";

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
  it("rejects a changed event, another credential, another sequence number, another key", () => {
    const changed = anchor.event.raw.replace(anchor.credSAID, anchor.credSAID.slice(0, -1) + "A");
    expect(verifyAnchor({ ...anchor, event: { raw: changed } }, exp).ok).toBe(false);
    expect(verifyAnchor(anchor, { ...exp, credSAID: "EOtherCredentialSaid000000000000000000000000" }).ok).toBe(false);
    expect(verifyAnchor(anchor, { ...exp, kelSeq: exp.kelSeq + 1n }).ok).toBe(false);
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
  });
  it("rejects a credential whose content was changed", () => {
    const tampered = authority.cesr.ecr.replace('"CBAM Lead Auditor"', '"CBAM Lead Auditer"');
    expect(verifyAuthority({ ...authority, cesr: { ...authority.cesr, ecr: tampered } }, expectAuth).ok).toBe(false);
  });
});
