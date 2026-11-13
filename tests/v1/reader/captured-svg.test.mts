import test from "node:test";import assert from "node:assert/strict";import { JSDOM } from "jsdom";
import { hydrateCapturedSvg, updateCapturedSvgTheme } from "../../../src/ui/shared/conversation-renderer/captured-svg.mts";
import { capturedDependencyAliases } from "../../../src/ui/shared/conversation-renderer/dependency-aliases.mts";

test("registered CDN entries accept minified spelling without crossing versions or module builds", () => {
 const known=['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js'];
 const same=known[0]!.replace('.umd.js','.umd.min.js'), wrong=same.replace('4.4.1','5.0.0'), module=same+'?module';
 assert.deepEqual(capturedDependencyAliases(`<script src="${same}"></script><script src="${wrong}"></script><script src="${module}"></script>`,known),[...known,same]);
});
test("captured SVG paints stay isolated and complete across themes, IDs, variables, markers and tiny icons", () => {
 for(const theme of ['dawn','star-night']){
  const dom=new JSDOM(`<html data-theme="${theme}"><body><main><svg width="100%" viewBox="0 0 600 200"><style>:root{--paint:light-dark(#eef,#224)}.node{fill:var(--paint);stroke:#08a}.edge{marker-end:url(#tip)}</style><defs><marker id="tip"><path d="M0 0L5 5"/></marker></defs><rect class="node" width="100" height="80"/><path class="edge" d="M0 0L90 90"/><script>bad()</script></svg><svg width="16" height="16"><path fill="red" d="M0 0L16 16"/></svg></main></body></html>`);
  const root=dom.window.document.querySelector('main')!;hydrateCapturedSvg(root);const images=root.querySelectorAll('img');assert.equal(images.length,2);
  const xml=decodeURIComponent(images[0]!.src.split(',')[1]!);assert.match(xml,/fill:var\(--paint\)/);assert.match(xml,/marker-end:url\(#tip\)/);assert.match(xml,new RegExp(`color-scheme: ${theme==='dawn'?'light':'dark'}`));assert(!xml.includes('<script'));assert.equal(images[0]!.getAttribute('width'),'600');assert.equal(images[1]!.getAttribute('width'),'16');assert(!root.querySelector('style'));
  updateCapturedSvgTheme(root as unknown as HTMLElement,theme==='dawn'?'star-night':'dawn');assert.equal(root.querySelector('img'),images[0]);assert.match(decodeURIComponent(images[0]!.src),new RegExp(`color-scheme: ${theme==='dawn'?'dark':'light'}`));assert.equal(images[0]!.getAttribute('width'),'600');dom.window.close();
 }
});
