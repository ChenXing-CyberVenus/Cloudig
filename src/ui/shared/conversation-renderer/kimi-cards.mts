import type { JsonObject } from "../../../core/contracts/types.mts";
import { cronLabel } from "./schedule-label.mts";
import { boxElement as el, boxObject as obj, boxList as list, boxText as text, boxHeading as heading, boxParagraph as paragraph, boxLabel as label, type BoxContext } from "./box-controls.mts";

/** Native service cards are records of the captured state, not calls to Kimi. */
export function kimiCard(ctx: BoxContext, block: JsonObject): HTMLElement {
  const data = obj(block["data"]), input = obj(data["input"]), kind = text(block["source"]);
  const root = el(ctx, "section", "cloudig-box cloudig-kimi-card");
  if (kind !== "kimi.com_files") root.append(heading(ctx, text(block["title"])));
  if (kind === "kimi.com_question") {
    for (const q of list(input["questions"])) {
      root.append(paragraph(ctx, text(q["question"])));
      const choices = el(ctx, "ul", "cloudig-box-bullets");
      for (const choice of list(q["options"])) choices.append(el(ctx, "li", "", text(choice["option"])));
      root.append(choices);
    }
    const answers: JsonObject[] = [];
    for (const item of list(obj(data["native"])["contents"])) {
      const content = obj(item["content"]);
      if (content["case"] !== "text") continue;
      try { answers.push(...list(JSON.parse(text(content["value"])))); } catch { /* Non-JSON tool text remains in the preserved native record. */ }
    }
    for (const answer of answers) if (answer["answer"] !== undefined) {
      root.append(el(ctx, "strong", "", label(ctx, "已保存的回答", "Saved answer")), paragraph(ctx, typeof answer["answer"] === "string" ? answer["answer"] : JSON.stringify(answer["answer"])));
    }
  } else if (kind === "kimi.com_scheduled_task") {
    const once = text(input["once_at"]), cron = text(input["cron_expr"]), zone = text(input["timezone"] ?? input["time_zone"]);
    if (once || cron) root.append(el(ctx, "p", "cloudig-kimi-schedule-time", once || cronLabel(cron, ctx.language === "en")));
    if (zone) root.append(el(ctx, "p", "cloudig-box-muted", `${label(ctx,"时区","Time zone")} · ${zone}`));
    if (cron) { const rule=el(ctx,"details","cloudig-box-files");rule.append(el(ctx,"summary","",label(ctx,"定时规则","Schedule rule")),el(ctx,"code","",cron));root.append(rule); }
    if (text(input["content"])) root.append(paragraph(ctx, text(input["content"])));
    if (text(data["presentation"])) { const original = el(ctx, "details", "cloudig-box-files"); original.append(el(ctx, "summary", "", label(ctx, "保存的卡片状态", "Saved card state")), paragraph(ctx, text(data["presentation"]))); root.append(original); }
  } else if (kind === "kimi.com_plugin_recommendation") {
    const plugins = list(data["plugins"]).length ? list(data["plugins"]) : list(input["plugins"]);
    for (const plugin of plugins) { const item = el(ctx, "section", "cloudig-box-stack"); item.append(heading(ctx, text(plugin["name"] ?? plugin["plugin_name"])), paragraph(ctx, text(plugin["description"]))); root.append(item); }
  } else if (kind === "kimi.com_website_evidence") {
    const provenance = obj(data["provenance"]);
    root.append(paragraph(ctx, [text(data["description"]), text(provenance["version"])].filter(Boolean).join(" · ")));
    root.append(paragraph(ctx, label(ctx, "已保存版本源码记录。此版本依赖原平台的服务。", "Version source evidence is saved. This version depends on the original platform's services."), true));
  }
  const files = list(block["files"]);
  if (files.length) {
    const details = el(ctx, "details", "cloudig-box-files"), summary = el(ctx, "summary", "", `${label(ctx, "文件", "Files")} · ${files.length}`);
    details.append(summary); let populated = false;
    details.addEventListener("toggle", () => {
      if (!details.open || populated || ctx.signal.aborted) return; populated = true;
      for (const file of files) details.append(ctx.file?.(text(file["resource"]), text(file["path"])) ?? paragraph(ctx, text(file["path"])));
    }); root.append(details);
  }
  return root;
}
