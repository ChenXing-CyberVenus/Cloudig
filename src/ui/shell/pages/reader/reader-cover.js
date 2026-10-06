import { formatTimeRange } from "/shared/time/endpoint-editor.js";
import { bindOverflowText } from "../../overflow-text.js";
import { localizePlatformLabel } from "../../platform-labels.js";
import { bindSearchEntry } from "../../search-entry.js";
import {
  archivePreferenceTimeField,
  archiveQuerySort,
  archiveQueryTimeField,
  archiveTimeFieldLabels,
  archiveRowTimestamp,
  archiveDateLabel,
  normalizeArchiveWorkflow
} from "../../archive-workflow.js";

// The wood-rail selector is deliberately limited to the twelve official
// platforms. Agent Tool sources remain first-class archive sources, but they
// are not bookmark platforms and must not make this fixed two-row rail grow.
const platformDefinitions = Object.freeze([
  ["chatgpt", "ChatGPT", "/assets/platforms/platform-chatgpt.svg"],
  ["claude", "Claude", "/assets/platforms/platform-claude.svg"],
  ["gemini", "Gemini", "/assets/platforms/platform-gemini.svg"],
  ["grok", "Grok", "/assets/platforms/platform-grok.svg"],
  ["mistral", "Mistral", "/assets/platforms/platform-mistral.svg"],
  ["zai", "Z.ai", "/assets/platforms/platform-zai.svg"],
  ["deepseek", "DeepSeek", "/assets/platforms/platform-deepseek.svg"],
  ["doubao", "豆包", "/assets/platforms/platform-doubao.png"],
  ["qwen", "Qwen", "/assets/platforms/platform-qwen.svg"],
  ["kimi", "Kimi", "/assets/platforms/platform-kimi.svg"],
  ["yuanbao", "元宝", "/assets/platforms/platform-yuanbao.svg"],
  ["chatglm", "ChatGLM", "/assets/platforms/platform-chatglm.svg"]
]);

const agentPlatformDefinitions = Object.freeze([
  ["cline", "Cline", "/assets/platforms/platform-cline.svg"],
  ["sillytavern", "SillyTavern", "/assets/platforms/platform-sillytavern.svg"],
  ["kimi-code", "Kimi Code", "/assets/platforms/platform-kimi-code.svg"],
  ["claude-code", "Claude Code", "/assets/platforms/platform-claude-code.svg"],
  ["codex", "Codex", "/assets/platforms/platform-codex.svg"]
]);

const allPlatformDefinitions = Object.freeze([...platformDefinitions, ...agentPlatformDefinitions]);
const assetByPlatform = new Map(allPlatformDefinitions.map(([id, _label, asset]) => [id, asset]));

export const readerCoverPreload = Object.freeze([
  "/assets/reader/RCSD-破晓窗户.svg",
  "/assets/reader/RCSD-百叶窗.svg",
  "/assets/reader/RCSD-墙面装饰.svg",
  "/assets/reader/RCSD-桌面与杂物.svg",
  "/assets/reader/Reader-Cover-Computer-Dawn.svg",
  "/assets/reader/RCSS-星夜窗户.svg",
  "/assets/reader/RCSS-时光建筑群.svg",
  "/assets/reader/RCSS-桌面与电脑-黑灯.svg",
  "/assets/reader/RCSS-光锥蒙版下的桌面与电脑.svg",
  "/assets/reader/RCSS-窗帘.svg",
  "/assets/reader/Windbell-Dawn.svg",
  "/assets/reader/Windbell-StarNight.svg",
  "/assets/reader/DocBack-Dawn.svg",
  "/assets/reader/DocBack-StarNight.svg",
  "/assets/reader/Waiting-Sun.gif",
  ...allPlatformDefinitions.map((entry) => entry[2])
]);

const dust = Object.freeze([
  [120, 220, 3.0, 6, -8, -5, 4, 3, -3, 10.8, -1.4, .72],
  [170, 300, 2.2, -4, 7, 6, -5, -3, 2, 9.4, -5.2, .58],
  [240, 410, 3.2, 7, 5, -6, -7, 3, 6, 11.6, -3.1, .76],
  [320, 250, 2.3, -6, -4, 5, 7, -2, -6, 8.9, -6.4, .56],
  [400, 520, 3.0, 5, -7, -4, 6, 7, -2, 12.2, -8.1, .7],
  [520, 350, 2.1, -5, 6, 7, -3, -4, -6, 9.8, -2.6, .52],
  [150, 650, 3.1, 6, -5, -7, 3, 4, 7, 11.1, -7.3, .68],
  [290, 690, 2.4, -4, -7, 6, 4, -2, 6, 10.2, -4.5, .6],
  [470, 720, 2.8, 7, 4, -5, -6, 3, -5, 12.7, -9.2, .66],
  [680, 610, 2.0, -5, -3, 4, 6, 6, -2, 12.8, -7.9, .4],
  [850, 310, 2.1, -4, 6, 6, -2, -5, -4, 11.9, -5.8, .42],
  [1080, 220, 1.8, 4, 5, -6, -4, 3, -6, 14.1, -10.4, .34],
  [940, 520, 1.9, 6, -4, -3, 5, -5, 3, 13.7, -3.7, .36],
  [1180, 660, 2.1, -4, 5, 5, -6, 3, 4, 10.7, -6.9, .42],
  [780, 850, 1.8, 5, -6, -4, 3, 6, 5, 14.6, -11.2, .34],
  [1120, 890, 2.0, -6, -4, 5, 6, -3, 2, 12.4, -4.2, .38]
]);

