// Revokes a credential as its issuer on the local KERIA stack. Default: the auditor's ECR, revoked by
// the verifier (the accredited body), which is what attack 3 of the demo needs. The issuer's agent
// creates the TEL `rev` event and an interaction event in its KEL with the seal
// { i: credSAID, s: "1", d: <rev SAID> }; this script waits for the operation (witness receipts),
// then prints the rev event and the KEL sequence number of the anchoring event.
//
// DRY RUN unless --confirm is given: without it, it only prints what it would do (it connects to the
// issuer's agent read-only to show the current status). --confirm is refused before the not-before
// time, by default 24 h after registerReport1 on Sepolia (fixtures/sepolia-tx.json), so the demo's
// "report registered before the revocation" window stays intact.
//
//   node verifier/src/revoke-ecr.ts [--cred <SAID>] [--confirm] [--not-before <ISO time>|none]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { keriTimestamp, log, poll, waitOp, type Json } from "./keri.ts";
import { findIssuanceSeal, findRevocationSeal } from "./revocation.ts";
import { FIXTURE_PATH, REPO_ROOT, readJson, reconnect, requireState, type AgentKey, type Party } from "./state.ts";

const SAID_RE = /^E[A-Za-z0-9_-]{43}$/;
const SEPOLIA_TX_PATH = resolve(REPO_ROOT, "fixtures/sepolia-tx.json");
const WINDOW_MS = 24 * 3600 * 1000;

function usage(msg: string): never {
  console.error(`revoke-ecr: ${msg}`);
  console.error("usage: node verifier/src/revoke-ecr.ts [--cred <SAID>] [--confirm] [--not-before <ISO time>|none]");
  process.exit(2);
}

/** registerReport1 block time on Sepolia + 24 h, or undefined when that tx is not recorded. */
function defaultNotBefore(): { at: Date; why: string } | undefined {
  if (!existsSync(SEPOLIA_TX_PATH)) return undefined;
  const tx = (readJson(SEPOLIA_TX_PATH).txs as Json[]).find((t) => t.step === "registerReport1" && t.result === "success");
  if (!tx?.time) return undefined;
  return { at: new Date(Date.parse(tx.time) + WINDOW_MS), why: `registerReport1 on Sepolia at ${tx.time} (block ${tx.block}) + 24 h` };
}

