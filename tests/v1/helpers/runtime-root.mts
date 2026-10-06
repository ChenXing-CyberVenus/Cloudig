import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after } from "node:test";
const roots = new Set<string>();
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

// Owned by the caller's disposable test root, never system Temp or a real Library.
export function testRuntimeRoot(root: string): string {
  const result = path.join(path.dirname(root), `.cache-${path.basename(root)}`);
  mkdirSync(result, { recursive: true });
  roots.add(result);
  return result;
}
