import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const temporaryRoot = path.join(process.cwd(), "tmp");
await mkdir(temporaryRoot, { recursive: true });
const output = await mkdtemp(path.join(temporaryRoot, "cloudig-renderer-build-"));

async function inventory(root) {
  const rows = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else rows.push({ path: path.relative(root, absolute).replaceAll("\\", "/"), bytes: (await stat(absolute)).size });
    }
  }
  await walk(root);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

try {
  const result = await build({
    entryPoints: [path.join(process.cwd(), "src/ui/shared/conversation-renderer/browser-entry.mts")],
    bundle: true,
    outdir: output,
    entryNames: "conversation-renderer",
    assetNames: "assets/[name]-[hash]",
    format: "iife",
    globalName: "CloudigConversationRenderer",
    legalComments: "linked",
    loader: {
      ".ttf": "file",
      ".woff": "file",
      ".woff2": "file"
    },
    metafile: true,
    minify: false,
    platform: "browser",
    sourcemap: false,
    target: ["chrome120"]
  });
  const files = await inventory(output);
  if (!files.some((entry) => entry.path === "conversation-renderer.js")) throw new TypeError("Renderer bundle omitted JavaScript");
  if (!files.some((entry) => entry.path === "conversation-renderer.css")) throw new TypeError("Renderer bundle omitted CSS");
  if (!files.some((entry) => /\.woff2$/u.test(entry.path))) throw new TypeError("Renderer bundle omitted local KaTeX fonts");
  const external = Object.keys(result.metafile?.inputs ?? {}).filter((entry) => /^https?:/iu.test(entry));
  if (external.length > 0) throw new TypeError("Renderer bundle depends on remote inputs");
  console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), outputs: files }));
} finally {
  await rm(output, { recursive: true, force: true });
}
