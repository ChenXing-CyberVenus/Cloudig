#!/usr/bin/env node

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { initializeLibrary, libraryPaths } from "../library/src/init.mjs";
import { pathExists, sha256File } from "../parser/src/atomic.mjs";
import { extractClaudeConversations, indexClaudeExport } from "../parser/src/claude-library.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SYNTHETIC_TMP_ROOT = path.join(PROJECT_ROOT, "tmp");
const MIB = 1024 * 1024;
const KIB = 1024;
const DEFAULT_OPTIONS = Object.freeze({
  targetMb: 32,
  itemKib: 512,
  maxRssDeltaMb: 256,
  keep: false,
  runId: ""
});
const PROGRESS_FIELDS = Object.freeze(["bytesDone", "bytesTotal", "itemsDone", "phase"]);
const INDEX_PHASES = Object.freeze(["hash", "scan", "precommit"]);
const EXTRACTION_PHASES = Object.freeze(["slice", "convert", "stage", "precommit"]);

function usage() {
  return `Usage: node scripts/stress-claude-conversations.mjs [options]

Purely synthetic Claude conversations.json pressure and cancellation verifier.
It accepts no source path and never reads Organized or private exports.

Options:
  --target-mb <1-1024>          Approximate generated export size (default: 32)
  --item-kib <64-8192>          Approximate bytes per conversation (default: 512)
  --max-rss-delta-mb <64-4096>  Local RSS-delta regression gate (default: 256)
  --run-id <safe-token>          Deterministic synthetic temp-root token for a supervising test
  --keep                        Keep the generated ignored tmp directory
  --help                        Show this help

Example for a several-hundred-MB local run:
  node scripts/stress-claude-conversations.mjs --target-mb 300 --item-kib 512
`;
}

function boundedInteger(value, label, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return normalized;
}

function normalizedRunId(value) {
  const runId = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(runId)) {
    throw new TypeError("--run-id must contain 1-64 lowercase letters, digits or hyphens");
  }
  return runId;
}

export function syntheticPressureRoot(runId) {
  return path.join(SYNTHETIC_TMP_ROOT, `claude-synthetic-pressure-${normalizedRunId(runId)}`);
}

