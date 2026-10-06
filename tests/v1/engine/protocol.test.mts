import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import {
  ENGINE_PROTOCOL,
  EngineCommandError,
  parseEngineRequest,
  serveEngineJsonl
} from "../../../src/engine/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

function request(id: string, command: string, payload: JsonObject = {}): string {
  return `${JSON.stringify({ protocol: ENGINE_PROTOCOL, kind: "request", request: id, command, payload })}\n`;
}

test("IPC validates its envelope without treating displayed path-shaped text as filesystem authority", () => {
  const text = ["C:\\Users\\someone\\archive.json", "\\\\server\\share", "file:///notes", "C:\\ 是我讨论的标题"];
  assert.throws(() => parseEngineRequest({
    protocol: ENGINE_PROTOCOL,
    kind: "request",
    request: "q_valid",
    command: "reader.open",
    payload: {},
    extra: true
  }), /envelope is invalid/iu);
  assert.throws(() => parseEngineRequest({
    protocol: ENGINE_PROTOCOL,
    kind: "request",
    request: "q_valid",
    command: "reader.open",
    payload: { data_base64: ["AA=="] }
  }), /forbidden field/iu);
  assert.deepEqual(parseEngineRequest({
    protocol: ENGINE_PROTOCOL,
    kind: "request",
    request: "q_valid",
    command: "reader.open",
    payload: { value: text }
  }).payload, { value: text });
});

test("JSONL engine allowlists commands, correlates events, rejects replay, cancels work and mediates output", async () => {
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk: string) => { captured += chunk; });
  let shutdown = false;
  const source = [
    request("q_handshake", "engine.handshake"),
    request("q_echo", "test.echo", { value: "C:\\Users\\someone\\我的标题" }),
    request("q_echo", "test.echo", { value: "replayed" }),
    request("q_slow", "test.slow"),
    request("q_cancel", "engine.cancel", { target: "q_slow" }),
    request("q_unknown", "test.unknown"),
    request("q_unsafe", "test.unsafe"),
    request("q_expected", "test.expected"),
    request("q_shutdown", "engine.shutdown")
  ].join("");

  await serveEngineJsonl({
    readable: Readable.from([source]),
    writable: output,
    engineVersion: "0.1.0",
    handlers: {
      "test.echo": async (payload, context) => {
        await context.emit({ phase: "echo", state: "running" });
        return { echoed: payload["value"]! };
      },
      "test.slow": async (_payload, context) => new Promise((resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        setTimeout(() => resolve({ late: true }), 10_000).unref();
      }),
      "test.unsafe": async () => ({ data_base64: ["AA=="] }),
      "test.expected": async () => { throw new EngineCommandError("CLOUDIG_EXPECTED", "Expected bounded failure"); }
    },
    onShutdown: () => { shutdown = true; }
  });

  const lines = captured.trim().split("\n").map((line) => JSON.parse(line) as JsonObject);
  assert.equal(shutdown, true);
  assert.equal(lines.some((line) => line["kind"] === "fatal"), false);
  assert.doesNotMatch(captured, /C:\\private|data_base64|stack/iu);
  const byRequest = (id: string) => lines.filter((line) => line["request"] === id);
  const handshake = byRequest("q_handshake").at(-1)!;
  assert.equal(handshake["ok"], true);
  assert.equal((handshake["result"] as JsonObject)["engine_version"], "0.1.0");
  assert.ok(((handshake["result"] as JsonObject)["commands"] as string[]).includes("test.echo"));
  assert.equal(byRequest("q_echo").some((line) => line["kind"] === "event"), true);
  assert.equal(byRequest("q_echo").filter((line) => line["kind"] === "response" && line["ok"] === true).length, 1);
  assert.deepEqual(byRequest("q_echo").find((line) => line["ok"] === true)?.["result"], { echoed: "C:\\Users\\someone\\我的标题" });
  assert.equal(((byRequest("q_echo").find((line) => line["ok"] === false)?.["error"] as JsonObject)["code"]), "CLOUDIG_IPC_REQUEST_REPLAY");
  assert.equal(((byRequest("q_slow").at(-1)!["error"] as JsonObject)["code"]), "CLOUDIG_CANCELLED");
  assert.deepEqual(byRequest("q_cancel").at(-1)!["result"], { cancelled: true });
  assert.equal(((byRequest("q_unknown").at(-1)!["error"] as JsonObject)["code"]), "CLOUDIG_IPC_COMMAND_UNKNOWN");
  assert.equal(((byRequest("q_unsafe").at(-1)!["error"] as JsonObject)["code"]), "CLOUDIG_IPC_FIELD_FORBIDDEN");
  assert.equal(((byRequest("q_expected").at(-1)!["error"] as JsonObject)["code"]), "CLOUDIG_EXPECTED");
  assert.deepEqual(byRequest("q_shutdown").at(-1)!["result"], { stopped: true });
});

test("malformed or unterminated input produces one bounded fatal envelope", async () => {
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk: string) => { captured += chunk; });
  await serveEngineJsonl({
    readable: Readable.from(["{\"not\":\"terminated\"}"]),
    writable: output,
    engineVersion: "0.1.0",
    handlers: {}
  });
  const fatal = JSON.parse(captured.trim()) as JsonObject;
  assert.equal(fatal["kind"], "fatal");
  assert.equal((fatal["error"] as JsonObject)["code"], "CLOUDIG_IPC_LINE_INCOMPLETE");
});

test("JSONL transports the exact camelCase production commands without relaxing the allowlist", async () => {
  const commands = ["systemLog.list", "reader.archive.exportMarkdown", "archiver.source.dismissMissing", "time.order.commit"];
  const output = new PassThrough(); output.setEncoding("utf8"); let captured = "";
  output.on("data", (chunk: string) => { captured += chunk; });
  await serveEngineJsonl({ readable: Readable.from([[
    ...commands.map((command, index) => request(`q_case${index}`, command)),
    request("q_wrong_case", "systemlog.list")
  ].join("")]), writable: output, engineVersion: "test", handlers: Object.fromEntries(commands.map(command => [command, async () => ({ command })])) });
  const responses = captured.trim().split("\n").map(line => JSON.parse(line));
  for (const [index, command] of commands.entries()) {
    const response = responses.find(line => line.request === `q_case${index}`);
    assert.equal(response?.ok, true, command); assert.deepEqual(response.result, { command });
  }
  assert.equal(responses.find(line => line.request === "q_wrong_case").error.code, "CLOUDIG_IPC_COMMAND_UNKNOWN");
  assert.equal(responses.some(line => line.kind === "fatal"), false);
});
