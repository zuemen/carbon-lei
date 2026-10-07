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
  // Built with Object.fromEntries (own data properties): an own "__proto__" key stays a key and is hashed,
  // where `copy[k] = v` would only set the copy's prototype and leave the key out of the digest.
  const copy = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === label ? SAID_DUMMY : v]));
  const digest = blake3(utf8(compactJson(copy)), { dkLen: 32 });
  const padded = new Uint8Array(33);
  padded.set(digest, 1);
  return "E" + base64url(padded).slice(1);
}

/**
 * The first key that appears twice in one object of a JSON text, read from the text itself (JSON.parse keeps
 * only the last value, so a repeated key could show one value to a reader and hash another); null if none.
 * The text must be valid JSON.
 */
export function duplicateKey(jsonText: string): string | null {
  const open: (Set<string> | null)[] = []; // keys of each enclosing object; null for an array
  let i = 0;
  while (i < jsonText.length) {
    const ch = jsonText[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < jsonText.length && jsonText[j] !== '"') j += jsonText[j] === "\\" ? 2 : 1;
      const raw = jsonText.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (k < jsonText.length && " \t\n\r".includes(jsonText[k])) k++;
      const keys = open[open.length - 1];
      if (jsonText[k] === ":" && keys) {
        const key = JSON.parse(raw) as string;
        if (keys.has(key)) return key;
        keys.add(key);
      }
      continue;
    }
    if (ch === "{") open.push(new Set());
    else if (ch === "[") open.push(null);
    else if (ch === "}" || ch === "]") open.pop();
    i++;
  }
  return null;
}

/**
 * Recomputes the SAID from the original JSON text (key order as transmitted) and compares it with `d`.
 * A text with a repeated key, or with a top-level "__proto__" key, never verifies.
 */
export function verifySaid(jsonText: string, label = "d"): boolean {
  const obj = JSON.parse(jsonText) as Record<string, unknown>;
  if (Object.hasOwn(obj, "__proto__") || duplicateKey(jsonText) !== null) return false;
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
