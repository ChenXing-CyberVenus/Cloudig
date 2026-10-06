import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLocalLibrary } from "../../../src/adapters/library-data/index.mts";
import { serializeLibrary, serializeTimeSystem } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { buildSovereignSnapshot } from "../../../src/core/time/index.mts";
import { TimeEngineCommands } from "../../../src/engine/index.mts";

function context() {
  return { request: "q_time", signal: new AbortController().signal, emit: async () => undefined };
}

test("Time display order saves atomically, survives reopening and leaves node facts untouched", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-time-order-"));
  const root = path.join(base, "Library");
  const libraryPath = path.join(root, "cloudig-library.json");
  const timePath = path.join(root, "Data", "State", "content-time.json");
  let commands: TimeEngineCommands | undefined;
  try {
    await createLocalLibrary({ root, transaction: "x_TIMEORDERENGINEA", timestamp: "2026-09-06T10:00:00.000Z", localDate: "2026-09-06", offset: "Z", language: "zh-CN" });
    const original = JSON.parse(await readFile(path.join(process.cwd(), "tests/v1/contracts/fixtures/time-system-full.json"), "utf8")) as JsonObject;
    const bytes = Buffer.from(serializeTimeSystem(original));
    const library = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    library["revision"] = 5;
    library["content_time"] = { schema: original["schema"]!, revision: original["revision"]!, sha256: createHash("sha256").update(bytes).digest("hex") };
    await writeFile(timePath, bytes); await writeFile(libraryPath, serializeLibrary(library));
    commands = new TimeEngineCommands({ libraryRoot: root, clock: () => "2026-09-06T12:00:00.000Z" });
    let handlers = commands.handlers();
    const cover = await handlers["time.cover.query"]!({ return_to: "archiver" }, context()) as JsonObject;
    const rows = (cover["sovereign"] as JsonObject)["items"] as JsonObject[];
    assert.deepEqual(rows.map(row => row["name"]), ["星河纪元·分叉", "星河纪元"]);
    const payload = { route: cover["route"]!, expected_time_revision: cover["revision"]!, expected_library_revision: cover["library_revision"]!, nodes: rows.map(row => row["node"]!).reverse() };
    const saved = await handlers["time.order.commit"]!(payload, context()) as JsonObject;
    assert.equal(saved["status"], "updated"); assert.equal(saved["revision"], 6); assert.equal(saved["library_revision"], 6);
    const installedBytes = await readFile(timePath);
    const installed = JSON.parse(installedBytes.toString("utf8")) as JsonObject;
    const installedLibraryBytes = await readFile(libraryPath);
    const installedLibrary = JSON.parse(installedLibraryBytes.toString("utf8")) as JsonObject;
    assert.deepEqual(installed["display_order"], ["v1", "v2"]);
    for (const key of ["variants", "times", "lineages", "contains", "counterparts", "mappings", "terran_values"]) assert.deepEqual(installed[key], original[key], key);
    assert.equal((installedLibrary["content_time"] as JsonObject)["sha256"], createHash("sha256").update(installedBytes).digest("hex"));
    await assert.rejects(handlers["time.order.commit"]!(payload, context()), { code: "CLOUDIG_TIME_ORDER_STALE" });
    const current = { ...payload, expected_time_revision: 6, expected_library_revision: 6 };
    for (const nodes of [[rows[0]!["node"]!], [rows[0]!["node"]!, rows[0]!["node"]!]]) {
      await assert.rejects(handlers["time.order.commit"]!({ ...current, nodes }, context()));
    }
    const unchanged = await handlers["time.order.commit"]!(current, context()) as JsonObject;
    assert.equal(unchanged["status"], "unchanged");
    assert.deepEqual(await readFile(timePath), installedBytes); assert.deepEqual(await readFile(libraryPath), installedLibraryBytes);
    commands.close(); commands = new TimeEngineCommands({ libraryRoot: root, clock: () => "2026-09-06T12:01:00.000Z" }); handlers = commands.handlers();
    const reopened = await handlers["time.cover.query"]!({ return_to: "reader-cover" }, context()) as JsonObject;
    assert.deepEqual(((reopened["sovereign"] as JsonObject)["items"] as JsonObject[]).map(row => row["name"]), ["星河纪元", "星河纪元·分叉"]);
    const preview = await handlers["time.editor.preview"]!({ route: reopened["route"]!, action: "create_timeline", expected_time_revision: 6, expected_library_revision: 6, expected_node_revision: 6,
      draft: { metadata: { kind: "timeline", name: "新纪元", author: "晨星", standard_name: null, version: "1.0" }, children: [], counterparts: [], mappings: [] }
    }, context()) as JsonObject;
    const created = await handlers["time.editor.commit"]!({ plan: preview["plan"]!, strategy: "in_place", selected_references: [], touch_on_noop: false }, context()) as JsonObject;
    assert.equal(created["status"], "updated");
    const afterCreate = JSON.parse(await readFile(timePath, "utf8")) as JsonObject;
    assert.deepEqual(afterCreate["display_order"], ["v3", "v1", "v2"]);
  } finally { commands?.close(); await rm(base, { recursive: true, force: true }); }
});

