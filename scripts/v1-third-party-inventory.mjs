#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { analyzeReactWorkBundle } from "./build-v1-work-dependencies.mjs";
import { analyzeMapRuntime } from "./build-v1-map-runtime.mjs";

export const V1_THIRD_PARTY_INVENTORY = "cloudig/third-party-inventory/1.0.0";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const licenseName = /^(?:license|licence|copying|notice)(?:[-_.].*|$)/iu;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRepository(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.url === "string") return value.url;
  return null;
}

async function packageRootForInput(repository, input) {
  let directory = path.dirname(path.resolve(repository, input));
  const boundary = path.resolve(repository);
  while (directory.startsWith(boundary) && directory !== boundary) {
    const packageFile = path.join(directory, "package.json");
    if (directory.includes(`${path.sep}node_modules${path.sep}`) && existsSync(packageFile)) {
      const value = JSON.parse(await readFile(packageFile, "utf8"));
      if (value.name && value.version) return { directory, value };
    }
    directory = path.dirname(directory);
  }
  return null;
}

async function licenseTexts(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (names.length > 0) {
    return Promise.all(names.map(async (name) => {
      const bytes = await readFile(path.join(directory, name));
      return { name, bytes: bytes.byteLength, sha256: sha256(bytes), text: bytes.toString("utf8").trim() };
    }));
  }
  const readmeName = (await readdir(directory)).find((name) => /^readme(?:\.|$)/iu.test(name));
  if (!readmeName) return [];
  const readme = await readFile(path.join(directory, readmeName), "utf8");
  const match = readme.match(/(?:^|\n)##\s+License\s*\r?\n([\s\S]+)$/iu);
  if (!match?.[1] || !/permission is hereby granted/iu.test(match[1])) return [];
  const text = match[1].trim();
  const bytes = Buffer.from(text, "utf8");
  return [{ name: `${readmeName}#License`, bytes: bytes.byteLength, sha256: sha256(bytes), text }];
}

export async function analyzeV1BundleMetafiles(repository = defaultRoot) {
  const engine = await build({
    entryPoints: [path.join(repository, "src", "engine", "main.mts")],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    target: ["node20.19"]
  });
  const parserWorker = await build({
    entryPoints: [path.join(repository, "src/app/parser/record-worker-entry.mts")],
    bundle: true, write: false, metafile: true,
    format: "esm", platform: "node", target: ["node20.19"]
  });
  const renderer = await build({
    entryPoints: [path.join(repository, "src", "ui", "shared", "conversation-renderer", "browser-entry.mts")],
    bundle: true,
    write: false,
    metafile: true,
    outdir: path.join(repository, "tmp", "v1-license-analysis"),
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    loader: { ".ttf": "file", ".woff": "file", ".woff2": "file" }
  });
  const mermaidLayout = await build({
    entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/mermaid-frame.mts")],
    bundle: true, write: false, metafile: true,
    format: "iife", platform: "browser", target: ["chrome120"]
  });
  const interactiveFrame = await build({
    entryPoints: [path.join(repository, "src/ui/shared/conversation-renderer/interactive-frame.mts")],
    bundle: true, write: false, metafile: true,
    format: "iife", platform: "browser", target: ["chrome120"]
  });
  // Match the actual desktop bundles, including isolated worker/frame
  // entry points that are intentionally absent from the main bundles.
  const interactiveReact = await analyzeReactWorkBundle(repository);
  const mapRuntime = await analyzeMapRuntime(repository);
  return { engine: engine.metafile, parser_worker: parserWorker.metafile, renderer: renderer.metafile, mermaid_layout: mermaidLayout.metafile, interactive_frame: interactiveFrame.metafile, interactive_react: interactiveReact.metafile, map_frame: mapRuntime.frame.metafile, map_worker: mapRuntime.worker.metafile };
}

async function npmInventory(repository, metafiles) {
  const packages = new Map();
  for (const [consumer, metafile] of Object.entries(metafiles)) {
    for (const input of Object.keys(metafile.inputs)) {
      const found = await packageRootForInput(repository, input);
      if (!found) continue;
      const key = `${found.value.name}@${found.value.version}`;
      const existing = packages.get(key) ?? {
        name: found.value.name,
        version: found.value.version,
        declared_license: found.value.license ?? null,
        repository: normalizeRepository(found.value.repository),
        consumers: new Set(),
        directory: found.directory
      };
      existing.consumers.add(consumer);
      packages.set(key, existing);
    }
  }
  // These distributions execute only in the work sandbox and are deliberately
  // absent from the main UI bundle's metafile. They are still shipped software.
  const workManifest = JSON.parse(await readFile(path.join(repository, "src/ui/runtime-dependencies/manifest.json"), "utf8"));
  for (const library of workManifest.libraries) {
    const directory = path.join(repository, "node_modules", library.package);
    const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const bytes = await readFile(path.join(directory, library.package_file));
    if (metadata.version !== library.version || sha256(bytes) !== library.sha256) throw new Error(`Work dependency drift: ${library.package}`);
    const key = `${metadata.name}@${metadata.version}`;
    const entry = packages.get(key) ?? { name: metadata.name, version: metadata.version, declared_license: metadata.license ?? null,
      repository: normalizeRepository(metadata.repository), consumers: new Set(), directory };
    entry.consumers.add("interactive_work"); packages.set(key, entry);
  }
  const rows = [];
  for (const item of [...packages.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"))) {
    const licenses = await licenseTexts(item.directory);
    // victory-vendor's ESM files are pass-throughs to separately inventoried
    // d3 packages, but npm omits the monorepo's own MIT license. Preserve the
    // exact release-tag text locally, never fetch legal files while packaging.
    for (const supplement of workManifest.license_supplements ?? []) {
      if (supplement.package !== item.name || supplement.version !== item.version) continue;
      const bytes = await readFile(path.join(repository, "src/ui/runtime-dependencies", supplement.file));
      if (sha256(bytes) !== supplement.sha256) throw new Error(`Supplemental license drift: ${supplement.package}`);
      licenses.push({ name: supplement.file, bytes: bytes.length, sha256: supplement.sha256, source: supplement.source, text: bytes.toString("utf8").trim() });
    }
    if (licenses.length === 0) throw new Error(`bundled package has no usable license text: ${item.name}@${item.version}`);
    rows.push({
      name: item.name,
      version: item.version,
      declared_license: item.declared_license,
      repository: item.repository,
      consumers: [...item.consumers].sort(),
      license_files: licenses.map(({ text: _text, ...license }) => license),
      license_texts: licenses
    });
  }
  return rows;
}

async function runtimeComponent(id, version, declaredLicense, files) {
  const licenseFiles = [];
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    licenseFiles.push({ name: file.name, bytes: bytes.byteLength, sha256: sha256(bytes), text: bytes.toString("utf8").trim() });
  }
  return { id, version, declared_license: declaredLicense, license_files: licenseFiles };
}

function combinedText(inventory, npmRows, runtimeRows) {
  const lines = [
    "Cloudig V1 third-party licenses",
    "",
    "This deterministic file contains the license texts for runtime components, JavaScript packages and UI fonts bundled into Cloudig.",
    ""
  ];
  for (const component of runtimeRows) {
    lines.push(`================================================================================`, `${component.id} ${component.version}`, `Declared license: ${component.declared_license}`, "");
    for (const license of component.license_files) lines.push(`--- ${license.name} / sha256 ${license.sha256} ---`, license.text, "");
  }
  for (const entry of npmRows) {
    lines.push(`================================================================================`, `${entry.name}@${entry.version}`, `Declared license: ${entry.declared_license ?? "see included license text"}`, `Bundled by: ${entry.consumers.join(", ")}`, "");
    for (const license of entry.license_texts) lines.push(`--- ${license.name} / sha256 ${license.sha256} ---`, license.text, "");
  }
  lines.push(`Inventory schema: ${inventory.schema}`, "");
  return `${lines.join("\n")}\n`;
}

export async function writeV1ThirdPartyInventory({ repository = defaultRoot, outputRoot, metafiles = null } = {}) {
  if (!outputRoot) throw new Error("outputRoot is required");
  const bundleMetafiles = metafiles ?? await analyzeV1BundleMetafiles(repository);
  const npmRows = await npmInventory(repository, bundleMetafiles);
  const webViewRoot = path.join(process.env.USERPROFILE ?? "", ".nuget", "packages", "microsoft.web.webview2", "1.0.4078.44");
  const runtimeRows = [
    await runtimeComponent("Node.js", "24.18.0", "Node.js license and bundled third-party notices", [
      { name: "LICENSE.node.txt", absolute: path.join(repository, "manager", ".cache", "node-v24.18.0-win-x64", "LICENSE") }
    ]),
    await runtimeComponent("Microsoft .NET Windows Desktop Runtime", "10.0.10", "MIT and bundled third-party notices", [
      { name: "LICENSE.dotnet.txt", absolute: path.join(repository, "manager", ".cache", "dotnet", "LICENSE.txt") },
      { name: "ThirdPartyNotices.dotnet.txt", absolute: path.join(repository, "manager", ".cache", "dotnet", "ThirdPartyNotices.txt") }
    ]),
    await runtimeComponent("Microsoft.Web.WebView2 SDK", "1.0.4078.44", "BSD-3-Clause and bundled notices", [
      { name: "LICENSE.webview2.txt", absolute: path.join(webViewRoot, "LICENSE.txt") },
      { name: "NOTICE.webview2.txt", absolute: path.join(webViewRoot, "NOTICE.txt") }
    ])
  ];
  const fontRoot = path.join(repository, 'src/ui/shell/fonts/bodoni-moda');
  const fontSource = JSON.parse(await readFile(path.join(fontRoot, 'source.json'), 'utf8'));
  const fontBytes = await readFile(path.join(fontRoot, fontSource.file));
  if (fontBytes.length !== fontSource.bytes || sha256(fontBytes) !== fontSource.sha256) throw new Error('Bodoni welcome font bytes drifted');
  const fontRows = [await runtimeComponent(fontSource.name, fontSource.version, fontSource.license, [
    { name: 'Bodoni-Moda-OFL.txt', absolute: path.join(fontRoot, fontSource.license_file) }
  ])];
  if (fontRows[0].license_files[0].sha256 !== fontSource.license_sha256) throw new Error('Bodoni license bytes drifted');
  Object.assign(fontRows[0], { file: fontSource.file, bytes: fontSource.bytes, sha256: fontSource.sha256 });
  const workRoot = path.join(repository, "src/ui/runtime-dependencies");
  const workManifest = JSON.parse(await readFile(path.join(workRoot, "manifest.json"), "utf8"));
  for (const family of [...new Set(workManifest.fonts.map(font => font.family))]) {
    const fonts = workManifest.fonts.filter(font => font.family === family), files = [];
    for (const font of fonts) {
      const bytes = await readFile(path.join(workRoot, font.file));
      if (sha256(bytes) !== font.sha256) throw new Error(`Interactive font bytes drifted: ${font.file}`);
      files.push({ file: font.file, weight: font.weight, style: font.style ?? "normal", bytes: bytes.length, sha256: font.sha256, source: font.source });
    }
    const component = await runtimeComponent(family, `Google Fonts ${/\/v\d+\//u.exec(fonts[0].source)?.[0].slice(1, -1) ?? "distribution"}`, "OFL-1.1",
      [...new Set(fonts.map(font => font.license))].map(file => ({ name: path.basename(file), absolute: path.join(workRoot, file) })));
    fontRows.push({ ...component, files });
  }
  const inventory = {
    schema: V1_THIRD_PARTY_INVENTORY,
    scope: "runtime components, packages present in bundle metafiles, and explicitly bundled UI fonts",
    runtime_components: runtimeRows.map((entry) => ({
      id: entry.id,
      version: entry.version,
      declared_license: entry.declared_license,
      license_files: entry.license_files.map(({ text: _text, ...license }) => license)
    })),
    npm_packages: npmRows.map(({ license_texts: _texts, directory: _directory, ...entry }) => entry),
    bundled_fonts: fontRows.map(entry => ({ ...entry,
      license_files: entry.license_files.map(({ text: _text, ...license }) => license) })),
    summary: {
      runtime_components: runtimeRows.length,
      npm_packages: npmRows.length,
      bundled_fonts: fontRows.length,
      license_texts: runtimeRows.reduce((sum, entry) => sum + entry.license_files.length, 0)
        + npmRows.reduce((sum, entry) => sum + entry.license_files.length, 0)
        + fontRows.reduce((sum, entry) => sum + entry.license_files.length, 0)
    }
  };
  const notices = combinedText(inventory, npmRows, [...runtimeRows, ...fontRows]);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "third-party-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputRoot, "THIRD-PARTY-LICENSES.txt"), notices, "utf8");
  const publication = {
    format: 'cloudig/third-party-publication/1',
    notices_sha256: sha256(Buffer.from(notices)),
    components: [
      ...[...runtimeRows, ...fontRows].map(entry => ({ name: entry.id, version: entry.version, declared_license: entry.declared_license, licenses: entry.license_files })),
      ...npmRows.map(entry => ({ name: entry.name, version: entry.version, declared_license: entry.declared_license, licenses: entry.license_texts }))
    ]
  };
  return { inventory, publication, notices_bytes: Buffer.byteLength(notices), notices_sha256: publication.notices_sha256 };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") {
    process.stderr.write("Usage: node scripts/v1-third-party-inventory.mjs --output <directory>\n");
    process.exitCode = 2;
  } else {
    writeV1ThirdPartyInventory({ outputRoot: path.resolve(args[1]) })
      .then((result) => process.stdout.write(`${JSON.stringify({ ...result.inventory.summary, notices_bytes: result.notices_bytes, notices_sha256: result.notices_sha256 })}\n`))
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
