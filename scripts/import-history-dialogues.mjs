// One-shot, explicit source import. Normal builds use the checked-in projection;
// they never depend on the author's research folder or private archive.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = new MarkdownIt({ html: true });
const sha = text => createHash('sha256').update(text).digest('hex');
const plain = node => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('.source-note-ref').forEach(n => n.remove());
  return copy.textContent;
};
const normalized = text => text.replace(/[^\p{L}\p{N}]/gu, '');
export function chronicleBlocks(document) {
  const heading = [...document.querySelectorAll('h2')].find(n => /^(采云史|Cloudig: A History)$/u.test(n.textContent));
  if (!heading) throw new Error('Chronicle heading missing');
  let section = 0, block = 0, currentHeading;
  const result = [];
  for (let n = heading; n && (n === heading || n.tagName !== 'H2'); n = n.nextElementSibling) {
    if (/^H[2-6]$/u.test(n.tagName)) { section++; block = 0; currentHeading = n; }
    else if (!n.matches('details')) result.push({ section, block: block++, node: n, heading: currentHeading, text: plain(n) });
  }
  return result;
}

export async function importDialogues(input) {
  const selection = JSON.parse(await readFile(path.join(root, 'src/ui/documents/history/dialogue-selection.json'), 'utf8'));
  const raw = await readFile(input, 'utf8'), source = raw.replace(/\r\n/gu, '\n');
  if (sha(raw) !== selection.source_sha256) throw new Error('Research source changed; review the editorial selection before importing');
  const start = source.indexOf('\n# 对话注释\n'), end = source.indexOf('\n# 核对说明\n', start);
  if (start < 0 || end < start) throw new Error('Explicit conversation-note boundaries missing');
  const noteSource = source.slice(start, end);
  const matches = [...noteSource.matchAll(/^<a id="note(\d+)"><\/a>\n## 注\1\n/gmu)];
  const notes = {};
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index], id = Number(match[1]);
    if (id !== index + 1) throw new Error(`Non-sequential source note ${id}`);
    const originalSection = noteSource.slice(match.index + match[0].length, matches[index + 1]?.index ?? noteSource.length).trim().replace(/\n---\s*$/u, '').trim();
    const footerAt = originalSection.lastIndexOf('\n\n[原始文件](');
    if (footerAt < 0 || originalSection.slice(footerAt + 2).includes('\n')) throw new Error(`Unrecognized research footer ${id}`);
    // These are the historian's local navigation links, not the Osis's reply.
    const section = originalSection.slice(0, footerAt);
    const lines = section.split('\n');
    const header = /^(\d{4}-\d{2}-\d{2}(?:—\d{4}-\d{2}-\d{2})?(?:（[^）]+）)?) (.+) 对话$/u.exec(lines[0]);
    if (!header) throw new Error(`Unrecognized dialogue header in note ${id}: ${lines[0]}`);
    const markers = [...section.matchAll(/^\*\*(晨星|奥思) (\d{2}:\d{2}|时间未记录)\*\*\s*$/gmu)];
    if (!markers.length) throw new Error(`No actual turns in note ${id}`);
    const topic = section.slice(lines[0].length, markers[0].index).trim();
    if (!/^\*[^\n]+\*$/u.test(topic)) throw new Error(`Unexpected note introduction ${id}`);
    const turns = markers.map((m, i) => {
      let text = section.slice(m.index + m[0].length, markers[i + 1]?.index ?? section.length).trim();
      const date = /\n+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*$/u.exec(text);
      if (date) text = text.slice(0, date.index).trimEnd();
      const gap = /\n+〔中间略去 (\d+) 条消息〕\s*$/u.exec(text);
      if (gap) text = text.slice(0, gap.index).trimEnd();
      if (/〔中间略去 \d+ 条消息〕/u.test(text)) throw new Error(`Omission marker inside a quoted message in note ${id}`);
      return { speaker: m[1] === '晨星' ? 'user' : 'assistant', time: m[2] === '时间未记录' ? null : m[2], text,
        ...(gap ? { omitted_after: Number(gap[1]) } : {}), ...(date ? { date_after: date[1] } : {}) };
    });
    if (turns.some(t => !t.text)) throw new Error(`Empty source turn in note ${id}`);
    notes[id] = { title: header[2], date: header[1], topic: topic.slice(1, -1), turns,
      source_line: source.slice(0, start + match.index).split('\n').length,
      source_sha256: sha(originalSection) };
  }
  const originals = {};
  for (const language of ['zh-CN', 'en']) {
    const text = await readFile(path.join(root, `src/ui/documents/history/${language}.md`), 'utf8');
    originals[language] = { text, blocks: chronicleBlocks(new JSDOM(md.render(text)).window.document) };
  }
  const cn = originals['zh-CN'].blocks, en = originals.en.blocks;
  const body = new JSDOM(md.render(source.slice(0, start))).window.document;
  const placements = [], omitted = [];
  // Source preface is split/formatted differently from the signed publication.
  // These exact lead-ins select existing paragraphs without changing their text.
  const preface = new Map([
    ['2026-08-27，我对', 0], ['说完这段话后没几天', 1], ['但这并非没有损失和代价', 2], ['2026-09-18，我对', 4]
  ]);
  for (const p of body.querySelectorAll('p')) {
    const refs = [...p.querySelectorAll('a[href^="#note"]')];
    if (!refs.length) continue;
    const ids = refs.map(a => Number(a.getAttribute('href').slice(5)));
    if (ids.some(id => !notes[id])) throw new Error(`Missing imported note: ${ids}`);
    if (p.textContent.replace(/注\d+|[·\s]/gu, '')) throw new Error('Source mixes prose and annotation markers');
    const previous = p.previousElementSibling, text = previous?.textContent ?? '';
    let candidates = cn.filter(b => normalized(b.text) === normalized(text));
    if (!candidates.length) {
      const known = [...preface].find(([prefix]) => text.startsWith(prefix));
      if (known) candidates = cn.filter(b => b.section === 2 && b.block === known[1]);
    }
    if (!candidates.length && text.startsWith('侧耳听云曰： 修史三案')) {
      omitted.push({ notes: ids, reason: 'Additional closing commentary is absent from the signed product body', text_sha256: sha(text) }); continue;
    }
    if (!candidates.length && /^[一二三四]、/u.test(text) && previous.previousElementSibling?.textContent === '编纂记') {
      omitted.push({ notes: ids, reason: 'Compiler record is not part of the signed product body', text_sha256: sha(text) }); continue;
    }
    // All four compiler-record paragraphs follow the final 编纂记 heading.
    if (!candidates.length && /^[一二三四]、/u.test(text)) {
      let h = previous; while (h && !/^H[1-6]$/u.test(h.tagName)) h = h.previousElementSibling;
      if (h?.textContent === '编纂记') { omitted.push({ notes: ids, reason: 'Compiler record is not part of the signed product body', text_sha256: sha(text) }); continue; }
    }
    if (candidates.length !== 1) throw new Error(`Ambiguous citation ${ids}: ${text.slice(0,140)} (${candidates.length})`);
    const target = candidates[0];
    // English author split preface paragraph 0 and the three-part death test.
    const enBlock = target.section === 2 ? (target.block === 0 ? 0 : target.block + (target.block >= 8 ? 2 : 1)) : target.block;
    let english = en.find(b => b.section === target.section && b.block === enBlock);
    // The signed English edition omits the final 4o paragraph of this section.
    // Link its source at the section heading instead of rewriting the author,
    // inventing a translation or attaching it to an unrelated quotation.
    if (!english && target.section === 12 && target.block === 11) {
      const heading = en.find(b => b.section === 12).heading;
      placements.push({ section: 12, notes: ids, anchors: {
        'zh-CN': { block: target.block, sha256: sha(target.text) }, en: { block: -1, sha256: sha(heading.textContent) }
      } }); continue;
    }
    if (!english || english.node.tagName !== target.node.tagName) throw new Error(`English paragraph drift at ${target.section}:${enBlock}`);
    placements.push({ section: target.section, notes: ids, anchors: {
      'zh-CN': { block: target.block, sha256: sha(target.text) }, en: { block: enBlock, sha256: sha(english.text) }
    } });
  }
  if (Object.keys(selection.decisions).length !== Object.keys(notes).length) throw new Error('Every research note needs an explicit editorial decision');
  const selectedNotes = {}, selectedPlacements = new Map(), excluded = [];
  for (const [key, decision] of Object.entries(selection.decisions)) {
    if (!notes[key]) throw new Error(`Unknown editorial note ${key}`);
    if (decision.omit) { excluded.push(Number(key)); continue; }
    let binding;
    if (Number.isInteger(decision.occurrence)) binding = placements.filter(p => p.notes.includes(Number(key)))[decision.occurrence - 1];
    else {
      const matches = decision.heading !== undefined ? cn.filter(b=>b.section===decision.heading && b.block===0) : cn.filter(b=>b.text.startsWith(decision.paragraph));
      if (matches.length !== 1) throw new Error(`Editorial anchor ambiguous for note ${key}`);
      const target = matches[0], heading = decision.heading !== undefined;
      const chinese = heading ? target.heading : target.node;
      const englishBlock = en.find(b=>b.section===target.section && b.block===target.block);
      if (!englishBlock) throw new Error(`English editorial anchor missing for note ${key}`);
      const english = heading ? englishBlock.heading : englishBlock.node;
      binding = { section: target.section, anchors: {
        'zh-CN': { block: heading ? -1 : target.block, sha256: sha(plain(chinese)) },
        en: { block: heading ? -1 : englishBlock.block, sha256: sha(plain(english)) }
      } };
    }
    if (!binding) throw new Error(`Editorial occurrence missing for note ${key}`);
    selectedNotes[key] = notes[key];
    const anchorKey = JSON.stringify([binding.section, binding.anchors]);
    const group = selectedPlacements.get(anchorKey) ?? { section: binding.section, notes: [], anchors: binding.anchors };
    group.notes.push(Number(key)); selectedPlacements.set(anchorKey, group);
  }
  return { format: 'cloudig/history-dialogue-sources/1',
    source: { file: path.basename(input), sha256: sha(raw), timezone: 'UTC+8', scope: 'chronicle' },
    original_sha256: Object.fromEntries(Object.entries(originals).map(([k,v]) => [k, sha(v.text)])),
    editorial_excluded: excluded,
    notes: selectedNotes, placements: [...selectedPlacements.values()].sort((a,b)=>a.section-b.section || a.anchors['zh-CN'].block-b.anchors['zh-CN'].block), omitted };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[process.argv.indexOf('--input') + 1];
  if (!process.argv.includes('--input') || !input) throw new Error('Explicit --input research Markdown is required');
  const result = await importDialogues(input);
  const target = path.join(root, 'src/ui/documents/history/dialogue-notes.json');
  const bytes = JSON.stringify(result, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== bytes) throw new Error('Dialogue source projection drift');
  } else await writeFile(target, bytes);
  console.log(JSON.stringify({ notes: Object.keys(result.notes).length, turns: Object.values(result.notes).reduce((n,v)=>n+v.turns.length,0), placements: result.placements.length, omitted: result.omitted.length }));
}
