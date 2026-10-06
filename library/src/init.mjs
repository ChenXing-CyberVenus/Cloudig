import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { createLibraryV1, normalizeLibraryV1, serializeLibraryV1 } from "../v1.mjs";
import { createParseStateV1, serializeParseStateV1 } from "../../parser/src/parse-state-v1.mjs";

const require = createRequire(import.meta.url);
const core = require("../core.js");

export function defaultLibraryRoot() {
  return path.join(os.homedir(), "Cloudig");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function localAnchor(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetMinutes);
  return {
    date: `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    captured_at: date.toISOString(),
    utc_offset: magnitude === 0
      ? "Z"
      : `${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`
  };
}

export function createDefaultLibraryV1(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Cloudig library initialization clock returned an invalid date");
  const library = createLibraryV1({
    edited_at: now.toISOString(),
    anchor: options.anchor || localAnchor(now),
    language: options.language || "zh-CN",
    theme: options.theme || "platform"
  });
  const userName = String(options.userName || "").trim();
  const assistantName = String(options.assistantName || "").trim();
  if (userName) library.user = { display_name: userName };
  if (assistantName) library.assistant = { display_name: assistantName, apply_to_all: false };
  return normalizeLibraryV1(library);
}

export function libraryPaths(rootPath) {
  const root = path.resolve(rootPath);
  const data = path.join(root, "Data");
  const assets = path.join(data, "Assets");
  return Object.freeze({
    root,
    library: path.join(root, core.FILE_NAME),
    inbox: path.join(root, "Inbox"),
    conversations: path.join(root, "Conversations"),
    exports: path.join(root, "Exports"),
    data,
    parseState: path.join(data, "parse-state.json"),
    parseBatchSettings: path.join(data, "parse-batch-settings.json"),
    assets,
    covers: path.join(assets, "Covers"),
    avatars: path.join(assets, "Avatars"),
    platformIcons: path.join(assets, "PlatformIcons"),
    indexes: path.join(data, "Indexes"),
    conversationCatalog: path.join(data, "Indexes", "conversation-catalog.json"),
    contentTimeReferenceIndex: path.join(data, "Indexes", "content-time-reference-index.json"),
    transactions: path.join(data, "Transactions"),
    recentOperations: path.join(data, "Transactions", "recent-operations.json"),
    readerRuntime: path.join(data, "Reader"),
    desktopReader: path.join(data, "Reader", "Cloudig-Reader.html"),
    backups: path.join(data, "Backups"),
    userStateBackups: path.join(data, "Backups", "UserState"),
    libraryBackups: path.join(data, "Backups", "UserState", "cloudig-library"),
    logs: path.join(data, "Logs")
  });
}

async function initializeLibraryGeneration(rootPath, options, generation) {
  const paths = libraryPaths(rootPath);
  const directories = [
    paths.inbox,
    paths.conversations,
    paths.exports,
    paths.covers,
    paths.avatars,
    paths.platformIcons,
    paths.indexes,
    paths.transactions,
    paths.backups,
    paths.logs
  ];
  for (const directory of directories) await mkdir(directory, { recursive: true });
  const [libraryExisted, parseStateExisted] = await Promise.all([
    exists(paths.library),
    exists(paths.parseState)
  ]);
  if (!libraryExisted) {
    if (parseStateExisted) {
      const error = new Error("Cloudig Library initialization is incomplete: parse-state exists without cloudig-library.json");
      error.code = "CLOUDIG_LIBRARY_INITIALIZATION_INCOMPLETE";
      throw error;
    }
    const v1 = generation === "v1";
    const libraryText = v1
      ? serializeLibraryV1(createDefaultLibraryV1(options))
      : core.serializeLibrary(core.createDefaultLibrary({
        userName: options.userName,
        assistantName: options.assistantName,
        language: options.language || "zh-CN"
      }));
    const stateText = v1
      ? serializeParseStateV1(createParseStateV1())
      : `${JSON.stringify({ format: "cloudig/parse-state", version: "0.2.1", sources: [] }, null, 2)}\n`;
    await writeFile(paths.library, libraryText, { encoding: "utf8", flag: "wx" });
    try {
      await writeFile(paths.parseState, stateText, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      await rm(paths.library, { force: true });
      throw error;
    }
  }
  return Object.freeze({
    ...paths,
    createdLibrary: !libraryExisted,
    createdParseState: !libraryExisted
  });
}

export function initializeLibrary(rootPath = defaultLibraryRoot(), options = {}) {
  return initializeLibraryGeneration(rootPath, options, "v1");
}

export function initializeLegacyLibraryForRegression(rootPath = defaultLibraryRoot(), options = {}) {
  return initializeLibraryGeneration(rootPath, options, "legacy");
}
