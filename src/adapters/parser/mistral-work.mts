import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import { inertHtmlFragment } from "./inert-html.mts";
import { safeVirtualPath } from "./claude-interactive.mts";
import { WorkResources } from "./work-resources.mts";
import { projectMistralSlides, prepareMistralSlideRenderer } from "./mistral-slides.mts";

const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
export class MistralWork {
  readonly #canvases = new Map<string, JsonObject>();
  readonly #resources = new Map<string, JsonObject>();
  readonly #used = new Set<string>();
  readonly pool: WorkResources;
  constructor(payload: JsonObject, pool: WorkResources) {
    this.pool = pool;
    for (const [field, target, id] of [["canvases", this.#canvases, "key"], ["resources", this.#resources, "id"]] as const) for (const raw of list(payload[field])) {
      const key = text(raw[id]); if (!key || target.has(key)) throw new TypeError(`Mistral Work ${field} has ambiguous identity`);
      target.set(key, raw);
    }
  }
  project(key: string, owner: string): JsonObject[] | undefined {
    const raw = this.#canvases.get(key); if (!raw) return;
    if (`${raw["message_id"]}::${raw["message_version"] ?? 0}` !== owner) throw new TypeError("Mistral Canvas belongs to a different message/version");
    if (this.#used.has(key)) return [];
    const files: JsonObject[] = [], seen = new Set<string>();
    for (const id of Array.isArray(raw["resource_ids"]) ? raw["resource_ids"] : []) {
      if (typeof id !== "string") continue;
      const resource = this.#resources.get(id);
      if (!resource || resource["asset_key"] !== key) throw new TypeError("Mistral Canvas file belongs to a different artifact/version");
      const name = text(resource["name"]);
      if (!name || !safeVirtualPath(name) || seen.has(name)) throw new TypeError("Mistral Canvas has ambiguous file paths");
      if (resource["status"] === "embedded" && !text(resource["data_url"])) throw new TypeError("Mistral embedded Canvas file has no bytes");
      const resourceId = this.pool.add(resource);
      if (resource["provenance"] === "native-canvas-source" && typeof raw["source"] === "string") {
        const saved = this.pool.values.find(r => r["id"] === resourceId)!;
        const bytes = Buffer.from((saved["data_base64"] as string[] ?? []).join(""), "base64");
        if (!bytes.equals(Buffer.from(raw["source"], "utf8"))) throw new TypeError("Mistral Canvas source and download bytes disagree");
      }
      files.push({ path: name, resource: resourceId }); seen.add(name);
    }
    const kind = text(raw["type"]), formats: Record<string, string> = { "text/html": "html", react: "react", table: "document", "text/markdown": "document", slides: "document" };
    let format = kind ? formats[kind] : undefined;
    const extension = format === "html" ? /\.html?$/iu : format === "react" ? /\.[jt]sx$/iu : /\.md$/iu;
    let entry = files.find(f => extension.test(String(f["path"])))?.["path"];
    const presentation = kind === "slides" ? projectMistralSlides(raw,this.#resources,this.pool) : undefined;
    if (presentation) {
      this.#used.add(key);
      if(typeof entry!=="string"){entry="__presentation__/source.md";files.unshift({path:entry,resource:this.pool.text(entry,String(raw["source"]??""),"text/markdown")});}
      return [{type:"window",source:"chat.mistral.ai_slides",format:"slides",...(text(raw["title"])?{title:raw["title"]!}:{}),
        files:[...files,...presentation.files],entry,data:{...presentation.data,rendered_file:presentation.entry}}];
    }
    if (kind === "spreadsheet" || kind === "slides") {
      const preview = inertHtmlFragment(text(raw["preview_html"]) ?? "");
      if (preview) { format = "document"; entry = "__cloudig_read_view__.html"; files.unshift({ path: entry, resource: this.pool.text(String(entry), preview, "text/html") }); }
    }
    this.#used.add(key);
    if (format && typeof entry === "string") return [{ type: "window", source: `chat.mistral.ai_${kind === "text/html" ? "html" : kind === "text/markdown" ? "document" : kind}`, format,
      ...(text(raw["title"]) ? { title: raw["title"]! } : {}), files, entry }];
    return files.map(file => ({ type: "attachment", resource: file["resource"]! }));
  }
  async prepare(): Promise<void> {
    if([...this.#canvases.values()].some(c=>isJsonObject(c["presentation"])&&c["presentation"]["status"]==="recipe-ready"))await prepareMistralSlideRenderer();
  }
  remaining(owner: string): JsonObject[] {
    return [...this.#canvases].flatMap(([key, value]) => `${value["message_id"]}::${value["message_version"] ?? 0}` === owner && !this.#used.has(key) ? this.project(key, owner) ?? [] : []);
  }
}
