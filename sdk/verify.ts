// Full verification of a supplier's proof (presentation), shared by the hosted page and the CLI.
// Checks: 0 structure, 1 SAID, 2 disclosures, 3 signature, 4 on-chain report, 5 shipment,
// 6 KEL anchor, 7 authority chain, 8 report reconciliation (advisory).
// All steps run even after a failure, so the result shows every failing check;
// only a malformed presentation (step 0) stops early.
import {
  auditorAidHashOf,
  batchKeyOf,
  credScopeKeyOf,
  importerCommitOf,
  installationCommitOf,
  reportIdHashOf,
  reportKeyOf,
  reportScopeKeyOf,
  supplierCommitOf,
  ZERO32,
} from "./commitment.ts";
import type { ChainReader, ReportRecord, ShipmentStatus } from "./chain.ts";
import {
  METHODOLOGY_NOTE,
  REQUIRED_DISCLOSURES,
  SEPOLIA_CHAIN_ID,
  checkNormalForms,
  checkShipmentForms,
  isoSeconds,
  isoToSeconds,
  kgToTonnes,
  tonnesToKg,
  type Hex,
} from "./credential.ts";
import { extractShapeProblem } from "./consistency.ts";
import { decodeDisclosure, disclosureDigest, type CredentialCore, type Presentation } from "./disclosure.ts";
import { recoverIssuer } from "./eip712.ts";
import { isSalt } from "./encoding.ts";
import { duplicateKey, verifySaid } from "./said.ts";

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface CheckResult {
  index: number;
  name: string;
  status: CheckStatus;
  code: string;
  detail: string;
}

export interface OnchainView {
  reportKey: Hex;
  batchKey?: Hex;
  registeredAt?: bigint;
  validUntil?: bigint;
  claimedAt?: bigint;
  verifiedKg?: bigint;
  remainingKg?: bigint;
  verifier?: Hex;
  issuerLeiHash?: Hex;
  supersedes?: Hex;
  supersededBy?: Hex;
}

/**
 * VALID: every check that applies passed. INVALID: a check failed. CONTESTED: needs a person's review (check 4 or 5):
 * the auditor was revoked, the body suspended or its address rotated soon after registration; the body was suspended
 * or its address rotated close to the shipment's claim; another body revised the credential with more tonnes or
 * another supplier; or the report was revoked close to such a key incident. INCOMPLETE: no check failed, but checks that decide validity
 * were not run (no evidence checkers for checks 6 and 7, a checker that answered only `warn` for one of them, or the
 * offline view without a chain); not a pass.
 */
export type Overall = "VALID" | "INVALID" | "CONTESTED" | "INCOMPLETE";

/** Something the caller should know about how the checks were run; it does not change any check. */
export interface VerificationWarning {
  code: "SHIPMENT_NOT_BOUND" | "EVIDENCE_NOT_CHECKED";
  detail: string;
}

export interface VerificationResult {
  overall: Overall;
  checks: CheckResult[];
  disclosed: Record<string, string>;
  hidden: number;
  onchain?: OnchainView;
  primaryCode: string;
  /**
   * Time used for checks 4 and 5: the shipment's claimedAt when check 5 binds the batch to the verifier's EORI,
   * otherwise the time of the pinned head block.
   */
  checkedAt?: bigint;
  /** Absent in results recorded before warnings existed (the demo's cached view). */
  warnings?: VerificationWarning[];
}

/** Plug-ins for checks 6–8 (vLEI evidence and report reconciliation live in their own modules). */
export interface EvidenceCheckers {
  anchor?: (evidence: unknown, ctx: EvidenceContext) => Promise<CheckResult> | CheckResult;
  authority?: (evidence: unknown, ctx: EvidenceContext) => Promise<CheckResult> | CheckResult;
  reconciliation?: (extract: Record<string, unknown>, ctx: EvidenceContext) => Promise<CheckResult> | CheckResult;
}

export interface EvidenceContext {
  core: CredentialCore;
  disclosed: Record<string, string>;
  /** Names of fields that were presented but rejected by check 2 (they are not in `disclosed`). */
  rejected?: readonly string[];
  report?: ReportRecord;
  reader: ChainReader;
}

export interface VerifyOptions {
  /**
   * The verifier's own EORI, to confirm the shipment was declared to them (check 5d). Only then is the report
   * judged at the shipment's claim time; without it, at the head block's time.
   */
  importerEORI?: string;
  /** CONTESTED window before a revocation or suspension, in hours (default 24). */
  contestedWindowHours?: number;
  checkers?: EvidenceCheckers;
  /**
   * Largest accepted age, in seconds, of the RPC's latest block against this computer's clock; an older head
   * means a node that is behind, and the verification throws rather than read an old state. Default:
   * `DEFAULT_MAX_HEAD_AGE_SEC` for the deployment's chain (300 s on Sepolia; no limit on other chains, such as a
   * local anvil chain). `Infinity` turns the limit off.
   */
  maxHeadAgeSec?: number;
  /** Clock for the head-age limit, in milliseconds (default `Date.now`). */
  now?: () => number;
  /**
   * The text the proof was parsed from (a file, a pasted text). When given, check 0 refuses a text that repeats
   * a key in any object, which `JSON.parse` would silently resolve to the last value.
   */
  proofText?: string;
}

