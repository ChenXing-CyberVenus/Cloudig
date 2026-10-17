import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeRecord, encodeRecord, inspectTimeLinks, parseRecordJson, validateRecord, type RecordKind } from "../../../src/core/records/index.mts";
import type { JsonObject, JsonValue } from "../../../src/core/contracts/types.mts";
import commonSchema from "../../../src/core/records/schemas/common.schema.json" with { type: "json" };
import timeSchema from "../../../src/core/records/schemas/content-time.schema.json" with { type: "json" };
import { RECORD_TIME_LIMITS } from "../../../src/core/records/limits.mts";

const fixture = (name: string): JsonObject => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as JsonObject;
const asObject = (v: JsonValue | undefined): JsonObject => v as JsonObject;
const items = (v: JsonValue | undefined): JsonObject[] => v as JsonObject[];
const good = (kind: RecordKind, v: unknown): void => { const r = validateRecord(kind, v); assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.issues)); };
const bad = (kind: RecordKind, v: unknown): void => assert.equal(validateRecord(kind, v).ok, false);

test("approved examples validate and roundtrip without adding fields", () => {
  for (const [name, kind] of [["01-1", "library"], ["02-1", "identity"], ["02-2", "identitySettings"], ["03-1", "contentTime"], ["03-2", "contentTime"], ["03-3", "contentTime"], ["04-1", "conversation"], ["05-1", "mark"], ["05-2", "mark"]] as const) {
    const v = fixture(name), before = structuredClone(v); good(kind, v);
    const encoded = encodeRecord(kind, v), decoded = decodeRecord(kind, encoded);
    assert.equal(decoded.ok, true); if (decoded.ok) assert.deepEqual(decoded.value, v);
    assert.deepEqual(v, before); assert(encoded.endsWith("\n"));
  }
});

test("HTML inline images reference image resources in this Conversation, not unrelated or missing IDs", () => {
  const c = fixture("04-1"), content = items(items(asObject(c["messages"])["items"])[0]!["content"]);
  c["resources"] = [{ id: "inline&image", kind: "image", availability: "metadata_only", name: "Diagram" }];
  content.splice(0, content.length, { type: "html", html: '<table><tr><td>Before<img data-cloudig-resource="inline&amp;image" alt="Diagram">After</td></tr></table>' });
  good("conversation", c);
  content[0]!["html"] = '<p><img data-cloudig-resource="missing"></p>';
  const missing = validateRecord("conversation", c); assert.equal(missing.ok, false);
  if (!missing.ok) assert(missing.issues.some(issue => issue.message.includes("resource") && issue.path.includes("content/0")));
  content[0]!["html"] = '<p><img data-cloudig-resource="inline&amp;image"></p>';
  items(c["resources"])[0]!["kind"] = "file"; bad("conversation", c);
  content[0]!["html"] = '<pre>&lt;img data-cloudig-resource="missing"&gt;</pre><!-- <img data-cloudig-resource="missing"> -->'; good("conversation", c);
  content.splice(0, content.length, { type: "reasoning", format: "html", text: '<p><img data-cloudig-resource="missing"></p>' }); bad("conversation", c);
});

test("old development schemas are not accepted by identical version labels", () => {
  for (const [name, kind] of [["library-minimal", "library"], ["conversation-minimal", "conversation"]] as const) {
    const old = JSON.parse(readFileSync(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), "utf8")); bad(kind, old);
  }
  for (const key of ["archive", "generation", "content_sha256", "content_time", "provider", "current_message", "user"]) {
    const c = fixture("04-1"); c[key] = {}; bad("conversation", c);
  }
  for (const key of ["next_archive", "revision", "archives", "identity", "content_time", "preferences", "workflow"]) {
    const l = fixture("01-1"); l[key] = {}; bad("library", l);
  }
});

