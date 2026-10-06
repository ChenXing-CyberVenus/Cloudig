import { readFile } from "node:fs/promises";
import { observeAuxiliarySnapshot, writeAuxiliarySnapshot } from "../storage/auxiliary.mts";
import { resolveManagedPath } from "../storage/path.mts";

/**
 * Reader position is a disposable device preference, not an edit to a
 * conversation.  Keeping it in one small auxiliary record lets a copied
 * Library retain the user's last place without making Conversation or Mark
 * files machine-specific.
 */
export const READER_STATE_PATH = "appdata/reader-state.json";
export const READER_STATE_SCHEMA = "cloudig/reader-state/1.0.0" as const;
const MAX_ENTRIES = 8192;
const MAX_ID = 512;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ReaderPosition = Readonly<{
  source_sha256: string;
  message_id?: string;
  selected_leaf?: string;
  branch_choices?: Readonly<Record<string, string>>;
  updated_at: string;
}>;
type ReaderState = { schema: typeof READER_STATE_SCHEMA; updated_at: string; conversations: Record<string, ReaderPosition> };

const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

function validBranchChoices(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([parent, child]) => validId(parent) && validId(child));
}

function emptyState(now: string): ReaderState { return { schema: READER_STATE_SCHEMA, updated_at: now, conversations: {} }; }

function parseState(value: unknown, now: string): ReaderState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState(now);
  const raw = value as Record<string, unknown>;
  if (raw["schema"] !== READER_STATE_SCHEMA || typeof raw["updated_at"] !== "string" || !raw["conversations"] || typeof raw["conversations"] !== "object" || Array.isArray(raw["conversations"])) return emptyState(now);
  const conversations: Record<string, ReaderPosition> = {};
  for (const [id, candidate] of Object.entries(raw["conversations"] as Record<string, unknown>)) {
    if (!validId(id) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (!SHA256.test(String(entry["source_sha256"] ?? "")) || typeof entry["updated_at"] !== "string") continue;
    if (entry["message_id"] !== undefined && !validId(entry["message_id"])) continue;
    if (entry["selected_leaf"] !== undefined && !validId(entry["selected_leaf"])) continue;
    if (entry["branch_choices"] !== undefined && !validBranchChoices(entry["branch_choices"])) continue;
    conversations[id] = {
      source_sha256: String(entry["source_sha256"]), updated_at: entry["updated_at"] as string,
      ...(typeof entry["message_id"] === "string" ? { message_id: entry["message_id"] } : {}),
      ...(typeof entry["selected_leaf"] === "string" ? { selected_leaf: entry["selected_leaf"] } : {}),
      ...(entry["branch_choices"] !== undefined ? { branch_choices: { ...(entry["branch_choices"] as Record<string, string>) } } : {})
    };
  }
  return { schema: READER_STATE_SCHEMA, updated_at: raw["updated_at"] as string, conversations };
}

async function readState(root: string, now: string): Promise<{ value: ReaderState; fingerprint: Awaited<ReturnType<typeof observeAuxiliarySnapshot>> }> {
  const fingerprint = await observeAuxiliarySnapshot(root, READER_STATE_PATH);
  if (!fingerprint) return { value: emptyState(now), fingerprint };
  try {
    const text = await readFile(await resolveManagedPath(root, READER_STATE_PATH), "utf8");
    return { value: parseState(JSON.parse(text), now), fingerprint };
  } catch (error) {
    if (missing(error)) return { value: emptyState(now), fingerprint: undefined };
    if (error instanceof SyntaxError) return { value: emptyState(now), fingerprint };
    throw error;
  }
}

export async function readReaderPosition(root: string, conversationId: string, sourceSha256: string, now: string): Promise<ReaderPosition | undefined> {
  if (!validId(conversationId) || !SHA256.test(sourceSha256)) return undefined;
  const { value } = await readState(root, now);
  const entry = value.conversations[conversationId];
  return entry?.source_sha256 === sourceSha256 ? entry : undefined;
}

export async function saveReaderPosition(root: string, conversationId: string, position: ReaderPosition, now: string): Promise<void> {
  if (!validId(conversationId) || !SHA256.test(position.source_sha256) || typeof position.updated_at !== "string") throw new TypeError("Invalid reader position");
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readState(root, now);
    const conversations = { ...current.value.conversations, [conversationId]: structuredClone(position) };
    const entries = Object.entries(conversations).sort((a, b) => String(b[1].updated_at).localeCompare(String(a[1].updated_at))).slice(0, MAX_ENTRIES);
    const next: ReaderState = { schema: READER_STATE_SCHEMA, updated_at: now, conversations: Object.fromEntries(entries) };
    const result = await writeAuxiliarySnapshot(root, READER_STATE_PATH, Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"), current.fingerprint);
    if (result === "written") return;
  }
  throw new Error("Reader position changed while saving; retry later");
}
