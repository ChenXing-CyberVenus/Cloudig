import { randomBytes } from "node:crypto";
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { EngineCommandError } from "./protocol.mts";

/** Small metadata rows only; a paging snapshot is never a write authorization. */
export const QUERY_PAGE_LIMITS = Object.freeze({ retainedSnapshots: 8 });
export class QueryPages {
  readonly #snapshots = new Map<string, { kind: string; rows: readonly JsonObject[]; metadata: JsonObject }>();
  readonly retainedSnapshots: number;
  constructor(retainedSnapshots: number = QUERY_PAGE_LIMITS.retainedSnapshots) {
    if (!Number.isSafeInteger(retainedSnapshots) || retainedSnapshots < 1) throw new RangeError("Invalid snapshot retention limit");
    this.retainedSnapshots = retainedSnapshots;
  }
  create(kind: string, rows: readonly JsonObject[], metadata: JsonObject, offset: number, limit: number): JsonObject {
    while (this.#snapshots.size >= this.retainedSnapshots) this.#snapshots.delete(this.#snapshots.keys().next().value!);
    const snapshot = `q_${randomBytes(32).toString("base64url")}`;
    this.#snapshots.set(snapshot, { kind, rows, metadata });
    return this.read(kind, snapshot, offset, limit);
  }
  read(kind: string, snapshot: JsonValue | undefined, offset: number, limit: number): JsonObject {
    const found = typeof snapshot === "string" ? this.#snapshots.get(snapshot) : undefined;
    if (!found || found.kind !== kind) throw new EngineCommandError("CLOUDIG_QUERY_EXPIRED", "List snapshot expired; refresh the list");
    return { ...found.metadata, snapshot: String(snapshot), offset, limit, items: found.rows.slice(offset, offset + limit) };
  }
  clear(): void { this.#snapshots.clear(); }
}