export function parsePressureArguments(argv = []) {
  const options = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument === "--keep") {
      options.keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${argument} requires a value`);
    if (argument === "--target-mb") {
      options.targetMb = boundedInteger(value, "--target-mb", 1, 1024);
    } else if (argument === "--item-kib") {
      options.itemKib = boundedInteger(value, "--item-kib", 64, 8192);
    } else if (argument === "--max-rss-delta-mb") {
      options.maxRssDeltaMb = boundedInteger(value, "--max-rss-delta-mb", 64, 4096);
    } else if (argument === "--run-id") {
      options.runId = normalizedRunId(value);
    } else {
      throw new TypeError(`Unknown option: ${argument}`);
    }
    index += 1;
  }
  return options;
}

async function writeWithBackpressure(stream, value) {
  if (stream.write(value)) return;
  await once(stream, "drain");
}

function syntheticConversation(index, payload) {
  const suffix = String(index).padStart(8, "0");
  return {
    uuid: `synthetic-conversation-${suffix}`,
    name: `Synthetic pressure conversation ${suffix}`,
    summary: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    account: { uuid: "synthetic-pressure-account" },
    chat_messages: [
      {
        uuid: `synthetic-message-${suffix}`,
        parent_message_uuid: null,
        sender: index % 2 === 0 ? "human" : "assistant",
        text: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        content: [{ type: "text", text: payload, citations: [] }],
        attachments: [],
        files: []
      }
    ]
  };
}

async function generateSyntheticExport(filePath, { targetBytes, itemBytes }) {
  const payloadBytes = Math.max(16 * KIB, itemBytes - 1024);
  const payload = "x".repeat(payloadBytes);
  const stream = createWriteStream(filePath, { encoding: "utf8", flags: "wx" });
  let bytesWritten = 0;
  let conversations = 0;
  try {
    await writeWithBackpressure(stream, "[");
    bytesWritten += 1;
    while (bytesWritten < targetBytes || conversations < 4) {
      const serialized = JSON.stringify(syntheticConversation(conversations, payload));
      const prefix = conversations ? "," : "";
      await writeWithBackpressure(stream, prefix);
      await writeWithBackpressure(stream, serialized);
      bytesWritten += Buffer.byteLength(prefix) + Buffer.byteLength(serialized);
      conversations += 1;
    }
    await writeWithBackpressure(stream, "]\n");
    bytesWritten += 2;
    stream.end();
    await finished(stream);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Object.freeze({ bytesWritten, conversations, payloadBytes });
}

function createMemoryTracker(gateBytes) {
  if (typeof global.gc === "function") global.gc();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeapUsed = baseline.heapUsed;
  function sample() {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
  }
  function summary() {
    sample();
    const rssDelta = Math.max(0, peakRss - baseline.rss);
    return Object.freeze({
      baseline_rss_bytes: baseline.rss,
      peak_rss_bytes: peakRss,
      rss_delta_bytes: rssDelta,
      gate_bytes: gateBytes,
      within_gate: rssDelta <= gateBytes,
      baseline_heap_used_bytes: baseline.heapUsed,
      peak_heap_used_bytes: peakHeapUsed,
      gc_exposed: typeof global.gc === "function",
      interpretation: "Local regression gate only; not a cross-machine absolute memory guarantee."
    });
  }
  return Object.freeze({ sample, summary });
}

function progressCollector(memory) {
  const events = [];
  return Object.freeze({
    events,
    onProgress(event) {
      memory.sample();
      events.push(event);
    }
  });
}

function validateProgress(events, allowedPhases, label, requiredPhases = allowedPhases) {
  assert.ok(events.length > 0, `${label} emitted no progress`);
  const allowed = new Set(allowedPhases);
  const required = new Set(requiredPhases);
  const seen = new Set();
  const previous = new Map();
  const phaseCounts = Object.create(null);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [...PROGRESS_FIELDS], `${label} exposed progress fields outside the contract`);
    assert.ok(Object.isFrozen(event), `${label} progress event was mutable`);
    assert.ok(allowed.has(event.phase), `${label} emitted an unexpected phase ${event.phase}`);
    assert.ok(Number.isSafeInteger(event.bytesDone) && event.bytesDone >= 0, `${label} bytesDone was invalid`);
    assert.ok(Number.isSafeInteger(event.bytesTotal) && event.bytesTotal >= 0, `${label} bytesTotal was invalid`);
    assert.ok(Number.isSafeInteger(event.itemsDone) && event.itemsDone >= 0, `${label} itemsDone was invalid`);
    assert.ok(event.bytesDone <= event.bytesTotal, `${label} bytesDone exceeded bytesTotal`);
    const last = previous.get(event.phase);
    if (last) {
      assert.ok(event.bytesDone >= last.bytesDone, `${label} ${event.phase} bytes regressed`);
      assert.ok(event.itemsDone >= last.itemsDone, `${label} ${event.phase} items regressed`);
      assert.equal(event.bytesTotal, last.bytesTotal, `${label} ${event.phase} bytesTotal changed`);
    }
    previous.set(event.phase, event);
    seen.add(event.phase);
    phaseCounts[event.phase] = (phaseCounts[event.phase] || 0) + 1;
  }
  for (const phase of required) assert.ok(seen.has(phase), `${label} omitted required phase ${phase}`);
  return Object.freeze({ events: events.length, phases: phaseCounts });
}

function shouldCancelAt(event, phase) {
  if (event.phase !== phase) return false;
  if (phase === "convert") return event.itemsDone > 0;
  if (phase === "stage" || phase === "precommit") return true;
  return event.bytesDone > 0;
}

async function captureOperationalState(paths) {
  const entries = [];
  for (const [label, directory] of [["Conversations", paths.conversations], ["Data/Indexes", paths.indexes]]) {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relative = `${label}/${child.name}`;
      if (child.isDirectory()) {
        entries.push({ type: "directory", path: relative });
        continue;
      }
      const absolute = path.join(directory, child.name);
      const information = await stat(absolute, { bigint: true });
      entries.push({
        type: "file",
        path: relative,
        size: information.size.toString(),
        mtime_ns: information.mtimeNs.toString(),
        sha256: await sha256File(absolute)
      });
    }
  }
  if (await pathExists(paths.parseState)) {
    const information = await stat(paths.parseState, { bigint: true });
    entries.push({
      type: "file",
      path: "Data/parse-state.json",
      size: information.size.toString(),
      mtime_ns: information.mtimeNs.toString(),
      sha256: await sha256File(paths.parseState)
    });
  }
  return JSON.stringify(entries);
}

async function stagedDirectories(paths) {
  return (await readdir(paths.conversations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".cloudig-stage-"))
    .map((entry) => entry.name)
    .sort();
}

async function verifyCancellation({ label, phase, paths, memory, allowedPhases, operation }) {
  const before = await captureOperationalState(paths);
  const controller = new AbortController();
  const collector = progressCollector(memory);
  let caught = null;
  try {
    await operation({
      signal: controller.signal,
      onProgress(event) {
        collector.onProgress(event);
        if (!controller.signal.aborted && shouldCancelAt(event, phase)) controller.abort();
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.name, "AbortError", `${label} cancellation did not throw AbortError`);
  assert.equal(caught?.code, "ABORT_ERR", `${label} cancellation did not expose ABORT_ERR`);
  assert.ok(collector.events.some((event) => event.phase === phase), `${label} emitted no ${phase} event`);
  const progress = validateProgress(
    collector.events,
    allowedPhases,
    `${label} cancellation`,
    [phase]
  );
  assert.equal(await captureOperationalState(paths), before, `${label} cancellation changed committed state`);
  assert.deepEqual(await stagedDirectories(paths), [], `${label} cancellation left a stage directory`);
  return Object.freeze({ phase, progress_events: progress.events });
}

async function verifyUnchangedFailure({ label, matcher, paths, memory, operation }) {
  const before = await captureOperationalState(paths);
  let caught = null;
  try {
    await operation({ onProgress: () => memory.sample() });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `${label} did not fail`);
  assert.match(String(caught.message), matcher, `${label} failed for the wrong reason`);
  assert.equal(await captureOperationalState(paths), before, `${label} changed committed state`);
  assert.deepEqual(await stagedDirectories(paths), [], `${label} left a stage directory`);
  return Object.freeze({ label, error: caught.name || "Error" });
}

function elapsedSince(started) {
  return Math.round(performance.now() - started);
}

export async function runSyntheticClaudePressure(rawOptions = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    targetMb: boundedInteger(rawOptions.targetMb ?? DEFAULT_OPTIONS.targetMb, "targetMb", 1, 1024),
    itemKib: boundedInteger(rawOptions.itemKib ?? DEFAULT_OPTIONS.itemKib, "itemKib", 64, 8192),
    maxRssDeltaMb: boundedInteger(
      rawOptions.maxRssDeltaMb ?? DEFAULT_OPTIONS.maxRssDeltaMb,
      "maxRssDeltaMb",
      64,
      4096
    ),
    keep: rawOptions.keep === true
  };
  options.runId = rawOptions.runId ? normalizedRunId(rawOptions.runId) : randomUUID();
  await mkdir(SYNTHETIC_TMP_ROOT, { recursive: true });
  const root = syntheticPressureRoot(options.runId);
  await mkdir(root, { recursive: false });
  const paths = libraryPaths(root);
  const sourceName = "conversations.json";
  const sourcePath = path.join(paths.inbox, sourceName);
  const started = performance.now();
  let cleaned = false;
  try {
    await initializeLibrary(root);
    const generationStarted = performance.now();
    const generated = await generateSyntheticExport(sourcePath, {
      targetBytes: options.targetMb * MIB,
      itemBytes: options.itemKib * KIB
    });
    const generationMs = elapsedSince(generationStarted);

    const memory = createMemoryTracker(options.maxRssDeltaMb * MIB);
    const indexCollector = progressCollector(memory);
    const indexStarted = performance.now();
    const indexed = await indexClaudeExport(root, sourceName, { onProgress: indexCollector.onProgress });
    const indexMs = elapsedSince(indexStarted);
    const indexProgress = validateProgress(indexCollector.events, INDEX_PHASES, "successful index");
    assert.equal(indexed.counts.total, generated.conversations, "index conversation count did not match synthesis");
    assert.ok(indexed.conversations.length >= 4, "synthetic export needs at least four conversations");

    const keys = indexed.conversations.slice(0, Math.min(32, indexed.conversations.length))
      .map((record) => record.conversation_key);
    const extractionCollector = progressCollector(memory);
    const extractionStarted = performance.now();
    await extractClaudeConversations(root, sourceName, keys, {
      onProgress: extractionCollector.onProgress
    });
    const extractionMs = elapsedSince(extractionStarted);
    const extractionProgress = validateProgress(
      extractionCollector.events,
      EXTRACTION_PHASES,
      "successful extraction"
    );

    const indexCancellations = [];
    for (const phase of INDEX_PHASES) {
      indexCancellations.push(await verifyCancellation({
        label: `index:${phase}`,
        phase,
        paths,
        memory,
        allowedPhases: INDEX_PHASES,
        operation: (progressOptions) => indexClaudeExport(root, sourceName, {
          ...progressOptions,
          force: true
        })
      }));
    }

    const extractionCancellations = [];
    for (const phase of EXTRACTION_PHASES) {
      extractionCancellations.push(await verifyCancellation({
        label: `extraction:${phase}`,
        phase,
        paths,
        memory,
        allowedPhases: EXTRACTION_PHASES,
        operation: (progressOptions) => extractClaudeConversations(
          root,
          sourceName,
          keys,
          progressOptions
        )
      }));
    }

    const resourceLimits = [];
    resourceLimits.push(await verifyUnchangedFailure({
      label: "index item-count limit",
      matcher: /1-item index limit/u,
      paths,
      memory,
      operation: (progressOptions) => indexClaudeExport(root, sourceName, {
        ...progressOptions,
        force: true,
        limits: { maxIndexItems: 1 }
      })
    }));
    resourceLimits.push(await verifyUnchangedFailure({
      label: "extraction transaction disk-footprint limit",
      matcher: /staging, journal and rollback snapshots/u,
      paths,
      memory,
      operation: (progressOptions) => extractClaudeConversations(root, sourceName, [keys[1]], {
        ...progressOptions,
        limits: { maxTransactionDiskBytes: 1 }
      })
    }));
    resourceLimits.push(await verifyUnchangedFailure({
      label: "index per-item byte limit",
      matcher: /exceeds the 1-byte item limit/u,
      paths,
      memory,
      operation: (progressOptions) => indexClaudeExport(root, sourceName, {
        ...progressOptions,
        force: true,
        limits: { maxItemBytes: 1 }
      })
    }));
    resourceLimits.push(await verifyUnchangedFailure({
      label: "extraction selection-count limit",
      matcher: /At most 1/u,
      paths,
      memory,
      operation: (progressOptions) => extractClaudeConversations(root, sourceName, [keys[1], keys[2]], {
        ...progressOptions,
        limits: { maxSelection: 1 }
      })
    }));
    resourceLimits.push(await verifyUnchangedFailure({
      label: "extraction transaction-input limit",
      matcher: /transaction input limit/u,
      paths,
      memory,
      operation: (progressOptions) => extractClaudeConversations(root, sourceName, [keys[1]], {
        ...progressOptions,
        limits: { maxSelectedInputBytes: 1 }
      })
    }));
    resourceLimits.push(await verifyUnchangedFailure({
      label: "extraction per-item byte limit",
      matcher: /item limit/u,
      paths,
      memory,
      operation: (progressOptions) => extractClaudeConversations(root, sourceName, [keys[1]], {
        ...progressOptions,
        limits: { maxItemBytes: 1 }
      })
    }));

    assert.deepEqual(await stagedDirectories(paths), [], "pressure run left a staged output directory");
    const memorySummary = memory.summary();
    assert.ok(
      memorySummary.within_gate,
      `Local RSS delta ${memorySummary.rss_delta_bytes} exceeded gate ${memorySummary.gate_bytes}`
    );
    const summary = {
      ok: true,
      schema: "cloudig/claude-synthetic-pressure/0.1.0",
      synthetic_only: true,
      node: process.version,
      requested_target_mb: options.targetMb,
      actual_source_bytes: generated.bytesWritten,
      conversations: generated.conversations,
      approximate_item_kib: options.itemKib,
      payload_bytes_per_conversation: generated.payloadBytes,
      timings_ms: {
        generation: generationMs,
        initial_index: indexMs,
        initial_extraction: extractionMs,
        total: elapsedSince(started)
      },
      progress: {
        fields: PROGRESS_FIELDS,
        monotonic_scope: "within_each_phase",
        successful_index: indexProgress,
        successful_extraction: extractionProgress
      },
      coverage: {
        successful_extraction_selected: keys.length,
        hard_defaults_not_exercised: [
          "maxIndexItems=250000",
          "maxSelection=2000",
          "maxSelectedInputBytes=2147483648",
          "maxTransactionDiskBytes=8589934592"
        ]
      },
      cancellations: {
        index: indexCancellations,
        extraction: extractionCancellations,
        committed_state_unchanged: true,
        stage_directories_remaining: 0
      },
      resource_limits: resourceLimits,
      memory: memorySummary,
      cleanup: {
        requested_keep: options.keep,
        performed: false
      }
    };
    if (!options.keep) {
      await rm(root, { recursive: true, force: true });
      cleaned = true;
      summary.cleanup.performed = true;
    } else {
      summary.cleanup.synthetic_root = root;
    }
    return summary;
  } finally {
    if (!options.keep && !cleaned) await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parsePressureArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const summary = await runSyntheticClaudePressure(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
