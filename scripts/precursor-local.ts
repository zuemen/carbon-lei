// Precursor demo data (local anvil only): starts its own anvil, deploys the contracts, runs the precursor scenario of
// scripts/precursor-scenario.ts (wire-rod mill → screw maker → EU importer), tries a second screw maker's claim on the
// same wire rod, verifies both screw proofs with check 9, and writes demo/public/precursor-data.json for the hosted
// page's "Precursor (wire rod)" sections. Nothing is sent to Sepolia; the file says so. Needs Foundry (anvil) and
// `forge build` output in contracts/out.
//
// Usage: node scripts/precursor-local.ts [--port 8547] [--out demo/public/precursor-data.json]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BaseError, ContractFunctionRevertedError, type TransactionReceipt } from "viem";
import { vleiCheckers } from "../sdk/checkers.ts";
import { reportKeyOf } from "../sdk/commitment.ts";
import { newSalt } from "../sdk/encoding.ts";
import { claimArgsOf } from "../sdk/issue.ts";
import type { PrecursorEvidence } from "../sdk/precursor.ts";
import { verifyPresentation } from "../sdk/verify.ts";
import { send, startLocalChain } from "../sdk/test/helpers/local-chain.ts";
import { IMPORTER_EORI, PC, SCREW_LEI, demo, issueAs, millClaims, proofOf, register, screwClaims, setupWorld, statementOf, wireRodLine } from "./precursor-scenario.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PRECURSOR_DATA_LABEL =
  "Built on a local anvil chain (chain ID 31337) by scripts/precursor-local.ts, not on Sepolia. vLEI evidence of both tiers is synthetic (deterministic test keys, no KERIA) under a synthetic test root. All companies fictional; emissions values illustrative.";

const toJson = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";

