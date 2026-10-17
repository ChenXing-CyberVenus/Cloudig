import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzeVariantImpact,
  analyzeTimeDeleteImpact,
  buildSovereignSnapshot,
  canonicalPath,
  cloneVariantState,
  deleteTimeNodeState,
  validateTimeSystem
} from "../../../src/core/index.mts";
import type { ArchiveTimeReference } from "../../../src/core/time/impact.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { isJsonObject } from "../../../src/core/contracts/types.mts";

const fixtures = new URL("../contracts/fixtures/", import.meta.url);

async function timeSystem(): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(new URL("time-system-full.json", fixtures), "utf8"));
  assert.equal(isJsonObject(value), true);
  return value as JsonObject;
}

test("canonical path uses first DFS ordinal while cycles and repeated links remain legal", async () => {
  const system = await timeSystem();
  assert.deepEqual(canonicalPath(system, "v2", 10), { status: "found", path: [], visited: 1 });
  assert.deepEqual(canonicalPath(system, "t1", 10), { status: "found", path: [1], visited: 2 });
  assert.deepEqual(canonicalPath(system, "t2", 10), { status: "found", path: [2], visited: 3 });
  assert.deepEqual(canonicalPath(system, "t3", 10), { status: "unreachable", visited: 1 });

  const contains = system["contains"];
  assert.ok(isJsonObject(contains) && Array.isArray(contains["v2"]));
  contains["v2"].push({ node: "t1" });
  assert.deepEqual(canonicalPath(system, "t1", 10), { status: "found", path: [1], visited: 2 });
});

test("canonical traversal returns budget_exceeded without a partial path", async () => {
  const system = await timeSystem();
  assert.deepEqual(canonicalPath(system, "t2", 1), { status: "budget_exceeded", visited: 1 });
  assert.deepEqual(buildSovereignSnapshot(system, {
    node: "t2",
    occurrences: { mode: "progression", first: 1, step: 1, last: 12 }
  }, 1), { status: "budget_exceeded" });
});

test("snapshot copies only portable facts, first path, and earliest direct intersecting mapping", async () => {
  const system = await timeSystem();
  const result = buildSovereignSnapshot(system, {
    node: "t2",
    occurrences: { mode: "progression", first: 1, step: 1, last: 12 }
  }, 20);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.snapshot["path"], [2]);
  assert.ok(isJsonObject(result.snapshot["sort"]));
  assert.equal("parents" in result.snapshot, false);
  assert.equal("children" in result.snapshot, false);
  assert.equal("counterparts" in result.snapshot, false);
  assert.equal("mappings" in result.snapshot, false);

  const mappings = system["terran_mappings"];
  assert.ok(Array.isArray(mappings));
  mappings.push({
    target: { node: "t2", occurrences: { mode: "progression", first: 1, step: 2, last: 11 } },
    range: { start: { kind: "calendar", era: "AD", year: 1900 } },
    edited_at: "2026-08-31T11:30:00.000Z"
  });
  const evenOnly = buildSovereignSnapshot(system, {
    node: "t2",
    occurrences: { mode: "progression", first: 2, step: 2, last: 12 }
  }, 20);
  assert.equal(evenOnly.status, "ok");
  if (evenOnly.status === "ok") {
    const sort = evenOnly.snapshot["sort"];
    assert.ok(isJsonObject(sort) && isJsonObject(sort["start"]));
    assert.equal(sort["start"]["year"], 2026);
  }
});

test("an owned but unreachable node receives a valid portable snapshot with no invented path", async () => {
  const system = await timeSystem();
  const result = buildSovereignSnapshot(system, { node: "t3" }, 20);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal("path" in result.snapshot, false);
    assert.equal("sort" in result.snapshot, false);
  }
  assert.deepEqual(buildSovereignSnapshot(system, { node: "t99" }, 20), { status: "invalid_target" });
});

const REFERENCES: ArchiveTimeReference[] = [
  {
    archive: "a1",
    title: "Periodic",
    endpoints: [{
      side: "start",
      target: { node: "t2", occurrences: { mode: "progression", first: 1, step: 1, last: 12 } }
    }]
  },
  {
    archive: "a2",
    title: "Variant root",
    endpoints: [{ side: "start", target: { node: "v2" } }]
  },
  {
    archive: "a3",
    title: "Other lineage node",
    endpoints: [{ side: "start", target: { node: "t3" } }]
  }
];

