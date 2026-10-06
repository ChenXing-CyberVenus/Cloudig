import type { JsonObject, JsonValue } from "../contracts/types.mts";
import { isJsonObject } from "../contracts/types.mts";

type Progression = Readonly<{ first: bigint; step: bigint; last: bigint }>;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function extendedGcd(left: bigint, right: bigint): { gcd: bigint; x: bigint; y: bigint } {
  if (right === 0n) return { gcd: left, x: 1n, y: 0n };
  const next = extendedGcd(right, left % right);
  return { gcd: next.gcd, x: next.y, y: next.x - (left / right) * next.y };
}

function mod(value: bigint, divisor: bigint): bigint {
  const result = value % divisor;
  return result < 0n ? result + divisor : result;
}

function progression(value: JsonValue, periodCount: number): Progression {
  if (!isJsonObject(value)) throw new TypeError("selector must be an object");
  if (value["mode"] === "all") return { first: 1n, step: 1n, last: BigInt(periodCount) };
  if (value["mode"] === "prefix") {
    if (typeof value["count"] !== "number") throw new TypeError("prefix.count is required");
    return { first: 1n, step: 1n, last: BigInt(value["count"]) };
  }
  if (value["mode"] !== "progression") throw new TypeError("unsupported selector mode");
  return {
    first: BigInt(value["first"] as number),
    step: BigInt(value["step"] as number),
    last: BigInt(value["last"] as number)
  };
}

export function selectorIntersects(left: JsonValue, right: JsonValue, periodCount: number): boolean {
  const a = progression(left, periodCount);
  const b = progression(right, periodCount);
  const lower = a.first > b.first ? a.first : b.first;
  const upper = a.last < b.last ? a.last : b.last;
  if (lower > upper) return false;
  const divisor = gcd(a.step, b.step);
  const difference = b.first - a.first;
  if (difference % divisor !== 0n) return false;
  const aReduced = a.step / divisor;
  const bReduced = b.step / divisor;
  const inverse = mod(extendedGcd(aReduced, bReduced).x, bReduced);
  const multiplier = mod((difference / divisor) * inverse, bReduced);
  const firstSolution = a.first + a.step * multiplier;
  const period = a.step * bReduced;
  const shift = firstSolution < lower ? (lower - firstSolution + period - 1n) / period : 0n;
  return firstSolution + shift * period <= upper;
}

export function fixedProgressionForAll(periodCount: number): JsonObject {
  if (!Number.isSafeInteger(periodCount) || periodCount < 1) throw new RangeError("periodCount must be a positive safe integer");
  return { mode: "progression", first: 1, step: 1, last: periodCount };
}
