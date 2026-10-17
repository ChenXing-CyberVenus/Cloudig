import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { libraryPaths } from "../../library/src/init.mjs";
import { applyConversationOverlay, normalizeLibraryDocument } from "../../library/compat.mjs";
import { loadParseState, saveParseState } from "../../parser/src/parse-state.mjs";
import { acquireFileTransactionLock, atomicWriteText, pathExists } from "../../parser/src/atomic.mjs";
import {
  ARCHIVE_DIRECTORY,
  reconcileConversationCatalog,
  scanConversationMetadata
} from "./conversation-catalog.mjs";

const require = createRequire(import.meta.url);
const libraryCore = require("../../library/core.js");
const readerCore = require("../../reader/src/core.js");

export { ARCHIVE_DIRECTORY };
const MAX_DIRECTORY_NAME = 80;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function normalizedRelative(value) {
  return String(value || "").trim().replaceAll("\\", "/");
}

function assertSafeSegment(value, label = "directory") {
  const name = String(value || "").normalize("NFC").trim();
  if (!name || Array.from(name).length > MAX_DIRECTORY_NAME) {
    throw new Error(`${label} name must contain 1-${MAX_DIRECTORY_NAME} characters`);
  }
  if (name === "." || name === ".." || name.startsWith(".") || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /[. ]$/u.test(name) || WINDOWS_RESERVED.test(name)) {
    throw new Error(`${label} name is not valid on Windows`);
  }
  return name;
}

function assertConversationRelative(value, { allowArchived = true } = {}) {
  const relative = normalizedRelative(value);
  const segments = relative.split("/");
  if (segments[0] !== "Conversations" || segments.length < 2 || !segments.at(-1).toLowerCase().endsWith(".json")) {
    throw new Error(`Conversation path is not a JSON file under Conversations: ${value}`);
  }
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/u.test(segment))) {
    throw new Error(`Conversation path is unsafe: ${value}`);
  }
  if (!allowArchived && segments[1] === ARCHIVE_DIRECTORY) throw new Error("Archived conversation is not allowed here");
  return relative;
}

function resolveConversationPath(paths, relative, options = {}) {
  const normalized = assertConversationRelative(relative, options);
  const absolute = path.resolve(paths.root, ...normalized.split("/"));
  const conversations = path.resolve(paths.conversations);
  const inside = path.relative(conversations, absolute);
  if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw new Error(`Conversation path escaped Conversations: ${relative}`);
  }
  return { relative: normalized, absolute };
}

async function readLibrary(paths) {
  return normalizeLibraryDocument(JSON.parse(await readFile(paths.library, "utf8")));
}

async function assertDirectoryNameAvailable(paths, directoryName, exceptName = "") {
  const folded = directoryName.toLocaleLowerCase("en-US");
  const entries = await readdir(paths.conversations, { withFileTypes: true });
  const duplicate = entries.find((entry) => entry.isDirectory()
    && entry.name !== exceptName
    && entry.name.toLocaleLowerCase("en-US") === folded);
  if (!duplicate) return;
  const error = new Error("A directory with that name already exists");
  error.code = "CLOUDIG_DIRECTORY_EXISTS";
  throw error;
}