test("impact analysis lists exact archive refs, external direct links, and selector invalidation", async () => {
  const system = await timeSystem();
  const contains = system["contains"];
  const counterparts = system["counterparts"];
  assert.ok(isJsonObject(contains) && Array.isArray(contains["v2"]) && Array.isArray(counterparts));
  contains["v1"] = [{ node: "t2", occurrences: { mode: "prefix", count: 12 } }];
  contains["v2"].push({ node: "t3" });
  counterparts.push({ left: { node: "t2", occurrences: { mode: "all" } }, right: { node: "t3" } });

  const impact = analyzeVariantImpact(system, "v2", REFERENCES, { t2: 3 });
  assert.deepEqual(impact.affectedArchives.map((entry) => entry.archive), ["a1", "a2"]);
  assert.ok(impact.externalLinks.some((entry) => entry.kind === "contains_incoming" && entry.externalNode === "v1"));
  assert.ok(impact.externalLinks.some((entry) => entry.kind === "contains_outgoing" && entry.externalNode === "t3"));
  assert.ok(impact.externalLinks.some((entry) => entry.kind === "counterpart" && entry.externalNode === "t3"));
  assert.ok(impact.invalidSelectors.some((entry) => entry.kind === "archive" && entry.node === "t2"));
  assert.ok(impact.invalidSelectors.some((entry) => entry.kind === "mapping" && entry.node === "t2"));
  assert.deepEqual(impact.strategies, ["all_references", "selected_references", "future_only"]);

  const isolated = analyzeVariantImpact(await timeSystem(), "v1", [], {});
  assert.deepEqual(isolated.strategies, ["in_place"]);
});

test("time deletion impact is exact and deletion removes only the chosen node plus reviewed direct links", async () => {
  const system = await timeSystem();
  const impact = analyzeTimeDeleteImpact(system, "t2", REFERENCES);
  assert.deepEqual(impact.deletedNodes, ["t2"]);
  assert.deepEqual(impact.parents.map((entry) => [entry.parent, entry.child]), [["v2", "t2"]]);
  assert.deepEqual(impact.children.map((entry) => [entry.parent, entry.child]), [["t2", "t1"]]);
  assert.equal(impact.counterparts.length, 1);
  assert.equal(impact.mappings.length, 1);
  assert.deepEqual(impact.affectedArchives.map((entry) => entry.archive), ["a1"]);
  assert.equal(impact.currentVariant, false);
  assert.deepEqual(impact.replacementVariants, []);

  const deleted = deleteTimeNodeState(system, "t2", undefined, "2026-09-01T13:00:00.000Z");
  assert.deepEqual(deleted.deletedNodes, ["t2"]);
  assert.equal(validateTimeSystem(deleted.system).ok, true);
  assert.equal(system["revision"], 5);
  assert.equal(deleted.system["revision"], 6);
  const times = deleted.system["times"] as JsonObject;
  const variants = deleted.system["variants"] as JsonObject;
  const contains = deleted.system["contains"] as JsonObject;
  assert.equal("t2" in times, false);
  assert.equal((variants["v2"] as JsonObject)["revision"], 4);
  assert.deepEqual((contains["v2"] as JsonObject[]).map((entry) => entry["node"]), ["t1", "v2"]);
  assert.equal("t2" in contains, false);
  assert.deepEqual(deleted.system["counterparts"], [{ left: { node: "v2" }, right: { node: "v2" } }]);
  assert.equal(deleted.system["terran_mappings"], undefined);
  assert.deepEqual(deleted.system["next"], system["next"]);
});

