import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseRecordJson } from "../../core/records/index.mts";
import { confinedRelativePath, isConversationLocation } from "../../core/records/layout.mts";
import { uuidV7 } from "../../core/records/ids.mts";
import { acquireRecordSnapshot, readStoredRecord, readStoredConversationMetadata, resolveRecordPath, withRecordSnapshot } from "../storage/record-store.mts";
import { fingerprintFile } from "../storage/stream.mts";
import { readRecordCatalog, uniqueConversation, uniqueMark } from "./record-catalog.mts";
import type { RecordConversationSelection } from "./record-file-operations.mts";
import schema from "./record-recycle.schema.json" with { type: "json" };

type RecycleFile = { kind: "conversation" | "mark"; path: string; bytes: number; sha256: string };
type RecyclePlan = { schema: "cloudig/recycle/1.0.0"; operation_id: string; conversation_id: string; created_at: string; files: RecycleFile[] };
const validate = new Ajv2020({ strict: true }).compile(schema), base = "appdata/recycle", UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex"), missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const location = (id: string) => { if (!UUID.test(id)) throw new TypeError("Invalid recycle operation"); return `${base}/${id}.json`; };
function checked(value: unknown, id: string): RecyclePlan {
  if (!validate(value)) throw new TypeError("Invalid recycle intent; its original is preserved"); const plan = value as RecyclePlan;
  if (plan.operation_id !== id || !Number.isFinite(Date.parse(plan.created_at)) || plan.files[0]?.kind !== "conversation" || plan.files[1]?.kind === "conversation") throw new TypeError("Invalid recycle pair");
  for (const file of plan.files) {
    confinedRelativePath(file.path);
    if (file.kind === "conversation" ? !isConversationLocation(file.path) : !/^Marks\/[a-f0-9-]+\.json$/u.test(file.path)) throw new TypeError("Recycle intent is outside the original-record scope");
  }
  return plan;
}
async function load(root: string, id: string) { const bytes = await readFile(await resolveRecordPath(root, location(id))); return { plan: checked(parseRecordJson(bytes.toString("utf8")), id), sha256: hash(bytes) }; }
async function pendingUnlocked(root: string) {
  const plans: Awaited<ReturnType<typeof load>>[] = [], issues: { path: string; message: string }[] = []; let entries;
  try { entries = await readdir(await resolveRecordPath(root, base), { withFileTypes: true }); } catch (e) { if (missing(e)) return { plans, issues }; throw e; }
  for (const entry of entries) {
    const id = entry.name.replace(/\.json$/u, "");
    try { if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json") || !UUID.test(id)) throw new TypeError("Unrecognized recycle intent is preserved"); plans.push(await load(root, id)); }
    catch (e) { issues.push({ path: `${base}/${entry.name}`, message: e instanceof Error ? e.message : String(e) }); }
  }
  return { plans, issues };
}
/** Inspection never deletes originals or auto-resumes a native delete. */
export async function pendingRecordRecycles(root: string) {
  return withRecordSnapshot(root, async () => {
    const found = await pendingUnlocked(root); return { items: found.plans.map(p => ({ operation: p.plan.operation_id, conversation_id: p.plan.conversation_id, files: p.plan.files.map(f => ({ ...f })) })), issues: found.issues };
  });
}
async function checkFiles(root: string, plan: RecyclePlan) {
  const remaining: RecycleFile[] = [], absent: RecycleFile[] = [];
  for (const file of plan.files) {
    try {
      const actual = await fingerprintFile(await resolveRecordPath(root, file.path));
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new TypeError(`Recycle original changed: ${file.path}`);
      if (file.kind === "mark") { const mark = await readStoredRecord(root, "mark", file.path); if (mark.value["target"] !== plan.conversation_id) throw new TypeError("Recycle Mark belongs to another conversation"); }
      else { const conversation = await readStoredConversationMetadata(root, file.path); if (conversation.value["conversation_id"] !== plan.conversation_id) throw new TypeError("Recycle Conversation identity changed"); }
      remaining.push(file);
    } catch (e) { if (missing(e)) absent.push(file); else throw e; }
  }
  return { remaining, absent };
}
async function forget(root: string, entry: Awaited<ReturnType<typeof load>>) {
  const file = await resolveRecordPath(root, location(entry.plan.operation_id));
  if (hash(await readFile(file)) !== entry.sha256) throw new TypeError("Recycle intent changed; preserve it for inspection"); await unlink(file);
}

/** One pending intent, at most a Conversation + its Mark. No duplicate content backup. */
export class RecordRecycleSession {
  readonly #root: string;
  #active: { token: string; entry: Awaited<ReturnType<typeof load>>; guard?: Awaited<ReturnType<typeof acquireRecordSnapshot>> } | undefined;
  constructor(root: string) { this.#root = root; }
  async prepare(selected: RecordConversationSelection, timestamp: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const guard = await acquireRecordSnapshot(this.#root);
    try {
      const pending = await pendingUnlocked(this.#root); if (pending.plans.length || pending.issues.length) throw new TypeError("Resolve the pending recycle operation before starting another");
      const catalog = await readRecordCatalog(this.#root), conversation = uniqueConversation(catalog, selected.id), mark = uniqueMark(catalog, selected.id);
      if (!conversation || conversation.path !== selected.path || conversation.sha256 !== selected.conversationSha || (mark?.sha256 ?? null) !== selected.markSha || catalog.issues.some(i => i.path.startsWith("Marks/"))) throw new TypeError("Selected Conversation or Mark changed before deletion");
      const files: RecycleFile[] = [{ kind: "conversation", path: conversation.path, bytes: conversation.bytes, sha256: conversation.sha256 }];
      if (mark) files.push({ kind: "mark", path: mark.path, bytes: (await lstat(await resolveRecordPath(this.#root, mark.path))).size, sha256: mark.sha256 });
      const id = uuidV7(), plan = checked({ schema: "cloudig/recycle/1.0.0", operation_id: id, conversation_id: selected.id, created_at: timestamp, files }, id); await checkFiles(this.#root, plan);
      signal?.throwIfAborted();
      await mkdir(await resolveRecordPath(this.#root, base), { recursive: true }); const handle = await open(await resolveRecordPath(this.#root, location(id)), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(plan, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
      const entry = await load(this.#root, id), token = `z_${randomBytes(32).toString("base64url")}`;
      if (signal?.aborted) { await forget(this.#root, entry); signal.throwIfAborted(); }
      this.#active = { token, entry };
      return { plan: token, operation: id, files: files.map(f => ({ ...f })) };
    } finally { await guard.release(); }
  }
  async resume(operation: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const guard = await acquireRecordSnapshot(this.#root);
    try { const entry = await load(this.#root, operation), checked = await checkFiles(this.#root, entry.plan), token = `z_${randomBytes(32).toString("base64url")}`;
      signal?.throwIfAborted(); this.#active = { token, entry }; return { plan: token, operation, files: checked.remaining.map(f => ({ ...f })) };
    } finally { await guard.release(); }
  }
  async begin(token: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); const active = this.#active;
    if (!active || active.token !== token || active.guard) throw new TypeError("Recycle plan is not ready to begin");
    const guard = await acquireRecordSnapshot(this.#root); let retained = false;
    try {
      const current = await load(this.#root, active.entry.plan.operation_id); if (current.sha256 !== active.entry.sha256) throw new TypeError("Recycle intent changed before native execution");
      const files = await checkFiles(this.#root, current.plan); signal?.throwIfAborted(); active.guard = guard; retained = true;
      return { plan: token, files: files.remaining.map(f => ({ ...f })) };
    } finally { if (!retained) await guard.release(); }
  }
  async finish(token: string, requireComplete: boolean) {
    const active = this.#active;
    if (!active || active.token !== token) { if (!requireComplete) return { status: "released" }; throw new TypeError("Recycle plan expired"); }
    const started = active.guard !== undefined;
    active.guard ??= await acquireRecordSnapshot(this.#root);
    try {
      if (!started && !requireComplete) { await forget(this.#root, active.entry); return { status: "cancelled" }; }
      const checked = await checkFiles(this.#root, active.entry.plan);
      if (!checked.remaining.length || !requireComplete && !checked.absent.length) await forget(this.#root, active.entry);
      if (requireComplete && checked.remaining.length) throw new TypeError("Windows has not recycled all selected originals");
      return { status: checked.remaining.length ? checked.absent.length ? "partial" : "cancelled" : "recycled", remaining: checked.remaining.map(f => ({ ...f })) };
    } finally { this.#active = undefined; await active.guard.release(); }
  }
  async keepRemaining(operation: string) {
    await withRecordSnapshot(this.#root, async () => { const entry = await load(this.#root, operation); await forget(this.#root, entry); }); return { status: "kept_remaining" };
  }
  async close() { const active = this.#active; this.#active = undefined; if (active?.guard) await active.guard.release(); }
}
