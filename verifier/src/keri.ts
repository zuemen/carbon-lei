// Thin helpers over signify-ts 0.4.0 for the local KERIA stack: connect/boot, witnessed AIDs,
// OOBIs, registries, issuance, IPEX grant/admit, and bounded waits on long-running operations.
import {
  ready,
  Saider,
  Salter,
  Serder,
  SignifyClient,
  Tier,
  type Operation,
} from "signify-ts";
import { KERIA_ADMIN_URL, KERIA_BOOT_URL, WITNESS_IDS, WITNESS_THRESHOLD } from "./constants.ts";

export type Json = Record<string, any>;

export interface Aid {
  name: string;
  prefix: string;
  oobi: string;
}

export const OP_TIMEOUT_MS = 60_000;

export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...args);
}

/** KERI-style timestamp (microseconds, explicit offset), as keripy expects in `dt`. */
export function keriTimestamp(date = new Date()): string {
  return date.toISOString().replace("Z", "000+00:00");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `fn` until it returns a value other than undefined, or throws after `timeoutMs`. */
export async function poll<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = OP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2_000);
  }
}

/** Connects to an existing KERIA agent for this passcode, or boots one first. */
export async function connectAgent(bran: string): Promise<SignifyClient> {
  await ready();
  const client = new SignifyClient(KERIA_ADMIN_URL, bran, Tier.low, KERIA_BOOT_URL);
  try {
    await client.connect();
  } catch {
    const res = await client.boot();
    if (!res.ok) throw new Error(`KERIA boot failed: HTTP ${res.status} ${await res.text()}`);
    await client.connect();
  }
  return client;
}

/** Waits for a long-running operation (with a hard timeout), then removes it and its dependencies. */
export async function waitOp<T extends Operation>(client: SignifyClient, op: T, timeoutMs = OP_TIMEOUT_MS): Promise<T> {
  const done = (await client.operations().wait(op, { signal: AbortSignal.timeout(timeoutMs) })) as T;
  const error = (done as Json).error;
  if (error) throw new Error(`operation ${done.name} failed: ${JSON.stringify(error)}`);
  let cur: Operation | undefined = done;
  while (cur) {
    try {
      await client.operations().delete(cur.name);
    } catch {
      // already removed
    }
    cur = (cur.metadata as Json | undefined)?.depends;
  }
  return done;
}

/** Returns the AID `name`, creating it (3 witnesses, toad 2) and its agent end role if missing. */
export async function ensureAid(client: SignifyClient, name: string): Promise<Aid> {
  let prefix: string;
  try {
    prefix = (await client.identifiers().get(name)).prefix;
  } catch {
    const res = await client.identifiers().create(name, { toad: WITNESS_THRESHOLD, wits: WITNESS_IDS });
    const op = await waitOp(client, await res.op());
    prefix = (op.response as Json).i;
  }
  let oobis = (await client.oobis().get(name, "agent")).oobis as string[];
  if (oobis.length === 0) {
    const res = await client.identifiers().addEndRole(name, "agent", client.agent!.pre);
    await waitOp(client, await res.op());
    oobis = (await client.oobis().get(name, "agent")).oobis as string[];
  }
  return { name, prefix, oobi: oobis[0] };
}

export async function resolveOobi(client: SignifyClient, oobi: string, alias?: string): Promise<void> {
  const op = await client.oobis().resolve(oobi, alias);
  await waitOp(client, op);
}

/** Returns the first registry of `name`, creating `registryName` if it has none. */
export async function ensureRegistry(client: SignifyClient, name: string, registryName: string): Promise<string> {
  let regs = await client.registries().list(name);
  if (regs.length === 0) {
    const res = await client.registries().create({ name, registryName });
    await waitOp(client, await res.op());
    regs = await client.registries().list(name);
  }
  return regs[0].regk;
}

/** Edge or rules block with its own SAID in `d`. */
export function saidBlock(body: Json): Json {
  return Saider.saidify({ d: "", ...body })[1];
}

/**
 * Rules block built from the `const` legal language in a schema's `r` section, so the text
 * always matches the schema exactly (the schema rejects any other wording).
 */
