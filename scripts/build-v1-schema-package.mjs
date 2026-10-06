import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const V1_SCHEMA_FILES = Object.freeze([
  ...["common", "library", "identity", "identity-settings", "conversation", "mark", "content-time", "content-time-order"].map(name => [`src/core/records/schemas/${name}.schema.json`, `records/${name}.schema.json`]),
  ...["conversation", "library"].map(name => [`src/core/records/schemas/compat/${name}-1.0.0.schema.json`, `records/compat/${name}-1.0.0.schema.json`]),
  ...["common", "container-record", "system-log"].map(name => [`src/core/contracts/schemas/${name}.schema.json`, `program/${name}.schema.json`]),
  ["src/adapters/storage/record-transaction.schema.json", "program/record-transaction.schema.json"],
  ["src/adapters/library-data/record-recycle.schema.json", "program/record-recycle.schema.json"]
]);
export async function readV1SchemaPackage(repository) {
  const rows = await Promise.all(V1_SCHEMA_FILES.map(async ([source, file]) => {
    const bytes = await readFile(path.join(repository, source));
    return { source, file, bytes, schema: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const byId = new Map(rows.map(row => [row.schema.$id, row.schema]));
  assert.equal(byId.size, rows.length);
  for (const row of rows) {
    const stack = [row.schema];
    while (stack.length) {
      const node = stack.pop(); if (!node || typeof node !== "object") continue;
      if (typeof node.$ref === "string") {
        const [id, fragment = ""] = node.$ref.split("#"); let target = byId.get(id || row.schema.$id);
        assert.ok(target, `Unbundled Schema reference: ${node.$ref}`);
        for (const part of fragment.split("/").slice(1)) target = target?.[decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")];
        assert.notEqual(target, undefined, `Missing Schema fragment: ${node.$ref}`);
      }
      stack.push(...Object.values(node));
    }
  }
  return rows;
}
export async function buildV1SchemaPackage(repository, output) {
  const relative = path.relative(repository, output);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const rows = await readV1SchemaPackage(repository);
  for (const row of rows) { const file = path.join(output, row.file); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, row.bytes); }
  await writeFile(path.join(output, "index.json"), JSON.stringify({ cloudig_standard: "1.0", schemas: rows.map(({ file, source, schema, sha256 }) => ({ file, source, id: schema.$id, sha256 })) }, null, 2) + "\n");
  await writeFile(path.join(output, "README.md"), "# 采云数据格式 / Cloudig Schemas\n\nrecords/ 是五类业务记录的字段规则；program/ 是程序状态及其公共依赖。index.json 登记对应路径、标识与 SHA-256。\n\n$id 中的 https://cloudig.local/ 是类型标识，不是下载地址。离线校验时先向 JSON Schema 2020-12 校验器注册本目录的全部 Schema，再按 $id 选择根规则，无需网络。\n\nJSON Schema 只覆盖字段形状，不替代引用关系、真实日期、消息无环及资源字节/哈希等语义校验；完整规则见《结构与规范》。不得把所有通过 Schema 的文件宣称为已通过全部采云校验。\n\nThese files are offline JSON Schema 2020-12 contracts. Register all files before validation; their IDs are not network endpoints. Semantic and cross-file checks remain required.\n");
  return rows.length;
}
