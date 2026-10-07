// Check 7 judges authority at registration, as check 4 does: from the on-chain allowlist (the auditor's
// `addedAt` and `revokedAt`, the body's `accreditedUntil`), and from TEL revocations in the evidence only
// when their issuer anchored them. Every time in check 7 is ISO 8601 with a time zone. The demo proof runs
// against the recorded Sepolia answers (sdk/test/fixtures/sepolia-demo-rpc.json); the revocation cases
// run on the synthetic chain of verifier/src/impostor-chain.ts, whose issuers sign with test keys.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainReader, type Deployment } from "../chain.ts";
import { vleiCheckers } from "../checkers.ts";
import { hashString } from "../commitment.ts";
import type { Presentation } from "../disclosure.ts";
import { verifyPresentation, type EvidenceCheckers } from "../verify.ts";
import { DEMO_TRUST_ANCHOR, SCHEMA, isoSeconds, parseCesr, verifyAuthority, type AuthorityEvidence, type AuthorityExpect } from "../vlei.ts";
import { computeSaid } from "../said.ts";
import { syntheticImpostorChain, type ImpCredKey } from "../../verifier/src/impostor-chain.ts";
import { recordedClock, replayFetch } from "./helpers/rpc-replay.ts";

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const proof = readJson("fixtures/sepolia-demo-proof.json") as Presentation;
const deployment = readJson("contracts/deployments/11155111.json") as Deployment;
const demo = readJson("fixtures/demo.json");
const recording = fileURLToPath(new URL("./fixtures/sepolia-demo-rpc.json", import.meta.url));
const loadBundle = async (path: string) => readFileSync(new URL(`../../demo/public/${path}`, import.meta.url), "utf8");
const bundleText = await loadBundle((proof.authorityEvidence as { bundle: string }).bundle);
const accSchema: string = readJson("verifier/schemas/cbam-verifier-accreditation.json").$id;

/** The check 7 detail of the demo proof, as recorded in the demo video: it must not change. */
const DEMO_DETAIL =
  "root → QVI → verification body (LE vLEI) → auditor (ECR, CBAM Lead Auditor); accredited by the NAB for CN 7318; each issuance signed in its issuer's KEL, every event with its witness threshold of receipts; hashes match the on-chain allowlist";

/** An unsigned TEL `rev` of the stream's credential, appended to the stream (what a supplier can add or leave out). */
function withUnsignedRev(stream: string): string {
  const acdc = parseCesr(stream).filter((m) => m.ked.v.startsWith("ACDC")).at(-1)!.ked;
  const iss = parseCesr(stream).find((m) => m.ked.t === "iss" && m.ked.i === acdc.d)!.ked;
  const body: Record<string, unknown> = { v: "KERI10JSON000000_", t: "rev", d: "#".repeat(44), i: acdc.d, s: "1", ri: acdc.ri, p: iss.d, dt: "2026-01-01T00:00:00.000000+00:00" };
  body.v = `KERI10JSON${JSON.stringify(body).length.toString(16).padStart(6, "0")}_`;
  body.d = computeSaid(body);
  return stream + JSON.stringify(body);
}

const { auditor, institution } = ChainReader.prototype;

