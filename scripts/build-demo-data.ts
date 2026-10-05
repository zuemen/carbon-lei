// Builds demo/public/demo-data.json (type DemoData in demo/src/data.ts) from the recorded scenario:
// fixtures/<network>-tx.json, fixtures/<network>-credential.json, the deployment file,
// fixtures/vlei.json and fixtures/evidence/*, plus a snapshot of on-chain reads taken now.
//
// Usage: node scripts/build-demo-data.ts --network local|sepolia [--rpc <url>] [--out demo/public/demo-data.json]
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, sepolia } from "viem/chains";
import type { CachedSnapshot, DemoData, DemoTx, TrustNode } from "../demo/src/data.ts";
import { ChainReader, SEPOLIA_RPCS } from "../sdk/chain.ts";
import { auditorAidHashOf, hashString, leiHashOf } from "../sdk/commitment.ts";
import type { Hex } from "../sdk/credential.ts";
import type { Presentation } from "../sdk/disclosure.ts";
import { claimArgsOf, DEMO_DISCLOSURE, present } from "../sdk/issue.ts";
import { verifyPresentation } from "../sdk/verify.ts";
import {
  ANVIL_KEYS,
  DEFAULT_LOCAL_RPC,
  EVIDENCE_DIR,
  IMPORTER_1,
  IMPORTER_2,
  ROOT,
  SCENARIO_STEPS,
  SHIPMENT_1,
  SHIPMENT_2,
  VERIFIER_LEI,
  demo,
  deploymentPath,
  isMain,
  isoOf,
  loadCredential,
  loadTxLog,
  loadVlei,
  readJson,
  toDeployment,
  toJson,
  toSigned,
  writeJson,
  type DeploymentFile,
  type NetworkName,
  type TxLog,
  type VleiValues,
} from "./demo-scenario.ts";

/** Carbon price used for the comparison until the quarterly update. */
const PRICE = { priceEur: "75.28", quarter: "Q2 2026" };

const str = (v: unknown): string => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v));
const argsOut = (a: readonly [Hex, Hex, bigint, Hex]): [Hex, Hex, string, Hex] => [a[0], a[1], a[2].toString(), a[3]];

// ------------------------------------------------------------------ trust chain

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
function pick(raw: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    let cur: unknown = raw;
    for (const seg of p.split(".")) {
      if (!cur || typeof cur !== "object") { cur = undefined; break; }
      const hit = Object.entries(cur as Record<string, unknown>).find(([k]) => norm(k) === seg);
      cur = hit?.[1];
    }
    if (typeof cur === "string" && cur) return cur;
  }
  return undefined;
}

const STATUSES = new Set(["valid", "revoked", "suspended", "expired"]);
const NODE_IDS = new Set(["root", "qvi", "nab", "body", "auditor"]);

