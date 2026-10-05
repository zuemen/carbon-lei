// Keys and commitments computed off-chain; the contracts only see bytes32.
// Standard abi.encode (length-prefixed), never encodePacked, so forge and the SDK agree.
import { encodeAbiParameters, keccak256, stringToBytes } from "viem";
import type { Hex } from "./credential.ts";

/** keccak256 over the UTF-8 bytes of a string (reportKey, reportIdHash, auditorAidHash, leiHash, SAID hashes). */
export function hashString(s: string): Hex {
  return keccak256(stringToBytes(s));
}

export const reportKeyOf = (credSAID: string): Hex => hashString(credSAID);
export const reportIdHashOf = (verificationReportId: string): Hex => hashString(verificationReportId);
export const auditorAidHashOf = (auditorAID: string): Hex => hashString(auditorAID);
export const leiHashOf = (lei: string): Hex => hashString(lei);

const STR_B32 = [{ type: "string" }, { type: "bytes32" }] as const;

export function supplierCommitOf(supplierLEI: string, idSalt: Hex): Hex {
  return keccak256(encodeAbiParameters(STR_B32, [supplierLEI, idSalt]));
}

export function installationCommitOf(installationId: string, idSalt: Hex): Hex {
  return keccak256(encodeAbiParameters(STR_B32, [installationId, idSalt]));
}

export function importerCommitOf(importerEORI: string, importerSalt: Hex): Hex {
  return keccak256(encodeAbiParameters(STR_B32, [importerEORI, importerSalt]));
}

export function batchKeyOf(reportKey: Hex, batchId: string, batchSalt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "string" }, { type: "bytes32" }],
      [reportKey, batchId, batchSalt],
    ),
  );
}

/** Report layer: (installationId, reportingPeriod). */
export function reportScopeKeyOf(installationId: string, reportingPeriod: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "string" }], [installationId, reportingPeriod]),
  );
}

/** Credential layer: (installationId, cnCode, cbamRoute, reportingPeriod). */
export function credScopeKeyOf(
  installationId: string,
  cnCode: string,
  cbamRoute: string,
  reportingPeriod: string,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }],
      [installationId, cnCode, cbamRoute, reportingPeriod],
    ),
  );
}

export const ZERO32: Hex = `0x${"0".repeat(64)}`;