async function credentialStatus(p: Party, ri: string, said: string): Promise<Json | undefined> {
  try {
    return (await p.client.credentials().state(ri, said)) as Json;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cred: { type: "string" },
      confirm: { type: "boolean", default: false },
      "not-before": { type: "string" },
    },
  });
  const fx = readJson(FIXTURE_PATH);
  if (values.cred !== undefined && !SAID_RE.test(values.cred)) usage(`--cred ${values.cred} is not a 44-char SAID`);
  const found = values.cred
    ? Object.entries<Json>(fx.credentials).find(([, c]) => c.said === values.cred)
    : (["ecr", fx.credentials.ecr] as [string, Json]);
  if (!found?.[1]) usage(`credential ${values.cred ?? "ecr"} is not in fixtures/vlei.json`);
  const [label, c] = found;
  const said: string = c.said;
  const issuerKey = c.issuer as AgentKey;
  const holderKey = c.issuee as AgentKey;

  let notBefore: { at: Date; why: string } | undefined;
  const nb = values["not-before"];
  if (nb === "none") notBefore = undefined;
  else if (nb !== undefined) {
    const t = Date.parse(nb);
    if (Number.isNaN(t)) usage(`--not-before ${nb} is not an ISO time`);
    notBefore = { at: new Date(t), why: "--not-before" };
  } else notBefore = defaultNotBefore();
  const now = new Date();
  const tooEarly = !!notBefore && now < notBefore.at;

  console.log(`${values.confirm ? "REVOKE" : "DRY RUN (no --confirm): nothing will be revoked"}`);
  console.log(`  credential   ${label} ${said} (schema ${c.schema})`);
  console.log(`  issuer       ${issuerKey} ${fx.agents[issuerKey].aid} — ${fx.agents[issuerKey].name}`);
  console.log(`  holder       ${holderKey} ${fx.agents[holderKey].aid} — ${fx.agents[holderKey].name}`);
  console.log(`  action       ${issuerKey} agent: credentials().revoke("${issuerKey}", "${said}")`);
  console.log(`               -> TEL rev event { i: ${said}, s: "1", p: <iss SAID>, dt }`);
  console.log(`               -> ixn in the ${issuerKey} KEL with seal { i: ${said}, s: "1", d: <rev SAID> }, witnessed`);
  console.log(
    `  not before   ${notBefore ? `${notBefore.at.toISOString()} (${notBefore.why})` : "none"}; now ${now.toISOString()}` +
      (tooEarly ? " -> --confirm would be REFUSED" : ""),
  );

  // Read-only view from the issuer's own agent.
  const issuer = await reconnect(requireState(), issuerKey);
  const cred = (await issuer.client.credentials().get(said)) as Json;
  const ri: string = cred.sad.ri ?? cred.sad.rd;
  const before = await credentialStatus(issuer, ri, said);
  const kel = (await issuer.client.keyEvents().get(issuer.aid.prefix)) as { ked: Json; atc: string }[];
  const kelSn = Math.max(...kel.map((e) => parseInt(e.ked.s, 16)));
  const iss = findIssuanceSeal(kel, said, { issuer: issuer.aid.prefix });
  const existing = findRevocationSeal(kel, said, { issuer: issuer.aid.prefix });
  console.log(`  registry     ${ri}`);
  console.log(`  TEL status   ${before ? `${before.et} (sn ${before.s}, event ${before.d})` : "unknown"} — issuer's own view`);
  console.log(`  issuer KEL   sn ${kelSn}; issuance seal at sn ${iss ? iss.sn : "?"}; next event would be sn ${kelSn + 1}`);

  if (existing) {
    console.log(`already revoked: rev seal at ${issuerKey} KEL sn ${existing.sn} (event ${existing.eventSaid}, rev ${existing.seal.d}); nothing to do`);
    return;
  }
  if (!values.confirm) {
    console.log("dry run only. Pass --confirm to revoke.");
    return;
  }
  if (tooEarly) {
    console.error(`refused: not before ${notBefore!.at.toISOString()} (${notBefore!.why}). Override with --not-before <ISO time>|none.`);
    process.exitCode = 2;
    return;
  }

  const t0 = Date.now();
  const res = await issuer.client.credentials().revoke(issuer.aid.name, said, keriTimestamp());
  log(`revocation submitted; waiting for witness receipts`);
  await waitOp(issuer.client, res.op);
  const rev = res.rev.sad as Json;
  const anc = res.anc.sad as Json;
  log(`operation done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Confirm from the KEL as KERIA serves it, and from the issuer's TEL.
  const hit = await poll(`rev seal in ${issuerKey} KEL`, async () =>
    findRevocationSeal(await issuer.client.keyEvents().get(issuer.aid.prefix), said, { issuer: issuer.aid.prefix }),
  );
  let after: Json | undefined;
  try {
    after = await poll(`TEL rev state of ${said}`, async () => {
      const s = await credentialStatus(issuer, ri, said);
      return s?.et === "rev" ? s : undefined;
    });
  } catch (err) {
    console.warn(`warning: ${err instanceof Error ? err.message : err}`);
  }

  console.log("TEL rev event:");
  console.log(`  t=${rev.t} d=${rev.d} i=${rev.i} s=${rev.s} ri=${rev.ri} p=${rev.p} dt=${rev.dt}`);
  console.log(`  raw ${res.rev.raw}`);
  console.log(`${issuerKey} KEL anchoring event:`);
  console.log(`  t=${anc.t} sn=${parseInt(anc.s, 16)} d=${anc.d} a=${JSON.stringify(anc.a)}`);
  console.log(`  in KEL: sn ${hit.sn} event ${hit.eventSaid} seal ${JSON.stringify(hit.seal)}${hit.eventSaid === anc.d ? "" : "  (MISMATCH with submitted event)"}`);
  console.log(`  TEL state now: ${after ? `${after.et} (sn ${after.s})` : "not yet rev"}`);
  console.log(
    JSON.stringify({
      credSAID: said,
      credential: label,
      issuer: issuer.aid.prefix,
      revEventSAID: rev.d,
      revokedAt: rev.dt,
      kelSeq: hit.sn,
      kelEventSAID: hit.eventSaid,
      telState: after?.et ?? null,
    }),
  );
  if (hit.eventSaid !== anc.d || hit.seal.d !== rev.d) process.exitCode = 1;
}

main()
  .then(() => process.stdout.write("", () => process.exit(process.exitCode ?? 0)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
