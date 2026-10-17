import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
// UI module is dependency-free and uses the same literal selection in both hosts.
const source = await readFile(new URL("../../../src/ui/shell/archive-scope.js", import.meta.url), "utf8");
const { archiveScopeQuery: query, archiveScopeLabel: label, toggleArchiveScope: toggle } = new Function(source.replaceAll("export function", "function") + ";return {archiveScopeQuery,archiveScopeLabel,toggleArchiveScope};")();

test("all is exclusive with every checkbox, while named directories and Archives form a union", () => {
  let scope = new Set(["all"]);
  scope = toggle(scope, "d_one", true); scope = toggle(scope, "d_two", true); scope = toggle(scope, "archived", true);
  assert.deepEqual(query(scope), { locations: ["conversations", "archives"], directories: ["d_one", "d_two"] });
  scope = toggle(scope, "all", true); assert.deepEqual([...scope], ["all"]); assert.deepEqual(query(scope), { locations: ["conversations"] });
  scope = toggle(scope, "archived", true); assert.deepEqual([...scope], ["archived"]); assert.deepEqual(query(scope), { locations: ["archives"] });
  scope = toggle(scope, "archived", false); assert.deepEqual(query(scope), { locations: [] });
});
test("directory labels describe multiple selection and never expose capabilities", () => {
  const dirs = [{ capability: "d_one", name: "One" }, { capability: "d_two", name: "Two" }];
  assert.equal(label(["d_one"], dirs, "en"), "One");
  assert.equal(label(["d_one", "d_two"], dirs, "zh-CN"), "已选 2 个目录");
  assert.equal(label(["all", "archived"], dirs, "en"), "All + Archived");
  assert.equal(label([], dirs, "en"), "No directories selected");
});
