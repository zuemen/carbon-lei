// A Communication Template draft signed with a key made on the spot (sdk/selfissue.ts): which checks it passes,
// offline and against a local anvil chain where nothing was registered for it.
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkNormalForms, METHODOLOGY_NOTE, REQUIRED_DISCLOSURES } from "../credential.ts";
import { reportInputOf } from "../issue.ts";
import { selfIssueDraft, selfIssuedClaims, SELF_ISSUED_LABEL, type SelfIssued } from "../selfissue.ts";
import { draftCredentialFields, parseTemplate, type CredentialDraft } from "../template.ts";
import { vleiCheckers } from "../checkers.ts";
import { verifyOffline, verifyPresentation } from "../verify.ts";
import { startLocalChain, type LocalChain } from "./helpers/local-chain.ts";

const SCREWS = new URL("../../fixtures/cbam-template/CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx", import.meta.url);
const status = (r: { checks: { index: number; status: string; code: string }[] }) =>
  Object.fromEntries(r.checks.map((x) => [x.index, `${x.status}:${x.code}`]));

let draft: CredentialDraft;
let c: LocalChain;
let issued: SelfIssued;
const key = privateKeyToAccount(generatePrivateKey());

beforeAll(async () => {
  draft = draftCredentialFields(await parseTemplate(new Uint8Array(readFileSync(SCREWS))), 0);
  c = await startLocalChain(19545 + Math.floor(Math.random() * 1000));
  issued = await selfIssueDraft(draft, {
    signer: key,
    registry: c.deployment.contracts.EmissionsClaimRegistry.address,
    chainId: 31337,
  });
}, 60_000);

afterAll(() => c?.stop());

describe("self-issued demo proof from the Commission's example", () => {
  it("keeps every template value, fills only the fields the template cannot, in normal form", () => {
    const { claims, fields } = selfIssuedClaims(draft, new Date("2026-10-08T09:30:15.250Z"));
    for (const [k, v] of Object.entries(draft.fields)) expect(claims[k as keyof typeof claims]).toBe(v);
    expect(claims.specificEmbeddedEmissions_tCO2e_per_t).toBe("2.00694");
    expect(fields.filter((f) => f.from === "placeholder").map((f) => f.field).sort()).toEqual(draft.toBeSupplied.map((s) => s.field).sort());
    expect(fields.filter((f) => f.from === "issuance").map((f) => f.field).sort()).toEqual([...draft.setAtIssuance].sort());
    expect(claims.methodologyNote).toBe(METHODOLOGY_NOTE);
    expect(claims.issuedAt).toBe("2026-10-08T09:30:15Z");
    expect(claims.validUntil).toBe("2026-11-07T09:30:15Z");
    expect(claims.supplierLEI.startsWith("ZZZZ")).toBe(true);
    expect(claims.verifierLEI.startsWith("ZZZZ")).toBe(true);
    expect(checkNormalForms(claims)).toEqual([]);
    expect(SELF_ISSUED_LABEL).toBe("demo key generated in this page; not a verification body; not registered on Sepolia");
  });

  it("offline: checks 0–3 pass (the demo key's own signature), 4–8 are not run, never VALID", async () => {
    expect(issued.proof.shipment).toBeUndefined();
    const names = issued.proof.disclosures.length;
    expect(names).toBeGreaterThanOrEqual(REQUIRED_DISCLOSURES.length);
    const r = await verifyOffline(issued.proof, { registry: c.deployment.contracts.EmissionsClaimRegistry.address, chainId: 31337 });
    expect(status(r)).toEqual({ 0: "pass:", 1: "pass:", 2: "pass:", 3: "pass:", 4: "skipped:", 5: "skipped:", 6: "skipped:", 7: "skipped:", 8: "skipped:" });
    expect(r.checks[3].detail).toBe(`signed by ${key.address}`);
    expect(r.overall).toBe("INCOMPLETE");
  });

  it("against the chain: not registered (4), nothing claimed (5), no KEL anchor (6), no vLEI chain (7): INVALID", async () => {
    const before = await c.pub.getBlockNumber();
    const r = await verifyPresentation(issued.proof, c.reader, {
      checkers: vleiCheckers({ loadBundle: async () => Promise.reject(new Error("no bundle")) }),
      maxHeadAgeSec: Infinity,
    });
    expect(status(r)).toEqual({
      0: "pass:",
      1: "pass:",
      2: "pass:",
      3: "pass:",
      4: "fail:REPORT_INVALID/NOT_REGISTERED",
      5: "skipped:",
      6: "fail:ANCHOR_NOT_FOUND",
      7: "fail:AUTHORITY_INVALID",
      8: "skipped:",
    });
    expect(r.checks[5].detail).toBe("no shipment in this proof");
    expect(r.overall).toBe("INVALID");
    expect(await c.pub.getBlockNumber()).toBe(before);
  });

  it("a registration from the demo key, as a dry run, is refused by the allowlist (NotActiveVerifier); no block is mined", async () => {
    const before = await c.pub.getBlockNumber();
    const input = reportInputOf(issued.credential, { supplier: key.address, kelSeq: 0n });
    const d = await c.reader.dryRun("registerReport", [input], key.address);
    expect(d).toMatchObject({ reverted: true, errorName: "NotActiveVerifier" });
    expect(await c.pub.getBlockNumber()).toBe(before);
  });
});