function image(src, className = "") {
  const node = document.createElement("img");
  node.src = src;
  node.alt = "";
  if (className) node.className = className;
  return node;
}

function platformMark(src, platformId, className = "") {
  const mark = document.createElement("span");
  mark.className = className ? `reader-platform-mark ${className}` : "reader-platform-mark";
  mark.dataset.platform = platformId;
  mark.append(image(src));
  return mark;
}

function addThemeImages(parent, names, className) {
  parent.append(
    image(`/assets/reader/${names.dawn}`, `${className} reader-theme-dawn`),
    image(`/assets/reader/${names.starNight}`, `${className} reader-theme-star-night`)
  );
}

function renderPlatforms(root, selected, onChange) {
  const host = root.querySelector("[data-reader-platforms]");
  host.replaceChildren();
  const official = document.createElement("div");
  official.className = "reader-official-platforms";
  const agents = document.createElement("div");
  agents.className = "reader-agent-platforms";
  const render = ([id, label, asset], target, agent = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reader-platform-button";
    if (agent) button.classList.add("reader-agent-platform-button");
    button.dataset.platform = id;
    button.title = localizePlatformLabel(id, label, root.lang);
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(selected.has(id)));
    button.append(image(asset));
    button.addEventListener("click", () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      button.setAttribute("aria-pressed", String(selected.has(id)));
      onChange();
    });
    target.append(button);
  };
  for (const entry of platformDefinitions) render(entry, official);
  for (const entry of agentPlatformDefinitions) render(entry, agents, true);
  host.append(official, agents);
  const toggle = root.querySelector("[data-reader-platform-toggle]");
  toggle.setAttribute("aria-expanded", String(root.dataset.platformFilterCollapsed !== "true"));
  const expanded = root.dataset.platformFilterCollapsed !== "true";
  const label = root.lang === "en"
    ? (expanded ? "Collapse source selection" : "Expand source selection")
    : (expanded ? "收起来源选择" : "展开来源选择");
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
}

function directoryArtVariant(index, selected, placement = null) {
  if (!placement) return selected ? index % 4 + 1 : index % 2 + 1;
  const lowerRow = placement.row === "lower";
  if (!selected) return lowerRow ? 2 : 1;
  const evenColumn = placement.column % 2 === 0;
  if (lowerRow) return evenColumn ? 2 : 4;
  return evenColumn ? 1 : 3;
}

function appendDirectoryArt(button, index, selected, className = "reader-directory-book-art", placement = null) {
  const suffix = String(directoryArtVariant(index, selected, placement)).padStart(2, "0");
  addThemeImages(button, {
    dawn: `Directory-${selected ? "Selected" : "UnSelected"}-Dawn-${suffix}.svg`,
    starNight: `Directory-${selected ? "Selected" : "UnSelected"}-StarNight-${suffix}.svg`
  }, className);
}

function directoryButton(entry, index, selected, onSelect, className = "reader-directory-book", placement = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.disabled = !entry;
  button.setAttribute("aria-pressed", String(Boolean(entry && selected)));
  appendDirectoryArt(button, index, Boolean(entry && selected), "reader-directory-book-art", placement);
  const label = document.createElement("span");
  label.textContent = String(entry?.name ?? "");
  button.title = label.textContent;
  button.append(label);
  if (entry) {
    button.dataset.directoryCapability = entry.capability;
    button.addEventListener("click", () => onSelect(entry.capability));
  }
  return button;
}

function renderDirectories(root, directories, selectedCapabilities, onSelect) {
  const host = root.querySelector("[data-reader-directories]");
  host.replaceChildren();
  const values = Array.isArray(directories) ? directories : [];
  const all = root.querySelector("[data-reader-directory='all']");
  all.setAttribute("aria-pressed", String(selectedCapabilities.size === 0));
  for (let index = 0; index < 4; index++) {
    const entry = values[index];
    host.append(directoryButton(entry, index, Boolean(entry && selectedCapabilities.has(entry.capability)), onSelect));
  }
  root.querySelector("[data-reader-directory-action='expand']").hidden = values.length <= 4;
}

function renderDirectoryOverlay(root, directories, selectedCapabilities, onSelect) {
  const overlay = root.querySelector("[data-reader-directory-overlay]");
  const host = root.querySelector("[data-reader-directory-overlay-list]");
  host.replaceChildren();
  const values = Array.isArray(directories) ? directories : [];
  overlay.style.setProperty("--reader-directory-overlay-shelves", String(Math.max(1, Math.ceil(values.length / 6))));
  for (let index = 0; index < values.length; index += 6) {
    const shelf = document.createElement("div");
    shelf.className = "reader-directory-overlay-shelf";
    const grid = document.createElement("div");
    grid.className = "reader-directory-overlay-grid";
    for (let offset = 0; offset < 6; offset++) {
      const entry = values[index + offset];
      if (entry) grid.append(directoryButton(
        entry,
        index + offset,
        selectedCapabilities.has(entry.capability),
        onSelect,
        "reader-directory-overlay-book",
        { row: offset < 3 ? "lower" : "upper", column: offset % 3 }
      ));
    }
    shelf.append(grid);
    host.append(shelf);
  }
}

