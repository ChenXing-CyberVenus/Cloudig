import type { JsonObject } from "../contracts/types.mts";
import presets from "./front-presets.json" with { type: "json" };

// Agent Tool sources are source-local platform families, not additions to the
// user's twelve-platform identity settings.  Keep their fixed fallback Fronts
// here so existing settings stay closed while Conversation identity remains
// resolvable for imported Agent JSON/JSONL.
const AGENT_FRONTS: Readonly<Record<string, JsonObject>> = {
  cline: { schema: "cloudig/identity/1.0.0", names: [{ name: "Cline", claimers: [{ name: "Cline" }] }], kind: { world: "terran", subject: "ai" }, role: "assistant", display_name: 1 },
  sillytavern: { schema: "cloudig/identity/1.0.0", names: [{ name: "SillyTavern", claimers: [{ name: "SillyTavern" }] }], kind: { world: "terran", subject: "ai" }, role: "assistant", display_name: 1 },
  "kimi-code": { schema: "cloudig/identity/1.0.0", names: [{ name: "Kimi Code", claimers: [{ name: "月之暗面" }] }], kind: { world: "terran", subject: "ai" }, role: "assistant", display_name: 1 },
  "claude-code": { schema: "cloudig/identity/1.0.0", names: [{ name: "Claude Code", claimers: [{ name: "Anthropic" }] }], kind: { world: "terran", subject: "ai" }, role: "assistant", display_name: 1 },
  codex: { schema: "cloudig/identity/1.0.0", names: [{ name: "Codex", claimers: [{ name: "OpenAI" }] }], kind: { world: "terran", subject: "ai" }, role: "assistant", display_name: 1 }
};

export function frontName(front: JsonObject | undefined): string | undefined {
  const names = front?.["names"] as JsonObject[] | undefined;
  const selected = front?.["display_name"];
  return typeof selected === "number" ? names?.[selected - 1]?.["name"] as string | undefined : undefined;
}

/** A cross-thread Agent instance is local to this Conversation, not the platform itself. */
export function isAgentInstanceSourceId(sourceId: string | undefined): boolean {
  return typeof sourceId === "string" && sourceId.startsWith("agent-thread:");
}

export function findPlatformFront(platform: string): JsonObject | undefined {
  const found = presets.presets.find(p => p.usage === "platform_fallback" && "platform" in p && p.platform === platform);
  return found ? structuredClone(found.identity) as JsonObject : AGENT_FRONTS[platform] ? structuredClone(AGENT_FRONTS[platform]) : undefined;
}

export function platformFront(platform: string): JsonObject {
  const found = findPlatformFront(platform);
  if (!found) throw new TypeError(`No declared platform Front for ${platform}`);
  return found;
}

/** Source-local identity declarations; invocation IDs never become actor IDs. */
export class SourceFronts {
  readonly values: JsonObject[] = [];
  readonly #keys = new Map<string, string>();
  readonly #platform: JsonObject;
  constructor(platform: string) { this.#platform = platformFront(platform); }

  get(input: Readonly<{ role: string; name?: string; sourceId?: string; subject?: string }>): string {
    const { role } = input;
    const subject = role === "tool" || role === "system" ? "program" : role === "user" ? "human" : role === "assistant" ? "ai" : input.subject;
    if (!subject) throw new TypeError(`Source role ${role} requires an explicit kind`);
    const agentInstance = isAgentInstanceSourceId(input.sourceId);
    const name = input.name ?? (role === "assistant" && !agentInstance ? frontName(this.#platform) : undefined);
    const key = JSON.stringify([input.sourceId ?? null, role, subject, name ?? null]);
    const known = this.#keys.get(key); if (known) return known;
    const stem = input.sourceId ?? `${role}:${name ?? "unnamed"}`;
    let id = stem, suffix = 2;
    while (this.values.some(f => f["source_id"] === id)) id = `${stem}:${suffix++}`;
    const claimers = agentInstance
      ? []
      : role === "assistant" || role === "tool" || role === "system"
      ? structuredClone((this.#platform["names"] as JsonObject[])[0]!["claimers"]!) : [];
    this.values.push({ schema: "cloudig/identity/1.0.0", source_id: id,
      names: name ? [{ name, claimers }] : [], ...(name ? { display_name: 1 } : {}),
      kind: { world: "terran", subject }, role });
    this.#keys.set(key, id); return id;
  }
}

export function userModelFront(name: string, userId: string, timestamp: string): JsonObject {
  return { schema: "cloudig/identity/1.0.0", names: [{ name, claimers: [{ front: userId }] }], display_name: 1,
    kind: { world: "terran", subject: "ai" }, role: "assistant", created_at: timestamp, edited_at: timestamp };
}
