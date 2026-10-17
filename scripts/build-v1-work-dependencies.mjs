import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

export async function analyzeReactWorkBundle(repository) {
  return build({ entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/interactive-react.mts")],
    bundle: true, write: false, metafile: true, format: "iife", globalName: "CloudigReactWork",
    outfile: path.join(repository, "tmp/interactive-react-analysis/react-work.js"),
    platform: "browser", target: ["chrome120"], minify: true, legalComments: "linked",
    define: { "process.env.NODE_ENV": '"production"' } });
}

/** Copy only the pinned browser distributions used by saved works, not whole packages. */
export async function buildWorkDependencies(repository, output) {
  const root = path.join(repository, "src/ui/runtime-dependencies");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  await mkdir(output, { recursive: true });
  // The manifest is the shipping set; superseded development fonts are not payload.
  const assets = new Set(["manifest.json", ...manifest.fonts.flatMap(font => [font.file, font.license]),
    ...manifest.license_supplements.map(license => license.file)]);
  for (const file of assets) {
    const bytes = await readFile(path.join(root, file)), font = manifest.fonts.find(font => font.file === file);
    if (font && createHash("sha256").update(bytes).digest("hex") !== font.sha256) throw new Error(`Work font byte drift: ${file}`);
    const target = path.join(output, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  const result = [];
  for (const library of manifest.libraries) {
    const packageRoot = path.join(repository, "node_modules", library.package);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== library.package || metadata.version !== library.version) throw new Error(`Work dependency version drift: ${library.package}`);
    const bytes = await readFile(path.join(packageRoot, library.package_file));
    if (createHash("sha256").update(bytes).digest("hex") !== library.sha256) throw new Error(`Work dependency byte drift: ${library.file}`);
    const target = path.join(output, library.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    result.push({ file: library.file, bytes: bytes.length, sha256: library.sha256 });
  }
  const react = await analyzeReactWorkBundle(repository);
  for (const file of react.outputFiles) {
    await writeFile(path.join(output, path.basename(file.path)), file.contents);
    result.push({ file: path.basename(file.path), bytes: file.contents.length, sha256: createHash("sha256").update(file.contents).digest("hex") });
  }
  return { files: result, metafile: react.metafile };
}
