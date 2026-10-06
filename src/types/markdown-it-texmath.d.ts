declare module "markdown-it-texmath" {
  import type { MarkdownIt as MarkdownItInstance } from "markdown-it";

  type TexmathOptions = Readonly<{
    engine: unknown;
    delimiters?: string | readonly string[];
    outerSpace?: boolean;
    katexOptions?: Readonly<Record<string, unknown>>;
  }>;

  const texmath: (markdown: MarkdownItInstance, options: TexmathOptions) => void;
  export default texmath;
}
