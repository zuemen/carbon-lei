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
  checkNormalForms,
  isoToSeconds,
  tonnesToKg,
  type Hex,
} from "./credential.ts";
import { decodeDisclosure, disclosureDigest, type CredentialCore, type Presentation } from "./disclosure.ts";
import { recoverIssuer } from "./eip712.ts";
import { isSalt } from "./encoding.ts";
import { verifySaid } from "./said.ts";

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

export interface VerificationResult {
  overall: "VALID" | "INVALID" | "CONTESTED";
  checks: CheckResult[];
  disclosed: Record<string, string>;
  hidden: number;
  onchain?: OnchainView;
  primaryCode: string;
  /** Time used for checks 4 and 5: the shipment's claimedAt, or now. */
  checkedAt?: bigint;
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
  report?: ReportRecord;
  reader: ChainReader;
}

export interface VerifyOptions {
  /** The verifier's own EORI, to confirm the shipment was declared to them (check 5d). */
  importerEORI?: string;
  /** CONTESTED window before a revocation or suspension, in hours (default 24). */
  contestedWindowHours?: number;
  checkers?: EvidenceCheckers;
}

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

export async function verifyPresentation(
  p: Presentation,
  reader: ChainReader,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  const checks: CheckResult[] = [];
  const disclosed: Record<string, string> = {};

  // ---------------------------------------------------------------- 0 structure
  let core: CredentialCore;
  const decoded: { name: string; value: string; salt: string; encoded: string }[] = [];
  const malformed = (detail: string): VerificationResult => ({
    overall: "INVALID",
    checks: [result(0, "fail", "PRESENTATION_MALFORMED", detail)],
    disclosed: {},
    hidden: 0,
    primaryCode: "PRESENTATION_MALFORMED",
  });
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
  checks.push(result(0, "pass"));
  const get = (n: string) => byName.get(n) as string;

  // --------------------------------------------------------------------- 1 SAID
  checks.push(
    verifySaid(p.core)
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

  // Chain reads go out in rounds of parallel requests: everything that depends only on the proof
  // first, then everything that depends on the registered report. A read whose answer may not be
  // needed starts early but is awaited only where the checks use it, in the same order as before,
  // so a failing read is reported exactly as if the reads ran one after another.
  const reportKey = reportKeyOf(core.d);
  const batchKey = p.shipment ? batchKeyOf(reportKey, p.shipment.batchId, get("batchSalt") as Hex) : undefined;
  const expectedScopeKey = reportScopeKeyOf(get("installationId"), get("reportingPeriod"));
  const chainIdP = early(reader.client.getChainId());
  const repP = early(reader.report(reportKey));
  const statusP = batchKey ? early(reader.shipmentStatus(batchKey)) : undefined;
  const latestP = early(reader.latestBlock());
  const remainingP = early(reader.remainingKg(reportKey));
  const expectedScopeP = early(reader.reportScope(expectedScopeKey));

  // ----------------------------------------------------------------- 3 signature
  const chainId = await chainIdP;
  let verifiedKg: bigint | undefined;
  let validUntilSec: bigint | undefined;
  try {
    verifiedKg = tonnesToKg(get("verifiedTonnes"));
    validUntilSec = isoToSeconds(core.validUntil);
    const signer = await recoverIssuer(
      reader.registry,
      {
        credSAID: core.d,
        supplierCommit: supplierCommitOf(get("supplierLEI"), get("idSalt") as Hex),
        verifiedKg,
        validUntil: validUntilSec,
      },
      p.signature,
      chainId,
    );
    checks.push(
      lower(signer) === lower(core.issuer.verifierAddress)
        ? result(3, "pass", "", `signed by ${core.issuer.verifierAddress}`)
        : result(3, "fail", "BAD_SIGNATURE", "signature does not match the issuer in the credential"),
    );
  } catch (e) {
    checks.push(result(3, "fail", "BAD_SIGNATURE", `signature could not be checked: ${(e as Error).message}`));
  }

  // ------------------------------------------------------------- 4 on-chain report
  const onchain: OnchainView = { reportKey };
  const rep = await repP;
  let status: ShipmentStatus | undefined;
  if (statusP) {
    status = await statusP;
    onchain.batchKey = batchKey;
  }
  const atClaim = status !== undefined && status.claimedAt !== 0n && lower(status.reportKey) === lower(reportKey);
  const t = atClaim && status ? status.claimedAt : (await latestP).timestamp;
  let contested = false;

  // Checks 6-8 only need the report and the disclosed fields: start them now, alongside check 4's reads.
  const ctx: EvidenceContext = { core, disclosed, report: rep.registeredAt === 0n ? undefined : rep, reader };
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
      rep.reportScopeKey === expectedScopeKey ? expectedScopeP : early(reader.reportScope(rep.reportScopeKey));
    const supersededByP = rep.supersededBy !== ZERO32 ? early(reader.report(rep.supersededBy)) : undefined;
    const unboundAtP = early(
      scopeP.then((s) =>
        rep.reportIdHash === s.reportIdHash ? 0n : reader.reportIdUnboundAt(rep.reportScopeKey, rep.reportIdHash),
      ),
    );
    const prevP = rep.supersedes !== ZERO32 ? early(reader.report(rep.supersedes)) : undefined;
    const contractValidP = early(reader.isValidAt(reportKey, t));
    // 4l events, searched up to the latest block read above
    const revocationsP = early(
      latestP.then(({ number }) => reader.auditorRevocations(rep.auditorAidHash, rep.issuerLeiHash, number)),
    );
    const suspensionsP = early(latestP.then(({ number }) => reader.suspensions(rep.issuerLeiHash, number)));

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
      atClaim &&
      status?.reportValid === true &&
      (replacedInLayer || scopeMoved) &&
      (!replacedInLayer || supersededAt === t) &&
      (!scopeMoved || unboundAt === t);
    if ((replacedInLayer || scopeMoved) && !sameBlockException) {
      let detail = replacedInLayer
        ? "replaced by a revision in the same credential layer"
        : "the report scope moved to another report (whole-report revision or takeover by another body)";
      const successor = replacedInLayer ? rep.supersededBy : scope.latestReportKey;
      const succ = await reader.report(successor);
      if (succ.issuerLeiHash !== rep.issuerLeiHash) detail += "; issuing body changed";
      fails.push(["REPORT_INVALID/SUPERSEDED", detail]);
    } else if (sameBlockException) {
      notes.push("valid when shipped; replaced later in the same block");
    }
    if (prevP) {
      const prev = await prevP;
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

    if (fails.length) {
      checks.push(result(4, "fail", fails[0][0], fails.map((f) => f[1]).join("; ")));
    } else {
      // 4l revocation window: registered shortly before the auditor was revoked or the body suspended
      const windowSec = BigInt(Math.round((opts.contestedWindowHours ?? 24) * 3600));
      const events = [...(await revocationsP), ...(await suspensionsP)];
      contested = events.some((e) => rep.registeredAt <= e.time && e.time - rep.registeredAt <= windowSec);
      const base = "registered by an authorized auditor (checked by the contract at registration)";
      checks.push(
        contested
          ? result(4, "pass", "CONTESTED", `${base}; revoked or suspended within ${opts.contestedWindowHours ?? 24} h after`)
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
    checks.push(
      problem
        ? result(5, "fail", "SHIPMENT_MISMATCH", problem)
        : result(5, "pass", "", `${p.shipment.quantityTonnes} t declared to you on the shared ledger`),
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

  const failed = checks.filter((x) => x.status === "fail");
  return {
    overall: failed.length ? "INVALID" : contested ? "CONTESTED" : "VALID",
    checks,
    disclosed,
    hidden,
    onchain,
    primaryCode: failed[0]?.code ?? "",
    checkedAt: t,
  };
}
