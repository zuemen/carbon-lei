// Endpoints and well-known SAIDs of the local vLEI stack (verifier/docker-compose.yaml).
// Host-side URLs reach KERIA; container-side URLs are what KERIA itself resolves.

export const KERIA_ADMIN_URL = process.env.KERIA_ADMIN_URL ?? "http://127.0.0.1:3901";
export const KERIA_BOOT_URL = process.env.KERIA_BOOT_URL ?? "http://127.0.0.1:3903";

/** Schema server as seen from inside the compose network. */
export const VLEI_SERVER_URL = "http://vlei-server:7723";

/** The three `kli witness demo` witnesses (fixed salts, so fixed prefixes). */
export const WITNESS_IDS = [
  "BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha", // wan
  "BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM", // wil
  "BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX", // wes
];
export const WITNESS_THRESHOLD = 2;

/** GLEIF vLEI schemas (served by gleif/vlei). */
export const QVI_SCHEMA_SAID = "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao";
export const LE_SCHEMA_SAID = "ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY";
export const ECR_SCHEMA_SAID = "EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw";

export function schemaOobi(said: string): string {
  return `${VLEI_SERVER_URL}/oobi/${said}`;
}
