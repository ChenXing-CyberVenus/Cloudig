import { Readable } from "node:stream";

import { serializeLibrary } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";
import { cleanupJournal, installJournal, removeCleanJournalFiles, stageJournalTargets } from "../storage/journal.mts";
import { capturePreviousAuthority, readCurrentAuthorityPair } from "../storage/recovery-point.mts";
import { acquireSingleWriter } from "../storage/writer-lock.mts";

export type ParseConfirmationPreferences = Readonly<{
  parse_unparsed: boolean;
  parse_selected: boolean;
  update_outdated: boolean;
  preserve_previous: boolean;
}>;

export type ClaudeWorkflowPreferences = Readonly<{
  sort: "time_asc" | "time_desc" | "title";
  time_field: "created_at" | "updated_at";
}>;

export type ArchiveWorkflowPreferences = Readonly<{
  sort: "time_asc" | "time_desc" | "title";
  time_field: "first_parsed_at" | "source_captured_at" | "cloudig_edited_at" | "file_modified_at" | "message_start" | "message_end" | "content_time_start" | "content_time_end";
}>;

export type WelcomeLibraryState = Readonly<{
  revision: number;
  theme: "dawn" | "star-night";
  language: "zh-CN" | "en";
  themeSwitched: boolean;
  userName: string;
  assistantName: string;
  ordinaryParse: ParseConfirmationPreferences;
  claudeParse: ParseConfirmationPreferences;
  archiverWorkflow: ArchiveWorkflowPreferences;
  readerWorkflow: ArchiveWorkflowPreferences;
  claudeWorkflow: ClaudeWorkflowPreferences;
}>;

const DEFAULT_ORDINARY_PARSE = Object.freeze({
  parse_unparsed: true,
  parse_selected: true,
  update_outdated: false,
  preserve_previous: false
});

const DEFAULT_ARCHIVE_WORKFLOW: ArchiveWorkflowPreferences = Object.freeze({
  sort: "time_desc",
  time_field: "file_modified_at"
});

const ARCHIVE_TIME_FIELDS = new Set<ArchiveWorkflowPreferences["time_field"]>([
  "first_parsed_at",
  "source_captured_at",
  "cloudig_edited_at",
  "file_modified_at",
  "message_start",
  "message_end",
  "content_time_start",
  "content_time_end"
]);

function parseConfirmation(library: JsonObject, kind: "ordinary" | "claude"): ParseConfirmationPreferences {
  const parse = isJsonObject(library["parse"]) ? library["parse"] : {};
  const ordinary = isJsonObject(parse[kind]) ? parse[kind] : {};
  return {
    parse_unparsed: typeof ordinary["parse_unparsed"] === "boolean" ? ordinary["parse_unparsed"] : DEFAULT_ORDINARY_PARSE.parse_unparsed,
    parse_selected: typeof ordinary["parse_selected"] === "boolean" ? ordinary["parse_selected"] : DEFAULT_ORDINARY_PARSE.parse_selected,
    update_outdated: typeof ordinary["update_outdated"] === "boolean" ? ordinary["update_outdated"] : DEFAULT_ORDINARY_PARSE.update_outdated,
    preserve_previous: typeof ordinary["preserve_previous"] === "boolean" ? ordinary["preserve_previous"] : DEFAULT_ORDINARY_PARSE.preserve_previous
  };
}

function claudeWorkflow(library: JsonObject): ClaudeWorkflowPreferences {
  const workflow = isJsonObject(library["workflow"]) ? library["workflow"] : {};
  const claude = isJsonObject(workflow["claude"]) ? workflow["claude"] : {};
  const sort = claude["sort"];
  return {
    sort: sort === "time_asc" || sort === "title" ? sort : "time_desc",
    time_field: claude["time_field"] === "created_at" ? "created_at" : "updated_at"
  };
}

