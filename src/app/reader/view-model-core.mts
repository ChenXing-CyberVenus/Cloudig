// Shared, side-effect-free projection of already validated conversations.
// Desktop validation stays in view-model.mts; the documentation site validates
// its finite public examples at build time and uses this same projection.
import type { ResolvedArchiveView } from "../../core/library/overlay.mts";
import type { ObservedResourceBody } from "../../core/contracts/semantic-conversation.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { RecordPresentation } from "../../core/records/presentation.mts";
import { blockHtml, htmlResourceImages } from "../../core/records/html-resources.mts";
import { conversationImages } from '../../core/records/conversation-images.mts';
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { blockCategory } from "./content-selection.mts";
import { isSummaryContent } from "./summary-sequence.mts";

export type ReaderSessionPreferences = Readonly<{
  selectedLeaf?: string;
  branchChoices?: Readonly<Record<string, string>>;
  expanded: Readonly<{
    reasoning: boolean;
    tools: boolean;
    references: boolean;
  }>;
  hidden: Readonly<{
    reasoning: boolean;
    tools: boolean;
  }>;
  navigation: Readonly<{
    user: boolean;
    assistant: boolean;
    process: boolean;
  }>;
}>;

export type ConversationPageRequest = Readonly<{
  offset: number;
  limit: number;
}>;

export type ConversationViewSource = Readonly<{
  conversation: JsonObject;
  resolved: ResolvedArchiveView | RecordPresentation;
  resourceBodies?: ReadonlyMap<string, ObservedResourceBody>;
}>;

export type ConversationViewPageInput = Readonly<{
  session?: ReaderSessionPreferences;
  page: ConversationPageRequest;
  navigationPage: ConversationPageRequest;
  branchPage: ConversationPageRequest;
  navigationSummaryCharacters?: number;
}>;

export const DEFAULT_READER_SESSION: ReaderSessionPreferences = Object.freeze({
  expanded: Object.freeze({ reasoning: false, tools: false, references: false }),
  hidden: Object.freeze({ reasoning: false, tools: false }),
  navigation: Object.freeze({ user: true, assistant: true, process: false })
});

const PRIMARY = new Set(["markdown", "text", "code", "math", "html", "image", "attachment", "diagram", "unknown", "interactive"]);

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedPage(page: ConversationPageRequest, maximum: number): void {
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) throw new RangeError("Conversation page offset must be a non-negative safe integer");
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw new RangeError("Conversation page limit must be a positive safe integer");
  if (page.limit > maximum) throw new RangeError("Conversation page limit exceeds the configured bound");
}