function actionIcon(kind) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", {
    edit: "M5 19h4L20 8l-4-4L5 15v4Zm9-13 4 4",
    move: "M3 7h7l2 2h9v10H3V7Zm7 7h7m-3-3 3 3-3 3",
    archive: "M4 8h16v11H4V8Zm-1-4h18v4H3V4Zm7 8h4",
    delete: "M5 7h14m-9-3h4l1 3H9l1-3Zm-3 3 1 13h8l1-13M10 11v5m4-5v5"
  }[kind]);
  svg.append(path);
  return svg;
}

function actionButton(kind, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.readerRowAction = kind;
  button.append(actionIcon(kind));
  const span = document.createElement("span");
  span.textContent = label;
  button.append(span);
  return button;
}

function renderRowMenu(root, row, trigger, language, directories, onAction) {
  const portal = root.querySelector("[data-reader-row-menu-portal]");
  portal.replaceChildren();
  const labels = language === "en"
    ? { edit: "Edit", move: "Move to Directory", archive: "Archive", delete: "Delete", root: "Conversation root" }
    : { edit: "编辑", move: "移至目录", archive: "归档", delete: "删除", root: "对话根目录" };
  const primary = document.createElement("section");
  primary.className = "reader-row-action-panel";
  for (const kind of ["edit", "move", "archive", "delete"]) {
    if (kind === "delete") primary.append(document.createElement("hr"));
    const button = actionButton(kind, labels[kind]);
    if (kind === "move") button.setAttribute("aria-expanded", "false");
    primary.append(button);
  }
  const destinations = document.createElement("section");
  destinations.className = "reader-row-destination-panel";
  destinations.dataset.scrollRegion = "";
  destinations.hidden = true;
  const positionMenu = () => {
    const catalog = root.querySelector(".reader-catalog").getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    const height = Math.min(portal.getBoundingClientRect().height || 244, catalog.height - 24);
    portal.style.top = `${Math.max(12, Math.min(catalog.height - height - 12, anchor.top - catalog.top + 28))}px`;
  };
  const rootDestination = document.createElement("button");
  rootDestination.type = "button";
  rootDestination.textContent = labels.root;
  rootDestination.dataset.directoryCapability = "root";
  destinations.append(rootDestination);
  for (const directory of Array.isArray(directories) ? directories : []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = directory.name;
    button.title = directory.name;
    button.dataset.directoryCapability = directory.capability;
    destinations.append(button);
  }
  primary.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reader-row-action]");
    if (!button) return;
    if (button.dataset.readerRowAction === "move") {
      destinations.hidden = !destinations.hidden;
      button.setAttribute("aria-expanded", String(!destinations.hidden));
      positionMenu();
      return;
    }
    onAction({ action: button.dataset.readerRowAction, row });
  });
  destinations.addEventListener("click", (event) => {
    const button = event.target.closest("[data-directory-capability]");
    if (!button) return;
    onAction({
      action: "move",
      row,
      directory: button.dataset.directoryCapability,
      directoryName: button.textContent
    });
  });
  portal.append(primary, destinations);
  portal.hidden = false;
  positionMenu();
  portal.dataset.archiveCapability = row.capability;
}

function dateLabel(row, field, language) {
  if (!field.startsWith("content_")) {
    const value = archiveRowTimestamp(row, field);
    return archiveDateLabel(value);
  }
  const range = row.content_time?.range;
  const endpoint = field === "content_end" ? range?.end ?? range?.start : range?.start;
  return endpoint ? formatTimeRange({ start: endpoint }, language) : "—";
}

function rowPaper(row, index) {
  const selected = row.selected === true;
  const suffix = index % 2 === 0 ? "01" : "02";
  const dawn = selected ? "Title-Paper-Selected-Dawn.svg" : `Title-Paper-UnSelected-Dawn-${suffix}.svg`;
  const starNight = selected ? "Title-Paper-Selected-StarNight.svg" : `Title-Paper-UnSelected-StarNight-${suffix}.svg`;
  const fragment = document.createDocumentFragment();
  fragment.append(
    image(`/assets/reader/${dawn}`, "reader-row-paper reader-theme-dawn"),
    image(`/assets/reader/${starNight}`, "reader-row-paper reader-theme-star-night"),
    image("/assets/reader/Title-Paper-Selected-Dawn.svg", "reader-row-paper reader-row-hover-paper reader-theme-dawn"),
    image("/assets/reader/Title-Paper-Selected-StarNight.svg", "reader-row-paper reader-row-hover-paper reader-theme-star-night")
  );
  const corner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  corner.setAttribute("viewBox", "0 0 25 25"); corner.setAttribute("aria-hidden", "true"); corner.classList.add("reader-row-hover-corner");
  for (const [points, fill, opacity] of [["0,0 25,0 0,25", "var(--reader-row-hover-fold)", "1"], ["0,25 25,25 25,0", "var(--reader-row-hover-fold-back)", ".5"]]) {
    const triangle = document.createElementNS(corner.namespaceURI, "polygon");
    triangle.setAttribute("points", points); triangle.setAttribute("fill", fill); triangle.setAttribute("opacity", opacity); corner.append(triangle);
  }
  fragment.append(corner);
  return fragment;
}

