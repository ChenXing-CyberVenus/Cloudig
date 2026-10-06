import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createLocalLibrary, inspectLocalLibrary } from "../../../src/adapters/library-data/index.mts";
import { capturePreviousAuthority, stageJournalTargets } from "../../../src/adapters/storage/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { LibraryEngineCommands } from "../../../src/engine/library-commands.mts";

const context = () => ({ request: `q_${"L".repeat(16)}`, signal: new AbortController().signal, emit: async () => undefined });

test("a missing adjacent portable Library is created only by the internal startup command", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-library-create-engine-"));
  const root = path.join(base, "Cloudig");
  try {
    await mkdir(root);
    const commands = new LibraryEngineCommands(root);
    const handlers = commands.handlers();
    assert.deepEqual(await handlers["library.startup.recover"]!({}, context()), { status: "missing" });
    const created = await handlers["library.create"]!({}, context()) as JsonObject;
    assert.deepEqual(created, { status: "created", revision: 1 });
    assert.equal((await inspectLocalLibrary(root)).status, "valid");
    await assert.rejects(() => handlers["library.create"]!({}, context()), /missing or an explicitly empty/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("startup recovery is zero-write when valid and restores one valid previous authority as a new revision", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-library-engine-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_LIBRARYCREATEABC",
      timestamp: "2026-09-01T12:00:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "zh-CN"
    });
    const commands = new LibraryEngineCommands(root);
    const handlers = commands.handlers();
    const before = await readFile(path.join(root, "cloudig-library.json"));
    assert.deepEqual(await handlers["library.startup.recover"]!({}, context()), { status: "valid", revision: 1 });
    assert.deepEqual(await readFile(path.join(root, "cloudig-library.json")), before);

    const pending: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: "x_PENDSTARTUPABCDE",
      state: "planned",
      intent: "test-startup-recovery",
      created_at: "2026-09-01T12:00:30.000Z",
      updated_at: "2026-09-01T12:00:30.000Z",
      authority: { library: { state: "missing" } },
      targets: [{
        action: "create",
        path: "Inbox/pending.html",
        status: "planned",
        expected_before: { state: "missing" },
        semantic: { kind: "source_import" }
      }]
    };
    await stageJournalTargets(root, pending, new Map([[0, Readable.from([Buffer.from("pending")])]]));
    assert.equal((await inspectLocalLibrary(root)).status, "transaction_recovery");
    assert.deepEqual(await handlers["library.startup.recover"]!({}, context()), { status: "reconciled", revision: 1 });
    assert.equal((await inspectLocalLibrary(root)).status, "valid");

    assert.equal(await capturePreviousAuthority(root, {
      transaction: "x_LIBRARYPOINTABCD",
      recordedAt: "2026-09-01T12:01:00.000Z",
      alreadyCapturedThisBatch: false
    }), "captured");
    await writeFile(path.join(root, "cloudig-library.json"), "damaged authority", "utf8");
    assert.equal((await inspectLocalLibrary(root)).status, "recovery_available");
    const restored = await handlers["library.startup.recover"]!({}, context()) as JsonObject;
    assert.equal(restored["status"], "restored");
    assert.equal(restored["revision"], 2);
    assert.equal((await inspectLocalLibrary(root)).status, "valid");
    const moved = path.join(base, "Moved-Library");
    await rename(root, moved);
    assert.equal((await inspectLocalLibrary(moved)).status, "valid");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Library workflow commands persist independent Archiver and Reader time choices", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-library-workflow-engine-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_LIBRARYWORKFLOWAA",
      timestamp: "2026-09-04T18:00:00.000Z",
      localDate: "2026-09-04",
      offset: "-07:00",
      language: "zh-CN"
    });
    const handlers = new LibraryEngineCommands(root).handlers();
    const initial = await handlers["library.preferences.query"]!({}, context()) as JsonObject;
    assert.deepEqual(initial["workflow_archiver"], { sort: "time_desc", time_field: "cloudig_edited_at" });
    assert.deepEqual(initial["workflow_reader"], { sort: "time_desc", time_field: "cloudig_edited_at" });
    const updated = await handlers["library.preferences.commit"]!({
      expected_revision: 1,
      workflow_archiver: { sort: "time_asc", time_field: "source_captured_at" },
      workflow_reader: { sort: "title", time_field: "content_time_end" }
    }, context()) as JsonObject;
    assert.equal(updated["revision"], 2);
    assert.deepEqual(updated["workflow_archiver"], { sort: "time_asc", time_field: "source_captured_at" });
    assert.deepEqual(updated["workflow_reader"], { sort: "title", time_field: "content_time_end" });
    await assert.rejects(
      handlers["library.preferences.commit"]!({ expected_revision: 2, workflow_reader: { sort: "time_desc", time_field: "made_up" } }, context()),
      /Reader workflow preferences are invalid/u
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