describe("check 7 on the demo proof: authority at registration, from the allowlist", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** verifyPresentation on the recorded answers; `allowlist` may change the auditor and body records read at block B. */
  async function run(
    p: Presentation,
    allowlist: { auditor?: (r: { addedAt: bigint; revokedAt: bigint }, t: bigint) => object; institution?: (r: { accreditedUntil: bigint }, t: bigint) => object } = {},
  ) {
    vi.stubGlobal("fetch", replayFetch(recording));
    let t = 0n;
    const seen: Record<string, bigint> = {};
    const base = vleiCheckers({ loadBundle });
    const checkers: EvidenceCheckers = {
      ...base,
      authority: async (ev, ctx) => {
        t = ctx.report!.registeredAt;
        return base.authority!(ev, ctx);
      },
    };
    vi.restoreAllMocks();
    vi.spyOn(ChainReader.prototype, "auditor").mockImplementation(async function (this: ChainReader, a, l) {
      const r = await auditor.call(this, a, l);
      Object.assign(seen, { addedAt: r.addedAt, revokedAt: r.revokedAt });
      return { ...r, ...(allowlist.auditor?.(r, t) ?? {}) };
    });
    vi.spyOn(ChainReader.prototype, "institution").mockImplementation(async function (this: ChainReader, h) {
      const r = await institution.call(this, h);
      seen.accreditedUntil = r.accreditedUntil;
      return { ...r, ...(allowlist.institution?.(r, t) ?? {}) };
    });
    const r = await verifyPresentation(p, ChainReader.forSepolia(deployment), {
      importerEORI: "NLDEMO000000001",
      checkers,
      now: recordedClock(recording),
    });
    return { r, t, seen };
  }

  it("VALID with the detail unchanged: the ECR was revoked on the allowlist after registration (the watcher's sync), so check 7 holds at registration", async () => {
    const { r, t, seen } = await run(proof);
    expect(r.overall).toBe("VALID");
    expect(r.checks[7]).toMatchObject({ status: "pass", code: "", detail: DEMO_DETAIL });
    // The recorded allowlist: the auditor added before registration, revoked after it (Sepolia tx 0x4bcd6469…674).
    expect(seen.revokedAt).toBeGreaterThan(t);
    expect(seen.addedAt).toBeLessThanOrEqual(t);
    expect(seen.accreditedUntil).toBeGreaterThanOrEqual(t);
  }, 30_000);

  it("INVALID when the allowlist shows the auditor revoked before registration, whatever the evidence leaves out", async () => {
    const { r } = await run(proof, { auditor: (_r, t) => ({ revokedAt: t - 1n }) });
    expect(r.overall).toBe("INVALID");
    expect(r.checks[7]).toMatchObject({ status: "fail", code: "AUTHORITY_INVALID", detail: "the auditor's ECR was revoked on the allowlist before registration" });
  }, 30_000);

  it("a revocation in the registration's own block came after it (check 4 shows CONTESTED): check 7 passes", async () => {
    const { r } = await run(proof, { auditor: (_r, t) => ({ revokedAt: t }) });
    expect(r.checks[7]).toMatchObject({ status: "pass", detail: DEMO_DETAIL });
  }, 30_000);

  it("INVALID when the allowlist's accreditedUntil, or the auditor's addedAt, does not cover the registration", async () => {
    const expired = await run(proof, { institution: (_r, t) => ({ accreditedUntil: t - 1n }) });
    expect(expired.r.checks[7]).toMatchObject({ status: "fail", detail: "accreditation (on-chain accreditedUntil) had expired at registration" });
    const added = await run(proof, { auditor: (_r, t) => ({ addedAt: t + 1n }) });
    expect(added.r.checks[7]).toMatchObject({ status: "fail", detail: "the auditor was not on the allowlist at registration" });
  }, 30_000);

  it("an unsigned TEL revocation in the evidence neither fails check 7 nor makes it pass", async () => {
    const bundle = JSON.parse(bundleText) as AuthorityEvidence;
    const inline = { ...proof, authorityEvidence: { ...bundle, cesr: { ...bundle.cesr, ecr: withUnsignedRev(bundle.cesr.ecr) } } };
    const ok = await run(inline);
    expect(ok.r.overall).toBe("VALID");
    expect(ok.r.checks[7]).toMatchObject({ status: "pass", detail: DEMO_DETAIL });
    const revoked = await run(inline, { auditor: (_r, t) => ({ revokedAt: t - 1n }) });
    expect(revoked.r.checks[7]).toMatchObject({ status: "fail", detail: "the auditor's ECR was revoked on the allowlist before registration" });
  }, 30_000);

  it("L7: malformed anchor evidence gives INVALID with a check 6 reason, never an exception", async () => {
    for (const anchorEvidence of [{}, null, 0, "garbage", [], { event: null }, { event: { raw: 5 } }, { ...proof.anchorEvidence as object, kel: "x" }]) {
      const { r } = await run({ ...proof, anchorEvidence } as Presentation);
      expect(r.overall, JSON.stringify(anchorEvidence)).toBe("INVALID");
      expect(r.checks[6]).toMatchObject({ status: "fail", code: "ANCHOR_NOT_FOUND" });
    }
  }, 60_000);
});