function archiveRevision(files, directories) {
  const snapshot = {
    directories: directories.map((directory) => [directory.name, directory.files, directory.size_bytes]),
    files: files.map((file) => [file.relative_path, file.size_bytes, file.modified_at])
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function assertExpectedRevision(archive, expectedRevision) {
  const expected = String(expectedRevision || "").trim();
  if (!expected || archive.revision === expected) return;
  const error = new Error("The archive changed while this window was open. Refresh it and try again.");
  error.code = "CLOUDIG_ARCHIVE_REVISION_CONFLICT";
  throw error;
}

async function withArchiveWriteLock(rootPath, expectedRevision, operation) {
  const paths = libraryPaths(rootPath);
  const lock = await acquireFileTransactionLock(paths.root);
  try {
    const library = await readLibrary(paths);
    const expected = String(expectedRevision || "").trim();
    if (expected) {
      const structure = await scanConversationMetadata(paths);
      assertExpectedRevision({ revision: archiveRevision(structure.files, structure.directories) }, expected);
    }
    return await operation({ paths, library });
  } finally {
    await lock.release();
  }
}

export async function scanConversationArchive(pathsOrRoot, libraryDocument = null) {
  const paths = typeof pathsOrRoot === "string" ? libraryPaths(pathsOrRoot) : pathsOrRoot;
  const library = libraryDocument || await readLibrary(paths);
  const { files, directories, catalog, content_time_references } = await reconcileConversationCatalog(paths, library);
  const active = files.filter((file) => !file.archived);
  const archived = files.filter((file) => file.archived);
  return Object.freeze({
    files,
    directories,
    catalog,
    content_time_references,
    revision: archiveRevision(files, directories),
    counts: {
      active: active.length,
      archived: archived.length,
      directories: directories.length,
      active_size_bytes: active.reduce((total, file) => total + file.size_bytes, 0),
      archived_size_bytes: archived.reduce((total, file) => total + file.size_bytes, 0)
    }
  });
}

async function rewriteParseStatePaths(paths, replacements) {
  if (!replacements.size) return { changed: false, state: await loadParseState(paths.parseState) };
  const state = await loadParseState(paths.parseState);
  let changed = false;
  const sources = state.sources.map((source) => ({
    ...source,
    outputs: (source.outputs || []).map((output) => {
      const nextPath = replacements.get(output.path);
      if (!nextPath) return output;
      changed = true;
      return { ...output, path: nextPath };
    })
  }));
  const next = { ...state, sources };
  if (changed) await saveParseState(paths.parseState, next);
  return { changed, state: next };
}

async function validateMove(paths, relativePaths, destination) {
  const unique = [...new Set((relativePaths || []).map((value) => assertConversationRelative(value)))];
  if (!unique.length) throw new Error("Select at least one conversation");
  const destinationName = destination === ARCHIVE_DIRECTORY ? ARCHIVE_DIRECTORY : destination ? assertSafeSegment(destination) : "";
  const destinationRoot = destinationName ? path.join(paths.conversations, destinationName) : paths.conversations;
  const operations = [];
  for (const relative of unique) {
    const source = resolveConversationPath(paths, relative);
    const information = await lstat(source.absolute);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error(`Conversation is not a regular file: ${relative}`);
    const targetRelative = `Conversations/${destinationName ? `${destinationName}/` : ""}${path.basename(relative)}`;
    const target = resolveConversationPath(paths, targetRelative);
    if (source.relative === target.relative) continue;
    if (await pathExists(target.absolute)) throw new Error(`A file with the same name already exists in the target directory: ${path.basename(relative)}`);
    operations.push({ ...source, targetRelative: target.relative, targetAbsolute: target.absolute });
  }
  return { destinationName, destinationRoot, operations };
}

export async function moveConversationFiles(rootPath, relativePaths, destination = "", options = {}) {
  return withArchiveWriteLock(rootPath, options.expectedRevision, async ({ paths, library }) => {
    const plan = await validateMove(paths, relativePaths, destination);
    if (!plan.operations.length) return { ok: true, moved: [], destination: plan.destinationName, archive: await scanConversationArchive(paths, library) };
    await mkdir(plan.destinationRoot, { recursive: true });
    const moved = [];
    try {
      for (const item of plan.operations) {
        await rename(item.absolute, item.targetAbsolute);
        moved.push(item);
      }
      await rewriteParseStatePaths(paths, new Map(moved.map((item) => [item.relative, item.targetRelative])));
    } catch (error) {
      for (const item of moved.reverse()) {
        if (await pathExists(item.targetAbsolute) && !await pathExists(item.absolute)) {
          try { await rename(item.targetAbsolute, item.absolute); } catch { /* keep both paths observable for recovery */ }
        }
      }
      throw error;
    }
    return {
      ok: true,
      moved: moved.map((item) => ({ from: item.relative, to: item.targetRelative })),
      destination: plan.destinationName,
      archive: await scanConversationArchive(paths, library)
    };
  });
}

export async function archiveConversationFiles(rootPath, relativePaths, options = {}) {
  return moveConversationFiles(rootPath, relativePaths, ARCHIVE_DIRECTORY, options);
}

export async function createConversationDirectory(rootPath, directoryName, options = {}) {
  return withArchiveWriteLock(rootPath, options.expectedRevision, async ({ paths, library }) => {
    const name = assertSafeSegment(directoryName);
    await assertDirectoryNameAvailable(paths, name);
    await mkdir(path.join(paths.conversations, name), { recursive: false });
    return { ok: true, directory: name, archive: await scanConversationArchive(paths, library) };
  });
}

export async function renameConversationDirectory(rootPath, oldName, newName, options = {}) {
  return withArchiveWriteLock(rootPath, options.expectedRevision, async ({ paths, library }) => {
    const previous = assertSafeSegment(oldName);
    const next = assertSafeSegment(newName);
    if (previous === next) return { ok: true, directory: next, archive: await scanConversationArchive(paths, library) };
    const source = path.join(paths.conversations, previous);
    const target = path.join(paths.conversations, next);
    await assertDirectoryNameAvailable(paths, next, previous);
    const information = await lstat(source);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("The selected directory is not a regular directory");
    await rename(source, target);
    try {
      const state = await loadParseState(paths.parseState);
      const prefix = `Conversations/${previous}/`;
      const replacements = new Map();
      for (const sourceState of state.sources) {
        for (const output of sourceState.outputs || []) {
          if (output.path.startsWith(prefix)) replacements.set(output.path, `Conversations/${next}/${output.path.slice(prefix.length)}`);
        }
      }
      await rewriteParseStatePaths(paths, replacements);
    } catch (error) {
      try { await rename(target, source); } catch { /* keep the renamed directory observable for recovery */ }
      throw error;
    }
    return { ok: true, directory: next, archive: await scanConversationArchive(paths, library) };
  });
}

export async function removeConversationDirectory(rootPath, directoryName, options = {}) {
  return withArchiveWriteLock(rootPath, options.expectedRevision, async ({ paths, library }) => {
    const name = assertSafeSegment(directoryName);
    const target = path.join(paths.conversations, name);
    const entries = await readdir(target);
    if (entries.length) throw new Error("Only an empty conversation directory can be removed");
    await rmdir(target);
    return { ok: true, directory: name, archive: await scanConversationArchive(paths, library) };
  });
}

export async function prepareConversationRecycle(rootPath, relativePaths, options = {}) {
  return withArchiveWriteLock(rootPath, options.expectedRevision, async ({ paths }) => {
    const unique = [...new Set((relativePaths || []).map((value) => assertConversationRelative(value)))];
    if (!unique.length) throw new Error("Select at least one conversation");
    const files = [];
    for (const relative of unique) {
      const resolved = resolveConversationPath(paths, relative);
      const information = await lstat(resolved.absolute);
      if (!information.isFile() || information.isSymbolicLink()) throw new Error(`Conversation is not a regular file: ${relative}`);
      files.push({ relative_path: resolved.relative, absolute_path: resolved.absolute, size_bytes: information.size });
    }
    return { ok: true, files };
  });
}

export async function finalizeConversationRecycle(rootPath, relativePaths) {
  return withArchiveWriteLock(rootPath, "", async ({ paths, library }) => {
    const removed = new Set((relativePaths || []).map((value) => assertConversationRelative(value)));
    const state = await loadParseState(paths.parseState);
    let changed = false;
    const sources = state.sources.map((source) => {
      const outputs = (source.outputs || []).filter((output) => {
        if (!removed.has(output.path)) return true;
        changed = true;
        return false;
      });
      return outputs.length === (source.outputs || []).length ? source : { ...source, outputs };
    });
    if (changed) await saveParseState(paths.parseState, { ...state, sources });
    return { ok: true, removed: [...removed], archive: await scanConversationArchive(paths, library) };
  });
}

function markdownOutputName(file, used) {
  const stem = path.basename(file.relative_path, ".json");
  let name = `${stem}.md`;
  if (used.has(name.toLowerCase())) name = `${stem}--${createHash("sha256").update(file.relative_path).digest("hex").slice(0, 8)}.md`;
  used.add(name.toLowerCase());
  return name;
}

export async function exportConversationMarkdown(rootPath, relativePaths) {
  return withArchiveWriteLock(rootPath, "", async ({ paths, library }) => {
    const unique = [...new Set((relativePaths || []).map((value) => assertConversationRelative(value)))];
    if (!unique.length) throw new Error("Select at least one conversation");
    const used = new Set();
    const outputs = [];
    await mkdir(paths.exports, { recursive: true });
    for (const relative of unique) {
      const resolved = resolveConversationPath(paths, relative);
      const document = JSON.parse(await readFile(resolved.absolute, "utf8"));
      readerCore.assertConversation(document);
      const effective = applyConversationOverlay(document, library);
      const markdown = readerCore.documentToMarkdown(effective);
      const fileName = markdownOutputName({ relative_path: relative }, used);
      const output = path.join(paths.exports, fileName);
      const serialized = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
      const status = await atomicWriteText(output, serialized);
      outputs.push({
        source: relative,
        file_name: fileName,
        output,
        status,
        bytes: Buffer.byteLength(serialized),
        sha256: createHash("sha256").update(serialized).digest("hex")
      });
    }
    return { ok: true, outputs, directory: paths.exports };
  });
}
