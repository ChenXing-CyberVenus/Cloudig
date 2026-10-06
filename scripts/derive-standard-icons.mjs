import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/ui/shell/pages/document/assets');
for (const name of ['Core', 'Important', 'General', 'Fold']) {
  const svg = await readFile(path.join(root, `InfoValue-${name}.svg`), 'utf8');
  const grey = svg.replace(/#([\da-f]{6}|[\da-f]{3})\b/giu, (_, hex) => {
    if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    const channel = Math.round(60 + luminance * .64).toString(16).padStart(2, '0');
    return `#${channel.repeat(3)}`;
  });
  const target = path.join(root, `InfoValue-${name}-Grey.svg`);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== grey) throw new Error(`Grey icon drift: ${name}`);
  } else await writeFile(target, grey);
}
console.log('Four authored silhouettes / four tonal-grey variants verified.');