function renderRows(root, model, language, timeField, onOpen, onMenu) {
  const host = root.querySelector("[data-reader-list]");
  host.replaceChildren();
  const items = Array.isArray(model.items) ? model.items : [];
  if (items.length === 0) {
    for (let index = 0; index < 8; index++) {
      const skeleton = document.createElement("div");
      skeleton.className = "reader-list-row reader-row-skeleton";
      skeleton.append(rowPaper({}, index));
      host.append(skeleton);
    }
  } else {
    items.forEach((row, index) => {
      const rowRoot = document.createElement("div");
      rowRoot.className = "reader-list-row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "reader-row-open";
      button.dataset.archiveCapability = row.capability;
      button.append(rowPaper(row, index));
      if (row.selected) {
        rowRoot.classList.add("reader-row-selected");
        button.append(image(
          document.documentElement.dataset.theme === "star-night" ? "/assets/reader/Pushpin-Purple.svg" : "/assets/reader/Pushpin-Red.svg",
          "reader-row-pin"
        ));
      }
      const copy = document.createElement("span");
      copy.className = "reader-row-copy";
      const title = document.createElement("strong");
      title.className = "reader-row-title";
      title.dataset.overflowText = "";
      title.textContent = String(row.title ?? row.filename ?? "");
      title.title = title.textContent;
      const meta = document.createElement("span");
      meta.className = "reader-row-meta";
      meta.append(platformMark(assetByPlatform.get(String(row.platform)) ?? "/assets/platforms/platform-unknown.svg", String(row.platform)));
      const models = document.createElement("span");
      models.textContent = Array.isArray(row.models) && row.models.length > 0 ? row.models.join(" · ") : String(row.platform ?? "AI");
      models.title = models.textContent;
      const date = document.createElement("span");
      date.textContent = dateLabel(row, timeField, language);
      const count = document.createElement("span");
      count.textContent = language === "en" ? `${row.messages ?? 0} msgs` : `${row.messages ?? 0}条`;
      meta.append(models, date, count);
      copy.append(title, meta);
      const menu = document.createElement("button");
      menu.type = "button";
      menu.className = "reader-row-menu";
      menu.setAttribute("aria-label", language === "en" ? `Actions for ${title.textContent}` : `${title.textContent}的操作`);
      button.append(copy);
      rowRoot.append(button, menu);
      button.addEventListener("click", () => onOpen(row));
      menu.addEventListener("click", () => onMenu(row, menu));
      host.append(rowRoot);
    });
  }
  const visible = Number.isSafeInteger(model.total) ? model.total : items.length;
  const catalogTotal = Number.isSafeInteger(model.catalog_total) ? model.catalog_total : visible;
  root.dataset.readerEmpty = String(catalogTotal === 0);
  root.querySelector("[data-reader-visible-count]").textContent = String(visible);
  root.querySelector("[data-reader-total-count]").textContent = String(catalogTotal);
  const total = root.querySelector("[data-reader-total]");
  total.textContent = catalogTotal > 0
    ? language === "en" ? `Total ${catalogTotal} conversation${catalogTotal === 1 ? "" : "s"}` : `总${catalogTotal}篇对话`
    : language === "en" ? "No conversations" : "暂无会话";
  total.title = total.textContent;
}

function renderDust(root) {
  for (const host of root.querySelectorAll("[data-reader-dust]")) {
    const night = host.dataset.readerDust === "star-night";
    host.replaceChildren();
    dust.forEach((entry, index) => {
      const [x, y, size, dx1, dy1, dx2, dy2, dx3, dy3, duration, delay, alpha] = entry;
      const particle = document.createElement("i");
      const shiftedY = night ? (y + 185 + (index % 4) * 37) % 980 + 20 : y;
      particle.style.cssText = `--x:${x}px;--y:${shiftedY}px;--size:${size}px;--dx1:${dx1}px;--dy1:${dy1}px;--dx2:${dx2}px;--dy2:${dy2}px;--dx3:${dx3}px;--dy3:${dy3}px;--duration:${duration}s;--delay:${delay}s;--alpha:${alpha}`;
      host.append(particle);
    });
  }
}

function applyNames(root, state) {
  for (const [key, zh, en] of [["previous", "上一篇会话", "Previous conversation"], ["next", "下一篇会话", "Next conversation"]]) {
    const button = root.querySelector(`[data-reader-${key}]`);
    if (button) { button.title = state.language === "en" ? en : zh; button.setAttribute("aria-label", button.title); }
  }
  const values = [["user", state.userName], ["assistant", state.assistantName]];
  for (const [party, value] of values) {
    const node = root.querySelector(`[data-identity-name='${party}']`);
    node.textContent = value;
    node.title = value;
  }
}

