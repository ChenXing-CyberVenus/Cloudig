import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readExporterEnvelope } from "../../../src/adapters/parser/html-envelope.mts";
import { geminiLightAdapter } from "../../../src/adapters/parser/gemini.mts";
import { doubaoFullAdapter } from "../../../src/adapters/parser/doubao.mts";
import { WorkResources } from "../../../src/adapters/parser/work-resources.mts";
import { MistralWork } from "../../../src/adapters/parser/mistral-work.mts";
import { GeminiRichContent } from "../../../src/adapters/parser/gemini-rich.mts";
import { DoubaoRichContent } from "../../../src/adapters/parser/doubao-rich.mts";
import { parseFragment } from "parse5";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import type { SourceMessageFacts } from "../../../src/app/parser/adapter.mts";
import type { JsonObject, JsonValue } from "../../../src/core/contracts/types.mts";

test("music companions are bound by the native component; timed lyrics preserve real timing and unrelated media remain separate", () => {
 const resources:JsonObject[]=[],pool=new WorkResources(resources);
 const rich=new GeminiRichContent({artifacts:[],media:[{key:"song",message_id:"m",name:"song.mp3",mime:"audio/mpeg",url:"https://example.test/song"},{key:"caption",message_id:"m",name:"captions.vtt",mime:"text/vtt",resource:"words"},{key:"other",message_id:"m",name:"other.mp4",mime:"video/mp4",url:"https://example.test/other"}],resources:[{key:"words",name:"captions.vtt",mime:"text/vtt",text:"WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n"}]},pool,()=>{});
 const node=parseFragment('<section class="gemini-music"><h4>Song title</h4><p>Original style</p><a href="https://example.test/song">Audio</a><a data-gemini-resource="words">Captions</a></section>').childNodes[0]!;
 assert('tagName' in node);const result=rich.node(node,"m")!,box=result.find(b=>b["type"]==="box")!;
 assert.equal(box["title"],"Song title");assert((box["files"] as JsonObject[]).some(f=>f["path"]==="captions.vtt"));
 assert.equal(rich.remaining("m").filter(b=>b["type"]==="box").length,1,"an unrelated video is not consumed with the song");
 const raw={messages:[{message_id:"d",native:{content_block:[{block_id:"b",content:{lyrics_to_songs_music_block:{lyrics_to_songs_music_content:{0:{lyric:"First\nSecond",captions_result:JSON.stringify({utterances:[{text:"First",start_time:1200,end_time:3400},{text:"Second",start_time:5100,end_time:6200}]})}}}}}]}}],resources:[{key:"audio",message_id:"d",block_id:"b:0",kind:"audio",name:"song.m4a",mime_type:"audio/mp4",url:"https://example.test/song",status:"metadata_only"}]};
 const doubao=new DoubaoRichContent(raw,pool),figure=parseFragment('<figure data-doubao-resource="audio"><audio></audio></figure>').childNodes[0]!;assert('tagName' in figure);
 const song=doubao.node(figure,"d")![0]!,captions=(song["files"] as JsonObject[]).find(f=>f["path"]==="captions.vtt")!;
 const stored=resources.find(r=>r["id"]===captions["resource"])!;assert.match(Buffer.from((stored["data_base64"] as string[]).join(""),"base64").toString(),/00:00:01.200 --> 00:00:03.400/u);
 const elapsed=parseFragment('<div class="osis-doubao-elapsed" data-elapsed-seconds="294">共用时 4 分 54 秒</div>').childNodes[0]!;assert('tagName' in elapsed);assert.deepEqual(doubao.node(elapsed,"d"),[{type:"status",title:"共用时 4 分 54 秒",duration:294}]);
});

test("Gemini Slides chooses the captured native pagination wrapper, not a stacked source document",()=>{
 const raw='<html><body><div class="slide-container">One</div><div class="slide-container">Two</div></body></html>';
 const reader='<html><body><main id="slideshow-wrapper">One and Two</main><button id="prev-slide">Previous</button><button id="next-slide">Next</button><span id="slide-counter"></span></body></html>';
 for(const variants of [[raw,reader],[reader,raw],[raw]]){
  const resources:JsonObject[]=[],rich=new GeminiRichContent({artifacts:[{key:"s",id:"s",message_id:"m",kind:"slides",slides:variants}]},new WorkResources(resources),()=>{}),block=rich.remaining("m")[0]!;
  assert.equal(block["entry"],variants[1]===reader?"variants/1.html":"slides.html");assert.equal((block["files"] as JsonObject[]).length,variants.length);
  for(const source of variants)assert(resources.some(r=>Buffer.from((r["data_base64"] as string[]).join(""),"base64").toString()===source));
 }
});

