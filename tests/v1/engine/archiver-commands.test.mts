import { testRuntimeRoot } from "../helpers/runtime-root.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { commitLibraryPreferences, createLocalLibrary, readCatalogCache, readWelcomeLibraryState } from "../../../src/adapters/library-data/index.mts";
import { projectArchiverSources } from "../../../src/app/archiver/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { ArchiverEngineCommands } from "../../../src/engine/index.mts";
import { probeExporterRoute } from "../../../src/adapters/parser/html-envelope.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";

test("source logo probe reads only the manifest and tolerates an unparsed huge or invalid payload", async () => {
  const temporary = path.join(process.cwd(), "tmp"); await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-platform-probe-"));
  try {
    const file = path.join(base, "arbitrary-name.html");
    const manifest = '<script type="application/json" id="ai-chat-archive-manifest">{"format":"ai-chat-archive/manifest-v1","platform":"gemini"}</script>';
    await writeFile(file, `<script type="application/json" id="large-payload">${"not JSON ".repeat(140000)}</script>${manifest}<script type="application/json" id="later">invalid`);
    assert.deepEqual(await probeExporterRoute(file), { format: "exporter-html", platform: "gemini" });
    assert.deepEqual(await readdir(base), ["arbitrary-name.html"], "the list probe creates no spool or archive");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("WPF picker capabilities import exact bytes without exposing the selected path", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-source-picker-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_PICKERLIBRARYAAA",
      timestamp: "2026-08-31T22:00:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const picker = `p_${"P".repeat(43)}`;
    const pickerRoot = path.join(root, "Data", "Runtime", "Pickers", picker);
    await mkdir(pickerRoot, { recursive: true });
    const payload = Buffer.from("picked source bytes", "utf8");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(path.join(pickerRoot, "payload.bin"), payload);
    await writeFile(path.join(pickerRoot, "manifest.json"), JSON.stringify({
      schema: "cloudig/picker/1.0.0",
      picker,
      filename: "selected.html",
      bytes: payload.length,
      sha256
    }), "utf8");

    const commands = new ArchiverEngineCommands({ runtimeRoot: testRuntimeRoot(root),
      libraryRoot: root,
      transaction: () => "x_PICKERIMPORTAAAA",
      clock: () => "2026-08-31T22:01:00.000Z"
    });
    const events: JsonObject[] = [];
    const result = await commands.handlers()["source.import"]!({ pickers: [picker] }, {
      request: "q_picker",
      signal: new AbortController().signal,
      emit: async (event: JsonObject) => { events.push(event); }
    }) as JsonObject;
    assert.equal(result["state"], "completed");
    assert.deepEqual(result["items"], [{ index: 1, status: "imported", filename: "selected.html", bytes: payload.length, sha256 }]);
    assert.deepEqual(await readFile(path.join(root, "Inbox", "selected.html")), payload);
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify({ result, events }), /Data\/Runtime|Inbox\/|[A-Za-z]:\\/u);
    await assert.rejects(readFile(path.join(pickerRoot, "manifest.json")), /ENOENT/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an Adapter bundle change unlocks a previously unsupported HTML source for a fresh scan", () => {
  const [row] = projectArchiverSources([{
    path: "Inbox/unsupported.html",
    bytes: 10,
    mtimeNs: "1",
    missing: false,
    changed: false,
    catalog: {
      path: "Inbox/unsupported.html",
      bytes: 10,
      mtime_ns: "1",
      status: "unsupported",
      error: { code: "unsupported-source", phase: "probe", retry: "after_adapter_change" }
    }
  }], [], true);
  assert.equal(row?.status, "pending");
  assert.equal(row?.error, undefined);
});

test("Archiver source capabilities drive explicit plan/commit with generic progress and no managed path disclosure", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-archiver-engine-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_ARCHIVERHOSTAAAA",
      timestamp: "2026-08-31T23:00:00.000Z",
      localDate: "2026-08-31",
      offset: "-07:00",
      language: "zh-CN"
    });
    const fixture = await readFile(path.join(process.cwd(), "tests", "v1", "parser", "fixtures", "chatgpt-light.html"));
    const sourcePath = path.join(root, "Inbox", "capture.html");
    await writeFile(sourcePath, fixture);
    await writeFile(path.join(root, "Inbox", "notes.txt"), "not supported", "utf8");

    let sourceOrdinal = 0;
    let parsePlanOrdinal = 0;
    let transactionOrdinal = 0;
    const transactions = "ABCDEFGHJKLMNPQRSTUVWXYZ234567";
    const commands = new ArchiverEngineCommands({ runtimeRoot: testRuntimeRoot(root),
      libraryRoot: root,
      sourceToken: () => `s_${String(++sourceOrdinal).padStart(43, "0")}`,
      parsePlanToken: () => `pp_${String(++parsePlanOrdinal).padStart(43, "0")}`,
      operation: () => "o_AAAAAAAAAAAAAAAA",
      transaction: () => `x_${"A".repeat(15)}${transactions[transactionOrdinal++]}`,
      clock: () => "2026-08-31T23:01:00.000Z"
    });
    const handlers = commands.handlers();
    const contextEvents: JsonObject[] = [];
    const context = {
      request: "q_archiver",
      signal: new AbortController().signal,
      emit: async (event: JsonObject) => { contextEvents.push(event); }
    };
    let listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20, sort: "modified_desc" }, context) as JsonObject;
    assert.equal(listed["total"], 2);
    assert.doesNotMatch(JSON.stringify(listed), /Inbox\/|[A-Za-z]:\\/u);
    const items = listed["items"] as JsonObject[];
    const source = items.find((entry) => entry["filename"] === "capture")!;
    const unsupported = items.find((entry) => entry["filename"] === "notes.txt")!;
    assert.equal(source["status"], "pending");
    assert.equal(source["platform"], "chatgpt", "an unparsed renamed HTML gets its logo from manifest, never filename");
    assert.deepEqual(await readdir(path.join(root, "Conversations")), [], "querying the platform never parses or writes an archive");
    assert.equal(unsupported["status"], "unsupported");

    let planned = await handlers["archiver.parse.plan"]!({ sources: [source["capability"]!] }, context) as JsonObject;
    assert.deepEqual((planned["items"] as JsonObject[]).map((entry) => entry["action"]), ["new"]);
    assert.match(planned["plan"] as string, /^pp_/u);
    const beforePreference = await readWelcomeLibraryState(root);
    const preference = await commitLibraryPreferences({
      libraryRoot: root,
      expectedRevision: beforePreference.revision,
      language: "en",
      transaction: `x_${"P".repeat(16)}`,
      recoveryTransaction: `x_${"R".repeat(16)}`,
      timestamp: "2026-08-31T23:00:30.000Z"
    });
    assert.equal(preference.status, "updated");
    const stale = await handlers["archiver.parse.commit"]!({ plan: planned["plan"]!, copy_user_state: true }, context) as JsonObject;
    assert.equal(((stale["items"] as JsonObject[])[0] as JsonObject)["reason"], "library_changed_after_preview");
    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20, sort: "modified_desc" }, context) as JsonObject;
    const refreshedSource = (listed["items"] as JsonObject[]).find((entry) => entry["filename"] === "capture")!;
    planned = await handlers["archiver.parse.plan"]!({ sources: [refreshedSource["capability"]!] }, context) as JsonObject;
    const committed = await handlers["archiver.parse.commit"]!({ plan: planned["plan"]!, copy_user_state: true }, context) as JsonObject;
    assert.equal(committed["state"], "completed", JSON.stringify(committed));
    assert.equal(((committed["items"] as JsonObject[])[0] as JsonObject)["status"], "created", JSON.stringify(committed));
    assert.doesNotMatch(JSON.stringify(committed), /Conversations\/|Inbox\/|[A-Za-z]:\\/u);
    assert.ok(contextEvents.length > 3);
    assert.doesNotMatch(JSON.stringify(contextEvents), /capture\.html|Inbox\/|[A-Za-z]:\\/u);
    assert.equal((await readdir(path.join(root, "Conversations"))).filter((name) => name.endsWith(".json")).length, 1);

    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20, statuses: ["complete"] }, context) as JsonObject;
    const unchangedSource = (listed["items"] as JsonObject[])[0]!;
    const unchangedPlan = await handlers["archiver.parse.plan"]!({ sources: [unchangedSource["capability"]!] }, context) as JsonObject;
    assert.equal(((unchangedPlan["items"] as JsonObject[])[0] as JsonObject)["action"], "unchanged");
    const libraryBeforeUnchanged = await readFile(path.join(root, "cloudig-library.json"));
    const catalogBeforeUnchanged = await readFile(path.join(root, "Data", "Indexes", "Catalog", "snapshot.json"));
    const unchanged = await handlers["archiver.parse.commit"]!({ plan: unchangedPlan["plan"]!, copy_user_state: true }, context) as JsonObject;
    assert.equal(((unchanged["items"] as JsonObject[])[0] as JsonObject)["status"], "unchanged");
    assert.deepEqual(await readFile(path.join(root, "cloudig-library.json")), libraryBeforeUnchanged);
    assert.deepEqual(await readFile(path.join(root, "Data", "Indexes", "Catalog", "snapshot.json")), catalogBeforeUnchanged);

    await rm(path.join(root, "Data", "Indexes"), { recursive: true, force: true });
    contextEvents.length = 0;
    const rebuilt = await handlers["indexes.rebuild"]!({}, context) as JsonObject;
    assert.deepEqual(
      { state: rebuilt["state"], archives: rebuilt["archives"], sources: rebuilt["sources"] },
      { state: "completed", archives: 1, sources: 2 }
    );
    assert.ok(contextEvents.some((event) => event["phase"] === "index"));
    assert.doesNotMatch(JSON.stringify({ rebuilt, contextEvents }), /Inbox\/|Conversations\/|[A-Za-z]:\\/u);

    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20, statuses: ["complete"] }, context) as JsonObject;
    assert.equal(listed["total"], 1);
    const completed = (listed["items"] as JsonObject[])[0]!;
    assert.equal(completed["filename"], "capture");
    assert.equal(completed["kind"], "bookmark_html");
    assert.equal(completed["platform"], "chatgpt");

    await rm(path.join(root, "Inbox", "notes.txt"));
    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20, statuses: ["missing"] }, context) as JsonObject;
    assert.equal(listed["total"], 1);
    const missing = (listed["items"] as JsonObject[])[0]!;
    assert.equal(missing["filename"], "notes.txt");
    assert.equal(missing["status"], "missing");
    assert.deepEqual(await handlers["archiver.source.dismissMissing"]!({ source: missing["capability"]! }, context), { status: "dismissed" });
    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20 }, context) as JsonObject;
    assert.equal((listed["items"] as JsonObject[]).some((entry) => entry["filename"] === "notes.txt"), false);
    assert.equal(((await readCatalogCache(root))!["archives"] as JsonObject[]).length, 1);

    await writeFile(sourcePath, Buffer.concat([fixture, Buffer.from("\n<!-- changed -->\n", "utf8")]));
    await assert.rejects(
      () => handlers["archiver.parse.plan"]!({ sources: [completed["capability"]!] }, context),
      /changed|stale/iu
    );
    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20 }, context) as JsonObject;
    const changedSource = (listed["items"] as JsonObject[]).find((entry) => entry["filename"] === "capture")!;
    const updatePlan = await handlers["archiver.parse.plan"]!({ sources: [changedSource["capability"]!] }, context) as JsonObject;
    assert.equal(((updatePlan["items"] as JsonObject[])[0] as JsonObject)["action"], "safe_update");
    const updated = await handlers["archiver.parse.commit"]!({ plan: updatePlan["plan"]!, copy_user_state: true }, context) as JsonObject;
    assert.equal(((updated["items"] as JsonObject[])[0] as JsonObject)["status"], "updated");
    listed = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20 }, context) as JsonObject;
    const currentSource = (listed["items"] as JsonObject[]).find((entry) => entry["filename"] === "capture")!;
    const preservePlan = await handlers["archiver.parse.plan"]!({ sources: [currentSource["capability"]!], preserve_previous: true, copy_user_state: true }, context) as JsonObject;
    assert.equal(((preservePlan["items"] as JsonObject[])[0] as JsonObject)["action"], "preserve");
    const preserved = await handlers["archiver.parse.commit"]!({ plan: preservePlan["plan"]!, copy_user_state: false }, context) as JsonObject;
    assert.equal(((preserved["items"] as JsonObject[])[0] as JsonObject)["status"], "preserved");
    assert.equal((await readdir(path.join(root, "Conversations"))).filter((name) => name.endsWith(".json")).length, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Claude container capabilities index, query, preview and commit selected records without exposing source identity", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-claude-engine-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_CLAUDEHOSTCREATEA",
      timestamp: "2026-09-01T08:00:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "zh-CN"
    });
    await writeFile(path.join(root, "Inbox", "conversations.json"), JSON.stringify([
      {
        uuid: "private-alpha-uuid",
        name: "Alpha archive",
        created_at: "2026-08-20T11:10:15Z",
        updated_at: "2026-08-20T12:04:10Z",
        chat_messages: [
          { uuid: "a1", sender: "human", parent_message_uuid: null, created_at: "2026-08-20T11:11:00Z", text: "hello", content: [] },
          { uuid: "a2", sender: "assistant", parent_message_uuid: "a1", created_at: "2026-08-20T11:12:00Z", content: [{ type: "text", text: "answer" }] }
        ]
      },
      {
        uuid: "private-beta-uuid",
        name: "Beta archive",
        created_at: "2026-08-21T01:00:00Z",
        updated_at: "2026-08-21T02:00:00Z",
        chat_messages: [{ uuid: "b1", sender: "assistant", parent_message_uuid: null, content: [{ type: "text", text: "kept" }] }]
      }
    ], null, 2), "utf8");

    let transactionOrdinal = 0;
    let claudePlanOrdinal = 0;
    const suffixes = "BCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const commands = new ArchiverEngineCommands({ runtimeRoot: testRuntimeRoot(root),
      libraryRoot: root,
      sourceToken: () => `s_${"S".repeat(43)}`,
      containerToken: () => `c_${"C".repeat(43)}`,
      claudePlanToken: () => `ep_${String(++claudePlanOrdinal).padStart(43, "0")}`,
      transaction: () => `x_${"A".repeat(15)}${suffixes[transactionOrdinal++]}`,
      operation: () => "o_CLAUDEENGINEAAAA",
      clock: () => "2026-09-01T08:01:00.000Z"
    });
    const handlers = commands.handlers();
    const events: JsonObject[] = [];
    const context = {
      request: "q_claude",
      signal: new AbortController().signal,
      emit: async (event: JsonObject) => { events.push(event); }
    };
    const sources = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20 }, context) as JsonObject;
    const source = (sources["items"] as JsonObject[]).find((item) => item["filename"] === "conversations.json")!;
    const indexed = await handlers["archiver.claude.index"]!({ source: source["capability"]! }, context) as JsonObject;
    assert.equal(indexed["records"], 2);
    assert.equal(indexed["container"], `c_${"C".repeat(43)}`);
    assert.ok(events.some((event) => event["phase"] === "index"));
    assert.doesNotMatch(JSON.stringify({ indexed, events }), /Inbox\/|Data\/Indexes|private-(?:alpha|beta)-uuid|[A-Za-z]:\\/u);

    const listed = await handlers["archiver.claude.records.query"]!({
      container: indexed["container"]!,
      offset: 0,
      limit: 20,
      search: "archive",
      time_field: "created_at",
      sort: "title",
      direction: "asc"
    }, context) as JsonObject;
    assert.deepEqual((listed["items"] as JsonObject[]).map((item) => [item["title"], item["status"]]), [["Alpha archive", "ready"], ["Beta archive", "ready"]]);
    assertIpcValue(indexed);
    assertIpcValue(listed);
    assert.deepEqual((listed["items"] as JsonObject[]).map((item) => [item["messages"], item["branches"]]), [[2, 1], [1, 1]]);
    const selector = ((listed["items"] as JsonObject[])[0] as JsonObject)["selector"]!;
    const secondSelector = ((listed["items"] as JsonObject[])[1] as JsonObject)["selector"]!;
    const preview = await handlers["archiver.claude.extract.preview"]!({ container: indexed["container"]!, selectors: [selector] }, context) as JsonObject;
    const secondPreview = await handlers["archiver.claude.extract.preview"]!({ container: indexed["container"]!, selectors: [secondSelector] }, context) as JsonObject;
    assert.equal(((preview["items"] as JsonObject[])[0] as JsonObject)["action"], "new");
    assert.equal(((secondPreview["items"] as JsonObject[])[0] as JsonObject)["action"], "new");
    assert.match(preview["plan"] as string, /^ep_/u);

    const beforePreference = await readWelcomeLibraryState(root);
    const preference = await commitLibraryPreferences({
      libraryRoot: root,
      expectedRevision: beforePreference.revision,
      language: "en",
      transaction: `x_${"C".repeat(16)}`,
      recoveryTransaction: `x_${"D".repeat(16)}`,
      timestamp: "2026-09-01T08:00:30.000Z"
    });
    assert.equal(preference.status, "updated");
    const stale = await handlers["archiver.claude.extract.commit"]!({ plans: [preview["plan"]!, secondPreview["plan"]!], copy_user_state: true }, context) as JsonObject;
    assert.deepEqual((stale["items"] as JsonObject[]).map((item) => item["reason"]), ["library_changed_after_preview", "library_changed_after_preview"]);
    const currentPreview = await handlers["archiver.claude.extract.preview"]!({ container: indexed["container"]!, selectors: [selector] }, context) as JsonObject;
    const currentSecondPreview = await handlers["archiver.claude.extract.preview"]!({ container: indexed["container"]!, selectors: [secondSelector] }, context) as JsonObject;

    events.length = 0;
    const committed = await handlers["archiver.claude.extract.commit"]!({ plans: [currentPreview["plan"]!, currentSecondPreview["plan"]!], copy_user_state: true }, context) as JsonObject;
    assert.equal(((committed["items"] as JsonObject[])[0] as JsonObject)["status"], "created", JSON.stringify(committed));
    assert.equal(((committed["items"] as JsonObject[])[1] as JsonObject)["status"], "created", JSON.stringify(committed));
    assert.doesNotMatch(JSON.stringify({ committed, events }), /conversations\.json|Alpha archive|Inbox\/|Conversations\/|[A-Za-z]:\\/u);
    const parsed = await handlers["archiver.claude.records.query"]!({ container: indexed["container"]!, offset: 0, limit: 20, statuses: ["parsed"] }, context) as JsonObject;
    assert.equal(parsed["visible"], 2);
    assert.equal(((parsed["items"] as JsonObject[])[0] as JsonObject)["status"], "parsed");
    const unchangedPreview = await handlers["archiver.claude.extract.preview"]!({ container: indexed["container"]!, selectors: [selector] }, context) as JsonObject;
    assert.equal(((unchangedPreview["items"] as JsonObject[])[0] as JsonObject)["action"], "unchanged");
    const originalContainerBytes = await readFile(path.join(root, "Inbox", "conversations.json"));
    const originalContainerSha = createHash("sha256").update(originalContainerBytes).digest("hex");
    const originalContainerState = path.join(root, "Data", "Indexes", "Containers", originalContainerSha, "state.json");
    const stateBeforeUnchanged = await stat(originalContainerState, { bigint: true });
    const unchanged = await handlers["archiver.claude.extract.commit"]!({ plans: [unchangedPreview["plan"]!], copy_user_state: true }, context) as JsonObject;
    assert.equal(((unchanged["items"] as JsonObject[])[0] as JsonObject)["status"], "unchanged");
    const stateAfterUnchanged = await stat(originalContainerState, { bigint: true });
    assert.equal(stateAfterUnchanged.mtimeNs, stateBeforeUnchanged.mtimeNs, "unchanged extraction does not rewrite the rebuildable container state");

    const changedContainer = JSON.parse(await readFile(path.join(root, "Inbox", "conversations.json"), "utf8")) as JsonObject[];
    (((changedContainer[0]!["chat_messages"] as JsonObject[])[1]!["content"] as JsonObject[])[0] as JsonObject)["text"] = "revised answer";
    (((changedContainer[1]!["chat_messages"] as JsonObject[])[0]!["content"] as JsonObject[])[0] as JsonObject)["text"] = "revised kept";
    await writeFile(path.join(root, "Inbox", "conversations.json"), JSON.stringify(changedContainer, null, 2), "utf8");
    const changedSources = await handlers["archiver.sources.query"]!({ offset: 0, limit: 20 }, context) as JsonObject;
    const changedSource = (changedSources["items"] as JsonObject[]).find((item) => item["filename"] === "conversations.json")!;
    const changedIndex = await handlers["archiver.claude.index"]!({ source: changedSource["capability"]! }, context) as JsonObject;
    const changedRecords = await handlers["archiver.claude.records.query"]!({ container: changedIndex["container"]!, offset: 0, limit: 20, sort: "title", direction: "asc" }, context) as JsonObject;
    const changedSelector = ((changedRecords["items"] as JsonObject[])[0] as JsonObject)["selector"]!;
    const changedSecondSelector = ((changedRecords["items"] as JsonObject[])[1] as JsonObject)["selector"]!;
    const updatePreview = await handlers["archiver.claude.extract.preview"]!({ container: changedIndex["container"]!, selectors: [changedSelector] }, context) as JsonObject;
    assert.equal(((updatePreview["items"] as JsonObject[])[0] as JsonObject)["action"], "safe_update");
    const updated = await handlers["archiver.claude.extract.commit"]!({ plans: [updatePreview["plan"]!], copy_user_state: true }, context) as JsonObject;
    assert.equal(((updated["items"] as JsonObject[])[0] as JsonObject)["status"], "updated", JSON.stringify(updated));
    const preservePreview = await handlers["archiver.claude.extract.preview"]!({
      container: changedIndex["container"]!, selectors: [changedSecondSelector], preserve_previous: true, copy_user_state: true
    }, context) as JsonObject;
    assert.equal(((preservePreview["items"] as JsonObject[])[0] as JsonObject)["action"], "preserve");
    const preserved = await handlers["archiver.claude.extract.commit"]!({ plans: [preservePreview["plan"]!], copy_user_state: false }, context) as JsonObject;
    assert.equal(((preserved["items"] as JsonObject[])[0] as JsonObject)["status"], "preserved", JSON.stringify(preserved));
    assert.equal((await readdir(path.join(root, "Conversations"))).filter((name) => name.endsWith(".json")).length, 3);

    const rebuilt = await handlers["archiver.claude.index"]!({ source: changedSource["capability"]!, rebuild: true }, context) as JsonObject;
    assert.equal(rebuilt["status"], "rebuilt");
    const afterRebuild = await handlers["archiver.claude.records.query"]!({ container: rebuilt["container"]!, offset: 0, limit: 20, statuses: ["parsed"] }, context) as JsonObject;
    assert.equal(afterRebuild["visible"], 2, "rebuilding the projection preserves completed output watermarks");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
