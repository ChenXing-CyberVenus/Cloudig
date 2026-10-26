import test from "node:test";
import assert from "node:assert/strict";
import { projectSearchReferences } from "../../../src/adapters/parser/chatgpt-search-references.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

test("search media stays in-place, keeps links and captions, and does not require DIL",()=>{
 const token="iturn0image0",news="navlistturn0news0",source=`Before\n\n${token}\n\nMiddle\n\n${news}\n\nAfter\n\n\`${token}\``;
 const reference={type:"image_v2",matched_text:token,images:[{title:"One",url:"https://example.test/one",attribution:"Author"},{title:"No saved bytes",url:"https://example.test/two"}]};
 const record={raw:{metadata:{content_references:[reference,{type:"nav_list",matched_text:news,items:[{title:"News",url:"https://example.test/news",pub_date:1}]}]}},reference_assets:{0:["i1",null],1:[null]}};
 let writes=0;const result=projectSearchReferences({markdown:source},record,{i1:{src:"data:image/png;base64,AA==",mime_type:"image/png"}},()=>{writes++;return"r1"});
 assert.equal(writes,1);assert.deepEqual(result.map(r=>r["type"]),["markdown","box","markdown","box","markdown"]);
 const data=result[1]!["data"] as JsonObject, items=data["items"] as JsonObject[];
 assert.deepEqual(data["reference"],reference);assert.equal((result[1]!["files"] as JsonObject[]).length,1);
 assert.equal(items[1]!["title"],"No saved bytes");assert.match(String(result.at(-1)!["text"]),/`i/u);
 assert.equal(result[3]!["source"],"chatgpt.com_nav_list");
});

test("citations beside search images use native readable alternatives without changing code literals",()=>{
 const token="citeturn0view1",alt="([Source](https://example.test/article))";
 const projected=projectSearchReferences({markdown:`Fact ${token}\n\n\`${token}\``},{raw:{metadata:{content_references:[{type:"grouped_webpages",matched_text:token,alt}]}},reference_assets:{}},{},()=>undefined);
 assert.equal(projected.length,1);assert.equal(projected[0]!["text"],`Fact ${alt}\n\n\`${token}\``);
});