/**
 * Check 4's detail for a credential that is superseded (code REPORT_INVALID/SUPERSEDED); `bodyChanged` is appended
 * when the successor has another issuing body. Any other reason check 4 fails is appended after "; ".
 */
export const SUPERSEDED_DETAIL = {
  inLayer: "replaced by a revision in the same credential layer",
  scopeMoved: "the report scope moved to another report (whole-report revision or takeover by another body)",
  bodyChanged: "; issuing body changed",
} as const;

/** Check 4 failed only because the credential was superseded (no other reason, such as expiry, was found). */
export function onlySuperseded(c: CheckResult | undefined): boolean {
  if (!c || c.status !== "fail" || c.code !== "REPORT_INVALID/SUPERSEDED") return false;
  const { inLayer, scopeMoved, bodyChanged } = SUPERSEDED_DETAIL;
  return [inLayer, scopeMoved, inLayer + bodyChanged, scopeMoved + bodyChanged].includes(c.detail as never);
}

/** Check 4 and 5 detail: a revocation within the CONTESTED window of a key incident at the issuing body. */
export const REVOKED_UNDER_INCIDENT = (hours: number) =>
  `within ${hours} h of a suspension of the issuing body or a rotation of its address, so the revocation may have been sent with a stolen key`;
/** Check 4 detail: a key incident at the issuing body within the CONTESTED window of the shipment's claim. */
export const CLAIM_UNDER_INCIDENT = (hours: number) =>
  `the issuing body was suspended or its address rotated within ${hours} h of this shipment's claim`;
/** Check 4 note: the shipment was claimed shortly before the credential was revised. */
export const CLAIMED_BEFORE_REVISION = (hours: number) =>
  `claimed within ${hours} h before this credential was revised: a pending downward correction may have been front-run`;
/** Check 4 detail when a revision by another body raised the verified tonnage (from, to in tonnes). */
export const CROSS_BODY_DETAIL = {
  raised: (from: string, to: string) => `revised by another body with more verified tonnes than the earlier body's credential (${from} t → ${to} t)`,
  supplier: "revised by another body with another supplier address than the earlier body's credential",
  tooLong: (n: number) => `revision chain longer than ${n} credentials of this body; a change of body before them was not checked`,
} as const;
/** How many credentials of the same body `crossBodyRevision` follows back, at most, to find a change of body. */
export const MAX_SAME_BODY_REVISIONS = 8;

/**
 * CR3: reasons to contest a credential whose revision chain changes issuing body. A body can revise another body's
 * credential once that body is suspended or past its accreditation (and an accreditation cannot be renewed, so the
 * second case is permanent); the contract lets it name another supplier and raise the verified tonnage. Follows
 * the chain back through this body's own earlier credentials (at most `MAX_SAME_BODY_REVISIONS` reads, one per
 * credential) to the last credential of the earlier body, so a takeover at the same tonnage followed by a raise
 * by the same body is caught too, and compares the supplier address and, within one credential layer, the
 * verified tonnage. A supplier LEI behind a fresh salt cannot be compared (the commitment is salted per credential).
 */
async function crossBodyRevision(rd: ChainReader, rep: ReportRecord, prev: ReportRecord): Promise<string[]> {
  let earlier = prev;
  for (let i = 0; earlier.issuerLeiHash === rep.issuerLeiHash; i++) {
    if (earlier.supersedes === ZERO32) return [];
    if (i >= MAX_SAME_BODY_REVISIONS) return [CROSS_BODY_DETAIL.tooLong(MAX_SAME_BODY_REVISIONS)];
    earlier = await rd.report(earlier.supersedes);
  }
  const reasons: string[] = [];
  if (rep.credScopeKey === earlier.credScopeKey && rep.verifiedKg > earlier.verifiedKg) {
    reasons.push(CROSS_BODY_DETAIL.raised(kgToTonnes(earlier.verifiedKg), kgToTonnes(rep.verifiedKg)));
  }
  if (lower(rep.supplier) !== lower(earlier.supplier)) reasons.push(CROSS_BODY_DETAIL.supplier);
  return reasons;
}

/** Default head-age limit per chain ID, in seconds (Sepolia makes a block every 12 s). */
export const DEFAULT_MAX_HEAD_AGE_SEC: Readonly<Record<number, number>> = { [SEPOLIA_CHAIN_ID]: 300 };

const NAMES = [
  "Structure",
  "Credential integrity (SAID)",
  "Disclosed fields",
  "Issuer signature",
  "On-chain report",
  "Shipment claim",
  "Auditor anchor (KEL)",
  "Authority chain (vLEI)",
  "Report reconciliation",
];