describe("check 7: the allowlist records against the registration time (verifyAuthority)", () => {
  const bundle = JSON.parse(bundleText) as AuthorityEvidence;
  const vlei = readJson("fixtures/vlei.json");
  const t = BigInt(Date.parse("2026-10-06T00:00:00Z") / 1000);
  const x: AuthorityExpect = {
    trustAnchor: DEMO_TRUST_ANCHOR,
    auditorAID: vlei.agents.auditor.aid,
    verifierLEI: demo.entities.verifier.lei,
    cnCode: demo.product.cnCode,
    registeredAt: t,
    onchain: {
      leCredSaidHash: hashString(vlei.credentials.leVerifier.said),
      accreditationSaidHash: hashString(vlei.credentials.accreditation.said),
      ecrSaidHash: hashString(vlei.credentials.ecr.said),
      accreditedUntil: t,
      auditorAddedAt: t,
      auditorRevokedAt: 0n,
    },
  };
  const on = (o: Partial<NonNullable<AuthorityExpect["onchain"]>>, over: Partial<AuthorityExpect> = {}) =>
    verifyAuthority(bundle, { ...x, ...over, onchain: { ...x.onchain!, ...o } });

  it("boundaries as the contract's: added at t, accredited until t and revoked at t pass; one second the other way fails", () => {
    expect(on({})).toMatchObject({ ok: true, detail: DEMO_DETAIL });
    expect(on({ auditorRevokedAt: t })).toMatchObject({ ok: true });
    expect(on({ auditorRevokedAt: t - 1n })).toMatchObject({ ok: false, detail: "the auditor's ECR was revoked on the allowlist before registration" });
    expect(on({ accreditedUntil: t - 1n })).toMatchObject({ ok: false, detail: "accreditation (on-chain accreditedUntil) had expired at registration" });
    expect(on({ auditorAddedAt: t + 1n })).toMatchObject({ ok: false, detail: "the auditor was not on the allowlist at registration" });
    expect(on({ auditorAddedAt: 0n })).toMatchObject({ ok: false, detail: "the auditor was not on the allowlist at registration" });
  });

  it("fails closed without the registration time or with a record that was not read", () => {
    expect(on({}, { registeredAt: undefined })).toMatchObject({ ok: false, detail: "no registration time to check the allowlist records against" });
    expect(on({ auditorRevokedAt: undefined as never })).toMatchObject({ ok: false, detail: "the allowlist records of the body and the auditor were not read" });
    expect(on({ accreditedUntil: undefined as never })).toMatchObject({ ok: false, detail: "the allowlist records of the body and the auditor were not read" });
  });
});