function archiveWorkflow(library: JsonObject, kind: "archiver" | "reader"): ArchiveWorkflowPreferences {
  const workflow = isJsonObject(library["workflow"]) ? library["workflow"] : {};
  const selected = isJsonObject(workflow[kind]) ? workflow[kind] : {};
  const sort = selected["sort"];
  const timeField = selected["time_field"];
  return {
    sort: sort === "time_asc" || sort === "title" ? sort : DEFAULT_ARCHIVE_WORKFLOW.sort,
    time_field: typeof timeField === "string" && ARCHIVE_TIME_FIELDS.has(timeField as ArchiveWorkflowPreferences["time_field"])
      ? timeField as ArchiveWorkflowPreferences["time_field"]
      : DEFAULT_ARCHIVE_WORKFLOW.time_field
  };
}

export function projectWelcomeLibraryState(library: JsonObject): WelcomeLibraryState {
  const preferences = isJsonObject(library["preferences"]) ? library["preferences"] : {};
  const identity = isJsonObject(library["identity"]) ? library["identity"] : {};
  const global = isJsonObject(identity["global"]) ? identity["global"] : {};
  const user = isJsonObject(global["user"]) ? global["user"] : {};
  const assistant = isJsonObject(global["assistant"]) ? global["assistant"] : {};
  const onboarding = isJsonObject(library["onboarding"]) ? library["onboarding"] : {};
  const language = preferences["language"] === "en" ? "en" : "zh-CN";
  return {
    revision: library["revision"] as number,
    theme: preferences["theme"] === "star_night" ? "star-night" : "dawn",
    language,
    themeSwitched: onboarding["theme_switched"] === true,
    userName: typeof user["name"] === "string" ? user["name"] : language === "en" ? "User" : "采云用户",
    assistantName: typeof assistant["name"] === "string" ? assistant["name"] : language === "en" ? "AI" : "智能伙伴",
    ordinaryParse: parseConfirmation(library, "ordinary"),
    claudeParse: parseConfirmation(library, "claude"),
    archiverWorkflow: archiveWorkflow(library, "archiver"),
    readerWorkflow: archiveWorkflow(library, "reader"),
    claudeWorkflow: claudeWorkflow(library)
  };
}

export async function readWelcomeLibraryState(libraryRoot: string): Promise<WelcomeLibraryState> {
  return projectWelcomeLibraryState((await readCurrentAuthorityPair(libraryRoot)).library);
}

