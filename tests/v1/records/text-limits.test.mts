import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateRecord, type RecordKind } from "../../../src/core/records/index.mts";
import { RECORD_TEXT_LIMITS, recordTextLength, withinRecordTextLimit } from "../../../src/core/records/text-limits.mts";
import { identityName } from "../../../src/core/records/identity-edit.mts";
import { applyRecordInfoDraft } from "../../../src/app/reader/record-info.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const fixture = (name: string): JsonObject => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const obj = (value: unknown) => value as JsonObject;
test("two shared limits use Schema Unicode code points, not UTF-16 units", () => {
  assert.deepEqual(RECORD_TEXT_LIMITS, { name: 1024, title: 4096 });
  assert.equal(recordTextLength("中😀"), 2);
  for (const unit of ["a", "中", "😀"]) for (const delta of [-1, 0, 1]) {
    const name = unit.repeat(RECORD_TEXT_LIMITS.name + delta);
    assert.equal(withinRecordTextLimit(name, RECORD_TEXT_LIMITS.name), delta <= 0);
    if (delta <= 0) assert.equal(identityName(name), name); else assert.throws(() => identityName(name));
    const identity = fixture("02-1"); obj((identity["names"] as JsonObject[])[0])["name"] = name;
    assert.equal(validateRecord("identity", identity).ok, delta <= 0);
    const draft = { conversation_name: { state: "set", value: unit.repeat(RECORD_TEXT_LIMITS.title + delta) }, models: { state: "inherit" }, content_time: { state: "inherit" } };
    if (delta <= 0) assert.doesNotThrow(() => applyRecordInfoDraft({}, draft, "019ecb65-7c00-7000-8000-000000000001", "2026-09-16T00:00:00Z"));
    else assert.throws(() => applyRecordInfoDraft({}, draft, "user", "2026-09-16T00:00:00Z"));
  }
});
test("all time names and conversation/Mark titles reject overflow, without limiting body text", () => {
  for (const [filename, kind, fields, limit] of [
    ["03-1", "contentTime", ["name", "author", "standard_name"], RECORD_TEXT_LIMITS.name],
    ["03-2", "contentTime", ["name", "prefix", "unit"], RECORD_TEXT_LIMITS.name],
    ["05-1", "mark", ["conversation_title"], RECORD_TEXT_LIMITS.title]
  ] as const) for (const key of fields) for (const delta of [0, 1]) {
    const value = fixture(filename); value[key] = "😀".repeat(limit + delta);
    if (filename === "03-2") { value["kind"] = "periodic"; value["count"] = 3; delete value["terran_mappings"]; }
    const valid = validateRecord(kind as RecordKind, value);
    assert.equal(valid.ok, delta === 0, `${filename}/${key}: ${JSON.stringify(valid)}`);
  }
  for (const key of ["filename", "original"]) {
    const c = fixture("04-1"); obj(c["title"])[key] = "中".repeat(RECORD_TEXT_LIMITS.title + 1);
    assert.equal(validateRecord("conversation", c).ok, false);
  }
  const c = fixture("04-1"), message = (obj(c["messages"])["items"] as JsonObject[])[0]!;
  message["content"] = [{ type: "text", text: "正文".repeat(RECORD_TEXT_LIMITS.title) }];
  assert.equal(validateRecord("conversation", c).ok, true);
});
