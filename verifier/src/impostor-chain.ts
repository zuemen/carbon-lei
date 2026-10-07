// Attack 4 (an impostor verification body with a vLEI chain of its own): pure helpers shared by the
// KERIA setup (verifier/src/setup-impostor.ts), the demo scenario and the tests. No KERIA, no network.
//
//   impRoot --QVI--> impQvi --LE--> impNab ------Accreditation--> impBody --ECR--> impAuditor
//                          \--LE--> impBody                           (CBAM Lead Auditor)
//
// Every credential is well formed and correctly chained; the only flaw is the root: impRoot is not the
// root of trust a verifier pins, so check 7 must fail with the pinned-root reason.
//
// syntheticImpostorChain() builds the same chain without KERIA (deterministic test keys, real SAIDs and
// Ed25519 signatures) for local runs and tests only. It is never written to fixtures/evidence/.
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, bytesToHex, utf8 } from "../../sdk/encoding.ts";
import { SAID_DUMMY, computeSaid, saidify } from "../../sdk/said.ts";
import { SCHEMA, type AuthorityEvidence } from "../../sdk/vlei.ts";

type Json = Record<string, any>;

export const IMP_KEYS = ["impRoot", "impQvi", "impNab", "impBody", "impAuditor"] as const;
export type ImpKey = (typeof IMP_KEYS)[number];

export const IMP_CRED_KEYS = ["qvi", "leNab", "leBody", "accreditation", "ecr"] as const;
export type ImpCredKey = (typeof IMP_CRED_KEYS)[number];

/** Evidence file of each credential's CESR stream in fixtures/evidence/impostor/. */
export const IMP_CRED_FILES: Record<ImpCredKey, string> = {
  qvi: "cred-qvi.cesr",
  leNab: "cred-le-nab.cesr",
  leBody: "cred-le-body.cesr",
  accreditation: "cred-accreditation.cesr",
  ecr: "cred-ecr.cesr",
};

export const ACCREDITATION_ACTIVITY = "Verification of embedded emissions reported under CBAM (demo)";

export interface ImpAgentInfo {
  key: ImpKey;
  displayName: string;
  role: string;
  lei: string | null;
}

/** Names, roles and LEIs of the five agents, from fixtures/demo.json (entities.impostorChain and entities.impostor). */
export function impostorAgentInfo(demo: Json): Record<ImpKey, ImpAgentInfo> {
  const c = demo?.entities?.impostorChain;
  const body = demo?.entities?.impostor;
  if (!c || !body) throw new Error("fixtures/demo.json has no entities.impostorChain or entities.impostor");
  const strip = (s: string) => s.replace(/\s*\(fictional[^)]*\)\s*$/, "");
  return {
    impRoot: { key: "impRoot", displayName: strip(c.root.name), role: c.root.role, lei: null },
    impQvi: { key: "impQvi", displayName: strip(c.qvi.name), role: "Qualified vLEI Issuer under the impostor's own root", lei: c.qvi.lei },
    impNab: { key: "impNab", displayName: strip(c.nab.name), role: "accreditation body under the impostor's own root", lei: c.nab.lei },
    impBody: { key: "impBody", displayName: strip(body.name), role: "impostor verification body", lei: body.lei },
    impAuditor: { key: "impAuditor", displayName: strip(c.auditor.name), role: c.auditor.role, lei: null },
  };
}

/** Attributes of each credential, identical in the KERIA setup and the synthetic chain. */
export function impostorAttributes(demo: Json, info = impostorAgentInfo(demo)) {
  const c = demo.entities.impostorChain;
  return {
    qvi: { LEI: info.impQvi.lei },
    leNab: { LEI: info.impNab.lei },
    leBody: { LEI: info.impBody.lei },
    accreditation: {
      LEI: info.impBody.lei,
      accreditationNumber: c.body.accreditationNumber,
      activity: ACCREDITATION_ACTIVITY,
      cnScope: [demo.product.cnCode],
      validUntil: c.body.accreditedUntil,
    },
    ecr: { LEI: info.impBody.lei, personLegalName: info.impAuditor.displayName, engagementContextRole: info.impAuditor.role },
  } as Record<ImpCredKey, Json>;
}

