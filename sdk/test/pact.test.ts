// PACT v3.0.3 export validated against the official openapi.yaml (ProductFootprint).
// The specification file is downloaded from the PACT repository at tag v3.0.3 and cached
// in .cache/ (it is not redistributed in this repository).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { reportKeyOf } from "../commitment.ts";
import { decodeDisclosure } from "../disclosure.ts";
import { DEMO_DISCLOSURE } from "../issue.ts";
import type { ChainReader, ReportRecord } from "../chain.ts";
import type { Presentation } from "../disclosure.ts";
import { exclusiveEnd, exportPact, exportPactFromProof, pactIdOf, type PactContext } from "../pact.ts";
import type { VerificationResult } from "../verify.ts";

const SPEC_URL = "https://raw.githubusercontent.com/wbcsd/data-exchange-protocol/v3.0.3/spec/v3/openapi.yaml";
const CACHE = new URL("../../.cache/pact-openapi-3.0.3.yaml", import.meta.url);

const v = JSON.parse(readFileSync(new URL("../../fixtures/vectors.json", import.meta.url), "utf8"));
const demo = JSON.parse(readFileSync(new URL("../../fixtures/demo.json", import.meta.url), "utf8"));

const disclosed: Record<string, string> = {};
for (const name of DEMO_DISCLOSURE) disclosed[name] = decodeDisclosure(v.disclosures[name]).value;

const ctx = (over: Partial<PactContext> = {}): PactContext => ({
  disclosed,
  credSAID: v.V7.d,
  auditorAID: v.inputs.auditorAID,
  verifierLEI: v.inputs.verifierLEI,
  reportKey: reportKeyOf(v.V7.d),
  kelSeq: 3n,
  registry: "0x72152A40f91C4357Ed53635C3fd3C41D023D78ba",
  chainId: 11155111,
  onchain: { revoked: false, replaced: false },
  companyName: demo.entities.supplier.name,
  productNameCompany: demo.product.productNameCompany,
  productDescription: `${demo.product.description} — CBAM direct embedded emissions only, not a full PCF (illustrative)`,
  productId: "hex-bolt-m10",
  verifierName: demo.entities.verifier.name,
  extensionSchemaUrl: "https://zuemen.github.io/carbon-lei/schemas/carbonlei-extension-0.1.0.json",
  documentationUrl: "https://github.com/zuemen/carbon-lei/blob/main/docs/PACT_MAPPING.md",
  created: "2026-10-05T00:00:00Z",
  ...over,
});

let validate: (x: unknown) => boolean;
let errors: () => unknown;

beforeAll(async () => {
  if (!existsSync(CACHE)) {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`cannot download the PACT specification: HTTP ${res.status}`);
    mkdirSync(new URL("./", CACHE), { recursive: true });
    writeFileSync(CACHE, await res.text());
  }
  const spec = parse(readFileSync(CACHE, "utf8"));
  // Only ProductFootprint and the definitions it references (some unrelated event schemas in the
  // file are not valid JSON Schema).
  const all = spec.components.schemas as Record<string, unknown>;
  const defs: Record<string, unknown> = {};
  const queue = ["ProductFootprint"];
  while (queue.length) {
    const name = queue.pop() as string;
    if (defs[name]) continue;
    const text = JSON.stringify(all[name]);
    defs[name] = JSON.parse(text.replaceAll("#/components/schemas/", "#/$defs/"));
    for (const m of text.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)) queue.push(m[1]);
  }
  // CommonJS packages under NodeNext: the class and the plugin sit on `.default`.
  const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module;
  const addFormats = (addFormatsModule as unknown as { default: typeof addFormatsModule }).default ?? addFormatsModule;
  const ajv = new (Ajv2020 as unknown as new (o: object) => any)({ strict: false, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  ajv.addSchema({ $id: "https://pact.local/openapi.json", $defs: defs });
  const fn = ajv.compile({ $ref: "https://pact.local/openapi.json#/$defs/ProductFootprint" });
  validate = (x) => fn(x) as boolean;
  errors = () => fn.errors;
}, 60_000);

