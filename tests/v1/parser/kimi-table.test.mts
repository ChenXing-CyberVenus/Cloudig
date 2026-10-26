import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { inertHtmlFragment } from "../../../src/adapters/parser/inert-html.mts";
import { kimiLightAdapter, kimiFullAdapter, kimiTreeAdapter } from "../../../src/adapters/parser/kimi.mts";

const head = '<thead><tr><th align="left" data-osis-align="left">Left<div class="table-buttons"><button>Copy</button></div></th><th align="right" data-osis-align="right"><em>Right</em></th></tr></thead>';
const body = '<tbody><tr><td>A</td><td align="right" data-osis-align="right"><a href="https://example.com">Link</a></td></tr><tr><td colspan="2"><code>code</code><br>line</td></tr></tbody>';
const split = (h = head, b = body, extra = "") => `<div class="markdown-table" role="table" aria-label="Table"><div class="table-header"><table class="header-table" role="presentation">${h}</table>${extra}</div><div class="table-container"><table class="body-table has-col-widths" role="presentation"><colgroup><col><col></colgroup>${b}</table></div></div>`;

test("captured split table becomes one grid with original cells, formatting, spans, links and alignment", () => {
  const html = inertHtmlFragment(split())!;
  const dom = new JSDOM(html), table = dom.window.document.querySelector("table")!;
  assert.equal(dom.window.document.querySelectorAll("table").length, 1);
  assert.equal(table.rows.length, 3);
  assert.equal(table.tHead!.rows[0]!.cells[1]!.dataset["osisAlign"], "right");
  assert.equal(table.tBodies[0]!.rows[1]!.cells[0]!.colSpan, 2);
  assert.equal(table.querySelector("a")!.getAttribute("href"), "https://example.com");
  assert.equal(table.querySelector("em")!.textContent, "Right");
  assert.equal(table.getAttribute("aria-label"), "Table");
  assert.equal(table.hasAttribute("role"), false);
  assert(!html.includes("table-buttons"));
  assert.equal(inertHtmlFragment(html), html);
  dom.window.close();
});

test("ordinary/new tables, incomplete or ambiguous split tables and author notes remain intact", () => {
  const cases = [
    `<table>${head.replace(/<div class="table-buttons">.*?<\/div>/u, "")}${body}</table>`,
    split(head, '<tbody><tr><td>One column</td></tr></tbody>'),
    split(head, body, '<p>Author note</p>'),
    split(head, body, 'Author note'),
    split(head + '<tbody><tr><td>Unexpected</td></tr></tbody>'),
    split('<caption>Keep me</caption>' + head),
    split().replace('<div class="table-container">', `<div class="table-container"><table class="body-table">${body}</table>`),
    split().replace('class="markdown-table"', 'class="other-table"')
  ];
  for (const source of cases) {
    const html = inertHtmlFragment(source)!;
    assert.equal((html.match(/<table\b/gu) ?? []).length, (source.match(/<table\b/gu) ?? []).length);
    if(source.includes("Author note")) assert(html.includes("Author note"));
  }
});

test("nested tables do not enter the outer column count; multirow headers retain rowspan", () => {
  const h='<thead><tr><th rowspan="2">A</th><th>B</th></tr><tr><th>C</th></tr></thead>';
  const b='<tbody><tr><td><table><tr><td>1</td><td>2</td><td>3</td></tr></table></td><td>D</td></tr></tbody>';
  const dom=new JSDOM(inertHtmlFragment(split(h,b))!);
  assert.equal(dom.window.document.querySelectorAll("table").length,2);
  assert.equal(dom.window.document.querySelector("th")!.rowSpan,2);
  dom.window.close();
});

test("all three Kimi adapters preserve surrounding prose while normalizing legacy tables", async () => {
  for(const adapter of [kimiLightAdapter,kimiFullAdapter,kimiTreeAdapter]) {
    const draft=await adapter.parse({manifest:{},source:{file:"table.html",bytes:1,sha256:"a".repeat(64)},payload:{messages:[{id:"m",role:"assistant"}],message_order:["m"]},reading:{fragments:[{messageId:"m",html:`<div class="rich-content"><p>Before</p>${split()}<p>After</p></div>`}],images:[],files:[],mermaid:[]}});
    const text=JSON.stringify(draft);
    assert.equal((text.match(/<table\b/gu)??[]).length,1,adapter.manifest.id);
    assert(text.includes("Before")); assert(text.includes("After"));
  }
});