const lower = (s: string) => s.toLowerCase();

function result(index: number, status: CheckStatus, code = "", detail = ""): CheckResult {
  return { index, name: NAMES[index], status, code, detail };
}

/** Starts a read before its result is needed: a rejection is kept for whoever awaits it, never left unhandled. */
function early<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/** What checks 0-2 found, for the checks that follow. */
interface LocalPart {
  core: CredentialCore;
  decoded: { name: string; value: string; salt: string; encoded: string }[];
  get: (name: string) => string;
  checks: CheckResult[];
  disclosed: Record<string, string>;
  hidden: number;
}

/**
 * Checks 0-2: they read only the proof. A malformed proof (check 0) gives its final result. `proofText`, when the
 * caller has it, is the text `p` was parsed from.
 */
function localChecks(p: Presentation, proofText?: string): LocalPart | VerificationResult {
  // ---------------------------------------------------------------- 0 structure
  let core: CredentialCore;
  const checks: CheckResult[] = [];
  const disclosed: Record<string, string> = {};
  const decoded: { name: string; value: string; salt: string; encoded: string }[] = [];
  const malformed = (detail: string): VerificationResult => ({
    overall: "INVALID",
    checks: [result(0, "fail", "PRESENTATION_MALFORMED", detail)],
    disclosed: {},
    hidden: 0,
    primaryCode: "PRESENTATION_MALFORMED",
  });
  // JSON.parse keeps the last of two equal keys, where another reader may take the first: a proof whose text
  // repeats a key (two "core" or "shipment" members, say) is refused rather than read one way here.
  const repeatedInProof = proofText === undefined ? null : duplicateKey(proofText);
  if (repeatedInProof !== null) return malformed(`the proof repeats the key ${JSON.stringify(repeatedInProof)}`);
  try {
    core = JSON.parse(p.core) as CredentialCore;
  } catch {
    return malformed("the credential core is not valid JSON");
  }
  if (
    typeof core?.d !== "string" ||
    typeof core.issuer?.verifierAddress !== "string" ||
    typeof core.issuer?.verifierLEI !== "string" ||
    typeof core.issuer?.auditorAID !== "string" ||
    !Array.isArray(core.digests) ||
    typeof core.validUntil !== "string" ||
    typeof p.signature !== "string" ||
    !Array.isArray(p.disclosures)
  ) {
    return malformed("missing core, signature or disclosure fields");
  }
  if (isoSeconds(core.validUntil) === undefined) {
    return malformed("the credential core's validUntil is not an ISO 8601 time with a time zone");
  }
  for (const enc of p.disclosures) {
    try {
      decoded.push({ ...decodeDisclosure(enc), encoded: enc });
    } catch {
      return malformed("a disclosure is not a [salt, name, value] array");
    }
  }
  const byName = new Map(decoded.map((d) => [d.name, d.value]));
  const missing = REQUIRED_DISCLOSURES.filter((n) => !byName.has(n));
  if (missing.length) return malformed(`required fields not disclosed: ${missing.join(", ")}`);
  if (byName.get("methodologyNote") !== METHODOLOGY_NOTE) return malformed("methodology note missing or changed");
  const badForms = checkNormalForms(Object.fromEntries(byName));
  if (badForms.length) return malformed(`not in normal form: ${badForms.join(", ")}`);
  if (!isSalt(byName.get("idSalt")) || !isSalt(byName.get("batchSalt"))) return malformed("salts must be 32-byte hex");
  if (
    p.shipment &&
    !(
      typeof p.shipment.batchId === "string" &&
      typeof p.shipment.quantityTonnes === "string" &&
      typeof p.shipment.shipmentDate === "string" &&
      isSalt(p.shipment.importerSalt)
    )
  ) {
    return malformed("shipment part incomplete");
  }
  const badShipment = p.shipment ? checkShipmentForms(p.shipment) : [];
  if (badShipment.length) return malformed(`shipment fields not in normal form: ${badShipment.join(", ")}`);
  if (p.reportExtract !== undefined) {
    const shape = extractShapeProblem(p.reportExtract);
    if (shape) return malformed(shape);
  }
  checks.push(result(0, "pass"));
  const get = (n: string) => byName.get(n) as string;

  // --------------------------------------------------------------------- 1 SAID
  // The SAID covers the parsed object, so a text whose parse loses information (a repeated key keeps only its
  // last value; a top-level "__proto__" key is not copied into the digest) is refused from the raw text.
  const repeated = duplicateKey(p.core);
  checks.push(
    repeated !== null
      ? result(1, "fail", "SAID_MISMATCH", `the credential core repeats the key ${JSON.stringify(repeated)}`)
      : Object.hasOwn(core, "__proto__")
        ? result(1, "fail", "SAID_MISMATCH", 'the credential core has a top-level "__proto__" key')
        : verifySaid(p.core)
          ? result(1, "pass", "", "credential ID matches its content")
          : result(1, "fail", "SAID_MISMATCH", "content changed after the credential ID was computed"),
  );

  // ---------------------------------------------------------------- 2 disclosure
  const digests = new Set(core.digests);
  const seen = new Set<string>();
  let tampered = "";
  for (const d of decoded) {
    if (seen.has(d.name)) tampered ||= `${d.name} disclosed twice`;
    seen.add(d.name);
    if (!digests.has(disclosureDigest(d.encoded))) tampered ||= `${d.name} does not match the signed credential`;
    else disclosed[d.name] = d.value;
  }
  const hidden = core.digests.length - Object.keys(disclosed).length;
  checks.push(
    tampered
      ? result(2, "fail", "DISCLOSURE_TAMPERED", tampered)
      : result(2, "pass", "", `${Object.keys(disclosed).length} fields disclosed, ${hidden} hidden by supplier`),
  );

  return { core, decoded, get, checks, disclosed, hidden };
}

