// Author-approved example editing only. Not a Parser or a bookmarklet.
// Explicit input/selection/output; originals and other examples are never written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

export const digest = value => createHash('sha256').update(value).digest('hex');
const inertJson = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
export function readJsonScript(html, id) {
  const at = html.indexOf(`id="${id}"`); assert(at >= 0, `Missing ${id}`);
  const start = html.indexOf('>', at) + 1, end = html.indexOf('</script>', start);
  return { value: JSON.parse(html.slice(start, end)), start, end };
}

export function curateClaudeExample(html, selection, title, sourceFile) {
  const record = readJsonScript(html, 'claude-export-data'), original = record.value;
  // Do not ask a DOM parser to duplicate tens of MB of inert JSON / resource bytes.
  const dom = new JSDOM(html.slice(0, record.start) + html.slice(record.end));
  const document = dom.window.document, manifest = JSON.parse(document.getElementById('ai-chat-archive-manifest').textContent);
  assert.equal(manifest.platform, 'claude');
  const privateIds = [manifest.source?.organization_id, manifest.source?.conversation_id].filter(id => typeof id === 'string' && id.length > 0);
  const privateAddress = value => privateIds.some(id => value.includes(id));
  const all = new Map(original.messages.map(m => [m.id, m])); assert.equal(all.size, original.messages.length);
  assert.equal(new Set(selection).size, selection.length, 'Duplicate selection');
  const selected = selection.map(index => { assert(Number.isInteger(index) && original.messages[index], `Invalid index ${index}`); return original.messages[index]; });
  assert(selected.length, 'Empty example');
  const selectedIds = new Set(selected.map(m => m.id)), parents = new Map(), children = new Map(selected.map(m => [m.id, []])), roots = [];
  for (const message of selected) {
    let parent = message.parent_id, seen = new Set([message.id]);
    while (parent && all.has(parent) && !selectedIds.has(parent)) {
      assert(!seen.has(parent), 'Source cycle'); seen.add(parent); parent = all.get(parent).parent_id;
    }
    parent = selectedIds.has(parent) ? parent : null;
    parents.set(message.id, parent); if (parent) children.get(parent).push(message.id); else roots.push(message.id);
  }
  assert.equal(roots.length, 1, 'Selection must describe one connected curated tree');
  const order = [], visiting = new Set();
  const visit = id => { assert(!visiting.has(id), 'Curated cycle'); visiting.add(id); order.push(id); for (const child of children.get(id)) visit(child); };
  visit(roots[0]); assert.equal(order.length, selected.length);
  const ids = new Map(order.map((id, i) => [id, `example-message-${i + 1}`]));
  const rewriteId = value => {
    let result = value;
    for (const [old, local] of ids) result = result.replaceAll(old, local);
    return result;
  };
  const authored = new Set(['text', 'markdown', 'source', 'code', 'content', 'body', 'summaries', 'description', 'summary', 'title', 'name', 'label', 'file_text', 'widget_code', 'fileText', 'old_str', 'new_str', 'old_string', 'new_string']);
  function rewriteMarkup(html) {
    // Captured display markup: identifiers/attributes only, never author text/code.
    return html.replace(/(<[a-zA-Z][^<>]*\s)([^<>]*?)(>)/gu, tag => tag.replace(/([\w:-]+)=("[^"]*"|'[^']*')/gu, (attr, key, value) =>
      /(?:href|src|url)/iu.test(key) && privateAddress(value) ? '' : /^(?:data-|aria-|id$|href$|for$)/u.test(key) ? `${key}=${rewriteId(value)}` : attr));
  }
  function remap(value, key = '') {
    if (authored.has(key) && (typeof value === 'string' || key === 'summaries')) return value;
    if (Array.isArray(value)) return value.map(item => remap(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [rewriteId(k), remap(v, k)]));
    if (typeof value !== 'string' || value.startsWith('data:')) return value;
    if (/(?:url|endpoint)/iu.test(key) && privateAddress(value)) return '';
    if (/(?:^|_)html$/u.test(key)) return rewriteMarkup(value);
    if (authored.has(key)) return value;
    return rewriteId(value);
  }
  const newParents = Object.fromEntries(order.map(id => [ids.get(id), ids.get(parents.get(id)) ?? null]));
  const newChildren = Object.fromEntries(order.map(id => [ids.get(id), children.get(id).map(child => ids.get(child))]));
  const pathTo = id => { const result = []; for (let cursor = id; cursor; cursor = newParents[cursor]) { assert(!result.includes(cursor)); result.unshift(cursor); } return result; };
  let oldCurrent = original.current_leaf_message_id;
  while (all.has(oldCurrent) && !selectedIds.has(oldCurrent)) oldCurrent = all.get(oldCurrent).parent_id;
  oldCurrent = selectedIds.has(oldCurrent) ? oldCurrent : order.at(-1);
  while (children.get(oldCurrent).length) oldCurrent = children.get(oldCurrent).at(-1);
  const current = ids.get(oldCurrent), active = pathTo(current), leaves = order.filter(id => !children.get(id).length).map(id => ids.get(id));
  const tree = original.format.includes('all-branches');
  if (!tree) assert.equal(leaves.length, 1, 'Linear example cannot silently lose a branch');

  const payload = structuredClone(original);
  for (const key of ['http_capture', 'raw_conversation', 'mounted_dom_articles', 'tree_probe']) delete payload[key];
  payload.messages = order.map((id, index) => ({ ...remap(all.get(id)), id: ids.get(id), parent_id: newParents[ids.get(id)], index }));
  payload.resources = (original.resources ?? []).filter(r => selectedIds.has(r.message_id)).map(r => remap(r));
  payload.artifacts = (original.artifacts ?? []).filter(r => selectedIds.has(r.message_id)).map(r => remap(r));
  payload.source_url = ''; payload.conversation = { ...payload.conversation, id: `example-${title}`, title };
  payload.current_leaf_message_id = current; payload.active_message_ids = active; payload.raw_tree_count = order.length;
  const branches = leaves.map((id, i) => ({ id: `branch-${i + 1}`, root_message_id: ids.get(roots[0]), leaf_message_id: id, is_current: id === current, is_terminal: true, message_ids: pathTo(id) }));
  const topology = { root_ids: roots.map(id => ids.get(id)), orphan_root_ids: [], children_by_id: newChildren, navigation_root_ids: roots.map(id => ids.get(id)), navigation_children_by_id: newChildren,
    message_order: order.map(id => ids.get(id)), terminal_leaf_ids: leaves, current_path_message_ids: active, current_is_terminal: true,
    branch_message_occurrences: branches.reduce((sum, b) => sum + b.message_ids.length, 0), fork_points: Object.values(newChildren).filter(c => c.length > 1).length, max_depth: Math.max(...branches.map(b => b.message_ids.length)) };
  if (tree) { payload.branches = branches; payload.tree_topology = topology; }
  else { delete payload.branches; delete payload.tree_topology; delete payload.branch_navigation; }

  const articleMap = new Map([...document.querySelectorAll('article.turn[data-message-id]')].map(a => [a.dataset.messageId, a]));
  for (const id of order) assert(articleMap.has(id), `Missing readable article for selected node ${id}`);
  const container = tree ? document.querySelector('.conversation-tree') : document.querySelector('main');
  assert(container);
  const nodeTemplate = document.querySelector('.tree-node')?.cloneNode(false), groupTemplate = document.querySelector('.node-branch-group')?.cloneNode(false), optionTemplate = document.querySelector('.node-branch-option')?.cloneNode(false);
  const navTemplates = new Map(['user', 'assistant'].map(role => [role, document.querySelector(`.node-branch-nav.${role}`)?.cloneNode(true)]));
  const articles = new Map();
  for (const id of order) {
    const article = articleMap.get(id); article.remove();
    for (const element of [article, ...article.querySelectorAll('*')]) for (const attr of [...element.attributes]) {
      if (/(?:href|src|url)/iu.test(attr.name) && privateAddress(attr.value)) element.removeAttribute(attr.name);
      else if (/^(?:data-|aria-|id$|href$|for$)/u.test(attr.name)) element.setAttribute(attr.name, rewriteId(attr.value));
    }
    article.dataset.messageId = ids.get(id); articles.set(ids.get(id), article);
  }
  for (const article of articleMap.values()) article.remove();
  if (tree) {
    const activeSet = new Set(active);
    const buildNode = (id, parent, siblings) => {
      assert(nodeTemplate); const node = nodeTemplate.cloneNode(false), article = articles.get(id); node.dataset.treeMessageId = id; node.removeAttribute('hidden'); node.append(article);
      if (siblings.length > 1) {
        const role = article.classList.contains('user') ? 'user' : 'assistant';
        const template = navTemplates.get(role) ?? [...navTemplates.values()].find(Boolean); assert(template, 'Missing native branch controls');
        const nav = template.cloneNode(true), position = siblings.indexOf(id) + 1; nav.classList.remove('user', 'assistant'); nav.classList.add(role);
        Object.assign(nav.dataset, { parentMessageId: parent ?? '', position: String(position), total: String(siblings.length), allowEmpty: 'false' });
        nav.querySelector('span').textContent = `${position} / ${siblings.length}`;
        for (const button of nav.querySelectorAll('button[data-delta]')) { const next = position + Number(button.dataset.delta); button.disabled = next < 1 || next > siblings.length; }
        node.append(nav);
      }
      node.append(...buildChildren(id)); return node;
    };
    const buildChildren = parent => {
      const list = parent ? newChildren[parent] : topology.root_ids;
      if (!list.length) return [];
      if (list.length === 1) return [buildNode(list[0], parent, list)];
      assert(groupTemplate && optionTemplate); const group = groupTemplate.cloneNode(false), chosen = list.find(id => activeSet.has(id)) ?? list[0];
      group.dataset.parentMessageId = parent ?? ''; group.dataset.selectedChildId = chosen;
      for (const id of list) {
        const option = optionTemplate.cloneNode(false); option.dataset.childMessageId = id; option.hidden = id !== chosen; option.setAttribute('aria-hidden', String(id !== chosen));
        if (id === chosen) option.setAttribute('aria-current', 'true'); else option.removeAttribute('aria-current');
        option.append(buildNode(id, parent, list)); group.append(option);
      }
      return [group];
    };
    container.replaceChildren(...buildChildren(null));
    const navigation = document.getElementById('claude-branch-navigation'); assert(navigation);
    navigation.textContent = inertJson({ format: 'osis.claude.branch-navigation/v1', root_ids: topology.root_ids, children_by_id: newChildren, current_path_message_ids: active });
  } else container.append(...order.map(id => articles.get(ids.get(id))));

  // Keep only byte-pool entries reachable from the retained messages/resources/DOM.
  if (payload.resource_data) {
    const referenced = new Set();
    const refs = (value, key = '') => {
      if (Array.isArray(value)) { value.forEach(v => refs(v, key)); return; }
      if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) if (k !== 'resource_data') refs(v, k); return; }
      if (typeof value !== 'string' || value.startsWith('data:')) return;
      if (key.endsWith('_ref')) referenced.add(value);
      if (value.includes('data-osis-data-')) for (const match of value.matchAll(/data-osis-data-(?:src|href)=["']([^"']+)["']/gu)) referenced.add(match[1]);
    };
    refs(payload); for (const element of document.querySelectorAll('[data-osis-data-src],[data-osis-data-href]')) referenced.add(element.getAttribute('data-osis-data-src') ?? element.getAttribute('data-osis-data-href'));
    for (const id of referenced) assert(typeof payload.resource_data[id] === 'string', `Dangling resource data ${id}`);
    payload.resource_data = Object.fromEntries(Object.entries(payload.resource_data).filter(([id]) => referenced.has(id)));
  }
  // Recalculate facts; original full-capture totals/raw transport do not describe a cut.
  const blocks = payload.messages.flatMap(m => m.blocks ?? []), countType = type => blocks.filter(b => b.type === type).length;
  const counts = { messages: order.length, user: payload.messages.filter(m => m.role === 'user').length, assistant: payload.messages.filter(m => m.role === 'assistant').length,
    thinking: countType('thinking'), tool_use: countType('tool_use'), tool_result: countType('tool_result'),
    sources: blocks.filter(b => b.type === 'tool_result').reduce((n, b) => n + (b.sources?.length ?? 0), 0), citations: blocks.reduce((n, b) => n + (b.citations?.length ?? 0), 0),
    attachments: payload.messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0), resource_variants: payload.resources.length,
    embedded_resources: payload.resources.filter(r => /^embedded/u.test(r.status ?? '') || r.data_url || r.data_ref).length, failed_resources: payload.resources.filter(r => r.status === 'unavailable').length,
    artifacts: payload.artifacts.length, cowork_page_tools: payload.messages.reduce((n, m) => n + (m.cowork_page_tools?.length ?? 0), 0),
    ...(tree ? { tree_nodes: order.length, branch_paths: branches.length, terminal_leaves: leaves.length, roots: roots.length, fork_points: topology.fork_points, max_depth: topology.max_depth, current_branch_messages: active.length, branch_message_occurrences: topology.branch_message_occurrences } : {}) };
  const diagnostics = (manifest.capture_diagnostics?.entries ?? []).filter(e => !e.message_id || selectedIds.has(e.message_id)).map(e => remap(e));
  manifest.source = { ...manifest.source, url: '', title, conversation_id: payload.conversation.id }; delete manifest.source.organization_id;
  manifest.current_leaf_message_id = current; manifest.counts = counts;
  manifest.capture = { data_source: 'curated-platform-example', complete: manifest.capture?.complete === true, diagnostics_count: diagnostics.length, full_tree_structure_validated: tree };
  delete manifest.raw_scope; delete manifest.resource_summary;
  if (manifest.capture_diagnostics) manifest.capture_diagnostics.entries = diagnostics;
  manifest.sample_derivation = { format: 'cloudig/platform-example-v1', notice: '本范例经过精简，仅保留与格式相关的轮次', source_file: sourceFile, source_sha256: digest(html), source_messages: original.messages.length,
    selected_messages: order.length, retained_turn_contract: 'selected_message_content_preserved; local_message_ids_and_tree_rebuilt; private_account_addresses_removed', tree_strategy: tree ? 'local-numbered-curated-tree' : 'local-numbered-curated-sequence' };
  document.title = title; document.querySelector('header.top h1').textContent = title;
  const meta = document.querySelector('header.top .meta'); meta.textContent = `${tree ? `${branches.length} 个分支 · ` : ''}${order.length} 条消息${payload.conversation.model ? ` · 当前选择模型：${payload.conversation.model}` : ''}`;
  const notice = document.createElement('p'); notice.className = 'meta'; notice.textContent = manifest.sample_derivation.notice; meta.after(notice);
  document.getElementById('claude-export-data').textContent = inertJson(payload); document.getElementById('ai-chat-archive-manifest').textContent = inertJson(manifest);
  const output = '<!doctype html>\n' + document.documentElement.outerHTML + '\n'; dom.window.close();
  return { html: output, evidence: { title, version: payload.version, input_sha256: digest(html), output_sha256: digest(output), counts, paths: branches.map(b => b.message_ids), current, id_map: Object.fromEntries(ids), source_indices: order.map(id => original.messages.indexOf(all.get(id))) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [planFile, outputRoot] = process.argv.slice(2); assert(planFile && outputRoot, 'Usage: node curate-claude-example.mjs <private-plan.json> <output-directory>');
  const plan = JSON.parse(await readFile(planFile, 'utf8')); await mkdir(outputRoot, { recursive: true });
  const evidence = [];
  for (const entry of plan.examples) {
    assert.equal(path.basename(entry.output), entry.output); assert(entry.output.startsWith('Claude-') && entry.output.endsWith('.html'));
    const input = await readFile(entry.input, 'utf8'); assert.equal(digest(input), entry.sha256, 'Source changed after selection');
    const result = curateClaudeExample(input, entry.selection, entry.output.slice(0, -5), path.basename(entry.input));
    await writeFile(path.join(outputRoot, entry.output), result.html); evidence.push({ ...result.evidence, output: entry.output });
    console.log(`${entry.output}: ${result.evidence.counts.messages} nodes / ${result.evidence.paths.length} paths / ${Buffer.byteLength(result.html)} bytes`);
  }
  await writeFile(path.join(outputRoot, 'curation-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
