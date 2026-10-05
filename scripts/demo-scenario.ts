// Runs the demo scenario (spec §5.2) against a local anvil or Sepolia and records every transaction
// in fixtures/<network>-tx.json. Steps already recorded with their expected result are skipped.
//
// Usage: node scripts/demo-scenario.ts --network local|sepolia [--rpc <url>] [--steps a,b,…] [--kel-seq <n>]
//   steps: issue, fund, addVerifier, addAuditor, register1, claim1, revokeAuditor, attack3
//   default: addVerifier,addAuditor,register1,claim1
//
// local:   anvil development keys (0 owner, 1 watcher, 2 body, 3 supplier, 4 impostor); deploys the
//          contracts when they are missing and writes fixtures/local-deployment.json.
// sepolia: addresses from contracts/deployments/11155111.json; keys from DEPLOYER_PRIVATE_KEY (owner),
//          WATCHER_PRIVATE_KEY, VERIFIER_PRIVATE_KEY (body), SUPPLIER_PRIVATE_KEY; IMPOSTOR_ADDRESS;
//          RPC from SEPOLIA_RPC_URL (or --rpc). The script reads only the process environment.
import { pickReconciledClaims, reconcile, type ReportExtract } from "../sdk/consistency.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry, sepolia } from "viem/chains";
import type { DemoTx, TxResult } from "../demo/src/data.ts";
import { emissionsClaimRegistryAbi, verifierAllowlistAbi } from "../sdk/abi.ts";
import { ChainReader, decodeRevert, type Deployment } from "../sdk/chain.ts";
import { auditorAidHashOf, hashString, leiHashOf, reportKeyOf, supplierCommitOf } from "../sdk/commitment.ts";
import { METHODOLOGY_NOTE, isoToSeconds, tonnesToKg, type CredentialClaims, type Hex } from "../sdk/credential.ts";
import { signCredential } from "../sdk/eip712.ts";
import { newSalt } from "../sdk/encoding.ts";
import { claimArgsOf, issueCredential, reportInputOf, type SignedCredential } from "../sdk/issue.ts";

// ------------------------------------------------------------------ paths and files

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = resolve(ROOT, "fixtures");
export const EVIDENCE_DIR = resolve(FIXTURES, "evidence");
export const VLEI_FILE = resolve(FIXTURES, "vlei.json");

export type NetworkName = "local" | "sepolia";

export const txLogPath = (n: NetworkName) => resolve(FIXTURES, `${n}-tx.json`);
export const credentialPath = (n: NetworkName, index: 1 | 2 = 1) =>
  resolve(FIXTURES, index === 1 ? `${n}-credential.json` : `${n}-credential-2.json`);
export const deploymentPath = (n: NetworkName) =>
  n === "local" ? resolve(FIXTURES, "local-deployment.json") : resolve(ROOT, "contracts/deployments/11155111.json");

export const toJson = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
export const readJson = <T = unknown>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
export function writeJson(path: string, data: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, toJson(data));
}

export const DEFAULT_LOCAL_RPC = "http://127.0.0.1:8545";

// --------------------------------------------------------------------- demo data

export const demo = readJson<any>(resolve(FIXTURES, "demo.json"));
export const REPORT_1 = demo.reports[0];
export const REPORT_2 = demo.reports[1];
export const SHIPMENT_1 = demo.shipments[0];
export const SHIPMENT_2 = demo.shipments[1];
export const IMPORTER_1 = demo.entities.importers[0];
export const IMPORTER_2 = demo.entities.importers[1];
export const VERIFIER_LEI: string = demo.entities.verifier.lei;

/** Stable step ids written to the tx log (demo/src/data.ts DemoTx.step) and their labels. */
export const LABELS: Record<string, string> = {
  addVerifier: "Verification body added to the allowlist",
  addAuditor: "Auditor added",
  registerReport1: "Report registered",
  claim1: "Batch claimed (200 t)",
  revokeAuditor: "Auditor revocation synced",
  attack3: "Attack 3: new report after the revocation — reverted (status 0)",
  fundWatcher: "Test ETH sent to the watcher (0.03)",
  fundBody: "Test ETH sent to the verification body (0.05)",
  fundSupplier: "Test ETH sent to the supplier (0.05)",
};
/** Steps shown on the demo page, in scenario order. */
export const SCENARIO_STEPS = ["addVerifier", "addAuditor", "registerReport1", "claim1", "revokeAuditor", "attack3"];

