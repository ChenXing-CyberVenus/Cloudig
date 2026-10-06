import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { detachConversationResourceBodies, streamCanonicalConversation, verifyStagedConversationResources, type ResourceSpool } from "../../../src/adapters/storage/conversation-stream.mts";
import { decodeCanonicalBase64 } from "../../../src/adapters/storage/stream.mts";
import { serializeDeterministic } from "../../../src/core/contracts/index.mts";

import {
  encodeBase64Chunks,
  fingerprintFile,
  parseManagedRelativePath,
  RootStringFieldRewriter,
  resolveManagedPath,
  verifyBase64Chunks,
  writeOwnedStagingFile
} from "../../../src/adapters/storage/index.mts";

async function disposable(): Promise<{ root: string; library: string; cleanup: () => Promise<void> }> {
  const temporaryRoot = path.join(process.cwd(), "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "cloudig-v1-storage-"));
  const library = path.join(root, "Cloudig");
  await mkdir(path.join(library, "Inbox"), { recursive: true });
  return { root, library, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const value of source) values.push(Buffer.from(value));
  return Buffer.concat(values);
}

test("managed paths reject absolute, parent, dot, empty, and backslash syntax", () => {
  assert.deepEqual(parseManagedRelativePath("Conversations/Folder/chat.json"), ["Conversations", "Folder", "chat.json"]);
  for (const value of ["../outside", "Inbox/../outside", "Inbox//chat", "Inbox/./chat", "C:/outside", "/outside", "Inbox\\chat"]) {
    assert.throws(() => parseManagedRelativePath(value));
  }
});

test("native Base64 roundtrip preserves strict canonical validation for malformed alphabets and padding", () => {
  const values = ["", "AA==", "AB==", "AAA=", "AAB=", "AAAA", "AAAA=", " AA=", "AA\n=", "-AAA", "_AAA", "ＡAAA", "A\0AA", "===="];
  for (let byte = 0; byte < 256; byte++) {
    const encoded = Buffer.from([byte]).toString("base64");
    values.push(encoded, encoded.slice(0, 2) + "=A", encoded.slice(0, 2) + "\t=");
  }
  for (const value of values) {
    const canonical = value.length > 0 && !/\s/u.test(value) && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && Buffer.from(value, "base64").toString("base64") === value;
    if (canonical) assert.deepEqual(decodeCanonicalBase64(value), Buffer.from(value, "base64"));
    else assert.throws(() => decodeCanonicalBase64(value));
  }
});

test("inline small resources and disk-spooled large resources produce identical canonical JSON bytes", async () => {
  const scope = await disposable();
  try {
    const small = Buffer.from("tiny SVG or thumbnail"), large = Buffer.alloc(1024 * 1024 + 17, 123);
    const resources = await Promise.all([small, large].map(async (bytes, index) => ({
      id: `r${index + 1}`, availability: "embedded", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: await collect(encodeBase64Chunks(Readable.from([bytes]), 196608))
    })));
    const original = { resources }, candidate = structuredClone(original);
    const detached = detachConversationResourceBodies(candidate, "x_INLINEBYTECHECKAA", 8 * 1024 * 1024);
    assert.equal(detached.bodies.length, 1);
    assert.ok(candidate.resources[0]!.data_base64);
    const spoolPath = path.join(scope.root, "large.bin"); await writeFile(spoolPath, large);
    const body = detached.bodies[0]!;
    const spools = new Map<string, ResourceSpool>([[body.resource, { resource: body.resource, path: body.path, absolutePath: spoolPath, fingerprint: body.expected }]]);
    const output = await collectBytes(streamCanonicalConversation(candidate, spools));
    assert.equal(output.toString("utf8"), serializeDeterministic(original));
    const target = path.join(scope.root, "result.json"); await writeFile(target, output);
    await verifyStagedConversationResources(target, new Map(resources.map(resource => [resource.id, { fingerprint: { bytes: resource.bytes, sha256: resource.sha256 } }])));
  } finally { await scope.cleanup(); }
});

test("canonical JSON transport coalesces tokens without changing UTF-8 content", async () => {
  const value = { messages: Array.from({ length: 2000 }, (_, index) => ({ role: "assistant", text: `消息 ${index}\nwith code`, index })) };
  const chunks: Buffer[] = [];
  for await (const chunk of streamCanonicalConversation(value, new Map())) chunks.push(Buffer.from(chunk));
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), value);
  assert.ok(chunks.length < 12, `JSON tokens leaked into ${chunks.length} filesystem chunks`);
});

