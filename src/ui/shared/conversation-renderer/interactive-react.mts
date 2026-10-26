import { transform } from "@babel/standalone";
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import { charts, icons } from "./interactive-react-libraries.mjs";
import { projectModules } from "./interactive-project-libraries.mjs";

// This bundle is loaded only inside an explicitly opened work sandbox. Neither
// compilation nor authored module execution takes place in the Parser/main UI.
const modules = new Map<string, unknown>([
  ["react", React], ["react/jsx-runtime", JsxRuntime], ["react-dom/client", { createRoot }],
  ...projectModules,
  ["recharts", charts], ["lucide-react", icons]
]);
type Module = { exports: Record<string, unknown> };
type Factory = (module: Module, exports: Module["exports"], require: (name: string) => unknown, react: typeof React) => void;

export function render(factory: Factory): void {
  const module: Module = { exports: {} };
  factory(module, module.exports, name => {
    if (!modules.has(name)) throw new Error(`React work dependency is not bundled: ${name}`);
    return modules.get(name);
  }, React);
  const component = module.exports["default"];
  if (!component || !["function", "object"].includes(typeof component)) throw new Error("React work must export a default component");
  const root = document.getElementById("cloudig-react-root"); if (!root) throw new Error("React work root is missing");
  createRoot(root).render(React.createElement(component as React.ComponentType));
}

export function mount(source: string, filename: string): void {
  const output = transform(source, {
    filename, sourceType: "module", sourceMaps: false,
    presets: [["react", { runtime: "classic" }], ["typescript", { allExtensions: true, isTSX: true }]],
    plugins: ["transform-modules-commonjs"]
  }).code;
  if (!output) throw new Error("React work compilation produced no code");
  // A normal script insertion in this sandbox, not eval or Function, and never
  // innerHTML. A literal </script> in the authored code stays literal JS data.
  const script = document.createElement("script");
  script.textContent = `CloudigReactWork.render(function(module,exports,require,React){\n${output}\n});`;
  document.body.append(script);
}

type ProjectFile = { path: string; source?: string; url: string };
let activeProject: { files: Map<string, ProjectFile>; factories: Map<string, Factory>; instances: Map<string, Module> } | undefined;
export function registerProjectModule(path: string, factory: Factory): void { activeProject!.factories.set(path, factory); }
export function mountProject(files: ProjectFile[], entry: string): void {
  const project = { files: new Map(files.map(f => [f.path, f])), factories: new Map<string, Factory>(), instances: new Map<string, Module>() };
  activeProject = project;
  const resolve = (name: string, from: string): string => {
    const relative = name.startsWith("@/") ? "src/" + name.slice(2) : name.startsWith("@contracts/") ? "contracts/" + name.slice(11)
      : name.startsWith(".") ? new URL(name, `https://work.invalid/${from}`).pathname.slice(1) : name.replace(/^\//u, "");
    return [relative, ...[".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.tsx"].map(s => relative + s)].find(p => project.files.has(p)) ?? relative;
  };
  const load = (name: string, from: string): unknown => {
    if (modules.has(name)) return modules.get(name);
    const path = resolve(name, from), cached = project.instances.get(path); if (cached) return cached.exports;
    const file = project.files.get(path); if (!file) throw new Error(`Saved frontend module is missing: ${name}`);
    const module: Module = { exports: {} }; project.instances.set(path, module);
    if (/\.css$/iu.test(path)) { const style = document.createElement("link"); style.rel = "stylesheet"; style.href = file.url; document.head.append(style); return module.exports; }
    if (/\.json$/iu.test(path)) { module.exports = JSON.parse(file.source ?? "{}"); return module.exports; }
    if (!/\.[cm]?[jt]sx?$/iu.test(path)) { module.exports = { __esModule: true, default: file.url }; return module.exports; }
    const output = transform(file.source ?? "", { filename:path, sourceType:"module", sourceMaps:false,
      presets:[["react",{runtime:"classic"}],["typescript",{allExtensions:true,isTSX:true}]], plugins:[
        // Build-time environment values aren't credentials to invent or recover.
        // Standard production flags are deterministic; absent VITE_* remain absent.
        ({types:t}: any) => ({visitor:{MemberExpression(p: any){const o=p.node.object;if(o?.type!=="MetaProperty"||o.meta.name!=="import"||o.property.name!=="meta")return;
          if(p.node.property.name==="env")p.replaceWith(t.valueToNode({MODE:"production",PROD:true,DEV:false,BASE_URL:"/"}));
          else if(p.node.property.name==="url")p.replaceWith(t.stringLiteral(file.url));}}}), "transform-modules-commonjs"] }).code;
    if (!output) throw new Error("Saved frontend compilation produced no code");
    const script = document.createElement("script");
    script.textContent = `CloudigReactWork.registerProjectModule(${JSON.stringify(path)},function(module,exports,require,React){\n${output}\n});`;
    document.body.append(script); script.remove();
    const factory = project.factories.get(path); if (!factory) throw new Error(`Saved frontend did not compile: ${path}`);
    factory(module, module.exports, next => load(next, path), React); return module.exports;
  };
  load(entry, "index.html");
}