/** CLI step name to recorded step id. */
const CLI_STEPS: Record<string, string | null> = {
  issue: null,
  fund: null,
  addVerifier: "addVerifier",
  addAuditor: "addAuditor",
  register1: "registerReport1",
  claim1: "claim1",
  revokeAuditor: "revokeAuditor",
  attack3: "attack3",
};
const DEFAULT_STEPS = ["addVerifier", "addAuditor", "register1", "claim1"];

/** Claims of the two demo credentials (fixtures/demo.json; hidden fields as in sdk/scripts/gen-vectors.ts). */
export function demoClaims(which: 1 | 2): CredentialClaims {
  const s = demo.entities.supplier;
  const r = which === 1 ? REPORT_1 : REPORT_2;
  const inst = s.installations.find((i: { id: string }) => i.id === r.installation);
  return {
    supplierLEI: s.lei,
    operatorId: s.operatorId,
    installationId: inst.id,
    installationName: inst.name,
    unLocode: s.unLocode,
    cnCode: demo.product.cnCode,
    cbamRoute: r.cbamRoute,
    productionRoute: "BF-BOF wire rod, cold heading (illustrative)",
    reportingPeriod: r.reportingPeriod,
    verifiedTonnes: r.verifiedTonnes,
    specificEmbeddedEmissions_tCO2e_per_t: r.specificEmbeddedEmissions_tCO2e_per_t,
    valueType: r.valueType,
    methodologyNote: METHODOLOGY_NOTE,
    verificationReportId: r.verificationReportId,
    verifierLEI: VERIFIER_LEI,
    accreditationNumber: demo.entities.verifier.accreditationNumber,
    nabName: demo.entities.nab.name,
    siteVisit: "physical",
    assuranceLevel: "reasonable",
    materialityThreshold: "5%",
    energyMix: "grid 70%, on-site solar 30% (illustrative)",
    supplierCost: "withheld (illustrative)",
    idSalt: newSalt(),
    batchSalt: newSalt(),
    issuedAt: r.issuedAt,
    validUntil: r.validUntil,
  };
}

// ------------------------------------------------------------------ vLEI values

export const PLACEHOLDER = {
  verifierLeSaid: "EDEV_PLACEHOLDER_VERIFIER_LE_CREDENTIAL_SAID",
  accreditationSaid: "EDEV_PLACEHOLDER_ACCREDITATION_CREDENTIAL_SAID",
  auditorAid: "EDEV_PLACEHOLDER_AUDITOR_AID",
  ecrSaid: "EDEV_PLACEHOLDER_AUDITOR_ECR_CREDENTIAL_SAID",
} as const;
export type VleiKey = keyof typeof PLACEHOLDER;

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Accepted locations for each value in fixtures/vlei.json (normalised key paths, then leaf names).
 * The first path of each entry is the layout written by the verifier's KERIA setup
 * (agents.<role>.aid, credentials.<name>.said); the rest are fallbacks.
 */
const VLEI_PATHS: Record<VleiKey, { paths: string[]; leaves: string[] }> = {
  verifierLeSaid: {
    paths: [
      "credentials.leverifier.said",
      "verifier.lesaid", "verifier.lecredentialsaid", "verifier.lecredsaid", "verifier.le.said",
      "body.lesaid", "body.lecredentialsaid", "body.le.said", "credentials.le.said", "credentials.verifierle.said",
      "saids.le", "saids.verifierle", "le.said",
    ],
    leaves: ["verifierlesaid", "verifierlecredentialsaid", "lesaid", "lecredentialsaid", "lecredsaid"],
  },
  accreditationSaid: {
    paths: [
      "verifier.accreditationsaid", "verifier.accreditation.said", "body.accreditationsaid",
      "credentials.accreditation.said", "saids.accreditation", "accreditation.said", "nab.accreditationsaid",
    ],
    leaves: ["accreditationsaid", "accreditationcredentialsaid", "verifieraccreditationsaid"],
  },
  auditorAid: {
    paths: ["agents.auditor.aid", "auditor.aid", "auditor.prefix", "auditor.pre", "aids.auditor"],
    leaves: ["auditoraid", "auditorprefix"],
  },
  ecrSaid: {
    paths: ["auditor.ecrsaid", "auditor.ecrcredentialsaid", "auditor.ecr.said", "credentials.ecr.said", "saids.ecr", "ecr.said"],
    leaves: ["ecrsaid", "ecrcredentialsaid", "auditorecrsaid"],
  },
};

