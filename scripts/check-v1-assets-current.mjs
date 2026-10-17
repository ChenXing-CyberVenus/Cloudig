import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveWorkspacePath(workspaceRoot, relativePath) {
  return path.join(workspaceRoot, ...relativePath.split("/"));
}

export async function checkV1AssetsCurrent({ repository = process.cwd() } = {}) {
  const workspaceRoot = path.resolve(repository, "..");
  const assetRoot = path.join(repository, "src", "ui", "assets");
  const manifest = JSON.parse(await readFile(path.join(assetRoot, "asset-sources.json"), "utf8"));
  assert.equal(manifest.schema, "cloudig/asset-sources/1.0.0");

  for (const asset of manifest.assets) {
    const source = await readFile(resolveWorkspacePath(workspaceRoot, asset.source));
    assert.equal(
      sha256(source),
      asset.source_sha256,
      `Formal asset source changed without a derived production update: ${asset.source}`
    );

    const output = await readFile(resolveWorkspacePath(assetRoot, asset.output));
    assert.equal(
      sha256(output),
      asset.output_sha256,
      `Production asset does not match its derivation manifest: ${asset.output}`
    );

    if (asset.motion_source) {
      const motion = await readFile(resolveWorkspacePath(workspaceRoot, asset.motion_source));
      assert.equal(sha256(motion), asset.motion_sha256, `Animation source changed without rebuilding: ${asset.motion_source}`);
    }

    if (asset.upstream && asset.upstream_sha256) {
      const upstreamPaths = asset.upstream.split(" + ");
      const upstreamHashes = asset.upstream_sha256.split("+");
      assert.equal(upstreamPaths.length, upstreamHashes.length, `Invalid upstream manifest entry: ${asset.output}`);
      for (let index = 0; index < upstreamPaths.length; index += 1) {
        const upstreamPath = upstreamPaths[index].includes("/")
          ? upstreamPaths[index]
          : `${path.posix.dirname(upstreamPaths[0])}/${upstreamPaths[index]}`;
        const upstream = await readFile(resolveWorkspacePath(workspaceRoot, upstreamPath));
        assert.equal(
          sha256(upstream),
          upstreamHashes[index],
          `Formal upstream asset changed without an accepted derivative update: ${upstreamPath}`
        );
      }
    }
  }

  return { assets: manifest.assets.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await checkV1AssetsCurrent({ repository: path.dirname(path.dirname(fileURLToPath(import.meta.url))) });
  console.log(JSON.stringify(result));
}
