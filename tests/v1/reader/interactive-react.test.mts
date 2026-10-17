import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
// @ts-expect-error build tooling is JavaScript, not the product type surface.
import { analyzeReactWorkBundle } from "../../../scripts/build-v1-work-dependencies.mjs";

test("isolated JSX compiler renders React state and actual Lucide exports without changing the source", async () => {
  const built = await analyzeReactWorkBundle(process.cwd());
  const code = built.outputFiles.find((file: {path:string}) => file.path.endsWith("react-work.js"))!.text;
  const errors: unknown[] = [], console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM('<!doctype html><div id="cloudig-react-root"></div>', { url: "https://cloudig-work.invalid/runtime/interactive-frame.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console });
  const source = 'import {useState} from "react"; import {Cloud} from "lucide-react"; export default function Counter(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}><Cloud/><span>{n}</span></button>}';
  try {
    const library = dom.window.document.createElement("script"); library.textContent = code; dom.window.document.body.append(library);
    (dom.window as unknown as { CloudigReactWork: { mount: (source: string, filename: string) => void } }).CloudigReactWork.mount(source, "counter.jsx");
    for (let n = 0; n < 20 && !dom.window.document.querySelector("button"); n++) await new Promise(resolve => setTimeout(resolve, 10));
    const button = dom.window.document.querySelector("button")!; assert(button); assert(button.querySelector("svg")); assert.equal(button.textContent, "0");
    button.click(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(button.textContent, "1");
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }
});
