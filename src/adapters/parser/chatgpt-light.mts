import { canonicalizeJcs } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { AdapterManifest, AdapterParseContext, SourceAdapter } from "../../app/parser/adapter.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";
import { normalizeMermaidSource, projectMarkdownWithDiagrams } from "./markdown-diagrams.mts";
import { extractMermaidCardsFromFragment } from "./reading-evidence.mts";
import { parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { compactCapturedMath, inertHtmlEvidence } from "./inert-html.mts";

export const CHATGPT_LIGHT_MANIFEST: AdapterManifest = {
  id: "chatgpt-light-items-v2",
  version: "3.0.4",
  family: "chatgpt",
  routes: [{
    format: "exporter-html",
    platform: "chatgpt",
    payload: "osis.chatgpt.chat-export/light-items-v2",
    profile: "light"
  }],
  target: "cloudig/conversation/1.0.0",
  update_from: [{
    adapter: "chatgpt-light-items-v2",
    version: "1.3.0",
    action: "reparse_source"
  }, ...["2.0.0", "2.0.1", "3.0.0", "3.0.1", "3.0.2", "3.0.3"].map(version => ({ adapter: "chatgpt-light-items-v2", version, action: "reparse_source" as const }))]
};

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function values(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function sourceText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function httpUrl(value: JsonValue | undefined): string | undefined {
  const text = sourceText(value);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}

function timestamp(value: JsonValue | undefined): string | undefined {
  let date: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value > 0 && value < 10_000_000_000 ? value * 1000 : value);
  } else if (typeof value === "string" && value.length > 0) {
    date = new Date(value);
  } else {
    return undefined;
  }
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}


function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return /^[a-z]/u.test(normalized) ? normalized.slice(0, 128) : `unknown-${normalized || "item"}`.slice(0, 128);
}

type HtmlElement = DefaultTreeAdapterTypes.Element;
function htmlElements(root: DefaultTreeAdapterTypes.ParentNode): HtmlElement[] {
  return root.childNodes.flatMap(node => "tagName" in node ? [node, ...htmlElements(node)] : []);
}
function htmlAttribute(node: HtmlElement, name: string): string | undefined { return node.attrs.find(attribute => attribute.name === name)?.value; }
function htmlClass(node: HtmlElement, name: string): boolean { return (htmlAttribute(node, "class") ?? "").split(/\s+/u).includes(name); }
function htmlText(node: DefaultTreeAdapterTypes.ParentNode): string { return node.childNodes.map(child => "value" in child ? child.value : "childNodes" in child ? htmlText(child) : "").join(""); }
function readingBodyMap(context: AdapterParseContext): ReadonlyMap<string, string> {
  const result = new Map((context.reading?.fragments ?? []).map(fragment => [fragment.messageId, fragment.html]));
  for (const [turn, raw] of Object.entries(object(context.payload["rendered_turns"]) ?? {})) {
    if (typeof raw !== "string") continue;
    for (const article of htmlElements(parseFragment(raw)).filter(node => node.tagName === "article")) {
      const id = htmlAttribute(article, "data-message-id");
      if (id) result.set(`${turn}\0${id}`, serialize(article));
    }
  }
  return result;
}

function recordedTextBody(item: JsonObject, ownerIds: readonly string[], reading: ReadonlyMap<string, string> | undefined,
  resources: ResourcePool, mermaid: MermaidEvidence): JsonObject[] | undefined {
  const parts = values(item["parts"]);
  if (!reading || parts.length === 0 || parts.some(raw => object(raw)?.["type"] !== "md")) return undefined;
  const ids = [sourceText(item["message_id"]), sourceText(item["node_id"])].filter((id): id is string => Boolean(id));
  const raw = [...ownerIds.flatMap(owner => ids.map(id => `${owner}\0${id}`)), ...ids].map(id => reading.get(id)).find(Boolean);
  if (!raw) return undefined;
  const tree = parseFragment(raw);
  const body = htmlElements(tree).find(node => htmlClass(node, item["kind"] === "user" ? "user-bubble" : "answer"));
  if (!body) return undefined;
  const elements = htmlElements(body);
  if (elements.some(node => node.tagName === "img" || htmlClass(node, "attachment"))) return undefined;
  if (elements.some(node => (htmlClass(node, "osis-mermaid-card") || htmlClass(node, "writing-block")) && node.parentNode !== body)) return undefined;
  compactCapturedMath(body);
  const result: JsonObject[] = [];
  let pending = "";
  const flush = () => { const html = inertHtmlEvidence(pending).html; if (html) result.push({ type: "html", html }); pending = ""; };
  for (const node of body.childNodes) {
    if ("tagName" in node && htmlClass(node, "osis-mermaid-card")) {
      flush();
      const code = htmlElements(node).find(child => child.tagName === "code");
      const source = code ? htmlText(code) : "";
      const preview = mermaid.take(unique([...ownerIds, ...ids]), source);
      if (source || preview) result.push({ type: "diagram", format: "mermaid", ...(source ? { source } : {}), ...(preview ? { rendered: resources.addRenderedDiagram(preview.dataUrl) } : {}) });
    } else if ("tagName" in node && htmlClass(node, "writing-block")) {
      flush();
      const html = inertHtmlEvidence(serializeOuter(node)).html;
      if (html) result.push({ type: "diagram", format: "writing-block", html });
    } else pending += serializeOuter(node);
  }
  flush();
  return result.length > 0 ? result : undefined;
}

