import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:net";

export type SingleWriter = Readonly<{
  endpoint: string;
  release: () => Promise<void>;
}>;

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function singleWriterEndpoint(libraryRoot: string): Promise<string> {
  const root = await realpath(libraryRoot);
  const key = createHash("sha256").update(root.toLocaleLowerCase("en-US"), "utf8").digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\Cloudig-V1-Writer-${key}`;
}

export async function requireNoPendingMove(libraryRoot: string): Promise<void> {
  try { await access(path.join(libraryRoot, "appdata/Move/request.json")); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  throw Object.assign(new Error("采云有未完成的整体搬迁，请先完成或取消搬迁；没有继续读写资料库。"), { code: "CLOUDIG_LIBRARY_MOVE_PENDING" });
}

// Only ordinary in-process record operations opt into this queue. Explicit
// native leases and other processes still fail immediately on pipe ownership.
const localWriters = new Map<string, Promise<void>>();
export async function acquireSingleWriter(libraryRoot: string, options: Readonly<{ waitForLocal?: boolean }> = {}): Promise<SingleWriter> {
  if (process.platform !== "win32") throw new Error("Cloudig V1 single-writer adapter currently requires Windows named pipes");
  const endpoint = await singleWriterEndpoint(libraryRoot);
  let releaseLocal = () => {};
  if (options.waitForLocal) {
    const previous = localWriters.get(endpoint) ?? Promise.resolve();
    let complete!: () => void;
    const ticket = new Promise<void>(resolve => { complete = resolve; });
    const tail = previous.then(() => ticket);
    localWriters.set(endpoint, tail);
    releaseLocal = () => { complete(); if (localWriters.get(endpoint) === tail) localWriters.delete(endpoint); };
    await previous;
  }
  const server = createServer();
  try { await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  server.unref();
  try { await requireNoPendingMove(libraryRoot); } catch (error) { await close(server); throw error; }
  } catch (error) { releaseLocal(); throw error; }
  let released = false;
  return {
    endpoint,
    release: async () => {
      if (released) return;
      released = true;
      try { await close(server); } finally { releaseLocal(); }
    }
  };
}
