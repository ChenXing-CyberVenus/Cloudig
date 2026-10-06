(function initCloudigLibraryCore(root, factory) {
  "use strict";
  const api = factory();
  root.CloudigLibraryCore = api;
  if (typeof module === "object" && module?.exports) module.exports = api;
}(typeof globalThis === "object" ? globalThis : this, function createCloudigLibraryCore() {
  "use strict";

  const FORMAT = "cloudig/library";
  const VERSION = "0.1.4";
  const PREVIOUS_VERSION = "0.1.3";
  const VERSION_012 = "0.1.2";
  const VERSION_011 = "0.1.1";
  const LEGACY_VERSION = "0.1.0";
  const SUPPORTED_VERSIONS = Object.freeze([LEGACY_VERSION, VERSION_011, VERSION_012, PREVIOUS_VERSION, VERSION]);
  const FILE_NAME = "cloudig-library.json";
  const SOURCE_HASH = /^[0-9a-f]{64}$/u;
  const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
  const ASSET_PATH = /^Data\/Assets\/(?:Covers|Avatars|PlatformIcons)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
  const ROOT_KEYS = new Set([
    "format", "version", "user", "assistant", "project", "preferences",
    "platform_overrides", "conversation_overrides"
  ]);
  const USER_KEYS = new Set(["display_name", "avatar"]);
  const ASSISTANT_KEYS = new Set(["display_name", "avatar", "apply_to_all"]);
  const LEGACY_ASSISTANT_KEYS = new Set(["display_name", "avatar"]);
  const PROJECT_KEYS = new Set(["title", "description", "icon", "cover"]);
  const COVER_KEYS = new Set(["path", "fit"]);
  const PREFERENCE_KEYS = new Set(["language", "theme", "name_rule_ack_version"]);
  const LEGACY_PREFERENCE_KEYS = new Set(["language", "theme"]);
  const PLATFORM_OVERRIDE_KEYS = new Set(["icon", "assistant_name", "assistant_avatar"]);
  const LEGACY_PLATFORM_OVERRIDE_KEYS = new Set(["icon"]);
  const CONVERSATION_OVERRIDE_KEYS = new Set([
    "conversation_name", "content_time", "provider", "platform", "models",
    "user_name", "assistant_name"
  ]);
  const CONVERSATION_PATCH_KEYS = new Set([...CONVERSATION_OVERRIDE_KEYS, "title"]);
  const PREVIOUS_CONVERSATION_OVERRIDE_KEYS = new Set(["conversation_name", "content_time", "provider", "platform", "models"]);
  const VERSION_011_CONVERSATION_OVERRIDE_KEYS = new Set(["title", "content_time", "provider", "platform", "models"]);
  const LEGACY_CONVERSATION_OVERRIDE_KEYS = new Set(["title", "date", "provider", "platform", "models"]);
  const THEMES = new Set(["platform", "dawn", "star_night"]);
  const LANGUAGES = new Set(["zh-CN", "en"]);
  const COVER_FITS = new Set(["contain", "stretch"]);
  const CONTENT_TIME_TYPES = new Set(["exact", "month", "year", "decade", "unknown"]);
  const CONTENT_TIME_KEYS = new Set(["start", "end"]);
  const CONTENT_TIME_ENDPOINT_KEYS = new Set(["type", "era", "year", "month", "day", "hour", "minute", "timezone"]);
  const CONTENT_TIME_ERAS = new Set(["AD", "BC"]);
  const CONTENT_TIME_ZONE = /^(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/u;
  const DEFAULT_DISPLAY_NAMES = Object.freeze({
    "zh-CN": Object.freeze({ user: "采云用户", assistant: "智能伙伴" }),
    en: Object.freeze({ user: "User", assistant: "AI" })
  });
  const GENERATED_NAME_PAIRS = Object.freeze([
    Object.freeze({ user: "用户", assistant: "AI" }),
    Object.freeze({ user: "Cloudig User", assistant: "AI Partner" }),
    DEFAULT_DISPLAY_NAMES["zh-CN"],
    DEFAULT_DISPLAY_NAMES.en
  ]);
  const PLATFORM_DISPLAY_NAMES = Object.freeze({
    chatgpt: "ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
    grok: "Grok",
    qwen: "Qwen",
    chatglm: "智谱清言",
    yuanbao: "元宝",
    zai: "Z.ai",
    deepseek: "DeepSeek",
    kimi: "Kimi",
    doubao: "豆包",
    mistral: "Mistral"
  });

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function unexpectedKeys(value, allowed, pathName, errors) {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) errors.push(`${pathName}.${key} 不是 ${VERSION} 支持的字段。`);
    }
  }

  function validateAssetPath(value, pathName, errors) {
    if (value === undefined) return;
    const pathValue = cleanString(value);
    if (!pathValue || !ASSET_PATH.test(pathValue) || pathValue.includes("..") || pathValue.includes("\\") || pathValue.includes("://")) {
      errors.push(`${pathName} 必须是 Data/Assets/ 下不含 .. 的正斜杠相对路径。`);
    }
  }

  function validateDisplayString(value, pathName, errors, { required = false, max = 200 } = {}) {
    const text = cleanString(value);
    if (required && !text) errors.push(`${pathName} 缺失或为空。`);
    if (text && text.length > max) errors.push(`${pathName} 超过 ${max} 个字符。`);
  }

  function validateOptionalDisplayString(value, pathName, errors, { max = 200 } = {}) {
    if (value === undefined) return;
    validateDisplayString(value, pathName, errors, { required: true, max });
  }

  function validateModels(models, pathName, errors) {
    if (!Array.isArray(models) || models.length === 0) {
      errors.push(`${pathName} 必须是非空字符串数组。`);
      return;
    }
    const seen = new Set();
    for (const [index, model] of models.entries()) {
      const text = cleanString(model);
      if (!text) errors.push(`${pathName}[${index}] 必须是非空字符串。`);
      else if (seen.has(text)) errors.push(`${pathName} 包含重复模型：${text}`);
      else seen.add(text);
    }
  }

  function validateDate(value, pathName, errors, { allowDateOnly = false } = {}) {
    const text = cleanString(value);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(text);
    const dateTimeWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text);
    if (!text || !(dateTimeWithZone || (allowDateOnly && dateOnly)) || !Number.isFinite(Date.parse(text))) {
      errors.push(`${pathName} 必须是带时区的 ISO 日期时间${allowDateOnly ? "（旧版也接受纯日期）" : ""}。`);
    }
  }

  function validCalendarDate(year, month, day) {
    if (![year, month, day].every(Number.isInteger)) return false;
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
    const monthDays = [31, ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= monthDays[month - 1];
  }

  function validateContentTimeEndpoint(value, pathName, errors) {
    if (!isRecord(value)) {
      errors.push(`${pathName} 必须是时间端点对象。`);
      return;
    }
    unexpectedKeys(value, CONTENT_TIME_ENDPOINT_KEYS, pathName, errors);
    const type = cleanString(value.type);
    if (!CONTENT_TIME_TYPES.has(type)) {
      errors.push(`${pathName}.type 必须是 exact、month、year、decade 或 unknown。`);
      return;
    }
    const allowed = type === "unknown"
      ? new Set(["type"])
      : type === "decade" || type === "year"
        ? new Set(["type", "era", "year"])
        : type === "month"
          ? new Set(["type", "era", "year", "month"])
          : CONTENT_TIME_ENDPOINT_KEYS;
    unexpectedKeys(value, allowed, pathName, errors);
    if (type === "unknown") return;
    if (value.era !== undefined && !CONTENT_TIME_ERAS.has(value.era)) errors.push(`${pathName}.era 必须是 AD 或 BC。`);
    if (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999) errors.push(`${pathName}.year 必须是 1 到 9999 的整数。`);
    if (type === "decade" && Number.isInteger(value.year) && value.year % 10 !== 0) errors.push(`${pathName}.year 在 decade 类型下必须是整十年份。`);
    if (["month", "exact"].includes(type) && (!Number.isInteger(value.month) || value.month < 1 || value.month > 12)) {
      errors.push(`${pathName}.month 必须是 1 到 12 的整数。`);
    }
    if (type !== "exact") return;
    if (!validCalendarDate(value.year, value.month, value.day)) errors.push(`${pathName} 必须是有效的公历年月日。`);
    const hasHour = value.hour !== undefined;
    const hasMinute = value.minute !== undefined;
    if (hasHour !== hasMinute) errors.push(`${pathName}.hour 与 minute 必须同时出现或同时省略。`);
    if (hasHour && (!Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23)) errors.push(`${pathName}.hour 必须是 0 到 23 的整数。`);
    if (hasMinute && (!Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59)) errors.push(`${pathName}.minute 必须是 0 到 59 的整数。`);
    if (value.timezone !== undefined && !CONTENT_TIME_ZONE.test(cleanString(value.timezone))) {
      errors.push(`${pathName}.timezone 必须是 Z 或 -14:00 到 +14:00 的时区偏移。`);
    }
  }

  function validateContentTime(value, pathName, errors) {
    if (!isRecord(value)) {
      errors.push(`${pathName} 必须是内容时间对象。`);
      return;
    }
    unexpectedKeys(value, CONTENT_TIME_KEYS, pathName, errors);
    if (value.start === undefined) errors.push(`${pathName}.start 缺失。`);
    else validateContentTimeEndpoint(value.start, `${pathName}.start`, errors);
    if (value.end !== undefined) validateContentTimeEndpoint(value.end, `${pathName}.end`, errors);
  }

  function validateLibrary(value) {
    const errors = [];
    if (!isRecord(value)) return { valid: false, errors: ["Library 根节点必须是 JSON 对象。"] };
    unexpectedKeys(value, ROOT_KEYS, "$", errors);
    if (value.format !== FORMAT) errors.push(`format 必须精确等于 ${FORMAT}。`);
    if (!SUPPORTED_VERSIONS.includes(value.version)) {
      errors.push(`version 必须精确等于 ${SUPPORTED_VERSIONS.join("、")} 之一。`);
    }

    if (value.user === undefined) {
      if (value.version !== VERSION) errors.push("user 必须是对象。");
    } else if (!isRecord(value.user)) errors.push("user 必须是对象。");
    else {
      unexpectedKeys(value.user, USER_KEYS, "user", errors);
      if (value.version === VERSION) {
        validateOptionalDisplayString(value.user.display_name, "user.display_name", errors, { max: 100 });
        if (!Object.keys(value.user).length) errors.push("user 不能为空对象。");
      } else {
        validateDisplayString(value.user.display_name, "user.display_name", errors, { required: true, max: 100 });
      }
      validateAssetPath(value.user.avatar, "user.avatar", errors);
    }

    if (value.assistant !== undefined) {
      if (!isRecord(value.assistant)) errors.push("assistant 必须是对象。");
      else {
        unexpectedKeys(
          value.assistant,
          value.version === VERSION ? ASSISTANT_KEYS : LEGACY_ASSISTANT_KEYS,
          "assistant",
          errors
        );
        if (value.version === VERSION) {
          validateOptionalDisplayString(value.assistant.display_name, "assistant.display_name", errors, { max: 100 });
          if (value.assistant.apply_to_all !== undefined && typeof value.assistant.apply_to_all !== "boolean") {
            errors.push("assistant.apply_to_all 必须是布尔值。");
          }
          if (!Object.keys(value.assistant).length) errors.push("assistant 不能为空对象。");
        } else {
          validateDisplayString(value.assistant.display_name, "assistant.display_name", errors, { required: true, max: 100 });
        }
        validateAssetPath(value.assistant.avatar, "assistant.avatar", errors);
      }
    }

    if (value.project !== undefined) {
      if (!isRecord(value.project)) errors.push("project 必须是对象。");
      else {
        unexpectedKeys(value.project, PROJECT_KEYS, "project", errors);
        validateDisplayString(value.project.title, "project.title", errors, { max: 200 });
        validateDisplayString(value.project.description, "project.description", errors, { max: 1000 });
        validateAssetPath(value.project.icon, "project.icon", errors);
        if (value.project.cover !== undefined) {
          if (!isRecord(value.project.cover)) errors.push("project.cover 必须是对象。");
          else {
            unexpectedKeys(value.project.cover, COVER_KEYS, "project.cover", errors);
            validateAssetPath(value.project.cover.path, "project.cover.path", errors);
            if (value.project.cover.fit !== undefined && !COVER_FITS.has(value.project.cover.fit)) {
              errors.push("project.cover.fit 必须是 contain 或 stretch。");
            }
          }
        }
      }
    }

    if (value.preferences !== undefined) {
      if (!isRecord(value.preferences)) errors.push("preferences 必须是对象。");
      else {
        const preferenceKeys = [VERSION, PREVIOUS_VERSION, VERSION_012].includes(value.version)
          ? PREFERENCE_KEYS
          : LEGACY_PREFERENCE_KEYS;
        unexpectedKeys(value.preferences, preferenceKeys, "preferences", errors);
        if (value.preferences.language !== undefined && !LANGUAGES.has(value.preferences.language)) {
          errors.push("preferences.language 当前只支持 zh-CN 或 en。");
        }
        if (value.preferences.theme !== undefined && !THEMES.has(value.preferences.theme)) {
          errors.push("preferences.theme 必须是 platform、dawn 或 star_night。");
        }
        if (
          value.preferences.name_rule_ack_version !== undefined
          && (!Number.isInteger(value.preferences.name_rule_ack_version) || value.preferences.name_rule_ack_version < 0)
        ) {
          errors.push("preferences.name_rule_ack_version 必须是非负整数。");
        }
      }
    }

    if (value.platform_overrides !== undefined) {
      if (!isRecord(value.platform_overrides)) errors.push("platform_overrides 必须是对象。");
      else for (const [platform, override] of Object.entries(value.platform_overrides)) {
        if (!SLUG.test(platform)) errors.push(`platform_overrides 的键无效：${platform}`);
        if (!isRecord(override)) errors.push(`platform_overrides.${platform} 必须是对象。`);
        else {
          unexpectedKeys(
            override,
            [VERSION, PREVIOUS_VERSION].includes(value.version) ? PLATFORM_OVERRIDE_KEYS : LEGACY_PLATFORM_OVERRIDE_KEYS,
            `platform_overrides.${platform}`,
            errors
          );
          validateAssetPath(override.icon, `platform_overrides.${platform}.icon`, errors);
          if ([VERSION, PREVIOUS_VERSION].includes(value.version)) {
            validateOptionalDisplayString(
              override.assistant_name,
              `platform_overrides.${platform}.assistant_name`,
              errors,
              { max: 100 }
            );
            validateAssetPath(
              override.assistant_avatar,
              `platform_overrides.${platform}.assistant_avatar`,
              errors
            );
            if (!Object.keys(override).length) errors.push(`platform_overrides.${platform} 不能为空对象。`);
          } else if (!cleanString(override.icon)) {
            errors.push(`platform_overrides.${platform}.icon 缺失或为空。`);
          }
        }
      }
    }

    if (value.conversation_overrides !== undefined) {
      if (!isRecord(value.conversation_overrides)) errors.push("conversation_overrides 必须是对象。");
      else for (const [conversationKey, override] of Object.entries(value.conversation_overrides)) {
        if (!SOURCE_HASH.test(conversationKey)) errors.push(`conversation_overrides 的键必须是稳定会话 SHA-256：${conversationKey}`);
        if (!isRecord(override)) {
          errors.push(`conversation_overrides.${conversationKey} 必须是对象。`);
          continue;
        }
        const overrideKeys = value.version === LEGACY_VERSION
          ? LEGACY_CONVERSATION_OVERRIDE_KEYS
          : value.version === VERSION_011
            ? VERSION_011_CONVERSATION_OVERRIDE_KEYS
            : value.version === VERSION_012
              ? PREVIOUS_CONVERSATION_OVERRIDE_KEYS
              : CONVERSATION_OVERRIDE_KEYS;
        unexpectedKeys(override, overrideKeys, `conversation_overrides.${conversationKey}`, errors);
        validateOptionalDisplayString(override.title, `conversation_overrides.${conversationKey}.title`, errors, { max: 500 });
        validateOptionalDisplayString(override.conversation_name, `conversation_overrides.${conversationKey}.conversation_name`, errors, { max: 500 });
        if (override.date !== undefined) validateDate(override.date, `conversation_overrides.${conversationKey}.date`, errors, { allowDateOnly: true });
        if (override.content_time !== undefined) {
          if (value.version === VERSION) validateContentTime(override.content_time, `conversation_overrides.${conversationKey}.content_time`, errors);
          else validateDate(override.content_time, `conversation_overrides.${conversationKey}.content_time`, errors);
        }
        validateOptionalDisplayString(override.provider, `conversation_overrides.${conversationKey}.provider`, errors, { max: 100 });
        validateOptionalDisplayString(override.platform, `conversation_overrides.${conversationKey}.platform`, errors, { max: 100 });
        validateOptionalDisplayString(override.user_name, `conversation_overrides.${conversationKey}.user_name`, errors, { max: 100 });
        validateOptionalDisplayString(override.assistant_name, `conversation_overrides.${conversationKey}.assistant_name`, errors, { max: 100 });
        if (override.models !== undefined) validateModels(override.models, `conversation_overrides.${conversationKey}.models`, errors);
        if (!Object.keys(override).length) errors.push(`conversation_overrides.${conversationKey} 不能为空对象。`);
      }
    }
    return { valid: errors.length === 0, errors: errors.slice(0, 100) };
  }

  function assertLibrary(value) {
    const result = validateLibrary(value);
    if (!result.valid) {
      const error = new Error(result.errors.join("\n"));
      error.name = "CloudigLibraryValidationError";
      error.validationErrors = result.errors;
      throw error;
    }
    return value;
  }

  function optionalString(value) {
    const text = cleanString(value);
    return text || undefined;
  }

  function normalizeModels(models) {
    if (!Array.isArray(models)) return undefined;
    const values = [...new Set(models.map(cleanString).filter(Boolean))];
    return values.length ? values : undefined;
  }

  function normalizeContentTimeEndpoint(value) {
    if (!isRecord(value) || !CONTENT_TIME_TYPES.has(cleanString(value.type))) return undefined;
    const type = cleanString(value.type);
    if (type === "unknown") return { type };
    const endpoint = { type };
    if (value.era === "BC") endpoint.era = "BC";
    endpoint.year = Number(value.year);
    if (["month", "exact"].includes(type)) endpoint.month = Number(value.month);
    if (type === "exact") {
      endpoint.day = Number(value.day);
      if (value.hour !== undefined && value.minute !== undefined) {
        endpoint.hour = Number(value.hour);
        endpoint.minute = Number(value.minute);
      }
      const timezone = cleanString(value.timezone);
      if (timezone) endpoint.timezone = timezone;
    }
    return endpoint;
  }

  function contentTimeFromLegacy(value) {
    const text = cleanString(value);
    if (!text) return undefined;
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/u);
    if (!match) return undefined;
    const endpoint = {
      type: "exact",
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    };
    if (match[4] !== undefined && match[5] !== undefined) {
      endpoint.hour = Number(match[4]);
      endpoint.minute = Number(match[5]);
    }
    if (match[6]) endpoint.timezone = match[6];
    return { start: endpoint };
  }

  function normalizeContentTime(value) {
    if (typeof value === "string") return contentTimeFromLegacy(value);
    if (!isRecord(value)) return undefined;
    const start = normalizeContentTimeEndpoint(value.start);
    if (!start) return undefined;
    const result = { start };
    const end = normalizeContentTimeEndpoint(value.end);
    if (end && JSON.stringify(end) !== JSON.stringify(start)) result.end = end;
    return result;
  }

  function contentTimeSortKey(value) {
    const normalized = normalizeContentTime(value);
    const endpoint = normalized?.start;
    if (!endpoint || endpoint.type === "unknown") return null;
    const signedYear = (endpoint.era === "BC" ? -1 : 1) * endpoint.year;
    const month = ["month", "exact"].includes(endpoint.type) ? endpoint.month : 1;
    const day = endpoint.type === "exact" ? endpoint.day : 1;
    const hour = endpoint.type === "exact" ? endpoint.hour || 0 : 0;
    const minute = endpoint.type === "exact" ? endpoint.minute || 0 : 0;
    let key = ((((signedYear * 13) + month) * 32 + day) * 24 + hour) * 60 + minute;
    const timezone = endpoint.type === "exact" ? cleanString(endpoint.timezone) : "";
    if (timezone && timezone !== "Z") {
      const [, sign, hours, minutes] = timezone.match(/^([+-])(\d{2}):(\d{2})$/u) || [];
      if (sign) key -= (sign === "+" ? 1 : -1) * (Number(hours) * 60 + Number(minutes));
    }
    return key;
  }

  function contentTimeEndpointLabel(endpoint, language) {
    if (!endpoint || endpoint.type === "unknown") return language === "en" ? "Unknown time" : "时间未知";
    const bc = endpoint.era === "BC";
    const eraPrefix = bc ? (language === "en" ? "" : "公元前") : "";
    const eraSuffix = bc && language === "en" ? " BC" : "";
    if (endpoint.type === "decade") return language === "en"
      ? `${endpoint.year}s${eraSuffix}`
      : `${eraPrefix}${endpoint.year}年代`;
    if (endpoint.type === "year") return language === "en"
      ? `${endpoint.year}${eraSuffix}`
      : `${eraPrefix}${endpoint.year}年`;
    if (endpoint.type === "month") return language === "en"
      ? `${String(endpoint.year).padStart(4, "0")}-${String(endpoint.month).padStart(2, "0")}${eraSuffix}`
      : `${eraPrefix}${endpoint.year}年${endpoint.month}月`;
    const date = language === "en"
      ? `${String(endpoint.year).padStart(4, "0")}-${String(endpoint.month).padStart(2, "0")}-${String(endpoint.day).padStart(2, "0")}${eraSuffix}`
      : `${eraPrefix}${endpoint.year}年${endpoint.month}月${endpoint.day}日`;
    if (endpoint.hour === undefined || endpoint.minute === undefined) return date;
    const clock = `${String(endpoint.hour).padStart(2, "0")}:${String(endpoint.minute).padStart(2, "0")}`;
    const timezone = endpoint.timezone ? ` UTC${endpoint.timezone === "Z" ? "" : endpoint.timezone}` : "";
    return `${date} ${clock}${timezone}`;
  }

  function formatContentTime(value, language = "zh-CN") {
    const normalized = normalizeContentTime(value);
    if (!normalized) return "";
    const start = contentTimeEndpointLabel(normalized.start, language);
    return normalized.end ? `${start} — ${contentTimeEndpointLabel(normalized.end, language)}` : start;
  }

  function sameContentTime(left, right) {
    return JSON.stringify(normalizeContentTime(left) || null) === JSON.stringify(normalizeContentTime(right) || null);
  }

  function normalizeLibrary(value) {
    assertLibrary(value);
    const inputUserName = cleanString(value.user?.display_name);
    const inputAssistantName = cleanString(value.assistant?.display_name);
    const usesLegacyGeneratedNames = ![VERSION, PREVIOUS_VERSION].includes(value.version) && GENERATED_NAME_PAIRS.some((pair) =>
      inputUserName === pair.user && inputAssistantName === pair.assistant);
    const output = {
      format: FORMAT,
      version: VERSION
    };
    const user = {};
    if (!usesLegacyGeneratedNames && inputUserName) user.display_name = inputUserName;
    if (optionalString(value.user?.avatar)) user.avatar = cleanString(value.user.avatar);
    if (Object.keys(user).length) output.user = user;
    if (value.assistant) {
      const assistant = {};
      if (!usesLegacyGeneratedNames && inputAssistantName) assistant.display_name = inputAssistantName;
      if (optionalString(value.assistant.avatar)) assistant.avatar = cleanString(value.assistant.avatar);
      if (value.assistant.apply_to_all === true) assistant.apply_to_all = true;
      if (Object.keys(assistant).length) output.assistant = assistant;
    }
    if (value.project) {
      const project = {};
      for (const key of ["title", "description", "icon"]) if (optionalString(value.project[key])) project[key] = cleanString(value.project[key]);
      if (value.project.cover) {
        const cover = {};
        if (optionalString(value.project.cover.path)) cover.path = cleanString(value.project.cover.path);
        if (value.project.cover.fit !== undefined) cover.fit = value.project.cover.fit;
        if (Object.keys(cover).length) project.cover = cover;
      }
      if (Object.keys(project).length) output.project = project;
    }
    if (value.preferences) {
      const preferences = {};
      if (value.preferences.language !== undefined) preferences.language = value.preferences.language;
      if (value.preferences.theme !== undefined) preferences.theme = value.preferences.theme;
      if (value.preferences.name_rule_ack_version !== undefined) {
        preferences.name_rule_ack_version = value.preferences.name_rule_ack_version;
      }
      if (Object.keys(preferences).length) output.preferences = preferences;
    }
    if (value.platform_overrides) {
      const platformOverrides = {};
      for (const platform of Object.keys(value.platform_overrides).sort((left, right) => left.localeCompare(right, "en"))) {
        const input = value.platform_overrides[platform];
        const override = {};
        if (optionalString(input.icon)) override.icon = cleanString(input.icon);
        if (optionalString(input.assistant_name)) override.assistant_name = cleanString(input.assistant_name);
        if (optionalString(input.assistant_avatar)) override.assistant_avatar = cleanString(input.assistant_avatar);
        if (Object.keys(override).length) platformOverrides[platform] = override;
      }
      if (Object.keys(platformOverrides).length) output.platform_overrides = platformOverrides;
    }
    if (value.conversation_overrides) {
      const conversationOverrides = {};
      for (const conversationKey of Object.keys(value.conversation_overrides).sort((left, right) => left.localeCompare(right, "en"))) {
        const input = value.conversation_overrides[conversationKey];
        const override = {};
        const conversationName = optionalString(input.conversation_name ?? input.title);
        if (conversationName) override.conversation_name = conversationName;
        for (const key of ["provider", "platform", "user_name", "assistant_name"]) {
          if (optionalString(input[key])) override[key] = cleanString(input[key]);
        }
        const contentTime = normalizeContentTime(input.content_time ?? input.date);
        if (contentTime) override.content_time = contentTime;
        const models = normalizeModels(input.models);
        if (models) override.models = models;
        if (Object.keys(override).length) conversationOverrides[conversationKey] = override;
      }
      if (Object.keys(conversationOverrides).length) output.conversation_overrides = conversationOverrides;
    }
    return output;
  }

  function serializeLibrary(value) {
    return `${JSON.stringify(normalizeLibrary(value), null, 2)}\n`;
  }

  function createDefaultLibrary({ userName, assistantName, language = "zh-CN" } = {}) {
    const library = {
      format: FORMAT,
      version: VERSION,
      preferences: { language, theme: "platform" }
    };
    const normalizedUserName = optionalString(userName);
    const normalizedAssistantName = optionalString(assistantName);
    if (normalizedUserName) library.user = { display_name: normalizedUserName };
    if (normalizedAssistantName) library.assistant = { display_name: normalizedAssistantName };
    return normalizeLibrary(library);
  }

  function conversationKey(documentData) {
    const currentConversationKey = cleanString(documentData?.conversation_key).toLowerCase();
    if (SOURCE_HASH.test(currentConversationKey)) return currentConversationKey;
    const conversationId = cleanString(documentData?.conversation_id).toLowerCase();
    if (SOURCE_HASH.test(conversationId)) return conversationId;
    const sourceSha256 = cleanString(documentData?.source_sha256).toLowerCase();
    return SOURCE_HASH.test(sourceSha256) ? sourceSha256 : "";
  }

  function conversationOverride(library, documentData) {
    const key = conversationKey(documentData);
    if (!key || !library) return null;
    return normalizeLibrary(library).conversation_overrides?.[key] || null;
  }

  function applyConversationOverlay(documentData, library) {
    const override = conversationOverride(library, documentData);
    if (!override) return documentData;
    const result = { ...documentData };
    if (cleanString(override.conversation_name)) result.title = cleanString(override.conversation_name);
    if (override.content_time) result.content_time = cloneJson(override.content_time);
    if (cleanString(override.provider)) result.provider = cleanString(override.provider);
    if (cleanString(override.platform)) result.platform = cleanString(override.platform);
    if (Array.isArray(override.models) && override.models.length) result.models = [...override.models];
    return result;
  }

  function setConversationOverride(library, conversationKeyValue, patch) {
    const normalizedLibrary = normalizeLibrary(library);
    const key = cleanString(conversationKeyValue).toLowerCase();
    if (!SOURCE_HASH.test(key)) throw new TypeError("Conversation override key must be a stable SHA-256 identity");
    if (!isRecord(patch)) throw new TypeError("Conversation override patch must be an object");
    for (const field of Object.keys(patch)) {
      if (!CONVERSATION_PATCH_KEYS.has(field)) throw new TypeError(`Unsupported conversation override field: ${field}`);
    }
    const current = normalizedLibrary.conversation_overrides?.[key] || {};
    const next = { ...current };
    if ("conversation_name" in patch || "title" in patch) {
      const value = optionalString(patch.conversation_name ?? patch.title);
      if (value) next.conversation_name = value;
      else delete next.conversation_name;
    }
    if ("content_time" in patch) {
      const value = normalizeContentTime(patch.content_time);
      if (value) next.content_time = value;
      else delete next.content_time;
    }
    for (const field of ["provider", "platform", "user_name", "assistant_name"]) {
      if (!(field in patch)) continue;
      const value = optionalString(patch[field]);
      if (value) next[field] = value;
      else delete next[field];
    }
    if ("models" in patch) {
      const models = normalizeModels(patch.models);
      if (models) next.models = models;
      else delete next.models;
    }
    const result = cloneJson(normalizedLibrary);
    const overrides = { ...(result.conversation_overrides || {}) };
    if (Object.keys(next).length) overrides[key] = next;
    else delete overrides[key];
    if (Object.keys(overrides).length) result.conversation_overrides = overrides;
    else delete result.conversation_overrides;
    return normalizeLibrary(result);
  }

  function updateLibrarySettings(library, patch) {
    const result = cloneJson(normalizeLibrary(library));
    if (patch.user) {
      result.user = { ...(result.user || {}) };
      if ("display_name" in patch.user) {
        const displayName = optionalString(patch.user.display_name);
        if (displayName) result.user.display_name = displayName;
        else delete result.user.display_name;
      }
      if ("avatar" in patch.user) {
        const avatar = optionalString(patch.user.avatar);
        if (avatar) result.user.avatar = avatar;
        else delete result.user.avatar;
      }
      if (!Object.keys(result.user).length) delete result.user;
    }
    if (patch.assistant) {
      result.assistant = { ...(result.assistant || {}) };
      if ("display_name" in patch.assistant) {
        const displayName = optionalString(patch.assistant.display_name);
        if (displayName) result.assistant.display_name = displayName;
        else delete result.assistant.display_name;
      }
      if ("avatar" in patch.assistant) {
        const avatar = optionalString(patch.assistant.avatar);
        if (avatar) result.assistant.avatar = avatar;
        else delete result.assistant.avatar;
      }
      if ("apply_to_all" in patch.assistant) {
        if (patch.assistant.apply_to_all === true) result.assistant.apply_to_all = true;
        else delete result.assistant.apply_to_all;
      }
      if (!Object.keys(result.assistant).length) delete result.assistant;
    }
    if (patch.preferences) result.preferences = { ...(result.preferences || {}), ...patch.preferences };
    if (patch.project) result.project = { ...(result.project || {}), ...patch.project };
    return normalizeLibrary(result);
  }

  function setPlatformOverride(library, platformValue, patch) {
    const normalizedLibrary = normalizeLibrary(library);
    const platform = cleanString(platformValue).toLowerCase();
    if (!SLUG.test(platform)) throw new TypeError("Platform override key must be a lowercase slug");
    if (!isRecord(patch)) throw new TypeError("Platform override patch must be an object");
    for (const key of Object.keys(patch)) {
      if (!PLATFORM_OVERRIDE_KEYS.has(key)) throw new TypeError(`Unsupported platform override field: ${key}`);
    }
    const current = normalizedLibrary.platform_overrides?.[platform] || {};
    const next = { ...current };
    for (const field of ["icon", "assistant_name", "assistant_avatar"]) {
      if (!(field in patch)) continue;
      const value = optionalString(patch[field]);
      if (value) next[field] = value;
      else delete next[field];
    }
    const result = cloneJson(normalizedLibrary);
    const overrides = { ...(result.platform_overrides || {}) };
    if (Object.keys(next).length) overrides[platform] = next;
    else delete overrides[platform];
    if (Object.keys(overrides).length) result.platform_overrides = overrides;
    else delete result.platform_overrides;
    return normalizeLibrary(result);
  }

  function resetGlobalIdentityNames(library) {
    return updateLibrarySettings(library, {
      user: { display_name: "" },
      assistant: { display_name: "" }
    });
  }

  function resetPlatformIdentityNames(library, platformValue = "") {
    const platform = cleanString(platformValue).toLowerCase();
    if (platform) return setPlatformOverride(library, platform, { assistant_name: "" });
    const result = cloneJson(normalizeLibrary(library));
    const overrides = {};
    for (const [key, value] of Object.entries(result.platform_overrides || {})) {
      const next = { ...value };
      delete next.assistant_name;
      if (Object.keys(next).length) overrides[key] = next;
    }
    if (Object.keys(overrides).length) result.platform_overrides = overrides;
    else delete result.platform_overrides;
    return normalizeLibrary(result);
  }

  function resetConversationIdentityNames(library, conversationKeyValue) {
    return setConversationOverride(library, conversationKeyValue, {
      user_name: "",
      assistant_name: ""
    });
  }

  function defaultDisplayNames(language = "zh-CN") {
    return DEFAULT_DISPLAY_NAMES[LANGUAGES.has(language) ? language : "zh-CN"];
  }

  function resolveConversationIdentity(documentData, library, options = {}) {
    const normalizedLibrary = library
      ? normalizeLibrary(library)
      : createDefaultLibrary({ language: LANGUAGES.has(options.language) ? options.language : "zh-CN" });
    const language = LANGUAGES.has(options.language)
      ? options.language
      : LANGUAGES.has(normalizedLibrary.preferences?.language)
        ? normalizedLibrary.preferences.language
        : "zh-CN";
    const defaults = defaultDisplayNames(language);
    const key = conversationKey(documentData);
    const conversation = key ? normalizedLibrary.conversation_overrides?.[key] || {} : {};
    const platform = cleanString(conversation.platform || documentData?.platform).toLowerCase();
    const platformOverride = normalizedLibrary.platform_overrides?.[platform] || {};
    const platformNames = isRecord(options.platformNames) ? options.platformNames : {};
    const platformAvatars = isRecord(options.platformAvatars) ? options.platformAvatars : {};
    const builtInPlatformName = cleanString(platformNames[platform]) || PLATFORM_DISPLAY_NAMES[platform] || "";
    const builtInPlatformAvatar = cleanString(platformAvatars[platform]);
    const globalUserName = cleanString(normalizedLibrary.user?.display_name);
    const globalUserAvatar = cleanString(normalizedLibrary.user?.avatar);
    const globalAssistantName = cleanString(normalizedLibrary.assistant?.display_name);
    const globalAssistantAvatar = cleanString(normalizedLibrary.assistant?.avatar);
    const applyToAll = normalizedLibrary.assistant?.apply_to_all === true;
    const assistantName = cleanString(conversation.assistant_name) || (
      applyToAll
        ? globalAssistantName || defaults.assistant
        : cleanString(platformOverride.assistant_name)
          || globalAssistantName
          || builtInPlatformName
          || defaults.assistant
    );
    const assistantAvatar = applyToAll
      ? globalAssistantAvatar || cleanString(options.defaultAssistantAvatar)
      : cleanString(platformOverride.assistant_avatar)
        || globalAssistantAvatar
        || builtInPlatformAvatar
        || cleanString(options.defaultAssistantAvatar);
    return Object.freeze({
      platform,
      apply_to_all: applyToAll,
      user: Object.freeze({
        display_name: cleanString(conversation.user_name) || globalUserName || defaults.user,
        avatar: globalUserAvatar || cleanString(options.defaultUserAvatar)
      }),
      assistant: Object.freeze({
        display_name: assistantName,
        avatar: assistantAvatar
      })
    });
  }

  return Object.freeze({
    FORMAT, VERSION, PREVIOUS_VERSION, VERSION_012, VERSION_011, LEGACY_VERSION, SUPPORTED_VERSIONS, FILE_NAME,
    DEFAULT_DISPLAY_NAMES, PLATFORM_DISPLAY_NAMES,
    isRecord, cleanString, validateLibrary, assertLibrary, normalizeLibrary, serializeLibrary,
    normalizeContentTime, contentTimeSortKey, formatContentTime, sameContentTime,
    createDefaultLibrary, conversationKey, conversationOverride, applyConversationOverlay,
    setConversationOverride, updateLibrarySettings, setPlatformOverride,
    resetGlobalIdentityNames, resetPlatformIdentityNames, resetConversationIdentityNames,
    defaultDisplayNames, resolveConversationIdentity
  });
}));
