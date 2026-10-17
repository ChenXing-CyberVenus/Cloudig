#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseAttributes } from "../parser/src/html.mjs";
import { isSemanticVersion } from "../parser/src/semver.mjs";

const MANIFEST_ID = "ai-chat-archive-manifest";
const MANIFEST_SCHEMA = "ai-chat-archive/manifest-v1";
const PAYLOAD_SCHEMA_PATTERN = /^osis\.[a-z0-9.-]+\.chat-export\/[a-z0-9.-]+$/iu;
const PROFILE_ORDER = Object.freeze(["light", "full", "all_branches"]);

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function scriptRanges(html) {
  const source = String(html);
  const ranges = [];
  const openingPattern = /<script\b([^>]*)>/giu;
  const closingPattern = /<\/script\s*>/giu;
  let cursor = 0;
  while (cursor < source.length) {
    openingPattern.lastIndex = cursor;
    const match = openingPattern.exec(source);
    if (!match) break;
    const openEnd = openingPattern.lastIndex;
    closingPattern.lastIndex = openEnd;
    const close = closingPattern.exec(source);
    if (!close) {
      throw new Error("HTML contains an unclosed script element");
    }
    ranges.push({
      attrs: parseAttributes(match[1]),
      contentStart: openEnd,
      contentEnd: close.index
    });
    cursor = closingPattern.lastIndex;
  }
  return ranges;
}

function scriptObjects(html, fileName) {
  const scripts = [];
  for (const range of scriptRanges(html)) {
    const attrs = range.attrs;
    if (String(attrs.type ?? "").toLowerCase() !== "application/json") continue;
    const id = String(attrs.id ?? "");
    if (!id) continue;
    let value;
    try {
      value = objectValue(
        JSON.parse(html.slice(range.contentStart, range.contentEnd).replace(/^\uFEFF/u, "").trim()),
        `${fileName}#${id}`
      );
    } catch (error) {
      throw new Error(`${fileName}#${id} is not valid object JSON: ${error.message}`);
    }
    scripts.push({ id, value });
  }
  return scripts;
}

function manifestSchema(manifest) {
  return String(manifest.format ?? manifest.schema ?? "");
}

function exporterVersion(manifest) {
  return String(manifest.exporter_version ?? manifest.exporter?.version ?? "");
}

function payloadObjectSchema(payload) {
  return String(payload.format ?? payload.schema ?? "");
}

function declaredPayloadSchema(manifest) {
  return String(manifest.payload?.format ?? manifest.payload?.schema ?? "");
}

function payloadSchemaPlatform(schema) {
  return /^osis\.([a-z0-9.-]+)\.chat-export\//iu.exec(String(schema))?.[1] ?? "";
}

function profileFromExporterVersion(version) {
  if (/-all-branches$/u.test(version)) return "all_branches";
  if (/-full$/u.test(version)) return "full";
  if (/-light$/u.test(version)) return "light";
  return "unknown";
}

function profileFromPayloadSchema(schema) {
  const leaf = String(schema).split("/").at(-1) ?? "";
  if (/^all-branches(?:-|$)/u.test(leaf)) return "all_branches";
  if (/^full(?:-|$)|^full-dom(?:-|$)|^full-capture(?:-|$)/u.test(leaf)) return "full";
  if (/^light(?:-|$)|^light-dom(?:-|$)|^light-messages(?:-|$)|^light-items(?:-|$)/u.test(leaf)) {
    return "light";
  }
  return "unknown";
}

export function profileHintFromSampleFileName(fileName) {
  const stem = path.basename(String(fileName), path.extname(String(fileName)));
  if (/ \(2\)$/u.test(stem)) return "all_branches";
  if (/ \(1\)$/u.test(stem)) return "full";
  return "light";
}

export function sampleCaseName(fileName) {
  const stem = path.basename(String(fileName), path.extname(String(fileName)));
  return stem.replace(/ \([12]\)$/u, "");
}

