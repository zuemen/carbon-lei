// Validator for docs/schemas/portfolio.schema.json (the output of `carbonlei portfolio --json` and of
// `buildPortfolio` in sdk/portfolio.ts), with the same ajv setup as verdict-schema.ts.
import { readFileSync } from "node:fs";
import Ajv2020Module from "ajv/dist/2020.js";

const schema = JSON.parse(readFileSync(new URL("../../../docs/schemas/portfolio.schema.json", import.meta.url), "utf8"));
// ajv's CommonJS default export is wrapped differently by Node and by vitest.
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module;
const ajv = new (Ajv2020 as unknown as new (o: object) => any)({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

/** The schema errors of `x` ([] when it conforms). */
export function portfolioSchemaErrors(x: unknown): string[] {
  return validate(x) ? [] : (validate.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message}`);
}
