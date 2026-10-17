import { transform } from "@babel/standalone";
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import { charts, icons } from "./interactive-react-libraries.mjs";

// This bundle is loaded only inside an explicitly opened work sandbox. Neither
// compilation nor authored module execution takes place in the Parser/main UI.
const modules = new Map<string, unknown>([
  ["react", React], ["react/jsx-runtime", JsxRuntime],
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
