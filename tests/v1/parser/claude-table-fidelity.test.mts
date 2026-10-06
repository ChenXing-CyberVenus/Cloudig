import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractHtmlRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { PARSER_VERSION } from "../../../src/app/parser/registry.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

function tables(document: Document): unknown[] {
  return [...document.querySelectorAll<HTMLTableElement>("table")].map(table => [...table.rows].map(row => [...row.cells].map(cell => ({
    text: cell.textContent?.replace(/\s+/gu, " ").trim(),
    align: cell.dataset["osisAlign"] ?? cell.style.textAlign,
    colspan: cell.colSpan, rowspan: cell.rowSpan,
    links: [...cell.querySelectorAll("a")].map(a => a.getAttribute("href"))
  }))));
}

const sample = process.env["CLOUDIG_RECORD_SAMPLE"];
test("latest Claude Chat and Cowork tables keep every cell, span, link, alignment and local wrapper", { skip: !sample }, async () => {
  let checked = 0, tableCount = 0, cells = 0;
  const profiles = new Map<string, number>();
  for (const file of await readdir(sample!)) {
    if (!file.endsWith(".html")) continue;
    const filePath = path.join(sample!, file), source = await readFile(filePath, "utf8");
    if (!source.includes('id="claude-export-data"')) continue;
    const original = new JSDOM(source);
    try {
      const extracted = await extractHtmlRecord({ filePath, temporaryRoot: path.resolve("tests/private/schema-rebuild") });
      const record = assembleConversationRecord({ ...extracted, parserVersion: PARSER_VERSION, timestamp: "2026-09-19T00:00:00Z" });
      const blocks = ((record["messages"] as JsonObject)["items"] as JsonObject[]).flatMap(message => message["content"] as JsonObject[]);
      const parsed = new JSDOM(blocks.flatMap(block => block["type"] === "html" ? [String(block["html"])] : block["format"] === "html" ? [String(block["text"])] : []).join(""));
      try {
        assert.deepEqual(tables(parsed.window.document), tables(original.window.document), file);
        const found = [...parsed.window.document.querySelectorAll("table")];
        assert(found.length > 0, `${file}: expected a real table witness`);
        assert(found.every(t => t.parentElement?.classList.contains("table-wrap")), `${file}: new exporter wrapper survives inert extraction`);
        tableCount += found.length;
        cells += found.reduce((sum, t) => sum + [...t.rows].reduce((n, r) => n + r.cells.length, 0), 0);
        const profile = String((record["source"] as JsonObject)["profile"]);
        profiles.set(profile, (profiles.get(profile) ?? 0) + 1); checked++;
      } finally { parsed.window.close(); }
    } finally { original.window.close(); }
  }
  assert(checked >= 5, "three Chat profiles and two Cowork profiles");
  assert.deepEqual([...profiles.keys()].sort(), ["full", "light", "tree"]);
  console.log(JSON.stringify({ claude_files: checked, tables: tableCount, cells, profiles: Object.fromEntries(profiles) }));
});
