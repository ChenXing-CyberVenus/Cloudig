// The source-specific wire formats are intentionally parsed as untrusted JSON.
// Their optional fields are normalized into the typed Conversation boundary at
// `fromMessages`; keep this adapter's probing code permissive rather than
// duplicating a second schema type for every vendor's event envelope.
// @ts-nocheck
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import * as readline from "node:readline";
import path from "node:path";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import type { AdapterManifest, SourceMessageFacts } from "../../app/parser/adapter.mts";
import type { CapturedSourceTime, ExtractedRecord } from "../../app/parser/record-source.mts";

/**
 * Agent-tool exports are one logical conversation per JSON/JSONL source in
 * V1.0.4.  The detector is deliberately structural: a filename is never
 * enough to select an adapter.  This module only projects source facts into
 * the existing Conversation draft; it does not create a second Reader model.
 */
export type AgentFamily = "cline-api" | "cline-ui" | "sillytavern" | "kimi-code" | "claude-code" | "codex";

type AgentProbe = Readonly<{ family: AgentFamily; format: "json" | "jsonl"; platform: string; payload: string; adapter: AdapterManifest }>;

const manifests: Readonly<Record<AgentFamily, AdapterManifest>> = {
  "cline-api": { id: "cline-api-json", version: "1.0.2", family: "cline", routes: [{ format: "json", platform: "cline", payload: "cline-api-json", profile: "container" }], target: "cloudig/conversation/1.0.0", update_from: [{ adapter: "cline-api-json", version: "1.0.1", action: "reparse_source" }] },
  "cline-ui": { id: "cline-ui-messages-json", version: "1.0.2", family: "cline", routes: [{ format: "json", platform: "cline", payload: "cline-ui-messages-json", profile: "container" }], target: "cloudig/conversation/1.0.0", update_from: [{ adapter: "cline-ui-messages-json", version: "1.0.1", action: "reparse_source" }] },
  sillytavern: { id: "sillytavern-message-jsonl", version: "1.0.2", family: "sillytavern", routes: [{ format: "jsonl", platform: "sillytavern", payload: "sillytavern-message-jsonl", profile: "container" }], target: "cloudig/conversation/1.0.0", update_from: [{ adapter: "sillytavern-message-jsonl", version: "1.0.1", action: "reparse_source" }] },
  "kimi-code": { id: "kimi-code-wire-jsonl", version: "1.0.3", family: "kimi-code", routes: [{ format: "jsonl", platform: "kimi-code", payload: "kimi-code-wire-jsonl", profile: "container" }], target: "cloudig/conversation/1.0.0", update_from: [{ adapter: "kimi-code-wire-jsonl", version: "1.0.2", action: "reparse_source" }] },
  "claude-code": { id: "claude-code-session-jsonl", version: "1.0.3", family: "claude-code", routes: [{ format: "jsonl", platform: "claude-code", payload: "claude-code-session-jsonl", profile: "container" }], target: "cloudig/conversation/1.0.0", update_from: [{ adapter: "claude-code-session-jsonl", version: "1.0.2", action: "reparse_source" }] },
  codex: { id: "codex-rollout-jsonl", version: "1.0.8", family: "codex", routes: [{ format: "jsonl", platform: "codex", payload: "codex-rollout-jsonl", profile: "container" }], target: "cloudig/conversation/1.0.0", update_from: [{ adapter: "codex-rollout-jsonl", version: "1.0.7", action: "reparse_source" }] }
};

const object = (value: unknown): JsonObject => isJsonObject(value) ? value : {};
const list = (value: unknown): JsonValue[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const finiteTime = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
  }
  if (typeof value === "string" && value.trim()) { const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined; }
  return undefined;
};
const stem = (file: string): string => path.parse(file).name;

export function agentManifest(family: AgentFamily): AdapterManifest { return manifests[family]; }

function looksLikeClineUi(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  return value.some(raw => { const item = object(raw); return item["type"] === "say" && item["say"] === "task" && Number.isFinite(item["ts"]); });
}
function looksLikeClineApi(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  return value.some(raw => { const item = object(raw); return ["user", "assistant", "system"].includes(String(item["role"])) && (typeof item["content"] === "string" || Array.isArray(item["content"])) && item["ts"] !== undefined; });
}
function looksLikeSilly(value: unknown): boolean {
  const item = object(value); return Object.hasOwn(item, "chat_metadata") || (Object.hasOwn(item, "mes") && typeof item["is_user"] === "boolean");
}
function looksLikeClaudeCode(value: unknown): boolean {
  const item = object(value); return typeof item["sessionId"] === "string" && typeof item["uuid"] === "string" && isJsonObject(item["message"]);
}
function looksLikeKimi(value: unknown): boolean {
  const item = object(value); return item["protocol_version"] !== undefined || item["type"] === "turn.prompt" || item["type"] === "context.append_loop_event";
}
function looksLikeCodex(value: unknown): boolean {
  const item = object(value); return ["session_meta", "response_item", "event_msg", "compacted", "turn_context"].includes(String(item["type"]));
}

