export type WorkFont = Readonly<{ family: string; weight: number | string; style?: string; alias: string; variation?: string; format?: string }>;

// Advertise actual bundled faces. CSS matching selects a nearby supported
// weight or the author's fallback family; font availability never blocks an app.
export function workFontCss(fonts: readonly WorkFont[]): string {
  return fonts.map(font => `@font-face{font-family:${JSON.stringify(font.family)};font-style:${font.style ?? "normal"};font-weight:${font.weight};${font.variation ? `font-variation-settings:${font.variation};` : ""}font-display:block;src:url("${font.alias}") format("${font.format ?? "truetype"}");}`).join("\n");
}