function buildTrustChain(
  vlei: VleiValues,
  log: TxLog,
  evidenceFiles: string[],
  credByFile: Map<string, { said?: string }>,
): { nodes: TrustNode[]; exportDate: string } {
  const raw = vlei.raw;
  const exportDate = (pick(raw, ["updatedat", "exportdate", "exportedat", "createdat"]) ?? "").slice(0, 10);
  if (raw && Array.isArray(raw.trustChain)) {
    const nodes = raw.trustChain as TrustNode[];
    for (const n of nodes) {
      if (!NODE_IDS.has(n.id) || typeof n.name !== "string" || typeof n.role !== "string" || !STATUSES.has(n.status)) {
        throw new Error(`fixtures/vlei.json trustChain node ${JSON.stringify(n.id)} does not match TrustNode`);
      }
    }
    return { nodes, exportDate };
  }
  const e = demo.entities;
  const ph = vlei.placeholders;
  const mark = (keys: string[]) =>
    keys.some((k) => ph.includes(k as never)) ? " — placeholder: not in fixtures/vlei.json" : "";
  // Status of a credential in the export: credentials.<key>.status, .revoked or .revokedAt.
  const credStatus = (key: string): TrustNode["status"] | undefined => {
    const s = pick(raw, [`credentials.${key}.status`])?.toLowerCase();
    if (s && STATUSES.has(s)) return s as TrustNode["status"];
    const c = (raw?.credentials ?? {})[Object.keys(raw?.credentials ?? {}).find((k) => norm(k) === key) ?? ""];
    if (c && (c.revoked === true || typeof c.revokedAt === "string")) return "revoked";
    return raw && c ? "valid" : undefined;
  };
  const revokedOnChain = log.txs.some((t) => t.step === "revokeAuditor" && t.result === "success");
  const evidenceFor = (said?: string) => {
    if (!said) return undefined;
    const f = [...credByFile].find(([, c]) => c.said === said)?.[0] ?? evidenceFiles.find((x) => x.includes(said));
    return f && evidenceFiles.includes(f) ? `evidence/${f}` : undefined;
  };
  const node = (n: TrustNode): TrustNode => {
    const withFile = { ...n, evidenceFile: n.evidenceFile ?? evidenceFor(n.credentialSaid) };
    return Object.fromEntries(Object.entries(withFile).filter(([, v]) => v !== undefined)) as unknown as TrustNode;
  };
  const qviSaid = pick(raw, ["credentials.qvi.said"]);
  const nabSaid = pick(raw, ["credentials.lenab.said"]);
  return {
    exportDate,
    nodes: [
      node({
        id: "root",
        name: e.root.name,
        role: raw ? e.root.role : `${e.root.role} — placeholder: no vLEI export yet`,
        aid: pick(raw, ["agents.geda.aid", "trustanchor", "root.aid", "geda.aid"]),
        status: "valid",
      }),
      node({
        id: "qvi",
        name: e.qvi.name,
        role: `Qualified vLEI Issuer${raw ? "" : " — placeholder: no vLEI export yet"}`,
        lei: e.qvi.lei,
        aid: pick(raw, ["agents.qvi.aid", "qvi.aid"]),
        credentialSaid: qviSaid,
        status: credStatus("qvi") ?? "valid",
      }),
      node({
        id: "nab",
        name: e.nab.name,
        role: `National accreditation body (${e.nab.country})${raw ? "" : " — placeholder: no vLEI export yet"}`,
        lei: e.nab.lei,
        aid: pick(raw, ["agents.nab.aid", "nab.aid"]),
        credentialSaid: nabSaid,
        status: credStatus("lenab") ?? "valid",
      }),
      node({
        id: "body",
        name: e.verifier.name,
        role: `Accredited CBAM verification body (${e.verifier.accreditationNumber})${mark(["verifierLeSaid", "accreditationSaid"])}`,
        lei: e.verifier.lei,
        aid: pick(raw, ["agents.verifier.aid", "verifier.aid", "body.aid"]),
        credentialSaid: vlei.values.accreditationSaid,
        status: credStatus("accreditation") ?? "valid",
      }),
      node({
        id: "auditor",
        name: e.auditor.name,
        role: `${e.auditor.role} (ECR)${mark(["auditorAid", "ecrSaid"])}`,
        aid: vlei.values.auditorAid,
        credentialSaid: vlei.values.ecrSaid,
        // The export may predate the revocation; fall back to the on-chain sync.
        status: credStatus("ecr") === "revoked" || revokedOnChain ? "revoked" : (credStatus("ecr") ?? "valid"),
      }),
    ],
  };
}

// ---------------------------------------------------------------- validation