export function rulesFromSchema(schema: Json): Json {
  const r = schema?.properties?.r;
  const block = r?.oneOf ? r.oneOf.find((x: Json) => x.type === "object") : r;
  if (!block?.properties) throw new Error(`schema ${schema?.$id} has no rules block`);
  const rules: Json = {};
  for (const [key, prop] of Object.entries<Json>(block.properties)) {
    if (key === "d") continue;
    const l = prop?.properties?.l?.const;
    if (typeof l !== "string") throw new Error(`rule ${key} in ${schema.$id} has no const legal text`);
    rules[key] = { l };
  }
  return saidBlock(rules);
}

export async function rulesFor(client: SignifyClient, schemaSaid: string): Promise<Json> {
  return rulesFromSchema(await client.schemas().get(schemaSaid));
}

export async function findCredential(client: SignifyClient, filter: Json): Promise<Json | undefined> {
  const list = await client.credentials().list({ filter });
  return list[0] as Json | undefined;
}

export interface IssueArgs {
  registry: string;
  schema: string;
  issuee: string;
  attributes: Json;
  edges?: Json;
  rules?: Json;
  privacy?: boolean;
}

/** Issues a credential unless this issuer already issued one with the same schema to the same issuee. */
export async function issueOnce(client: SignifyClient, issuer: Aid, args: IssueArgs): Promise<{ said: string; fresh: boolean }> {
  const existing = await findCredential(client, { "-i": issuer.prefix, "-s": args.schema, "-a-i": args.issuee });
  if (existing) return { said: existing.sad.d, fresh: false };
  const res = await client.credentials().issue(issuer.name, {
    ri: args.registry,
    s: args.schema,
    u: args.privacy ? new Salter({}).qb64 : undefined,
    a: { i: args.issuee, u: args.privacy ? new Salter({}).qb64 : undefined, ...args.attributes },
    e: args.edges,
    r: args.rules,
  });
  await waitOp(client, res.op);
  return { said: res.acdc.sad.d, fresh: true };
}

/** Sends an IPEX grant of credential `said` (held or issued by `sender`) and returns the grant SAID. */
export async function grant(client: SignifyClient, sender: Aid, recipientPre: string, said: string): Promise<string> {
  const cred = (await client.credentials().get(said)) as Json;
  const [exn, sigs, atc] = await client.ipex().grant({
    senderName: sender.name,
    recipient: recipientPre,
    acdc: new Serder(cred.sad),
    iss: new Serder(cred.iss),
    anc: new Serder(cred.anc),
    datetime: keriTimestamp(),
  });
  const op = await client.ipex().submitGrant(sender.name, exn, sigs, atc, [recipientPre]);
  await waitOp(client, op);
  return exn.sad.d as string;
}

/** Waits for the grant notification `grantSaid`, admits it, and waits until the credential is stored. */
export async function admit(
  client: SignifyClient,
  recipient: Aid,
  senderPre: string,
  grantSaid: string,
  credSaid: string,
): Promise<void> {
  const note = await poll(`grant ${grantSaid} at ${recipient.name}`, async () => {
    const res = await client.notifications().list();
    return (res.notes as Json[]).find((n) => n.a?.r === "/exn/ipex/grant" && n.a?.d === grantSaid);
  });
  const [exn, sigs, atc] = await client.ipex().admit({
    senderName: recipient.name,
    recipient: senderPre,
    grantSaid,
    message: "",
    datetime: keriTimestamp(),
  });
  const op = await client.ipex().submitAdmit(recipient.name, exn, sigs, atc, [senderPre]);
  await waitOp(client, op);
  try {
    await client.notifications().mark(note.i);
    await client.notifications().delete(note.i);
  } catch {
    // notification bookkeeping only
  }
  await poll(`credential ${credSaid} at ${recipient.name}`, () => findCredential(client, { "-d": credSaid }));
}

/** Grant + admit, skipped when the recipient already holds the credential. */
export async function present(
  from: { client: SignifyClient; aid: Aid },
  to: { client: SignifyClient; aid: Aid },
  credSaid: string,
): Promise<boolean> {
  if (await findCredential(to.client, { "-d": credSaid })) return false;
  const g = await grant(from.client, from.aid, to.aid.prefix, credSaid);
  await admit(to.client, to.aid, from.aid.prefix, g, credSaid);
  return true;
}