async function main() {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8547" }, out: { type: "string", default: "demo/public/precursor-data.json" } } });
  const c = await startLocalChain(Number(values.port));
  try {
    const txs: { step: string; label: string; hash: string; block: number; time: string; result: "success" | "reverted" }[] = [];
    const log = async (step: string, label: string, p: Promise<TransactionReceipt>) => {
      const r = await p;
      const b = await c.pub.getBlock({ blockNumber: r.blockNumber });
      txs.push({ step, label, hash: r.transactionHash, block: Number(r.blockNumber), time: new Date(Number(b.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), result: r.status });
      return r;
    };
    const w = await setupWorld(c);

    const mill = await issueAs(w, "mill", millClaims());
    const st = statementOf([wireRodLine(mill, PC.delivery.batchId)]);
    const screw = await issueAs(w, "screw", screwClaims(), { statement: st });
    const sB = statementOf([wireRodLine(mill, PC.secondScrewMaker.batchId, "1.25")]);
    const second = await issueAs(
      w,
      "screw",
      screwClaims({
        supplierLEI: PC.secondScrewMaker.lei,
        operatorId: `TW${PC.secondScrewMaker.lei}`,
        installationId: PC.secondScrewMaker.installation.id,
        installationName: PC.secondScrewMaker.installation.name,
        verificationReportId: "VR-DEMO-SW-0001",
        verifiedTonnes: "400",
        specificEmbeddedEmissions_tCO2e_per_t: "1.98",
      }),
      { statement: sB },
    );

    await log("registerMill", "Mill report registered by the mill's verification body (1000 t of wire rod at 1.44 tCO2e/t)", register(w, "mill", mill, w.millSupplier));
    await log("registerScrew", "Screw report registered, with the precursor statement's digest in its signed core (500 t at 1.8 tCO2e/t)", register(w, "screw", screw, w.screwSupplier));
    await log("registerSecond", "Second screw maker's report registered (400 t, 1.25 t of wire rod per t)", register(w, "screw", second, w.secondSupplier));
    const shipA = { batchId: PC.delivery.batchId, quantityTonnes: PC.delivery.quantityTonnes, shipmentDate: PC.delivery.shipmentDate, importerSalt: newSalt() };
    await log(
      "claimWireRod",
      `Mill claims ${PC.delivery.quantityTonnes} t of wire rod for the screw maker on its report (importerCommit = the screw maker's LEI)`,
      send(c, w.millSupplier, "registry", "claimShipment", claimArgsOf(mill, { ...shipA, importerEORI: SCREW_LEI })),
    );
    const shipment = { batchId: demo.shipments[0].batchId, quantityTonnes: demo.shipments[0].quantityTonnes, shipmentDate: demo.shipments[0].shipmentDate, importerSalt: newSalt() };
    await log("claimScrews", `Screw maker claims ${shipment.quantityTonnes} t of screws for the EU importer`, send(c, w.screwSupplier, "registry", "claimShipment", claimArgsOf(screw, { ...shipment, importerEORI: IMPORTER_EORI })));

    // The second maker's 500 t of the same wire rod: more than the 437.5 t left (eth_call; the transaction is not sent).
    const shipB = { batchId: PC.secondScrewMaker.batchId, quantityTonnes: PC.secondScrewMaker.quantityTonnes, shipmentDate: "2026-07-15", importerSalt: newSalt() };
    const argsB = claimArgsOf(mill, { ...shipB, importerEORI: PC.secondScrewMaker.lei });
    let secondRevert: { errorName: string; args: string[] } | null = null;
    try {
      await send(c, w.millSupplier, "registry", "claimShipment", argsB);
    } catch (e) {
      const r = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
      secondRevert = { errorName: r?.data?.errorName ?? "unknown", args: (r?.data?.args ?? []).map(String) };
    }
    if (secondRevert?.errorName !== "ExceedsVerifiedTonnage") throw new Error(`expected ExceedsVerifiedTonnage, got ${JSON.stringify(secondRevert)}`);

    const checkers = vleiCheckers({ trustAnchor: w.chain.trustAnchor });
    const evidence: PrecursorEvidence = { statement: st, proofs: [proofOf(w, "mill", mill, { shipment: shipA })] };
    const goodProof = proofOf(w, "screw", screw, { shipment, precursorEvidence: evidence });
    const verification = await verifyPresentation(goodProof, c.reader, { importerEORI: IMPORTER_EORI, checkers });
    const secondProof = proofOf(w, "screw", second, { precursorEvidence: { statement: sB, proofs: [proofOf(w, "mill", mill, { shipment: shipB })] } });
    const secondVerification = await verifyPresentation(secondProof, c.reader, { checkers });
    if (verification.overall !== "VALID") throw new Error(`the screw proof is ${verification.overall} (${verification.primaryCode})`);
    if (secondVerification.overall !== "INVALID") throw new Error(`the second maker's proof is ${secondVerification.overall}`);

    const b = w.chain.bodies;
    const data = {
      version: 1,
      mode: "local",
      label: PRECURSOR_DATA_LABEL,
      chainId: 31337,
      deployment: { registry: w.registry, allowlist: c.deployment.contracts.VerifierAllowlist.address },
      trustAnchor: w.chain.trustAnchor,
      entities: {
        root: PC.root,
        qvi: PC.qvi,
        nab: PC.nab,
        mill: { name: PC.mill.name, lei: PC.mill.lei, installation: PC.mill.installations[0] },
        millBody: { name: b.mill.name, lei: b.mill.lei, aid: b.mill.bodyAid, accreditationNumber: PC.body.accreditationNumber, cnScope: PC.body.cnScope, leSaid: b.mill.saids.leBody, accreditationSaid: b.mill.saids.accreditation },
        millAuditor: { name: b.mill.auditorName, role: PC.auditor.role, aid: b.mill.auditorAid, ecrSaid: b.mill.saids.ecr },
        screwBody: { name: b.screw.name, lei: b.screw.lei, aid: b.screw.bodyAid },
        screwAuditor: { name: b.screw.auditorName, aid: b.screw.auditorAid },
        secondScrewMaker: { name: PC.secondScrewMaker.name, lei: PC.secondScrewMaker.lei },
        screwMaker: { name: demo.entities.supplier.name, lei: demo.entities.supplier.lei },
      },
      statement: st,
      statementNote: PC.statement.note,
      good: { proof: goodProof, reportKey: reportKeyOf(screw.core.d), kelSeq: "1" },
      mill: { credSAID: mill.core.d, reportKey: reportKeyOf(mill.core.d), verifiedTonnes: PC.report.verifiedTonnes, remainingKg: (await c.reader.remainingKg(reportKeyOf(mill.core.d))).toString() },
      verification,
      secondMaker: {
        claim: { quantityTonnes: shipB.quantityTonnes, batchId: shipB.batchId, revert: secondRevert, args: argsB },
        verification: secondVerification,
      },
      txs,
    };
    const out = resolve(ROOT, values.out!);
    writeFileSync(out, toJson(data));
    console.log(`wrote ${out}`);
    console.log(`screw proof: ${verification.overall}; check 9 ${verification.checks[9]?.status}; ${verification.precursors?.attributedDirect} + ${verification.precursors?.precursorTotal} = ${verification.precursors?.recomputed}`);
    console.log(`second maker: claim reverted with ${secondRevert.errorName}(${secondRevert.args.join(", ")}); proof ${secondVerification.overall} (${secondVerification.primaryCode})`);
  } finally {
    c.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
