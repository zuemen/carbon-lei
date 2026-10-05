// Shared file locations, the eight demo agents, and the private/public state files.
// Private: verifier/.data/state.json (passcodes, git-ignored). Public: fixtures/vlei.json (no secrets).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SignifyClient } from "signify-ts";
import { connectAgent, type Aid, type Json } from "./keri.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
export const STATE_PATH = resolve(REPO_ROOT, "verifier/.data/state.json");
export const FIXTURE_PATH = resolve(REPO_ROOT, "fixtures/vlei.json");
export const DEMO_PATH = resolve(REPO_ROOT, "fixtures/demo.json");
export const EVIDENCE_DIR = resolve(REPO_ROOT, "fixtures/evidence");
export const ACCREDITATION_SCHEMA_PATH = resolve(REPO_ROOT, "verifier/schemas/cbam-verifier-accreditation.json");

export const AGENT_KEYS = ["geda", "qvi", "nab", "verifier", "auditor", "supplier", "importer", "impostor"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export interface AgentInfo {
  key: AgentKey;
  displayName: string;
  role: string;
  lei: string | null;
}

/** Display names and LEIs come from fixtures/demo.json so every component uses the same fiction. */
export function agentInfo(): Record<AgentKey, AgentInfo> {
  const e = readJson(DEMO_PATH).entities;
  const strip = (s: string) => s.replace(/\s*\(fictional[^)]*\)\s*$/, "");
  return {
    geda: { key: "geda", displayName: strip(e.root.name), role: "simulated GLEIF root (GEDA)", lei: null },
    qvi: { key: "qvi", displayName: strip(e.qvi.name), role: "Qualified vLEI Issuer", lei: e.qvi.lei },
    nab: { key: "nab", displayName: strip(e.nab.name), role: "national accreditation body", lei: e.nab.lei },
    verifier: { key: "verifier", displayName: strip(e.verifier.name), role: "accredited CBAM verifier", lei: e.verifier.lei },
    auditor: { key: "auditor", displayName: strip(e.auditor.name), role: e.auditor.role, lei: null },
    supplier: { key: "supplier", displayName: strip(e.supplier.name), role: "installation operator", lei: e.supplier.lei },
    importer: { key: "importer", displayName: strip(e.importers[0].name), role: "CBAM declarant", lei: e.importers[0].lei },
    impostor: { key: "impostor", displayName: strip(e.impostor.name), role: "impostor verifier (no credentials)", lei: e.impostor.lei },
  };
}

export interface AgentState {
  bran: string;
  prefix?: string;
}

export interface PrivateState {
  createdAt: string;
  agents: Partial<Record<AgentKey, AgentState>>;
}

export function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function loadState(): PrivateState | undefined {
  return existsSync(STATE_PATH) ? (readJson(STATE_PATH) as PrivateState) : undefined;
}

export function saveState(state: PrivateState): void {
  writeJson(STATE_PATH, state);
}

export function requireState(): PrivateState {
  const s = loadState();
  if (!s) throw new Error(`no ${STATE_PATH}; run "npm run vlei:setup" first`);
  return s;
}

export interface Party {
  key: AgentKey;
  client: SignifyClient;
  aid: Aid;
}

/** Reconnects an agent from the private state and loads its AID (named after the agent key). */
export async function reconnect(state: PrivateState, key: AgentKey): Promise<Party> {
  const a = state.agents[key];
  if (!a) throw new Error(`agent ${key} missing from ${STATE_PATH}`);
  return { key, ...(await reconnectAgent(a.bran, key)) };
}

/** Connects to the agent for `bran` and loads its AID `name` (any agent set, e.g. the attack 4 chain). */
export async function reconnectAgent(bran: string, name: string): Promise<{ client: SignifyClient; aid: Aid }> {
  const client = await connectAgent(bran);
  const hab = await client.identifiers().get(name);
  const oobis = (await client.oobis().get(name, "agent")).oobis as string[];
  return { client, aid: { name, prefix: hab.prefix, oobi: oobis[0] } };
}
