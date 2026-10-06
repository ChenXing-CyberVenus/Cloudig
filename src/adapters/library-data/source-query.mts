import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { readCurrentListingSnapshot } from "./catalog.mts";
import { probeExporterRoute } from "../parser/html-envelope.mts";
import { resolveManagedPath } from "../storage/path.mts";

export type SourceQueueFact = Readonly<{
  path: string;
  bytes: number;
  mtimeNs: string;
  missing: boolean;
  changed: boolean;
  catalog?: JsonObject;
  discoveredRoute?: JsonObject;
}>;

const routeCache = new Map<string, { observation: string; route: JsonObject | undefined }>();

export async function listSourceQueueFacts(libraryRoot: string): Promise<Readonly<{
  catalogDegraded: boolean;
  catalogAdapterBundleSha256?: string;
  rows: readonly SourceQueueFact[];
}>> {
  const { scan, catalog } = await readCurrentListingSnapshot(libraryRoot);
  const observed = new Map(scan.sources.map((entry) => [entry.path, entry]));
  const catalogRows = new Map<string, JsonObject>();
  if (catalog && Array.isArray(catalog["sources"])) {
    for (const raw of catalog["sources"]) {
      if (isJsonObject(raw) && typeof raw["path"] === "string") catalogRows.set(raw["path"], raw);
    }
  }
  const paths = new Set([...observed.keys(), ...catalogRows.keys()]);
  const rows = [...paths].sort((left, right) => left.localeCompare(right, "en")).map((relative): SourceQueueFact => {
    const file = observed.get(relative);
    const cached = catalogRows.get(relative);
    if (!file) {
      return {
        path: relative,
        bytes: typeof cached?.["bytes"] === "number" ? cached["bytes"] : 0,
        mtimeNs: typeof cached?.["mtime_ns"] === "string" ? cached["mtime_ns"] : "0",
        missing: true,
        changed: false,
        ...(cached ? { catalog: structuredClone(cached) } : {})
      };
    }
    const changed = Boolean(cached && (cached["bytes"] !== file.bytes || cached["mtime_ns"] !== file.mtime_ns));
    return {
      path: relative,
      bytes: file.bytes,
      mtimeNs: file.mtime_ns,
      missing: false,
      changed,
      ...(cached ? { catalog: structuredClone(cached) } : {})
    };
  });
  const enriched: SourceQueueFact[] = new Array(rows.length);
  let cursor = 0;
  const decorate = async (row: SourceQueueFact): Promise<SourceQueueFact> => {
    if (row.missing || !row.path.toLowerCase().endsWith(".html")) return row;
    const key = `${libraryRoot}\0${row.path}`;
    const observation = `${row.bytes}:${row.mtimeNs}`;
    let known = routeCache.get(key);
    if (!known || known.observation !== observation) {
      let route: JsonObject | undefined;
      try { route = await probeExporterRoute(await resolveManagedPath(libraryRoot, row.path, { mustExist: true })); } catch { /* Unknown display source stays unknown; explicit parse reports actual errors. */ }
      known = { observation, route };
      if (routeCache.size >= 4096) routeCache.delete(routeCache.keys().next().value!);
      routeCache.set(key, known);
    }
    return known.route ? { ...row, discoveredRoute: known.route } : row;
  };
  // Manifest probes are bounded I/O, not full parsing. Preserve list order while
  // allowing the disk queue to service several files instead of one at a time.
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      enriched[index] = await decorate(rows[index]!);
    }
  }));
  return {
    catalogDegraded: !catalog,
    ...(typeof catalog?.["adapter_bundle_sha256"] === "string" ? { catalogAdapterBundleSha256: catalog["adapter_bundle_sha256"] } : {}),
    rows: enriched
  };
}
