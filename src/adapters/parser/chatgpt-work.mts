import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import type { RecordExtractionObserver } from "../../app/parser/adapter.mts";

const rows = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];
const text = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";

/** Both item exports and the tree carry these source-local IDs. Thread IDs
 * designate speakers; completion IDs designate turns within that speaker. */
export class ChatGptWork {
  private readonly threads = new Map<string, JsonObject>();
  private readonly sites = new Map<string, JsonObject>();
  private readonly deliveries = new Map<string, JsonObject[]>();

  private readonly record: RecordExtractionObserver | undefined;
  constructor(payload: JsonObject, sites?: JsonObject, record?: RecordExtractionObserver) {
    this.record = record;
    for (const card of rows(payload["subagent_cards"])) this.threads.set(text(card["thread_id"]), card);
    for (const project of rows(sites?.["projects"])) this.sites.set(text(project["project_id"]), project);
    for (const link of rows(sites?.["messages"])) {
      const id = text(link["message_id"]);
      if (id) this.deliveries.set(id, [...this.deliveries.get(id) ?? [], link]);
    }
  }

  activity(item: JsonObject, addPart?: (part: JsonObject) => string | undefined): JsonObject {
    const event = isJsonObject(item["subagent_event"]) ? item["subagent_event"] : {};
    const raw = isJsonObject(event["raw"]) ? event["raw"] : {};
    const thread = text(event["thread"]), card = this.threads.get(thread);
    const name = text(card?.["displayName"]) || text(card?.["agent_path"]) || text(raw["agentPath"]);
    const action = text(event["action"]) || "activity";
    const block: JsonObject = { type: "status", title: `Subagent · ${action}${name ? " · " + name : ""}` };
    const content: JsonObject[] = [];
    const icon = text(card?.["icon_data"]);
    if (icon.startsWith("data:image/") && addPart) {
      const resource = addPart({type:"img",src:icon});
      if (resource) content.push({type:"image",purpose:"agent_icon",resource});
    }
    if (action === "started" && text(card?.["prompt"])) content.push({type:"markdown",text:card!["prompt"]!});
    // Only a completed event owns its final. A pending/interrupted thread can
    // supply a status, but a parent's description is never the child's answer.
    const turns = rows(card?.["turns"]);
    const id = text(raw["id"]);
    const turn = turns.find(t => id === "subagent-completed-" + t["id"])
      ?? (action === "completed" && !id.startsWith("subagent-completed-") && turns.length === 1 ? turns[0] : undefined);
    if (action === "completed" && turn) {
      const answer = rows(turn["items"]).filter(i => i["type"] === "agentMessage" && i["phase"] === "final_answer" && text(i["text"])).at(-1);
      if (answer) content.push({ type: "markdown", text: answer["text"]! });
    } else if (action === "started" && turns.length === 1 && turns[0]?.["status"] === "interrupted") {
      block["title"] = `Subagent · interrupted${name ? " · " + name : ""}`;
    }
    if (content.length) block["content"] = content;
    if (thread) this.record?.block(block, { role: "assistant", sourceId: "agent-thread:" + thread, ...(name ? { name } : {}) });
    return block;
  }

  ownsSite(message: string, project: string): boolean {
    return this.sites.has(project) && !!this.deliveries.get(message)?.some(link => link["project_id"] === project);
  }

  siteBlocks(item: JsonObject, addPart: (part: JsonObject) => string | undefined): JsonObject[] {
    const result: JsonObject[] = [];
    for (const link of this.deliveries.get(text(item["message_id"])) ?? []) {
      const project = this.sites.get(text(link["project_id"]));
      if (!project) continue;
      const title = text(project["title"]) || "ChatGPT Site";
      const preview = text(project["preview"]);
      const image = preview.startsWith("data:image/") ? addPart({ type: "img", src: preview, name: title }) : undefined;
      const data: JsonObject = { project_id: link["project_id"]! };
      for (const key of ["url", "version_at_capture"]) if (project[key] !== undefined) data[key] = project[key]!;
      if (link["deployment_id"]) data["deployment_id"] = link["deployment_id"]!;
      result.push({ type: "box", source: "chatgpt.com_site", format: "structured", title, data,
        ...(image ? { files: [{ path: "preview", resource: image }] } : {}) });
      const document = text(project["document"]);
      if (document.startsWith("data:text/html")) {
        const resource = addPart({ type: "attachment", name: "index.html", src: document, embedded_size: project["document_bytes"] ?? null });
        if (resource) result.push({ type: "window", source: "chatgpt.com_site", format: "html", title, data,
          files: [{ path: "index.html", resource }], entry: "index.html" });
      }
    }
    return result;
  }
}
