import { orderJson } from "../../core/contracts/deterministic-json.mts";
import type { JsonObject } from "../../core/contracts/types.mts";

/** Platform-authored notices, not user/assistant prose or exporter failures.
 * Unknown future flag names retain their accompanying data by the same rule. */
export function claudePlatformFlag(raw: JsonObject): JsonObject {
  // The discriminator establishes authorship, not a closed catalogue of names
  // or fields. Preserve the complete source notice, including its timestamps.
  return { type: "status", title: "Claude platform flag", text: JSON.stringify(orderJson(raw), null, 2), format: "text" };
}
