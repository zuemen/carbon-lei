// Read-only health check of the demo trust chain: reconnects every agent from verifier/.data/state.json
// and checks that AIDs, held credentials and the importer's presented copies match fixtures/vlei.json.
// Used after `docker compose restart` to prove that no state was lost. Exit code 1 on any mismatch.
//   node verifier/src/status.ts
import { findCredential, waitOp, type Json } from "./keri.ts";
import { AGENT_KEYS, FIXTURE_PATH, readJson, reconnect, requireState, type AgentKey, type Party } from "./state.ts";

async function main(): Promise<void> {
  const state = requireState();
  const fx = readJson(FIXTURE_PATH);
  const problems: string[] = [];
  const parties = {} as Record<AgentKey, Party>;

  for (const k of AGENT_KEYS) {
    parties[k] = await reconnect(state, k);
    const want = fx.agents[k].aid;
    const got = parties[k].aid.prefix;
    const ks = (await parties[k].client.keyStates().get(got))[0] as Json;
    console.log(`${k.padEnd(9)} ${got}  sn=${parseInt(ks.s, 16)}  witnesses=${ks.b.length}`);
    if (got !== want) problems.push(`${k}: AID ${got} != fixture ${want}`);
  }

  for (const [label, c] of Object.entries<Json>(fx.credentials)) {
    const holder = parties[c.issuee as AgentKey];
    const held = await findCredential(holder.client, { "-d": c.said });
    const atImporter = await findCredential(parties.importer.client, { "-d": c.said });
    const status = held?.status?.et ?? "missing";
    console.log(`${label.padEnd(14)} ${c.said}  holder=${c.issuee}:${status}  importer=${atImporter ? atImporter.status.et : "missing"}`);
    if (!held) problems.push(`${label}: not held by ${c.issuee}`);
    if (!atImporter) problems.push(`${label}: not presented to importer`);
    if (held && held.sad.a.i !== holder.aid.prefix) problems.push(`${label}: issuee mismatch`);
    if (held && c.parent) {
      const edge = held.sad.e?.[c.edge];
      if (edge?.n !== c.parent) problems.push(`${label}: edge ${c.edge} does not point to ${c.parent}`);
    }
  }

  // Witness check: the importer asks the witnesses for the auditor's latest key state, which
  // only works if the witnesses kept the auditor's KEL (state survives a restart).
  const auditorPre = parties.auditor.aid.prefix;
  const ownSn = parseInt(((await parties.auditor.client.keyStates().get(auditorPre))[0] as Json).s, 16);
  const qop = await parties.importer.client.keyStates().query(auditorPre, ownSn.toString(16));
  const queried = ((await waitOp(parties.importer.client, qop)) as Json).response as Json;
  const seenSn = parseInt(queried.s, 16);
  console.log(`importer -> witnesses: auditor sn=${seenSn} (auditor's own sn=${ownSn})`);
  if (seenSn !== ownSn) problems.push(`witness query returned sn ${seenSn}, expected ${ownSn}`);

  const impostorCreds = await parties.impostor.client.credentials().list();
  console.log(`impostor credentials: ${impostorCreds.length}`);
  if (impostorCreds.length !== 0) problems.push("impostor holds credentials");

  if (problems.length) {
    console.error(`FAIL\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("OK: all AIDs and credentials present");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
