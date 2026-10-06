import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomId(prefix: "x" | "o"): string {
  const bytes = randomBytes(20);
  let value = 0;
  let bits = 0;
  let result = `${prefix}_`;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

export function engineTransactionId(): string {
  return randomId("x");
}

export function engineOperationId(): string {
  return randomId("o");
}
