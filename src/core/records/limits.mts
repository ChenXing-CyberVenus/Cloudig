// Reuse the already named, versioned numeric policy; do not bury a second time limit table in validators.
import timeLimits from "../contracts/machine/time-limits.json" with { type: "json" };
export const RECORD_TIME_LIMITS = Object.freeze(timeLimits);
export const RELATIVE_MAX_TENTHS = BigInt(timeLimits.relative.coefficient_max.replace(".", ""));
