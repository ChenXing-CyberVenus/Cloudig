import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RecordLibraryEngineCommands } from "../../../src/engine/record-library-commands.mts";
import { commitRecords, readStoredRecord } from "../../../src/adapters/storage/record-store.mts";
import { assertIpcValue } from "../../../src/engine/protocol.mts";
import { createRecordLibrary } from "../../../src/adapters/library-data/record-library.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

const base = path.resolve("tests/private/schema-rebuild");
async function temporary(run: (root: string) => Promise<void>) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, "record-library-engine-")); let passed = false;
  try { await run(root); passed = true; }
  finally { if (passed) { assert.equal(path.dirname(await realpath(root)), await realpath(base)); assert(!(await lstat(root)).isSymbolicLink()); await rm(root, { recursive: true }); } else console.error(`Retained Library Engine test: ${root}`); }
}
const context = () => ({ request: "q_record_library", signal: new AbortController().signal, emit: async () => undefined });
function client(root: string) {
  const handlers = new RecordLibraryEngineCommands(root).handlers();
  return async (command: string, payload: JsonObject = {}): Promise<JsonObject> => { const result = await handlers[command]!(payload, context()); assertIpcValue(result); return result as JsonObject; };
}

test("fresh Engine Library commands create only new independent records and startup inspection never writes", async () => temporary(async root => {
  const call = client(root); assert.deepEqual(await call("library.startup.recover"), { status: "missing" }); assert.deepEqual(await readdir(root), []);
  assert.equal((await call("library.create"))["status"], "created");
  const current = await call("library.preferences.query"), original = await readFile(path.join(root, "CloudigLibrary.json"));
  assert.match(String(current["revision"]), /^[a-f0-9]{64}$/); assert.equal(current["theme"], "dawn"); assert.equal(current["theme_switched"], false);
  assert.deepEqual(current["workflow_archiver"], { sort: "time_desc", time_field: "file_modified_at" }); assert.deepEqual(current["workflow_reader"], current["workflow_archiver"]);
  assert.deepEqual(current["parse_claude"], { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false });
  assert.equal(current["default_output_directory"], "Conversations"); assert.equal((await readdir(path.join(root, "ContentTimes"))).length, 18);
  assert.deepEqual(await call("library.startup.recover"), { status: "valid", revision: current["revision"] }); assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), original);
  await assert.rejects(call("library.create"), /Existing Library/);
  const parsed = JSON.parse(original.toString("utf8")); assert.deepEqual(Object.keys(parsed).sort(), ["cloudig_standard", "edited_at", "schema", "schemas", "settings"]);
  assert.equal(parsed.cloudig_standard, "1.0"); assert.equal(Object.keys(parsed)[0], "cloudig_standard");
}));

test("the known Library without only the total declaration opens without rewriting and the next real save adds it", async () => temporary(async root => {
  const call = client(root); await call("library.create"); const file = path.join(root, "CloudigLibrary.json");
  const old = JSON.parse(await readFile(file, "utf8")); delete old.cloudig_standard;
  const bytes = JSON.stringify(old, null, 2) + "\n"; await writeFile(file, bytes);
  assert.equal((await call("library.startup.recover"))["status"], "valid");
  const preferences = await call("library.preferences.query");
  assert.equal(await readFile(file, "utf8"), bytes);
  await call("library.preferences.commit", { expected_revision: preferences["revision"]!, language: "en" });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.cloudig_standard, "1.0"); assert.equal(Object.keys(saved)[0], "cloudig_standard");
}));

