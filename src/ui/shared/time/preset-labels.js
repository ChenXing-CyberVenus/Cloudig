const english = Object.freeze({
  "采云此地时间轴": "Cloudig Terran Time", "无论何时": "Whenever", "不知何时": "Unknown",
  "无限久前": "Infinite past", "大爆炸前": "Before Big Bang", "宇宙诞生": "Universe",
  "生命起源": "Life", "史前文明": "Prehistory", "轴心时代": "Axial Age", "帝国兴亡": "Empires",
  "工业革命": "Industry", "硝烟铁幕": "War Era", "现代社会": "Modernity", "智能初晓": "AI Dawn",
  "展望未来": "Future", "万年之后": "Far future", "无限久后": "Infinite future"
});

export const terranShortcutNames = Object.freeze(["宇宙诞生", "生命起源", "史前文明", "轴心时代", "帝国兴亡", "工业革命", "硝烟铁幕", "现代社会", "智能初晓"]);
export function terranLabel(name, language) { return language === "en" ? english[name] ?? name : name; }
// Translate only built-in UI vocabulary, never a user's identically named node.
export function timeNodeLabel(row, language) { return row.builtin ? terranLabel(row.name, language) : row.name; }
