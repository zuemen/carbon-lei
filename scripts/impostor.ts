// Attack 4 (simulated owner-key compromise: an impostor verification body with a vLEI chain of its own
// is put on the allowlist): file locations, the impostor's credential claims, the values the scenario
// puts on the allowlist, and the impostor's proof. Shared by scripts/demo-scenario.ts and
// scripts/build-demo-data.ts. Self-contained (no import from demo-scenario.ts at run time).
//
// Evidence from the local KERIA run (verifier/src/setup-impostor.ts):
//   fixtures/vlei-impostor.json, fixtures/evidence/impostor/ (cred-*.cesr, kel-*.json, index.json,
//   authority-bundle.json, anchor-<credSAID>.json)
// Synthetic evidence for local anvil runs without KERIA (--synthetic-impostor; git-ignored):
//   fixtures/local-impostor/vlei-impostor.json, fixtures/local-impostor/evidence/
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, vleiCheckers } from "../sdk/checkers.ts";
import { METHODOLOGY_NOTE, type CredentialClaims } from "../sdk/credential.ts";
import type { Presentation } from "../sdk/disclosure.ts";
import { newSalt } from "../sdk/encoding.ts";
import { DEMO_DISCLOSURE, present, type SignedCredential } from "../sdk/issue.ts";
import type { EvidenceCheckers } from "../sdk/verify.ts";
import { parseCesr } from "../sdk/vlei.ts";
import { IMP_CRED_FILES, IMP_CRED_KEYS, syntheticImpostorChain } from "../verifier/src/impostor-chain.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = resolve(ROOT, "fixtures");
const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, data: unknown) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

export const demo = readJson(resolve(FIXTURES, "demo.json"));
export const IMPOSTOR_LEI: string = demo.entities.impostor.lei;
export const IMPOSTOR_CHAIN = demo.entities.impostorChain;

/** Where the impostor's bundle and anchor are served next to the page (demo/public/evidence/impostor/). */
export const IMPOSTOR_PUBLIC_DIR = "evidence/impostor";

export type ImpostorEvidenceKind = "keria" | "synthetic";

export interface ImpostorFiles {
  kind: ImpostorEvidenceKind;
  vlei: string;
  evidenceDir: string;
}

export function impostorFiles(kind: ImpostorEvidenceKind = "keria"): ImpostorFiles {
  return kind === "synthetic"
    ? { kind, vlei: resolve(FIXTURES, "local-impostor/vlei-impostor.json"), evidenceDir: resolve(FIXTURES, "local-impostor/evidence") }
    : { kind, vlei: resolve(FIXTURES, "vlei-impostor.json"), evidenceDir: resolve(FIXTURES, "evidence/impostor") };
}

export const impostorCredentialPath = (network: string) => resolve(FIXTURES, `${network}-credential-impostor.json`);
/** Verification of the impostor's proof recorded by the scenario before the watcher's suspension. */
export const impostorVerificationPath = (network: string) => resolve(FIXTURES, `${network}-impostor-verification.json`);
export const impostorAnchorPath = (files: ImpostorFiles, credSaid: string) => resolve(files.evidenceDir, `anchor-${credSaid}.json`);

export interface ImpostorVlei {
  /** The impostor's own root (not the pinned root of trust). */
  trustAnchor: string;
  rootName: string;
  bodyLei: string;
  bodyLeSaid: string;
  accreditationSaid: string;
  auditorAid: string;
  ecrSaid: string;
  updatedAt: string;
  synthetic: boolean;
}

/** The values attack 4 puts on the allowlist, from fixtures/vlei-impostor.json (or its synthetic twin). */
export function loadImpostorVlei(files: ImpostorFiles): ImpostorVlei {
  if (!existsSync(files.vlei)) {
    throw new Error(
      `${files.vlei} not found: run "npm run vlei:impostor:setup" (local KERIA)` +
        (files.kind === "keria" ? ", or --synthetic-impostor on a local anvil" : ""),
    );
  }
  const raw = readJson(files.vlei);
  const need = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v) throw new Error(`${files.vlei} lacks ${what}`);
    return v;
  };
  const out: ImpostorVlei = {
    trustAnchor: need(raw.trustAnchor, "trustAnchor"),
    rootName: need(raw.agents?.impRoot?.name, "agents.impRoot.name"),
    bodyLei: need(raw.agents?.impBody?.lei, "agents.impBody.lei"),
    bodyLeSaid: need(raw.credentials?.leBody?.said, "credentials.leBody.said"),
    accreditationSaid: need(raw.credentials?.accreditation?.said, "credentials.accreditation.said"),
    auditorAid: need(raw.agents?.impAuditor?.aid, "agents.impAuditor.aid"),
    ecrSaid: need(raw.credentials?.ecr?.said, "credentials.ecr.said"),
    updatedAt: need(raw.updatedAt, "updatedAt"),
    synthetic: raw.synthetic === true,
  };
  if (out.bodyLei !== IMPOSTOR_LEI) throw new Error(`${files.vlei} names body LEI ${out.bodyLei}, expected ${IMPOSTOR_LEI}`);
  if ((files.kind === "synthetic") !== out.synthetic) throw new Error(`${files.vlei}: synthetic flag does not match its location`);
  return out;
}

