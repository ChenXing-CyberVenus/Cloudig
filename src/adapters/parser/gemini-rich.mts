import { workContainer } from "./work-container.mts";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import { safeVirtualPath, interactiveFileMime } from "./claude-interactive.mts";
import { WorkResources } from "./work-resources.mts";

const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v.length ? v : undefined;
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
type Element = DefaultTreeAdapterTypes.Element;

function hasNativeSlideReader(html:string):boolean{
  const ids=new Set<string>(),pending:DefaultTreeAdapterTypes.Node[]=[parse(html)];
  while(pending.length){const node=pending.pop()!;if("attrs" in node)for(const attr of node.attrs)if(attr.name==="id")ids.add(attr.value);if("childNodes" in node)pending.push(...node.childNodes);}
  return ["slideshow-wrapper","prev-slide","next-slide","slide-counter"].every(id=>ids.has(id));
}

export class GeminiRichContent {
  readonly #artifacts = new Map<string, JsonObject>();
  readonly #resources = new Map<string, JsonObject>();
  readonly #media = new Map<string, JsonObject>();
  readonly #used = new Set<string>();
  readonly #resourceIds = new Map<string, string>();
  readonly pool: WorkResources;
  readonly claimImage: (owner: string, dataUrl: string) => void;
  constructor(payload: JsonObject, pool: WorkResources, claimImage: (owner: string, dataUrl: string) => void) {
    this.pool = pool; this.claimImage = claimImage;
    for (const raw of list(payload["resources"])) {
      const key = text(raw["key"]); if (!key || this.#resources.has(key)) throw new TypeError("Gemini rich resource identity is missing or duplicated");
      this.#resources.set(key, raw);
    }
    for (const [field, target] of [["artifacts", this.#artifacts], ["media", this.#media]] as const) for (const raw of list(payload[field])) {
      const key = text(raw["key"]); if (!key || target.has(key) || !text(raw["message_id"])) throw new TypeError("Gemini rich content ownership is missing or duplicated");
      target.set(key, raw);
    }
  }
  #resource(key: string, owner: string): string {
    const raw = this.#resources.get(key); if (!raw) throw new TypeError(`Gemini rich content references a missing resource: ${key}`);
    const data = text(raw["data_url"]); if (data?.startsWith("data:image/")) this.claimImage(owner, data);
    let id = this.#resourceIds.get(key); if (!id) { id = this.pool.add(raw); this.#resourceIds.set(key, id); }
    return id;
  }
  #artifact(raw: JsonObject, owner: string): JsonObject | undefined {
    if (raw["message_id"] !== owner) throw new TypeError("Gemini artifact belongs to a different source message");
    const kind = text(raw["kind"]), source = typeof raw["source"] === "string" ? raw["source"] : "";
    const title = text(raw["title"]), files: JsonObject[] = [], revisions: JsonObject[] = [];
    const addSource = (item: JsonObject, prefix = ""): string | undefined => {
      const rawName = text(item["filename"]), name = rawName && safeVirtualPath(rawName) ? rawName : "source.txt";
      if (typeof item["source"] === "string" && item["source"].length) {
        const path = prefix + name;
        files.push({ path, resource: this.pool.text(name, item["source"], interactiveFileMime(name)) }); return path;
      }
      if (Array.isArray(item["quiz"]) && item["quiz"].length) {
        const path = `${prefix}quiz.json`; files.push({ path, resource: this.pool.text("quiz.json", JSON.stringify(item["quiz"]), "application/json") }); return path;
      }
      return undefined;
    };
    let entry: string | undefined, format: string | undefined;
    let data: JsonObject | undefined;
    if (kind === "quiz") { data = { questions: raw["quiz"] ?? [], ...(title ? { title } : {}) }; format = "structured"; }
    else if (kind === "slides") {
      // These are source + preview-wrapped variants of one presentation, NOT
      // a page list. Preserve both; prefer the saved native reader when its
      // controls exist, otherwise the original document remains the fallback.
      const variants = Array.isArray(raw["slides"]) ? raw["slides"].filter((v): v is string => typeof v === "string" && !!v) : [];
      for (const [i, variant] of variants.entries()) files.push({ path: i ? `variants/${i}.html` : "slides.html", resource: this.pool.text(i ? `slides-variant-${i}.html` : "slides.html", variant, "text/html") });
      if (variants.length) { const reader=variants.findIndex(hasNativeSlideReader);entry=reader>0?`variants/${reader}.html`:"slides.html";format="html"; }
    } else if (source) {
      entry = addSource(raw);
      format = ["document", "research"].includes(kind ?? "") ? "document" : /^(?:```|~~~)?(?:html|svg)?\s*(?:<!doctype html>|<html\b|<svg\b)/iu.test(source) || /\.html?$/iu.test(entry ?? "") ? "html" : undefined;
    }
    if (!format || format !== "structured" && !entry) return;
    for (const [i, revision] of list(raw["history"]).entries()) {
      if (revision["message_id"] !== owner || revision["id"] !== raw["id"]) throw new TypeError("Gemini artifact revision ownership mismatch");
      const path = addSource(revision, `history/${i + 1}/`);
      if (path) revisions.push({ path, ...(revision["updated_at"] !== undefined ? { updated_at: revision["updated_at"]! } : {}) });
    }
    for (const file of list(raw["files"])) {
      const key = text(file["resource"] ?? file["resource_key"] ?? file["key"]);
      if (!key) continue;
      const name = text(file["name"]) ?? text(this.#resources.get(key)?.["name"]) ?? "download";
      files.push({ path: `downloads/${files.length}/${safeVirtualPath(name) ? name : "file"}`, resource: this.#resource(key, owner) });
    }
    if (kind === "research") {
      const visuals: JsonObject[] = [];
      for (const [index, visual] of list(raw["visuals"]).entries()) {
        if (typeof visual["source"] !== "string" || !visual["source"]) continue;
        const path = `visuals/${index + 1}.html`;
        files.push({ path, resource: this.pool.text(`visual-${index + 1}.html`, visual["source"], "text/html") });
        const previews: string[] = [];
        for (const key of new Set(Array.isArray(visual["previews"]) ? visual["previews"].filter((v): v is string => typeof v === "string") : [])) {
          const previewPath = `visuals/${index + 1}-preview-${previews.length + 1}`;
          files.push({ path: previewPath, resource: this.#resource(key, owner) }); previews.push(previewPath);
        }
        visuals.push({ path, ...(text(visual["placeholder"]) ? { placeholder: visual["placeholder"]! } : {}), ...(text(visual["title"]) ? { title: visual["title"]! } : {}), ...(text(visual["description"]) ? { description: visual["description"]! } : {}), ...(previews.length ? { previews } : {}) });
      }
      data = { research: { entry: entry!, visuals, sources: raw["sources"] ?? [], process: raw["research_process"] ?? [] } };
    }
    const preview = text(raw["preview"]);
    return { type: workContainer({role:kind === "quiz" ? "inline" : kind === "visualize" ? "component" : "workspace",source}), source: `gemini.google.com_${kind}`, format, ...(title ? { title } : {}),
      ...(files.length ? { files } : {}), ...(entry ? { entry } : {}),
      ...((data || revisions.length) ? { data: { ...data, ...(revisions.length ? { revisions } : {}) } } : {}),
      ...(preview ? { preview: this.#resource(preview, owner) } : {}) };
  }
  #mediaBlock(raw: JsonObject, owner: string, companion?: Readonly<{ caption?: string; lyrics?: string; poster?: string; title?: string }>): JsonObject[] {
    if (raw["message_id"] !== owner) throw new TypeError("Gemini media belongs to a different source message");
    const key = text(raw["resource"]), mime = text(raw["mime"]) ?? "application/octet-stream", name = text(raw["name"]) ?? "media";
    const resource = key ? this.#resource(key, owner) : this.pool.add({ name, mime, source_url: raw["access_url"] ?? raw["url"] ?? "" });
    if (!/^(?:audio|video)\//u.test(mime)) return [{ type: "attachment", resource }];
    const local = key ? this.#resources.get(key) : undefined;
    const mediaPath = `media/${mime.startsWith("video") ? "video" : "audio"}`;
    const files: JsonObject[] = [], url = local && (text(local["data_url"]) || typeof local["text"] === "string") ? mediaPath : text(raw["access_url"] ?? raw["url"]);
    if (local) files.push({ path: mediaPath, resource });
    const tag = mime.startsWith("video") ? "video" : "audio";
    const poster = companion?.poster ?? text(raw["poster_resource"]);
    if (poster) files.push({ path: "cover", resource: this.#resource(poster, owner) });
    if (companion?.caption) files.push({ path: "captions.vtt", resource: this.#resource(companion.caption, owner) });
    const track=companion?.caption?'<track kind="captions" src="captions.vtt" default>':"";
    const lyrics=!track&&companion?.lyrics?`<div data-cloudig-lyrics><p>${escape(companion.lyrics)}</p></div>`:"";
    files.unshift({ path: "player.html", resource: this.pool.text("player.html", `<${tag} controls preload="none"${url ? ` src="${escape(url)}"` : ""}${poster ? ' poster="cover"' : ""}>${track}</${tag}>${lyrics}`, "text/html") });
    return [{ type: "box", source: "gemini.google.com_media", format: "html", title: companion?.title ?? name, files, entry: "player.html" }, { type: "attachment", resource }];
  }
  node(node: Element, owner: string): JsonObject[] | undefined {
    const attr = (name: string) => node.attrs.find(a => a.name === name)?.value;
    if ((attr("class") ?? "").split(/\s/u).includes("gemini-response-model")) return [];
    if ((attr("class") ?? "").split(/\s/u).includes("gemini-music")) {
      const nodes:Element[]=[];const visit=(p:DefaultTreeAdapterTypes.ParentNode)=>{for(const n of p.childNodes)if("tagName" in n){nodes.push(n);visit(n);}};visit(node);
      const a=(n:Element,key:string)=>n.attrs.find(v=>v.name===key)?.value;
      const ids=new Set(nodes.flatMap(n=>[a(n,"data-gemini-resource"),a(n,"data-gemini-media")]).filter(Boolean));
      const links=new Set(nodes.map(n=>a(n,"href")).filter(Boolean));
      const members=[...this.#media.values()].filter(m=>m["message_id"]===owner&&(ids.has(String(m["key"]))||ids.has(String(m["resource"]))||links.has(String(m["url"]))||links.has(String(m["access_url"]))));
      const audio=members.filter(m=>String(m["mime"]).startsWith("audio/")),captions=members.filter(m=>m["mime"]==="text/vtt"&&text(m["resource"]));
      // The native music component, not message proximity, proves these are
      // companion files of one song. Ambiguous groups keep their old fallback.
      if(audio.length===1&&captions.length<=1){
        const plain=(n:DefaultTreeAdapterTypes.Node):string=>"value" in n?n.value:"childNodes" in n?n.childNodes.map(plain).join(""):"";
        const titleNode=nodes.find(n=>/^h[1-6]$/u.test(n.tagName)),lyricNode=nodes.find(n=>(a(n,"class")??"").split(/\s/u).includes("plain-text"));
        const poster=members.map(m=>text(m["poster_resource"])).find(Boolean);
        const block=this.#mediaBlock(audio[0]!,owner,{...(captions[0]?{caption:String(captions[0]["resource"])}:{}),...(poster?{poster}:{}),...(titleNode?{title:plain(titleNode)}:{}),...(lyricNode?{lyrics:plain(lyricNode)}:{})});
        for(const member of members){this.#used.add(String(member["key"]));if(member!==audio[0]){const key=text(member["resource"]);block.push({type:"attachment",resource:key?this.#resource(key,owner):this.pool.add({name:member["name"]??"media",mime:member["mime"]??"application/octet-stream",source_url:member["access_url"]??member["url"]??""})});}}
        const description=nodes.filter(n=>n.tagName==="p"&&n.parentNode===node).map(plain).join("\n");
        return [...(description?[{type:"text",text:description}]:[]),...block];
      }
    }
    const key = attr("data-gemini-artifact"), media = attr("data-gemini-media");
    if (key) {
      const raw = this.#artifacts.get(key); if (!raw) return;
      if (raw["message_id"] !== owner) throw new TypeError("Gemini artifact belongs to a different source message");
      if (this.#used.has(key)) return [];
      const block = this.#artifact(raw, owner); if (!block) return;
      this.#used.add(key); return [block];
    }
    if (media) {
      const raw = this.#media.get(media); if (!raw) return;
      if (raw["message_id"] !== owner) throw new TypeError("Gemini media belongs to a different source message");
      if (this.#used.has(media)) return [];
      const blocks = this.#mediaBlock(raw, owner); this.#used.add(media); return blocks;
    }
    return undefined;
  }
  remaining(owner: string): JsonObject[] {
    const result: JsonObject[] = [];
    for (const [key, raw] of this.#artifacts) if (raw["message_id"] === owner && !this.#used.has(key)) {
      const block = this.#artifact(raw, owner); if (block) { result.push(block); this.#used.add(key); }
    }
    for (const [key, raw] of this.#media) if (raw["message_id"] === owner && !this.#used.has(key)) { result.push(...this.#mediaBlock(raw, owner)); this.#used.add(key); }
    return result;
  }
}
