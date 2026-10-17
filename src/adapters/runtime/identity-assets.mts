import { readdir } from "node:fs/promises";
import path from "node:path";

import { resolveManagedPath } from "../storage/path.mts";

const SUPPORTED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export async function listManagedIdentityAssets(libraryRoot: string): Promise<ReadonlySet<string>> {
  const relativeRoot = "Data/Assets/User";
  const directory = await resolveManagedPath(libraryRoot, relativeRoot, { mustExist: true });
  const values = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !SUPPORTED.has(path.extname(entry.name).toLowerCase())) continue;
    values.add(`${relativeRoot}/${entry.name}`);
  }
  return values;
}
