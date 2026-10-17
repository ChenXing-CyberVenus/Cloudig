import type { JsonObject } from "../contracts/types.mts";

/** Reading projection only. Never changes an archived 1.0.1 block in place. */
export function containerDisplay(value: JsonObject): "box" | "window" | undefined {
  const kind = value["type"];
  if (kind === "box" || kind === "window") return kind;
  if (kind === "interactive" && (value["display"] === "box" || value["display"] === "window")) return value["display"];
  return undefined;
}
