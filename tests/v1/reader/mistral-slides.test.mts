// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { projectMistralSlides, prepareMistralSlideRenderer } from "../../../src/adapters/parser/mistral-slides.mts";
import { WorkResources } from "../../../src/adapters/parser/work-resources.mts";
import { prepareInteractiveHtml } from "../../../src/ui/shared/conversation-renderer/interactive-document.mts";
import { INTERACTIVE_PROTOCOL } from "../../../src/ui/shared/conversation-renderer/interactive-protocol.mts";

test("captured Marp recipe preserves generated source CSS, then theme overlay; sanitizes slide markup",async()=>{
 await prepareMistralSlideRenderer();
 const source="<!-- theme: beam -->\n<style>h1 { color: #123456; }</style>\n# Original title\n\n---\n\nSecond page\n\n<script>window.EVIL=1</script>";
 const raw={key:"asset",message_id:"msg",message_version:0,version:0,source,presentation:{schema:"osis.mistral.slides-presentation/v1",status:"recipe-ready",asset_key:"asset",message_id:"msg",message_version:0,version:0,
 source_sha256:createHash("sha256").update(source).digest("hex"),renderer:{package:"@marp-team/marp-core",version:"4.3.0"},css_resource_ids:["p","b","t"],page_css_resource_id:"p",renderer_css_resource_id:"b",theme_css_resource_id:"t"}};
 const resources=new Map([['p','h1{font-weight:600}'],['b','/* engine reference */'],['t','@import "./default.css"; section{background:#abcdef}']].map(([id,css])=>[id,{id,name:`${id}.css`,asset_key:"asset",status:"embedded",mime:"text/css",data_url:`data:text/css;base64,${Buffer.from(css).toString("base64")}`}])) ,pool=new WorkResources([]);
 const projected=projectMistralSlides(raw,resources,pool);assert(projected);
 for(const theme of ["dawn","star-night"]){const dom=new JSDOM('<!doctype html>');
 const input={protocol:INTERACTIVE_PROTOCOL,token:"test",source:"chat.mistral.ai_slides",format:"slides",entry:"original.md",data:{...projected.data,rendered_file:projected.entry},theme,language:"en",state:{},files:[{path:"original.md",mime:"text/markdown",bytes:new TextEncoder().encode(source).buffer},...projected.files.map(f=>{const r=pool.values.find(r=>r.id===f.resource),bytes=Buffer.from(r.data_base64.join(""),"base64");return {path:f.path,mime:r.mime,bytes:Uint8Array.from(bytes).buffer}})]};
 const html=prepareInteractiveHtml(input,dom.window.document,()=>"blob:local"),out=new JSDOM(html).window.document;
 assert.equal(out.querySelectorAll('.saved-slide').length,2);assert.match(out.querySelector('.saved-slide').textContent,/Original title/u);
 assert.ok(html.includes('#123456'));assert.ok(html.includes('#abcdef'));assert.ok(!html.includes('./default.css'));assert.ok(!html.includes('window.EVIL=1'));
 assert.ok(!out.querySelector('#cloudig-file-preview'));assert.equal(out.querySelector('.saved-slide').getAttribute('data-width'),'1280');
 dom.window.close();out.defaultView.close();}
 assert.equal(raw.source,source);
});
