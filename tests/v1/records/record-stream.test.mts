import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, rm, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import { recordJsonChunks, prepareRecordEncoding, RECORD_ENCODING_LIMITS } from "../../../src/core/records/encoding.mts";
import { encodeRecord, validateRecord, validateConversationRecordMetadata } from "../../../src/core/records/index.mts";
import { inspectRecordConversation, materializeRecordResource, streamRecordResource } from "../../../src/adapters/reader/record-resource.mts";
import { commitRecords, pendingRecordOperations } from "../../../src/adapters/storage/record-store.mts";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { exportRecordMarkdown } from "../../../src/adapters/library-data/record-markdown-export.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild");
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const obj = (v: unknown): JsonObject => v as JsonObject;
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "stream-")); let passed = false;
  try { await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true }); } else console.error(`Retained record stream test: ${root}`); }
}
async function conversation(parts: Buffer[]): Promise<JsonObject> {
  const c = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/04-1.json"), "utf8")) as JsonObject;
  const all = Buffer.concat(parts), speaker = (c["identity"] as JsonObject[]).find(f => f["role"] === "user")!["source_id"]!;
  c["title"] = { filename: "中文🌈及引号\"" };
  c["messages"] = { items: [{ id: "m", speaker, content: [{ type: "markdown", text: "body\r\n\t\u0000 🌈中文引号\"".repeat(7000) }, { type: "attachment", resource: "r1" }] }] };
  c["resources"] = [{ id: "r1", kind: "file", availability: "embedded", name: "source.bin", mime: "application/octet-stream", bytes: all.length, sha256: sha(all), data_base64: parts.map(p => p.toString("base64")) }];
  assert.equal(validateRecord("conversation", c).ok, true); return c;
}

test("bounded encoding preserves exact readable JSON bytes, including long Unicode and escapes", async () => {
  const c = await conversation([Buffer.alloc(1024 * 1024, 0xab)]), expected = encodeRecord("conversation", c);
  const chunks = [...recordJsonChunks(c)]; assert.equal(chunks.join(""), expected);
  assert(Math.max(...chunks.map(c => c.length)) <= 6 * RECORD_ENCODING_LIMITS.textChunkCharacters);
  assert(chunks.every(c => c.isWellFormed()));
  assert.deepEqual(prepareRecordEncoding("conversation", c).fingerprint, { bytes: Buffer.byteLength(expected), sha256: sha(expected) });
});

