import { workContainer } from "./work-container.mts";
import type { DefaultTreeAdapterTypes } from "parse5";
import { serializeOuter } from "parse5";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import { WorkResources } from "./work-resources.mts";

type Element = DefaultTreeAdapterTypes.Element;
type Parent = DefaultTreeAdapterTypes.ParentNode;
const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;
const object = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
const attr = (node: Element, name: string) => node.attrs.find(a => a.name === name)?.value;
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
function elements(node: Parent): Element[] {
  const result: Element[] = [], pending = [...node.childNodes];
  while (pending.length) { const child = pending.shift()!; if ("tagName" in child) { result.push(child); pending.unshift(...child.childNodes); } }
  return result;
}

export class DoubaoRichContent {
  readonly #works = new Map<string, JsonObject>();
  readonly #clouds = new Map<string, JsonObject>();
  readonly #resources = new Map<string, JsonObject>();
  readonly #dependencies = new Map<string, JsonObject>();
  readonly #urls = new Map<string, string>();
  readonly #used = new Set<string>();
  readonly #ids = new Map<string, string>();
  readonly #threads = new Map<string, JsonObject>();
  readonly #tasks = new Map<string, JsonObject>();
  readonly #songs = new Map<string, JsonObject>();
  readonly #shownLyrics = new Set<string>();
  readonly pool: WorkResources;
  constructor(payload: JsonObject, pool: WorkResources) {
    this.pool = pool;
    for (const thread of list(payload["subthreads"])) {
      const id=text(thread["thread_id"]);if(!id||this.#threads.has(id))throw new TypeError("Doubao subtask thread identity is ambiguous");this.#threads.set(id,thread);
    }
    const owners=[...list(payload["messages"]).map(row=>({id:row["message_id"],native:object(row["native"])})),...list(payload["subthreads"]).flatMap(thread=>list(thread["messages"]).map(native=>({id:native["message_id"],native})))];
    for(const owner of owners)for(const block of list(owner.native["content_block"])){
      const task=object(object(block["content"])["complex_task_block"]),id=text(task["thread_id"]);if(id)this.#tasks.set(`${owner.id}:${id}`,task);
      const songs=object(object(object(block["content"])["lyrics_to_songs_music_block"])["lyrics_to_songs_music_content"]);
      for(const [index,song] of Object.entries(songs))if(isJsonObject(song))this.#songs.set(`${owner.id}:${block["block_id"]}:${index}`,song);
    }
    for (const [field, target] of [["works", this.#works], ["cloud_artifacts", this.#clouds], ["resources", this.#resources]] as const) {
      for (const row of list(payload[field])) {
        const key = text(row["key"]); if (!key || !text(row["message_id"]) || target.has(key)) throw new TypeError(`Doubao ${field} identity is missing or duplicated`);
        target.set(key, row);
      }
    }
    for (const row of list(payload["dependencies"])) {
      const url = text(row["url"]); if (!url || this.#dependencies.has(url)) throw new TypeError("Doubao dependency identity is missing or duplicated");
      this.#dependencies.set(url, row);
    }
  }
  capture(parent: Parent, owner: string): void {
    for (const node of elements(parent)) {
      let ancestor=node.parentNode, nested=false;
      while(ancestor&&"tagName" in ancestor){if(attr(ancestor,"data-doubao-thread-id")){nested=true;break;}ancestor=ancestor.parentNode;}
      if(nested)continue; // The child thread is captured with its own message owner.
      const key = attr(node, "data-doubao-resource"); if (!key) continue;
      const resource = this.#resources.get(key); if (!resource) continue;
      if (resource["message_id"] !== owner) throw new TypeError("Doubao resource belongs to another message");
      const within: Element[] = [];
      const visit = (n: Element): void => {
        if (n !== node && attr(n, "data-doubao-resource") && attr(n, "data-doubao-resource") !== key) return;
        within.push(n); for (const child of n.childNodes) if ("tagName" in child) visit(child);
      }; visit(node);
      const valueAttribute = text(object(resource["resource_locator"])["value_attribute"]);
      const candidates = within.flatMap(n => valueAttribute === "src" || valueAttribute === "href" ? [attr(n, valueAttribute)] : [attr(n, "src"), attr(n, "href")]).filter((v): v is string => !!v?.startsWith("data:"));
      const urls = [...new Set(candidates)];
      if (urls.length > 1) throw new TypeError("Doubao resource DOM locator is ambiguous");
      if (urls[0]) {
        const previous = this.#urls.get(key); if (previous && previous !== urls[0]) throw new TypeError("Doubao resource locator has conflicting bytes");
        this.#urls.set(key, urls[0]);
      }
    }
  }
  subtask(node: Element, owner: string): { title: string; task: JsonObject; parts: { owner: string; sourceId: string; role: string; html: string }[] } | undefined {
    if(!(attr(node,"class")??"").split(/\s+/u).includes("osis-doubao-subtask"))return;
    const root=elements(node).find(n=>attr(n,"data-doubao-thread-id"));if(!root)return;
    const id=attr(root,"data-doubao-thread-id")!,thread=this.#threads.get(id),task=this.#tasks.get(`${owner}:${id}`);
    if(!thread||!task)throw new TypeError("Doubao subtask does not belong to this message");
    const owners=new Map<string,JsonObject>();
    for(const message of list(thread["messages"]))for(const block of list(message["content_block"])){
      const key=text(block["block_id"]);if(!key||owners.has(key))throw new TypeError("Doubao subtask block ownership is ambiguous");owners.set(key,message);
    }
    const parts: { owner: string; sourceId: string; role: string; html: string }[]=[];
    for(const child of root.childNodes){
      if(!("tagName" in child))continue;
      const message=owners.get(attr(child,"data-doubao-block-id")??""),mid=text(message?.["message_id"]);
      if(!message||!mid)throw new TypeError("Doubao subtask DOM block has no source message");
      const role=Number(message["user_type"])===1?"user":Number(message["user_type"])===2?"assistant":"system";
      const previous=parts.at(-1),html=serializeOuter(child);
      if(previous?.owner===mid)previous.html+=html;
      else parts.push({owner:mid,sourceId:`agent-thread:${id}:${String(message["sender_id"]??role)}`,role,html});
    }
    return {title:text(task["title"]??object(task["header"])["name"])??"子任务",task,parts};
  }
  #resource(key: string, owner: string): string {
    const raw = this.#resources.get(key); if (!raw || raw["message_id"] !== owner) throw new TypeError("Doubao rich resource ownership is unresolved");
    let id = this.#ids.get(key); if (id) return id;
    const data = this.#urls.get(key), size = raw["embedded_bytes"];
    if (raw["status"] === "embedded" && !data) throw new TypeError("Doubao embedded resource has no saved DOM bytes");
    id = this.pool.add({ name: raw["name"] ?? "", mime: raw["mime_type"] ?? "application/octet-stream", ...(data ? { data_url: data, ...(typeof size === "number" ? { size } : {}) } : {}),
      ...(text(raw["url"]) ? { source_url: raw["url"]! } : {}) });
    this.#ids.set(key, id); return id;
  }
  #work(raw: JsonObject, node: Element): JsonObject {
    const source = text(raw["source"]); if (!source) throw new TypeError("Doubao renderer source is missing");
    const files: JsonObject[] = [{ path: "index.html", resource: this.pool.text("index.html", source, "text/html") }];
    for (const value of Array.isArray(raw["dependencies"]) ? raw["dependencies"] : []) {
      if (typeof value !== "string") continue;
      const dependency = this.#dependencies.get(value); if (typeof dependency?.["source"] !== "string") continue;
      const path = `dependencies/${files.length}.js`;
      files.push({ path, resource: this.pool.add({ name: path, text: dependency["source"], mime: text(dependency["mime_type"])?.split(";")[0] ?? "text/javascript", source_url: value }) });
    }
    const preview = elements(node).find(n => n.tagName === "img" && attr(n, "src")?.startsWith("data:image/"));
    return { type: workContainer({role:"component",source,previewHeight:raw["preview_height"]}), source: "www.doubao.com_renderer", format: "html", ...(text(raw["title"]) ? { title: raw["title"]! } : {}), files, entry: "index.html",
      ...(preview ? { preview: this.pool.add({ name: "preview.webp", data_url: attr(preview, "src")! }) } : {}) };
  }
  #cloud(raw: JsonObject, owner: string): JsonObject | undefined {
    const meta = object(raw["meta"]), version = object(meta["current_version_info"]), title = text(meta["title"] ?? version["title"]);
    const source = text(raw["source"]), parts = object(raw["source_parts"]), snapshot = object(raw["native_snapshot"]);
    const kind = source ? "document" : Object.keys(parts).length ? "spreadsheet" : Object.keys(snapshot).length ? "slides" : undefined;
    if (!kind) return;
    const name = source ? "document.md" : "source.json";
    const originalSourceKey = !source && Array.isArray(raw["resource_keys"]) ? raw["resource_keys"].find(k => typeof k === "string" && this.#resources.get(k)?.["kind"] === "source") : undefined;
    const files: JsonObject[] = [{ path: name, resource: typeof originalSourceKey === "string" ? this.#resource(originalSourceKey, owner) : this.pool.text(name, source ?? JSON.stringify({ ...(Object.keys(parts).length ? { source_parts: parts } : {}), ...(Object.keys(snapshot).length ? { native_snapshot: snapshot } : {}) }), source ? "text/markdown" : "application/json") }];
    for (const key of Array.isArray(raw["resource_keys"]) ? raw["resource_keys"] : []) {
      if (typeof key !== "string") continue;
      const resource = this.#resource(key, owner), value = this.#resources.get(key)!;
      this.#used.add(`resource:${key}`);
      // The native-source download is the very same snapshot already stored
      // above; retain its original bytes rather than an additional JSON copy.
      if (value["kind"] === "source" && !source) { files[0] = { path: name, resource }; continue; }
      files.push({ path: `downloads/${files.length}/${String(value["name"] ?? "file").replace(/[\\/:*?"<>|]/gu, "_") || "file"}`, resource });
    }
    return { type: "window", source: `www.doubao.com_${kind}`, format: "document", ...(title ? { title } : {}), entry: name, files };
  }
  node(node: Element, owner: string): JsonObject[] | undefined {
    const plain = (n: DefaultTreeAdapterTypes.Node): string => "value" in n ? n.value : "childNodes" in n ? n.childNodes.map(plain).join("") : "";
    if ((attr(node,"class")??"").split(/\s+/u).includes("osis-doubao-elapsed")) {
      const title=plain(node).trim(),seconds=Number(attr(node,"data-elapsed-seconds"));
      return title?[{type:"status",title,...(attr(node,"data-elapsed-seconds")!==undefined&&Number.isFinite(seconds)&&seconds>=0?{duration:seconds}:{})}]:[];
    }
    if(node.tagName==="details"){
      const summary=node.childNodes.find(n=>"tagName" in n&&n.tagName==="summary"),body=node.childNodes.filter(n=>n!==summary).map(plain).join("").trim();
      if(summary&&plain(summary).trim()==="歌词"&&this.#shownLyrics.has(`${owner}:${body}`))return [];
    }
    const work = attr(node, "data-doubao-work"), cloud = attr(node, "data-doubao-cloud"), resource = attr(node, "data-doubao-resource");
    for (const [key, map, prefix] of [[work, this.#works, "work"], [cloud, this.#clouds, "cloud"]] as const) {
      if (!key) continue;
      const raw = map.get(key); if (!raw || raw["message_id"] !== owner) throw new TypeError("Doubao work belongs to another message or is absent");
      if (this.#used.has(`${prefix}:${key}`)) return [];
      const block = prefix === "work" ? this.#work(raw, node) : this.#cloud(raw, owner);
      if (!block) return;
      this.#used.add(`${prefix}:${key}`); return [block];
    }
    if (!resource) return;
    const raw = this.#resources.get(resource); if (!raw) return;
    if (raw["message_id"] !== owner) throw new TypeError("Doubao resource belongs to another message");
    if (this.#used.has(`resource:${resource}`)) return [];
    const id = this.#resource(resource, owner); this.#used.add(`resource:${resource}`);
    if (raw["kind"] === "image") return [{ type: "image", resource: id, ...(text(raw["name"]) ? { alt: raw["name"]! } : {}) }];
    if (raw["kind"] === "audio" || raw["kind"] === "video") {
      const path = "media", tag = raw["kind"], data = this.#urls.get(resource), url = data ? path : text(raw["url"]);
      const covers = [...new Set(elements(node).flatMap(n => attr(n, "data-doubao-resource") ?? []))].filter(k => this.#resources.get(k)?.["kind"] === "image");
      const cover = covers.length === 1 ? covers[0] : undefined;
      const poster = cover ? this.#resource(cover, owner) : undefined;
      if (cover) this.#used.add(`resource:${cover}`);
      const song=this.#songs.get(`${owner}:${raw["block_id"]}`),files:JsonObject[]=[];
      let track="",lyrics="";
      if(song){
        let captions:JsonObject={};try{captions=object(JSON.parse(text(song["captions_result"])??"{}"));}catch{ /* The source lyrics still survive without usable timing. */ }
        const cues=list(captions["utterances"]).filter(c=>typeof c["text"]==="string"&&typeof c["start_time"]==="number"&&typeof c["end_time"]==="number"&&c["start_time"]>=0&&c["end_time"]>c["start_time"]);
        const stamp=(ms:number)=>`${String(Math.floor(ms/3600000)).padStart(2,"0")}:${String(Math.floor(ms/60000)%60).padStart(2,"0")}:${(ms%60000/1000).toFixed(3).padStart(6,"0")}`;
        if(cues.length){const vtt="WEBVTT\n\n"+cues.map(c=>`${stamp(c["start_time"] as number)} --> ${stamp(c["end_time"] as number)}\n${escape(String(c["text"]))}\n`).join("\n");files.push({path:"captions.vtt",resource:this.pool.text("captions.vtt",vtt,"text/vtt")});track='<track kind="captions" src="captions.vtt" default>';}
        else if(text(song["lyric"]))lyrics=`<div data-cloudig-lyrics><p>${escape(String(song["lyric"]))}</p></div>`;
        if(text(song["lyric"]))this.#shownLyrics.add(`${owner}:${String(song["lyric"]).trim()}`);
      }
      files.unshift({ path: "player.html", resource: this.pool.text("player.html", `<${tag} controls preload="none"${url ? ` src="${escape(url)}"` : ""}${poster ? ' poster="cover"' : ""}>${track}</${tag}>${lyrics}`, "text/html") });
      if (data) files.push({ path, resource: id });
      if (poster) files.push({ path: "cover", resource: poster });
      return [{ type: "box", source: "www.doubao.com_media", format: "html", ...(text(raw["name"]) ? { title: raw["name"]! } : {}), files, entry: "player.html" }, { type: "attachment", resource: id }];
    }
    return [{ type: "attachment", resource: id }];
  }
}
