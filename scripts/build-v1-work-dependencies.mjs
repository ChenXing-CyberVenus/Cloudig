import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { buildBundledWorkComponents } from "./build-v1-work-components.mjs";

export async function analyzeReactWorkBundle(repository) {
  return build({ entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/interactive-react.mts")],
    bundle: true, write: false, metafile: true, format: "iife", globalName: "CloudigReactWork",
    outfile: path.join(repository, "tmp/interactive-react-analysis/react-work.js"),
    platform: "browser", target: ["chrome120"], minify: true, legalComments: "linked",
    define: { "process.env.NODE_ENV": '"production"' } });
}

export async function analyzeFilePreviewBundle(repository) {
  return build({entryPoints:[path.join(repository,"src/ui/shared/conversation-renderer/file-preview-client.mts")],bundle:true,write:false,metafile:true,
    format:"iife",globalName:"CloudigFilePreview",outfile:path.join(repository,"tmp/file-preview-analysis/file-preview.js"),platform:"browser",target:["chrome120"],minify:true,legalComments:"linked",
    define:{"process.env.NODE_ENV":'"production"'}});
}

export async function analyzeDocumentPreviewBundle(repository) {
  return build({entryPoints:[path.join(repository,"src/ui/shared/conversation-renderer/document-preview.mts")],bundle:true,write:false,metafile:true,
    format:"iife",globalName:"CloudigDocumentPreview",outfile:path.join(repository,"tmp/document-preview-analysis/document-preview.js"),platform:"browser",target:["chrome120"],minify:true,legalComments:"linked"});
}

