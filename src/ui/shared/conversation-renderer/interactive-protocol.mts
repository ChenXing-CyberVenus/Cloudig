/** Runtime policy, not Conversation fields. No source code runs in the Parser. */
export const INTERACTIVE_LIMITS = Object.freeze({
  statePerWorkBytes: 5 * 1024 * 1024,
  statePerApplicationBytes: 32 * 1024 * 1024,
  loadTimeoutMs: 20_000,
  errorMessageCharacters: 1024,
  inlineMinimumHeight: 120,
  inlineMaximumHeight: 640,
  assetMemoryBytes: 64 * 1024 * 1024,
  assetReadConcurrency: 4
});
export const INTERACTIVE_PROTOCOL = "cloudig/interactive-runtime/1";
export type InteractiveFile = Readonly<{ path: string; mime: string; bytes: ArrayBuffer; aliases?: readonly string[] }>;
export type InteractiveState = Readonly<Record<string, string>>;
export type InteractiveFormat = "html" | "react" | "document" | "slides" | "design" | "design-system" | "svg";
export type InteractivePackage = Readonly<{
  protocol: typeof INTERACTIVE_PROTOCOL;
  token: string;
  entry: string;
  format?: InteractiveFormat;
  source?: string;
  icons?: readonly Readonly<{ name: string; path: string }>[];
  files: readonly InteractiveFile[];
  fontCss?: string;
  state: InteractiveState;
  theme: "dawn" | "star-night";
  language?: "zh" | "en";
  scrollCss?: string;
}>;

// The user explicitly chose session-only progress for 1.0.2. This map is never
// written to cache, WebView localStorage, Conversation, Mark or an export file.
const workStates = new Map<string, { state: InteractiveState; bytes: number }>();
let stateBytes = 0;
export function readInteractiveState(key: string): InteractiveState { return { ...workStates.get(key)?.state }; }
export function saveInteractiveState(key: string, state: unknown): void {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("Invalid interactive progress");
  const copy: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(state)) { if (typeof value !== "string") throw new TypeError("Invalid interactive progress value"); copy[name] = value; }
  const bytes = new TextEncoder().encode(JSON.stringify(copy)).byteLength, previous = workStates.get(key)?.bytes ?? 0;
  if (bytes > INTERACTIVE_LIMITS.statePerWorkBytes || stateBytes - previous + bytes > INTERACTIVE_LIMITS.statePerApplicationBytes) throw new RangeError("Interactive session progress is full");
  if (!Object.keys(copy).length) { workStates.delete(key); stateBytes -= previous; return; }
  workStates.set(key, { state: copy, bytes }); stateBytes += bytes - previous;
}
