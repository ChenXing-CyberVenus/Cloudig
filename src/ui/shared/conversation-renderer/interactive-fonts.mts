export type WorkFont = Readonly<{ family: string; weight: number | string; style?: string; alias: string }>;

/** Google stylesheet declarations are requirements, not permission to use a CDN. */
export function verifyWorkFontRequests(sources: string, fonts: readonly WorkFont[]): void {
  for (const raw of sources.match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^\s"'<>)]*/gu) ?? []) {
    const url = new URL(raw.replaceAll("&amp;", "&"));
    for (const declaration of url.searchParams.getAll("family").flatMap(value => value.split("|"))) {
      const [family, spec] = declaration.split(":");
      const requests: { style: string; minimum: number; maximum: number }[] = [];
      if (!spec) requests.push({ style: "normal", minimum: 400, maximum: 400 });
      else if (spec.includes("@")) {
        const [names, values] = spec.split("@"), axes = names!.split(",");
        for (const tuple of values!.split(";")) {
          const parts = tuple.split(","), weight = parts[axes.indexOf("wght")] ?? "400";
          const [minimum, maximum = minimum] = weight.split("..").map(Number);
          requests.push({ style: parts[axes.indexOf("ital")] === "1" ? "italic" : "normal", minimum: minimum!, maximum: maximum! });
        }
      } else for (const weight of spec.split(",")) {
        const value = Number.parseInt(weight, 10);
        requests.push({ style: /italic|i$/u.test(weight) ? "italic" : "normal", minimum: value, maximum: value });
      }
      for (const request of requests) {
        if (!fonts.some(font => {
          const [minimum, maximum = minimum] = String(font.weight).split(" ").map(Number);
          return font.family === family && (font.style ?? "normal") === request.style && minimum! <= request.minimum && maximum! >= request.maximum;
        })) throw new TypeError(`Font face is not bundled: ${family} ${request.style} ${request.minimum}${request.maximum !== request.minimum ? `–${request.maximum}` : ""}`);
      }
    }
  }
}

export function workFontCss(fonts: readonly WorkFont[]): string {
  return fonts.map(font => `@font-face{font-family:${JSON.stringify(font.family)};font-style:${font.style ?? "normal"};font-weight:${font.weight};font-display:block;src:url("${font.alias}") format("truetype");}`).join("\n");
}