export function probeAgentJson(value: unknown): AgentProbe | undefined {
  if (looksLikeClineUi(value)) return { family: "cline-ui", format: "json", platform: "cline", payload: "cline-ui-messages-json", adapter: manifests["cline-ui"] };
  if (looksLikeClineApi(value)) return { family: "cline-api", format: "json", platform: "cline", payload: "cline-api-json", adapter: manifests["cline-api"] };
  return undefined;
}

export function probeAgentJsonl(values: readonly JsonObject[]): AgentProbe | undefined {
  if (values.some(looksLikeClaudeCode)) return { family: "claude-code", format: "jsonl", platform: "claude-code", payload: "claude-code-session-jsonl", adapter: manifests["claude-code"] };
  if (values.some(looksLikeKimi) && values.some(v => v["type"] === "turn.prompt")) return { family: "kimi-code", format: "jsonl", platform: "kimi-code", payload: "kimi-code-wire-jsonl", adapter: manifests["kimi-code"] };
  if (values.some(looksLikeCodex)) return { family: "codex", format: "jsonl", platform: "codex", payload: "codex-rollout-jsonl", adapter: manifests.codex };
  if (values.some(looksLikeSilly)) return { family: "sillytavern", format: "jsonl", platform: "sillytavern", payload: "sillytavern-message-jsonl", adapter: manifests.sillytavern };
  return undefined;
}

