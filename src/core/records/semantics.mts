import { createHash } from "node:crypto";
import common from "./schemas/common.schema.json" with { type: "json" };
import type { JsonObject, JsonValue, ValidationIssue } from "../contracts/types.mts";
import type { RecordKind } from "./schema-registry.mts";
import { RECORD_TIME_LIMITS, RELATIVE_MAX_TENTHS } from "./limits.mts";
import { blockHtml, htmlResourceImages } from "./html-resources.mts";

const uuid = new RegExp(common.$defs.uuid.pattern, "u");
const object = (value: JsonValue | undefined): JsonObject => value as JsonObject;
const array = (value: JsonValue | undefined): JsonObject[] => (value ?? []) as JsonObject[];
const pointer = (value: string): string => value.replace(/~/gu, "~0").replace(/\//gu, "~1");
const issue = (issues: ValidationIssue[], path: string, message: string, code = "CLOUDIG_RECORD_SEMANTIC"): void => { issues.push({ code, path, message }); };

function realDay(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 ? leap ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31);
}

function utc(value: JsonValue | undefined, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  const text = String(value), date = new Date(text);
  const expected = text.replace(/(?:\.([0-9]{1,3}))?Z$/u, (_m, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  if (text.startsWith("0000-") || !Number.isFinite(date.getTime()) || date.toISOString() !== expected) issue(issues, path, "Expected a real UTC timestamp");
}

function front(value: JsonObject, path: string, issues: ValidationIssue[], scope: "source" | "user", sourceIds?: ReadonlySet<string>): void {
  const names = array(value["names"]), selected = value["display_name"];
  if (typeof selected === "number" && selected > names.length) issue(issues, `${path}/display_name`, "Selected name is outside names");
  for (const [index, name] of names.entries()) {
    for (const claimer of array(name["claimers"])) {
      const ref = claimer["front"];
      if (ref !== undefined && (typeof ref !== "string" || (scope === "source" ? !sourceIds?.has(ref) : !uuid.test(ref)))) issue(issues, `${path}/names/${index}/claimers`, "Claimer must reference an identity in the applicable scope");
    }
  }
  utc(value["created_at"], `${path}/created_at`, issues);
  utc(value["edited_at"], `${path}/edited_at`, issues);
  if (value["image"] !== undefined && !String(value["image"]).startsWith("Identities/Images/")) issue(issues, `${path}/image`, "User images belong under Identities/Images");
}

function progression(value: JsonObject, count: number, path: string, issues: ValidationIssue[]): void {
  if (value["all"] === true) return;
  const first = Number(value["first"]), last = Number(value["last"]), step = Number(value["step"]);
  if (first > last || last > count || (last - first) % step !== 0) issue(issues, path, "Period selection must stay in bounds and end on its step");
}

function endpoint(value: JsonObject, path: string, issues: ValidationIssue[]): void {
  const kind = value["kind"];
  if (kind === "calendar" && value["day"] !== undefined) {
    const year = Number(value["year"]), actualYear = value["era"] === "BC" ? 1 - year : year;
    if (!realDay(actualYear, Number(value["month"]), Number(value["day"]))) issue(issues, path, "Invalid calendar day");
  }
  if (kind === "now" || kind === "relative") {
    const anchor = object(value["anchor"]), [y, m, d] = String(anchor["date"]).split("-").map(Number);
    if (!y || !realDay(y, m!, d!)) issue(issues, `${path}/anchor/date`, "Invalid anchor day");
    if (kind === "relative") {
      const tenths = BigInt(String(value["value"]).replace(".", ""));
      if (tenths <= 0n || tenths > RELATIVE_MAX_TENTHS) issue(issues, `${path}/value`, `Relative time must be greater than zero and at most ${RECORD_TIME_LIMITS.relative.coefficient_max}`);
    }
  }
  if (kind !== "node") return;
  const target = object(value["target"]), snapshot = object(value["snapshot"]), node = object(snapshot["node"]);
  if ((target["timeline"] !== undefined) !== (snapshot["timeline"] !== undefined)) issue(issues, path, "Timeline reference and timeline snapshot must appear together");
  if (snapshot["path"] !== undefined && target["timeline"] === undefined) issue(issues, `${path}/snapshot/path`, "A path requires its selected timeline");
  if (node["kind"] === "periodic") {
    if (!target["occurrences"]) issue(issues, `${path}/target/occurrences`, "Periodic selection is required");
    else progression(object(target["occurrences"]), Number(node["count"]), `${path}/target/occurrences`, issues);
  } else if (target["occurrences"] !== undefined) issue(issues, `${path}/target/occurrences`, "Only periodic nodes carry occurrences");
  if (snapshot["sort"]) range(object(snapshot["sort"]), `${path}/snapshot/sort`, issues);
}

function equalJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equalJson((a as JsonObject)[k]!, (b as JsonObject)[k]!));
}