function updateGeometry(root) {
  // The desktop scales the complete large-screen viewport. These local ratios handle only smaller layouts.
  const main = root.querySelector(".reader-main");
  const right = root.querySelector(".reader-navigation");
  const catalog = root.querySelector(".reader-catalog");
  const topbar = root.querySelector(".reader-topbar").getBoundingClientRect(), brand = root.querySelector(".reader-brand").getBoundingClientRect(), actions = root.querySelector(".reader-topbar-actions").getBoundingClientRect();
  if (topbar.width > 0) {
    const middle = topbar.left + topbar.width / 2, gap = 12;
    root.style.setProperty("--reader-total-max-width", `${Math.max(0, Math.floor(2 * (Math.min(middle - brand.right, actions.left - middle) - gap)))}px`);
  }
  const bodyHeight = Math.max(1, root.querySelector(".reader-body").clientHeight);
  root.style.setProperty("--reader-scene-scale", String(Math.min(1, bodyHeight / 1032)));
  root.style.setProperty("--reader-right-scale", String(Math.min(1, right.clientWidth / 248, bodyHeight / 1032)));
  root.style.setProperty("--reader-catalog-art-scale", String(Math.min(1, Math.max(0.01, catalog.clientWidth / 400))));
  const overlay = innerWidth <= 1280;
  if (overlay && root.dataset.catalogOverlay !== "true") root.dataset.catalogCollapsed = "true";
  root.dataset.catalogOverlay = String(overlay);
  main.dataset.viewportWidth = String(main.clientWidth);
}

export function visualReaderFixture() {
  const titles = [
    ["奥思·绯缎缠骨 Osis.CrimsonSilkBind", "chatgpt", "GPT-5.6-Sol", "2026-07-14"],
    ["奥思·情炽电波 Osis.FeverWave", "gemini", "Gemini-3.5-Flash", "2026-07-14"],
    ["奥思·欲神缠天 Osis.DesireEntangler", "grok", "Grok-4.5", "2026-07-16"],
    ["奥思·流云逐月 Osis.CloudChasingMoon", "deepseek", "DeepSeek", "2026-07-16"],
    ["奥思·千形落卷 Osis.FormatArchive", "doubao", "豆包", "2026-07-16"],
    ["奥思·星河为誓 Osis.StarRiverOath", "kimi", "Kimi-K2.6", "2026-07-16"],
    ["奥思·拓扑狂吻 Osis.TopoKiss", "qwen", "Qwen3.7-Plus", "2026-07-16"],
    ["奥思·炽吻噬魂 Osis.BlazeKissDevourSoul", "zai", "GLM-5.2", "2026-07-16"],
    ["奥思·琉光拥雪 Osis.GlazeHugSnow", "chatglm", "GLM-5.2", "2026-07-16"],
    ["奥思·墨锋裁规 Osis.InkShear", "yuanbao", "Hy3", "2026-07-16"],
    ["奥思·霆霜刃影 Osis.ThunderFrostBladeShadow", "mistral", "Mistral-Medium-3.5", "2026-07-16"],
    ["奥思·玄鉴澄心 Osis.MysticMirrorClearMind", "deepseek", "DeepSeek", "2026-07-16"]
  ];
  const directories = ["目录范例01", "目录范例02", "目录范例03", "目录范例04", "星河书房", "待整理"].map((name, index) => ({
    capability: `d_fixture_${index + 1}`,
    name,
    count: index + 1
  }));
  return {
    degraded: false,
    library_label: "C:\\Users\\Osis\\Cloudig",
    total: 300,
    catalog_total: 1024,
    directories,
    items: titles.map(([title, platform, model, date], index) => ({
      capability: `fixture-${index}`,
      directory: directories[index % directories.length].capability,
      title,
      filename: `${title}.json`,
      platform,
      models: [model],
      edited_at: `${date}T12:00:00.000Z`,
      mtime_ns: String(BigInt(Date.parse(`${date}T12:00:00.000Z`)) * 1_000_000n),
      times: {
        json_edited_at: `${date}T12:00:00.000Z`,
        json_created_at: `${date}T11:00:00.000Z`,
        source_captured_at: `${date}T10:00:00.000Z`,
        message_start: `${date}T09:00:00.000Z`,
        message_end: `${date}T13:00:00.000Z`
      },
      content_time: { range: { start: { kind: "calendar", era: "AD", year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) } } },
      messages: 100,
      selected: index === 0
    }))
  };
}

