import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { parseJsonArrayItem, streamTopLevelJsonArray } from "../src/json-array-stream.mjs";

const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!sourcePath) {
  process.stderr.write("Usage: node parser/scripts/audit-claude-export.mjs <conversations.json>\n");
  process.exitCode = 2;
} else {
  const information = await stat(sourcePath);
  const rootKeys = new Set();
  const messageKeys = new Set();
  const contentKeys = new Set();
  const attachmentKeys = new Set();
  const fileKeys = new Set();
  const senders = new Set();
  const contentTypes = new Set();
  const contentTypeCounts = new Map();
  const contentTypeShapes = new Map();
  const citationKeys = new Set();
  const citationShapes = new Map();
  const branchPaths = new Set();
  const rootShapes = new Map();
  let conversations = 0;
  let messages = 0;
  let contentBlocks = 0;
  let conversationsWithAttachments = 0;
  let conversationsWithFiles = 0;
  let conversationsWithBranchFields = 0;
  let nonNullBranchValues = 0;
  let maxMessages = 0;
  let maxItemBytes = 0;
  let conversationsWithForks = 0;
  let conversationsWithMultipleRoots = 0;
  let conversationsWithOrphans = 0;
  let conversationsWithCycles = 0;
  let totalForkPoints = 0;
  let totalLeaves = 0;
  let maxChildren = 0;
  let maxDepth = 0;
  let duplicateMessageIds = 0;
  let orphanParentReferences = 0;
  let lastMessageIsLeaf = 0;
  let latestUpdatedMessageIsLeaf = 0;
  let parentAppearsAfterChild = 0;
  let messagesWithText = 0;
  let messagesWithContent = 0;
  let messagesWhoseTextMatchesTextBlocks = 0;
  let messagesWhoseTextMatchesConcatenatedTextBlocks = 0;
  let messagesWhoseTextMatchesDoubleNewlineTextBlocks = 0;
  let messagesWithTextButNoTextBlock = 0;
  let attachmentsWithExtractedContent = 0;
  let maxExtractedContentCharacters = 0;

  function typeName(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function collectBranchKeys(value, base = "$", depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) return false;
    let found = false;
    for (const [key, child] of Object.entries(value)) {
      const next = `${base}.${key}`;
      if (/(?:^|_)(?:parent|branch|ancestor|children|tree)(?:_|$)/iu.test(key)) {
        branchPaths.add(next.replace(/\.\d+(?=\.|$)/gu, "[]"));
        found = true;
        if (child !== null && child !== "" && (!Array.isArray(child) || child.length > 0)) nonNullBranchValues += 1;
      }
      if (typeof child === "object" && child !== null) found = collectBranchKeys(child, next, depth + 1) || found;
    }
    return found;
  }

  for await (const item of streamTopLevelJsonArray(createReadStream(sourcePath), { maxItemBytes: 512 * 1024 * 1024 })) {
    const conversation = parseJsonArrayItem(item);
    if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
      throw new TypeError(`Claude export item ${item.index} is not an object`);
    }
    conversations += 1;
    maxItemBytes = Math.max(maxItemBytes, item.length);
    for (const [key, value] of Object.entries(conversation)) {
      rootKeys.add(key);
      const shapes = rootShapes.get(key) || new Set();
      shapes.add(typeName(value));
      rootShapes.set(key, shapes);
    }
    if (collectBranchKeys(conversation)) conversationsWithBranchFields += 1;

    const conversationMessages = Array.isArray(conversation.chat_messages)
      ? conversation.chat_messages
      : Array.isArray(conversation.messages)
        ? conversation.messages
        : [];
    maxMessages = Math.max(maxMessages, conversationMessages.length);
    let hasAttachments = false;
    let hasFiles = false;
    const identifiers = new Set();
    const parentById = new Map();
    const childCounts = new Map();
    for (const message of conversationMessages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      messages += 1;
      for (const key of Object.keys(message)) messageKeys.add(key);
      if (typeof message.sender === "string") senders.add(message.sender);
      if (typeof message.role === "string") senders.add(message.role);
      if (typeof message.uuid === "string") {
        if (identifiers.has(message.uuid)) duplicateMessageIds += 1;
        identifiers.add(message.uuid);
        parentById.set(message.uuid, typeof message.parent_message_uuid === "string" && message.parent_message_uuid
          ? message.parent_message_uuid
          : null);
      }
      if (typeof message.text === "string" && message.text.length) messagesWithText += 1;
      for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
        hasAttachments = true;
        if (attachment && typeof attachment === "object") for (const key of Object.keys(attachment)) attachmentKeys.add(key);
        if (typeof attachment?.extracted_content === "string" && attachment.extracted_content.length) {
          attachmentsWithExtractedContent += 1;
          maxExtractedContentCharacters = Math.max(maxExtractedContentCharacters, attachment.extracted_content.length);
        }
      }
      for (const file of Array.isArray(message.files) ? message.files : []) {
        hasFiles = true;
        if (file && typeof file === "object") for (const key of Object.keys(file)) fileKeys.add(key);
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      if (blocks.length) messagesWithContent += 1;
      const joinedTextBlocks = blocks
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (joinedTextBlocks && joinedTextBlocks === message.text) messagesWhoseTextMatchesTextBlocks += 1;
      const textBlockValues = blocks
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text);
      if (textBlockValues.length && textBlockValues.join("") === message.text) messagesWhoseTextMatchesConcatenatedTextBlocks += 1;
      if (textBlockValues.length && textBlockValues.join("\n\n") === message.text) messagesWhoseTextMatchesDoubleNewlineTextBlocks += 1;
      if (!textBlockValues.length && typeof message.text === "string" && message.text.length) messagesWithTextButNoTextBlock += 1;
      for (const block of blocks) {
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        contentBlocks += 1;
        for (const key of Object.keys(block)) contentKeys.add(key);
        if (typeof block.type === "string") {
          contentTypes.add(block.type);
          contentTypeCounts.set(block.type, (contentTypeCounts.get(block.type) || 0) + 1);
          const shape = contentTypeShapes.get(block.type) || new Map();
          for (const [key, value] of Object.entries(block)) {
            const types = shape.get(key) || new Set();
            types.add(typeName(value));
            shape.set(key, types);
          }
          contentTypeShapes.set(block.type, shape);
        }
        for (const citation of Array.isArray(block.citations) ? block.citations : []) {
          if (!citation || typeof citation !== "object") continue;
          for (const [key, value] of Object.entries(citation)) {
            citationKeys.add(key);
            const types = citationShapes.get(key) || new Set();
            types.add(typeName(value));
            citationShapes.set(key, types);
          }
        }
      }
    }
    let rootCount = 0;
    let hasOrphan = false;
    const messagePosition = new Map(conversationMessages.map((message, position) => [message?.uuid, position]));
    for (const parent of parentById.values()) {
      if (!parent) {
        rootCount += 1;
        continue;
      }
      if (!identifiers.has(parent)) {
        orphanParentReferences += 1;
        hasOrphan = true;
        continue;
      }
      childCounts.set(parent, (childCounts.get(parent) || 0) + 1);
    }
    for (const [identifier, parent] of parentById.entries()) {
      if (parent && messagePosition.has(parent) && messagePosition.get(parent) > messagePosition.get(identifier)) parentAppearsAfterChild += 1;
    }
    if (rootCount > 1) conversationsWithMultipleRoots += 1;
    if (hasOrphan) conversationsWithOrphans += 1;
    const forkPoints = [...childCounts.values()].filter((count) => count > 1);
    if (forkPoints.length) conversationsWithForks += 1;
    totalForkPoints += forkPoints.length;
    maxChildren = Math.max(maxChildren, ...childCounts.values(), 0);
    const leaves = [...identifiers].filter((identifier) => !childCounts.has(identifier));
    totalLeaves += leaves.length;
    const leafSet = new Set(leaves);
    if (conversationMessages.length && leafSet.has(conversationMessages.at(-1)?.uuid)) lastMessageIsLeaf += 1;
    const latestUpdated = conversationMessages
      .filter((message) => typeof message?.updated_at === "string")
      .reduce((latest, message) => !latest || message.updated_at > latest.updated_at ? message : latest, null);
    if (latestUpdated && leafSet.has(latestUpdated.uuid)) latestUpdatedMessageIsLeaf += 1;

    let hasCycle = false;
    for (const identifier of identifiers) {
      const seen = new Set();
      let current = identifier;
      let depth = 0;
      while (current && parentById.has(current)) {
        if (seen.has(current)) {
          hasCycle = true;
          break;
        }
        seen.add(current);
        current = parentById.get(current);
        depth += 1;
      }
      maxDepth = Math.max(maxDepth, depth);
    }
    if (hasCycle) conversationsWithCycles += 1;
    if (hasAttachments) conversationsWithAttachments += 1;
    if (hasFiles) conversationsWithFiles += 1;
  }

  const sorted = (set) => [...set].sort((left, right) => left.localeCompare(right, "en"));
  const shapeSummary = Object.fromEntries([...rootShapes.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, types]) => [key, sorted(types)]));
  const nestedShapeSummary = (records) => Object.fromEntries([...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([record, fields]) => [record, Object.fromEntries([...fields.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, types]) => [key, sorted(types)]))]));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source_file: path.basename(sourcePath),
    source_size_bytes: information.size,
    conversations,
    messages,
    content_blocks: contentBlocks,
    max_messages_per_conversation: maxMessages,
    max_conversation_bytes: maxItemBytes,
    conversations_with_attachments: conversationsWithAttachments,
    conversations_with_files: conversationsWithFiles,
    conversations_with_branch_fields: conversationsWithBranchFields,
    non_null_branch_values: nonNullBranchValues,
    root_shapes: shapeSummary,
    root_keys: sorted(rootKeys),
    message_keys: sorted(messageKeys),
    content_keys: sorted(contentKeys),
    attachment_keys: sorted(attachmentKeys),
    file_keys: sorted(fileKeys),
    senders: sorted(senders),
    content_types: sorted(contentTypes),
    content_type_counts: Object.fromEntries([...contentTypeCounts.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))),
    content_type_shapes: nestedShapeSummary(contentTypeShapes),
    citation_keys: sorted(citationKeys),
    citation_shapes: Object.fromEntries([...citationShapes.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, types]) => [key, sorted(types)])),
    preservation: {
      messages_with_text: messagesWithText,
      messages_with_content: messagesWithContent,
      messages_whose_text_matches_text_blocks: messagesWhoseTextMatchesTextBlocks,
      messages_whose_text_matches_concatenated_text_blocks: messagesWhoseTextMatchesConcatenatedTextBlocks,
      messages_whose_text_matches_double_newline_text_blocks: messagesWhoseTextMatchesDoubleNewlineTextBlocks,
      messages_with_text_but_no_text_block: messagesWithTextButNoTextBlock,
      attachments_with_extracted_content: attachmentsWithExtractedContent,
      max_extracted_content_characters: maxExtractedContentCharacters
    },
    branch_paths: sorted(branchPaths),
    topology: {
      conversations_with_forks: conversationsWithForks,
      conversations_with_multiple_roots: conversationsWithMultipleRoots,
      conversations_with_orphans: conversationsWithOrphans,
      conversations_with_cycles: conversationsWithCycles,
      total_fork_points: totalForkPoints,
      total_leaves: totalLeaves,
      max_children: maxChildren,
      max_depth: maxDepth,
      duplicate_message_ids: duplicateMessageIds,
      orphan_parent_references: orphanParentReferences,
      last_message_is_leaf: lastMessageIsLeaf,
      latest_updated_message_is_leaf: latestUpdatedMessageIsLeaf
      ,parent_appears_after_child: parentAppearsAfterChild
    },
    privacy: "field names, types, and counts only"
  }, null, 2)}\n`);
}
