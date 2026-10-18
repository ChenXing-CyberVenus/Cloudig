import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Tree } from "parse5";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import { parseDilProgram, unwrapDil, isDilJsx, walkDil, dilLiteral, dilVisibleText, DIL_VIEW_FORMAT, DIL_SOURCE_FORMAT, type DilAst } from "../../core/records/dil-program.mts";
import { inertStandaloneSvg, inertHtmlEvidence } from "./inert-html.mts";
const obj = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
const str = (v: JsonValue | undefined): string => typeof v === "string" ? v : "";
const escape = (s: string): string => s.replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
type Write = (part: JsonObject) => string | undefined;
const elements = (root: Tree.ParentNode): Tree.Element[] => root.childNodes.flatMap(n => "tagName" in n ? [n, ...elements(n)] : []);
const textContent = (root: Tree.ParentNode): string => root.childNodes.map(n => "value" in n ? n.value : "childNodes" in n ? textContent(n) : "").join("");
const attr = (n: Tree.Element, key: string): string | undefined => n.attrs.find(a => a.name === key)?.value;
const svgUrl = (source: string): string => `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;

/** Pure literal text remains ordinary HTML; expressions and native components
 * are not executed at parse time. They use the captured DIL view contract. */
function literalHtml(node: DilAst, constants: JsonObject): string | undefined {
  node = unwrapDil(node);
  const value = dilLiteral(node, constants);
  if (typeof value === "string" || typeof value === "number") return escape(String(value));
  if (!isDilJsx(node)) return;
  const name = node["arguments"][0]?.value;
  const tags: Record<string, string> = { text: "p", bold: "strong", italic: "em", underline: "u", strikethrough: "s", code: "code", divider: "hr", title: "h2" };
  if (!tags[name]) return;
  const children = (node["arguments"].slice(2) as DilAst[]).map(n => literalHtml(n, constants)); if (children.some(c => c === undefined)) return;
  const props = obj(dilLiteral(node["arguments"][1], constants));
  if (Object.keys(props).some(k => k.startsWith("on"))) return;
  // Plain HTML is only a lossless shortcut. Styled/inline text stays in the
  // source-backed view instead of discarding its typography and hierarchy.
  if (Object.keys(props).some(k => k !== "preserveWhitespace")) return;
  const tag = tags[name], html = children.join("");
  return tag === "hr" ? "<hr>" : `<${tag}${props["preserveWhitespace"] ? ' style="white-space:pre-wrap"' : ""}>${html}</${tag}>`;
}
function rootRefs(root: DilAst, constants: JsonObject, widgets: JsonObject): number[] {
  const found = new Set<number>();
  walkDil(root, n => {
    if (!isDilJsx(n) || n["arguments"][0]?.value !== "__chatgptClientDefinedWidget") return;
    const props = n["arguments"][1]; if (props?.type !== "ObjectExpression") return;
    const invocation = props.properties.find((p: DilAst) => (p["key"]?.name ?? p["key"]?.value) === "invocationId");
    const id = dilLiteral(invocation?.value, constants), index = obj(widgets[String(id)])["refIndex"];
    if (Number.isSafeInteger(index) && Number(index) >= 0) found.add(Number(index));
  }); return [...found];
}
function heavyReference(ref: JsonObject): boolean {
  const data = obj(ref["data"]), category = str(ref["category"]), language = str(data["language"]), source = str(data["content"]);
  if (category === "app_block") return /<script\b|<canvas\b/iu.test(source) || !/<(?:video|audio)\b/iu.test(source);
  return category === "code_block" && ["html", "jsx", "tsx", "react"].includes(language) && (data["interactive"] === true || data["model_previewable"] === true);
}

export class ChatGptIntelligentUi {
  #extension: JsonObject; #write: Write; #cache = new Map<string, JsonObject[]>();
  constructor(extension: JsonObject, write: Write) { this.#extension = extension; this.#write = write; }
  project(part: JsonObject, owners: readonly string[], findDiagram?: (source: string) => string | undefined): JsonObject[] | undefined {
    const descriptor = obj(part["intelligent_ui"]), id = str(descriptor["record_id"]);
    if (!id) return;
    if (!owners.includes(id)) throw new TypeError("Intelligent UI belongs to a different source message");
    if (this.#cache.has(id)) return structuredClone(this.#cache.get(id)!);
    const record = obj(obj(this.#extension["records"])[id]);
    if (record["message_id"] !== id) throw new TypeError("Missing owned Intelligent UI record");
    const raw = obj(record["raw"]), metadata = obj(raw["metadata"]), dil = obj(metadata["model_dil_v2"]), source = str(dil["code"]);
    if (!source) throw new TypeError("Intelligent UI has no saved definition");
    const program = parseDilProgram(source), constants = obj(dil["constants"]), references = list(metadata["content_references"]), widgets = obj(dil["clientDefinedWidgets"]);
    const sourcePool = obj(this.#extension["resources"]), files: JsonObject[] = [], resourcePaths: JsonObject = {};
    const embedded = new Map<string, string>();
    const resolve = (id: string, seen = new Set<string>()): JsonObject => {
      if (seen.has(id)) throw new TypeError("Intelligent UI resource alias cycle"); seen.add(id);
      const r = obj(sourcePool[id]); if (!Object.keys(r).length) throw new TypeError("Missing Intelligent UI resource");
      return r["alias_of"] ? resolve(String(r["alias_of"]), seen) : r;
    };
    const register = (key: string, value: JsonObject, name = key): string | undefined => {
      if (resourcePaths[key]) return String(resourcePaths[key]);
      const src = str(value["src"]), mime = str(value["mime_type"]), canonical = str(value["id"]) || key;
      if (!src.startsWith("data:")) return;
      const existing = embedded.get(canonical); if (existing) { resourcePaths[key] = existing; return existing; }
      const rid = this.#write({ type: mime.startsWith("image/") ? "img" : "attachment", src, name, ...(mime ? { mime_type: mime } : {}) });
      if (!rid) return;
      const filename = `assets/${files.length}-${name.replace(/[^\p{L}\p{N}_.-]/gu, "_")}`;
      files.push({ path: filename, resource: rid }); resourcePaths[key] = filename; embedded.set(canonical, filename); return filename;
    };
    const attachmentNames = new Map(list(record["attachments"]).map(a => [str(a["resource_id"]), str(a["name"])]));
    for (const key of Array.isArray(record["resource_ids"]) ? record["resource_ids"] : []) register(String(key), resolve(String(key)), attachmentNames.get(String(key)) || String(key));
    // All image aliases resolve to a single physical file, but every placement
    // retains its own source key/description in the saved UI definition.
    const sourceLinks: JsonObject = {};
    for (const item of list(record["resolved_images"])) {
      const path = register(str(item["resource_id"]), resolve(str(item["resource_id"])));
      if (path) for (const k of ["url", "content_url", "thumbnail_url", "original_content_url"]) { const url = str(obj(item["source"])[k]); if (url) sourceLinks[url] = path; }
    }
    for (const attachment of list(record["attachments"])) { const key = str(attachment["resource_id"]), path = register(key, resolve(key), str(attachment["name"]) || key); if (path) sourceLinks[`sandbox:${str(attachment["sandbox_path"])}`] = path; }
    const tree = parseFragment(str(part["html"])), dom = elements(tree), snapshots: JsonObject = {};
    for (const element of dom) {
      const index = attr(element, "data-osis-ui-reference"); if (index === undefined || !/^\d+$/u.test(index)) continue;
      const svg = elements(element).find(n => n.tagName === "svg"), clean = svg && inertStandaloneSvg(serializeOuter(svg));
      if (clean) { const path = register(`chart-${index}`, { src: svgUrl(clean), mime_type: "image/svg+xml" }, `chart-${index}.svg`); if (path) snapshots[index] = path; }
    }
    const basic = obj(record["basic_interaction"]), icons: JsonObject = {};
    for (const [name, value] of Object.entries(obj(basic["icons"]))) if (typeof value === "string") { const clean = inertStandaloneSvg(value); if (clean) { const path = register(`icon-${name}`, { src: svgUrl(clean), mime_type: "image/svg+xml" }, `${name}.svg`); if (path) icons[name] = path; } }
    // Associate captured glyphs only inside an unambiguous, message-owned
    // semantic container with the same literal label and icon arity. Never
    // pair global SVG ordinal with a program ordinal across hidden branches.
    const norm = (s: string) => s.replace(/\s+/gu, "");
    const domText = new Map(dom.map(e => [e, norm(textContent(e))]));
    const stateKeys = new Map<string, string>();
    for (const statement of program.body) if (statement.type === "VariableDeclaration") for (const declaration of statement["declarations"] as DilAst[]) {
      const initial = declaration["init"], name = declaration["id"]?.elements?.[0]?.name;
      if (name && initial?.callee?.object?.name === "DIL" && initial.callee.property?.name === "useState") stateKeys.set(name, str(obj(dilLiteral(initial.arguments[1], constants))["key"]) || name);
    }
    const observedStates = new Map<string, Set<number>>();
    // Capture advanced sliders from their owned visible component, not the
    // API initializer or a global list of anonymously labelled controls.
    for (const root of program.roots) {
      const unwrapped = unwrapDil(root), tag = isDilJsx(unwrapped) ? unwrapped["arguments"][0]?.value : undefined;
      if (!["box", "card"].includes(tag)) continue;
      const hints = dilVisibleText(root, constants).split("\n").map(norm).filter(s => s.length >= 3).slice(0, 2);
      if (!hints.length) continue;
      const candidates = dom.filter(e => attr(e, "data-osis-native-component") === tag && hints.every(h => domText.get(e)!.includes(h))).sort((a,b) => elements(a).length-elements(b).length);
      const parent = candidates[0]; if (!parent || candidates[1] && elements(candidates[1]).length === elements(parent).length) continue;
      const sliders: DilAst[] = []; walkDil(root, n => { if (isDilJsx(n) && n["arguments"][0]?.value === "slider") sliders.push(n); }); sliders.sort((a,b) => a.start-b.start);
      const saved = elements(parent).filter(e => attr(e, "data-osis-native-component") === "slider"); if (sliders.length !== saved.length) continue;
      for (const [index, node] of sliders.entries()) {
        const props = node["arguments"][1]; if (props?.type !== "ObjectExpression") continue;
        const property = (key: string): DilAst | undefined => props.properties.find((p: DilAst) => (p["key"]?.name ?? p["key"]?.value) === key)?.value;
        const value = property("value"), key = value?.type === "Identifier" ? stateKeys.get(value["name"]) : undefined;
        const min = dilLiteral(property("min"),constants), max = dilLiteral(property("max"),constants);
        const shown = /^\s*(-?\d+(?:\.\d+)?)\s*\(\s*(-?\d+(?:\.\d+)?)\s*[–-]\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/u.exec(textContent(saved[index]!));
        if (!key || !shown || typeof min !== "number" || typeof max !== "number" || Number(shown[2]) !== min || Number(shown[3]) !== max) continue;
        const number = Number(shown[1]); if (!Number.isFinite(number) || number < min || number > max) continue;
        const values = observedStates.get(key) ?? new Set<number>(); values.add(number); observedStates.set(key,values);
      }
    }
    const capturedState = { ...obj(basic["state"]) };
    for (const [key,values] of observedStates) if (values.size === 1 && !Object.hasOwn(capturedState,key)) capturedState[key] = [...values][0]!;
    const iconName = (n: DilAst): string => isDilJsx(n) && n["arguments"][0]?.value === "icon" ? str(obj(dilLiteral(n["arguments"][1], constants))["name"]) : "";
    const visit = (n: DilAst, ancestors: DilAst[]): void => {
      if (!n || typeof n !== "object") return;
      const name = iconName(n);
      if (name && !icons[name]) for (const ancestor of [...ancestors].reverse()) {
        const tag = ancestor["arguments"][0]?.value;
        if (!["button", "row", "box", "card", "text", "title", "caption", "table-cell", "list-item"].includes(tag)) continue;
        const hints = dilVisibleText(ancestor, constants).split("\n").map(norm).filter(s => s.length >= 2).slice(0, 2);
        if (!hints.length) continue;
        const candidates = dom.filter(e => attr(e, "data-osis-native-component") === tag && hints.every(h => domText.get(e)!.includes(h)))
          .sort((a, b) => elements(a).length - elements(b).length);
        const parent = candidates[0]; if (!parent || candidates[1] && elements(candidates[1]).length === elements(parent).length) continue;
        const sourceIcons: DilAst[] = []; walkDil(ancestor, a => { if (iconName(a)) sourceIcons.push(a); }); sourceIcons.sort((a,b) => a.start-b.start);
        const savedIcons = elements(parent).filter(e => e.tagName === "svg" && attr(e, "data-d-component") === "icon");
        if (sourceIcons.length !== savedIcons.length) continue;
        const at = sourceIcons.indexOf(n), saved = at >= 0 ? savedIcons[at] : undefined, clean = saved && inertStandaloneSvg(serializeOuter(saved));
        if (clean) { const path = register(`icon-${name}`, { src: svgUrl(clean), mime_type: "image/svg+xml" }, `${name}.svg`); if (path) icons[name] = path; break; }
      }
      const next = isDilJsx(n) ? [...ancestors, n] : ancestors;
      for (const [key, value] of Object.entries(n)) if (!["start", "end", "loc"].includes(key)) {
        if (Array.isArray(value)) { for (const child of value) if (child && typeof child === "object") visit(child, next); }
        else if (value && typeof value === "object") visit(value as DilAst, next);
      }
    };
    for (const root of program.roots) visit(root, []);
    for (const placement of list(record["placements"])) if (placement["method"] === "owner_scoped_map") { const p = resourcePaths[str(placement["resource_id"])]; if (p) snapshots[String(placement["reference_index"])] = p; }
    // Preserve existing source-owned Mermaid pictures rather than repaint them.
    const mermaids = dom.filter(n => (attr(n, "class") || "").split(/\s/u).some(c => c === "osis-mermaid-card" || c === "osis-ui-mermaid"));
    const diagram = (ref: JsonObject): JsonObject => {
      const data = obj(ref["data"]), body = str(data["content"]);
      const card = mermaids.find(c => elements(c).some(n => n.tagName === "code" && textContent(n).trim() === body.trim()));
      const svg = card && elements(card).find(n => n.tagName === "svg"), clean = svg && inertStandaloneSvg(serializeOuter(svg));
      let rendered: string | undefined = findDiagram?.(body);
      if (!rendered && clean) rendered = this.#write({ type: "img", src: svgUrl(clean), mime_type: "image/svg+xml", name: "diagram.svg" });
      return { type: "diagram", format: "mermaid", source: body, ...(rendered ? { rendered } : {}) };
    };
    const bundle: JsonObject = { format: DIL_SOURCE_FORMAT, source_message: id, code: source, constants, app_data: obj(dil["appData"]), widgets, references,
      captured_state: capturedState, resource_paths: resourcePaths, source_links: sourceLinks, snapshots, icons,
      styles: obj(basic["styles"]), colors: obj(basic["colors"]), media: list(record["media"]),
      original: raw["content"] ?? {}, captured: obj(record["capture"]) };
    const output: JsonObject[] = [];
    for (const [index, root] of program.roots.entries()) {
      const plain = literalHtml(root, constants);
      if (plain !== undefined) { const html = inertHtmlEvidence(plain).html; if (html) output.push({ type: "html", html }); continue; }
      const refs = rootRefs(root, constants, widgets), unwrapped = unwrapDil(root);
      const simple = refs.length === 1 && (unwrapped.type === "ConditionalExpression" || isDilJsx(unwrapped) && unwrapped["arguments"][0]?.value === "__chatgptClientDefinedWidget");
      const ref = references[refs[0]!], data = obj(ref?.["data"]);
      if (simple && ref?.["category"] === "code_block" && data["language"] === "mermaid") { output.push(diagram(ref)); continue; }
      if (simple && ref?.["category"] === "code_block" && !heavyReference(ref)) { output.push({ type: "code", language: str(data["language"]) || "text", code: str(data["content"]) }); continue; }
      const type = refs.some(i => references[i] && heavyReference(references[i]!)) ? "window" : "box";
      const assets = new Map<string, JsonObject>();
      const addAsset = (path: string, alt: string, kind: string) => { if (files.some(f => f["path"] === path)) assets.set(path, { path, alt, kind }); };
      const collect = (value: JsonValue | undefined): void => {
        if (typeof value === "string" && typeof sourceLinks[value] === "string") {
          const attachment = list(record["attachments"]).find(a => `sandbox:${str(a["sandbox_path"])}` === value);
          addAsset(String(sourceLinks[value]), attachment ? str(attachment["name"]) : "", attachment ? "attachment" : "image");
        } else if (Array.isArray(value)) value.forEach(collect);
        else if (isJsonObject(value)) Object.values(value).forEach(collect);
      };
      const assetNodes: DilAst[] = []; walkDil(root, node => { if (isDilJsx(node)) assetNodes.push(node); });
      for (const node of assetNodes.sort((a,b) => a.start-b.start)) {
        const props = obj(dilLiteral(node["arguments"][1], constants));
        const resolution = str(props["__resolutionId"]);
        if (resolution) collect(obj(obj(obj(dil["appData"])["opGenui"])["componentResults"])[resolution]);
        if (props["url"]) collect(props["url"]);
      }
      for (const i of refs) if (typeof snapshots[String(i)] === "string") addAsset(String(snapshots[String(i)]), str(obj(references[i]?.["data"])["title"]), "image");
      const text = [dilVisibleText(root, constants), ...refs.map(i => {
        const r = references[i], d = obj(r?.["data"]);
        return r?.["category"] === "writing_block" ? str(d["content"]) : str(r?.["alt"]) || str(d["title"]);
      })].filter(Boolean).join("\n"), title = text.split("\n")[0] || str(data["title"]) || (type === "window" ? `${str(data["language"]).toUpperCase()} 预览 / Preview`.trim() : "");
      output.push({ type, source: "chatgpt.com_dil", format: "structured", ...(title ? { title } : {}), data: { format: DIL_VIEW_FORMAT, root: index, text, ...(assets.size ? { assets: [...assets.values()] } : {}) }, files, entry: "ui.json" });
    }
    if (output.some(block => block["type"] === "box" || block["type"] === "window")) {
      const bundleId = this.#write({ type: "attachment", name: "ui.json", mime_type: "application/json", src: `data:application/json;base64,${Buffer.from(JSON.stringify(bundle)).toString("base64")}` });
      if (!bundleId) throw new TypeError("Could not preserve the UI definition");
      files.unshift({ path: "ui.json", resource: bundleId });
    }
    this.#cache.set(id, output); return structuredClone(output);
  }
}
