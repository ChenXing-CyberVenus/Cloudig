import type { JsonValue } from "../contracts/types.mts";

/** Inspect tokens before JSON.parse can discard duplicate keys or numeric precision. */
export function parseRecordJson(text: string): JsonValue {
  let at = 0;
  type Frame = { kind: "object"; state: "key" | "colon" | "value" | "comma"; keys: Set<string>; empty: boolean }
    | { kind: "array"; state: "value" | "comma"; empty: boolean };
  const stack: Frame[] = [];
  let root = false;
  const fail = (message: string): never => { throw new SyntaxError(`${message} at character ${at}`); };
  const skip = (): void => {
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code !== 32 && code !== 9 && code !== 13 && code !== 10) break;
      at++;
    }
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      // Native search skips long prose in one pass. An odd run of preceding
      // backslashes escapes a quote; JSON.parse still validates every escape,
      // control character and Unicode sequence in the exact token below.
      const quote = text.indexOf('"', at);
      if (quote < 0) return fail("Unterminated string");
      let slashes = 0;
      for (let back = quote - 1; back > start && text.charCodeAt(back) === 92; back--) slashes++;
      at = quote + 1;
      if (slashes % 2 === 0) {
        const value: unknown = JSON.parse(text.slice(start, at));
        if (typeof value !== "string" || !value.isWellFormed()) fail("Invalid Unicode string");
        return value as string;
      }
    }
    return fail("Unterminated string");
  };
  const done = (): void => {
    const frame = stack.at(-1);
    if (frame) { frame.state = "comma"; frame.empty = false; }
    else if (root) fail("Multiple root values");
    else root = true;
  };
  const value = (): void => {
    const char = text[at];
    if (char === "{" || char === "[") {
      done(); at++;
      stack.push(char === "{" ? { kind: "object", state: "key", keys: new Set(), empty: true } : { kind: "array", state: "value", empty: true });
    } else if (char === '"') { string(); done(); }
    else if (char === "t" || char === "f" || char === "n") {
      const token = char === "t" ? "true" : char === "f" ? "false" : "null";
      if (!text.startsWith(token, at)) fail("Invalid literal");
      at += token.length; done();
    } else {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(at));
      if (!match) fail("Expected JSON value");
      const token = match![0], number = Number(token);
      if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)
        || decimal(token) !== decimal(String(number))) fail("Number cannot be represented without loss");
      at += token.length; done();
    }
  };
  while (true) {
    skip();
    const frame = stack.at(-1);
    if (!frame) { if (root) break; value(); continue; }
    if (frame.state === "comma") {
      const end = frame.kind === "object" ? "}" : "]";
      if (text[at] === end) { at++; stack.pop(); continue; }
      if (text[at++] !== ",") fail("Expected comma or closing delimiter");
      frame.state = frame.kind === "object" ? "key" : "value";
      frame.empty = false;
    } else if (frame.kind === "object" && frame.state === "key") {
      if (text[at] === "}" && frame.empty) { at++; stack.pop(); continue; }
      if (text[at] !== '"') fail("Expected object key");
      const key = string();
      if (frame.keys.has(key)) fail(`Duplicate object key ${JSON.stringify(key)}`);
      frame.keys.add(key); frame.state = "colon";
    } else if (frame.kind === "object" && frame.state === "colon") {
      if (text[at++] !== ":") fail("Expected colon");
      frame.state = "value";
    } else {
      if (frame.kind === "array" && text[at] === "]" && frame.empty) { at++; stack.pop(); continue; }
      value();
    }
  }
  skip();
  if (at !== text.length) fail("Trailing JSON content");
  return JSON.parse(text) as JsonValue;
}

function decimal(token: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(token)!;
  let digits = (match[2]! + (match[3] ?? "")).replace(/^0+/u, "");
  if (!digits) return "0";
  let exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailing) { digits = digits.slice(0, -trailing); exponent += BigInt(trailing); }
  return `${match[1]}${digits}e${exponent}`;
}

/** Reject non-JSON in-memory values, including cycles, sparse arrays and getters. */
export function assertRecordJson(value: unknown): asserts value is JsonValue {
  const active = new Set<object>();
  const stack: { value: unknown; leave?: boolean }[] = [{ value }];
  while (stack.length) {
    const entry = stack.pop()!, current = entry.value;
    if (entry.leave) { active.delete(current as object); continue; }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") { if (!current.isWellFormed()) throw new TypeError("Invalid Unicode string"); continue; }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Number.isInteger(current) && !Number.isSafeInteger(current)) throw new TypeError("Invalid JSON number");
      continue;
    }
    if (!current || typeof current !== "object") throw new TypeError("Expected JSON values only");
    if (active.has(current)) throw new TypeError("Cyclic JSON object");
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw new TypeError("Expected plain JSON object");
    active.add(current); stack.push({ value: current, leave: true });
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Object.getOwnPropertySymbols(current).length) throw new TypeError("Symbol properties are not JSON");
    if (Array.isArray(current) && Object.keys(current).length !== current.length) throw new TypeError("Sparse or decorated JSON array");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current) && key === "length") continue;
      if (Array.isArray(current) && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length)) throw new TypeError("Decorated JSON array");
      if (!key.isWellFormed() || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Invalid JSON property");
      stack.push({ value: descriptor.value });
    }
  }
}
