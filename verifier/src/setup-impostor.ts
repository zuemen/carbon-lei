// Attack 4: the impostor verification body builds a vLEI chain of its own on the local KERIA stack,
// under a root it controls (not the pinned root of trust). Five NEW agents with their own private
// state file, verifier/.data/state-impostor.json. The eight demo agents, verifier/.data/state.json
// and fixtures/vlei.json are never written (fixtures/vlei.json is only read, to refuse an overlap).
//
//   impRoot --QVI--> impQvi --LE--> impNab ------Accreditation--> impBody --ECR--> impAuditor
//                          \--LE--> impBody          (CN 7318)         (CBAM Lead Auditor, privacy)
//
//   node verifier/src/setup-impostor.ts setup
//       builds the chain (idempotent) and writes fixtures/vlei-impostor.json (no passcodes)
//   node verifier/src/setup-impostor.ts export
//       CESR streams, KELs, index.json and authority-bundle.json -> fixtures/evidence/impostor/
//   node verifier/src/setup-impostor.ts anchor [<credSAID>] [--network sepolia|local] [--force]
//       anchors the impostor's credential in impAuditor's KEL -> fixtures/evidence/impostor/anchor-<credSAID>.json
//       (without <credSAID>: the credSAID of fixtures/<network>-credential-impostor.json, network default sepolia)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomPasscode, ready, type SignifyClient } from "signify-ts";
import { DEMO_TRUST_ANCHOR, verifyAuthority } from "../../sdk/vlei.ts";
import { anchorCredential, isEntryPoint } from "./anchor.ts";
import { ECR_SCHEMA_SAID, LE_SCHEMA_SAID, QVI_SCHEMA_SAID, WITNESS_IDS, WITNESS_THRESHOLD, schemaOobi } from "./constants.ts";
import {
  IMP_CRED_FILES,
  IMP_CRED_KEYS,
  IMP_KEYS,
  assertSeparateFromMain,
  impostorAgentInfo,
  impostorAttributes,
  impostorBundle,
  impostorFixture,
  type ImpCredKey,
  type ImpKey,
} from "./impostor-chain.ts";
import { connectAgent, ensureAid, ensureRegistry, issueOnce, log, present, resolveOobi, rulesFor, saidBlock, type Aid, type Json } from "./keri.ts";
import { ACCREDITATION_SCHEMA_PATH, DEMO_PATH, FIXTURE_PATH, REPO_ROOT, STATE_PATH, readJson, reconnectAgent, writeJson } from "./state.ts";

export const IMP_STATE_PATH = resolve(REPO_ROOT, "verifier/.data/state-impostor.json");
export const IMP_FIXTURE_PATH = resolve(REPO_ROOT, "fixtures/vlei-impostor.json");
export const IMP_EVIDENCE_DIR = resolve(REPO_ROOT, "fixtures/evidence/impostor");

const SAID_RE = /^E[A-Za-z0-9_-]{43}$/;
const TIME_BUDGET_S = 150;

interface ImpState {
  createdAt: string;
  agents: Partial<Record<ImpKey, { bran: string; prefix?: string }>>;
}

interface ImpParty {
  key: ImpKey;
  client: SignifyClient;
  aid: Aid;
}

function loadImpState(): ImpState | undefined {
  return existsSync(IMP_STATE_PATH) ? (readJson(IMP_STATE_PATH) as ImpState) : undefined;
}

function saveImpState(state: ImpState): void {
  if (resolve(IMP_STATE_PATH) === resolve(STATE_PATH)) throw new Error("refusing to write the demo agents' state file");
  writeJson(IMP_STATE_PATH, state);
}

function requireImpState(): ImpState {
  const s = loadImpState();
  if (!s) throw new Error(`no ${IMP_STATE_PATH}; run "npm run vlei:impostor:setup" first`);
  return s;
}

async function reconnectImp(state: ImpState, key: ImpKey): Promise<ImpParty> {
  const a = state.agents[key];
  if (!a) throw new Error(`agent ${key} missing from ${IMP_STATE_PATH}`);
  return { key, ...(await reconnectAgent(a.bran, key)) };
}

