import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import test from "node:test";

test("browser inputs use Core code-point limits, preserve pasted text and clear errors after reset", async () => {
  const script = await build({ entryPoints: ["src/ui/shared/record-text-input.js"], bundle: true, write: false, format: "iife", globalName: "recordInputs", platform: "browser" });
  const dom = new JSDOM('<html lang="zh-CN"><body><form><input maxlength="1"></form></body></html>', { runScripts: "outside-only" });
  try {
    dom.window.eval(script.outputFiles[0]!.text);
    const api = (dom.window as unknown as { recordInputs: { bindRecordTextInput(input: HTMLInputElement, kind: string): void; refreshRecordTextInputs(root: HTMLElement): void } }).recordInputs;
    const input = dom.window.document.querySelector("input")!, form = dom.window.document.querySelector("form")!;
    for (const [kind, limit] of [["name", 1024], ["title", 4096]] as const) {
      api.bindRecordTextInput(input, kind); assert.equal(input.hasAttribute("maxlength"), false);
      input.value = "😀".repeat(limit); input.dispatchEvent(new dom.window.Event("input")); assert(input.checkValidity());
      input.value += "中"; input.dispatchEvent(new dom.window.Event("input")); assert(!input.checkValidity());
      assert.equal(Array.from(input.value).length, limit + 1, "invalid text is not silently truncated");
      input.value = ""; api.refreshRecordTextInputs(form); assert(input.checkValidity());
    }
  } finally { dom.window.close(); }
});