function sparseKey(values: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

class ResourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();
  readonly #sourceById = new Map<string, JsonObject>();

  constructor(rawResources?: JsonValue) {
    for (const [key, raw] of objectEntries(rawResources)) {
      const id = sourceText(raw["id"]) ?? key;
      if (!id) throw new TypeError("ChatGPT resource has no source id");
      if (this.#sourceById.has(id)) throw new TypeError("ChatGPT resource source id is duplicated");
      this.#sourceById.set(id, raw);
    }
  }

  addPart(raw: JsonObject): string | undefined {
    const resourceId = sourceText(raw["resource_id"]);
    const source = resourceId ? this.#sourceById.get(resourceId) : undefined;
    const sourceData = sourceText(source?.["src"]);
    const resolved: JsonObject = source ? {
      ...source,
      ...raw,
      ...(sourceData?.startsWith("data:") ? { src: sourceData } : {})
    } : raw;
    const type = sourceText(resolved["type"] ?? raw["type"]);
    if (type === "img") return this.#addImage(resolved);
    if (type === "attachment") return this.#addAttachment(resolved);
    return undefined;
  }

  addRenderedDiagram(dataUrl: string): string {
    const embedded = embeddedImageDataUrl(dataUrl);
    const sha256 = embedded.sha256;
    return this.#allocate(`diagram\u0000${embedded.mime}\u0000${sha256}`, {
      kind: "diagram",
      availability: "embedded",
      mime: embedded.mime,
      bytes: embedded.byteLength,
      sha256,
      ...(embedded.byteLength === 0 ? {} : { data_base64: embedded.dataBase64 })
    });
  }

  #allocate(key: string, resource: Omit<JsonObject, "id">): string {
    // Equal bytes do not make filenames, dimensions or source facts equal.
    // Do not hash the large Base64 body again: its digest is already in key.
    const metadata = { ...resource }; delete metadata["data_base64"];
    const identity = `${key}\u0000${canonicalizeJcs(metadata)}`;
    const existing = this.#byKey.get(identity);
    if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource });
    this.#byKey.set(identity, id);
    return id;
  }

  #addImage(raw: JsonObject): string {
    const source = sourceText(raw["src"]);
    const declaredMime = sourceText(raw["mime_type"])?.toLowerCase();
    if (source?.startsWith("data:")) {
      const embedded = embeddedImageDataUrl(source);
      if (declaredMime && declaredMime !== embedded.mime) throw new TypeError("ChatGPT image MIME metadata disagrees with embedded bytes");
      const embeddedSize = nonNegativeInteger(raw["embedded_size"]);
      if (embeddedSize !== undefined && embeddedSize !== embedded.byteLength) {
        throw new TypeError("ChatGPT image embedded size disagrees with its bytes");
      }
      const sha256 = embedded.sha256;
      const width = nonNegativeInteger(raw["width"]);
      const height = nonNegativeInteger(raw["height"]);
      return this.#allocate(`embedded\u0000${embedded.mime}\u0000${sha256}`, {
        kind: "image",
        availability: "embedded",
        ...(sourceText(raw["name"]) ? { name: sourceText(raw["name"])! } : {}),
        mime: embedded.mime,
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength === 0 ? {} : { data_base64: embedded.dataBase64 }),
        ...(width !== undefined && height !== undefined ? { dimensions: { width, height } } : {}),
        ...(sourceText(raw["mime_type"]) ? { original_mime: sourceText(raw["mime_type"])! } : {}),
        ...(nonNegativeInteger(raw["source_size"]) !== undefined ? { original_bytes: nonNegativeInteger(raw["source_size"])! } : {})
      });
    }
    const url = httpUrl(raw["src"]);
    const key = sourceText(raw["id"]) ?? canonicalizeJcs(sparseKey({ type: "img", name: raw["name"], mime: declaredMime, url }));
    return this.#allocate(`image\u0000${key}`, {
      kind: "image",
      availability: url ? "external" : raw["availability"] === "missing" ? "missing" : "metadata_only",
      ...(sourceText(raw["name"]) ? { name: sourceText(raw["name"])! } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(url ? { url } : {})
    });
  }

  #addAttachment(raw: JsonObject): string {
    const source = sourceText(raw["src"]);
    const declaredMime = sourceText(raw["mime_type"])?.toLowerCase();
    if (source?.startsWith("data:")) {
      const embedded = embeddedBase64DataUrl(source);
      if (declaredMime && declaredMime !== embedded.mime) throw new TypeError("ChatGPT attachment MIME metadata disagrees with embedded bytes");
      const embeddedSize = nonNegativeInteger(raw["embedded_size"]);
      if (embeddedSize !== undefined && embeddedSize !== embedded.byteLength) {
        throw new TypeError("ChatGPT attachment embedded size disagrees with its bytes");
      }
      const sha256 = embedded.sha256;
      return this.#allocate(`file\u0000${embedded.mime}\u0000${sha256}`, {
        kind: "file",
        availability: "embedded",
        ...(sourceText(raw["name"]) ? { name: sourceText(raw["name"])! } : {}),
        mime: embedded.mime,
        bytes: embedded.byteLength,
        sha256,
        ...(embedded.byteLength === 0 ? {} : { data_base64: embedded.dataBase64 })
      });
    }
    const key = sourceText(raw["id"]) ?? canonicalizeJcs(sparseKey({
      type: "attachment",
      name: raw["name"],
      mime: raw["mime_type"],
      bytes: raw["size_bytes"]
    }));
    return this.#allocate(`attachment\u0000${key}`, {
      kind: "file",
      availability: raw["availability"] === "missing" ? "missing" : "metadata_only",
      ...(sourceText(raw["name"]) ? { name: sourceText(raw["name"])! } : {}),
      ...(declaredMime ? { mime: declaredMime } : {}),
      ...(nonNegativeInteger(raw["size_bytes"]) !== undefined ? { bytes: nonNegativeInteger(raw["size_bytes"])! } : {})
    });
  }
}

