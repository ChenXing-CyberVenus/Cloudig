import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { installV1ProgramFiles } from "../../../scripts/v1-program-install.mjs";

async function fixture(run) {
  await mkdir("tmp", { recursive: true }); const base = await mkdtemp(path.join(process.cwd(), "tmp/program-storage-"));
  const payload = path.join(base, "payload"), installed = path.join(base, "installed"); let passed = false;
  try {
    for (const file of ["Cloudig.exe", "app/Cloudig.dll", "app/hostfxr.dll", "app/web/current.css", "bookmarks/current.js", "docs/THIRD-PARTY-LICENSES.txt", "LICENSE"]) {
      await mkdir(path.dirname(path.join(payload, file)), { recursive: true }); await writeFile(path.join(payload, file), `new ${file}`);
    }
    for (const file of ["CloudigLibrary.json", "Inbox/source.html", "Conversations/a.json", "Marks/b.json", "ContentTimes/c.json", "Identities/d.json", "Archives/old.json", "Exports/export.md", "appdata/settings.json", "cache/sentinel", "docs/user-notes.txt", "user-note.txt", "Cloudig/Conversations/legacy", "Data/Device/legacy", "app/old.dll", "Cloudig.exe"]) {
      await mkdir(path.dirname(path.join(installed, file)), { recursive: true }); await writeFile(path.join(installed, file), `old ${file}`);
    }
    await run({ base, payload, installed }); passed = true;
  } finally { if (passed) await rm(base, { recursive: true }); else console.error(`Retained program install fixture: ${base}`); }
}

test("flat program replacement preserves all user records, old data and unrelated documentation", async () => fixture(async ({ base, payload, installed }) => {
  for (let index = 0; index < 3; index++) {
    await installV1ProgramFiles(payload, installed);
    for (const file of ["CloudigLibrary.json", "Inbox/source.html", "Conversations/a.json", "Marks/b.json", "ContentTimes/c.json", "Identities/d.json", "Archives/old.json", "Exports/export.md", "appdata/settings.json", "cache/sentinel", "docs/user-notes.txt", "user-note.txt", "Cloudig/Conversations/legacy", "Data/Device/legacy"]) assert.equal(await readFile(path.join(installed, file), "utf8"), `old ${file}`);
    assert.deepEqual(await readdir(path.join(installed, "app")), ["Cloudig.dll", "hostfxr.dll", "web"]);
    assert.equal(await readFile(path.join(installed, "docs/THIRD-PARTY-LICENSES.txt"), "utf8"), "new docs/THIRD-PARTY-LICENSES.txt");
    assert.deepEqual((await readdir(base)).sort(), ["installed", "payload"]);
  }
  await mkdir(path.join(payload, "Conversations"));
  await assert.rejects(installV1ProgramFiles(payload, installed), /cannot contain portable user data/u);
}));

test("a failed program switch restores earlier components and leaves business data unchanged", async () => fixture(async ({ base, payload, installed }) => {
  await assert.rejects(installV1ProgramFiles(payload, installed, { beforeInstall: relative => { if (relative === "bookmarks") throw new Error("test interruption"); } }), /test interruption/u);
  assert.deepEqual(await readdir(path.join(installed, "app")), ["old.dll"]);
  assert.equal(await readFile(path.join(installed, "Cloudig.exe"), "utf8"), "old Cloudig.exe");
  assert.equal(await readFile(path.join(installed, "Marks/b.json"), "utf8"), "old Marks/b.json");
  assert.deepEqual((await readdir(base)).sort(), ["installed", "payload"]);
}));

async function onlineExamples(payload, installed) {
  const id = "example-0123456789abcdefabcd", html = "<p>Curated original</p>", record = '{"example":true}';
  const entry = (relative, bytes) => ({ path: relative, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
  const manifest = { format: "cloudig/public-examples/1", distribution: "online", examples: [{ id,
    html: { ...entry("html/Example.html", html), file: "Example.html" }, record: entry(`records/${id}.json`, record) }] };
  await mkdir(path.join(payload, "docs/examples"), { recursive: true });
  await writeFile(path.join(payload, "docs/examples/manifest.json"), JSON.stringify(manifest));
  for (const [file, text] of [["html/Example.html", html], [`records/${id}.json`, record], ["html/my-notes.html", "User words"]]) {
    await mkdir(path.dirname(path.join(installed, "docs/examples", file)), { recursive: true }); await writeFile(path.join(installed, "docs/examples", file), text);
  }
  return { manifest, html: path.join(installed, "docs/examples/html/Example.html"), record: path.join(installed, `docs/examples/records/${id}.json`) };
}

test("online distribution retires only byte-matching program examples, preserving edited and unrelated docs", async () => fixture(async ({ base, payload, installed }) => {
  const sample = await onlineExamples(payload, installed);
  await writeFile(sample.record, "User-edited record");
  await installV1ProgramFiles(payload, installed);
  await assert.rejects(readFile(sample.html), { code: "ENOENT" });
  assert.equal(await readFile(sample.record, "utf8"), "User-edited record");
  assert.equal(await readFile(path.join(installed, "docs/examples/html/my-notes.html"), "utf8"), "User words");
  assert.deepEqual((await readdir(base)).sort(), ["installed", "payload"]);
}));

test("a retirement interrupted by an external edit rolls back without discarding that edit", async () => fixture(async ({ base, payload, installed }) => {
  const sample = await onlineExamples(payload, installed);
  await assert.rejects(installV1ProgramFiles(payload, installed, { beforeInstall: async relative => {
    if (relative === sample.manifest.examples[0].record.path.replace(/^/, "docs/examples/")) await writeFile(sample.record, "Edited during install");
  } }), /Example changed during program replacement/u);
  assert.equal(await readFile(sample.html, "utf8"), "<p>Curated original</p>");
  assert.equal(await readFile(sample.record, "utf8"), "Edited during install");
  assert.deepEqual(await readdir(path.join(installed, "app")), ["old.dll"]);
  assert.deepEqual((await readdir(base)).sort(), ["installed", "payload"]);
}));

test("an online catalog cannot nominate an arbitrary document for retirement", async () => fixture(async ({ payload, installed }) => {
  const sample = await onlineExamples(payload, installed); sample.manifest.examples[0].record.path = "../user-notes.txt";
  await writeFile(path.join(payload, "docs/examples/manifest.json"), JSON.stringify(sample.manifest));
  await assert.rejects(installV1ProgramFiles(payload, installed), /Invalid managed example/u);
  assert.equal(await readFile(path.join(installed, "docs/user-notes.txt"), "utf8"), "old docs/user-notes.txt");
}));
