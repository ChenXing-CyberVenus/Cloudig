export type ResolvedV1Sample = Readonly<{
  file: string; name: string; importName: string; batch: string;
  platform: string; profile: "light" | "full" | "tree"; version: string; caseName: string;
}>;
export function resolveV1Samples(root: string, batches?: readonly string[]): Promise<ResolvedV1Sample[]>;
