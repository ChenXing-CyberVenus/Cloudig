import type { Readable, Writable } from "node:stream";
import { RecordSchemaError } from "../core/records/errors.mts";

import resourceLimits from "../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { JsonObject, JsonValue } from "../core/contracts/types.mts";
import { isJsonObject } from "../core/contracts/types.mts";

export const ENGINE_PROTOCOL = "cloudig/engine-ipc/1.0.0";

const REQUEST_ID = /^q_[A-Za-z0-9_-]{1,62}$/u;
// Existing command contracts use camelCase; preserve their exact allowlist key.
const COMMAND = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "data_base64"]);

export type EngineRequest = Readonly<{
  protocol: typeof ENGINE_PROTOCOL;
  kind: "request";
  request: string;
  command: string;
  payload: JsonObject;
}>;

export type EngineCommandContext = Readonly<{
  request: string;
  signal: AbortSignal;
  emit(event: JsonObject): Promise<void>;
}>;

export type EngineCommandHandler = (payload: JsonObject, context: EngineCommandContext) => Promise<JsonValue>;

export class EngineCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineCommandError";
    this.code = code;
  }
}

export class EngineProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineProtocolError";
    this.code = code;
  }
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function assertIpcValue(value: unknown): asserts value is JsonValue {
  const stack: Array<{ value: unknown; depth: number; key?: string }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > resourceLimits.ipc_json_nodes_max) throw new EngineProtocolError("CLOUDIG_IPC_TOO_COMPLEX", "IPC payload contains too many values");
    if (current.depth > resourceLimits.ipc_json_depth_max) throw new EngineProtocolError("CLOUDIG_IPC_TOO_DEEP", "IPC payload nesting is too deep");
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value) || (Number.isInteger(current.value) && !Number.isSafeInteger(current.value))) {
        throw new EngineProtocolError("CLOUDIG_IPC_NUMBER_INVALID", "IPC payload contains a non-interoperable number");
      }
      continue;
    }
    if (typeof current.value === "string") {
      if (!validUnicode(current.value) || current.value.includes("\0")) throw new EngineProtocolError("CLOUDIG_IPC_STRING_INVALID", "IPC payload contains invalid text");
      // Display text is not a filesystem capability. Each command validates its
      // own token/path fields; the transport must not censor titles or messages.
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    if (!isJsonObject(current.value)) throw new EngineProtocolError("CLOUDIG_IPC_VALUE_INVALID", "IPC payload must contain JSON values only");
    for (const [key, entry] of Object.entries(current.value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new EngineProtocolError("CLOUDIG_IPC_FIELD_FORBIDDEN", "IPC payload contains a forbidden field");
      stack.push({ value: entry, depth: current.depth + 1, key });
    }
  }
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function parseEngineRequest(value: unknown): EngineRequest {
  assertIpcValue(value);
  if (!isJsonObject(value) || !exactKeys(value, ["protocol", "kind", "request", "command", "payload"])) {
    throw new EngineProtocolError("CLOUDIG_IPC_REQUEST_INVALID", "IPC request envelope is invalid");
  }
  if (value["protocol"] !== ENGINE_PROTOCOL || value["kind"] !== "request") {
    throw new EngineProtocolError("CLOUDIG_IPC_PROTOCOL_MISMATCH", "IPC protocol is not supported");
  }
  if (typeof value["request"] !== "string" || !REQUEST_ID.test(value["request"])) {
    throw new EngineProtocolError("CLOUDIG_IPC_REQUEST_ID_INVALID", "IPC request ID is invalid");
  }
  if (typeof value["command"] !== "string" || !COMMAND.test(value["command"])) {
    throw new EngineProtocolError("CLOUDIG_IPC_COMMAND_INVALID", "IPC command name is invalid");
  }
  if (!isJsonObject(value["payload"])) throw new EngineProtocolError("CLOUDIG_IPC_PAYLOAD_INVALID", "IPC command payload must be an object");
  return value as EngineRequest;
}

async function* jsonLines(input: Readable): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  for await (const raw of input) {
    const incoming = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.byteLength === 0 ? incoming : Buffer.concat([pending, incoming]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > resourceLimits.ipc_json_line_max_bytes) throw new EngineProtocolError("CLOUDIG_IPC_LINE_TOO_LARGE", "IPC line exceeds the configured bound");
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.byteLength === 0 || line.at(-1) === 0x0d) throw new EngineProtocolError("CLOUDIG_IPC_LINE_INVALID", "IPC requires one nonempty LF-framed JSON value per line");
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(line)) as unknown;
      } catch {
        throw new EngineProtocolError("CLOUDIG_IPC_JSON_INVALID", "IPC line is not valid UTF-8 JSON");
      }
      yield value;
    }
    if (pending.byteLength > resourceLimits.ipc_json_line_max_bytes) throw new EngineProtocolError("CLOUDIG_IPC_LINE_TOO_LARGE", "IPC line exceeds the configured bound");
  }
  if (pending.byteLength !== 0) throw new EngineProtocolError("CLOUDIG_IPC_LINE_INCOMPLETE", "IPC input ended without LF framing");
}

class JsonLineWriter {
  readonly #output: Writable;
  #tail: Promise<void> = Promise.resolve();

  constructor(output: Writable) {
    this.#output = output;
  }

