import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adapterBundleSnapshot } from "../../../src/app/parser/registry.mts";

test("bundled Parser history resolves each delta and ends at the exact current adapter mapping", async () => {
  const data = JSON.parse(await readFile(new URL("../../../src/adapters/parser/contracts/parser-history.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../../../src/ui/shared/parser-history.js", import.meta.url), "utf8");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const rows = module.parserReleaseMappings(data);
  assert.ok(rows.length >= 13);
  assert.equal(new Set(rows.map((row: { version: string }) => row.version)).size, rows.length);
  assert.equal(rows.at(-1).version, adapterBundleSnapshot().parser);
  assert.equal(data.current_parser, rows.at(-1).version);
  assert.deepEqual(rows.at(-1).adapters, Object.fromEntries(adapterBundleSnapshot().adapters.map(adapter => [adapter.id, adapter.version])));
  for (const row of rows) {
    assert.match(row.version, /^\d+\.\d+\.\d+$/u);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/u);
    assert.match(row.source_commit, /^[0-9a-f]{40}$/u);
    assert.ok(Object.keys(row.adapters).length > 0);
  }
  assert.deepEqual(rows.find((row: { version: string }) => row.version === "1.0.11").adapters, rows.find((row: { version: string }) => row.version === "1.0.10").adapters, "A performance-only total bump must not invent adapter changes");
});
