// Precursor tier (wire rod, CN 7213): a synthetic vLEI chain with two verification bodies under one root, for the
// local precursor demo (scripts/precursor-local.ts) and the tests. No KERIA, no network.
//
//   root --QVI--> qvi --LE--> nab ------Accreditation (CN 7318)--> screwBody --ECR--> screwAuditor
//                    \           \-----Accreditation (CN 7213)--> millBody  --ECR--> millAuditor
//                     \--LE--> screwBody
//                      \-LE--> millBody
//
// Every credential is well formed and correctly chained (real SAIDs, Ed25519 signatures, one KEL per AID, each
// issuance anchored in its issuer's KEL), with deterministic test keys. The root is a synthetic test root, NOT the
// demo's pinned root (DEMO_TRUST_ANCHOR, the simulated GLEIF root of the local KERI run): whoever checks this
// evidence must pin this chain's root explicitly, and a check against the demo root fails (tested). Built here,
// rather than on the KERI stack, because the precursor demo needs a second body and new credential anchors, and
// the demo's KERIA keys are not on the build machine.
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, bytesToHex, utf8 } from "../../sdk/encoding.ts";
import { saidify } from "../../sdk/said.ts";
import { AUDITOR_ROLE, SCHEMA, type AuthorityEvidence } from "../../sdk/vlei.ts";
import { versioned } from "./impostor-chain.ts";

type Json = Record<string, any>;

export const PRECURSOR_CHAIN_NOTE =
  "SYNTHETIC (local precursor demo and tests only; built without KERIA by verifier/src/precursor-chain.ts, deterministic test keys). Its root is a synthetic test root, not the demo's pinned root; a verifier must pin it explicitly. Fictional identities.";

export type BodyKey = "screw" | "mill";
export const BODY_KEYS: readonly BodyKey[] = ["screw", "mill"];

export interface PrecursorChainInput {
  root: { name: string };
  qvi: { name: string; lei: string };
  nab: { name: string; lei: string };
  bodies: Record<
    BodyKey,
    { name: string; lei: string; accreditationNumber: string; accreditedUntil: string; cnScope: string[]; auditor: { name: string } }
  >;
}

/** The input for the demo's two tiers, from fixtures/demo.json (entities and entities.precursorChain). */
export function precursorChainInput(demo: Json): PrecursorChainInput {
  const e = demo?.entities;
  const pc = e?.precursorChain;
  if (!e || !pc) throw new Error("fixtures/demo.json has no entities.precursorChain");
  return {
    root: { name: pc.root.name },
    qvi: { name: pc.qvi.name, lei: pc.qvi.lei },
    nab: { name: pc.nab.name, lei: pc.nab.lei },
    bodies: {
      screw: {
        name: e.verifier.name,
        lei: e.verifier.lei,
        accreditationNumber: e.verifier.accreditationNumber,
        accreditedUntil: e.verifier.accreditedUntil,
        cnScope: [demo.product.cnCode],
        auditor: { name: e.auditor.name },
      },
      mill: {
        name: pc.body.name,
        lei: pc.body.lei,
        accreditationNumber: pc.body.accreditationNumber,
        accreditedUntil: pc.body.accreditedUntil,
        cnScope: pc.body.cnScope,
        auditor: { name: pc.auditor.name },
      },
    },
  };
}

const DEFAULT_SEED = "carbonlei/precursor/synthetic-two-tier";
const DEFAULT_DT = "2026-10-05T00:00:00.000000+00:00";
export const ACCREDITATION_ACTIVITY = "Verification of embedded emissions reported under CBAM (demo)";

const qb64Key = (pub: Uint8Array) => "D" + base64url(new Uint8Array([0, ...pub])).slice(1);
const qb64Digest = (bytes: Uint8Array) => "E" + base64url(new Uint8Array([0, ...blake3(bytes, { dkLen: 32 })])).slice(1);
const qb64Sig = (sig: Uint8Array) => "AA" + base64url(new Uint8Array([0, 0, ...sig])).slice(2);

interface Controller {
  aid: string;
  secret: Uint8Array;
  key: string;
  events: { ked: Json; atc: string }[];
}

