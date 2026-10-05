// Onboarding gate (before addVerifier / addAuditor): verify a verification body's vLEI chain and
// its auditor's role credential off-chain, from the exported evidence, and print the hashes that
// go on-chain. Refuses a body without an LE vLEI and an accreditation (the demo impostor).
// Usage: node verifier/src/onboard-check.ts [body|impostor]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashString } from "../../sdk/commitment.ts";
import { verifyAuthority } from "../../sdk/vlei.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vlei = JSON.parse(readFileSync(`${root}fixtures/vlei.json`, "utf8"));
const demo = JSON.parse(readFileSync(`${root}fixtures/demo.json`, "utf8"));
const read = (f: string) => readFileSync(`${root}fixtures/evidence/${f}`, "utf8");
const who = process.argv[2] ?? "body";

if (who === "impostor") {
  const held = vlei.impostorCredentials ?? 0;
  console.log(`impostor ${demo.entities.impostor.name}: ${held} credentials — no LE vLEI, no accreditation`);
  console.log("REFUSED: not added to the allowlist");
  process.exit(1);
}

const r = verifyAuthority(
  {
    trustAnchor: vlei.trustAnchor,
    accreditationSchema: vlei.schemas.CBAMVerifierAccreditation,
    cesr: {
      qvi: read("cred-qvi.cesr"),
      leBody: read("cred-le-verifier.cesr"),
      leNab: read("cred-le-nab.cesr"),
      accreditation: read("cred-accreditation.cesr"),
      ecr: read("cred-ecr.cesr"),
    },
  },
  { auditorAID: vlei.agents.auditor.aid, verifierLEI: demo.entities.verifier.lei, cnCode: demo.product.cnCode },
);
console.log(r.ok ? `OK: ${r.detail}` : `REFUSED: ${r.code} — ${r.detail}`);
if (!r.ok) process.exit(1);
console.log(
  JSON.stringify(
    {
      leiHash: hashString(demo.entities.verifier.lei),
      leCredSaidHash: hashString(vlei.credentials.leVerifier.said),
      accreditationSaidHash: hashString(vlei.credentials.accreditation.said),
      auditorAidHash: hashString(vlei.agents.auditor.aid),
      ecrSaidHash: hashString(vlei.credentials.ecr.said),
    },
    null,
    2,
  ),
);
