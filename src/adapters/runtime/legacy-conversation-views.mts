// Old aN/AuthorityPair entry retained for inventory characterization only.
// The production record Engine imports conversation-views.mts directly.
import { RuntimeConversationViews, capabilityResolvedView, type RuntimeConversationViewsOptions, type OpenRuntimeConversation } from "./conversation-views.mts";
import { prepareConversationView, type ConversationViewPageInput } from "../../app/reader/view-model.mts";
import { resolveArchiveView, type BuiltinIdentity } from "../../core/library/overlay.mts";
import { openCanonicalConversationFile } from "../reader/conversation-file.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { readCurrentAuthorityPair } from "../storage/recovery-point.mts";

export type LegacyRuntimeConversationViewsOptions = RuntimeConversationViewsOptions & Readonly<{
  builtins: BuiltinIdentity; availableAssets: ReadonlySet<string>;
}>;

export class LegacyRuntimeConversationViews extends RuntimeConversationViews {
  readonly #legacy: LegacyRuntimeConversationViewsOptions;
  constructor(options: LegacyRuntimeConversationViewsOptions) { super(options); this.#legacy = options; }
  async open(input: Readonly<{
    relativePath: string; expectedArchive?: string; expectedGeneration?: number;
    expectedFingerprint?: Readonly<{ bytes: number; sha256: string }>;
    page: ConversationViewPageInput; signal?: AbortSignal;
  }>): Promise<OpenRuntimeConversation> {
    if (!input.relativePath.startsWith("Conversations/") || !input.relativePath.toLowerCase().endsWith(".json")) throw new TypeError("Runtime view requires one exact active Conversation path");
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Operation aborted", "AbortError");
    const absolute = await resolveManagedPath(this.#legacy.libraryRoot, input.relativePath, { mustExist: true });
    const file = await openCanonicalConversationFile({ filePath: absolute, ...(input.signal ? { signal: input.signal } : {}) });
    try {
      const conversation = file.index.conversation, archive = String(conversation["archive"]), generation = Number(conversation["generation"]);
      if (input.expectedArchive !== undefined && archive !== input.expectedArchive) throw new TypeError("Archive capability no longer matches the selected Conversation");
      if (input.expectedGeneration !== undefined && generation !== input.expectedGeneration) throw new TypeError("Archive generation changed before the view opened");
      if (input.expectedFingerprint && (file.index.fingerprint.bytes !== input.expectedFingerprint.bytes || file.index.fingerprint.sha256 !== input.expectedFingerprint.sha256)) throw new TypeError("Archive bytes changed before the view opened");
      const authority = await readCurrentAuthorityPair(this.#legacy.libraryRoot);
      const resolved = resolveArchiveView(conversation, authority.library, this.#legacy.builtins, this.#legacy.availableAssets);
      const identities = new Map<string, string>();
      const prepared = prepareConversationView({ conversation, resourceBodies: file.index.resourceBodies, resolved: capabilityResolvedView(resolved, identities, prefix => this.newToken(prefix)) });
      return await this.register(file, prepared, identities, { schema: "cloudig/runtime-view/1.0.0", archive, generation }, input.page);
    } catch (error) { await file.close(); throw error; }
  }
}