async function* agentJsonlRecords(filePath: string, signal?: AbortSignal, onProgress?: (bytes: number) => void): AsyncGenerator<JsonObject> {
  const info = await import("node:fs/promises").then(fs => fs.stat(filePath));
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 512 * 1024 });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let completed = 0, count = 0;
  try {
    for await (const line of input) {
      signal?.throwIfAborted(); completed += Buffer.byteLength(line, "utf8") + 1; onProgress?.(Math.min(completed, info.size));
      if (!line.trim()) continue;
      let value: unknown; try { value = JSON.parse(line.replace(/^\uFEFF/u, "")); } catch (error) { throw new SyntaxError(`Invalid JSONL record: ${error instanceof Error ? error.message : String(error)}`); }
      if (!isJsonObject(value)) throw new TypeError("Agent JSONL record must be an object");
      count++; yield value;
    }
  } finally { input.close(); stream.destroy(); }
  if (!count) throw new TypeError("Agent JSONL source is empty");
}
export async function readAgentJsonl(filePath: string, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<JsonObject[]> {
  const values: JsonObject[] = [];
  for await (const value of agentJsonlRecords(filePath, signal, onProgress)) values.push(value);
  return values;
}

async function readRoot(filePath: string, format: "json" | "jsonl", signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<unknown> {
  if (format === "jsonl") return readAgentJsonl(filePath, signal, onProgress);
  const bytes = await readFile(filePath); signal?.throwIfAborted(); onProgress?.(bytes.length);
  const value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  return value;
}

function part(kind: "text" | "markdown" | "reasoning" | "tool", value: string, extra: JsonObject = {}): JsonObject {
  if (kind === "tool") return { type: "tool", kind: "activity", title: value, ...extra };
  return { type: kind === "reasoning" ? "reasoning" : kind === "markdown" ? "markdown" : "text", text: value, ...extra };
}
function contentValue(value: unknown, kind: "text" | "reasoning" = "text"): JsonObject[] {
  if (typeof value === "string" && value.length) return [part(kind === "reasoning" ? "reasoning" : "markdown", value)];
  if (Array.isArray(value)) return value.flatMap(item => {
    const block = object(item), type = String(block["type"] ?? "text");
    if (type === "thinking" || type === "think" || type === "reasoning" || type === "summary_text" || type === "summary") return contentValue(block["thinking"] ?? block["think"] ?? block["text"] ?? block["content"], "reasoning");
    if (type === "text" || type === "output_text" || type === "input_text") return contentValue(block["text"] ?? block["content"], "text");
    if (type === "tool_use" || type === "function_call") { const call = text(block["id"]) ?? text(block["call_id"]), name = text(block["name"]) ?? "tool"; return [part("tool", name, { kind: "call", title: name, ...(call ? { call } : {}), input: block["input"] ?? block["arguments"] ?? null })]; }
    if (type === "tool_result" || type === "function_call_output") { const call = text(block["tool_use_id"]) ?? text(block["call_id"]), output = block["content"] ?? block["output"] ?? null; return [part("tool", "tool result", { kind: "result", ...(call ? { call } : {}), output })]; }
    return [{ type: "unknown", kind: type, data: block }];
  });
  return [];
}

function wireText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(wireText).filter(Boolean).join("\n");
  if (isJsonObject(value)) return wireText(value["text"] ?? value["content"] ?? value["message"] ?? value["output"] ?? "");
  return "";
}

/**
 * Codex writes some authored messages twice: once as an event_msg transport
 * notification and once as the canonical response_item. This comparison is
 * deliberately local and lossless. It normalizes only line endings and the
 * outer whitespace; it must never become a content-based global deduper,
 * because two distinct authored messages may legitimately have identical
 * text.
 */
function transportComparableText(value: unknown): string {
  return wireText(value).replace(/\r\n?/gu, "\n").trim();
}

// Codex puts several desktop/system injections into response_item messages
// whose wire role is nevertheless `user`. Classify by the stable envelope
// markers, not by filenames or by the first visible speaker.
function isCodexSystemContext(value: unknown): boolean {
  const body = wireText(value).trimStart();
  return /^(?:<(?:app-context|recommended_plugins|environment_context|permissions instructions|skills_instructions|multi_agent_mode|collaboration_mode|oai-mem-citation)\b|<system-reminder\b)/iu.test(body);
}

/**
 * A Codex desktop rollout carries an incoming message from another Agent as
 * a user-role response_item wrapped in a delegation envelope.  The wire role
 * describes the transport direction, not the speaker in the conversation.
 * Keep the source thread as the local source key, but do not invent a model
 * when the envelope does not provide one.
 */
function codexExternalAgentEnvelope(value: unknown): Readonly<{ sourceThreadId?: string; text: string; kind: "delegation" | "question" }> | undefined {
  const body = wireText(value).trim();
  const delegation = /^<codex_delegation>\s*([\s\S]*?)\s*<\/codex_delegation>\s*$/iu.exec(body);
  const question = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/iu.exec(body);
  const match = delegation ?? question;
  if (!match) return undefined;
  const inner = match[1] ?? "";
  const sourceThreadId = /<source_thread_id>\s*([\s\S]*?)\s*<\/source_thread_id>/iu.exec(inner)?.[1]?.trim() || undefined;
  if (delegation) {
    const input = /<input>\s*([\s\S]*?)\s*<\/input>/iu.exec(inner)?.[1]?.trim();
    return { ...(sourceThreadId ? { sourceThreadId } : {}), text: input || inner.trim(), kind: "delegation" };
  }
  const answer = /<answer>\s*([\s\S]*?)\s*<\/answer>/iu.exec(inner)?.[1]?.trim();
  const prompt = /<question>\s*([\s\S]*?)\s*<\/question>/iu.exec(inner)?.[1]?.trim();
  return { ...(sourceThreadId ? { sourceThreadId } : {}), text: answer || prompt || inner.trim(), kind: "question" };
}

/** Codex appends its memory citation envelope after the authored answer. It is
 * transport/process metadata, not conversation prose; keep it as a collapsible
 * status block so it remains auditable without polluting the正文 Markdown. */
function codexContentValue(value: unknown): JsonObject[] {
  return contentValue(value).flatMap(block => {
    const kind = text(block["type"]), body = text(block["text"]);
    if (!body || !["markdown", "text"].includes(kind ?? "")) return [block];
    const match = /(?:^|\n)\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/iu.exec(body);
    if (!match) return [block];
    const prose = body.slice(0, match.index ?? 0).trimEnd(), citation = match[0].trim();
    return [
      ...(prose ? [{ type: "markdown", text: prose }] : []),
      { type: "status", title: "Codex memory citation", text: citation, format: "text" }
    ];
  });
}

function codexToolTitle(output: unknown): string {
  const body = wireText(output).trimStart();
  if (body.startsWith("<codex_delegation>")) return "Agent delegation";
  if (body.startsWith("<send_user_message_question_reply>")) return "Agent question";
  return "tool result";
}

function isClaudeCodeLocalCommand(value: unknown): boolean {
  const body = wireText(value).trimStart();
  return /^(?:<(?:local-command-caveat|command-name|command-message|command-args)\b)/iu.test(body);
}

function isClaudeCodeToolResult(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => isJsonObject(item) && (item["type"] === "tool_result" || item["tool_use_id"] !== undefined));
}

function isClaudeCodeCompactionSummary(value: unknown): boolean {
  const body = wireText(value).trimStart();
  return /^This session is being continued from a previous conversation that ran out of context\./iu.test(body);
}

