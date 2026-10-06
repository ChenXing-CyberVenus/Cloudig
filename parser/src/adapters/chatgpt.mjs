import {
  CONVERSATION_SCHEMA_BRANCHES,
  ConversationBuilder,
  addChatGptResources,
  addChatGptSources,
  chatGptDomNode,
  chatGptMermaidRecords,
  chatGptPartResource,
  chatGptPartText,
  importExporterWarnings
} from "./common.mjs";
import { sha256 } from "../contract.mjs";
import {
  escapeHtml,
  hasClass,
  outerHtml,
  sanitizeRichTextFragment
} from "../html.mjs";

export const chatgptAdapter = Object.freeze({
  id: "chatgpt-light-items-v2",
  profile: "light",
  provider: "openai",
  platform: "chatgpt",
  payloadSchema: "osis.chatgpt.chat-export/light-items-v2",
  parse: parseChatGpt
});

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function duration(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

const SCHEDULE_STATE = new WeakMap();

function objectRecords(value) {
  if (Array.isArray(value)) return value.map((record, index) => [String(index), record]);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value);
}

function taskTitle(task) {
  return text(task?.title) ?? text(task?.display_title) ?? null;
}

function scheduleTaskMap(payload) {
  const tasks = new Map();
  for (const [key, task] of objectRecords(payload?.scheduled_components?.tasks)) {
    const id = text(task?.id) ?? text(key);
    if (id) tasks.set(id, task);
  }
  const current = payload?.scheduled_task;
  const currentId = text(current?.id);
  if (currentId) tasks.set(currentId, current);
  return tasks;
}

function safeScheduleUrl(value) {
  const source = text(value);
  if (!source) return null;
  try {
    const parsed = new URL(source);
    return ["http:", "https:"].includes(parsed.protocol) ? source : null;
  } catch {
    return null;
  }
}

function scheduleTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const date = new Date(
    Number.isFinite(numeric) && numeric > 0 && numeric < 10_000_000_000
      ? numeric * 1_000
      : value
  );
  return Number.isFinite(date.valueOf()) ? date.toISOString() : text(value);
}

function scheduleFacts(task, scheduleLabel = null) {
  return [
    ["状态", task?.is_enabled === false ? "已暂停" : task?.is_enabled === true ? "已启用" : null],
    ["安排", scheduleLabel ?? text(task?.display_schedule) ?? text(task?.schedule)],
    ["上次运行", scheduleTime(task?.last_run_time)],
    ["下次运行", scheduleTime(Array.isArray(task?.next_run_times) ? task.next_run_times[0] : null)],
    ["时区", text(task?.default_timezone)],
    ["通知", task?.notifications_enabled === false ? "关闭" : task?.notifications_enabled === true ? "开启" : null]
  ].filter(([, value]) => value);
}

function scheduleFactsHtml(facts) {
  if (!facts.length) return "";
  return `<dl>${facts.map(([label, value]) => (
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
  )).join("")}</dl>`;
}

function scheduleListFallbackHtml(list, tasks) {
  const rows = (Array.isArray(list?.tasks) ? list.tasks : []).map((row) => {
    const task = tasks.get(text(row?.id)) ?? row;
    const title = taskTitle(task) ?? taskTitle(row) ?? "ChatGPT 任务";
    const scheduleLabel = text(row?.schedule_label) ?? text(task?.display_schedule);
    const prompt = text(task?.prompt);
    const conversationId = text(task?.conversation_id);
    const href = conversationId
      ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
      : null;
    return `<details data-cloudig-source-class="scheduled-list-item"><summary><span><strong>${escapeHtml(title)}</strong>${scheduleLabel ? `<small>${escapeHtml(scheduleLabel)}</small>` : ""}</span><span data-cloudig-source-class="scheduled-list-arrow">›</span></summary><div data-cloudig-source-class="scheduled-list-settings">${scheduleFactsHtml(scheduleFacts(task, scheduleLabel))}${prompt ? `<section data-cloudig-source-class="scheduled-list-prompt"><h4>任务指令</h4><pre>${escapeHtml(prompt)}</pre></section>` : ""}${href ? `<a href="${escapeHtml(href)}">打开关联会话</a>` : ""}</div></details>`;
  }).join("");
  if (!rows) return "";
  const allTasksUrl = safeScheduleUrl(list?.all_tasks_url) ?? "https://chatgpt.com/scheduled";
  return `<section data-cloudig-source-class="scheduled-list"><header><span data-cloudig-source-class="scheduled-list-icon">◷</span><h2>${escapeHtml(text(list?.heading) ?? "已安排")}</h2></header>${rows}<a data-cloudig-source-class="scheduled-list-all" href="${escapeHtml(allTasksUrl)}">查看全部任务</a></section>`;
}