function flatten(x: unknown, prefix = "", out = new Map<string, unknown>()) {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    for (const [k, v] of Object.entries(x)) flatten(v, prefix ? `${prefix}.${norm(k)}` : norm(k), out);
  } else if (prefix) {
    out.set(prefix, x);
  }
  return out;
}

export interface VleiValues {
  values: Record<VleiKey, string>;
  /** Keys that fell back to the placeholder. */
  placeholders: VleiKey[];
  raw: any | null;
}

/** Sepolia refuses placeholders unless `strict` is false (build-demo-data marks them in the trust chain instead). */
export function loadVlei(network: NetworkName, strict = network === "sepolia"): VleiValues {
  const raw = existsSync(VLEI_FILE) ? readJson<any>(VLEI_FILE) : null;
  const flat = raw ? flatten(raw) : new Map<string, unknown>();
  const values = {} as Record<VleiKey, string>;
  const placeholders: VleiKey[] = [];
  for (const key of Object.keys(PLACEHOLDER) as VleiKey[]) {
    const { paths, leaves } = VLEI_PATHS[key];
    let found: unknown;
    for (const p of [norm(key), ...paths]) if (typeof flat.get(p) === "string") { found = flat.get(p); break; }
    if (found === undefined) {
      for (const [p, v] of flat) {
        if (typeof v === "string" && v && leaves.includes(p.split(".").pop() as string)) { found = v; break; }
      }
    }
    if (typeof found === "string" && found) values[key] = found;
    else {
      values[key] = PLACEHOLDER[key];
      placeholders.push(key);
    }
  }
  if (placeholders.length && strict) {
    throw new Error(
      `fixtures/vlei.json ${raw ? "lacks" : "is missing; needed for"} ${placeholders.join(", ")} — Sepolia never uses placeholders`,
    );
  }
  if (placeholders.length) {
    console.warn(`! vLEI values not found (${placeholders.join(", ")}); using EDEV_PLACEHOLDER_* values`);
  }
  return { values, placeholders, raw };
}

// ------------------------------------------------------------- deployment

export interface DeploymentFile {
  chainId: number;
  network?: string;
  rpc?: string;
  deployedAt?: string;
  contracts: {
    VerifierAllowlist: { address: Hex; txHash: Hex; block: number; constructorArguments?: string[] };
    EmissionsClaimRegistry: { address: Hex; txHash: Hex; block: number; constructorArguments?: string[] };
  };
}

export function toDeployment(f: DeploymentFile): Deployment {
  return {
    chainId: f.chainId,
    contracts: {
      VerifierAllowlist: { address: f.contracts.VerifierAllowlist.address, block: f.contracts.VerifierAllowlist.block },
      EmissionsClaimRegistry: {
        address: f.contracts.EmissionsClaimRegistry.address,
        block: f.contracts.EmissionsClaimRegistry.block,
      },
    },
  };
}

function bytecode(name: string): Hex {
  const art = readJson<any>(resolve(ROOT, `contracts/out/${name}.sol/${name}.json`));
  return art.bytecode.object as Hex;
}

// ------------------------------------------------------------------ tx log

export interface TxLog {
  network: NetworkName;
  chainId: number;
  addresses: Partial<Record<"owner" | "watcher" | "body" | "supplier" | "impostor", Hex>>;
  txs: DemoTx[];
}

export function loadTxLog(network: NetworkName, chainId: number): TxLog {
  const path = txLogPath(network);
  if (!existsSync(path)) return { network, chainId, addresses: {}, txs: [] };
  return readJson<TxLog>(path);
}

// --------------------------------------------------------------- credentials

export interface CredentialFile {
  network: NetworkName;
  chainId: number;
  registry: Hex;
  credSAID: string;
  reportKey: Hex;
  auditorAID: string;
  /** True when the auditor AID was a local placeholder at issuance. */
  placeholderAuditor: boolean;
  coreJson: string;
  signature: Hex;
  claims: CredentialClaims;
  disclosures: Record<string, string>;
  /** Importer salts for the demo shipments (credential 1 only). */
  importerSalt?: Hex;
  importer2Salt?: Hex;
  issuedWith: string;
  /** Verification report extract reconciled at issuance (check 8). */
  reportExtractFile?: string;
}

export function toSigned(f: CredentialFile): SignedCredential {
  return { core: JSON.parse(f.coreJson), coreJson: f.coreJson, disclosures: f.disclosures, claims: f.claims, signature: f.signature };
}

