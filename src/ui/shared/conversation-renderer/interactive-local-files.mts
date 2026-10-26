/** Runs only in the disposable work origin. Its immutable URL map contains
 * this work's bytes and pinned components, never an OS path/network bridge. */
export function installWorkLocalFiles(entries: readonly (readonly [string, string])[], pyodideBase?: string): void {
  const files = new Map(entries), originalFetch = globalThis.fetch.bind(globalThis);
  const resolve = (value: string) => files.get(value) ?? value;
  globalThis.fetch = async (input, init) => {
    const source = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = files.get(source);
    if (!target) {
      if (/^https?:/iu.test(source)) throw new TypeError(`Saved work resource is not installed: ${source}`);
      return originalFetch(input, init); // CSP also denies non-local network.
    }
    const response = await originalFetch(target, init);
    Object.defineProperty(response, "url", { value: source });
    return response;
  };
  const src = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src")!;
  Object.defineProperty(HTMLScriptElement.prototype, "src", { ...src, set(value: string) { src.set!.call(this, resolve(String(value))); } });
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name: string, value: string): void {
    attribute.call(this, name, this instanceof HTMLScriptElement && name.toLowerCase() === "src" ? resolve(String(value)) : value);
  };
  if (pyodideBase) {
    // The script itself now has a Blob URL, so its original sibling-file base
    // must be supplied. Explicit author settings retain their precedence.
    let stored: unknown;
    Object.defineProperty(globalThis, "loadPyodide", { configurable: true, get: () => stored, set: value => {
      stored = typeof value !== "function" ? value : (options: Record<string, unknown> = {}) => value({ indexURL: pyodideBase, ...options });
    } });
  }
}
