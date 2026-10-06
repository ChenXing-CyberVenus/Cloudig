import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  commitIdentityState,
  prepareIdentityAvatar,
  readIdentityState,
  type AvatarIntent,
  type IdentityArchiveDraft,
  type IdentityDraft
} from "../adapters/library-data/index.mts";
import { listManagedIdentityAssets } from "../adapters/runtime/index.mts";
import { resolveManagedPath } from "../adapters/storage/path.mts";
import { fingerprintFile } from "../adapters/storage/stream.mts";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { resolveArchiveView, type BuiltinIdentity } from "../core/library/overlay.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import { engineTransactionId } from "./transaction.mts";

const IDENTITY_CAPABILITY = /^i_[A-Za-z0-9_-]{43}$/u;
const PICKER_CAPABILITY = /^p_[A-Za-z0-9_-]{43}$/u;

function token(prefix: "i" | "v" | "r"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function fail(message: string): never {
  throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", message);
}

function exactObject(value: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isJsonObject(value)) fail("Identity payload object is invalid");
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) fail("Identity payload shape is invalid");
  return value;
}

function nullableName(value: JsonValue | undefined, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) fail(`${label} is invalid`);
  return value;
}

function avatarIntent(value: JsonValue | undefined): AvatarIntent {
  const object = exactObject(value, ["state"], ["picker"]);
  if (object["state"] === "keep" || object["state"] === "clear") {
    if (object["picker"] !== undefined) fail("Identity avatar state cannot carry a picker");
    return { state: object["state"] };
  }
  if (object["state"] !== "picker" || typeof object["picker"] !== "string" || !PICKER_CAPABILITY.test(object["picker"])) {
    fail("Identity avatar picker is invalid");
  }
  return { state: "picker", picker: object["picker"] };
}

function partyDraft(value: JsonValue | undefined, label: string): IdentityDraft["global"]["user"] {
  const party = exactObject(value, ["avatar"], ["name"]);
  return { ...(nullableName(party["name"], `${label} name`) ? { name: party["name"] as string } : {}), avatar: avatarIntent(party["avatar"]) };
}