class SourcePool {
  readonly values: JsonObject[] = [];
  readonly #byKey = new Map<string, string>();

  add(raw: JsonObject, fallbackKind: "web" | "past_chat" | "saved_memory"): string | undefined {
    const declared = sourceText(raw["kind"]);
    const kind = declared === "past_chat" || declared === "saved_memory" ? declared : fallbackKind;
    const url = httpUrl(raw["url"]);
    if (kind === "web" && !url) return undefined;
    const title = sourceText(raw["title"]);
    const snippet = sourceText(raw["snippet"]);
    const key = canonicalizeJcs(sparseKey({ citation_uuid: raw["citation_uuid"], kind, title, snippet, url }));
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = `s${this.values.length + 1}`;
    this.values.push({
      id,
      kind,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(snippet ? { snippet } : {})
    });
    this.#byKey.set(key, id);
    return id;
  }
}

type MermaidRecord = Readonly<{ messageId: string; source: string; dataUrl: string }>;

class MermaidEvidence {
  readonly #records: Array<{ record: MermaidRecord; used: boolean }>;

  constructor(records: readonly MermaidRecord[]) {
    this.#records = records.map((record) => ({ record, used: false }));
  }

  take(ownerIds: readonly string[], source: string): MermaidRecord | undefined {
    const normalized = normalizeMermaidSource(source);
    const found = this.#records.find((entry) => (
      !entry.used
      && ownerIds.includes(entry.record.messageId)
      && normalizeMermaidSource(entry.record.source) === normalized
    ));
    if (!found) return undefined;
    found.used = true;
    return found.record;
  }

  remaining(): readonly MermaidRecord[] {
    return this.#records.filter((entry) => !entry.used).map((entry) => entry.record);
  }
}

function attachRemainingMermaid(
  mermaid: MermaidEvidence,
  contentBySourceId: ReadonlyMap<string, JsonObject[]>,
  resources: ResourcePool,
  limitations: JsonObject[]
): void {
  let orphaned = 0;
  for (const record of mermaid.remaining()) {
    const content = contentBySourceId.get(record.messageId);
    if (content) {
      content.push({ type: "diagram", format: "mermaid", rendered: resources.addRenderedDiagram(record.dataUrl) });
    } else {
      orphaned += 1;
    }
  }
  if (orphaned > 0) limitations.push({ code: "chatgpt-unowned-mermaid-preview", detail: `${orphaned} reading preview(s) lacked a message owner` });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sourceIds(raw: JsonValue | undefined, pool: SourcePool, kind: "web" | "past_chat" | "saved_memory"): string[] {
  return unique(values(raw).flatMap((entry) => {
    const source = object(entry);
    const id = source ? pool.add(source, kind) : undefined;
    return id ? [id] : [];
  }));
}

function memorySourceIds(raw: JsonValue | undefined, pool: SourcePool): string[] {
  return unique(values(raw).flatMap((entry) => {
    const source = object(entry);
    if (!source) return [];
    const kind = source["kind"] === "past_chat" ? "past_chat" : "saved_memory";
    const id = pool.add(source, kind);
    return id ? [id] : [];
  }));
}

type ScheduleState = Readonly<{
  tasks: ReadonlyMap<string, JsonObject>;
  listsByMessage: ReadonlyMap<string, readonly JsonObject[]>;
  current?: JsonObject;
}>;

function objectEntries(value: JsonValue | undefined): Array<readonly [string, JsonObject]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      const record = object(entry);
      return record ? [[String(index), record] as const] : [];
    });
  }
  const record = object(value);
  return record
    ? Object.entries(record).flatMap(([key, entry]) => {
      const child = object(entry);
      return child ? [[key, child] as const] : [];
    })
    : [];
}

