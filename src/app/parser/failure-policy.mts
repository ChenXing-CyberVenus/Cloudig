import type { AdapterManifest } from "./adapter.mts";
import type { JsonObject } from "../../core/contracts/types.mts";

// Only explicit source-shape errors spend the one content retry. File access,
// cancellation, memory pressure and unexpected implementation errors do not.
export function isSourceContentError(error: unknown): boolean {
  if (!(error instanceof Error) || "code" in error || error.name === "AbortError") return false;
  if (error instanceof SyntaxError) return true;
  return (error instanceof TypeError || error instanceof RangeError)
    && !/internal|catalog|transaction|commit|IPC|temporary root|memory threshold/iu.test(error.message)
    && /manifest|payload|Exporter HTML|Claude export record|selected Claude.*shape|message UUID|message cycle|parent-first traversal|source.*(?:shape|format)|draft.*invalid/iu.test(error.message);
}

export function nextContentFailureAttempts(previous: number, contentFailure: boolean): number {
  return Math.min(2, Math.max(0, Number.isInteger(previous) ? previous : 0) + (contentFailure ? 1 : 0));
}

export function sourceFailureWatermark(route: JsonObject | undefined, adapters: readonly AdapterManifest[], bundle: string): string {
  const platform = route?.["platform"];
  const matching = typeof platform === "string" ? adapters.filter(adapter => adapter.routes.some(candidate => candidate.platform === platform)) : [];
  return matching.length ? matching.map(adapter => `${adapter.id}@${adapter.version}`).sort().join("|") : `bundle:${bundle}`;
}
