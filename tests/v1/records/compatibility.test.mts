import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { decodeRecord, validateRecord, encodeRecord, type RecordKind } from "../../../src/core/records/index.mts";
import { RECORD_SCHEMA_UNSUPPORTED } from "../../../src/core/records/errors.mts";
import { parseStreamingJson } from "../../../src/adapters/parser/json-object-stream.mts";
import { prepareRecordEncoding } from "../../../src/core/records/encoding.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
const fixture = (name: string): JsonObject => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("unsupported record/component versions have a distinct update-required result", () => {
  for (const [file, kind] of [["01-1", "library"], ["02-1", "identity"], ["02-2", "identitySettings"], ["03-1", "contentTime"], ["04-1", "conversation"], ["05-1", "mark"]] as const) {
    const v = fixture(file); v["schema"] = String(v["schema"]).replace("1.0.0", "1.1.0");
    const r = validateRecord(kind as RecordKind, v); assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.issues[0]!.code, RECORD_SCHEMA_UNSUPPORTED);
  }
  for (const field of ["library", "identity", "content_time", "conversation", "mark", "narrative"]) {
    const v = fixture("01-1"); (v["schemas"] as JsonObject)[field] = "1.1.0";
    const r = decodeRecord("library", JSON.stringify(v)); assert(!r.ok); if (!r.ok) assert.equal(r.issues[0]!.code, RECORD_SCHEMA_UNSUPPORTED);
  }
  const v = fixture("04-1"); v["undeclared"] = true;
  const r = validateRecord("conversation", v); assert(!r.ok); if (!r.ok) assert.notEqual(r.issues[0]!.code, RECORD_SCHEMA_UNSUPPORTED);
});
test("known earlier Library gains the total declaration in memory only, and writes it first", () => {
  const v = fixture("01-1"); delete v["cloudig_standard"];
  const text = JSON.stringify(v), r = decodeRecord("library", text);
  assert(r.ok); if (!r.ok) return;
  assert.equal(r.value["cloudig_standard"], "1.0"); assert(!Object.hasOwn(v, "cloudig_standard"));
  assert.deepEqual(r.value["settings"], v["settings"]);
  assert.equal(validateRecord("library", v).ok, false, "canonical new writes require the declaration");
  const encoded = encodeRecord("library", r.value); assert(encoded.startsWith('{\n  "cloudig_standard": "1.0",\n'));
  assert.equal([...prepareRecordEncoding("library", r.value).chunks()].join(""), encoded);
});
test("strict UTF-8 accepts one leading BOM consistently but no interior/double BOM", async () => {
  const c = fixture("04-1"), text = JSON.stringify(c);
  for (const prefix of ["", "\uFEFF"]) {
    assert.deepEqual(decodeRecord("conversation", Buffer.from(prefix + text)), decodeRecord("conversation", text));
    const bytes = Buffer.from(prefix + text), stream = Readable.from(Array.from(bytes, byte => Buffer.from([byte])));
    assert.deepEqual(await parseStreamingJson(stream), c);
  }
  for (const text of ['\uFEFF\uFEFF{}', '{"x":\uFEFF1}', '{\uFEFF"x":1}']) await assert.rejects(parseStreamingJson(Readable.from([Buffer.from(text)])));
  assert.equal(decodeRecord("conversation", Buffer.from([0xff, 0xfe])).ok, false);
});