test("Time Cover exposes bounded route/node capabilities and flat Sovereign queries without internal IDs", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-time-cover-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_TIMECOVERENGINEA",
      timestamp: "2026-09-01T10:00:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "zh-CN"
    });
    const time = JSON.parse(await readFile(path.join(process.cwd(), "tests", "v1", "contracts", "fixtures", "time-system-full.json"), "utf8")) as JsonObject;
    const timeBytes = Buffer.from(serializeTimeSystem(time), "utf8");
    const libraryPath = path.join(root, "cloudig-library.json");
    const library = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    library["revision"] = 5;
    library["edited_at"] = "2026-08-31T12:00:00.000Z";
    library["content_time"] = {
      schema: "cloudig/time-system/1.0.0",
      revision: time["revision"]!,
      sha256: createHash("sha256").update(timeBytes).digest("hex")
    };
    const target = { node: "t2", occurrences: { mode: "progression", first: 1, step: 1, last: 12 } };
    const snapshot = buildSovereignSnapshot(time, target, 100);
    assert.equal(snapshot.status, "ok");
    if (snapshot.status !== "ok") return;
    library["next_archive"] = 2;
    library["archives"] = {
      a1: {
        revision: 1,
        edited_at: "2026-08-31T12:00:00.000Z",
        conversation_name: "月相记录",
        content_time: {
          state: "set",
          range: { start: { kind: "sovereign", target, snapshot: snapshot.snapshot } }
        }
      }
    };
    await writeFile(path.join(root, "Data", "State", "content-time.json"), timeBytes);
    await writeFile(libraryPath, serializeLibrary(library), "utf8");

    let routeOrdinal = 0;
    let nodeOrdinal = 0;
    let planOrdinal = 0;
    let deletePlanOrdinal = 0;
    let referenceOrdinal = 0;
    let endpointOrdinal = 0;
    const commands = new TimeEngineCommands({
      libraryRoot: root,
      routeToken: () => `tr_${String(++routeOrdinal).padStart(43, "0")}`,
      nodeToken: () => `tn_${String(++nodeOrdinal).padStart(43, "0")}`,
      planToken: () => `tp_${String(++planOrdinal).padStart(43, "0")}`,
      deletePlanToken: () => `td_${String(++deletePlanOrdinal).padStart(43, "0")}`,
      referenceToken: () => `ta_${String(++referenceOrdinal).padStart(43, "0")}`,
      endpointToken: () => `te_${String(++endpointOrdinal).padStart(43, "0")}`,
      clock: () => "2026-09-01T12:00:00.000Z",
      anchor: () => ({ date: "2026-09-01", offset: "-07:00" })
    });
    const handlers = commands.handlers();
    const cover = await handlers["time.cover.query"]!({ return_to: "archiver" }, context()) as JsonObject;
    assert.equal(cover["revision"], 5);
    const terran = cover["terran"] as JsonObject;
    const sovereign = cover["sovereign"] as JsonObject;
    assert.equal((terran["items"] as JsonObject[]).length, 16);
    assert.equal(sovereign["total"], 2);
    assert.match(cover["route"] as string, /^tr_/u);
    assert.doesNotMatch(JSON.stringify(cover), /"(?:p1|v1|v2|t1|t2|t3)"/u);
    assert.deepEqual(await handlers["time.route.resolve"]!({ route: cover["route"]! }, context()), { return_to: "archiver" });

    const rootNode = (terran["root"] as JsonObject)["node"]!;
    const children = await handlers["time.nodes.children"]!({ route: cover["route"]!, node: rootNode }, context()) as JsonObject;
    assert.equal((children["items"] as JsonObject[]).length, 16);
    const searched = await handlers["time.sovereign.query"]!({ route: cover["route"]!, offset: 0, limit: 20, search: "月相", sort: "title" }, context()) as JsonObject;
    assert.equal(searched["total"], 1);
    assert.equal(((searched["items"] as JsonObject[])[0] as JsonObject)["name"], "月相");
    assert.doesNotMatch(JSON.stringify(searched), /"(?:v1|v2|t1|t2|t3)"/u);

    const periodic = (searched["items"] as JsonObject[])[0]!;
    const endpointPreview = await handlers["time.endpoint.preview"]!({
      route: cover["route"]!, node: periodic["node"]!, occurrences: { mode: "progression", first: 1, step: 1, last: 12 }
    }, context()) as JsonObject;
    assert.doesNotMatch(JSON.stringify(endpointPreview), /"(?:v2|t2)"/u);
    const resolvedEndpoint = await commands.resolveDraftRange({ start: endpointPreview["endpoint"]! });
    assert.equal((((resolvedEndpoint["start"] as JsonObject)["target"] as JsonObject)["node"]), "t2");
    const projectedEndpoint = await commands.projectDraftRange(resolvedEndpoint);
    assert.doesNotMatch(JSON.stringify(projectedEndpoint), /"(?:v2|t2)"/u);
    const editor = await handlers["time.editor.query"]!({ route: cover["route"]!, node: periodic["node"]! }, context()) as JsonObject;
    assert.equal((editor["references"] as JsonObject[]).length, 1);
    assert.doesNotMatch(JSON.stringify(editor), /"(?:a1|v1|v2|t1|t2|t3)"/u);
    const metadata = structuredClone(editor["metadata"] as JsonObject);
    metadata["count"] = 13;
    const draft = {
      metadata,
      children: editor["children"]!,
      counterparts: editor["counterparts"]!,
      mappings: editor["mappings"]!
    };
    const preview = await handlers["time.editor.preview"]!({
      route: cover["route"]!,
      action: "edit",
      node: editor["node"]!,
      expected_time_revision: editor["time_revision"]!,
      expected_library_revision: editor["library_revision"]!,
      expected_node_revision: editor["node_revision"]!,
      draft
    }, context()) as JsonObject;
    assert.equal(preview["no_change"], false);
    assert.equal(preview["can_commit"], true);
    assert.deepEqual((preview["impact"] as JsonObject)["strategies"], ["all_references", "selected_references", "future_only"]);
    assert.doesNotMatch(JSON.stringify(preview), /"(?:a1|v1|v2|t1|t2|t3)"/u);
    const committed = await handlers["time.editor.commit"]!({
      plan: preview["plan"]!,
      strategy: "all_references",
      selected_references: [],
      touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(committed["status"], "updated");
    assert.equal(committed["time_revision"], 6);
    assert.doesNotMatch(JSON.stringify(committed), /"(?:a1|v1|v2|t1|t2|t3)"/u);
    const installedTime = JSON.parse(await readFile(path.join(root, "Data", "State", "content-time.json"), "utf8")) as JsonObject;
    const installedLibrary = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    assert.equal(((installedTime["times"] as JsonObject)["t2"] as JsonObject)["count"], 13);
    assert.equal(((installedTime["variants"] as JsonObject)["v2"] as JsonObject)["revision"], 4);
    const installedState = (installedLibrary["archives"] as JsonObject)["a1"] as JsonObject;
    assert.equal(installedState["revision"], 2);
    assert.equal((((installedState["content_time"] as JsonObject)["range"] as JsonObject)["start"] as JsonObject)["snapshot"] !== undefined, true);

    const refreshed = await handlers["time.cover.query"]!({ return_to: "archiver" }, context()) as JsonObject;
    const createdPreview = await handlers["time.editor.preview"]!({
      route: refreshed["route"]!,
      action: "create_timeline",
      expected_time_revision: refreshed["revision"]!,
      expected_library_revision: installedLibrary["revision"]!,
      expected_node_revision: refreshed["revision"]!,
      draft: {
        metadata: { kind: "timeline", name: "新纪元", author: "晨星", standard_name: null, version: "1.0" },
        children: [], counterparts: [], mappings: []
      }
    }, context()) as JsonObject;
    const created = await handlers["time.editor.commit"]!({
      plan: createdPreview["plan"]!,
      strategy: "in_place",
      selected_references: [],
      touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(created["status"], "updated");
    assert.doesNotMatch(JSON.stringify(created), /"(?:l2|v3)"/u);
    const afterCreate = JSON.parse(await readFile(path.join(root, "Data", "State", "content-time.json"), "utf8")) as JsonObject;
    assert.equal(((afterCreate["variants"] as JsonObject)["v3"] as JsonObject)["revision"], 1);
    assert.equal(((afterCreate["lineages"] as JsonObject)["l2"] as JsonObject)["current"], "v3");

    const nextCover = await handlers["time.cover.query"]!({ return_to: "archiver" }, context()) as JsonObject;
    const nextSearch = await handlers["time.sovereign.query"]!({ route: nextCover["route"]!, offset: 0, limit: 20, search: "月相", sort: "title" }, context()) as JsonObject;
    const nextPeriodic = (nextSearch["items"] as JsonObject[])[0]!;
    const nextEditor = await handlers["time.editor.query"]!({ route: nextCover["route"]!, node: nextPeriodic["node"]! }, context()) as JsonObject;
    const unchangedDraft = {
      metadata: nextEditor["metadata"]!,
      children: nextEditor["children"]!,
      counterparts: nextEditor["counterparts"]!,
      mappings: nextEditor["mappings"]!
    };
    const unchangedPreview = await handlers["time.editor.preview"]!({
      route: nextCover["route"]!, action: "edit", node: nextEditor["node"]!,
      expected_time_revision: nextEditor["time_revision"]!, expected_library_revision: nextEditor["library_revision"]!, expected_node_revision: nextEditor["node_revision"]!,
      draft: unchangedDraft
    }, context()) as JsonObject;
    assert.equal(unchangedPreview["no_change"], true);
    const timeBeforeNoop = await readFile(path.join(root, "Data", "State", "content-time.json"));
    const libraryBeforeNoop = await readFile(libraryPath);
    const unchanged = await handlers["time.editor.commit"]!({
      plan: unchangedPreview["plan"]!, strategy: "in_place", selected_references: [], touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(unchanged["status"], "unchanged");
    assert.deepEqual(await readFile(path.join(root, "Data", "State", "content-time.json")), timeBeforeNoop);
    assert.deepEqual(await readFile(libraryPath), libraryBeforeNoop);

    const invalidMetadata = structuredClone(nextEditor["metadata"] as JsonObject);
    invalidMetadata["count"] = 2;
    const invalidPreview = await handlers["time.editor.preview"]!({
      route: nextCover["route"]!, action: "edit", node: nextEditor["node"]!,
      expected_time_revision: nextEditor["time_revision"]!, expected_library_revision: nextEditor["library_revision"]!, expected_node_revision: nextEditor["node_revision"]!,
      draft: { ...unchangedDraft, metadata: invalidMetadata }
    }, context()) as JsonObject;
    assert.equal(invalidPreview["can_commit"], false);
    assert.ok(((invalidPreview["impact"] as JsonObject)["invalid_selectors"] as JsonObject[]).length >= 2);

    const forkMetadata = structuredClone(nextEditor["metadata"] as JsonObject);
    forkMetadata["count"] = 14;
    const forkPreview = await handlers["time.editor.preview"]!({
      route: nextCover["route"]!, action: "edit", node: nextEditor["node"]!,
      expected_time_revision: nextEditor["time_revision"]!, expected_library_revision: nextEditor["library_revision"]!, expected_node_revision: nextEditor["node_revision"]!,
      draft: { ...unchangedDraft, metadata: forkMetadata }
    }, context()) as JsonObject;
    const affected = ((forkPreview["impact"] as JsonObject)["affected_references"] as JsonObject[])[0]!;
    const forked = await handlers["time.editor.commit"]!({
      plan: forkPreview["plan"]!, strategy: "selected_references", selected_references: [affected["reference"]!], touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(forked["status"], "updated");
    assert.doesNotMatch(JSON.stringify(forked), /"(?:a1|v4|t5)"/u);
    const afterFork = JSON.parse(await readFile(path.join(root, "Data", "State", "content-time.json"), "utf8")) as JsonObject;
    const afterForkLibrary = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    assert.equal(((afterFork["times"] as JsonObject)["t2"] as JsonObject)["count"], 13);
    assert.equal(((afterFork["times"] as JsonObject)["t5"] as JsonObject)["count"], 14);
    assert.equal(((afterFork["lineages"] as JsonObject)["l1"] as JsonObject)["current"], "v4");
    const forkedState = (afterForkLibrary["archives"] as JsonObject)["a1"] as JsonObject;
    assert.equal((((((forkedState["content_time"] as JsonObject)["range"] as JsonObject)["start"] as JsonObject)["target"] as JsonObject)["node"]), "t5");

    const forkedEditor = await handlers["time.editor.query"]!({ route: nextCover["route"]!, node: forked["node"]! }, context()) as JsonObject;
    const forkedReference = (forkedEditor["references"] as JsonObject[])[0]!;
    const cancelPreview = await handlers["time.editor.preview"]!({
      route: nextCover["route"]!, action: "edit", node: forkedEditor["node"]!,
      expected_time_revision: forkedEditor["time_revision"]!, expected_library_revision: forkedEditor["library_revision"]!, expected_node_revision: forkedEditor["node_revision"]!,
      cancel_references: [forkedReference["reference"]!],
      draft: {
        metadata: forkedEditor["metadata"]!, children: forkedEditor["children"]!,
        counterparts: forkedEditor["counterparts"]!, mappings: forkedEditor["mappings"]!
      }
    }, context()) as JsonObject;
    assert.equal(cancelPreview["no_change"], false);
    assert.deepEqual((cancelPreview["impact"] as JsonObject)["strategies"], ["in_place"]);
    const timeBeforeCancel = await readFile(path.join(root, "Data", "State", "content-time.json"));
    const cancelled = await handlers["time.editor.commit"]!({
      plan: cancelPreview["plan"]!, strategy: "in_place", selected_references: [], touch_on_noop: false
    }, context()) as JsonObject;
    assert.equal(cancelled["status"], "updated");
    assert.deepEqual(await readFile(path.join(root, "Data", "State", "content-time.json")), timeBeforeCancel);
    const afterCancelLibrary = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    assert.deepEqual((((afterCancelLibrary["archives"] as JsonObject)["a1"] as JsonObject)["content_time"]), { state: "cleared" });

    const afterCancelTime = JSON.parse(await readFile(path.join(root, "Data", "State", "content-time.json"), "utf8")) as JsonObject;
    const deleteTarget = { node: "t5", occurrences: { mode: "progression", first: 1, step: 1, last: 14 } };
    const deleteSnapshot = buildSovereignSnapshot(afterCancelTime, deleteTarget, 100);
    assert.equal(deleteSnapshot.status, "ok");
    if (deleteSnapshot.status !== "ok") return;
    const restoredArchive = (afterCancelLibrary["archives"] as JsonObject)["a1"] as JsonObject;
    restoredArchive["revision"] = (restoredArchive["revision"] as number) + 1;
    restoredArchive["edited_at"] = "2026-09-01T12:01:00.000Z";
    restoredArchive["content_time"] = {
      state: "set",
      range: { start: { kind: "sovereign", target: deleteTarget, snapshot: deleteSnapshot.snapshot } }
    };
    afterCancelLibrary["revision"] = (afterCancelLibrary["revision"] as number) + 1;
    afterCancelLibrary["edited_at"] = "2026-09-01T12:01:00.000Z";
    await writeFile(libraryPath, serializeLibrary(afterCancelLibrary), "utf8");

    const deleteEditor = await handlers["time.editor.query"]!({ route: nextCover["route"]!, node: cancelled["owner"]! }, context()) as JsonObject;
    const deletePreview = await handlers["time.delete.preview"]!({
      route: nextCover["route"]!, node: deleteEditor["node"]!,
      expected_time_revision: deleteEditor["time_revision"]!, expected_library_revision: deleteEditor["library_revision"]!, expected_node_revision: deleteEditor["node_revision"]!
    }, context()) as JsonObject;
    assert.match(deletePreview["plan"] as string, /^td_/u);
    assert.doesNotMatch(JSON.stringify(deletePreview), /"(?:a1|l1|v1|v2|v4|t1|t2|t4|t5)"/u);
    const deleteImpact = deletePreview["impact"] as JsonObject;
    assert.equal(deleteImpact["current_variant"], true);
    assert.equal(deleteImpact["replacement_required"], true);
    assert.equal(deleteImpact["clear_references_required"], true);
    assert.equal((deleteImpact["affected_references"] as JsonObject[]).length, 1);
    const replacement = ((deleteImpact["replacement_variants"] as JsonObject[])[0] as JsonObject)["node"]!;
    await assert.rejects(() => handlers["time.delete.commit"]!({
      plan: deletePreview["plan"]!, replacement, clear_references: false
    }, context()), /reference clearing/iu);
    const deleted = await handlers["time.delete.commit"]!({
      plan: deletePreview["plan"]!, replacement, clear_references: true
    }, context()) as JsonObject;
    assert.equal(deleted["status"], "updated");
    assert.equal(deleted["deleted_count"], 3);
    assert.doesNotMatch(JSON.stringify(deleted), /"(?:a1|l1|v4|t4|t5)"/u);
    const afterDelete = JSON.parse(await readFile(path.join(root, "Data", "State", "content-time.json"), "utf8")) as JsonObject;
    assert.equal("v4" in (afterDelete["variants"] as JsonObject), false);
    assert.equal("t4" in (afterDelete["times"] as JsonObject), false);
    assert.equal("t5" in (afterDelete["times"] as JsonObject), false);
    assert.notEqual(((afterDelete["lineages"] as JsonObject)["l1"] as JsonObject)["current"], "v4");
    const afterDeleteLibrary = JSON.parse(await readFile(libraryPath, "utf8")) as JsonObject;
    assert.deepEqual((((afterDeleteLibrary["archives"] as JsonObject)["a1"] as JsonObject)["content_time"]), { state: "cleared" });
    commands.close();
    await assert.rejects(() => handlers["time.route.resolve"]!({ route: cover["route"]! }, context()), /stale/iu);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
