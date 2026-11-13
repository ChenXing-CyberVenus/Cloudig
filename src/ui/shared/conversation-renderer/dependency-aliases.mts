/** Minified/unminified spellings of a registered, versioned CDN file have the
 * same entry API. Never erase a package version, build suffix or module query. */
function key(value: string): string | undefined {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    if (url.protocol !== "https:" || !["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"].includes(url.hostname)) return;
    url.pathname = url.pathname.replace(/\.min(?=\.(?:js|mjs|cjs)$)/u, "");
    return url.href;
  } catch { return; }
}

export function capturedDependencyAliases(sources: string, aliases: readonly string[]): string[] {
  const registered = new Set(aliases.map(key).filter(Boolean)), result = [...aliases];
  for (const raw of sources.match(/https:\/\/[^\s"'<>`\\)]+/gu) ?? []) {
    const candidate = key(raw); if (!candidate || !registered.has(candidate)) continue;
    const url = raw.replaceAll("&amp;", "&"); if (!result.includes(url)) result.push(url);
  }
  return result;
}