export function loadCredential(network: NetworkName, index: 1 | 2 = 1): CredentialFile | null {
  const path = credentialPath(network, index);
  return existsSync(path) ? readJson<CredentialFile>(path) : null;
}

// ------------------------------------------------------------------ helpers

export const isoOf = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");

export async function rpcReachable(rpc: string): Promise<number | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const j = (await res.json()) as { result?: string };
    return j.result ? Number(BigInt(j.result)) : null;
  } catch {
    return null;
  }
}

/** anvil's default development keys (public, test-only). */
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

type Role = "owner" | "watcher" | "body" | "supplier";
const ENV_KEYS: Record<Role, string> = {
  owner: "DEPLOYER_PRIVATE_KEY",
  watcher: "WATCHER_PRIVATE_KEY",
  body: "VERIFIER_PRIVATE_KEY",
  supplier: "SUPPLIER_PRIVATE_KEY",
};

interface Ctx {
  network: NetworkName;
  chain: Chain;
  rpc: string;
  pub: PublicClient;
  deployment: DeploymentFile;
  account: (role: Role) => PrivateKeyAccount;
  impostor: () => Hex;
  log: TxLog;
  vlei: VleiValues;
  kelSeqArg?: string;
}

function accountsFor(network: NetworkName): { account: (r: Role) => PrivateKeyAccount; impostor: () => Hex } {
  if (network === "local") {
    const [owner, watcher, body, supplier, impostor] = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
    const byRole: Record<Role, PrivateKeyAccount> = { owner, watcher, body, supplier };
    return { account: (r) => byRole[r], impostor: () => impostor.address };
  }
  const cache = new Map<Role, PrivateKeyAccount>();
  return {
    account: (r) => {
      if (!cache.has(r)) {
        const k = process.env[ENV_KEYS[r]];
        if (!k) throw new Error(`${ENV_KEYS[r]} is not set (needed for the ${r} on Sepolia)`);
        cache.set(r, privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex));
      }
      return cache.get(r)!;
    },
    impostor: () => {
      const a = process.env.IMPOSTOR_ADDRESS;
      if (!a) throw new Error("IMPOSTOR_ADDRESS is not set");
      return getAddress(a);
    },
  };
}

function saveLog(ctx: Ctx) {
  writeJson(txLogPath(ctx.network), ctx.log);
}

function noteAddress(ctx: Ctx, role: keyof TxLog["addresses"], addr: Hex) {
  ctx.log.addresses[role] = addr;
}

function recorded(ctx: Ctx, step: string, expected: TxResult): DemoTx | undefined {
  return ctx.log.txs.find((t) => t.step === step && t.result === expected);
}

async function record(ctx: Ctx, step: string, receipt: TransactionReceipt, label = LABELS[step]): Promise<DemoTx> {
  const block = await ctx.pub.getBlock({ blockNumber: receipt.blockNumber });
  const tx: DemoTx = {
    step,
    label,
    hash: receipt.transactionHash,
    block: Number(receipt.blockNumber),
    time: isoOf(block.timestamp),
    result: receipt.status === "success" ? "success" : "reverted",
  };
  ctx.log.txs.push(tx);
  saveLog(ctx);
  console.log(`  ${step}: ${tx.result} · block ${tx.block} · ${tx.time} · ${tx.hash}`);
  return tx;
}

const wait = (ctx: Ctx, hash: Hex) =>
  ctx.pub.waitForTransactionReceipt({ hash, timeout: ctx.network === "sepolia" ? 300_000 : 60_000 });

function wallet(ctx: Ctx, from: PrivateKeyAccount) {
  return createWalletClient({ account: from, chain: ctx.chain, transport: http(ctx.rpc) });
}

function target(ctx: Ctx, which: "allowlist" | "registry") {
  return which === "allowlist"
    ? { address: ctx.deployment.contracts.VerifierAllowlist.address, abi: verifierAllowlistAbi }
    : { address: ctx.deployment.contracts.EmissionsClaimRegistry.address, abi: emissionsClaimRegistryAbi };
}

/** Simulates, sends and records one contract write that is expected to succeed. */
async function sendStep(
  ctx: Ctx,
  step: string,
  from: PrivateKeyAccount,
  which: "allowlist" | "registry",
  functionName: string,
  args: readonly unknown[],
) {
  const { address, abi } = target(ctx, which);
  let request: unknown;
  try {
    ({ request } = await ctx.pub.simulateContract({ address, abi, functionName, args, account: from } as never));
  } catch (err) {
    const { errorName, args: errArgs } = decodeRevert(err);
    throw new Error(`${step}: dry run reverted with ${errorName}(${errArgs.map(String).join(", ")}); nothing sent`);
  }
  const hash = await wallet(ctx, from).writeContract(request as never);
  const receipt = await wait(ctx, hash);
  if (receipt.status !== "success") {
    await record(ctx, `${step}:failed`, receipt, `${LABELS[step]} — unexpected revert`);
    throw new Error(`${step}: transaction ${hash} reverted`);
  }
  return record(ctx, step, receipt);
}

