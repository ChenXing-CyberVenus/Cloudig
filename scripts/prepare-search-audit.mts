import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { inspectRecordConversation } from "../src/adapters/reader/record-resource.mts";
import { searchableHtmlText, searchConversationMessages } from "../src/app/reader/full-text-search.mts";
import { conversationMessagePath } from "../src/app/reader/view-model-core.mts";
import { locateConversationMessage } from "../src/app/reader/message-location.mts";
import { messageContentCategory } from "../src/app/reader/content-selection.mts";
import type { JsonObject } from "../src/core/contracts/types.mts";
import { startRecordEngine } from "./record-engine-client.mjs";

/** Private evidence inputs are copied byte-for-byte; source messages/IDs are not fabricated. */
export async function prepareSearchAudit(root: string, outputRoot: string, primary: string, companions: readonly string[], packageRoot: string) {
  assert.equal(companions.length, 2, "Search audit needs one other-directory and one archived real Conversation");
  await mkdir(path.join(root, "Conversations/Alpha")); await mkdir(path.join(root, "Conversations/Beta"));
  await rename(path.join(root, "Conversations", path.basename(primary)), path.join(root, "Conversations/Alpha", path.basename(primary)));
  const sources = [primary, ...companions], locations = ["Conversations/Alpha", "Conversations/Beta", "Archives"], ids = new Set();
  const facts = [];
  for (const [index, source] of sources.entries()) {
    const input = await inspectRecordConversation(path.resolve(source)); assert(!ids.has(input.conversation["conversation_id"]), "Audit sources must be distinct records"); ids.add(input.conversation["conversation_id"]);
    if (index) await writeFile(path.join(root, locations[index]!, path.basename(source)), await readFile(source), { flag: "wx" });
    facts.push({ source: path.resolve(source), ...input.fingerprint, location: locations[index] });
  }
  const { conversation: c } = await inspectRecordConversation(primary);
  const tree = c["messages"] as JsonObject, messages = (tree["items"] as JsonObject[]), projected = { ...c, messages, current_message: tree["current"] } as JsonObject;
  const initial = new Set(conversationMessagePath(projected).path), roles = new Map((c["identity"] as JsonObject[]).map(f => [f["source_id"], f["role"]]));
  const md = new MarkdownIt({ html: true }); let query = "", chosen: JsonObject | undefined;
  for (const [index, message] of messages.entries()) {
    if (initial.has(index)) continue;
    for (const block of (message["content"] as JsonObject[])) {
      if (messageContentCategory(roles.get(message["speaker"]), block) === "process") continue;
      const raw = typeof block["html"] === "string" ? searchableHtmlText(block["html"]) : typeof block["text"] === "string" ? searchableHtmlText(md.render(block["text"])) : "";
      for (const line of raw.split("\n").map(s => s.trim()).filter(s => s.length >= 12)) {
        const candidate = [...line].slice(0, 24).join("");
        const hits = [...searchConversationMessages(c, { query: candidate })];
        if (hits.length === 1 && hits[0]!.message === message["id"]) { query = candidate; chosen = message; break; }
      }
      if (chosen) break;
    }
    if (chosen) break;
  }
  assert(chosen && query, "The real Tree needs an independently searchable message off its initial branch");
  const focus = locateConversationMessage(projected, String(chosen["id"]));
  const chosenPath = conversationMessagePath(projected, focus.selectedLeaf).path.map(i => messages[i]!);
  const selected = chosenPath.filter(m => (m["content"] as JsonObject[]).some(b => messageContentCategory(roles.get(m["speaker"]), b) !== "process")).slice(-2).map(m => String(m["id"]));
  assert.equal(selected.length, 2);
  const engine = startRecordEngine({ packageRoot, libraryRoot: root });
  const expected: Record<string, Record<string, { sha256: string; bytes: number }>> = {};
  try {
    for (const language of ["zh-CN", "en"]) {
    const settings = await engine.request("library.preferences.query");
    if (settings.language !== language) await engine.request("library.preferences.commit", { expected_revision: settings.revision, language });
    const list = await engine.request("reader.archives.query", { offset: 0, limit: 100 });
    const archive = list.items.find((r: JsonObject) => r["archive"] === c["conversation_id"] || r["conversation_id"] === c["conversation_id"]);
    assert(archive, "Primary audit record must appear in the actual package's archive list");
    expected[language] = {};
    for (const [name, settings] of Object.entries({ single: { messages: [chosen["id"]], include_header: false }, partial: { messages: selected }, whole: {}, process: { content_mode: "with_process" } })) {
      const receipt = await engine.request("reader.archive.copyMarkdown.prepare", { archive: archive.capability, selected_leaf: focus.selectedLeaf, content_mode: "body", ...settings });
      expected[language]![name] = receipt.fingerprint ?? { sha256: receipt.sha256, bytes: receipt.bytes };
      await engine.request("reader.archive.copyMarkdown.release", { copy: receipt.copy });
    }
    }
  } finally { await engine.close(); }
  assert(Object.values(expected).every(group => Object.values(group).every(r => /^[a-f0-9]{64}$/i.test(r.sha256) && Number.isSafeInteger(r.bytes))));
  const record = { query, message: chosen["id"], anchor: focus.anchor, selectedLeaf: focus.selectedLeaf, selected, expected, sources: facts };
  await writeFile(path.join(outputRoot, "search-audit-input.json"), JSON.stringify(record, null, 2) + "\n");
  return { inputs: facts, initial_branch_excluded_message: chosen["id"], message_count: messages.length };
}