function payloadScript(scripts, manifest, fileName) {
  const recognizable = scripts.filter((script) =>
    script.id !== MANIFEST_ID
    && PAYLOAD_SCHEMA_PATTERN.test(String(script.value.format ?? script.value.schema ?? ""))
  );
  const explicitId = String(
    manifest.payload?.element_id
    ?? manifest.payload?.script_id
    ?? ""
  );
  if (explicitId) {
    const matches = scripts.filter((script) => script.id === explicitId);
    if (matches.length !== 1) {
      throw new Error(`${fileName} manifest payload id must match exactly one inert script`);
    }
    if (recognizable.length !== 1 || recognizable[0].id !== explicitId) {
      throw new Error(`${fileName} must expose exactly one recognizable export payload; got ${recognizable.length}`);
    }
    return matches[0];
  }

  if (recognizable.length !== 1) {
    throw new Error(`${fileName} must expose exactly one recognizable export payload; got ${recognizable.length}`);
  }
  return recognizable[0];
}

function optionalText(...values) {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value ? value.trim() : null;
}

export function inspectExportHtml(filePath) {
  const source = readFileSync(filePath);
  const fileName = path.basename(filePath);
  const hasBom = source.length >= 3
    && source[0] === 0xef
    && source[1] === 0xbb
    && source[2] === 0xbf;
  const html = source.toString("utf8").replace(/^\uFEFF/u, "");
  const scripts = scriptObjects(html, fileName);
  const manifests = scripts.filter((script) => script.id === MANIFEST_ID);
  if (manifests.length !== 1) {
    throw new Error(`${fileName} must expose exactly one #${MANIFEST_ID}; got ${manifests.length}`);
  }

  const manifest = manifests[0].value;
  const actualManifestSchema = manifestSchema(manifest);
  if (actualManifestSchema !== MANIFEST_SCHEMA) {
    throw new Error(`${fileName} has unsupported manifest ${actualManifestSchema || "<missing>"}`);
  }
  const platform = String(manifest.platform ?? "").trim();
  if (!platform) throw new Error(`${fileName} manifest is missing platform`);

  const payloadRecord = payloadScript(scripts, manifest, fileName);
  const actualPayloadSchema = payloadObjectSchema(payloadRecord.value);
  if (!PAYLOAD_SCHEMA_PATTERN.test(actualPayloadSchema)) {
    throw new Error(`${fileName} has unsupported payload schema ${actualPayloadSchema || "<missing>"}`);
  }
  const declaredSchema = declaredPayloadSchema(manifest);
  if (declaredSchema && declaredSchema !== actualPayloadSchema) {
    throw new Error(`${fileName} manifest payload schema does not match the actual payload`);
  }
  if (payloadSchemaPlatform(actualPayloadSchema) !== platform) {
    throw new Error(`${fileName} payload schema platform does not match its manifest`);
  }
  if (payloadRecord.value.platform && String(payloadRecord.value.platform) !== platform) {
    throw new Error(`${fileName} payload platform does not match its manifest`);
  }

  const version = exporterVersion(manifest);
  const profiles = {
    exporter_version: profileFromExporterVersion(version),
    payload_schema: profileFromPayloadSchema(actualPayloadSchema)
  };
  if (new Set(Object.values(profiles)).size !== 1 || profiles.exporter_version === "unknown") {
    throw new Error(`${fileName} manifest and payload profile markers disagree`);
  }

  return {
    file_name: fileName,
    case_name: sampleCaseName(fileName),
    bytes: source.length,
    sha256: sha256(source),
    utf8_bom: hasBom,
    profile: profiles.exporter_version,
    platform,
    exporter_version: version,
    manifest_shape: Object.hasOwn(manifest, "format") ? "format" : "schema",
    exporter_shape: Object.hasOwn(manifest, "exporter_version") ? "flat" : "nested",
    payload_descriptor: Boolean(manifest.payload),
    payload_id: payloadRecord.id,
    payload_schema: actualPayloadSchema,
    capture_mode: optionalText(
      manifest.capture_mode,
      manifest.mode,
      manifest.capture?.mode,
      payloadRecord.value.capture_mode,
      payloadRecord.value.mode
    ),
    capture_scope: optionalText(
      manifest.capture_scope,
      manifest.scope,
      manifest.capture?.scope,
      payloadRecord.value.capture_scope,
      payloadRecord.value.scope
    )
  };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = String(item[key]);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}

