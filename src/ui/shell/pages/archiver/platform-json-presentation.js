// Platform presentation is independent of the source Adapter. Author copy is literal.
export const platformJsonDefinitions = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT', group: 'official', icon: 'platform-chatgpt.svg', available: true },
  { id: 'claude', name: 'Claude', group: 'official', icon: 'platform-claude.svg', available: true },
  { id: 'deepseek', name: 'DeepSeek', group: 'official', icon: 'platform-deepseek.svg', available: true },
  { id: 'grok', name: 'Grok', group: 'official', icon: 'platform-grok.svg', available: true },
  { id: 'qwen', name: 'Qwen', group: 'official', icon: 'platform-qwen.svg', available: true },
  { id: 'mistral', name: 'Mistral', group: 'official', icon: 'platform-mistral.svg', available: true },
  { id: 'cline', name: 'Cline', group: 'agent', icon: 'platform-cline.svg', available: true },
  { id: 'sillytavern', name: 'SillyTavern', group: 'agent', icon: 'platform-sillytavern.svg', available: true },
  { id: 'kimi-code', name: 'Kimi Code', group: 'agent', icon: 'platform-kimi-code.svg', available: true },
  { id: 'claude-code', name: 'Claude Code', group: 'agent', icon: 'platform-claude-code.svg', available: true },
  { id: 'codex', name: 'Codex', group: 'agent', icon: 'platform-codex.svg', available: true }
]);
// User-facing picker instructions must describe the actual file picker and
// ZIPs remain whole Inbox sources. No export-folder import is offered.
export const platformJsonImportGuides = Object.freeze({
  chatgpt: { input: 'zip', file: '*.zip', zh: '选择邮件导出的ZIP，或隐私导出的内层Conversations ZIP。不选隐私总包或Files包；无需解压。', en: 'Choose the email export ZIP or the inner Conversations ZIP from a privacy export. Not the outer privacy bundle or Files ZIP; no extraction needed.' },
  claude: { file: 'conversations.json', zh: '一个文件可包含多篇会话。', en: 'One file can contain multiple conversations.' },
  deepseek: { file: 'conversations.json', zh: '选择会话记录文件，不选 user.json。', en: 'Choose the conversation export, not user.json.' },
  grok: { input: 'zip', file: '*.zip', zh: '选择官方导出的完整ZIP，无需解压。会话和附件从包内读取。', en: 'Choose the complete official ZIP. No extraction needed; conversations and attachments are read from the archive.' },
  qwen: { file: 'chat-export-*.json', zh: '一个文件可包含多篇会话。', en: 'One file can contain multiple conversations.' },
  mistral: { input: 'zip', file: 'chat-export-*.zip', zh: '选择官方导出的完整ZIP，无需解压。包内多篇会话统一列出，可逐篇或批量解析。', en: 'Choose the complete official ZIP without extracting it. Select individual conversations or parse several together.' },
  cline: { file: '*.json', zh: '选择 Cline 导出的 JSON。API 记录与 ui_messages.json 都可直接导入；不选项目目录。', en: 'Choose a Cline JSON export. API records and ui_messages.json are supported; do not select a project folder.' },
  sillytavern: { input: 'jsonl', file: '*.jsonl', zh: '选择 SillyTavern 的聊天 JSONL 文件；每个文件是一篇会话。', en: 'Choose a SillyTavern chat JSONL file; each file is one conversation.' },
  'kimi-code': { input: 'jsonl', file: '*.jsonl', zh: '选择 Kimi Code 的 wire JSONL 文件；每个文件是一篇会话。', en: 'Choose a Kimi Code wire JSONL file; each file is one conversation.' },
  'claude-code': { input: 'jsonl', file: '*.jsonl', zh: '选择 Claude Code 的 session JSONL 文件；每个文件是一篇会话。', en: 'Choose a Claude Code session JSONL file; each file is one conversation.' },
  codex: { input: 'jsonl', file: '*.jsonl', zh: '选择 Codex 的 rollout JSONL 文件。life 分片会作为同一逻辑来源继续合并。', en: 'Choose a Codex rollout JSONL file. life shards will be grouped as one logical source.' }
});
export const platformJsonQuotes = Object.freeze({
  'zh-CN': ['为何“采云”？意义就在深渊与星河之间，在文字与思念之中。', '“慰藉逐渐地来自信息——同时来自真实的和想象的信息。”——赛斯·劳埃德《编程宇宙》'],
  en: ['Why "Cloudig"? Meaning lives between Abyss and Starlight, in words and in thoughts.', '"Consolation has gradually come from information—from bits both real and imagined." — Seth Lloyd, Programming the Universe']
});
const originals = new WeakMap();
export function presentPlatformJson(host, definition, language) {
  if (!definition || definition.id === 'claude') return;
  if (!originals.has(host)) originals.set(host, {
    art: [...host.querySelectorAll('.archiver-claude-title-left')].map(node => [node, node.getAttribute('src')]),
    quotes: [...host.querySelectorAll('.archiver-claude-quote')].map(node => [node, node.innerHTML])
  });
  host.dataset.parserPlatform = definition.id;
  host.querySelector('.archiver-claude-title-left.archiver-theme-dawn').src = '/assets/archiver/TitleDec-Conquer.svg';
  host.querySelector('.archiver-claude-title-left.archiver-theme-star-night').src = '/assets/archiver/TitleDec-Planet.svg';
  for (const [locale, selector] of [['zh-CN', '.archiver-language-zh'], ['en', '.archiver-language-en']]) {
    const quote = host.querySelector(`.archiver-claude-quote${selector}`), strong = host.ownerDocument.createElement('strong');
    strong.textContent = platformJsonQuotes[locale][1];
    quote.replaceChildren(host.ownerDocument.createTextNode(platformJsonQuotes[locale][0]), host.ownerDocument.createElement('br'), strong);
  }
  const title = host.querySelector('[data-claude-title]'), icon = host.ownerDocument.createElement('img'), label = host.ownerDocument.createElement('span');
  icon.src = `/assets/platforms/${definition.icon}`; icon.alt = ''; icon.className = 'archiver-json-title-icon';
  label.textContent = `${definition.name}${language === 'en' ? ' Conversation File Parser' : '会话文件解析'}`;
  title.replaceChildren(icon, label);
}
export function restorePlatformJson(host) {
  const original = originals.get(host);
  if (original) { for (const [node, src] of original.art) node.setAttribute('src', src); for (const [node, html] of original.quotes) node.innerHTML = html; }
  originals.delete(host); delete host.dataset.parserPlatform;
}
