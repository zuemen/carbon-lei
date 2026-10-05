// Exports static evidence for the hosted demo: the CESR stream of each credential in the chain
// (credentials().get(said, true), which includes the issuer KEL/TEL and the chained sources) and
// the KEL of every issuing or anchoring AID (keyEvents().get(pre)). Output: fixtures/evidence/.
//   node verifier/src/export-evidence.ts
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { EVIDENCE_DIR, FIXTURE_PATH, readJson, reconnect, requireState, writeJson, type AgentKey } from "./state.ts";
import { log, type Json } from "./keri.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const SIZE_HINT_BYTES = 20 * 1024;

const CREDENTIAL_FILES: Record<string, string> = {
  qvi: "cred-qvi.cesr",
  leNab: "cred-le-nab.cesr",
  leVerifier: "cred-le-verifier.cesr",
  leSupplier: "cred-le-supplier.cesr",
  accreditation: "cred-accreditation.cesr",
  ecr: "cred-ecr.cesr",
};

const KEL_AGENTS: AgentKey[] = ["geda", "qvi", "nab", "verifier", "auditor"];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const state = requireState();
  const fx = readJson(FIXTURE_PATH);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const index: Json = { generatedAt: new Date().toISOString(), credentials: {}, kels: {} };
  const oversize: string[] = [];

  const save = (file: string, text: string) => {
    writeFileSync(resolve(EVIDENCE_DIR, file), text);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > SIZE_HINT_BYTES) oversize.push(`${file} (${bytes} B)`);
    return { file, bytes, sha256: sha256(text) };
  };

  for (const [label, file] of Object.entries(CREDENTIAL_FILES)) {
    const c = fx.credentials[label];
    const holder = await reconnect(state, c.issuee as AgentKey);
    const cesr = await holder.client.credentials().get(c.said, true);
    index.credentials[label] = { said: c.said, schema: c.schema, issuer: c.issuer, issuee: c.issuee, ...save(file, cesr) };
    log(`${label}: ${file} ${index.credentials[label].bytes} B`);
  }

  for (const k of KEL_AGENTS) {
    const p = await reconnect(state, k);
    const events = await p.client.keyEvents().get(p.aid.prefix);
    const file = `kel-${k}.json`;
    index.kels[k] = { aid: p.aid.prefix, events: events.length, ...save(file, JSON.stringify(events, null, 2) + "\n") };
    log(`${k}: ${file} ${events.length} events ${index.kels[k].bytes} B`);
  }

  writeJson(resolve(EVIDENCE_DIR, "index.json"), index);
  if (oversize.length) console.warn(`note: over ${SIZE_HINT_BYTES} B: ${oversize.join(", ")}`);
  log(`wrote ${EVIDENCE_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
