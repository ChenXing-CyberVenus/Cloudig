export const PUBLIC_EXAMPLES_SITE = 'https://chenxing-cybervenus.github.io/Cloudig/';
const idPattern = /^example-[a-f0-9]{20}$/u;
const actions = new Set(['view', 'reader', 'download-html', 'download-json']);

export function publicExampleUrl(id, action = 'view', language = 'zh-CN', theme = 'dawn') {
  if (!idPattern.test(id) || !actions.has(action)) throw new TypeError('Unknown public example route');
  const url = new URL(PUBLIC_EXAMPLES_SITE);
  url.searchParams.set('lang', language === 'en' ? 'en' : 'zh-CN');
  url.searchParams.set('theme', theme === 'star-night' ? 'star-night' : 'dawn');
  url.hash = `platforms/${id}/${action}`;
  return url.href;
}

export function publicExampleRoute(hash) {
  const [topic, id, action = 'view'] = hash.replace(/^#/u, '').split('/');
  return topic === 'platforms' && idPattern.test(id ?? '') && actions.has(action) ? { id, action } : null;
}

export function exampleFileSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid example byte count');
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
