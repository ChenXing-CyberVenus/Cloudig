import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readV1SchemaPackage } from "../../../scripts/build-v1-schema-package.mjs";

test("release Schemas include all offline references and the current standard declaration", async () => {
  const rows = await readV1SchemaPackage(process.cwd());
  assert.equal(rows.length, 15); // current contracts/dependency plus two frozen 1.0.0 readers
  const validator = new Ajv2020({ strict: false });
  for (const row of rows) validator.addSchema(row.schema);
  for (const row of rows) assert.ok(validator.getSchema(row.schema.$id));
  assert.equal(rows.find(row => row.file === "records/library.schema.json").schema.properties.cloudig_standard.const, "1.0");
  assert.ok(rows.some(row => row.schema.$id === "https://cloudig.local/records/conversation/1.0.0"));
  assert.ok(rows.some(row => row.schema.$id === "https://cloudig.local/records/conversation/1.0.1"));
});
