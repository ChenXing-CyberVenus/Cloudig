import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const rootEntries = new Set(["Cloudig.exe", "app", "bookmarks", "docs", "LICENSE", "NOTICE.md"]);
const maybeStat = target => lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
async function unlinkedAncestors(target) {
  for (let at = path.resolve(target);; at = path.dirname(at)) {
    if ((await maybeStat(at))?.isSymbolicLink()) throw new Error(`Program installation path is a link: ${at}`);
    if (path.dirname(at) === at) break;
  }
}
async function files(directory, prefix = "") {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`A program component contains a link: ${relative}`);
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), relative));
    else if (item.isFile()) result.push(relative);
    else throw new Error(`A program component is not a regular file: ${relative}`);
  }
  return result;
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function retiredExampleCopies(payload, publish) {
  const manifestPath = path.join(payload, "docs/examples/manifest.json");
  if (!(await maybeStat(manifestPath))) return [];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.distribution !== "online") return [];
  if (manifest.format !== "cloudig/public-examples/1" || !Array.isArray(manifest.examples)) throw new Error("Invalid online example catalog");
  const result = [], seen = new Set();
  for (const row of manifest.examples) for (const kind of ["html", "record"]) {
    const entry = row[kind], relative = `docs/examples/${entry?.path}`;
    if (!/^example-[a-f0-9]{20}$/u.test(row.id) || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")
      || (kind === "html" ? !/^[^/\\:*?"<>|\u0000-\u001f]+\.html$/u.test(entry.file ?? "") || entry.path !== `html/${entry.file}` : entry.path !== `records/${row.id}.json`)
      || seen.has(relative)) throw new Error("Invalid managed example path or digest");
    seen.add(relative);
    // Only copies identical to the newly verified, authoritative catalog are
    // obsolete. Modified files and unrelated docs are user material, not ours.
    const target = path.join(publish, relative); await unlinkedAncestors(target);
    const info = await maybeStat(target); if (!info?.isFile() || info.size !== entry.bytes) continue;
    if (digest(await readFile(target)) === entry.sha256) result.push({ relative, bytes: entry.bytes, sha256: entry.sha256 });
  }
  return result;
}
export async function installV1ProgramFiles(payloadRoot, publishRoot, { beforeInstall } = {}) {
  const payload = path.resolve(payloadRoot), publish = path.resolve(publishRoot);
  if (payload === publish || path.dirname(payload) !== path.dirname(publish)) throw new Error("Program replacement needs distinct sibling build directories");
  await unlinkedAncestors(payload); await unlinkedAncestors(publish);
  const entries = await readdir(payload);
  if (entries.some(name => !rootEntries.has(name))) throw new Error("A program payload cannot contain portable user data or unknown root entries");
  for (const name of entries) if ((await lstat(path.join(payload, name))).isSymbolicLink()) throw new Error(`A program payload entry is a link: ${name}`);
  for (const directory of ["app", "bookmarks", "docs"]) {
    if (!(await lstat(path.join(payload, directory))).isDirectory()) throw new Error(`Missing program directory: ${directory}`);
    await files(path.join(payload, directory));
  }
  for (const file of ["Cloudig.exe", "app/Cloudig.dll", "app/hostfxr.dll"]) {
    const info = await lstat(path.join(payload, file));
    if (!info.isFile() || info.size === 0) throw new Error(`Completed program payload is missing ${file}`);
  }
  try { const unlocked = await open(path.join(publish, "Cloudig.exe"), "r+"); await unlocked.close(); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Close the fixed Cloudig executable before replacing its program files", { cause: error }); }
  // docs/ can also hold user material; replace only files shipped by this build.
  const components = ["app", "bookmarks", ...(await files(path.join(payload, "docs"))).map(file => `docs/${file}`), ...entries.filter(name => !["app", "bookmarks", "docs"].includes(name))];
  const retired = await retiredExampleCopies(payload, publish);
  if (retired.some(item => components.includes(item.relative))) throw new Error("Online payload still contains an example body");
  for (const relative of components) {
    const target = path.join(publish, relative); await unlinkedAncestors(target);
    const previous = await maybeStat(target);
    if (previous?.isDirectory()) await files(target);
    if (previous && previous.isDirectory() !== ["app", "bookmarks"].includes(relative)) throw new Error(`Program target kind changed: ${relative}`);
  }
  const stage = await mkdtemp(path.join(path.dirname(payload), "program-install-")), changed = []; let removable = true;
  try {
    await mkdir(publish, { recursive: true });
    for (const relative of components) {
      const next = path.join(stage, "next", relative); await mkdir(path.dirname(next), { recursive: true });
      await cp(path.join(payload, relative), next, { recursive: true });
    }
    for (const relative of components) {
      await beforeInstall?.(relative);
      const target = path.join(publish, relative), previous = path.join(stage, "previous", relative);
      await mkdir(path.dirname(target), { recursive: true });
      const item = { target, previous, installed: false, displaced: false }; changed.push(item);
      if (await maybeStat(target)) { await mkdir(path.dirname(previous), { recursive: true }); await rename(target, previous); item.displaced = true; }
      await rename(path.join(stage, "next", relative), target); item.installed = true;
    }
    for (const obsolete of retired) {
      await beforeInstall?.(obsolete.relative);
      const target = path.join(publish, obsolete.relative), previous = path.join(stage, "previous", obsolete.relative);
      await unlinkedAncestors(target); await mkdir(path.dirname(previous), { recursive: true });
      const item = { target, previous, installed: false, displaced: false }; changed.push(item);
      await rename(target, previous); item.displaced = true;
      const bytes = await readFile(previous);
      if (bytes.length !== obsolete.bytes || digest(bytes) !== obsolete.sha256) throw new Error(`Example changed during program replacement: ${obsolete.relative}`);
    }
    if (!(await stat(path.join(publish, "Cloudig.exe"))).isFile()) throw new Error("Installed entry is unavailable");
  } catch (error) {
    const failures = [];
    for (const item of changed.reverse()) {
      try { if (item.installed) await rm(item.target, { recursive: true }); if (item.displaced) await rename(item.previous, item.target); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length) { removable = false; throw new AggregateError([error, ...failures], `Program rollback needs inspection; preserved bytes: ${stage}`); }
    throw error;
  } finally { if (removable) await rm(stage, { recursive: true }); }
}
