import type { JsonObject, JsonValue } from "../../../core/contracts/types.mts";
import { quizBox, recipeBox, stepBox } from "./learning-boxes.mts";
import { chartBox, weatherBox, placesListBox } from "./data-boxes.mts";
import { mapBox } from "./map-box.mts";
import { boxText as str, boxObject as obj, boxList as list, boxStrings as strings, boxElement as el, boxLabel as tr,
  boxButton as button, boxParagraph as p, boxHeading as heading, boxPager as pager, boxTabs as tabs,
  boxLink as link, boxCopy as copy, boxImages, type BoxContext } from "./box-controls.mts";

function translation(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-translation");
  for (const [language, body, pronunciation] of [
    [str(input["source_language"]), str(input["source_text"]), ""],
    [str(input["target_language"]) || str(input["target_lang"]), str(input["translation"]), str(input["pronunciation"])]
  ]) {
    const column = el(ctx, "section", "cloudig-box-translation-column"), header = el(ctx, "header", "cloudig-box-toolbar");
    header.append(el(ctx, "span", "cloudig-box-muted", language), copy(ctx, () => body!)); column.append(header, p(ctx, body!));
    if (pronunciation) column.append(p(ctx, pronunciation, true)); root.append(column);
  }
  return root;
}

function optionsBox(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-options"), options = list(input["options"]); let index = 0;
  const paint = () => {
    root.setAttribute("aria-label", str(input["title"])); root.replaceChildren(); const item = options[index]; if (!item) return;
    root.append(heading(ctx, str(item["title"])), p(ctx, str(item["description"])));
    const bullets = el(ctx, "ul", "cloudig-box-option-points"); for (const text of strings(item["bullets"])) bullets.append(el(ctx, "li", "", text));
    root.append(bullets, pager(ctx, options.length, index, n => { index = n; paint(); }));
  }; paint(); return root;
}

function productsBox(ctx: BoxContext, input: JsonObject, images: readonly JsonObject[], mode: "comparison" | "featured" | "carousel"): HTMLElement {
  const root = el(ctx, "section", `cloudig-box cloudig-box-products cloudig-box-${mode}`), products = list(input["products"]); let page = 0;
  const nodes = products.map((item, index) => {
      const product = el(ctx, "section", "cloudig-box-product"), name = str(item["name"]);
      const assigned = images.filter(i => str(i["source_id"]).startsWith(`product_${index}_`));
      const gallery = boxImages(ctx, assigned.map(i => str(i["path"])), name);
      if (gallery) { gallery.classList.add("cloudig-box-mosaic"); product.append(gallery); } product.append(heading(ctx, name));
      if (str(item["price"])) product.append(p(ctx, str(item["price"])));
      if (str(item["blurb"])) product.append(p(ctx, str(item["blurb"])));
      const attributes = list(item["attributes"]);
      if (attributes.length && mode !== "comparison") {
        const dl = el(ctx, "dl", "cloudig-box-attributes");
        for (const a of attributes) dl.append(el(ctx, "dt", "cloudig-box-muted", str(a["label"])), el(ctx, "dd", "", str(a["value"])));
        product.append(dl);
      }
      return product;
  });
  const unassigned = boxImages(ctx, images.filter(i => !products.some((_, index) => str(i["source_id"]).startsWith(`product_${index}_`))).map(i => str(i["path"])), str(input["summary"]));
  if (mode === "comparison") {
    const region = el(ctx, "div", "cloudig-box-comparison-scroll"), table = el(ctx, "table", "cloudig-box-comparison-table"); region.dataset["scrollRegion"] = "";
    table.style.setProperty("--cloudig-product-count", String(Math.max(1, products.length)));
    const headers = el(ctx, "tr"), head = el(ctx, "thead"), body = el(ctx, "tbody");
    for (const node of nodes) { const th = el(ctx, "th"); th.scope = "col"; th.append(node); headers.append(th); }
    head.append(headers); table.append(head, body);
    // One table row per attribute. Missing/reordered attributes cannot shift the
    // adjacent product's values, and repeated labels retain their occurrences.
    const rows: { key: string; label: string }[] = [], seen = new Set<string>();
    const columns = products.map(product => {
      const count = new Map<string, number>(), values = new Map<string, string>();
      for (const attribute of list(product["attributes"])) {
        const label = str(attribute["label"]), occurrence = count.get(label) ?? 0, key = JSON.stringify([label, occurrence]); count.set(label, occurrence + 1);
        if (!seen.has(key)) { seen.add(key); rows.push({ key, label }); } values.set(key, str(attribute["value"]));
      } return values;
    });
    for (const row of rows) {
      const tr = el(ctx, "tr"); for (const column of columns) {
        const td = el(ctx, "td"), dl = el(ctx, "dl"); dl.append(el(ctx, "dt", "cloudig-box-muted", row.label), el(ctx, "dd", "", column.get(row.key) ?? "—")); td.append(dl); tr.append(td);
      } body.append(tr);
    }
    region.append(table); root.append(region); if (unassigned) root.append(unassigned); return root;
  }
  const paint = () => {
    root.replaceChildren(); const grid = el(ctx, "div", "cloudig-box-product-grid");
    // Reparent existing cards, so page changes do not allocate more image URLs.
    grid.append(...(mode === "carousel" ? nodes.slice(page * 2, page * 2 + 2) : nodes));
    root.append(grid);
    if (unassigned) root.append(unassigned);
    if (mode === "carousel" && products.length > 2) root.append(pager(ctx, Math.ceil(products.length / 2), page, n => { page = n; paint(); }));
  }; paint(); return root;
}