test("deleting a current variant requires an exact surviving replacement and never rolls allocation watermarks back", async () => {
  const system = await timeSystem();
  const impact = analyzeTimeDeleteImpact(system, "v2", REFERENCES);
  assert.deepEqual(impact.deletedNodes, ["t1", "t2", "v2"]);
  assert.equal(impact.currentVariant, true);
  assert.deepEqual(impact.replacementVariants, ["v1"]);
  assert.deepEqual(impact.affectedArchives.map((entry) => entry.archive), ["a1", "a2"]);
  assert.throws(() => deleteTimeNodeState(system, "v2", undefined, "2026-09-01T13:00:00.000Z"), /replacement/iu);

  const deleted = deleteTimeNodeState(system, "v2", "v1", "2026-09-01T13:00:00.000Z");
  assert.equal(validateTimeSystem(deleted.system).ok, true);
  const lineages = deleted.system["lineages"] as JsonObject;
  const variants = deleted.system["variants"] as JsonObject;
  const times = deleted.system["times"] as JsonObject;
  assert.equal((lineages["l1"] as JsonObject)["current"], "v1");
  assert.equal("v2" in variants, false);
  assert.deepEqual(Object.keys(times), ["t3"]);
  assert.deepEqual(deleted.system["display_order"], ["v1"]);
  assert.deepEqual(deleted.system["next"], system["next"]);

  const last = deleteTimeNodeState(deleted.system, "v1", undefined, "2026-09-01T13:01:00.000Z");
  assert.equal(validateTimeSystem(last.system).ok, true);
  assert.equal(last.system["lineages"], undefined);
  assert.equal(last.system["variants"], undefined);
  assert.equal(last.system["times"], undefined);
  assert.equal(last.system["display_order"], undefined);
  assert.deepEqual(last.system["next"], system["next"]);
});

test("selected-reference clone allocates a new #N, rewrites internal graph, and leaves old/external incoming links intact", async () => {
  const system = await timeSystem();
  const contains = system["contains"];
  const counterparts = system["counterparts"];
  assert.ok(isJsonObject(contains) && Array.isArray(contains["v2"]) && Array.isArray(counterparts));
  contains["v1"] = [{ node: "t2", occurrences: { mode: "prefix", count: 12 } }];
  contains["v2"].push({ node: "t3" });
  counterparts.push({ left: { node: "t2", occurrences: { mode: "all" } }, right: { node: "t3" } });
  assert.equal(validateTimeSystem(system).ok, true);

  const result = cloneVariantState(
    system,
    "v2",
    "selected_references",
    REFERENCES,
    new Set(["a1", "a3"]),
    "2026-08-31T12:30:00.000Z",
    { name: "星河纪元·新分叉", version: "2.0" }
  );
  assert.deepEqual(result.nodeMap, { v2: "v3", t1: "t4", t2: "t5" });
  assert.equal(validateTimeSystem(result.system).ok, true);
  assert.equal(system["revision"], 5);

  const variants = result.system["variants"];
  const times = result.system["times"];
  const resultContains = result.system["contains"];
  const lineages = result.system["lineages"];
  const next = result.system["next"];
  assert.ok(isJsonObject(variants) && isJsonObject(times) && isJsonObject(resultContains) && isJsonObject(lineages) && isJsonObject(next));
  assert.ok(isJsonObject(variants["v2"]) && isJsonObject(variants["v3"]));
  assert.equal(variants["v3"]["number"], 3);
  assert.equal(variants["v3"]["revision"], 1);
  assert.equal(variants["v3"]["name"], "星河纪元·新分叉");
  assert.ok(isJsonObject(times["t4"]) && isJsonObject(times["t5"]));
  assert.equal(times["t4"]["owner"], "v3");
  assert.ok(Array.isArray(resultContains["v3"]));
  assert.deepEqual(resultContains["v3"].map((entry) => isJsonObject(entry) ? entry["node"] : undefined), ["t4", "t5", "v3", "t3"]);
  assert.deepEqual(resultContains["v1"], [{ node: "t2", occurrences: { mode: "prefix", count: 12 } }]);
  assert.equal((lineages["l1"] as JsonObject)["current"], "v3");
  assert.equal(next["variant"], 4);
  assert.equal(next["time"], 6);
  assert.deepEqual(result.archiveRetargets.map((entry) => entry.archive), ["a1"]);
  assert.equal(result.archiveRetargets[0]!.endpoints[0]!.target["node"], "t5");

  const clonedCounterparts = result.system["counterparts"];
  assert.ok(Array.isArray(clonedCounterparts));
  assert.ok(clonedCounterparts.some((entry) => isJsonObject(entry)
    && isJsonObject(entry["left"]) && isJsonObject(entry["right"])
    && new Set([entry["left"]["node"], entry["right"]["node"]]).has("t5")
    && new Set([entry["left"]["node"], entry["right"]["node"]]).has("t3")));
});

test("future-only clone leaves every current archive reference untouched", async () => {
  const result = cloneVariantState(
    await timeSystem(),
    "v2",
    "future_only",
    REFERENCES,
    new Set(["a1", "a2"]),
    "2026-08-31T12:30:00.000Z"
  );
  assert.deepEqual(result.archiveRetargets, []);
  assert.equal(validateTimeSystem(result.system).ok, true);
});
