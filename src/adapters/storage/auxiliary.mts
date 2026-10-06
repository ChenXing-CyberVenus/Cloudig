import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { resolveManagedPath } from "./path.mts";
import { fingerprintFile, type ByteFingerprint } from "./stream.mts";

async function fingerprintIfExists(filePath: string): Promise<ByteFingerprint | undefined> {
  try { return await fingerprintFile(filePath); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function same(left: ByteFingerprint | undefined, right: ByteFingerprint | undefined): boolean {
  return left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

export async function writeAuxiliarySnapshot(
  libraryRoot: string,
  relativePath: string,
  bytes: Buffer,
  expectedBefore: ByteFingerprint | undefined,
  options: Readonly<{ durable?: boolean }> = {}
): Promise<"written" | "conflict"> {
  const target = await resolveManagedPath(libraryRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      if (options.durable !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    if (!same(await fingerprintIfExists(target), expectedBefore)) return "conflict";
    await rename(temporary, target);
    return "written";
  } finally {
    if (created) {
      try { await unlink(temporary); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

export async function observeAuxiliarySnapshot(libraryRoot: string, relativePath: string): Promise<ByteFingerprint | undefined> {
  const target = await resolveManagedPath(libraryRoot, relativePath);
  return fingerprintIfExists(target);
}
