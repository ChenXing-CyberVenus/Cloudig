import type { JsonObject } from "../../core/contracts/types.mts";
import { embeddedBase64DataUrl, embeddedImageDataUrl } from "./embedded-data.mts";

/** One Conversation resource array, not a second asset store. Original bytes
 * and URL aliases stay separate from an eventual runtime presentation copy. */
export class WorkResources {
  readonly #ids = new Map<string, string>();
  readonly values: JsonObject[];
  constructor(values: JsonObject[]) { this.values = values; }
  add(meta: JsonObject): string {
    const name = typeof meta["name"] === "string" ? meta["name"] : undefined;
    const mime = typeof meta["mime"] === "string" ? meta["mime"] : "application/octet-stream";
    const dataUrl = typeof meta["data_url"] === "string" ? meta["data_url"] : typeof meta["text"] === "string" ? `data:${mime};base64,${Buffer.from(meta["text"], "utf8").toString("base64")}` : undefined;
    const url = typeof meta["source_url"] === "string" && /^https?:\/\//iu.test(meta["source_url"]) ? meta["source_url"] : undefined;
    let resource: JsonObject;
    if (dataUrl) {
      const embedded = /^data:image\//iu.test(dataUrl) ? embeddedImageDataUrl(dataUrl) : embeddedBase64DataUrl(dataUrl);
      if (typeof meta["sha256"] === "string" && meta["sha256"].toLowerCase() !== embedded.sha256) throw new TypeError("Saved work resource SHA-256 mismatch");
      if (typeof meta["size"] === "number" && meta["size"] !== embedded.byteLength) throw new TypeError("Saved work resource byte size mismatch");
      resource = { kind: embedded.mime.startsWith("image/") ? "image" : "file", availability: "embedded", ...(name ? { name } : {}),
        mime: embedded.mime, bytes: embedded.byteLength, sha256: embedded.sha256, ...(embedded.byteLength ? { data_base64: embedded.dataBase64 } : {}), ...(url ? { original: { url } } : {}) };
    } else resource = { kind: mime.startsWith("image/") ? "image" : "file", availability: url ? "external" : "metadata_only", mime, ...(name ? { name } : {}), ...(url ? { url } : {}) };
    const key = JSON.stringify([name, resource["mime"], resource["sha256"], url]);
    const existing = this.#ids.get(key); if (existing) return existing;
    const id = `r${this.values.length + 1}`;
    this.values.push({ id, ...resource }); this.#ids.set(key, id); return id;
  }
  text(name: string, source: string, mime: string): string { return this.add({ name, text: source, mime }); }
}
