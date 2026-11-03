import { isJsonObject, type JsonObject } from "../../../core/contracts/types.mts";
import { readableTask } from "../../../core/records/chatgpt-task.mts";

type Fold = { root: HTMLDetailsElement; body: HTMLElement };
export type TaskCardOptions = {
  language: "zh" | "en";
  richText: (source: string) => HTMLElement;
  formatTimestamp?: ((value: string) => string) | undefined;
  defer?: (fold: Fold, build: () => void) => void;
};
const str = (v: unknown): string => typeof v === "string" ? v : "";
export function taskTimeLabel(value: string, timezone: string): string {
  if (!timezone || !Number.isFinite(Date.parse(value))) return value;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).formatToParts(new Date(value));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
  } catch { return value; }
}
export function renderTaskList(host: HTMLElement, input: JsonObject, options: TaskCardOptions): boolean {
  const tasks = input["kind"] === "task-list" && Array.isArray(input["tasks"])
    ? input["tasks"].filter(isJsonObject) : input["kind"] === "scheduled-task" ? [input] : [];
  if (!tasks.length) return false;
  const d = host.ownerDocument, en = options.language === "en", label = (zh: string, eng: string) => en ? eng : zh;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] => {
    const n = d.createElement(tag); n.className = cls; n.textContent = text; return n;
  };
  const link = (parent: HTMLElement, url: unknown, text: string, cls: string) => {
    if (typeof url !== "string") return;
    try { if (!["https:", "http:"].includes(new URL(url).protocol)) return; } catch { return; }
    const a = el("a", `cloudig-source-link ${cls}`, text); a.href = url; a.dataset["cloudigExternal"] = "true"; a.rel = "noopener noreferrer"; parent.append(a);
  };
  const defer = options.defer ?? ((fold: Fold, build: () => void) => {
    let done = false; const fill = () => { if (!done && fold.root.open) { done = true; build(); } }; fold.root.addEventListener("toggle", fill); fill();
  });
  for (const saved of tasks) {
    const task = readableTask(saved), status = str(task["status"]), card = el("details", "cloudig-schedule-task");
    card.dataset["taskStatus"] = status;
    const summary = el("summary", "cloudig-fold-title"), title = el("span", "cloudig-task-heading");
    title.append(el("strong", "cloudig-fold-label", str(task["title"]) || label("ChatGPT 任务", "ChatGPT task")));
    if (str(task["schedule"])) title.append(el("small", "cloudig-schedule-summary", str(task["schedule"])));
    const current = isJsonObject(task["source_evidence"]) && task["source_evidence"]["source"] === "automation_api";
    const state = status === "enabled" ? label("已启用", "Enabled") : status === "paused" ? label("已暂停", "Paused") : status === "completed" ? label("已完成", "Completed") : label("状态未确认", "Status unknown");
    summary.append(title, el("span", "cloudig-schedule-state", (current ? label("采集时：", "At capture: ") : label("记录状态：", "Recorded: ")) + state));
    const body = el("div", "cloudig-fold-body"); card.append(summary, body); host.append(card);
    defer({ root: card, body }, () => {
      const meta = el("dl", "cloudig-schedule-meta");
      for (const [field, name] of [["timezone",label("时区","Time zone")],["last_run_at",label("上次执行","Last run")],["next_run_at",label("下次计划","Next scheduled run")],["planned_run_at",label("原计划时间","Previously scheduled")]] as const) {
        const value = str(task[field]); if (value) meta.append(el("dt","",name),el("dd","",field === "timezone" ? value : taskTimeLabel(value, str(task["timezone"]))));
      }
      if (typeof task["notifications_enabled"] === "boolean") meta.append(el("dt","",label("通知","Notifications")),el("dd","",task["notifications_enabled"] ? label("开启","On") : label("关闭","Off")));
      if (meta.childElementCount) body.append(meta);
      if (str(task["prompt"])) body.append(el("h4","cloudig-schedule-prompt-label",label("任务指令","Task instructions")),options.richText(str(task["prompt"])));
      link(body, task["url"], label("在原平台查看","View on ChatGPT"), "cloudig-task-source");
      link(body, task["conversation_url"], label("原会话","Original conversation"), "cloudig-schedule-conversation");
      if (isJsonObject(task["source_task"])) {
        const raw = el("details","cloudig-schedule-settings"), rawSummary = el("summary","cloudig-fold-title",label("原始设置","Original settings")), rawBody = el("div","cloudig-fold-body");
        raw.append(rawSummary,rawBody);body.append(raw);
        defer({root:raw,body:rawBody},()=>{const pre=el("pre","cloudig-tool-data",JSON.stringify(task["source_task"],null,2));pre.dataset["scrollRegion"]="";rawBody.append(pre);});
      }
    });
  }
  link(host,input["all_tasks_url"],label("查看所有任务","View all tasks"),"cloudig-schedule-all");
  return true;
}
