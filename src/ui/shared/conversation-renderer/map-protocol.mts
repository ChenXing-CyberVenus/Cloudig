export const MAP_PROTOCOL = "cloudig/saved-map/1";
export const MAP_LIMITS = Object.freeze({ loadTimeoutMs: 30_000, maximumZoom: 18, initialZoom: 12 });
export const MAP_TILES_ORIGIN = "https://tiles.openfreemap.org";
export type SavedMapPoint = Readonly<{ name: string; notes: string; longitude: number; latitude: number }>;
export function validMapPoint(value: unknown): value is SavedMapPoint {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p["name"] === "string" && typeof p["notes"] === "string"
    && typeof p["longitude"] === "number" && Number.isFinite(p["longitude"]) && Math.abs(p["longitude"]) <= 180
    && typeof p["latitude"] === "number" && Number.isFinite(p["latitude"]) && Math.abs(p["latitude"]) <= 90;
}

/** Only the built-in, explicitly opened map uses this provider. Saved works do not. */
export function mapResourceUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== MAP_TILES_ORIGIN || url.username || url.password) throw new Error("Unsupported map resource origin");
  return url.href;
}
