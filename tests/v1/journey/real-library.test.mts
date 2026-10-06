import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fileCaptureTime } from "../../../src/app/parser/record-source.mts";
import { commitRecords, readStoredRecord, pendingRecordOperations } from "../../../src/adapters/storage/record-store.mts";
import { validateRecord } from "../../../src/core/records/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const sampleRoot = process.env["CLOUDIG_REAL_SAMPLE_DIR"], claudeContainer = process.env["CLOUDIG_REAL_CLAUDE_CONTAINER"];
const keepLibrary = process.env["CLOUDIG_KEEP_REAL_LIBRARY"] === "1";
const packageRoot = path.resolve(process.env["CLOUDIG_RECORD_PACKAGE_ROOT"] ?? "artifacts/v1-desktop/app");
const { startRecordEngine } = await import(pathToFileURL(path.resolve("scripts/record-engine-client.mjs")).href);
type Request = (command: string, payload?: JsonObject, onEvent?: (event: any) => void) => Promise<any>;
async function hash(file: string) { const value = createHash("sha256"); let bytes = 0; for await (const chunk of createReadStream(file)) { bytes += chunk.length; value.update(chunk); } return { bytes, sha256: value.digest("hex") }; }
async function files(root: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    assert(!entry.isSymbolicLink()); const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await files(root, relative)); else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}
async function fingerprints(root: string, directories: string[]) { const result: Record<string, string> = {}; for (const directory of directories) for (const file of await files(root, directory)) result[file] = (await hash(path.join(root, file))).sha256; return result; }
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

