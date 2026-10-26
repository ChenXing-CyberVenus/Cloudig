declare module "markdown-it-footnote" {
  import type { MarkdownIt as MarkdownItInstance } from "markdown-it";
  const footnote: (markdown: MarkdownItInstance) => void;
  export default footnote;
}
