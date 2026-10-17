import { isJsonObject, type JsonObject } from "../../core/contracts/types.mts";

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function diagnosticMessage(value: unknown): string | undefined {
  const text = boundedText(value, 8192);
  if (!text) return undefined;
  const projected = text
    .replace(/\b(?:https?|file):\/\/\S+/giu, "[URL omitted]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)\S+/gu, "[path omitted]")
    .slice(0, 4096);
  return projected.length > 0 ? projected : undefined;
}

export function parserErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? diagnosticMessage(error.message) ?? fallback : fallback;
}

function diagnosticRef(value: unknown): string | undefined {
  const ref = boundedText(value, 256);
  return ref && !/^(?:https?|file):|^(?:[A-Za-z]:[\\/]|\\\\)/iu.test(ref) ? ref : undefined;
}

export function captureDiagnosticErrors(manifest: JsonObject): readonly JsonObject[] {
  const envelope = isJsonObject(manifest["capture_diagnostics"]) ? manifest["capture_diagnostics"] : undefined;
  if (envelope?.["format"] !== "ai-chat-archive/capture-diagnostics-v1" || !Array.isArray(envelope["entries"])) return [];
  const errors: JsonObject[] = [];
  for (const raw of envelope["entries"]) {
    if (!isJsonObject(raw)) continue;
    const message = diagnosticMessage(raw["detail"] ?? raw["message"] ?? raw["error"]);
    if (!message) continue;
    const code = boundedText(raw["code"], 128);
    const stage = boundedText(raw["stage"], 64);
    const ref = diagnosticRef(raw["ref"] ?? raw["resource_key"] ?? raw["message_id"]);
    errors.push({ source: "exporter", ...(code ? { code } : {}), ...(stage ? { stage } : {}), message, ...(ref ? { ref } : {}) });
  }
  return errors;
}

export function canonicalDiagnosticErrors(draft: JsonObject): readonly JsonObject[] {
  const errors: JsonObject[] = [];
  for (const raw of Array.isArray(draft["limitations"]) ? draft["limitations"] : []) {
    if (!isJsonObject(raw)) continue;
    const code = boundedText(raw["code"], 128);
    const message = diagnosticMessage(raw["detail"] ?? raw["message"] ?? code);
    const ref = diagnosticRef(raw["at"] ?? raw["ref"]);
    if (message) errors.push({ source: "parser", ...(code ? { code } : {}), message, ...(ref ? { ref } : {}) });
  }
  for (const raw of Array.isArray(draft["resources"]) ? draft["resources"] : []) {
    if (!isJsonObject(raw) || raw["availability"] !== "missing") continue;
    const ref = diagnosticRef(raw["id"]);
    errors.push({ source: "canonical", code: "resource-missing", message: "原文件未取得此资源，保留已有来源描述。", ...(ref ? { ref } : {}) });
  }
  return errors;
}
