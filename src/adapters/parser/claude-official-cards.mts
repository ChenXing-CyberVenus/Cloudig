import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

const text = (value: JsonValue | undefined): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const object = (value: JsonValue | undefined): JsonObject => isJsonObject(value) ? value : {};
const list = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];

type OfficialCardResource = Readonly<{ id: string; name?: string; url: string; mime?: string; width?: number; height?: number }>;
type OfficialCardResult = Readonly<{ block: JsonObject; resources: readonly OfficialCardResource[] }>;

function displayType(value: JsonObject | undefined): string | undefined {
  const kind = text(value?.["type"]);
  return kind?.toLowerCase().replace(/[^a-z0-9_:-]+/gu, "_");
}

function sourceFor(type: string): string {
  const names: Readonly<Record<string, string>> = {
    single_select: "claude.ai_ask_user_input_v0",
    table: "claude.ai_table_display_v0",
    code_block: "claude.ai_code_block_display_v0",
    json_block: "claude.ai_json_block_display_v0",
    rich_link: "claude.ai_link_preview_display_v0",
    rich_content: "claude.ai_rich_content_display_v0",
    image_gallery: "claude.ai_image_gallery_display_v0",
    local_resource: "claude.ai_local_resource_display_v0"
  };
  return names[type] ?? `claude.ai_${type}_display_v0`;
}

function titleFor(type: string, display: JsonObject, call: JsonObject | undefined): string | undefined {
  const link = object(display["link"]);
  const content = list(display["content"]);
  return text(display["title"] ?? link["title"] ?? content[0]?.["title"] ?? call?.["message"] ?? call?.["name"])
    ?? (type === "table" ? "Claude table" : type === "code_block" ? "Claude code" : undefined);
}

function externalResources(display: JsonObject, type: string): Readonly<{ data: JsonObject; files: JsonObject[]; resources: OfficialCardResource[] }> {
  const imageItems = type === "image_gallery" ? list(display["images"]) : [];
  const files: JsonObject[] = [], images: JsonObject[] = [], resources: OfficialCardResource[] = [];
  for (const [index, image] of imageItems.entries()) {
    const url = text(image["url"] ?? image["thumbnail_url"]);
    if (!url || !/^https?:\/\//iu.test(url)) continue;
    const id = `card-image-${index + 1}`;
    resources.push({ id, url, ...(text(image["title"]) ? { name: text(image["title"])! } : {}),
      ...(typeof image["width"] === "number" ? { width: image["width"] as number } : {}),
      ...(typeof image["height"] === "number" ? { height: image["height"] as number } : {}) });
    const path = `assets/card-image-${index + 1}.jpg`;
    files.push({ path, resource: id });
    images.push({ path, ...(text(image["id"]) ? { source_id: image["id"]! } : {}), ...(text(image["title"]) ? { title: image["title"]! } : {}) });
  }
  return { data: images.length ? { images } : {}, files, resources };
}

/**
 * Claude account exports expose native Cards as tool display_content rather
 * than the bookmarklet's already-normalized native_card. Keep the original
 * tool block and add one inert Cloudig structured Box for the visible Card.
 */
export function projectClaudeOfficialCard(
  display: JsonObject | undefined,
  call: JsonObject | undefined,
  result: JsonValue | undefined
): OfficialCardResult | undefined {
  const type = displayType(display);
  if (!type || !display) return undefined;
  const input = object(call?.["input"]);
  const extra = externalResources(display, type);
  let cardInput: JsonObject = {};
  if (type === "single_select") cardInput = { ...input, ...(Object.keys(input).length ? {} : { questions: [display] }) };
  else if (type === "rich_link") cardInput = { links: [object(display["link"]) ] };
  else if (type === "image_gallery") cardInput = { title: titleFor(type, display, call) ?? "Images" };
  else if (type === "rich_content") cardInput = { items: list(display["content"]) };
  else if (type === "local_resource") cardInput = { resources: list(display["resources"]) };
  else if (type === "json_block") {
    const json = display["json_block"] ?? display["json"] ?? display["content"];
    cardInput = json === undefined ? {} : { json };
  } else if (type === "code_block") {
    cardInput = { ...(display["language"] !== undefined ? { language: display["language"] } : {}),
      ...(display["code"] !== undefined ? { code: display["code"] } : {}),
      ...(display["filename"] !== undefined ? { filename: display["filename"] } : {}) };
  }
  else cardInput = { ...display };
  const data: JsonObject = { input: cardInput };
  if (result !== undefined) data["result"] = result;
  for (const [key, value] of Object.entries(extra.data)) data[key] = value;
  return {
    block: { type: "interactive", source: sourceFor(type), display: "box", format: "structured",
      ...(titleFor(type, display, call) ? { title: titleFor(type, display, call)! } : {}), data,
      ...(extra.files.length ? { files: extra.files } : {}) },
    resources: extra.resources
  };
}
