#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(uiRoot);
const archiverAssets = Object.freeze([
  "Astronaut.svg", "ChenXing-Avatar.png", "Cock.svg", "GirlInForest.svg", "Phoenix.svg",
  "Button-Name-Flower.svg", "Button-Time-Clock.svg", "Button-Time-LightCone.svg", "Button-Time-Tea.svg",
  "PinkGreenTrees.svg", "Pushpin-Purple.svg", "Pushpin-Red.svg", "Rocket.svg", "RockStage.svg",
  "SailboatWithShadow.svg", "Ship.svg", "Sunflower.svg", "TitleDec-Explosion.svg", "TitleDec-Garden.svg",
  "TitleDec-Homeland.svg", "TitleDec-Pompeii.svg", "Village-Dusk.svg", "Village-Night.svg",
  "Wave-Blue.svg", "Wave-Green.svg", "WildTree.svg"
]);
const brandAssets = Object.freeze([
  "Cloudig-Slogan-Chinese-Grey-Dark-1024.png", "Cloudig-Slogan-Chinese-Grey-Light-1024.png",
  "Cloudig-Title-Chinese-Grey-Dark-1024.png", "Cloudig-Title-Chinese-Grey-Light-1024.png",
  "OsisLogo-Cloudig-PurpleBackOrangeAbyss.svg", "OsisLogo-Cloudig-RedBackWhiteAbyss.svg"
]);

const targets = Object.freeze([
  { source: "tokens/cloudig-tokens.css", target: "manager/web/shared/cloudig-tokens.css" },
  { source: "components/cloudig-foundation.css", target: "manager/web/shared/cloudig-foundation.css" },
  { source: "components/cloudig-docs.css", target: "manager/web/shared/cloudig-docs.css" },
  { source: "runtime/viewport.js", target: "manager/web/shared/cloudig-viewport.js" },
  { source: "runtime/tooltip.js", target: "manager/web/shared/cloudig-tooltip.js" },
  { source: "runtime/docs.js", target: "manager/web/shared/cloudig-docs.js" },
  { source: "content/cloudig-docs.json", target: "manager/web/shared/cloudig-docs.json" },
  { source: "assets/welcome/OsisLogo-Main-1024.png", target: "manager/web/assets/welcome/OsisLogo-Main-1024.png" },
  { source: "assets/welcome/Cloudig-Logo-Title-Slogan.svg", target: "manager/web/assets/welcome/Cloudig-Logo-Title-Slogan.svg" },
  { source: "assets/welcome/OsisLogo-Simple-Mono-Purple.svg", target: "manager/web/assets/welcome/OsisLogo-Simple-Mono-Purple.svg" },
  { source: "assets/welcome/OsisLogo-Simple-Mono-Orange.svg", target: "manager/web/assets/welcome/OsisLogo-Simple-Mono-Orange.svg" },
  { source: "assets/welcome/OsisLogo-Cloudig-1024.png", target: "manager/web/assets/welcome/OsisLogo-Cloudig-1024.png" },
  { source: "assets/welcome/OsisLogo-Simple.svg", target: "manager/web/assets/welcome/OsisLogo-Simple.svg" },
  { source: "assets/welcome/Cover-PhotoFrame-Dawn.svg", target: "manager/web/assets/welcome/Cover-PhotoFrame-Dawn.svg" },
  { source: "assets/welcome/Cover-PhotoFrame-StarNight.svg", target: "manager/web/assets/welcome/Cover-PhotoFrame-StarNight.svg" },
  { source: "assets/welcome/Back-Light-start-1920.png", target: "manager/web/assets/welcome/Back-Light-start-1920.png" },
  { source: "assets/welcome/Back-Light-1920.png", target: "manager/web/assets/welcome/Back-Light-1920.png" },
  { source: "assets/welcome/Back-Abyss-1920.png", target: "manager/web/assets/welcome/Back-Abyss-1920.png" },
  { source: "assets/welcome/Back-Horizon-1920.png", target: "manager/web/assets/welcome/Back-Horizon-1920.png" },
  ...brandAssets.map((name) => ({ source: `assets/brand/${name}`, target: `manager/web/assets/brand/${name}` })),
  ...archiverAssets.map((name) => ({ source: `assets/archiver/${name}`, target: `manager/web/assets/archiver/${name}` }))
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readOrNull(filePath) {
  try { return await readFile(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function buildUi({ check = false } = {}) {
  const records = [];
  let changed = false;
  for (const item of targets) {
    const sourcePath = path.join(uiRoot, ...item.source.split("/"));
    const targetPath = path.join(projectRoot, ...item.target.split("/"));
    const source = await readFile(sourcePath);
    const existing = await readOrNull(targetPath);
    const differs = existing === null || !existing.equals(source);
    if (differs && check) throw new Error(`Generated UI file is stale: ${item.target}`);
    if (differs) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, source);
      changed = true;
    }
    records.push({ source: item.source, target: item.target, bytes: source.length, sha256: sha256(source) });
  }
  const manifest = Buffer.from(`${JSON.stringify({
    format: "cloudig/ui-build-manifest",
    version: "0.1.0",
    files: records
  }, null, 2)}\n`, "utf8");
  const manifestPath = path.join(projectRoot, "manager", "web", "shared", "manifest.json");
  const existingManifest = await readOrNull(manifestPath);
  const manifestDiffers = existingManifest === null || !existingManifest.equals(manifest);
  if (manifestDiffers && check) throw new Error("Generated UI manifest is stale: manager/web/shared/manifest.json");
  if (manifestDiffers) {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifest);
    changed = true;
  }
  return Object.freeze({ ok: true, mode: check ? "check" : "write", changed, files: records.length });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--check")) throw new Error(`Unknown UI build option: ${args.join(" ")}`);
  process.stdout.write(`${JSON.stringify(await buildUi({ check: args.includes("--check") }))}\n`);
}
