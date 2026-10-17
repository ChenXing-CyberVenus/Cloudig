import type { JsonObject } from "../../../core/contracts/types.mts";
import { boxText as str, boxList as list, boxStrings as strings, boxElement as el, boxButton as button, boxLabel as tr,
  boxParagraph as p, boxHeading as heading, boxNumberPager as pager, boxTabs as tabs, boxCopy as copy, boxImages, type BoxContext } from "./box-controls.mts";
import { recipeTimer } from "./recipe-timer.mts";
import { recipeQuantity, type RecipeUnitMode } from "./recipe-units.mts";

/** Answers and page choices are session-local; neither mutates the captured call. */
export function quizBox(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-quiz"), questions = list(input["questions"]);
  let index = 0, flashcards = false, revealed = false;
  const answers = new Map<number, string>();
  const paint = () => {
    root.setAttribute("aria-label", str(input["title"]));
    root.replaceChildren(tabs(ctx, [tr(ctx, "测验", "Quiz"), tr(ctx, "卡片", "Flashcards")], flashcards ? 1 : 0,
      n => { flashcards = n === 1; revealed = false; paint(); }));
    const q = questions[index]; if (!q) { root.append(p(ctx, str(input["description"]))); return; }
    if (!flashcards) root.append(el(ctx, "h4", "cloudig-box-question", str(q["prompt"])));
    const options = list(q["options"]), answer = answers.get(index), correct = str(q["correct_option_id"]);
    if (flashcards) {
      const face = el(ctx, "div", "cloudig-box-flashcard");
      if (revealed) {
        face.append(el(ctx, "h4", "cloudig-box-question", str(options.find(o => str(o["id"]) === correct)?.["text"]) || tr(ctx, "原记录未提供答案", "No answer in the saved record")));
        if (str(q["explanation"])) face.append(p(ctx, str(q["explanation"])));
      } else face.append(el(ctx, "h4", "cloudig-box-question", str(q["prompt"])));
      face.append(button(ctx, revealed ? tr(ctx, "查看问题", "View question") : tr(ctx, "查看答案", "View answer"), () => { revealed = !revealed; paint(); }));
      root.append(face);
    } else {
      const choices = el(ctx, "div", "cloudig-box-choices"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", str(q["prompt"]));
      for (const [ordinal, option] of options.entries()) {
        const id = str(option["id"]) || String(ordinal);
        const choice = button(ctx, "", () => { answers.set(index, id); paint(); }, "cloudig-box-choice");
        const marker = el(ctx, "span", "cloudig-box-choice-marker"); marker.setAttribute("aria-hidden", "true");
        choice.append(marker, el(ctx, "span", "", str(option["text"])));
        choice.setAttribute("aria-pressed", String(id === answer));
        choice.disabled = answer !== undefined && !!correct;
        if (answer !== undefined) choice.dataset["result"] = correct && id === correct ? "correct" : id === answer ? (correct ? "incorrect" : "selected") : "idle";
        choices.append(choice);
      }
      root.append(choices);
      if (answer !== undefined) {
        const feedback = el(ctx, "div", "cloudig-box-feedback"); feedback.setAttribute("role", "status");
        feedback.dataset["result"] = correct ? answer === correct ? "correct" : "incorrect" : "selected";
        const text = correct ? str(q[answer === correct ? "correct_feedback" : "incorrect_feedback"]) || (answer === correct ? tr(ctx, "回答正确", "Correct") : tr(ctx, "再看看答案", "Review the answer")) : tr(ctx, "已选择；原记录未提供判分答案", "Selected; no grading answer in the saved record");
        feedback.append(p(ctx, text)); if (str(q["explanation"])) feedback.append(p(ctx, str(q["explanation"]))); root.append(feedback);
      } else if (str(q["hint"])) {
        const hint = el(ctx, "details", "cloudig-box-hint"); hint.append(el(ctx, "summary", "", tr(ctx, "提示", "Hint")), p(ctx, str(q["hint"]))); root.append(hint);
      }
    }
    root.append(pager(ctx, questions.length, index, n => { index = n; revealed = false; paint(); }, flashcards || answer !== undefined));
  };
  paint(); return root;
}

export function stepBox(ctx: BoxContext, input: JsonObject): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-steps"), steps = list(input["steps"]); let index = 0, all = false;
  const paint = () => {
    root.replaceChildren();
    for (const [n, step] of steps.entries()) {
      if (!all && n !== index) continue;
      const item = el(ctx, "section", "cloudig-box-step"); item.append(el(ctx, "span", "cloudig-box-step-number", String(n + 1)),
        heading(ctx, str(step["title"])), p(ctx, str(step["description"]))); root.append(item);
    }
    root.append(button(ctx, all ? tr(ctx, "逐步查看", "View one step") : tr(ctx, "查看全部步骤", "View all steps"), () => { all = !all; paint(); }));
    if (!all && steps.length) root.append(pager(ctx, steps.length, index, n => { index = n; paint(); }));
  }; paint(); return root;
}