function claudeCodeSystemText(raw: JsonObject): string {
  const body = wireText(raw["content"] ?? raw["message"] ?? raw["text"] ?? raw["error"]);
  if (body) return body;
  const subtype = text(raw["subtype"]);
  return subtype ? `Claude Code system event: ${subtype}` : "Claude Code system event";
}

function sourceFor(input: Readonly<{ file: string; bytes: number; sha256: string }>, format: "json" | "jsonl", platform: string): JsonObject {
  return { ...input, format, platform };
}

function fromMessages(input: Readonly<{ family: AgentFamily; source: Readonly<{ file: string; bytes: number; sha256: string }>; format: "json" | "jsonl"; platform: string; messages: JsonObject[]; facts: SourceMessageFacts[]; title?: string; models?: string[]; captured?: CapturedSourceTime }>): ExtractedRecord {
  const manifest = manifests[input.family], dates = input.messages.flatMap(m => typeof m["timestamp"] === "string" ? [String(m["timestamp"])] : []).sort();
  const defaultTitle = stem(input.source.file).replace(/-life\d+(?:-\d+)?$/iu, "");
  const draft: JsonObject = { platform: input.platform, source: sourceFor(input.source, input.format, input.platform), title: input.title ?? defaultTitle, messages: input.messages,
    ...(input.models?.length ? { models: [...new Set(input.models)] } : {}), ...(dates.length ? { message_time: { start: dates[0]!, end: dates.at(-1)! } } : {}) };
  return { parsed: { draft, adapter: manifest, sourceFingerprint: input.source, systemLogErrors: [] }, facts: { messages: input.facts, ...(input.captured ? { captured: input.captured } : {}) } };
}

function clineApi(root: JsonObject[], source: Readonly<{ file: string; bytes: number; sha256: string }>, captured?: CapturedSourceTime): ExtractedRecord {
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], models: string[] = [];
  for (const [index, raw] of root.entries()) { const role = text(raw["role"]) ?? "assistant", model = text(raw["model"]); if (model) models.push(model);
    const timestamp = finiteTime(raw["ts"]), content = contentValue(raw["content"]); messages.push({ id: `m${index + 1}`, ...(index ? { parent: `m${index}` } : {}), role, ...(timestamp ? { timestamp } : {}), content }); facts.push({ id: `m${index + 1}`, ...(index ? { parent: `m${index}` } : {}), role, ...(model ? { model } : {}) }); }
  return fromMessages({ family: "cline-api", source, format: "json", platform: "cline", messages, facts, models, captured });
}

function clineUi(root: JsonObject[], source: Readonly<{ file: string; bytes: number; sha256: string }>, captured?: CapturedSourceTime): ExtractedRecord {
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], models: string[] = [];
  let activeModel: string | undefined, lastCommand: string | undefined;
  for (const [index, raw] of root.entries()) {
    const event = text(raw["say"]) ?? text(raw["ask"]), explicit = text(object(raw["modelInfo"])["modelId"]);
    if (explicit) activeModel = explicit;
    // Transport/accounting records repeat prompts; they are not new speech.
    if (["api_req_started", "api_req_finished", "deleted_api_reqs", "checkpoint_created"].includes(String(event))) continue;
    const value = text(raw["text"]); if (!value) continue;
    let parsed: unknown = value; try { parsed = JSON.parse(value); } catch { /* Plain text is authoritative. */ }
    const data = object(parsed), role = raw["type"] === "say" && ["task", "user_feedback"].includes(String(event)) ? "user" : "assistant";
    let content: JsonObject[];
    if (role === "user" || ["text", "completion_result"].includes(String(event))) content = contentValue(value);
    else if (["plan_mode_respond", "followup"].includes(String(event))) content = contentValue(data["response"] ?? data["question"] ?? value);
    else if (event === "reasoning") content = contentValue(value, "reasoning");
    else if (event === "command") {
      lastCommand = `cline-command-${index + 1}`;
      content = [part("tool", "execute_command", { kind: "call", call: lastCommand, input: value })];
    } else if (event === "command_output") content = [part("tool", "execute_command", { kind: "result", ...(lastCommand ? { call: lastCommand } : {}), output: value })];
    else if (event === "tool") content = [part("tool", text(data["tool"]) ?? "Cline tool", { kind: "activity", input: parsed as JsonValue })];
    else content = [part("tool", `Cline · ${event ?? raw["type"]}`, { kind: "activity", output: parsed as JsonValue })];
    if (!content.length) continue;
    const id = `m${index + 1}`, parent = text(messages.at(-1)?.["id"]), timestamp = finiteTime(raw["ts"]);
    messages.push({ id, ...(parent ? { parent } : {}), role, ...(timestamp ? { timestamp } : {}), content });
    facts.push({ id, ...(parent ? { parent } : {}), role, ...(role === "assistant" && activeModel ? { model: activeModel } : {}) });
    if (role === "assistant" && activeModel) models.push(activeModel);
  }
  return fromMessages({ family: "cline-ui", source, format: "json", platform: "cline", messages, facts, models, captured });
}