test("Mark model declarations have no IDs but keep user claimers and Mark identity", () => {
  const m = fixture("05-1"), model = items(m["models"])[0]!;
  assert(!("front_id" in model)); assert(!("source_id" in model));
  for (const key of ["front_id", "source_id", "id"]) { const copy = structuredClone(m); items(copy["models"])[0]![key] = "unused"; bad("mark", copy); }
  for (const key of ["mark_id", "target"]) { const copy = structuredClone(m); delete copy[key]; bad("mark", copy); }
  const claimed = structuredClone(m); asObject(items(items(claimed["models"])[0]!["names"])[0])["claimers"] = [{ name: "user" }]; bad("mark", claimed);
  good("mark", m);
});

test("empty models is an explicit setting; empty Mark and null are not", () => {
  const m = fixture("05-1"); m["models"] = []; good("mark", m);
  delete m["models"]; bad("mark", m);
  m["models"] = null; bad("mark", m);
  delete m["models"]; m["conversation_title"] = "A"; good("mark", m);
  m["names"] = {}; bad("mark", m);
});

test("Front display selection, role location and tool/system kind are enforced", () => {
  const user = fixture("02-1"); user["display_name"] = 2; bad("identity", user);
  user["display_name"] = 0; bad("identity", user);
  const c = fixture("04-1"), fronts = items(c["identity"]), messages = items(asObject(c["messages"])["items"]);
  for (const role of ["tool", "system"]) {
    const copy = structuredClone(c), f = items(copy["identity"])[1]!; f["role"] = role; bad("conversation", copy);
    f["kind"] = { world: "terran", subject: "program" }; good("conversation", copy);
  }
  fronts[0]!["front_id"] = user["front_id"]!; bad("conversation", c); delete fronts[0]!["front_id"];
  messages[0]!["role"] = "user"; bad("conversation", c); delete messages[0]!["role"];
  messages[0]!["model"] = "invented"; bad("conversation", c); delete messages[0]!["model"];
  fronts[1]!["source_id"] = fronts[0]!["source_id"]!; bad("conversation", c);
});

test("message topology preserves direct parents, rejects cycles, allows empty roots and automatic AI runs", () => {
  const c = fixture("04-1"), tree = asObject(c["messages"]), m = items(tree["items"]);
  m[0]!["parent"] = "m2"; bad("conversation", c); delete m[0]!["parent"];
  m[1]!["parent"] = "m2"; bad("conversation", c);
  m[1]!["parent"] = "missing-in-source"; good("conversation", c); assert.equal(m[1]!["parent"], "missing-in-source");
  tree["current"] = "missing"; bad("conversation", c); tree["current"] = "m2";
  m.push({ id: "topology-root", content: [] }); good("conversation", c);
  m[0]!["speaker"] = "assistant-1"; good("conversation", c);
  m[1]!["speaker"] = "unknown"; bad("conversation", c);
});

test("caller, tool result producer and call ID remain distinct without reordering", () => {
  const c = fixture("04-1"), m = items(asObject(c["messages"])["items"])[1]!;
  items(c["identity"]).push({ schema: "cloudig/identity/1.0.0", source_id: "python", names: [{ name: "python", claimers: [{ name: "OpenAI" }] }], display_name: 1, role: "tool", kind: { world: "terran", subject: "program" } });
  m["content"] = [{ type: "reasoning", content: [
    { type: "tool", kind: "call", recipient: "python", call: "run-1", input: "1+1" },
    { type: "tool", kind: "result", speaker: "python", call: "run-1", output: 2 }
  ] }, { type: "markdown", text: "2" }];
  const before = JSON.stringify(m); good("conversation", c); assert.equal(JSON.stringify(m), before);
  const nested = items(items(m["content"])[0]!["content"]);
  delete nested[1]!["speaker"]; bad("conversation", c); nested[1]!["speaker"] = "python";
  nested[0]!["recipient"] = "assistant-1"; bad("conversation", c);
});

