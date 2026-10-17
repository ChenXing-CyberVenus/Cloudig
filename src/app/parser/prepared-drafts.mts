import { availableParallelism, freemem } from "node:os";
import { Worker } from "node:worker_threads";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { resolveManagedPath } from "../../adapters/storage/path.mts";
import { checkCacheSpace } from "../../adapters/storage/runtime-cache.mts";
import type { ByteFingerprint } from "../../adapters/storage/stream.mts";
import type { ParsedSourceDraft } from "./adapter.mts";

type Progress = { phase: "fingerprint" | "extract" | "normalize"; completed: number; total: number };
export type DraftPreview = { parsed: ParsedSourceDraft; messages: number; resources: number; mtimeNs: string };
type Outcome = { ok: true; preview: DraftPreview } | { ok: false; error: Error };
type Job = { index: number; source: string; file: string; spool: string; bytes: number; mtimeNs: string; fingerprint?: ByteFingerprint };
type Options = { runtimeRoot: string; signal?: AbortSignal; threshold?: number; workers?: number; onProgress?: (index: number, progress: Progress) => void };

export function parserParallelism(logical = availableParallelism(), free = freemem()): number {
  // Leave CPU and memory for Windows and the Reader. A large individual source
  // runs alone; this is admission control, not a new maximum input-file size.
  return Math.max(1, Math.min(6, logical - 2, Math.floor(free / (1536 * 1024 ** 2))));
}

export class PreparedDraftStore {
  readonly #root: string;
  readonly #relative: string;
  readonly #jobs: Job[] = [];
  readonly #bySource = new Map<string, Job>();
  readonly #outcomes: Promise<Outcome>[] = [];
  readonly #resolve: Array<(outcome: Outcome) => void> = [];
  readonly #slots: Array<{ worker: Worker; job?: Job }> = [];
  readonly #options: Options;
  readonly #memoryBudget = Math.max(32 * 1024 ** 2, Math.min(512 * 1024 ** 2, freemem() / 8));
  #next = 0;
  #activeBytes = 0;
  #closing = false;
  #disposed = false;
  #shutdown?: Promise<void>;
  #abort = () => this.#stop(new DOMException("Parser preparation cancelled", "AbortError"));
  readonly metrics = { workers: 0, maxActive: 0, peakRss: 0, parsed: 0, spoolBytes: 0, threadIds: [] as number[] };

