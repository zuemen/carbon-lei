// Builds the "CBAM Verifier Accreditation Credential (demo)" ACDC schema and writes it with its SAIDs.
// SAIDs are computed with the repo's own sdk/said.ts (label "$id"): the nested a / e / r blocks
// first, the outer schema last. The file is written once with the final key order; do not
// reformat it afterwards, because key order is part of every SAID.
//   node verifier/scripts/build-schema.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSaid } from "../../sdk/said.ts";
import { LE_SCHEMA_SAID } from "../src/constants.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, "../schemas/cbam-verifier-accreditation.json");

export const USAGE_DISCLAIMER =
  "Demo only: this credential is issued by a fictional accreditation body for a hackathon prototype. " +
  "It is not an accreditation under Regulation (EU) 2023/956 or any national accreditation scheme " +
  "and must not be relied on for real CBAM reporting.";

type Json = Record<string, unknown>;

function oneOfBlock(label: string, block: Json): Json {
  return { oneOf: [{ description: `${label} SAID`, type: "string" }, block] };
}

/** The schema with every `$id` left empty, in final key order. */
export function schemaSkeleton(): Json {
  const attributes: Json = {
    $id: "",
    description: "Attributes block",
    type: "object",
    properties: {
      d: { description: "Attributes block SAID", type: "string" },
      i: { description: "Issuee AID (the accredited verification body)", type: "string" },
      dt: { description: "Issuance date time", type: "string", format: "date-time" },
      LEI: { description: "LEI of the accredited verification body", type: "string", format: "ISO 17442" },
      accreditationNumber: { description: "Accreditation certificate number", type: "string" },
      activity: { description: "Accredited activity", type: "string" },
      cnScope: {
        description: "Combined Nomenclature codes covered by the accreditation",
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      validUntil: { description: "End of the accreditation period", type: "string", format: "date-time" },
    },
    additionalProperties: false,
    required: ["i", "dt", "LEI", "accreditationNumber", "activity", "cnScope", "validUntil"],
  };

  const edges: Json = {
    $id: "",
    description: "Edges block",
    type: "object",
    properties: {
      d: { description: "Edges block SAID", type: "string" },
      nab: {
        description: "Accreditation body node: the Legal Entity vLEI credential held by the issuer",
        type: "object",
        properties: {
          n: { description: "SAID of the accreditation body's LE credential", type: "string" },
          s: {
            description: "SAID of required schema of the credential pointed to by this node",
            type: "string",
            const: LE_SCHEMA_SAID,
          },
        },
        additionalProperties: false,
        required: ["n", "s"],
      },
    },
    additionalProperties: false,
    required: ["d", "nab"],
  };

  const rules: Json = {
    $id: "",
    description: "Rules block",
    type: "object",
    properties: {
      d: { description: "Rules block SAID", type: "string" },
      usageDisclaimer: {
        description: "Usage Disclaimer",
        type: "object",
        properties: {
          l: { description: "Associated legal language", type: "string", const: USAGE_DISCLAIMER },
        },
      },
    },
    additionalProperties: false,
    required: ["d", "usageDisclaimer"],
  };

  return {
    $id: "",
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "CBAM Verifier Accreditation Credential (demo)",
    description:
      "Demo credential issued by an accreditation body (holder of an LE vLEI) to a CBAM verification body, " +
      "stating the accredited activity and the CN codes in scope.",
    type: "object",
    credentialType: "CBAMVerifierAccreditationCredential",
    version: "1.0.0",
    properties: {
      v: { description: "Version", type: "string" },
      d: { description: "Credential SAID", type: "string" },
      u: { description: "One time use nonce", type: "string" },
      i: { description: "Accreditation body issuer AID", type: "string" },
      ri: { description: "Credential status registry", type: "string" },
      s: { description: "Schema SAID", type: "string" },
      a: oneOfBlock("Attributes block", attributes),
      e: oneOfBlock("Edges block", edges),
      r: oneOfBlock("Rules block", rules),
    },
    additionalProperties: false,
    required: ["i", "ri", "s", "d", "e", "r"],
  };
}

/** Fills the nested `$id`s first, then the outer one. Mutates and returns the skeleton. */
export function buildSchema(): Json {
  const schema = schemaSkeleton();
  const props = schema.properties as Record<string, { oneOf: Json[] }>;
  for (const key of ["a", "e", "r"]) {
    const block = props[key].oneOf[1];
    block.$id = computeSaid(block, "$id");
  }
  schema.$id = computeSaid(schema, "$id");
  return schema;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const schema = buildSchema();
  // Cross-check against signify-ts (the library KERIA clients use) before writing.
  const { Saider } = await import("signify-ts");
  const [, check] = Saider.saidify(structuredClone(schema), undefined, undefined, "$id");
  if (check.$id !== schema.$id) throw new Error(`SAID mismatch: sdk ${schema.$id} vs signify-ts ${check.$id}`);
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2) + "\n");
  console.log(`schema SAID ${schema.$id}`);
  console.log(`written ${SCHEMA_PATH}`);
}
