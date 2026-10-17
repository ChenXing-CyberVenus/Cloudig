import type { JsonObject } from "../contracts/types.mts";
import { normalizeRange } from "./range.mts";
import { formatEndpoint, type TimeLocale } from "./format-endpoint.mts";

export { formatEndpoint, type TimeLocale } from "./format-endpoint.mts";

export function formatRange(value: JsonObject, locale: TimeLocale): string {
  const range = normalizeRange(value);
  const start = formatEndpoint(range["start"]!, locale);
  return range["end"] === undefined ? start : `${start} – ${formatEndpoint(range["end"]!, locale)}`;
}
