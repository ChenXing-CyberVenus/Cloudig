export type InlineDollarRange = Readonly<{ start: number; end: number; tex: string }>;
export function osisInlineDollarRanges(value: unknown): InlineDollarRange[];
export function osisReplaceInlineDollarMath(value: unknown, render: (tex: string, original: string) => string): string;