/** Runtime check of the fields the demo page reads; returns the problems found. */
export function checkDemoData(d: DemoData): string[] {
  const bad: string[] = [];
  const hex = (v: unknown, path: string, len?: number) => {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v) || (len !== undefined && v.length !== 2 + len * 2)) bad.push(path);
  };
  const s = (v: unknown, path: string) => typeof v === "string" || bad.push(path);
  const n = (v: unknown, path: string) => (typeof v === "number" && Number.isFinite(v)) || bad.push(path);
  const tx = (t: DemoTx, path: string) => {
    s(t?.step, `${path}.step`); s(t?.label, `${path}.label`); hex(t?.hash, `${path}.hash`, 32);
    n(t?.block, `${path}.block`); s(t?.time, `${path}.time`);
    if (t?.result !== "success" && t?.result !== "reverted") bad.push(`${path}.result`);
  };
  if (d.version !== 1) bad.push("version");
  if (d.mode !== "hosted" && d.mode !== "local") bad.push("mode");
  n(d.network?.chainId, "network.chainId"); s(d.network?.name, "network.name"); s(d.network?.explorer, "network.explorer");
  if (!Array.isArray(d.network?.rpcs) || !d.network.rpcs.length) bad.push("network.rpcs");
  n(d.deployment?.chainId, "deployment.chainId");
  for (const c of ["VerifierAllowlist", "EmissionsClaimRegistry"] as const) {
    hex(d.deployment?.contracts?.[c]?.address, `deployment.contracts.${c}.address`, 20);
    n(d.deployment?.contracts?.[c]?.block, `deployment.contracts.${c}.block`);
    hex(d.deployment?.deployTxs?.[c], `deployment.deployTxs.${c}`, 32);
  }
  if (typeof d.deployment?.sourceVerified !== "boolean") bad.push("deployment.sourceVerified");
  s(d.exportDate, "exportDate");
  for (const k of ["owner", "watcher", "body", "supplier", "impostor"] as const) hex(d.addresses?.[k], `addresses.${k}`, 20);
  for (const k of ["importer", "secondImporter", "impostor"] as const) {
    const o = d[k] as Record<string, unknown>;
    for (const f of Object.keys(o ?? {})) s(o[f], `${k}.${f}`);
    if (!o || Object.keys(o).length !== 2) bad.push(k);
  }
  s(d.proof?.core, "proof.core"); hex(d.proof?.signature, "proof.signature", 65);
  if (!Array.isArray(d.proof?.disclosures)) bad.push("proof.disclosures");
  s(d.credential?.coreJson, "credential.coreJson"); hex(d.credential?.signature, "credential.signature", 65);
  hex(d.credential?.reportKey, "credential.reportKey", 32); s(d.credential?.kelSeq, "credential.kelSeq");
  if (!d.credential?.disclosures || typeof d.credential.disclosures !== "object") bad.push("credential.disclosures");
  for (const f of ["installationName", "installationId", "cnCode", "reportingPeriod", "verifiedTonnes", "intensity", "reportId", "accreditationNumber", "issuedAt"] as const) {
    s(d.report?.[f], `report.${f}`);
  }
  s(d.shipment?.batchId, "shipment.batchId"); s(d.shipment?.quantityTonnes, "shipment.quantityTonnes");
  s(d.shipment?.shipmentDate, "shipment.shipmentDate"); hex(d.shipment?.importerSalt, "shipment.importerSalt", 32);
  for (const k of ["sameBatch", "secondImporter"] as const) {
    const a = d.attacks?.[k];
    if (!Array.isArray(a?.args) || a.args.length !== 4) bad.push(`attacks.${k}.args`);
    else { hex(a.args[0], `attacks.${k}.args[0]`, 32); hex(a.args[1], `attacks.${k}.args[1]`, 32); s(a.args[2], `attacks.${k}.args[2]`); hex(a.args[3], `attacks.${k}.args[3]`, 32); }
    hex(a?.caller, `attacks.${k}.caller`, 20);
  }
  s(d.attacks?.secondImporter?.quantityTonnes, "attacks.secondImporter.quantityTonnes");
  if (d.attacks?.attack3 !== null) tx(d.attacks?.attack3 as DemoTx, "attacks.attack3");
  if (!Array.isArray(d.txs)) bad.push("txs");
  else d.txs.forEach((t, i) => tx(t, `txs[${i}]`));
  if (!Array.isArray(d.trustChain)) bad.push("trustChain");
  else d.trustChain.forEach((t, i) => {
    if (!NODE_IDS.has(t.id)) bad.push(`trustChain[${i}].id`);
    s(t.name, `trustChain[${i}].name`); s(t.role, `trustChain[${i}].role`);
    if (!STATUSES.has(t.status)) bad.push(`trustChain[${i}].status`);
  });
  for (const f of ["defaultValue", "verifiedValue", "quantityTonnes", "priceEur", "quarter"] as const) s(d.comparison?.[f], `comparison.${f}`);
  if (!Array.isArray(d.evidence?.files)) bad.push("evidence.files");
  if (d.cached !== null) {
    const c = d.cached;
    n(c?.block, "cached.block"); s(c?.time, "cached.time"); s(c?.remainingKg, "cached.remainingKg");
    if (typeof c?.reportValid !== "boolean") bad.push("cached.reportValid");
    s(c?.shipment?.claimedAt, "cached.shipment.claimedAt"); s(c?.shipment?.quantityKg, "cached.shipment.quantityKg");
    if (typeof c?.shipment?.reportValid !== "boolean") bad.push("cached.shipment.reportValid");
    for (const [k, v] of Object.entries(c?.dryRuns ?? {})) {
      s(v.errorName, `cached.dryRuns.${k}.errorName`);
      if (!Array.isArray(v.args) || v.args.some((a) => typeof a !== "string")) bad.push(`cached.dryRuns.${k}.args`);
    }
  }
  return bad;
}