/** Copy only the pinned browser distributions used by saved works, not whole packages. */
export async function buildWorkDependencies(repository, output) {
  const root = path.join(repository, "src/ui/runtime-dependencies");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  await mkdir(output, { recursive: true });
  // The manifest is the shipping set; superseded development fonts are not payload.
  const assets = new Set(["manifest.json", "optional-components.json", ...manifest.fonts.flatMap(font => [font.file, font.license]),
    ...manifest.license_supplements.map(license => license.file)]);
  for (const file of assets) {
    const bytes = await readFile(path.join(root, file)), font = manifest.fonts.find(font => font.file === file);
    if (font && createHash("sha256").update(bytes).digest("hex") !== font.sha256) throw new Error(`Work font byte drift: ${file}`);
    const target = path.join(output, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  const components = JSON.parse(await readFile(path.join(root, "optional-components.json"), "utf8"));
  const result = await buildBundledWorkComponents(repository, output, components);
  // A generated document uses the same KaTeX renderer as conversation prose.
  // Ship its stylesheet with WOFF2 bytes inline: no cross-origin font requests
  // or broader sandbox permissions are needed in the work's isolated origin.
  const mathRoot = path.join(repository, "node_modules/katex/dist");
  let mathCss = await readFile(path.join(mathRoot, "katex.min.css"), "utf8");
  const fontSources = [...mathCss.matchAll(/src:([^;}]+)/g)];
  for (const match of fontSources) {
    const font = /url\(([^)]+\.woff2)\)\s*format\(["']woff2["']\)/.exec(match[1]);
    if (!font) throw new Error("KaTeX font has no WOFF2 source");
    const bytes = await readFile(path.join(mathRoot, font[1]));
    mathCss = mathCss.replace(match[0], `src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")`);
  }
  await mkdir(path.join(output, "libraries"), { recursive: true });
  await writeFile(path.join(output, "libraries/document-math.css"), mathCss);
  // Same owned stylesheet as the Reader's external bundle. The main page
  // forbids inline styles; the isolated document receives its pinned copy.
  const mediaCss=await readFile(path.join(repository,"src/ui/shared/conversation-renderer/media-controls.css"));
  await writeFile(path.join(output,"libraries/media-controls.css"),mediaCss);
  result.push({file:"libraries/media-controls.css",bytes:mediaCss.length,sha256:createHash("sha256").update(mediaCss).digest("hex")});
  result.push({ file: "libraries/document-math.css", bytes: Buffer.byteLength(mathCss), sha256: createHash("sha256").update(mathCss).digest("hex") });
  for (const library of manifest.libraries) {
    const packageRoot = path.join(repository, "node_modules", library.install_as ?? library.package);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== library.package || metadata.version !== library.version) throw new Error(`Work dependency version drift: ${library.package}`);
    let bytes = await readFile(path.join(packageRoot, library.package_file));
    if (createHash("sha256").update(bytes).digest("hex") !== library.sha256) throw new Error(`Work dependency byte drift: ${library.file}`);
    if (library.bridge === "three-legacy-controls") {
      // Three removed its legacy controls distribution. Bridge the SAME
      // revision's official module to the captured global THREE namespace.
      // Neither the work nor its original Three source is rewritten.
      const names = /import\s*\{([^}]+)\}\s*from 'three';/u.exec(bytes.toString("utf8"))?.[1].split(",").map(value => value.trim()).filter(Boolean);
      if (!names?.length || names.some(name => !/^[A-Za-z][A-Za-z0-9]*$/u.test(name))) throw new Error("Unexpected Three controls imports");
      const compiled = await build({ stdin: { contents: `import {OrbitControls} from ${JSON.stringify("./" + library.package_file)}; if(globalThis.THREE?.REVISION!==${JSON.stringify(library.version.split(".")[1])})throw new Error("OrbitControls needs matching Three revision"); globalThis.THREE.OrbitControls=OrbitControls;`, resolveDir: packageRoot }, bundle:true, write:false, format:"iife", target:"chrome120", minify:true,
        plugins:[{name:"captured-three",setup(builder){builder.onResolve({filter:/^three$/},()=>({path:"three",namespace:"captured"}));builder.onLoad({filter:/.*/,namespace:"captured"},()=>({contents:names.map(name=>`export const ${name}=globalThis.THREE.${name};`).join("\n"),loader:"js"}));}}] });
      bytes = Buffer.from(compiled.outputFiles[0].contents);
    }
    const target = path.join(output, library.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    result.push({ file: library.file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const react = await analyzeReactWorkBundle(repository);
  const preview = await analyzeFilePreviewBundle(repository);
  const documentPreview = await analyzeDocumentPreviewBundle(repository);
  for(const file of documentPreview.outputFiles){await writeFile(path.join(output,path.basename(file.path)),file.contents);result.push({file:path.basename(file.path),bytes:file.contents.length,sha256:createHash("sha256").update(file.contents).digest("hex")});}
  for(const file of preview.outputFiles){await writeFile(path.join(output,path.basename(file.path)),file.contents);result.push({file:path.basename(file.path),bytes:file.contents.length,sha256:createHash("sha256").update(file.contents).digest("hex")});}
  const pdfWorker=await readFile(path.join(repository,"node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"));
  await writeFile(path.join(output,"pdf-worker.mjs"),pdfWorker);result.push({file:"pdf-worker.mjs",bytes:pdfWorker.length,sha256:createHash("sha256").update(pdfWorker).digest("hex")});
  for (const icons of manifest.icons ?? []) {
    const packageRoot=path.join(repository,"node_modules",icons.package);
    const metadata=JSON.parse(await readFile(path.join(packageRoot,"package.json"),"utf8"));
    if(metadata.version!==icons.version)throw new Error(`Icon dependency version drift: ${icons.package}`);
    const catalog={};
    for(const style of ["outline","filled"]){
      const directory=path.join(packageRoot,"icons",style);
      for(const name of (await readdir(directory)).filter(n=>/^[a-z0-9-]+\.svg$/.test(n)).sort())
        catalog[`${style}/${name}`]=await readFile(path.join(directory,name),"utf8");
    }
    const bytes=Buffer.from(JSON.stringify(catalog)+"\n"),target=path.join(output,icons.file);
    await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
    result.push({file:icons.file,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
  }
  for (const file of react.outputFiles) {
    await writeFile(path.join(output, path.basename(file.path)), file.contents);
    result.push({ file: path.basename(file.path), bytes: file.contents.length, sha256: createHash("sha256").update(file.contents).digest("hex") });
  }
  return { files: result, metafile: react.metafile };
}