function sillyTavern(root: JsonObject[], source: Readonly<{ file: string; bytes: number; sha256: string }>, captured?: CapturedSourceTime): ExtractedRecord {
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], models: string[] = [];
  let selectedParent: string | undefined;
  for (const [index, raw] of root.entries()) {
    if (!Object.hasOwn(raw, "mes")) continue;
    const role = raw["is_system"] === true ? "system" : raw["is_user"] === true ? "user" : "assistant";
    const swipes = list(raw["swipes"]), selected = Number.isInteger(raw["swipe_id"]) && Number(raw["swipe_id"]) >= 0 && Number(raw["swipe_id"]) < swipes.length ? Number(raw["swipe_id"]) : 0;
    const alternatives = swipes.length ? swipes.map((v, i) => i === selected ? raw["mes"] : v) : [raw["mes"]];
    for (const [i, value] of alternatives.entries()) {
      const info = object(list(raw["swipe_info"])[i]), extra = i === selected ? object(raw["extra"]) : object(info["extra"]);
      const model = text(extra["model"]), reasoning = text(extra["reasoning"]), id = `m${index + 1}${swipes.length > 1 ? `-s${i + 1}` : ""}`;
      const content = [...(reasoning ? [part("reasoning", reasoning)] : []), ...contentValue(value)], timestamp = finiteTime(i === selected ? raw["send_date"] : info["send_date"]);
      messages.push({ id, ...(selectedParent ? { parent: selectedParent } : {}), role, ...(timestamp ? { timestamp } : {}), content });
      facts.push({ id, ...(selectedParent ? { parent: selectedParent } : {}), role, ...(model ? { model } : {}), ...(text(raw["name"]) ? { name: text(raw["name"]) } : {}) });
      if (role === "assistant" && model) models.push(model);
    }
    selectedParent = `m${index + 1}${swipes.length > 1 ? `-s${selected + 1}` : ""}`;
  }
  const result = fromMessages({ family: "sillytavern", source, format: "jsonl", platform: "sillytavern", messages, facts, models, captured });
  if (selectedParent) result.parsed.draft["current_message"] = selectedParent;
  return result;
}

function claudeCode(root: JsonObject[], source: Readonly<{ file: string; bytes: number; sha256: string }>, captured?: CapturedSourceTime): ExtractedRecord {
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], models: string[] = [];
  for (const raw of root) {
    const rawType = text(raw["type"]), rawSubtype = text(raw["subtype"]);
    if (rawType === "system") {
      const id = text(raw["uuid"]) ?? `m${messages.length + 1}`;
      const parent = text(raw["parentUuid"]), subtypeTitle = rawSubtype && /compact/iu.test(rawSubtype)
        ? "Claude Code compaction"
        : rawSubtype ? `Claude Code system event · ${rawSubtype}` : "Claude Code system event";
      const timestamp = finiteTime(raw["timestamp"]);
      messages.push({ id, ...(parent ? { parent } : messages.length ? { parent: messages[messages.length - 1]!["id"]! } : {}), role: "system", ...(timestamp ? { timestamp } : {}), content: [{ type: "status", title: subtypeTitle, text: claudeCodeSystemText(raw), format: "text" }] });
      facts.push({ id, ...(parent ? { parent } : {}), role: "system" });
      continue;
    }
    const message = object(raw["message"]), sourceRole = text(message["role"]);
    if (!sourceRole || !["user", "assistant", "system"].includes(sourceRole)) continue;
    const id = text(raw["uuid"]) ?? `m${messages.length + 1}`;
    const parent = text(raw["parentUuid"]), model = text(message["model"]);
    if (model && model !== "<synthetic>") models.push(model);
    const value = message["content"];
    const compactionSummary = sourceRole === "user" && isClaudeCodeCompactionSummary(value);
    const localCommand = sourceRole === "user" && isClaudeCodeLocalCommand(value);
    const toolResult = sourceRole === "user" && isClaudeCodeToolResult(value);
    const synthetic = sourceRole === "assistant" && model === "<synthetic>" && /^No response requested\.?$/iu.test(wireText(value).trim());
    const role = compactionSummary || localCommand || synthetic ? "system" : toolResult ? "tool" : sourceRole;
    const content = compactionSummary
      ? [{ type: "status", title: "Claude Code compaction summary", text: wireText(value), format: "text" }]
      : localCommand
      ? [{ type: "status", title: "Claude Code local command", text: wireText(value), format: "text" }]
      : synthetic
        ? [{ type: "status", title: "Claude Code synthetic event", text: wireText(value), format: "text" }]
        : contentValue(value);
    if (!content.length && role !== "system") continue;
    const timestamp = finiteTime(raw["timestamp"]);
    messages.push({ id, ...(parent ? { parent } : messages.length ? { parent: messages[messages.length - 1]!["id"]! } : {}), role, ...(timestamp ? { timestamp } : {}), content });
    facts.push({ id, ...(parent ? { parent } : {}), role, ...(model && model !== "<synthetic>" ? { model } : {}) });
  }
  return fromMessages({ family: "claude-code", source, format: "jsonl", platform: "claude-code", messages, facts, models, captured });
}