test("the packaged Engine completes the real five-record Library journey without mutating source originals", { skip: !sampleRoot || !claudeContainer, timeout: 600000 }, async () => {
  assert(sampleRoot && claudeContainer);
  const parent = path.resolve("tests/private/schema-rebuild"); await mkdir(parent, { recursive: true });
  const scope = await mkdtemp(path.join(parent, "package-journey-")); let root = path.join(scope, "Library"), passed = false;
  await mkdir(root); let engine = startRecordEngine({ packageRoot, libraryRoot: root });
  const request: Request = (...args) => engine.request(...args);
  const list = async (archived = false) => {
    const first = await request("reader.archives.query", { offset: 0, limit: 200, archived, sort: "title" });
    const rows = [...first.items]; while (rows.length < first.total) { const next = await request("reader.archives.query", { offset: rows.length, limit: 200, snapshot: first.snapshot }); assert(next.items.length); rows.push(...next.items); }
    return { ...first, items: rows };
  };
  const find = async (id: string, archived = false) => { const row = (await list(archived)).items.find((r: any) => r.archive === id); assert(row, `Conversation is missing: ${id}`); return row; };
  const markFor = async (id: string) => { for (const file of await files(root, "Marks")) { const value = await json(path.join(root, file)); if (value.target === id) return { file, value, bytes: await readFile(path.join(root, file)) }; } return undefined; };
  const edit = async (id: string, change: (draft: any) => void, extra: JsonObject = {}) => {
    const row = await find(id), info = await request("reader.archive.info.query", { archive: row.capability }), draft = structuredClone(info.draft); change(draft);
    return request("reader.archive.info.commit", { archive: row.capability, expected_conversation: info.revision.conversation, expected_mark: info.revision.mark, draft, touch_on_noop: false, ...extra });
  };
  const allSources = () => request("archiver.sources.query", { offset: 0, limit: 200, sort: "title" });
  const parse = async (sources: string[], keep = false) => { const plan = await request("archiver.parse.plan", { sources, preserve_previous: keep }); return request("archiver.parse.commit", { plan: plan.plan }); };
  const importFile = async (source: string, filename = path.basename(source)) => {
    const runtime = (await request("engine.storage")).runtime_root, picker = `p_${randomBytes(32).toString("base64url")}`;
    const directory = path.join(runtime, "Pickers", picker); await mkdir(directory, { recursive: true });
    const sourceHash = await hash(source), info = await lstat(source);
    await copyFile(source, path.join(directory, "payload.bin"));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schema: "cloudig/picker/1.0.0", picker, filename, ...sourceHash, created_at: info.birthtime.toISOString(), modified_at: info.mtime.toISOString() }));
    const result = await request("source.import", { pickers: [picker] }); assert.equal(result.items[0].status, "imported");
    assert.deepEqual(await hash(path.join(root, "Inbox", result.items[0].filename)), sourceHash); return sourceHash;
  };
  const timeCover = () => request("time.cover.query", { return_to: "archiver" });
  const createTime = async (metadata: JsonObject, mappings: JsonObject[] = []) => {
    const cover = await timeCover(), plan = await request("time.editor.preview", { route: cover.route, action: metadata["kind"] === "timeline" ? "create_timeline" : "create_time", draft: { metadata, children: [], counterparts: [], mappings } });
    return request("time.editor.commit", { plan: plan.plan, strategy: "in_place", selected_references: [] });
  };
  const queryTime = async (name: string) => { const cover = await timeCover(), rows = await request("time.sovereign.query", { route: cover.route, offset: 0, limit: 200, search: name, sort: "title" }); const row = rows.items.find((r: any) => r.name === name); assert(row); return { cover, row, editor: await request("time.editor.query", { route: cover.route, node: row.node }) }; };
  const timeDraft = (editor: any) => ({ metadata: structuredClone(editor.metadata), children: structuredClone(editor.children), counterparts: structuredClone(editor.counterparts), mappings: structuredClone(editor.mappings) });
  try {
    const programBefore = await hash(path.join(packageRoot, "app/engine/engine.mjs"));
    assert.equal((await request("library.startup.recover")).status, "missing"); await request("library.create");
    const initial = await request("library.preferences.query"); assert.equal(initial.theme, "dawn"); assert.equal(initial.theme_switched, false);
    const bindings = await json(path.join(root, "Identities/identity-settings.json")); assert.equal(Object.keys(bindings.platforms).length, 12);
    assert.equal((await files(root, "ContentTimes")).length, 18, "17 independent nodes plus order");
    const names = (await readdir(sampleRoot)).filter(n => n.endsWith(".html")).sort(); assert(names.length >= 12);
    const originals = new Map<string, Awaited<ReturnType<typeof hash>>>();
    for (const name of names) originals.set(name, await importFile(path.join(sampleRoot, name)));
    const officialHash = await importFile(claudeContainer, "conversations.json");
    console.log(`Package journey: imported ${names.length} HTML and the official container`);
    const progress = new Set<number>(); const plan = await request("archiver.parse.plan", { sources: [], one_click: true });
    assert.equal(plan.total, names.length); assert.equal((await files(root, "Conversations")).length, 0);
    const started = performance.now(), parsed = await request("archiver.parse.commit", { plan: plan.plan }, e => { if (e.bytes?.completed > 0) progress.add(e.file.index); });
    const htmlMs = performance.now() - started; assert.equal(parsed.completed, names.length); assert.equal(parsed.failed, 0); assert.equal(progress.size, names.length);
    console.log(`Package journey: parsed ${parsed.completed} HTML with progress for every file`);
    const concurrent = await Promise.all([allSources(), list(), request("identity.query")]); assert.equal(concurrent[0].total, names.length + 1); assert.equal(concurrent[1].total, names.length);
    const records: any[] = [];
    for (const file of await files(root, "Conversations")) { const value = await json(path.join(root, file)); assert.equal(validateRecord("conversation", value).ok, true); assert.equal(value.title.filename, path.parse(value.source.file).name); assert(!("user" in value || "content_time" in value)); records.push({ file, value }); }
    assert.equal(new Set(records.map(r => r.value.platform)).size, 12);
    const locatorGroups = new Map<string, string[]>(); for (const r of records) if (r.value.source.locator) { const key = JSON.stringify([r.value.platform, r.value.source.locator]); locatorGroups.set(key, [...locatorGroups.get(key) ?? [], r.value.conversation_id]); }
    const family = [...locatorGroups.values()].find(ids => ids.length >= 3); assert(family, "same-page captures remain independent records");
    const a = records.find(r => r.value.conversation_id === family[0])!, b = records.find(r => r.value.conversation_id === family[1])!;
    const aid = a.value.conversation_id as string, bid = b.value.conversation_id as string, aOriginal = await hash(path.join(root, a.file)), firstParsed = a.value.lifecycle.first_parsed_at;
    await edit(aid, draft => { draft.conversation_name = { state: "set", value: "Journey A" }; draft.models = { state: "set", values: [] }; draft.content_time = { state: "set", range: { start: { kind: "calendar", era: "BC", year: 2000 } } }; });
    const aMark = await markFor(aid); assert(aMark); assert.deepEqual(aMark.value.models, []); assert.deepEqual(await hash(path.join(root, a.file)), aOriginal); assert.equal(await markFor(bid), undefined);
    await appendFile(path.join(root, "Inbox", a.value.source.file), "\n");
    let source = (await allSources()).items.find((r: any) => r.source_file === a.value.source.file); assert(source);
    assert.equal((await parse([source.capability])).items[0].status, "updated"); assert.equal((await json(path.join(root, a.file))).lifecycle.first_parsed_at, firstParsed); assert.deepEqual((await markFor(aid))!.bytes, aMark.bytes);
    const preserved = await parse([source.capability], true), copyId = preserved.items[0].archive; assert.notEqual(copyId, aid); assert.equal(await markFor(copyId), undefined);
    const targetBytes = await hash(path.join(root, a.file));
    const identity = await request("identity.query"), global = identity.global;
    const identityDraft = { global: { user: { name: "Journey User", avatar: { state: "keep" } }, assistant: { name: "Journey AI", avatar: { state: "keep" }, apply_to_all: false } }, platforms: Object.fromEntries(identity.platforms.map((p: any) => [p.platform, { name: p.name, avatar: { state: "keep" } }])) };
    const identityInfo = await request("reader.archive.identity.query", { archive: (await find(aid)).capability });
    await request("identity.commit", { expected_revision: identity.revision, draft: identityDraft, conversation: { archive: (await find(aid)).capability, expected_conversation: identityInfo.revision.conversation, expected_mark: identityInfo.revision.mark, names: { user: "A User", assistant: "A AI" } } });
    assert.deepEqual((await request("reader.archive.identity.query", { archive: (await find(aid)).capability })).resolved, { user: "A User", assistant: "A AI" });
    assert.deepEqual(await hash(path.join(root, a.file)), targetBytes); assert.equal((await json(path.join(root, "Identities/identity-settings.json"))).subject, bindings.subject); assert.equal(await markFor(bid), undefined); assert(global.user);
    console.log("Package journey: Mark, reparse, preserved copy and identity isolation passed");

    const claudeSource = (await allSources()).items.find((r: any) => r.source_file === "conversations.json"); assert(claudeSource); let indexProgress = 0;
    const indexed = await request("archiver.claude.index", { source: claudeSource.capability }, e => { if (e.bytes) indexProgress++; }); assert(indexed.records >= 3 && indexProgress > 1);
    const first = await request("archiver.claude.records.query", { container: indexed.container, offset: 0, limit: 200, time_field: "created_at", direction: "asc" }); const selections = [...first.items];
    while (selections.length < first.total) { const page = await request("archiver.claude.records.query", { container: indexed.container, snapshot: first.snapshot, offset: selections.length, limit: 200 }); assert(page.items.length); selections.push(...page.items); }
    const previews = []; for (let i = 0; i < selections.length; i += 500) previews.push(await request("archiver.claude.extract.preview", { container: indexed.container, selectors: selections.slice(i, i + 500).map(r => r.selector) }));
    const extractAt = performance.now(), extracted = await request("archiver.claude.extract.commit", { plans: previews.map(p => p.plan) }); const claudeMs = performance.now() - extractAt;
    assert.equal(extracted.completed, indexed.records); assert.equal(extracted.failed, 0);
    const copyClaude = await request("archiver.claude.extract.preview", { container: indexed.container, selectors: [selections[0].selector], preserve_previous: true });
    const copiedClaude = await request("archiver.claude.extract.commit", { plans: [copyClaude.plan] }); assert.equal(copiedClaude.completed, 1); assert.equal(await markFor(copiedClaude.items[0].archive), undefined);
    console.log(`Package journey: ${names.length} HTML and ${indexed.records} official Claude records parsed`);

    let runtimeMessages = 0, materialized = 0, graphViews = 0;
    const runtimeRoot = (await request("engine.storage")).runtime_root;
    const runtimeFile = (virtual: string) => { assert(/^\/v_[\w-]+\/(?:pages|assets)\/[\w.-]+$/u.test(virtual)); return path.join(runtimeRoot, "Views", virtual.slice(1)); };
    const all = await list();
    const readerRows = all.items.filter((r: any) => r.source_file !== "conversations.json");
    readerRows.push(all.items.find((r: any) => r.source_file === "conversations.json" && r.title.includes("星陨不灭")) ?? all.items.find((r: any) => r.source_file === "conversations.json"));
    for (const row of readerRows) {
      const viewRequest = { messages: { offset: 0, limit: 200 }, navigation: { offset: 0, limit: 500 }, branches: { offset: 0, limit: 200 } };
      const opened = await request("reader.view.open", { archive: row.capability, request: viewRequest }); let descriptor = opened.page, count = 0;
      try {
        let page; do { page = await json(runtimeFile(descriptor.virtual_path)); assert.equal(page.header.title, row.title); count += page.messages.length; if (!page.pagination.has_next) break; assert(page.messages.length); viewRequest.messages.offset = count; descriptor = await request("reader.view.page", { view: opened.token, request: viewRequest }); } while (true);
        assert.equal(count, page.pagination.total_visible); runtimeMessages += count; if (page.branch?.tree) graphViews++;
        const full = await json(path.join(root, "Conversations", row.directory ?? "", row.filename)); assert.equal(validateRecord("conversation", full).ok, true);
        const resource = full.resources?.find((r: any) => r.availability === "embedded");
        if (resource) { const available = await request("reader.resource.materialize", { view: opened.token, resource: resource.id }); assert.deepEqual(await hash(runtimeFile(available.virtual_path)), { bytes: resource.bytes, sha256: resource.sha256 }); materialized++; }
      } finally { await request("reader.view.close", { view: opened.token }); }
    }
    // A branch-capable graph can still be linear; do not report all graph views as Tree captures.
    const treeCaptures = records.filter(record => record.value.source.profile === "tree").length;
    assert(treeCaptures >= 8); assert(graphViews >= treeCaptures); assert(materialized > 0);
    console.log(`Package journey: Reader paginated ${runtimeMessages} messages and materialized ${materialized} resources`);
    for (const file of await files(root, "Conversations")) assert.equal(validateRecord("conversation", await json(path.join(root, file))).ok, true, file);
    const logs = await request("systemLog.list", { offset: 0, limit: 200 }); assert(logs.total > 0); const reveal = await request("systemLog.reveal", { file: logs.items[0].capability }); assert((await lstat(path.join(root, reveal.path))).isFile());

    await createTime({ kind: "timeline", name: "Journey Axis", author: "Cloudig", standard_name: null, version: "1.0" });
    await createTime({ kind: "periodic", name: "Journey Cycle", count: 12, prefix: null, unit: null, display_empty: true });
    await createTime({ kind: "single", name: "Journey Mapped" }, [{ range: { start: { kind: "calendar", era: "AD", year: 2000 } } }]);
    const axis = await queryTime("Journey Axis"), cycle = await queryTime("Journey Cycle"), mapped = await queryTime("Journey Mapped");
    let draft = timeDraft(axis.editor); draft.children = [{ node: cycle.row.node, count: 12 }, { node: mapped.row.node }];
    let preview = await request("time.editor.preview", { route: axis.cover.route, action: "edit", node: axis.row.node, draft }); await request("time.editor.commit", { plan: preview.plan, strategy: "in_place", selected_references: [] });
    const freshCycle = await queryTime("Journey Cycle"), freshMapped = await queryTime("Journey Mapped"); draft = timeDraft(freshCycle.editor); draft.counterparts = [{ target: { node: freshMapped.row.node }, self_occurrences: { first: 2, step: 2, last: 12 } }];
    preview = await request("time.editor.preview", { route: freshCycle.cover.route, action: "edit", node: freshCycle.row.node, draft }); await request("time.editor.commit", { plan: preview.plan, strategy: "in_place", selected_references: [] });
    const selectedAxis = await queryTime("Journey Axis"), children = await request("time.nodes.children", { route: selectedAxis.cover.route, node: selectedAxis.row.node }); const child = children.items.find((r: any) => r.name === "Journey Cycle"); assert(child);
    const endpoint = (await request("time.endpoint.preview", { route: selectedAxis.cover.route, node: child.node, occurrences: { first: 2, step: 2, last: 12 } })).endpoint;
    for (const id of [aid, bid]) await edit(id, value => { value.content_time = { state: "set", range: { start: endpoint } }; });
    assert.equal((await markFor(aid))!.value.content_time.range.start.snapshot.sort.start.year, 2000);
    for (const strategy of ["all_references", "selected_references", "future_only"]) {
      const state = await queryTime(strategy === "future_only" ? "Journey Cycle selected_references" : strategy === "selected_references" ? "Journey Cycle all_references" : "Journey Cycle");
      const beforeA = (await markFor(aid))!.bytes, beforeB = (await markFor(bid))!.bytes, sourceBytes = await hash(path.join(root, a.file)); draft = timeDraft(state.editor); draft.metadata.name = `Journey Cycle ${strategy}`;
      preview = await request("time.editor.preview", { route: state.cover.route, action: "edit", node: state.row.node, draft });
      const references = preview.impact.affected_references, selected = strategy === "selected_references" ? [references.find((r: any) => r.title === "Journey A").reference] : [];
      const choice = { plan: preview.plan, strategy, selected_references: selected }; await request("time.editor.selection.preview", choice); await request("time.editor.commit", choice);
      assert.deepEqual(await hash(path.join(root, a.file)), sourceBytes);
      if (strategy !== "all_references") assert.deepEqual((await markFor(bid))!.bytes, beforeB); else assert.notDeepEqual((await markFor(bid))!.bytes, beforeB);
      if (strategy === "future_only") assert.deepEqual((await markFor(aid))!.bytes, beforeA); else assert.notDeepEqual((await markFor(aid))!.bytes, beforeA);
    }
    const timeNodes = []; for (const file of await files(root, "ContentTimes")) if (!file.endsWith("/order.json")) { const value = await json(path.join(root, file)); assert.equal(validateRecord("contentTime", value).ok, true); assert(!("owner" in value || "lineage" in value || "variant" in value || "current" in value)); timeNodes.push(value); }
    assert(timeNodes.some(value => value.forked_from));
    const modernCover = await timeCover(), modern = modernCover.terran.items.find((r: any) => r.name === "现代社会"); assert(modern);
    const modernEndpoint = (await request("time.endpoint.preview", { route: modernCover.route, node: modern.node })).endpoint;
    for (const id of [aid, bid]) await edit(id, value => { value.content_time = { state: "set", range: { start: modernEndpoint } }; });
    for (const id of [aid, bid]) {
      const mark = (await markFor(id))!, value = structuredClone(mark.value);
      const ageAnchors = (entry: any) => { if (!entry || typeof entry !== "object") return; if (entry.anchor?.date) entry.anchor.date = "2020-01-01"; for (const child of Object.values(entry)) ageAnchors(child); }; ageAnchors(value.content_time);
      await commitRecords(root, [{ action: "write", kind: "mark", path: mark.file, expected: (await hash(path.join(root, mark.file))).sha256, value }]);
    }
    const sharedBefore = await fingerprints(root, ["ContentTimes"]), otherBefore = (await markFor(bid))!.bytes, anchorBefore = (await markFor(aid))!.bytes;
    await edit(aid, () => {}, { refresh_anchor: true }); assert.notDeepEqual((await markFor(aid))!.bytes, anchorBefore); assert.deepEqual((await markFor(bid))!.bytes, otherBefore); assert.deepEqual(await fingerprints(root, ["ContentTimes"]), sharedBefore);
    console.log("Package journey: Time synchronization and A-only anchor isolation passed");

    const beforeMove = await hash(path.join(root, a.file)), beforeMarkMove = (await markFor(aid))!.bytes;
    await request("reader.directory.create", { name: "Journey" }); let directory = (await list()).directories.find((d: any) => d.name === "Journey");
    const prefs = await request("library.preferences.query"); await request("library.preferences.commit", { expected_revision: prefs.revision, default_output_directory: "Conversations/Journey" });
    await request("reader.archive.move", { archive: (await find(aid)).capability, directory: directory.capability });
    directory = (await list()).directories.find((d: any) => d.name === "Journey"); await request("reader.directory.rename", { directory: directory.capability, name: "Journey-Renamed" });
    assert.equal((await request("library.preferences.query")).default_output_directory, "Conversations/Journey-Renamed");
    await request("reader.archive.archive", { archive: (await find(aid)).capability }); await request("reader.archive.restore", { archive: (await find(aid, true)).capability });
    directory = (await list()).directories.find((d: any) => d.name === "Journey-Renamed"); await request("reader.directory.delete", { directory: directory.capability });
    assert.equal((await request("library.preferences.query")).default_output_directory, "Conversations"); assert.deepEqual(await hash(path.join(root, a.file)), beforeMove); assert.deepEqual((await markFor(aid))!.bytes, beforeMarkMove);
    const exported = await request("reader.archive.exportMarkdown", { archive: (await find(aid)).capability }); assert.equal(exported.status, "exported"); assert.deepEqual(await hash(path.join(root, "Exports", exported.filename)), { bytes: exported.bytes, sha256: exported.sha256 });
    console.log("Package journey: directory operations and Markdown export passed");

    // A fake native destination tests the exact pair/lease contract. Real Windows Recycle Bin has its separate WPF gate.
    const recycle = await request("reader.archive.recycle.plan", { archive: (await find(aid)).capability }); assert.equal(recycle.files.length, 2); await request("reader.archive.recycle.begin", { plan: recycle.plan });
    const recycled = path.join(scope, "FakeRecycle"); await mkdir(recycled);
    for (const file of recycle.files) { assert(/^(Conversations|Marks)\//u.test(file.path)); await rename(path.join(root, file.path), path.join(recycled, path.basename(file.path))); }
    assert.equal((await request("reader.archive.recycle.complete", { plan: recycle.plan })).status, "recycled");
    const finalCount = names.length + indexed.records + 1; assert.equal((await list()).total, finalCount); assert.equal((await readdir(path.join(root, "Inbox"))).length, names.length + 1);
    const beforeRecovery = await fingerprints(root, ["Conversations", "Marks", "ContentTimes", "Identities"]);
    await request("indexes.rebuild"); assert.deepEqual(await fingerprints(root, ["Conversations", "Marks", "ContentTimes", "Identities"]), beforeRecovery);
    await engine.close(); await rename(path.join(root, "appdata/indexes/conversations.json"), path.join(scope, "PreviousCatalog.json"));
    engine = startRecordEngine({ packageRoot, libraryRoot: root }); assert.equal((await list()).total, finalCount); assert.deepEqual(await fingerprints(root, ["Conversations", "Marks", "ContentTimes", "Identities"]), beforeRecovery);
    await engine.close(); await rename(path.join(root, "CloudigLibrary.json"), path.join(scope, "PreviousLibrarySettings.json"));
    engine = startRecordEngine({ packageRoot, libraryRoot: root }); assert.equal((await request("library.startup.recover")).status, "settings_recovery"); await request("library.settings.recover");
    assert.deepEqual(await fingerprints(root, ["Conversations", "Marks", "ContentTimes", "Identities"]), beforeRecovery); assert.equal((await list()).total, finalCount);
    await engine.close(); const settings = await readStoredRecord(root, "library", "CloudigLibrary.json"), restoredBytes = await readFile(path.join(root, "CloudigLibrary.json")); (settings.value["settings"] as JsonObject)["language"] = "en";
    await assert.rejects(commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", expected: settings.sha256, value: settings.value }], { fault: point => { if (point === "displaced_0") throw new Error("intentional journey interruption"); } }));
    const pending = await pendingRecordOperations(root); assert.equal(pending.length, 1); engine = startRecordEngine({ packageRoot, libraryRoot: root }); assert.equal((await request("library.startup.recover")).status, "transaction_recovery");
    await request("library.recovery.commit", { operation: pending[0]!, action: "rollback" }); assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), restoredBytes);
    await engine.close(); const moved = path.join(scope, "MovedRecords"); await rename(root, moved); root = moved; engine = startRecordEngine({ packageRoot, libraryRoot: root });
    assert.equal((await request("library.startup.recover")).status, "valid"); assert.equal((await list()).total, finalCount); assert.deepEqual(await fingerprints(root, ["Conversations", "Marks", "ContentTimes", "Identities"]), beforeRecovery);
    for (const [name, original] of originals) assert.deepEqual(await hash(path.join(sampleRoot, name)), original); assert.deepEqual(await hash(claudeContainer), officialHash); assert.deepEqual(await hash(path.join(packageRoot, "app/engine/engine.mjs")), programBefore);
    console.log(JSON.stringify({ sample_files: names.length, execution: "packaged-record-engine", planned: { new: plan.total }, committed: { created: parsed.completed, updated: 1, preserved: 1 }, progress_files: progress.size,
      claude: { records: indexed.records, created: extracted.completed, preserved: copiedClaude.completed, progress_events: indexProgress }, archives: finalCount,
      runtime: { messages: runtimeMessages, graph_views: graphViews, sample_tree_captures: treeCaptures, materialized_resources: materialized }, performance: { html_parse_ms: Math.round(htmlMs), claude_extract_ms: Math.round(claudeMs) },
      managed: { moved: 1, archived: 1, restored: 1, recycled_pair: 1, native_recycle: "simulated-by-rename" }, reader_rows: finalCount, catalog_rebuilt: true,
      settings_only_recovered: true, transaction_rollback: true, record_root_relocated: true, full_program_move: "separate-native-gate", time_strategies: ["all_references", "selected_references", "future_only"], a_only_anchor: true,
      system_log_groups: logs.total, identity_edited: true, markdown_exported: true, source_originals_unchanged: true, package_engine: programBefore, library: keepLibrary ? root : "deleted-after-verification" })); passed = true;
  } finally { await engine.close(); if (passed && !keepLibrary) { assert.equal(path.dirname(await realpath(scope)), await realpath(parent)); assert(!(await lstat(scope)).isSymbolicLink()); await rm(scope, { recursive: true }); } else console.error(`Retained package journey: ${root}`); }
});
