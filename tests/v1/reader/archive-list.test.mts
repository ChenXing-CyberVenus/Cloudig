import assert from "node:assert/strict";
import test from "node:test";

import { queryReaderArchives, readerArchiveDirectory, readerArchiveRow, type ReaderArchiveFact } from "../../../src/app/reader/index.mts";

function fact(input: Readonly<{
  path: string;
  archive: string;
  title: string;
  platform: string;
  year?: number;
}>): ReaderArchiveFact {
  return {
    path: input.path,
    bytes: 100,
    mtimeNs: "1",
    sha256: input.archive.slice(1).repeat(64).slice(0, 64),
    archive: input.archive,
    generation: 1,
    archived: false,
    access: "normal",
    view: {
      archive: input.archive,
      platform: input.platform,
      archiveLayer: "none",
      conversationName: input.title,
      models: [],
      userName: "User",
      assistantName: "AI",
      userAvatar: "Assets/user.svg",
      assistantAvatar: "Assets/ai.svg",
      contentTime: input.year === undefined
        ? { state: "unavailable" }
        : { state: "set", range: { start: { kind: "calendar", era: "AD", year: input.year } } }
    },
    messageCount: 2,
    resourceCount: 0,
    times: {}
  };
}

const rows = [
  fact({ path: "Conversations/third.json", archive: "a3", title: "Gamma", platform: "gemini" }),
  fact({ path: "Conversations/second.json", archive: "a2", title: "Beta", platform: "chatgpt", year: 2025 }),
  fact({ path: "Conversations/first.json", archive: "a1", title: "Alpha", platform: "chatgpt", year: 2024 })
];

test("Reader archive query filters only title/filename and keeps unknown content time last", () => {
  assert.deepEqual(queryReaderArchives(rows, { offset: 0, limit: 20, platforms: [] }).rows, []);
  assert.deepEqual(queryReaderArchives(rows, { offset: 0, limit: 20 }).rows.map((row) => row.archive), ["a1", "a2", "a3"]);
  assert.deepEqual(queryReaderArchives(rows, { offset: 0, limit: 20, sort: "content_desc", timeField: "content_start" }).rows.map((row) => row.archive), ["a2", "a1", "a3"]);
  assert.deepEqual(queryReaderArchives(rows, { offset: 0, limit: 20, search: "FIRST" }).rows.map((row) => row.archive), ["a1"]);
  assert.deepEqual(queryReaderArchives(rows, { offset: 0, limit: 20, platforms: ["gemini"] }).rows.map((row) => row.archive), ["a3"]);
  assert.deepEqual(queryReaderArchives(rows, { offset: 0, limit: 2, sort: "title" }).rows.map((row) => row.archive), ["a1", "a2"]);
});

test("Archiver archive query sorts every persisted V1 time field without reading archive bodies", () => {
  const timed = [
    { ...rows[0]!, times: { json_created_at: "2023-01-01T00:00:00.000Z", source_captured_at: "2026-03-01T00:00:00.000Z", message_start: "2024-03-01T00:00:00.000Z" } },
    { ...rows[1]!, times: { json_created_at: "2025-01-01T00:00:00.000Z", source_captured_at: "2024-03-01T00:00:00.000Z", message_start: "2026-03-01T00:00:00.000Z" } },
    { ...rows[2]!, times: { json_created_at: "2024-01-01T00:00:00.000Z", source_captured_at: "2025-03-01T00:00:00.000Z", message_start: "2025-03-01T00:00:00.000Z" } }
  ];
  assert.deepEqual(queryReaderArchives(timed, { offset: 0, limit: 20, sort: "content_desc", timeField: "json_created" }).rows.map((row) => row.archive), ["a2", "a1", "a3"]);
  assert.deepEqual(queryReaderArchives(timed, { offset: 0, limit: 20, sort: "content_asc", timeField: "source_captured" }).rows.map((row) => row.archive), ["a2", "a1", "a3"]);
  assert.deepEqual(queryReaderArchives(timed, { offset: 0, limit: 20, sort: "content_desc", timeField: "message_start" }).rows.map((row) => row.archive), ["a2", "a1", "a3"]);
});

test("Reader archive row exposes display facts but never its managed path", () => {
  const value = readerArchiveRow(rows[0]!);
  assert.equal(value["filename"], "third.json");
  assert.equal(value["title"], "Gamma");
  assert.equal(value["path"], undefined);
  assert.doesNotMatch(JSON.stringify(value), /Conversations\//u);
  assert.throws(() => queryReaderArchives(rows, { offset: 0, limit: 201 }), /configured bound/iu);
});

test("filesystem modification, Cloudig edit and first parse remain independent sort facts", () => {
  const timed = rows.map((row, index) => ({
    ...row,
    mtimeNs: String([3000000001n, 3000000002n, 3000000000n][index]),
    view: { ...row.view, effectiveEditedAt: ["2026-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"][index]! },
    times: { json_created_at: ["2023-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"][index]! }
  }));
  const order = (timeField: "json_modified" | "cloudig_edited" | "json_created", sort: "content_asc" | "content_desc" = "content_desc") => queryReaderArchives(timed, { offset: 0, limit: 20, timeField, sort }).rows.map(row => row.archive);
  assert.deepEqual(order("json_modified"), ["a2", "a3", "a1"]);
  assert.deepEqual(order("json_modified", "content_asc"), ["a1", "a3", "a2"]);
  assert.deepEqual(order("cloudig_edited"), ["a3", "a1", "a2"]);
  assert.deepEqual(order("json_created"), ["a2", "a1", "a3"]);
  assert.equal(readerArchiveRow(timed[0]!)["mtime_ns"], "3000000001");
});

test("Reader directory filtering uses a display fact without exposing the managed path", () => {
  const nested = fact({ path: "Conversations/Research/nested.json", archive: "a4", title: "Delta", platform: "chatgpt", year: 2026 });
  const notes = fact({ path: "Conversations/Notes/note.json", archive: "a5", title: "Epsilon", platform: "claude", year: 2023 });
  assert.equal(readerArchiveDirectory(nested), "Research");
  assert.deepEqual(queryReaderArchives([...rows, nested], { offset: 0, limit: 20, directory: "Research" }).rows.map((row) => row.archive), ["a4"]);
  assert.deepEqual(queryReaderArchives([...rows, nested, notes], { offset: 0, limit: 20, directories: ["Research", "Notes"], sort: "content_asc", timeField: "content_start" }).rows.map((row) => row.archive), ["a5", "a4"]);
  assert.throws(() => queryReaderArchives(rows, { offset: 0, limit: 20, directory: "Research", directories: ["Notes"] }), /mutually exclusive/iu);
  assert.throws(() => queryReaderArchives(rows, { offset: 0, limit: 20, directory: "" }), /directory filter/iu);
});