function draft(value: JsonValue | undefined, platformKeys: ReadonlySet<string>): IdentityDraft {
  const root = exactObject(value, ["global", "platforms"]);
  const global = exactObject(root["global"], ["user", "assistant"]);
  const assistant = exactObject(global["assistant"], ["avatar", "apply_to_all"], ["name"]);
  if (typeof assistant["apply_to_all"] !== "boolean") fail("Global assistant apply-to-all state is invalid");
  if (!isJsonObject(root["platforms"])) fail("Identity platform settings are invalid");
  const platforms = root["platforms"];
  const platformDrafts: Record<string, IdentityDraft["global"]["user"]> = {};
  for (const [platform, raw] of Object.entries(platforms)) {
    if (!platformKeys.has(platform)) fail("Identity platform is not supported");
    platformDrafts[platform] = partyDraft(raw, platform);
  }
  return {
    global: {
      user: partyDraft(global["user"], "User"),
      assistant: {
        ...(nullableName(assistant["name"], "Assistant name") ? { name: assistant["name"] as string } : {}),
        avatar: avatarIntent(assistant["avatar"]),
        applyToAll: assistant["apply_to_all"] as boolean
      }
    },
    platforms: platformDrafts
  };
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function rawParty(identity: JsonObject | undefined, scope: "user" | "assistant" | string): JsonObject | undefined {
  if (scope === "user" || scope === "assistant") return object(object(identity?.["global"])?.[scope]);
  return object(object(object(identity?.["platforms"])?.[scope])?.["assistant"]);
}

export type IdentityEngineCommandsOptions = Readonly<{
  libraryRoot: string;
  runtimeRoot: string;
  builtins: BuiltinIdentity;
  transaction?: () => string;
  clock?: () => string;
  onCommitted?: () => void | Promise<void>;
  resolveArchive?: (value: JsonValue) => IdentityArchiveDraft;
}>;

export class IdentityEngineCommands {
  readonly #libraryRoot: string;
  readonly #runtimeRoot: string;
  readonly #builtins: BuiltinIdentity;
  readonly #transaction: () => string;
  readonly #clock: () => string;
  readonly #onCommitted: () => void | Promise<void>;
  readonly #resolveArchive: IdentityEngineCommandsOptions["resolveArchive"];
  #assets = new Map<string, string>();
  #assetTokens = new Map<string, string>();
  #runtimeViews = new Set<string>();
  #previews = new Map<string, JsonObject>();

  constructor(options: IdentityEngineCommandsOptions) {
    this.#libraryRoot = options.libraryRoot;
    this.#runtimeRoot = options.runtimeRoot;
    this.#builtins = options.builtins;
    this.#transaction = options.transaction ?? engineTransactionId;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#onCommitted = options.onCommitted ?? (() => undefined);
    this.#resolveArchive = options.resolveArchive;
  }

  #capability(relativePath: string): string {
    const existing = this.#assetTokens.get(relativePath);
    if (existing) return existing;
    const capability = token("i");
    this.#assetTokens.set(relativePath, capability);
    this.#assets.set(capability, relativePath);
    return capability;
  }

  #asset(pathValue: string, available: ReadonlySet<string>): JsonObject {
    if (pathValue.startsWith("Data/Assets/User/") && available.has(pathValue)) {
      return { kind: "managed", capability: this.#capability(pathValue) };
    }
    return { kind: "application", asset: pathValue, ...(pathValue.startsWith("Data/Assets/User/") ? { missing: true } : {}) };
  }

  async #query(): Promise<JsonObject> {
    this.#assets.clear();
    this.#assetTokens.clear();
    const state = await readIdentityState(this.#libraryRoot);
    const identity = state.identity;
    const available = await listManagedIdentityAssets(this.#libraryRoot);
    const preview = (platform: string) => resolveArchiveView({ archive: "", platform }, { preferences: { language: state.language }, ...(identity ? { identity } : {}) }, this.#builtins, available);
    const generic = preview("");
    const user = rawParty(identity, "user");
    const assistant = rawParty(identity, "assistant");
    const platforms = Object.entries(this.#builtins.platforms).sort(([left], [right]) => left.localeCompare(right)).map(([platform, builtin]) => {
      const raw = rawParty(identity, platform);
      const resolved = preview(platform);
      return {
        platform,
        source_name: builtin.name,
        source_avatar: this.#asset(builtin.avatar, available),
        name: typeof raw?.["name"] === "string" ? raw["name"] : null,
        custom_avatar: typeof raw?.["avatar"] === "string",
        resolved_name: resolved.assistantName,
        resolved_avatar: this.#asset(resolved.assistantAvatar, available)
      };
    });
    return {
      revision: state.revision,
      language: state.language,
      global: {
        user: {
          source_name: this.#builtins.user.localizedNames?.[state.language] ?? this.#builtins.user.name,
          source_avatar: this.#asset(this.#builtins.user.avatar, available),
          name: typeof user?.["name"] === "string" ? user["name"] : null,
          custom_avatar: typeof user?.["avatar"] === "string",
          resolved_name: generic.userName,
          resolved_avatar: this.#asset(generic.userAvatar, available)
        },
        assistant: {
          source_name: this.#builtins.assistant.localizedNames?.[state.language] ?? this.#builtins.assistant.name,
          source_avatar: this.#asset(this.#builtins.assistant.avatar, available),
          name: typeof assistant?.["name"] === "string" ? assistant["name"] : null,
          custom_avatar: typeof assistant?.["avatar"] === "string",
          apply_to_all: assistant?.["apply_to_all"] === true,
          resolved_name: generic.assistantName,
          resolved_avatar: this.#asset(generic.assistantAvatar, available)
        }
      },
      platforms
    };
  }

  async #materialize(sourcePath: string, extension: string, expected?: Readonly<{ bytes: number; sha256: string }>): Promise<JsonObject> {
    const key = `${expected?.sha256 ?? sourcePath}|${extension}`;
    const previous = this.#previews.get(key);
    if (previous) {
      const file = path.join(this.#runtimeRoot, "Views", ...String(previous["virtual_path"]).slice(1).split("/"));
      if (await stat(file).then(value => value.isFile()).catch(error => { if (error.code !== "ENOENT") throw error; return false; })) return previous;
    }
    const view = token("v");
    const resource = token("r");
    const relativeDirectory = `Views/${view}/assets`;
    const relativePath = `${relativeDirectory}/${resource}.${extension}`;
    const directory = await resolveManagedPath(this.#runtimeRoot, relativeDirectory);
    const target = await resolveManagedPath(this.#runtimeRoot, relativePath);
    await mkdir(directory, { recursive: true });
    try {
      await copyFile(sourcePath, target);
      if (expected) {
        const observed = await fingerprintFile(target);
        if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) throw new TypeError("Identity preview bytes changed");
      }
      this.#runtimeViews.add(`Views/${view}`);
      const result = { virtual_path: `/${view}/assets/${resource}.${extension}` };
      this.#previews.set(key, result);
      return result;
    } catch (error) {
      await rm(await resolveManagedPath(this.#runtimeRoot, `Views/${view}`), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "identity.query": async (payload) => {
        if (Object.keys(payload).length !== 0) fail("Identity query payload must be empty");
        return this.#query();
      },
      "identity.commit": async (payload) => {
        const value = exactObject(payload, ["expected_revision", "draft"], ["conversation"]);
        if (typeof value["expected_revision"] !== "number" || !Number.isSafeInteger(value["expected_revision"]) || value["expected_revision"] < 1) {
          fail("Identity revision is invalid");
        }
        if (value["conversation"] !== undefined && !this.#resolveArchive) fail("Conversation identity resolver is unavailable");
        const archive = value["conversation"] === undefined ? undefined : this.#resolveArchive!(value["conversation"]);
        const result = await commitIdentityState({
          libraryRoot: this.#libraryRoot,
          expectedRevision: value["expected_revision"] as number,
          draft: draft(value["draft"], new Set(Object.keys(this.#builtins.platforms))),
          ...(archive ? { archive } : {}),
          transaction: this.#transaction(),
          recoveryTransaction: this.#transaction(),
          timestamp: this.#clock()
        });
        if (result.status === "conflict") throw new EngineCommandError("CLOUDIG_LIBRARY_REVISION_CONFLICT", "Library changed; refresh identity settings and try again");
        if (result.status === "updated") await this.#onCommitted();
        return { status: result.status, ...(await this.#query()), ...(result.archiveRevision === undefined ? {} : { archive_revision: result.archiveRevision }) };
      },
      "identity.avatar.resolve": async (payload) => {
        const value = exactObject(payload, ["avatar"]);
        if (typeof value["avatar"] !== "string" || !IDENTITY_CAPABILITY.test(value["avatar"])) fail("Identity avatar capability is invalid");
        const relative = this.#assets.get(value["avatar"]);
        if (!relative) throw new EngineCommandError("CLOUDIG_IDENTITY_AVATAR_STALE", "Identity avatar preview is stale");
        const source = await resolveManagedPath(this.#libraryRoot, relative, { mustExist: true });
        const extension = path.extname(relative).slice(1).toLowerCase();
        if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) throw new EngineCommandError("CLOUDIG_IDENTITY_AVATAR_UNSUPPORTED", "Identity avatar format is not supported");
        return this.#materialize(source, extension === "jpeg" ? "jpg" : extension);
      },
      "identity.avatar.preview": async (payload) => {
        const value = exactObject(payload, ["picker"]);
        if (typeof value["picker"] !== "string" || !PICKER_CAPABILITY.test(value["picker"])) fail("Identity avatar picker is invalid");
        const prepared = await prepareIdentityAvatar(this.#libraryRoot, value["picker"]);
        return this.#materialize(prepared.picker.payloadPath, prepared.extension, prepared.picker.fingerprint);
      }
    };
  }

  async close(): Promise<void> {
    this.#assets.clear();
    this.#assetTokens.clear();
    this.#previews.clear();
    const values = [...this.#runtimeViews];
    this.#runtimeViews.clear();
    await Promise.all(values.map(async (relative) => {
      const target = await resolveManagedPath(this.#runtimeRoot, relative).catch(() => undefined);
      if (target) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }));
  }
}