// ------------------------------------------------------------------ setup

async function ensureLocalDeployment(ctx: Omit<Ctx, "deployment" | "log">): Promise<{ file: DeploymentFile; fresh: boolean }> {
  const path = deploymentPath("local");
  if (existsSync(path)) {
    const file = readJson<DeploymentFile>(path);
    try {
      const ok = await Promise.all(
        (["VerifierAllowlist", "EmissionsClaimRegistry"] as const).map(async (name) => {
          const c = file.contracts[name];
          const r = await ctx.pub.getTransactionReceipt({ hash: c.txHash });
          const code = await ctx.pub.getCode({ address: c.address });
          return r.contractAddress?.toLowerCase() === c.address.toLowerCase() && !!code && code !== "0x";
        }),
      );
      if (ok.every(Boolean)) return { file, fresh: false };
    } catch {
      // receipt not found: a new anvil instance
    }
    console.log("  local deployment file is stale (new anvil instance); deploying again");
  }
  const owner = ctx.account("owner");
  const watcher = ctx.account("watcher");
  const w = wallet(ctx as Ctx, owner);
  const h1 = await w.deployContract({
    abi: verifierAllowlistAbi,
    bytecode: bytecode("VerifierAllowlist"),
    args: [owner.address, watcher.address],
  } as never);
  const r1 = await ctx.pub.waitForTransactionReceipt({ hash: h1 });
  const allowlist = getAddress(r1.contractAddress as Hex);
  const h2 = await w.deployContract({
    abi: emissionsClaimRegistryAbi,
    bytecode: bytecode("EmissionsClaimRegistry"),
    args: [allowlist],
  } as never);
  const r2 = await ctx.pub.waitForTransactionReceipt({ hash: h2 });
  const file: DeploymentFile = {
    chainId: await ctx.pub.getChainId(),
    network: "local",
    rpc: ctx.rpc,
    deployedAt: isoOf((await ctx.pub.getBlock({ blockNumber: r2.blockNumber })).timestamp),
    contracts: {
      VerifierAllowlist: {
        address: allowlist,
        txHash: h1,
        block: Number(r1.blockNumber),
        constructorArguments: [owner.address, watcher.address],
      },
      EmissionsClaimRegistry: {
        address: getAddress(r2.contractAddress as Hex),
        txHash: h2,
        block: Number(r2.blockNumber),
        constructorArguments: [allowlist],
      },
    },
  };
  writeJson(path, file);
  console.log(`  deployed VerifierAllowlist ${allowlist} and EmissionsClaimRegistry ${file.contracts.EmissionsClaimRegistry.address}`);
  return { file, fresh: true };
}

/** Loads credential 1 or 2, or issues it once with the body's key. Never re-issues an existing one. */
async function ensureCredential(ctx: Ctx, index: 1 | 2): Promise<CredentialFile> {
  const registry = ctx.deployment.contracts.EmissionsClaimRegistry.address;
  const chainId = ctx.deployment.chainId;
  const auditorAID = ctx.vlei.values.auditorAid;
  const existing = loadCredential(ctx.network, index);
  if (!existing) return issueAndSave(ctx, index);

  if (existing.auditorAID !== auditorAID) {
    // Local only: a credential issued before the vLEI export (placeholder auditor) is replaced
    // while this chain has not registered it; once registered it stays.
    if (ctx.network === "local") {
      const reader = new ChainReader(ctx.pub, toDeployment(ctx.deployment));
      if ((await reader.report(existing.reportKey)).registeredAt === 0n) {
        console.log(`  credential ${index}: auditor changed (${existing.auditorAID} -> ${auditorAID}), not registered here; issuing again`);
        return issueAndSave(ctx, index);
      }
    }
    throw new Error(
      `${credentialPath(ctx.network, index)} names auditor ${existing.auditorAID} but the current vLEI auditor is ${auditorAID}. ` +
        (ctx.network === "local"
          ? "It is already registered on this chain: stop anvil and delete fixtures/local-*.json to start over."
          : "Not re-issuing: the anchored credSAID must stay the same."),
    );
  }
  if (existing.registry.toLowerCase() !== registry.toLowerCase() || existing.chainId !== chainId) {
    if (ctx.network !== "local") throw new Error(`${credentialPath(ctx.network, index)} was signed for another registry`);
    // Same core and credSAID; only the EIP-712 domain changed (new local deployment).
    const signed = toSigned(existing);
    existing.signature = await signCredential(
      ctx.account("body"),
      registry,
      {
        credSAID: signed.core.d,
        supplierCommit: supplierCommitOf(signed.claims.supplierLEI, signed.claims.idSalt),
        verifiedKg: tonnesToKg(signed.claims.verifiedTonnes),
        validUntil: isoToSeconds(signed.claims.validUntil),
      },
      chainId,
    );
    existing.registry = registry;
    existing.chainId = chainId;
    writeJson(credentialPath(ctx.network, index), existing);
    console.log(`  credential ${index}: re-signed for the new local registry (credSAID unchanged)`);
  }
  return existing;
}

