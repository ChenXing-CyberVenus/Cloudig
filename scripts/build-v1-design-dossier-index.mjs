import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dossierRoot = path.join(repoRoot, "release", "v1-design-dossiers");
const designRoot = path.resolve(process.env.CLOUDIG_DESIGN_ROOT ?? path.join(repoRoot, "..", "阅读器美术素材", "Cloudig-Image"));
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "check";
if (!new Set(["write", "check"]).has(mode)) throw new Error(`Unsupported mode: ${mode}`);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function atomicWrite(target, body) {
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, target);
}

const aiFiles = fs.readdirSync(designRoot)
  .filter((name) => /^Cloudig-.*\.ai$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en"));
const dossierFiles = fs.readdirSync(dossierRoot)
  .filter((name) => name.endsWith(".design-metrics.json"))
  .sort((left, right) => left.localeCompare(right, "en"));

if (aiFiles.length !== 18) throw new Error(`Expected 18 current Illustrator sources, found ${aiFiles.length}`);
if (dossierFiles.length !== aiFiles.length) throw new Error(`Expected ${aiFiles.length} dossiers, found ${dossierFiles.length}`);

const items = aiFiles.map((aiName) => {
  const base = path.basename(aiName, ".ai");
  const pngName = `${base}.png`;
  const dossierName = `${base}.design-metrics.json`;
  const markdownName = `${base}.design-metrics.md`;
  const aiPath = path.join(designRoot, aiName);
  const pngPath = path.join(designRoot, pngName);
  const dossierPath = path.join(dossierRoot, dossierName);
  const markdownPath = path.join(dossierRoot, markdownName);
  for (const required of [pngPath, dossierPath, markdownPath]) {
    if (!fs.existsSync(required)) throw new Error(`Missing design evidence: ${required}`);
  }
  const dossier = JSON.parse(fs.readFileSync(dossierPath, "utf8"));
  const aiBytes = fs.readFileSync(aiPath);
  const pngBytes = fs.readFileSync(pngPath);
  const actualAiSha = sha256(aiBytes);
  if (dossier.schema !== "cloudig/ai-design-metrics/1.0.0") throw new Error(`Unsupported dossier schema: ${dossierName}`);
  if (dossier.source?.basename !== aiName || dossier.source?.sha256 !== actualAiSha) {
    throw new Error(`Dossier source drifted: ${dossierName}`);
  }
  return {
    id: base,
    ai: aiName,
    ai_bytes: aiBytes.length,
    ai_sha256: actualAiSha,
    png: pngName,
    png_bytes: pngBytes.length,
    png_sha256: sha256(pngBytes),
    dossier_json: dossierName,
    dossier_markdown: markdownName,
    artboard: dossier.artboard?.crop ?? null,
    named_art: dossier.layers?.named_art_count ?? 0,
    text_runs: dossier.text_runs?.length ?? 0,
    effect_styles: dossier.appearance?.effect_styles?.length ?? 0,
    gradients: dossier.appearance?.gradients?.length ?? 0,
    unresolved: dossier.unresolved ?? [],
    illustrator_dom_evidence: dossier.illustrator_dom?.raw_evidence ?? null,
  };
});

const index = {
  schema: "cloudig/v1-design-dossier-index/1.0.0",
  authority: {
    ai: "geometry and appearance source",
    png: "1920 final appearance reference",
    text: "approved Page Contracts and current interface specifications",
  },
  source_directory: "../阅读器美术素材/Cloudig-Image",
  item_count: items.length,
  items,
};
const jsonBody = `${JSON.stringify(index, null, 2)}\n`;
const markdownRows = items.map((item) => `| ${item.id} | ${item.named_art} | ${item.text_runs} | ${item.effect_styles} | ${item.gradients} | ${item.unresolved.length} | [JSON](${item.dossier_json}) | [table](${item.dossier_markdown}) |`).join("\n");
const markdownBody = `# Cloudig V1 design dossiers\n\n- Schema: \`${index.schema}\`\n- Current Illustrator sources: ${items.length}\n- AI supplies geometry and appearance facts; PNG is the final 1920 comparison, not the first measurement source.\n\n| Design | Named art | Text | Effects | Gradients | Unresolved | Machine | Table |\n| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |\n${markdownRows}\n`;

const outputs = new Map([
  [path.join(dossierRoot, "index.json"), jsonBody],
  [path.join(dossierRoot, "README.md"), markdownBody],
]);
let changed = false;
for (const [target, body] of outputs) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (current === body) continue;
  changed = true;
  if (mode === "write") atomicWrite(target, body);
}
if (mode === "check" && changed) throw new Error("V1 design dossier index is stale; run with --mode write");
console.log(JSON.stringify({ status: "pass", mode, changed: mode === "write" ? changed : false, items: items.length }));
