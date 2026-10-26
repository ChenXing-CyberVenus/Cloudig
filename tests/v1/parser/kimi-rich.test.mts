import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { parseFragment } from "parse5";
import { KimiRichContent } from "../../../src/adapters/parser/kimi-rich.mts";
import { WorkResources } from "../../../src/adapters/parser/work-resources.mts";
import { kimiWebsiteSnapshot } from "../../../src/adapters/parser/kimi-website.mts";
import { kimiFullAdapter, kimiTreeAdapter } from "../../../src/adapters/parser/kimi.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const node = (html: string) => { const n = parseFragment(html).childNodes[0]!; assert("tagName" in n); return n; };

test("a user plugin icon is inline by its native wrapper while identical ordinary image bytes stay an image", async () => {
  const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const draft=await kimiFullAdapter.parse({manifest:{},source:{file:"icons.html",bytes:1,sha256:"f".repeat(64)},payload:{messages:[{id:"u",role:"user"}],message_order:["u"]},reading:{fragments:[{messageId:"u",html:`<div class="user-content"><span class="plugin-node"><span class="plugin-node-icon"><img src="${png}"></span>Native plugin</span><p>Question</p><img src="${png}"></div>`}],images:[],files:[],mermaid:[]}});
  const blocks=(draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.equal(blocks.filter(b=>b["type"]==="image").length,1);
  const html=blocks.filter(b=>b["type"]==="html").map(b=>b["html"]).join("");assert.match(html,/plugin-node/);assert.match(html,/width="20"/);assert.match(html,/Native plugin/);
});

test("mixed Kimi prose/process/work order is preserved in Full and public DOM, including repeated authored prose", async () => {
  for (const native of [false, true]) {
    const rich = fixture(); rich["works"] = [{ key:"w", kind:"widget", message_id:"m", block_id:"3", source:"<p>Work</p>" }];
    const html = '<div class="rich-content"><div class="markdown-container"><p>Repeated answer</p></div><div class="toolcall-flow__item"><details class="osis-thinking"><summary>思考</summary><p>Reasoning</p></details></div><div class="plugin-toolcall"><div class="plugin-toolcall-entry"><div aria-controls="plugin-toolcall-detail-3">Make work</div></div><section data-kimi-work="w"></section></div><div class="markdown-container"><p>Repeated answer</p></div></div>';
    const draft = await kimiFullAdapter.parse({manifest:{},source:{file:"ordered.html",bytes:1,sha256:"e".repeat(64)},payload:{messages:[{id:"m",role:"assistant",...(native?{api:{blocks:[{id:"1",type:"text",value:{content:"Repeated answer"}},{id:"2",type:"think",value:{content:"Reasoning"}},{id:"3",type:"tool",value:{name:"create_work"}},{id:"4",type:"text",value:{content:"Repeated answer"}}]}}:{})}],message_order:["m"]},extensions:{kimiRichContent:rich},reading:{fragments:[{messageId:"m",html}],images:[],files:[],mermaid:[]}});
    const content=(draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
    assert.deepEqual(content.map(b=>b["type"]),["html","reasoning","tool","box","html"]);
    for (const index of [0,4]) assert.match(String(content[index]!["html"]),/<p>Repeated answer<\/p>/u,"different native slots with the same text must both remain");
  }
});

test("website version selection requires consistent file evidence, handles append and ignores clipped reads", () => {
  const evidence = (name:string,args:JsonObject,output?:string) => ({native:{name,args:JSON.stringify(args),contents:output?[{content:{case:"text",value:output}}]:[]}});
  const raw:JsonObject={project_dir:"/output/project",version_evidence:[evidence("write_file",{file_path:"/output/project/src/App.tsx",content:"version 1"}),evidence("write_file",{file_path:"/output/project/src/style.css",content:"a{}"}),evidence("read_file",{file_path:"/output/project/src/style.css"},"1\ta{<response clipped>"),evidence("write_file",{file_path:"/output/project/src/style.css",content:"b{}",append:true})]};
  const archive={"old/index.html":strToU8("old"),"old/src/App.tsx":strToU8("version 1"),"old/src/style.css":strToU8("a{}b{}"),"old/.env":strToU8("secret"),"latest/index.html":strToU8("new"),"latest/src/App.tsx":strToU8("version 2"),"latest/src/style.css":strToU8("a{}b{}")};
  const result=kimiWebsiteSnapshot(raw,archive)!;assert(result);assert.equal(new TextDecoder().decode(result["src/App.tsx"]),"version 1");assert(!result[".env"]);
  assert.equal(kimiWebsiteSnapshot(raw,{...archive,"old/src/App.tsx":strToU8("unproven edit")}),undefined);
});
function fixture(): JsonObject {
  const file = strToU8("first\nsecond\n"), zip = zipSync({ "dir/notes.md": file, "empty.txt": new Uint8Array() });
  return { resources: [{ id: "f", path: "dir/notes.md", name: "notes.md", mime_type: "text/markdown", status: "embedded", provenance: "native_output_tree", package_id: "output", package_entry: "dir/notes.md", sha256: sha(file), saved_bytes: file.length }],
    packages: [{ id: "output", bytes: zip.length, sha256: sha(zip), data_url: `data:application/zip;base64,${Buffer.from(zip).toString("base64")}` }],
    works: [{ key: "w", kind: "widget", message_id: "m", source: '<div><svg viewBox="0 0 10 10"></svg><input type="range"></div>', title: "Native widget", resource_ids: [] },
      { key: "f", kind: "file", message_id: "m", resource_ids: ["f"], title: "notes.md" }] };
}
test("Kimi exact markers preserve surrounding prose; mirrors reuse one work and resource; records stay in the current Schema", async () => {
  const rich = fixture(), html = '<div class="rich-content"><p>Before</p><section data-kimi-work="w">old source UI</section><p>Between</p><section data-kimi-work="f">old file UI</section><section data-kimi-work="w">mirror</section><p>After</p><details class="osis-kimi-file-catalog"></details></div>';
  const draft = await kimiFullAdapter.parse({ source: { file: "source.html", bytes: 1, sha256: "a".repeat(64) }, manifest: {}, payload: { messages: [{ id: "m", role: "assistant" }], message_order: ["m"] },
    extensions: { kimiRichContent: rich }, reading: { fragments: [{ messageId: "m", html }], images: [], files: [], mermaid: [] } });
  const record = assembleConversationRecord({ parsed: { draft, adapter: kimiFullAdapter.manifest, sourceFingerprint: { bytes: 1, sha256: "a".repeat(64) }, systemLogErrors: [] }, facts: {}, parserVersion: "1.1.46", timestamp: "2026-10-24T00:00:00Z" });
  const content = ((record["messages"] as JsonObject)["items"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.deepEqual(content.map(b => b["type"]), ["html", "box", "html", "attachment", "html", "box"]);
  assert(!JSON.stringify(content).includes("old source UI")); assert(!JSON.stringify(content).includes("mirror"));
  assert.equal((record["resources"] as JsonObject[]).length, 2);
  assert.equal(content[3]!["resource"], ((content.at(-1)!["files"] as JsonObject[])[0]!["resource"]));
});
test("Kimi ownership, unsafe paths and changed package bytes fail explicitly, never a successful text-only archive", () => {
  const rich = new KimiRichContent(fixture(), new WorkResources([]));
  assert.throws(() => rich.node(node('<section data-kimi-work="w"></section>'), "other"), /different source message/);
  assert.throws(() => rich.validateOwners(new Set()), /missing message/);
  const bad = fixture(); (bad["packages"] as JsonObject[])[0]!["sha256"] = "0".repeat(64);
  assert.throws(() => new KimiRichContent(bad, new WorkResources([])).remaining("m"), /SHA-256 mismatch/);
  const traversal = fixture(); (traversal["resources"] as JsonObject[])[0]!["path"] = "../notes.md";
  assert.throws(() => new KimiRichContent(traversal, new WorkResources([])).remaining("m"), /Unsafe/);
});
test("Kimi same-title website versions retain different bytes; cloud evidence is never run as the latest site", () => {
  const packages: JsonObject[] = ["first", "second"].map((s, i) => { const b = zipSync({ "index.html": strToU8(`<h1>${s}</h1>`) }); return { id: String(i), data_url: `data:application/zip;base64,${Buffer.from(b).toString("base64")}`, sha256: sha(b) }; });
  const resources: JsonObject[] = [], works = [0, 1].map(i => ({ key: String(i), kind: "website", message_id: "m", title: "Same", version_id: `v${i}`, revision_number: i + 1, package_id: String(i) }));
  const rich = new KimiRichContent({ packages, works: [...works, { key: "cloud", kind: "website", message_id: "m", source_status: "version_tool_evidence", version_evidence: [{ code: "server" }] }] }, new WorkResources(resources));
  const [a, b, c] = rich.remaining("m"); assert.notDeepEqual(a!["files"], b!["files"]); assert.equal(c!["format"], "structured"); assert.equal(c!["source"], "kimi.com_website_evidence"); assert.deepEqual(rich.remaining("m"), []);
});
test("Kimi Light metadata stays metadata and native Widgets remain Box regardless of implementation technology", () => {
  const data = fixture(); data["resources"] = [{ id: "f", path: "notes.md", status: "metadata_only", mime_type: "text/markdown" }];
  (data["works"] as JsonObject[])[0]!["source"] = '<canvas></canvas><script>requestAnimationFrame(draw)</script>';
  const values: JsonObject[] = [], blocks = new KimiRichContent(data, new WorkResources(values)).remaining("m");
  assert.equal(blocks[0]!["type"], "box"); assert.equal(values.find(v => v["name"] === "notes.md")!["availability"], "metadata_only");
});
test("Kimi sibling branches keep identical widget source as distinct owned occurrences and preserve the selected leaf", async () => {
  const source = "<p>Same work code</p>", payload = { messages: [{ id: "u", role: "user" }, { id: "a", role: "assistant", parent_id: "u" }, { id: "b", role: "assistant", parent_id: "u" }], message_order: ["u", "a", "b"], active_path_message_ids: ["u", "b"], tree: { roots: ["u"], nodes: [{ id: "u", role: "user", children_ids: ["a", "b"] }, { id: "a", role: "assistant", parent_id: "u", children_ids: [] }, { id: "b", role: "assistant", parent_id: "u", children_ids: [] }] } };
  const draft = await kimiTreeAdapter.parse({ manifest: {}, payload, source: { file: "tree.html", bytes: 1, sha256: "b".repeat(64) }, extensions: { kimiRichContent: { works: ["a", "b"].map(id => ({ key: id, kind: "widget", title: "Same title", message_id: id, source })) } }, reading: { fragments: [{ messageId: "u", html: "<p>Question</p>" }, { messageId: "b", html: '<div class="rich-content"><section data-kimi-work="b"></section></div>' }], images: [], files: [], mermaid: [] } });
  const messages = draft["messages"] as JsonObject[];
  assert.equal(draft["current_message"], messages[2]!["id"]);
  assert.equal(messages[1]!["parent"], messages[2]!["parent"]);
  for (const m of messages.slice(1)) assert.equal((m["content"] as JsonObject[]).filter(b => b["source"] === "kimi.com_widget").length, 1);
  assert.equal((draft["resources"] as JsonObject[]).length, 1, "same bytes may be shared; branch occurrences must not be merged");
});

test("Kimi tool reading mirrors stay in process for API and public-only exports, without removing equal prose or repeated calls", async () => {
  for (const api of [undefined, { blocks: [1, 2].map(i => ({ type: "tool", value: { name: "read_file", args: { path: `note${i}.md` } } })) }]) {
    const draft = await kimiFullAdapter.parse({ manifest: {}, source: { file: "tools.html", bytes: 1, sha256: "c".repeat(64) },
      payload: { messages: [{ id: "m", role: "assistant", ...(api ? { api } : {}), public_processes: [1, 2].map(i => ({ kind: "tool", title: "阅读文件", content: `result ${i}` })) }], message_order: ["m"] },
      reading: { fragments: [{ messageId: "m", html: '<div class="rich-content"><div class="osis-tool">工具 · 阅读文件</div><div class="osis-tool">工具 · 阅读文件</div><p>工具 · 阅读文件</p><p>Answer</p></div>' }], images: [], files: [], mermaid: [] } });
    const blocks = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
    assert.equal(blocks.filter(b => b["type"] === "tool").length, 2);
    assert.equal(blocks.filter(b => b["type"] === "unknown").length, 0);
    const body = blocks.filter(b => b["type"] === "html").map(b => String(b["html"])).join("");
    assert.equal(body.split("工具 · 阅读文件").length - 1, 1, "only the authored paragraph remains");
    assert(body.includes("Answer"));
  }
});

test("Kimi plugin-call icons are process decoration: native block IDs pair Full mirrors and Light keeps the captured summary", async () => {
  for (const api of [undefined, { blocks: [{ id: "45", type: "tool", value: { name: "shell", args: { description: "Check document" } } }] }]) {
    const draft = await kimiFullAdapter.parse({ manifest: {}, source: { file: "plugins.html", bytes: 1, sha256: "d".repeat(64) },
      payload: { messages: [{ id: "m", role: "assistant", ...(api ? { api } : {}) }], message_order: ["m"] },
      reading: { fragments: [{ messageId: "m", html: '<div class="rich-content"><div class="plugin-toolcall"><div class="plugin-toolcall-entry"><div aria-controls="plugin-toolcall-detail-45"><img class="toolcall-title-name-icon" src="data:image/png;base64,invalid">使用 PDF 检查环境</div></div></div><p>Actual answer</p></div>' }], images: [], files: [], mermaid: [] } });
    const blocks = (draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
    assert.equal(blocks.filter(b => b["type"] === "tool").length, 1);
    assert.equal((draft["resources"] as JsonObject[] | undefined)?.length ?? 0, 0, "a tool icon is not a conversation image");
    assert(!blocks.filter(b => b["type"] === "html").some(b => String(b["html"]).includes("使用 PDF")));
    if (!api) assert.equal(blocks[0]!["title"], "使用 PDF 检查环境");
  }
});