/** Structured fields of the demo verification report, if the fixture exists (fixtures/report-<id>.json). */
export function loadReportExtract(reportId: string): ReportExtract | null {
  const path = fileURLToPath(new URL(`../fixtures/report-${reportId}.json`, import.meta.url));
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).extract as ReportExtract) : null;
}

async function issueAndSave(ctx: Ctx, index: 1 | 2): Promise<CredentialFile> {
  const registry = ctx.deployment.contracts.EmissionsClaimRegistry.address;
  const chainId = ctx.deployment.chainId;
  const auditorAID = ctx.vlei.values.auditorAid;
  const claims = demoClaims(index);
  // Check 8: the body reconciles the verification report's structured fields with the credential
  // and signs the three reconciliation hashes as part of the credential core.
  const extract = loadReportExtract(claims.verificationReportId);
  const picked = extract ? pickReconciledClaims(claims as unknown as Record<string, string>) : null;
  const reconciliation = extract && picked ? reconcile(extract, picked).reconciliation : undefined;
  const cred = await issueCredential({
    claims,
    auditorAID,
    signer: ctx.account("body"),
    registry,
    chainId,
    ...(reconciliation ? { reconciliation } : {}),
  });
  const file: CredentialFile = {
    network: ctx.network,
    chainId,
    registry,
    credSAID: cred.core.d,
    reportKey: reportKeyOf(cred.core.d),
    auditorAID,
    placeholderAuditor: ctx.vlei.placeholders.includes("auditorAid"),
    coreJson: cred.coreJson,
    signature: cred.signature,
    claims: cred.claims,
    disclosures: cred.disclosures,
    ...(index === 1 ? { importerSalt: newSalt(), importer2Salt: newSalt() } : {}),
    issuedWith: "scripts/demo-scenario.ts (sdk issueCredential, EIP-712 by the verification body)",
    ...(extract ? { reportExtractFile: `fixtures/report-${claims.verificationReportId}.json` } : {}),
  };
  writeJson(credentialPath(ctx.network, index), file);
  console.log(`  credential ${index} issued: credSAID ${file.credSAID}`);
  return file;
}

/** kelSeq: --kel-seq, else fixtures/evidence/anchor-<credSAID>.json, else 1 on a local chain. */
export function kelSeqFor(network: NetworkName, credSAID: string, arg?: string): bigint {
  if (arg !== undefined) return BigInt(arg);
  const path = resolve(EVIDENCE_DIR, `anchor-${credSAID}.json`);
  if (existsSync(path)) {
    const flat = flatten(readJson(path));
    for (const [p, v] of flat) {
      const leaf = p.split(".").pop();
      if (leaf === "kelseq" && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) return BigInt(v);
    }
    for (const [p, v] of flat) {
      const leaf = p.split(".").pop();
      if (leaf === "sn" && typeof v === "string" && /^[0-9a-f]+$/.test(v)) return BigInt(`0x${v}`);
    }
    for (const [p, v] of flat) {
      // KERI "s" / "sn": sequence number as lower-case hex
      if (p.split(".").pop() === "s" && typeof v === "string" && /^[0-9a-f]+$/.test(v)) return BigInt(`0x${v}`);
    }
    throw new Error(`${path} has no kelSeq, sn or s field`);
  }
  if (network === "local") return 1n;
  throw new Error(`no kelSeq: pass --kel-seq or add fixtures/evidence/anchor-${credSAID}.json`);
}

// ------------------------------------------------------------------ steps

