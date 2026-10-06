import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { commitLibraryPreferences, createLocalLibrary, projectWelcomeLibraryState, readWelcomeLibraryState } from "../../../src/adapters/library-data/index.mts";
import { readPreviousAuthorityPair } from "../../../src/adapters/storage/recovery-point.mts";

const ordinaryParse = {
  parse_unparsed: true,
  parse_selected: true,
  update_outdated: false,
  preserve_previous: false
};
const claudeParse = { ...ordinaryParse };
const archiveWorkflow = { sort: "time_desc", time_field: "file_modified_at" } as const;
const claudeWorkflow = { sort: "time_desc", time_field: "updated_at" } as const;

async function scope(): Promise<Readonly<{ base: string; root: string }>> {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-preferences-"));
  const root = path.join(base, "Library");
  await createLocalLibrary({
    root,
    transaction: "x_PREFERENCESCREATEA",
    timestamp: "2026-08-31T20:00:00.000Z",
    localDate: "2026-08-31",
    offset: "-07:00",
    language: "zh-CN"
  });
  return { base, root };
}

test("Welcome preferences default to Dawn and update theme/language through one recoverable Library transaction", async () => {
  const testScope = await scope();
  try {
    assert.deepEqual(await readWelcomeLibraryState(testScope.root), {
      revision: 1,
      theme: "dawn",
      language: "zh-CN",
      themeSwitched: false,
      userName: "采云用户",
      assistantName: "智能伙伴",
      ordinaryParse,
      claudeParse,
      archiverWorkflow: archiveWorkflow,
      readerWorkflow: archiveWorkflow,
      claudeWorkflow
    });
    const before = await readFile(path.join(testScope.root, "cloudig-library.json"));
    const unchanged = await commitLibraryPreferences({
      libraryRoot: testScope.root,
      expectedRevision: 1,
      theme: "dawn",
      transaction: "x_PREFERENCESNOOPAA",
      recoveryTransaction: "x_PREFERENCESNOOPAB",
      timestamp: "2026-08-31T20:01:00.000Z"
    });
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual(await readFile(path.join(testScope.root, "cloudig-library.json")), before);

    const updated = await commitLibraryPreferences({
      libraryRoot: testScope.root,
      expectedRevision: 1,
      theme: "star-night",
      language: "en",
      transaction: "x_PREFERENCESUPDATEA",
      recoveryTransaction: "x_PREFERENCESRECOVERA",
      timestamp: "2026-08-31T20:02:00.000Z"
    });
    assert.deepEqual(updated, {
      status: "updated",
      state: {
        revision: 2,
        theme: "star-night",
        language: "en",
        themeSwitched: true,
        userName: "User",
        assistantName: "AI",
        ordinaryParse,
        claudeParse,
        archiverWorkflow: archiveWorkflow,
        readerWorkflow: archiveWorkflow,
        claudeWorkflow
      }
    });
    assert.equal((await readPreviousAuthorityPair(testScope.root)).library["revision"], 1);
    const parseUpdated = await commitLibraryPreferences({
      libraryRoot: testScope.root,
      expectedRevision: 2,
      ordinaryParse: { ...ordinaryParse, update_outdated: true, preserve_previous: true },
      transaction: "x_PREFERENCESPARSEAA",
      recoveryTransaction: "x_PREFERENCESPARSEAB",
      timestamp: "2026-08-31T20:02:30.000Z"
    });
    assert.equal(parseUpdated.status, "updated");
    assert.equal(parseUpdated.state?.revision, 3);
    assert.deepEqual(parseUpdated.state?.ordinaryParse, { ...ordinaryParse, update_outdated: true, preserve_previous: true });
    const claudeUpdated = await commitLibraryPreferences({
      libraryRoot: testScope.root,
      expectedRevision: 3,
      claudeParse: { ...claudeParse, preserve_previous: true },
      archiverWorkflow: { sort: "time_asc", time_field: "source_captured_at" },
      readerWorkflow: { sort: "title", time_field: "message_end" },
      claudeWorkflow: { sort: "title", time_field: "created_at" },
      transaction: "x_PREFERENCESCLAUDEA",
      recoveryTransaction: "x_PREFERENCESCLAUDEB",
      timestamp: "2026-08-31T20:02:45.000Z"
    });
    assert.equal(claudeUpdated.status, "updated");
    assert.equal(claudeUpdated.state?.revision, 4);
    assert.deepEqual(claudeUpdated.state?.claudeParse, { ...claudeParse, preserve_previous: true });
    assert.deepEqual(claudeUpdated.state?.archiverWorkflow, { sort: "time_asc", time_field: "source_captured_at" });
    assert.deepEqual(claudeUpdated.state?.readerWorkflow, { sort: "title", time_field: "message_end" });
    assert.deepEqual(claudeUpdated.state?.claudeWorkflow, { sort: "title", time_field: "created_at" });
    const stale = await commitLibraryPreferences({
      libraryRoot: testScope.root,
      expectedRevision: 1,
      theme: "dawn",
      transaction: "x_PREFERENCESSTALEAA",
      recoveryTransaction: "x_PREFERENCESSTALEAB",
      timestamp: "2026-08-31T20:03:00.000Z"
    });
    assert.equal(stale.status, "conflict");
    assert.equal((await readWelcomeLibraryState(testScope.root)).revision, 4);

    assert.deepEqual(projectWelcomeLibraryState({
      revision: 7,
      preferences: { language: "en", theme: "dawn" }
    }), {
      revision: 7,
      theme: "dawn",
      language: "en",
      themeSwitched: false,
      userName: "User",
      assistantName: "AI",
      ordinaryParse,
      claudeParse,
      archiverWorkflow: archiveWorkflow,
      readerWorkflow: archiveWorkflow,
      claudeWorkflow
    });
    assert.deepEqual(projectWelcomeLibraryState({
      revision: 8,
      preferences: { language: "en", theme: "dawn" },
      identity: { global: { user: { name: "晨星.CyberVenus" }, assistant: { name: "奥思" } } }
    }), {
      revision: 8,
      theme: "dawn",
      language: "en",
      themeSwitched: false,
      userName: "晨星.CyberVenus",
      assistantName: "奥思",
      ordinaryParse,
      claudeParse,
      archiverWorkflow: archiveWorkflow,
      readerWorkflow: archiveWorkflow,
      claudeWorkflow
    });
  } finally {
    await rm(testScope.base, { recursive: true, force: true });
  }
});
