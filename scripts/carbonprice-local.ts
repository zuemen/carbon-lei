// Carbon price demo data (check 10, DRAFT CBAM Art 9 rules — not adopted, illustrative; local anvil only): starts its
// own anvil, deploys the contracts, runs the precursor scenario (wire-rod mill → screw maker → EU importer) with the
// carbon price scenario on top (scripts/carbonprice-scenario.ts): the certifier registers the mill's Taiwan carbon fee
// statement, the mill claims the wire rod it delivered to the screw maker against it, and the screw proof is verified
// with checks 0–10. Then tries the double use: a second claim of the statement beyond the tonnes it covers (eth_call
// revert, ExceedsVerifiedTonnage) and the same statement presented for a second maker without a claim (check 10 fails).
// Writes demo/public/carbonprice-data.json for the hosted page. Nothing is sent to Sepolia; the file says so. Needs
// Foundry (anvil) and `forge build` output in contracts/out.
//
// Usage: node scripts/carbonprice-local.ts [--port 8548] [--out demo/public/carbonprice-data.json]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BaseError, ContractFunctionRevertedError, type TransactionReceipt } from "viem";
import { DRAFT_LABEL, DRAFT_REF, PINNED_FX, art9Reduction, carbonPriceKeys } from "../sdk/carbonprice.ts";
import { vleiCheckers } from "../sdk/checkers.ts";
import { reportKeyOf } from "../sdk/commitment.ts";
import { newSalt } from "../sdk/encoding.ts";
import { claimArgsOf } from "../sdk/issue.ts";
import type { PrecursorEvidence } from "../sdk/precursor.ts";
import { verifyPresentation } from "../sdk/verify.ts";
import { send, startLocalChain } from "../sdk/test/helpers/local-chain.ts";
import { IMPORTER_EORI, PC, SCREW_LEI, demo, issueAs, millClaims, proofOf, register, screwClaims, statementOf, wireRodLine } from "./precursor-scenario.ts";
import { CP, claimAgainst, evidenceFor, millOverrides, registerStatement, setupCarbonWorld, statementFor } from "./carbonprice-scenario.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CARBONPRICE_DATA_LABEL = `${DRAFT_LABEL}. Built on a local anvil chain (chain ID 31337) by scripts/carbonprice-local.ts, not on Sepolia. vLEI evidence of the mill's body and of the certifier is synthetic (deterministic test keys, no KERIA) under the synthetic precursor root. All companies and people fictional; installation and emissions figures invented; the Taiwan fee rules and the exchange rate are real (sources in fixtures/carbonprice.json).`;

const toJson = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";

