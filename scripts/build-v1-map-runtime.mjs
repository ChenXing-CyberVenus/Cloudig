import { build } from "esbuild";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export async function analyzeMapRuntime(repository) {
  const metadata = JSON.parse(await readFile(path.join(repository, "node_modules/maplibre-gl/package.json"), "utf8"));
  if (metadata.version !== "6.11.2" || metadata.license !== "BSD-3-Clause") throw new Error("Pinned MapLibre dependency changed");
  const options = { bundle: true, write: false, metafile: true, minify: true, legalComments: "linked", platform: "browser", target: ["chrome120"] };
  const frame = await build({ ...options, format: "esm", entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/map-frame.mts")], outfile: path.join(repository, "tmp/map-analysis/map-frame.js") });
  const worker = await build({ ...options, format: "esm", entryPoints: [path.join(repository, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs")], outfile: path.join(repository, "tmp/map-analysis/map-worker.js") });
  return { frame, worker };
}
export async function buildMapRuntime(repository, output) {
  const { frame, worker } = await analyzeMapRuntime(repository), files = [];
  await mkdir(output, { recursive: true });
  for (const result of [frame, worker]) for (const file of result.outputFiles) {
    await writeFile(path.join(output, path.basename(file.path)), file.contents);
    files.push({ file: path.basename(file.path), bytes: file.contents.length, sha256: createHash("sha256").update(file.contents).digest("hex") });
  }
  await copyFile(path.join(repository, "src/ui/shared/conversation-renderer/map-frame.html"), path.join(output, "map-frame.html"));
  return { files, metafiles: { map_frame: frame.metafile, map_worker: worker.metafile } };
}