test("Gemini research retains report, original visual source, preview and research provenance in one owned package",()=>{
  const source="# Report\n\nhttp://googleusercontent.com/visual_element_0\n",visual="<!doctype html><html><body>Native visual</body></html>\n",resources:JsonObject[]=[];
  const payload:JsonObject={artifacts:[{key:"report",id:"native-report",message_id:"m",kind:"research",filename:"report.md",source,
    visuals:[{placeholder:"http://googleusercontent.com/visual_element_0",title:"Native visual",source:visual,previews:["p","p"]}],sources:[{index:1,title:"Source",url:"https://example.test"}],research_process:[{action:[1,"Reading",null,[]]}]}],resources:[{key:"p",name:"preview.svg",mime:"image/svg+xml",text:'<svg xmlns="http://www.w3.org/2000/svg"/>'}]};
  const rich=new GeminiRichContent(payload,new WorkResources(resources),()=>{}),block=rich.remaining("m")[0]!,data=(block["data"] as JsonObject)["research"] as JsonObject;
  assert.equal(block["type"],"window");assert.equal(data["entry"],"report.md");assert.equal((block["files"] as JsonObject[]).length,3);
  assert.equal((data["visuals"] as JsonObject[])[0]!["placeholder"],"http://googleusercontent.com/visual_element_0");assert.equal((data["process"] as JsonObject[]).length,1);
  for(const raw of [source,visual])assert(resources.some(r=>Buffer.from(Array.isArray(r["data_base64"])?(r["data_base64"] as string[]).join(""):String(r["data_base64"]??""),"base64").toString()===raw));
  assert.deepEqual(rich.remaining("m"),[]);
});

test("Doubao subtask text and resources stay inside the task with a distinct source Front",async()=>{
  const rich:JsonObject={messages:[{message_id:"parent",native:{content_block:[{content:{complex_task_block:{thread_id:"t",title:"Original task"}}}]}}],
    subthreads:[{thread_id:"t",complete:true,messages:[{message_id:"child",sender_id:"agent",user_type:2,content_block:[{block_id:"child-block"}]}]}],
    resources:[{key:"image",message_id:"child",kind:"image",status:"embedded",resource_locator:{value_attribute:"src"}}]};
  const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const html=`<div class="rich-content"><p>Main before</p><details class="osis-doubao-subtask"><summary>Original task</summary><div data-doubao-thread-id="t"><section data-doubao-block-id="child-block"><p>Child only</p><figure data-doubao-resource="image"><img src="${svg}"></figure></section></div></details><p>Main after</p></div>`;
  const facts:SourceMessageFacts[]=[],speakers=new Map<JsonObject,SourceMessageFacts>();
  const parse=(extension:JsonObject)=>doubaoFullAdapter.parse({manifest:{},payload:{messages:[{id:"parent",role:"assistant",attachments:[]}],message_order:["parent"]},source:{file:"subtask.html",bytes:1,sha256:"d".repeat(64)},extensions:{doubaoRichContent:extension},reading:{fragments:[{messageId:"parent",html}],images:[],files:[],mermaid:[]},record:{message(i,f){facts[i]=f;},current(){},conversationModel(){},block(b,f){speakers.set(b,f);}}});
  const draft=await parse(rich),record=assembleConversationRecord({parsed:{draft,adapter:doubaoFullAdapter.manifest,sourceFingerprint:{bytes:1,sha256:"d".repeat(64)},systemLogErrors:[]},facts:{messages:facts,blockSpeakers:speakers},parserVersion:"1.1.39",timestamp:"2026-10-21T00:00:00Z"});
  const messages=(record["messages"] as JsonObject)["items"] as JsonObject[],content=messages[0]!["content"] as JsonObject[];
  assert.equal(messages.length,1);assert.deepEqual(content.map(b=>b["type"]),["html","status","html"]);assert(!JSON.stringify([content[0],content[2]]).includes("Child only"));
  const child=(content[1]!["content"] as JsonObject[]).find(b=>b["type"]==="image")!;assert.equal(child["speaker"],"agent-thread:t:agent");assert((record["identity"] as JsonObject[]).some(f=>f["source_id"]===child["speaker"]&&f["role"]==="assistant"));
  const wrong=structuredClone(rich);((wrong["messages"] as JsonObject[])[0]!)["message_id"]="someone-else";await assert.rejects(async()=>parse(wrong),/does not belong/);
});