export function recipeBox(ctx: BoxContext, input: JsonObject, images: readonly string[]): HTMLElement {
  const root = el(ctx, "section", "cloudig-box cloudig-box-recipe"), ingredients = list(input["ingredients"]), steps = list(input["steps"]);
  const base = typeof input["base_servings"] === "number" && input["base_servings"] > 0 ? input["base_servings"] : 1;
  let servings = base, cooking = false, stepIndex = 0;
  let unitMode: RecipeUnitMode = "written";
  const checked = new Set<number>();
  const completed = new Set<number>();
  const timers = steps.map(step => typeof step["timer_seconds"] === "number" && Number.isFinite(step["timer_seconds"]) && step["timer_seconds"] > 0 ? recipeTimer(ctx, step["timer_seconds"]) : undefined);
  const ingredientText = (item: JsonObject) => {
    const quantity = typeof item["amount"] === "number" ? recipeQuantity(item["amount"] * servings / base, str(item["unit"]), unitMode) : undefined;
    const amount = quantity ? new Intl.NumberFormat(ctx.language, { maximumFractionDigits: quantity.converted ? 1 : 2 }).format(quantity.amount) : str(item["amount"]);
    return [amount, quantity?.unit ?? str(item["unit"]), str(item["name"])].filter(Boolean).join(" ");
  };
  const stepText = (step: JsonObject) => str(step["content"]).replace(/\{([^{}]+)\}/gu, (token, id: string) => {
    const ingredient = ingredients.find(i => str(i["id"]) === id); return ingredient ? ingredientText(ingredient) : token;
  });
  const content = el(ctx, "div", "cloudig-box-stack");
  const cookingWindow = el(ctx, "dialog", "cloudig-box-cooking"), cookingHeader = el(ctx, "header", "cloudig-box-toolbar");
  cookingWindow.setAttribute("aria-label", str(input["title"]) || tr(ctx, "制作食谱", "Cooking mode"));
  let originalMinimumHeight = "";
  const closeCooking = () => {
    if (!cooking) return;
    cooking = false; timers.forEach(timer => timer?.pause());
    if (cookingWindow.open) cookingWindow.close();
    root.append(content); content.removeAttribute("data-scroll-region"); cookingWindow.remove(); root.style.minHeight = originalMinimumHeight;
    if (!ctx.signal.aborted) { paint(); content.querySelector<HTMLButtonElement>("[data-start-cooking]")?.focus(); }
  };
  const openCooking = () => {
    if (!steps.length || cooking) return;
    originalMinimumHeight = root.style.minHeight; root.style.minHeight = `${root.getBoundingClientRect().height}px`;
    cooking = true; content.dataset["scrollRegion"] = ""; cookingWindow.append(content); root.append(cookingWindow); paint(); cookingWindow.showModal();
  };
  cookingHeader.append(heading(ctx, str(input["title"])), button(ctx, tr(ctx, "退出制作", "Exit cooking mode"), closeCooking)); cookingWindow.append(cookingHeader);
  cookingWindow.addEventListener("cancel", event => { event.preventDefault(); closeCooking(); }); cookingWindow.addEventListener("close", closeCooking);
  ctx.signal.addEventListener("abort", closeCooking, { once: true });
  const gallery = boxImages(ctx, images, str(input["title"])); if (gallery) root.append(gallery);
  root.append(heading(ctx, str(input["title"]))); if (str(input["description"])) root.append(p(ctx, str(input["description"]))); root.append(content);
  const paint = () => {
    const portion = el(ctx, "div", "cloudig-box-serving");
    const minus = button(ctx, "−", () => { servings = Math.max(1, servings - 1); paint(); }); minus.setAttribute("aria-label", tr(ctx, "减少份数", "Fewer servings")); minus.disabled = servings <= 1;
    const plus = button(ctx, "+", () => { servings++; paint(); }); plus.setAttribute("aria-label", tr(ctx, "增加份数", "More servings"));
    const count = el(ctx, "span", "", `${servings} ${tr(ctx, "份", servings === 1 ? "serving" : "servings")}`); count.setAttribute("aria-live", "polite");
    const mode = button(ctx, cooking ? tr(ctx, "完整食谱", "Full recipe") : tr(ctx, "开始制作", "Start cooking"), () => cooking ? closeCooking() : openCooking());
    if (!cooking) mode.dataset["startCooking"] = "";
    mode.disabled = !steps.length;
    const modes: RecipeUnitMode[] = ["written", "us", "metric"], labels = [tr(ctx, "原单位", "As written"), tr(ctx, "美制", "US"), tr(ctx, "公制", "Metric")];
    const units = el(ctx, "details", "cloudig-box-units");
    units.append(el(ctx, "summary", "cloudig-box-button", `${tr(ctx, "单位", "Units")} · ${labels[modes.indexOf(unitMode)]}`),
      tabs(ctx, labels, modes.indexOf(unitMode), index => { unitMode = modes[index]!; paint(); }));
    portion.append(minus, count, plus, copy(ctx, () => [str(input["title"]), str(input["description"]), count.textContent,
      ...ingredients.map(ingredientText), ...steps.map((step, index) => `${index + 1}. ${str(step["title"])}\n${stepText(step)}`),
      typeof input["notes"] === "string" ? str(input["notes"]) : strings(input["notes"]).join("\n")].filter(Boolean).join("\n\n")),
      units, mode);
    content.replaceChildren(portion);
    if (!cooking) {
      const items = el(ctx, "ul", "cloudig-box-ingredients");
      for (const [n, ingredient] of ingredients.entries()) {
        const item = el(ctx, "li"); const check = button(ctx, ingredientText(ingredient), () => {
          checked.has(n) ? checked.delete(n) : checked.add(n); check.setAttribute("aria-pressed", String(checked.has(n)));
        }, "cloudig-box-ingredient"); check.setAttribute("aria-pressed", String(checked.has(n))); item.append(check); items.append(item);
      } content.append(heading(ctx, tr(ctx, "材料", "Ingredients")), items);
    }
    for (const [n, step] of steps.entries()) {
      if (cooking && n !== stepIndex) continue;
      const section = el(ctx, "section", "cloudig-box-step");
      const complete = button(ctx, completed.has(n) ? "✓" : String(n + 1), () => { completed.has(n) ? completed.delete(n) : completed.add(n); paint(); }, "cloudig-box-step-number");
      complete.setAttribute("aria-label", `${tr(ctx, "标记完成步骤", "Mark step complete ")}${n + 1}`); complete.setAttribute("aria-pressed", String(completed.has(n)));
      section.append(complete, heading(ctx, str(step["title"])), p(ctx, stepText(step)));
      if (timers[n]) section.append(timers[n]!.element);
      content.append(section);
    }
    if (cooking && steps.length) content.append(pager(ctx, steps.length, stepIndex, n => { stepIndex = n; paint(); }));
    const notes = typeof input["notes"] === "string" ? str(input["notes"]) : strings(input["notes"]).join("\n");
    if (notes) { const note = el(ctx, "aside", "cloudig-box-note"); note.append(heading(ctx, tr(ctx, "备注", "Notes")), p(ctx, notes)); content.append(note); }
  }; paint(); return root;
}