// ------------------------------------------------------------------ build

export async function buildDemoData(network: NetworkName, rpcArg?: string): Promise<{ data: DemoData; evidenceSrc: string[] }> {
  const credFile = loadCredential(network, 1);
  if (!credFile) throw new Error(`fixtures/${network}-credential.json not found; run demo-scenario first`);
  const depFile = readJson<DeploymentFile>(deploymentPath(network));
  const deployment = toDeployment(depFile);
  const rpc = rpcArg ?? (network === "local" ? (depFile.rpc ?? DEFAULT_LOCAL_RPC) : undefined);
  const reader =
    network === "local"
      ? ChainReader.forRpc(deployment, [rpc as string], foundry)
      : rpc
        ? ChainReader.forRpc(deployment, [rpc], sepolia)
        : ChainReader.forSepolia(deployment);
  const chainId = await reader.client.getChainId();
  if (chainId !== deployment.chainId) throw new Error(`RPC is on chain ${chainId}, deployment is for ${deployment.chainId}`);

  if (credFile.registry.toLowerCase() !== deployment.contracts.EmissionsClaimRegistry.address.toLowerCase()) {
    throw new Error("the credential was signed for another registry; run demo-scenario again");
  }
  const cred = toSigned(credFile);
  const log = loadTxLog(network, chainId);
  const vlei = loadVlei(network, false);

  const reportKey = credFile.reportKey;
  const rep = await reader.report(reportKey);
  const inst = await reader.institution(leiHashOf(VERIFIER_LEI));
  if (
    inst.leCredSaidHash !== hashString(vlei.values.verifierLeSaid) ||
    inst.accreditationSaidHash !== hashString(vlei.values.accreditationSaid) ||
    rep.auditorAidHash !== auditorAidHashOf(vlei.values.auditorAid)
  ) {
    console.warn("! the chain holds other vLEI values than fixtures/vlei.json (allowlist added before the export?)");
  }
  if (rep.registeredAt === 0n) throw new Error("report 1 is not registered on this chain; run demo-scenario first");

  // ---- addresses
  let addresses: DemoData["addresses"];
  if (network === "local") {
    const [owner, watcher, body, supplier, impostor] = ANVIL_KEYS.map((k) => privateKeyToAccount(k).address);
    addresses = { owner, watcher, body, supplier, impostor };
  } else {
    const ctor = depFile.contracts.VerifierAllowlist.constructorArguments ?? [];
    const impostor = log.addresses.impostor ?? process.env.IMPOSTOR_ADDRESS;
    if (!impostor) throw new Error("impostor address unknown: set IMPOSTOR_ADDRESS or run demo-scenario with it set");
    addresses = {
      owner: getAddress(log.addresses.owner ?? ctor[0]),
      watcher: getAddress(log.addresses.watcher ?? ctor[1]),
      body: getAddress(cred.core.issuer.verifierAddress),
      supplier: getAddress(rep.supplier),
      impostor: getAddress(impostor),
    };
  }

  // ---- evidence
  // All exported evidence files, except KEL anchors of credentials other than the two demo credentials.
  const ownSaids = [credFile.credSAID, loadCredential(network, 2)?.credSAID].filter(Boolean);
  const evidenceAll = existsSync(EVIDENCE_DIR)
    ? readdirSync(EVIDENCE_DIR).filter((f) => statSync(resolve(EVIDENCE_DIR, f)).isFile()).sort()
    : [];
  const evidenceSrc = evidenceAll.filter((f) => !/^anchor-/.test(f) || ownSaids.some((x) => f === `anchor-${x}.json`));
  const skipped = evidenceAll.filter((f) => !evidenceSrc.includes(f));
  if (skipped.length) console.log(`  evidence: skipped anchors of other credentials: ${skipped.join(", ")}`);
  const anchorName = evidenceSrc.find((f) => f === `anchor-${credFile.credSAID}.json`);
  // Authority chain: an explicit authority*.json, else the credential-chain index written by
  // verifier/src/export-evidence.ts (index.json: credentials and KELs exported from KERIA).
  const authorityName =
    evidenceSrc.find((f) => /^authority.*\.json$/i.test(f)) ?? evidenceSrc.find((f) => f === "index.json");
  const index = evidenceSrc.includes("index.json") ? readJson<any>(resolve(EVIDENCE_DIR, "index.json")) : null;
  const credByFile = new Map<string, { schema?: string; issuer?: string; issuee?: string; said?: string }>(
    Object.values(index?.credentials ?? {}).map((c: any) => [c.file, c]),
  );
  const label = (f: string): string => {
    if (f === anchorName) return "Auditor KEL anchor of the demo credential";
    if (f === "index.json") return "vLEI evidence index (credentials and KELs)";
    if (f === authorityName) return "vLEI authority chain";
    const c = credByFile.get(f);
    if (c) return `${c.schema} credential, ${c.issuer} → ${c.issuee}`;
    const kel = /^kel-(.+)\.json$/.exec(f);
    if (kel) return `Key event log: ${kel[1]}`;
    const anchor = /^anchor-(.+)\.json$/.exec(f);
    if (anchor) return `KEL anchor of credential ${anchor[1]}`;
    return f;
  };

  // ---- proof
  const shipment = {
    batchId: SHIPMENT_1.batchId as string,
    quantityTonnes: SHIPMENT_1.quantityTonnes as string,
    shipmentDate: SHIPMENT_1.shipmentDate as string,
    importerSalt: credFile.importerSalt as Hex,
  };
  const proof: Presentation = {
    ...present(cred, DEMO_DISCLOSURE, shipment),
    ...(anchorName ? { anchorEvidence: readJson(resolve(EVIDENCE_DIR, anchorName)) } : {}),
    ...(authorityName && authorityName !== "index.json"
      ? { authorityEvidence: readJson(resolve(EVIDENCE_DIR, authorityName)) }
      : {}),
  };

  // ---- attacks (claimShipment arguments, caller = supplier)
  const claim1 = claimArgsOf(cred, { ...shipment, importerEORI: IMPORTER_1.eori });
  const sameBatch = claimArgsOf(cred, {
    batchId: SHIPMENT_1.batchId,
    quantityTonnes: SHIPMENT_1.quantityTonnes,
    importerEORI: IMPORTER_2.eori,
    importerSalt: credFile.importer2Salt as Hex,
  });
  const second = claimArgsOf(cred, {
    batchId: SHIPMENT_2.batchId,
    quantityTonnes: SHIPMENT_2.quantityTonnes,
    importerEORI: IMPORTER_2.eori,
    importerSalt: credFile.importer2Salt as Hex,
  });

  const order = (s: string) => SCENARIO_STEPS.indexOf(s);
  const txs = log.txs.filter((t) => order(t.step) >= 0).sort((a, b) => a.block - b.block || order(a.step) - order(b.step));
  const attack3 = txs.find((t) => t.step === "attack3" && t.result === "reverted") ?? null;

  // ---- cached snapshot
  const head = await reader.client.getBlock();
  const verification = await verifyPresentation(proof, reader, { importerEORI: IMPORTER_1.eori });
  const ship = await reader.shipmentStatus(claim1[1]);
  const dry = async (args: readonly [Hex, Hex, bigint, Hex]) => {
    const r = await reader.dryRun("claimShipment", args, addresses.supplier);
    return r.reverted ? { errorName: r.errorName, args: r.args.map(str) } : { errorName: "NONE (would succeed)", args: [] };
  };
  const cached: CachedSnapshot = {
    block: Number(head.number),
    time: isoOf(head.timestamp),
    remainingKg: (await reader.remainingKg(reportKey)).toString(),
    reportValid: await reader.isValidAt(reportKey, head.timestamp),
    shipment: { claimedAt: ship.claimedAt.toString(), quantityKg: ship.quantityKg.toString(), reportValid: ship.reportValid },
    verification: JSON.parse(toJson(verification)),
    dryRuns: { sameBatch: await dry(sameBatch), secondImporter: await dry(second) },
  };

  const { nodes, exportDate } = buildTrustChain(vlei, log, evidenceSrc, credByFile);
  const c = credFile.claims;
  const data: DemoData = {
    version: 1,
    mode: network === "local" ? "local" : "hosted",
    network:
      network === "local"
        ? { chainId, name: "Local anvil", rpcs: [rpc as string], explorer: "" }
        : { chainId, name: "Sepolia", rpcs: SEPOLIA_RPCS, explorer: "https://sepolia.etherscan.io" },
    deployment: {
      ...deployment,
      deployTxs: {
        VerifierAllowlist: depFile.contracts.VerifierAllowlist.txHash,
        EmissionsClaimRegistry: depFile.contracts.EmissionsClaimRegistry.txHash,
      },
      sourceVerified: network === "sepolia",
    },
    exportDate,
    addresses,
    importer: { name: IMPORTER_1.name, eori: IMPORTER_1.eori },
    secondImporter: { name: IMPORTER_2.name, eori: IMPORTER_2.eori },
    proof,
    credential: {
      coreJson: credFile.coreJson,
      signature: credFile.signature,
      disclosures: credFile.disclosures,
      reportKey,
      kelSeq: rep.kelSeq.toString(),
    },
    report: {
      installationName: c.installationName,
      installationId: c.installationId,
      cnCode: c.cnCode,
      reportingPeriod: c.reportingPeriod,
      verifiedTonnes: c.verifiedTonnes,
      intensity: c.specificEmbeddedEmissions_tCO2e_per_t,
      reportId: c.verificationReportId,
      accreditationNumber: c.accreditationNumber,
      issuedAt: c.issuedAt,
    },
    shipment,
    attacks: {
      sameBatch: { args: argsOut(sameBatch), caller: addresses.supplier },
      secondImporter: { args: argsOut(second), caller: addresses.supplier, quantityTonnes: SHIPMENT_2.quantityTonnes },
      attack3,
    },
    txs,
    trustChain: nodes,
    impostor: { name: demo.entities.impostor.name, lei: demo.entities.impostor.lei },
    comparison: {
      defaultValue: demo.defaultValue_tCO2e_per_t,
      verifiedValue: c.specificEmbeddedEmissions_tCO2e_per_t,
      quantityTonnes: SHIPMENT_1.quantityTonnes,
      ...PRICE,
    },
    evidence: {
      ...(anchorName ? { anchor: `evidence/${anchorName}` } : {}),
      ...(authorityName ? { authority: `evidence/${authorityName}` } : {}),
      files: evidenceSrc.map((f) => ({ label: label(f), path: `evidence/${f}` })),
    },
    cached,
  };
  return { data, evidenceSrc };
}

