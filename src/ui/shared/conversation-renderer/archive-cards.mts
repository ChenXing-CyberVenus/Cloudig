import type { JsonObject } from "../../../core/contracts/types.mts";
import { boxElement as el, boxText as str, boxObject as obj, boxList as list, boxHeading as heading, boxParagraph as paragraph,
  boxLink as link, boxLabel as label, type BoxContext } from "./box-controls.mts";

export function searchReferenceBox(ctx: BoxContext, data: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-search-references"), track = el(ctx, "div", "cloudig-search-reference-track");
  const news = obj(data["reference"])["type"] === "nav_list";
  root.dataset["kind"] = news ? "news" : "images";
  track.dataset["scrollRegion"] = "";
  track.dataset["count"]=String(list(data["items"]).length);
  for (const item of list(data["items"])) {
    const card = el(ctx, "article", "cloudig-search-reference-card"), title = str(item["title"] ?? item["attribution"] ?? item["url"]);
    if (str(item["image"])) {
      card.append(ctx.image(str(item["image"]), title));
      const size = obj(item["thumbnail_size"] ?? item["content_size"]), width = Number(size["width"]), height = Number(size["height"]);
      if (!news && width > 0 && height > 0 && Number.isFinite(width / height)) card.style.setProperty("--search-image-ratio", String(Math.min(4, Math.max(.25, width / height))));
    }
    const caption = el(ctx, "div", "cloudig-search-reference-caption");
    if (news && str(item["attribution"])) caption.append(paragraph(ctx, str(item["attribution"]), true));
    // Search-image captions are attribution, not a second article heading.
    caption.append(link(ctx, news || !str(item["image"]) ? title : str(item["attribution"]) || title, str(item["url"])));
    if (typeof item["pub_date"] === "number") {
      const date = new Date(item["pub_date"] * 1000); if (Number.isFinite(date.valueOf())) caption.append(el(ctx, "time", "cloudig-box-muted", date.toISOString().slice(0, 10)));
    }
    card.append(caption);
    track.append(card);
  }
  root.append(track); return root;
}

/** Archived choices show captured answers/state, never submit a new response
 * or perform a connector action on the user's live account. */
export function botArchiveCard(ctx: BoxContext, data: JsonObject): HTMLElement {
  const entry = obj(data["entry"]), root = el(ctx, "section", "cloudig-box cloudig-bot-card");
  const rich = (text: string) => ctx.richText?.(text) ?? paragraph(ctx, text);
  if (entry["kind"] === "widget") {
    root.append(rich(str(entry["prompt"])));
    if (str(entry["helpText"])) root.append(rich(str(entry["helpText"])));
    const choices = el(ctx, "ul", "cloudig-bot-options"), answer = entry["respondedValue"], selected = Array.isArray(answer) ? answer : [answer];
    for (const raw of Array.isArray(entry["options"]) ? entry["options"] : []) {
      const option = obj(raw), text = typeof raw === "string" ? raw : str(option["label"] ?? option["value"]);
      const item = el(ctx, "li", "", text); item.dataset["selected"] = String(selected.some(value => value === (option["value"] ?? text))); choices.append(item);
    }
    root.append(choices);
    if (answer !== null && answer !== undefined) { root.append(heading(ctx, label(ctx,"已回答","Answered")),rich(typeof answer === "string" ? answer : JSON.stringify(answer))); }
    if (entry["skipped"]) root.append(paragraph(ctx,label(ctx,"已跳过","Skipped"),true));
    if (entry["dismissed"]) root.append(paragraph(ctx,label(ctx,"已收起","Dismissed"),true));
  } else {
    root.append(heading(ctx,str(entry["connector"] ?? entry["kind"])), paragraph(ctx,str(entry["variant"]),true));
  }
  return root;
}
