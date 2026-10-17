import assert from "node:assert/strict";
import test from "node:test";
import { uuidV7 } from "../../../src/core/records/ids.mts";
import { formatRecordTimeEndpoint, recordTimeRangeLabels, recordContentTimeOrder, compareRecordContentTimes, recordTimeRangeDirection } from "../../../src/core/records/time-display.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const year = (value: number, era = "AD"): JsonObject => ({ kind: "calendar", era, year: value });
const facts = (range?: JsonObject, modified = "2026-09-11T00:00:00Z") => ({ ...(range ? { range } : {}), fileModifiedAt: modified, title: "Title", conversationId: uuidV7() });
test("display preserves calendar precision and node names/periods without fabricated date labels", () => {
  assert.equal(formatRecordTimeEndpoint({ ...year(2026), month: 9 }, "zh-CN"), "2026年9月");
  assert.equal(formatRecordTimeEndpoint({ ...year(2026), month: 9, day: 11 }, "zh-CN"), "2026-09-11");
  const node: JsonObject = { kind: "node", target: { node: uuidV7(), occurrences: { first: 1, step: 2, last: 5 } }, snapshot: { node: { kind: "periodic", name: "星河", count: 10, prefix: "第", unit: "纪" }, timeline: { name: "纪元", author: "晨星" } } };
  assert.equal(formatRecordTimeEndpoint(node, "zh-CN"), "纪元 · 星河（第1纪–第5纪，步长2）");
  assert.deepEqual(recordTimeRangeLabels({ start: year(1, "BC"), end: year(2) }, "zh-CN"), { start: "公元前1年", end: "2年" });
  assert.deepEqual(recordTimeRangeLabels({ start: year(2), end: year(2) }, "zh-CN"), { start: "2年" });
});
test("time comparison uses exact bounds, includes end values and keeps unset time last", () => {
  const a = recordContentTimeOrder(facts({ start: year(2026), end: year(2028) })), b = recordContentTimeOrder(facts({ start: year(2026), end: year(2029) })), empty = recordContentTimeOrder(facts());
  assert(compareRecordContentTimes(a, b, "asc") < 0); assert(compareRecordContentTimes(a, b, "desc") > 0);
  assert(compareRecordContentTimes(a, empty, "desc") < 0);
  const ancient = recordContentTimeOrder(facts({ start: { kind: "relative", direction: "before", unit: "yi", value: "9999.0", anchor: { date: "2026-09-11", offset: "Z" } } }));
  assert(compareRecordContentTimes(ancient, a, "asc") < 0);
});
test("node snapshots sort offline by full mapped ranges or by explicit root order and ordinal path", () => {
  const l = uuidV7(), r = uuidV7();
  const endpoint = (root: string, position: number): JsonObject => ({ kind: "node", target: { node: uuidV7(), timeline: root }, snapshot: { node: { kind: "single", name: "A" }, path: [position] } });
  const a = recordContentTimeOrder(facts({ start: endpoint(l, 9) })), b = recordContentTimeOrder(facts({ start: endpoint(r, 1) }));
  assert(compareRecordContentTimes(a, b, "asc", new Map([[l, 0], [r, 1]])) < 0);
  const mapped = endpoint(l, 1); (mapped["snapshot"] as JsonObject)["sort"] = { start: year(2026), end: year(2030) };
  const span = recordContentTimeOrder(facts({ start: mapped })), shorter = recordContentTimeOrder(facts({ start: year(2026), end: year(2029) }));
  assert(compareRecordContentTimes(span, shorter, "asc") > 0); assert(compareRecordContentTimes(span, a, "asc") < 0);
});

test("range direction warns without rewriting reversed values or inventing order between unrelated axes", () => {
  const reverse = { start: year(2028), end: year(2026) }; assert.equal(recordTimeRangeDirection(reverse), "reversed"); assert.deepEqual(reverse.start, year(2028));
  const node = (root: string, position: number): JsonObject => ({ kind: "node", target: { node: uuidV7(), timeline: root }, snapshot: { node: { name: "T", kind: "single" }, path: [position] } });
  const root = uuidV7(); assert.equal(recordTimeRangeDirection({ start: node(root, 2), end: node(root, 1) }), "reversed");
  assert.equal(recordTimeRangeDirection({ start: node(root, 2), end: node(uuidV7(), 1) }), "indeterminate");
});
