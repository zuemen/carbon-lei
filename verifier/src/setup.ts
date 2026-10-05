// Builds the demo vLEI trust chain on the local KERIA stack. Idempotent: agents, AIDs, registries
// and credentials that already exist are reused, so it can be re-run at any time.
//
//   geda --QVI--> qvi --LE--> nab ------Accreditation--> verifier --ECR--> auditor
//                      \--LE--> verifier                    (CBAM Lead Auditor)
//                      \--LE--> supplier
//   impostor: an AID with no credentials.
//   Every credential is then presented (IPEX grant/admit) to the importer.
//
//   node verifier/src/setup.ts
import { randomPasscode, ready } from "signify-ts";
import {
  ECR_SCHEMA_SAID,
  LE_SCHEMA_SAID,
  QVI_SCHEMA_SAID,
  WITNESS_IDS,
  WITNESS_THRESHOLD,
  schemaOobi,
} from "./constants.ts";
import { connectAgent, ensureAid, ensureRegistry, issueOnce, log, present, resolveOobi, rulesFor, saidBlock } from "./keri.ts";
import {
  ACCREDITATION_SCHEMA_PATH,
  AGENT_KEYS,
  DEMO_PATH,
  FIXTURE_PATH,
  agentInfo,
  loadState,
  readJson,
  saveState,
  writeJson,
  type AgentKey,
  type Party,
  type PrivateState,
} from "./state.ts";

const TIME_BUDGET_S = 150;

