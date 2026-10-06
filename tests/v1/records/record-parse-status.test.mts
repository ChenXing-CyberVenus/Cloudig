import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { scanRecordSources, readRecordParseStatuses, recordParseFailure, clearRecordParseFailure, dismissMissingRecordSources, unitKey } from "../../../src/adapters/library-data/record-parse-status.mts";
import { prepareRecordParsePlan } from "../../../src/app/parser/record-plan.mts";
import { runRecordParseBatch } from "../../../src/app/parser/record-batch.mts";
import { adapterBundleSnapshot } from "../../../src/app/parser/registry.mts";
import { indexRecordClaudeContainer } from "../../../src/adapters/parser/record-claude-index.mts";
import { updateRecordSystemLog, readRecordSystemLog, removeRecordSystemLogGroups } from "../../../src/adapters/library-data/record-system-log.mts";
import { recordHistoryKey, recordHistoryPath, savePreparedRecord } from "../../../src/adapters/library-data/record-parser-commit.mts";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild"), fixture = path.resolve("tests/fixtures/chatgpt-light-items-v2.html"), timestamp = "2026-09-11T21:00:00Z";
const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "parse-status-")); let passed = false;
  try { await createRecordLibrary(root, { timestamp, anchor: { date: "2026-09-11", offset: "Z" } }); await copyFile(fixture, path.join(root, "Inbox/One.html")); await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained parse status test: ${root}`); }
}

test("an HTML locator is source metadata, while a container locator identifies a separate parse unit", () => {
  const source = { path: "Inbox/One.html", format: "exporter-html" as const, platform: "claude", bytes: 1, sha256: "a".repeat(64), modifiedAt: timestamp, stamp: "test" };
  assert.deepEqual(recordHistoryKey(source.path, { source: { format: source.format, locator: "platform-conversation" }, platform: source.platform }), unitKey({ source }));
  const container = { ...source, path: "Inbox/conversations.json", format: "json-container" as const };
  for (const locator of ["record-a", "record-b"]) assert.deepEqual(recordHistoryKey(container.path, { source: { format: container.format, locator }, platform: "claude" }), unitKey({ source: container, locator }));
  assert.notDeepEqual(unitKey({ source: container, locator: "record-a" }), unitKey({ source: container, locator: "record-b" }));
});

test("legacy HTML histories restore completed status without parsing or rewriting originals, and keep safe reparse ownership", async () => temporary(async root => {
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  const run = await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.1", timestamp, units: plan.units });
  const item = run.items[0]!; assert.equal(item.status, "created"); if (!("path" in item)) throw new Error("missing output");
  const conversation = JSON.parse(await readFile(path.join(root, item.path), "utf8")) as JsonObject;
  (conversation["source"] as JsonObject)["locator"] = "platform-conversation";
  const saved = await savePreparedRecord(root, { conversation, sourcePath: "Inbox/One.html" }); assert(saved.replaced);
  const canonical = recordHistoryPath(unitKey(plan.units[0]!));
  const history = JSON.parse(await readFile(path.join(root, canonical), "utf8"));
  history.source.locator = "platform-conversation";
  const legacy = recordHistoryPath(history.source), legacyBytes = JSON.stringify(history, null, 2) + "\n";
  await writeFile(path.join(root, legacy), legacyBytes); await unlink(path.join(root, canonical));
  const before = await readFile(path.join(root, saved.path));
  const markId = uuidV7(), markPath = "Marks/" + markId + ".json";
  const mark = JSON.stringify({ schema: "cloudig/mark/1.0.0", mark_id: markId, target: saved.conversation["conversation_id"], edited_at: timestamp, conversation_title: "Keep my title" });
  await writeFile(path.join(root, markPath), mark);
  await copyFile(path.join(root, "Inbox/One.html"), path.join(root, "Inbox/One(1).html"));
  const units = (await scanRecordSources(root)).map(source => ({ source }));
  for (let refresh = 0; refresh < 2; refresh++) {
    const statuses = await readRecordParseStatuses(root, units);
    assert.deepEqual(Object.fromEntries(statuses.map(r => [r.unit.source.path, r.status])), { "Inbox/One(1).html": "ready", "Inbox/One.html": "parsed" });
    assert.deepEqual(await readFile(path.join(root, saved.path)), before);
    assert.equal(await readFile(path.join(root, legacy), "utf8"), legacyBytes);
    assert.equal(await readFile(path.join(root, markPath), "utf8"), mark);
    assert(!(await lstat(path.join(root, canonical)).catch(() => undefined)), "read-only status does not migrate history");
  }
  const pending = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() }); assert.deepEqual(pending.preview.map(r => r.filename), ["One(1).html"]);
  const current = adapterBundleSnapshot().adapters.map(a => ({ ...a, version: a.id === plan.units[0]!.source.adapterId ? "99.0.0" : a.version }));
  const outdated = (await readRecordParseStatuses(root, [plan.units[0]!], { adapters: current }))[0]!; assert.equal(outdated.status, "parsed"); assert(outdated.outdated);
  const reparsed = await savePreparedRecord(root, { conversation, sourcePath: "Inbox/One.html" });
  assert(reparsed.replaced); assert.equal(reparsed.conversation["conversation_id"], saved.conversation["conversation_id"]);
  assert.equal((reparsed.conversation["lifecycle"] as JsonObject)["first_parsed_at"], (saved.conversation["lifecycle"] as JsonObject)["first_parsed_at"]);
  assert.equal(await readFile(path.join(root, markPath), "utf8"), mark); assert.equal((await readdir(path.join(root, "Conversations"))).length, 1);
  assert(!JSON.parse(await readFile(path.join(root, canonical), "utf8")).source.locator);
  await writeFile(path.join(root, "Inbox/One.html"), (await readFile(path.join(root, "Inbox/One.html"), "utf8")) + "\nchanged");
  const changed = (await scanRecordSources(root)).find(s => s.path === "Inbox/One.html")!;
  assert.equal((await readRecordParseStatuses(root, [{ source: changed }]))[0]!.status, "ready");
  await unlink(path.join(root, saved.path)); assert.equal((await readRecordParseStatuses(root, [plan.units[0]!]))[0]!.status, "ready");
}));

test("an adapter reparse follows parse-history output even when the catalog has duplicate conversation IDs", async () => temporary(async root => {
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  const firstRun = await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.1", timestamp, units: plan.units });
  const first = firstRun.items[0]!; assert.equal(first.status, "created"); if (!("path" in first)) throw new Error("missing initial output");
  const originalPath = path.join(root, first.path), original = JSON.parse(await readFile(originalPath, "utf8")) as JsonObject;
  await copyFile(originalPath, path.join(root, "Conversations/duplicate.json"));
  const candidate = structuredClone(original) as JsonObject;
  candidate["parser"] = { ...obj(candidate["parser"]), version: "1.1.2" };
  candidate["lifecycle"] = { ...obj(candidate["lifecycle"]), last_parsed_at: "2026-09-11T21:01:00Z", cloudig_edited_at: "2026-09-11T21:01:00Z" };
  const saved = await savePreparedRecord(root, { conversation: candidate, sourcePath: "Inbox/One.html" });
  assert.equal(saved.replaced, true);
  assert.equal(saved.path, first.path, "an adapter reparse must replace the parse-history output, not allocate a no-replace leaf");
  assert.equal((await readdir(path.join(root, "Conversations"))).filter(name => name.endsWith(".json")).length, 2);
  assert.equal(JSON.parse(await readFile(originalPath, "utf8")).parser.version, "1.1.2");
}));

test("a deleted historical output is recreated instead of failing the next parse", async () => temporary(async root => {
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  const firstRun = await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.1", timestamp, units: plan.units });
  const first = firstRun.items[0]!; assert.equal(first.status, "created"); if (!("path" in first)) throw new Error("missing initial output");
  await rm(path.join(root, first.path));
  const nextPlan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  assert.equal(nextPlan.jobs.length, 1, "a missing output must be parseable again");
  const next = await runRecordParseBatch(root, nextPlan.jobs, { parserVersion: "1.1.2", timestamp: "2026-09-11T21:01:00Z", units: nextPlan.units });
  assert.equal(next.items[0]!.status, "created");
  assert.equal((await readdir(path.join(root, "Conversations"))).filter(name => name.endsWith(".json")).length, 1);
}));

test("ambiguous old HTML histories are not guessed into a completed result", async () => temporary(async root => {
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.1", timestamp, units: plan.units });
  const canonical = recordHistoryPath(unitKey(plan.units[0]!)), history = JSON.parse(await readFile(path.join(root, canonical), "utf8"));
  for (const locator of ["old-a", "old-b"]) {
    history.source.locator = locator; await writeFile(path.join(root, recordHistoryPath(history.source)), JSON.stringify(history));
  }
  await unlink(path.join(root, canonical));
  assert.equal((await readRecordParseStatuses(root, plan.units))[0]!.status, "ready");
  assert.equal((await readdir(path.join(root, "Conversations"))).length, 1);
}));

test("official JSON records keep independent completed and unparsed states", async () => temporary(async root => {
  await writeFile(path.join(root, "Inbox/conversations.json"), JSON.stringify([
    { uuid: "record-a", name: "A", chat_messages: [{ uuid: "a1", sender: "human", text: "A" }] },
    { uuid: "record-b", name: "B", chat_messages: [{ uuid: "b1", sender: "human", text: "B" }] }
  ]));
  const index = (await indexRecordClaudeContainer(root, "Inbox/conversations.json")).index;
  const plan = await prepareRecordParsePlan(root, { mode: "claude_json", selected: new Set(), claudeIndex: index });
  const result = await runRecordParseBatch(root, plan.jobs.slice(0, 1), { parserVersion: "1.1.1", timestamp, units: plan.units.slice(0, 1) }); assert.equal(result.items[0]!.status, "created");
  assert.deepEqual((await readRecordParseStatuses(root, plan.units)).map(r => r.status), ["parsed", "ready"]);
  const pending = await prepareRecordParsePlan(root, { mode: "claude_json", selected: new Set(), claudeIndex: index }); assert.equal(pending.units.length, 1); assert.equal(pending.units[0]!.locator, plan.units[1]!.locator);
}));

test("missing-record cleanup rechecks the disk after selection and does not write when a source has returned", async () => temporary(async root => {
  await scanRecordSources(root);
  await unlink(path.join(root, "Inbox/One.html"));
  const selected = await scanRecordSources(root, { includeMissing: true });
  assert.equal(selected[0]!.missing, true);
  const before = await readFile(path.join(root, "appdata/indexes/sources.json"));
  await copyFile(fixture, path.join(root, "Inbox/One.html"));
  assert.equal(await dismissMissingRecordSources(root, selected), 0);
  assert.deepEqual(await readFile(path.join(root, "appdata/indexes/sources.json")), before);
  assert.deepEqual(await readFile(path.join(root, "Inbox/One.html")), await readFile(fixture));
}));

test("preview unions settings, excludes the Claude container and never extracts before confirmation", async () => temporary(async root => {
  await writeFile(path.join(root, "Inbox/conversations.json"), JSON.stringify([{ uuid: "c1", name: "Claude record", chat_messages: [] }]));
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  assert.deepEqual(plan.preview.map(p => p.filename), ["One.html"]); assert.equal(plan.directory, "Conversations");
  assert.deepEqual(await readdir(path.join(root, "Conversations")), []); assert.deepEqual(await readdir(path.join(root, "cache")), []);
  const run = await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.0", timestamp, units: plan.units }); assert.equal(run.items[0]!.status, "created"); assert.deepEqual(run.maintenanceWarnings, []);
  const next = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() }); assert.equal(next.jobs.length, 0);
  const selected = new Set([JSON.stringify(unitKey(plan.units[0]!))]); const again = await prepareRecordParsePlan(root, { mode: "parser", selected }); assert.equal(again.jobs.length, 1);
  const index = (await indexRecordClaudeContainer(root, "Inbox/conversations.json")).index;
  const claude = await prepareRecordParsePlan(root, { mode: "claude_json", selected: new Set(), claudeIndex: index }); assert.equal(claude.jobs.length, 1); assert.equal(claude.preview[0]!.title, "Claude record");
}));

test("content failures consume one retry, system failures do not, source/adapter changes reopen only their own gate", async () => temporary(async root => {
  const unit = { source: (await scanRecordSources(root))[0]! };
  await recordParseFailure(root, unit, "content", true); assert.equal((await readRecordParseStatuses(root, [unit]))[0]!.status, "failed");
  await recordParseFailure(root, unit, "disk", false); assert.equal((await readRecordParseStatuses(root, [unit]))[0]!.status, "failed");
  await recordParseFailure(root, unit, "content", true); assert.equal((await readRecordParseStatuses(root, [unit]))[0]!.status, "unsupported");
  const unrelated = adapterBundleSnapshot().adapters.map(a => ({ ...a, version: a.family === "gemini" ? "99.0.0" : a.version }));
  assert.equal((await readRecordParseStatuses(root, [unit], { adapters: unrelated }))[0]!.status, "unsupported");
  const changed = adapterBundleSnapshot().adapters.map(a => ({ ...a, version: a.id === unit.source.adapterId ? "99.0.0" : a.version }));
  assert.equal((await readRecordParseStatuses(root, [unit], { adapters: changed }))[0]!.status, "ready");
  await writeFile(path.join(root, unit.source.path), (await readFile(path.join(root, unit.source.path), "utf8")) + "\n");
  const fresh = { source: (await scanRecordSources(root))[0]! }; assert.equal((await readRecordParseStatuses(root, [fresh]))[0]!.status, "ready");
  await clearRecordParseFailure(root, unit); assert.deepEqual(await readdir(path.join(root, "appdata/parse-failures")), []);
}));

test("outdated is adapter-specific, neither total Parser changes nor an older adapter make every file stale", async () => temporary(async root => {
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() }); await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.0", timestamp, units: plan.units });
  const current = adapterBundleSnapshot().adapters;
  const status = (adapters: typeof current) => readRecordParseStatuses(root, plan.units, { adapters, bundle: "a different total Parser bundle" });
  assert.equal((await status(current))[0]!.outdated, false);
  assert.equal((await status(current.map(a => ({ ...a, version: a.family === "gemini" ? "99.0.0" : a.version }))))[0]!.outdated, false);
  assert.equal((await status(current.map(a => ({ ...a, version: a.id === plan.units[0]!.source.adapterId ? "99.0.0" : a.version }))))[0]!.outdated, true);
  assert.equal((await status(current.map(a => ({ ...a, version: "0.1.0" }))))[0]!.outdated, false);
}));

test("partial Claude success keeps other record errors; deleting log groups does not delete files; missing paths retire their log", async () => temporary(async root => {
  const file = "Inbox/conversations.json"; await writeFile(path.join(root, file), "[]");
  await updateRecordSystemLog(root, [{ path: file, locator: "a", recorded_at: timestamp, errors: [{ source: "parser", message: "A" }] }, { path: file, locator: "b", recorded_at: timestamp, errors: [{ source: "exporter", message: "B" }] }]);
  await updateRecordSystemLog(root, [{ path: file, locator: "b", recorded_at: timestamp, errors: [] }]);
  const groups = (await readRecordSystemLog(root))["files"] as Array<Record<string, unknown>>; assert.equal(groups.length, 1); assert.equal((groups[0]!["errors"] as Array<Record<string, unknown>>)[0]!["message"], "A");
  await removeRecordSystemLogGroups(root, new Set([file])); assert.equal(await readFile(path.join(root, file), "utf8"), "[]"); assert.deepEqual((await readRecordSystemLog(root))["files"], []);
  await updateRecordSystemLog(root, [{ path: file, recorded_at: timestamp, errors: [{ source: "parser", message: "deleted" }] }]); await unlink(path.join(root, file)); assert.deepEqual((await readRecordSystemLog(root))["files"], []);
}));

test("changed source after preview is not silently parsed as the confirmed bytes", async () => temporary(async root => {
  const plan = await prepareRecordParsePlan(root, { mode: "parser", selected: new Set() });
  await writeFile(path.join(root, "Inbox/One.html"), (await readFile(fixture, "utf8")) + "\n");
  const result = await runRecordParseBatch(root, plan.jobs, { parserVersion: "1.1.0", timestamp, units: plan.units });
  assert.equal(result.items[0]!.status, "failed"); assert.deepEqual(await readdir(path.join(root, "Conversations")), []);
}));