test("settings persist full defaults, independent page selections and completed theme guide without touching Time or Front", async () => temporary(async root => {
  const call = client(root); await call("library.create"); const initial = await call("library.preferences.query"), libraryBefore = await readFile(path.join(root, "CloudigLibrary.json"));
  const timeNames = await readdir(path.join(root, "ContentTimes")), times = await Promise.all(timeNames.map(n => readFile(path.join(root, "ContentTimes", n))));
  const frontNames = await readdir(path.join(root, "Identities")), fronts = await Promise.all(frontNames.map(n => readFile(path.join(root, "Identities", n))));
  assert.equal((await call("library.preferences.commit", { expected_revision: initial["revision"]!, theme: "dawn" }))["status"], "unchanged");
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), libraryBefore);
  await mkdir(path.join(root, "Conversations", "My archives"));
  const changed = await call("library.preferences.commit", { expected_revision: initial["revision"]!, theme: "star-night", language: "en", default_output_directory: "Conversations/My archives",
    workflow_parser: { sort: "title" }, workflow_reader: { sort: "time_asc", time_field: "content_time_end" }, workflow_claude: { sort: "title", time_field: "created_at" },
    parse_claude: { parse_unparsed: true, parse_selected: false, update_outdated: true, preserve_previous: true } });
  assert.equal(changed["theme_switched"], true); assert.equal(changed["user_name"], "User"); assert.equal(changed["assistant_name"], "AI");
  assert.deepEqual(changed["workflow_archiver"], initial["workflow_archiver"]); assert.deepEqual(changed["parse_ordinary"], initial["parse_ordinary"]);
  const returned = await call("library.preferences.commit", { expected_revision: changed["revision"]!, theme: "dawn" }); assert.equal(returned["theme_switched"], true);
  const reopened = await client(root)("library.preferences.query"); assert.equal(reopened["default_output_directory"], "Conversations/My archives"); assert.deepEqual(reopened["workflow_reader"], { sort: "time_asc", time_field: "content_time_end" });
  const settings = (await readStoredRecord(root, "library", "CloudigLibrary.json")).value["settings"] as JsonObject;
  assert.deepEqual(Object.keys(settings).sort(), ["default_output_directory", "language", "one_click_parse", "sort", "theme", "theme_guide_completed", "time_type"]);
  assert.equal((settings["time_type"] as JsonObject)["claude_json"], "conversation_created_at");
  for (const [i, name] of timeNames.entries()) assert.deepEqual(await readFile(path.join(root, "ContentTimes", name)), times[i]);
  for (const [i, name] of frontNames.entries()) assert.deepEqual(await readFile(path.join(root, "Identities", name)), fronts[i]);
}));

test("custom names remain untranslated and stale or malformed preference writes preserve bytes", async () => temporary(async root => {
  const call = client(root); await call("library.create"); const old = await call("library.preferences.query");
  const binding = await readStoredRecord(root, "identitySettings", "Identities/identity-settings.json"), file = `Identities/${binding.value["subject"]}.json`, front = await readStoredRecord(root, "identity", file);
  Object.assign(front.value, { names: [{ name: "晨星.CyberVenus", claimers: [{ front: binding.value["subject"] }] }], display_name: 1 });
  await commitRecords(root, [{ action: "write", kind: "identity", path: file, value: front.value, expected: front.sha256 }]);
  const changed = await call("library.preferences.commit", { expected_revision: old["revision"]!, language: "en" }); assert.equal(changed["user_name"], "晨星.CyberVenus");
  const before = await readFile(path.join(root, "CloudigLibrary.json"));
  await assert.rejects(call("library.preferences.commit", { expected_revision: old["revision"]!, theme: "star-night" }), e => (e as { code?: string }).code === "CLOUDIG_LIBRARY_REVISION_CONFLICT");
  for (const invalid of [{ theme_switched: false }, { default_output_directory: "../escape" }, { default_output_directory: null }, { workflow_reader: { sort: "time_desc", time_field: "fiction" } }, { parse_ordinary: { include_unparsed: true } }]) {
    await assert.rejects(call("library.preferences.commit", { expected_revision: changed["revision"]!, ...invalid } as JsonObject));
    assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), before);
  }
}));

test("old development formats and missing settings beside existing nodes are not auto-migrated", async () => temporary(async root => {
  const call = client(root), file = path.join(root, "cloudig-library.json"), bytes = '{"schema":"cloudig/library/1.0.0","next_archive":1}\n';
  await writeFile(file, bytes); assert.equal((await call("library.startup.recover"))["status"], "unsupported"); await assert.rejects(call("library.create")); assert.equal(await readFile(file, "utf8"), bytes);
  const second = path.join(root, "independent"); await mkdir(path.join(second, "Identities"), { recursive: true }); await writeFile(path.join(second, "Identities", "original.json"), "preserve");
  const nested = client(second); assert.equal((await nested("library.startup.recover"))["status"], "settings_recovery"); await assert.rejects(nested("library.create")); assert.equal(await readFile(path.join(second, "Identities", "original.json"), "utf8"), "preserve");
}));

