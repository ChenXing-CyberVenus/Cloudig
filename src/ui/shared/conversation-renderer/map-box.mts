import type { JsonObject } from "../../../core/contracts/types.mts";
import { boxText as str, boxObject as obj, boxList as list, boxStrings as strings, boxElement as el, boxLabel as tr,
  boxButton as button, boxParagraph as p, boxHeading as heading, boxLink as link, boxImages, type BoxContext } from "./box-controls.mts";
import { validMapPoint, type SavedMapPoint } from "./map-protocol.mts";
import { openSavedMap } from "./map-window.mts";

export function mapBox(ctx: BoxContext, input: JsonObject, result: JsonObject, images: readonly JsonObject[]): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-map"), grid = el(ctx, "div", "cloudig-box-product-grid");
  const enriched = obj(result["enriched_places"]), title = str(input["title"]) || tr(ctx, "地点地图", "Places map");
  const points: SavedMapPoint[] = [];
  for (const location of list(input["locations"])) {
    const id = str(location["place_id"]), extra = obj(enriched[id]), name = str(location["name"]), notes = str(location["notes"]);
    const candidate = { name, notes, latitude: location["latitude"], longitude: location["longitude"] };
    if (validMapPoint(candidate)) points.push(candidate);
    const card = el(ctx, "section", "cloudig-box-product"), ownedImages = id ? images.filter(i => str(i["source_id"]) === id) : [];
    const gallery = boxImages(ctx, ownedImages.map(i => str(i["path"])), name); if (gallery) card.append(gallery);
    card.append(heading(ctx, name)); if (notes) card.append(p(ctx, notes));
    if (typeof extra["rating"] === "number") card.append(p(ctx, `${tr(ctx, "来源评分", "Saved rating")} ${extra["rating"]}${typeof extra["rating_count"] === "number" ? ` · ${extra["rating_count"]}` : ""}`, true));
    if (str(location["address"])) card.append(p(ctx, str(location["address"])));
    if (str(extra["phone_number"])) card.append(p(ctx, str(extra["phone_number"])));
    if (str(extra["website"])) card.append(link(ctx, tr(ctx, "网站", "Website"), str(extra["website"])));
    if (str(extra["maps_url"])) card.append(link(ctx, tr(ctx, "在浏览器查看地点", "View place in browser"), str(extra["maps_url"])));
    const hours = strings(extra["weekday_hours"]); if (hours.length) { const details = el(ctx, "details"); details.append(el(ctx, "summary", "", tr(ctx, "来源营业时间", "Saved opening hours")), p(ctx, hours.join("\n"))); card.append(details); }
    const owners = list(extra["photos"]).filter(photo => ownedImages.some(image => image["source_url"] === photo["url"])).flatMap(photo => list(photo["attributions"]));
    if (owners.length) { const credits = el(ctx, "div", "cloudig-box-muted"); credits.append(ctx.document.createTextNode(tr(ctx, "照片：", "Photo: ")));
      for (const [n, owner] of owners.entries()) { if (n) credits.append(ctx.document.createTextNode(" · ")); credits.append(link(ctx, str(owner["display_name"]), str(owner["uri"]))); } card.append(credits); }
    if (validMapPoint(candidate)) card.append(p(ctx, `${candidate.latitude}, ${candidate.longitude}`, true));
    grid.append(card);
  }
  const load = button(ctx, tr(ctx, "加载地图 · 联网", "Load map · Online"), () => openSavedMap(ctx, title, points, load, ctx.mapFrameUrl), "cloudig-box-button cloudig-box-primary"); load.disabled = points.length === 0;
  const header = el(ctx, "header", "cloudig-box-toolbar"); header.append(heading(ctx, title), load); root.append(header, grid);
  if (!points.length) root.append(p(ctx, tr(ctx, "来源没有可用坐标。", "No usable coordinates in the saved source."), true));
  return root;
}