/** Check 3: the EIP-712 signer under the registry's signing domain on `chainId`. */
async function signatureCheck(
  p: Presentation,
  { core, get }: LocalPart,
  registry: Hex,
  chainId: number,
): Promise<{ check: CheckResult; verifiedKg?: bigint; validUntilSec?: bigint }> {
  let verifiedKg: bigint | undefined;
  let validUntilSec: bigint | undefined;
  try {
    verifiedKg = tonnesToKg(get("verifiedTonnes"));
    validUntilSec = isoToSeconds(core.validUntil);
    const signer = await recoverIssuer(
      registry,
      {
        credSAID: core.d,
        supplierCommit: supplierCommitOf(get("supplierLEI"), get("idSalt") as Hex),
        verifiedKg,
        validUntil: validUntilSec,
      },
      p.signature,
      chainId,
    );
    return {
      check:
        lower(signer) === lower(core.issuer.verifierAddress)
          ? result(3, "pass", "", `signed by ${core.issuer.verifierAddress}`)
          : result(3, "fail", "BAD_SIGNATURE", "signature does not match the issuer in the credential"),
      verifiedKg,
      validUntilSec,
    };
  } catch (e) {
    return {
      check: result(3, "fail", "BAD_SIGNATURE", `signature could not be checked: ${(e as Error).message}`),
      verifiedKg,
      validUntilSec,
    };
  }
}

const isFinal = (x: LocalPart | VerificationResult): x is VerificationResult => "overall" in x;

/**
 * Checks 0-3 without a chain (the demo's offline view): the signature is checked under the signing domain of
 * `registry` on `chainId`, taken from the deployment, not from a node. Checks 4-8 need the chain and are reported
 * as not run, so the result is INCOMPLETE at best, never VALID.
 */
export async function verifyOffline(
  p: Presentation,
  deployment: { registry: Hex; chainId: number },
  opts: Pick<VerifyOptions, "proofText"> = {},
): Promise<VerificationResult> {
  const local = localChecks(p, opts.proofText);
  if (isFinal(local)) return local;
  const { checks, disclosed, hidden } = local;
  checks.push((await signatureCheck(p, local, deployment.registry, deployment.chainId)).check);
  for (let i = 4; i <= 8; i++) checks.push(result(i, "skipped", "", "not run: needs a live connection to the chain"));
  const failed = checks.filter((x) => x.status === "fail");
  return {
    overall: failed.length ? "INVALID" : "INCOMPLETE",
    checks,
    disclosed,
    hidden,
    primaryCode: failed[0]?.code ?? "",
    warnings: [],
  };
}

