import { boxElement as el, boxButton as button, boxLabel as tr, type BoxContext } from "./box-controls.mts";

/** A user-started clock belongs to this Reader instance, never to the saved recipe. */
export function recipeTimer(ctx: BoxContext, seconds: number): Readonly<{ element: HTMLElement; pause: () => void }> {
  const root = el(ctx, "div", "cloudig-box-timer"), clock = ctx.document.defaultView!;
  const display = el(ctx, "output", "cloudig-box-timer-display"), announcement = el(ctx, "span", "cloudig-box-muted");
  display.setAttribute("role", "timer"); announcement.setAttribute("role", "status");
  const duration = Math.max(0, Math.round(seconds * 1000)); let remaining = duration, deadline = 0, handle: number | undefined;
  const stop = () => { if (handle !== undefined) clock.clearInterval(handle); handle = undefined; };
  const paint = () => {
    const total = Math.ceil(remaining / 1000), minutes = Math.floor(total / 60);
    display.textContent = `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    display.setAttribute("aria-label", `${total} ${tr(ctx, "秒", "seconds")}`);
    toggle.textContent = handle !== undefined ? tr(ctx, "暂停", "Pause") : remaining === 0 ? tr(ctx, "重新计时", "Restart timer") : tr(ctx, "开始计时", "Start timer");
    announcement.textContent = remaining === 0 ? tr(ctx, "计时结束", "Timer finished") : "";
    reset.disabled = remaining === duration && handle === undefined;
  };
  const tick = () => { remaining = Math.max(0, deadline - Date.now()); if (remaining === 0) stop(); paint(); };
  const toggle = button(ctx, "", () => {
    if (handle !== undefined) { remaining = Math.max(0, deadline - Date.now()); stop(); }
    else { if (remaining === 0) remaining = duration; deadline = Date.now() + remaining; handle = clock.setInterval(tick, 1000); }
    paint();
  });
  const reset = button(ctx, tr(ctx, "重置计时", "Reset timer"), () => { stop(); remaining = duration; paint(); });
  ctx.signal.addEventListener("abort", stop, { once: true });
  root.append(display, toggle, reset, announcement); paint();
  return { element: root, pause: () => { if (handle !== undefined) remaining = Math.max(0, deadline - Date.now()); stop(); paint(); } };
}
