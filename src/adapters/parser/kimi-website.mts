import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

/** Match a saved project to this version's file operations. Never execute its
 * shell commands, package scripts or server code, nor assume workspace=version. */
export function kimiWebsiteSnapshot(raw: JsonObject, archive: Record<string, Uint8Array>): Record<string, Uint8Array> | undefined {
  const directory = String(raw["project_dir"] ?? "").replace(/\/+$/u, "") + "/";
  if (directory === "/" || !Array.isArray(raw["version_evidence"])) return;
  const known = new Map<string, string>();
  for (const item of raw["version_evidence"]) {
    if (!isJsonObject(item) || !isJsonObject(item["native"])) continue;
    const call = item["native"]; if (call["isError"] === true) continue;
    let args: JsonObject;
    try { const v = typeof call["args"] === "string" ? JSON.parse(call["args"]) : call["args"]; if (!isJsonObject(v)) continue; args = v; } catch { continue; }
    const absolute = String(args["file_path"] ?? ""); if (!absolute.startsWith(directory)) continue;
    const name = absolute.slice(directory.length); if (!/^(?:src\/|index\.html$|package\.json$)/u.test(name)) continue;
    if (call["name"] === "write_file" && typeof args["content"] === "string") {
      if (args["append"] === true && !known.has(name)) continue;
      known.set(name, (args["append"] === true ? known.get(name)! : "") + args["content"]);
    }
    else if (call["name"] === "edit_file") {
      const before = known.get(name), old = args["old_string"], next = args["new_string"];
      if (before === undefined || typeof old !== "string" || !old || typeof next !== "string" || !before.includes(old)) { known.delete(name); continue; }
      if (before.indexOf(old) !== before.lastIndexOf(old) && args["replace_all"] !== true) { known.delete(name); continue; }
      known.set(name, args["replace_all"] === true ? before.replaceAll(old, next) : before.replace(old, next));
    } else if (call["name"] === "read_file" && Array.isArray(call["contents"])) {
      const output = call["contents"].filter(isJsonObject).flatMap(c => isJsonObject(c["content"]) && c["content"]["case"] === "text" && typeof c["content"]["value"] === "string" ? [c["content"]["value"]] : []).join("\n");
      if (/<response clipped>|<NOTE>Lines longer than|\[.*truncated.*\]/iu.test(output)) continue;
      const lines = output.split("\n"), numbered = lines.map(l => /^\s*(\d+)\t(.*)$/u.exec(l));
      if (numbered.length && numbered.every((m, i) => m && Number(m[1]) === i + 1) && (!args["limit"] || numbered.length < Number(args["limit"]))) known.set(name, numbered.map(m => m![2]).join("\n"));
    }
  }
  // A lone common bootstrap is insufficient to identify a version.
  const witnesses = [...known].filter(([name]) => /^src\/.*\.(?:tsx?|jsx?|css)$/u.test(name));
  if (witnesses.length < 2) return;
  const normalize = (value: string) => value.replace(/\r\n/gu, "\n").trimEnd();
  const roots = Object.keys(archive).filter(n => n.endsWith("/index.html")).map(n => n.slice(0, -10));
  const matches = roots.filter(root => witnesses.every(([path, source]) => archive[root + path] && normalize(new TextDecoder().decode(archive[root + path])) === normalize(source)));
  if (matches.length !== 1) return;
  const root = matches[0]!;
  // Only frontend source/assets are replayed; secrets and backend files remain
  // in the untouched source package and are not sent to the work's browser.
  return Object.fromEntries(Object.entries(archive).filter(([path]) => path.startsWith(root) && /^(?:src\/|public\/|assets\/|contracts\/|index\.html$|package\.json$)/u.test(path.slice(root.length)))
    .map(([path, bytes]) => [path.slice(root.length), bytes]));
}
