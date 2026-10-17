import { randomBytes } from "node:crypto";

import { readSystemLog } from "../adapters/library-data/index.mts";
import { pruneMissingSystemLogGroups, removeSystemLogGroups } from "../adapters/library-data/system-log.mts";
import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";

const FILE_CAPABILITY = /^sl_[A-Za-z0-9_-]{43}$/u;

type LogFileCapability = Readonly<{ key: string; path: string }>;

export type SystemLogEngineCommandsOptions = Readonly<{
  libraryRoot: string;
  fileToken?: () => string;
}>;

function fail(message: string): never {
  throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", message);
}

function exactObject(value: JsonValue | undefined, required: readonly string[]): JsonObject {
  if (!isJsonObject(value)) fail("Command payload object is invalid");
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key))) {
    fail("Command payload fields are invalid");
  }
  return value;
}

function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  return value;
}

function groupKey(value: JsonObject): string {
  return JSON.stringify(value);
}

export class SystemLogEngineCommands {
  readonly #libraryRoot: string;
  readonly #fileToken: () => string;
  #files = new Map<string, LogFileCapability>();
  #fileKeys = new Map<string, string>();

  constructor(options: SystemLogEngineCommandsOptions) {
    this.#libraryRoot = options.libraryRoot;
    this.#fileToken = options.fileToken ?? (() => `sl_${randomBytes(32).toString("base64url")}`);
  }

  #refresh(groups: readonly JsonObject[]): void {
    const files = new Map<string, LogFileCapability>();
    const keys = new Map<string, string>();
    for (const group of groups) {
      const key = groupKey(group);
      let capability = this.#fileKeys.get(key);
      if (!capability) {
        capability = this.#fileToken();
        if (!FILE_CAPABILITY.test(capability)) throw new TypeError("System Log file token factory returned an invalid capability");
      }
      keys.set(key, capability);
      files.set(capability, { key, path: String(group["path"]) });
    }
    this.#fileKeys = keys;
    this.#files = files;
  }

  async #groups(): Promise<readonly JsonObject[]> {
    const log = await readSystemLog(this.#libraryRoot);
    return Array.isArray(log["files"])
      ? log["files"].filter((entry): entry is JsonObject => isJsonObject(entry))
      : [];
  }

  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "systemLog.list": async (payload) => {
        exactObject(payload, ["offset", "limit"]);
        const offset = integer(payload["offset"], "System Log offset");
        const limit = integer(payload["limit"], "System Log limit");
        if (offset < 0 || limit < 1 || limit > resourceLimits.reader_message_page_max) fail("System Log query range is invalid");
        if (offset === 0) await pruneMissingSystemLogGroups(this.#libraryRoot);
        const groups = await this.#groups();
        this.#refresh(groups);
        return {
          offset,
          limit,
          total: groups.length,
          items: groups.slice(offset, offset + limit).map((group) => ({
            capability: this.#fileKeys.get(groupKey(group))!,
            path: group["path"]!,
            recorded_at: group["recorded_at"]!,
            errors: structuredClone(group["errors"]!)
          }))
        };
      },
      "systemLog.delete": async (payload) => {
        exactObject(payload, ["file"]);
        const value = payload["file"];
        if (typeof value !== "string" || !FILE_CAPABILITY.test(value)) fail("System Log file capability is invalid");
        const selected = this.#files.get(value);
        const groups = await this.#groups();
        const current = selected && groups.find(group => groupKey(group) === selected.key && group["path"] === selected.path);
        if (!current) throw new EngineCommandError("CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE", "System Log entry changed; refresh the page");
        const result = await removeSystemLogGroups(this.#libraryRoot, [current]);
        if (result.status === "conflict") throw new EngineCommandError("CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE", "System Log entry changed; refresh the page");
        this.#files.delete(value);
        return result;
      },
      "systemLog.clear": async (payload) => {
        exactObject(payload, []);
        const result = await removeSystemLogGroups(this.#libraryRoot, await this.#groups());
        if (result.status === "conflict") throw new EngineCommandError("CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE", "System Log changed; refresh the page");
        this.#files.clear(); this.#fileKeys.clear();
        return result;
      },
      "systemLog.reveal": async (payload) => {
        exactObject(payload, ["file"]);
        const value = payload["file"];
        if (typeof value !== "string" || !FILE_CAPABILITY.test(value)) fail("System Log file capability is invalid");
        const selected = this.#files.get(value);
        if (!selected) throw new EngineCommandError("CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE", "System Log selection is stale; refresh the page");
        const groups = await this.#groups();
        const current = groups.find((group) => groupKey(group) === selected.key && group["path"] === selected.path);
        if (!current) {
          this.#files.delete(value);
          throw new EngineCommandError("CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE", "System Log selection changed; refresh the page");
        }
        return { path: selected.path };
      }
    };
  }
}