test("missing Library settings are restored alone, without replacing any existing node or user file", async () => temporary(async root => {
  const call = client(root); await call("library.create"); const initial = await call("library.preferences.query");
  await call("library.preferences.commit", { expected_revision: initial["revision"]!, theme: "star-night", language: "en" });
  await writeFile(path.join(root, "Conversations", "kept.json"), "user conversation bytes"); await writeFile(path.join(root, "Marks", "kept.json"), "user mark bytes");
  const before = new Map<string, Buffer>();
  for (const directory of ["Identities", "ContentTimes", "Conversations", "Marks"]) for (const name of await readdir(path.join(root, directory))) before.set(`${directory}/${name}`, await readFile(path.join(root, directory, name)));
  await rm(path.join(root, "CloudigLibrary.json"));
  for (let n = 0; n < 2; n++) assert.equal((await call("library.startup.recover"))["status"], "settings_recovery");
  assert(!await lstat(path.join(root, "CloudigLibrary.json")).catch(() => undefined));
  await assert.rejects(call("library.create"));
  assert.equal((await call("library.settings.recover"))["status"], "valid");
  const settings = await call("library.preferences.query"); assert.equal(settings["theme"], "dawn"); assert.equal(settings["language"], "zh-CN"); assert.equal(settings["default_output_directory"], "Conversations");
  for (const [relative, bytes] of before) assert.deepEqual(await readFile(path.join(root, relative)), bytes);
  for (const directory of ["Identities", "ContentTimes", "Conversations", "Marks"]) assert.equal((await readdir(path.join(root, directory))).length, [...before.keys()].filter(key => key.startsWith(directory + "/")).length);
  const restored = await readFile(path.join(root, "CloudigLibrary.json")); await assert.rejects(call("library.settings.recover"), { code: "CLOUDIG_LIBRARY_RECOVERY_CONFLICT" }); assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), restored);
}));

test("legacy wrapper roots cannot grow another Library alongside their existing inner data", async () => temporary(async root => {
  for (const [name, marker] of [["Old test", "Library/cloudig-library.json"], ["Old portable", "Cloudig/Data/State/content-time.json"], ["Nested current", "Library/CloudigLibrary.json"]]) {
    const location = path.join(root, name!), file = path.join(location, marker!); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "preserved inner authority");
    const call = client(location); assert.equal((await call("library.startup.recover"))["status"], "unsupported"); await assert.rejects(call("library.create")); await assert.rejects(call("library.settings.recover"));
    assert.equal(await readFile(file, "utf8"), "preserved inner authority"); assert(!await lstat(path.join(location, "CloudigLibrary.json")).catch(() => undefined));
  }
  const wrapper = path.join(root, "Missing inner metadata"); await mkdir(path.join(wrapper, "Library"), { recursive: true }); await mkdir(path.join(wrapper, "Device"));
  assert.equal((await client(wrapper)("library.startup.recover"))["status"], "unsupported");
}));

test("full initialization preserves imported Conversations but cannot run over existing meaning nodes", async () => temporary(async root => {
  await mkdir(path.join(root, "Conversations")); await writeFile(path.join(root, "Conversations", "imported.json"), "existing import");
  await mkdir(path.join(root, "Identities")); await mkdir(path.join(root, "ContentTimes"));
  await createRecordLibrary(root, { timestamp: "2026-09-11T12:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } });
  assert.equal(await readFile(path.join(root, "Conversations", "imported.json"), "utf8"), "existing import");
  await rm(path.join(root, "CloudigLibrary.json"));
  await assert.rejects(createRecordLibrary(root, { timestamp: "2026-09-11T12:00:00Z", anchor: { date: "2026-09-11", offset: "Z" } }), /Existing Library or node/);
}));

test("valid current settings remain authoritative beside extra user directories with legacy-looking names", async () => temporary(async root => {
  const request = client(root); await request("library.create");
  for (const name of ["Data", "Library", "Device"]) await mkdir(path.join(root, name));
  assert.equal((await request("library.startup.recover"))["status"], "valid");
  await assert.rejects(request("library.create"));
}));

test("startup reports interruption without writing and explicit Engine recovery uses the shared storage boundary", async () => temporary(async root => {
  const call = client(root); await call("library.create"); const current = await readStoredRecord(root, "library", "CloudigLibrary.json"), original = await readFile(path.join(root, "CloudigLibrary.json"));
  (current.value["settings"] as JsonObject)["language"] = "en";
  await assert.rejects(commitRecords(root, [{ action: "write", kind: "library", path: "CloudigLibrary.json", value: current.value, expected: current.sha256 }], { fault(point) { if (point === "displaced_0") throw new Error("test interruption"); } }));
  const inspection = await call("library.startup.recover"); assert.equal(inspection["status"], "transaction_recovery");
  await assert.rejects(call("library.preferences.query"), /Complete recovery/);
  const operations = inspection["operations"] as string[]; assert.equal(operations.length, 1);
  assert.equal((await call("library.recovery.commit", { operation: operations[0]!, action: "rollback" }))["status"], "valid");
  assert.deepEqual(await readFile(path.join(root, "CloudigLibrary.json")), original);
  await assert.rejects(call("library.recovery.commit", { operation: operations[0]!, action: "complete" }), /no longer pending/);
}));
