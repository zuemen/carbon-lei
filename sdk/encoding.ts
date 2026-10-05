// Byte helpers shared by the browser and Node. No Buffer, so the hosted page can load them.
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "./credential.ts";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function utf8(s: string): Uint8Array {
  return utf8ToBytes(s);
}

/** 32 random bytes as a lower-case 0x-hex string (all salts). */
export function newSalt(): Hex {
  return `0x${bytesToHex(randomBytes(32))}`;
}

export function isSalt(s: unknown): s is Hex {
  return typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);
}

export { bytesToHex, hexToBytes };