/**
 * Refuses an impostor chain that shares an AID with the eight demo agents (fixtures/vlei.json) or whose
 * root is the pinned root of trust: attack 4 must not touch the demo chain.
 */
export function assertSeparateFromMain(mainVlei: Json | null, impAids: string[], pinnedRoot: string): void {
  const main = new Set<string>(Object.values<Json>(mainVlei?.agents ?? {}).map((a) => a?.aid).filter(Boolean));
  if (mainVlei?.trustAnchor) main.add(mainVlei.trustAnchor);
  const shared = impAids.filter((a) => main.has(a));
  if (shared.length) throw new Error(`impostor AIDs overlap the demo agents: ${shared.join(", ")}`);
  if (impAids.includes(pinnedRoot)) throw new Error("the impostor's root must not be the pinned root of trust");
}

export interface ImpCredRecord {
  said: string;
  schema: string;
  issuer: ImpKey;
  issuee: ImpKey;
  edge?: string;
  parent?: string;
  privacy?: boolean;
}

/** fixtures/vlei-impostor.json (no secrets). Written by setup-impostor.ts and, locally, by the synthetic chain. */
export function impostorFixture(args: {
  createdAt: string;
  updatedAt: string;
  info: Record<ImpKey, ImpAgentInfo>;
  aids: Record<ImpKey, { prefix: string; oobi?: string }>;
  saids: Record<ImpCredKey, string>;
  accreditationSchema: string;
  stack: Json;
  witnesses?: Json;
  synthetic?: boolean;
}): Json {
  const s = args.saids;
  const cred = (schema: string, said: string, issuer: ImpKey, issuee: ImpKey, extra: Partial<ImpCredRecord> = {}): ImpCredRecord => ({
    said,
    schema,
    issuer,
    issuee,
    ...extra,
  });
  return {
    note:
      (args.synthetic
        ? "SYNTHETIC (local test only, built without KERIA by verifier/src/impostor-chain.ts). "
        : "") +
      "Attack 4: a vLEI chain the impostor verification body built for itself on the local KERIA stack. Its root is the impostor's own AID, not the pinned root of trust, so check 7 rejects it. Fictional identities; LEIs use the ZZZZ prefix. Passcodes are kept out of this file.",
    ...(args.synthetic ? { synthetic: true } : {}),
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    stack: args.stack,
    ...(args.witnesses ? { witnesses: args.witnesses } : {}),
    trustAnchor: args.aids.impRoot.prefix,
    schemas: { QVI: SCHEMA.QVI, LE: SCHEMA.LE, ECR: SCHEMA.ECR, CBAMVerifierAccreditation: args.accreditationSchema },
    agents: Object.fromEntries(
      IMP_KEYS.map((k) => [
        k,
        {
          name: args.info[k].displayName,
          role: args.info[k].role,
          lei: args.info[k].lei,
          aid: args.aids[k].prefix,
          ...(args.aids[k].oobi ? { oobi: args.aids[k].oobi } : {}),
        },
      ]),
    ),
    credentials: {
      qvi: cred("QVI", s.qvi, "impRoot", "impQvi"),
      leNab: cred("LE", s.leNab, "impQvi", "impNab"),
      leBody: cred("LE", s.leBody, "impQvi", "impBody"),
      accreditation: cred("CBAMVerifierAccreditation", s.accreditation, "impNab", "impBody", { edge: "nab", parent: s.leNab }),
      ecr: cred("ECR", s.ecr, "impBody", "impAuditor", { edge: "le", parent: s.leBody, privacy: true }),
    },
  };
}