test("streamed Reader projections omit absent optional properties without losing array positions", () => {
  const value = obj({ messages: [{ role: "assistant", optional: undefined, nested: { label: undefined, content: "Gemini" } }], optional: undefined, positions: [undefined, null, , "last"] });
  assert.equal([...recordJsonChunks(value)].join(""), `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => [...recordJsonChunks(undefined as never)], /non-JSON/u);
});

test("resource indexing skips a single large segment without imposing a Schema segment size", async () => temporary(async root => {
  const data = Buffer.alloc(8 * 1024 * 1024, 0xfe), c = await conversation([data]), file = path.join(root, "conversation.json");
  await writeFile(file, encodeRecord("conversation", c));
  const read = await inspectRecordConversation(file), body = read.resourceBodies.get("r1")!;
  assert.equal(body.encoded.segments, 1); assert.equal(body.bytes, data.length); assert.equal(body.sha256, sha(data));
  assert(!Object.hasOwn((read.conversation["resources"] as JsonObject[])[0]!, "data_base64"));
  assert.equal(validateRecord("conversation", read.conversation).ok, false, "metadata cannot masquerade as a complete portable record");
  assert.equal(validateConversationRecordMetadata(read.conversation, read.resourceBodies).ok, true);
  const output = path.join(root, "materialized.bin"); await materializeRecordResource(file, body, output); assert.deepEqual(await readFile(output), data);
}));

test("byte spans survive multibyte text, alternate whitespace and escaped Base64 characters", async () => temporary(async root => {
  const parts = [Buffer.from([255]), Buffer.from([250, 171]), Buffer.from([0, 1, 2])], c = await conversation(parts);
  // Non-canonical layout is still valid JSON. Slashes/plus signs may be escaped.
  const text = JSON.stringify(c, null, "\t").replaceAll("/", "\\/").replaceAll("+", "\\u002b");
  const file = path.join(root, "custom.json"); await writeFile(file, text);
  const read = await inspectRecordConversation(file), body = read.resourceBodies.get("r1")!;
  assert.equal(body.encoded.segments, parts.length);
  const original = await readFile(file), encoded = original.subarray(body.encoded.offset, body.encoded.offset + body.encoded.length).toString("utf8");
  assert.deepEqual(JSON.parse(`[${encoded}]`), parts.map(p => p.toString("base64")));
  const target = path.join(root, "decoded.bin"); await materializeRecordResource(file, body, target); assert.deepEqual(await readFile(target), Buffer.concat(parts));
}));

test("zero-byte embedded files remain real available resources", async () => temporary(async root => {
  const c = await conversation([Buffer.from([1])]), r = (c["resources"] as JsonObject[])[0]!;
  r["bytes"] = 0; r["sha256"] = sha(Buffer.alloc(0)); delete r["data_base64"];
  const file = path.join(root, "zero.json"); await writeFile(file, encodeRecord("conversation", c));
  const read = await inspectRecordConversation(file), target = path.join(root, "zero.bin"); await materializeRecordResource(file, read.resourceBodies.get("r1")!, target);
  assert.equal((await lstat(target)).size, 0);
}));

test("BOM resource spans include the file prefix and decode the original bytes", async () => temporary(async root => {
  const data = Buffer.from("中文 resource 🌈"), c = await conversation([data]), file = path.join(root, "bom.json");
  const bytes = Buffer.from("\uFEFF" + encodeRecord("conversation", c)); await writeFile(file, bytes);
  const read = await inspectRecordConversation(file), body = read.resourceBodies.get("r1")!;
  assert.equal(read.fingerprint.bytes, bytes.length); assert.equal(read.fingerprint.sha256, sha(bytes));
  assert.deepEqual(JSON.parse(`[${bytes.subarray(body.encoded.offset, body.encoded.offset + body.encoded.length).toString("utf8")}]`), [data.toString("base64")]);
  const output: Buffer[] = []; for await (const chunk of streamRecordResource(file, body)) output.push(chunk);
  assert.deepEqual(Buffer.concat(output), data); assert.deepEqual(await readFile(file), bytes);
}));

test("invalid or non-string bodies and changed resources fail without keeping a partial cache file", async () => temporary(async root => {
  const c = await conversation([Buffer.from([1, 2, 3])]), file = path.join(root, "source.json");
  await writeFile(file, encodeRecord("conversation", c)); const indexed = await inspectRecordConversation(file);
  const invalid = structuredClone(c); obj((invalid["resources"] as JsonObject[])[0])["data_base64"] = ["AAAA"];
  await writeFile(file, JSON.stringify(invalid, null, 2) + "\n");
  const target = path.join(root, "partial.bin"); await assert.rejects(materializeRecordResource(file, indexed.resourceBodies.get("r1")!, target)); assert(!(await readdir(root)).includes("partial.bin"));
  for (const body of [["A==="], ["AA==", 2], [""], ["AA==AA=="], ["AA==", null]]) {
    obj((invalid["resources"] as JsonObject[])[0])["data_base64"] = body;
    await writeFile(file, JSON.stringify(invalid)); await assert.rejects(inspectRecordConversation(file));
  }
  await writeFile(target, "keep"); await assert.rejects(materializeRecordResource(file, indexed.resourceBodies.get("r1")!, target)); assert.equal(await readFile(target, "utf8"), "keep");
}));

test("streamed record writes retain the exact hash and staged bytes ignore later caller mutation", async () => temporary(async root => {
  const c = await conversation([Buffer.alloc(2 * 1024 * 1024, 7)]);
  await commitRecords(root, [{ action: "write", kind: "conversation", path: "Conversations/record.json", value: c, expected: null }]);
  assert.equal(sha(await readFile(path.join(root, "Conversations/record.json"))), prepareRecordEncoding("conversation", c).fingerprint.sha256);
  const changed = structuredClone(c), expected = sha(await readFile(path.join(root, "Conversations/record.json"))); obj(changed["title"])["filename"] = "Before mutation";
  const pending = commitRecords(root, [{ action: "write", kind: "conversation", path: "Conversations/record.json", value: changed, expected }], { fault(point) { if (point === "staged_0") obj(changed["title"])["filename"] = "Too late to change the already-staged file"; } });
  await pending;
  const bytes = await readFile(path.join(root, "Conversations/record.json"), "utf8"); assert(bytes.includes("Before mutation")); assert(!bytes.includes("Too late"));
  assert.deepEqual(await pendingRecordOperations(root), []);
}));

test("cancelled resource materialization retires only its own incomplete output", async () => temporary(async root => {
  const c = await conversation([Buffer.alloc(4 * 1024 * 1024, 0xef)]), source = path.join(root, "source.json"); await writeFile(source, encodeRecord("conversation", c));
  const before = sha(await readFile(source)), indexed = await inspectRecordConversation(source), abort = new AbortController(), target = path.join(root, "cancelled.bin");
  const timer = setTimeout(() => abort.abort(), 1);
  try { await assert.rejects(materializeRecordResource(source, indexed.resourceBodies.get("r1")!, target, abort.signal), e => e instanceof Error && e.name === "AbortError"); }
  finally { clearTimeout(timer); }
  assert(!(await readdir(root)).includes("cancelled.bin")); assert.equal(sha(await readFile(source)), before);
}));

test("closing a resource consumer early releases the backpressured decoder", { timeout: 5000 }, async () => temporary(async root => {
  const c = await conversation([Buffer.alloc(1024 * 1024, 0xab)]), file = path.join(root, "source.json"); await writeFile(file, encodeRecord("conversation", c));
  const read = await inspectRecordConversation(file), iterator = streamRecordResource(file, read.resourceBodies.get("r1")!);
  const first = await iterator.next(); assert(!first.done && first.value.length > 0);
  await iterator.return(undefined); assert.equal((await iterator.next()).done, true);
}));

test("Markdown re-encodes independently padded segments into one correct data URL and never overwrites an export", { timeout: 15000 }, async () => temporary(async root => {
  await createRecordLibrary(root, { timestamp: "2026-09-11T18:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } });
  const parts = [Buffer.from([255]), Buffer.from([250, 171]), Buffer.from([0, 1, 2])], c = await conversation(parts);
  await commitRecords(root, [{ action: "write", kind: "conversation", path: "Conversations/Unicode.json", value: c, expected: null }]);
  const source = path.join(root, "Conversations/Unicode.json"), expected = sha(await readFile(source));
  const input = { conversationId: String(c["conversation_id"]), expectedConversation: expected, expectedMark: null, builtins: { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} } };
  const first = await exportRecordMarkdown(root, input), text = await readFile(path.join(root, first.path), "utf8");
  const data = /<data:application\/octet-stream;base64,([^>]+)>/u.exec(text)?.[1]; assert(data);
  assert.deepEqual(Buffer.from(data, "base64"), Buffer.concat(parts)); assert.equal(data, Buffer.concat(parts).toString("base64"));
  const second = await exportRecordMarkdown(root, input); assert.notEqual(first.path, second.path);
  assert.equal(await readFile(path.join(root, first.path), "utf8"), text);
  assert.equal(sha(await readFile(source)), expected); assert.deepEqual(await readdir(path.join(root, "cache/Engine")), []);
}));

test("real Markdown file preserves inline image position, exact bytes and nested reasoning", async () => temporary(async root => {
  await createRecordLibrary(root, { timestamp: "2026-09-21T18:00:00Z", anchor: { date: "2026-09-21", offset: "Z" } });
  const c = JSON.parse(await readFile(path.resolve("tests/v1/records/fixtures/inline-images.json"), "utf8")) as JsonObject;
  const image = (c["resources"] as JsonObject[])[0]!, bytes = Buffer.from((image["data_base64"] as string[]).join(""), "base64");
  // Independently padded source chunks must become a single valid image URI.
  image["data_base64"] = [bytes.subarray(0, 5).toString("base64"), bytes.subarray(5).toString("base64")];
  await commitRecords(root, [{ action: "write", kind: "conversation", path: "Conversations/inline.json", value: c, expected: null }]);
  const source = path.join(root, "Conversations/inline.json"), expected = sha(await readFile(source)), progress: number[][] = [];
  const result = await exportRecordMarkdown(root, { conversationId: String(c["conversation_id"]), expectedConversation: expected, expectedMark: null,
    builtins: { user: { name: "User", avatar: "app/user.svg" }, assistant: { name: "AI", avatar: "app/ai.svg" }, platforms: {} }, onProgress: (done, total) => { progress.push([done, total]); } });
  const output = await readFile(path.join(root, result.path)), dom = new JSDOM(output.toString("utf8"));
  for (const selector of ["td img", "li img", "details details p img"]) {
    const image = dom.window.document.querySelector<HTMLImageElement>(selector); assert(image, selector);
    assert.deepEqual(Buffer.from(image.src.split(",")[1]!, "base64"), bytes);
  }
  assert.equal(dom.window.document.querySelector("td:has(img)")!.textContent, "BeforeAfter");
  assert.equal(dom.window.document.querySelectorAll("img").length, 3);
  assert.equal(dom.window.document.querySelectorAll("img[data-cloudig-resource]").length, 0);
  assert.equal(result.fingerprint.sha256, sha(output)); assert(progress.length >= 2);
  assert.deepEqual(progress.at(-1), [output.length, output.length]);
  assert.equal(sha(await readFile(source)), expected); assert.deepEqual(await readdir(path.join(root, "cache/Engine")), []);
  dom.window.close();
}));

test("packaged Engine exports inline and nested images through the actual archive capability", { skip: !process.env["CLOUDIG_RECORD_PACKAGE_ROOT"] }, async () => temporary(async root => {
  const { startRecordEngine } = await import(pathToFileURL(path.resolve("scripts/record-engine-client.mjs")).href);
  const engine = startRecordEngine({ packageRoot: path.resolve(process.env["CLOUDIG_RECORD_PACKAGE_ROOT"]!), libraryRoot: root });
  try {
    await engine.request("library.create");
    const original = await readFile(path.resolve("tests/v1/records/fixtures/inline-images.json"));
    await writeFile(path.join(root, "Conversations/inline.json"), original);
    const list = await engine.request("reader.archives.query", { offset: 0, limit: 10 }); assert.equal(list.total, 1);
    const events: JsonObject[] = [], result = await engine.request("reader.archive.exportMarkdown", { archive: list.items[0].capability }, (event: JsonObject) => { events.push(event); });
    const output = await readFile(path.join(root, "Exports", result.filename)), dom = new JSDOM(output.toString("utf8"));
    const image = JSON.parse(original.toString("utf8")).resources[0];
    for (const selector of ["td img", "li img", "details details p img"]) {
      const node = dom.window.document.querySelector<HTMLImageElement>(selector); assert(node, selector);
      assert.equal(sha(Buffer.from(node.src.split(",")[1]!, "base64")), image.sha256);
    }
    assert.equal(result.status, "exported"); assert.equal(result.sha256, sha(output)); assert.equal(result.bytes, output.length);
    assert.deepEqual(events.at(-1)!["bytes"], { completed: output.length, total: output.length });
    assert.equal(sha(await readFile(path.join(root, "Conversations/inline.json"))), sha(original));
    assert.equal(dom.window.document.querySelector("td:has(img)")!.textContent, "BeforeAfter");
    assert.equal(dom.window.document.querySelectorAll("img[data-cloudig-resource]").length, 0); dom.window.close();
    console.log(JSON.stringify({ packaged_inline_export: { images: 3, source_unchanged: true, progress_exact: true, bytes: result.bytes, sha256: result.sha256 } }));
  } finally { await engine.close(); }
}));

test("isolated-process resource memory measurement", { skip: process.env["CLOUDIG_RECORD_STREAM_BENCH"] !== "1" }, async () => temporary(async root => {
  const chunk = Buffer.alloc(1024 * 1024, 0xac), encoded = chunk.toString("base64"), metrics: JsonObject[] = [];
  for (const count of [2, 48]) {
    const c = await conversation([chunk]), r = (c["resources"] as JsonObject[])[0]!, digest = createHash("sha256");
    for (let i = 0; i < count; i++) digest.update(chunk);
    r["bytes"] = count * chunk.length; r["sha256"] = digest.digest("hex"); r["data_base64"] = Array(count).fill(encoded);
    const relative = `Conversations/${count}.json`; await commitRecords(root, [{ action: "write", kind: "conversation", path: relative, value: c, expected: null }]);
    const metric = await new Promise<JsonObject>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("tests/v1/records/stream-metrics-child.mts"), path.join(root, relative)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; }); child.once("error", reject);
      child.once("exit", code => { if (code !== 0) reject(new Error(errors || `Measurement exited ${code}`)); else { try { resolve(JSON.parse(output) as JsonObject); } catch (error) { reject(error); } } });
    });
    assert.equal(metric["retainedBase64"], false); assert.equal(metric["resources"], 1); metrics.push(metric);
  }
  console.log(JSON.stringify({ record_stream_metrics: metrics }));
}));