function bytesByProfile(files) {
  const result = Object.fromEntries(PROFILE_ORDER.map((profile) => [profile, 0]));
  for (const file of files) result[file.profile] += file.bytes;
  return result;
}

function validateGroups(files) {
  const groups = new Map();
  for (const file of files) {
    const current = groups.get(file.case_name) ?? [];
    current.push(file);
    groups.set(file.case_name, current);
  }

  const result = [];
  for (const [caseName, entries] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    const counts = countBy(entries, "profile");
    if (PROFILE_ORDER.some((profile) => (counts[profile] ?? 0) > 1)) {
      throw new Error(`${caseName} must contain at most one sample for each profile`);
    }
    const platforms = [...new Set(entries.map((entry) => entry.platform))];
    if (platforms.length !== 1) throw new Error(`${caseName} profiles disagree on platform`);
    result.push({
      case_name: caseName,
      platform: platforms[0],
      profiles: PROFILE_ORDER.filter((profile) => entries.some((entry) => entry.profile === profile))
    });
  }
  return result;
}

function completeCaseCount(cases, requiredProfiles) {
  return cases.filter((record) => requiredProfiles.every((profile) => record.profiles.includes(profile))).length;
}

export function inspectExportSampleSet(directoryPath) {
  const root = path.resolve(directoryPath);
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText);
  if (!names.length) throw new Error(`No HTML files found in ${root}`);

  const files = names.map((name) => inspectExportHtml(path.join(root, name)));
  const cases = validateGroups(files);
  const profileCounts = countBy(files, "profile");
  const platforms = [...new Set(files.map((file) => file.platform))].sort(compareText);
  const branchPlatforms = [...new Set(
    files.filter((file) => file.profile === "all_branches").map((file) => file.platform)
  )].sort(compareText);

  return {
    format: "cloudig/private-export-sample-set-audit",
    version: "0.2.0",
    batch_id: path.basename(root),
    source_root: root,
    summary: {
      files: files.length,
      cases: cases.length,
      platforms: platforms.length,
      total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      profile_counts: Object.fromEntries(PROFILE_ORDER.map((profile) => [profile, profileCounts[profile] ?? 0])),
      profile_bytes: bytesByProfile(files),
      paired_light_full_cases: completeCaseCount(cases, ["light", "full"]),
      paired_full_all_branches_cases: completeCaseCount(cases, ["full", "all_branches"]),
      standalone_cases: cases.filter((record) => record.profiles.length === 1).length,
      branch_platforms: branchPlatforms,
      utf8_bom: countBy(files, "utf8_bom"),
      manifest_shape: countBy(files, "manifest_shape"),
      exporter_shape: countBy(files, "exporter_shape"),
      payload_descriptor: countBy(files, "payload_descriptor")
    },
    platforms,
    cases,
    files
  };
}

export function publicSampleWaterline(audit, parserVersion) {
  const value = objectValue(audit, "Private sample audit");
  if (!isSemanticVersion(parserVersion)) {
    throw new TypeError("Public sample waterline requires a semantic Parser version");
  }
  const sources = new Map();
  for (const file of value.files ?? []) {
    const key = [file.platform, file.profile, file.payload_schema].join("\u0000");
    const current = sources.get(key) ?? {
      platform: file.platform,
      profile: file.profile,
      payload_schema: file.payload_schema,
      exporter_versions: new Set(),
      samples: 0
    };
    if (file.exporter_version) current.exporter_versions.add(file.exporter_version);
    current.samples += 1;
    sources.set(key, current);
  }
  return {
    format: "cloudig/parser-sample-waterline",
    version: "0.1.0",
    batch_id: value.batch_id,
    parser_version: String(parserVersion),
    summary: {
      files: value.summary.files,
      cases: value.summary.cases,
      platforms: value.summary.platforms,
      profile_counts: value.summary.profile_counts,
      paired_light_full_cases: value.summary.paired_light_full_cases,
      paired_full_all_branches_cases: value.summary.paired_full_all_branches_cases,
      standalone_cases: value.summary.standalone_cases
    },
    sources: [...sources.values()]
      .map((record) => ({
        ...record,
        exporter_versions: [...record.exporter_versions].sort(compareText)
      }))
      .sort((left, right) =>
        compareText(left.platform, right.platform)
        || PROFILE_ORDER.indexOf(left.profile) - PROFILE_ORDER.indexOf(right.profile)
        || compareText(left.payload_schema, right.payload_schema))
  };
}

