import { canonicalizeJcs } from "./deterministic-json.mts";
import type { JsonObject, JsonValue, ValidationIssue } from "./types.mts";
import { isJsonObject } from "./types.mts";

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function nonNegativeMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function isLeapYear(astronomicalYear: number): boolean {
  return nonNegativeMod(astronomicalYear, 4) === 0
    && (nonNegativeMod(astronomicalYear, 100) !== 0 || nonNegativeMod(astronomicalYear, 400) === 0);
}

function daysInMonth(astronomicalYear: number, month: number): number {
  if (month === 2) return isLeapYear(astronomicalYear) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value)) {
    return false;
  }
  if (value.startsWith("0000-")) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateUtcTimestamp(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): void {
  if (!isValidUtcTimestamp(value)) {
    issue(issues, "CLOUDIG_TIME_INVALID_TIMESTAMP", path, "Expected a real UTC RFC3339 timestamp with milliseconds");
  }
}

function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u.exec(value);
  if (!match || match[1] === "0000") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return day <= daysInMonth(year, month);
}

function validateAnchor(value: JsonValue | undefined, path: string, issues: ValidationIssue[]): void {
  if (!isJsonObject(value)) return;
  if (!isValidLocalDate(value["date"])) {
    issue(issues, "CLOUDIG_TIME_INVALID_ANCHOR_DATE", `${path}/date`, "Anchor date is not a real AD calendar date");
  }
}

function validateCalendar(endpoint: JsonObject, path: string, issues: ValidationIssue[]): void {
  const era = endpoint["era"];
  const year = endpoint["year"];
  if (era !== "AD" && era !== "BC") return;
  if (typeof year !== "number" || !Number.isInteger(year)) return;
  const month = endpoint["month"];
  const day = endpoint["day"];
  if (typeof month === "number" && typeof day === "number") {
    const astronomicalYear = era === "AD" ? year : 1 - year;
    if (day > daysInMonth(astronomicalYear, month)) {
      issue(issues, "CLOUDIG_TIME_INVALID_CALENDAR_DATE", path, "Calendar endpoint contains a day outside its real month");
    }
  }
}

export function validateProgressionSelector(
  selector: JsonValue | undefined,
  periodCount: number,
  path: string,
  issues: ValidationIssue[]
): void {
  if (!isJsonObject(selector)) return;
  const first = selector["first"];
  const step = selector["step"];
  const last = selector["last"];
  if (typeof first !== "number" || typeof step !== "number" || typeof last !== "number") return;
  if (first > last || last > periodCount || (last - first) % step !== 0) {
    issue(
      issues,
      "CLOUDIG_TIME_INVALID_SELECTOR",
      path,
      "Progression selector must stay within the periodic target and end on its declared step"
    );
  }
}

function validateSovereign(endpoint: JsonObject, path: string, issues: ValidationIssue[]): void {
  const target = endpoint["target"];
  const snapshot = endpoint["snapshot"];
  if (isJsonObject(snapshot)) {
    validateSovereignSnapshotSemantics(snapshot, `${path}/snapshot`, issues, target, `${path}/target`);
  }
}

export function validateSovereignSnapshotSemantics(
  value: JsonValue,
  path: string,
  issues: ValidationIssue[],
  endpointTarget?: JsonValue,
  endpointTargetPath?: string
): void {
  if (!isJsonObject(value)) return;
  const targetSnapshot = value["target"];
  if (!isJsonObject(targetSnapshot)) return;
  const snapshotId = targetSnapshot["id"];
  const kind = targetSnapshot["kind"];
  const expectedPrefix = kind === "variant" ? "v" : kind === "preset" ? "p" : "t";
  if (typeof snapshotId === "string" && !snapshotId.startsWith(expectedPrefix)) {
    issue(issues, "CLOUDIG_TIME_TARGET_KIND_MISMATCH", `${path}/target/id`, "Target ID prefix does not match snapshot target kind");
  }
  const timeline = value["timeline"];
  if (isJsonObject(timeline) && kind === "variant" && timeline["variant"] !== snapshotId) {
    issue(issues, "CLOUDIG_TIME_VARIANT_SNAPSHOT_MISMATCH", `${path}/timeline/variant`, "Variant snapshot target must be its timeline variant");
  }
  const sort = value["sort"];
  if (isJsonObject(sort)) {
    validateRange(sort, `${path}/sort`, issues);
    for (const side of ["start", "end"] as const) {
      const endpoint = sort[side];
      if (isJsonObject(endpoint) && (endpoint["kind"] === "unknown" || endpoint["kind"] === "whenever")) {
        issue(issues, "CLOUDIG_TIME_SNAPSHOT_SORT_UNORDERED", `${path}/sort/${side}`, "Snapshot sort must omit unknown and whenever mappings");
      }
    }
  }

  if (!isJsonObject(endpointTarget)) return;
  const node = endpointTarget["node"];
  if (node !== snapshotId) {
    issue(issues, "CLOUDIG_TIME_SNAPSHOT_TARGET_MISMATCH", `${path}/target/id`, "Snapshot target must describe the endpoint target");
  }
  const targetPath = endpointTargetPath ?? path;
  const occurrences = endpointTarget["occurrences"];
  if (kind === "periodic") {
    const count = targetSnapshot["count"];
    if (typeof count === "number") validateProgressionSelector(occurrences, count, `${targetPath}/occurrences`, issues);
  } else if (occurrences !== undefined) {
    issue(issues, "CLOUDIG_TIME_SELECTOR_NOT_ALLOWED", `${targetPath}/occurrences`, "Only periodic targets can carry occurrences");
  }
}

export function validateEndpoint(value: JsonValue, path: string, issues: ValidationIssue[]): void {
  if (!isJsonObject(value)) return;
  switch (value["kind"]) {
    case "calendar":
      validateCalendar(value, path, issues);
      break;
    case "relative": {
      validateAnchor(value["anchor"], `${path}/anchor`, issues);
      const coefficient = value["value"];
      if (typeof coefficient === "string" && Number(coefficient) > 9999) {
        issue(issues, "CLOUDIG_TIME_RELATIVE_OUT_OF_RANGE", `${path}/value`, "Relative coefficient must not exceed 9999.0");
      }
      break;
    }
    case "now":
      validateAnchor(value["anchor"], `${path}/anchor`, issues);
      break;
    case "sovereign":
      validateSovereign(value, path, issues);
      break;
    default:
      break;
  }
}

export function validateRange(value: JsonValue, path: string, issues: ValidationIssue[]): void {
  if (!isJsonObject(value)) return;
  const start = value["start"];
  const end = value["end"];
  if (start !== undefined) validateEndpoint(start, `${path}/start`, issues);
  if (end !== undefined) {
    validateEndpoint(end, `${path}/end`, issues);
    if (start !== undefined && canonicalizeJcs(start) === canonicalizeJcs(end)) {
      issue(issues, "CLOUDIG_TIME_NONCANONICAL_COLLAPSED_RANGE", `${path}/end`, "A point range must omit an endpoint equal to start");
    }
  }
}
