import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  acquireSingleWriter,
  capturePreviousAuthority,
  cleanupJournal,
  fingerprintFile,
  installJournal,
  readJournal,
  recoverJournal,
  removeCleanJournalFiles,
  stageJournalTargets
} from "../../../src/adapters/storage/index.mts";
import { serializeLibrary, serializeTimeSystem } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const TOKEN = "x_ABCDEFGHIJKLMNOP";

async function disposable(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const temporaryRoot = path.join(process.cwd(), "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const base = await mkdtemp(path.join(temporaryRoot, "cloudig-v1-journal-"));
  const root = path.join(base, "Cloudig");
  for (const directory of ["Conversations", "Inbox", "Data/Transactions"]) await mkdir(path.join(root, directory), { recursive: true });
  return { root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function hash(bytes: Buffer): { bytes: number; sha256: string } {
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function journal(targets: JsonObject[]): JsonObject {
  return {
    schema: "cloudig/transaction/1.0.0",
    transaction: TOKEN,
    state: "planned",
    intent: "storage-test",
    created_at: "2026-08-31T12:00:00.000Z",
    updated_at: "2026-08-31T12:00:00.000Z",
    authority: { library: { state: "missing" } },
    targets
  };
}

function createTarget(relativePath: string): JsonObject {
  return {
    action: "create",
    path: relativePath,
    status: "planned",
    expected_before: { state: "missing" },
    semantic: { kind: "source_import" }
  };
}

function replaceTarget(relativePath: string, expected: { bytes: number; sha256: string }): JsonObject {
  return {
    action: "replace",
    path: relativePath,
    status: "planned",
    expected_before: { state: "present", ...expected },
    semantic: { kind: "conversation", archive: "a1", generation: 2, schema: "cloudig/conversation/1.0.0" }
  };
}

test("Windows named-pipe writer ownership rejects a second live writer and leaves no stale lock", async () => {
  const scope = await disposable();
  try {
    const first = await acquireSingleWriter(scope.root);
    await assert.rejects(acquireSingleWriter(scope.root));
    await first.release();
    const second = await acquireSingleWriter(scope.root);
    await second.release();
  } finally {
    await scope.cleanup();
  }
});

test("create and replace stage all bytes, install, verify, and clean exact owned artifacts", async () => {
  const scope = await disposable();
  try {
    const oldBytes = Buffer.from("old archive", "utf8");
    const newBytes = Buffer.from("new archive", "utf8");
    const createdBytes = Buffer.from("new source", "utf8");
    await writeFile(path.join(scope.root, "Conversations", "old.json"), oldBytes);
    const staged = await stageJournalTargets(scope.root, journal([
      createTarget("Inbox/new.html"),
      replaceTarget("Conversations/old.json", hash(oldBytes))
    ]), new Map([
      [0, Readable.from([createdBytes])],
      [1, Readable.from([newBytes])]
    ]));
    assert.equal(staged["state"], "staged");
    const committed = await installJournal(scope.root, staged);
    assert.equal(committed["state"], "committed");
    assert.deepEqual(await readFile(path.join(scope.root, "Inbox", "new.html")), createdBytes);
    assert.deepEqual(await readFile(path.join(scope.root, "Conversations", "old.json")), newBytes);
    const cleaned = await cleanupJournal(scope.root, committed);
    assert.equal(cleaned["state"], "cleaned");
    await removeCleanJournalFiles(scope.root, TOKEN);
    await assert.rejects(access(path.join(scope.root, "Data", "Transactions", TOKEN, "journal.json")));
  } finally {
    await scope.cleanup();
  }
});

test("crash after displacement recovers the exact old bytes", async () => {
  const scope = await disposable();
  try {
    const oldBytes = Buffer.from("old archive", "utf8");
    const newBytes = Buffer.from("new archive", "utf8");
    const target = path.join(scope.root, "Conversations", "old.json");
    await writeFile(target, oldBytes);
    const staged = await stageJournalTargets(scope.root, journal([
      replaceTarget("Conversations/old.json", hash(oldBytes))
    ]), new Map([[0, Readable.from([newBytes])]]));
    await assert.rejects(installJournal(scope.root, staged, (point) => {
      if (point === "after_displace_0") throw new Error("simulated crash");
    }), /simulated crash/u);
    await assert.rejects(access(target));
    const recovered = await recoverJournal(scope.root, TOKEN);
    assert.equal(recovered["state"], "rolled_back");
    assert.deepEqual(await readFile(target), oldBytes);
  } finally {
    await scope.cleanup();
  }
});

test("replace publication never overwrites a new occupant and rollback rejects altered displaced bytes", async () => {
  for (const collision of [true, false]) {
    const scope = await disposable();
    try {
      const target = path.join(scope.root, "Conversations", "old.json");
      const old = Buffer.from("original");
      await writeFile(target, old);
      const staged = await stageJournalTargets(scope.root, journal([replaceTarget("Conversations/old.json", hash(old))]), new Map([[0, Readable.from(["replacement"])]]));
      if (collision) {
        const result = await installJournal(scope.root, staged, point => {
          if (point === "after_displace_0") writeFileSync(target, "external occupant");
        });
        assert.equal(result["state"], "conflict");
        assert.equal(await readFile(target, "utf8"), "external occupant");
        assert.deepEqual(await readFile(path.join(scope.root, "Data", "Transactions", TOKEN, "displaced", "0.bin")), old);
      } else {
        await assert.rejects(installJournal(scope.root, staged, point => {
          if (point === "after_displace_0") throw new Error("crash");
        }), /crash/u);
        await writeFile(path.join(scope.root, "Data", "Transactions", TOKEN, "displaced", "0.bin"), "altered displaced data");
        assert.equal((await recoverJournal(scope.root, TOKEN))["state"], "conflict");
        await assert.rejects(access(target));
        assert.equal(await readFile(path.join(scope.root, "Data", "Transactions", TOKEN, "displaced", "0.bin"), "utf8"), "altered displaced data");
      }
    } finally { await scope.cleanup(); }
  }
});

test("external no-replace collision becomes conflict without touching unknown bytes", async () => {
  const scope = await disposable();
  try {
    const ours = Buffer.from("ours", "utf8");
    const external = Buffer.from("external", "utf8");
    const target = path.join(scope.root, "Inbox", "new.html");
    const staged = await stageJournalTargets(scope.root, journal([
      createTarget("Inbox/new.html")
    ]), new Map([[0, Readable.from([ours])]]));
    await writeFile(target, external);
    const result = await installJournal(scope.root, staged);
    assert.equal(result["state"], "conflict");
    assert.deepEqual(await readFile(target), external);
    assert.equal((await recoverJournal(scope.root, TOKEN))["state"], "conflict");
  } finally {
    await scope.cleanup();
  }
});

test("external modification after install preserves both external target and displaced old bytes", async () => {
  const scope = await disposable();
  try {
    const oldBytes = Buffer.from("old archive", "utf8");
    const newBytes = Buffer.from("new archive", "utf8");
    const external = Buffer.from("external edit", "utf8");
    const target = path.join(scope.root, "Conversations", "old.json");
    await writeFile(target, oldBytes);
    const staged = await stageJournalTargets(scope.root, journal([
      replaceTarget("Conversations/old.json", hash(oldBytes))
    ]), new Map([[0, Readable.from([newBytes])]]));
    await assert.rejects(installJournal(scope.root, staged, (point) => {
      if (point === "after_install_0") throw new Error("simulated crash");
    }), /simulated crash/u);
    await writeFile(target, external);
    const recovered = await recoverJournal(scope.root, TOKEN);
    assert.equal(recovered["state"], "conflict");
    assert.deepEqual(await readFile(target), external);
    const persisted = await readJournal(scope.root, TOKEN);
    const targets = persisted["targets"] as JsonObject[];
    const displaced = targets[0]!["displaced"] as string;
    const displacedPath = path.join(scope.root, ...displaced.split("/"));
    assert.deepEqual(await readFile(displacedPath), oldBytes);
  } finally {
    await scope.cleanup();
  }
});

test("abort during multi-target staging leaves a planned journal that recovery can roll back", async () => {
  const scope = await disposable();
  try {
    const controller = new AbortController();
    async function* aborting(): AsyncGenerator<Buffer> {
      yield Buffer.from("partial", "utf8");
      controller.abort(new Error("cancelled"));
      yield Buffer.from("unreachable", "utf8");
    }
    await assert.rejects(stageJournalTargets(scope.root, journal([
      createTarget("Inbox/one.html"),
      createTarget("Inbox/two.html")
    ]), new Map([
      [0, Readable.from([Buffer.from("complete", "utf8")])],
      [1, Readable.from(aborting())]
    ]), controller.signal), /cancelled/u);
    const planned = await readJournal(scope.root, TOKEN);
    assert.equal(planned["state"], "planned");
    const recovered = await recoverJournal(scope.root, TOKEN);
    assert.equal(recovered["state"], "rolled_back");
    const transactionRoot = path.join(scope.root, "Data", "Transactions", TOKEN, "staged");
    await assert.rejects(access(path.join(transactionRoot, "0.bin")));
    await assert.rejects(access(path.join(transactionRoot, "1.bin")));
  } finally {
    await scope.cleanup();
  }
});

async function installCurrentAuthority(root: string): Promise<void> {
  const fixtureRoot = new URL("../contracts/fixtures/", import.meta.url);
  const time = JSON.parse(await readFile(new URL("time-system-full.json", fixtureRoot), "utf8")) as JsonObject;
  const timeBytes = Buffer.from(serializeTimeSystem(time), "utf8");
  const library = JSON.parse(await readFile(new URL("library-full.json", fixtureRoot), "utf8")) as JsonObject;
  library["content_time"] = {
    schema: "cloudig/time-system/1.0.0",
    revision: time["revision"]!,
    sha256: createHash("sha256").update(timeBytes).digest("hex")
  };
  await mkdir(path.join(root, "Data", "State"), { recursive: true });
  await mkdir(path.join(root, "Data", "Recovery", "Previous"), { recursive: true });
  await writeFile(path.join(root, "cloudig-library.json"), serializeLibrary(library), "utf8");
  await writeFile(path.join(root, "Data", "State", "content-time.json"), timeBytes);
}

test("previous recovery point captures one validated Library+Time pair and never overwrites it from damaged current authority", async () => {
  const scope = await disposable();
  try {
    await installCurrentAuthority(scope.root);
    assert.equal(await capturePreviousAuthority(scope.root, {
      transaction: "x_RECOVERYPOINTABCDE",
      recordedAt: "2026-08-31T13:00:00.000Z",
      alreadyCapturedThisBatch: false
    }), "captured");
    const previousLibrary = path.join(scope.root, "Data", "Recovery", "Previous", "cloudig-library.json");
    const previousTime = path.join(scope.root, "Data", "Recovery", "Previous", "content-time.json");
    const beforeLibrary = await fingerprintFile(previousLibrary);
    const beforeTime = await fingerprintFile(previousTime);

    assert.equal(await capturePreviousAuthority(scope.root, {
      transaction: "x_SECONDRECOVERYABCD",
      recordedAt: "2026-08-31T13:01:00.000Z",
      alreadyCapturedThisBatch: false
    }), "unchanged");
    assert.equal(await capturePreviousAuthority(scope.root, {
      transaction: "x_THIRDRECOVERYABCDE",
      recordedAt: "2026-08-31T13:02:00.000Z",
      alreadyCapturedThisBatch: true
    }), "skipped_batch");

    await writeFile(path.join(scope.root, "cloudig-library.json"), "{broken", "utf8");
    await assert.rejects(capturePreviousAuthority(scope.root, {
      transaction: "x_FOURTHRECOVERYABCD",
      recordedAt: "2026-08-31T13:03:00.000Z",
      alreadyCapturedThisBatch: false
    }));
    assert.deepEqual(await fingerprintFile(previousLibrary), beforeLibrary);
    assert.deepEqual(await fingerprintFile(previousTime), beforeTime);
  } finally {
    await scope.cleanup();
  }
});