test("resources are self-contained and hash checked chunk by chunk", () => {
  const c = fixture("04-1"), bytes = Buffer.from("source image bytes");
  c["resources"] = [{ id: "image", kind: "image", availability: "embedded", mime: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data_base64: [bytes.subarray(0, 5).toString("base64"), bytes.subarray(5).toString("base64")] }];
  items(asObject(c["messages"])["items"])[0]!["content"] = [{ type: "image", resource: "image", alt: "" }]; good("conversation", c);
  const resource = items(c["resources"])[0]!;
  resource["sha256"] = "0".repeat(64); bad("conversation", c);
  resource["availability"] = "metadata_only"; delete resource["data_base64"]; good("conversation", c);
  resource["availability"] = "external"; bad("conversation", c); resource["url"] = "https://example.invalid/image"; good("conversation", c);
  resource["id"] = "different"; bad("conversation", c);
});

test("all persistent Library defaults are required, and output is inside Conversations", () => {
  const l = fixture("01-1"), s = asObject(l["settings"]); good("library", l);
  assert.equal(s["theme"], "Dawn"); assert.equal(s["theme_guide_completed"], false);
  for (const key of Object.keys(s)) { const copy = structuredClone(l); delete asObject(copy["settings"])[key]; bad("library", copy); }
  for (const dir of ["C:/other", "Conversations/../other", "/Conversations", "Conversations\\folder", "Exports"]) { s["default_output_directory"] = dir; bad("library", l); }
  s["default_output_directory"] = "Conversations/小说"; good("library", l);
});

test("machine timestamps accept real seconds or milliseconds but no calendar normalization", () => {
  const m = fixture("05-1");
  for (const date of ["2026-02-30T10:00:00Z", "0000-01-01T00:00:00Z", "2026-09-11T25:00:00Z"]) { m["edited_at"] = date; bad("mark", m); }
  for (const date of ["2026-09-11T10:00:00Z", "2026-09-11T10:00:00.12Z", "2026-09-11T10:00:00.123Z"]) { m["edited_at"] = date; good("mark", m); }
});

test("content times retain precision, floating zone, huge values and intentional reversal", () => {
  const m = fixture("05-1"); delete m["models"];
  const set = (start: JsonObject, end?: JsonObject): void => { m["content_time"] = { range: { start, ...(end ? { end } : {}) } }; };
  set({ kind: "calendar", era: "AD", year: 2026, month: 9 }); good("mark", m);
  set({ kind: "calendar", era: "BC", year: 1, month: 2, day: 29 }); good("mark", m);
  set({ kind: "calendar", era: "AD", year: 2026, month: 2, day: 29 }); bad("mark", m);
  set({ kind: "calendar", era: "AD", year: 2026, month: 9, offset: "Z" }); bad("mark", m);
  set({ kind: "calendar", era: "AD", year: 99999999 }, { kind: "calendar", era: "BC", year: 9999 }); good("mark", m);
  const relative = { kind: "relative", direction: "after", unit: "zheng", value: "9999.0", anchor: { date: "2026-09-11", offset: "+14:00" } }; set(relative); good("mark", m);
  for (const value of ["0.0", "9999.1", "1.01"]) { set({ ...relative, value }); bad("mark", m); }
});

test("independent time files allow empty axes, multiple parents and cycles without owner/family fields", () => {
  const a = fixture("03-1"), b = fixture("03-2"); b["contains"] = [{ node: a["node_id"]! }]; good("contentTime", a); good("contentTime", b); assert.deepEqual(inspectTimeLinks([a, b]), []);
  delete a["contains"]; good("contentTime", a);
  for (const key of ["owner", "lineage", "variant", "number", "revision", "next", "current"]) { const copy = structuredClone(a); copy[key] = "old"; bad("contentTime", copy); }
  a["contains"] = [{ node: b["node_id"]! }, { node: b["node_id"]! }]; bad("contentTime", a);
});

