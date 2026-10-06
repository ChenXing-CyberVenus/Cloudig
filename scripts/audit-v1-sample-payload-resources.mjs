import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readExporterEnvelope } from "../src/adapters/parser/html-envelope.mts";
import { parseExporterHtmlToDraft } from "../src/app/parser/host.mts";

const sampleRoot = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
if (!output.startsWith(path.resolve("artifacts") + path.sep)) throw new Error("Evidence belongs in project artifacts");
const rows = [];
for (const filename of (await readdir(sampleRoot)).filter(name => /\.html?$/i.test(name)).sort()) {
  const filePath = path.join(sampleRoot, filename);
  const envelope = await readExporterEnvelope({ filePath });
  const acquired = new Map();
  const stack = [envelope.payload];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string" && /^data:(?:image|application|text|audio|video)[/;]/i.test(value)) {
      const comma = value.indexOf(",");
      if (comma < 0) continue;
      const prefix = value.slice(0, comma);
      const mime = prefix.slice(5).split(";")[0].toLowerCase();
      // SVG is also legitimately a source-preserving inline HTML/diagram block;
      // the separate rendered-structure audit covers that representation.
      if (/svg|font|woff|opentype/.test(mime)) continue;
      const bytes = /;base64/i.test(prefix) ? Buffer.from(value.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(value.slice(comma + 1)));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      acquired.set(sha256, { mime, bytes: bytes.length, sha256 });
    } else if (Array.isArray(value)) stack.push(...value);
    else if (value && typeof value === "object" && value.kind !== "source-icon") stack.push(...Object.values(value));
  }
  const parsed = await parseExporterHtmlToDraft({ filePath });
  const embedded = new Set((parsed.draft.resources ?? []).filter(resource => resource.availability === "embedded").map(resource => resource.sha256));
  const missing = [...acquired.values()].filter(resource => !embedded.has(resource.sha256));
  rows.push({ filename, source_sha256: parsed.sourceFingerprint.sha256, platform: parsed.draft.platform, acquired: acquired.size, embedded: embedded.size, missing });
  console.log(JSON.stringify({ filename, acquired: acquired.size, missing: missing.length }));
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ schema: "cloudig/payload-resource-audit/1.0.0", rows }, null, 2) + "\n");
console.log(JSON.stringify({ files: rows.length, missing: rows.reduce((sum, row) => sum + row.missing.length, 0), output }));
