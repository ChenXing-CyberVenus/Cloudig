import timeLimits from "../contracts/machine/time-limits.json" with { type: "json" };
import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";

export type TerranOrderedProjection = Readonly<{
  domain: "terran_ordered";
  segment: 0 | 20 | 40;
  lower?: bigint;
  upper?: bigint;
}>;

export type IndependentProjection = Readonly<{
  domain: "special_independent";
  kind: "unknown" | "whenever";
}>;

export type TerranProjection = TerranOrderedProjection | IndependentProjection;

const SECONDS_PER_DAY = 86400n;
const FLOATING_EXPANSION_SECONDS = 14n * 3600n;
const UNIT_EXPONENT = new Map(timeLimits.relative.units.map((unit) => [unit.slug, unit.exponent]));

function requireObject(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}

export function floorDiv(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError("floorDiv divisor must be positive");
  let quotient = value / divisor;
  if (value % divisor < 0n) quotient -= 1n;
  return quotient;
}

export function floorMod(value: bigint, divisor: bigint): bigint {
  return value - floorDiv(value, divisor) * divisor;
}

export function isGregorianLeapYear(astronomicalYear: bigint): boolean {
  return floorMod(astronomicalYear, 4n) === 0n
    && (floorMod(astronomicalYear, 100n) !== 0n || floorMod(astronomicalYear, 400n) === 0n);
}

export function daysInGregorianMonth(astronomicalYear: bigint, month: number): number {
  if (month < 1 || month > 12) throw new RangeError("month must be 1 through 12");
  if (month === 2) return isGregorianLeapYear(astronomicalYear) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function astronomicalYear(era: "AD" | "BC", year: number | bigint): bigint {
  const positiveYear = typeof year === "bigint" ? year : BigInt(year);
  if (positiveYear < 1n) throw new RangeError("civil year must be positive");
  return era === "AD" ? positiveYear : 1n - positiveYear;
}

export function dayOrdinal(year: bigint, month: number, day: number): bigint {
  const adjustedYear = year - (month <= 2 ? 1n : 0n);
  const era = floorDiv(adjustedYear, 400n);
  const yearOfEra = adjustedYear - era * 400n;
  const monthPrime = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = floorDiv(153n * monthPrime + 2n, 5n) + BigInt(day) - 1n;
  const dayOfEra = yearOfEra * 365n + floorDiv(yearOfEra, 4n) - floorDiv(yearOfEra, 100n) + dayOfYear;
  return era * 146097n + dayOfEra;
}

export function civilSecond(
  year: bigint,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): bigint {
  return dayOrdinal(year, month, day) * SECONDS_PER_DAY
    + BigInt(hour) * 3600n
    + BigInt(minute) * 60n
    + BigInt(second);
}

function parseOffsetMinutes(value: string): number {
  if (value === "Z" || value === "+00:00" || value === "-00:00") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new TypeError("Invalid UTC offset");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export function normalizeRelativeValue(value: string): string {
  const match = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]))?$/u.exec(value);
  if (!match) throw new TypeError("Relative value must be an integer or one-decimal string");
  const normalized = `${match[1]}.${match[2] ?? "0"}`;
  const tenths = BigInt(match[1]!) * 10n + BigInt(match[2] ?? "0");
  if (tenths < 1n || tenths > 99990n) throw new RangeError("Relative value must be between 0.1 and 9999.0");
  return normalized;
}

export function relativeNominalYears(unit: string, value: string): bigint {
  const exponent = UNIT_EXPONENT.get(unit);
  if (exponent === undefined) throw new TypeError(`Unknown relative unit ${unit}`);
  const normalized = normalizeRelativeValue(value);
  const [whole, fraction] = normalized.split(".");
  const tenths = BigInt(whole!) * 10n + BigInt(fraction!);
  return tenths * 10n ** BigInt(exponent - 1);
}

function yearInterval(firstYear: bigint, lastYear: bigint, floating: boolean): TerranOrderedProjection {
  let lower = civilSecond(firstYear, 1, 1);
  let upper = civilSecond(lastYear, 12, 31, 23, 59, 59);
  if (floating) {
    lower -= FLOATING_EXPANSION_SECONDS;
    upper += FLOATING_EXPANSION_SECONDS;
  }
  return { domain: "terran_ordered", segment: 20, lower, upper };
}

