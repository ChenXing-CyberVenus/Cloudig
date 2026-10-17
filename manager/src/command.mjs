#!/usr/bin/env node

import process from "node:process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  buildDesktopReader,
  buildPortableReader,
  createLibrary,
  dismissMissingSources,
  executeParseBatch,
  getParseBatchSettings,
  importFiles,
  importLibraryAsset,
  indexClaudeLibraryExport,
  librarySummary,
  listLibraryStateHistory,
  parseLibrary,
  prepareEmptyLegacyLibraryV1,
  parseClaudeLibrarySelection,
  planLibraryRelocation,
  planParseBatch,
  readConversationForReader,
  readClaudeLibraryIndex,
  recoverLibraryRelocation,
  restoreLibraryStateBackup,
  saveLibraryOverlay,
  saveMarkdownExport,
  setParseBatchSettings,
  executeLibraryRelocation
} from "./service.mjs";
import {
  archiveConversationFiles,
  createConversationDirectory,
  exportConversationMarkdown,
  finalizeConversationRecycle,
  moveConversationFiles,
  prepareConversationRecycle,
  removeConversationDirectory,
  renameConversationDirectory,
  scanConversationArchive
} from "./archive-library.mjs";
import {
  commitContainmentCommand,
  commitConversationMetadata,
  commitCounterpartCommand,
  commitLibraryPreferencesCommand,
  commitSovereignDisplayOrderCommand,
  commitTerranPresetCommand,
  commitTerranMappingCommand,
  commitTimeNodeDeletionCommand,
  commitTimeReferenceRemoval,
  commitTimeTimelineMutation,
  commitTimeNodeCommand,
  getTimeSystem,
  planTimeNodeDeletion,
  planTimeReferenceRemoval,
  planTimeTimelineMutation,
  previewTimeRange
} from "./content-time-service.mjs";

async function readRequest() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error("Cloudig Manager command requires one JSON request on stdin");
  const request = JSON.parse(text);
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Manager request must be an object");
  return request;
}