function itinerary(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-itinerary"), days = list(input["days"]); let day = 0;
  const paint = () => {
    root.replaceChildren(heading(ctx, str(input["title"])), tabs(ctx, days.map(d => str(d["day_label"])), day, n => { day = n; paint(); }));
    const stops = el(ctx, "ol", "cloudig-box-stops");
    for (const stop of list(days[day]?.["stops"])) {
      const item = el(ctx, "li"); item.append(el(ctx, "span", "cloudig-box-muted", str(stop["time"])), heading(ctx, str(stop["name"])), p(ctx, str(stop["blurb"]))); stops.append(item);
    } root.append(stops);
  }; paint(); return root;
}

function links(ctx: BoxContext, input: JsonObject, images: readonly string[]): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-links");
  for (const [index, item] of list(input["links"]).entries()) {
    const card = el(ctx, "section", "cloudig-box-link-card"), path = images[index]; if (path) card.append(ctx.image(path, str(item["title"])));
    card.append(p(ctx, str(item["domain"]), true), link(ctx, str(item["title"]), str(item["url"])), p(ctx, str(item["snippet"]))); root.append(card);
  } return root;
}

function compose(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-compose"), variants = list(input["variants"]); let index = 0;
  const drafts = variants.map(v => ({ subject: str(v["subject"]), body: str(v["body"]) }));
  const paint = () => {
    root.replaceChildren(heading(ctx, str(input["summary_title"])));
    if (variants.length > 1) root.append(tabs(ctx, variants.map((v, n) => str(v["label"]) || String(n + 1)), index, n => { index = n; paint(); }));
    const draft = drafts[index]; if (!draft) return;
    if (input["kind"] === "email" || draft.subject) {
      const label = el(ctx, "label", "cloudig-box-field", tr(ctx, "主题", "Subject")), field = el(ctx, "input", "cloudig-box-input"); field.type = "text"; field.value = draft.subject;
      field.addEventListener("input", () => { draft.subject = field.value; }); label.append(field); root.append(label);
    }
    const label = el(ctx, "label", "cloudig-box-field", tr(ctx, "正文", "Message")), field = el(ctx, "textarea", "cloudig-box-input"); field.rows = 8; field.value = draft.body;
    field.dataset["scrollRegion"] = ""; field.addEventListener("input", () => { draft.body = field.value; }); label.append(field);
    root.append(label, copy(ctx, () => [draft.subject, draft.body].filter(Boolean).join("\n\n")));
    // A saved composition is not connected to the original Gmail/account or AI.
    // Editing and copying are local; no fake send action and no source rewrite.
  }; paint(); return root;
}

function officialTable(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-table"), rows = Array.isArray(input["table"])
    ? input["table"].filter(Array.isArray).map(row => row as JsonValue[]) : [];
  if (str(input["title"])) root.append(heading(ctx, str(input["title"])));
  if (!rows.length) return root;
  const region = el(ctx, "div", "cloudig-box-table-scroll"); region.dataset["scrollRegion"] = "";
  const table = el(ctx, "table"), head = el(ctx, "thead"), body = el(ctx, "tbody");
  const header = rows[0]! as JsonValue[]; const headerRow = el(ctx, "tr");
  for (const cell of header) headerRow.append(el(ctx, "th", "", str(cell)));
  head.append(headerRow); table.append(head);
  for (const row of rows.slice(1)) { const tr = el(ctx, "tr"); for (const cell of row) tr.append(el(ctx, "td", "", str(cell))); body.append(tr); }
  table.append(body); region.append(table); root.append(region); return root;
}