function scheduledTaskFallbackHtml(task) {
  if (!task || typeof task !== "object") return "";
  const title = taskTitle(task) ?? "ChatGPT 任务";
  const prompt = text(task?.prompt);
  const conversationId = text(task?.conversation_id);
  const href = conversationId
    ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
    : null;
  const facts = scheduleFacts(task).map(([, value]) => value);
  return `<section data-cloudig-source-class="scheduled-task"><div data-cloudig-source-class="scheduled-task-kicker">已安排的任务</div><h1>${escapeHtml(title)}</h1>${facts.length ? `<div data-cloudig-source-class="scheduled-task-meta">${facts.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}${prompt ? `<details data-cloudig-source-class="scheduled-task-prompt" open><summary>任务指令</summary><pre>${escapeHtml(prompt)}</pre></details>` : ""}${href ? `<a data-cloudig-source-class="scheduled-task-chat" href="${escapeHtml(href)}">打开关联会话</a>` : ""}</section>`;
}

function scheduleState(context) {
  const cached = SCHEDULE_STATE.get(context);
  if (cached) return cached;
  const tasks = scheduleTaskMap(context.payload);
  const listHtmlByMessage = new Map();
  let taskHeaderHtml = "";
  for (const node of context.dom?.nodes ?? []) {
    if (hasClass(node, "scheduled-list")) {
      const messageId = text(node.attrs?.["data-message-id"]);
      const html = sanitizeRichTextFragment(outerHtml(context, node));
      if (messageId && html) {
        const values = listHtmlByMessage.get(messageId) ?? [];
        values.push(html);
        listHtmlByMessage.set(messageId, values);
      }
    } else if (!taskHeaderHtml && hasClass(node, "scheduled-task")) {
      taskHeaderHtml = sanitizeRichTextFragment(outerHtml(context, node));
    }
  }
  const payloadListsByMessage = new Map();
  for (const [, list] of objectRecords(context.payload?.scheduled_components?.lists)) {
    const messageId = text(list?.message_id);
    if (!messageId) continue;
    const values = payloadListsByMessage.get(messageId) ?? [];
    values.push(list);
    payloadListsByMessage.set(messageId, values);
  }
  if (!taskHeaderHtml && context.payload?.entry_surface === "scheduled_task") {
    taskHeaderHtml = scheduledTaskFallbackHtml(context.payload?.scheduled_task);
  }
  const result = { tasks, listHtmlByMessage, payloadListsByMessage, taskHeaderHtml };
  SCHEDULE_STATE.set(context, result);
  return result;
}

function scheduleListBlocks(context, item) {
  if (item?.kind !== "assistant") return [];
  const messageId = text(item?.message_id) ?? text(item?.node_id);
  if (!messageId) return [];
  const state = scheduleState(context);
  const captured = state.listHtmlByMessage.get(messageId) ?? [];
  const fallback = captured.length
    ? []
    : (state.payloadListsByMessage.get(messageId) ?? [])
      .map((list) => scheduleListFallbackHtml(list, state.tasks))
      .filter(Boolean);
  return [...captured, ...fallback].map((html) => ({
    type: "tool",
    kind: "activity",
    name: "schedule",
    title: "已安排",
    html
  }));
}

function scheduledTaskName(context, item) {
  const id = text(item?.scheduled_task_id);
  if (!id) return null;
  return taskTitle(scheduleState(context).tasks.get(id));
}

function scheduledTaskHeaderBlock(context) {
  if (context.payload?.entry_surface !== "scheduled_task") return null;
  const state = scheduleState(context);
  if (!state.taskHeaderHtml) return null;
  return {
    type: "tool",
    kind: "activity",
    name: "schedule",
    title: taskTitle(context.payload?.scheduled_task) ?? "已安排的任务",
    html: state.taskHeaderHtml
  };
}

function chatGptPrivateMessageId(item, index, occurrence) {
  const identity = text(item?.message_id) ?? text(item?.node_id) ?? `item-${index}`;
  return sha256(Buffer.from(`chatgpt\u0000scheduled-message\u0000${identity}\u0000${occurrence}\u0000${index}`, "utf8"));
}

function createTurnAllocator(entrySurface) {
  let sequence = 0;
  let mode = null;
  let scheduledRun = null;
  return (role, item, index) => {
    if (role === "user") {
      sequence += 1;
      mode = "user";
      scheduledRun = null;
      return `turn_${String(sequence).padStart(6, "0")}_user`;
    }
    const isScheduled = Boolean(text(item?.scheduled_task_id)) || entrySurface === "scheduled_task";
    if (isScheduled) {
      const sourceMessage = text(item?.message_id) ?? text(item?.node_id) ?? `item-${index}`;
      const key = `${text(item?.scheduled_task_id) ?? "scheduled-task"}\u0000${sourceMessage}`;
      if (mode !== "scheduled" || scheduledRun !== key) sequence += 1;
      mode = "scheduled";
      scheduledRun = key;
      return `turn_${String(sequence).padStart(6, "0")}_assistant`;
    }
    if (sequence === 0 || mode === "scheduled") sequence += 1;
    mode = "assistant";
    scheduledRun = null;
    return `turn_${String(sequence).padStart(6, "0")}_assistant`;
  };
}

function thoughtBlocks(item) {
  const content = [];
  const thoughts = (Array.isArray(item?.thoughts) ? item.thoughts : [])
    .map((thought) => ({
      summary: text(thought?.summary),
      body: text(thought?.content)
    }))
    .filter((thought) => thought.summary || thought.body);
  const summariesWithBody = new Set(
    thoughts.filter((thought) => thought.summary && thought.body).map((thought) => thought.summary)
  );
  const seen = new Set();
  for (const thought of thoughts) {
    const { summary, body } = thought;
    if (summary && !body && summariesWithBody.has(summary)) continue;
    const fingerprint = `${summary ?? ""}\u0000${body ?? ""}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const block = {
      type: summary ? "reasoning_summary" : "reasoning"
    };
    if (summary) block.title = summary;
    if (body) block.markdown = body;
    if (text(item?.effort)) block.effort = text(item.effort);
    content.push(block);
  }
  return content;
}

