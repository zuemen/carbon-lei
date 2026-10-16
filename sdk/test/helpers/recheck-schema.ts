// Validator for docs/schemas/recheck.schema.json (the output of `carbonlei recheck --json`, POST /v1/recheck and
// `recheckRecords` in sdk/recheck.ts). The nested verdict refers to verdict.schema.json, added under its $id.
import { readFileSync } from "node:fs";
import Ajv2020Module from "ajv/dist/2020.js";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../docs/schemas/${name}`, import.meta.url), "utf8"));
// ajv's CommonJS default export is wrapped differently by Node and by vitest.
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module;
const ajv = new (Ajv2020 as unknown as new (o: object) => any)({ strict: true, allErrors: true });
ajv.addSchema(read("verdict.schema.json"));
const validate = ajv.compile(read("recheck.schema.json"));

/** The schema errors of `x` ([] when it conforms). */
export function recheckSchemaErrors(x: unknown): string[] {
  return validate(x) ? [] : (validate.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message}`);
}