function range(value: JsonObject, path: string, issues: ValidationIssue[]): void {
  endpoint(object(value["start"]), `${path}/start`, issues);
  if (value["end"] !== undefined) {
    endpoint(object(value["end"]), `${path}/end`, issues);
    if (equalJson(value["start"]!, value["end"])) issue(issues, `${path}/end`, "Equal endpoints must be stored as start only");
  }
  // Reverse chronological ranges are valid user meaning, not a validation failure.
}
export function validateRecordRangeSemantics(value: JsonObject): ValidationIssue[] { const issues: ValidationIssue[] = []; range(value, "", issues); return issues; }

function ids(values: JsonObject[], key: string, path: string, issues: ValidationIssue[]): Set<string> {
  const found = new Set<string>();
  for (const [index, value] of values.entries()) {
    const id = String(value[key]);
    if (found.has(id)) issue(issues, `${path}/${index}/${key}`, "Duplicate local identifier");
    found.add(id);
  }
  return found;
}

export type ObservedRecordResource = Readonly<{ bytes: number; sha256: string }>;
function conversation(value: JsonObject, issues: ValidationIssue[], observed?: ReadonlyMap<string, ObservedRecordResource>): void {
  const fronts = array(value["identity"]), frontIds = ids(fronts, "source_id", "/identity", issues);
  fronts.forEach((f, i) => front(f, `/identity/${i}`, issues, "source", frontIds));
  const speakers = new Map(fronts.map(f => [String(f["source_id"]), f]));
  const resources = array(value["resources"]), resourceIds = ids(resources, "id", "/resources", issues);
  const imageIds = new Set(resources.filter(r => ["image", "diagram"].includes(String(r["kind"]))
    && (r["mime"] === undefined || /^image\//iu.test(String(r["mime"])))).map(r => String(r["id"])));
  const refs = ids(array(value["references"]), "id", "/references", issues);
  const tree = object(value["messages"]), messages = array(tree["items"]), messageIds = ids(messages, "id", "/messages/items", issues);
  if (tree["current"] !== undefined && !messageIds.has(String(tree["current"]))) issue(issues, "/messages/current", "Default message is absent");
  const parents = new Map(messages.map(m => [String(m["id"]), m["parent"] === undefined ? undefined : String(m["parent"])]));
  const done = new Set<string>();
  for (const id of messageIds) {
    const visiting = new Set<string>(); let cursor: string | undefined = id;
    while (cursor && messageIds.has(cursor) && !done.has(cursor)) {
      if (visiting.has(cursor)) { issue(issues, "/messages/items", "Message parent cycle", "CLOUDIG_MESSAGE_CYCLE"); break; }
      visiting.add(cursor); cursor = parents.get(cursor);
    }
    for (const seen of visiting) done.add(seen);
  }
  // Missing external parents remain source facts, not a fabricated replacement edge.
  for (const [i, m] of messages.entries()) {
    const p = `/messages/items/${i}`, speaker = m["speaker"];
    if (array(m["content"]).length && (typeof speaker !== "string" || !frontIds.has(speaker))) issue(issues, `${p}/speaker`, "Actual message must reference a Front");
    if (speaker !== undefined && !frontIds.has(String(speaker))) issue(issues, `${p}/speaker`, "Unknown Front");
    utc(m["timestamp"], `${p}/timestamp`, issues);
    const stack = array(m["content"]).map((b, j) => ({ b, p: `${p}/content/${j}`, speaker }));
    while (stack.length) {
      const item = stack.pop()!, b = item.b, who = b["speaker"] ?? item.speaker;
      for (const key of ["speaker", "recipient"] as const) if (b[key] !== undefined && !frontIds.has(String(b[key]))) issue(issues, `${item.p}/${key}`, "Unknown Front reference");
      if (b["type"] === "tool" && b["kind"] === "call" && b["recipient"] !== undefined && speakers.get(String(b["recipient"]))?.["role"] !== "tool") issue(issues, `${item.p}/recipient`, "Tool call target must have tool role");
      if (b["type"] === "tool" && b["kind"] === "result" && speakers.get(String(who))?.["role"] !== "tool") issue(issues, `${item.p}/speaker`, "Tool result belongs to the tool Front");
      for (const key of ["resource", "input_resource", "output_resource", "rendered"] as const) if (b[key] !== undefined && !resourceIds.has(String(b[key]))) issue(issues, `${item.p}/${key}`, "Unknown resource reference");
      if (b["type"] === "interactive") {
        const files = array(b["files"]), paths = new Set<string>();
        for (const [j, file] of files.entries()) {
          const name = String(file["path"]);
          // Virtual paths, never local filesystem paths or URLs. The runtime
          // resolves these names only against this block's declared resources.
          if (/^[\/\\]|[\\\u0000-\u001f:#?%]/u.test(name) || name.split("/").some(p => !p || p === "." || p === "..")) issue(issues, `${item.p}/files/${j}/path`, "Interactive file requires a safe relative virtual path");
          if (paths.has(name)) issue(issues, `${item.p}/files/${j}/path`, "Duplicate interactive file path");
          paths.add(name);
          if (!resourceIds.has(String(file["resource"]))) issue(issues, `${item.p}/files/${j}/resource`, "Unknown interactive file resource");
        }
        if (b["entry"] !== undefined && !paths.has(String(b["entry"]))) issue(issues, `${item.p}/entry`, "Interactive entry must name one of its files");
        if (b["preview"] !== undefined && !imageIds.has(String(b["preview"]))) issue(issues, `${item.p}/preview`, "Interactive preview must reference an image resource");
      }
      const html = blockHtml(b);
      if (html !== undefined) for (const image of htmlResourceImages(html)) if (!imageIds.has(image.id))
        issue(issues, `${item.p}/${typeof b["html"] === "string" ? "html" : "text"}`, "Inline image must reference an image resource in this Conversation");
      if (Array.isArray(b["references"])) for (const r of b["references"]) if (!refs.has(String(r))) issue(issues, `${item.p}/references`, "Unknown reference");
      for (const [j, nested] of array(b["content"]).entries()) stack.push({ b: nested, p: `${item.p}/content/${j}`, speaker: who });
    }
  }
  for (const [i, r] of resources.entries()) {
    if (r["availability"] !== "embedded") {
      if (observed?.has(String(r["id"]))) issue(issues, `/resources/${i}`, "Non-embedded resource cannot have a body");
      continue;
    }
    if (observed) {
      const proof = observed.get(String(r["id"])) ?? (r["bytes"] === 0 ? { bytes: 0, sha256: createHash("sha256").digest("hex") } : undefined);
      if (!proof || proof.bytes !== r["bytes"] || proof.sha256 !== r["sha256"]) issue(issues, `/resources/${i}`, "Streamed bytes and checksum must match", "CLOUDIG_RESOURCE_INTEGRITY");
      continue;
    }
    const hash = createHash("sha256"); let bytes = 0;
    for (const part of (r["data_base64"] ?? []) as string[]) {
      const decoded = Buffer.from(part, "base64");
      if (decoded.toString("base64") !== part) issue(issues, `/resources/${i}/data_base64`, "Noncanonical or invalid Base64");
      bytes += decoded.length; hash.update(decoded);
    }
    if (bytes !== r["bytes"] || hash.digest("hex") !== r["sha256"]) issue(issues, `/resources/${i}`, "Embedded bytes and checksum must match", "CLOUDIG_RESOURCE_INTEGRITY");
  }
  if (observed) for (const id of observed.keys()) if (!resourceIds.has(id)) issue(issues, "/resources", "Byte evidence names an absent resource");
  for (const [key, date] of Object.entries(object(value["lifecycle"]))) utc(date, `/lifecycle/${key}`, issues);
  const source = object(value["source"]);
  for (const key of ["captured_at", "conversation_created_at", "conversation_updated_at"]) utc(source[key], `/source/${key}`, issues);
  if (source["captured_from"] !== undefined && !/^(?:bookmark:.+|source_json:.+|filesystem:creation_time|filesystem:last_write_time)$/u.test(String(source["captured_from"]))) issue(issues, "/source/captured_from", "Unknown capture time basis");
  if (/[\\/]/u.test(String(source["file"]))) issue(issues, "/source/file", "Source file is a basename, not a directory");
  if (value["message_time"]) for (const [key, date] of Object.entries(object(value["message_time"]))) utc(date, `/message_time/${key}`, issues);
}

export function validateRecordSemantics(kind: RecordKind, value: JsonObject, observed?: ReadonlyMap<string, ObservedRecordResource>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  utc(value["edited_at"], "/edited_at", issues);
  if (kind === "identity") front(value, "", issues, "user");
  if (kind === "conversation") conversation(value, issues, observed);
  if (kind === "mark") {
    if (!["conversation_title", "models", "names", "content_time"].some(k => Object.hasOwn(value, k))) issue(issues, "", "An empty Mark has no user setting");
    for (const [i, f] of array(value["models"]).entries()) {
      front(f, `/models/${i}`, issues, "user");
      if (array(f["names"]).some(n => !array(n["claimers"]).length || array(n["claimers"]).some(c => c["front"] === undefined))) issue(issues, `/models/${i}/names`, "User model claims must reference the user's Identity");
    }
    if (value["content_time"]) range(object(object(value["content_time"])["range"]), "/content_time/range", issues);
  }
  if (kind === "contentTime") {
    utc(value["created_at"], "/created_at", issues);
    ids(array(value["contains"]), "node", "/contains", issues);
    if (value["forked_from"] === value["node_id"]) issue(issues, "/forked_from", "A new independent copy cannot fork from itself");
    if (value["display_empty"] === true && Number(value["count"]) > RECORD_TIME_LIMITS.periodic.empty_expand_max) issue(issues, "/display_empty", "Empty expansion exceeds the configured occurrence limit");
    for (const [key, list] of [["counterparts", array(value["counterparts"])], ["terran_mappings", array(value["terran_mappings"])]] as const) {
      for (const [i, relation] of list.entries()) {
        const at = `/${key}/${i}`;
        if (value["kind"] === "periodic") {
          if (!relation["occurrences"]) issue(issues, `${at}/occurrences`, "Periodic relation requires a selection");
          else progression(object(relation["occurrences"]), Number(value["count"]), `${at}/occurrences`, issues);
        } else if (relation["occurrences"] !== undefined) issue(issues, `${at}/occurrences`, "Nonperiodic relation has no occurrences");
        if (relation["range"]) range(object(relation["range"]), `${at}/range`, issues);
        utc(relation["edited_at"], `${at}/edited_at`, issues);
      }
    }
  }
  return issues;
}

/** Cross-file time relations: cycles and shared children are legal; check known targets only. */
export function inspectTimeLinks(nodes: readonly JsonObject[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [], byId = new Map(nodes.map(n => [String(n["node_id"]), n]));
  const counterparts = new Set<string>();
  const selectionKey = (ref: JsonObject | undefined): string => !ref ? "" : ref["all"] === true ? "all" : `${ref["first"]}:${ref["step"]}:${ref["last"]}`;
  if (byId.size !== nodes.length) issue(issues, "", "Duplicate time node UUID");
  for (const node of nodes) {
    const p = `/${pointer(String(node["node_id"]))}`;
    for (const relation of array(node["contains"])) {
      const target = byId.get(String(relation["node"]));
      if (!target) { issue(issues, `${p}/contains`, "Missing referenced node", "CLOUDIG_REFERENCE_MISSING"); continue; }
      if (target["kind"] === "periodic") {
        if (typeof relation["count"] !== "number" || relation["count"] > Number(target["count"])) issue(issues, `${p}/contains`, "Included prefix is out of bounds");
      } else if (relation["count"] !== undefined) issue(issues, `${p}/contains`, "Only a periodic child has a prefix count");
    }
    for (const relation of array(node["counterparts"])) {
      const ref = object(relation["target"]), target = byId.get(String(ref["node"]));
      const ends = [JSON.stringify([node["node_id"], selectionKey(relation["occurrences"] as JsonObject | undefined)]), JSON.stringify([ref["node"], selectionKey(ref["occurrences"] as JsonObject | undefined)])].sort();
      const key = JSON.stringify(ends);
      if (counterparts.has(key)) issue(issues, `${p}/counterparts`, "The same counterpart relation must be stored once");
      counterparts.add(key);
      if (!target) { issue(issues, `${p}/counterparts`, "Missing counterpart", "CLOUDIG_REFERENCE_MISSING"); continue; }
      if (target["kind"] === "periodic") {
        if (!ref["occurrences"]) issue(issues, `${p}/counterparts`, "Periodic counterpart needs a selection");
        else progression(object(ref["occurrences"]), Number(target["count"]), `${p}/counterparts`, issues);
      } else if (ref["occurrences"]) issue(issues, `${p}/counterparts`, "Nonperiodic counterpart has no selection");
    }
  }
  return issues;
}
