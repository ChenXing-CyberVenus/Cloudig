import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { normalizeConversation, serializeConversation } from "../../schema/serialize.mjs";
import { validateConversation } from "../../schema/validate.mjs";
import { convertClaudeConversation } from "../src/claude-json-adapter.mjs";
import { parseJsonArrayItem, streamTopLevelJsonArray } from "../src/json-array-stream.mjs";

const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!sourcePath) {
  process.stderr.write("Usage: node parser/scripts/validate-claude-export.mjs <conversations.json>\n");
  process.exitCode = 2;
} else {
  const information = await stat(sourcePath);
  const sourceSha256 = "0".repeat(64);
  const errors = [];
  let conversations = 0;
  let messages = 0;
  let resources = 0;
  let sources = 0;
  let parentLinks = 0;
  let projectedBytes = 0;
  let maxProjectedBytes = 0;

  for await (const item of streamTopLevelJsonArray(createReadStream(sourcePath), { maxItemBytes: 512 * 1024 * 1024 })) {
    try {
      const document = normalizeConversation(convertClaudeConversation(parseJsonArrayItem(item), {
        sourceFile: path.basename(sourcePath),
        sourceSha256,
        sourceSizeBytes: information.size
      }));
      const validation = validateConversation(document);
      if (!validation.valid) throw new Error(validation.errors[0]);
      const serialized = serializeConversation(document);
      const bytes = Buffer.byteLength(serialized);
      conversations += 1;
      messages += document.messages.length;
      resources += document.resources?.length || 0;
      sources += document.sources?.length || 0;
      parentLinks += document.messages.filter((message) => message.parent_id).length;
      projectedBytes += bytes;
      maxProjectedBytes = Math.max(maxProjectedBytes, bytes);
    } catch (error) {
      errors.push({ index: item.index, error: String(error?.message || error).split(/\r?\n/u)[0] });
      if (errors.length >= 20) break;
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: errors.length === 0,
    source_file: path.basename(sourcePath),
    source_size_bytes: information.size,
    conversations,
    messages,
    resources,
    sources,
    parent_links: parentLinks,
    projected_json_bytes: projectedBytes,
    max_projected_conversation_bytes: maxProjectedBytes,
    errors,
    privacy: "conversion counts and structural errors only; no title, body, URL, or vendor identifier output"
  }, null, 2)}\n`);
  if (errors.length) process.exitCode = 1;
}
