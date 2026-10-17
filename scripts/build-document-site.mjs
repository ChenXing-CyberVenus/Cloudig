import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { inspectRecordConversation } from '../src/adapters/reader/record-resource.mts';
import { buildPlatformExamples, exampleBuildRoot } from './build-platform-examples.mts';
import { buildWorkDependencies } from './build-v1-work-dependencies.mjs';
import { buildMapRuntime } from './build-v1-map-runtime.mjs';
import { buildV1SchemaPackage } from './build-v1-schema-package.mjs';
import { writeV1ThirdPartyInventory } from './v1-third-party-inventory.mjs';
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const siteRoot = path.join(projectRoot, 'artifacts/v1-document-site');
const frozen = path.join(projectRoot, 'releases/1.0.0/Cloudig');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function siteBase(value = '/Cloudig/') {
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/u.test(value))
        throw Error('Expected a deployment path such as /Cloudig/');
    return value;
}
export function rebaseApplicationText(text, base) {
    return text.replace(/(["'`(])\/(pages|assets|runtime|shared|docs)(?=\/)/gu, (_, lead, folder) => `${lead}${base}${folder}`);
}
async function files(root) { return (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(e => e.isDirectory() ? [] : [e.name]).concat(...await Promise.all((await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(async (e) => (await files(path.join(root, e.name))).map(f => `${e.name}/${f}`)))); }
export async function buildDocumentSite({ base = '/Cloudig/' } = {}) {
    base = siteBase(base);
    const owned = new Map(), inputs = [];
    const put = async (rel, data) => { const target = path.join(siteRoot, rel); assert(target.startsWith(siteRoot + path.sep)); await mkdir(path.dirname(target), { recursive: true }); const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); const existing = await readFile(target).catch(() => null); if (!existing?.equals(bytes))
        await writeFile(target, bytes); owned.set(rel, { path: rel, bytes: bytes.length, sha256: digest(bytes) }); };
    const copy = async (from, to, rebase = false) => { const bytes = await readFile(from); inputs.push({ path: path.relative(projectRoot, from).replaceAll('\\', '/'), sha256: digest(bytes) }); await put(to, rebase ? rebaseApplicationText(bytes.toString('utf8'), base) : bytes); };
    const tree = async (from, to, rebase = false) => { for (const relative of await files(from))
        await copy(path.join(from, relative), `${to}/${relative}`, rebase && /\.(?:js|css|html|json)$/u.test(relative)); };
    await mkdir(siteRoot, { recursive: true });
    await tree(path.join(projectRoot, 'src/ui/shell/pages/document'), 'pages/document', true);
    await copy(path.join(projectRoot, 'src/ui/shell/shell.css'), 'shell.css', true);
    await copy(path.join(projectRoot, 'src/ui/shell/platform-labels.js'), 'platform-labels.js', true);
    for (const file of ['reader.css', 'conversation.css', 'reader-conversation.js', 'title-layout.js'])
        await copy(path.join(projectRoot, 'src/ui/shell/pages/reader', file), `pages/reader/${file}`, true);
    await tree(path.join(frozen, 'app/web/assets'), 'assets');
    await copy(path.join(projectRoot, 'src/ui/assets/identity/System-Avatar.svg'), 'assets/identity/System-Avatar.svg');
    await tree(path.join(frozen, 'app/web/runtime'), 'runtime', true);
    // Render examples with the current production Reader, not the executable
    // assets of a signed historical release. Curated record bytes stay frozen.
    const reader = await build({ entryPoints: [path.join(projectRoot, 'src/ui/shared/conversation-renderer/browser-entry.mts')],
        bundle: true, outdir: path.join(siteRoot, 'runtime'), entryNames: 'conversation-renderer', assetNames: 'assets/[name]-[hash]',
        format: 'iife', globalName: 'CloudigConversationRenderer', legalComments: 'linked', loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
        metafile: true, minify: true, write: false, platform: 'browser', target: ['chrome120', 'firefox128', 'safari17'] });
    for (const file of reader.outputFiles) await put(path.relative(siteRoot, file.path).replaceAll('\\', '/'), /\.(?:js|css)$/u.test(file.path) ? rebaseApplicationText(file.text, base) : file.contents);
    for (const input of Object.keys(reader.metafile.inputs).filter(f => f.startsWith('src/'))) inputs.push({ path: input, sha256: digest(await readFile(path.join(projectRoot, input))) });
    const work = await build({ entryPoints: [path.join(projectRoot, 'src/ui/shared/conversation-renderer/interactive-frame.mts')], bundle: true, format: 'iife', platform: 'browser', target: ['chrome120'], write: false, minify: true, metafile: true });
    await put('runtime/interactive-frame.js', work.outputFiles[0].contents);
    await copy(path.join(projectRoot, 'src/ui/shared/conversation-renderer/interactive-frame.html'), 'runtime/interactive-frame.html');
    const dependencies = await buildWorkDependencies(projectRoot, path.join(siteRoot, 'runtime/dependencies'));
    for (const file of await files(path.join(siteRoot, 'runtime/dependencies'))) await put(`runtime/dependencies/${file}`, await readFile(path.join(siteRoot, 'runtime/dependencies', file)));
    for (const input of [...Object.keys(work.metafile.inputs), ...Object.keys(dependencies.metafile.inputs)].filter(f => f.startsWith('src/'))) inputs.push({ path: input, sha256: digest(await readFile(path.join(projectRoot, input))) });
    const maps = await buildMapRuntime(projectRoot, path.join(siteRoot, 'runtime'));
    for (const file of maps.files) await put(`runtime/${file.file}`, await readFile(path.join(siteRoot, 'runtime', file.file)));
    await put('runtime/map-frame.html', (await readFile(path.join(projectRoot, 'src/ui/shared/conversation-renderer/map-frame.html'), 'utf8')).replace('content="https://cloudig.local"', 'content="same-origin"'));
    for (const input of Object.values(maps.metafiles).flatMap(meta => Object.keys(meta.inputs)).filter(f => f.startsWith('src/'))) inputs.push({ path: input, sha256: digest(await readFile(path.join(projectRoot, input))) });
    await tree(path.join(frozen, 'app/web/locales'), 'locales');
    for (const file of ['endpoint-editor.js', 'core-format.js', 'record-format.js'])
        await copy(path.join(frozen, 'app/web/shared/time', file), `shared/time/${file}`, true);
    await buildV1SchemaPackage(projectRoot, path.join(siteRoot, 'docs/schemas'));
    for (const file of await files(path.join(siteRoot, 'docs/schemas'))) await put(`docs/schemas/${file}`, await readFile(path.join(siteRoot, 'docs/schemas', file)));
    await copy(path.join(frozen, 'LICENSE'), 'LICENSE');
    await copy(path.join(frozen, 'NOTICE.md'), 'NOTICE.md');
    await writeV1ThirdPartyInventory({ repository: projectRoot, outputRoot: path.join(siteRoot, 'docs'), metafiles: { reader: reader.metafile, work: work.metafile, react: dependencies.metafile, ...maps.metafiles } });
    for (const file of ['THIRD-PARTY-LICENSES.txt', 'third-party-inventory.json']) await put(`docs/${file}`, await readFile(path.join(siteRoot, 'docs', file)));
    const catalog = JSON.parse(await readFile(path.join(projectRoot, 'src/ui/shell/pages/document/content/examples.json'), 'utf8'));
    // Website and desktop consume the same current, verified Parser outputs.
    // A frozen signed release is immutable inventory, not a live examples cache.
    const manifest = await buildPlatformExamples(true, { reuseExisting: true });
    assert.equal(catalog.examples.length, manifest.examples.length);
    for (const entry of catalog.examples) {
        assert(/^example-[a-f0-9]{20}$/u.test(entry.id));
        assert.equal(entry.record.path, `records/${entry.id}.json`);
        assert.equal(entry.html.path, `html/${entry.html.file}`);
        assert(!/[\\/]/u.test(entry.html.file));
        const original = manifest.examples.find(e => e.id === entry.id);
        assert(original);
        for (const key of ['html', 'record']) {
            assert.equal(entry[key].sha256, original[key].sha256);
            const from = path.join(exampleBuildRoot, entry[key].path), bytes = await readFile(from);
            assert.equal(digest(bytes), entry[key].sha256);
            assert.equal(bytes.length, entry[key].bytes);
            if (key === 'record')
                await inspectRecordConversation(from); // Schema + semantic + embedded bytes.
            await copy(from, `examples/${entry[key].path}`);
        }
    }
    const shell = await readFile(path.join(projectRoot, 'src/ui/shell/index.html'), 'utf8');
    const template = shell.match(/<template id="reader-conversation-template">[\s\S]*?<\/template>/u)?.[0];
    assert(template);
    for (const file of ['site.js', 'site.css', 'preferences.js'])
        await copy(path.join(projectRoot, 'src/ui/document-site', file), file);
    const index = await readFile(path.join(projectRoot, 'src/ui/document-site/index.html'), 'utf8');
    await put('index.html', index.replace('<!-- READER_TEMPLATE -->', rebaseApplicationText(template, base)));
    const bundled = await build({ entryPoints: [path.join(projectRoot, 'src/ui/document-site/public-reading.mts')], bundle: true, format: 'esm', platform: 'browser', target: ['chrome120', 'firefox128', 'safari17'], write: false, metafile: true, minify: true, legalComments: 'inline' });
    assert(Object.keys(bundled.metafile.inputs).every(name => !name.startsWith('node:')));
    await put('public-reading.js', bundled.outputFiles[0].contents);
    for (const input of Object.keys(bundled.metafile.inputs).filter(f => f.startsWith('src/')))
        inputs.push({ path: input, sha256: digest(await readFile(path.join(projectRoot, input))) });
    await put('.nojekyll', '');
    const receipt = { schema: 'cloudig/document-site/1', base, examples: catalog.examples.length, platforms: new Set(catalog.examples.map(e => e.platform)).size, inputs, files: [...owned.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
    await put('site-manifest.json', JSON.stringify(receipt, null, 2) + '\n');
    const disk = await files(siteRoot);
    assert.deepEqual(disk.sort(), [...owned.keys()].sort(), 'Unexpected files in this website output; do not publish it');
    const result = { root: siteRoot, base, files: owned.size, bytes: [...owned.values()].reduce((n, f) => n + f.bytes, 0), examples: receipt.examples, platforms: receipt.platforms };
    console.log(JSON.stringify(result));
    return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await buildDocumentSite({ base: process.argv.find(a => a.startsWith('--base='))?.slice(7) });
