// Read-only production/runtime comparison; outputs contain synthetic text only.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createOfflineContentRuntime } from '../src/ui/shared/conversation-renderer/content-runtime.mts';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorPath = path.join(project, 'bookmarklets/vendor/osis-math-delimiters.js');
const source = await readFile(vendorPath, 'utf8');
const singleDollarRanges = vm.runInNewContext(source + '\n;osisInlineDollarRanges;', Object.create(null), { timeout: 1000 });
const runtime = createOfflineContentRuntime();
const cases = [
  ['formula', '$E=mc^2$'], ['numeric-formula', '$1/2$'], ['two-prices', '$0.435/$0.87'],
  ['opening-space', '$ x$'], ['closing-space', '$x $'], ['digit-after-close', '$x$2'],
  ['escaped-dollar', String.raw`\$100`], ['inline-code', '`$x$`'], ['fenced-code', '```text\n$x$\n```'],
  ['newline', '$x\ny$'], ['digit-before-open', '1$x$'], ['link-target', '[link](https://example.com/a$x$)'],
  ['code-inside-pair', '$a `b` c$'], ['adjacent-pairs', '$x$$y$'],
  ['known-signed-price-ambiguity', '$-0.5/$+0.75'], ['known-mixed-price-ambiguity', '$0.1/1M，公式$x^2$'],
  ['explicit-inline', String.raw`\(x\)2`], ['explicit-display', String.raw`\[x^2\]`],
  ['double-dollars', '$$x^2$$'], ['math-environment', String.raw`\begin{matrix}a&b\\c&d\end{matrix}`]
];
const rows = cases.map(([id, input]) => {
  const html = runtime.renderMarkdown(input), document = JSDOM.fragment(html);
  return { id, input, bookmark_single_dollar_tex: Array.from(singleDollarRanges(input), r => r.tex),
    reader_tex: [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map(n => n.textContent),
    reader_math_errors: document.querySelectorAll('.katex-error').length,
    reader_codes: [...document.querySelectorAll('code')].map(n => n.textContent),
    reader_html: html };
});
runtime.dispose();
const require = createRequire(import.meta.url), packageInfo = name => JSON.parse(require('node:fs').readFileSync(require.resolve(name + '/package.json'), 'utf8')).version;
const facts = { kind: 'read-only-current-dollar-comparison', versions: { markdown_it: packageInfo('markdown-it'), texmath: packageInfo('markdown-it-texmath'), katex: packageInfo('katex') },
  source_sha256: { bookmark_helper: createHash('sha256').update(source).digest('hex'), reader_runtime: createHash('sha256').update(await readFile(path.join(project, 'src/ui/shared/conversation-renderer/content-runtime.mts'))).digest('hex') },
  boundary: 'Only the bookmark single-dollar recognizer is compared. Empty bookmark results for explicit delimiters do not mean its complete exporter cannot render them.', rows };
const output = process.argv[2];
if (output) { const target = path.resolve(output); if (!target.startsWith(path.join(project, 'artifacts') + path.sep)) throw new Error('Evidence output must stay in project artifacts'); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(facts, null, 2) + '\n', { flag: 'wx' }); }
console.log(JSON.stringify({ versions: facts.versions, rows: rows.map(({ reader_html, ...rest }) => rest) }, null, 2));