async function stepFund(ctx: Ctx) {
  if (ctx.network === "local") {
    console.log("- fund: skipped (anvil accounts are pre-funded)");
    return;
  }
  const owner = ctx.account("owner");
  const plan: [string, Role, string][] = [
    ["fundWatcher", "watcher", "0.03"],
    ["fundBody", "body", "0.05"],
    ["fundSupplier", "supplier", "0.05"],
  ];
  for (const [step, role, eth] of plan) {
    if (recorded(ctx, step, "success")) {
      console.log(`- ${step}: already recorded, skipped`);
      continue;
    }
    console.log(`- ${step}`);
    const hash = await wallet(ctx, owner).sendTransaction({
      to: ctx.account(role).address,
      value: parseEther(eth),
    } as never);
    await record(ctx, step, await wait(ctx, hash));
  }
}

async function runStep(ctx: Ctx, name: string) {
  if (!(name in CLI_STEPS)) throw new Error(`unknown step ${name}; use ${Object.keys(CLI_STEPS).join(", ")}`);
  if (name === "fund") return stepFund(ctx);
  if (name === "issue") {
    const c = await ensureCredential(ctx, 1);
    console.log(`- issue: credSAID ${c.credSAID} · reportKey ${c.reportKey}`);
    return;
  }
  const step = CLI_STEPS[name] as string;
  const expected: TxResult = step === "attack3" ? "reverted" : "success";
  const prev = recorded(ctx, step, expected);
  if (prev) {
    console.log(`- ${step}: already recorded (${prev.hash}), skipped`);
    return;
  }
  console.log(`- ${step}`);
  const v = ctx.vlei.values;
  const leiHash = leiHashOf(VERIFIER_LEI);
  switch (step) {
    case "addVerifier": {
      const body = ctx.account("body");
      noteAddress(ctx, "body", body.address);
      await sendStep(ctx, step, ctx.account("owner"), "allowlist", "addVerifier", [
        {
          leiHash,
          verifier: body.address,
          leCredSaidHash: hashString(v.verifierLeSaid),
          accreditationSaidHash: hashString(v.accreditationSaid),
          accreditedUntil: isoToSeconds(demo.entities.verifier.accreditedUntil),
        },
      ]);
      return;
    }
    case "addAuditor":
      await sendStep(ctx, step, ctx.account("owner"), "allowlist", "addAuditor", [
        { auditorAidHash: auditorAidHashOf(v.auditorAid), leiHash, ecrSaidHash: hashString(v.ecrSaid) },
      ]);
      return;
    case "registerReport1": {
      const c = await ensureCredential(ctx, 1);
      const supplier = ctx.account("supplier").address;
      noteAddress(ctx, "supplier", supplier);
      const kelSeq = kelSeqFor(ctx.network, c.credSAID, ctx.kelSeqArg);
      console.log(`  credSAID ${c.credSAID} · kelSeq ${kelSeq}`);
      await sendStep(ctx, step, ctx.account("body"), "registry", "registerReport", [
        reportInputOf(toSigned(c), { supplier, kelSeq }),
      ]);
      return;
    }
    case "claim1": {
      const c = await ensureCredential(ctx, 1);
      const args = claimArgsOf(toSigned(c), {
        batchId: SHIPMENT_1.batchId,
        quantityTonnes: SHIPMENT_1.quantityTonnes,
        importerEORI: IMPORTER_1.eori,
        importerSalt: c.importerSalt as Hex,
      });
      await sendStep(ctx, step, ctx.account("supplier"), "registry", "claimShipment", args);
      return;
    }
    case "revokeAuditor": {
      const c = await ensureCredential(ctx, 1);
      await sendStep(ctx, step, ctx.account("watcher"), "allowlist", "revokeAuditor", [
        auditorAidHashOf(c.auditorAID),
        leiHash,
      ]);
      return;
    }
    case "attack3":
      await stepAttack3(ctx);
      return;
  }
}