async function main() {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8548" }, out: { type: "string", default: "demo/public/carbonprice-data.json" } } });
  const c = await startLocalChain(Number(values.port));
  try {
    const txs: { step: string; label: string; hash: string; block: number; time: string; result: "success" | "reverted" }[] = [];
    const log = async (step: string, label: string, p: Promise<TransactionReceipt>) => {
      const r = await p;
      const b = await c.pub.getBlock({ blockNumber: r.blockNumber });
      txs.push({ step, label, hash: r.transactionHash, block: Number(r.blockNumber), time: new Date(Number(b.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), result: r.status });
      return r;
    };
    const w = await setupCarbonWorld(c);
    const mill = await issueAs(w, "mill", millClaims(millOverrides));
    const pst = statementOf([wireRodLine(mill, PC.delivery.batchId)]);
    const screw = await issueAs(w, "screw", screwClaims(), { statement: pst });
    await log("registerMill", "Mill report registered by the mill's verification body (1000 t of wire rod at 1.44 tCO2e/t)", register(w, "mill", mill, w.millSupplier));
    await log("registerScrew", "Screw report registered, with the precursor statement's digest in its signed core (500 t at 1.8 tCO2e/t)", register(w, "screw", screw, w.screwSupplier));
    const shipA = { batchId: PC.delivery.batchId, quantityTonnes: PC.delivery.quantityTonnes, shipmentDate: PC.delivery.shipmentDate, importerSalt: newSalt() };
    await log("claimWireRod", `Mill claims ${PC.delivery.quantityTonnes} t of wire rod for the screw maker on its report`, send(c, w.millSupplier, "registry", "claimShipment", claimArgsOf(mill, { ...shipA, importerEORI: SCREW_LEI })));
    const shipment = { batchId: demo.shipments[0].batchId, quantityTonnes: demo.shipments[0].quantityTonnes, shipmentDate: demo.shipments[0].shipmentDate, importerSalt: newSalt() };
    await log("claimScrews", `Screw maker claims ${shipment.quantityTonnes} t of screws for the EU importer`, send(c, w.screwSupplier, "registry", "claimShipment", claimArgsOf(screw, { ...shipment, importerEORI: IMPORTER_EORI })));

    // ---- carbon price: certified statement, registered by the certifier body; the mill's claim for the screw maker
    const st = statementFor(w, mill);
    await log("registerStatement", `Certifier registers the mill's carbon price statement (draft rules; ${st.productionTonnes} t of wire rod produced in the period are claimable against it)`, registerStatement(w, st));
    const ca = await claimAgainst(w, st, { batchId: "CP-DEMO-2026-0001", quantityTonnes: PC.delivery.quantityTonnes, beneficiary: SCREW_LEI });
    await log("claimStatement", `Mill claims ${PC.delivery.quantityTonnes} t of wire rod against the statement for the screw maker (importerCommit = its LEI)`, Promise.resolve(ca.receipt));
    const claim = ca.claim;
    const evidence = await evidenceFor(w, st, claim);

    const checkers = vleiCheckers({ trustAnchor: w.chain.trustAnchor });
    const pev: PrecursorEvidence = { statement: pst, proofs: [proofOf(w, "mill", mill, { shipment: shipA })] };
    const goodProof = { ...proofOf(w, "screw", screw, { shipment, precursorEvidence: pev }), carbonPriceEvidence: evidence };
    const verification = await verifyPresentation(goodProof, c.reader, { importerEORI: IMPORTER_EORI, checkers });
    const c10 = verification.checks.find((x) => x.index === 10);
    if (verification.overall !== "VALID" || !c10 || (c10.status !== "pass" && c10.status !== "warn")) {
      throw new Error(`the screw proof is ${verification.overall} (${verification.primaryCode}); check 10 ${c10?.status} ${c10?.code} ${c10?.detail}`);
    }

    // ---- double use: claim more than the statement covers (eth_call; not sent)
    const remaining = await c.reader.remainingKg(carbonPriceKeys(st).reportKey);
    const overTonnes = (remaining / 1000n + 1n).toString();
    let overRevert: { errorName: string; args: string[] } | null = null;
    try {
      await claimAgainst(w, st, { batchId: "CP-DEMO-2026-0002", quantityTonnes: overTonnes, beneficiary: PC.secondScrewMaker.lei });
    } catch (e) {
      const r = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
      overRevert = { errorName: r?.data?.errorName ?? "unknown", args: (r?.data?.args ?? []).map(String) };
    }
    if (overRevert?.errorName !== "ExceedsVerifiedTonnage") throw new Error(`expected ExceedsVerifiedTonnage, got ${JSON.stringify(overRevert)}`);
    // ---- the same evidence reused by a second maker's proof, without a claim for that maker: check 10 fails
    const reused = { ...goodProof, carbonPriceEvidence: { ...evidence, claim: { ...evidence.claim, beneficiarySalt: newSalt() } } };
    const reusedVerification = await verifyPresentation(reused, c.reader, { importerEORI: IMPORTER_EORI, checkers });
    if (reusedVerification.overall !== "INVALID") throw new Error(`the reused statement gives ${reusedVerification.overall}`);

    const cp = verification.carbonPrice!;
    const q = shipment.quantityTonnes;
    const obligationT = (Number(q) * Number(verification.disclosed.specificEmbeddedEmissions_tCO2e_per_t)).toFixed(3);
    const reduction = art9Reduction(cp.deductibleEurPerTonneGood!, CP.refPriceEur, q, obligationT);
    const cert = w.chain.certifier!;
    const data = {
      version: 1,
      mode: "local",
      draft: DRAFT_LABEL,
      draftRef: DRAFT_REF,
      label: CARBONPRICE_DATA_LABEL,
      chainId: 31337,
      deployment: { registry: w.registry, allowlist: c.deployment.contracts.VerifierAllowlist.address },
      trustAnchor: w.chain.trustAnchor,
      entities: {
        mill: { name: PC.mill.name, lei: PC.mill.lei, installation: PC.mill.installations[0] },
        screwMaker: { name: demo.entities.supplier.name, lei: demo.entities.supplier.lei },
        secondScrewMaker: { name: PC.secondScrewMaker.name, lei: PC.secondScrewMaker.lei },
        root: PC.root,
        qvi: PC.qvi,
        nab: PC.nab,
        certifierBody: { name: cert.name, lei: cert.lei, aid: cert.bodyAid, accreditationNumber: CP.certifier.accreditationNumber, cnScope: CP.certifier.cnScope, leSaid: cert.saids.leBody, accreditationSaid: cert.saids.accreditation },
        certifierAuditor: { name: cert.auditorName, role: CP.certifier.auditor.role, aid: cert.auditorAid, ecrSaid: cert.saids.ecr },
      },
      statement: st,
      /** The evidence as the screw maker presents it (the page re-checks its off-chain parts). */
      evidence,
      statementKey: carbonPriceKeys(st).reportKey,
      fx: PINNED_FX.find((r) => r.currency === st.currency && r.year === st.fx.year),
      shipment: { quantityTonnes: q, see: verification.disclosed.specificEmbeddedEmissions_tCO2e_per_t, obligationT },
      refPriceEur: CP.refPriceEur,
      refPriceNote: CP.refPriceNote,
      reductionCertificates: reduction,
      verification: { overall: verification.overall, primaryCode: verification.primaryCode, checks: verification.checks, carbonPrice: cp, precursors: verification.precursors },
      doubleUse: {
        overClaim: { quantityTonnes: overTonnes, remainingKg: remaining.toString(), revert: overRevert },
        reused: { overall: reusedVerification.overall, primaryCode: reusedVerification.primaryCode, check10: reusedVerification.checks.find((x) => x.index === 10) },
      },
      mill: { credSAID: mill.core.d, reportKey: reportKeyOf(mill.core.d) },
      sources: CP.sources,
      txs,
    };
    const out = resolve(ROOT, values.out!);
    writeFileSync(out, toJson(data));
    console.log(`wrote ${out}`);
    console.log(`screw proof: ${verification.overall}; check 10 ${c10.status} ${c10.code}`);
    for (const s of cp.steps) console.log(`  ${s}`);
    console.log(`  ${q} t × €${cp.deductibleEurPerTonneGood}/t ÷ €${CP.refPriceEur} = ${reduction} certificates (of ${obligationT} tCO2e)`);
    console.log(`double use: over-claim ${overRevert.errorName}(${overRevert.args.join(", ")}); reused statement ${reusedVerification.overall} (${reusedVerification.primaryCode})`);
  } finally {
    c.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
