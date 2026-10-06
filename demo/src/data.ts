// Shape of demo/public/demo-data.json, written by scripts/build-demo-data.ts from the
// recorded demo scenario (fixtures/sepolia-tx.json, fixtures/vlei.json, fixtures/evidence/).
// The hosted page reads only this file plus live calls to the contracts.
import type { Deployment } from "../../sdk/chain.ts";
import type { Hex } from "../../sdk/credential.ts";
import type { Presentation } from "../../sdk/disclosure.ts";

export type TxResult = "success" | "reverted";

export interface DemoTx {
  /**
   * Stable step id, e.g. "addVerifier", "addAuditor", "registerReport1", "claim1", "revokeAuditor", "attack3",
   * and for attack 4 "impostorAddVerifier", "impostorAddAuditor", "impostorRegister", "impostorSuspend".
   */
  step: string;
  label: string;
  hash: Hex;
  block: number;
  /** ISO 8601 UTC time of the block. */
  time: string;
  result: TxResult;
  /** Gas used, from the transaction receipt. */
  gasUsed?: number;
}

export interface TrustNode {
  id: "root" | "qvi" | "nab" | "body" | "auditor";
  name: string;
  role: string;
  lei?: string;
  aid?: string;
  credentialSaid?: string;
  /** Status in the exported evidence. */
  status: "valid" | "revoked" | "suspended" | "expired";
  evidenceFile?: string;
  /** What happened after the export (for example a revocation synced on-chain later). */
  note?: string;
}

export interface CachedSnapshot {
  block: number;
  time: string;
  /** On-chain values read at build time, used only when the reviewer asks for the cached view. */
  remainingKg: string;
  reportValid: boolean;
  shipment: { claimedAt: string; quantityKg: string; reportValid: boolean };
  verification: unknown;
  dryRuns: Record<string, { errorName: string; args: string[] }>;
}

/**
 * Attack 4: a simulated compromise of the allowlist owner key puts an impostor verification body, whose vLEI chain
 * leads to its own root, on the allowlist. Its registration succeeds; check 7 rejects its proof.
 */
export interface Attack4 {
  /** Where the impostor's vLEI evidence comes from: the local KERI run, or a synthetic chain (local tests only). */
  evidence: "keria" | "synthetic";
  /** Date of the impostor's evidence export (YYYY-MM-DD). */
  exportDate: string;
  body: { name: string; lei: string; address: Hex };
  /** The root the impostor's chain leads to, and the root the page pins (DEMO_TRUST_ANCHOR). */
  impostorRoot: { name: string; aid: string };
  pinnedRoot: string;
  supplier: { name: string; installationName: string };
  /** The impostor's proof (no shipment; authority bundle at evidence/impostor/). */
  proof: Presentation;
  txs: { addVerifier: DemoTx; addAuditor: DemoTx; register: DemoTx; suspend: DemoTx };
  /** registerReport from the impostor after the suspension (eth_call); bigint fields as decimal strings. */
  dryRun: { input: Record<string, string>; caller: Hex };
  /** The verification of the proof taken when the data was built. */
  verification: unknown;
  /** The same verification recorded by the scenario before the watcher's suspension, if recorded. */
  beforeSuspension: { block: number; time: string; verification: unknown } | null;
  evidenceFiles: { label: string; path: string }[];
}

export interface DemoData {
  version: 1;
  mode: "hosted" | "local";
  network: { chainId: number; name: string; rpcs: string[]; explorer: string };
  deployment: Deployment & { deployTxs: { VerifierAllowlist: Hex; EmissionsClaimRegistry: Hex }; sourceVerified: boolean };
  /** Date of the vLEI evidence export from the local KERI run (YYYY-MM-DD). */
  exportDate: string;
  /** Wallet addresses that appear in the demo. */
  addresses: { owner: Hex; watcher: Hex; body: Hex; supplier: Hex; impostor: Hex };
  /** The importer the demo proof was issued for (Buyer tab default). */
  importer: { name: string; eori: string };
  secondImporter: { name: string; eori: string };
  /** Supplier's proof for the demo shipment (Buyer tab "Load the demo proof"). */
  proof: Presentation;
  /** All encoded disclosures of the demo credential, so the Supplier tab can build proofs with other field choices. */
  credential: { coreJson: string; signature: Hex; disclosures: Record<string, string>; reportKey: Hex; kelSeq: string };
  report: {
    installationName: string;
    installationId: string;
    cnCode: string;
    reportingPeriod: string;
    verifiedTonnes: string;
    intensity: string;
    reportId: string;
    accreditationNumber: string;
    issuedAt: string;
  };
  shipment: { batchId: string; quantityTonnes: string; shipmentDate: string; importerSalt: Hex };
  /** Attack 2a/2b dry-run arguments (claimShipment), attack 3 transaction, attack 4 (when recorded). */
  attacks: {
    sameBatch: { args: [Hex, Hex, string, Hex]; caller: Hex };
    secondImporter: { args: [Hex, Hex, string, Hex]; caller: Hex; quantityTonnes: string };
    attack3: DemoTx | null;
    attack4?: Attack4;
  };
  txs: DemoTx[];
  trustChain: TrustNode[];
  impostor: { name: string; lei: string };
  comparison: { defaultValue: string; verifiedValue: string; quantityTonnes: string; priceEur: string; quarter: string };
  /** Anchor and authority evidence paths (served next to the page). */
  evidence: { anchor?: string; authority?: string; files: { label: string; path: string }[] };
  cached: CachedSnapshot | null;
}

export async function loadDemoData(): Promise<DemoData> {
  const res = await fetch(`${import.meta.env.BASE_URL}demo-data.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`demo data not found (HTTP ${res.status})`);
  return (await res.json()) as DemoData;
}

export const short = (h: string, head = 6, tail = 4) =>
  h.length > head + tail + 2 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;

export const fmt = (n: number, digits = 1) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

/**
 * Figures behind the Buyer tab's "Verified value vs CBAM default" card. The first screen and the
 * summary under the Verify button use the same function, so their numbers always match the card.
 */
export function comparisonFigures(cmp: DemoData["comparison"]) {
  const q = Number(cmp.quantityTonnes);
  const dq = Number(cmp.defaultValue) * q;
  const vq = Number(cmp.verifiedValue) * q;
  const gap = dq - vq;
  return { q, dq, vq, gap, eur: gap * Number(cmp.priceEur) };
}

/**
 * The Buyer tab's "what if" control: figures for a hypothetical verified intensity, at the card's
 * certificate price and shipment quantity. Gross and illustrative, like the card.
 */
export function whatIfFigures(cmp: DemoData["comparison"], intensity: number) {
  const price = Number(cmp.priceEur);
  const gapPerT = Math.max(0, Number(cmp.defaultValue) - intensity);
  return {
    gapPerT,
    eurPerT: gapPerT * price,
    eurShipment: gapPerT * price * Number(cmp.quantityTonnes),
    eurPerTenth: 0.1 * price,
  };
}

export const EVIDENCE_WHY =
  "The vLEI credential chain is checked against evidence exported from a local KERI run. KERI agents need a server we do not host here; the local mode (README › Quick start) rebuilds the whole credential chain and its evidence on your machine.";
