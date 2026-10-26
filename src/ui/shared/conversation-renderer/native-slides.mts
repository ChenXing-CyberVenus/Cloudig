import { unzipSync } from "fflate";
import type { InteractivePackage } from "./interactive-protocol.mts";
import { INTERACTIVE_LIMITS } from "./interactive-protocol.mts";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const num = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const color = (value: unknown, fallback = "transparent") => typeof value === "string" && /^#[0-9a-f]{3,8}$/iu.test(value) ? value : fallback;
const alphaColor = (value: unknown, alpha: unknown) => `color-mix(in srgb, ${color(value)} ${Math.max(0, Math.min(1, num(alpha,1))) * 100}%, transparent)`;
const measure = (value: unknown, fallback: string) => typeof value === "string" && /^-?[\d.]+(?:px|pt|em|%)?$/u.test(value) ? value : fallback;
export type SavedSlide = Readonly<{ name: string; width: number; height: number; body: string; notes: string }>;

/** Native attributed-text lengths are base36 UTF-16 counts. lmkr marks the
 * paragraph sentinel, not a visible asterisk. Literal user asterisks survive. */
export function nativeSlideText(text: Obj, plain = false): string {
  const content = obj(text["content"]), pool = obj(obj(content["apool"])["numToAttrib"]), initial = obj(content["initialAttributedTexts"]);
  const chunks = obj(initial["text"]), attributes = obj(initial["attribs"]);
  return Object.keys(chunks).sort((a,b) => num(a)-num(b)).map(key => {
    const source = String(chunks[key] ?? ""), encoded = String(attributes[key] ?? ""); let cursor = 0, result = "";
    for (const match of encoded.matchAll(/((?:\*[0-9a-z]+)*)(?:\|[0-9a-z]+)?[+=]([0-9a-z]+)/gu)) {
      const length = Number.parseInt(match[2]!,36), value = source.slice(cursor, cursor + length); cursor += length;
      const flags = new Map([...match[1]!.matchAll(/\*([0-9a-z]+)/gu)].flatMap(m => {const entry=pool[String(Number.parseInt(m[1]!,36))];return Array.isArray(entry)&&entry.length===2?[[String(entry[0]),String(entry[1])] as [string,string]]:[];}));
      if (flags.get("lmkr") === "1") continue;
      let rendered = plain ? value : esc(value);
      if (!plain) for (const [name, tag] of [["bold","strong"],["italic","em"],["underline","u"],["strikethrough","s"]]) if (["1","true"].includes(flags.get(name!) ?? "")) rendered=`<${tag}>${rendered}</${tag}>`;
      result += rendered;
    }
    return result + (plain ? source.slice(cursor) : esc(source.slice(cursor)));
  }).join("");
}

function officeImagePages(input: InteractivePackage, document: Document): Uint8Array[][] {
  const packages = input.files.filter(file => /\.pptx$/iu.test(file.path)); if (packages.length !== 1) return [];
  let total = 0, count = 0;
  const zip = unzipSync(new Uint8Array(packages[0]!.bytes), {filter(file) {
    if (!/^ppt\/(?:media\/[^/]+|presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(?:slide\d+\.xml|_rels\/slide\d+\.xml\.rels))$/u.test(file.name)) return false;
    if (++count > INTERACTIVE_LIMITS.officeParts || file.originalSize > INTERACTIVE_LIMITS.officePartBytes || (total += file.originalSize) > INTERACTIVE_LIMITS.officeTotalBytes) throw new RangeError("Saved presentation exceeds the read-view budget");
    return true;
  }});
  const xml = (part: string) => new document.defaultView!.DOMParser().parseFromString(new TextDecoder().decode(zip[part] ?? new Uint8Array()), "application/xml");
  const relation = (from: string): Map<string,string> => {
    const slash=from.lastIndexOf("/"), rel=from.slice(0,slash+1)+"_rels/"+from.slice(slash+1)+".rels";
    return new Map([...xml(rel).getElementsByTagNameNS("*","Relationship")].filter(e=>e.getAttribute("TargetMode")!=="External").map(e=>[e.getAttribute("Id")!,new URL(e.getAttribute("Target")!,"https://office.invalid/"+from).pathname.slice(1)]));
  };
  const presentation = relation("ppt/presentation.xml"), relId = (node: Element, local: string) => node.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", local);
  return [...xml("ppt/presentation.xml").getElementsByTagNameNS("*","sldId")].map(id => {
    const part=presentation.get(relId(id,"id") ?? "");if(!part)return[];const links=relation(part);
    return [...xml(part).getElementsByTagNameNS("*","pic")].flatMap(pic=>{const embed=pic.getElementsByTagNameNS("*","blip")[0],target=embed&&links.get(relId(embed,"embed")??"");return target&&zip[target]?[zip[target]!]:[];});
  });
}
function base64(bytes: Uint8Array): string { let text="";for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text); }
function matrix(value: Obj): string { return `matrix(${num(value["scaleX"],1)},${num(value["shearY"])},${num(value["shearX"])},${num(value["scaleY"],1)},${num(value["translateX"])},${num(value["translateY"])})`; }