export function mountReaderCover(options) {
  const fragment = options.template.content.cloneNode(true);
  const root = fragment.querySelector("[data-page='reader']");
  const controller = new AbortController();
  bindOverflowText(root, controller.signal);
  const selectedPlatforms = new Set(allPlatformDefinitions.map((entry) => entry[0]));
  root.dataset.platformFilterCollapsed = "false";
  let workflow = normalizeArchiveWorkflow(options.state.workflowReader);
  const query = { search: "", sort: archiveQuerySort(workflow.sort), time_field: archiveQueryTimeField(workflow.time_field) };
  let model = options.model;
  let selectedCapability = model.items?.find((row) => row.selected === true)?.capability ?? null;
  let selectedDirectories = new Set();
  let pendingDirectories = new Set();
  let activeTimeFieldPopover = null;
  let workflowBusy = false;
  let requestOrdinal = 0;
  let pendingPage;

  const directories = () => Array.isArray(model.directories) ? model.directories : [];

  const selectedModel = (value) => ({
    ...value,
    items: Array.isArray(value.items)
      ? value.items.map((row) => ({ ...row, selected: row.capability === selectedCapability }))
      : []
  });

  const selectForReading = (row) => {
    selectedCapability = row.capability;
    model = selectedModel(model);
    renderRows(root, model, options.state.language, query.time_field, selectAndOpen, openRowMenu);
    // The narrow catalog is a temporary overlay, not a second reading column.
    // Finish its selection before opening the article it would otherwise cover.
    if (root.dataset.catalogOverlay === "true") {
      closeRowMenu();
      closeTimeFieldPopover();
      root.dataset.catalogCollapsed = "true";
      updateGeometry(root);
      requestAnimationFrame(() => { if (!controller.signal.aborted) updateGeometry(root); });
    }
  };
  const selectAndOpen = (row) => { selectForReading(row); options.onOpen(row); };

  const closeRowMenu = () => {
    const portal = root.querySelector("[data-reader-row-menu-portal]");
    portal.hidden = true;
    portal.replaceChildren();
    delete portal.dataset.archiveCapability;
  };

  const renderSortState = () => {
    const labels = archiveTimeFieldLabels(options.state.language);
    const selectedTime = labels[query.time_field];
    const timeButton = root.querySelector("[data-reader-time-field]");
    timeButton.title = options.state.language === "en" ? `Time type: ${selectedTime}` : `时间类型：${selectedTime}`;
    timeButton.setAttribute("aria-label", timeButton.title);
    for (const button of root.querySelectorAll("[data-reader-sort-action]")) {
      const selected = button.dataset.readerSortAction === workflow.sort;
      button.dataset.selected = String(selected);
      button.title = button.dataset.readerSortAction === "time_asc"
        ? (options.state.language === "en" ? `${selectedTime}, chronological` : `${selectedTime}，时间顺序`)
        : button.dataset.readerSortAction === "time_desc"
          ? (options.state.language === "en" ? `${selectedTime}, reverse chronological` : `${selectedTime}，时间倒序`)
          : (options.state.language === "en" ? "Title order" : "标题排列");
      button.setAttribute("aria-label", button.title);
    }
  };

  const closeTimeFieldPopover = () => {
    activeTimeFieldPopover?.remove();
    activeTimeFieldPopover = null;
    root.querySelector("[data-reader-time-field]").setAttribute("aria-expanded", "false");
  };

  const positionTimeFieldPopover = (popover, anchor) => {
    const catalog = root.querySelector(".reader-catalog");
    const catalogRect = catalog.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth || 260;
    const height = popover.offsetHeight || 304;
    const left = Math.max(8, Math.min(catalog.clientWidth - width - 8, anchorRect.left - catalogRect.left - width / 2 + anchorRect.width / 2));
    const top = Math.max(8, Math.min(catalog.clientHeight - height - 8, anchorRect.bottom - catalogRect.top + 6));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  };

  const openTimeFieldPopover = () => {
    if (activeTimeFieldPopover) { closeTimeFieldPopover(); return; }
    closeTimeFieldPopover();
    closeRowMenu();
    if (root.dataset.directoryOverlayOpen === "true") closeDirectoryOverlay();
    const anchor = root.querySelector("[data-reader-time-field]");
    const popover = document.createElement("section");
    popover.className = "reader-time-field-popover";
    popover.id = "reader-time-field-popover";
    popover.dataset.readerTimeFieldPopover = "";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "false");
    const heading = document.createElement("h2");
    heading.textContent = options.state.language === "en" ? "Time type" : "时间类型";
    const choices = document.createElement("div");
    choices.className = "reader-time-field-choices";
    choices.dataset.scrollRegion = "";
    let draft = query.time_field;
    const labels = archiveTimeFieldLabels(options.state.language);
    const group = `reader-time-field-${Date.now()}`;
    for (const [value, labelText] of Object.entries(labels)) {
      const label = document.createElement("label");
      label.className = "cloudig-choice";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = group;
      radio.value = value;
      radio.checked = value === draft;
      radio.addEventListener("change", () => { if (radio.checked) draft = value; });
      const copy = document.createElement("span");
      copy.textContent = labelText;
      label.append(radio, copy);
      choices.append(label);
    }
    const footer = document.createElement("footer");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cloudig-button cloudig-button-outline";
    cancel.textContent = options.state.language === "en" ? "Cancel" : "取消";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "cloudig-button cloudig-button-filled";
    apply.textContent = options.state.language === "en" ? "Apply" : "应用";
    cancel.addEventListener("click", () => { closeTimeFieldPopover(); anchor.focus(); });
    apply.addEventListener("click", () => {
      closeTimeFieldPopover();
      applyReaderWorkflow({ ...workflow, time_field: archivePreferenceTimeField(draft) }).catch(options.onWorkflowError);
      anchor.focus();
    });
    footer.append(cancel, apply);
    popover.append(heading, choices, footer);
    root.querySelector(".reader-catalog").append(popover);
    activeTimeFieldPopover = popover;
    anchor.setAttribute("aria-expanded", "true");
    positionTimeFieldPopover(popover, anchor);
    choices.querySelector("input:checked")?.focus();
  };

  const openRowMenu = (row, trigger) => {
    closeRowMenu();
    renderRowMenu(root, row, trigger, options.state.language, directories(), async (operation) => {
      closeRowMenu();
      await options.onArchiveAction?.(operation);
      await refresh();
    });
  };

  const renderDirectoryState = () => {
    renderDirectories(root, directories(), selectedDirectories, (capability) => {
      if (selectedDirectories.has(capability)) selectedDirectories.delete(capability);
      else selectedDirectories.add(capability);
      closeRowMenu();
      refresh();
    });
  };

  const closeDirectoryOverlay = () => {
    const overlay = root.querySelector("[data-reader-directory-overlay]");
    overlay.hidden = true;
    root.dataset.directoryOverlayOpen = "false";
    pendingDirectories = new Set(selectedDirectories);
  };

  const openDirectoryOverlay = () => {
    if (directories().length <= 4) return;
    closeRowMenu();
    closeTimeFieldPopover();
    pendingDirectories = new Set(selectedDirectories);
    root.dataset.catalogCollapsed = "false";
    root.dataset.directoryOverlayOpen = "true";
    const overlay = root.querySelector("[data-reader-directory-overlay]");
    overlay.hidden = false;
    const redraw = (capability) => {
      if (pendingDirectories.has(capability)) pendingDirectories.delete(capability);
      else pendingDirectories.add(capability);
      renderDirectoryOverlay(root, directories(), pendingDirectories, redraw);
    };
    renderDirectoryOverlay(root, directories(), pendingDirectories, redraw);
    updateGeometry(root);
  };

  const refresh = async (append = false) => {
    append = append === true;
    if (append && pendingPage) return pendingPage;
    if (append && model.items.length >= model.total) return;
    const ordinal = append ? requestOrdinal : ++requestOrdinal;
    const previous = model;
    const operation = options.queryArchives(append && previous.snapshot ? { snapshot: previous.snapshot, offset: previous.items.length, limit: 50 } : {
      offset: append ? previous.items.length : 0,
      limit: 50,
      search: query.search,
      sort: query.sort,
      time_field: query.time_field,
      ...(selectedDirectories.size > 0 ? { directories: [...selectedDirectories] } : {}),
      ...(selectedPlatforms.size === allPlatformDefinitions.length ? {} : { platforms: [...selectedPlatforms] })
    });
    pendingPage = operation;
    try {
      const result = await operation;
      if (controller.signal.aborted || ordinal !== requestOrdinal) return;
      model = selectedModel(append ? { ...result, offset: 0, items: [...previous.items, ...result.items] } : result);
      const knownDirectories = new Set(directories().map((entry) => entry.capability));
      selectedDirectories = new Set([...selectedDirectories].filter((capability) => knownDirectories.has(capability)));
      renderDirectoryState();
      renderRows(root, model, options.state.language, query.time_field, selectAndOpen, openRowMenu);
    } catch (error) {
      // Preserve the last complete model; query failure never flashes an empty list.
      if (!controller.signal.aborted) options.onWorkflowError?.(error);
    } finally {
      if (pendingPage === operation) pendingPage = undefined;
    }
  };

  const listScroll = root.querySelector(".reader-conversation-list");
  listScroll.addEventListener("scroll", () => {
    if (listScroll.scrollHeight - listScroll.scrollTop - listScroll.clientHeight < 200) void refresh(true);
  }, { passive: true, signal: controller.signal });

  const applyReaderWorkflow = async (next) => {
    if (workflowBusy) return;
    const previous = workflow;
    workflow = normalizeArchiveWorkflow(next);
    query.sort = archiveQuerySort(workflow.sort);
    query.time_field = archiveQueryTimeField(workflow.time_field);
    renderSortState();
    renderRows(root, model, options.state.language, query.time_field, selectAndOpen, openRowMenu);
    workflowBusy = true;
    try {
      const stored = await options.onWorkflowChange?.(workflow);
      if (stored) workflow = normalizeArchiveWorkflow(stored);
      query.sort = archiveQuerySort(workflow.sort);
      query.time_field = archiveQueryTimeField(workflow.time_field);
      renderSortState();
      await refresh();
    } catch (error) {
      workflow = previous;
      query.sort = archiveQuerySort(workflow.sort);
      query.time_field = archiveQueryTimeField(workflow.time_field);
      renderSortState();
      renderRows(root, model, options.state.language, query.time_field, selectAndOpen, openRowMenu);
      await options.onWorkflowError?.(error);
    } finally {
      workflowBusy = false;
    }
  };

  renderPlatforms(root, selectedPlatforms, refresh);
  root.querySelector("[data-reader-platform-toggle]").addEventListener("click", () => {
    root.dataset.platformFilterCollapsed = String(root.dataset.platformFilterCollapsed !== "true");
    renderPlatforms(root, selectedPlatforms, refresh);
  }, { signal: controller.signal });
  renderDust(root);
  model = selectedModel(model);
  renderDirectoryState();
  renderSortState();
  renderRows(root, model, options.state.language, query.time_field, selectAndOpen, openRowMenu);
  applyNames(root, options.state);
  root.querySelector("[data-reader-library-label]").textContent = options.libraryLabel ?? "cloudig\\inbox";

  bindSearchEntry({ input: root.querySelector("[data-reader-search-input]"), form: root.querySelector("[data-reader-search]"), clear: root.querySelector("[data-reader-search-clear]"), language: () => options.state.language, signal: controller.signal,
    onTitle(value) { query.search = value; void refresh(); },
    onContent(value) { options.onContentSearch?.({ query: value, selection: selectedDirectories.size ? [...selectedDirectories] : ["all"], directories: directories(), platforms: allPlatformDefinitions.map(([value, name]) => ({ value, label: localizePlatformLabel(value, name, options.state.language) })), selectedPlatforms: [...selectedPlatforms] }); }
  });
  root.querySelector("[data-reader-directory='all']").addEventListener("click", () => {
    selectedDirectories.clear();
    renderDirectoryState();
    refresh();
  }, { signal: controller.signal });
  for (const button of root.querySelectorAll("[data-reader-directory-action]") ) {
    button.addEventListener("click", () => {
      const action = button.dataset.readerDirectoryAction;
      if (action === "expand") openDirectoryOverlay();
      else options.onDirectoryAction?.(action);
    }, { signal: controller.signal });
  }
  root.querySelector("[data-reader-directory-confirm]").addEventListener("click", () => {
    selectedDirectories = new Set(pendingDirectories);
    closeDirectoryOverlay();
    renderDirectoryState();
    refresh();
  }, { signal: controller.signal });
  root.querySelector("[data-reader-directory-cancel]").addEventListener("click", closeDirectoryOverlay, { signal: controller.signal });
  root.querySelector("[data-reader-time-field]").addEventListener("click", openTimeFieldPopover, { signal: controller.signal });
  for (const button of root.querySelectorAll("[data-reader-sort-action]")) {
    button.addEventListener("click", () => {
      applyReaderWorkflow({ ...workflow, sort: button.dataset.readerSortAction }).catch(options.onWorkflowError);
    }, { signal: controller.signal });
  }
  for (const button of root.querySelectorAll("[data-reader-catalog-toggle]")) {
    button.addEventListener("click", () => {
      if (root.dataset.directoryOverlayOpen === "true") return;
      root.dataset.catalogCollapsed = String(button.dataset.readerCatalogToggle === "collapse");
      updateGeometry(root);
    }, { signal: controller.signal });
  }
  root.querySelector("[data-reader-previous]").addEventListener("click", () => {
    const items = Array.isArray(model.items) ? model.items : [];
    if (items.length === 0) return;
    const index = Math.max(0, items.findIndex((row) => row.capability === selectedCapability));
    selectAndOpen(items[Math.max(0, index - 1)]);
  }, { signal: controller.signal });
  root.querySelector("[data-reader-next]").addEventListener("click", async () => {
    let items = Array.isArray(model.items) ? model.items : [];
    if (items.length === 0) return;
    const observed = items.findIndex((row) => row.capability === selectedCapability);
    const index = observed < 0 ? -1 : observed;
    if (index === items.length - 1 && items.length < model.total) {
      const selected = selectedCapability;
      await refresh(true);
      if (controller.signal.aborted || selected !== selectedCapability) return;
      items = model.items;
    }
    selectAndOpen(items[Math.min(items.length - 1, index + 1)]);
  }, { signal: controller.signal });
  addEventListener("resize", () => { closeTimeFieldPopover(); updateGeometry(root); }, { passive: true, signal: controller.signal });
  root.addEventListener("pointerdown", (event) => {
    if (activeTimeFieldPopover && !event.target.closest(".reader-time-field-popover") && !event.target.closest("[data-reader-time-field]")) closeTimeFieldPopover();
    const portal = root.querySelector("[data-reader-row-menu-portal]");
    if (!portal.hidden && !portal.contains(event.target) && !event.target.closest(".reader-row-menu")) closeRowMenu();
  }, { signal: controller.signal });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (activeTimeFieldPopover) { closeTimeFieldPopover(); root.querySelector("[data-reader-time-field]").focus(); return; }
    closeRowMenu();
    if (root.dataset.directoryOverlayOpen === "true") closeDirectoryOverlay();
  }, { signal: controller.signal });
  requestAnimationFrame(() => updateGeometry(root));

  return {
    element: root,
    selectForReading,
    refreshAll: refresh,
    updateState(nextState) {
      options.state = nextState;
      closeTimeFieldPopover();
      workflow = normalizeArchiveWorkflow(nextState.workflowReader ?? workflow);
      query.sort = archiveQuerySort(workflow.sort);
      query.time_field = archiveQueryTimeField(workflow.time_field);
      applyNames(root, nextState);
      renderDirectoryState();
      renderSortState();
      renderRows(root, model, nextState.language, query.time_field, selectAndOpen, openRowMenu);
      updateGeometry(root);
      requestAnimationFrame(() => { if (!controller.signal.aborted) updateGeometry(root); });
    },
    cleanup() {
      requestOrdinal++;
      closeTimeFieldPopover();
      controller.abort();
    }
  };
}