export interface BodyChain {
  lei: string;
  name: string;
  bodyAid: string;
  auditorAid: string;
  auditorName: string;
  saids: { leBody: string; accreditation: string; ecr: string };
  /** Authority evidence for check 7 (trustAnchor = this chain's synthetic root). */
  bundle: AuthorityEvidence & { note: string; exportedAt: string };
  /**
   * The auditor's interaction event #1 anchoring every SAID in `credSaids` (one event, several seals), in the shape
   * verifier/src/anchor.ts writes. Each credential's `kelSeq` on the registry is 1.
   */
  anchor: (credSaids: string[]) => Json;
}

export interface PrecursorChain {
  note: string;
  trustAnchor: string;
  qviAid: string;
  nabAid: string;
  qviSaid: string;
  leNabSaid: string;
  bodies: Record<BodyKey, BodyChain>;
}

export function syntheticPrecursorChain(input: PrecursorChainInput, opts: { seed?: string; dt?: string } = {}): PrecursorChain {
  const seed = opts.seed ?? DEFAULT_SEED;
  const dt = opts.dt ?? DEFAULT_DT;
  const iso = dt.replace(/\.(\d{3})\d{3}\+00:00$/, ".$1Z");
  const secretOf = (label: string) => sha256(utf8(`${seed}/${label}`));
  const sign = (c: Controller, ked: Json) => "-AAB" + qb64Sig(ed25519.sign(utf8(JSON.stringify(ked)), c.secret));

  const controller = (k: string): Controller => {
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
    const ked = versioned("KERI", { t: "ixn", d: "", i: c.aid, s: c.events.length.toString(16), p: prev.d, a: seals });
    c.events.push({ ked, atc: sign(c, ked) });
    return ked;
  };
  const registry = (c: Controller, k: string) => {
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
    return { acdc, tel: [iss] };
  };

  const root = controller("root");
  const qvi = controller("qvi");
  const nab = controller("nab");
  const bodyC = { screw: controller("body/screw"), mill: controller("body/mill") };
  const auditorC = { screw: controller("auditor/screw"), mill: controller("auditor/mill") };

  const rootReg = registry(root, "root");
  const cQvi = issue(root, rootReg, SCHEMA.QVI, qvi.aid, { LEI: input.qvi.lei }, "qvi");
  const qviReg = registry(qvi, "qvi");
  const qviEdge = { qvi: { n: cQvi.acdc.d, s: SCHEMA.QVI } };
  const cLeNab = issue(qvi, qviReg, SCHEMA.LE, nab.aid, { LEI: input.nab.lei }, "leNab", qviEdge);
  const cLeBody = {} as Record<BodyKey, ReturnType<typeof issue>>;
  for (const k of BODY_KEYS) cLeBody[k] = issue(qvi, qviReg, SCHEMA.LE, bodyC[k].aid, { LEI: input.bodies[k].lei }, `leBody/${k}`, qviEdge);
  const nabReg = registry(nab, "nab");
  const cAcc = {} as Record<BodyKey, ReturnType<typeof issue>>;
  for (const k of BODY_KEYS) {
    const b = input.bodies[k];
    cAcc[k] = issue(
      nab,
      nabReg,
      SCHEMA.ACCREDITATION,
      bodyC[k].aid,
      { LEI: b.lei, accreditationNumber: b.accreditationNumber, activity: ACCREDITATION_ACTIVITY, cnScope: b.cnScope, validUntil: b.accreditedUntil },
      `accreditation/${k}`,
      { nab: { n: cLeNab.acdc.d, s: SCHEMA.LE } },
    );
  }
  const bodyReg = {} as Record<BodyKey, Json>;
  const cEcr = {} as Record<BodyKey, ReturnType<typeof issue>>;
  for (const k of BODY_KEYS) {
    bodyReg[k] = registry(bodyC[k], `body/${k}`);
    cEcr[k] = issue(
      bodyC[k],
      bodyReg[k],
      SCHEMA.ECR,
      auditorC[k].aid,
      { LEI: input.bodies[k].lei, personLegalName: input.bodies[k].auditor.name, engagementContextRole: AUDITOR_ROLE },
      `ecr/${k}`,
      { le: { n: cLeBody[k].acdc.d, s: SCHEMA.LE } },
      true,
    );
  }

  // CESR text streams laid out like KERIA's credentials().get(said, true): chained sources first, then the issuer's
  // KEL (all of it, so the QVI's and the NAB's KELs are the same in both bodies' bundles), the issuee's inception,
  // the registry, the TEL issuance and the credential.
  const kel = (c: Controller) => c.events.map((e) => JSON.stringify(e.ked) + e.atc).join("");
  const icpOf = (c: Controller) => JSON.stringify(c.events[0].ked) + c.events[0].atc;
  const tail = (issuer: Controller, issuee: Controller, reg: Json, cred: { acdc: Json; tel: Json[] }) =>
    kel(issuer) + icpOf(issuee) + JSON.stringify(reg) + cred.tel.map((e) => JSON.stringify(e)).join("") + JSON.stringify(cred.acdc);
  const sQvi = tail(root, qvi, rootReg, cQvi);
  const sLeNab = sQvi + tail(qvi, nab, qviReg, cLeNab);

  const bodies = {} as Record<BodyKey, BodyChain>;
  for (const k of BODY_KEYS) {
    const sLeBody = sQvi + tail(qvi, bodyC[k], qviReg, cLeBody[k]);
    const sAcc = sLeNab + tail(nab, bodyC[k], nabReg, cAcc[k]);
    const sEcr = sLeBody + tail(bodyC[k], auditorC[k], bodyReg[k], cEcr[k]);
    const auditor = auditorC[k];
    const auditorIcp = auditor.events[0].ked;
    bodies[k] = {
      lei: input.bodies[k].lei,
      name: input.bodies[k].name,
      bodyAid: bodyC[k].aid,
      auditorAid: auditor.aid,
      auditorName: input.bodies[k].auditor.name,
      saids: { leBody: cLeBody[k].acdc.d, accreditation: cAcc[k].acdc.d, ecr: cEcr[k].acdc.d },
      bundle: {
        note: PRECURSOR_CHAIN_NOTE,
        exportedAt: iso,
        trustAnchor: root.aid,
        accreditationSchema: SCHEMA.ACCREDITATION,
        cesr: { qvi: sQvi, leBody: sLeBody, leNab: sLeNab, accreditation: sAcc, ecr: sEcr },
      },
      anchor: (credSaids: string[]) => {
        const ked = versioned("KERI", { t: "ixn", d: "", i: auditor.aid, s: "1", p: auditorIcp.d, a: credSaids.map((d) => ({ d })) });
        const raw = JSON.stringify(ked);
        const sig = ed25519.sign(utf8(raw), auditor.secret);
        return {
          note: `${PRECURSOR_CHAIN_NOTE} Interaction event #1 in the auditor's KEL anchoring credential SAIDs.`,
          synthetic: true,
          credSAID: credSaids[0],
          auditor: auditor.aid,
          kelSeq: 1,
          event: { raw, said: ked.d, type: ked.t, sn: ked.s, prior: ked.p, seals: ked.a },
          signatures: [{ qb64: qb64Sig(sig), index: 0, hex: bytesToHex(sig) }],
          signingKeys: [{ qb64: auditor.key, hex: bytesToHex(ed25519.getPublicKey(auditor.secret)) }],
          signingThreshold: "1",
          establishmentEvent: { sn: "0", said: auditorIcp.d },
          establishmentRaw: JSON.stringify(auditorIcp),
          establishmentAttachment: auditor.events[0].atc,
          kelAttachment: "-AAB" + qb64Sig(sig),
          checks: { saidRecomputed: true, sizeMatchesVersion: true, signatureValid: true, matchesSubmittedEvent: null },
          exportedAt: iso,
        };
      },
    };
  }
  return { note: PRECURSOR_CHAIN_NOTE, trustAnchor: root.aid, qviAid: qvi.aid, nabAid: nab.aid, qviSaid: cQvi.acdc.d, leNabSaid: cLeNab.acdc.d, bodies };
}
