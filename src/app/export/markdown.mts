import { conversationMessagePath } from "../reader/index.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { ResolvedArchiveView } from "../../core/library/overlay.mts";
import { formatRange } from "../../core/time/index.mts";
import { formatRecordTimeRange } from "../../core/records/time-display.mts";
import { projectRecordForReading, type RecordPresentation } from "../../core/records/presentation.mts";
import { validateRecord, validateConversationRecordMetadata, type ObservedRecordResource } from "../../core/records/index.mts";
import { htmlResourceImages } from "../../core/records/html-resources.mts";
import { conversationImages } from '../../core/records/conversation-images.mts';
import { inertHtmlFragment } from "../../adapters/parser/inert-html.mts";
import { dilReference, savedDil, dilText } from "../../adapters/parser/chatgpt-dil.mts";
import { selectedMessageBlocks, type ContentMode } from "../reader/content-selection.mts";

export type MarkdownExportLocale = "zh-CN" | "en";

export type MarkdownExportPart =
  | string
  | Readonly<{
      kind: "embedded_resource";
      resource: string;
      prefix: string;
      suffix: string;
    }>;

export type MarkdownExportPlan = Readonly<{
  parts: readonly MarkdownExportPart[];
  selectedLeaf?: string;
  messageCount: number;
}>;

type Copy = Readonly<{
  platform: string;
  models: string;
  contentTime: string;
  sourceFile: string;
  archive: string;
  branch: string;
  messages: string;
  unknownTime: string;
  clearedTime: string;
  noVisibleContent: string;
  system: string;
  toolParty: string;
  other: string;
  reasoning: string;
  status: string;
  search: string;
  citations: string;
  toolCall: string;
  toolResult: string;
  toolActivity: string;
  diagram: string;
  renderedDiagram: string;
  unknown: string;
  resource: string;
  unavailable: string;
  metadataOnly: string;
  missing: string;
  external: string;
  input: string;
  output: string;
  duration: string;
  effort: string;
}>;

const COPY: Readonly<Record<MarkdownExportLocale, Copy>> = Object.freeze({
  "zh-CN": Object.freeze({
    platform: "平台",
    models: "模型",
    contentTime: "内容时间",
    sourceFile: "来源文件",
    archive: "档案",
    branch: "当前分支",
    messages: "消息数",
    unknownTime: "未设置",
    clearedTime: "已清除",
    noVisibleContent: "无可见内容",
    system: "系统",
    toolParty: "工具",
    other: "其他",
    reasoning: "思考",
    status: "状态",
    search: "搜索",
    citations: "参考",
    toolCall: "工具调用",
    toolResult: "工具结果",
    toolActivity: "工具活动",
    diagram: "图表",
    renderedDiagram: "图表渲染",
    unknown: "未知内容",
    resource: "资源",
    unavailable: "不可用",
    metadataOnly: "仅元数据",
    missing: "缺失",
    external: "外部链接",
    input: "输入",
    output: "输出",
    duration: "耗时",
    effort: "思考强度"
  }),
  en: Object.freeze({
    platform: "Platform",
    models: "Models",
    contentTime: "Content time",
    sourceFile: "Source file",
    archive: "Archive",
    branch: "Selected branch",
    messages: "Messages",
    unknownTime: "Not set",
    clearedTime: "Cleared",
    noVisibleContent: "No visible content",
    system: "System",
    toolParty: "Tool",
    other: "Other",
    reasoning: "Reasoning",
    status: "Status",
    search: "Search",
    citations: "References",
    toolCall: "Tool call",
    toolResult: "Tool result",
    toolActivity: "Tool activity",
    diagram: "Diagram",
    renderedDiagram: "Rendered diagram",
    unknown: "Unknown content",
    resource: "Resource",
    unavailable: "unavailable",
    metadataOnly: "metadata only",
    missing: "missing",
    external: "external link",
    input: "Input",
    output: "Output",
    duration: "Duration",
    effort: "Effort"
  })
});

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function line(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\s*\n\s*/gu, " ").trim();
}

function escapeLabel(value: string): string {
  return line(value).replace(/[\\\[\]]/gu, "\\$&");
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function fenced(value: string, language = "text"): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  const longest = Math.max(0, ...Array.from(normalized.matchAll(/~+/gu), (match) => match[0].length));
  const fence = "~".repeat(Math.max(3, longest + 1));
  const info = /^[A-Za-z0-9_+.-]+$/u.test(language) ? language : "text";
  return `${fence}${info}\n${normalized}\n${fence}`;
}

function quote(value: string): string {
  return value.replace(/\r\n?/gu, "\n").split("\n").map((entry) => `> ${entry}`).join("\n");
}