function baselineValue(value) {
  return {
    format: value.format,
    version: value.version,
    batch_id: value.batch_id,
    summary: value.summary,
    platforms: value.platforms,
    cases: value.cases,
    files: value.files
  };
}

export function assertAuditMatchesBaseline(actual, expected) {
  const actualText = JSON.stringify(baselineValue(objectValue(actual, "Actual sample audit")));
  const expectedText = JSON.stringify(baselineValue(objectValue(expected, "Expected sample audit")));
  if (actualText !== expectedText) {
    throw new Error("Export sample set drifted from its private audit baseline");
  }
}

function parseCliArgs(argv) {
  const args = [...argv];
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }
  const directory = args.shift();
  let output = null;
  let checkAgainst = null;
  let waterlineOutput = null;
  let parserVersion = null;
  let replace = false;
  while (args.length) {
    const option = args.shift();
    if (option === "--output" && args.length && !output && !checkAgainst) {
      output = args.shift();
    } else if (option === "--check-against" && args.length && !output && !checkAgainst) {
      checkAgainst = args.shift();
    } else if (option === "--waterline-output" && args.length && !waterlineOutput) {
      waterlineOutput = args.shift();
    } else if (option === "--parser-version" && args.length && !parserVersion) {
      parserVersion = args.shift();
    } else if (option === "--replace" && (output || waterlineOutput) && !replace) {
      replace = true;
    } else {
      throw new Error(
        "Usage: node scripts/inspect-export-sample-set.mjs <folder> "
        + "[--output <json> [--replace] | --check-against <json>] "
        + "[--waterline-output <json> --parser-version <semver> [--replace]]"
      );
    }
  }
  if (waterlineOutput && !parserVersion) {
    throw new Error("--waterline-output requires --parser-version");
  }
  return { help: false, directory, output, checkAgainst, waterlineOutput, parserVersion, replace };
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/inspect-export-sample-set.mjs <folder> "
      + "[--output <json> [--replace] | --check-against <json>] "
      + "[--waterline-output <json> --parser-version <semver>]\n"
    );
    return;
  }
  const result = inspectExportSampleSet(options.directory);
  if (options.checkAgainst) {
    const baselinePath = path.resolve(options.checkAgainst);
    const baseline = objectValue(JSON.parse(readFileSync(baselinePath, "utf8")), "Private sample baseline");
    assertAuditMatchesBaseline(result, baseline);
  }
  if (options.output) {
    const outputPath = path.resolve(options.output);
    if (existsSync(outputPath) && !options.replace) {
      throw new Error(`Refusing to overwrite existing sample baseline: ${outputPath}`);
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  if (options.waterlineOutput) {
    const outputPath = path.resolve(options.waterlineOutput);
    if (existsSync(outputPath) && !options.replace) {
      throw new Error(`Refusing to overwrite existing public sample waterline: ${outputPath}`);
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      `${JSON.stringify(publicSampleWaterline(result, options.parserVersion), null, 2)}\n`,
      "utf8"
    );
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    batch_id: result.batch_id,
    output: options.output ? path.resolve(options.output) : null,
    waterline_output: options.waterlineOutput ? path.resolve(options.waterlineOutput) : null,
    checked_against: options.checkAgainst ? path.resolve(options.checkAgainst) : null,
    ...result.summary
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
