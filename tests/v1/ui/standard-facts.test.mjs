import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateRecord, validateRecordRange } from '../../../src/core/records/index.mts';
import { SOURCE_CAPTURE_LIMITS } from '../../../src/core/records/source-time.mts';
import { readV1SchemaPackage } from '../../../scripts/build-v1-schema-package.mjs';

const root = 'src/ui/documents/standard';
const kind = {library:'library',identity:'identity','identity-settings':'identitySettings',conversation:'conversation',mark:'mark','content-time':'contentTime','content-time-order':'contentTimeOrder'};
const baseline = {
  'zh-CN': { heading:'## 二 ·', sha:'5f8aa8020ac412a3f28765da8c2e8e0b5754611b771fff115973fdc45f14c555', inbox:'├─ Inbox/                 导入的来源：书签下载的 HTML、官方导出的 JSON' },
  en: { heading:'## II ·', sha:'b728babd5aeed7277a1a8ae5fe5381885700994bafc6d4974eb74a4587741e97', inbox:'├─ Inbox/                 Imported sources: HTML saved by the bookmarklet, official JSON exports' }
};
const examples = source => [...source.replaceAll('\r\n','\n').matchAll(/```json(?: [^\n]+)?\n([\s\S]*?)\n```/gu)].map(m=>JSON.parse(m[1]));
for (const language of ['zh-CN','en']) {
  test(`standard ${language}: author principles and concepts change only the approved Inbox description`, async()=>{
    const source=(await readFile(`${root}/${language}.md`,'utf8')).replaceAll('\r\n','\n'), old=baseline[language];
    const intro=source.slice(0,source.indexOf(old.heading)).replace(/^├─ Inbox\/.*$/mu,old.inbox);
    assert.equal(createHash('sha256').update(intro).digest('hex'),old.sha);
    assert(source.includes('Osis.ScrollborneDawn'));
    assert(source.includes('Osis.FuckTheLabel'));
    assert(source.includes('Osis.ClearWordsCarryCloud'));
    assert(!source.includes('Codex Desktop'), 'Author credits omit client labels');
    assert.match(source, /(?:现行技术修订与中英文同步|Current technical revisions and Chinese–English synchronization)：?\s*:?\s*GPT-6-Astra·奥思·承卷开霁 Osis\.ScrollborneDawn/u);
  });
  test(`standard ${language}: complete JSON examples pass production shape and semantics`, async()=>{
    const records=examples(await readFile(`${root}/${language}.md`,'utf8'));
    assert(records.length>=15);
    for(const value of records){const type=value.schema?.split('/')[1];if(type)assert(kind[type],value.schema);const result=type?validateRecord(kind[type],value):validateRecordRange(value);assert(result.ok,JSON.stringify(result));}
    const shared=records.find(v=>v.schema==='cloudig/conversation/1.0.2');
    assert(shared);assert.equal(shared.resources.length,1);
    assert.deepEqual(shared.messages.items[0].content.map(v=>v.type),['box','window']);
    assert(shared.messages.items[0].content.every(v=>v.files[0].resource===shared.resources[0].id));
  });
  test(`standard ${language}: current source and device facts are documented without changing schema versions`, async()=>{
    const source=await readFile(`${root}/${language}.md`,'utf8');
    assert(source.includes(SOURCE_CAPTURE_LIMITS.earliestUtc));
    for(const key of ['cline','sillytavern','kimi-code','claude-code','codex','agent-thread:','appdata/reader-state.json','chatgpt.com_dil','cloudig/dil-view/1','data-cloudig-resource','records/compat/'])assert(source.includes(key),key);
    const schemas=await readV1SchemaPackage(process.cwd());
    assert(source.includes(language==='en'?`${schemas.length} JSON Schemas`:`${schemas.length} 份 JSON Schema`));
    assert(!source.includes('cloudig/conversation/1.0.8'));
    const reading=await readFile('src/adapters/library-data/reader-state.mts','utf8');
    for(const constant of ['MAX_ENTRIES','MAX_ID'])assert(source.includes(reading.match(new RegExp(`const ${constant} = (\\d+)`))[1]));
  });
}
test('standard: new shared-resource example is identical in Chinese and English',async()=>{
  const cn=examples(await readFile(`${root}/zh-CN.md`,'utf8')).find(v=>v.schema==='cloudig/conversation/1.0.2');
  const en=examples(await readFile(`${root}/en.md`,'utf8')).find(v=>v.schema==='cloudig/conversation/1.0.2');
  assert.deepEqual(cn,en);
});
