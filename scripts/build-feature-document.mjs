import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = new MarkdownIt({ html: false });
export const featureFigures = {
  '01-welcome': ['01-welcome'], '02-archiver': [],
  '03-batch-settings': ['03-entry','03-batch-settings'], '03b-batch-confirm': ['03b-batch-confirm'],
  '04-claude-json': ['04-entry','04-claude-json'], '05-reader-cover': ['05-reader-cover'],
  '06-conversation': ['06-conversation'], '07-reading-controls': ['07-toolbar','07-navigation','07-branches'],
  '08-conversation-info': ['08-entry','08-conversation-info'], '09a-identity-global': ['09a-entry','09a-identity-global'],
  '09b-identity-platforms': ['09b-identity-platforms'], '10-content-time-edit': ['10-content-time-edit'],
  '11-time-cover': ['11-entry','11-time-terran','11-time-sovereign','11-time-create'], '11b-time-editor': ['11b-time-editor'],
  '12-move-library': ['12-entry','12-move-library'], '13-system-log': ['13-entry','13-system-log'],
  '14-rename-in-conversation': ['14-entry','14-rename-in-conversation']
};
export function compileFeatureDocument(source, language) {
  const dom = new JSDOM(markdown.render(source)), doc = dom.window.document, body = doc.body;
  const title = body.querySelector('h1').textContent; body.querySelector('h1').remove();
  // The signed source retains the construction checklist. Only the reading edition removes it.
  const checklist = [...body.querySelectorAll('h2')].find(n => n.textContent.startsWith('配图清单'));
  if (checklist) { let n = checklist.nextElementSibling; while (n && n.tagName !== 'H2') { const next = n.nextElementSibling; n.remove(); n = next; } checklist.remove(); }
  const toc = [...body.children].find(n => n.tagName === 'UL' && n.querySelectorAll('a[href^="#"]').length > 5); toc?.remove();
  body.querySelectorAll('hr').forEach(n=>n.remove());
  const captions = {
    '02-archiver': '图 2：区域关系示意（非截图）。书签在左、功能导航在右，中间并列解析区与档案区。',
    '04-claude-json': '图 5：从来源行进入Claude JSON，使用搜索、时间排序、图钉多选与一键解析。',
    '07-reading-controls': '图 8：工具栏、右侧导航与消息分叉处的按钮，分别展示局部。',
    '08-conversation-info': '图 9：编辑入口，以及标题、模型和时间信息；内容时间控件见图12。',
    '11-time-cover': '图 13：内容时间入口、此地与独立时间列表，以及新建入口的局部。',
    '12-move-library': '图 15：搬家入口与目标确认。本演示只到确认并取消；真正搬家期间请不要关闭采云。',
    '13-system-log': '图 16：明确标为演示的错误记录。删除日志不影响来源和档案。'
  };
  for (const image of [...body.querySelectorAll('img')]) {
    const id = path.basename(image.getAttribute('src'), '.png'); assert(id in featureFigures, `Unknown illustration ${id}`);
    const p = image.parentElement, next = p.nextElementSibling;
    const figure = doc.createElement('figure'); figure.className = 'feature-figure'; figure.dataset.featureFigure = id;
    const caption = doc.createElement('figcaption');
    caption.textContent = language === 'zh-CN' && captions[id] ? captions[id] : next?.matches('p:has(>em:only-child)') ? next.textContent : image.alt;
    figure.append(caption); p.replaceWith(figure); if (next?.matches('p:has(>em:only-child)')) next.remove();
  }
  // Source 4.2 allowed an optional illustration; add it without altering its prose.
  const namesHeading = [...body.querySelectorAll('h3')].find(n=>n.textContent.startsWith('4.2'));
  const optional = doc.createElement('figure'); optional.className = 'feature-figure'; optional.dataset.featureFigure = '14-rename-in-conversation';
  const optionalCaption = doc.createElement('figcaption'); optionalCaption.textContent = language === 'en' ? 'Click a message identity to edit names for this conversation only.' : '点击消息身份，修改仅用于本篇对话的名称。'; optional.append(optionalCaption);
  namesHeading?.nextElementSibling?.after(optional);
  for (const a of body.querySelectorAll('a')) {
    const href = decodeURIComponent(a.getAttribute('href'));
    const topic = href.startsWith('cloudig:') ? href.slice(8) : href.includes('01_书签指南') ? 'bookmark' : href.includes('03_采云标准') ? 'json' : null;
    if (topic) { a.dataset.documentTarget = topic; a.setAttribute('href','#'); }
  }
  let chapter = -1, sub = 0; const sections = []; let current;
  for (const node of [...body.children]) {
    if (!current || /^H[23]$/u.test(node.tagName)) {
      const heading = /^H[23]$/u.test(node.tagName), rank = node.tagName === 'H3' ? 3 : 2;
      if (rank === 2) { chapter++; sub = 0; } else sub++;
      const label = heading ? node.textContent : language === 'en' ? 'Bring your conversations home' : '把云端对话带回家';
      const value = /作者|Authors of This/u.test(label) ? 'fold' : chapter < 2 ? 'core' : /^(八、|8\.)/u.test(label) ? 'general' : 'important';
      current = { id: `features-${chapter}-${sub}`, rank, parent: rank === 3 ? `features-${chapter}-0` : null, label, value, html:'' }; sections.push(current);
      if (heading) continue;
    }
    current.html += node.outerHTML;
  }
  dom.window.close();
  return { format:'cloudig/features-publication/1', language, title, source_sha256:createHash('sha256').update(source).digest('hex'), sections };
}
export async function featurePublications(check = false) {
  const images = JSON.parse(await readFile(path.join(root,'src/ui/documents/features/screenshots.json'),'utf8'));
  for (const language of ['zh-CN','en']) {
    const source = await readFile(path.join(root,`src/ui/documents/features/${language}.md`),'utf8');
    const publication = compileFeatureDocument(source,language);
    publication.images = {};
    for (const id of new Set(Object.values(featureFigures).flat())) {
      publication.images[id] = {};
      for (const theme of ['dawn','star-night']) {
        const asset = images.images[`${language}/${theme}/${id}`]; assert(asset,`Missing actual guide screenshot ${language}/${theme}/${id}`);
        const bytes = await readFile(path.join(root,'src/ui/shell/pages/document/assets/function-guide',asset.file));
        assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
        publication.images[id][theme] = { file:asset.file,width:asset.pixels.width,height:asset.pixels.height };
      }
    }
    publication.figures = featureFigures;
    const output = JSON.stringify(publication)+'\n', file = path.join(root,`src/ui/shell/pages/document/content/features-${language}.json`);
    if (check) assert.equal(await readFile(file,'utf8'),output); else await writeFile(file,output);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await featurePublications(process.argv.includes('--check')); console.log('Features: both languages, all real screenshot hashes verified'); }
