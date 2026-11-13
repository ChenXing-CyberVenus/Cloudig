import type { RecordExtractionObserver } from "../../app/parser/adapter.mts";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";

const array = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;
const at = (v: JsonValue | undefined, ...path: number[]): JsonValue | undefined => path.reduce<JsonValue | undefined>((n, i) => array(n)[i], v);

/** Only declared task turns enter this projection. Ordinary Chat thoughts keep
 * their established HTML path. Source IDs, not titles, bind repeated snapshots. */
export class GeminiTasks {
  readonly #turns = new Map<string, JsonValue[]>();
  readonly #tasks = new Map<string, JsonObject>();
  readonly #children = new Map<string, JsonObject>();
  readonly #childNames = new Map<string, string>();
  readonly observer: RecordExtractionObserver | undefined;
  constructor(payload: JsonObject, observer?: RecordExtractionObserver) {
    this.observer = observer;
    for (const raw of array(payload["native_turns"])) {
      const id = text(at(raw, 0, 1)); if (id) this.#turns.set(id, array(raw));
    }
    for (const raw of array(payload["task_turns"])) if (isJsonObject(raw) && text(raw["message_id"])) this.#tasks.set(String(raw["message_id"]), raw);
    for (const raw of array(payload["task_children"])) if (isJsonObject(raw) && text(raw["conversation_id"])) this.#children.set(String(raw["conversation_id"]), raw);
    for (const turn of this.#turns.values()) for (const event of array(at(turn, 3, 4))) for (const child of array(at(event, 12, 10))) {
      const id = text(at(child, 1)), name = text(at(child, 0));
      if (id && name && !this.#childNames.has(id)) this.#childNames.set(id, name);
    }
  }
  process(owner: string): JsonObject | undefined {
    const task = this.#tasks.get(owner), turn = this.#turns.get(owner);
    const events = array(at(turn, 3, 4));
    if (!task || !events.length) return;
    const content: JsonObject[] = [], calls = new Map<string, JsonObject>();
    const children = new Map<string, { title: string; block: JsonObject; snapshots: JsonObject[] }>();
    let lastNarrative = "", lastPlan = "";
    const tool = (row: JsonValue, index: number, aggregate = false): void => {
      if (!Array.isArray(row) || typeof row[0] !== "string") return;
      const id = text(row[9]), known = id ? calls.get(id) : undefined;
      if (known) {
        if (!aggregate) (known["input"] as JsonObject[]).push({ index, record: row });
        return;
      }
      const name = text(row[4]) ?? text(row[0]) ?? "Gemini tool";
      const block: JsonObject = { type: "tool", kind: "activity", title: text(row[0]) ?? name, name,
        ...(id ? { call: id } : {}), input: [{ index, record: row }] };
      content.push(block); if (id) calls.set(id, block);
    };
    for (const [index, event] of events.entries()) {
      const state = at(event, 12); if (!Array.isArray(state)) continue;
      const narrative = text(state[3]);
      if (narrative && narrative !== lastNarrative) { lastNarrative = narrative; content.push({ type: "reasoning_summary", text: narrative, format: "markdown" }); }
      for (const row of array(state[0])) tool(row, index);
      for (const row of array(state[6])) tool(row, index, true);
      if (Array.isArray(state[2]) && JSON.stringify(state[2]) !== lastPlan) {
        lastPlan = JSON.stringify(state[2]);
        content.push({ type: "status", title: "Gemini task plan", text: state[2].map(row => text(at(row, 2))).filter(Boolean).join("\n"), format: "text" });
      }
      for (const child of array(state[10])) {
        const id = text(at(child, 1)); if (!id) continue;
        let entry = children.get(id);
        if (!entry) {
          const title = text(at(child, 0)) ?? "Gemini subtask", block: JsonObject = { type: "status", title, content: [] };
          entry = { title, block, snapshots: [] }; children.set(id, entry); content.push(block);
        }
        entry.snapshots.push({ index, record: child });
      }
    }
    for (const [id, entry] of children) {
      const child = this.#children.get(id), childContent: JsonObject[] = [];
      // A snapshot belongs to the parent observation; a child's actual answer
      // belongs to the distinct child Front, even when two tasks share a title.
      childContent.push({ type: "status", title: "Gemini task snapshots", text: JSON.stringify({ conversation_id: id, snapshots: entry.snapshots }, null, 2), format: "text" });
      for (const raw of array(child?.["native_turns"])) {
        const answer = text(at(raw, 3, 0, 0, 1, 0)); if (!answer) continue;
        const block: JsonObject = { type: "markdown", text: answer };
        this.observer?.block(block, { role: "assistant", sourceId: `agent-thread:gemini:${id}`, name: this.#childNames.get(id) ?? entry.title });
        childContent.push(block);
      }
      if (child) childContent.push({ type: "status", title: "Gemini subtask source", text: JSON.stringify(child, null, 2), format: "text" });
      entry.block["content"] = [{ type: "status", title: "Gemini subtask at capture", content: childContent }];
    }
    // Keep unknown event kinds and future fields, without presenting raw arrays
    // as prose or pretending their semantics are understood.
    content.push({ type: "status", title: "Gemini task source", format: "text", text: JSON.stringify({ message_id: owner, parent: task["parent"] ?? null, automatic: task["automatic"] ?? false, events }, null, 2) });
    return { type: "reasoning", title: text(task["summary"]) ?? "Gemini task process", content };
  }
}
