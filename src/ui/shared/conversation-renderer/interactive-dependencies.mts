import manifest from "../../runtime-dependencies/manifest.json" with { type: "json" };
import optional from "../../runtime-dependencies/optional-components.json" with { type: "json" };
import type { InteractiveFile, InteractiveFormat } from "./interactive-protocol.mts";
import { workFontCss, type WorkFont } from "./interactive-fonts.mts";
import { capturedDependencyAliases } from "./dependency-aliases.mts";
import { mapInteractiveAssets, readInteractiveAsset } from "./interactive-assets.mts";
import { previewKind } from "./file-preview-policy.mts";

export async function loadInteractiveDependencies(files: readonly InteractiveFile[], signal: AbortSignal, base: string, format: InteractiveFormat = "html"): Promise<{ files: InteractiveFile[]; fontCss: string }> {
  const sources = files.filter(f => /^(?:text\/|application\/(?:json|xml|javascript|ecmascript))/u.test(f.mime)).map(f => new TextDecoder().decode(f.bytes)).join("\n");
  const components = optional.components.filter(item => item.triggers.some(trigger => sources.includes(trigger)) || item.id==="libmedia-1.3.1"&&format==="document"&&files.some(f=>previewKind(f.path,f.mime)==="video"));
  const fonts = manifest.fonts.filter(font => sources.includes(font.family) || sources.includes(font.family.replaceAll(" ", "+")));
  const allFonts: WorkFont[] = [...fonts, ...components.flatMap<WorkFont>(item => "fonts" in item ? item.fonts ?? [] : [])];
  const requests: { file: string; path: string; mime: string; aliases: readonly string[]; label: string; optional?: boolean }[] = [];
  const supplied = new Set(files.flatMap(file => file.aliases ?? []));
  if (format === "react") {
    requests.push({ file: "react-work.js", path: "__cloudig_dependencies__/react-work.js", mime: "text/javascript", aliases: ["cloudig-runtime:react"], label: "React work runtime" });
  }
  if (format === "document" || format === "design-system" || format === "slides") {
    requests.push({ file: "libraries/document-math.css", path: "__cloudig_dependencies__/document-math.css", mime: "text/css", aliases: ["cloudig-runtime:document-math"], label: "Document math styles and fonts" });
  }
  if (format === "document" && /(?:^|\n)\s*`{3,}mermaid\b/u.test(sources)) {
    requests.push({ file:"document-preview.js",path:"__cloudig_dependencies__/document-preview.js",mime:"text/javascript",aliases:["cloudig-runtime:document-preview"],label:"Document diagrams" });
  }
  if(format==="document"&&files.some(f=>["audio","video"].includes(previewKind(f.path,f.mime)??"")))requests.push({file:"libraries/media-controls.css",path:"__cloudig_dependencies__/media-controls.css",mime:"text/css",aliases:["cloudig-runtime:media-controls-css"],label:"Media control styles"});
  if (format === "document" && files.some(f => /\.(pptx|xlsx|docx|pdf|glb)$/iu.test(f.path) || f.mime === "application/pdf" || f.mime === "model/gltf-binary")) {
    requests.push({ file:"file-preview.js",path:"__cloudig_dependencies__/file-preview.js",mime:"text/javascript",aliases:["cloudig-runtime:file-preview"],label:"File preview" });
    if (files.some(f => /\.pdf$/iu.test(f.path) || f.mime === "application/pdf")) requests.push({ file:"pdf-worker.mjs",path:"__cloudig_dependencies__/pdf-worker.mjs",mime:"text/javascript",aliases:["cloudig-runtime:pdf-worker"],label:"PDF worker" });
  }
  for (const library of manifest.libraries) {
    const aliases = capturedDependencyAliases(sources, library.aliases).filter(alias => !supplied.has(alias));
    if (!aliases.some(alias => sources.includes(alias)) && !("formats" in library && library.formats.includes(format))) continue;
    requests.push({ file: library.file, path: `__cloudig_dependencies__/${library.file}`, mime: "text/javascript", aliases, label: `${library.package} ${library.version}` });
  }
  for (const font of fonts) {
    requests.push({ file: font.file, path: `__cloudig_dependencies__/${font.file}`, mime: "font/ttf", aliases: [font.alias], label: font.family });
  }
  for (const component of components) for (const file of component.files) {
    const aliases = file.aliases.filter(alias => !supplied.has(alias));
    if(!aliases.length)continue;
    // License files are installed alongside the component, but aren't passed
    // to an untrusted work as executable files.
    const bundled = component.delivery === "bundled";
    requests.push({ file: `${bundled ? "components/" : ""}${component.id}/${file.file}`, path: `__cloudig_optional__/${component.id}/${file.file}`, mime: file.mime, aliases, label: component.name, optional: !bundled });
  }
  const dependencies: InteractiveFile[] = await mapInteractiveAssets(requests, signal, async request => {
    const url = new URL(request.file, request.optional ? new URL("../optional/", base).href : base).href;
    const bytes = await readInteractiveAsset(url, signal, async () => { const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`Local dependency is missing: ${request.label}`); return response.arrayBuffer(); });
    return { path: request.path, mime: request.mime, bytes, aliases: [...request.aliases] };
  });
  return { files: dependencies.filter(file => file.aliases?.length), fontCss: workFontCss(allFonts) };
}
