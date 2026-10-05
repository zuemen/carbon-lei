// Shape of demo/public/demo-data.json, written by scripts/build-demo-data.ts from the
// recorded demo scenario (fixtures/sepolia-tx.json, fixtures/vlei.json, fixtures/evidence/).
// The hosted page reads only this file plus live calls to the contracts.
import type { Deployment } from "../../sdk/chain.ts";
import type { Hex } from "../../sdk/credential.ts";
import type { Presentation } from "../../sdk/disclosure.ts";

export type TxResult = "success" | "reverted";

export interface DemoTx {
  /** Stable step id, e.g. "addVerifier", "addAuditor", "registerReport1", "claim1", "revokeAuditor", "attack3". */
  step: string;
  label: string;
  hash: Hex;
  block: number;
  /** ISO 8601 UTC time of the block. */
  time: string;
  result: TxResult;
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
  /** Attack 2a/2b dry-run arguments (claimShipment) and attack 3 transaction. */
  attacks: {
    sameBatch: { args: [Hex, Hex, string, Hex]; caller: Hex };
    secondImporter: { args: [Hex, Hex, string, Hex]; caller: Hex; quantityTonnes: string };
    attack3: DemoTx | null;
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