/** Feishu/Doubao source nodes retain their own order, coordinates, colours and
 * text. This is a read view, not a replacement office editor or source rewrite. */
export function nativeSlides(input: InteractivePackage, raw: string, document: Document): SavedSlide[] {
  const snapshot=obj(obj(JSON.parse(raw))["native_snapshot"]), blocks=obj(snapshot["block_map"]);
  const node=(id: unknown)=>obj(obj(blocks[String(id)])["data"]);
  const decks=Object.values(blocks).map(value=>obj(obj(value)["data"])).filter(value=>value["type"]==="presentation");
  if(decks.length!==1||!Array.isArray(decks[0]!["slides"]))throw new TypeError("Saved native presentation has no unambiguous page order");
  const deck=decks[0]!, pages=officeImagePages(input,document), size=obj(deck["size"]);
  return (deck["slides"] as unknown[]).map((id,index)=>{
    const page=node(id), dimensions=obj(obj(page["page"])["size"]), width=num(dimensions["width"],num(size["width"],960)),height=num(dimensions["height"],num(size["height"],540));
    if(page["type"]!=="slide"||width<=0||height<=0)throw new TypeError("Saved native slide is missing");
    const ids=Array.isArray(page["children"])?page["children"]:[], background=obj(obj(page["page"])["background"]), paint=color(obj(obj(background["fill"])["color"])["rgb_color"],"#ffffff");let imageIndex=0;
    const render=(child: unknown, ancestors: Set<string>): string=>{
      if(ancestors.has(String(child)))throw new TypeError("Saved slide contains a cycle");const next=new Set(ancestors).add(String(child));
      const value=node(child);if(value["hidden"]===true)return"";
      const element=obj(value["element"]), bounds=obj(element["size"]), transform=obj(element["transform"]),border=obj(element["border"]),fill=obj(element["background"]);
      const w=num(bounds["width"]),h=num(bounds["height"]), common=`position:absolute;left:0;top:0;width:${w}px;height:${h}px;transform-origin:0 0;transform:${matrix(transform)};opacity:${num(element["alpha"],1)};box-sizing:border-box;`;
      if(value["type"]==="group")return `<div style="${common}">${(Array.isArray(value["children"])?value["children"]:[]).map(c=>render(c,next)).join("")}</div>`;
      if(value["type"]==="image"){
        const image=obj(value["image"]), bytes=pages[index]?.[imageIndex++];
        if(!bytes||bytes.length!==num(image["size"]))throw new TypeError("Saved slide image cannot be bound to its original file");
        const mime=typeof image["mimeType"]==="string"&&/^image\/(?:png|jpeg|webp|gif)$/u.test(image["mimeType"])?image["mimeType"]:"image/png";
        return `<div style="${common}overflow:hidden"><img alt="${esc(image["name"])}" src="data:${mime};base64,${base64(bytes)}" style="width:100%;height:100%;object-fit:cover;transform:${matrix(obj(obj(image["crop"])["transform"]))};transform-origin:0 0"></div>`;
      }
      if(value["type"]==="line")return `<div style="${common}height:0;border-top:${num(border["width"],1)}px solid ${color(obj(border["color"])["rgb_color"],"#000000")};opacity:${num(border["alpha"],1)}"></div>`;
      const shape=obj(value["shape"]),text=obj(shape["text"]);if(value["type"]!=="shape")throw new TypeError(`Unsupported saved slide element: ${String(value["type"])}`);
      const align=["left","center","right","justify"].includes(String(text["h_align"]))?text["h_align"]:"left",vertical=text["v_align"]==="middle"?"center":text["v_align"]==="bottom"?"flex-end":"flex-start";
      const padding=["top","right","bottom","left"].map(side=>`${num(obj(text[`padding_${side}`])["value"])}px`).join(" ");
      const appearance=`${fill["inherit_mode"]===1?`background:${alphaColor(obj(obj(fill["fill"])["color"])["rgb_color"],fill["alpha"])};`:""}${border["inherit_mode"]===1?`border:${num(border["width"],1)}px solid ${alphaColor(obj(border["color"])["rgb_color"],border["alpha"])};`:""}`;
      const style=`${common}${appearance}display:flex;flex-direction:column;justify-content:${vertical};padding:${padding};white-space:pre-wrap;overflow-wrap:anywhere;text-align:${align};font-family:${JSON.stringify(text["font_family"]||"sans-serif")};font-size:${measure(text["text_font_size"],"16px")};line-height:${measure(text["line_height"],"1.2")};letter-spacing:${measure(text["letter_spacing"],"0px")};color:${color(text["font_color"],"#000000")};font-weight:${text["bold"]==="true"?700:400};font-style:${text["italic"]==="true"?"italic":"normal"};`;
      return `<div style="${esc(style)}"><div>${nativeSlideText(text)}</div></div>`;
    };
    const note=node(obj(page["slide"])["note"]),notes=nativeSlideText(obj(obj(note["note"])["text"]),true);
    return {name:String(index+1),width,height,notes,body:`<section style="width:100%;height:100%;position:relative;background:${paint}">${ids.map(child=>render(child,new Set())).join("")}</section>`};
  });
}