function formatContentTime(resolved: ResolvedArchiveView | RecordPresentation, locale: MarkdownExportLocale, copy: Copy): string {
  if (resolved.contentTime.state === "cleared") return copy.clearedTime;
  if (!isJsonObject(resolved.contentTime.range)) return copy.unknownTime;
  return "effectiveEditedAt" in resolved ? formatRecordTimeRange(resolved.contentTime.range, locale) : formatRange(resolved.contentTime.range, locale);
}

function roleName(message: JsonObject, resolved: ResolvedArchiveView | RecordPresentation, copy: Copy): string {
  const party = object(message["party"]);
  if (text(party?.["name"])) return text(party?.["name"])!;
  const role = text(message["role"]);
  if (role === "user") return resolved.userName;
  if (role === "assistant") return resolved.assistantName;
  if (role === "system") return text(message["name"]) ?? copy.system;
  if (role === "tool") return text(message["name"]) ?? copy.toolParty;
  return text(message["name"]) ?? copy.other;
}

function json(value: JsonValue): string {
  return fenced(JSON.stringify(value, null, 2), "json");
}

export function buildConversationMarkdown(input: Readonly<{
  conversation: JsonObject;
  resolved: ResolvedArchiveView | RecordPresentation;
  locale: MarkdownExportLocale;
  selectedLeaf?: string;
  branchChoices?: Readonly<Record<string, string>>;
  contentMode?: ContentMode;
  messageIds?: readonly string[];
  includeHeader?: boolean;
}>): MarkdownExportPlan {
  const copy = COPY[input.locale];
  const conversation = input.conversation;
  const archive = text(conversation["conversation_id"]) ?? text(conversation["archive"]) ?? "a0";
  const generation = typeof conversation["generation"] === "number" ? conversation["generation"] : 0;
  const identityText = conversation["conversation_id"] ? archive : `${archive} · generation ${generation}`;
  const selection = conversationMessagePath(conversation, input.selectedLeaf, input.branchChoices);
  if (input.selectedLeaf !== undefined && selection.selected !== input.selectedLeaf) {
    throw new TypeError("Selected branch is not present in the Conversation");
  }
  const messages = conversation["messages"] as JsonObject[];
  const mode = input.contentMode ?? "with_process";
  if (mode !== "body" && mode !== "with_process") throw new TypeError("Invalid Markdown content mode");
  const wanted = input.messageIds === undefined ? undefined : new Set(input.messageIds);
  if (wanted && (!wanted.size || wanted.size !== input.messageIds!.length || [...wanted].some(id => typeof id !== "string" || !id))) throw new TypeError("Invalid Markdown message selection");
  const pathIds = new Set(selection.path.map(index => String(messages[index]!["id"])));
  if (wanted && [...wanted].some(id => !pathIds.has(id))) throw new TypeError("Selected message is not on the displayed branch");
  const selectedMessages = selection.path.filter(index => !wanted || wanted.has(String(messages[index]!["id"])))
    .map(index => ({ message: messages[index]!, blocks: selectedMessageBlocks(messages[index]!, mode) }))
    .filter(entry => mode === "with_process" || entry.blocks.length > 0);
  const resources = new Map<string, JsonObject>();
  for (const raw of Array.isArray(conversation["resources"]) ? conversation["resources"] : []) {
    if (isJsonObject(raw) && typeof raw["id"] === "string") resources.set(raw["id"], raw);
  }
  const sources = new Map<string, JsonObject>();
  for (const raw of Array.isArray(conversation["sources"]) ? conversation["sources"] : []) {
    if (isJsonObject(raw) && typeof raw["id"] === "string") sources.set(raw["id"], raw);
  }
  const usedResources = new Set<string>();
  const parts: MarkdownExportPart[] = [];
  const reference = (id: string): string => `cloudig-${archive}${conversation["conversation_id"] ? "" : `-${generation}`}-${id}`;

  const resourceLink = (id: string | undefined, label: string, image = false): string => {
    if (!id) return `**[${copy.resource}: ${escapeLabel(label)} · ${copy.unavailable}]**`;
    const resource = resources.get(id);
    if (!resource) return `**[${copy.resource}: ${escapeLabel(label)} · ${copy.unavailable}]**`;
    const availability = text(resource["availability"]);
    const name = text(resource["name"]) ?? label ?? id;
    if (availability === "embedded" || availability === "external") {
      usedResources.add(id);
      return image
        ? `![${escapeLabel(label || name)}][${reference(id)}]`
        : `[${escapeLabel(label || name)}][${reference(id)}]`;
    }
    const state = availability === "metadata_only" ? copy.metadataOnly : availability === "missing" ? copy.missing : copy.unavailable;
    return `**[${copy.resource}: ${escapeLabel(name)} · ${state}]**`;
  };

  const sourceList = (ids: readonly string[]): string => {
    const rows = ids.map((id) => {
      const source = sources.get(id);
      if (!source) return `- **${escapeLabel(id)}** · ${copy.unavailable}`;
      const label = text(source["title"]) ?? text(source["name"]) ?? id;
      const url = text(source["url"]);
      const heading = url ? `[${escapeLabel(label)}](<${url}>)` : `**${escapeLabel(label)}**`;
      const body = text(source["snippet"]) ?? text(source["text"]);
      return body ? `- ${heading}\n${quote(body).replace(/^/gmu, "  ")}` : `- ${heading}`;
    });
    return rows.join("\n");
  };

  const inlineHtml = (html: string): MarkdownExportPart[] => {
    const result: MarkdownExportPart[] = [];
    let cursor = 0;
    for (const image of htmlResourceImages(html)) {
      result.push(html.slice(cursor, image.start));
      const resource = resources.get(image.id);
      if (!resource) throw new TypeError(`Unknown inline image resource: ${image.id}`);
      const tag = inertHtmlFragment(html.slice(image.start, image.end), { preserveEmbeddedImages: true }) ?? "";
      const slot = htmlResourceImages(tag)[0];
      if (!slot) throw new TypeError("Inline image reference was lost during export");
      const before = tag.slice(0, slot.attributeStart), after = tag.slice(slot.attributeEnd);
      if (resource["availability"] === "embedded") {
        const prefix = `${before}src="data:${escapeHtml(text(resource["mime"]) ?? "application/octet-stream")};base64,`, suffix = `"${after}`;
        result.push(resource["bytes"] === 0 ? prefix + suffix : { kind: "embedded_resource", resource: image.id, prefix, suffix });
      }
      else if (resource["availability"] === "external" && text(resource["url"])) {
        const url = String(resource["url"]);
        if (/^https?:\/\//iu.test(url)) result.push(`${before}src="${escapeHtml(url)}"${after}`);
        else result.push(escapeHtml(image.alt || text(resource["name"]) || ""));
      } else result.push(escapeHtml(image.alt || text(resource["name"]) || ""));
      cursor = image.end;
    }
    result.push(html.slice(cursor));
    return result;
  };
  const asParts = (value: string | readonly MarkdownExportPart[]): readonly MarkdownExportPart[] => typeof value === "string" ? [value] : value;
  const nestedParts = (block: JsonObject): MarkdownExportPart[] => (Array.isArray(block["content"]) ? block["content"].filter(isJsonObject) : [])
    .flatMap(child => [...asParts(blockMarkdown(child)), "\n\n"]);
  const foldParts = (title: string, body: readonly MarkdownExportPart[]): MarkdownExportPart[] =>
    [`<details>\n<summary>${escapeHtml(line(title))}</summary>\n\n`, ...body, "\n\n</details>"];

  const blockMarkdown = (block: JsonObject, preserveUserLines = false): string | readonly MarkdownExportPart[] => {
    const type = text(block["type"]) ?? "unknown";
    const nativeCard = dilReference(block), savedCard = nativeCard && savedDil(nativeCard);
    if (savedCard) return [quote(dilText(savedCard))];
    if (type === "markdown") return text(block["text"]) ?? "";
    if (type === "text") return fenced(text(block["text"]) ?? "", "text");
    if (type === "code") return fenced(text(block["code"]) ?? "", text(block["language"]) ?? "text");
    if (type === "math") {
      const tex = text(block["tex"]);
      if (tex) return block["display"] === false ? `\\(${tex}\\)` : `\\[\n${tex}\n\\]`;
      return text(block["mathml"]) ?? "";
    }
    if (type === "html") {
      const html = text(block["html"]) ?? "";
      return inlineHtml(preserveUserLines ? inertHtmlFragment(html, { preserveEmbeddedImages: true, preserveUserLines: true }) ?? "" : html);
    }
    if (type === "reasoning" || type === "reasoning_summary" || type === "status") {
      const title = text(block["title"]) ?? (type === "status" ? copy.status : copy.reasoning);
      const children = nestedParts(block);
      const raw = text(block["text"]) ?? (children.length ? "" : title);
      const format = text(block["format"]);
      const body = !raw ? [] : format === "html" ? inlineHtml(raw) : [format === "markdown" ? raw : fenced(raw, "text")];
      const facts = [
        typeof block["duration"] === "number" ? `${copy.duration}: ${block["duration"]}s` : undefined,
        text(block["effort"]) ? `${copy.effort}: ${text(block["effort"])}` : undefined
      ].filter((entry): entry is string => entry !== undefined);
      return foldParts(title, [...body, ...(facts.length > 0 ? [`\n\n_${facts.join(" · ")}_`] : []), "\n\n", ...children]);
    }
    if (type === "image") {
      const id = text(block["resource"]);
      const alt = text(block["alt"]) ?? text(block["caption"]) ?? resources.get(id ?? "")?.["name"] as string | undefined ?? copy.resource;
      const image = resourceLink(id, alt, true);
      return text(block["caption"]) ? `${image}\n\n_${text(block["caption"])}_` : image;
    }
    if (type === "attachment") {
      const id = text(block["resource"]);
      return resourceLink(id, text(block["text"]) ?? text(resources.get(id ?? "")?.["name"]) ?? copy.resource);
    }
    if (type === "search") {
      const title = text(block["query"]) ?? copy.search;
      const facts = [text(block["status"]), typeof block["duration"] === "number" ? `${block["duration"]}s` : undefined]
        .filter((entry): entry is string => entry !== undefined);
      const ids = Array.isArray(block["sources"]) ? block["sources"].filter((entry): entry is string => typeof entry === "string") : [];
      return `**${copy.search}: ${escapeLabel(title)}${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}**${ids.length > 0 ? `\n\n${sourceList(ids)}` : ""}`;
    }
    if (type === "citations") {
      const ids = Array.isArray(block["sources"]) ? block["sources"].filter((entry): entry is string => typeof entry === "string") : [];
      return `**${escapeLabel(text(block["label"]) ?? copy.citations)}**${ids.length > 0 ? `\n\n${sourceList(ids)}` : ""}`;
    }
    if (type === "tool") {
      const kind = text(block["kind"]);
      const label = kind === "call" ? copy.toolCall : kind === "result" ? copy.toolResult : copy.toolActivity;
      const title = text(block["title"]) ?? text(block["name"]) ?? label;
      const body: string[] = [];
      if (block["input"] !== undefined) body.push(`**${copy.input}**\n\n${json(block["input"]!)}`);
      if (text(block["input_resource"])) body.push(`**${copy.input}**\n\n${resourceLink(text(block["input_resource"]), copy.input)}`);
      if (block["output"] !== undefined) body.push(`**${copy.output}**\n\n${json(block["output"]!)}`);
      if (text(block["output_resource"])) body.push(`**${copy.output}**\n\n${resourceLink(text(block["output_resource"]), copy.output)}`);
      const facts = [
        text(block["status"]),
        typeof block["success"] === "boolean" ? String(block["success"]) : undefined,
        typeof block["duration"] === "number" ? `${block["duration"]}s` : undefined
      ].filter((entry): entry is string => entry !== undefined);
      if (facts.length > 0) body.unshift(`_${facts.join(" · ")}_`);
      const children = nestedParts(block);
      return foldParts(`${label} · ${title}`, [body.length > 0 ? body.join("\n\n") : children.length ? "" : copy.noVisibleContent, "\n\n", ...children]);
    }
    if (type === "interactive") {
      const heading = `**${escapeLabel(text(block["title"]) ?? text(block["source"]) ?? "Box / Window")}**`;
      const files = Array.isArray(block["files"]) ? block["files"].filter(isJsonObject) : [];
      return [heading, ...(block["data"] !== undefined ? ["\n\n", json(block["data"]!)] : []),
        ...files.map(file => `\n\n${resourceLink(text(file["resource"]), text(file["path"]) ?? copy.resource)}`)];
    }
    if (type === "diagram") {
      const format = text(block["format"]) ?? "text";
      const body = text(block["source"]) ? [fenced(text(block["source"])!, format)] : inlineHtml(text(block["html"]) ?? "");
      const rendered = text(block["rendered"])
        ? `\n\n${resourceLink(text(block["rendered"]), copy.renderedDiagram, true)}`
        : "";
      return [`**${copy.diagram} · ${escapeLabel(format)}**\n\n`, ...body, rendered];
    }
    const kind = text(block["kind"]) ?? type;
    const body = [text(block["text"]), text(block["resource"]) ? resourceLink(text(block["resource"]), kind) : undefined]
      .filter((entry): entry is string => entry !== undefined)
      .join("\n\n");
    return [`> **${copy.unknown} · ${escapeLabel(kind)}**${body ? `\n>\n${quote(body)}` : ""}`, ...(text(block["html"]) ? ["\n\n", ...inlineHtml(String(block["html"]))] : []), ...nestedParts(block)];
  };

  const source = object(conversation["source"]);
  const title = input.resolved.conversationName ?? text(conversation["title"]) ?? text(source?.["file"]) ?? archive;
  if (input.includeHeader !== false) parts.push(`# ${line(title)}\n\n`);
  const metadata = [
    `- **${copy.platform}**: ${escapeLabel(input.resolved.platform)}`,
    ...(input.resolved.models.length > 0 ? [`- **${copy.models}**: ${input.resolved.models.map(escapeLabel).join(", ")}`] : []),
    `- **${copy.contentTime}**: ${escapeLabel(formatContentTime(input.resolved, input.locale, copy))}`,
    ...(text(source?.["file"]) ? [`- **${copy.sourceFile}**: ${escapeLabel(text(source?.["file"])!)}`] : []),
    `- **${copy.archive}**: ${identityText}`,
    `- **${copy.messages}**: ${selectedMessages.length}`,
    ...(selection.tree && selection.selected ? [`- **${copy.branch}**: ${escapeLabel(selection.selected)}`] : [])
  ];
  if (input.includeHeader !== false) parts.push(`${metadata.join("\n")}\n\n---\n\n`);

  for (const { message, blocks } of selectedMessages) {
    const heading = [roleName(message, input.resolved, copy), text(message["timestamp"]), text(message["model"])]
      .filter((entry): entry is string => entry !== undefined)
      .map(line)
      .join(" · ");
    if (blocks.length === 0) parts.push(`## ${heading}\n\n*${copy.noVisibleContent}*\n\n`);
    let lastHeading: string | undefined;
    for (const block of blocks) {
      const actor = isJsonObject(block["party"]) ? block["party"] : undefined;
      const system = actor?.["role"] === "system";
      const currentHeading = system ? [copy.system, text(actor["name"])].filter(Boolean).map(value => line(value!)).join(" · ") : heading;
      if (currentHeading !== lastHeading) parts.push(`## ${currentHeading}\n\n`);
      lastHeading = currentHeading;
      parts.push(...asParts(blockMarkdown(block, !system && message["role"] === "user")), "\n\n");
    }
  }

  if (!wanted) {
    const images = conversationImages(conversation);
    if (images.length) {
      parts.push(input.locale === 'en' ? '## Conversation images\n\nImages saved with this conversation without an available message location.\n\n'
        : '## 会话附图\n\n随本篇保存、但无法定位到原消息的图片。\n\n');
      for (const image of images) parts.push(resourceLink(String(image['id']), text(image['name']) ?? copy.resource, true), '\n\n');
    }
  }
  if (input.includeHeader !== false) parts.push(`<!-- Cloudig Markdown export · ${identityText}${selection.selected ? ` · branch ${selection.selected}` : ""} -->\n`);
  for (const id of usedResources) {
    const resource = resources.get(id)!;
    const availability = text(resource["availability"]);
    const name = reference(id);
    if (availability === "external" && text(resource["url"])) {
      parts.push(`[${name}]: <${text(resource["url"])}>\n`);
      continue;
    }
    if (availability !== "embedded") continue;
    const mime = text(resource["mime"]) ?? "application/octet-stream";
    const bytes = typeof resource["bytes"] === "number" ? resource["bytes"] : 0;
    if (bytes === 0) parts.push(`[${name}]: <data:${mime};base64,>\n`);
    else parts.push({ kind: "embedded_resource", resource: id, prefix: `[${name}]: <data:${mime};base64,`, suffix: ">\n" });
  }

  return {
    parts,
    ...(selection.selected ? { selectedLeaf: selection.selected } : {}),
    messageCount: selectedMessages.length
  };
}

export function buildRecordMarkdown(input: Readonly<{
  conversation: JsonObject; resolved: RecordPresentation; mark?: JsonObject; locale: MarkdownExportLocale;
  selectedLeaf?: string; branchChoices?: Readonly<Record<string, string>>;
  contentMode?: ContentMode; messageIds?: readonly string[]; includeHeader?: boolean;
  resourceBodies?: ReadonlyMap<string, ObservedRecordResource>;
}>): MarkdownExportPlan {
  const valid = input.resourceBodies ? validateConversationRecordMetadata(input.conversation, input.resourceBodies) : validateRecord("conversation", input.conversation);
  if (!valid.ok) throw new TypeError("Invalid Conversation for Markdown export");
  if (input.mark && (!validateRecord("mark", input.mark).ok || input.mark["target"] !== input.conversation["conversation_id"])) throw new TypeError("Invalid or unrelated Mark for export");
  return buildConversationMarkdown({ ...input, conversation: projectRecordForReading(input.conversation, input.resolved, input.mark) });
}