async function main() {
  const { values } = parseArgs({
    options: { network: { type: "string" }, rpc: { type: "string" }, out: { type: "string" } },
  });
  const network = values.network as NetworkName;
  if (network !== "local" && network !== "sepolia") throw new Error("--network local|sepolia is required");
  const out = resolve(values.out ?? resolve(ROOT, "demo/public/demo-data.json"));

  const { data, evidenceSrc } = await buildDemoData(network, values.rpc);
  const problems = checkDemoData(data);
  if (problems.length) throw new Error(`demo data does not match DemoData: ${problems.join(", ")}`);

  // demo/public/evidence/ is generated: rebuild it from the current evidence set.
  const dir = resolve(dirname(out), "evidence");
  rmSync(dir, { recursive: true, force: true });
  if (evidenceSrc.length) {
    mkdirSync(dir, { recursive: true });
    for (const f of evidenceSrc) copyFileSync(resolve(EVIDENCE_DIR, f), resolve(dir, f));
  }
  writeJson(out, data);

  const v = data.cached?.verification as { overall: string; checks: { index: number; status: string; code: string }[] };
  console.log(`wrote ${out}`);
  console.log(`  txs: ${data.txs.map((t) => `${t.step}=${t.result}`).join(", ") || "none"}`);
  console.log(`  verification: ${v.overall} · ${v.checks.map((x) => `${x.index}:${x.status}${x.code ? `(${x.code})` : ""}`).join(" ")}`);
  console.log(`  dry runs: ${Object.entries(data.cached?.dryRuns ?? {}).map(([k, r]) => `${k}=${r.errorName}`).join(", ")}`);
  console.log(`  remainingKg ${data.cached?.remainingKg} · evidence files ${data.evidence.files.length} · exportDate "${data.exportDate}"`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`build-demo-data failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