// ------------------------------------------------------------------ synthetic evidence (local only)

function syntheticChain() {
  const accreditationSchema: string = readJson(resolve(ROOT, "verifier/schemas/cbam-verifier-accreditation.json")).$id;
  return syntheticImpostorChain({ demo, accreditationSchema });
}

/** Writes the synthetic chain (deterministic, so re-running rewrites the same files). Local anvil only. */
export function writeSyntheticImpostor(): ImpostorFiles {
  const files = impostorFiles("synthetic");
  const chain = syntheticChain();
  writeJson(files.vlei, chain.fixture);
  mkdirSync(files.evidenceDir, { recursive: true });
  for (const k of IMP_CRED_KEYS) writeFileSync(resolve(files.evidenceDir, IMP_CRED_FILES[k]), chain.cesr[k]);
  writeFileSync(resolve(files.evidenceDir, "authority-bundle.json"), JSON.stringify(chain.bundle) + "\n");
  return files;
}

/** Synthetic anchor of `credSaid` in the impostor auditor's KEL (sn 1). Local anvil only. */
export function writeSyntheticAnchor(credSaid: string): string {
  const files = impostorFiles("synthetic");
  const path = impostorAnchorPath(files, credSaid);
  writeJson(path, syntheticChain().anchor(credSaid));
  return path;
}

// ------------------------------------------------------------------ the impostor's credential and proof

/** Claims of the impostor's credential: a fictional second supplier's fictional installation (not report 1's). */
export function impostorClaims(): CredentialClaims {
  const c = IMPOSTOR_CHAIN;
  const s = c.supplier;
  const r = c.report;
  const inst = s.installations.find((i: { id: string }) => i.id === r.installation);
  if (!inst) throw new Error(`installation ${r.installation} not in entities.impostorChain.supplier`);
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: inst.id,
    installationName: inst.name,
    unLocode: s.unLocode,
    cnCode: demo.product.cnCode,
    cbamRoute: r.cbamRoute,
    productionRoute: "BF-BOF wire rod, cold heading (illustrative)",
    reportingPeriod: r.reportingPeriod,
    verifiedTonnes: r.verifiedTonnes,
    specificEmbeddedEmissions_tCO2e_per_t: r.specificEmbeddedEmissions_tCO2e_per_t,
    valueType: r.valueType,
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: r.verificationReportId,
    verifierLEI: IMPOSTOR_LEI,
    accreditationNumber: c.body.accreditationNumber,
    nabName: c.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "withheld (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: newSalt(),
    batchSalt: newSalt(),
    issuedAt: r.issuedAt,
    validUntil: r.validUntil,
  };
}

export interface ImpostorProof {
  proof: Presentation;
  anchorFile: string;
  bundleFile: string;
  bundleSha256: string;
}

/**
 * The impostor's proof as an importer receives it: the signed core and disclosures (no shipment: the
 * impostor's report has no claim), the auditor's KEL anchor with the auditor's inception event, and a
 * hashed reference to the impostor's authority bundle served at evidence/impostor/.
 */
export function impostorProof(cred: SignedCredential, files: ImpostorFiles): ImpostorProof {
  const credSaid = cred.core.d;
  const anchorFile = impostorAnchorPath(files, credSaid);
  if (!existsSync(anchorFile)) throw new Error(`${anchorFile} not found: anchor the impostor's credential first`);
  const anchorEvidence = readJson(anchorFile);
  if (!anchorEvidence.establishmentRaw) {
    const ecr = resolve(files.evidenceDir, IMP_CRED_FILES.ecr);
    const icp = existsSync(ecr)
      ? parseCesr(readFileSync(ecr, "utf8")).find((m) => m.ked.t === "icp" && m.ked.i === anchorEvidence.auditor)
      : undefined;
    if (icp) {
      anchorEvidence.establishmentRaw = icp.raw;
      if (icp.atc) anchorEvidence.establishmentAttachment = icp.atc; // the inception's witness receipts
    }
  }
  const bundleFile = resolve(files.evidenceDir, "authority-bundle.json");
  if (!existsSync(bundleFile)) throw new Error(`${bundleFile} not found: export the impostor's evidence first`);
  const bundleSha256 = sha256Hex(readFileSync(bundleFile, "utf8"));
  const proof: Presentation = {
    ...present(cred, DEMO_DISCLOSURE),
    anchorEvidence,
    authorityEvidence: { bundle: `${IMPOSTOR_PUBLIC_DIR}/authority-bundle.json`, sha256: bundleSha256 },
  };
  return { proof, anchorFile, bundleFile, bundleSha256 };
}

/** Checks 6–8 for the impostor's proof in Node, with the pinned demo root (never the bundle's own root). */
export function impostorCheckers(files: ImpostorFiles): EvidenceCheckers {
  return vleiCheckers({
    loadBundle: async (path) => {
      const prefix = `${IMPOSTOR_PUBLIC_DIR}/`;
      if (!path.startsWith(prefix)) throw new Error(`unexpected bundle path ${path}`);
      return readFileSync(resolve(files.evidenceDir, path.slice(prefix.length)), "utf8");
    },
  });
}
