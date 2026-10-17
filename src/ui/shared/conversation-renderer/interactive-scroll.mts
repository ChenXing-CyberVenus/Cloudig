/** Copy the host rules, never a second hardcoded colour/width table. */
export function interactiveScrollCss(document: Document): string {
  const scan = (rules: CSSRuleList): string => [...rules].map(rule => {
    if ("selectorText" in rule) return String(rule.selectorText).includes("[data-scroll-region]") ? rule.cssText : "";
    if ("cssRules" in rule) {
      const content = scan((rule as CSSGroupingRule).cssRules); if (!content) return "";
      return `${rule.cssText.slice(0, rule.cssText.indexOf("{"))}{${content}}`;
    }
    return "";
  }).join("\n");
  const css = [...document.styleSheets].map(sheet => { try { return scan(sheet.cssRules); } catch { return ""; } }).join("\n");
  const style = document.defaultView!.getComputedStyle(document.documentElement);
  const tokens = ["--cloudig-scroll-idle", "--cloudig-scroll-active"].map(name => `${name}:${style.getPropertyValue(name).trim()};`).join("");
  return `:root{${tokens}}\n${css}`;
}

/** First-declared layer: every authored rule (including its own layers) wins.
 * Universal selectors also cover elements created after load by source scripts. */
export function interactiveScrollFallback(css: string): string {
  return `@layer cloudig-work-scroll-default{\n${css.replaceAll("[data-scroll-region]", ":where(*)")}\n}`;
}
