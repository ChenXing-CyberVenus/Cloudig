(function initCloudigTimeCore(root, factory) {
  "use strict";
  const limits = typeof module === "object" && module?.exports
    ? require("./limits-1.0.0.json")
    : root.CloudigTimeLimits;
  const api = factory(limits);
  root.CloudigTimeCore = api;
  if (typeof module === "object" && module?.exports) module.exports = api;
}(typeof globalThis === "object" ? globalThis : this, function createCloudigTimeCore(defaultLimits) {
  "use strict";

  const FORMAT = "cloudig/content-time";
  const VERSION = "1.0.0";
  const TIME_SYSTEM_FORMAT = "cloudig/content-time-system";
  const TIME_SYSTEM_VERSION = "1.0.0";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
  const ENDPOINT_KINDS = new Set([
    "terran_exact", "terran_year_month", "terran_decade", "terran_century",
    "terran_relative", "terran_now", "infinite_past", "infinite_future",
    "unknown", "whenever", "sovereign"
  ]);
  const SPECIAL_KINDS = new Set(["unknown", "whenever"]);
  const TERRAN_KINDS = new Set([...ENDPOINT_KINDS].filter((kind) => kind !== "sovereign" && !SPECIAL_KINDS.has(kind)));
  const DOMAIN_RANK = Object.freeze({
    terran_ordered: 0,
    special_independent: 1,
    sovereign_unmapped: 2,
    unset_or_invalid: 3
  });

  class CloudigTimeError extends TypeError {
    constructor(code, path, message, details = undefined) {
      super(message);
      this.name = "CloudigTimeError";
      this.code = code;
      this.path = path;
      if (details !== undefined) this.details = details;
    }
  }

  function issue(code, path, message, details) {
    throw new CloudigTimeError(code, path, message, details);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function assertRecord(value, path) {
    if (!isRecord(value)) issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be an object`);
    return value;
  }

  function assertKeys(value, allowed, path) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.${key}`, `Unknown field ${key}`);
    }
  }

  function integer(value, minimum, maximum, path) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
  }

  function nonEmptyString(value, path) {
    if (typeof value !== "string" || !value.trim()) issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be a non-empty string`);
    return value.trim().normalize("NFC");
  }

  function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => [key, stableObject(value[key])]));
  }

  function stableString(value) {
    return JSON.stringify(stableObject(value));
  }

  function floorDiv(value, divisor) {
    const a = BigInt(value);
    const b = BigInt(divisor);
    if (b === 0n) throw new RangeError("divisor must not be zero");
    let quotient = a / b;
    const remainder = a % b;
    if (remainder !== 0n && ((remainder > 0n) !== (b > 0n))) quotient -= 1n;
    return quotient;
  }

  function floorMod(value, divisor) {
    const a = BigInt(value);
    const b = BigInt(divisor);
    const result = a - floorDiv(a, b) * b;
    return result;
  }

  function power10(digits) {
    return 10n ** BigInt(digits);
  }

  function validateLimits(limits) {
    if (!isRecord(limits) || limits.format !== "cloudig/time-limits" || limits.version !== VERSION) {
      throw new TypeError("Cloudig time limits 1.0.0 are required before loading the time core");
    }
    if (!Array.isArray(limits.terran?.relative_units) || limits.terran.relative_units.length !== 10) {
      throw new TypeError("Cloudig time limits must define the ten Terran relative units");
    }
    const ids = new Set();
    for (const unit of limits.terran.relative_units) {
      if (!isRecord(unit) || typeof unit.id !== "string" || ids.has(unit.id) || !Number.isInteger(unit.power10)) {
        throw new TypeError("Cloudig relative-unit table is invalid");
      }
      ids.add(unit.id);
    }
    return limits;
  }

  const LIMITS = validateLimits(defaultLimits);
  const UNIT_BY_ID = new Map(LIMITS.terran.relative_units.map((unit) => [unit.id, Object.freeze({ ...unit })]));
  const AD_YEAR_MAX = Number(power10(LIMITS.terran.ad_year_max_digits) - 1n);
  const AD_DECADE_MAX = Number(power10(LIMITS.terran.decade_ad_max_digits) - 1n);
  const AD_CENTURY_MAX = Number(power10(LIMITS.terran.century_ad_max_digits) - 1n);

  function astronomicalYear(era, year) {
    return era === "BC" ? 1n - BigInt(year) : BigInt(year);
  }

  function isLeapAstronomicalYear(year) {
    const value = BigInt(year);
    return floorMod(value, 4n) === 0n && (floorMod(value, 100n) !== 0n || floorMod(value, 400n) === 0n);
  }

  function isLeapYear(era, year) {
    return isLeapAstronomicalYear(astronomicalYear(era, year));
  }

  function daysInMonth(era, year, month) {
    if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
    if ([4, 6, 9, 11].includes(month)) return 30;
    if (month === 2) return isLeapYear(era, year) ? 29 : 28;
    return 0;
  }

  function daysFromCivil(year, month, day) {
    let y = BigInt(year);
    const m = BigInt(month);
    const d = BigInt(day);
    if (month <= 2) y -= 1n;
    const era = floorDiv(y, 400n);
    const yoe = y - era * 400n;
    const mp = m + (month > 2 ? -3n : 9n);
    const doy = floorDiv(153n * mp + 2n, 5n) + d - 1n;
    const doe = yoe * 365n + floorDiv(yoe, 4n) - floorDiv(yoe, 100n) + doy;
    return era * 146097n + doe;
  }

  function normalizeEra(value, path) {
    if (value !== "AD" && value !== "BC") issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be AD or BC`);
    return value;
  }

  function normalizeCalendarYear(era, value, path) {
    const maximum = era === "BC" ? LIMITS.terran.bc_year_max : AD_YEAR_MAX;
    return integer(value, 1, maximum, path);
  }

  function normalizeUtcOffset(value, path) {
    if (typeof value !== "string") issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must be an UTC offset`);
    if (value === "Z" || value === "+00:00" || value === "-00:00") return "Z";
    const match = /^([+-])(\d{2}):(\d{2})$/u.exec(value);
    if (!match) issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} must use Z or UTC±HH:MM`);
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    if (Number(match[3]) > 59 || minutes > LIMITS.terran.utc_offset_max_minutes) {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, `${path} exceeds the configured UTC offset boundary`);
    }
    return `${match[1]}${match[2]}:${match[3]}`;
  }

  function offsetMinutes(value) {
    if (!value || value === "Z") return 0;
    const match = /^([+-])(\d{2}):(\d{2})$/u.exec(value);
    const magnitude = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -magnitude : magnitude;
  }

  function normalizeAnchor(value, path) {
    const anchor = assertRecord(value, path);
    assertKeys(anchor, new Set(["date", "captured_at", "utc_offset"]), path);
    if (typeof anchor.date !== "string" || !LOCAL_DATE.test(anchor.date)) {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.date`, "Anchor date must use YYYY-MM-DD");
    }
    const [year, month, day] = anchor.date.split("-").map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth("AD", year, month)) {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.date`, "Anchor date is not a valid Gregorian date");
    }
    if (typeof anchor.captured_at !== "string" || !UTC_DATE_TIME.test(anchor.captured_at) || !Number.isFinite(Date.parse(anchor.captured_at))) {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.captured_at`, "Anchor captured_at must be an ISO date-time with offset");
    }
    return {
      date: anchor.date,
      captured_at: new Date(anchor.captured_at).toISOString(),
      utc_offset: normalizeUtcOffset(anchor.utc_offset, `${path}.utc_offset`)
    };
  }

  function normalizeCoefficient(value, path) {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== "string" || !/^\d{1,4}(?:\.\d)?$/u.test(text)) {
      issue("CLOUDIG_TIME_INVALID_DECIMAL", path, "Relative coefficient must contain at most four integer digits and one decimal digit");
    }
    const [wholeText, decimalText = "0"] = text.split(".");
    const tenths = BigInt(wholeText) * 10n + BigInt(decimalText);
    const maximumTenths = BigInt(LIMITS.terran.relative_coefficient_max.replace(".", ""));
    if (tenths <= 0n || tenths > maximumTenths) {
      issue("CLOUDIG_TIME_INVALID_DECIMAL", path, `Relative coefficient must be from 0.1 to ${LIMITS.terran.relative_coefficient_max}`);
    }
    return `${tenths / 10n}.${tenths % 10n}`;
  }

  function normalizeEndpoint(value, path = "$") {
    const endpoint = assertRecord(value, path);
    if (!ENDPOINT_KINDS.has(endpoint.kind)) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.kind`, "Unsupported content-time endpoint kind");
    const kind = endpoint.kind;
    if (["infinite_past", "infinite_future", "unknown", "whenever"].includes(kind)) {
      assertKeys(endpoint, new Set(["kind"]), path);
      return { kind };
    }
    if (kind === "terran_exact") {
      assertKeys(endpoint, new Set(["kind", "era", "year", "month", "day", "hour", "minute", "second", "utc_offset"]), path);
      const era = normalizeEra(endpoint.era, `${path}.era`);
      const year = normalizeCalendarYear(era, endpoint.year, `${path}.year`);
      const month = integer(endpoint.month, 1, 12, `${path}.month`);
      const day = integer(endpoint.day, 1, daysInMonth(era, year, month), `${path}.day`);
      const hasHour = hasOwn(endpoint, "hour");
      const hasMinute = hasOwn(endpoint, "minute");
      const hasSecond = hasOwn(endpoint, "second");
      const hasOffset = hasOwn(endpoint, "utc_offset");
      if (hasHour !== hasMinute) issue("CLOUDIG_TIME_INVALID_ENDPOINT", path, "Hour and minute must be supplied together");
      if (hasSecond && !(hasHour && hasMinute)) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.second`, "Second requires hour and minute");
      if (hasOffset && !(hasHour && hasMinute)) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.utc_offset`, "UTC offset requires hour and minute");
      const result = { kind, era, year, month, day };
      if (hasHour) {
        result.hour = integer(endpoint.hour, 0, 23, `${path}.hour`);
        result.minute = integer(endpoint.minute, 0, 59, `${path}.minute`);
      }
      if (hasSecond) result.second = integer(endpoint.second, 0, 59, `${path}.second`);
      if (hasOffset) result.utc_offset = normalizeUtcOffset(endpoint.utc_offset, `${path}.utc_offset`);
      return result;
    }
    if (kind === "terran_year_month") {
      assertKeys(endpoint, new Set(["kind", "era", "year", "month"]), path);
      const era = normalizeEra(endpoint.era, `${path}.era`);
      const result = { kind, era, year: normalizeCalendarYear(era, endpoint.year, `${path}.year`) };
      if (hasOwn(endpoint, "month")) result.month = integer(endpoint.month, 1, 12, `${path}.month`);
      return result;
    }
    if (kind === "terran_decade") {
      assertKeys(endpoint, new Set(["kind", "era", "index"]), path);
      const era = normalizeEra(endpoint.era, `${path}.era`);
      const maximum = era === "BC" ? 999 : AD_DECADE_MAX;
      return { kind, era, index: integer(endpoint.index, 1, maximum, `${path}.index`) };
    }
    if (kind === "terran_century") {
      assertKeys(endpoint, new Set(["kind", "era", "index"]), path);
      const era = normalizeEra(endpoint.era, `${path}.era`);
      const maximum = era === "BC" ? 99 : AD_CENTURY_MAX;
      return { kind, era, index: integer(endpoint.index, 1, maximum, `${path}.index`) };
    }
    if (kind === "terran_relative") {
      assertKeys(endpoint, new Set(["kind", "direction", "unit", "coefficient", "anchor"]), path);
      if (endpoint.direction !== "before" && endpoint.direction !== "after") {
        issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.direction`, "Relative direction must be before or after");
      }
      if (!UNIT_BY_ID.has(endpoint.unit)) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.unit`, "Unknown relative unit");
      return {
        kind,
        direction: endpoint.direction,
        unit: endpoint.unit,
        coefficient: normalizeCoefficient(endpoint.coefficient, `${path}.coefficient`),
        anchor: normalizeAnchor(endpoint.anchor, `${path}.anchor`)
      };
    }
    if (kind === "terran_now") {
      assertKeys(endpoint, new Set(["kind", "anchor"]), path);
      return { kind, anchor: normalizeAnchor(endpoint.anchor, `${path}.anchor`) };
    }
    assertKeys(endpoint, new Set(["kind", "binding_id", "snapshot"]), path);
    if (typeof endpoint.binding_id !== "string" || !UUID.test(endpoint.binding_id)) {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.binding_id`, "Sovereign binding_id must be a lowercase UUID");
    }
    const result = { kind, binding_id: endpoint.binding_id };
    if (hasOwn(endpoint, "snapshot")) result.snapshot = cloneJson(endpoint.snapshot);
    return result;
  }

  function materializePresetEndpoint(value, valueAnchor, path = "$") {
    const endpoint = assertRecord(value, path);
    if (endpoint.kind !== "terran_relative" && endpoint.kind !== "terran_now") {
      return normalizeEndpoint(endpoint, path);
    }
    const allowed = endpoint.kind === "terran_relative"
      ? new Set(["kind", "direction", "unit", "coefficient", "anchor_policy"])
      : new Set(["kind", "anchor_policy"]);
    assertKeys(endpoint, allowed, path);
    if (endpoint.anchor_policy !== "materialize_on_apply") {
      issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.anchor_policy`, "Preset relative and now endpoints must materialize their anchor when applied");
    }
    const { anchor_policy: _anchorPolicy, ...template } = endpoint;
    return normalizeEndpoint({ ...template, anchor: normalizeAnchor(valueAnchor, `${path}.anchor`) }, path);
  }

  function materializePresetRange(value, valueAnchor, options = {}) {
    const path = options.path || "$";
    const range = assertRecord(value, path);
    assertKeys(range, new Set(["start", "end"]), path);
    if (!hasOwn(range, "start")) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.start`, "Preset range requires a start endpoint");
    const start = materializePresetEndpoint(range.start, valueAnchor, `${path}.start`);
    const end = hasOwn(range, "end") ? materializePresetEndpoint(range.end, valueAnchor, `${path}.end`) : undefined;
    return normalizeRange({ start, ...(end ? { end } : {}) }, { path, context: options.context || {} });
  }

  function validationResult(normalizer, value, options) {
    try {
      return { valid: true, value: normalizer(value, options), errors: [] };
    } catch (error) {
      if (!(error instanceof CloudigTimeError)) throw error;
      return {
        valid: false,
        errors: [{ code: error.code, path: error.path, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }]
      };
    }
  }

  function validateEndpoint(value, options = {}) {
    return validationResult((input) => normalizeEndpoint(input, options.path || "$"), value);
  }

  function semanticEndpointKey(value, context = {}) {
    const endpoint = normalizeEndpoint(value);
    if (endpoint.kind === "sovereign" && typeof context.resolveSovereignSemantic === "function") {
      const resolved = context.resolveSovereignSemantic(endpoint);
      if (resolved !== undefined) return `sovereign:${stableString(resolved)}`;
    }
    if (endpoint.kind === "sovereign") return `sovereign-binding:${endpoint.binding_id}`;
    return stableString(endpoint);
  }

  function semanticEndpointEqual(left, right, context = {}) {
    return semanticEndpointKey(left, context) === semanticEndpointKey(right, context);
  }

  function compareText(left, right) {
    return String(left).localeCompare(String(right), "en");
  }

  function compareBigIntText(left, right) {
    const a = BigInt(left || "0");
    const b = BigInt(right || "0");
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function comparePath(left = [], right = []) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const ordinal = Number(left[index]?.ordinal || 0) - Number(right[index]?.ordinal || 0);
      if (ordinal) return ordinal < 0 ? -1 : 1;
      const link = compareText(left[index]?.link_id || "", right[index]?.link_id || "");
      if (link) return link;
    }
    return left.length - right.length;
  }

  function compareStable(left, right) {
    return compareText(stableString(left || []), stableString(right || []));
  }

  function compareRangeTie(left, right, direction = "ascending") {
    const leftTie = Array.isArray(left?.range_tie) ? left.range_tie : null;
    const rightTie = Array.isArray(right?.range_tie) ? right.range_tie : null;
    if (!leftTie && !rightTie) return 0;
    if (!leftTie) return -1;
    if (!rightTie) return 1;
    let result = Number(leftTie[0] || 0) - Number(rightTie[0] || 0);
    if (result) return result < 0 ? -1 : 1;
    result = compareSortDescriptors(leftTie[1], rightTie[1], direction);
    if (result) return result;
    result = Number(leftTie[2] || 0) - Number(rightTie[2] || 0);
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  }

  function calendarSecond(era, year, month, day, hour = 0, minute = 0, second = 0) {
    const ordinal = daysFromCivil(astronomicalYear(era, year), month, day);
    return ordinal * 86400n + BigInt(hour * 3600 + minute * 60 + second);
  }

  function floatingInterval(lower, upper) {
    const spread = BigInt(LIMITS.terran.utc_offset_max_minutes * 60);
    return { lower: lower - spread, upper: upper + spread };
  }

  function calendarInterval(endpoint) {
    if (endpoint.kind === "terran_exact") {
      const hasTime = hasOwn(endpoint, "hour");
      const start = calendarSecond(endpoint.era, endpoint.year, endpoint.month, endpoint.day, endpoint.hour || 0, endpoint.minute || 0, endpoint.second || 0);
      let end = hasTime ? start + (hasOwn(endpoint, "second") ? 0n : 59n) : start + 86399n;
      if (endpoint.utc_offset) {
        const shift = BigInt(offsetMinutes(endpoint.utc_offset) * 60);
        return { lower: start - shift, upper: end - shift, precision_rank: hasOwn(endpoint, "second") ? 6 : hasTime ? 5 : 4 };
      }
      const interval = floatingInterval(start, end);
      return { ...interval, precision_rank: hasOwn(endpoint, "second") ? 6 : hasTime ? 5 : 4 };
    }
    if (endpoint.kind === "terran_year_month") {
      const firstMonth = endpoint.month || 1;
      const lastMonth = endpoint.month || 12;
      const lower = calendarSecond(endpoint.era, endpoint.year, firstMonth, 1);
      const upper = calendarSecond(endpoint.era, endpoint.year, lastMonth, daysInMonth(endpoint.era, endpoint.year, lastMonth), 23, 59, 59);
      return { ...floatingInterval(lower, upper), precision_rank: endpoint.month ? 3 : 2 };
    }
    if (endpoint.kind === "terran_decade") {
      const earlyYear = endpoint.era === "AD" ? endpoint.index * 10 : endpoint.index * 10 + 9;
      const lateYear = endpoint.era === "AD" ? endpoint.index * 10 + 9 : endpoint.index * 10;
      const lower = calendarSecond(endpoint.era, earlyYear, 1, 1);
      const upper = calendarSecond(endpoint.era, lateYear, 12, 31, 23, 59, 59);
      return { ...floatingInterval(lower, upper), precision_rank: 1 };
    }
    if (endpoint.kind === "terran_century") {
      const earlyYear = endpoint.era === "AD" ? (endpoint.index - 1) * 100 + 1 : endpoint.index * 100;
      const lateYear = endpoint.era === "AD" ? endpoint.index * 100 : (endpoint.index - 1) * 100 + 1;
      const lower = calendarSecond(endpoint.era, earlyYear, 1, 1);
      const upper = calendarSecond(endpoint.era, lateYear, 12, 31, 23, 59, 59);
      return { ...floatingInterval(lower, upper), precision_rank: 0 };
    }
    if (endpoint.kind === "terran_now") {
      const [year, month, day] = endpoint.anchor.date.split("-").map(Number);
      return { ...floatingInterval(calendarSecond("AD", year, month, day), calendarSecond("AD", year, month, day, 23, 59, 59)), precision_rank: 4 };
    }
    return null;
  }

  function nominalRelativeYears(endpoint) {
    const unit = UNIT_BY_ID.get(endpoint.unit);
    const tenths = BigInt(endpoint.coefficient.replace(".", ""));
    return tenths * power10(unit.power10 - 1);
  }

  function sortDescriptorForEndpoint(value, context = {}) {
    const endpoint = normalizeEndpoint(value);
    if (endpoint.kind === "infinite_past") return { domain: "terran_ordered", segment: 0, lower: "0", upper: "0", precision_rank: 0, stable_tie: [endpoint.kind] };
    if (endpoint.kind === "infinite_future") return { domain: "terran_ordered", segment: 40, lower: "0", upper: "0", precision_rank: 0, stable_tie: [endpoint.kind] };
    if (endpoint.kind === "terran_relative") {
      const years = nominalRelativeYears(endpoint);
      const key = endpoint.direction === "before" ? -years : years;
      return {
        domain: "terran_ordered",
        segment: endpoint.direction === "before" ? 10 : 30,
        lower: key.toString(),
        upper: key.toString(),
        precision_rank: 0,
        stable_tie: [endpoint.kind, endpoint.unit, endpoint.coefficient]
      };
    }
    if (["terran_exact", "terran_year_month", "terran_decade", "terran_century", "terran_now"].includes(endpoint.kind)) {
      const interval = calendarInterval(endpoint);
      return {
        domain: "terran_ordered",
        segment: 20,
        lower: interval.lower.toString(),
        upper: interval.upper.toString(),
        precision_rank: interval.precision_rank,
        stable_tie: [endpoint.kind, stableString(endpoint)]
      };
    }
    if (SPECIAL_KINDS.has(endpoint.kind)) {
      return { domain: "special_independent", kind_rank: endpoint.kind === "unknown" ? 0 : 1, stable_tie: [endpoint.kind] };
    }
    if (typeof context.directTerranMappings === "function") {
      const mappings = context.directTerranMappings(endpoint) || [];
      let chosen = null;
      for (const mapping of mappings) {
        if (!mapping?.range?.start) continue;
        const descriptor = sortDescriptorForEndpoint(mapping.range.start, {});
        if (descriptor.domain !== "terran_ordered") continue;
        const candidate = { ...descriptor, stable_tie: [...(descriptor.stable_tie || []), String(mapping.mapping_id || "")] };
        if (!chosen || compareSortDescriptors(candidate, chosen, "ascending") < 0) chosen = candidate;
      }
      if (chosen) return chosen;
    }
    const order = typeof context.sovereignOrder === "function" ? context.sovereignOrder(endpoint) || {} : {};
    return {
      domain: "sovereign_unmapped",
      timeline_order: Number.isFinite(order.timeline_order) ? order.timeline_order : Number.MAX_SAFE_INTEGER,
      ordinal_path: Array.isArray(order.ordinal_path) ? cloneJson(order.ordinal_path) : [],
      occurrence_first: Number.isInteger(order.occurrence_first) ? order.occurrence_first : 1,
      occurrence_last: Number.isInteger(order.occurrence_last) ? order.occurrence_last : 1,
      edited_at_desc: String(order.edited_at || ""),
      node_id: String(order.node_id || endpoint.binding_id),
      stable_tie: [endpoint.binding_id]
    };
  }

  function applyDirection(result, direction) {
    return direction === "descending" ? -result : result;
  }

  function compareWithinDomain(left, right, direction) {
    if (left.domain === "terran_ordered") {
      let result = Number(left.segment || 0) - Number(right.segment || 0);
      if (result) return applyDirection(result < 0 ? -1 : 1, direction);
      result = compareBigIntText(left.lower, right.lower);
      if (result) return applyDirection(result, direction);
      result = compareBigIntText(left.upper, right.upper);
      if (result) return applyDirection(result, direction);
      result = compareRangeTie(left, right, direction);
      if (result) return result;
      result = Number(left.precision_rank || 0) - Number(right.precision_rank || 0);
      return result || compareStable(left.stable_tie, right.stable_tie);
    }
    if (left.domain === "sovereign_unmapped") {
      let result = Number(left.timeline_order) - Number(right.timeline_order);
      if (result) return applyDirection(result < 0 ? -1 : 1, direction);
      result = comparePath(left.ordinal_path, right.ordinal_path);
      if (result) return applyDirection(result, direction);
      result = Number(left.occurrence_first) - Number(right.occurrence_first);
      if (result) return applyDirection(result < 0 ? -1 : 1, direction);
      result = Number(left.occurrence_last) - Number(right.occurrence_last);
      if (result) return applyDirection(result < 0 ? -1 : 1, direction);
      result = compareRangeTie(left, right, direction);
      if (result) return result;
      result = compareText(right.edited_at_desc || "", left.edited_at_desc || "");
      return result || compareText(left.node_id || "", right.node_id || "") || compareStable(left.stable_tie, right.stable_tie);
    }
    if (left.domain === "special_independent") {
      return Number(left.kind_rank || 0) - Number(right.kind_rank || 0) || compareStable(left.stable_tie, right.stable_tie);
    }
    return compareStable(left.stable_tie, right.stable_tie);
  }

  function compareSortDescriptors(left, right, direction = "ascending") {
    if (direction !== "ascending" && direction !== "descending") throw new TypeError("direction must be ascending or descending");
    const leftRank = DOMAIN_RANK[left?.domain] ?? DOMAIN_RANK.unset_or_invalid;
    const rightRank = DOMAIN_RANK[right?.domain] ?? DOMAIN_RANK.unset_or_invalid;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return compareWithinDomain(left, right, direction);
  }

  function sovereignPosition(value, context) {
    return typeof context.sovereignPosition === "function" ? context.sovereignPosition(value) : null;
  }

  function compareForReversal(startValue, endValue, context = {}) {
    const start = normalizeEndpoint(startValue, "$.start");
    const end = normalizeEndpoint(endValue, "$.end");
    if (semanticEndpointEqual(start, end, context)) return "equal";
    if (SPECIAL_KINDS.has(start.kind) || SPECIAL_KINDS.has(end.kind)) return "indeterminate";
    const startSovereign = start.kind === "sovereign";
    const endSovereign = end.kind === "sovereign";
    if (startSovereign !== endSovereign) return "indeterminate";
    if (startSovereign) {
      const left = sovereignPosition(start, context);
      const right = sovereignPosition(end, context);
      if (!left || !right || left.variant_key !== right.variant_key) return "indeterminate";
      const leftLow = Array.isArray(left.lower_path) ? left.lower_path : left.path;
      const leftHigh = Array.isArray(left.upper_path) ? left.upper_path : left.path;
      const rightLow = Array.isArray(right.lower_path) ? right.lower_path : right.path;
      const rightHigh = Array.isArray(right.upper_path) ? right.upper_path : right.path;
      if (![leftLow, leftHigh, rightLow, rightHigh].every(Array.isArray)) return "indeterminate";
      if (comparePath(leftLow, rightHigh) > 0) return "reversed";
      if (comparePath(leftHigh, rightLow) < 0) return "forward";
      return "indeterminate";
    }
    const left = sortDescriptorForEndpoint(start, context);
    const right = sortDescriptorForEndpoint(end, context);
    if (left.domain !== "terran_ordered" || right.domain !== "terran_ordered") return "indeterminate";
    if (left.segment !== right.segment) return left.segment > right.segment ? "reversed" : "forward";
    if (compareBigIntText(left.lower, right.upper) > 0) return "reversed";
    if (compareBigIntText(left.upper, right.lower) < 0) return "forward";
    return "indeterminate";
  }

  function normalizeRange(value, options = {}) {
    const path = options.path || "$";
    const range = assertRecord(value, path);
    assertKeys(range, new Set(["start", "end", "is_collapsed", "is_reversed"]), path);
    if (!hasOwn(range, "start")) issue("CLOUDIG_TIME_INVALID_ENDPOINT", `${path}.start`, "Content-time range requires a start endpoint");
    const start = normalizeEndpoint(range.start, `${path}.start`);
    let end = hasOwn(range, "end") ? normalizeEndpoint(range.end, `${path}.end`) : undefined;
    if (end && semanticEndpointEqual(start, end, options.context || {})) end = undefined;
    const relation = end ? compareForReversal(start, end, options.context || {}) : "equal";
    return {
      start,
      ...(end ? { end } : {}),
      is_collapsed: !end,
      is_reversed: relation === "reversed"
    };
  }

  function validateRange(value, options = {}) {
    const result = validationResult((input) => normalizeRange(input, options), value);
    if (!result.valid) return result;
    const errors = [];
    if (options.require_flags) {
      if (typeof value?.is_collapsed !== "boolean") errors.push({ code: "CLOUDIG_TIME_INVALID_ENDPOINT", path: "$.is_collapsed", message: "Stored range requires is_collapsed" });
      if (typeof value?.is_reversed !== "boolean") errors.push({ code: "CLOUDIG_TIME_INVALID_ENDPOINT", path: "$.is_reversed", message: "Stored range requires is_reversed" });
    }
    if (typeof value?.is_collapsed === "boolean" && value.is_collapsed !== result.value.is_collapsed) {
      errors.push({ code: "CLOUDIG_TIME_INVALID_ENDPOINT", path: "$.is_collapsed", message: "is_collapsed does not match the normalized range" });
    }
    if (typeof value?.is_reversed === "boolean" && value.is_reversed !== result.value.is_reversed) {
      errors.push({ code: "CLOUDIG_TIME_INVALID_ENDPOINT", path: "$.is_reversed", message: "is_reversed does not match the normalized range" });
    }
    return errors.length ? { valid: false, errors } : result;
  }

  function recomputeRangeFlags(value, context = {}) {
    return normalizeRange(value, { context });
  }

  function semanticRangeEqual(left, right, context = {}) {
    return stableString(normalizeRange(left, { context })) === stableString(normalizeRange(right, { context }));
  }

  function sortDescriptorForRange(value, context = {}) {
    const normalized = normalizeRange(value, { context });
    const start = sortDescriptorForEndpoint(normalized.start, context);
    const end = normalized.end ? sortDescriptorForEndpoint(normalized.end, context) : start;
    return {
      ...start,
      range_tie: [
        normalized.is_collapsed ? 0 : 1,
        end,
        normalized.is_reversed ? 1 : 0
      ]
    };
  }

  function pad(value, size) {
    return String(value).padStart(size, "0");
  }

  function formatEndpoint(value, options = {}) {
    const endpoint = normalizeEndpoint(value);
    const locale = options.locale === "en" ? "en" : "zh-CN";
    const bc = endpoint.era === "BC" ? (locale === "en" ? " BC" : " BC") : "";
    if (endpoint.kind === "terran_exact") {
      let label = `${endpoint.year <= 9999 ? pad(endpoint.year, 4) : endpoint.year}-${pad(endpoint.month, 2)}-${pad(endpoint.day, 2)}`;
      if (hasOwn(endpoint, "hour")) {
        label += ` ${pad(endpoint.hour, 2)}:${pad(endpoint.minute, 2)}`;
        if (hasOwn(endpoint, "second")) label += `:${pad(endpoint.second, 2)}`;
        if (endpoint.utc_offset) label += ` ${endpoint.utc_offset === "Z" ? "UTC" : `UTC${endpoint.utc_offset}`}`;
      }
      return `${label}${bc}`;
    }
    if (endpoint.kind === "terran_year_month") {
      if (locale === "en") return `${endpoint.year}${endpoint.month ? `-${pad(endpoint.month, 2)}` : ""}${bc}`;
      return `${endpoint.year}年${endpoint.month ? `${endpoint.month}月` : ""}${bc}`;
    }
    if (endpoint.kind === "terran_decade") return `${endpoint.index * 10}s${bc}`;
    if (endpoint.kind === "terran_century") return locale === "en" ? `${endpoint.index}${ordinalSuffix(endpoint.index)} century${bc}` : `${endpoint.index}世纪${bc}`;
    if (endpoint.kind === "terran_relative") {
      const unit = UNIT_BY_ID.get(endpoint.unit);
      if (locale === "en") return `${endpoint.coefficient} ${unit.en} years ${endpoint.direction}`;
      return `${endpoint.coefficient}${unit.zh}年前${endpoint.direction === "after" ? "后" : ""}`.replace("年前后", "年后");
    }
    if (endpoint.kind === "terran_now") return locale === "en" ? `Now (${endpoint.anchor.date})` : `现今（${endpoint.anchor.date}）`;
    const labels = locale === "en"
      ? { infinite_past: "Infinite past", infinite_future: "Infinite future", unknown: "Unknown time", whenever: "Whenever" }
      : { infinite_past: "无限久前", infinite_future: "无限久后", unknown: "不知何时", whenever: "无论何时" };
    if (labels[endpoint.kind]) return labels[endpoint.kind];
    if (typeof options.sovereignLabel === "function") {
      const label = options.sovereignLabel(endpoint);
      if (label) return String(label);
    }
    return endpoint.snapshot?.payload?.node?.name || endpoint.snapshot?.payload?.timeline?.name || endpoint.binding_id;
  }

  function ordinalSuffix(value) {
    const mod100 = value % 100;
    if (mod100 >= 11 && mod100 <= 13) return "th";
    return value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  }

  function formatRange(value, options = {}) {
    const range = normalizeRange(value, { context: options.context || {} });
    const start = formatEndpoint(range.start, options);
    return range.end ? `${start} — ${formatEndpoint(range.end, options)}` : start;
  }

  function normalizePeriodSelector(value, periodCount, options = {}) {
    const path = options.path || "$";
    const count = integer(periodCount, 1, LIMITS.sovereign.period_count_max, `${path}.period_count`);
    const selector = assertRecord(value, path);
    if (selector.mode === "all") {
      assertKeys(selector, new Set(["mode"]), path);
      return { mode: "all" };
    }
    if (selector.mode === "prefix") {
      assertKeys(selector, new Set(["mode", "count"]), path);
      return { mode: "prefix", count: integer(selector.count, 1, count, `${path}.count`) };
    }
    if (selector.mode !== "progression") issue("CLOUDIG_TIME_INVALID_PERIOD_SELECTOR", `${path}.mode`, "Period selector mode must be all, prefix or progression");
    assertKeys(selector, new Set(["mode", "first", "step", "last"]), path);
    const first = integer(selector.first, 1, count, `${path}.first`);
    const step = integer(selector.step, 1, count, `${path}.step`);
    const last = integer(selector.last, first, count, `${path}.last`);
    if ((last - first) % step !== 0) issue("CLOUDIG_TIME_INVALID_PERIOD_SELECTOR", path, "Period progression last must land on first + N × step");
    return { mode: "progression", first, step, last };
  }

  function selectorAsProgression(value, periodCount) {
    const selector = normalizePeriodSelector(value, periodCount);
    if (selector.mode === "all") return { first: 1n, step: 1n, last: BigInt(periodCount) };
    if (selector.mode === "prefix") return { first: 1n, step: 1n, last: BigInt(selector.count) };
    return { first: BigInt(selector.first), step: BigInt(selector.step), last: BigInt(selector.last) };
  }

  function gcd(left, right) {
    let a = left < 0n ? -left : left;
    let b = right < 0n ? -right : right;
    while (b) [a, b] = [b, a % b];
    return a;
  }

  function extendedGcd(a, b) {
    if (b === 0n) return { g: a, x: 1n, y: 0n };
    const next = extendedGcd(b, a % b);
    return { g: next.g, x: next.y, y: next.x - (a / b) * next.y };
  }

  function ceilDiv(value, divisor) {
    return -floorDiv(-BigInt(value), BigInt(divisor));
  }

  function selectorIntersects(leftValue, rightValue, periodCount) {
    const left = selectorAsProgression(leftValue, periodCount);
    const right = selectorAsProgression(rightValue, periodCount);
    const lower = left.first > right.first ? left.first : right.first;
    const upper = left.last < right.last ? left.last : right.last;
    if (lower > upper) return false;
    const common = gcd(left.step, right.step);
    const difference = right.first - left.first;
    if (floorMod(difference, common) !== 0n) return false;
    const leftReduced = left.step / common;
    const rightReduced = right.step / common;
    const inverse = floorMod(extendedGcd(leftReduced, rightReduced).x, rightReduced);
    const offset = floorMod((difference / common) * inverse, rightReduced);
    const base = left.first + left.step * offset;
    const lcm = left.step * rightReduced;
    const candidate = base < lower ? base + ceilDiv(lower - base, lcm) * lcm : base;
    return candidate <= upper;
  }

  function canonicalSovereignPath({ root_node_id, target_node_id, containment_links }) {
    const rootId = nonEmptyString(root_node_id, "$.root_node_id");
    const targetId = nonEmptyString(target_node_id, "$.target_node_id");
    if (!Array.isArray(containment_links)) issue("CLOUDIG_TIME_GRAPH_REFERENCE_MISSING", "$.containment_links", "containment_links must be an array");
    const children = new Map();
    for (const [index, raw] of containment_links.entries()) {
      const link = assertRecord(raw, `$.containment_links[${index}]`);
      const normalized = {
        link_id: nonEmptyString(link.link_id, `$.containment_links[${index}].link_id`),
        parent_node_id: nonEmptyString(link.parent_node_id, `$.containment_links[${index}].parent_node_id`),
        child_node_id: nonEmptyString(link.child_node_id ?? link.child?.node_id, `$.containment_links[${index}].child_node_id`),
        ordinal: integer(link.ordinal, 1, LIMITS.sovereign.physical_links_max, `$.containment_links[${index}].ordinal`)
      };
      if (!children.has(normalized.parent_node_id)) children.set(normalized.parent_node_id, []);
      children.get(normalized.parent_node_id).push(normalized);
    }
    for (const links of children.values()) links.sort((a, b) => a.ordinal - b.ordinal || compareText(a.link_id, b.link_id));
    if (rootId === targetId) return { found: true, path: [], cycle_cut: false, edge_visits: 0 };
    const visited = new Set([rootId]);
    const stack = [{ node_id: rootId, path: [], links: children.get(rootId) || [], index: 0 }];
    let cycleCut = false;
    let edgeVisits = 0;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.links.length) {
        stack.pop();
        continue;
      }
      const link = frame.links[frame.index++];
      edgeVisits += 1;
      if (edgeVisits > LIMITS.sovereign.traversal_edge_visits_max) {
        issue("CLOUDIG_TIME_GRAPH_LIMIT", "$.containment_links", "Sovereign traversal exceeded the configured edge-visit limit", { edge_visits: edgeVisits });
      }
      if (visited.has(link.child_node_id)) {
        cycleCut = true;
        continue;
      }
      const path = [...frame.path, { ordinal: link.ordinal, link_id: link.link_id }];
      if (link.child_node_id === targetId) return { found: true, path, cycle_cut: cycleCut, edge_visits: edgeVisits };
      visited.add(link.child_node_id);
      stack.push({ node_id: link.child_node_id, path, links: children.get(link.child_node_id) || [], index: 0 });
    }
    return { found: false, path: [], cycle_cut: cycleCut, edge_visits: edgeVisits };
  }

  return Object.freeze({
    FORMAT,
    VERSION,
    TIME_SYSTEM_FORMAT,
    TIME_SYSTEM_VERSION,
    LIMITS,
    CloudigTimeError,
    astronomicalYear,
    isLeapYear,
    daysInMonth,
    daysFromCivil,
    normalizeEndpoint,
    materializePresetEndpoint,
    materializePresetRange,
    validateEndpoint,
    normalizeRange,
    validateRange,
    recomputeRangeFlags,
    semanticEndpointEqual,
    semanticRangeEqual,
    formatEndpoint,
    formatRange,
    sortDescriptorForEndpoint,
    sortDescriptorForRange,
    compareSortDescriptors,
    compareForReversal,
    normalizePeriodSelector,
    selectorIntersects,
    canonicalSovereignPath
  });
}));