function calendarProjection(endpoint: JsonObject): TerranOrderedProjection {
  const era = endpoint["era"];
  if (era !== "AD" && era !== "BC") throw new TypeError("Calendar era must be AD or BC");
  const year = astronomicalYear(era, requireInteger(endpoint["year"], "calendar year"));
  const month = typeof endpoint["month"] === "number" ? endpoint["month"] : undefined;
  const day = typeof endpoint["day"] === "number" ? endpoint["day"] : undefined;
  const hour = typeof endpoint["hour"] === "number" ? endpoint["hour"] : undefined;
  const minute = typeof endpoint["minute"] === "number" ? endpoint["minute"] : undefined;
  const second = typeof endpoint["second"] === "number" ? endpoint["second"] : undefined;

  let lower: bigint;
  let upper: bigint;
  if (month === undefined) {
    lower = civilSecond(year, 1, 1);
    upper = civilSecond(year, 12, 31, 23, 59, 59);
  } else if (day === undefined) {
    lower = civilSecond(year, month, 1);
    upper = civilSecond(year, month, daysInGregorianMonth(year, month), 23, 59, 59);
  } else if (hour === undefined) {
    lower = civilSecond(year, month, day);
    upper = civilSecond(year, month, day, 23, 59, 59);
  } else if (minute === undefined) {
    lower = civilSecond(year, month, day, hour);
    upper = civilSecond(year, month, day, hour, 59, 59);
  } else if (second === undefined) {
    lower = civilSecond(year, month, day, hour, minute);
    upper = civilSecond(year, month, day, hour, minute, 59);
  } else {
    lower = civilSecond(year, month, day, hour, minute, second);
    upper = lower;
  }

  const offset = endpoint["offset"];
  if (typeof offset === "string") {
    const offsetSeconds = BigInt(parseOffsetMinutes(offset)) * 60n;
    lower -= offsetSeconds;
    upper -= offsetSeconds;
  } else {
    lower -= FLOATING_EXPANSION_SECONDS;
    upper += FLOATING_EXPANSION_SECONDS;
  }
  return { domain: "terran_ordered", segment: 20, lower, upper };
}

function decadeProjection(endpoint: JsonObject): TerranOrderedProjection {
  const era = endpoint["era"];
  if (era !== "AD" && era !== "BC") throw new TypeError("Decade era must be AD or BC");
  const index = BigInt(requireInteger(endpoint["index"], "decade index"));
  if (era === "AD") return yearInterval(index * 10n, index * 10n + 9n, true);
  return yearInterval(astronomicalYear("BC", index * 10n + 9n), astronomicalYear("BC", index * 10n), true);
}

function centuryProjection(endpoint: JsonObject): TerranOrderedProjection {
  const era = endpoint["era"];
  if (era !== "AD" && era !== "BC") throw new TypeError("Century era must be AD or BC");
  const index = BigInt(requireInteger(endpoint["index"], "century index"));
  if (era === "AD") return yearInterval((index - 1n) * 100n + 1n, index * 100n, true);
  return yearInterval(astronomicalYear("BC", index * 100n), astronomicalYear("BC", (index - 1n) * 100n + 1n), true);
}

function anchorYear(anchor: JsonValue | undefined): bigint {
  const value = requireObject(anchor!, "anchor");
  const date = value["date"];
  if (typeof date !== "string") throw new TypeError("anchor.date must be a local date");
  return BigInt(date.slice(0, 4));
}

function relativeProjection(endpoint: JsonObject): TerranOrderedProjection {
  const unit = endpoint["unit"];
  const value = endpoint["value"];
  const direction = endpoint["direction"];
  if (typeof unit !== "string" || typeof value !== "string" || (direction !== "before" && direction !== "after")) {
    throw new TypeError("Invalid relative endpoint");
  }
  const exponent = UNIT_EXPONENT.get(unit);
  if (exponent === undefined) throw new TypeError(`Unknown relative unit ${unit}`);
  const nominal = relativeNominalYears(unit, value);
  const center = anchorYear(endpoint["anchor"]) + (direction === "before" ? -nominal : nominal);
  const halfGranularity = 10n ** BigInt(exponent - 1) / 2n;
  return yearInterval(center - halfGranularity, center + halfGranularity, true);
}

function nowProjection(endpoint: JsonObject): TerranOrderedProjection {
  const anchor = requireObject(endpoint["anchor"]!, "now anchor");
  const date = anchor["date"];
  if (typeof date !== "string") throw new TypeError("now anchor date must be a local date");
  const year = BigInt(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return {
    domain: "terran_ordered",
    segment: 20,
    lower: civilSecond(year, month, day) - FLOATING_EXPANSION_SECONDS,
    upper: civilSecond(year, month, day, 23, 59, 59) + FLOATING_EXPANSION_SECONDS
  };
}

export function projectTerranEndpoint(value: JsonValue): TerranProjection {
  const endpoint = requireObject(value, "Terran endpoint");
  switch (endpoint["kind"]) {
    case "calendar": return calendarProjection(endpoint);
    case "decade": return decadeProjection(endpoint);
    case "century": return centuryProjection(endpoint);
    case "relative": return relativeProjection(endpoint);
    case "now": return nowProjection(endpoint);
    case "infinite_past": return { domain: "terran_ordered", segment: 0 };
    case "infinite_future": return { domain: "terran_ordered", segment: 40 };
    case "unknown": return { domain: "special_independent", kind: "unknown" };
    case "whenever": return { domain: "special_independent", kind: "whenever" };
    default: throw new TypeError(`Unsupported Terran endpoint kind ${String(endpoint["kind"])}`);
  }
}

export function compareTerranProjection(left: TerranProjection, right: TerranProjection): -1 | 0 | 1 | undefined {
  if (left.domain !== "terran_ordered" || right.domain !== "terran_ordered") return undefined;
  if (left.segment !== right.segment) return left.segment < right.segment ? -1 : 1;
  if (left.segment !== 20) return 0;
  if (left.lower! !== right.lower!) return left.lower! < right.lower! ? -1 : 1;
  if (left.upper! !== right.upper!) return left.upper! < right.upper! ? -1 : 1;
  return 0;
}
