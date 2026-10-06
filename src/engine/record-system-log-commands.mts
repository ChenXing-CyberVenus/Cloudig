import { randomBytes } from "node:crypto";
import { readRecordSystemLog, removeRecordSystemLogGroups } from "../adapters/library-data/record-system-log.mts";
import { isJsonObject, type JsonObject } from "../core/contracts/types.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };

/** The existing themed log page: list/copy/reveal/delete; no monitoring or repair subsystem. */
export class RecordSystemLogEngineCommands {
  readonly #root: string; readonly #files = new Map<string, JsonObject>(); readonly #keys = new Map<string, string>();
  constructor(root: string) { this.#root = root; }
  async #groups(): Promise<JsonObject[]> { return (await readRecordSystemLog(this.#root))["files"] as JsonObject[]; }
  #refresh(groups: readonly JsonObject[]) {
    const live = new Set(groups.map(g => JSON.stringify(g)));
    for (const [key, cap] of this.#keys) if (!live.has(key)) { this.#keys.delete(key); this.#files.delete(cap); }
    for (const group of groups) { const key = JSON.stringify(group); if (!this.#keys.has(key)) { const cap = `sl_${randomBytes(32).toString("base64url")}`; this.#keys.set(key, cap); this.#files.set(cap, group); } }
  }
  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    const exact = (value: JsonObject, keys: string[]) => { if (Object.keys(value).sort().join("|") !== keys.sort().join("|")) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid System Log fields"); };
    const stale = (): never => { throw new EngineCommandError("CLOUDIG_SYSTEM_LOG_CAPABILITY_STALE", "System Log changed; refresh the page"); };
    const selected = async (p: JsonObject) => {
      exact(p, ["file"]); const group = typeof p["file"] === "string" ? this.#files.get(p["file"]) : undefined, groups = await this.#groups(); this.#refresh(groups);
      if (!group || !groups.some(g => JSON.stringify(g) === JSON.stringify(group))) stale(); return group!;
    };
    return {
      "systemLog.list": async payload => {
        exact(payload, ["offset", "limit"]); const { offset, limit } = payload;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > resourceLimits.reader_message_page_max) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Invalid System Log page");
        const groups = await this.#groups(); this.#refresh(groups); return { offset: offset!, limit: limit!, total: groups.length, items: groups.slice(Number(offset), Number(offset) + Number(limit)).map(g => ({ ...structuredClone(g), capability: this.#keys.get(JSON.stringify(g))! })) };
      },
      "systemLog.delete": async payload => { const group = await selected(payload), result = await removeRecordSystemLogGroups(this.#root, new Set([String(group["path"])]), [group]); if (result.status === "conflict") stale(); return result; },
      "systemLog.clear": async payload => { exact(payload, []); const groups = await this.#groups(), result = await removeRecordSystemLogGroups(this.#root, new Set(groups.map(g => String(g["path"]))), groups); if (result.status === "conflict") stale(); return result; },
      "systemLog.reveal": async payload => { const group = await selected(payload); if (!isJsonObject(group)) stale(); return { path: group["path"]! }; }
    };
  }
  close(): void { this.#files.clear(); this.#keys.clear(); }
}
