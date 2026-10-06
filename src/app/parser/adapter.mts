import type { JsonObject } from "../../core/contracts/types.mts";

export async function mapSequential<T, R>(items: readonly T[], convert: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (const [index, value] of items.entries()) result.push(await convert(value, index));
  return result;
}

export type AdapterProfile = "light" | "full" | "tree" | "container";

export type AdapterRoute = Readonly<{
  format: "exporter-html" | "json-container" | "zip-container" | "json" | "jsonl";
  platform: string;
  payload: string;
  profile: AdapterProfile;
}>;

export type AdapterManifest = Readonly<{
  id: string;
  version: string;
  family: string;
  routes: readonly AdapterRoute[];
  target: "cloudig/conversation/1.0.0" | "cloudig/conversation/1.0.1";
  update_from: readonly Readonly<{
    adapter: string;
    version: string;
    action: "none" | "reparse_source" | "redownload_source" | "upgrade_cloudig" | "unsupported";
  }>[];
}>;

export type SourceMessageFacts = Readonly<{
  id?: string; parent?: string; sourceId?: string; role?: string; name?: string; model?: string; subject?: string;
}>;

/** Extraction-time witnesses before an old consumer's display grouping loses them. */
export type RecordExtractionObserver = Readonly<{
  message(index: number, facts: SourceMessageFacts): void;
  current(id: string): void;
  conversationModel(model: string): void;
  block(value: JsonObject, facts: SourceMessageFacts): void;
}>;

export type AdapterParseContext = Readonly<{
  manifest: JsonObject;
  payload: JsonObject;
  source: Readonly<{
    file: string;
    bytes: number;
    sha256: string;
    fileSystemCapturedAt?: string;
  }>;
  reading?: Readonly<{
    mermaid: readonly Readonly<{
      messageId: string;
      messageVersion?: string;
      resourceKey?: string;
      source: string;
      dataUrl: string;
    }>[];
    images: readonly Readonly<{
      messageId: string;
      messageVersion?: string;
      resourceKey?: string;
      dataUrl: string;
      alt?: string;
      width?: number;
      height?: number;
    }>[];
    files: readonly Readonly<{
      messageId: string;
      messageVersion?: string;
      resourceKey?: string;
      dataUrl: string;
      name?: string;
    }>[];
    fragments: readonly Readonly<{
      messageId: string;
      messageVersion?: string;
      html: string;
    }>[];
  }>;
  onProgress?: (completedItems: number, totalItems: number) => void | Promise<void>;
  record?: RecordExtractionObserver;
}>;

export type SourceAdapter = Readonly<{
  manifest: AdapterManifest;
  readingEvidence?: "static" | "none";
  parse(context: AdapterParseContext): JsonObject | Promise<JsonObject>;
}>;

export type ParsedSourceDraft = Readonly<{
  draft: JsonObject;
  adapter: AdapterManifest;
  sourceFingerprint: Readonly<{ bytes: number; sha256: string }>;
  systemLogErrors: readonly JsonObject[];
  // Private prepared-draft evidence, never serialized into Conversation JSON.
  verifiedResources?: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>;
}>;
