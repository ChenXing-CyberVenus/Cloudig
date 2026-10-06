import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { ConversationViewPageInput, PreparedConversationView } from "../../app/reader/view-model.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import resourceLimits from "../../core/contracts/machine/resource-limits.json" with { type: "json" };
import type { ResolvedArchiveView } from "../../core/library/overlay.mts";
import type { CanonicalConversationFile } from "../reader/index.mts";
import { resolveManagedPath } from "../storage/path.mts";
import { writeOwnedStagingFile } from "../storage/stream.mts";
import { fingerprintFile } from "../storage/stream.mts";
import { materializeRecordResource } from "../reader/record-resource.mts";
import { resolveRecordPath } from "../storage/record-store.mts";
import type { readConversationRecord } from "../library-data/record-reading.mts";
import { prepareRecordConversationView } from "../../app/reader/view-model.mts";
import { recordJsonChunks } from "../../core/records/encoding.mts";

const VIEW_TOKEN = /^v_[A-Za-z0-9_-]{43}$/u;
const ASSET_TOKEN = /^r_[A-Za-z0-9_-]{43}$/u;
const IDENTITY_TOKEN = /^i_[A-Za-z0-9_-]{43}$/u;
const PAGE_TOKEN = /^p_[A-Za-z0-9_-]{43}$/u;

export type RuntimeViewToken = string;

export type RuntimeResourceCapability = Readonly<{
  capability: string;
  virtual_path: string;
  mime: string;
  name?: string;
  bytes: number;
  sha256: string;
}>;

export type RuntimePageCapability = Readonly<{
  capability: string;
  virtual_path: string;
  mime: "application/json";
  bytes: number;
  sha256: string;
}>;

export type RuntimeIdentityCapability =
  | Readonly<{ kind: "application"; asset: string }>
  | Readonly<{ kind: "runtime"; asset: RuntimeResourceCapability }>;

export type OpenRuntimeConversation = Readonly<{
  token: RuntimeViewToken;
  page: RuntimePageCapability;
}>;

type RuntimeAsset = RuntimeResourceCapability & Readonly<{
  kind: "resource";
  resource: string;
  file: string;
}>;

type RuntimePage = RuntimePageCapability & Readonly<{
  kind: "page";
  request_sha256: string;
  file: string;
}>;

type RuntimeIdentityAsset = RuntimeResourceCapability & Readonly<{
  kind: "identity";
  identity: string;
  file: string;
}>;

type RuntimeOwnedFile = RuntimeAsset | RuntimePage | RuntimeIdentityAsset;

type RuntimeManifest = Readonly<{
  owner: string;
  token: string;
  source: Readonly<{ bytes: number; sha256: string }>;
  created_at: string;
  files: readonly RuntimeOwnedFile[];
}> & (Readonly<{ schema: "cloudig/runtime-view/1.0.0"; archive: string; generation: number }> | Readonly<{ schema: "cloudig/runtime-view/2.0.0"; conversation_id: string }>);

type RuntimeFile = Pick<CanonicalConversationFile, "assertStable" | "materializeResource" | "close"> & { index: Pick<CanonicalConversationFile["index"], "conversation" | "fingerprint"> };

type RuntimeSession = {
  token: string;
  directory: string;
  relativeDirectory: string;
  manifest: RuntimeManifest;
  manifestTail: Promise<void>;
  file: RuntimeFile;
  prepared: Pick<PreparedConversationView, "page">;
  identities: Map<string, string>;
  identityAssets: Map<string, RuntimeIdentityCapability>;
  pendingIdentities: Map<string, Promise<RuntimeIdentityCapability>>;
  resources: Map<string, RuntimeResourceCapability>;
  pages: Map<string, RuntimePageCapability>;
  pendingPages: Map<string, Promise<RuntimePageCapability>>;
  pendingResources: Map<string, Promise<RuntimeResourceCapability>>;
  abort: AbortController;
};

export type RuntimeConversationViewsOptions = Readonly<{
  libraryRoot: string;
  runtimeRoot: string;
  now?: () => string;
  token?: (prefix: "e" | "v" | "r" | "i" | "p") => string;
}>;

