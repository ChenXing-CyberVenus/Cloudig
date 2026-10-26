// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { streamAgentJsonl } from "../../../src/adapters/parser/agent-jsonl-stream.mts";
import { planCodexChain, codexChainRecords } from "../../../src/adapters/parser/codex-storage-chain.mts";
import { extractAgentRecord, probeAgentFile } from "../../../src/adapters/parser/agent-json.mts";
import { scanRecordSources, readRecordParseStatuses, unitKey } from "../../../src/adapters/library-data/record-parse-status.mts";
import { prepareRecordParsePlan } from "../../../src/app/parser/record-plan.mts";
import { runRecordParseBatch } from "../../../src/app/parser/record-batch.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import { savePreparedRecord } from "../../../src/adapters/library-data/record-parser-commit.mts";
import { chooseNoReplaceLeaf } from "../../../src/adapters/storage/names.mts";

const first = "00000000-0000-7000-8000-000000000001", next = "00000000-0000-7000-8000-000000000002";
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const message = (id, value) => ({ type: "response_item", payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text: value }] } });
async function sandbox(fn) {
  await mkdir("tests/private/codex-storage", { recursive: true });
  const root = await mkdtemp(path.resolve("tests/private/codex-storage/run-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function extract(file, bytes, shards) {
  const input = { filePath: file, source: { file: path.basename(file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, family: "codex", format: "jsonl", ...(shards ? { shards } : {}) };
  return assembleConversationRecord({ ...await extractAgentRecord(input), parserVersion: "1.1.45", timestamp: "2026-10-23T00:00:00Z" });
}

test("Zstd and plain JSONL preserve equivalent source records with decoded byte coordinates", () => sandbox(async root => {
  const bytes = encode([{ type: "session_meta", payload: {} }, message("a", "中文🪶\n第二行")]);
  const plain = path.join(root, "sample.jsonl"), compressed = plain + ".zst";
  await writeFile(plain, bytes); await writeFile(compressed, zstdCompressSync(bytes));
  const read = async file => { const rows=[]; for await (const row of streamAgentJsonl(file)) rows.push(row); return rows; };
  assert.deepEqual(await read(compressed), await read(plain));
  assert.equal((await probeAgentFile(compressed, "jsonl"))?.family, "codex");
  assert.deepEqual((await extract(compressed, bytes)).messages, (await extract(plain, bytes)).messages);
  assert.equal((await extract(compressed, bytes)).title.filename,"sample");
  assert.equal(chooseNoReplaceLeaf("sample.jsonl.zst",new Set(["sample.jsonl.zst"])),"sample (2).jsonl.zst");
  await assert.rejects(async () => { for await (const _ of streamAgentJsonl(compressed, { end: bytes.length - 4 })) {} }, /cutoff/u);
}));

test("verified storage chain uses inherited prefix only and keeps one stable source row", () => sandbox(async root => {
  await mkdir(path.join(root, "Inbox"));
  const a = path.join(root, "Inbox", `rollout-${first}.jsonl.zst`), b = path.join(root, "Inbox", `rollout-${next}.jsonl`);
  const prefix = encode([{ ordinal: 0, type: "session_meta", payload: { id: first } }, { ordinal: 1, ...message("a", "前片") }]);
  const parent = Buffer.concat([prefix, encode([{ ordinal: 2, ...message("not-inherited", "未继承尾段") }])]);
  const child = encode([{ ordinal: 2, type: "session_meta", payload: { session_id: first, history_base: { thread_id: first, end_ordinal_exclusive: 2, end_byte_offset: prefix.length } } }, { ordinal: 3, ...message("b", "续片") }]);
  await writeFile(a, zstdCompressSync(parent)); await writeFile(b, child);
  await createRecordLibrary(root,{timestamp:"2026-10-23T00:00:00Z",anchor:{date:"2026-10-23",offset:"Z"}});
  const chain = await planCodexChain(b, [a,b]), rows=[];
  for await (const row of codexChainRecords(chain)) rows.push(row);
  assert.equal(rows.length,4); assert.ok(!JSON.stringify(rows).includes("未继承尾段"));
  const cold = await scanRecordSources(root), warm = await scanRecordSources(root);
  assert.equal(cold.length,1); assert.equal(cold[0].path,`Inbox/${path.basename(a)}`); assert.deepEqual(warm,cold);
  const record = await extract(a, Buffer.concat([parent, child]), [a,b]);
  assert.equal(record.messages.items.length,2); assert.match(JSON.stringify(record.limitations),/decoded_end_exclusive/u);
  record.source.sha256=cold[0].sha256;record.source.bytes=cold[0].bytes;
  const saved=await savePreparedRecord(root,{conversation:record,sourcePath:cold[0].path,sourceParts:cold[0].agentParts});
  const repeated=await savePreparedRecord(root,{conversation:record,sourcePath:cold[0].path,sourceParts:cold[0].agentParts});
  assert.equal(repeated.path,saved.path);assert.equal(repeated.conversation.conversation_id,saved.conversation.conversation_id);assert.equal(repeated.replaced,true);
  await assert.rejects(planCodexChain(b,[b]),/Missing or ambiguous/u);
  await writeFile(b, encode([{ ordinal:2,type:"session_meta",payload:{session_id:first,history_base:{thread_id:first,end_ordinal_exclusive:2,end_byte_offset:prefix.length-1}}}]));
  await assert.rejects(savePreparedRecord(root,{conversation:record,sourcePath:cold[0].path,sourceParts:cold[0].agentParts}),/Read dependency changed/u);
  await assert.rejects(async()=>{ for await(const _ of codexChainRecords(await planCodexChain(b,[a,b]))){} },/cutoff/u);
}));

test("new item events pair with their canonical item, not equal messages from another turn", () => sandbox(async root => {
  const rows = [
    {type:"session_meta",payload:{}},
    {type:"event_msg",payload:{type:"thread_settings_applied",thread_settings:{model:"unused-configuration"}}},
    {type:"turn_context",payload:{turn_id:"t1",model:"actual-model"}},
    {type:"event_msg",payload:{type:"item_completed",turn_id:"t1",item:{type:"AgentMessage",id:"a1",content:[{type:"Text",text:"同文"}]}}},
    message("a1","同文"),
    {type:"event_msg",payload:{type:"item_completed",turn_id:"t1",item:{type:"Reasoning",id:"r1",summary_text:["摘要一","摘要二"]}}},
    {type:"response_item",payload:{type:"reasoning",id:"r1",summary:[{type:"summary_text",text:"摘要一"},{type:"summary_text",text:"摘要二"}]}},
    message("a2","同文"),
    {type:"turn_context",payload:{turn_id:"t2",model:"second-model"}},
    {type:"event_msg",payload:{type:"item_completed",turn_id:"t2",item:{type:"AgentMessage",id:"a3",content:[{type:"Text",text:"同文"}]}}}
  ];
  const bytes=encode(rows),file=path.join(root,"source.jsonl");await writeFile(file,bytes);
  const record=await extract(file,bytes);
  assert.deepEqual(record.messages.items.map(m=>m.id),["a1","r1","a2","a3"]);
  assert.deepEqual(record.models,["actual-model","second-model"]);
  assert.ok(!JSON.stringify(record).includes("unused-configuration"));
}));

test("a missing storage identity blocks the entire known session, not only its tail, and never overwrites an existing archive", () => sandbox(async root => {
  await createRecordLibrary(root,{timestamp:"2026-10-23T00:00:00Z",anchor:{date:"2026-10-23",offset:"Z"}});
  const third="00000000-0000-7000-8000-000000000003";
  const a=path.join(root,"Inbox",`rollout-${first}.jsonl`),b=path.join(root,"Inbox",`rollout-${next}.jsonl`),c=path.join(root,"Inbox",`rollout-${third}.jsonl`);
  const parent=encode([{ordinal:0,type:"session_meta",payload:{id:first}},{ordinal:1,...message("a","第一片")}]);
  const middle=encode([{ordinal:2,type:"session_meta",payload:{session_id:first,history_base:{thread_id:first,end_ordinal_exclusive:2,end_byte_offset:parent.length}}},{ordinal:3,...message("b","中间片")}]);
  const tail=encode([{ordinal:4,type:"session_meta",payload:{session_id:first,history_base:{thread_id:next,end_ordinal_exclusive:4,end_byte_offset:middle.length}}},{ordinal:5,...message("c","最后片")}]);
  await writeFile(a,parent);await writeFile(b,middle);await writeFile(c,tail);
  const beforePlan=await prepareRecordParsePlan(root,{mode:"parser",selected:new Set()});
  const created=await runRecordParseBatch(root,beforePlan.jobs,{parserVersion:"1.1.45",timestamp:"2026-10-23T00:00:00Z",units:beforePlan.units});
  assert.equal(created.items[0].status,"created");const target=path.join(root,created.items[0].path),original=await readFile(target);
  await rename(b,path.join(root,"Inbox","renamed-middle.jsonl"));
  const broken=await scanRecordSources(root);assert.equal(broken.length,3);
  assert.ok(broken.every(s=>s.chainError?.includes(next)&&!s.agentShards));
  assert.ok((await readRecordParseStatuses(root,broken.map(source=>({source})))).every(s=>s.status==="failed"));
  const plan=await prepareRecordParsePlan(root,{mode:"parser",selected:new Set(broken.map(source=>JSON.stringify(unitKey({source})))),settings:{include_unparsed:false,include_selected:true,include_outdated:false,keep_previous:true}});
  assert.equal(plan.jobs.length,3);assert.ok(plan.jobs.every(j=>j.agent.error));
  const result=await runRecordParseBatch(root,plan.jobs,{parserVersion:"1.1.45",timestamp:"2026-10-23T01:00:00Z",units:plan.units});
  assert.ok(result.items.every(i=>i.status==="failed"));assert.deepEqual(await readFile(target),original);
  await rename(path.join(root,"Inbox","renamed-middle.jsonl"),b);
  assert.equal((await scanRecordSources(root)).length,1,"restoring the physical identity unblocks the full chain");
}));

test("cyclic storage ancestry reports failure even when every shard has a child", () => sandbox(async root => {
  await createRecordLibrary(root,{timestamp:"2026-10-23T00:00:00Z",anchor:{date:"2026-10-23",offset:"Z"}});
  for(const [id,parent]of [[first,next],[next,first]])await writeFile(path.join(root,"Inbox",`rollout-${id}.jsonl`),encode([{ordinal:0,type:"session_meta",payload:{session_id:first,history_base:{thread_id:parent,end_ordinal_exclusive:0,end_byte_offset:0}}}]));
  const rows=await scanRecordSources(root);assert.equal(rows.length,2);assert.ok(rows.every(r=>r.chainError?.includes("cyclic")));
}));

test("new Agent mail is an independent identity, plaintext retained, ciphertext never exposed as prose", () => sandbox(async root => {
  const bytes=encode([
    {type:"session_meta",payload:{}},
    {type:"turn_context",payload:{model:"recipient-model"}},
    {type:"event_msg",payload:{type:"item_completed",item:{type:"SubAgentActivity",kind:"started",agent_path:"/root/helper",agent_thread_id:next,model:"sender-model"}}},
    {type:"response_item",payload:{type:"agent_message",id:"mail1",author:"/root/helper",recipient:"/root",content:[{type:"input_text",text:"Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/helper\nPayload:\n真实报告"}]}},
    {type:"response_item",payload:{type:"agent_message",id:"mail2",author:"/root/helper",content:[{type:"encrypted_content",encrypted_content:"secret-ciphertext"}]}},
    message("main","主回答")
  ]),file=path.join(root,"source.jsonl");await writeFile(file,bytes);
  const record=await extract(file,bytes),mail=record.messages.items[0];
  assert.equal(mail.speaker,`agent-thread:${next}`);assert.match(JSON.stringify(mail.content),/真实报告/u);
  assert.equal(record.messages.items.at(-1).speaker,"assistant:recipient-model");
  assert.ok(!record.models.includes("sender-model"),"a launch model is not historical author evidence");
  assert.ok(!JSON.stringify(record).includes("secret-ciphertext"));assert.match(JSON.stringify(record.limitations),/encrypted_agent_content/u);
}));
