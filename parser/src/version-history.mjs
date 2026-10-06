import { createRequire } from "node:module";

import { isSemanticVersion } from "./semver.mjs";

const require = createRequire(import.meta.url);
const ADAPTER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const HISTORY_FORMAT = "cloudig/parser-version-history";

function normalizeRelease(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Parser version history release ${index} must be an object`);
  }
  const parserVersion = String(value.parser_version || "").trim();
  if (!isSemanticVersion(parserVersion)) throw new TypeError(`Parser version history release ${index} needs a semantic parser_version`);
  if (!value.adapters || typeof value.adapters !== "object" || Array.isArray(value.adapters)) {
    throw new TypeError(`Parser version history release ${parserVersion} needs a complete adapter map`);
  }
  const adapters = {};
  for (const [id, version] of Object.entries(value.adapters).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!ADAPTER_ID.test(id)) throw new TypeError(`Parser version history contains an invalid adapter id: ${id}`);
    if (!isSemanticVersion(String(version || ""))) throw new TypeError(`Parser adapter ${id} needs a semantic version`);
    adapters[id] = String(version);
  }
  if (!Object.keys(adapters).length) throw new TypeError(`Parser version history release ${parserVersion} has no adapters`);
  return Object.freeze({
    parser_version: parserVersion,
    recorded_at: String(value.recorded_at || ""),
    ...(value.baseline === true ? { baseline: true } : {}),
    adapters: Object.freeze(adapters),
    ...(typeof value.note === "string" && value.note.trim() ? { note: value.note.trim() } : {})
  });
}

export function normalizeParserVersionHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Parser version history must be an object");
  if (value.format !== HISTORY_FORMAT) throw new TypeError(`Parser version history format must be ${HISTORY_FORMAT}`);
  if (!isSemanticVersion(String(value.version || ""))) throw new TypeError("Parser version history version must be semantic version");
  if (!isSemanticVersion(String(value.current || ""))) throw new TypeError("Parser version history current must be semantic version");
  if (!Array.isArray(value.releases) || !value.releases.length) throw new TypeError("Parser version history needs releases");
  const releases = value.releases.map(normalizeRelease);
  const versions = new Set();
  for (const release of releases) {
    if (versions.has(release.parser_version)) throw new TypeError(`Duplicate Parser version history release: ${release.parser_version}`);
    versions.add(release.parser_version);
  }
  if (!versions.has(value.current)) throw new TypeError(`Current Parser ${value.current} is missing from version history`);
  return Object.freeze({
    format: HISTORY_FORMAT,
    version: String(value.version),
    current: String(value.current),
    releases: Object.freeze(releases)
  });
}

export const PARSER_VERSION_HISTORY = normalizeParserVersionHistory(require("../version-history.json"));
export const CURRENT_PARSER_RELEASE = PARSER_VERSION_HISTORY.releases.find(
  (release) => release.parser_version === PARSER_VERSION_HISTORY.current
);

export function parserAdapterVersion(id, parserVersion = PARSER_VERSION_HISTORY.current) {
  const release = PARSER_VERSION_HISTORY.releases.find((candidate) => candidate.parser_version === parserVersion);
  if (!release) throw new Error(`Unknown Parser version in history: ${parserVersion}`);
  const version = release.adapters[String(id || "")];
  if (!version) throw new Error(`Parser ${parserVersion} has no adapter mapping for ${id}`);
  return version;
}

export function parserAdapterRecord(id, parserVersion = PARSER_VERSION_HISTORY.current) {
  return Object.freeze({ id: String(id), version: parserAdapterVersion(id, parserVersion) });
}