function kimiCode(root: JsonObject[], source: Readonly<{ file: string; bytes: number; sha256: string }>, captured?: CapturedSourceTime): ExtractedRecord {
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], models: string[] = [], turns = new Map<string, JsonObject>();
  const toolCalls = new Map<string, JsonObject>();
  let currentTurnId: string | undefined;
  const turnFor = (id: string | undefined): JsonObject | undefined => id ? turns.get(id) : undefined;
  const addPart = (turn: JsonObject, value: JsonObject): void => { turn["parts"] = [...list(turn["parts"]), value]; };
  for (const raw of root) {
    const type = text(raw["type"]);
    if (type === "turn.prompt") {
      const id = String(raw["turnId"] ?? turns.size); currentTurnId = id;
      turns.set(id, { id, prompt: raw["input"], parts: [], time: raw["time"] });
      continue;
    }
    if (type === "llm.request") {
      const model = text(raw["modelAlias"]) ?? text(raw["model"]), turn = turnFor(text(raw["turnId"]) ?? currentTurnId);
      if (model) { models.push(model); if (turn) turn["model"] = model; }
      continue;
    }
    if (type !== "context.append_loop_event") continue;
    const event = object(raw["event"]), eventType = text(event["type"]), turnId = text(event["turnId"]) ?? currentTurnId, turn = turnFor(turnId);
    if (!turn) continue;
    currentTurnId = turnId;
    if (eventType === "content.part") {
      const partValue = object(event["part"]); addPart(turn, { kind: partValue["type"], text: partValue["text"] ?? partValue["think"] });
    } else if (eventType === "tool.call") {
      const call = text(event["toolCallId"]) ?? text(event["uuid"]), name = text(event["name"]) ?? text(object(event["display"])["skill_name"]) ?? "Kimi Code tool";
      const record = { turnId, name, call, input: event["args"] ?? event["arguments"] ?? event["input"] ?? null };
      if (call) toolCalls.set(call, record);
      addPart(turn, { kind: "tool", title: name, call, toolKind: "call", input: record["input"] });
    } else if (eventType === "tool.result") {
      const call = text(event["toolCallId"]) ?? text(event["parentUuid"]), previous = call ? toolCalls.get(call) : undefined;
      const result = object(event["result"]), output = result["output"] ?? result["content"] ?? result["text"] ?? event["result"] ?? null;
      addPart(turn, { kind: "tool", title: previous?.["name"] ?? "Kimi Code tool result", call, toolKind: "result", output });
    }
  }
  for (const turn of turns.values()) {
    const id = `m${messages.length + 1}`, prompt = contentValue(turn["prompt"]), time = finiteTime(turn["time"]), model = text(turn["model"]);
    messages.push({ id, ...(messages.length ? { parent: `m${messages.length}` } : {}), role: "user", ...(time ? { timestamp: time } : {}), content: prompt });
    facts.push({ id, ...(messages.length > 1 ? { parent: `m${messages.length - 1}` } : {}), role: "user" });
    const assistantId = `m${messages.length + 1}`;
    const assistant = list(turn["parts"]).flatMap(item => {
      const partValue = object(item);
      if (partValue["kind"] === "tool") return [part("tool", text(partValue["title"]) ?? "Kimi Code tool", { kind: partValue["toolKind"] ?? "activity", ...(text(partValue["call"]) ? { call: text(partValue["call"]) } : {}), ...(partValue["input"] !== undefined ? { input: partValue["input"] } : {}), ...(partValue["output"] !== undefined ? { output: partValue["output"] } : {}) })];
      return contentValue(partValue["text"], partValue["kind"] === "think" ? "reasoning" : "text");
    });
    if (assistant.length) { messages.push({ id: assistantId, parent: id, role: "assistant", ...(time ? { timestamp: time } : {}), ...(model ? { model } : {}), content: assistant }); facts.push({ id: assistantId, parent: id, role: "assistant", ...(model ? { model } : {}) }); }
  }
  return fromMessages({ family: "kimi-code", source, format: "jsonl", platform: "kimi-code", messages, facts, models, captured });
}

