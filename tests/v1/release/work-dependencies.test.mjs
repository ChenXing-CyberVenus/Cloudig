import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildWorkDependencies } from "../../../scripts/build-v1-work-dependencies.mjs";
import { buildBundledWorkComponents } from "../../../scripts/build-v1-work-components.mjs";

test("component delivery pins bundled bytes, reuses them offline and excludes recognition downloads", async () => {
  await mkdir("tmp", {recursive:true});
  const root = await mkdtemp(path.resolve("tmp/work-component-test-"));
  const bytes = Buffer.from("public dependency"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = {file:"runtime.js", url:"https://example.invalid/runtime.js", bytes:bytes.length, sha256};
  const catalog = {components:[{id:"python",delivery:"bundled",files:[file]}, {id:"recognition",delivery:"on-demand",files:[file]}]};
  let requests = 0;
  try {
    const output = path.join(root,"output");
    const first = await buildBundledWorkComponents(root,output,catalog,async () => {requests++;return bytes;});
    assert.equal(requests,1);assert.deepEqual(first.map(x=>x.file),["components/python/runtime.js"]);
    assert.deepEqual(await readdir(path.join(output,"components")),["python"]);
    assert.deepEqual(await buildBundledWorkComponents(root,output,catalog,async()=>{throw new Error("offline");}),first);
    const bad = {...catalog,components:[{...catalog.components[0],id:"bad"}]};
    await assert.rejects(buildBundledWorkComponents(root,output,bad,async()=>Buffer.from("wrong")),/hash\/length mismatch/);
    await assert.rejects(readFile(path.join(output,"components/bad/runtime.js")),{code:"ENOENT"});
  } finally {await rm(root,{recursive:true,force:true});}
});

test("saved work payload ships manifest fonts only, with pinned bytes and original licenses", async () => {
  const root = process.cwd(); await mkdir(path.join(root, "tmp"), { recursive: true });
  const output = await mkdtemp(path.join(root, "tmp", "work-dependencies-"));
  try {
    const built = await buildWorkDependencies(root, output);
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    const expected = [...new Set(manifest.fonts.flatMap(font => [path.basename(font.file), path.basename(font.license)]))].sort();
    assert.deepEqual((await readdir(path.join(output, "fonts"))).sort(), expected);
    assert(!expected.includes("NotoSerifSC-400.ttf")); assert(!expected.includes("NotoSerifSC-700.ttf"));
    for (const font of manifest.fonts) assert.equal(createHash("sha256").update(await readFile(path.join(output, font.file))).digest("hex"), font.sha256);
    for (const file of built.files) assert.equal(createHash("sha256").update(await readFile(path.join(output,file.file))).digest("hex"), file.sha256);
    assert((await readFile(path.join(output,"libraries/three-0.158.0-orbit-controls.js"),"utf8")).includes('"158"'));
    assert.equal(JSON.parse(await readFile(path.join(output,"optional-components.json"),"utf8")).version,1);
    const catalog = JSON.parse(await readFile(path.join(output,"optional-components.json"),"utf8"));
    assert.deepEqual((await readdir(path.join(output,"components"))).sort(),catalog.components.filter(c=>c.delivery==="bundled").map(c=>c.id).sort());
    assert(built.files.some(f=>f.file==="components/pyodide-0.26.2/python_stdlib.zip"));
    assert(!built.files.some(f=>/components\/(?:tfjs|mobilenet)/u.test(f.file)));
  } finally { await rm(output, { recursive: true, force: true }); }
});
