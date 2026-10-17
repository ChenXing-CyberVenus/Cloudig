/** Inert captured native-UI layout, shared by Parser and Reader. This is a
 * source-specific structured Box payload, not another business Schema. No JS,
 * page positioning, URL loads, forms or stylesheet rules are admitted. */
export const NATIVE_LAYOUT_TAGS = new Set(["div", "span", "p", "strong", "b", "em", "i", "small", "br", "hr", "ul", "ol", "li", "h1", "h2", "h3", "h4", "a", "button"]);
const STYLE = /^(?:display|flex(?:-direction|-wrap|-grow|-shrink|-basis)?|align-(?:items|self|content)|justify-(?:content|items|self)|grid-template-columns|grid-column|gap|row-gap|column-gap|width|max-width|min-width|height|min-height|max-height|box-sizing|color|background(?:-color)?|border(?:-(?:radius|width|style|color|top|bottom|left|right))?|box-shadow|(?:padding|margin)(?:-(?:top|right|bottom|left))?|text-align|text-decoration|text-transform|font(?:-size|-weight|-style|-family)?|line-height|letter-spacing|white-space|overflow-wrap|word-break)$/u;
export function nativeLayoutStyle(property: string, value: string): boolean {
  return STYLE.test(property) && !/(?:url\s*\(|expression\s*\(|@|javascript:|[;{}<>])/iu.test(value);
}
