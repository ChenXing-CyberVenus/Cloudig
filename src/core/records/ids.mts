import { randomBytes } from "node:crypto";

/** UUID v7: time for locality, cryptographic randomness for identity, no Library counter. */
export function uuidV7(timestamp = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) throw new RangeError("UUID v7 requires a 48-bit millisecond timestamp");
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
