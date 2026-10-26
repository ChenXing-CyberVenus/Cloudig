import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";
import { safeVirtualPath } from "./claude-interactive.mts";
import { WorkResources } from "./work-resources.mts";

export const MISTRAL_SLIDE_RENDERER = Object.freeze({ package: "@marp-team/marp-core", version: "4.3.0" });
const obj = (v: unknown): JsonObject => isJsonObject(v) ? v : {};
let MarpEngine: typeof import("@marp-team/marp-core").Marp | undefined;
export async function prepareMistralSlideRenderer(): Promise<void> { MarpEngine ??= (await import("@marp-team/marp-core")).Marp; }

/** Reproduce a captured, versioned renderer recipe. No source JS execution,
 * remote fetch, theme-name guess, or mutation of the original Markdown/PPTX. */
export function projectMistralSlides(raw: JsonObject, resources: ReadonlyMap<string, JsonObject>, pool: WorkResources): { files: JsonObject[]; entry: string; data: JsonObject } | undefined {
  const recipe = obj(raw["presentation"]), renderer = obj(recipe["renderer"]);
  if (recipe["schema"] !== "osis.mistral.slides-presentation/v1" || recipe["status"] !== "recipe-ready") return;
  if (renderer["package"] !== MISTRAL_SLIDE_RENDERER.package || renderer["version"] !== MISTRAL_SLIDE_RENDERER.version)
    throw new TypeError("Mistral 幻灯片需要更新呈现组件 / unsupported saved slide renderer version");
  if (recipe["asset_key"] !== raw["key"] || recipe["message_id"] !== raw["message_id"] || recipe["message_version"] !== raw["message_version"] || recipe["version"] !== raw["version"])
    throw new TypeError("Mistral presentation belongs to a different asset/version");
  const source = raw["source"];
  if (typeof source !== "string" || createHash("sha256").update(source).digest("hex") !== recipe["source_sha256"])
    throw new TypeError("Mistral presentation source SHA mismatch");
  const files: JsonObject[] = [], paths = new Map<string,string>(), aliases: JsonObject = {};
  const add = (key: string, ancestry = new Set<string>()): string => {
    if (paths.has(key)) return paths.get(key)!;
    if (ancestry.has(key)) throw new TypeError("Mistral presentation resource alias cycle"); ancestry.add(key);
    const r = resources.get(key);
    if (!r || r["asset_key"] !== raw["key"]) throw new TypeError("Mistral presentation resource owner mismatch");
    if (typeof r["alias_of"] === "string") { const p=add(r["alias_of"],ancestry);paths.set(key,p);return p; }
    const name = typeof r["name"] === "string" ? r["name"] : key;
    const p = `__presentation__/${files.length}-${name}`;
    if (!safeVirtualPath(p) || r["status"] !== "embedded" || typeof r["data_url"] !== "string") throw new TypeError("Mistral presentation resource bytes are missing");
    const id=pool.add(r);files.push({path:p,resource:id});paths.set(key,p);
    for(const field of ["source_url","url","original_url"])if(typeof r[field]==="string")aliases[r[field]]=p;
    return p;
  };
  for(const field of ["css_resource_ids","dependency_resource_ids","license_resource_ids"])
    for(const id of Array.isArray(recipe[field])?recipe[field]:[])if(typeof id==="string")add(id);
  for(const dep of Array.isArray(recipe["dependencies"])?recipe["dependencies"]:[]){const d=obj(dep),id=d["resource_id"];if(typeof id==="string"&&paths.has(id))for(const field of ["url","original_url"])if(typeof d[field]==="string")aliases[d[field]]=paths.get(id)!;}
  const cssPath = (field: string) => { const id=recipe[field];if(typeof id!=="string"||!paths.has(id))throw new TypeError("Mistral presentation CSS role is missing");return paths.get(id)!; };
  // Fixed options are trusted renderer policy, not arbitrary constructor input.
  // In particular beam is a post-overlay, never a themeSet registration.
  let input=source.trim();const fence=/^```(\w+)?([\s\S]*?)(?:```$|$)/u.exec(input);if(fence?.[2])input=fence[2].trim();
  if(!MarpEngine)throw new TypeError("Mistral slide renderer has not been prepared");
  const marp=new MarpEngine({container:false,html:true,inlineSVG:true,emoji:{shortcode:false,unicode:true},markdown:{xhtmlOut:true},slideContainer:{tag:"div",class:"osis-mistral-slides"}});
  const result=marp.render(input,{htmlAsArray:true});
  const entry="__presentation__/rendered.json";
  files.push({path:entry,resource:pool.text(entry,JSON.stringify({html:result.html,css:result.css,comments:result.comments}),"application/json")});
  return {files,entry,data:{presentation:recipe,page_css:cssPath("page_css_resource_id"),theme_css:cssPath("theme_css_resource_id"),aliases}};
}
