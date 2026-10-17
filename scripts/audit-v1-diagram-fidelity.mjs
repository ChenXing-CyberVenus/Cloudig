import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { readExporterEnvelope } from "../src/adapters/parser/html-envelope.mts";
import { finalizeConversation, serializeConversation } from "../src/core/contracts/index.mts";
import { PARSER_VERSION } from "../src/app/parser/registry.mts";

const root = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
if (!output.startsWith(path.resolve("artifacts") + path.sep)) throw new Error("Private evidence belongs in artifacts");
const hash = value => createHash("sha256").update(value).digest("hex");
const dom = new JSDOM("");
const svgFacts = bytes => {
  const xml = new dom.window.DOMParser().parseFromString(bytes, "image/svg+xml");
  return { sha256: hash(bytes), xml_error: xml.querySelector("parsererror")?.textContent, viewBox: xml.documentElement.getAttribute("viewBox"), width: xml.documentElement.getAttribute("width"), height: xml.documentElement.getAttribute("height"), styles: [...xml.querySelectorAll("style")].map(s => s.textContent), labels: [...xml.querySelectorAll("text,foreignObject")].map(s => s.textContent), local_paints: (bytes.match(/url\(["']?#/gu) ?? []).length };
};
const rows = [];
const galleryMessages = [], galleryResources = [], gallerySeen = new Set();
await mkdir(path.dirname(output), { recursive: true });
for (const filename of (await readdir(root)).filter(f => /\.html$/iu.test(f)).sort()) {
  const envelope = await readExporterEnvelope({ filePath: path.join(root, filename) });
  const draft = await envelope.adapter.parse({ manifest: envelope.manifest, payload: envelope.payload, reading: envelope.reading, source: { file: filename, ...envelope.fingerprint } });
  const resources = new Map((draft.resources ?? []).map(r => [r.id, r]));
  const diagrams = draft.messages.flatMap(m => (m.content ?? []).filter(b => b.type === "diagram").map(b => {
    const r = resources.get(b.rendered);
    const bytes = r?.data_base64 ? Buffer.from(r.data_base64.join(""), "base64") : undefined;
    return { message: m.id, format: b.format, source_sha256: b.source ? hash(b.source.trim()) : null, resource: r?.id, mime: r?.mime, bytes: r?.bytes, ...(r?.mime === "image/svg+xml" && bytes ? { svg: svgFacts(bytes.toString("utf8")) } : {}) };
  }));
  const source = envelope.reading.mermaid.map(card => { const comma = card.dataUrl.indexOf(","), bytes = /;base64,/u.test(card.dataUrl) ? Buffer.from(card.dataUrl.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(card.dataUrl.slice(comma + 1))); return { message: card.messageId, source_sha256: hash(card.source.trim()), ...(card.dataUrl.startsWith("data:image/svg+xml") ? { svg: svgFacts(bytes.toString("utf8")) } : { sha256: hash(bytes) }) }; });
  const row = { filename, source_sha256: envelope.fingerprint.sha256, platform: draft.platform, profile: draft.source.profile, diagrams, reading: source };
  const galleryContent = [];
  for (const message of draft.messages) for (const block of message.content ?? []) {
    if (block.type !== "diagram" || block.format === "writing-block") continue;
    const resource = resources.get(block.rendered);
    const signature = JSON.stringify([block.format, block.source, resource?.sha256, block.html]);
    if (gallerySeen.has(signature)) continue;
    gallerySeen.add(signature);
    const copy = structuredClone(block);
    if (resource) {
      copy.rendered = `r${galleryResources.length + 1}`;
      galleryResources.push({ ...structuredClone(resource), id: copy.rendered });
    }
    galleryContent.push(copy);
  }
  if (galleryContent.length) galleryMessages.push({ role: "assistant", content: [{ type: "text", text: `${draft.platform} / ${draft.source.profile} / ${filename}` }, ...galleryContent] });
  rows.push(row);
  console.log(JSON.stringify({ file: filename, diagrams: diagrams.length, svg: diagrams.filter(d => d.svg).length, invalid: diagrams.filter(d => d.svg?.xml_error).length, missing_svg_styles: diagrams.filter(d => d.svg && d.svg.styles.length === 0).length }));
  await writeFile(output, JSON.stringify({ schema: "cloudig/diagram-fidelity-audit/1.0.0", note: "Source and Parser SVG evidence; visual comparison remains necessary.", rows }, null, 2) + "\n");
}
if (process.argv[4]) {
  const galleryFile = path.resolve(process.argv[4]);
  if (!galleryFile.startsWith(path.resolve("artifacts") + path.sep)) throw new Error("Derived gallery belongs in artifacts");
  const stamp = new Date().toISOString();
  const sourceBytes = await readFile(output);
  const gallery = finalizeConversation({ schema: "cloudig/conversation/1.0.0", archive: "a1", generation: 1, content_sha256: "0".repeat(64), parser: { version: PARSER_VERSION, adapter: { id: "derived-diagram-audit", version: "1.0.0" } }, lifecycle: { first_parsed_at: { basis: "parser", value: stamp }, last_parsed_at: stamp, cloudig_edited_at: stamp }, source: { file: path.basename(output), bytes: sourceBytes.length, sha256: hash(sourceBytes), format: "json", payload: "cloudig.diagram-audit-v1" }, title: "Derived diagram atlas — not a source conversation", content_time: { basis: "unavailable" }, platform: "chatgpt", provider: "openai", messages: galleryMessages, resources: galleryResources });
  await writeFile(galleryFile, serializeConversation(gallery));
  console.log(JSON.stringify({ gallery: galleryFile, sourceFiles: rows.length, uniqueDiagrams: gallerySeen.size }));
}
dom.window.close();
