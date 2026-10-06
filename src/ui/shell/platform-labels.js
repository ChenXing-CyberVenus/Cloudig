// Interface labels only. Never translate source model claims or user-set names.
const englishNames = Object.freeze({ doubao: "Doubao", chatglm: "ChatGLM", yuanbao: "Yuanbao" });

export function localizePlatformLabel(id, fallback, language) {
  return language === "en" ? (englishNames[id] ?? fallback) : fallback;
}
