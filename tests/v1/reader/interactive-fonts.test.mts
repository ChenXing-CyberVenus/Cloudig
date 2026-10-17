import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { verifyWorkFontRequests, workFontCss } from "../../../src/ui/shared/conversation-renderer/interactive-fonts.mts";
import { loadInteractiveDependencies } from "../../../src/ui/shared/conversation-renderer/interactive-dependencies.mts";
import manifest from "../../../src/ui/runtime-dependencies/manifest.json" with { type: "json" };

const request = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,500;1,600&family=Noto+Serif+SC:wght@400;600;900&family=Zhi+Mang+Xing&display=swap';
test("saved work font declarations require exact style and weight coverage, including variable ranges", () => {
  verifyWorkFontRequests(request, manifest.fonts);
  verifyWorkFontRequests(request.replaceAll("&", "&amp;"), manifest.fonts);
  verifyWorkFontRequests('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@200..900', manifest.fonts);
  verifyWorkFontRequests('https://fonts.googleapis.com/css?family=DM+Sans:400,500,700', manifest.fonts);
  assert.throws(() => verifyWorkFontRequests(request.replace("1,500;1,600", "0,500"), manifest.fonts), /Cormorant Garamond normal 500/);
  assert.throws(() => verifyWorkFontRequests(request.replace("400;600;900", "1000"), manifest.fonts), /Noto Serif SC normal 1000/);
  assert.throws(() => verifyWorkFontRequests('https://fonts.googleapis.com/css2?family=Unbundled', manifest.fonts), /Unbundled/);
  const css = workFontCss(manifest.fonts);
  assert(css.includes('font-family:"Cormorant Garamond";font-style:italic;font-weight:300 700'));
  assert(css.includes('font-family:"Noto Serif SC";font-style:normal;font-weight:200 900'));
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
