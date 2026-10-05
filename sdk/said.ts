// Self-addressing identifier (SAID) of the credential core: Blake3-256 over the compact
// JSON with `d` filled by 44 '#', key order preserved, then CESR code 'E' (Blake3-256).
import { blake3 } from "@noble/hashes/blake3.js";
import { base64url, utf8 } from "./encoding.ts";

export const SAID_DUMMY = "#".repeat(44);

/** Compact JSON with insertion-ordered keys and non-ASCII kept as is (keripy: ensure_ascii=False). */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

/** SAID of a JSON object text or object, label `d`. The object must already contain `d`. */
export function computeSaid(obj: Record<string, unknown>, label = "d"): string {
  if (!(label in obj)) throw new Error(`object has no '${label}' field`);
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) copy[k] = k === label ? SAID_DUMMY : v;
  const digest = blake3(utf8(compactJson(copy)), { dkLen: 32 });
  const padded = new Uint8Array(33);
  padded.set(digest, 1);
  return "E" + base64url(padded).slice(1);
}

/** Recomputes the SAID from the original JSON text (key order as transmitted) and compares it with `d`. */
export function verifySaid(jsonText: string, label = "d"): boolean {
  const obj = JSON.parse(jsonText) as Record<string, unknown>;
  const d = obj[label];
  return typeof d === "string" && d.length === 44 && computeSaid(obj, label) === d;
}

/** Fills `d` in place order and returns the object with its SAID. */
export function saidify<T extends Record<string, unknown>>(obj: T, label = "d"): T {
  const out = { ...obj } as Record<string, unknown>;
  if (!(label in out)) throw new Error(`object has no '${label}' field`);
  out[label] = computeSaid(out, label);
  return out as T;
}
