import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const url='https://zhuanlan.zhihu.com/p/2085630488027330496';

test('Both author footers expose the chosen Zhihu article and GitHub issues as external links',async()=>{
  const dom=new JSDOM(await readFile('src/ui/shell/index.html','utf8'));
  for(const id of ['reader-cover-template','archiver-template'])for(const [key,destination] of [['contactZhihu',url],['contactGithub','https://github.com/ChenXing-CyberVenus/Cloudig/issues']]){
    const node=dom.window.document.getElementById(id).content.querySelector(`[data-i18n="reader.${key}"]`);
    assert.equal(node.tagName,'A',id);
    assert.equal(node.getAttribute('href'),destination);
    assert.equal(node.target,'_blank');
    assert(node.relList.contains('noopener'));assert(node.relList.contains('noreferrer'));
    assert(node.classList.contains('cloudig-contact-link'));
    assert(!node.hasAttribute('data-route-target'));
  }
  dom.window.close();
});

test('Zhihu labels remain bilingual and link styling inherits each footer palette',async()=>{
  const zh=JSON.parse(await readFile('src/ui/shell/locales/zh-CN.json','utf8'));
  const en=JSON.parse(await readFile('src/ui/shell/locales/en.json','utf8'));
  assert.equal(zh.reader.contactZhihu,'知乎留言');assert.equal(en.reader.contactZhihu,'Zhihu');
  const css=await readFile('src/ui/shell/shell.css','utf8');
  assert.match(css,/\.cloudig-contact-link\s*\{[^}]*color: inherit;[^}]*font: inherit;[^}]*text-decoration: none;/u);
  assert.match(css,/\.cloudig-contact-link:is\(:hover, :focus-visible\)/u);
});

test('Desktop external hyperlinks use the default browser, never an in-app page',async()=>{
  const source=await readFile('src/desktop/Cloudig.Desktop/MainWindow.xaml.cs','utf8');
  const handler=source.slice(source.indexOf('private void OnNewWindowRequested'),source.indexOf('private async Task VerifyParseDestinationAsync'));
  assert.match(handler,/e\.Handled = true;/u);
  assert.match(handler,/e\.IsUserInitiated && BridgePolicy\.IsExternalHttp\(e\.Uri\)\) OpenExternal\(e\.Uri\)/u);
  assert.match(handler,/Process\.Start\(new ProcessStartInfo\(value\) \{ UseShellExecute = true \}\)/u);
});