function defaultToken(prefix: "e" | "v" | "r" | "i" | "p"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function requireToken(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new TypeError(`${label} is not a valid opaque capability`);
}

function extensionForMime(value: string): string {
  switch (value.toLowerCase()) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/svg+xml": return ".svg";
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    default: return ".bin";
  }
}

function mimeForIdentity(reference: string): string {
  const extension = path.extname(reference).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  throw new TypeError("Identity asset type is not supported");
}

function applicationAsset(reference: string): boolean {
  return reference.startsWith("Assets/")
    && !reference.includes("\\")
    && reference.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function writeAtomicJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parseManifest(value: unknown): RuntimeManifest | undefined {
  if (!isJsonObject(value) || !["cloudig/runtime-view/1.0.0", "cloudig/runtime-view/2.0.0"].includes(String(value["schema"]))) return undefined;
  if (typeof value["owner"] !== "string" || typeof value["token"] !== "string") return undefined;
  if (value["schema"] === "cloudig/runtime-view/1.0.0" ? typeof value["archive"] !== "string" || !Number.isSafeInteger(value["generation"]) : typeof value["conversation_id"] !== "string") return undefined;
  if (!isJsonObject(value["source"]) || typeof value["source"]["sha256"] !== "string" || !Number.isSafeInteger(value["source"]["bytes"])) return undefined;
  if (typeof value["created_at"] !== "string" || !Array.isArray(value["files"])) return undefined;
  return value as unknown as RuntimeManifest;
}

function identityCapability(
  reference: string,
  identities: Map<string, string>,
  token: (prefix: "e" | "v" | "r" | "i" | "p") => string
): string {
  for (const [capability, observed] of identities) if (observed === reference) return capability;
  const capability = token("i");
  requireToken(capability, IDENTITY_TOKEN, "Identity token");
  identities.set(capability, reference);
  return capability;
}

export function capabilityResolvedView<T extends Pick<ResolvedArchiveView, "userAvatar" | "assistantAvatar">>(
  resolved: T,
  identities: Map<string, string>,
  token: (prefix: "e" | "v" | "r" | "i" | "p") => string
): T {
  return {
    ...resolved,
    userAvatar: identityCapability(resolved.userAvatar, identities, token),
    assistantAvatar: identityCapability(resolved.assistantAvatar, identities, token)
  };
}

function resourceById(conversation: JsonObject, id: string): JsonObject | undefined {
  if (!Array.isArray(conversation["resources"])) return undefined;
  return conversation["resources"].find((entry): entry is JsonObject => isJsonObject(entry) && entry["id"] === id);
}

async function present(runtimeRoot: string, capability: RuntimeResourceCapability | RuntimePageCapability): Promise<boolean> {
  const file = path.join(runtimeRoot, "Views", ...capability.virtual_path.slice(1).split("/"));
  try { return (await stat(file)).isFile(); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export class RuntimeConversationViews {
  readonly #libraryRoot: string;
  readonly #runtimeRoot: string;
  readonly #now: () => string;
  readonly #token: (prefix: "e" | "v" | "r" | "i" | "p") => string;
  readonly #owner: string;
  readonly #views = new Map<string, RuntimeSession>();
  #current: string | undefined;

  constructor(options: RuntimeConversationViewsOptions) {
    this.#libraryRoot = options.libraryRoot;
    this.#runtimeRoot = options.runtimeRoot;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#token = options.token ?? defaultToken;
    this.#owner = this.#token("e");
    if (!/^e_[A-Za-z0-9_-]{43}$/u.test(this.#owner)) throw new TypeError("Engine owner token is invalid");
  }

  protected newToken(prefix: "e" | "v" | "r" | "i" | "p"): string { return this.#token(prefix); }

  async openRecord(input: Readonly<{ reading: Awaited<ReturnType<typeof readConversationRecord>>; page: ConversationViewPageInput; signal?: AbortSignal; sourceRoot?: string }>): Promise<OpenRuntimeConversation> {
    // sourceRoot is an internal package capability, never a path accepted from UI input.
    const { reading } = input, absolute = await resolveRecordPath(input.sourceRoot ?? this.#libraryRoot, reading.evidence.conversation.path);
    const before = await lstat(absolute, { bigint: true });
    const stamp = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
    const fingerprint = await fingerprintFile(absolute, input.signal);
    if (fingerprint.sha256 !== reading.evidence.conversation.sha256 || stamp(before) !== stamp(await lstat(absolute, { bigint: true }))) throw new TypeError("Conversation changed before opening its resource view");
    let closed = false;
    const stable = async () => { if (closed || stamp(await lstat(absolute, { bigint: true })) !== stamp(before)) throw new TypeError("Conversation changed or view closed"); };
    const file: RuntimeFile = {
      index: { conversation: reading.conversation, fingerprint }, assertStable: stable,
      async materializeResource({ resource, stagingPath, signal }) {
        await stable(); const body = reading.resourceBodies.get(resource); if (!body) throw new TypeError("Resource has no embedded body");
        await materializeRecordResource(absolute, body, stagingPath, signal);
        try { await stable(); } catch (e) { await rm(stagingPath, { force: true }); throw e; }
        return { bytes: body.bytes, sha256: body.sha256 };
      },
      async close() { closed = true; }
    };
    const identities = new Map<string, string>();
    try {
      const prepared = prepareRecordConversationView({ ...reading, resolved: capabilityResolvedView(reading.resolved, identities, this.#token), resolveAgentAvatar: reference => identityCapability(reference, identities, this.#token) });
      return await this.register(file, prepared, identities, { schema: "cloudig/runtime-view/2.0.0", conversation_id: String(reading.conversation["conversation_id"]) }, input.page);
    } catch (error) { await file.close(); throw error; }
  }

  protected async register(file: RuntimeFile, prepared: Pick<PreparedConversationView, "page">, identities: Map<string, string>, identity: Readonly<{ schema: "cloudig/runtime-view/1.0.0"; archive: string; generation: number }> | Readonly<{ schema: "cloudig/runtime-view/2.0.0"; conversation_id: string }>, input: ConversationViewPageInput): Promise<OpenRuntimeConversation> {
    let directory: string | undefined, registeredToken: string | undefined;
    try {
      const viewToken = this.#token("v");
      requireToken(viewToken, VIEW_TOKEN, "View token");
      const relativeDirectory = `Views/${viewToken}`;
      directory = await resolveManagedPath(this.#runtimeRoot, relativeDirectory);
      await mkdir(path.dirname(directory), { recursive: true });
      await mkdir(directory);
      const manifest: RuntimeManifest = {
        ...identity,
        owner: this.#owner,
        token: viewToken,
        source: file.index.fingerprint,
        created_at: this.#now(),
        files: []
      };
      await writeAtomicJson(path.join(directory, "manifest.json"), manifest);
      const session: RuntimeSession = {
        token: viewToken,
        directory,
        relativeDirectory,
        manifest,
        manifestTail: Promise.resolve(),
        file,
        prepared,
        identities,
        identityAssets: new Map(),
        pendingIdentities: new Map(),
        resources: new Map(),
        pages: new Map(),
        pendingPages: new Map(),
        pendingResources: new Map(),
        abort: new AbortController()
      };
      this.#views.set(viewToken, session);
      registeredToken = viewToken;
      const previous = this.#current;
      const page = await this.#publishPage(session, input);
      this.#current = viewToken;
      if (previous && previous !== viewToken) await this.close(previous);
      return { token: viewToken, page };
    } catch (error) {
      if (registeredToken) {
        this.#views.delete(registeredToken);
        if (this.#current === registeredToken) this.#current = undefined;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  #session(token: string): RuntimeSession {
    requireToken(token, VIEW_TOKEN, "View token");
    const session = this.#views.get(token);
    if (!session || token !== this.#current) throw new TypeError("Runtime view capability is stale or revoked");
    return session;
  }

  #appendManifestFile(session: RuntimeSession, owned: RuntimeManifest["files"][number]): Promise<void> {
    // Bytes can be prepared concurrently; publishing their one shared index
    // cannot. Construct each next value after the preceding publish completes.
    const update = session.manifestTail.then(async () => {
      session.abort.signal.throwIfAborted();
      const manifest = { ...session.manifest, files: [...session.manifest.files, owned] };
      await writeAtomicJson(path.join(session.directory, "manifest.json"), manifest);
      session.manifest = manifest;
    });
    session.manifestTail = update.catch(() => undefined);
    return update;
  }

  async #writePage(
    session: RuntimeSession,
    input: ConversationViewPageInput,
    requestSha256: string
  ): Promise<RuntimePageCapability> {
    const value = session.prepared.page(input);
    const capability = this.#token("p");
    requireToken(capability, PAGE_TOKEN, "Page token");
    const file = `pages/${capability}.json`;
    const pagesDirectory = path.join(session.directory, "pages");
    await mkdir(pagesDirectory, { recursive: true });
    const target = path.join(session.directory, ...file.split("/"));
    const fingerprint = await writeOwnedStagingFile(Readable.from(recordJsonChunks(value)), target, { signal: session.abort.signal });
    const result: RuntimePageCapability = {
      capability,
      virtual_path: `/${session.token}/${file}`,
      mime: "application/json",
      ...fingerprint
    };
    const owned: RuntimePage = { ...result, kind: "page", request_sha256: requestSha256, file };
    try {
      await this.#appendManifestFile(session, owned);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    session.pages.set(requestSha256, result);
    return result;
  }

  async #publishPage(session: RuntimeSession, input: ConversationViewPageInput): Promise<RuntimePageCapability> {
    const requestSha256 = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await session.file.assertStable();
    const existing = session.pages.get(requestSha256);
    if (existing && await present(this.#runtimeRoot, existing)) return existing;
    const pending = session.pendingPages.get(requestSha256);
    if (pending) return pending;
    const task = this.#writePage(session, input, requestSha256);
    session.pendingPages.set(requestSha256, task);
    try {
      return await task;
    } finally {
      session.pendingPages.delete(requestSha256);
    }
  }

  async page(token: string, input: ConversationViewPageInput): Promise<RuntimePageCapability> {
    return this.#publishPage(this.#session(token), input);
  }

  identityReference(token: string, capability: string): string {
    const session = this.#session(token);
    requireToken(capability, IDENTITY_TOKEN, "Identity token");
    const reference = session.identities.get(capability);
    if (!reference) throw new TypeError("Identity capability is stale or unknown");
    return reference;
  }

  async #resolveIdentity(
    session: RuntimeSession,
    identity: string,
    signal?: AbortSignal
  ): Promise<RuntimeIdentityCapability> {
    const reference = session.identities.get(identity);
    if (!reference) throw new TypeError("Identity capability is stale or unknown");
    if (applicationAsset(reference)) {
      const result: RuntimeIdentityCapability = { kind: "application", asset: reference };
      session.identityAssets.set(identity, result);
      return result;
    }
    const userPrefix = session.manifest.schema === "cloudig/runtime-view/2.0.0" ? "Identities/Images/" : "Data/Assets/User/";
    if (!reference.startsWith(userPrefix)) throw new TypeError("Identity asset is outside the managed asset roots");
    const source = await resolveManagedPath(this.#libraryRoot, reference, { mustExist: true });
    const before = await stat(source, { bigint: true });
    if (!before.isFile() || before.size > BigInt(resourceLimits.avatar_file_max_bytes)) throw new RangeError("Identity asset exceeds the configured bound");
    const mime = mimeForIdentity(reference);
    const capability = this.#token("r");
    requireToken(capability, ASSET_TOKEN, "Identity resource token");
    const file = `assets/${capability}${extensionForMime(mime)}`;
    await mkdir(path.join(session.directory, "assets"), { recursive: true });
    const target = path.join(session.directory, ...file.split("/"));
    const combined = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
    const fingerprint = await writeOwnedStagingFile(createReadStream(source), target, { signal: combined });
    const after = await stat(source, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      await rm(target, { force: true });
      throw new TypeError("Identity asset changed while it was materialized");
    }
    const asset: RuntimeResourceCapability = {
      capability,
      virtual_path: `/${session.token}/${file}`,
      mime,
      name: path.basename(reference),
      ...fingerprint
    };
    const owned: RuntimeIdentityAsset = { ...asset, kind: "identity", identity, file };
    try {
      await this.#appendManifestFile(session, owned);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    const result: RuntimeIdentityCapability = { kind: "runtime", asset };
    session.identityAssets.set(identity, result);
    return result;
  }

  async resolveIdentity(input: Readonly<{
    token: string;
    identity: string;
    signal?: AbortSignal;
  }>): Promise<RuntimeIdentityCapability> {
    const session = this.#session(input.token);
    requireToken(input.identity, IDENTITY_TOKEN, "Identity token");
    const existing = session.identityAssets.get(input.identity);
    if (existing && (existing.kind === "application" || await present(this.#runtimeRoot, existing.asset))) return existing;
    const pending = session.pendingIdentities.get(input.identity);
    if (pending) return pending;
    const task = this.#resolveIdentity(session, input.identity, input.signal);
    session.pendingIdentities.set(input.identity, task);
    try {
      return await task;
    } finally {
      session.pendingIdentities.delete(input.identity);
    }
  }

  async #materialize(
    session: RuntimeSession,
    resourceId: string,
    signal?: AbortSignal
  ): Promise<RuntimeResourceCapability> {
    const resource = resourceById(session.file.index.conversation, resourceId);
    if (!resource || resource["availability"] !== "embedded") throw new TypeError("Resource is not an embedded body in this view");
    const mime = typeof resource["mime"] === "string" ? resource["mime"] : "application/octet-stream";
    const capability = this.#token("r");
    requireToken(capability, ASSET_TOKEN, "Resource token");
    const file = `${capability}${extensionForMime(mime)}`;
    const assetsDirectory = path.join(session.directory, "assets");
    await mkdir(assetsDirectory, { recursive: true });
    const target = path.join(assetsDirectory, file);
    const combined = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
    const fingerprint = await session.file.materializeResource({
      resource: resourceId,
      stagingPath: target,
      signal: combined
    });
    const result: RuntimeResourceCapability = {
      capability,
      virtual_path: `/${session.token}/assets/${file}`,
      mime,
      ...(typeof resource["name"] === "string" ? { name: resource["name"] } : {}),
      ...fingerprint
    };
    const owned: RuntimeAsset = { ...result, kind: "resource", resource: resourceId, file: `assets/${file}` };
    try {
      await this.#appendManifestFile(session, owned);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    session.resources.set(resourceId, result);
    return result;
  }

  async materializeResource(input: Readonly<{
    token: string;
    resource: string;
    signal?: AbortSignal;
  }>): Promise<RuntimeResourceCapability> {
    const session = this.#session(input.token);
    const existing = session.resources.get(input.resource);
    if (existing && await present(this.#runtimeRoot, existing)) return existing;
    const pending = session.pendingResources.get(input.resource);
    if (pending) return pending;
    const task = this.#materialize(session, input.resource, input.signal);
    session.pendingResources.set(input.resource, task);
    try {
      return await task;
    } finally {
      session.pendingResources.delete(input.resource);
    }
  }

  async close(token: string): Promise<"removed" | "ownership_lost" | "absent"> {
    const session = this.#views.get(token);
    if (!session) return "absent";
    this.#views.delete(token);
    if (this.#current === token) this.#current = undefined;
    session.abort.abort(new DOMException("Runtime view was revoked", "AbortError"));
    await Promise.allSettled([
      ...session.pendingResources.values(),
      ...session.pendingIdentities.values(),
      ...session.pendingPages.values()
    ]);
    await session.file.close();
    let manifest: RuntimeManifest | undefined;
    try {
      manifest = parseManifest(JSON.parse(await readFile(path.join(session.directory, "manifest.json"), "utf8")) as unknown);
    } catch {
      return "ownership_lost";
    }
    if (!manifest || manifest.owner !== this.#owner || manifest.token !== token) return "ownership_lost";
    await rm(session.directory, { recursive: true });
    return "removed";
  }

  async closeAll(): Promise<void> {
    for (const token of [...this.#views.keys()]) await this.close(token);
  }
}