test("periodic selections keep bounds and snapshots do not need a full time library", () => {
  const m = fixture("05-1"), n = fixture("03-2");
  n["kind"] = "periodic"; n["count"] = 5; delete n["terran_mappings"]; good("contentTime", n);
  n["display_empty"] = true; n["count"] = 21; bad("contentTime", n); n["count"] = 5;
  const target: JsonObject = { node: n["node_id"]!, occurrences: { first: 1, step: 2, last: 5 } };
  const snapshot: JsonObject = { node: { kind: "periodic", name: "轮回", count: 5 } };
  m["content_time"] = { range: { start: { kind: "node", target, snapshot } } }; good("mark", m);
  asObject(target["occurrences"])["last"] = 4; bad("mark", m); asObject(target["occurrences"])["last"] = 5;
  asObject(target["occurrences"])["mode"] = "progression"; bad("mark", m); delete asObject(target["occurrences"])["mode"];
  snapshot["timeline"] = { name: "轴", author: "用户" }; bad("mark", m);
});

test("raw JSON inspection catches discarded duplicate keys, precision loss and invalid syntax", () => {
  for (const text of ['{"x":1,"x":2}', '{"a":1,"\\u0061":2}', '{"nested":{"a":0,"a":1}}', '{"n":9007199254740993}', '{"n":1.234567890123456789}', '{"n":1e-400}', '[1,]', '{"x":}', 'true false', '\uFEFF{}', '{"x":"\\ud800"}']) assert.throws(() => parseRecordJson(text), text);
  for (const text of ['null', '[]', '{}', '{"a":-1.5,"b":[1e3,true,false,null,"x\\\"y"]}', '{"x":{"a":1},"y":{"a":2}}']) assert.deepEqual(parseRecordJson(text), JSON.parse(text));
  const m = fixture("05-1"), text = JSON.stringify(m); assert.equal(decodeRecord("mark", Buffer.from(text)).ok, true);
  assert.equal(decodeRecord("mark", Buffer.from([0xff])).ok, false);
});

test("validation rejects in-memory cycles, getters and sparse/decorated arrays without invoking getters", () => {
  const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic; bad("mark", cyclic);
  let read = false; const getter = Object.defineProperty({}, "x", { enumerable: true, get() { read = true; return 1; } }); bad("mark", getter); assert.equal(read, false);
  const m = fixture("05-1"), sparse = new Array(2); m["models"] = sparse as JsonValue; bad("mark", m);
  Object.assign(sparse, { foo: 1, bar: 2 }); bad("mark", m);
});

test("counterpart relation is stored once even when seen from both ends", () => {
  const a = fixture("03-1"), b = fixture("03-2");
  a["counterparts"] = [{ target: { node: b["node_id"]! } }]; assert.deepEqual(inspectTimeLinks([a, b]), []);
  b["counterparts"] = [{ target: { node: a["node_id"]! } }]; assert(inspectTimeLinks([a, b]).some(x => x.message.includes("stored once")));
});

test("machine numeric constraints are tied to the single time limit table", () => {
  assert.equal(commonSchema.$defs.calendar.properties.year.maximum, 10 ** RECORD_TIME_LIMITS.calendar.ad_year_digits - 1);
  assert.equal(commonSchema.$defs.calendar.allOf[0]!.then.properties.year.maximum, RECORD_TIME_LIMITS.calendar.bc_year_max);
  assert.equal(timeSchema.properties.count.maximum, RECORD_TIME_LIMITS.periodic.count_max);
  assert.equal(commonSchema.$defs.progression.properties.last.maximum, RECORD_TIME_LIMITS.periodic.count_max);
  assert.deepEqual(commonSchema.$defs.relative.properties.unit.enum, RECORD_TIME_LIMITS.relative.units.map(x => x.slug));
  assert.deepEqual(commonSchema.$defs.relative.allOf[0]!.then.properties.unit.enum, RECORD_TIME_LIMITS.relative.before_units);
});

test("large Base64 segments use native byte validation, not an unbounded recursive regex", () => {
  const c = fixture("04-1"), bytes = Buffer.alloc(1024 * 1024, 7);
  c["resources"] = [{ id: "large", kind: "file", availability: "embedded", mime: "application/octet-stream", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data_base64: [bytes.toString("base64")] }];
  good("conversation", c);
  items(c["resources"])[0]!["data_base64"] = ["!!!!"]; bad("conversation", c);
});