export function conversationMessagePath(conversation: JsonObject, selectedLeaf?: string, branchChoices: Readonly<Record<string, string>> = {}): Readonly<{
  tree: boolean;
  selected?: string;
  current?: string;
  path: readonly number[];
  leaves: readonly string[];
  controls: ReadonlyMap<number, JsonObject>;
}> {
  const messages = conversation["messages"] as JsonObject[];
  const hasIds = messages.some((message) => typeof message["id"] === "string");
  if (!hasIds) return { tree: false, path: messages.map((_, index) => index), leaves: [], controls: new Map() };
  const byId = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const [index, message] of messages.entries()) {
    const id = text(message["id"]);
    if (id) byId.set(id, index);
  }
  const roots: string[] = [];
  for (const message of messages) {
    const id = text(message["id"]);
    if (!id) continue;
    const parent = text(message["parent"]);
    if (parent && byId.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(id);
      children.set(parent, siblings);
    } else roots.push(id);
  }
  const leaves = messages.flatMap((message) => {
    const id = text(message["id"]);
    return id && !children.has(id) ? [id] : [];
  });
  const current = text(conversation["current_message"]);
  const selected = selectedLeaf && byId.has(selectedLeaf)
    ? selectedLeaf
    : current && byId.has(current)
      ? current
      : leaves.at(-1);
  const preferred = new Map<string, string>();
  const seen = new Set<string>();
  let cursor: string | undefined = selected;
  while (cursor) {
    if (seen.has(cursor)) throw new TypeError("Validated Conversation tree unexpectedly contains a cycle");
    seen.add(cursor);
    const index = byId.get(cursor);
    if (index === undefined) break;
    const parent = text(messages[index]!["parent"]);
    if (parent) preferred.set(parent, cursor);
    cursor = parent;
  }
  const path: number[] = [];
  const controls = new Map<number, JsonObject>();
  // A missing source parent makes a separate fragment, not an alternative to
  // every other root. Read all components; only real siblings are switchable.
  for (const root of roots) {
    cursor = root;
    while (cursor) {
      path.push(byId.get(cursor)!);
      const siblings = children.get(cursor);
      if (!siblings?.length) break;
      const requested = branchChoices[cursor] ?? preferred.get(cursor);
      const child: string = requested && siblings.includes(requested) ? requested : siblings.at(-1)!;
      if (siblings.length > 1) {
        const index = siblings.indexOf(child);
        controls.set(byId.get(child)!, {
          parent: cursor, selected: child, index, total: siblings.length,
          ...(index > 0 ? { previous: siblings[index - 1]! } : {}),
          ...(index + 1 < siblings.length ? { next: siblings[index + 1]! } : {})
        });
      }
      cursor = child;
    }
  }
  const displayedLeaf = roots.length === 1 ? text(messages[path.at(-1)!]?.["id"]) : selectedLeaf && byId.has(selectedLeaf) ? selectedLeaf : undefined;
  return { tree: true, ...(displayedLeaf ? { selected: displayedLeaf } : {}), ...(current ? { current } : {}), path, leaves, controls };
}

function resourceReferences(block: JsonObject): string[] {
  const html = blockHtml(block);
  return [...new Set([
    text(block["resource"]),
    text(block["rendered"]),
    text(block["input_resource"]),
    text(block["output_resource"]),
    ...(block["type"] === "interactive" ? [text(block["preview"]), ...(Array.isArray(block["files"]) ? block["files"].filter(isJsonObject).map(file => text(file["resource"])) : [])] : []),
    ...(html === undefined ? [] : htmlResourceImages(html).map(image => image.id))
  ].filter((value): value is string => value !== undefined))];
}

function resourceView(resource: JsonObject): JsonObject {
  const { data_base64: _body, ...metadata } = resource;
  return structuredClone(metadata);
}

function sourceReferences(block: JsonObject): string[] {
  return Array.isArray(block["sources"])
    ? [...new Set(block["sources"].filter((value): value is string => typeof value === "string"))]
    : [];
}

function blockView(
  block: JsonObject,
  resources: ReadonlyMap<string, JsonObject>,
  sources: ReadonlyMap<string, JsonObject>,
  session: ReaderSessionPreferences
): JsonObject | undefined {
  const category = blockCategory(block);
  if (category === "reasoning" && session.hidden.reasoning) return undefined;
  if (category === "tool" && session.hidden.tools) return undefined;
  const refs = resourceReferences(block);
  const output = isJsonObject(block["output"]) ? block["output"] : {};
  const toolSources = block["type"] === "tool" && Array.isArray(output["sources"]) ? output["sources"].filter((id): id is string => typeof id === "string" && sources.has(id)) : [];
  const sourceIds = [...new Set([...sourceReferences(block), ...toolSources])];
  const nested = Array.isArray(block["content"]) ? block["content"].filter(isJsonObject) : undefined;
  const { content: _content, ...withoutContent } = block;
  return {
    category,
    value: structuredClone(nested ? withoutContent : block),
    ...(nested ? { blocks: nested.flatMap(child => { const view = blockView(child, resources, sources, session); return view ? [view] : []; }) } : {}),
    ...(category === "reasoning" ? { collapsed: !session.expanded.reasoning } : {}),
    ...(category === "tool" ? { collapsed: !session.expanded.tools } : {}),
    ...(category === "references" ? { collapsed: !session.expanded.references } : {}),
    ...(refs.length > 0 ? {
      resources: refs.map((id) => {
        const resource = resources.get(id);
        if (!resource) throw new TypeError(`Validated Conversation omitted resource ${id}`);
        return resourceView(resource);
      })
    } : {}),
    ...(sourceIds.length > 0 ? {
      sources: sourceIds.map((id) => {
        const source = sources.get(id);
        if (!source) throw new TypeError(`Validated Conversation omitted source ${id}`);
        return structuredClone(source);
      })
    } : {})
  };
}