test("optional rich carriers preserve legacy routes, validate declarations, and never silently ignore a broken known payload", async t => {
  const parent = path.resolve("tmp"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "cloudig-rich-carrier-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [platform, id, schema, key, payloadId, payloadSchema] of [
    ["kimi", "kimi-rich-content", "osis.kimi.rich-content/v1", "kimiRichContent", "kimi-export-data", "osis.kimi.chat-export/full-dom-v1"],
    ["gemini", "gemini-rich-content-data", "osis.gemini.rich-content/v1", "geminiRichContent", "gemini-archive-data", "osis.gemini.chat-export/light-dom-v2"],
    ["doubao", "doubao-rich-content", "osis.doubao.rich-content/v1", "doubaoRichContent", "doubao-export-data", "osis.doubao.chat-export/light-dom-v2"],
    ["mistral", "mistral-work-data", "osis.mistral.work/v1", "mistralWork", "mistral-export-data", "osis.mistral.chat-export/light-dom-rsc-v2"]
  ]) {
    const declared = { script_id: id!, schema: schema! };
    const payload: JsonObject = { script_id: payloadId!, schema: payloadSchema! };
    if (platform === "gemini") payload["rich_content"] = declared;
    const manifest = { format: "ai-chat-archive/manifest-v1", platform: platform!, payload, ...(platform === "mistral" ? { work: declared } : {}) };
    const script = (id: string, value: unknown) => `<script type="application/json" id="${id}">${JSON.stringify(value)}</script>`;
    const core = script("ai-chat-archive-manifest", manifest) + script(payloadId!, { format: payloadSchema!, platform: platform!, messages: [], items: [] });
    const file = path.join(root, `${platform}.html`);
    await writeFile(file, core + script(id!, { schema: schema!, artifacts: [], works: [], canvases: [] }));
    const envelope = await readExporterEnvelope({ filePath: file });
    assert.equal((envelope.extensions as Record<string, JsonObject>)[key!]!["schema"], schema);
    await writeFile(file, core + script(id!, { schema: "future-unknown" }));
    await assert.rejects(readExporterEnvelope({ filePath: file }), /format mismatch/);
    if (platform === "gemini" || platform === "mistral") { await writeFile(file, core); await assert.rejects(readExporterEnvelope({ filePath: file }), /JSON script is missing/); }
    delete payload["rich_content"];
    await writeFile(file, script("ai-chat-archive-manifest", { format: manifest.format, platform, payload }) + script(payloadId!, { format: payloadSchema, platform }));
    assert.deepEqual((await readExporterEnvelope({ filePath: file })).extensions, {});
  }
});

