export type ReaderTheme = "dawn" | "star-night";
export function readerTheme(root: HTMLElement | undefined, fallback: ReaderTheme): ReaderTheme {
  const value = root?.closest<HTMLElement>("[data-theme]")?.dataset["theme"];
  return value === "dawn" || value === "star-night" ? value : fallback;
}

/** Portals and isolated work frames follow their owning Reader, not a copied
 * theme from creation time. Updating colour never recreates the running work. */
export function followReaderTheme(root: HTMLElement | undefined, fallback: ReaderTheme, update: (theme: ReaderTheme) => void): () => void {
  const owner = root?.closest<HTMLElement>("[data-theme]");
  let current = readerTheme(root, fallback);
  update(current);
  const Observer = owner?.ownerDocument.defaultView?.MutationObserver;
  const observer = owner && Observer ? new Observer(() => {
    const next = readerTheme(root, fallback);
    if (next !== current) { current = next; update(next); }
  }) : undefined;
  observer?.observe(owner!, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer?.disconnect();
}