  write(value: JsonValue): Promise<void> {
    const task = this.#tail.then(async () => {
      assertIpcValue(value);
      const line = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(line) > resourceLimits.ipc_json_line_max_bytes) {
        throw new EngineProtocolError("CLOUDIG_IPC_LINE_TOO_LARGE", "IPC output exceeds the configured bound");
      }
      await new Promise<void>((resolve, reject) => {
        this.#output.write(line, (error?: Error | null) => error ? reject(error) : resolve());
      });
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }

  async flush(): Promise<void> {
    await this.#tail;
  }
}

function boundedMessage(value: string): string {
  return Array.from(value).slice(0, 512).join("");
}

function errorPayload(error: unknown): JsonObject {
  if (error instanceof EngineCommandError || error instanceof EngineProtocolError || error instanceof RecordSchemaError) {
    return { code: error.code, message: boundedMessage(error.message) };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "CLOUDIG_CANCELLED", message: "Operation was cancelled" };
  }
  return { code: "CLOUDIG_COMMAND_FAILED", message: "Command failed" };
}

function response(request: string, result: JsonValue): JsonObject {
  return { protocol: ENGINE_PROTOCOL, kind: "response", request, ok: true, result };
}

function failure(request: string, error: unknown): JsonObject {
  return { protocol: ENGINE_PROTOCOL, kind: "response", request, ok: false, error: errorPayload(error) };
}

export async function serveEngineJsonl(input: Readonly<{
  readable: Readable;
  writable: Writable;
  engineVersion: string;
  handlers: Readonly<Record<string, EngineCommandHandler>>;
  onShutdown?: () => Promise<void> | void;
}>): Promise<void> {
  const writer = new JsonLineWriter(input.writable);
  const active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  const seen = new Set<string>();
  let stopping = false;
  let fatal: unknown;

  const sendFailure = async (request: string, error: unknown): Promise<void> => {
    try {
      await writer.write(failure(request, error));
    } catch (boundary) {
      await writer.write(failure(request, boundary));
    }
  };

  try {
    for await (const value of jsonLines(input.readable)) {
      const request = parseEngineRequest(value);
      if (seen.has(request.request)) {
        await sendFailure(request.request, new EngineProtocolError("CLOUDIG_IPC_REQUEST_REPLAY", "IPC request ID has already been used"));
        continue;
      }
      seen.add(request.request);

      if (request.command === "engine.handshake") {
        if (Object.keys(request.payload).length !== 0) {
          await sendFailure(request.request, new EngineProtocolError("CLOUDIG_IPC_PAYLOAD_INVALID", "Handshake payload must be empty"));
        } else {
          await writer.write(response(request.request, {
            protocol: ENGINE_PROTOCOL,
            engine_version: input.engineVersion,
            commands: ["engine.cancel", "engine.handshake", "engine.shutdown", ...Object.keys(input.handlers)].sort()
          }));
        }
        continue;
      }

      if (request.command === "engine.cancel") {
        const target = request.payload["target"];
        if (typeof target !== "string" || !REQUEST_ID.test(target) || Object.keys(request.payload).length !== 1) {
          await sendFailure(request.request, new EngineProtocolError("CLOUDIG_IPC_PAYLOAD_INVALID", "Cancel requires one target request ID"));
          continue;
        }
        const operation = active.get(target);
        operation?.controller.abort(new DOMException("Operation cancelled by request", "AbortError"));
        await writer.write(response(request.request, { cancelled: operation !== undefined }));
        continue;
      }

      if (request.command === "engine.shutdown") {
        if (Object.keys(request.payload).length !== 0) {
          await sendFailure(request.request, new EngineProtocolError("CLOUDIG_IPC_PAYLOAD_INVALID", "Shutdown payload must be empty"));
          continue;
        }
        stopping = true;
        for (const operation of active.values()) operation.controller.abort(new DOMException("Engine is shutting down", "AbortError"));
        await Promise.all([...active.values()].map((operation) => operation.task));
        await input.onShutdown?.();
        await writer.write(response(request.request, { stopped: true }));
        break;
      }

      const handler = input.handlers[request.command];
      if (!handler) {
        await sendFailure(request.request, new EngineProtocolError("CLOUDIG_IPC_COMMAND_UNKNOWN", "IPC command is not allowlisted"));
        continue;
      }
      if (active.size >= resourceLimits.ipc_concurrent_commands_max) {
        await sendFailure(request.request, new EngineProtocolError("CLOUDIG_IPC_BUSY", "Engine command capacity is currently full"));
        continue;
      }
      const controller = new AbortController();
      const task = (async () => {
        try {
          const result = await handler(request.payload, {
            request: request.request,
            signal: controller.signal,
            emit: async (event) => writer.write({ protocol: ENGINE_PROTOCOL, kind: "event", request: request.request, event })
          });
          assertIpcValue(result);
          await writer.write(response(request.request, result));
        } catch (error) {
          await sendFailure(request.request, error);
        }
      })().catch((error) => {
        fatal = error;
        for (const operation of active.values()) operation.controller.abort(new DOMException("IPC transport failed", "AbortError"));
      }).finally(() => {
        active.delete(request.request);
      });
      active.set(request.request, { controller, task });
    }
  } catch (error) {
    fatal = error;
  } finally {
    if (!stopping) for (const operation of active.values()) operation.controller.abort(new DOMException("IPC input closed", "AbortError"));
    await Promise.all([...active.values()].map((operation) => operation.task));
    if (fatal) {
      try {
        await writer.write({ protocol: ENGINE_PROTOCOL, kind: "fatal", error: errorPayload(fatal) });
      } catch {
        // A closed transport cannot receive a second failure.
      }
    }
    await writer.flush();
  }
}