const mainVlei = () => (existsSync(FIXTURE_PATH) ? readJson(FIXTURE_PATH) : null);

// ------------------------------------------------------------------ setup

async function setup(): Promise<void> {
  await ready();
  const t0 = Date.now();
  const lap = (what: string) => log(`${what} (+${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const demo = readJson(DEMO_PATH);
  const info = impostorAgentInfo(demo);
  const attrs = impostorAttributes(demo, info);
  const accSchemaSaid: string = readJson(ACCREDITATION_SCHEMA_PATH).$id;
  const schemaSaids = [QVI_SCHEMA_SAID, LE_SCHEMA_SAID, ECR_SCHEMA_SAID, accSchemaSaid];

  // Passcodes are persisted before anything is created, so an interrupted run can resume.
  const state: ImpState = loadImpState() ?? { createdAt: new Date().toISOString(), agents: {} };
  for (const k of IMP_KEYS) state.agents[k] ??= { bran: randomPasscode() };
  saveImpState(state);

  // 1. Five new agents and witnessed AIDs (AIDs are named after the agent keys).
  const parties = Object.fromEntries(
    await Promise.all(
      IMP_KEYS.map(async (key): Promise<[ImpKey, ImpParty]> => {
        const client = await connectAgent(state.agents[key]!.bran);
        const aid = await ensureAid(client, key);
        state.agents[key]!.prefix = aid.prefix;
        return [key, { key, client, aid }];
      }),
    ),
  ) as Record<ImpKey, ImpParty>;
  saveImpState(state);
  assertSeparateFromMain(mainVlei(), IMP_KEYS.map((k) => parties[k].aid.prefix), DEMO_TRUST_ANCHOR);
  lap("5 impostor agents connected, AIDs ready");

  // 2. The five resolve each other's agent OOBIs and the four schemas (nobody else's).
  await Promise.all(
    IMP_KEYS.map(async (key) => {
      const { client } = parties[key];
      const contacts = new Set(((await client.contacts().list()) as { alias?: string }[]).map((c) => c.alias));
      for (const other of IMP_KEYS) {
        if (other !== key && !contacts.has(other)) await resolveOobi(client, parties[other].aid.oobi, other);
      }
      const known = new Set(((await client.schemas().list()) as { $id: string }[]).map((s) => s.$id));
      for (const said of schemaSaids) if (!known.has(said)) await resolveOobi(client, schemaOobi(said));
    }),
  );
  lap("OOBIs and schemas resolved");

  // 3. Registries of the four issuers.
  const issuers = ["impRoot", "impQvi", "impNab", "impBody"] as const;
  const regs = Object.fromEntries(
    await Promise.all(issuers.map(async (k) => [k, await ensureRegistry(parties[k].client, k, `${k}-registry`)] as const)),
  ) as Record<(typeof issuers)[number], string>;
  lap("registries ready");

  const { impRoot, impQvi, impNab, impBody, impAuditor } = parties;

  // 4. impRoot -> impQvi: QVI credential.
  const qviCred = await issueOnce(impRoot.client, impRoot.aid, {
    registry: regs.impRoot,
    schema: QVI_SCHEMA_SAID,
    issuee: impQvi.aid.prefix,
    attributes: attrs.qvi,
  });
  await present(impRoot, impQvi, qviCred.said);
  lap(`QVI credential ${qviCred.said}`);

  // 5. impQvi -> impNab, impBody: LE credentials (issued one at a time, then granted in parallel).
  const leRules = await rulesFor(impQvi.client, LE_SCHEMA_SAID);
  const leEdge = saidBlock({ qvi: { n: qviCred.said, s: QVI_SCHEMA_SAID } });
  const leNab = await issueOnce(impQvi.client, impQvi.aid, {
    registry: regs.impQvi,
    schema: LE_SCHEMA_SAID,
    issuee: impNab.aid.prefix,
    attributes: attrs.leNab,
    edges: leEdge,
    rules: leRules,
  });
  const leBody = await issueOnce(impQvi.client, impQvi.aid, {
    registry: regs.impQvi,
    schema: LE_SCHEMA_SAID,
    issuee: impBody.aid.prefix,
    attributes: attrs.leBody,
    edges: leEdge,
    rules: leRules,
  });
  await Promise.all([present(impQvi, impNab, leNab.said), present(impQvi, impBody, leBody.said)]);
  lap("2 LE credentials");

  // 6. impNab -> impBody: accreditation (CN 7318, same schema as the demo's), and
  //    impBody -> impAuditor: ECR in privacy mode, as in the demo chain.
  const [accCred, ecrCred] = await Promise.all([
    (async () => {
      const c = await issueOnce(impNab.client, impNab.aid, {
        registry: regs.impNab,
        schema: accSchemaSaid,
        issuee: impBody.aid.prefix,
        attributes: attrs.accreditation,
        edges: saidBlock({ nab: { n: leNab.said, s: LE_SCHEMA_SAID } }),
        rules: await rulesFor(impNab.client, accSchemaSaid),
      });
      await present(impNab, impBody, c.said);
      return c;
    })(),
    (async () => {
      const c = await issueOnce(impBody.client, impBody.aid, {
        registry: regs.impBody,
        schema: ECR_SCHEMA_SAID,
        issuee: impAuditor.aid.prefix,
        attributes: attrs.ecr,
        edges: saidBlock({ le: { n: leBody.said, s: LE_SCHEMA_SAID } }),
        rules: await rulesFor(impBody.client, ECR_SCHEMA_SAID),
        privacy: true,
      });
      await present(impBody, impAuditor, c.said);
      return c;
    })(),
  ]);
  lap(`Accreditation ${accCred.said}, ECR ${ecrCred.said}`);

  saveImpState(state);
  const fixture = impostorFixture({
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    info,
    aids: Object.fromEntries(IMP_KEYS.map((k) => [k, { prefix: parties[k].aid.prefix, oobi: parties[k].aid.oobi }])) as Record<
      ImpKey,
      { prefix: string; oobi: string }
    >,
    saids: { qvi: qviCred.said, leNab: leNab.said, leBody: leBody.said, accreditation: accCred.said, ecr: ecrCred.said },
    accreditationSchema: accSchemaSaid,
    stack: { keria: "weboftrust/keria:0.4.0", witness: "weboftrust/keri:1.2.13", schemaServer: "gleif/vlei:1.0.3", client: "signify-ts@0.4.0" },
    witnesses: { ids: WITNESS_IDS, toad: WITNESS_THRESHOLD },
  });
  writeJson(IMP_FIXTURE_PATH, fixture);

  const secs = (Date.now() - t0) / 1000;
  lap(`done; wrote ${IMP_FIXTURE_PATH}`);
  console.log(`impostor root (NOT the pinned root): ${fixture.trustAnchor}`);
  console.log(`impostor auditor AID: ${fixture.agents.impAuditor.aid}`);
  console.log(`setup time ${secs.toFixed(1)} s (budget ${TIME_BUDGET_S} s)${secs > TIME_BUDGET_S ? "  OVER BUDGET" : ""}`);
}

// ------------------------------------------------------------------ export

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function exportEvidence(): Promise<void> {
  await ready();
  const state = requireImpState();
  const fx = readJson(IMP_FIXTURE_PATH);
  if (fx.synthetic) throw new Error(`${IMP_FIXTURE_PATH} is synthetic; run "npm run vlei:impostor:setup" first`);
  mkdirSync(IMP_EVIDENCE_DIR, { recursive: true });
  const index: Json = { generatedAt: new Date().toISOString(), trustAnchor: fx.trustAnchor, credentials: {}, kels: {} };
  const save = (file: string, text: string) => {
    writeFileSync(resolve(IMP_EVIDENCE_DIR, file), text);
    return { file, bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) };
  };

  const cesr = {} as Record<ImpCredKey, string>;
  for (const label of IMP_CRED_KEYS) {
    const c = fx.credentials[label];
    const holder = await reconnectImp(state, c.issuee as ImpKey);
    cesr[label] = await holder.client.credentials().get(c.said, true);
    index.credentials[label] = { said: c.said, schema: c.schema, issuer: c.issuer, issuee: c.issuee, ...save(IMP_CRED_FILES[label], cesr[label]) };
    log(`${label}: ${IMP_CRED_FILES[label]} ${index.credentials[label].bytes} B`);
  }
  for (const k of IMP_KEYS) {
    const p = await reconnectImp(state, k);
    const events = await p.client.keyEvents().get(p.aid.prefix);
    const file = `kel-${k}.json`;
    index.kels[k] = { aid: p.aid.prefix, events: events.length, ...save(file, JSON.stringify(events, null, 2) + "\n") };
    log(`${k}: ${file} ${events.length} events`);
  }
  writeJson(resolve(IMP_EVIDENCE_DIR, "index.json"), index);

  const bundle = impostorBundle(fx, cesr, fx.updatedAt);
  const text = JSON.stringify(bundle) + "\n";
  writeFileSync(resolve(IMP_EVIDENCE_DIR, "authority-bundle.json"), text);
  log(`wrote ${IMP_EVIDENCE_DIR}/authority-bundle.json (${text.length} bytes, sha256 ${sha256(text)})`);

  // Self-check: the chain is valid under the impostor's own root and fails only at the pinned root.
  const demo = readJson(DEMO_PATH);
  const expect = {
    auditorAID: fx.agents.impAuditor.aid,
    verifierLEI: demo.entities.impostor.lei,
    cnCode: demo.product.cnCode,
  };
  const own = verifyAuthority(bundle, { ...expect, trustAnchor: fx.trustAnchor });
  const pinned = verifyAuthority(bundle, { ...expect, trustAnchor: DEMO_TRUST_ANCHOR });
  console.log(`check 7 with the impostor's own root configured: ${own.ok ? "PASS" : `FAIL — ${own.detail}`}`);
  console.log(`check 7 with the pinned demo root:            ${pinned.ok ? "PASS" : `FAIL — ${pinned.detail}`}`);
  if (!own.ok || pinned.ok) {
    console.error("unexpected: the impostor chain must pass under its own root and fail under the pinned root");
    process.exit(1);
  }
}

// ------------------------------------------------------------------ anchor

async function anchor(args: string[]): Promise<void> {
  await ready();
  const force = args.includes("--force");
  const ni = args.indexOf("--network");
  const network = ni >= 0 ? args[ni + 1] : "sepolia";
  let credSaid = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--network");
  if (!credSaid) {
    const path = resolve(REPO_ROOT, `fixtures/${network}-credential-impostor.json`);
    if (!existsSync(path)) {
      console.error(`no credSAID given and ${path} does not exist; run the scenario step impostorIssue first`);
      process.exit(2);
    }
    credSaid = readJson(path).credSAID as string;
    log(`credSAID from ${path}: ${credSaid}`);
  }
  if (!SAID_RE.test(credSaid)) {
    console.error("usage: node verifier/src/setup-impostor.ts anchor [<credSAID>] [--network sepolia|local] [--force]");
    process.exit(2);
  }
  const fx = readJson(IMP_FIXTURE_PATH);
  const auditor = await reconnectImp(requireImpState(), "impAuditor");
  if (auditor.aid.prefix !== fx.agents.impAuditor.aid) throw new Error("impAuditor AID differs from fixtures/vlei-impostor.json");
  const { path, out, ok } = await anchorCredential(auditor, credSaid, IMP_EVIDENCE_DIR, { force });
  if (!ok) {
    console.error("anchor export failed its own checks", out.checks);
    process.exit(1);
  }
  log(`wrote ${path}`);
  console.log(JSON.stringify({ credSAID: credSaid, aid: auditor.aid.prefix, kelSeq: out.kelSeq, eventSAID: out.event.said }));
}

async function main(): Promise<void> {
  const [cmd = "setup", ...rest] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "export") return exportEvidence();
  if (cmd === "anchor") return anchor(rest);
  console.error("usage: node verifier/src/setup-impostor.ts setup|export|anchor [<credSAID>] [--network sepolia|local] [--force]");
  process.exit(2);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