  get size(): number { return this.#bySource.size; }
  has(source: string): boolean { return Boolean(this.#bySource.get(source)?.fingerprint); }
  observation(source: string): { bytes: number; mtimeNs: string } | undefined {
    const job = this.#bySource.get(source);
    return job ? { bytes: job.bytes, mtimeNs: job.mtimeNs } : undefined;
  }

  private constructor(root: string, relative: string, options: Options) {
    this.#root = root; this.#relative = relative; this.#options = options;
  }

  static async create(root: string, sources: readonly string[], options: Options): Promise<PreparedDraftStore> {
    await checkCacheSpace(options.runtimeRoot);
    const relative = `ParserDrafts/p_${randomBytes(16).toString("hex")}`;
    const store = new PreparedDraftStore(options.runtimeRoot, relative, options);
    const inbox = await resolveManagedPath(root, "Inbox", { mustExist: true });
    const directory = await resolveManagedPath(options.runtimeRoot, relative);
    await mkdir(directory, { recursive: true });
    try {
      for (const [index, source] of sources.entries()) {
        store.#outcomes.push(new Promise(resolve => { store.#resolve[index] = resolve; }));
        try {
          if (!/^Inbox\/[^/\\]+$/u.test(source)) throw new TypeError("Parser source must be a direct Inbox file");
          const file = path.join(inbox, source.slice("Inbox/".length));
          const info = await lstat(file, { bigint: true });
          if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("Parser source must be a confined ordinary file");
          const bytes = Number(info.size);
          if (!Number.isSafeInteger(bytes)) throw new RangeError("Parser source size exceeds I-JSON");
          const job: Job = { index, source, file, bytes, mtimeNs: String(info.mtimeNs), spool: path.join(directory, `${index}.bin`) };
          store.#jobs.push(job); store.#bySource.set(source, job);
        } catch (error) { store.#resolve[index]!({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }); }
      }
      if (options.signal?.aborted) { store.#abort(); return store; }
      options.signal?.addEventListener("abort", store.#abort, { once: true });
      if (options.workers !== undefined && (!Number.isSafeInteger(options.workers) || options.workers < 1)) throw new RangeError("Parser worker count must be positive");
      const count = Math.min(store.#jobs.length, options.workers ?? parserParallelism(), parserParallelism());
      store.metrics.workers = count;
      const url = new URL(import.meta.url.endsWith(".mts") ? "./worker-entry.mts" : "./parser-worker.mjs", import.meta.url);
      for (let index = 0; index < count; index++) {
        const worker = new Worker(url, { name: `cloudig-parser-${index + 1}` });
        const slot: { worker: Worker; job?: Job } = { worker };
        store.#slots.push(slot);
        worker.on("message", message => {
          if (store.#closing || !slot.job || message.index !== slot.job.index) return;
          store.metrics.peakRss = Math.max(store.metrics.peakRss, Number(message.rss) || 0);
          if (message.type === "progress") {
            try { options.onProgress?.(slot.job.index, message.progress); }
            catch (error) { store.#stop(error instanceof Error ? error : new Error(String(error))); }
            return;
          }
          const job = slot.job;
          if (Number.isInteger(message.threadId) && !store.metrics.threadIds.includes(message.threadId)) store.metrics.threadIds.push(message.threadId);
          if (message.type === "result") {
            job.fingerprint = message.fingerprint;
            store.metrics.parsed++;
            store.metrics.spoolBytes += job.fingerprint!.bytes;
            store.#resolve[job.index]!({ ok: true, preview: { ...message.preview, mtimeNs: job.mtimeNs } });
          } else {
            const detail = message.error;
            const error = detail?.name === "SyntaxError" ? new SyntaxError(detail.message) : detail?.name === "TypeError" ? new TypeError(detail.message) : new Error(detail?.message ?? "Parser worker failed");
            store.#resolve[job.index]!({ ok: false, error });
          }
          store.#activeBytes -= store.#cost(job);
          delete slot.job;
          store.#dispatch();
        });
        worker.on("error", error => store.#stop(error));
        worker.on("exit", code => { if (!store.#closing) store.#stop(new Error(`Parser worker exited unexpectedly (${code})`)); });
      }
      store.#dispatch();
      return store;
    } catch (error) { await store.dispose(); throw error; }
  }

  #cost(job: Job): number { return Math.max(8 * 1024 ** 2, job.bytes * 8); }
  #dispatch(): void {
    if (this.#closing) return;
    for (const slot of this.#slots) {
      if (slot.job || this.#next >= this.#jobs.length) continue;
      const job = this.#jobs[this.#next]!;
      const cost = this.#cost(job);
      if (this.#activeBytes > 0 && this.#activeBytes + cost > this.#memoryBudget) continue;
      this.#next++; slot.job = job; this.#activeBytes += cost;
      this.metrics.maxActive = Math.max(this.metrics.maxActive, this.#slots.filter(entry => entry.job).length);
      slot.worker.postMessage({ index: job.index, file: job.file, spool: job.spool, temporaryRoot: path.dirname(job.spool), ...(this.#options.threshold === undefined ? {} : { threshold: this.#options.threshold }) });
    }
  }

  #stop(error: Error): void {
    if (this.#closing) return;
    this.#closing = true;
    for (const job of this.#jobs) this.#resolve[job.index]!({ ok: false, error });
    this.#shutdown = Promise.all(this.#slots.map(slot => slot.worker.terminate())).then(() => undefined);
  }

  async preview(index: number): Promise<DraftPreview> {
    const outcome = await this.#outcomes[index]!;
    if (!outcome.ok) throw outcome.error;
    return outcome.preview;
  }

  async finish(): Promise<void> {
    await Promise.all(this.#outcomes);
    this.#options.signal?.removeEventListener("abort", this.#abort);
    if (!this.#closing) {
      this.#closing = true;
      this.#shutdown = Promise.all(this.#slots.map(slot => slot.worker.terminate())).then(() => undefined);
    }
    await this.#shutdown;
  }

  async take(source: string): Promise<ParsedSourceDraft | undefined> {
    const job = this.#bySource.get(source);
    if (!job?.fingerprint || this.#disposed) return undefined;
    let exact: string;
    let bytes: Buffer;
    try {
      exact = await resolveManagedPath(this.#root, `${this.#relative}/${job.index}.bin`, { mustExist: true });
      bytes = await readFile(exact);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("解析准备缓存已清除，请重新准备解析；现有档案未改动。");
      throw error;
    }
    if (bytes.length !== job.fingerprint.bytes || createHash("sha256").update(bytes).digest("hex") !== job.fingerprint.sha256) throw new TypeError("Prepared Parser draft changed after preview");
    const parsed = deserialize(bytes) as ParsedSourceDraft;
    await unlink(exact); this.#bySource.delete(source);
    return parsed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.signal?.removeEventListener("abort", this.#abort);
    if (!this.#closing) this.#stop(new DOMException("Parser preparation disposed", "AbortError"));
    await this.#shutdown;
    const exact = await resolveManagedPath(this.#root, this.#relative);
    await rm(exact, { recursive: true, force: true });
    this.#bySource.clear();
  }
}