export async function commitLibraryPreferences(input: Readonly<{
  libraryRoot: string;
  expectedRevision: number;
  theme?: "dawn" | "star-night";
  language?: "zh-CN" | "en";
  ordinaryParse?: WelcomeLibraryState["ordinaryParse"];
  claudeParse?: WelcomeLibraryState["claudeParse"];
  archiverWorkflow?: WelcomeLibraryState["archiverWorkflow"];
  readerWorkflow?: WelcomeLibraryState["readerWorkflow"];
  claudeWorkflow?: WelcomeLibraryState["claudeWorkflow"];
  transaction: string;
  recoveryTransaction: string;
  timestamp: string;
}>): Promise<Readonly<{ status: "updated" | "unchanged" | "conflict"; state?: WelcomeLibraryState }>> {
  if (input.transaction === input.recoveryTransaction) throw new TypeError("Preference and recovery transactions must differ");
  const writer = await acquireSingleWriter(input.libraryRoot);
  try {
    const authority = await readCurrentAuthorityPair(input.libraryRoot);
    if (authority.library["revision"] !== input.expectedRevision) return { status: "conflict" };
    const previous = projectWelcomeLibraryState(authority.library);
    const nextTheme = input.theme ?? previous.theme;
    const nextLanguage = input.language ?? previous.language;
    const nextOrdinaryParse = input.ordinaryParse ?? previous.ordinaryParse;
    const nextClaudeParse = input.claudeParse ?? previous.claudeParse;
    const nextArchiverWorkflow = input.archiverWorkflow ?? previous.archiverWorkflow;
    const nextReaderWorkflow = input.readerWorkflow ?? previous.readerWorkflow;
    const nextClaudeWorkflow = input.claudeWorkflow ?? previous.claudeWorkflow;
    const switched = previous.themeSwitched || (input.theme !== undefined && input.theme !== previous.theme);
    if (nextTheme === previous.theme
      && nextLanguage === previous.language
      && switched === previous.themeSwitched
      && Object.keys(DEFAULT_ORDINARY_PARSE).every((key) => nextOrdinaryParse[key as keyof typeof DEFAULT_ORDINARY_PARSE] === previous.ordinaryParse[key as keyof typeof DEFAULT_ORDINARY_PARSE])
      && Object.keys(DEFAULT_ORDINARY_PARSE).every((key) => nextClaudeParse[key as keyof typeof DEFAULT_ORDINARY_PARSE] === previous.claudeParse[key as keyof typeof DEFAULT_ORDINARY_PARSE])
      && nextArchiverWorkflow.sort === previous.archiverWorkflow.sort
      && nextArchiverWorkflow.time_field === previous.archiverWorkflow.time_field
      && nextReaderWorkflow.sort === previous.readerWorkflow.sort
      && nextReaderWorkflow.time_field === previous.readerWorkflow.time_field
      && nextClaudeWorkflow.sort === previous.claudeWorkflow.sort
      && nextClaudeWorkflow.time_field === previous.claudeWorkflow.time_field) {
      return { status: "unchanged", state: previous };
    }
    const next = structuredClone(authority.library);
    const preferences = isJsonObject(next["preferences"]) ? next["preferences"] : {};
    preferences["theme"] = nextTheme === "star-night" ? "star_night" : "dawn";
    preferences["language"] = nextLanguage;
    next["preferences"] = preferences;
    const parse = isJsonObject(next["parse"]) ? next["parse"] : {};
    parse["ordinary"] = { ...nextOrdinaryParse };
    parse["claude"] = { ...nextClaudeParse };
    next["parse"] = parse;
    const workflow = isJsonObject(next["workflow"]) ? next["workflow"] : {};
    workflow["archiver"] = { ...nextArchiverWorkflow };
    workflow["reader"] = { ...nextReaderWorkflow };
    workflow["claude"] = { ...nextClaudeWorkflow };
    next["workflow"] = workflow;
    if (switched) {
      const onboarding = isJsonObject(next["onboarding"]) ? next["onboarding"] : {};
      onboarding["theme_switched"] = true;
      next["onboarding"] = onboarding;
    }
    next["revision"] = input.expectedRevision + 1;
    next["edited_at"] = input.timestamp;
    const bytes = Buffer.from(serializeLibrary(next), "utf8");
    const recovery = await capturePreviousAuthority(input.libraryRoot, {
      transaction: input.recoveryTransaction,
      recordedAt: input.timestamp,
      alreadyCapturedThisBatch: false
    });
    if (recovery === "conflict") return { status: "conflict" };
    const journal: JsonObject = {
      schema: "cloudig/transaction/1.0.0",
      transaction: input.transaction,
      state: "planned",
      intent: "update-library-preferences",
      created_at: input.timestamp,
      updated_at: input.timestamp,
      authority: {
        library: { state: "present", revision: input.expectedRevision, sha256: authority.libraryFingerprint.sha256 },
        time: { state: "present", revision: authority.time["revision"]!, sha256: authority.timeFingerprint.sha256 }
      },
      targets: [{
        action: "replace",
        path: "cloudig-library.json",
        status: "planned",
        expected_before: { state: "present", ...authority.libraryFingerprint },
        semantic: { kind: "library" }
      }]
    };
    const staged = await stageJournalTargets(input.libraryRoot, journal, new Map([[0, Readable.from([bytes])]]));
    const committed = await installJournal(input.libraryRoot, staged);
    if (committed["state"] !== "committed") return { status: "conflict" };
    const installed = await readCurrentAuthorityPair(input.libraryRoot);
    if (installed.library["revision"] !== input.expectedRevision + 1) throw new TypeError("Preference update installed the wrong revision");
    const cleaned = await cleanupJournal(input.libraryRoot, committed);
    await removeCleanJournalFiles(input.libraryRoot, input.transaction);
    if (cleaned["state"] !== "cleaned") throw new TypeError("Preference update cleanup failed");
    return { status: "updated", state: projectWelcomeLibraryState(installed.library) };
  } finally {
    await writer.release();
  }
}