function markdownSummary(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[`*_#>\[\]()~|]/gu, " ");
}

const NON_READING_HTML = new Set(["script", "style", "template", "head", "title", "meta", "link", "base", "defs", "metadata", "desc", "annotation", "annotation-xml"]);
const SUMMARY_BREAKS = new Set(["p", "div", "section", "article", "li", "ul", "ol", "br", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td", "th", "hr", "summary", "details", "svg", "text"]);

function htmlSummary(value: string): string | undefined {
  const pending: Array<DefaultTreeAdapterTypes.Node | string> = [parseFragment(value)];
  const result: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") { result.push(node); continue; }
    if ("value" in node) { result.push(node.value); continue; }
    if ("tagName" in node && (NON_READING_HTML.has(node.tagName) || node.attrs.some(attr => attr.name === "hidden"))) continue;
    if (!("childNodes" in node)) continue;
    if ("tagName" in node && SUMMARY_BREAKS.has(node.tagName)) { result.push(" "); pending.push(" "); }
    for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]!);
  }
  return text(result.join("").trim());
}

function primarySummary(block: JsonObject): string | undefined {
  if (blockCategory(block) !== "content") return undefined;
  const type = text(block["type"]);
  if (!type || !PRIMARY.has(type)) return undefined;
  if (type === "markdown") return text(markdownSummary(text(block["text"]) ?? "").trim());
  if (type === "text") return text(block["text"]);
  if (type === "code") return text(block["code"]);
  if (type === "math") return text(block["tex"]) ?? (text(block["mathml"]) ? htmlSummary(text(block["mathml"])!) : undefined);
  if (type === "html") return text(block["html"]) ? htmlSummary(text(block["html"])!) : undefined;
  if (type === "image") return text(block["caption"] ?? block["alt"]);
  if (type === "attachment") return text(block["text"]);
  if (type === "diagram") return text(block["source"]) ?? (text(block["html"]) ? htmlSummary(text(block["html"])!) : undefined);
  if (type === "unknown") return text(block["text"]);
  if (type === "interactive") return text(block["title"]) ?? text(block["source"]);
  return undefined;
}

function processSummary(block: JsonObject): string | undefined {
  const category = blockCategory(block);
  if (category === "content") return undefined;
  const label = text(block["title"] ?? block["query"] ?? block["name"]);
  if (label) return label;
  const body = text(block["text"]);
  if (body) return block["format"] === "html" ? htmlSummary(body) : block["format"] === "markdown" ? markdownSummary(body) : body;
  return text(block["status"] ?? block["label"]);
}

export function messageSelectionSummary(message: JsonObject, limit: number): string {
  const blocks = Array.isArray(message["content"]) ? message["content"].filter(isJsonObject) : [];
  return excerpt(blocks.map(primarySummary).find(Boolean) ?? blocks.map(processSummary).find(Boolean), limit) ?? "";
}

function excerpt(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const points: string[] = [];
  for (const point of normalized) { points.push(point); if (points.length > limit) break; }
  return points.length <= limit ? normalized : `${points.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function party(message: JsonObject, resolved: ResolvedArchiveView | RecordPresentation): JsonObject {
  if (isJsonObject(message["party"])) return message["party"];
  const role = text(message["role"])!;
  if (role === "user") return { role, name: resolved.userName, avatar: resolved.userAvatar };
  if (role === "assistant") return { role, name: resolved.assistantName, avatar: resolved.assistantAvatar };
  return { role, ...(text(message["name"]) ? { name: text(message["name"])! } : {}) };
}

function navigation(
  pathMessages: readonly Readonly<{ sourceIndex: number; message: JsonObject; blocks: readonly JsonObject[] }>[],
  session: ReaderSessionPreferences,
  summaryCharacters: number
): JsonObject[] {
  const result: JsonObject[] = [];
  for (const entry of pathMessages) {
    const role = text(entry.message["role"]);
    const anchor = `message-${entry.sourceIndex + 1}`;
    const primary = entry.blocks.map((block) => primarySummary(block)).find((value) => value !== undefined);
    if (role === "user" && session.navigation.user && primary) {
      result.push({ anchor, kind: "user", source_index: entry.sourceIndex, text: excerpt(primary, summaryCharacters)! });
    } else if (role === "assistant" && session.navigation.assistant && primary) {
      result.push({ anchor, kind: "assistant", source_index: entry.sourceIndex, text: excerpt(primary, summaryCharacters)! });
    }
    if (!session.navigation.process) continue;
    for (const [blockIndex, block] of entry.blocks.entries()) {
      const summary = excerpt(processSummary(block), summaryCharacters);
      if (!summary) continue;
      result.push({
        anchor: `${anchor}-process-${blockIndex + 1}`,
        kind: "process",
        source_index: entry.sourceIndex,
        block_index: blockIndex,
        text: summary
      });
    }
  }
  return result;
}

export function buildConversationPageCore(
  input: ConversationViewSource & ConversationViewPageInput,
  conversation: JsonObject
): JsonObject {
  boundedPage(input.page, resourceLimits.reader_message_page_max);
  boundedPage(input.navigationPage, resourceLimits.reader_navigation_page_max);
  boundedPage(input.branchPage, resourceLimits.reader_branch_page_max);
  const summaryCharacters = input.navigationSummaryCharacters ?? 96;
  if (!Number.isSafeInteger(summaryCharacters) || summaryCharacters < 8) {
    throw new RangeError("Navigation summary limit must be a safe integer of at least eight characters");
  }
  const session = input.session ?? DEFAULT_READER_SESSION;
  const messages = conversation["messages"] as JsonObject[];
  const resources = new Map<string, JsonObject>();
  for (const raw of Array.isArray(conversation["resources"]) ? conversation["resources"] : []) {
    if (isJsonObject(raw) && typeof raw["id"] === "string") resources.set(raw["id"], raw);
  }
  const sources = new Map<string, JsonObject>();
  for (const raw of Array.isArray(conversation["sources"]) ? conversation["sources"] : []) {
    if (isJsonObject(raw) && typeof raw["id"] === "string") sources.set(raw["id"], raw);
  }
  const branch = conversationMessagePath(conversation, session.selectedLeaf, session.branchChoices);
  const pathMessages = branch.path.map((sourceIndex) => {
    const message = messages[sourceIndex]!;
    return {
      sourceIndex,
      message,
      blocks: message["content"] as JsonObject[]
    };
  });
  const visible = pathMessages.flatMap((entry) => {
    const messageAnchor = `message-${entry.sourceIndex + 1}`;
    const blocks = entry.blocks.flatMap((block, blockIndex) => {
      const category = blockCategory(block);
      if (category === "reasoning" && session.hidden.reasoning || category === "tool" && session.hidden.tools) return [];
      // Keep source references here. Expensive clones and reference expansion belong only to the requested page.
      return [{ value: block, anchor: `${messageAnchor}-process-${blockIndex + 1}` }];
    });
    if (blocks.length === 0) return [];
    return [{
      anchor: messageAnchor,
      source_index: entry.sourceIndex,
      ...(typeof entry.message["id"] === "string" ? { id: entry.message["id"] } : {}),
      party: party(entry.message, input.resolved),
      ...(text(entry.message["model"]) ? { model: text(entry.message["model"])! } : {}),
      ...(text(entry.message["timestamp"]) ? { timestamp: text(entry.message["timestamp"])! } : {}),
      blocks
    }];
  });
  const visibleBySource = new Map(visible.map((entry) => [entry.source_index, entry as JsonObject]));
  for (const [sourceIndex, control] of branch.controls) {
    const start = branch.path.indexOf(sourceIndex);
    let target = visibleBySource.get(sourceIndex);
    // Empty topology nodes have no bubble; keep their switch at the first
    // visible descendant, or at the visible parent for an empty alternative.
    for (let index = start + 1; !target && index < branch.path.length; index += 1) {
      const next = branch.path[index]!;
      if (!text(messages[next]!["parent"])) break;
      target = visibleBySource.get(next);
    }
    if (!target) {
      let parent = text(messages[sourceIndex]!["parent"]);
      while (parent && !target) {
        const index = messages.findIndex((message) => message["id"] === parent);
        if (index < 0) break;
        target = visibleBySource.get(index);
        parent = text(messages[index]!["parent"]);
      }
    }
    if (target) target["branch_controls"] = [...(Array.isArray(target["branch_controls"]) ? target["branch_controls"] : []), control];
  }
  // Mark runs before pagination, so a page boundary cannot split the reading
  // disclosure. IDs, graph edges, timestamps and navigation stay independent.
  const summarySequences = new Map<number, string>();
  let previousSummary: typeof visible[number] | undefined;
  for (const entry of visible) {
    const sourceMessage = messages[entry.source_index]!;
    const rawBlocks = sourceMessage["content"] as JsonObject[];
    const eligible = entry.party["role"] === "assistant" && rawBlocks.length > 0 && rawBlocks.every(isSummaryContent)
      && !Array.isArray((entry as JsonObject)["branch_controls"]);
    if (!eligible) { previousSummary = undefined; continue; }
    if (previousSummary) {
      const previous = messages[previousSummary.source_index]!;
      const directlyNext = text(sourceMessage["id"]) && text(previous["id"])
        ? sourceMessage["parent"] === previous["id"] : entry.source_index === previousSummary.source_index + 1;
      const sameIdentity = ["speaker", "role", "name", "model"].every(key => sourceMessage[key] === previous[key]);
      if (directlyNext && sameIdentity) {
        const key = summarySequences.get(previousSummary.source_index) ?? previousSummary.anchor;
        summarySequences.set(previousSummary.source_index, key); summarySequences.set(entry.source_index, key);
      }
    }
    previousSummary = entry;
  }
  // Official exports may split one answer into thought, elapsed notice and
  // final-message nodes. Keep their IDs and metadata, but do not repeat the
  // same portrait at every step. A body, user/tool, branch or actor change
  // starts a new heading; calculate before paging to keep append stable.
  const assistantContinuations = new Set<number>();
  let previousProcess: typeof visible[number] | undefined, processActor: string | undefined;
  const actor = (message: JsonObject) => JSON.stringify([message['speaker'], message['role'], message['name'], message['model']]);
  for (const entry of visible) {
    const source = messages[entry.source_index]!, content = source['content'] as JsonObject[];
    const statusOnly = content.length > 0 && content.every(b => b['type'] === 'status');
    const ownThinking = content.length > 0 && content.every(b => blockCategory(b) === 'reasoning' && !(isJsonObject(b['party']) && b['party']['role'] === 'system'));
    const eligible = entry.party['role'] === 'assistant' && !Array.isArray((entry as JsonObject)['branch_controls']);
    const previous = previousProcess && messages[previousProcess.source_index]!;
    const directlyNext = previous && (text(source['id']) && text(previous['id']) ? source['parent'] === previous['id'] : entry.source_index === previousProcess!.source_index + 1);
    const continued = eligible && previousProcess && directlyNext && JSON.stringify(entry.party) === JSON.stringify(previousProcess.party)
      && (statusOnly || processActor === undefined || processActor === actor(source));
    if (continued) assistantContinuations.add(entry.source_index);
    else processActor = undefined;
    if (eligible && ownThinking) {
      if (!statusOnly) processActor = actor(source);
      previousProcess = entry;
    } else { previousProcess = undefined; processActor = undefined; }
  }
  const pageMessages = visible.slice(input.page.offset, input.page.offset + input.page.limit).map(entry => ({
    ...entry,
    ...(summarySequences.has(entry.source_index) ? { summary_sequence: summarySequences.get(entry.source_index)! } : {}),
    ...(assistantContinuations.has(entry.source_index) ? { assistant_continuation: true } : {}),
    blocks: entry.blocks.map(block => ({ ...blockView(block.value, resources, sources, session)!, anchor: block.anchor }))
  }));
  const messageIndex = new Map(messages.map((message, index) => [message["id"], index]));
  const leaves = branch.leaves.map((id) => {
    const index = messageIndex.get(id) ?? -1;
    const content = index >= 0 ? messages[index]!["content"] as JsonObject[] : [];
    const summary = content.map((block) => primarySummary(block)).find((value) => value !== undefined);
    return { id, source_index: index, ...(excerpt(summary, summaryCharacters) ? { text: excerpt(summary, summaryCharacters)! } : {}) };
  });
  const branchLeaves = leaves.slice(input.branchPage.offset, input.branchPage.offset + input.branchPage.limit);
  const visibleOffsets = new Map(visible.map((entry, offset) => [entry.source_index, offset]));
  const allNavigation = navigation(pathMessages, session, summaryCharacters).map(entry => ({ ...entry,
    ...(visibleOffsets.has(Number(entry["source_index"])) ? { message_offset: visibleOffsets.get(Number(entry["source_index"]))! } : {}) }));
  const navigationEntries = allNavigation.slice(
    input.navigationPage.offset,
    input.navigationPage.offset + input.navigationPage.limit
  );
  const source = object(conversation["source"])!;
  return {
    schema: "cloudig/conversation-view/1.0.0",
    ...(conversation["conversation_id"] ? { conversation_id: conversation["conversation_id"]! } : { archive: conversation["archive"]! }),
    header: {
      ...(input.resolved.conversationName ? { title: input.resolved.conversationName } : {}),
      ...(conversation["provider"] !== undefined ? { provider: conversation["provider"]! } : {}),
      platform: conversation["platform"]!,
      models: [...input.resolved.models],
      content_time: structuredClone(input.resolved.contentTime as unknown as JsonObject),
      source_file: source["file"]!,
      ...(source["captured_at"] !== undefined ? { captured_at: structuredClone(source["captured_at"]) } : {}),
      ...(isJsonObject(source["exporter"]) ? { exporter: structuredClone(source["exporter"]) } : {})
    },
    branch: {
      tree: branch.tree,
      ...(branch.selected ? { selected: branch.selected } : {}),
      ...(branch.current ? { current: branch.current } : {}),
      path_length: branch.path.length,
      leaves: {
        offset: input.branchPage.offset,
        limit: input.branchPage.limit,
        returned: branchLeaves.length,
        total: leaves.length,
        has_previous: input.branchPage.offset > 0,
        has_next: input.branchPage.offset + branchLeaves.length < leaves.length,
        items: branchLeaves
      }
    },
    pagination: {
      offset: input.page.offset,
      limit: input.page.limit,
      returned: pageMessages.length,
      total_visible: visible.length,
      total_canonical: messages.length,
      total_contentful: messages.filter(message => Array.isArray(message["content"]) && message["content"].length > 0).length,
      empty_messages: messages.filter(message => ["user", "assistant"].includes(String(message["role"])) && Array.isArray(message["content"]) && message["content"].length === 0).length,
      has_previous: input.page.offset > 0,
      has_next: input.page.offset + pageMessages.length < visible.length
    },
    messages: pageMessages,
    conversation_images: conversationImages(conversation).map(resourceView),
    navigation: {
      offset: input.navigationPage.offset,
      limit: input.navigationPage.limit,
      returned: navigationEntries.length,
      total: allNavigation.length,
      has_previous: input.navigationPage.offset > 0,
      has_next: input.navigationPage.offset + navigationEntries.length < allNavigation.length,
      items: navigationEntries
    }
  };
}