export async function handleCommand(request, { signal = null, onProgress = null, onCheckpoint = null } = {}) {
  const payload = request.payload && typeof request.payload === "object" ? request.payload : {};
  switch (request.command) {
    case "library.summary":
      return librarySummary(payload.root);
    case "library.create":
      return createLibrary(payload.root, payload.options || {});
    case "library.prepare-empty-v1":
      return prepareEmptyLegacyLibraryV1(payload.root, payload.options || {});
    case "library.move.plan":
      return planLibraryRelocation(payload.root, payload.target, { signal, onProgress });
    case "library.move.execute":
      return executeLibraryRelocation(payload.plan, { signal, onProgress, onCheckpoint });
    case "library.move.recover":
      return recoverLibraryRelocation(payload.plan, { signal, onProgress, onCheckpoint });
    case "files.import":
      return importFiles(payload.root, payload.files || []);
    case "asset.import":
      return importLibraryAsset(payload.root, payload.file, payload.usage);
    case "parse.all":
      return parseLibrary(payload.root, { force: payload.force === true });
    case "parse.file":
      return parseLibrary(payload.root, { selectedFile: payload.file, force: payload.force === true, preservePrevious: payload.preserve_previous === true });
    case "parse.settings.get":
      return getParseBatchSettings(payload.root);
    case "parse.settings.save":
      return setParseBatchSettings(payload.root, payload.settings || {});
    case "parse.batch.plan":
      return planParseBatch(payload.root, { selectedFiles: payload.selected_files || [] });
    case "parse.batch.execute":
      return executeParseBatch(payload.root, payload.plan, { signal, onProgress });
    case "parse.dismiss-missing":
      return dismissMissingSources(payload.root, { sourcePath: payload.source_path });
    case "parse.dismiss-all-missing":
      return dismissMissingSources(payload.root, { all: true });
    case "claude.index":
      return indexClaudeLibraryExport(payload.root, payload.file, {
        force: payload.force === true,
        signal,
        onProgress
      });
    case "claude.list":
      return readClaudeLibraryIndex(payload.root, payload.file);
    case "claude.extract":
      return parseClaudeLibrarySelection(
        payload.root,
        payload.file,
        payload.conversation_keys || payload.conversation_ids || [],
        {
          preservePrevious: payload.preserve_previous === true,
          signal,
          onProgress
        }
      );
    case "reader.build":
      if (payload.mode === "desktop_catalog") return buildDesktopReader(payload.root, { signal, onProgress });
      if (payload.mode && payload.mode !== "portable") throw new Error(`Unsupported Cloudig Reader build mode: ${payload.mode}`);
      return buildPortableReader(payload.root, payload.output || "", { signal, onProgress });
    case "reader.conversation.read":
      return readConversationForReader(payload.root, payload.relative_path, payload.expected_sha256);
    case "library.save":
      return saveLibraryOverlay(payload.root, payload.library, payload.expected_sha256 || "");
    case "time.range.preview":
      return previewTimeRange(payload);
    case "time.system.get":
      return getTimeSystem(payload.root);
    case "conversation.metadata.commit":
      return commitConversationMetadata(payload.root, payload);
    case "library.preferences.commit":
      return commitLibraryPreferencesCommand(payload.root, payload);
    case "time.node.commit":
      return commitTimeNodeCommand(payload.root, payload);
    case "time.containment.commit":
      return commitContainmentCommand(payload.root, payload);
    case "time.counterpart.commit":
      return commitCounterpartCommand(payload.root, payload);
    case "time.terran-mapping.commit":
      return commitTerranMappingCommand(payload.root, payload);
    case "time.terran-preset.commit":
      return commitTerranPresetCommand(payload.root, payload);
    case "time.display-order.commit":
      return commitSovereignDisplayOrderCommand(payload.root, payload);
    case "time.node.delete.plan":
      return planTimeNodeDeletion(payload.root, payload);
    case "time.node.delete.commit":
      return commitTimeNodeDeletionCommand(payload.root, payload);
    case "time.reference.remove.plan":
      return planTimeReferenceRemoval(payload.root, payload);
    case "time.reference.remove.commit":
      return commitTimeReferenceRemoval(payload.root, payload);
    case "time.timeline.plan":
      return planTimeTimelineMutation(payload.root, payload);
    case "time.timeline.commit":
      return commitTimeTimelineMutation(payload.root, payload);
    case "library.history.list":
      return listLibraryStateHistory(payload.root);
    case "library.history.restore":
      return restoreLibraryStateBackup(payload.root, payload.backup_id, payload.expected_sha256 || "");
    case "archive.list":
      return scanConversationArchive(payload.root);
    case "archive.directory.create":
      return createConversationDirectory(payload.root, payload.name, { expectedRevision: payload.expected_revision });
    case "archive.directory.rename":
      return renameConversationDirectory(payload.root, payload.old_name, payload.new_name, { expectedRevision: payload.expected_revision });
    case "archive.directory.remove":
      return removeConversationDirectory(payload.root, payload.name, { expectedRevision: payload.expected_revision });
    case "archive.move":
      return moveConversationFiles(payload.root, payload.relative_paths || [], payload.destination || "", { expectedRevision: payload.expected_revision });
    case "archive.archive":
      return archiveConversationFiles(payload.root, payload.relative_paths || [], { expectedRevision: payload.expected_revision });
    case "archive.recycle.prepare":
      return prepareConversationRecycle(payload.root, payload.relative_paths || [], { expectedRevision: payload.expected_revision });
    case "archive.recycle.finalize":
      return finalizeConversationRecycle(payload.root, payload.relative_paths || []);
    case "archive.export-markdown":
      return exportConversationMarkdown(payload.root, payload.relative_paths || []);
    case "export.markdown":
      return saveMarkdownExport(payload.root, payload.file_name, payload.markdown);
    default:
      throw new Error(`Unsupported Cloudig Manager command: ${request.command}`);
  }
}

