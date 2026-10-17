import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rmdir, unlink } from "node:fs/promises";
import { isJsonObject, type JsonObject, type JsonValue } from "../core/contracts/types.mts";
import type { BuiltinIdentity } from "../core/library/overlay.mts";
import { frontName } from "../core/records/front.mts";
import { parseRecordIdentityDraft } from "../core/records/identity-edit.mts";
import { resolveRecordPresentation } from "../core/records/presentation.mts";
import { commitRecordIdentity, readRecordIdentityState, type RecordAvatarBytes, type RecordIdentityNames } from "../adapters/library-data/record-identity.mts";
import { cleanupRecordPicker, prepareRecordAvatar, readPreparedRecordAvatar, RECORD_PICKER_TOKEN } from "../adapters/library-data/record-picker.mts";
import { resolveRecordPath } from "../adapters/storage/record-store.mts";
import { fingerprintFile, type ByteFingerprint } from "../adapters/storage/stream.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";

type State = Awaited<ReturnType<typeof readRecordIdentityState>>;
type Asset = { path: string; proof: ByteFingerprint };
type Preview = { directory: string; file: string; proof: ByteFingerprint; result: JsonObject };
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
function exact(v: JsonValue | undefined, required: string[], optional: string[] = []): JsonObject {
  if (!isJsonObject(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid identity command fields"); return v;
}
export class RecordIdentityEngineCommands {
  readonly #root: string; readonly #runtime: string; readonly #builtins: BuiltinIdentity; readonly #clock: () => string;
  readonly #resolveConversation: ((value: JsonValue) => Promise<RecordIdentityNames>) | undefined;
  readonly #assets = new Map<string, Asset>(); readonly #assetKeys = new Map<string, string>(); readonly #previews = new Map<string, Preview>();
  constructor(input: { libraryRoot: string; runtimeRoot: string; builtins: BuiltinIdentity; clock?: () => string; resolveConversation?: (value: JsonValue) => Promise<RecordIdentityNames> }) {
    this.#root = input.libraryRoot; this.#runtime = input.runtimeRoot; this.#builtins = input.builtins; this.#clock = input.clock ?? (() => new Date().toISOString()); this.#resolveConversation = input.resolveConversation;
  }
  #asset(path: string, state: State): JsonObject {
    const proof = state.images.get(path); if (!proof) return { kind: "application", asset: path };
    const key = `${path}|${proof.sha256}`; let capability = this.#assetKeys.get(key);
    if (!capability) { capability = token("i"); this.#assetKeys.set(key, capability); this.#assets.set(capability, { path, proof }); }
    return { kind: "managed", capability };
  }
  async #query(): Promise<JsonObject> {
    const state = await readRecordIdentityState(this.#root), bindings = state.bindings.value, identities = new Map([...state.fronts].map(([id, f]) => [id, f.value]));
    const liveAssets = new Set([...state.images].map(([path, proof]) => `asset:${path}:${proof.sha256}`));
    for (const key of [...this.#previews.keys()]) if (key.startsWith("asset:") && !liveAssets.has(key)) await this.#removePreview(key);
    this.#assets.clear(); this.#assetKeys.clear();
    const localName = (builtin: BuiltinIdentity["user"]) => builtin.localizedNames?.[state.language] ?? builtin.name;
    const party = (id: string, builtin: BuiltinIdentity["user"], resolvedName?: string, resolvedAvatar?: string): JsonObject => {
      const front = identities.get(id), image = front?.["image"], available = typeof image === "string" && state.images.has(image);
      return { source_name: localName(builtin), source_avatar: this.#asset(builtin.avatar, state), name: frontName(front) ?? null, custom_avatar: available,
        resolved_name: resolvedName ?? frontName(front) ?? localName(builtin), resolved_avatar: this.#asset(resolvedAvatar ?? (available ? image : builtin.avatar), state) };
    };
    return { revision: state.revision, language: state.language,
      global: { user: party(String(bindings["subject"]), this.#builtins.user), assistant: { ...party(String(bindings["assistant"]), this.#builtins.assistant), apply_to_all: bindings["apply_assistant_to_all"]! } },
      platforms: Object.entries(bindings["platforms"] as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([platform, id]) => {
        const builtin = this.#builtins.platforms[platform] ?? this.#builtins.assistant;
        const resolved = resolveRecordPresentation({ conversation: { platform, identity: [], title: {}, lifecycle: {} }, language: state.language, bindings, identities, builtins: this.#builtins, availableAssets: new Set(state.images.keys()) });
        return { platform, ...party(String(id), builtin, resolved.assistantName, resolved.assistantAvatar) };
      }) };
  }
  async #removePreview(key: string): Promise<void> {
    const preview = this.#previews.get(key); if (!preview) return;
    const file = await resolveRecordPath(this.#runtime, preview.file);
    try { const actual = await fingerprintFile(file); if (actual.bytes !== preview.proof.bytes || actual.sha256 !== preview.proof.sha256) return; await unlink(file); }
    catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
    for (const dir of [`${preview.directory}/assets`, preview.directory]) await rmdir(await resolveRecordPath(this.#runtime, dir)).catch(e => { if (!["ENOENT", "ENOTEMPTY"].includes(e.code)) throw e; });
    this.#previews.delete(key);
  }
  async #materialize(key: string, source: string, extension: string, proof: ByteFingerprint): Promise<JsonObject> {
    const previous = this.#previews.get(key);
    if (previous) { try { const actual = await fingerprintFile(await resolveRecordPath(this.#runtime, previous.file)); if (actual.bytes === proof.bytes && actual.sha256 === proof.sha256) return previous.result; } catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; } await this.#removePreview(key); }
    const view = token("v"), resource = token("r"), directory = `Views/${view}`, file = `${directory}/assets/${resource}.${extension}`;
    await mkdir(await resolveRecordPath(this.#runtime, `${directory}/assets`), { recursive: true });
    const target = await resolveRecordPath(this.#runtime, file), result = { virtual_path: `/${view}/assets/${resource}.${extension}` };
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL); const actual = await fingerprintFile(target);
      if (actual.bytes !== proof.bytes || actual.sha256 !== proof.sha256) throw new TypeError("Avatar changed before preview");
      this.#previews.set(key, { directory, file, proof, result }); return result;
    } catch (error) {
      await unlink(target).catch(e => { if (e.code !== "ENOENT") throw e; });
      for (const dir of [`${directory}/assets`, directory]) await rmdir(await resolveRecordPath(this.#runtime, dir)).catch(() => undefined);
      throw error;
    }
  }
  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    const guard = (handler: EngineCommandHandler): EngineCommandHandler => async (payload, context) => {
      try { context.signal.throwIfAborted(); return await handler(payload, context); }
      catch (error) { if (error instanceof EngineCommandError || error instanceof Error && error.name === "AbortError") throw error; throw new EngineCommandError("CLOUDIG_IDENTITY_EDIT_INVALID", error instanceof Error ? error.message : "Identity change could not be completed"); }
    };
    return {
      "identity.query": guard(async payload => { exact(payload, []); return this.#query(); }),
      "identity.commit": guard(async (payload, context) => {
        exact(payload, ["expected_revision", "draft"], ["conversation"]);
        if (typeof payload["expected_revision"] !== "string" || !/^[a-f0-9]{64}$/u.test(payload["expected_revision"]) || !isJsonObject(payload["draft"])) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid identity save proof");
        const state = await readRecordIdentityState(this.#root);
        if (state.revision !== payload["expected_revision"]) throw new EngineCommandError("CLOUDIG_IDENTITY_EDIT_INVALID", "Identity settings changed; reopen the editor");
        const draft = parseRecordIdentityDraft(payload["draft"], new Set(Object.keys(state.bindings.value["platforms"] as JsonObject)));
        const conversation = payload["conversation"] === undefined ? undefined : this.#resolveConversation ? await this.#resolveConversation(payload["conversation"]) : (() => { throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Conversation identity resolver is unavailable"); })();
        const picks = new Set([draft.global.user, draft.global.assistant, ...Object.values(draft.platforms)].flatMap(p => p.avatar.state === "picker" ? [p.avatar.picker] : []));
        const prepared = []; const avatars = new Map<string, RecordAvatarBytes>();
        for (const pick of picks) { context.signal.throwIfAborted(); const value = await prepareRecordAvatar(this.#runtime, pick); prepared.push(value); avatars.set(pick, await readPreparedRecordAvatar(value, context.signal)); }
        const saved = await commitRecordIdentity(this.#root, { expected: payload["expected_revision"], draft: payload["draft"], timestamp: this.#clock(), avatars, ...(conversation ? { conversation } : {}), signal: context.signal });
        const warnings = [...saved.maintenanceWarnings];
        for (const value of prepared) {
          try { if (!await cleanupRecordPicker(this.#runtime, value.picker)) warnings.push("Avatar staging retained for cache cleanup"); await this.#removePreview(`picker:${value.picker.picker}`); }
          catch { warnings.push("Avatar staging cleanup is pending; the identity save succeeded"); }
        }
        return { status: saved.status, ...await this.#query(), ...(warnings.length ? { maintenance_warnings: warnings } : {}) };
      }),
      "identity.avatar.resolve": guard(async payload => {
        exact(payload, ["avatar"]); const asset = typeof payload["avatar"] === "string" ? this.#assets.get(payload["avatar"]) : undefined;
        if (!asset) throw new EngineCommandError("CLOUDIG_IDENTITY_AVATAR_STALE", "Avatar changed; reopen identity settings");
        const extension = asset.path.split(".").at(-1)!.toLowerCase(); if (!["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) throw new TypeError("Unsupported avatar format");
        return this.#materialize(`asset:${asset.path}:${asset.proof.sha256}`, await resolveRecordPath(this.#root, asset.path), extension === "jpeg" ? "jpg" : extension, asset.proof);
      }),
      "identity.avatar.preview": guard(async payload => {
        exact(payload, ["picker"]); if (typeof payload["picker"] !== "string") throw new TypeError("Invalid picker"); const prepared = await prepareRecordAvatar(this.#runtime, payload["picker"]);
        return this.#materialize(`picker:${prepared.picker.picker}`, prepared.picker.payloadPath, prepared.extension, prepared.picker.fingerprint);
      }),
      // Native-owned picker discard, not a filesystem path accepted from the page.
      "identity.avatar.discard": guard(async payload => {
        exact(payload, ["picker"]); if (typeof payload["picker"] !== "string" || !RECORD_PICKER_TOKEN.test(payload["picker"])) throw new TypeError("Invalid picker");
        await this.#removePreview(`picker:${payload["picker"]}`); return { discarded: true };
      })
    };
  }
  async close(): Promise<void> { for (const key of [...this.#previews.keys()]) await this.#removePreview(key); this.#assets.clear(); this.#assetKeys.clear(); }
}
