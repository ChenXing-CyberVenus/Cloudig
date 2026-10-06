import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { extractHtmlRecord } from "../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../src/app/parser/conversation-record.mts";
import { PARSER_VERSION } from "../src/app/parser/registry.mts";
import { extractStaticReadingEvidence } from "../src/adapters/parser/reading-evidence.mts";
import { readExporterEnvelope } from "../src/adapters/parser/html-envelope.mts";
import { resolveRecordPresentation } from "../src/core/records/presentation.mts";
import { prepareRecordConversationView } from "../src/app/reader/view-model.mts";
import { DEFAULT_READER_SESSION } from "../src/app/reader/index.mts";
import { createConversationRenderer } from "../src/ui/shared/conversation-renderer/index.mts";

const sampleRoot = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const owned = path.resolve("artifacts");
if (!output.startsWith(`${owned}${path.sep}`)) throw new Error("Private comparison output must stay in artifacts.");
const labels = { reasoning: "思考", toolCall: "工具调用", toolResult: "工具结果", toolActivity: "工具活动", references: "参考", search: "搜索", diagram: "图表", source: "源码", loadingResource: "正在读取", unavailableResource: "资源不可用", failedResource: "读取失败", openAttachment: "打开附件", externalResource: "外部链接", systemParty: "系统", toolParty: "工具", otherParty: "其他" };
const hash = value => createHash("sha256").update(value).digest("hex");
const compact = text => text.replace(/\s+/gu, " ").trim();
function semanticText(node) {
  const clone = node.cloneNode(true);
  for (const math of clone.querySelectorAll('.katex,math')) {
    if (!clone.contains(math)) continue;
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    math.replaceWith(` MATH[${compact(tex ?? math.textContent)}] `);
  }
  clone.querySelectorAll('button,.cloudig-diagram-tabs,.cloudig-diagram-controls').forEach(item => item.remove());
  for (const item of clone.querySelectorAll('p,li,div,br,pre,blockquote')) { item.before(' '); item.after(' '); }
  return compact(clone.textContent);
}
function features(root) {
  const result = new Map();
  const add = (kind, value) => {
    if (!value) return;
    const key = `${kind}:${hash(value)}`;
    const prior = result.get(key);
    result.set(key, { kind, value: value.slice(0, 240), count: (prior?.count ?? 0) + 1 });
  };
  for (const node of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) add(node.tagName.toLowerCase(), semanticText(node));
  for (const node of root.querySelectorAll("pre")) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button,.copy-button,.code-toolbar").forEach(node => node.remove());
    add("code", clone.textContent.replace(/\r\n/gu, "\n").trim());
  }
  for (const node of root.querySelectorAll("blockquote")) add("quote", semanticText(node));
  for (const node of root.querySelectorAll("ol")) add("ordered-list", `${node.getAttribute("start") ?? "1"}|${semanticText(node)}`);
  for (const node of root.querySelectorAll("table")) add("table", [...node.rows].map(row => [...row.cells].map(cell => semanticText(cell)).join("| ")).join("\n"));
  for (const node of root.querySelectorAll('annotation[encoding="application/x-tex"]')) add("math", (node.closest('[data-tex]')?.getAttribute('data-tex') ?? node.textContent).trim());
  return result;
}
function counts(features) {
  const result = {};
  for (const item of features.values()) result[item.kind] = (result[item.kind] ?? 0) + item.count;
  return result;
}
// Text normalization used by the old feature check deliberately erased all
// whitespace. Keep a separate check for authored hard/paragraph breaks.
function readingText(root) {
  const blockTags = new Set(['ARTICLE', 'P', 'DIV', 'SECTION', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TR']);
  const visit = (node, preserve = false) => {
    if (node.nodeType === 11) return [...node.childNodes].map(child => visit(child, preserve)).join('');
    if (node.nodeType === 3) return preserve ? node.textContent.replace(/\n/gu, '\uE000') : node.textContent.replace(/\s+/gu, ' ');
    if (node.nodeType !== 1) return '';
    if (node.matches('button,time,script,style,.cloudig-message-header,.cloudig-diagram-tabs,.cloudig-diagram-controls,.osis-mermaid-card,pre,.katex,math,summary')) return '';
    if (node.tagName === 'BR') return '\uE000';
    const pre = preserve || node.matches('.user-bubble,.cloudig-text,.plain-text,.whitespace-pre-wrap,.whitespace-pre-line,[style*="white-space: pre"],[style*="white-space:pre"]');
    const content = [...node.childNodes].map(child => visit(child, pre)).join('');
    return blockTags.has(node.tagName) ? `\n${content}${node.tagName === 'P' && node.nextElementSibling?.tagName === 'P' ? '\uE000' : '\n'}` : content;
  };
  return visit(root);
}
function lineBreakComparison(source, target) {
  const original = readingText(source), parts = original.split(/([\n\uE000])/u);
  const lines = text => text.split(/[\n\uE000]/u).map(compact).filter(Boolean);
  const expected = lines(original), actual = lines(readingText(target));
  const targetText = compact(actual.join(' '));
  const targetLines = actual.join('\n');
  // Only authored separators within a body: never infer line breaks between
  // tool cards, author labels, table columns or distinct tree branches.
  const pairs = [];
  const add = (before, after) => pairs.push([compact(before).slice(-24), compact(after).slice(0, 24)]);
  for (let i = 1; i < parts.length - 1; i += 2) {
    if (parts[i] !== '\uE000') continue;
    let next = i + 1;
    while (next < parts.length && !compact(parts[next])) next++;
    add(parts[i - 1], parts[next] ?? '');
  }
  const reviewed = pairs
    .filter(([before, after]) => before.length >= 4 && after.length >= 4 && targetText.includes(before) && targetText.includes(after));
  const missing = reviewed.filter(([before, after]) => {
    for (let cursor = 0; cursor < targetLines.length;) {
      const left = targetLines.indexOf(before, cursor); if (left < 0) break;
      cursor = left + before.length;
      const right = targetLines.indexOf(after, cursor);
      if (right >= cursor && right - cursor < 400 && targetLines.slice(cursor, right).includes('\n')) return false;
    }
    return true;
  });
  return { source_lines: expected.length, reader_lines: actual.length, matched_text_boundaries: reviewed.length, review_candidates: missing };
}
const rows = [];
await mkdir(path.dirname(output), { recursive: true });
for (const filename of (await readdir(sampleRoot)).filter(name => /\.html?$/iu.test(name) && (!process.argv[4] || new RegExp(process.argv[4], "u").test(name))).sort()) {
  const file = path.join(sampleRoot, filename);
  const extracted = await extractHtmlRecord({ filePath: file, temporaryRoot: path.join(path.dirname(output), "cache") });
  const { parsed } = extracted;
  const reading = await extractStaticReadingEvidence(createReadStream(file));
  const conversation = assembleConversationRecord({ ...extracted, timestamp: "2026-09-15T00:00:00.000Z", parserVersion: PARSER_VERSION });
  const builtins = { user: { name: "User", avatar: "user.svg" }, assistant: { name: "AI", avatar: "ai.svg" }, platforms: {} };
  const resolved = resolveRecordPresentation({ conversation, language: "zh-CN", bindings: {}, identities: new Map(), builtins, availableAssets: new Set() });
  const prepared = prepareRecordConversationView({ conversation, resolved });
  const items = conversation.messages.items;
  const parents = new Set(items.map(message => message.parent).filter(Boolean));
  const leaves = conversation.messages.current ? items.filter(message => !parents.has(message.id)).map(message => message.id) : [undefined];
  const messages = new Map();
  for (const leaf of leaves) for (let offset = 0; offset < items.length; offset += 100) {
    const view = prepared.page({ session: { ...DEFAULT_READER_SESSION, ...(leaf ? { selectedLeaf: leaf } : {}) }, page: { offset, limit: 100 }, navigationPage: { offset: 0, limit: 1 }, branchPage: { offset: 0, limit: 1 } });
    for (const message of view.messages) messages.set(message.anchor, message);
    if (view.messages.length < 100) break;
  }
  let sourceHtml = reading.fragments.map(fragment => fragment.html).join("\n");
  if (!reading.fragments.length && conversation.platform === "chatgpt" && conversation.source.profile === "tree") {
    const envelope = await readExporterEnvelope({ filePath: file });
    sourceHtml = Object.values(envelope.payload.rendered_turns ?? {}).join("\n");
  }
  const source = new JSDOM(`<main>${sourceHtml}</main>`);
  const rendered = new JSDOM("<main></main>");
  const root = rendered.window.document.querySelector("main");
  const resources = new Map((conversation.resources ?? []).map(resource => [resource.id, resource]));
  const renderer = createConversationRenderer({ root, labels, theme: "dawn", resolveResource: async metadata => {
    const resource = resources.get(metadata.id);
    return { url: `data:${resource.mime};base64,${Array.isArray(resource.data_base64) ? resource.data_base64.join("") : resource.data_base64}` };
  } });
  renderer.render({ messages: [...messages.values()] });
  renderer.materializeDeferred();
  await new Promise(resolve => setTimeout(resolve, 0));
  const expected = features(source.window.document.querySelector("main"));
  const actual = features(root);
  const mathErrors = root => [...root.querySelectorAll('.katex-error')].map(node => compact(node.textContent));
  const sourceMathErrors = mathErrors(source.window.document), readerMathErrors = mathErrors(root);
  const introducedMathErrors = readerMathErrors.filter(value => !sourceMathErrors.includes(value));
  if (process.argv[4]) {
    await writeFile(`${output}.${filename}.reader.html`, root.innerHTML, "utf8");
    await writeFile(`${output}.${filename}.source.html`, sourceHtml, "utf8");
  }
  const missing = [...expected].filter(([key]) => !actual.has(key)).map(([, item]) => item);
  const hrefs = root => new Set([...root.querySelectorAll('a[href]')].map(a => a.href).filter(url => /^https?:/u.test(url)));
  const actualLinks = hrefs(root);
  const missingHyperlinks = [...hrefs(source.window.document)].filter(url => !actualLinks.has(url));
  const sourceReferences = [...source.window.document.querySelectorAll('.answer-sources a[href]')].map(node => ({ title: compact(node.querySelector('.source-title')?.textContent ?? node.textContent), url: node.getAttribute('href') }));
  const readerReferences = [...root.querySelectorAll('.cloudig-source-link')].map(node => ({ title: compact(node.textContent), url: node.getAttribute('href') }));
  const missingSourceReferences = sourceReferences.filter(expected => !readerReferences.some(actual => actual.title === expected.title && actual.url === expected.url));
  const bitmapHashes = new Set([...resources.values()].filter(resource => resource.availability === "embedded" && !/svg/iu.test(resource.mime ?? "")).map(resource => resource.sha256));
  const missingImages = reading.images.filter(image => !/^data:image\/svg/iu.test(image.dataUrl)).filter(image => {
    const comma = image.dataUrl.indexOf(",");
    const bytes = /;base64,/iu.test(image.dataUrl.slice(0, comma + 1)) ? Buffer.from(image.dataUrl.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(image.dataUrl.slice(comma + 1)));
    return !bitmapHashes.has(hash(bytes));
  }).length;
  const row = { filename, platform: conversation.platform, profile: conversation.source.profile, source_sha256: parsed.sourceFingerprint.sha256, messages: items.length, rendered_messages: messages.size, leaves: leaves.length, source_fragments: reading.fragments.length, source_features: counts(expected), reader_features: counts(actual), missing, source_reference_count: sourceReferences.length, missing_source_references: missingSourceReferences, missing_images: missingImages, source_math_errors: sourceMathErrors, introduced_math_errors: introducedMathErrors, open_process: root.querySelectorAll(".cloudig-process[open]").length, diagnostics: parsed.systemLogErrors.length };
  row.line_breaks = lineBreakComparison(source.window.document.querySelector('main'), root);
  const diagrams = [...resources.values()].filter(resource => resource.kind === 'diagram' && resource.availability === 'embedded');
  const diagramHashes = new Set(diagrams.map(resource => resource.sha256));
  row.diagram_snapshots = { source: reading.mermaid.length, embedded: diagrams.length, missing: reading.mermaid.filter(item => {
    const comma = item.dataUrl.indexOf(',');
    const bytes = /;base64,/iu.test(item.dataUrl.slice(0, comma + 1)) ? Buffer.from(item.dataUrl.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(item.dataUrl.slice(comma + 1)));
    return !diagramHashes.has(hash(bytes));
  }).length };
  row.missing_hyperlinks = missingHyperlinks;
  rows.push(row);
  console.log(JSON.stringify({ file: filename, platform: row.platform, profile: row.profile, format_differences: missing.length, missing_images: missingImages, line_break_candidates: row.line_breaks.review_candidates.length, diagrams: row.diagram_snapshots, introduced_math_errors: introducedMathErrors.length, open_process: row.open_process }));
  renderer.destroy(); source.window.close(); rendered.window.close();
  await writeFile(output, `${JSON.stringify({ schema: "cloudig/sample-render-comparison/1.0.0", note: "Structural comparison uses the real Parser, view projector and Renderer; all branch bodies are unioned. This is not screenshot acceptance. Different HTML structures are review candidates, not automatic data loss.", rows }, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ files: rows.length, candidate_differences: rows.reduce((n, row) => n + row.missing.length, 0), missing_images: rows.reduce((n, row) => n + row.missing_images, 0), output }));
