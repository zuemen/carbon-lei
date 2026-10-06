// Parse coverage of the Communication Template importer over a set of xlsx files.
// Usage: node sdk/scripts/template-coverage.ts <file.xlsx>…
// For each file: parsed or the error, template version, products, values extracted, credential fields drafted.
// This measures how much the importer reads, not whether the values are correct.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { draftCredentialFields, parseTemplate } from "../template.ts";

let ok = 0;
for (const f of process.argv.slice(2)) {
  try {
    const t = await parseTemplate(readFileSync(f));
    const drafted = t.products.map((_, i) => draftCredentialFields(t, i).rows.length);
    console.log(
      `OK    ${basename(f)}  v${t.templateVersion}  products ${t.products.length}  values extracted ${t.extractedValues}  ` +
        `credential fields drafted per product ${drafted.join("/")}  CN ${t.products.map((p) => p.cnCode).join(",")}`,
    );
    ok++;
  } catch (e) {
    console.log(`FAIL  ${basename(f)}  ${(e as Error).message}`);
  }
}
console.log(`\n${ok} of ${process.argv.length - 2} files parsed`);
