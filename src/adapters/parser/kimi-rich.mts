import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import type { DefaultTreeAdapterTypes } from "parse5";
import { isJsonObject, type JsonObject, type JsonValue } from "../../core/contracts/types.mts";
import { safeVirtualPath, interactiveFileMime } from "./claude-interactive.mts";
import { WorkResources } from "./work-resources.mts";
import { kimiWebsiteSnapshot } from "./kimi-website.mts";

const text = (v: JsonValue | undefined): string => typeof v === "string" ? v : "";
const list = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter(isJsonObject) : [];
const object = (v: JsonValue | undefined): JsonObject => isJsonObject(v) ? v : {};
const strings = (v: JsonValue | undefined): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const esc = (v: string): string => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const hash = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
const mime = (name: string, declared = ""): string => declared && declared !== "application/octet-stream" ? declared
  : /\.glb$/iu.test(name) ? "model/gltf-binary" : /\.ttf$/iu.test(name) ? "font/ttf" : interactiveFileMime(name);

/** The carrier is evidence, never a program to execute during parsing. Each
 * resource is materialized once; native message/work identity owns placement. */
export class KimiRichContent {
  readonly #works = new Map<string, JsonObject>();
  readonly #resources = new Map<string, JsonObject>();
  readonly #packages = new Map<string, JsonObject>();
  readonly #unzipped = new Map<string, Record<string, Uint8Array>>();
  readonly #ids = new Map<string, string>();
  readonly #used = new Set<string>();
  readonly #pool: WorkResources;
  readonly #payload: JsonObject;
  #catalogUsed = false;
  constructor(payload: JsonObject, pool: WorkResources) {
    this.#payload = payload; this.#pool = pool;
    for (const [field, key, target] of [["resources", "id", this.#resources], ["packages", "id", this.#packages], ["works", "key", this.#works]] as const) {
      for (const raw of list(payload[field])) {
        const id = text(raw[key]);
        if (!id || target.has(id)) throw new TypeError(`Kimi ${field} identity is missing or duplicated`);
        if (field === "works" && !text(raw["message_id"])) throw new TypeError("Kimi work has no source message");
        target.set(id, raw);
      }
    }
  }
  #package(id: string): Record<string, Uint8Array> {
    const found = this.#unzipped.get(id); if (found) return found;
    const raw = this.#packages.get(id); if (!raw) throw new TypeError("Kimi package reference is missing");
    const url = text(raw["data_url"]), match = /^data:[^,]*;base64,([\s\S]*)$/u.exec(url);
    if (!match) throw new TypeError("Kimi package has no saved bytes");
    const bytes = Buffer.from(match[1]!, "base64");
    if (typeof raw["bytes"] === "number" && bytes.length !== raw["bytes"] || text(raw["sha256"]) && hash(bytes) !== raw["sha256"]) throw new TypeError("Kimi package byte size or SHA-256 mismatch");
    const names = new Set<string>();
    const files = unzipSync(bytes, { filter(entry) {
      if (entry.name.endsWith("/")) return false;
      if (!safeVirtualPath(entry.name)) throw new TypeError("Unsafe Kimi package member path");
      if (names.has(entry.name)) throw new TypeError("Ambiguous duplicate Kimi package member");
      names.add(entry.name); return true;
    } });
    this.#unzipped.set(id, files); return files;
  }
  #resource(key: string): string {
    const found = this.#ids.get(key); if (found) return found;
    const raw = this.#resources.get(key); if (!raw) throw new TypeError("Kimi resource reference is missing");
    const name = text(raw["name"]) || text(raw["path"]) || key, type = mime(name, text(raw["mime_type"]));
    let url = text(raw["data_url"]);
    if (text(raw["package_id"])) {
      const bytes = this.#package(text(raw["package_id"]))[text(raw["package_entry"])];
      if (!bytes) throw new TypeError("Kimi saved package member is missing");
      url = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    }
    if (!url && ["embedded", "embedded_thumbnail"].includes(text(raw["status"]))) throw new TypeError("Kimi embedded resource has no bytes");
    const id = this.#pool.add({ name, mime: type, ...(/^https?:\/\//u.test(text(raw["path"])) ? { source_url: raw["path"]! } : {}), ...(url ? { data_url: url,
      ...(raw["saved_bytes"] !== undefined ? { size: raw["saved_bytes"]! } : {}), ...(text(raw["sha256"]) ? { sha256: raw["sha256"]! } : {}) } : {}) });
    this.#ids.set(key, id); return id;
  }
  #file(key: string, prefix = ""): JsonObject {
    const raw = this.#resources.get(key); if (!raw) throw new TypeError("Kimi file reference is missing");
    const original = text(raw["path"]) || text(raw["name"]) || key;
    const path = /^https?:\/\//u.test(original) ? `external/${key}/${text(raw["name"]) || "file"}` : original;
    if (!safeVirtualPath(path)) throw new TypeError("Unsafe Kimi virtual file path");
    return { path: prefix + path, resource: this.#resource(key) };
  }
  #project(raw: JsonObject): JsonObject[] {
    const kind = text(raw["kind"]), title = text(raw["title"]), files: JsonObject[] = [];
    const provenance: JsonObject = { key: raw["key"]!, message_id: raw["message_id"]!,
      ...Object.fromEntries(["block_id", "tool_call_id", "artifact_id", "version_id", "version", "revision_number", "source_status"].filter(k => raw[k] !== undefined).map(k => [k, raw[k]!])) };
    if (kind === "widget") {
      const source = text(raw["source"]); if (!source) throw new TypeError("Kimi Widget source is missing");
      files.push({ path: "index.html", resource: this.#pool.text("index.html", source, "text/html") });
      for (const key of strings(raw["resource_ids"])) files.push(this.#file(key));
      // Widget is the source's inline presentation role. Canvas, animation and
      // Shadow DOM describe implementation, not a request for a separate page.
      return [{ type: "box", source: "kimi.com_widget", format: "html", title, files, entry: "index.html",
        data: { provenance, host_style: object(this.#payload["host_style"]) } }];
    }
    if (kind === "website") {
      const packageId = text(raw["package_id"]);
      if (packageId) {
        const contents = this.#package(packageId);
        for (const [path, bytes] of Object.entries(contents)) if (!path.endsWith("/")) files.push({ path, resource: this.#pool.add({ name: path, mime: mime(path), data_url: `data:${mime(path)};base64,${Buffer.from(bytes).toString("base64")}` }) });
        const entry = Object.hasOwn(contents, "index.html") ? "index.html" : undefined;
        if (entry) return [{ type: "window", source: "kimi.com_website", format: "html", title: `${title}${raw["revision_number"] ? ` · V${raw["revision_number"]}` : ""}`, files, entry, data: { provenance, description: raw["description"] ?? "" } }];
      } else {
        const workspace = text(raw["workspace_package_id"]);
        const snapshot = workspace ? kimiWebsiteSnapshot(raw, this.#package(workspace)) : undefined;
        if (snapshot) {
          const index = new TextDecoder().decode(snapshot["index.html"]), entry = /<script\b[^>]*\bsrc=["']\/?([^"']+\.[cm]?[jt]sx?)["']/iu.exec(index)?.[1];
          if (entry && snapshot[entry]) {
            for (const [path, bytes] of Object.entries(snapshot)) files.push({ path, resource: this.#pool.add({ name: path, mime: mime(path), data_url: `data:${mime(path)};base64,${Buffer.from(bytes).toString("base64")}` }) });
            return [{ type: "window", source: "kimi.com_website", format: "react", title: `${title}${raw["revision_number"] ? ` · V${raw["revision_number"]}` : ""}`, files, entry,
              data: { provenance, project: { entry }, description: raw["description"] ?? "" } }];
          }
        }
        // A work directory is not a version-specific export. Preserve its
        // actual evidence with an explicit identity; never replay latest as V3.
        files.push({ path: "version-evidence.json", resource: this.#pool.text("version-evidence.json", JSON.stringify({ provenance, metadata: raw["version_metadata"] ?? {}, evidence: raw["version_evidence"] ?? [] }, null, 2), "application/json") });
      }
      return [{ type: "window", source: "kimi.com_website_evidence", format: "structured", title, files,
        data: { provenance, description: raw["description"] ?? "", presentation: raw["presentation_text"] ?? "" } }];
    }
    if (kind === "file" || kind === "slides") {
      const keys = strings(raw["resource_ids"]);
      if (!keys.length) throw new TypeError("Kimi file work has no resource reference");
      for (const key of keys) files.push(this.#file(key));
      const primary = files[0]!, id = text(primary["resource"]), resource = this.#pool.values.find(r => r["id"] === id)!;
      if (kind === "slides") {
        const presentation = object(raw["presentation"]), native = object(presentation["native"]);
        const pptd = text(native["pptdContent"]), pages = list(native["pages"]);
        if (!pptd || !pages.length) return [{ type: "attachment", resource: id }];
        const originalPath = text(primary["path"]), base = originalPath.includes("/") ? originalPath.slice(0, originalPath.lastIndexOf("/") + 1) : "";
        for (const key of strings(presentation["resource_ids"])) {
          const file = this.#file(key); if (!files.some(f => f["path"] === file["path"])) files.push(file);
        }
        const fontFiles: JsonObject[] = [];
        for (const f of files) { const r = this.#pool.values.find(r => r["id"] === f["resource"]); if (r && /font|sfnt/u.test(text(r["mime"]))) fontFiles.push(f); }
        return [{ type: "window", source: "kimi.com_pptd", format: "slides", title, entry: originalPath, files,
          data: { provenance, presentation: { pptdContent: pptd, pages, base, fontFiles } } }];
      }
      const type = text(resource["mime"]), attachment: JsonObject = { type: "attachment", resource: id };
      if (resource["availability"] !== "embedded") return [attachment];
      if (type.startsWith("image/")) return [{ type: "image", resource: id, alt: title, purpose: "attachment-thumbnail" }, attachment];
      if (/^(audio|video)\//u.test(type)) {
        const tag = type.startsWith("audio/") ? "audio" : "video", entry = "player.html";
        files.push({ path: entry, resource: this.#pool.text(entry, `<${tag} controls preload="none" src="${esc(text(primary["path"]))}"></${tag}>`, "text/html") });
        return [{ type: "box", source: "kimi.com_media", format: "html", title, entry, files }, attachment];
      }
      return [attachment];
    }
    return [{ type: "box", source: `kimi.com_${kind || "record"}`, format: "structured", title,
      data: { provenance, input: object(raw["configuration"]), native: raw["native"] ?? {}, presentation: raw["presentation_text"] ?? "", plugins: raw["presentation_plugins"] ?? [] } }];
  }
  node(node: DefaultTreeAdapterTypes.Element, owner: string): JsonObject[] | undefined {
    const attr = (name: string) => node.attrs.find(a => a.name === name)?.value;
    const key = attr("data-kimi-work");
    if (key) {
      const raw = this.#works.get(key); if (!raw) throw new TypeError("Kimi work marker has no owned record");
      if (raw["message_id"] !== owner) throw new TypeError("Kimi work belongs to a different source message");
      if (this.#used.has(key)) return [];
      const blocks = this.#project(raw); this.#used.add(key); return blocks;
    }
    if ((attr("class") ?? "").split(/\s/u).includes("osis-kimi-file-catalog")) {
      if (this.#catalogUsed) return []; this.#catalogUsed = true;
      const unique = new Map<string, JsonObject>();
      for (const [key, raw] of this.#resources) if (raw["provenance"] === "native_output_tree") {
        const file = this.#file(key), path = text(file["path"]);
        if (unique.has(path) && unique.get(path)!["resource"] !== file["resource"]) throw new TypeError("Ambiguous Kimi file catalog path");
        unique.set(path, file);
      }
      return [{ type: "box", source: "kimi.com_files", format: "structured", title: "全部文件", data: {}, files: [...unique.values()] }];
    }
    return undefined;
  }
  remaining(owner: string): JsonObject[] {
    const result: JsonObject[] = [];
    for (const [key, raw] of this.#works) if (raw["message_id"] === owner && !this.#used.has(key)) { result.push(...this.#project(raw)); this.#used.add(key); }
    return result;
  }
  atBlock(owner: string, block: string): JsonObject[] {
    const result: JsonObject[] = [];
    for (const [key, raw] of this.#works) if (raw["message_id"] === owner && String(raw["block_id"] ?? "") === block && !this.#used.has(key)) {
      result.push(...this.#project(raw)); this.#used.add(key);
    }
    return result;
  }
  validateOwners(owners: ReadonlySet<string>): void {
    for (const raw of this.#works.values()) if (!owners.has(text(raw["message_id"]))) throw new TypeError("Kimi work belongs to a missing message");
  }
}
