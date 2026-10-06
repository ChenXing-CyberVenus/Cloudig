import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createLocalLibrary, inspectLocalLibrary, restoreAuthorityFromConversationSnapshots } from "../../../src/adapters/library-data/index.mts";
import { serializeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

test("when current and previous are both unusable, unique Conversation snapshots restore sparse archive state and duplicate aN is reassigned", async () => {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-snapshot-recovery-"));
  const root = path.join(base, "Library");
  try {
    await createLocalLibrary({
      root,
      transaction: "x_SNAPSHOTCREATEAAA",
      timestamp: "2026-09-01T10:00:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00",
      language: "en"
    });
    const fixture = JSON.parse(await readFile(new URL("../contracts/fixtures/conversation-full.json", import.meta.url), "utf8")) as JsonObject;
    const first = structuredClone(fixture);
    first["archive"] = "a2";
    first["user"] = { revision: 7, edited_at: "2026-08-31T18:00:00.000Z", conversation_name: "First recovered", names: { user: "晨星" } };
    const second = structuredClone(fixture);
    second["archive"] = "a2";
    second["user"] = { revision: 8, edited_at: "2026-08-31T19:00:00.000Z", conversation_name: "Second recovered", names: { assistant: "万卷" } };
    await writeFile(path.join(root, "Conversations", "one.json"), serializeConversation(first));
    await writeFile(path.join(root, "Conversations", "two.json"), serializeConversation(second));
    await writeFile(path.join(root, "Conversations", "broken.json"), "{broken");
    await writeFile(path.join(root, "cloudig-library.json"), "damaged current Library");
    await writeFile(path.join(root, "Data", "State", "content-time.json"), "damaged current Time");
    await writeFile(path.join(root, "Data", "Recovery", "Previous", "cloudig-library.json"), "damaged previous Library");
    await writeFile(path.join(root, "Data", "Recovery", "Previous", "content-time.json"), "damaged previous Time");
    await writeFile(path.join(root, "Data", "Recovery", "Previous", "manifest.json"), "damaged manifest");

    const restored = await restoreAuthorityFromConversationSnapshots({
      libraryRoot: root,
      transaction: "x_SNAPSHOTRESTOREAA",
      restoredAt: "2026-09-01T10:05:00.000Z",
      localDate: "2026-09-01",
      offset: "-07:00"
    });
    assert.deepEqual(restored, { status: "restored_from_conversations", revision: 9, archives: 2, reassigned: 1, isolated: 1 });
    const inspection = await inspectLocalLibrary(root);
    assert.equal(inspection.status, "valid");
    if (inspection.status !== "valid") return;
    assert.deepEqual(inspection.pair.library["preferences"], { language: "zh-CN", theme: "dawn" });
    assert.equal(inspection.pair.library["next_archive"], 4);
    assert.deepEqual((inspection.pair.library["archives"] as JsonObject)["a2"], first["user"]);
    assert.deepEqual((inspection.pair.library["archives"] as JsonObject)["a3"], second["user"]);
    assert.equal((JSON.parse(await readFile(path.join(root, "Conversations", "one.json"), "utf8")) as JsonObject)["archive"], "a2");
    assert.equal((JSON.parse(await readFile(path.join(root, "Conversations", "two.json"), "utf8")) as JsonObject)["archive"], "a3");
    assert.equal(inspection.pair.time["variants"], undefined, "a complete Time graph must not be invented from portable snapshots");
    assert.equal(inspection.pair.time["times"], undefined);
    assert.deepEqual(await readdir(path.join(root, "Data", "Indexes")), []);
    assert.equal(await readFile(path.join(root, "Data", "Recovery", "Previous", "cloudig-library.json"), "utf8"), "damaged previous Library");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
