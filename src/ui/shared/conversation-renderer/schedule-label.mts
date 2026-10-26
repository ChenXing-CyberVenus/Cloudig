/** Human reading of common five-field cron schedules. Unknown syntax remains
 * in details; never invent a timezone or flatten OR day-of-month/day-of-week. */
export function cronLabel(expression: string, en: boolean): string {
  const parts = expression.trim().split(/\s+/u);
  const fallback = en ? "Custom schedule · see rule" : "自定义时间表 · 详见规则";
  if (parts.length !== 5) return fallback;
  const [minute, hour, day, month, week] = parts as [string,string,string,string,string];
  const n = (v:string,max:number) => /^\d+$/u.test(v) && Number(v) <= max;
  const clock = n(minute,59) && n(hour,23) ? `${hour.padStart(2,"0")}:${minute.padStart(2,"0")}` : undefined;
  if (month !== "*") return fallback;
  if (day === "*" && week === "*") {
    if (clock) return en ? `Every day at ${clock}` : `每天 ${clock}`;
    if (minute === "*" && hour === "*") return en ? "Every minute" : "每分钟";
    const interval = /^\*\/(\d+)$/u.exec(minute);
    if (hour === "*" && interval && Number(interval[1]) >= 1 && Number(interval[1]) <= 59) return en ? `Every ${interval[1]} minutes` : `每 ${interval[1]} 分钟`;
    if (n(minute,59) && hour === "*") return en ? `Every hour at minute ${minute.padStart(2,"0")}` : `每小时的第 ${Number(minute)} 分钟`;
  }
  if (clock && n(day,31) && Number(day)>=1 && week==="*") return en ? `Day ${Number(day)} of each month at ${clock}` : `每月 ${Number(day)} 日 ${clock}`;
  if (clock && day==="*") {
    const days = week === "1-5" ? [1,2,3,4,5] : week.split(",").every(v=>n(v,7)) ? [...new Set(week.split(",").map(v=>Number(v)%7))] : [];
    if (days.length) { const names=en?["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]:["周日","周一","周二","周三","周四","周五","周六"];
      return en ? `Every ${days.map(d=>names[d]).join(", ")} at ${clock}` : `每${days.map(d=>names[d]).join("、")} ${clock}`; }
  }
  return fallback;
}