async function main(): Promise<void> {
  await ready();
  const t0 = Date.now();
  const lap = (what: string) => log(`${what} (+${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const info = agentInfo();
  const demo = readJson(DEMO_PATH);
  const accSchemaSaid: string = readJson(ACCREDITATION_SCHEMA_PATH).$id;
  const schemaSaids = [QVI_SCHEMA_SAID, LE_SCHEMA_SAID, ECR_SCHEMA_SAID, accSchemaSaid];

  // Passcodes are persisted before anything is created, so an interrupted run can resume.
  const state: PrivateState = loadState() ?? { createdAt: new Date().toISOString(), agents: {} };
  for (const k of AGENT_KEYS) state.agents[k] ??= { bran: randomPasscode() };
  saveState(state);

  // 1. Agents and witnessed AIDs, all in parallel.
  const parties = Object.fromEntries(
    await Promise.all(
      AGENT_KEYS.map(async (key): Promise<[AgentKey, Party]> => {
        const client = await connectAgent(state.agents[key]!.bran);
        const aid = await ensureAid(client, key);
        state.agents[key]!.prefix = aid.prefix;
        return [key, { key, client, aid }];
      }),
    ),
  ) as Record<AgentKey, Party>;
  saveState(state);
  lap("8 agents connected, AIDs ready");

  // 2. Everyone resolves everyone's agent OOBI and the four schemas (sequential per agent).
  await Promise.all(
    AGENT_KEYS.map(async (key) => {
      const { client } = parties[key];
      const contacts = new Set(((await client.contacts().list()) as { alias?: string }[]).map((c) => c.alias));
      for (const other of AGENT_KEYS) {
        if (other !== key && !contacts.has(other)) await resolveOobi(client, parties[other].aid.oobi, other);
      }
      const known = new Set(((await client.schemas().list()) as { $id: string }[]).map((s) => s.$id));
      for (const said of schemaSaids) if (!known.has(said)) await resolveOobi(client, schemaOobi(said));
    }),
  );
  lap("OOBIs and schemas resolved");

  // 3. Credential registries for the four issuers.
  const issuers = ["geda", "qvi", "nab", "verifier"] as const;
  const regs = Object.fromEntries(
    await Promise.all(issuers.map(async (k) => [k, await ensureRegistry(parties[k].client, k, `${k}-registry`)] as const)),
  ) as Record<(typeof issuers)[number], string>;
  lap("registries ready");

  const { geda, qvi, nab, verifier, auditor, supplier, importer } = parties;

  // 4. geda -> qvi: QVI credential (no edges, no rules).
  const qviCred = await issueOnce(geda.client, geda.aid, {
    registry: regs.geda,
    schema: QVI_SCHEMA_SAID,
    issuee: qvi.aid.prefix,
    attributes: { LEI: info.qvi.lei },
  });
  await present(geda, qvi, qviCred.said);
  lap(`QVI credential ${qviCred.said}`);

  // 5. qvi -> nab, verifier, supplier: LE credentials. Issued one at a time (each anchors in the
  //    QVI's KEL), then granted and admitted in parallel.
  const leRules = await rulesFor(qvi.client, LE_SCHEMA_SAID);
  const leEdge = saidBlock({ qvi: { n: qviCred.said, s: QVI_SCHEMA_SAID } });
  const leHolders = [nab, verifier, supplier];
  const leCreds: Record<string, string> = {};
  for (const h of leHolders) {
    const c = await issueOnce(qvi.client, qvi.aid, {
      registry: regs.qvi,
      schema: LE_SCHEMA_SAID,
      issuee: h.aid.prefix,
      attributes: { LEI: info[h.key].lei },
      edges: leEdge,
      rules: leRules,
    });
    leCreds[h.key] = c.said;
  }
  await Promise.all(leHolders.map((h) => present(qvi, h, leCreds[h.key])));
  lap("3 LE credentials");

  // 6. nab -> verifier: CBAM Verifier Accreditation (edge to the NAB's own LE), and
  //    verifier -> auditor: ECR in privacy mode (edge to the verifier's LE). Different issuers, so parallel.
  const v = demo.entities.verifier;
  const [accCred, ecrCred] = await Promise.all([
    (async () => {
      const c = await issueOnce(nab.client, nab.aid, {
        registry: regs.nab,
        schema: accSchemaSaid,
        issuee: verifier.aid.prefix,
        attributes: {
          LEI: info.verifier.lei,
          accreditationNumber: v.accreditationNumber,
          activity: "Verification of embedded emissions reported under CBAM (demo)",
          cnScope: [demo.product.cnCode],
          validUntil: v.accreditedUntil,
        },
        edges: saidBlock({ nab: { n: leCreds.nab, s: LE_SCHEMA_SAID } }),
        rules: await rulesFor(nab.client, accSchemaSaid),
      });
      await present(nab, verifier, c.said);
      return c;
    })(),
    (async () => {
      const c = await issueOnce(verifier.client, verifier.aid, {
        registry: regs.verifier,
        schema: ECR_SCHEMA_SAID,
        issuee: auditor.aid.prefix,
        attributes: {
          LEI: info.verifier.lei,
          personLegalName: info.auditor.displayName,
          engagementContextRole: info.auditor.role,
        },
        edges: saidBlock({ le: { n: leCreds.verifier, s: LE_SCHEMA_SAID } }),
        rules: await rulesFor(verifier.client, ECR_SCHEMA_SAID),
        privacy: true,
      });
      await present(verifier, auditor, c.said);
      return c;
    })(),
  ]);
  lap(`Accreditation ${accCred.said}, ECR ${ecrCred.said}`);

  // 7. Holders present every credential to the importer: parents first, then the leaves.
  await Promise.all([
    present(qvi, importer, qviCred.said),
    present(nab, importer, leCreds.nab),
    present(verifier, importer, leCreds.verifier),
    present(supplier, importer, leCreds.supplier),
  ]);
  await Promise.all([present(verifier, importer, accCred.said), present(auditor, importer, ecrCred.said)]);
  lap("all credentials presented to the importer");

  // 8. The impostor must hold and have issued nothing.
  const impostorCreds = await parties.impostor.client.credentials().list();
  if (impostorCreds.length !== 0) throw new Error(`impostor unexpectedly has ${impostorCreds.length} credential(s)`);

  saveState(state);
  const fixture = {
    note:
      "Fictional demo identities on a local KERIA stack (verifier/docker-compose.yaml). The root is a simulated " +
      "GEDA, not GLEIF; LEIs use the ZZZZ prefix and are not registered. Passcodes are kept out of this file.",
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    stack: { keria: "weboftrust/keria:0.4.0", witness: "weboftrust/keri:1.2.13", schemaServer: "gleif/vlei:1.0.3", client: "signify-ts@0.4.0" },
    witnesses: { ids: WITNESS_IDS, toad: WITNESS_THRESHOLD },
    trustAnchor: parties.geda.aid.prefix,
    schemas: {
      QVI: QVI_SCHEMA_SAID,
      LE: LE_SCHEMA_SAID,
      ECR: ECR_SCHEMA_SAID,
      CBAMVerifierAccreditation: accSchemaSaid,
    },
    agents: Object.fromEntries(
      AGENT_KEYS.map((k) => [
        k,
        { name: info[k].displayName, role: info[k].role, lei: info[k].lei, aid: parties[k].aid.prefix, oobi: parties[k].aid.oobi },
      ]),
    ),
    credentials: {
      qvi: cred("QVI", qviCred.said, "geda", "qvi"),
      leNab: cred("LE", leCreds.nab, "qvi", "nab"),
      leVerifier: cred("LE", leCreds.verifier, "qvi", "verifier"),
      leSupplier: cred("LE", leCreds.supplier, "qvi", "supplier"),
      accreditation: cred("CBAMVerifierAccreditation", accCred.said, "nab", "verifier", { edge: "nab", parent: leCreds.nab }),
      ecr: cred("ECR", ecrCred.said, "verifier", "auditor", { edge: "le", parent: leCreds.verifier, privacy: true }),
    },
    presentedTo: "importer",
    impostorCredentials: 0,
  };
  function cred(schema: string, said: string, issuer: AgentKey, issuee: AgentKey, extra: Record<string, unknown> = {}) {
    return { said, schema, issuer, issuee, ...extra };
  }
  writeJson(FIXTURE_PATH, fixture);

  const secs = (Date.now() - t0) / 1000;
  lap(`done; wrote ${FIXTURE_PATH}`);
  console.log(`setup time ${secs.toFixed(1)} s (budget ${TIME_BUDGET_S} s)${secs > TIME_BUDGET_S ? "  OVER BUDGET" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