test("Gemini works retain source bytes, revisions, media ownership, in-place order and per-message model", async () => {
  const program = "```html\n<!doctype html><html><body>Works</body></html>\n```\n";
  const original = "# Original\n", revised = "# Revised\n";
  const payload: JsonObject = { messages: [{ source_id: "u", role: "user", html: "<p>Question</p>" },
    { source_id: "r", role: "assistant", model: "Argon", html: '<p>Before</p><section data-gemini-artifact="w">old preview</section><p>Between</p><section data-gemini-artifact="d">old document</section><section data-gemini-media="m">old player</section><p>After</p><div class="gemini-response-model">Argon</div>' }] };
  const rich: JsonObject = { artifacts: [
    { key: "w", id: "native-w", message_id: "r", kind: "visualize", title: "Chart", filename: "chart.html", source: program },
    { key: "d", id: "native-d", message_id: "r", kind: "document", filename: "doc.md", source: revised,
      history: [{ key: "previous", id: "native-d", message_id: "r", source: original, filename: "doc.md", updated_at: [100, 20] }] }
  ], media: [{ key: "m", message_id: "r", mime: "audio/mpeg", name: "music.mp3", resource: "bytes" }], resources: [{ key: "bytes", name: "music.mp3", mime: "audio/mpeg", data_url: "data:audio/mpeg;base64,YXVkaW8=" }] };
  const messages: SourceMessageFacts[] = [];
  const parse = async (extensions: JsonObject) => geminiLightAdapter.parse({ manifest: {}, payload, source: { file: "native.html", bytes: 1, sha256: "a".repeat(64) }, extensions: { geminiRichContent: extensions },
    record: { message(i, f) { messages[i] = f; }, current() {}, conversationModel() {}, block() {} } });
  const draft = await parse(rich);
  const record = assembleConversationRecord({ parsed: { draft, adapter: geminiLightAdapter.manifest, sourceFingerprint: { bytes: 1, sha256: "a".repeat(64) }, systemLogErrors: [] },
    facts: { messages }, parserVersion: "1.1.39", timestamp: "2026-10-21T00:00:00.000Z" });
  const content = ((record["messages"] as JsonObject)["items"] as JsonObject[])[1]!["content"] as JsonObject[];
  assert.deepEqual(content.map(b => b["type"]), ["html", "box", "html", "window", "box", "attachment", "html"]);
  assert(!JSON.stringify(content).includes("old preview")); assert(!JSON.stringify(content).includes("gemini-response-model"));
  const resources = record["resources"] as JsonObject[];
  for (const source of [program, original, revised]) assert(resources.some(r => Buffer.from((r["data_base64"] as string[] ?? []).join(""), "base64").toString() === source));
  assert.equal((resources.find(r => r["name"] === "music.mp3")?.["bytes"]), 5);
  assert.deepEqual(record["models"], ["Argon"]);
  assert.equal((content[3]!["data"] as JsonObject)["revisions"] instanceof Array, true);
  const corrupt = structuredClone(rich); (corrupt["artifacts"] as JsonObject[])[0]!["message_id"] = "u";
  await assert.rejects(parse(corrupt), /different source message/);
});

test("Gemini native response time follows response identity, never user position or export time", async () => {
  const source = { file: "times.html", bytes: 1, sha256: "a".repeat(64) };
  const payload: JsonObject = { messages: [{ source_id: "user-0", role: "user", text: "question" }, { source_id: "r_second", role: "assistant", text: "second" }, { source_id: "r_first", role: "assistant", text: "first" }] };
  const turn = (id: string, sec: number): JsonValue => [["c_test", id], null, [], [], [sec, 572813000]];
  const parse = (turns: JsonValue[]) => geminiLightAdapter.parse({ source, manifest: { exported_at: "2026-10-22T00:00:00Z" }, payload, extensions: { geminiRichContent: { native_turns: turns } } });
  const draft = await parse([turn("r_first", 1792384080), turn("r_second", 1792384081)]), rows=draft["messages"] as JsonObject[];
  assert.equal(rows[0]!["timestamp"], undefined);
  assert.equal(rows[1]!["timestamp"], new Date(1792384081572).toISOString());
  assert.equal(rows[2]!["timestamp"], new Date(1792384080572).toISOString());
  assert.equal(((await parse([]))["messages"] as JsonObject[])[1]!["timestamp"], undefined, "old HTML must not invent source time");
  assert.equal(((await parse([turn("r_first", 1792384080), turn("r_first", 1792384090)]))["messages"] as JsonObject[])[2]!["timestamp"], undefined, "conflicting source identity is not resolved by choosing one time");
});

test("work resources reject corrupt bytes, preserve URL aliases and coexist with ordinary resource IDs", () => {
  const values: JsonObject[] = [{ id: "r1" }], pool = new WorkResources(values);
  const r = pool.add({ name: "s.txt", text: "line\n", mime: "text/plain", source_url: "https://example.test/source" });
  assert.equal(r, "r2"); assert.deepEqual(values[1]!["original"], { url: "https://example.test/source" });
  assert.equal(pool.add({ name: "s.txt", text: "line\n", mime: "text/plain", source_url: "https://example.test/source" }), r);
  assert.throws(() => pool.add({ data_url: "data:text/plain;base64,YQ==", sha256: "a".repeat(64) }), /SHA-256/);
  assert.throws(() => pool.add({ data_url: "data:text/plain;base64,YQ==", size: 2 }), /byte size/);
});
test("Mistral Canvas files are scoped to message and revision, not title or filename", () => {
  const source = "# Same title\n", bytes = `data:text/plain;base64,${Buffer.from(source).toString("base64")}`;
  const pool = new WorkResources([]), payload: JsonObject = { canvases: [0, 1].map(version => ({ key: `canvas::${version}`, message_id: "m", message_version: version, type: "text/markdown", title: "Same title", source, resource_ids: [`f${version}`] })),
    resources: [0, 1].map(version => ({ id: `f${version}`, asset_key: `canvas::${version}`, name: "same.md", data_url: bytes, provenance: "native-canvas-source", status: "embedded" })) };
  const work = new MistralWork(payload, pool);
  assert.equal(work.project("canvas::0", "m::0")?.[0]?.["type"], "window");
  assert.throws(() => work.project("canvas::1", "m::0"), /different message\/version/);
  assert.equal(work.project("canvas::1", "m::1")?.[0]?.["entry"], "same.md");
  assert.deepEqual(work.remaining("m::0"), []);
  const corrupt = structuredClone(payload); (corrupt["resources"] as JsonObject[])[0]!["data_url"] = "data:text/plain;base64,eA==";
  assert.throws(() => new MistralWork(corrupt, new WorkResources([])).project("canvas::0", "m::0"), /source and download bytes disagree/);
});