/** Authority bundle for check 7 (fixtures/evidence/impostor/authority-bundle.json): trustAnchor = the impostor's own root. */
export function impostorBundle(fixture: Json, cesr: Record<ImpCredKey, string>, exportedAt: string): AuthorityEvidence & { note: string; exportedAt: string } {
  return {
    note:
      (fixture.synthetic ? "SYNTHETIC (local test only). " : "") +
      "Attack 4: the impostor's own vLEI chain (fictional identities). Its trustAnchor is the impostor's root; a verifier pins its own root and ignores this field.",
    exportedAt,
    trustAnchor: fixture.trustAnchor,
    accreditationSchema: fixture.schemas.CBAMVerifierAccreditation,
    cesr: { qvi: cesr.qvi, leBody: cesr.leBody, leNab: cesr.leNab, accreditation: cesr.accreditation, ecr: cesr.ecr },
  };
}

// ------------------------------------------------------------------ synthetic chain (no KERIA)

const DEFAULT_SEED = "carbonlei/attack4/synthetic-impostor";
const DEFAULT_DT = "2026-10-05T00:00:00.000000+00:00";

const qb64Key = (pub: Uint8Array) => "D" + base64url(new Uint8Array([0, ...pub])).slice(1);
const qb64Digest = (bytes: Uint8Array) => "E" + base64url(new Uint8Array([0, ...blake3(bytes, { dkLen: 32 })])).slice(1);
const qb64Sig = (sig: Uint8Array) => "AA" + base64url(new Uint8Array([0, 0, ...sig])).slice(2);

/** A KERI or ACDC message with a correct version-string size and its SAID in every `labels` field. */
export function versioned(proto: "KERI" | "ACDC", body: Json, labels: string[] = ["d"]): Json {
  const ev: Json = { v: `${proto}10JSON000000_`, ...body };
  for (const l of labels) ev[l] = SAID_DUMMY;
  ev.v = `${proto}10JSON${utf8(JSON.stringify(ev)).length.toString(16).padStart(6, "0")}_`;
  const said = computeSaid(ev);
  for (const l of labels) ev[l] = said;
  return ev;
}

interface Controller {
  aid: string;
  secret: Uint8Array;
  key: string;
  events: { ked: Json; atc: string }[];
}

export interface SyntheticOptions {
  demo: Json;
  accreditationSchema: string;
  /** Key-derivation seed; the default gives the same chain on every run. */
  seed?: string;
  /** Issuance time written into the credentials and TEL events. */
  dt?: string;
  /**
   * Tests only: credentials to revoke, each with the time of its TEL revocation. The issuer anchors the
   * `rev` event in its KEL right after the issuance, as KERIA does; the stream carries it after `iss`.
   */
  revoke?: Partial<Record<ImpCredKey, string>>;
}

export interface SyntheticChain {
  fixture: Json;
  saids: Record<ImpCredKey, string>;
  cesr: Record<ImpCredKey, string>;
  bundle: AuthorityEvidence & { note: string; exportedAt: string };
  /** The impostor auditor's interaction event anchoring `credSaid` (sn 1), in the shape verifier/src/anchor.ts writes. */
  anchor: (credSaid: string) => Json;
}