function officialCode(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-code");
  if (str(input["title"])) root.append(heading(ctx, str(input["title"])));
  const pre = el(ctx, "pre", "cloudig-code", str(input["code"] ?? input["json"] ?? input["content"])); pre.dataset["scrollRegion"] = "";
  if (str(input["language"])) pre.dataset["language"] = str(input["language"]);
  if (str(input["filename"])) pre.dataset["filename"] = str(input["filename"]);
  root.append(pre); return root;
}

function officialRichContent(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-rich-content");
  if (str(input["title"])) root.append(heading(ctx, str(input["title"])));
  for (const item of list(input["items"])) {
    const card = el(ctx, "section", "cloudig-box-stack");
    if (str(item["title"])) card.append(heading(ctx, str(item["title"])));
    for (const subtitle of strings(item["subtitles"])) card.append(p(ctx, subtitle, true));
    if (str(item["text"])) card.append(p(ctx, str(item["text"])));
    if (str(item["url"])) card.append(link(ctx, str(item["title"]) || str(item["url"]), str(item["url"])));
    root.append(card);
  }
  return root;
}

function officialResources(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-resources");
  if (str(input["title"])) root.append(heading(ctx, str(input["title"])));
  for (const item of list(input["resources"])) {
    const row = el(ctx, "div", "cloudig-box-resource-row");
    row.append(el(ctx, "strong", "", str(item["name"] ?? item["file_name"] ?? item["type"] ?? "Resource")));
    if (str(item["file_path"])) row.append(p(ctx, str(item["file_path"]), true));
    if (str(item["mime_type"])) row.append(p(ctx, str(item["mime_type"]), true));
    root.append(row);
  }
  return root;
}

export function nativeResult(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value === "string") { try { return JSON.parse(value) as JsonValue; } catch { return value; } }
  if (Array.isArray(value)) {
    const texts = list(value).flatMap(v => typeof v["text"] === "string" ? [v["text"] as string] : []);
    if (texts.length) return nativeResult(texts.join("\n"));
  } return value;
}

function questions(ctx: BoxContext, input: JsonObject, result: JsonValue | undefined): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-questions"), recorded = obj(nativeResult(result));
  const answer = recorded["answers"] ?? recorded["answer"] ?? recorded["responses"];
  for (const [n, question] of list(input["questions"]).entries()) {
    const item = el(ctx, "section", "cloudig-box-stack"); item.append(heading(ctx, `${n + 1}. ${str(question["question"])}`));
    const ul = el(ctx, "ul", "cloudig-box-bullets"); for (const option of strings(question["options"])) ul.append(el(ctx, "li", "", option)); item.append(ul); root.append(item);
  }
  if (answer !== undefined) {
    root.append(heading(ctx, tr(ctx, "已保存的回答", "Saved answers")));
    // Never turn a recorded human answer into an invitation to send a new one.
    const render = (value: JsonValue): HTMLElement => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return p(ctx, value === null ? "" : String(value));
      const section = el(ctx, "div", "cloudig-box-stack");
      if (Array.isArray(value)) for (const v of value) section.append(render(v));
      else for (const [key, v] of Object.entries(value)) { const entry = el(ctx, "div"); entry.append(el(ctx, "strong", "", key), render(v)); section.append(entry); }
      return section;
    }; root.append(render(answer));
  }
  return root;
}

/** Dispatch exact platform-native names. Unknown providers stay readable and
 * inert instead of being guessed as an executable format from their suffix. */
