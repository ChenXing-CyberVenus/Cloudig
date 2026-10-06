import type { SourceQueueFact } from "../../adapters/library-data/source-query.mts";
import type { AdapterManifest } from "../parser/adapter.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { sourceFailureWatermark } from "../parser/failure-policy.mts";

export type ArchiverSourceRow = Readonly<{
  fact: SourceQueueFact;
  displayFilename: string;
  status: "pending" | "complete" | "update_action" | "failed" | "missing" | "unsupported";
  kind: "bookmark_html" | "claude_json" | "other";
  platform?: string;
  adapter?: Readonly<{ id: string; version: string }>;
  exporterVersion?: string;
  action?: string;
  error?: string;
  retry?: string;
}>;

function filename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function currentAdapters(values: readonly AdapterManifest[]): ReadonlyMap<string, string> {
  return new Map(values.map((entry) => [entry.id, entry.version]));
}

function route(row: JsonObject | undefined): JsonObject | undefined {
  return isJsonObject(row?.["route"]) ? row["route"] : undefined;
}

function outputs(row: JsonObject | undefined): readonly JsonObject[] {
  return Array.isArray(row?.["outputs"]) ? row["outputs"].filter(isJsonObject) : [];
}

export function projectArchiverSources(
  facts: readonly SourceQueueFact[],
  adapters: readonly AdapterManifest[],
  adapterBundleChanged = false,
  currentBundleSha256 = ""
): readonly ArchiverSourceRow[] {
  const versions = currentAdapters(adapters);
  return facts.map((fact) => {
    const cached = fact.catalog;
    const sourceRoute = fact.discoveredRoute ?? (fact.changed ? undefined : route(cached));
    const base = filename(fact.path);
    const kind = sourceRoute?.["format"] === "anthropic-claude-export-json"
      || (base.toLowerCase().endsWith(".json") && sourceRoute?.["platform"] === "claude")
      ? "claude_json"
      : sourceRoute?.["format"] === "exporter-html"
        ? "bookmark_html"
        : "other";
    const stale = outputs(cached).some((output) => {
      const adapter = isJsonObject(output["adapter"]) ? output["adapter"] : undefined;
      return typeof adapter?.["id"] === "string"
        && typeof adapter["version"] === "string"
        && versions.get(adapter["id"]) !== adapter["version"];
    });
    const cachedStatus = cached?.["status"];
    const cachedError = isJsonObject(cached?.["error"]) ? cached["error"] : undefined;
    const failure = isJsonObject(cached?.["failure"]) ? cached["failure"] : undefined;
    const cachedFailure = cachedStatus === "failed" || cachedStatus === "unsupported";
    const retryUnlocked = cachedFailure && (failure && currentBundleSha256
      ? failure["watermark"] !== sourceFailureWatermark(sourceRoute, adapters, currentBundleSha256)
      : adapterBundleChanged && cachedError?.["retry"] === "after_adapter_change");
    const status = fact.missing
      ? "missing"
      : fact.changed || !cached || retryUnlocked
        ? (base.toLowerCase().endsWith(".html") || base.toLowerCase().endsWith(".json") ? "pending" : "unsupported")
        : stale && !cachedFailure
          ? "update_action"
          : ["pending", "complete", "update_action", "failed", "missing", "unsupported"].includes(String(cachedStatus))
            ? cachedStatus as ArchiverSourceRow["status"]
            : "pending";
    const firstOutput = outputs(cached)[0];
    const adapter = isJsonObject(firstOutput?.["adapter"]) ? firstOutput["adapter"] : undefined;
    const exporter = isJsonObject(firstOutput?.["exporter"]) ? firstOutput["exporter"] : undefined;
    const exporterVersion = sourceRoute?.["exporter_version"] ?? exporter?.["version"];
    const error = (status === "failed" || status === "unsupported") && typeof cachedError?.["code"] === "string" ? cachedError["code"] : undefined;
    const retry = error && typeof cachedError?.["retry"] === "string" ? cachedError["retry"] : undefined;
    return {
      fact,
      displayFilename: kind === "bookmark_html" && base.toLowerCase().endsWith(".html") ? base.slice(0, -5) : base,
      status,
      kind,
      ...(typeof exporterVersion === "string" ? { exporterVersion } : {}),
      ...(typeof sourceRoute?.["platform"] === "string" ? { platform: sourceRoute["platform"] } : {}),
      ...(typeof adapter?.["id"] === "string" && typeof adapter["version"] === "string"
        ? { adapter: { id: adapter["id"], version: adapter["version"] } }
        : {}),
      ...(typeof cached?.["action"] === "string" ? { action: cached["action"] } : {}),
      ...(error ? { error } : {}),
      ...(retry ? { retry } : {})
    };
  });
}
