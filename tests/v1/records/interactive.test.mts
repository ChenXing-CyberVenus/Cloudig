import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeRecord, encodeRecord, validateRecord } from "../../../src/core/records/index.mts";
import { validateConversationRecordMetadata } from "../../../src/core/records/index.mts";
import { CONVERSATION_SCHEMA, LIBRARY_SCHEMA, validateConversationHeader } from "../../../src/core/records/schema-registry.mts";
import { createLibraryMetadata } from "../../../src/app/library/record-defaults.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const fixture = (): JsonObject => JSON.parse(readFileSync(new URL("./fixtures/04-1.json", import.meta.url), "utf8"));
const source = '<!doctype html><button onclick="document.body.dataset.hit=1">Run</button>';
const body = Buffer.from(source);
const resource = { id: "interactive-file", kind: "file", availability: "embedded", name: "index.html", mime: "text/html", bytes: body.length,
  sha256: createHash("sha256").update(body).digest("hex"), data_base64: [body.toString("base64")] };
function sample(block: JsonObject): JsonObject {
  const v = fixture(); v["schema"] = CONVERSATION_SCHEMA;
  const messages = (v["messages"] as JsonObject)["items"] as JsonObject[];
  messages[0]!["content"] = [block]; v["resources"] = [resource];
  return v;
}
const windowBlock = (): JsonObject => ({ type: "interactive", display: "window", source: "claude.ai_artifact", format: "html", title: "Window",
  files: [{ path: "index.html", resource: resource.id }], entry: "index.html" });
const blocks = (v: JsonObject) => ((v["messages"] as JsonObject)["items"] as JsonObject[])[0]!["content"] as JsonObject[];

test("Box/Window preserve source product, native type and data without running source", () => {
  for (const block of [windowBlock(), { type: "interactive", display: "box", source: "claude.ai_quiz_display_v0", format: "structured", data: { questions: [{ text: "Q", options: ["A", "B"] }] } }]) {
    const v = sample(block); assert.equal(validateRecord("conversation", v).ok, true);
    assert.deepEqual(decodeRecord("conversation", encodeRecord("conversation", v)), { ok: true, value: v });
  }
  const v = sample(windowBlock()); blocks(v)[0]!["source"] = "future-product_canvas";
  assert.equal(validateRecord("conversation", v).ok, true, "sources are not a closed list of twelve providers");
  blocks(v)[0]!["source"] = { platform: "claude.ai", type: "artifact" };
  assert.equal(validateRecord("conversation", v).ok, false, "source is the user-approved single string");
});

test("1.0.0 remains strict and readable, not silently redefined to accept new blocks", () => {
  const old = fixture(), before = JSON.stringify(old);
  assert.equal(validateRecord("conversation", old).ok, true);
  assert.equal(JSON.stringify(old), before);
  const v = sample(windowBlock()); v["schema"] = "cloudig/conversation/1.0.0";
  assert.equal(validateRecord("conversation", v).ok, false);
  v["schema"] = "cloudig/conversation/1.0.2";
  const invalid = validateRecord("conversation", v); assert(!invalid.ok);
  assert.equal(invalid.issues[0]!.code, "CLOUDIG_RECORD_SCHEMA_UNSUPPORTED");
  assert.match(invalid.issues[0]!.message, /请更新采云/u);
});

test("Window file references and entry paths stay within their own declared resource set", () => {
  for (const name of ["../escape.html", "/root.html", "C:/x.html", "a\\b.html", "https://x.test/a", "a//b", "a/./b", "a/%2e%2e/b"]) {
    const b = windowBlock(); (b["files"] as JsonObject[])[0]!["path"] = name; b["entry"] = name;
    assert.equal(validateRecord("conversation", sample(b)).ok, false, name);
  }
  for (const change of [
    (b: JsonObject) => { b["entry"] = "absent.html"; },
    (b: JsonObject) => { b["preview"] = resource.id; },
    (b: JsonObject) => { (b["files"] as JsonObject[])[0]!["resource"] = "absent"; },
    (b: JsonObject) => { (b["files"] as JsonObject[]).push({ path: "index.html", resource: resource.id }); }
  ]) { const b = windowBlock(); change(b); assert.equal(validateRecord("conversation", sample(b)).ok, false); }
});

test("both supported versions have correct stream/header validation", () => {
  for (const v of [fixture(), sample(windowBlock())]) {
    const header = structuredClone(v);
    for (const k of ["messages", "resources", "references", "limitations"]) delete header[k];
    assert.equal(validateConversationHeader(header), true);
  }
  const v = sample(windowBlock()); delete (v["resources"] as JsonObject[])[0]!["data_base64"];
  const proof = new Map([[resource.id, { bytes: resource.bytes, sha256: resource.sha256 }]]);
  assert.equal(validateConversationRecordMetadata(v, proof).ok, true);
  assert.equal(validateConversationRecordMetadata(v, new Map()).ok, false);
});

test("new Library declares only affected patch versions while legacy declarations remain readable", () => {
  const fresh = createLibraryMetadata({ timestamp: "2026-09-24T00:00:00Z" });
  assert.equal(fresh["schema"], LIBRARY_SCHEMA);
  assert.deepEqual(fresh["schemas"], { library: "1.0.1", conversation: "1.0.1", identity: "1.0.0", mark: "1.0.0", content_time: "1.0.0" });
  assert.equal(fresh["cloudig_standard"], "1.0");
  assert.equal(validateRecord("library", fresh).ok, true);
  const old = JSON.parse(readFileSync(new URL("./fixtures/01-1.json", import.meta.url), "utf8"));
  assert.equal(validateRecord("library", old).ok, true);
});