function scheduleState(payload: JsonObject): ScheduleState {
  const tasks = new Map<string, JsonObject>();
  const components = object(payload["scheduled_components"]);
  for (const [key, task] of objectEntries(components?.["tasks"])) {
    const id = sourceText(task["id"]) ?? key;
    if (id) tasks.set(id, task);
  }
  const current = object(payload["scheduled_task"]);
  const currentId = sourceText(current?.["id"]);
  if (current && currentId) tasks.set(currentId, current);
  const listsByMessage = new Map<string, JsonObject[]>();
  for (const [, list] of objectEntries(components?.["lists"])) {
    const messageId = sourceText(list["message_id"]);
    if (!messageId) continue;
    const existing = listsByMessage.get(messageId) ?? [];
    existing.push(list);
    listsByMessage.set(messageId, existing);
  }
  return { tasks, listsByMessage, ...(current ? { current } : {}) };
}

function scheduleTaskTitle(task: JsonObject | undefined, fallback?: JsonObject): string | undefined {
  return sourceText(task?.["title"] ?? task?.["display_title"] ?? fallback?.["title"]);
}

function scheduleTaskView(task: JsonObject | undefined, fallback?: JsonObject): JsonObject {
  const title = scheduleTaskTitle(task, fallback);
  const displaySchedule = sourceText(fallback?.["schedule_label"] ?? task?.["display_schedule"] ?? task?.["schedule"]);
  const lastRun = timestamp(task?.["last_run_time"]);
  const nextRun = timestamp(values(task?.["next_run_times"])[0]);
  const timezone = sourceText(task?.["default_timezone"]);
  const prompt = sourceText(task?.["prompt"]);
  const conversationId = sourceText(task?.["conversation_id"]);
  const all: JsonObject = {
    ...(task ? { source_task: structuredClone(task) } : {}),
    ...(title ? { title } : {}),
    ...(typeof task?.["is_enabled"] === "boolean" ? { enabled: task["is_enabled"] } : {}),
    ...(displaySchedule ? { schedule: displaySchedule } : {}),
    ...(lastRun ? { last_run_at: lastRun } : {}),
    ...(nextRun ? { next_run_at: nextRun } : {}),
    ...(timezone ? { timezone } : {}),
    ...(typeof task?.["notifications_enabled"] === "boolean" ? { notifications_enabled: task["notifications_enabled"] } : {}),
    ...(prompt ? { prompt } : {}),
    ...(conversationId ? { conversation_url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` } : {})
  };
  return all;
}

function scheduleListBlocks(item: JsonObject, state: ScheduleState): JsonObject[] {
  if (item["kind"] !== "assistant") return [];
  const messageId = sourceText(item["message_id"] ?? item["node_id"]);
  if (!messageId) return [];
  return (state.listsByMessage.get(messageId) ?? []).flatMap((list) => {
    const tasks = values(list["tasks"]).flatMap((value) => {
      const row = object(value);
      if (!row) return [];
      const task = state.tasks.get(sourceText(row["id"]) ?? "");
      const view = scheduleTaskView(task, row);
      return Object.keys(view).length > 0 ? [view] : [];
    });
    if (tasks.length === 0) return [];
    const allTasksUrl = httpUrl(list["all_tasks_url"]);
    const input: JsonObject = {
      kind: "task-list",
      tasks,
      ...(allTasksUrl ? { all_tasks_url: allTasksUrl } : {})
    };
    return [{
      type: "tool",
      kind: "activity",
      name: "schedule",
      ...(sourceText(list["heading"]) ? { title: sourceText(list["heading"])! } : {}),
      input
    }];
  });
}

function scheduledTaskName(items: readonly JsonObject[], state: ScheduleState): string | undefined {
  const ids = unique(items.flatMap((item) => sourceText(item["scheduled_task_id"]) ? [sourceText(item["scheduled_task_id"])!] : []));
  if (ids.length !== 1) return undefined;
  return scheduleTaskTitle(state.tasks.get(ids[0]!));
}

function scheduledTaskHeader(payload: JsonObject, state: ScheduleState): JsonObject | undefined {
  if (payload["entry_surface"] !== "scheduled_task" || !state.current) return undefined;
  const input = scheduleTaskView(state.current);
  if (Object.keys(input).length === 0) return undefined;
  return {
    type: "tool",
    kind: "activity",
    name: "schedule",
    ...(scheduleTaskTitle(state.current) ? { title: scheduleTaskTitle(state.current)! } : {}),
    input: { kind: "scheduled-task", ...input }
  };
}

function thoughtBlocks(item: JsonObject): JsonObject[] {
  const thoughts = values(item["thoughts"]).flatMap((raw) => {
    const thought = object(raw);
    if (!thought) return [];
    const summary = sourceText(thought["summary"]);
    const body = sourceText(thought["content"]);
    return summary || body ? [{ summary, body }] : [];
  });
  const withBody = new Set(thoughts.filter((entry) => entry.summary && entry.body).map((entry) => entry.summary));
  const seen = new Set<string>();
  const result: JsonObject[] = [];
  for (const thought of thoughts) {
    if (thought.summary && !thought.body && withBody.has(thought.summary)) continue;
    const key = `${thought.summary ?? ""}\u0000${thought.body ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      type: thought.summary ? "reasoning_summary" : "reasoning",
      ...(thought.body ? { text: thought.body } : {}),
      ...(thought.summary ? { title: thought.summary } : {}),
      ...(sourceText(item["effort"]) ? { effort: sourceText(item["effort"])! } : {})
    });
  }
  return result;
}

function recapBlock(item: JsonObject): JsonObject | undefined {
  let title = sourceText(item["text"]);
  if (!title) return undefined;
  const duration = positiveNumber(item["seconds"]);
  if (duration !== undefined && (/^思考了\s*/u.test(title) || /^(?:worked|thought|thinking)\s+for\s+/iu.test(title))) title = "思考";
  return {
    type: "status",
    title,
    ...(duration !== undefined ? { duration } : {}),
    ...(sourceText(item["effort"]) ? { effort: sourceText(item["effort"])! } : {})
  };
}

function projectParts(
  item: JsonObject,
  resources: ResourcePool,
  limitations: JsonObject[],
  mermaid: MermaidEvidence,
  additionalOwnerIds: readonly string[] = [],
  reading?: ReadonlyMap<string, string>
): JsonObject[] {
  const recorded = recordedTextBody(item, additionalOwnerIds, reading, resources, mermaid);
  if (recorded) return recorded;
  const result: JsonObject[] = [];
  const ownerIds = unique([
    ...additionalOwnerIds,
    ...[sourceText(item["message_id"]), sourceText(item["node_id"])].filter((entry): entry is string => entry !== undefined)
  ]);
  for (const raw of values(item["parts"])) {
    const part = object(raw);
    if (!part) continue;
    const type = sourceText(part["type"]);
    if (type === "md") {
      const text = sourceText(part["text"]);
      if (text) result.push(...projectMarkdownWithDiagrams(text, (source) => {
        const evidence = mermaid.take(ownerIds, source);
        return evidence ? resources.addRenderedDiagram(evidence.dataUrl) : undefined;
      }));
    } else if (type === "img" || type === "attachment") {
      const resource = resources.addPart(part);
      if (resource) result.push({ type: type === "img" ? "image" : "attachment", resource });
    } else {
      const text = sourceText(part["text"]);
      if (text) result.push({ type: "unknown", kind: slug(type ?? "chatgpt-part"), text });
      else limitations.push({ code: "chatgpt-unknown-part" });
    }
  }
  return result;
}

function projectItem(
  item: JsonObject,
  resources: ResourcePool,
  sources: SourcePool,
  limitations: JsonObject[],
  mermaid: MermaidEvidence,
  schedule: ScheduleState,
  additionalOwnerIds: readonly string[] = [],
  reading?: ReadonlyMap<string, string>
): JsonObject[] {
  const kind = sourceText(item["kind"]);
  const result: JsonObject[] = [];
  if (kind === "thinking") {
    result.push(...thoughtBlocks(item));
  } else if (kind === "recap") {
    const recap = recapBlock(item);
    if (recap) result.push(recap);
  } else if (kind === "code" && sourceText(item["recipient"])) {
    result.push({
      type: "tool",
      kind: "call",
      ...(sourceText(item["recipient"]) ? { name: sourceText(item["recipient"])! } : {}),
      ...(sourceText(item["text"]) ? { input: sourceText(item["text"])! } : {})
    });
  } else if (kind === "code") {
    const code = sourceText(item["text"]);
    if (code) result.push({ type: "code", code, ...(sourceText(item["lang"]) ? { language: sourceText(item["lang"])! } : {}) });
  } else if (kind === "tool") {
    const output = sourceText(item["text"]);
    const name = sourceText(item["name"]);
    if (output || name) result.push({ type: "tool", kind: "result", ...(name ? { name } : {}), ...(output ? { output } : {}) });
  } else if (kind === "user" || kind === "assistant" || kind === "assistant_asset") {
    result.push(...projectParts(item, resources, limitations, mermaid, additionalOwnerIds, reading));
  } else {
    const text = sourceText(item["text"]);
    if (text) result.push({ type: "unknown", kind: slug(kind ?? "chatgpt-item"), text });
    else limitations.push({ code: "chatgpt-unknown-item" });
  }

  result.push(...scheduleListBlocks(item, schedule));

  const web = sourceIds(item["sources"], sources, "web");
  const memory = memorySourceIds(item["memory_sources"], sources);
  const queries = unique(values(item["queries"]).flatMap((value) => sourceText(value) ? [sourceText(value)!] : []));
  if (queries.length > 0) {
    for (const query of queries) result.push({ type: "search", query, ...(web.length > 0 ? { sources: web } : {}) });
  } else if (kind === "tool" && web.length > 0) {
    result.push({ type: "search", sources: web });
  } else if (web.length > 0) {
    result.push({ type: "citations", sources: web });
  }
  if (memory.length > 0) result.push({ type: "citations", sources: memory });
  return result;
}

async function groupMessages(
  items: JsonValue[],
  resources: ResourcePool,
  sources: SourcePool,
  limitations: JsonObject[],
  mermaid: MermaidEvidence,
  schedule: ScheduleState,
  onProgress?: (completed: number, total: number) => void | Promise<void>,
  reading?: ReadonlyMap<string, string>,
  record?: AdapterParseContext["record"],
  offset = 0
): Promise<JsonObject[]> {
  const messages: JsonObject[] = [];
  const contentBySourceId = new Map<string, JsonObject[]>();
  let assistant: { content: JsonObject[]; items: JsonObject[]; models: string[]; timestamps: string[]; answerTimestamps: string[] } | undefined;
  let previousId = offset > 0 ? "schedule:header" : undefined;
  const observe = (id: string, role: string, model?: string): void => {
    record?.message(messages.length + offset, { id, ...(previousId ? { parent: previousId } : {}), role, ...(model ? { model } : {}) }); previousId = id;
  };
  const flushAssistant = (): void => {
    if (!assistant) return;
    const model = assistant.models[0];
    const timestamp = assistant.answerTimestamps.sort().at(-1) ?? assistant.timestamps.sort()[0];
    const name = scheduledTaskName(assistant.items, schedule);
    const answer = assistant.items.find(item => item["kind"] === "assistant" || item["kind"] === "assistant_asset") ?? assistant.items[0];
    observe(sourceText(answer?.["message_id"] ?? answer?.["node_id"]) ?? `group:${messages.length + offset + 1}`, "assistant", model);
    messages.push({ role: "assistant", ...(name ? { name } : {}), ...(model ? { model } : {}), ...(timestamp ? { timestamp } : {}), content: assistant.content });
    assistant = undefined;
  };
  for (const [index, raw] of items.entries()) {
    const item = object(raw);
    if (!item) throw new TypeError("ChatGPT item sequence contains a non-object entry");
    if (assistant) {
      const run = sourceText(item["scheduled_task_id"]) ? sourceText(item["message_id"] ?? item["node_id"]) : undefined;
      const priorRun = assistant.items.find(part => sourceText(part["scheduled_task_id"]));
      const priorId = sourceText(priorRun?.["message_id"] ?? priorRun?.["node_id"]);
      if ((run || priorId) && run !== priorId) flushAssistant();
    }
    if (item["kind"] === "user") {
      flushAssistant();
      const time = timestamp(item["created_at"]);
      const content = projectItem(item, resources, sources, limitations, mermaid, schedule, [], reading);
      observe(sourceText(item["message_id"] ?? item["node_id"]) ?? `group:${messages.length + offset + 1}`, "user");
      messages.push({ role: "user", ...(time ? { timestamp: time } : {}), content });
      for (const id of [sourceText(item["message_id"]), sourceText(item["node_id"])]) if (id) contentBySourceId.set(id, content);
    } else {
      assistant ??= { content: [], items: [], models: [], timestamps: [], answerTimestamps: [] };
      assistant.items.push(item);
      const projected = projectItem(item, resources, sources, limitations, mermaid, schedule, [], reading);
      const declaredModel = sourceText(item["model"]);
      if (declaredModel) for (const block of projected) record?.block(block, { role: "assistant", model: declaredModel });
      assistant.content.push(...projected);
      for (const id of [sourceText(item["message_id"]), sourceText(item["node_id"])]) if (id) contentBySourceId.set(id, assistant.content);
      const model = sourceText(item["model"]);
      if (model && !assistant.models.includes(model)) assistant.models.push(model);
      const time = timestamp(item["created_at"]);
      if (time) {
        assistant.timestamps.push(time);
        if (item["kind"] === "assistant" || item["kind"] === "assistant_asset") assistant.answerTimestamps.push(time);
      }
    }
    await onProgress?.(index + 1, items.length);
  }
  flushAssistant();
  attachRemainingMermaid(mermaid, contentBySourceId, resources, limitations);
  return messages;
}

type ChatGptRoute = Readonly<{ payload: string; profile: "light" | "full" | "tree" }>;

function chatGptDraft(input: Readonly<{
  context: AdapterParseContext;
  route: ChatGptRoute;
  messages: JsonObject[];
  resources: ResourcePool;
  sources: SourcePool;
  limitations: JsonObject[];
  models: string[];
  currentMessage?: string;
}>): JsonObject {
  const { context, route, messages, resources, sources, limitations, models } = input;
  const messageTimes = messages.flatMap((message) => typeof message["timestamp"] === "string" ? [message["timestamp"] as string] : []).sort();
  const capturedAt = timestamp(context.manifest["captured_at"] ?? context.manifest["exported_at"])
    ?? context.source.fileSystemCapturedAt;
  const title = sourceText(context.payload["title"] ?? context.manifest["title"]);
  const sourceUrl = httpUrl(context.manifest["source_url"] ?? object(context.manifest["source"])?.["url"]);
  const exporterVersion = sourceText(context.manifest["exporter_version"] ?? object(context.manifest["exporter"])?.["version"]);
  const conversationKey = sourceText(context.manifest["conversation_key"]);
  const firstMessageTime = messageTimes[0];
  return {
    source: {
      file: context.source.file,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      format: "exporter-html",
      payload: route.payload.replaceAll("/", "."),
      profile: route.profile,
      ...(exporterVersion ? { exporter: { id: "chatgpt-bookmarklet", version: exporterVersion } } : {}),
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(conversationKey ? { locator: { kind: "exporter_conversation_key", value: conversationKey } } : {}),
      ...(capturedAt ? { captured_at: { value: capturedAt, basis: context.source.fileSystemCapturedAt === capturedAt ? "file_system_earliest" : "manifest" } } : {})
    },
    content_time: { basis: "unavailable" },
    provider: "openai",
    platform: "chatgpt",
    ...(title ? { title } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(messageTimes.length > 0 ? { message_time: { start: messageTimes[0]!, ...(messageTimes.at(-1) !== messageTimes[0] ? { end: messageTimes.at(-1)! } : {}) } } : {}),
    ...(input.currentMessage ? { current_message: input.currentMessage } : {}),
    messages,
    ...(resources.values.length > 0 ? { resources: resources.values } : {}),
    ...(sources.values.length > 0 ? { sources: sources.values } : {}),
    ...(limitations.length > 0 ? { limitations: unique(limitations.map((entry) => canonicalizeJcs(entry))).map((entry) => JSON.parse(entry) as JsonObject) } : {})
  };
}

export async function parseChatGptItems(context: AdapterParseContext, route: ChatGptRoute): Promise<JsonObject> {
  const resources = new ResourcePool();
  const sources = new SourcePool();
  const limitations: JsonObject[] = [];
  const items = values(context.payload["items"]);
  const mermaid = new MermaidEvidence(context.reading?.mermaid ?? []);
  const schedule = scheduleState(context.payload);
  const header = scheduledTaskHeader(context.payload, schedule);
  if (header) context.record?.message(0, { id: "schedule:header", role: "system" });
  const messages = [
    ...(header ? [{
      role: "system",
      ...(sourceText(header["title"]) ? { name: sourceText(header["title"])! } : {}),
      content: [header]
    }] : []),
    ...await groupMessages(items, resources, sources, limitations, mermaid, schedule, context.onProgress, readingBodyMap(context), context.record, header ? 1 : 0)
  ];
  const models = unique(items.flatMap((value) => {
    const item = object(value);
    return item && sourceText(item["model"]) ? [sourceText(item["model"])!] : [];
  }));
  return chatGptDraft({ context, route, messages, resources, sources, limitations, models });
}

function stringValues(value: JsonValue | undefined): string[] {
  return values(value).flatMap((entry) => typeof entry === "string" && entry.length > 0 ? [entry] : []);
}

type TreeTurn = Readonly<{
  key: string;
  value: JsonObject;
  parent?: string;
  children: readonly string[];
  nodes: readonly string[];
}>;

function orderedTreeTurns(payload: JsonObject, limitations: JsonObject[]): TreeTurn[] {
  const record = object(payload["turns"]);
  if (!record) throw new TypeError("ChatGPT Tree payload has no turn graph");
  const turns = new Map<string, TreeTurn>();
  for (const [key, raw] of Object.entries(record)) {
    const value = object(raw);
    if (!value) throw new TypeError("ChatGPT Tree contains a non-object turn");
    const declared = sourceText(value["id"]);
    if (declared && declared !== key) throw new TypeError("ChatGPT Tree turn key and id disagree");
    turns.set(key, {
      key,
      value,
      ...(sourceText(value["parent"]) ? { parent: sourceText(value["parent"])! } : {}),
      children: stringValues(value["children"]),
      nodes: stringValues(value["node_ids"])
    });
  }

  const roots: string[] = [];
  const addRoot = (key: string): void => {
    if (turns.has(key) && !roots.includes(key)) roots.push(key);
  };
  for (const key of stringValues(payload["turn_roots"])) addRoot(key);
  for (const turn of turns.values()) {
    if (!turn.parent) {
      addRoot(turn.key);
    } else if (!turns.has(turn.parent)) {
      addRoot(turn.key);
      limitations.push({ code: "source_parent_omitted", detail: "A ChatGPT Tree turn referenced a parent omitted by the source payload" });
    } else if (!turns.get(turn.parent)!.children.includes(turn.key)) {
      throw new TypeError("ChatGPT Tree parent and child lists disagree");
    }
    const seenChildren = new Set<string>();
    for (const child of turn.children) {
      if (seenChildren.has(child)) throw new TypeError("ChatGPT Tree contains a duplicate child link");
      seenChildren.add(child);
      const target = turns.get(child);
      if (!target) {
        limitations.push({ code: "source_child_omitted", detail: "A ChatGPT Tree turn referenced a child omitted by the source payload" });
      } else if (target.parent !== turn.key) {
        throw new TypeError("ChatGPT Tree child and parent links disagree");
      }
    }
  }

  const ordered: TreeTurn[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): void => {
    const current = state.get(key);
    if (current === "done") return;
    if (current === "visiting") throw new TypeError("ChatGPT Tree turn graph contains a cycle");
    const turn = turns.get(key);
    if (!turn) return;
    state.set(key, "visiting");
    ordered.push(turn);
    for (const child of turn.children) visit(child);
    state.set(key, "done");
  };
  for (const root of roots) visit(root);
  if (ordered.length !== turns.size) throw new TypeError("ChatGPT Tree has no complete parent-first traversal");
  return ordered;
}

function treeRole(value: JsonValue | undefined): Readonly<{ role: "user" | "assistant" | "system" | "tool" | "other"; name?: string }> {
  const role = sourceText(value);
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return { role };
  return { role: "other", name: role ?? "ChatGPT" };
}

function treeRenderedMermaid(payload: JsonObject): readonly Readonly<{ messageId: string; source: string; dataUrl: string }>[] {
  const rendered = object(payload["rendered_turns"]);
  if (!rendered) return [];
  return Object.entries(rendered).flatMap(([turn, value]) => (
    typeof value === "string" ? extractMermaidCardsFromFragment(value, turn) : []
  ));
}

export async function parseChatGptTree(context: AdapterParseContext, route: ChatGptRoute): Promise<JsonObject> {
  if (context.payload["entry_surface"] === "scheduled_task" && Array.isArray(context.payload["items"])) {
    return parseChatGptItems(context, route);
  }
  const resources = new ResourcePool(context.payload["resources"]);
  const sources = new SourcePool();
  const limitations: JsonObject[] = [];
  const renderedMermaid = treeRenderedMermaid(context.payload);
  const mermaid = new MermaidEvidence(renderedMermaid.length > 0 ? renderedMermaid : context.reading?.mermaid ?? []);
  const schedule = scheduleState(context.payload);
  const turns = orderedTreeTurns(context.payload, limitations);
  const reading = readingBodyMap(context);
  const messageIds = new Map(turns.map((turn, index) => [turn.key, `m${index + 1}`]));
  const itemsByNode = object(context.payload["items_by_node"]) ?? {};
  const contentBySourceId = new Map<string, JsonObject[]>();
  const allModels: string[] = [];
  const totalItems = turns.reduce((total, turn) => total + turn.nodes.reduce((count, node) => count + values(itemsByNode[node]).length, 0), 0);
  let completedItems = 0;
  const messages: JsonObject[] = [];

  for (const [index, turn] of turns.entries()) {
    const items = turn.nodes.flatMap((node) => {
      const rawItems = itemsByNode[node];
      if (rawItems === undefined) return [];
      if (!Array.isArray(rawItems)) throw new TypeError("ChatGPT Tree node items are not an array");
      return rawItems.map((value) => {
        const item = object(value);
        if (!item) throw new TypeError("ChatGPT Tree node contains a non-object item");
        return item;
      });
    });
    const content: JsonObject[] = [];
    const models: string[] = [];
    const timestamps: string[] = [];
    const answerTimestamps: string[] = [];
    for (const item of items) {
      const projected = projectItem(item, resources, sources, limitations, mermaid, schedule, [turn.key], reading);
      const declaredModel = sourceText(item["model"]);
      if (declaredModel) for (const block of projected) context.record?.block(block, { role: "assistant", model: declaredModel });
      content.push(...projected);
      for (const id of [sourceText(item["message_id"]), sourceText(item["node_id"])]) if (id) contentBySourceId.set(id, content);
      const model = sourceText(item["model"]);
      if (model && !models.includes(model)) models.push(model);
      if (model && !allModels.includes(model)) allModels.push(model);
      const time = timestamp(item["created_at"]);
      if (time) {
        timestamps.push(time);
        if (item["kind"] === "assistant" || item["kind"] === "assistant_asset") answerTimestamps.push(time);
      }
      completedItems += 1;
      await context.onProgress?.(completedItems, totalItems);
    }
    const role = treeRole(turn.value["role"]);
    const parent = turn.parent ? messageIds.get(turn.parent) : undefined;
    context.record?.message(index, { id: turn.key, ...(turn.parent ? { parent: turn.parent } : {}), role: role.role, ...(models[0] ? { model: models[0] } : {}) });
    const time = role.role === "assistant"
      ? answerTimestamps.sort().at(-1) ?? timestamps.sort()[0]
      : timestamps.sort()[0];
    const name = role.role === "assistant" ? scheduledTaskName(items, schedule) : role.name;
    messages.push({
      id: messageIds.get(turn.key)!,
      ...(parent ? { parent } : {}),
      role: role.role,
      ...(name ? { name } : {}),
      ...(models.length === 1 ? { model: models[0]! } : {}),
      ...(time ? { timestamp: time } : {}),
      content
    });
  }
  attachRemainingMermaid(mermaid, contentBySourceId, resources, limitations);
  const currentTurn = sourceText(context.payload["current_turn"]);
  const currentMessage = currentTurn ? messageIds.get(currentTurn) : undefined;
  return chatGptDraft({
    context,
    route,
    messages,
    resources,
    sources,
    limitations,
    models: allModels,
    ...(currentMessage ? { currentMessage } : {})
  });
}

export const chatGptLightAdapter: SourceAdapter = Object.freeze({
  manifest: CHATGPT_LIGHT_MANIFEST,
  parse: (context) => parseChatGptItems(context, {
    payload: "osis.chatgpt.chat-export/light-items-v2",
    profile: "light"
  })
});
