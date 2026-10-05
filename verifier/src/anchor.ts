// Anchors a credential SAID in the auditor's KEL with an interaction event whose seal is {d: credSAID},
// prints the event's sequence number (kelSeq), and exports the event for browser-side verification:
// raw event JSON, controller signature(s), signing key(s), and the results of re-checking the SAID
// and the Ed25519 signature locally. If the SAID is already anchored, the existing event is exported
// and no new event is created (pass --force to anchor again).
//   node verifier/src/anchor.ts <credSAID> [--force]
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Siger, Verfer } from "signify-ts";
import { computeSaid } from "../../sdk/said.ts";
import { log, waitOp, type Json } from "./keri.ts";
import { EVIDENCE_DIR, reconnect, requireState, writeJson, type Party } from "./state.ts";

const SAID_RE = /^E[A-Za-z0-9_-]{43}$/;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64Int(s: string): number {
  let n = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`bad base64 char ${ch}`);
    n = n * 64 + v;
  }
  return n;
}

/**
 * Controller indexed signatures from a KEL record attachment. Skips an optional attachment-group
 * counter (-V## or -0V#####), then reads the ControllerIdxSigs group: counter -A## followed by
 * ## indexed Ed25519 signatures (88 characters each, codes A/B).
 */
export function controllerSigs(atc: string): string[] {
  let i = 0;
  if (atc.startsWith("-V")) i = 4;
  else if (atc.startsWith("-0V")) i = 8;
  if (atc.slice(i, i + 2) !== "-A") throw new Error(`no controller signatures in attachment: ${atc.slice(0, 16)}...`);
  const count = b64Int(atc.slice(i + 2, i + 4));
  i += 4;
  const sigs: string[] = [];
  for (let k = 0; k < count; k++) {
    const code = atc[i];
    if (code !== "A" && code !== "B") throw new Error(`unsupported indexed signature code ${code}`);
    sigs.push(new Siger({ qb64: atc.slice(i, i + 88) }).qb64);
    i += 88;
  }
  return sigs;
}

function hasSeal(ked: Json, credSaid: string): boolean {
  return ked.t === "ixn" && Array.isArray(ked.a) && ked.a.some((s: Json) => s?.d === credSaid);
}

/** First KEL event sealing `credSaid`, or, with `eventSaid`, exactly that event. */
async function findAnchor(p: Party, credSaid: string, eventSaid?: string): Promise<{ ked: Json; atc: string } | undefined> {
  const events = (await p.client.keyEvents().get(p.aid.prefix)) as { ked: Json; atc: string }[];
  return events.find((e) => hasSeal(e.ked, credSaid) && (!eventSaid || e.ked.d === eventSaid));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const credSaid = args.find((a) => !a.startsWith("--"));
  if (!credSaid || !SAID_RE.test(credSaid)) {
    console.error("usage: node verifier/src/anchor.ts <credSAID: 44-char CESR Blake3 SAID starting with E> [--force]");
    process.exit(2);
  }

  const auditor = await reconnect(requireState(), "auditor");
  let anchored = force ? undefined : await findAnchor(auditor, credSaid);
  let fresh: { raw: string; sigs: string[] } | undefined;

  if (anchored) {
    log(`already anchored at sn ${parseInt(anchored.ked.s, 16)}; exporting the existing event`);
  } else {
    const res = await auditor.client.identifiers().interact(auditor.aid.name, { d: credSaid });
    await waitOp(auditor.client, await res.op());
    fresh = { raw: res.serder.raw, sigs: res.sigs };
    anchored = await findAnchor(auditor, credSaid, res.serder.sad.d);
    if (!anchored) throw new Error("interaction event not found in the auditor's KEL");
  }

  // Everything below is derived from the KEL as KERIA serves it to any verifier.
  const ked = anchored.ked;
  const raw = JSON.stringify(ked);
  const kelSeq = parseInt(ked.s, 16);
  const sigs = controllerSigs(anchored.atc);
  const hab = await auditor.client.identifiers().get(auditor.aid.name);
  const keyState = hab.state as Json;
  const keys: string[] = keyState.k;
  const msg = new TextEncoder().encode(raw);

  const declaredSize = parseInt(ked.v.slice(10, 16), 16);
  const saidOk = computeSaid(JSON.parse(raw)) === ked.d;
  const sizeOk = msg.length === declaredSize;
  const sigChecks = sigs.map((qb64) => {
    const siger = new Siger({ qb64 });
    const verfer = new Verfer({ qb64: keys[siger.index] });
    return {
      qb64,
      index: siger.index,
      hex: bytesToHex(siger.raw),
      valid: ed25519.verify(siger.raw, msg, verfer.raw),
    };
  });
  const sigOk = sigChecks.length > 0 && sigChecks.every((s) => s.valid);
  const matchesSubmitted = fresh ? fresh.raw === raw && fresh.sigs.every((s) => sigs.includes(s)) : null;

  const out = {
    note: "Interaction event in the auditor's KEL anchoring a credential SAID. Verify: SAID = Blake3-256 over `raw` with `d` replaced by 44 '#'; signature = Ed25519 over the UTF-8 bytes of `raw`.",
    credSAID: credSaid,
    auditor: auditor.aid.prefix,
    kelSeq,
    event: { raw, said: ked.d, type: ked.t, sn: ked.s, prior: ked.p, seals: ked.a },
    signatures: sigChecks.map(({ qb64, index, hex }) => ({ qb64, index, hex })),
    signingKeys: keys.map((qb64) => ({ qb64, hex: bytesToHex(new Verfer({ qb64 }).raw) })),
    signingThreshold: keyState.kt,
    establishmentEvent: { sn: keyState.ee?.s, said: keyState.ee?.d },
    kelAttachment: anchored.atc,
    checks: { saidRecomputed: saidOk, sizeMatchesVersion: sizeOk, signatureValid: sigOk, matchesSubmittedEvent: matchesSubmitted },
    exportedAt: new Date().toISOString(),
  };
  const path = resolve(EVIDENCE_DIR, `anchor-${credSaid}.json`);
  writeJson(path, out);

  if (!saidOk || !sizeOk || !sigOk || matchesSubmitted === false) {
    console.error("anchor export failed its own checks", out.checks);
    process.exit(1);
  }
  log(`wrote ${path}`);
  console.log(JSON.stringify({ credSAID: credSaid, aid: auditor.aid.prefix, kelSeq, eventSAID: ked.d }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
