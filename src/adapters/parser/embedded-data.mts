import { RESOURCE_BASE64_DECODED_CHUNK_BYTES } from "../storage/stream.mts";
import { createHash } from "node:crypto";

const BASE64_CHUNK_CHARACTERS = RESOURCE_BASE64_DECODED_CHUNK_BYTES / 3 * 4;

export type EmbeddedData = Readonly<{
  mime: string;
  byteLength: number;
  sha256: string;
  dataBase64: string[];
  signaturePrefix: Buffer;
}>;

function imageSignatureMatches(mime: string, prefix: Buffer, byteLength: number): boolean {
  if (mime === "image/png") return prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (mime === "image/gif") return prefix.subarray(0, 6).toString("ascii") === "GIF87a" || prefix.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mime === "image/webp") return prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "image/svg+xml") return /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(prefix.toString("utf8"));
  return mime.startsWith("image/") && byteLength > 0;
}

function inspectCanonicalBase64(value: string, start: number): Omit<EmbeddedData, "mime"> {
  const hash = createHash("sha256");
  const dataBase64: string[] = [];
  let byteLength = 0;
  let signaturePrefix = Buffer.alloc(0);
  for (let offset = start; offset < value.length; offset += BASE64_CHUNK_CHARACTERS) {
    const encoded = value.slice(offset, Math.min(value.length, offset + BASE64_CHUNK_CHARACTERS));
    if (/\s/u.test(encoded) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
      throw new TypeError("Embedded resource is not canonical Base64 data");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) throw new TypeError("Embedded resource Base64 is noncanonical");
    if (offset + BASE64_CHUNK_CHARACTERS < value.length && decoded.byteLength !== RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
      throw new TypeError("Embedded resource Base64 has an invalid non-final chunk boundary");
    }
    if (signaturePrefix.byteLength < 4096) {
      signaturePrefix = Buffer.concat([signaturePrefix, decoded.subarray(0, 4096 - signaturePrefix.byteLength)]);
    }
    hash.update(decoded);
    byteLength += decoded.byteLength;
    dataBase64.push(encoded);
  }
  return { byteLength, sha256: hash.digest("hex"), dataBase64, signaturePrefix };
}

function inspectBuffer(bytes: Buffer): Omit<EmbeddedData, "mime"> {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    dataBase64: base64Chunks(bytes),
    signaturePrefix: Buffer.from(bytes.subarray(0, 4096))
  };
}

export function embeddedBase64DataUrl(value: string): EmbeddedData {
  const comma = value.indexOf(",");
  if (comma < 0) throw new TypeError("Embedded resource has an invalid data URL");
  const header = value.slice(0, comma);
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64$/iu.exec(header);
  if (!match) throw new TypeError("Embedded resource is not canonical Base64 data");
  return { mime: match[1]!.toLowerCase(), ...inspectCanonicalBase64(value, comma + 1) };
}

export function embeddedImageDataUrl(value: string): EmbeddedData {
  const comma = value.indexOf(",");
  if (comma < 0) throw new TypeError("Embedded image has an invalid data URL");
  const header = value.slice(0, comma);
  const body = value.slice(comma + 1);
  const match = /^data:([^;,]+)(?:;[^,]*)*$/iu.exec(header);
  if (!match) throw new TypeError("Embedded image has an invalid MIME header");
  const mime = match[1]!.toLowerCase();
  let inspected: Omit<EmbeddedData, "mime">;
  if (/;base64$/iu.test(header)) {
    const embedded = embeddedBase64DataUrl(value);
    inspected = embedded;
  } else {
    if (mime !== "image/svg+xml") throw new TypeError("Only UTF-8 SVG may use a non-Base64 image data URL");
    try {
      inspected = inspectBuffer(Buffer.from(decodeURIComponent(body), "utf8"));
    } catch {
      throw new TypeError("Embedded image has invalid percent-encoded bytes");
    }
  }
  if (!imageSignatureMatches(mime, inspected.signaturePrefix, inspected.byteLength)) {
    throw new TypeError("Embedded image MIME does not match its bytes");
  }
  return { mime, ...inspected };
}

export function base64Chunks(bytes: Buffer): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += RESOURCE_BASE64_DECODED_CHUNK_BYTES) {
    result.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + RESOURCE_BASE64_DECODED_CHUNK_BYTES)).toString("base64"));
  }
  return result;
}
