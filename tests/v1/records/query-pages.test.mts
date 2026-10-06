import assert from "node:assert/strict";
import test from "node:test";
import { QueryPages, QUERY_PAGE_LIMITS } from "../../../src/engine/query-pages.mts";
test("paging metadata is bounded, isolated by query kind and destroyed with its session", () => {
  const pages = new QueryPages(), first = pages.create("source", [{ name: "A" }, { name: "B" }], { total: 2 }, 0, 1);
  assert.deepEqual(pages.read("source", first["snapshot"], 1, 1)["items"], [{ name: "B" }]);
  assert.throws(() => pages.read("claude", first["snapshot"], 0, 1), { code: "CLOUDIG_QUERY_EXPIRED" });
  for (let i = 0; i < QUERY_PAGE_LIMITS.retainedSnapshots; i++) pages.create("source", [], { total: 0 }, 0, 1);
  assert.throws(() => pages.read("source", first["snapshot"], 0, 1), { code: "CLOUDIG_QUERY_EXPIRED" });
  const last = pages.create("source", [], { total: 0 }, 0, 1); pages.clear();
  assert.throws(() => pages.read("source", last["snapshot"], 0, 1), { code: "CLOUDIG_QUERY_EXPIRED" });
});