function codex(root: JsonObject[], source: Readonly<{ file: string; bytes: number; sha256: string }>, captured?: CapturedSourceTime): ExtractedRecord {
  const messages: JsonObject[] = [], facts: SourceMessageFacts[] = [], models: string[] = [];
  const seenIds = new Set<string>();
  let activeModel: string | undefined, activeAgent: string | undefined;
  const isCodexBoundary = (raw: JsonObject | undefined): boolean => {
    const type = text(raw?.["type"]), payload = object(raw?.["payload"]);
    return type === "turn_context" || type === "session_meta" || (type === "event_msg" && ["task_started", "task_complete", "thread_rolled_back"].includes(text(payload["type"]) ?? ""));
  };
  const canonicalMirror = (index: number, role: "user" | "assistant", value: unknown, direction: -1 | 1): boolean => {
    const comparable = transportComparableText(value);
    if (!comparable) return false;
    for (let cursor = index + direction; cursor >= 0 && cursor < root.length; cursor += direction) {
      const raw = root[cursor];
      if (isCodexBoundary(raw)) return false;
      const payload = object(raw?.["payload"]);
      if (raw?.["type"] !== "response_item" || payload["type"] !== "message") continue;
      const canonicalRole = text(payload["role"]);
      if (canonicalRole !== role) return false;
      return transportComparableText(payload["content"] ?? payload["text"]) === comparable;
    }
    return false;
  };
  const add = (role: string, content: JsonObject[], id?: string, model?: string, timestamp?: string, extra: JsonObject = {}) => {
    if (!content.length) return;
    if (id && seenIds.has(id)) return;
    if (id) seenIds.add(id);
    const messageId = id ?? `m${messages.length + 1}`, parent = messages.at(-1)?.["id"];
    messages.push({ id: messageId, ...(parent ? { parent } : {}), role, ...(timestamp ? { timestamp } : {}), content }); facts.push({ id: messageId, ...(parent ? { parent } : {}), role, ...(model ? { model } : {}), ...extra });
  };
  for (const [index, raw] of root.entries()) {
    const type = text(raw["type"]), payload = object(raw["payload"]), event = object(payload["payload"]), role = text(payload["role"]);
    const settings = object(payload["thread_settings"]), collaboration = object(payload["collaboration_mode"]), configuredModel = text(payload["model"]) ?? text(settings["model"]) ?? text(object(collaboration["settings"])["model"]);
    if (configuredModel) { activeModel = configuredModel; models.push(configuredModel); }
    const sender = text(payload["agent_name"]) ?? text(payload["sender"]) ?? text(payload["source_agent"]);
    if (sender) activeAgent = sender;
    if (type === "response_item") {
      const kind = text(payload["type"]), model = text(payload["model"]) ?? activeModel, timestamp = finiteTime(raw["timestamp"]); if (model) { activeModel = model; models.push(model); }
      if (role && ["user", "assistant", "system", "developer"].includes(role)) {
        const value = payload["content"] ?? payload["text"];
        const external = role === "user" ? codexExternalAgentEnvelope(value) : undefined;
        if (external) {
          const sourceId = external.sourceThreadId ? `agent-thread:${external.sourceThreadId}` : activeAgent ? `agent:${activeAgent}` : "agent:codex-external";
          const explicitModel = text(payload["model"]);
          const explicitSender = text(payload["agent_name"]) ?? text(payload["sender"]);
          add("assistant", codexContentValue(external.text), text(payload["id"]), explicitModel, timestamp, {
            sourceId,
            ...(explicitSender ? { name: explicitSender } : {})
          });
        } else {
          const normalizedRole = role === "developer" || (role === "user" && isCodexSystemContext(value)) ? "system" : role;
          add(normalizedRole, codexContentValue(value), text(payload["id"]), model, timestamp);
        }
      }
      else if (kind === "reasoning") { const reasoning = contentValue(payload["summary"] ?? payload["content"] ?? payload["text"], "reasoning"); add("assistant", reasoning.length ? reasoning : text(payload["encrypted_content"]) ? [{ type: "reasoning", title: "Codex encrypted reasoning", text: "Codex exported this reasoning in encrypted form; plaintext is unavailable to the offline Parser." }] : [], text(payload["id"]), model, timestamp); }
      else if (["function_call", "tool_search_call", "web_search_call", "custom_tool_call"].includes(String(kind))) { const call = text(payload["call_id"]) ?? text(payload["id"]), name = text(payload["name"]) ?? text(payload["tool_name"]) ?? kind; add("assistant", [part("tool", name, { kind: "call", title: name, ...(call ? { call } : {}), input: payload["arguments"] ?? payload["input"] ?? payload["action"] ?? payload["query"] ?? null })], text(payload["id"]), model, timestamp); }
      else if (["function_call_output", "tool_search_output", "web_search_output", "custom_tool_call_output"].includes(String(kind))) {
        const call = text(payload["call_id"]) ?? text(payload["id"]), output = payload["output"] ?? payload["result"] ?? payload["tools"] ?? payload["action"] ?? null;
        const external = kind === "function_call_output" ? codexExternalAgentEnvelope(output) : undefined;
        if (external) {
          const sourceId = external.sourceThreadId ? `agent-thread:${external.sourceThreadId}` : activeAgent ? `agent:${activeAgent}` : "agent:codex-external";
          const explicitModel = text(payload["model"]), explicitSender = text(payload["agent_name"]) ?? text(payload["sender"]);
          add("assistant", codexContentValue(external.text), text(payload["id"]), explicitModel, timestamp, {
            sourceId,
            ...(explicitSender ? { name: explicitSender } : {})
          });
        } else {
          add("tool", [part("tool", codexToolTitle(output), { kind: "result", ...(call ? { call } : {}), output })], text(payload["id"]), model, timestamp);
        }
      }
    } else if (type === "event_msg") {
      const eventType = text(payload["type"]), value = eventType === "user_message" || eventType === "agent_message" ? payload["message"] ?? payload["text"] : undefined;
      if (eventType === "thread_settings_applied") { const applied = text(object(payload["thread_settings"])["model"]); if (applied) { activeModel = applied; models.push(applied); } }
      if (value !== undefined) {
        const mirrorRole = eventType === "user_message" ? "user" : "assistant";
        if (canonicalMirror(index, mirrorRole, value, eventType === "user_message" ? -1 : 1)) continue;
        const content = codexContentValue(value), role = eventType === "user_message" ? (isCodexSystemContext(value) ? "system" : "user") : "assistant";
        add(role, content, undefined, activeModel, finiteTime(raw["timestamp"]), activeAgent ? { name: activeAgent, sourceId: `agent:${activeAgent}` } : {});
      }
    }
  }
  return fromMessages({ family: "codex", source, format: "jsonl", platform: "codex", messages, facts, models, captured });
}

