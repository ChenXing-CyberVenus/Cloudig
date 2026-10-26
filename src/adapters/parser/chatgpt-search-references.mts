import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";
const obj = (v: unknown): JsonObject => isJsonObject(v) ? v : {};

/** Search-media references are not DIL programs. Project each occurrence at
 * its original Markdown position and resolve image bytes only from this file. */
export function projectSearchReferences(part: JsonObject, record: JsonObject, pool: JsonObject,
  write: (part: JsonObject) => string | undefined): JsonObject[] {
  const refs = obj(obj(record["raw"])["metadata"])["content_references"];
  if (!Array.isArray(refs)) throw new TypeError("ChatGPT search references are missing");
  const original = typeof part["markdown"] === "string" ? part["markdown"] : "";
  // Ordinary citations coexist with media in the same part. Use the source's
  // own readable alternative, but never substitute inside literal code.
  const source = original.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|(`+)[^\n]*?\2|[^]+/gu,(token,fence,inline)=>{
    if(fence||inline)return token;
    const ref=refs.map(obj).find(r=>r["matched_text"]===token&&!["image_v2","nav_list"].includes(String(r["type"])));
    return typeof ref?.["alt"]==="string" ? ref["alt"] : token;
  });
  const assets = obj(record["reference_assets"]), result: JsonObject[] = [];
  const stored = new Map<string, string>();
  const resolve = (id: string, seen = new Set<string>()): JsonObject => {
    if (seen.has(id)) throw new TypeError("Search image resource alias cycle"); seen.add(id);
    const r = obj(pool[id]); return typeof r["alias_of"] === "string" ? resolve(r["alias_of"], seen) : r;
  };
  let end = 0;
  // Code examples containing reference-looking glyphs stay code examples.
  const tokens = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|(`+)[^\n]*?\2|(?:i|navlist)[^]+/gu;
  for (const match of source.matchAll(tokens)) {
    if (match[1] || match[2]) continue;
    const index = refs.findIndex(v => { const r = obj(v); return ["image_v2", "nav_list"].includes(String(r["type"])) && r["matched_text"] === match[0]; });
    if (index < 0) continue;
    const ref = obj(refs[index]), entries = ref["type"] === "nav_list" ? ref["items"] : ref["images"];
    if (!Array.isArray(entries) || !entries.length) continue;
    if (match.index > end) result.push({ type: "markdown", text: source.slice(end, match.index) });
    const files: JsonObject[] = [], ids = Array.isArray(assets[index]) ? assets[index] : [];
    const items = entries.map((raw, i) => {
      const value = obj(raw), key = typeof ids[i] === "string" ? ids[i] : undefined, r = key ? resolve(key) : {};
      let resource = key ? stored.get(key) : undefined;
      if (!resource && typeof r["src"] === "string" && r["src"].startsWith("data:")) {
        resource = write({ type: "img", src: r["src"], ...(typeof r["mime_type"] === "string" ? { mime_type: r["mime_type"] } : {}) });
        if (resource && key) stored.set(key, resource);
      }
      const image = `images/${i}`; if (resource) files.push({ path: image, resource });
      return { ...value, ...(resource ? { image } : {}) };
    });
    const title=ref["title"]??ref["query"]??obj(entries[0])["title"]??obj(entries[0])["attribution"];
    result.push({ type: "box", source: `chatgpt.com_${ref["type"]}`, format: "structured", ...(typeof title==="string"&&title?{title}:{}),data: { reference: ref, items }, ...(files.length ? { files } : {}) });
    end = match.index + match[0].length;
  }
  if (end < source.length) result.push({ type: "markdown", text: source.slice(end) });
  return result;
}
