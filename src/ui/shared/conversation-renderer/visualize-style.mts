// The saved visualize tool's supplied contract defines these ramps/classes.
// This fills its hosting environment; it does not recolour authored artifacts.
const ramps = {
  purple: ["#EEEDFE", "#CECBF6", "#AFA9EC", "#534AB7", "#3C3489"],
  teal: ["#E1F5EE", "#9FE1CB", "#5DCAA5", "#0F6E56", "#085041"],
  coral: ["#FAECE7", "#F5C4B3", "#F0997B", "#993C1D", "#712B13"],
  pink: ["#FBEAF0", "#F4C0D1", "#ED93B1", "#993556", "#72243E"],
  gray: ["#F1EFE8", "#D3D1C7", "#B4B2A9", "#5F5E5A", "#444441"],
  blue: ["#E6F1FB", "#B5D4F4", "#85B7EB", "#185FA5", "#0C447C"],
  green: ["#EAF3DE", "#C0DD97", "#97C459", "#3B6D11", "#27500A"],
  amber: ["#FAEEDA", "#FAC775", "#EF9F27", "#854F0B", "#633806"],
  red: ["#FCEBEB", "#F7C1C1", "#F09595", "#A32D2D", "#791F1F"]
};
export function visualizeStyle(dark: boolean): string {
  return `:root{color-scheme:${dark ? "dark" : "light"};--text-primary:${dark ? "#e2e1e1" : "#2d2d2d"};--text-secondary:${dark ? "#bbc0c5" : "#5f5e5a"};--text-muted:${dark ? "#a1a7ad" : "#75716b"};--text-accent:${dark ? ramps.purple[2] : ramps.purple[3]};--surface-0:transparent;--surface-1:${dark ? "#303038" : "#f3e8dc"};--surface-2:${dark ? "#383841" : "#e8d6c4"};--border:${dark ? "#65616e" : "#b4b2a9"};--font-sans:system-ui,sans-serif}
:where(input[type="range"]){accent-color:var(--text-accent);cursor:pointer;min-width:0}
body{margin:8px;color:var(--text-primary);font:400 16px/1.7 var(--font-sans)}*{box-sizing:border-box}h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}h1,h2,h3{font-weight:500}button{font:inherit;color:inherit;background:var(--surface-1);border:1px solid var(--border);border-radius:8px;cursor:pointer}button:hover{background:var(--surface-2)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.t,.ts,.th{fill:var(--text-primary);font-family:var(--font-sans)}.t,.th{font-size:14px}.ts{font-size:12px}.th{font-weight:500}.arr{stroke:var(--text-secondary);fill:none}.ti{display:inline-block;width:1em;height:1em;vertical-align:-.12em;background:currentColor;mask-size:contain;mask-repeat:no-repeat;mask-position:center}
${Object.entries(ramps).map(([name, c]) => `.c-${name}{--node-fill:${dark ? c[4] : c[0]};--node-stroke:${dark ? c[2] : c[3]};--node-title:${dark ? c[1] : c[4]};--node-subtitle:${dark ? c[2] : c[3]}}.c-${name} :is(rect,circle,ellipse),:is(rect,circle,ellipse).c-${name}{fill:var(--node-fill);stroke:var(--node-stroke)}.c-${name} :is(.t,.th){fill:var(--node-title)}.c-${name} .ts{fill:var(--node-subtitle)}`).join("\n")}`;
}