test("path confinement resolves prospective files and rejects reparse escape", async () => {
  const scope = await disposable();
  try {
    const expected = path.join(scope.library, "Inbox", "new.html");
    assert.equal(await resolveManagedPath(scope.library, "Inbox/new.html"), expected);
    await writeFile(expected, "safe", "utf8");
    assert.equal(await resolveManagedPath(scope.library, "Inbox/new.html", { mustExist: true }), expected);

    const outside = path.join(scope.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const link = path.join(scope.library, "Inbox", "escape");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(resolveManagedPath(scope.library, "Inbox/escape/secret.txt", { mustExist: true }), /reparse point|outside/u);
  } finally {
    await scope.cleanup();
  }
});

test("Base64 output is deterministic across arbitrary source chunk boundaries", async () => {
  const bytes = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789", "utf8");
  const sources = [
    Readable.from([bytes]),
    Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 8), bytes.subarray(8, 19), bytes.subarray(19)])
  ];
  const first = await collect(encodeBase64Chunks(sources[0]!, 6));
  const second = await collect(encodeBase64Chunks(sources[1]!, 6));
  assert.deepEqual(first, second);
  assert.ok(first.slice(0, -1).every((chunk) => !chunk.includes("=")));
  const expected = { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  assert.deepEqual(await verifyBase64Chunks(Readable.from(first), expected, 6), expected);
});

test("Base64 verification rejects noncanonical chunks, wrong boundaries, bytes, and hash", async () => {
  const empty = { bytes: 0, sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex") };
  assert.deepEqual(await verifyBase64Chunks(Readable.from([]), empty, 6), empty);
  await assert.rejects(verifyBase64Chunks(Readable.from(["YQ==", "Yg=="]), {
    bytes: 2,
    sha256: createHash("sha256").update("ab").digest("hex")
  }, 6), /non-final/u);
  await assert.rejects(verifyBase64Chunks(Readable.from(["Y Q=="]), { bytes: 1, sha256: "0".repeat(64) }, 6), /alphabet|whitespace/u);
  await assert.rejects(verifyBase64Chunks(Readable.from(["YQ=="]), { bytes: 2, sha256: "0".repeat(64) }, 6), /byte count/u);
  await assert.rejects(verifyBase64Chunks(Readable.from(["YQ=="]), { bytes: 1, sha256: "0".repeat(64) }, 6), /SHA-256/u);
});

test("root string rewrite is chunk-boundary independent and never changes nested fields", async () => {
  const source = Buffer.from(`${String.raw`{"schema":"cloudig/conversation/1.0.0","\u0061rchive":"a2","nested":{"archive":"a2"},"tail":"ok"}`}\n`, "utf8");
  const chunks = Array.from(source, (byte) => Buffer.from([byte]));
  const rewriter = new RootStringFieldRewriter("archive", "a2", "a37");
  const output = await collectBytes(Readable.from(chunks).pipe(rewriter));
  assert.deepEqual(JSON.parse(output.toString("utf8")), {
    schema: "cloudig/conversation/1.0.0",
    archive: "a37",
    nested: { archive: "a2" },
    tail: "ok"
  });
  assert.equal(rewriter.replacementCount, 1);
  assert.equal(rewriter.previousValue, "a2");

  const duplicate = new RootStringFieldRewriter("archive", "a2", "a3");
  await assert.rejects(collectBytes(Readable.from([Buffer.from('{"archive":"a2","archive":"a2"}')]).pipe(duplicate)), /more than once/u);
});

test("transaction-owned staging writes, flushes, fingerprints, and removes only its aborted partial", async () => {
  const scope = await disposable();
  try {
    const target = path.join(scope.library, "staged.bin");
    const bytes = Buffer.from("complete staging bytes", "utf8");
    const progress: number[] = [];
    const fingerprint = await writeOwnedStagingFile(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), target, {
      onProgress: (completed) => progress.push(completed)
    });
    assert.deepEqual(await readFile(target), bytes);
    assert.deepEqual(await fingerprintFile(target), fingerprint);
    assert.deepEqual(progress, [3, bytes.byteLength]);

    const aborted = path.join(scope.library, "aborted.bin");
    const controller = new AbortController();
    await assert.rejects(writeOwnedStagingFile(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), aborted, {
      signal: controller.signal,
      onProgress: () => controller.abort(new Error("cancelled"))
    }), /cancelled/u);
    await assert.rejects(access(aborted));

    await assert.rejects(writeOwnedStagingFile(Readable.from([Buffer.from("collision")]), target), /EEXIST/u);
    assert.deepEqual(await readFile(target), bytes);
  } finally {
    await scope.cleanup();
  }
});
