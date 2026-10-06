import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { compileFeatureDocument,featureFigures } from '../../../scripts/build-feature-document.mjs';
import { mountFeatureDocument,screenshotNeedsZoom } from '../../../src/ui/shell/pages/document/features.js';

test('Zoom requires a visible image and a useful actual size gain',()=>{
  assert.equal(screenshotNeedsZoom(220,70,220,70),false);
  assert.equal(screenshotNeedsZoom(220,70,219.5,69.8),false);
  assert.equal(screenshotNeedsZoom(1000,400,950,380),false);
  assert.equal(screenshotNeedsZoom(1000,400,600,240),true);
  assert.equal(screenshotNeedsZoom(1000,400,0,0),false);
  assert.equal(screenshotNeedsZoom(0,0,600,240),false);
});

test('Features retains the complete authored sections; only publication scaffolding and captions change',async()=>{
  const source=await readFile('src/ui/documents/features/zh-CN.md','utf8'),publication=compileFeatureDocument(source,'zh-CN');
  assert.equal(publication.sections.filter(s=>s.rank===3).length,[...source.matchAll(/^### /gmu)].length);
  assert.equal(publication.sections.filter(s=>s.rank===2).length,11);
  const text=new JSDOM(publication.sections.map(s=>s.html).join('')).window.document.body.textContent;
  for(const required of ['新档案默认没有内容时间','前三个开关共同圈定范围','这一篇对话里的身份','CloudigLibrary.json','Osis.FuckOrFlee','Osis.ClearWordsCarryCloud','晨星.CyberVenus'])assert(text.includes(required));
  assert(!text.includes('配图清单'));assert(source.includes('配图清单'));
  const doc=new JSDOM(publication.sections.map(s=>s.html).join('')).window.document;
  assert.equal(doc.querySelectorAll('[data-feature-figure]').length,17);
  assert.deepEqual(new Set([...doc.querySelectorAll('[data-feature-figure]')].map(n=>n.dataset.featureFigure)),new Set(Object.keys(featureFigures)));
  assert(doc.querySelectorAll('[data-document-target=bookmark]').length>=3);
});

test('Features supports nested category folding, TOC reveal, language switching and central-only disposal',async()=>{
  const publications={};for(const language of ['zh-CN','en']){
    const p=compileFeatureDocument(await readFile(`src/ui/documents/features/${language}.md`,'utf8'),language);p.figures=featureFigures;p.images={};
    for(const id of new Set(Object.values(featureFigures).flat()))p.images[id]=Object.fromEntries(['dawn','star-night'].map(t=>[t,{file:`${language}/${t}/${id}.png`,width:640,height:240}]));publications[language]=p;
  }
  const dom=new JSDOM('<div data-page="reader"><aside>untouched</aside><button data-doc-topic="archive"></button><main class="reader-main"><div id="original"></div></main></div>',{pretendToBeVisual:true});
  const beforeDocument=globalThis.document,beforeFetch=globalThis.fetch;globalThis.document=dom.window.document;globalThis.fetch=async url=>({ok:true,json:async()=>publications[url.endsWith('-en.json')?'en':'zh-CN']});
  try{
    const page=document.querySelector('[data-page]'),original=document.querySelector('#original');let closed=false,topic=null;
    const mounted=await mountFeatureDocument({page,language:'zh-CN',onClose(){closed=true;},onDocument(t){topic=t;},onExternal(){}});
    assert.equal(page.dataset.document,'features');assert.equal(document.querySelectorAll('[data-feature-figure]').length,17);
    const zoom=document.querySelector('.feature-zoom'),image=zoom.closest('figure').querySelector('img');
    assert.equal(zoom.hidden,true);
    Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:640},naturalHeight:{value:240}});
    let renderedWidth=320;
    image.getBoundingClientRect=()=>({width:renderedWidth,height:renderedWidth*240/640});
    image.dispatchEvent(new dom.window.Event('load'));await new Promise(r=>setTimeout(r,30));assert.equal(zoom.hidden,false);assert.equal(zoom.textContent,'查看大图');
    zoom.click();assert.equal(zoom.getAttribute('aria-expanded'),'true');assert.equal(zoom.hidden,false);
    renderedWidth=640;dom.window.dispatchEvent(new dom.window.Event('resize'));await new Promise(r=>setTimeout(r,30));assert.equal(zoom.hidden,false,'Expanded view must retain its return button');
    zoom.click();assert.equal(zoom.getAttribute('aria-expanded'),'false');assert.equal(zoom.hidden,true);
    renderedWidth=320;dom.window.dispatchEvent(new dom.window.Event('resize'));await new Promise(r=>setTimeout(r,30));assert.equal(zoom.hidden,false);
    document.querySelector('[data-standard-menu=important]').click();
    assert([...document.querySelectorAll('[data-feature-section][data-infovalue=important]')].every(n=>n.querySelector(':scope>.standard-section-body').hidden));
    document.querySelector('[data-standard-menu=all]').click();
    const link=[...document.querySelectorAll('.standard-nav-panel a')].find(n=>n.textContent.startsWith('5.1'));assert(link);link.click();
    assert(document.activeElement.textContent.includes('给一篇对话设置时间'));assert(!document.activeElement.querySelector(':scope>.standard-section-body').hidden);assert(document.querySelector('.standard-nav-panel').hidden);
    mounted.updateLanguage('en');assert(document.querySelector('h1').textContent.includes('Features and User Guide'));assert(document.querySelector('.feature-crop img').src.includes('/en/'));assert.equal(document.querySelector('.feature-zoom').textContent,'View larger image');assert.equal(document.querySelector('.feature-zoom').hidden,true);
    document.querySelector('[data-document-target=bookmark]').click();assert.equal(topic,'bookmark');
    document.querySelector('.standard-return').click();assert(closed);mounted.close();assert.equal(document.querySelector('#original'),original);assert.equal(document.querySelector('aside').textContent,'untouched');assert(!page.dataset.document);
  }finally{globalThis.document=beforeDocument;globalThis.fetch=beforeFetch;dom.window.close();}
});

test('Welcome documentation entrance opens Features inside Archiver, not Reader or a detached guide',async()=>{
  const source=await readFile('src/ui/shell/shell.js','utf8');
  const dispatch=source.split('\n').filter(line=>line.includes('button.dataset.action === "open-docs"'));
  assert.equal(dispatch.length,1);
  assert.match(dispatch[0],/revealRoute\("archiver"\)\.then\(\(\) => openStandard\('archive'\)\)/u);
});
