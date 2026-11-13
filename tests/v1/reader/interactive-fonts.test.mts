import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { workFontCss } from "../../../src/ui/shared/conversation-renderer/interactive-fonts.mts";
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { JSDOM } from "jsdom";
import { clearInteractiveAssets } from "../../../src/ui/shared/conversation-renderer/interactive-assets.mts";
import { loadInteractiveDependencies } from "../../../src/ui/shared/conversation-renderer/interactive-dependencies.mts";
import manifest from "../../../src/ui/runtime-dependencies/manifest.json" with { type: "json" };

const request = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,500;1,600&family=Noto+Serif+SC:wght@400;600;900&family=Zhi+Mang+Xing&display=swap';
test("font CSS advertises real faces, leaving nearest weight matching to the browser", () => {
  const css = workFontCss(manifest.fonts);
  assert(css.includes('font-family:"Cormorant Garamond";font-style:italic;font-weight:300 700'));
  assert(css.includes('font-family:"Noto Serif SC";font-style:normal;font-weight:200 900'));
});

test("requested font ranges and optional missing families never prevent a saved work from opening offline", async () => {
  const previous = globalThis.fetch; const urls: string[] = []; clearInteractiveAssets();
  globalThis.fetch = async input => { urls.push(String(input)); return new Response("font"); };
  const dom = new JSDOM();
  try {
    const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@1..1000&amp;family=Unbundled"><style>@font-face{font-family:Unused;src:url(https://fonts.gstatic.com/missing.woff2)}body{font-family:"Google Sans Flex",sans-serif}</style><button>Ready</button>';
    const file = { path: "index.html", mime: "text/html", bytes: new TextEncoder().encode(html).buffer };
    const dependencies = await loadInteractiveDependencies([file], new AbortController().signal, "https://cloudig.local/runtime/dependencies/");
    assert.match(dependencies.fontCss, /font-weight:100 1000/); assert.doesNotMatch(dependencies.fontCss, /font-weight:1 1000/);
    assert(urls.every(url => url.startsWith("https://cloudig.local/")));
    const output = prepareInteractiveHtml({ protocol: "cloudig/interactive-runtime/1", token: "font-test", source: "generic.example_widget", format: "html", entry: file.path, files: [file, ...dependencies.files], fontCss: dependencies.fontCss, theme: "dawn", language: "en", state: {} }, dom.window.document, () => "blob:owned-font");
    const result = new JSDOM(output); assert.equal(result.window.document.querySelector("button")?.textContent, "Ready");
    assert.equal(result.window.document.querySelectorAll('link[href*="fonts.googleapis"]').length, 0);
    assert(![...result.window.document.querySelectorAll('style')].some(style => style.textContent?.includes('missing.woff2'))); result.window.close();
  } finally { globalThis.fetch = previous; clearInteractiveAssets(); dom.window.close(); }
});

test("SFNT variable font axes cover the advertised ranges and licenses remain original", async () => {
  for (const [file, min, max] of [["NotoSerifSC-Variable.ttf", 200, 900], ["CormorantGaramond-Italic-Variable.ttf", 300, 700]] as const) {
    const bytes = await readFile(`src/ui/runtime-dependencies/fonts/${file}`);
    let axisOffset = 0;
    for (let n = 0; n < bytes.readUInt16BE(4); n++) {
      const offset = 12 + 16 * n;
      if (bytes.toString("ascii", offset, offset + 4) === "fvar") axisOffset = bytes.readUInt32BE(offset + 8);
    }
    assert(axisOffset > 0, file);
    const first = axisOffset + bytes.readUInt16BE(axisOffset + 4);
    assert.equal(bytes.toString("ascii", first, first + 4), "wght");
    assert.equal(bytes.readInt32BE(first + 4) / 65536, min);
    assert.equal(bytes.readInt32BE(first + 12) / 65536, max);
  }
  for (const [file, sha] of [["CormorantGaramond-OFL.txt", "60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956"], ["ZhiMangXing-OFL.txt", "10947328199e369a3e6b4a67e8e5507ed99d5bbb264a1f156415aa9b665e4d15"]]) {
    assert.equal(createHash("sha256").update(await readFile(`src/ui/runtime-dependencies/fonts/${file}`)).digest("hex"), sha);
  }
});

test("the actual three-family declaration loads only local faces without synthesizing italic", async () => {
  const originalFetch = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input)); return new Response("font"); };
  try {
    const files = [{ path: "index.html", mime: "text/html", bytes: new TextEncoder().encode(`<link rel="stylesheet" href="${request}">`).buffer }];
    const result = await loadInteractiveDependencies(files, new AbortController().signal, "https://cloudig.local/runtime/dependencies/");
    assert.equal(requests.length, 3);
    assert(requests.every(url => url.startsWith("https://cloudig.local/runtime/dependencies/fonts/")));
    assert(result.fontCss.includes("font-style:italic"));
    assert(!requests.some(url => /NotoSerifSC-(400|700)/u.test(url)));
  } finally { globalThis.fetch = originalFetch; }
});