/** The attack 4 chain without KERIA: deterministic Ed25519 test keys, real SAIDs, signed KEL events. */
export function syntheticImpostorChain(opts: SyntheticOptions): SyntheticChain {
  const seed = opts.seed ?? DEFAULT_SEED;
  const dt = opts.dt ?? DEFAULT_DT;
  const info = impostorAgentInfo(opts.demo);
  const attrs = impostorAttributes(opts.demo, info);
  const secretOf = (label: string) => sha256(utf8(`${seed}/${label}`));
  const sign = (c: Controller, ked: Json) => "-AAB" + qb64Sig(ed25519.sign(utf8(JSON.stringify(ked)), c.secret));

  const controller = (k: ImpKey): Controller => {
    const secret = secretOf(`key/${k}`);
    const key = qb64Key(ed25519.getPublicKey(secret));
    const next = qb64Digest(ed25519.getPublicKey(secretOf(`next/${k}`)));
    const icp = versioned("KERI", { t: "icp", d: "", i: "", s: "0", kt: "1", k: [key], nt: "1", n: [next], bt: "0", b: [], c: [], a: [] }, ["d", "i"]);
    const c: Controller = { aid: icp.i, secret, key, events: [] };
    c.events.push({ ked: icp, atc: sign(c, icp) });
    return c;
  };
  const ixn = (c: Controller, seals: Json[]) => {
    const prev = c.events[c.events.length - 1].ked;
    const ked = versioned("KERI", { t: "ixn", d: "", i: c.aid, s: (c.events.length).toString(16), p: prev.d, a: seals });
    c.events.push({ ked, atc: sign(c, ked) });
    return ked;
  };
  const registry = (c: Controller, k: ImpKey) => {
    const nonce = "A" + base64url(new Uint8Array([0, ...secretOf(`registry/${k}`)])).slice(1);
    const vcp = versioned("KERI", { t: "vcp", d: "", i: "", ii: c.aid, s: "0", c: ["NB"], bt: "0", b: [], n: nonce }, ["d", "i"]);
    ixn(c, [{ i: vcp.i, s: "0", d: vcp.d }]);
    return vcp;
  };
  const salt = (label: string) => "0A" + base64url(secretOf(`salt/${label}`).slice(0, 16));
  const issue = (issuer: Controller, reg: Json, schema: string, issuee: string, a: Json, label: string, edges?: Json, privacy = false) => {
    const block = saidify({ d: "", ...(privacy ? { u: salt(`${label}/a`) } : {}), i: issuee, dt, ...a });
    const acdc = versioned("ACDC", {
      d: "",
      ...(privacy ? { u: salt(`${label}/top`) } : {}),
      i: issuer.aid,
      ri: reg.i,
      s: schema,
      a: block,
      ...(edges ? { e: saidify({ d: "", ...edges }) } : {}),
    });
    const iss = versioned("KERI", { t: "iss", d: "", i: acdc.d, s: "0", ri: reg.i, dt });
    ixn(issuer, [{ i: acdc.d, s: "0", d: iss.d }]);
    const revDt = opts.revoke?.[label as ImpCredKey];
    if (revDt === undefined) return { acdc, iss, tel: [iss] };
    const rev = versioned("KERI", { t: "rev", d: "", i: acdc.d, s: "1", ri: reg.i, p: iss.d, dt: revDt });
    ixn(issuer, [{ i: acdc.d, s: "1", d: rev.d }]);
    return { acdc, iss, tel: [iss, rev] };
  };

  const root = controller("impRoot");
  const qvi = controller("impQvi");
  const nab = controller("impNab");
  const body = controller("impBody");
  const auditor = controller("impAuditor");

  const rootReg = registry(root, "impRoot");
  const cQvi = issue(root, rootReg, SCHEMA.QVI, qvi.aid, attrs.qvi, "qvi");
  const qviReg = registry(qvi, "impQvi");
  const qviEdge = { qvi: { n: cQvi.acdc.d, s: SCHEMA.QVI } };
  const cLeNab = issue(qvi, qviReg, SCHEMA.LE, nab.aid, attrs.leNab, "leNab", qviEdge);
  const cLeBody = issue(qvi, qviReg, SCHEMA.LE, body.aid, attrs.leBody, "leBody", qviEdge);
  const nabReg = registry(nab, "impNab");
  const cAcc = issue(nab, nabReg, opts.accreditationSchema, body.aid, attrs.accreditation, "accreditation", {
    nab: { n: cLeNab.acdc.d, s: SCHEMA.LE },
  });
  const bodyReg = registry(body, "impBody");
  const cEcr = issue(body, bodyReg, SCHEMA.ECR, auditor.aid, attrs.ecr, "ecr", { le: { n: cLeBody.acdc.d, s: SCHEMA.LE } }, true);

  // CESR text streams laid out like KERIA's credentials().get(said, true): chained sources first, then the
  // issuer's KEL, the issuee's inception, the registry, the TEL issuance and the credential.
  const kel = (c: Controller) => c.events.map((e) => JSON.stringify(e.ked) + e.atc).join("");
  const icpOf = (c: Controller) => JSON.stringify(c.events[0].ked) + c.events[0].atc;
  const tail = (issuer: Controller, issuee: Controller, reg: Json, cred: { acdc: Json; tel: Json[] }) =>
    kel(issuer) + icpOf(issuee) + JSON.stringify(reg) + cred.tel.map((e) => JSON.stringify(e)).join("") + JSON.stringify(cred.acdc);
  const sQvi = tail(root, qvi, rootReg, cQvi);
  const sLeNab = sQvi + tail(qvi, nab, qviReg, cLeNab);
  const sLeBody = sQvi + tail(qvi, body, qviReg, cLeBody);
  const sAcc = sLeNab + tail(nab, body, nabReg, cAcc);
  const sEcr = sLeBody + tail(body, auditor, bodyReg, cEcr);

  const saids: Record<ImpCredKey, string> = {
    qvi: cQvi.acdc.d,
    leNab: cLeNab.acdc.d,
    leBody: cLeBody.acdc.d,
    accreditation: cAcc.acdc.d,
    ecr: cEcr.acdc.d,
  };
  const cesr: Record<ImpCredKey, string> = { qvi: sQvi, leNab: sLeNab, leBody: sLeBody, accreditation: sAcc, ecr: sEcr };
  const iso = dt.replace(/\.(\d{3})\d{3}\+00:00$/, ".$1Z");
  const fixture = impostorFixture({
    createdAt: iso,
    updatedAt: iso,
    info,
    aids: { impRoot: { prefix: root.aid }, impQvi: { prefix: qvi.aid }, impNab: { prefix: nab.aid }, impBody: { prefix: body.aid }, impAuditor: { prefix: auditor.aid } },
    saids,
    accreditationSchema: opts.accreditationSchema,
    stack: { synthetic: "verifier/src/impostor-chain.ts (no KERIA; deterministic test keys)" },
    synthetic: true,
  });

  const auditorIcp = auditor.events[0].ked;
  const anchor = (credSaid: string): Json => {
    const ked = versioned("KERI", { t: "ixn", d: "", i: auditor.aid, s: "1", p: auditorIcp.d, a: [{ d: credSaid }] });
    const raw = JSON.stringify(ked);
    const sig = ed25519.sign(utf8(raw), auditor.secret);
    return {
      note: "SYNTHETIC (local test only). Interaction event in the impostor auditor's KEL anchoring a credential SAID, in the shape verifier/src/anchor.ts writes.",
      synthetic: true,
      credSAID: credSaid,
      auditor: auditor.aid,
      kelSeq: 1,
      event: { raw, said: ked.d, type: ked.t, sn: ked.s, prior: ked.p, seals: ked.a },
      signatures: [{ qb64: qb64Sig(sig), index: 0, hex: bytesToHex(sig) }],
      signingKeys: [{ qb64: auditor.key, hex: bytesToHex(ed25519.getPublicKey(auditor.secret)) }],
      signingThreshold: "1",
      establishmentEvent: { sn: "0", said: auditorIcp.d },
      kelAttachment: "-AAB" + qb64Sig(sig),
      checks: { saidRecomputed: true, sizeMatchesVersion: true, signatureValid: true, matchesSubmittedEvent: null },
      exportedAt: iso,
    };
  };

  return { fixture, saids, cesr, bundle: impostorBundle(fixture, cesr, iso), anchor };
}