function recapBlock(item) {
  let title = text(item?.text);
  if (!title) return null;
  const seconds = duration(item?.seconds);
  if (
    seconds !== null
    && (
      /^思考了\s*(?:(?:\d+(?:\.\d+)?)\s*(?:ms|s|m|h)\s*)+$/iu.test(title)
      || /^思考了\s*[零〇一二两三四五六七八九十百千半几]+\s*(?:秒|分钟|分|小时)$/u.test(title)
      || /^(?:worked|thought|thinking)\s+for\s*(?:(?:\d+(?:\.\d+)?)\s*(?:ms|s|m|h)\s*)+$/iu.test(title)
    )
  ) {
    title = "思考";
  }
  const block = { type: "status", title };
  if (seconds !== null) block.duration_seconds = seconds;
  if (text(item?.effort)) block.effort = text(item.effort);
  return block;
}

function toolBlock(item) {
  const body = text(item?.text);
  const name = text(item?.name);
  const block = { type: "tool", kind: "result" };
  if (name) block.name = name;
  if (body) block.markdown = body;
  return name || body ? block : null;
}

function markdownFence(value, language = "") {
  const body = String(value ?? "");
  const longest = [...body.matchAll(/`+/gu)]
    .reduce((maximum, match) => Math.max(maximum, match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const label = text(language);
  return `${fence}${label && label.toLowerCase() !== "unknown" ? label : ""}\n${body}\n${fence}`;
}

function toolCallBlock(item) {
  const body = text(item?.text);
  const name = text(item?.recipient) ?? text(item?.name);
  const block = { type: "tool", kind: "call" };
  if (name) block.name = name;
  if (body) block.markdown = markdownFence(body, item?.lang);
  return name || body ? block : null;
}

function markdownFenceMarker(line) {
  const match = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/u.exec(String(line ?? ""));
  return match ? {
    character: match[1][0],
    length: match[1].length,
    info: match[2].trim()
  } : null;
}

function closesMarkdownFence(line, fence) {
  if (!fence) return false;
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(String(line ?? ""));
  return Boolean(match && match[1][0] === fence.character && match[1].length >= fence.length);
}

function normalizedMermaidSource(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]{2,}/gu, " "))
    .join("\n")
    .trim();
}

function takeMermaidPreview(state, source) {
  if (!state || state.cursor >= state.records.length) return null;
  const record = state.records[state.cursor];
  if (normalizedMermaidSource(record.source) !== normalizedMermaidSource(source)) return null;
  state.cursor += 1;
  return record.block;
}

function partBlocks(value, mermaidState = null) {
  const source = text(value);
  if (!source) return [];
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const content = [];
  const markdown = [];
  let outerFence = null;
  const flushMarkdown = () => {
    const body = text(markdown.join("\n"));
    markdown.length = 0;
    if (body) content.push({ type: "markdown", text: body });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (outerFence) {
      markdown.push(line);
      if (closesMarkdownFence(line, outerFence)) outerFence = null;
      continue;
    }
    const fence = markdownFenceMarker(line);
    if (fence) {
      if (/^mermaid(?:\s|$)/iu.test(fence.info)) {
        let closing = -1;
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          if (closesMarkdownFence(lines[cursor], fence)) {
            closing = cursor;
            break;
          }
        }
        if (closing >= 0) {
          const source = lines.slice(index + 1, closing).join("\n");
          const preview = takeMermaidPreview(mermaidState, source);
          if (preview) {
            flushMarkdown();
            content.push(preview);
          }
          markdown.push(...lines.slice(index, closing + 1));
          index = closing;
          continue;
        }
      }
      outerFence = fence;
      markdown.push(line);
      continue;
    }
    if (!/^ {0,3}:::writing(?:\{[^\r\n]*\})?[ \t]*$/u.test(line)) {
      markdown.push(line);
      continue;
    }

    let innerFence = null;
    let closing = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (innerFence) {
        if (closesMarkdownFence(candidate, innerFence)) innerFence = null;
        continue;
      }
      const innerOpening = markdownFenceMarker(candidate);
      if (innerOpening) {
        innerFence = innerOpening;
        continue;
      }
      if (/^ {0,3}:::[ \t]*$/u.test(candidate)) {
        closing = cursor;
        break;
      }
    }
    if (closing < 0) {
      markdown.push(line);
      continue;
    }

    flushMarkdown();
    const body = text(lines.slice(index + 1, closing).join("\n"));
    if (body) {
      content.push({ type: "diagram", format: "writing_block", source: body });
    }
    index = closing;
  }
  flushMarkdown();
  return content;
}

export function projectChatGptItemContent(context, builder, item, index, node) {
  const content = [];
  const role = item?.kind === "user"
    ? "user"
    : item?.kind === "tool" || (item?.kind === "code" && text(item?.recipient))
      ? "tool"
      : "assistant";
  if (item?.kind === "thinking") {
    content.push(...thoughtBlocks(item));
  } else if (item?.kind === "recap") {
    content.push(recapBlock(item));
  } else if (item?.kind === "code" && text(item?.recipient)) {
    content.push(toolCallBlock(item));
  } else if (item?.kind === "code") {
    const code = text(item?.text);
    if (code) {
      const block = { type: "code", code };
      if (text(item?.lang)) block.language = text(item.lang);
      content.push(block);
    }
  } else if (item?.kind === "tool") {
    content.push(toolBlock(item));
  } else {
    const mermaidState = {
      records: chatGptMermaidRecords(context, builder, node, role),
      cursor: 0
    };
    for (const part of Array.isArray(item?.parts) ? item.parts : []) {
      const resource = chatGptPartResource(context, builder, item, part, role);
      if (resource) {
        content.push(resource);
        continue;
      }
      const partText = chatGptPartText(part);
      if (partText) content.push(...partBlocks(partText, mermaidState));
    }
  }
  addChatGptResources(context, builder, item, node, content, role);
  content.push(...scheduleListBlocks(context, item));
  addChatGptSources(builder, item, content, index);
  return {
    role,
    name: scheduledTaskName(context, item),
    content: content.filter(Boolean)
  };
}

export function parseChatGptWithDescriptor(context, descriptor) {
  const builder = new ConversationBuilder(context, descriptor);
  const occurrences = new Map();
  const items = Array.isArray(context.payload.items) ? context.payload.items : [];
  const allocateTurn = createTurnAllocator(context.payload?.entry_surface);
  const branchOutput = descriptor.outputSchema === CONVERSATION_SCHEMA_BRANCHES;
  const taskHeader = scheduledTaskHeaderBlock(context);
  let previousId = null;
  if (!items.length && taskHeader) {
    const id = branchOutput
      ? sha256(Buffer.from(`chatgpt\u0000scheduled-header\u0000${text(context.payload?.scheduled_task?.id) ?? "task"}`, "utf8"))
      : null;
    builder.addMessage({
      id,
      role: "system",
      name: taskTitle(context.payload?.scheduled_task) ?? "Scheduled",
      turnId: "turn_000001_system",
      content: [taskHeader]
    });
  }
  for (const [index, item] of items.entries()) {
    const id = String(item?.message_id ?? item?.node_id ?? "");
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    const node = chatGptDomNode(context, id, occurrence);
    const projected = projectChatGptItemContent(context, builder, item, index, node);
    if (index === 0 && taskHeader) projected.content.unshift(taskHeader);
    const turnId = allocateTurn(projected.role, item, index);
    const privateId = branchOutput ? chatGptPrivateMessageId(item, index, occurrence) : null;
    if (!node) builder.warn("dom_fragment_missing", "ChatGPT item 没有对应静态 DOM 片段。", index);
    builder.addMessage({
      id: privateId,
      parentId: branchOutput ? previousId : null,
      role: projected.role,
      name: projected.name,
      model: item?.model,
      timestamp: item?.created_at,
      turnId,
      content: projected.content
    });
    if (branchOutput) previousId = privateId;
  }
  if (context.messageNodes.length !== items.length) {
    builder.warn(
      "dom_fragment_count_mismatch",
      `机器 items 为 ${items.length} 项，静态 DOM 为 ${context.messageNodes.length} 个片段。`
    );
  }
  importExporterWarnings(context, builder);
  return builder.finalize();
}

export function parseChatGpt(context) {
  return parseChatGptWithDescriptor(context, chatgptAdapter);
}
