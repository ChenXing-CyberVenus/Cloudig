/** Capture inference for the supported platform exports; not a constraint on authored or message time. */
export const SOURCE_CAPTURE_LIMITS = Object.freeze({ earliestUtc: "2020-01-01T00:00:00.000Z" });
const earliest = Date.parse(SOURCE_CAPTURE_LIMITS.earliestUtc);
export type CapturedSourceTime = Readonly<{ at: string; from: string }>;

export function validCaptureTime(value: unknown): string | undefined {
  const milliseconds = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && milliseconds >= earliest ? date.toISOString() : undefined;
}

export function fileTimesCapture(created: unknown, modified: unknown): CapturedSourceTime | undefined {
  const creation = validCaptureTime(created), write = validCaptureTime(modified);
  if (creation && (!write || Date.parse(creation) <= Date.parse(write))) return { at: creation, from: "filesystem:creation_time" };
  return write ? { at: write, from: "filesystem:last_write_time" } : undefined;
}

export function exporterCapture(manifest: Readonly<Record<string, unknown>>, payload: Readonly<Record<string, unknown>> = {}): CapturedSourceTime | undefined {
  for (const [name, value] of [["manifest", manifest], ["payload", payload]] as const) {
    for (const key of ["captured_at", "exported_at"] as const) {
      const at = validCaptureTime(value[key]);
      if (at) return { at, from: `bookmark:${name}.${key}` };
    }
  }
  return undefined;
}