describe("check 7: TEL revocations in the evidence count only when the issuer anchored them", () => {
  const t = BigInt(Date.parse("2026-10-06T00:00:00Z") / 1000);
  const chainOf = (revoke: Partial<Record<ImpCredKey, string>> = {}, demoOver: (d: any) => void = () => {}, schema = accSchema) => {
    const d = structuredClone(demo);
    demoOver(d);
    const c = syntheticImpostorChain({ demo: d, accreditationSchema: schema, revoke });
    const x: AuthorityExpect = {
      trustAnchor: c.fixture.trustAnchor,
      auditorAID: c.fixture.agents.impAuditor.aid,
      verifierLEI: d.entities.impostor.lei,
      cnCode: d.product.cnCode,
      registeredAt: t,
    };
    return { bundle: c.bundle, x };
  };

  it("the synthetic chain passes under its own root, and the ECR revocation is anchored by the body (its issuer)", () => {
    const { bundle, x } = chainOf();
    expect(verifyAuthority(bundle, x)).toMatchObject({ ok: true });
    const r = chainOf({ ecr: "2026-10-05T12:00:00.000000+00:00" });
    const rev = parseCesr(r.bundle.cesr.ecr).find((m) => m.ked.t === "rev")!;
    expect(parseCesr(r.bundle.cesr.ecr).some((m) => m.ked.t === "ixn" && m.ked.a.some((s: any) => s.d === rev.ked.d && s.s === "1"))).toBe(true);
  });

  it("an anchored revocation before registration fails; after registration it passes (authority at registration, as check 4), noted in the detail", () => {
    const before = chainOf({ ecr: "2026-10-05T23:59:59.999999+00:00" });
    expect(verifyAuthority(before.bundle, before.x)).toEqual({ ok: false, code: "AUTHORITY_INVALID", detail: "ECR credential: revoked before registration" });
    const acc = chainOf({ accreditation: "2026-10-05T00:00:00Z" });
    expect(verifyAuthority(acc.bundle, acc.x)).toMatchObject({ ok: false, detail: "accreditation credential: revoked before registration" });
    const after = chainOf({ ecr: "2026-10-06T00:00:00.000000+00:00" });
    expect(verifyAuthority(after.bundle, after.x)).toMatchObject({ ok: true, detail: expect.stringMatching(/; revoked after registration in the evidence: ECR$/) });
    // The same instant written with an offset: 02:00+02:00 is 00:00Z.
    const offset = chainOf({ ecr: "2026-10-06T01:59:59+02:00" });
    expect(verifyAuthority(offset.bundle, offset.x)).toMatchObject({ ok: false, detail: "ECR credential: revoked before registration" });
  });

  it("an anchored revocation fails without a registration time, and with a time that has no time zone", () => {
    const r = chainOf({ ecr: "2026-10-07T00:00:00.000000+00:00" });
    expect(verifyAuthority(r.bundle, { ...r.x, registeredAt: undefined })).toMatchObject({ ok: false, detail: "ECR credential: revoked" });
    const naive = chainOf({ ecr: "2026-10-07T00:00:00.000000" });
    expect(verifyAuthority(naive.bundle, naive.x)).toMatchObject({ ok: false, detail: "ECR credential: revoked, at a time that is not ISO 8601 with a time zone" });
  });

  it("a revocation that is unsigned, unanchored or anchored by an event whose signature does not verify is ignored", () => {
    const { bundle, x } = chainOf();
    expect(verifyAuthority({ ...bundle, cesr: { ...bundle.cesr, ecr: withUnsignedRev(bundle.cesr.ecr) } }, x)).toMatchObject({ ok: true });
    // A real, anchored revocation with its anchoring event's controller signature broken.
    const r = chainOf({ ecr: "2026-10-05T00:00:00Z" });
    const msgs = parseCesr(r.bundle.cesr.ecr);
    const rev = msgs.find((m) => m.ked.t === "rev")!;
    const anchor = msgs.find((m) => m.ked.t === "ixn" && m.ked.a.some((s: any) => s.d === rev.ked.d))!;
    const sig = anchor.atc!.slice(4);
    const broken = r.bundle.cesr.ecr.replace(anchor.raw + anchor.atc, anchor.raw + "-AAB" + sig.slice(0, 20) + (sig[20] === "A" ? "B" : "A") + sig.slice(21));
    expect(verifyAuthority({ ...r.bundle, cesr: { ...r.bundle.cesr, ecr: broken } }, r.x)).toMatchObject({ ok: true });
    // The same revocation with its anchoring event removed.
    const unanchored = r.bundle.cesr.ecr.replace(anchor.raw + anchor.atc, "");
    expect(verifyAuthority({ ...r.bundle, cesr: { ...r.bundle.cesr, ecr: unanchored } }, r.x)).toMatchObject({ ok: true });
  });

  it("L6: an accreditation without validUntil fails, also without a registration time; its schema is pinned, not the one the evidence names", () => {
    const none = chainOf({}, (d) => {
      delete d.entities.impostorChain.body.accreditedUntil;
    });
    expect(verifyAuthority(none.bundle, none.x)).toMatchObject({ ok: false, detail: "accreditation credential has no validUntil" });
    expect(verifyAuthority(none.bundle, { ...none.x, registeredAt: undefined })).toMatchObject({ ok: false, detail: "accreditation credential has no validUntil" });
    expect(SCHEMA.ACCREDITATION).toBe(accSchema);
    const other = chainOf({}, () => {}, SCHEMA.LE);
    expect(other.bundle.accreditationSchema).toBe(SCHEMA.LE);
    expect(verifyAuthority(other.bundle, other.x)).toMatchObject({ ok: false, detail: "accreditation credential has another schema" });
  });

  it("L5: an accreditation validUntil without a time zone fails, in any machine time zone", () => {
    const naive = chainOf({}, (d) => {
      d.entities.impostorChain.body.accreditedUntil = "2030-12-31T00:00:00";
    });
    expect(verifyAuthority(naive.bundle, naive.x)).toMatchObject({ ok: false, detail: "accreditation validUntil is not an ISO 8601 time with a time zone" });
    // The expiry boundary is the same second whatever the machine's time zone.
    const until = BigInt(Date.parse("2030-12-31T00:00:00Z") / 1000);
    const { bundle, x } = chainOf();
    const tz = process.env.TZ;
    try {
      for (const zone of ["UTC", "Asia/Taipei", "America/Los_Angeles"]) {
        process.env.TZ = zone;
        expect(verifyAuthority(bundle, { ...x, registeredAt: until }), zone).toMatchObject({ ok: true });
        expect(verifyAuthority(bundle, { ...x, registeredAt: until + 1n }), zone).toMatchObject({ ok: false, detail: "accreditation had expired at registration" });
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe("isoSeconds: ISO 8601 with a time zone only", () => {
  it("reads Z and offsets, drops fractions, and refuses times without a zone, other forms and dates that do not exist", () => {
    const z = BigInt(Date.UTC(2030, 11, 31) / 1000);
    expect(isoSeconds("2030-12-31T00:00:00Z")).toBe(z);
    expect(isoSeconds("2030-12-31T00:00:00.999999+00:00")).toBe(z);
    expect(isoSeconds("2030-12-31T08:00:00+08:00")).toBe(z);
    expect(isoSeconds("2030-12-30T19:30:00-04:30")).toBe(z);
    expect(isoSeconds("2028-02-29T00:00:00Z")).toBe(BigInt(Date.UTC(2028, 1, 29) / 1000));
    for (const bad of [
      "2030-12-31T00:00:00",
      "2030-12-31",
      "2030-12-31 00:00:00Z",
      "2030-12-31t00:00:00z",
      "2030-12-31T00:00Z",
      "2030-12-31T00:00:00+0800",
      "2030-12-31T00:00:00+24:00",
      "2030-02-30T00:00:00Z",
      "2027-02-29T00:00:00Z",
      "2030-13-01T00:00:00Z",
      "2030-12-31T24:00:00Z",
      "2030-12-31T00:00:60Z",
      " 2030-12-31T00:00:00Z",
      "Tue, 31 Dec 2030 00:00:00 GMT",
      "",
      undefined,
      1924905600,
    ]) {
      expect(isoSeconds(bad), String(bad)).toBeUndefined();
    }
  });
});