function streamError(error, kind) {
  const code = String(error?.code || (error?.name === "AbortError" ? "ABORT_ERR" : "manager_command_failed"));
  return {
    code,
    kind,
    retryable: code === "ABORT_ERR",
    message: String(error?.message || error).split(/\r?\n/u)[0]
  };
}

function writeStreamEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runEventProtocol() {
  const controller = new AbortController();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let requestReceived = false;
  let commitWaiter = null;
  let resolveRequest;
  let rejectRequest;
  const requestReady = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  input.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      const message = JSON.parse(text);
      if (!requestReceived) {
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Manager request must be an object");
        requestReceived = true;
        resolveRequest(message);
        return;
      }
      if (message?.type === "cancel") controller.abort();
      else if (message?.type === "commit" && commitWaiter) {
        const waiter = commitWaiter;
        commitWaiter = null;
        waiter.resolve();
      }
    } catch (error) {
      if (!requestReceived) rejectRequest(error);
    }
  });
  input.once("close", () => {
    if (!requestReceived) rejectRequest(new Error("Cloudig Manager event command requires one JSON request line on stdin"));
    if (commitWaiter) {
      const waiter = commitWaiter;
      commitWaiter = null;
      waiter.reject(Object.assign(new Error("Cloudig desktop host closed before committing the library move"), { code: "ABORT_ERR", name: "AbortError" }));
    }
  });

  let operationId = randomUUID();
  let kind = "unknown";
  let lastProgressAt = 0;
  let lastProgressPhase = "";
  try {
    const request = await requestReady;
    operationId = String(request.operation_id || operationId);
    kind = String(request.command || "unknown");
    writeStreamEvent({ type: "started", operation_id: operationId, kind });
    const result = await handleCommand(request, {
      signal: controller.signal,
      onProgress(progress) {
        const now = Date.now();
        const phaseChanged = progress.phase !== lastProgressPhase;
        const phaseComplete = progress.bytesTotal > 0 && progress.bytesDone >= progress.bytesTotal;
        if (!phaseChanged && !phaseComplete && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        lastProgressPhase = progress.phase;
        writeStreamEvent({
          type: "progress",
          operation_id: operationId,
          kind,
          phase: progress.phase,
          bytes_done: progress.bytesDone,
          bytes_total: progress.bytesTotal,
          items_done: progress.itemsDone
        });
      },
      async onCheckpoint(checkpoint) {
        if (commitWaiter) throw new Error("Cloudig Manager event protocol already has a pending commit checkpoint");
        writeStreamEvent({
          type: "checkpoint",
          operation_id: operationId,
          kind,
          ...checkpoint
        });
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            controller.signal.removeEventListener("abort", onAbort);
            if (commitWaiter) commitWaiter = null;
            reject(Object.assign(new Error("Cloudig library move was cancelled before pointer commit"), { code: "ABORT_ERR", name: "AbortError" }));
          };
          commitWaiter = {
            resolve() {
              controller.signal.removeEventListener("abort", onAbort);
              resolve();
            },
            reject(error) {
              controller.signal.removeEventListener("abort", onAbort);
              reject(error);
            }
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
      }
    });
    writeStreamEvent({ type: "result", operation_id: operationId, kind, result });
  } catch (error) {
    writeStreamEvent({ type: "error", operation_id: operationId, kind, error: streamError(error, kind) });
    process.exitCode = 1;
  } finally {
    input.close();
    process.stdin.pause();
  }
}

const isDirectExecution = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  if (process.argv.includes("--events")) {
    await runEventProtocol();
  } else {
    let request = null;
    try {
      request = await readRequest();
      const result = await handleCommand(request);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: streamError(error, String(request?.command || "unknown")) })}\n`);
      process.exitCode = 1;
    }
  }
}
