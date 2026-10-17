import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { analyzeV1BundleMetafiles, writeV1ThirdPartyInventory } from "../../../scripts/v1-third-party-inventory.mjs";

test("the V1 Engine and Renderer have a complete deterministic runtime license inventory", async () => {
  const root = process.cwd();
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const output = await mkdtemp(path.join(root, 'tmp', "cloudig-v1-licenses-"));
  try {
    const metafiles = await analyzeV1BundleMetafiles(root);
    assert.deepEqual(Object.keys(metafiles).sort(), ["engine", "interactive_frame", "interactive_react", "map_frame", "map_worker", "mermaid_layout", "parser_worker", "renderer"]);
    const first = await writeV1ThirdPartyInventory({ repository: root, outputRoot: output, metafiles });
    const firstJson = await readFile(path.join(output, "third-party-inventory.json"), "utf8");
    const firstText = await readFile(path.join(output, "THIRD-PARTY-LICENSES.txt"), "utf8");
    const second = await writeV1ThirdPartyInventory({ repository: root, outputRoot: output, metafiles });
    assert.equal(await readFile(path.join(output, "third-party-inventory.json"), "utf8"), firstJson);
    assert.equal(await readFile(path.join(output, "THIRD-PARTY-LICENSES.txt"), "utf8"), firstText);
    assert.equal(first.notices_sha256, second.notices_sha256);
    assert.deepEqual(first.publication, second.publication);
    assert.equal(first.publication.components.length, first.inventory.summary.runtime_components + first.inventory.summary.npm_packages + first.inventory.summary.bundled_fonts);
    assert.equal(first.inventory.bundled_fonts[0].id, 'Bodoni Moda');
    assert.equal(first.inventory.bundled_fonts[0].bytes, 2500);
    assert.equal(first.inventory.bundled_fonts[0].declared_license, 'OFL-1.1');
    assert.equal(first.inventory.bundled_fonts.find(font => font.id === "Ma Shan Zheng").files.length, 1);
    assert.equal(first.inventory.bundled_fonts.find(font => font.id === "Noto Serif SC").files.length, 1);
    assert.equal(first.inventory.bundled_fonts.find(font => font.id === "Noto Serif SC").files[0].weight, "200 900");
    assert.equal(first.inventory.bundled_fonts.find(font => font.id === "Cormorant Garamond").files[0].style, "italic");
    assert.equal(first.inventory.bundled_fonts.find(font => font.id === "Zhi Mang Xing").files.length, 1);
    assert.equal(first.inventory.bundled_fonts.find(font => font.id === "DM Sans").files.length, 3);
    assert.equal(first.publication.notices_sha256, first.notices_sha256);
    assert.equal(first.publication.components.reduce((n, c) => n + c.licenses.length, 0), first.inventory.summary.license_texts);
    for (const component of first.publication.components) for (const license of component.licenses) assert(firstText.includes(license.text));
    assert.equal(first.inventory.runtime_components.length, 3);
    assert.ok(first.inventory.npm_packages.some((entry) => entry.name === "markdown-it" && entry.version === "15.0.1"));
    assert.ok(first.inventory.npm_packages.some((entry) => entry.name === "katex" && entry.version === "0.18.5"));
    assert.ok(first.inventory.npm_packages.some((entry) => entry.name === "mermaid" && entry.version === "11.17.2" && entry.consumers.includes("mermaid_layout")));
    assert.ok(first.inventory.npm_packages.every((entry) => entry.license_files.length > 0));
    for (const name of ["react", "react-dom", "three", "chart.js"]) {
      assert.ok(first.inventory.npm_packages.some(entry => entry.name === name && entry.consumers.includes("interactive_work")));
    }
    for (const name of ["@babel/standalone", "recharts", "lucide-react"]) {
      assert.ok(first.inventory.npm_packages.some(entry => entry.name === name && entry.consumers.includes("interactive_react")));
    }
    assert.ok(first.inventory.npm_packages.some(entry => entry.name === "@tailwindcss/browser"));
    assert.ok(first.inventory.npm_packages.some(entry => entry.name === "maplibre-gl" && entry.version === "6.11.2" && entry.consumers.includes("map_frame") && entry.consumers.includes("map_worker")));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