export async function verifyPresentation(
  p: Presentation,
  reader: ChainReader,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  const local = localChecks(p, opts.proofText);
  if (isFinal(local)) return local;
  const { core, decoded, get, checks, disclosed, hidden } = local;

  // All chain reads are pinned to one block: round 0 reads the latest block B (number and
  // timestamp); every view call after that reads block B and every event search ends at B, so the
  // checks see one consistent snapshot even if new blocks arrive while they run.
  // After round 0 the reads go out in rounds of parallel requests: everything that depends only on
  // the proof first, then everything that depends on the registered report. A read whose answer may
  // not be needed starts early but is awaited only where the checks use it, in the same order as
  // before, so a failing read is reported exactly as if the reads ran one after another.
  const reportKey = reportKeyOf(core.d);
  const batchKey = p.shipment ? batchKeyOf(reportKey, p.shipment.batchId, get("batchSalt") as Hex) : undefined;
  const expectedScopeKey = reportScopeKeyOf(get("installationId"), get("reportingPeriod"));
  const chainIdP = early(reader.client.getChainId());
  // The deployment block's timestamp anchors the block search of 4l; it does not depend on the snapshot.
  if (!reader.options.fullEventScan) early(reader.deploymentTimestamp());
  const head = await reader.latestBlock();
  // A load-balanced RPC can answer from a node that is behind: fail closed rather than check an old state.
  if (head.number < reader.deployedBlock) {
    throw new Error(
      `RPC node is behind: its latest block ${head.number} is before the contracts were deployed (block ${reader.deployedBlock}); try again or use another RPC`,
    );
  }
  // ... or from a node that stopped following the chain: its head is older than the clock allows.
  const maxAge = opts.maxHeadAgeSec ?? DEFAULT_MAX_HEAD_AGE_SEC[reader.chainId];
  if (maxAge !== undefined) {
    if (Number.isNaN(maxAge) || maxAge < 0) throw new Error(`maxHeadAgeSec must be a number of seconds ≥ 0, got ${maxAge}`);
    const nowSec = BigInt(Math.floor((opts.now ?? Date.now)() / 1000));
    const age = nowSec - head.timestamp;
    if (maxAge !== Infinity && age > BigInt(Math.floor(maxAge))) {
      throw new Error(
        `RPC node is behind: its latest block ${head.number} is ${age} s old, more than the ${maxAge} s allowed, so it may not show a recent revocation; try again or use another RPC (or check this computer's clock)`,
      );
    }
  }
  const rd = reader.at(head.number);
  const repP = early(rd.report(reportKey));
  const statusP = batchKey ? early(rd.shipmentStatus(batchKey)) : undefined;
  const remainingP = early(rd.remainingKg(reportKey));
  const expectedScopeP = early(rd.reportScope(expectedScopeKey));

  // ----------------------------------------------------------------- 3 signature
  const chainId = await chainIdP;
  // The deployment file names the chain its contracts are on; an RPC on another chain reads other contracts.
  if (chainId !== reader.chainId) {
    throw new Error(
      `RPC is on chain ${chainId}, but the deployment is for chain ${reader.chainId}; use an RPC for chain ${reader.chainId}`,
    );
  }
  const sig = await signatureCheck(p, local, rd.registry, chainId);
  const { verifiedKg, validUntilSec } = sig;
  checks.push(sig.check);

  // ------------------------------------------------------------- 4 on-chain report
  const onchain: OnchainView = { reportKey };
  const rep = await repP;
  if (rep.registeredAt !== 0n && head.timestamp < rep.registeredAt) {
    throw new Error(
      `RPC node is behind: its block ${head.number} (time ${head.timestamp}) is older than the report's registration (time ${rep.registeredAt}); try again or use another RPC`,
    );
  }
  const windowSecOf = () => BigInt(Math.round((opts.contestedWindowHours ?? 24) * 3600));
  let status: ShipmentStatus | undefined;
  if (statusP) {
    status = await statusP;
    onchain.batchKey = batchKey;
  }
  const atClaim = status !== undefined && status.claimedAt !== 0n && lower(status.reportKey) === lower(reportKey);
  // The report is judged at the claim time only for the importer the batch was declared to: the EORI given by
  // the verifier, with the proof's salt, must give the claim's importerCommit. Anyone else (no EORI, or another
  // one) judges it at the head block's time, so an old claim for someone else cannot bring back a credential
  // that has since been superseded or has expired.
  const boundToVerifier =
    atClaim &&
    status !== undefined &&
    opts.importerEORI !== undefined &&
    opts.importerEORI !== "" &&
    p.shipment !== undefined &&
    status.importerCommit === importerCommitOf(opts.importerEORI, p.shipment.importerSalt);
  const t = boundToVerifier && status ? status.claimedAt : head.timestamp;
  let contested = false;

  // CONTESTED events (4l, and the key-incident rules of checks 4 and 5), searched up to block B (the snapshot) in
  // one search: auditor revocations, suspensions of the body and rotations of its address. Each event's time is the
  // timestamp of its block, and only an event inside one of these intervals can flag the proof, so the search
  // covers the blocks of those intervals (each with a margin of blocks outside it), found by interpolation search;
  // on any error, every block from the deployment block to B:
  //   - [registeredAt, registeredAt + window]: 4l (auditor revoked, body suspended, issuing address rotated);
  //   - [claimedAt - window, claimedAt + window], for a shipment bound to the verifier: a key incident around the claim;
  //   - [revokedAt - window, revokedAt + window], for a revoked report: a key incident around the revocation.
  let windowSec: bigint | undefined;
  try {
    windowSec = windowSecOf();
  } catch {}
  const intervals: [bigint, bigint][] = [];
  if (rep.registeredAt !== 0n) {
    // An option that is not a number: search up to B (check 4 then throws, as before).
    if (windowSec === undefined) intervals.push([rep.registeredAt, head.timestamp]);
    else {
      intervals.push([rep.registeredAt, rep.registeredAt + windowSec]);
      if (boundToVerifier && status) intervals.push([status.claimedAt - windowSec, status.claimedAt + windowSec]);
      if (rep.revokedAt !== 0n) intervals.push([rep.revokedAt - windowSec, rep.revokedAt + windowSec]);
    }
  }
  const eventsP = intervals.length
    ? early(rd.bodyEventsInTimes(rep.issuerLeiHash, rep.auditorAidHash, intervals, head))
    : undefined;
  /** Key incidents at the issuing body (suspension or address rotation) within the window of time `at`. */
  const keyIncidentNear = async (at: bigint) => {
    const w = windowSecOf();
    return ((await eventsP) ?? []).some(
      (e) => (e.kind === "suspended" || e.kind === "rotated") && (e.time >= at ? e.time - at : at - e.time) <= w,
    );
  };
  const hours = opts.contestedWindowHours ?? 24;
  const revokedUnderIncident = async () => rep.revokedAt !== 0n && (await keyIncidentNear(rep.revokedAt));

  // Checks 6-8 only need the report and the disclosed fields: start them now, alongside check 4's reads.
  const ctx: EvidenceContext = { core, disclosed, rejected: decoded.map((d) => d.name).filter((n) => !Object.hasOwn(disclosed, n)), report: rep.registeredAt === 0n ? undefined : rep, reader: rd };
  const c = opts.checkers ?? {};
  const { anchor, authority, reconciliation } = c;
  const anchorP =
    p.anchorEvidence !== undefined && anchor ? early(Promise.resolve().then(() => anchor(p.anchorEvidence, ctx))) : undefined;
  const authorityP =
    p.authorityEvidence !== undefined && authority
      ? early(Promise.resolve().then(() => authority(p.authorityEvidence, ctx)))
      : undefined;
  const reportExtract = p.reportExtract;
  const reconciliationP =
    reportExtract !== undefined && reconciliation
      ? early(Promise.resolve().then(() => reconciliation(reportExtract, ctx)))
      : undefined;

  if (rep.registeredAt === 0n) {
    checks.push(result(4, "fail", "REPORT_INVALID/NOT_REGISTERED", "no report with this credential ID on the registry"));
  } else {
    Object.assign(onchain, {
      registeredAt: rep.registeredAt,
      validUntil: rep.validUntil,
      verifiedKg: rep.verifiedKg,
      verifier: rep.verifier,
      issuerLeiHash: rep.issuerLeiHash,
      supersedes: rep.supersedes,
      supersededBy: rep.supersededBy,
      remainingKg: await remainingP,
    });
    const fails: [string, string][] = [];
    const notes: string[] = [];

    // Second round of reads (they depend on the registered report and on t).
    const scopeP =
      rep.reportScopeKey === expectedScopeKey ? expectedScopeP : early(rd.reportScope(rep.reportScopeKey));
    const supersededByP = rep.supersededBy !== ZERO32 ? early(rd.report(rep.supersededBy)) : undefined;
    const unboundAtP = early(
      scopeP.then((s) =>
        rep.reportIdHash === s.reportIdHash ? 0n : rd.reportIdUnboundAt(rep.reportScopeKey, rep.reportIdHash),
      ),
    );
    const prevP = rep.supersedes !== ZERO32 ? early(rd.report(rep.supersedes)) : undefined;
    const contractValidP = early(rd.isValidAt(reportKey, t));
    // 4b revoked
    const revoked = rep.revokedAt !== 0n;
    if (revoked) fails.push(["REPORT_INVALID/REVOKED", "the verification body revoked this report"]);

    // 4d superseded or moved off the report scope
    const scope = await scopeP;
    let supersededAt = 0n;
    if (supersededByP) supersededAt = (await supersededByP).registeredAt;
    const unboundAt = await unboundAtP;
    const replacedInLayer = rep.supersededBy !== ZERO32 && t >= supersededAt;
    const scopeMoved = rep.reportIdHash !== scope.reportIdHash && (unboundAt === 0n || t >= unboundAt);
    const sameBlockException =
      boundToVerifier &&
      status?.reportValid === true &&
      (replacedInLayer || scopeMoved) &&
      (!replacedInLayer || supersededAt === t) &&
      (!scopeMoved || unboundAt === t);
    if ((replacedInLayer || scopeMoved) && !sameBlockException) {
      let detail = replacedInLayer ? SUPERSEDED_DETAIL.inLayer : SUPERSEDED_DETAIL.scopeMoved;
      const successor = replacedInLayer ? rep.supersededBy : scope.latestReportKey;
      const succ = await rd.report(successor);
      if (succ.issuerLeiHash !== rep.issuerLeiHash) detail += SUPERSEDED_DETAIL.bodyChanged;
      fails.push(["REPORT_INVALID/SUPERSEDED", detail]);
    } else if (sameBlockException) {
      notes.push("valid when shipped; replaced later in the same block");
    }
    let prev: ReportRecord | undefined;
    if (prevP) {
      prev = await prevP;
      notes.push(
        prev.credScopeKey === rep.credScopeKey
          ? "this credential revises an earlier one in the same layer"
          : "registered through a report-scope takeover; the earlier layer is frozen",
      );
    }

    // 4e expired
    const expired = t > rep.validUntil;
    if (expired) fails.push(["REPORT_INVALID/EXPIRED", "past the credential's validity"]);

    // 4f authorization: checked live by the contract at registration (not recomputed)
    // 4g registrant
    if (lower(rep.verifier) !== lower(core.issuer.verifierAddress)) {
      fails.push(["REPORT_INVALID/REGISTRANT_MISMATCH", "registered by another address than the credential's issuer"]);
    }
    // 4h issued content
    if (
      rep.auditorAidHash !== auditorAidHashOf(core.issuer.auditorAID) ||
      (verifiedKg !== undefined && rep.verifiedKg !== verifiedKg) ||
      (validUntilSec !== undefined && rep.validUntil !== validUntilSec)
    ) {
      fails.push(["REPORT_INVALID/ISSUER_MISMATCH", "auditor, quantity or validity differs from the signed credential"]);
    }
    // 4i supplier
    if (
      rep.supplierCommit !== supplierCommitOf(get("supplierLEI"), get("idSalt") as Hex) ||
      rep.installationCommit !== installationCommitOf(get("installationId"), get("idSalt") as Hex)
    ) {
      fails.push(["REPORT_INVALID/SUPPLIER_MISMATCH", "supplier or installation differs from the registered report"]);
    }
    // 4j scope keys
    if (
      rep.reportScopeKey !== reportScopeKeyOf(get("installationId"), get("reportingPeriod")) ||
      rep.credScopeKey !==
        credScopeKeyOf(get("installationId"), get("cnCode"), get("cbamRoute"), get("reportingPeriod")) ||
      rep.reportIdHash !== reportIdHashOf(get("verificationReportId"))
    ) {
      fails.push(["REPORT_INVALID/SCOPE_MISMATCH", "installation, CN code, route, period or report ID differs"]);
    }
    // 4k cross-check with the contract's own answer
    const localValid = !revoked && !(replacedInLayer || scopeMoved) && !expired;
    const contractValid = await contractValidP;
    if (localValid !== contractValid || (atClaim && status && status.reportValid !== !revoked)) {
      fails.push(["REPORT_INVALID", "contract and local checks disagree (SDK or ABI version?)"]);
    }

    if (fails.length === 1 && fails[0][0] === "REPORT_INVALID/REVOKED" && (await revokedUnderIncident())) {
      // CR1: a stolen body key (or an owner key used to rotate the body's address) can revoke every report of the
      // body, and nothing can undo it. A revocation within the window of a suspension of the body or a rotation of
      // its address may be the attacker's: a person reviews it rather than the verifier rejecting the shipment.
      contested = true;
      checks.push(result(4, "warn", "CONTESTED", `${fails[0][1]}; ${REVOKED_UNDER_INCIDENT(hours)}`));
    } else if (fails.length) {
      checks.push(result(4, "fail", fails[0][0], fails.map((f) => f[1]).join("; ")));
    } else {
      // 4l revocation window: registered shortly before the auditor was revoked or the body suspended
      // (the report is registered here, so the search was started above)
      const windowSec = windowSecOf();
      const events = (await eventsP) ?? [];
      const after = (e: { time: bigint }) => rep.registeredAt <= e.time && e.time - rep.registeredAt <= windowSec;
      const reasons: string[] = [];
      if (events.some((e) => (e.kind === "auditorRevoked" || e.kind === "suspended") && after(e))) {
        reasons.push(`revoked or suspended within ${hours} h after`);
      }
      // CR9: the address that registered the report was rotated away soon after (the incident response to a
      // stolen key may be a rotation rather than a suspension).
      if (events.some((e) => e.kind === "rotated" && lower(e.oldAddr ?? "") === lower(rep.verifier) && after(e))) {
        reasons.push(`the registering address was rotated within ${hours} h after`);
      }
      // CR1/CR9 at the claim: a suspension of the body or a rotation of its address within the window of the claim
      // of the shipment declared to the verifier (a credential registered by a stolen key and claimed at once).
      if (boundToVerifier && status && (await keyIncidentNear(status.claimedAt))) {
        reasons.push(CLAIM_UNDER_INCIDENT(hours));
      }
      // CR3: a revision by another body (possible once the earlier body is suspended or past its accreditation,
      // permanently in the second case) that raises the verified tonnage or changes the supplier address.
      if (prev) reasons.push(...(await crossBodyRevision(rd, rep, prev)));
      contested = reasons.length > 0;
      // CR2: a claim shortly before the credential was revised; a downward correction may have been front-run.
      if (boundToVerifier && status && !contested) {
        const nexts = [
          ...(rep.supersededBy !== ZERO32 ? [supersededAt] : []),
          ...(rep.reportIdHash !== scope.reportIdHash && unboundAt !== 0n ? [unboundAt] : []),
        ].filter((x) => x >= status!.claimedAt);
        if (nexts.some((x) => x - status!.claimedAt <= windowSec)) notes.push(CLAIMED_BEFORE_REVISION(hours));
      }
      const base = "registered by an authorized auditor (checked by the contract at registration)";
      checks.push(
        contested
          ? result(4, "pass", "CONTESTED", [base, ...reasons].join("; "))
          : result(4, "pass", "", [base, ...notes].join("; ")),
      );
    }
  }

  // ----------------------------------------------------------------- 5 shipment
  if (!p.shipment) {
    checks.push(result(5, "skipped", "", "no shipment in this proof"));
  } else if (!opts.importerEORI) {
    checks.push(result(5, "skipped", "", "enter your EORI to confirm the shipment was declared to you"));
  } else if (!status || status.claimedAt === 0n) {
    checks.push(result(5, "fail", "SHIPMENT_MISMATCH", "no claim for this batch on the registry"));
  } else {
    onchain.claimedAt = status.claimedAt;
    let qtyKg: bigint | undefined;
    try {
      qtyKg = tonnesToKg(p.shipment.quantityTonnes);
    } catch {
      qtyKg = undefined;
    }
    const problem =
      lower(status.reportKey) !== lower(reportKey)
        ? "the batch was claimed against another report"
        : status.quantityKg !== qtyKg
          ? "the claimed quantity differs"
          : status.importerCommit !== importerCommitOf(opts.importerEORI, p.shipment.importerSalt)
            ? "the batch was not declared to your EORI"
            : !status.reportValid
              ? "the report was revoked after the claim"
              : "";
    const declared = `${kgToTonnes(status.quantityKg)} t declared to you on the shared ledger`;
    checks.push(
      problem === "the report was revoked after the claim" && (await revokedUnderIncident())
        ? ((contested = true), result(5, "warn", "CONTESTED", `${declared}; ${problem}, ${REVOKED_UNDER_INCIDENT(hours)}`))
        : problem
          ? result(5, "fail", "SHIPMENT_MISMATCH", problem)
          : result(5, "pass", "", declared),
    );
  }

  // ------------------------------------------------------------ 6, 7, 8 evidence
  // (started after the first round of reads; their results are added here, in order)
  if (p.anchorEvidence === undefined) {
    checks.push(result(6, "fail", "ANCHOR_NOT_FOUND", "no KEL anchor evidence in this proof"));
  } else if (!anchorP) {
    checks.push(result(6, "skipped", "", "anchor verification not available here"));
  } else {
    checks.push({ ...(await anchorP), index: 6, name: NAMES[6] });
  }
  if (p.authorityEvidence === undefined) {
    checks.push(result(7, "fail", "AUTHORITY_INVALID", "no vLEI authority evidence in this proof"));
  } else if (!authorityP) {
    checks.push(result(7, "skipped", "", "authority-chain verification not available here"));
  } else {
    checks.push({ ...(await authorityP), index: 7, name: NAMES[7] });
  }
  if (p.reportExtract === undefined) {
    checks.push(result(8, "skipped", "", "no report extract in this proof"));
  } else if (!reconciliationP) {
    checks.push(result(8, "skipped", "", "reconciliation not available here"));
  } else {
    checks.push({ ...(await reconciliationP), index: 8, name: NAMES[8] });
  }

  const warnings: VerificationWarning[] = [];
  if (p.shipment && !opts.importerEORI) {
    warnings.push({
      code: "SHIPMENT_NOT_BOUND",
      detail:
        "no EORI given: check 5 did not bind the shipment to you, so check 4 judged the report at the latest block's time, not at the shipment's claim time",
    });
  }
  // Checks 6 and 7 decide whether the auditor and the body were authorised: a result without them is not a pass.
  // Anything but pass or fail counts as not checked: skipped (no checker), and also warn from a caller's own
  // checker, which does not say the evidence holds.
  const notChecked = [6, 7].filter((i) => {
    const s = checks.find((x) => x.index === i)?.status;
    return s !== "pass" && s !== "fail";
  });
  if (notChecked.length) {
    const warned = notChecked.filter((i) => checks.find((x) => x.index === i)?.status === "warn");
    const notRun = notChecked.filter((i) => !warned.includes(i));
    const list = (ns: number[]) => `check${ns.length > 1 ? "s" : ""} ${ns.join(" and ")}`;
    warnings.push({
      code: "EVIDENCE_NOT_CHECKED",
      detail: [
        ...(notRun.length ? [`${list(notRun)} not run: no evidence checker was supplied`] : []),
        ...(warned.length ? [`${list(warned)} gave only a warning: the evidence checker did not confirm the evidence`] : []),
      ].join("; "),
    });
  }

  const failed = checks.filter((x) => x.status === "fail");
  return {
    overall: failed.length ? "INVALID" : contested ? "CONTESTED" : notChecked.length ? "INCOMPLETE" : "VALID",
    checks,
    disclosed,
    hidden,
    onchain,
    primaryCode: failed[0]?.code ?? "",
    checkedAt: t,
    warnings,
  };
}
