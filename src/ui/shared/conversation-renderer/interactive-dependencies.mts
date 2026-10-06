import manifest from "../../runtime-dependencies/manifest.json" with { type: "json" };
import type { InteractiveFile, InteractiveFormat } from "./interactive-protocol.mts";
import { verifyWorkFontRequests, workFontCss } from "./interactive-fonts.mts";
import { mapInteractiveAssets, readInteractiveAsset } from "./interactive-assets.mts";

export async function loadInteractiveDependencies(files: readonly InteractiveFile[], signal: AbortSignal, base: string, format: InteractiveFormat = "html"): Promise<{ files: InteractiveFile[]; fontCss: string }> {
  const sources = files.filter(f => /^(?:text\/|application\/(?:json|xml|javascript|ecmascript))/u.test(f.mime)).map(f => new TextDecoder().decode(f.bytes)).join("\n");
  const fonts = manifest.fonts.filter(font => sources.includes(font.family) || sources.includes(font.family.replaceAll(" ", "+")));
  verifyWorkFontRequests(sources, fonts);
  const requests: { file: string; path: string; mime: string; aliases: readonly string[]; label: string }[] = [];
  if (format === "react") {
    requests.push({ file: "react-work.js", path: "__cloudig_dependencies__/react-work.js", mime: "text/javascript", aliases: ["cloudig-runtime:react"], label: "React work runtime" });
  }
  for (const library of manifest.libraries.filter(item => item.aliases.some(alias => sources.includes(alias)) || "formats" in item && item.formats.includes(format))) {
    requests.push({ file: library.file, path: `__cloudig_dependencies__/${library.file}`, mime: "text/javascript", aliases: library.aliases, label: `${library.package} ${library.version}` });
  }
  for (const font of fonts) {
    requests.push({ file: font.file, path: `__cloudig_dependencies__/${font.file}`, mime: "font/ttf", aliases: [font.alias], label: font.family });
  }
  const dependencies: InteractiveFile[] = await mapInteractiveAssets(requests, signal, async request => {
    const url = new URL(request.file, base).href;
    const bytes = await readInteractiveAsset(url, signal, async () => { const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`Local dependency is missing: ${request.label}`); return response.arrayBuffer(); });
    return { path: request.path, mime: request.mime, bytes, aliases: [...request.aliases] };
  });
  return { files: dependencies, fontCss: workFontCss(fonts) };
}
