import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

const text = (value: JsonValue | undefined): string | undefined => typeof value === "string" && value.length ? value : undefined;
const id = (item: JsonObject): string | undefined => text(item["message_id"]) ?? text(item["node_id"]);
export function isSourceSummary(item: JsonObject): boolean {
  return item["kind"] === "tool" && item["presentation"] === "source_summary"
    && (!Array.isArray(item["queries"]) || item["queries"].length === 0);
}

/** Work only inside one source user/assistant turn; Tree callers supply one turn.
 * These are reading associations, never message-graph edges or text deduplication. */
export function prepareChatGptActivities(items: readonly JsonObject[]): JsonObject[] {
  const result: JsonObject[] = [];
  const flush = (run: JsonObject[]): void => {
    const codes = new Map<string, JsonObject[]>(), answers = new Map<string, JsonObject[]>();
    const positions = new Map(run.map((item, index) => [item, index]));
    for (const item of run) {
      const key = id(item); if (!key) continue;
      if (item["kind"] === "code" && /^python(?:\.|$)/u.test(text(item["recipient"]) ?? "") && item["analysis_call_id"] === key)
        codes.set(key, [...codes.get(key) ?? [], item]);
      if (item["kind"] === "assistant") answers.set(key, [...answers.get(key) ?? [], item]);
    }
    const moved = new Set<JsonObject>(), after = new Map<JsonObject, JsonObject[]>();
    for (const item of run) {
      const call = text(item["analysis_call_id"]), matches = call ? codes.get(call) : undefined;
      const code = matches?.length === 1 ? matches[0] : undefined;
      const valid = code && (item === code || (item["kind"] === "tool" && item["content_type"] === "execution_output" && positions.get(code)! < positions.get(item)!));
      if (call && !valid) delete item["analysis_call_id"];
      if (valid && item !== code) item["name"] = code["recipient"]!;
      if (isSourceSummary(item)) {
        const owner = text(item["source_owner_id"]), matches = owner ? answers.get(owner) : undefined;
        if (matches?.length === 1) { const answer = matches[0]!; if (!item["model"] && text(answer["model"])) item["model"] = answer["model"]!; after.set(answer, [...after.get(answer) ?? [], item]); moved.add(item); }
      }
    }
    for (const item of run) { if (!moved.has(item)) result.push(item); result.push(...after.get(item) ?? []); }
  };
  let run: JsonObject[] = [];
  for (const original of items) {
    const item = { ...original }; // Never annotate the captured payload in place.
    if (item["kind"] === "user") { flush(run); run = []; result.push(item); }
    else run.push(item);
  }
  flush(run); return result;
}

/** The exporter creates this plain list from sources; it is not assistant prose.
 * Anything else must survive separately rather than being mistaken for a duplicate. */
export function sourceSummaryIsDerived(item: JsonObject): boolean {
  const sources = Array.isArray(item["sources"]) ? item["sources"].filter(isJsonObject) : [];
  const expected = sources.length ? ["结果：", ...sources.map(s => `- [${s["title"] ?? ""}](${s["url"] ?? ""}) · ${s["domain"] ?? ""}${s["snippet"] ? `\n  ${s["snippet"]}` : ""}`)].join("\n") : "";
  return !text(item["text"]) || item["text"] === expected;
}
