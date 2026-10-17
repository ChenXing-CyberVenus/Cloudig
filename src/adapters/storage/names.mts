export const MAX_WINDOWS_LEAF_UNITS = 240;

export function safeWindowsLeaf(value: string, label: string): string {
  if (
    value.length === 0
    || value.length > MAX_WINDOWS_LEAF_UNITS
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(value)
    || /[ .]$/u.test(value)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value)
  ) throw new TypeError(`Invalid ${label}`);
  return value;
}

export function chooseNoReplaceLeaf(requested: string, occupied: ReadonlySet<string>): string {
  const filename = safeWindowsLeaf(requested, "filename");
  const folded = new Set([...occupied].map((entry) => entry.toLocaleLowerCase("en-US")));
  if (!folded.has(filename.toLocaleLowerCase("en-US"))) return filename;

  const extensionAt = filename.lastIndexOf(".");
  const stem = extensionAt > 0 ? filename.slice(0, extensionAt) : filename;
  const extension = extensionAt > 0 ? filename.slice(extensionAt) : "";
  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const suffix = ` (${index})`;
    const maximumStem = MAX_WINDOWS_LEAF_UNITS - suffix.length - extension.length;
    if (maximumStem < 1) throw new TypeError("Filename extension leaves no room for a collision-safe suffix");
    // Windows limits UTF-16 units, not Unicode code points. Keep whole code
    // points while reserving the suffix, including for astral characters.
    let prefix = "";
    for (const character of stem) {
      if (prefix.length + character.length > maximumStem) break;
      prefix += character;
    }
    const boundedStem = prefix.replace(/[ .]+$/u, "");
    if (boundedStem.length === 0) throw new TypeError("Filename leaves no safe stem for collision handling");
    const candidate = safeWindowsLeaf(`${boundedStem}${suffix}${extension}`, "generated filename");
    if (!folded.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  throw new RangeError("No collision-safe filename remains");
}
