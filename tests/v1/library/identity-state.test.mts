import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  commitIdentityState,
  createLocalLibrary,
  readIdentityState,
  readWelcomeLibraryState
} from "../../../src/adapters/library-data/index.mts";
import { readPreviousAuthorityPair } from "../../../src/adapters/storage/recovery-point.mts";

async function scope(): Promise<Readonly<{ base: string; root: string }>> {
  const temporary = path.join(process.cwd(), "tmp");
  await mkdir(temporary, { recursive: true });
  const base = await mkdtemp(path.join(temporary, "cloudig-identity-"));
  const root = path.join(base, "Library");
  await createLocalLibrary({
    root,
    transaction: "x_IDENTITYCREATEAAA",
    timestamp: "2026-09-01T08:00:00.000Z",
    localDate: "2026-09-01",
    offset: "-07:00",
    language: "zh-CN"
  });
  return { base, root };
}

async function stagePng(root: string, picker: string): Promise<Readonly<{ bytes: Buffer; sha256: string }>> {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(root, "Data", "Runtime", "Pickers", picker);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "payload.bin"), bytes);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schema: "cloudig/picker/1.0.0",
    picker,
    filename: "avatar.png",
    bytes: bytes.byteLength,
    sha256,
    captured_at: "2026-09-01T08:00:10.000Z"
  }));
  return { bytes, sha256 };
}

test("global and platform identity is sparse, recoverable, content-addressed and zero-write on no-op", async () => {
  const testScope = await scope();
  try {
    assert.deepEqual(await readIdentityState(testScope.root), { revision: 1, language: "zh-CN" });
    const picker = `p_${"A".repeat(43)}`;
    const avatar = await stagePng(testScope.root, picker);
    const updated = await commitIdentityState({
      libraryRoot: testScope.root,
      expectedRevision: 1,
      draft: {
        global: {
          user: { name: "晨星.CyberVenus", avatar: { state: "picker", picker } },
          assistant: { name: "奥思", avatar: { state: "clear" }, applyToAll: true }
        },
        platforms: { qwen: { name: "通义千问", avatar: { state: "clear" } } }
      },
      transaction: "x_IDENTITYUPDATEAAA",
      recoveryTransaction: "x_IDENTITYRECOVERAA",
      timestamp: "2026-09-01T08:01:00.000Z"
    });
    assert.equal(updated.status, "updated");
    assert.equal(updated.revision, 2);
    const asset = `Data/Assets/User/avatar-${avatar.sha256}.png`;
    assert.deepEqual(await readFile(path.join(testScope.root, ...asset.split("/"))), avatar.bytes);
    await assert.rejects(stat(path.join(testScope.root, "Data", "Runtime", "Pickers", picker)));
    assert.equal((await readPreviousAuthorityPair(testScope.root)).library["revision"], 1);
    const state = await readIdentityState(testScope.root);
    assert.deepEqual(state.identity, {
      global: {
        user: { name: "晨星.CyberVenus", avatar: asset },
        assistant: { name: "奥思", apply_to_all: true }
      },
      platforms: { qwen: { assistant: { name: "通义千问" } } }
    });
    assert.equal((await readWelcomeLibraryState(testScope.root)).userName, "晨星.CyberVenus");

    const beforeNoop = await readFile(path.join(testScope.root, "cloudig-library.json"));
    const unchanged = await commitIdentityState({
      libraryRoot: testScope.root,
      expectedRevision: 2,
      draft: {
        global: {
          user: { name: "晨星.CyberVenus", avatar: { state: "keep" } },
          assistant: { name: "奥思", avatar: { state: "keep" }, applyToAll: true }
        },
        platforms: { qwen: { name: "通义千问", avatar: { state: "keep" } } }
      },
      transaction: "x_IDENTITYNOOPAAAA",
      recoveryTransaction: "x_IDENTITYNOOPBAAA",
      timestamp: "2026-09-01T08:02:00.000Z"
    });
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual(await readFile(path.join(testScope.root, "cloudig-library.json")), beforeNoop);
  } finally {
    await rm(testScope.base, { recursive: true, force: true });
  }
});
