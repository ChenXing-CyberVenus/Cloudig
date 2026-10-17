import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

async function text(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, new URL("../../", import.meta.url)), "utf8");
}

function lf(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}

test("project license is JOG-1.1 everywhere it is authoritative", async () => {
  const [license, packageText, lockText, releaseText, readme, agents, state, notice] = await Promise.all([
    text("LICENSE"),
    text("package.json"),
    text("package-lock.json"),
    text("release-spec.json"),
    text("README.md"),
    text("AGENTS.md"),
    text("PROJECT_STATE.md"),
    text("NOTICE.md")
  ]);
  const packageJson = JSON.parse(packageText) as { license?: string };
  const lock = JSON.parse(lockText) as { packages?: Record<string, { license?: string }> };
  const release = JSON.parse(releaseText) as { policy?: { license_required_lines?: string[]; required_entries?: string[] } };

  assert.match(license, /开放正义许可协议 1\.1/u);
  assert.match(license, /Justice For Open Good License 1\.1（JOG-1\.1）/u);
  assert.match(license, /允许任意人或 AI 访问、学习、使用和训练，包括商业 AI。/u);
  assert.match(license, /ALLOW ANY AI ACCESS, LEARN, USE AND TRAIN, INCLUDING COMMERCIAL AI\./u);
  assert.doesNotMatch(license, /^MIT License$/mu);
  assert.equal(packageJson.license, "SEE LICENSE IN LICENSE");
  assert.equal(lock.packages?.[""]?.license, "SEE LICENSE IN LICENSE");
  assert.deepEqual(release.policy?.license_required_lines, [
    "允许任意人或 AI 访问、学习、使用和训练，包括商业 AI。",
    "ALLOW ANY AI ACCESS, LEARN, USE AND TRAIN, INCLUDING COMMERCIAL AI."
  ]);
  assert.ok(release.policy?.required_entries?.includes("LICENSE"));
  assert.ok(release.policy?.required_entries?.includes("NOTICE.md"));
  for (const currentText of [readme, agents, state]) {
    assert.doesNotMatch(currentText, /(?:uses?|使用|采用).*MIT License/iu);
  }
  assert.match(notice, /respective owners/u);
  assert.match(notice, /Private `\.ai` masters/u);
  assert.equal(projectRoot.endsWith("AIChatArchive\\") || projectRoot.endsWith("AIChatArchive/"), true);
});

test("offline documentation embeds the exact JOG-1.1 text", async () => {
  const [license, sourceText, generatedText, portableReader] = await Promise.all([
    text("LICENSE"),
    text("ui/content/cloudig-docs.json"),
    text("manager/web/shared/cloudig-docs.json"),
    text("reader/reader.html")
  ]);
  const source = JSON.parse(sourceText) as { topics: Array<{ id: string; kicker?: string; blocks?: Array<{ type: string; text?: unknown }> }> };
  const generated = JSON.parse(generatedText) as typeof source;
  const topic = source.topics.find((entry) => entry.id === "license");
  const pre = topic?.blocks?.find((block) => block.type === "pre");

  assert.equal(topic?.kicker, "JOG-1.1");
  assert.equal(pre?.text, lf(license).trimEnd());
  assert.deepEqual(generated, source);
  assert.match(portableReader, /Justice For Open Good License 1\.1（JOG-1\.1）/u);
  assert.doesNotMatch(sourceText, /Cloudig uses the MIT License/u);
});