/** Attack 3: the body registers report 2 with the revoked auditor. Sent with a fixed gas limit so it is mined and reverts. */
async function stepAttack3(ctx: Ctx) {
  const c1 = await ensureCredential(ctx, 1);
  const c2 = await ensureCredential(ctx, 2);
  const body = ctx.account("body");
  const supplier = ctx.account("supplier").address;
  let kelSeq: bigint;
  try {
    kelSeq = kelSeqFor(ctx.network, c2.credSAID, ctx.kelSeqArg);
  } catch {
    kelSeq = kelSeqFor(ctx.network, c1.credSAID, ctx.kelSeqArg);
  }
  const input = reportInputOf(toSigned(c2), { supplier, kelSeq });
  const { address, abi } = target(ctx, "registry");
  // Guard: send only if the contract would reject it for the revoked auditor.
  try {
    await ctx.pub.simulateContract({ address, abi, functionName: "registerReport", args: [input], account: body } as never);
    throw new Error("attack3: registerReport would succeed (auditor not revoked?); refusing to send");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("attack3:")) throw err;
    const { errorName } = decodeRevert(err);
    if (errorName !== "AuditorNotAuthorized") {
      throw new Error(`attack3: dry run reverted with ${errorName}, expected AuditorNotAuthorized; nothing sent`);
    }
    console.log("  dry run: AuditorNotAuthorized (expected); sending with a fixed gas limit");
  }
  const hash = await wallet(ctx, body).writeContract({
    address,
    abi,
    functionName: "registerReport",
    args: [input],
    gas: 400_000n,
  } as never);
  const receipt = await wait(ctx, hash);
  if (receipt.status === "success") {
    await record(ctx, "attack3:unexpected-success", receipt, "Attack 3 — unexpectedly succeeded");
    throw new Error(`attack3: transaction ${hash} succeeded; expected a revert`);
  }
  await record(ctx, "attack3", receipt);
}

// ------------------------------------------------------------------ main

export function isMain(metaUrl: string) {
  return !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(metaUrl).toLowerCase();
}

async function main() {
  const { values } = parseArgs({
    options: {
      network: { type: "string" },
      rpc: { type: "string" },
      steps: { type: "string" },
      "kel-seq": { type: "string" },
    },
  });
  const network = values.network as NetworkName;
  if (network !== "local" && network !== "sepolia") throw new Error("--network local|sepolia is required");
  const steps = values.steps ? values.steps.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_STEPS;
  for (const s of steps) if (!(s in CLI_STEPS)) throw new Error(`unknown step ${s}`);

  const chain = network === "local" ? foundry : sepolia;
  const rpc = values.rpc ?? (network === "local" ? DEFAULT_LOCAL_RPC : process.env.SEPOLIA_RPC_URL);
  if (!rpc) throw new Error("SEPOLIA_RPC_URL is not set (or pass --rpc)");
  const pub = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const chainId = await pub.getChainId();
  if (chainId !== chain.id) throw new Error(`RPC is on chain ${chainId}, expected ${chain.id}`);

  const accounts = accountsFor(network);
  const vlei = loadVlei(network);
  const base = { network, chain, rpc, pub, account: accounts.account, impostor: accounts.impostor, vlei, kelSeqArg: values["kel-seq"] };

  let deployment: DeploymentFile;
  let fresh = false;
  if (network === "local") ({ file: deployment, fresh } = await ensureLocalDeployment(base));
  else deployment = readJson<DeploymentFile>(deploymentPath("sepolia"));

  let log = loadTxLog(network, chainId);
  if (network === "local" && log.txs.length) {
    // A recorded hash that this chain does not know means the log belongs to an earlier anvil.
    const known = await pub.getTransactionReceipt({ hash: log.txs[0].hash }).then(
      () => true,
      () => false,
    );
    if (fresh || !known) {
      console.log("  local tx log belongs to an earlier anvil instance; starting a new log");
      log = { network, chainId, addresses: {}, txs: [] };
    }
  }
  const ctx: Ctx = { ...base, deployment, log };

  if (network === "local") {
    for (const r of ["owner", "watcher", "body", "supplier"] as Role[]) noteAddress(ctx, r, ctx.account(r).address);
    noteAddress(ctx, "impostor", ctx.impostor());
  } else {
    noteAddress(ctx, "owner", getAddress(deployment.contracts.VerifierAllowlist.constructorArguments?.[0] as string));
    noteAddress(ctx, "watcher", getAddress(deployment.contracts.VerifierAllowlist.constructorArguments?.[1] as string));
    if (process.env.IMPOSTOR_ADDRESS) noteAddress(ctx, "impostor", getAddress(process.env.IMPOSTOR_ADDRESS));
  }
  saveLog(ctx);

  console.log(`demo scenario on ${network} (chain ${chainId}) · registry ${deployment.contracts.EmissionsClaimRegistry.address}`);
  for (const s of steps) await runStep(ctx, s);
  saveLog(ctx);
  console.log(`tx log: ${txLogPath(network)}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`demo-scenario failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
