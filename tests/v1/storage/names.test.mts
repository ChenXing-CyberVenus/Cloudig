import assert from "node:assert/strict";
import test from "node:test";
import { chooseNoReplaceLeaf, safeWindowsLeaf } from "../../../src/adapters/storage/names.mts";

test("collision suffixes respect UTF-16 filename units without splitting Unicode characters", () => {
  for (const stem of ["x".repeat(234), "😀".repeat(116) + "xx", "汉😀".repeat(78)]) {
    const filename = `${stem}.json`, occupied = new Set([filename.toUpperCase()]);
    assert.equal(safeWindowsLeaf(filename, "fixture"), filename);
    const second = chooseNoReplaceLeaf(filename, occupied); occupied.add(second);
    const third = chooseNoReplaceLeaf(filename, occupied);
    assert(second.endsWith(" (2).json")); assert(third.endsWith(" (3).json"));
    for (const value of [second, third]) {
      assert(value.length <= 240); assert(value.isWellFormed());
      assert(![...occupied].slice(0, 1).some(n => n.toLowerCase() === value.toLowerCase()));
    }
  }
});

test("ordinary collision names and unsafe-name rejection are unchanged", () => {
  assert.equal(chooseNoReplaceLeaf("对话.html", new Set()), "对话.html");
  assert.equal(chooseNoReplaceLeaf("对话.html", new Set(["对话.HTML"])), "对话 (2).html");
  for (const name of ["CON.json", "../name.json", "a:b.json", "trailing. ", "x".repeat(241)]) assert.throws(() => safeWindowsLeaf(name, "fixture"));
});