export async function extractAgentRecord(input: Readonly<{ filePath: string; source: Readonly<{ file: string; bytes: number; sha256: string }>; format: "json" | "jsonl"; family: AgentFamily; shards?: readonly string[]; captured?: CapturedSourceTime; signal?: AbortSignal; onProgress?: (phase: string, completed: number, total: number) => void }>): Promise<ExtractedRecord> {
  const files = input.shards?.length ? input.shards : [input.filePath], values: unknown[] = [];
  for (const file of files) { const value = await readRoot(file, input.format, input.signal, completed => input.onProgress?.("scan", completed, input.source.bytes)); if (input.format === "jsonl") values.push(...(value as JsonObject[])); else values.push(value); }
  const root = input.format === "jsonl" ? values as JsonObject[] : values.flatMap(value => Array.isArray(value) ? value.map(object) : [object(value)]);
  const result = input.family === "cline-api" ? clineApi(root, input.source, input.captured)
    : input.family === "cline-ui" ? clineUi(root, input.source, input.captured)
    : input.family === "sillytavern" ? sillyTavern(root, input.source, input.captured)
    : input.family === "kimi-code" ? kimiCode(root, input.source, input.captured)
    : input.family === "claude-code" ? claudeCode(root, input.source, input.captured)
    : codex(root, input.source, input.captured);
  if (!result.parsed.draft["messages"] || !(result.parsed.draft["messages"] as JsonValue[]).length) throw new TypeError(`Agent source ${input.family} contains no visible conversation messages`);
  return result;
}

export async function probeAgentFile(filePath: string, format: "json" | "jsonl", signal?: AbortSignal): Promise<AgentProbe | undefined> {
  if (format === "json") return probeAgentJson(JSON.parse((await readFile(filePath)).toString("utf8").replace(/^\uFEFF/u, "")));
  const values: JsonObject[] = []; const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 256 * 1024 }), input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of input) { signal?.throwIfAborted(); if (!line.trim()) continue; try { const value = JSON.parse(line.replace(/^\uFEFF/u, "")); if (isJsonObject(value)) values.push(value); } catch { break; } if (values.length >= 32) break; } } finally { input.close(); stream.destroy(); }
  return probeAgentJsonl(values);
}
