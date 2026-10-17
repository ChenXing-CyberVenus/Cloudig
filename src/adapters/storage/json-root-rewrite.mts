import { Transform, type TransformCallback } from "node:stream";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

function whitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

export class RootStringFieldRewriter extends Transform {
  readonly #field: string;
  readonly #expected: string;
  readonly #replacement: string;
  #rootStarted = false;
  #finished = false;
  #depth = 0;
  #inString = false;
  #escaped = false;
  #expectingKey = false;
  #expectingValue = false;
  #currentKey: string | undefined;
  #captureRole: "key" | "value" | undefined;
  #capture: number[] = [];
  #replacementCount = 0;
  #previousValue: string | undefined;

  constructor(field: string, expected: string, replacement: string) {
    super();
    this.#field = field;
    this.#expected = expected;
    this.#replacement = replacement;
  }

  get replacementCount(): number {
    return this.#replacementCount;
  }

  get previousValue(): string | undefined {
    return this.#previousValue;
  }

  #decodeCaptured(): string {
    const token = Buffer.from(this.#capture).toString("utf8");
    const value: unknown = JSON.parse(token);
    if (typeof value !== "string") throw new TypeError("Captured root JSON token is not a string");
    return value;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    let segmentStart = 0;
    try {
      for (let index = 0; index < bytes.byteLength; index += 1) {
        const byte = bytes[index]!;
        if (this.#finished) {
          if (!whitespace(byte)) throw new TypeError("Conversation JSON has trailing non-whitespace bytes");
          continue;
        }
        if (this.#inString) {
          if (this.#captureRole) {
            this.#capture.push(byte);
            segmentStart = index + 1;
            if (this.#capture.length > 4096) throw new TypeError("Root JSON string token exceeds the bounded rewrite limit");
          }
          if (this.#escaped) {
            this.#escaped = false;
          } else if (byte === BACKSLASH) {
            this.#escaped = true;
          } else if (byte === QUOTE) {
            this.#inString = false;
            if (this.#captureRole === "key") {
              this.#currentKey = this.#decodeCaptured();
              this.#expectingKey = false;
              this.push(Buffer.from(this.#capture));
              this.#capture = [];
              this.#captureRole = undefined;
              segmentStart = index + 1;
            } else if (this.#captureRole === "value") {
              const previous = this.#decodeCaptured();
              if (previous !== this.#expected) throw new TypeError("Root field no longer matches the expected value");
              if (this.#replacementCount !== 0) throw new TypeError("Root field occurs more than once");
              this.#previousValue = previous;
              this.#replacementCount += 1;
              this.push(Buffer.from(JSON.stringify(this.#replacement), "utf8"));
              this.#capture = [];
              this.#captureRole = undefined;
              segmentStart = index + 1;
            }
          }
          continue;
        }

        if (!this.#rootStarted) {
          if (whitespace(byte)) continue;
          if (byte !== OPEN_OBJECT) throw new TypeError("Conversation JSON root must be an object");
          this.#rootStarted = true;
          this.#depth = 1;
          this.#expectingKey = true;
          continue;
        }

        if (byte === QUOTE) {
          const role = this.#depth === 1 && this.#expectingKey
            ? "key"
            : this.#depth === 1 && this.#expectingValue && this.#currentKey === this.#field
              ? "value"
              : undefined;
          this.#inString = true;
          this.#escaped = false;
          if (role) {
            if (segmentStart < index) this.push(bytes.subarray(segmentStart, index));
            this.#captureRole = role;
            this.#capture = [QUOTE];
            segmentStart = index + 1;
          }
          continue;
        }
        if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
          this.#depth += 1;
        } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
          if (this.#depth < 1) throw new TypeError("Conversation JSON nesting is invalid");
          this.#depth -= 1;
          if (this.#depth === 0) this.#finished = true;
        } else if (this.#depth === 1 && byte === COLON && this.#currentKey !== undefined) {
          this.#expectingValue = true;
        } else if (this.#depth === 1 && byte === COMMA) {
          this.#expectingKey = true;
          this.#expectingValue = false;
          this.#currentKey = undefined;
        }
      }
      if (!this.#captureRole && segmentStart < bytes.byteLength) this.push(bytes.subarray(segmentStart));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new TypeError("Root JSON rewrite failed"));
    }
  }

  override _flush(callback: TransformCallback): void {
    if (
      !this.#rootStarted
      || !this.#finished
      || this.#depth !== 0
      || this.#inString
      || this.#captureRole !== undefined
      || this.#replacementCount !== 1
    ) {
      callback(new TypeError("Conversation JSON root field rewrite did not complete exactly once"));
      return;
    }
    callback();
  }
}