describe("PACT v3.0.3 export (S8)", () => {
  it("validates against the official ProductFootprint schema", () => {
    const pf = exportPact(ctx());
    const ok = validate(pf);
    if (!ok) console.log(JSON.stringify(errors(), null, 2));
    expect(ok).toBe(true);
  });

  it("states the boundary and uses urn:lei, string decimals and an exclusive period end", () => {
    const pf = exportPact(ctx()) as Record<string, any>;
    expect(pf.companyIds).toEqual([`urn:lei:${v.inputs.supplierLEI}`]);
    expect(pf.comment).toContain("illustrative — not official CBAM methodology");
    expect(pf.comment).toContain("not a full PCF");
    expect(pf.pcf.boundaryProcessesDescription).toContain("not a full product carbon footprint");
    expect(pf.pcf.pcfExcludingBiogenicUptake).toBe("1.8");
    expect(pf.pcf.declaredUnitAmount).toBe("1");
    expect(pf.pcf.referencePeriodStart).toBe("2026-01-01T00:00:00Z");
    expect(pf.pcf.referencePeriodEnd).toBe("2027-01-01T00:00:00Z");
    expect(pf.pcf.geographyCountry).toBe("TW");
    expect(pf.productClassifications).toEqual(["urn:pact:ec.europa.eu:cn:7318"]);
    expect(pf.extensions[0].data.cbam.boundary).toBe("direct embedded emissions");
    expect(pf.extensions[0].data.carbonlei.kelSeq).toBe("3");
    expect(pf.extensions[0].data.carbonlei.registry.chainId).toBe(11155111);
  });

  it("never exports hidden fields", () => {
    const text = JSON.stringify(exportPact(ctx()));
    for (const hidden of ["productionRoute", "energyMix", "supplierCost"]) {
      expect(text).not.toContain(hidden);
      expect(text).not.toContain(decodeDisclosure(v.disclosures[hidden]).value);
    }
  });

  it("id is deterministic per credential; revisions in the same layer list the previous id", () => {
    expect(exportPact(ctx()).id).toBe(pactIdOf(reportKeyOf(v.V7.d)));
    expect(pactIdOf(reportKeyOf(v.V7.d))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const prev = v.V17.reportIdHash;
    const same = exportPact(ctx({ onchain: { revoked: false, replaced: false, supersedes: prev, supersedesSameLayer: true } }));
    expect(same.precedingPfIds).toEqual([pactIdOf(prev)]);
    const takeover = exportPact(ctx({ onchain: { revoked: false, replaced: false, supersedes: prev, supersedesSameLayer: false } }));
    expect(takeover.precedingPfIds).toBeUndefined();
    expect(validate(same)).toBe(true);
  });

  it("status: replaced → Deprecated; revoked → not exported; offline → Active with a note", () => {
    expect(exportPact(ctx({ onchain: { revoked: false, replaced: true } })).status).toBe("Deprecated");
    expect(() => exportPact(ctx({ onchain: { revoked: true, replaced: false } }))).toThrow(/revoked/);
    const offline = exportPact(ctx({ onchain: undefined }));
    expect(offline.status).toBe("Active");
    expect(offline.comment).toContain("on-chain status not checked");
  });

  it("exclusive end handles month and year ends", () => {
    expect(exclusiveEnd("2026-12-31")).toBe("2027-01-01T00:00:00Z");
    expect(exclusiveEnd("2028-02-28")).toBe("2028-02-29T00:00:00Z");
  });

  it("exportPactFromProof (CLI and hosted demo): same export from a verified proof and the on-chain record", async () => {
    const zero = `0x${"0".repeat(64)}` as const;
    const rec = (over: Partial<ReportRecord> = {}) =>
      ({ kelSeq: 3n, registeredAt: 1n, revokedAt: 0n, supersedes: zero, credScopeKey: zero, ...over }) as ReportRecord;
    const rd = (r: ReportRecord) =>
      ({ report: async () => r, registry: ctx().registry, client: { getChainId: async () => 11155111 } }) as unknown as ChainReader;
    const proof = {
      core: JSON.stringify({ d: v.V7.d, issuer: { auditorAID: v.inputs.auditorAID, verifierLEI: v.inputs.verifierLEI } }),
    } as Presentation;
    const checks = [1, 2, 3, 4, 5].map((index) => ({ index, name: "", status: "pass" as const, code: "", detail: "" }));
    const result = { overall: "VALID", checks, disclosed, hidden: 0, primaryCode: "" } as VerificationResult;
    const c = ctx();
    const product = {
      companyName: c.companyName,
      productNameCompany: c.productNameCompany,
      productDescription: c.productDescription,
      productId: c.productId,
      verifierName: c.verifierName,
      created: c.created,
    };
    const pf = await exportPactFromProof(proof, result, rd(rec()), product);
    expect(pf).toEqual(exportPact(c));
    expect(validate(pf)).toBe(true);
    await expect(exportPactFromProof(proof, result, rd(rec({ revokedAt: 5n })), product)).rejects.toThrow(/revoked/);
    const failed = { ...result, checks: checks.map((x) => (x.index === 2 ? { ...x, status: "fail" as const } : x)) };
    await expect(exportPactFromProof(proof, failed as VerificationResult, rd(rec()), product)).rejects.toThrow(/nothing exported/);
  });
});
