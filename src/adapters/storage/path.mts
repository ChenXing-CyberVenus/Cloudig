import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function canonicalCase(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = canonicalCase(path.resolve(root));
  const normalizedCandidate = canonicalCase(path.resolve(candidate));
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function parseManagedRelativePath(relativePath: string): readonly string[] {
  if (relativePath.length === 0 || relativePath.length > 1024) throw new TypeError("Managed path length is invalid");
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/u.test(relativePath) || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new TypeError("Managed paths must use confined forward-slash relative syntax");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("Managed paths cannot contain empty, dot, or parent segments");
  }
  return segments;
}

async function nearestExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = candidate;
  while (inside(root, current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new TypeError("No confined existing ancestor for managed path");
}

export async function resolveManagedPath(
  libraryRoot: string,
  relativePath: string,
  options: Readonly<{ mustExist?: boolean }> = {}
): Promise<string> {
  const rootReal = await realpath(libraryRoot);
  const candidate = path.resolve(rootReal, ...parseManagedRelativePath(relativePath));
  if (!inside(rootReal, candidate)) throw new TypeError("Managed path escapes the Library root");
  const ancestor = await nearestExistingAncestor(candidate, rootReal);
  const ancestorReal = await realpath(ancestor);
  if (!inside(rootReal, ancestorReal)) throw new TypeError("Managed path crosses a reparse point outside the Library root");
  if (options.mustExist && ancestor !== candidate) {
    const candidateReal = await realpath(candidate);
    if (!inside(rootReal, candidateReal)) throw new TypeError("Managed target resolves outside the Library root");
  }
  return candidate;
}
