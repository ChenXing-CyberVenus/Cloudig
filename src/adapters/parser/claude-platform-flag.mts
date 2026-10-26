import { orderJson } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject } from "../../core/contracts/types.mts";

/** Platform-authored notices, not user/assistant prose or exporter failures.
 * Unknown future flag names retain their accompanying data by the same rule. */
export function claudePlatformFlag(raw: JsonObject): JsonObject {
  const { type: _type, start_timestamp: _start, stop_timestamp: _stop, ...details } = raw;
  return { type: "status", title: "Claude platform flag", text: JSON.stringify(orderJson(details), null, 2), format: "text" };
}
