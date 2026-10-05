// Packs the exported credential chain into one authority-evidence bundle for check 7
// (fixtures/evidence/authority-bundle.json). Run after export-evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuthorityEvidence } from "../../sdk/vlei.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}fixtures/evidence/`;
const vlei = JSON.parse(readFileSync(`${root}fixtures/vlei.json`, "utf8"));
const read = (f: string) => readFileSync(dir + f, "utf8");

const bundle: AuthorityEvidence & { note: string; exportedAt: string } = {
  note: "vLEI credential chain exported from the local KERI run (fictional identities, simulated root). Check 7 recomputes every SAID in it.",
  exportedAt: vlei.updatedAt,
  trustAnchor: vlei.trustAnchor,
  accreditationSchema: vlei.schemas.CBAMVerifierAccreditation,
  cesr: {
    qvi: read("cred-qvi.cesr"),
    leBody: read("cred-le-verifier.cesr"),
    leNab: read("cred-le-nab.cesr"),
    accreditation: read("cred-accreditation.cesr"),
    ecr: read("cred-ecr.cesr"),
  },
};
writeFileSync(`${dir}authority-bundle.json`, JSON.stringify(bundle) + "\n");
console.log(`wrote fixtures/evidence/authority-bundle.json (${JSON.stringify(bundle).length} bytes)`);