export function renderStructuredBox(ctx: BoxContext, block: JsonObject): HTMLElement {
  if (block["display"] === "window") return structuredWindow(ctx, block);
  const data = obj(block["data"]), input = obj(data["input"]), imageItems = list(data["images"]), images = imageItems.map(i => str(i["path"]));
  let root: HTMLElement;
  switch (block["source"]) {
    case "claude.ai_translation_display_v0": root = translation(ctx, input); break;
    case "claude.ai_quiz_display_v0": root = quizBox(ctx, input); break;
    case "claude.ai_recipe_display_v0": root = recipeBox(ctx, input, images); break;
    case "claude.ai_step_card_display_v0": root = stepBox(ctx, input); break;
    case "claude.ai_options_card_display_v0": root = optionsBox(ctx, input); break;
    case "claude.ai_comparison_card_display_v0": root = productsBox(ctx, input, imageItems, "comparison"); break;
    case "claude.ai_featured_card_display_v0": root = productsBox(ctx, input, imageItems, "featured"); break;
    case "claude.ai_product_carousel_display_v0": root = productsBox(ctx, input, imageItems, "carousel"); break;
    case "claude.ai_itinerary_display_v0": root = itinerary(ctx, input); break;
    case "claude.ai_link_preview_display_v0": root = links(ctx, input, images); break;
    case "claude.ai_message_compose_v1": root = compose(ctx, input); break;
    case "claude.ai_table_display_v0": root = officialTable(ctx, input); break;
    case "claude.ai_code_block_display_v0":
    case "claude.ai_json_block_display_v0": root = officialCode(ctx, input); break;
    case "claude.ai_rich_content_display_v0": root = officialRichContent(ctx, input); break;
    case "claude.ai_local_resource_display_v0": root = officialResources(ctx, input); break;
    case "claude.ai_image_gallery_display_v0": root = boxImages(ctx, images, str(block["title"])) ?? el(ctx, "section", "cloudig-box cloudig-box-images"); break;
    case "claude.ai_chart_display_v0": root = chartBox(ctx, input); break;
    case "claude.ai_weather_fetch": root = weatherBox(ctx, input, obj(nativeResult(data["result"]))); break;
    case "claude.ai_places_list_display_v0": root = placesListBox(ctx, input, imageItems); break;
    case "claude.ai_places_map_display_v0": root = mapBox(ctx, input, obj(nativeResult(data["result"])), imageItems); break;
    case "claude.ai_ask_user_input_v0": root = questions(ctx, input, data["result"]); break;
    default: {
      root = el(ctx, "section", "cloudig-box cloudig-box-fallback");
      root.append(heading(ctx, str(block["title"]) || str(block["source"])));
      const original = el(ctx, "pre", "cloudig-tool-data", JSON.stringify(data, null, 2)); original.dataset["scrollRegion"] = ""; root.append(original);
      const gallery = boxImages(ctx, images, str(block["title"])); if (gallery) root.append(gallery);
    }
  }
  root.dataset["source"] = str(block["source"]); return root;
}

/** Display is independent of the native content format. A structured Window
 * uses the same card controls, created only when opened and aborted on close. */
function structuredWindow(ctx: BoxContext, block: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-window-entry"), title = str(block["title"]) || str(block["source"]);
  let dismiss: (() => void) | undefined;
  const launch = button(ctx, tr(ctx, "打开作品", "Open work"), () => {
    if (dismiss) return;
    const controller = new AbortController(), dialog = el(ctx, "dialog", "cloudig-conversation-renderer cloudig-interactive-window cloudig-structured-window");
    dialog.dataset["theme"] = root.closest<HTMLElement>("[data-theme]")?.dataset["theme"] === "star-night" ? "star-night" : "dawn";
    const header = el(ctx, "header", "cloudig-interactive-header"), body = el(ctx, "div", "cloudig-interactive-body"); body.dataset["scrollRegion"] = "";
    const close = () => { if (!dismiss) return; dismiss = undefined; controller.abort(); ctx.signal.removeEventListener("abort", close); dialog.close(); dialog.remove(); if (!ctx.signal.aborted) launch.focus(); };
    dismiss = close;
    const done = button(ctx, "×", close, "cloudig-interactive-close"); done.setAttribute("aria-label", tr(ctx, "关闭作品", "Close work")); done.title = done.getAttribute("aria-label")!;
    header.append(el(ctx, "h2", "", title), done); body.append(renderStructuredBox({ ...ctx, signal: controller.signal }, { ...block, display: "box" }));
    dialog.append(header, body); dialog.setAttribute("aria-label", title); ctx.document.body.append(dialog);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); }); ctx.signal.addEventListener("abort", close, { once: true }); dialog.showModal();
  });
  root.append(heading(ctx, title), launch); return root;
}