test("Doubao thinking beside the answer container is retained, not replaced by elapsed status", async () => {
 const payload:JsonObject={message_order:["m"],messages:[{id:"m",role:"assistant",attachments:[]}]};
 const html='<div class="message-shell"><div class="assistant-model">Platform chrome</div><details class="osis-thinking"><summary>Thought</summary><div class="osis-thinking-body">First line\nSecond line</div></details><div class="rich-content"><p>Answer</p><div class="assistant-model">Authored same class</div></div><div class="osis-doubao-elapsed" data-elapsed-seconds="20">20 seconds</div><time class="osis-doubao-message-time">2026-10-22</time></div>';
 const draft=await doubaoFullAdapter.parse({manifest:{},payload,source:{file:"x.html",bytes:1,sha256:"b".repeat(64)},extensions:{doubaoRichContent:{}},reading:{fragments:[{messageId:"m",html}],images:[],files:[],mermaid:[]},record:{message(){},current(){},block(){},conversationModel(){}}});
 const blocks=(draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
 assert.deepEqual(blocks.map(b=>b["type"]),["reasoning","html","status","html"]);
 assert(JSON.stringify(blocks[0]).includes("First line\\nSecond line"));assert(JSON.stringify(blocks[1]).includes("Answer"));
 assert.equal(blocks[2]!["title"], "20 seconds"); assert.equal(blocks[2]!["duration"], 20);
 assert(!JSON.stringify(blocks).includes("Platform chrome"));assert(JSON.stringify(blocks).includes("2026-10-22"));assert(JSON.stringify(blocks).includes("Authored same class"));
});

test("Doubao preserves utterance times in the standard field while keeping elapsed status and unknown source dates", async () => {
 const created = "2026-10-20T06:10:28.000Z", completed = "2026-10-20T06:11:02.852Z", edited = "2026-10-22T00:00:00.000Z";
 const messages: JsonObject[] = [
  {id:"u",role:"user",timestamps:{created_at:created,completed_at:completed,updated_at:edited}},
  {id:"a",role:"assistant",timestamps:{created_at:created,completed_at:completed,updated_at:edited}},
  {id:"fallback",role:"assistant",timestamps:{created_at:created,completed_at:"invalid",updated_at:edited}},
  {id:"dom",role:"assistant"},
  {id:"unknown",role:"assistant",timestamps:{updated_at:edited}}
 ];
 const expected = [created,completed,created,completed,undefined], facts: SourceMessageFacts[] = [];
 const draft = await doubaoFullAdapter.parse({manifest:{},payload:{message_order:messages.map(m=>m["id"]!),messages},source:{file:"time.html",bytes:1,sha256:"b".repeat(64)},extensions:{doubaoRichContent:{}},
  reading:{fragments:messages.map((m,i)=>({messageId:String(m["id"]),html:`<div class="message-shell"><p>Body</p><div class="osis-doubao-elapsed" data-elapsed-seconds="34.852">共用时34.852秒</div><time class="osis-doubao-message-time" datetime="${expected[i]??'invalid'}">${expected[i]??'source date unavailable'}</time></div>`})),images:[],files:[],mermaid:[]},
  record:{message(i,f){facts[i]=f;},current(){},block(){},conversationModel(){}}});
 const record=assembleConversationRecord({parsed:{draft,adapter:doubaoFullAdapter.manifest,sourceFingerprint:{bytes:1,sha256:"b".repeat(64)},systemLogErrors:[]},facts:{messages:facts},parserVersion:"1.1.42",timestamp:edited});
 const items=(record["messages"] as JsonObject)["items"] as JsonObject[];
 assert.deepEqual(items.map(m=>m["timestamp"]),expected);
 for (const [i,m] of items.entries()) {
  const blocks=m["content"] as JsonObject[];
  assert(blocks.some(b=>b["type"]==="status"&&b["title"]==="共用时34.852秒"&&b["duration"]===34.852));
  assert.equal(JSON.stringify(blocks).includes("osis-doubao-message-time"),i===4,"only a preserved exact instant moves out of prose");
 }
 assert(JSON.stringify(items[4]).includes("source date unavailable"));
});

test("Doubao keeps native process images, captured dependencies and media bytes in their own scopes", async () => {
  const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>');
  const code = '<html><body><canvas></canvas><script src="https://example.test/chart.js"></script></body></html>';
  const payload: JsonObject = { message_order: ["m"], messages: [{ id: "m", role: "assistant", attachments: [] }] };
  const rich: JsonObject = { works: [{ key: "w", message_id: "m", title: "Chart", source: code, dependencies: ["https://example.test/chart.js"] }],
    dependencies: [{ url: "https://example.test/chart.js", source: "window.library=42;", mime_type: "application/javascript" }],
    resources: [{ key: "sound", message_id: "m", name: "track.wav", kind: "audio", mime_type: "audio/wav", status: "embedded", embedded_bytes: 5, resource_locator: { value_attribute: "src" } },
      { key: "cover", message_id: "m", kind: "image", status: "embedded", resource_locator: { value_attribute: "src" } },
      { key: "thought", message_id: "m", kind: "image", status: "embedded", resource_locator: { value_attribute: "src" } }] };
  const fragment = `<div class="rich-content"><details class="osis-thinking"><summary>Drawing</summary><figure data-doubao-resource="thought"><img src="${image}"></figure></details><p>Before</p><section data-doubao-work="w">Preview</section><figure data-doubao-resource="sound"><figure data-doubao-resource="cover"><img src="${image}"></figure><audio src="data:audio/wav;base64,YXVkaW8="></audio><a href="data:audio/wav;base64,YXVkaW8=">Save</a></figure><p>After</p></div>`;
  const facts: SourceMessageFacts[] = [];
  const draft = await doubaoFullAdapter.parse({ manifest: {}, payload, source: { file: "doubao.html", bytes: 1, sha256: "b".repeat(64) }, extensions: { doubaoRichContent: rich },
    reading: { fragments: [{ messageId: "m", html: fragment }], images: [], files: [], mermaid: [] },
    record: { message(i, f) { facts[i] = f; }, current() {}, block() {}, conversationModel() {} } });
  const record = assembleConversationRecord({ parsed: { draft, adapter: doubaoFullAdapter.manifest, sourceFingerprint: { bytes: 1, sha256: "b".repeat(64) }, systemLogErrors: [] },
    facts: { messages: facts }, parserVersion: "1.1.39", timestamp: "2026-10-21T00:00:00.000Z" });
  const content = ((record["messages"] as JsonObject)["items"] as JsonObject[])[0]!["content"] as JsonObject[];
  assert.deepEqual(content.map(b => b["type"]), ["reasoning", "html", "box", "box", "attachment", "html"]);
  assert((content[3]!["files"] as JsonObject[]).some(f=>f["path"]==="cover"),"album cover stays owned by its media card rather than a repeated full-size image");
  assert.equal((content[0]!["content"] as JsonObject[])[0]!["type"], "image");
  const resources = record["resources"] as JsonObject[];
  assert.equal(resources.filter(r => r["mime"] === "audio/wav").length, 1);
  const dependency = resources.find(r => r["mime"] === "application/javascript")!;
  assert.deepEqual(dependency["original"], { url: "https://example.test/chart.js" });
  assert.equal(Buffer.from((dependency["data_base64"] as string[]).join(""), "base64").toString(), "window.library=42;");
  assert.equal(resources.filter(r => r["mime"] === "text/html" && Buffer.from((r["data_base64"] as string[]).join(""), "base64").toString() === code).length, 1);
});
