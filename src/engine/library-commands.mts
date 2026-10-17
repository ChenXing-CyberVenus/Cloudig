import { commitLibraryPreferences, createLocalLibrary, inspectLocalLibrary, readWelcomeLibraryState, restoreAuthorityFromConversationSnapshots, type ArchiveWorkflowPreferences } from "../adapters/library-data/index.mts";
import { cleanupJournal, recoverJournal, removeCleanJournalFiles, restorePreviousAuthority } from "../adapters/storage/index.mts";
import type { JsonObject } from "../core/contracts/types.mts";
import { EngineCommandError, type EngineCommandHandler } from "./protocol.mts";
import { engineTransactionId } from "./transaction.mts";

function state(value: Awaited<ReturnType<typeof readWelcomeLibraryState>>): JsonObject {
  return {
    revision: value.revision,
    theme: value.theme,
    language: value.language,
    theme_switched: value.themeSwitched,
    user_name: value.userName,
    assistant_name: value.assistantName,
    parse_ordinary: { ...value.ordinaryParse },
    parse_claude: { ...value.claudeParse },
    workflow_archiver: { ...value.archiverWorkflow },
    workflow_reader: { ...value.readerWorkflow },
    workflow_claude: { ...value.claudeWorkflow }
  };
}

const ARCHIVE_TIME_FIELDS = new Set<ArchiveWorkflowPreferences["time_field"]>([
  "first_parsed_at",
  "source_captured_at",
  "cloudig_edited_at",
  "message_start",
  "message_end",
  "content_time_start",
  "content_time_end"
]);

function archiveWorkflow(value: unknown): value is ArchiveWorkflowPreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const workflow = value as Record<string, unknown>;
  return Object.keys(workflow).sort().join("|") === "sort|time_field"
    && ["time_asc", "time_desc", "title"].includes(String(workflow["sort"]))
    && typeof workflow["time_field"] === "string"
    && ARCHIVE_TIME_FIELDS.has(workflow["time_field"] as ArchiveWorkflowPreferences["time_field"]);
}

function localAnchor(): Readonly<{ date: string; offset: string }> {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const minutes = -now.getTimezoneOffset();
  if (minutes === 0) return { date, offset: "Z" };
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return { date, offset: `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}` };
}

export class LibraryEngineCommands {
  readonly #libraryRoot: string;

  constructor(libraryRoot: string) {
    this.#libraryRoot = libraryRoot;
  }

  handlers(): Readonly<Record<string, EngineCommandHandler>> {
    return {
      "library.create": async (payload) => {
        if (Object.keys(payload).length !== 0) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Library creation payload must be empty");
        const anchor = localAnchor();
        const pair = await createLocalLibrary({
          root: this.#libraryRoot,
          transaction: engineTransactionId(),
          timestamp: new Date().toISOString(),
          localDate: anchor.date,
          offset: anchor.offset,
          language: "zh-CN"
        });
        return { status: "created", revision: pair.library["revision"]! };
      },
      "library.startup.recover": async (payload) => {
        if (Object.keys(payload).length !== 0) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Startup recovery payload must be empty");
        let inspection = await inspectLocalLibrary(this.#libraryRoot);
        let reconciled = false;
        if (inspection.status === "transaction_recovery") {
          for (const transaction of inspection.transactions) {
            const recovered = await recoverJournal(this.#libraryRoot, transaction);
            if (!["committed", "rolled_back"].includes(String(recovered["state"]))) {
              throw new EngineCommandError("CLOUDIG_TRANSACTION_RECOVERY_FAILED", "An interrupted Library transaction could not be recovered");
            }
            const cleaned = await cleanupJournal(this.#libraryRoot, recovered);
            if (cleaned["state"] !== "cleaned") throw new EngineCommandError("CLOUDIG_TRANSACTION_RECOVERY_FAILED", "An interrupted Library transaction could not be cleaned");
            await removeCleanJournalFiles(this.#libraryRoot, transaction);
          }
          reconciled = true;
          inspection = await inspectLocalLibrary(this.#libraryRoot);
        }
        if (inspection.status === "recovery_available") {
          const restored = await restorePreviousAuthority(this.#libraryRoot, {
            transaction: engineTransactionId(),
            restoredAt: new Date().toISOString()
          });
          return { status: "restored", revision: restored.library["revision"]! };
        }
        if (inspection.status === "valid") return { status: reconciled ? "reconciled" : "valid", revision: inspection.pair.library["revision"]! };
        if (inspection.status === "unsupported") return { status: "unsupported", schema: inspection.schema };
        if (inspection.status === "unsafe") {
          try {
            const anchor = localAnchor();
            return await restoreAuthorityFromConversationSnapshots({
              libraryRoot: this.#libraryRoot,
              transaction: engineTransactionId(),
              restoredAt: new Date().toISOString(),
              localDate: anchor.date,
              offset: anchor.offset
            });
          } catch {
            return { status: "unsafe" };
          }
        }
        return { status: inspection.status };
      },
      "library.preferences.query": async (payload) => {
        if (Object.keys(payload).length !== 0) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Preference query payload must be empty");
        return state(await readWelcomeLibraryState(this.#libraryRoot));
      },
      "library.preferences.commit": async (payload) => {
        const keys = Object.keys(payload);
        if (!keys.includes("expected_revision") || keys.some((key) => !["expected_revision", "theme", "language", "parse_ordinary", "parse_claude", "workflow_archiver", "workflow_reader", "workflow_claude"].includes(key))) {
          throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Preference commit payload is invalid");
        }
        const expected = payload["expected_revision"];
        const theme = payload["theme"];
        const language = payload["language"];
        const ordinary = payload["parse_ordinary"];
        const claude = payload["parse_claude"];
        const archiverWorkflow = payload["workflow_archiver"];
        const readerWorkflow = payload["workflow_reader"];
        const claudeWorkflow = payload["workflow_claude"];
        if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Preference revision is invalid");
        if (theme !== undefined && theme !== "dawn" && theme !== "star-night") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Preference theme is invalid");
        if (language !== undefined && language !== "zh-CN" && language !== "en") throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Preference language is invalid");
        if (ordinary !== undefined && (
          ordinary === null
          || typeof ordinary !== "object"
          || Array.isArray(ordinary)
          || Object.keys(ordinary).sort().join("|") !== "parse_selected|parse_unparsed|preserve_previous|update_outdated"
          || Object.values(ordinary).some((value) => typeof value !== "boolean")
        )) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Ordinary parse preferences are invalid");
        if (claude !== undefined && (
          claude === null
          || typeof claude !== "object"
          || Array.isArray(claude)
          || Object.keys(claude).sort().join("|") !== "parse_selected|parse_unparsed|preserve_previous|update_outdated"
          || Object.values(claude).some((value) => typeof value !== "boolean")
        )) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Claude parse preferences are invalid");
        if (archiverWorkflow !== undefined && !archiveWorkflow(archiverWorkflow)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Archiver workflow preferences are invalid");
        if (readerWorkflow !== undefined && !archiveWorkflow(readerWorkflow)) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Reader workflow preferences are invalid");
        if (claudeWorkflow !== undefined && (
          claudeWorkflow === null
          || typeof claudeWorkflow !== "object"
          || Array.isArray(claudeWorkflow)
          || Object.keys(claudeWorkflow).sort().join("|") !== "sort|time_field"
          || !["time_asc", "time_desc", "title"].includes(String((claudeWorkflow as Record<string, unknown>)["sort"]))
          || !["created_at", "updated_at"].includes(String((claudeWorkflow as Record<string, unknown>)["time_field"]))
        )) throw new EngineCommandError("CLOUDIG_IPC_PAYLOAD_INVALID", "Claude workflow preferences are invalid");
        const result = await commitLibraryPreferences({
          libraryRoot: this.#libraryRoot,
          expectedRevision: expected,
          ...(theme === "dawn" || theme === "star-night" ? { theme } : {}),
          ...(language === "zh-CN" || language === "en" ? { language } : {}),
          ...(ordinary && typeof ordinary === "object" && !Array.isArray(ordinary) ? { ordinaryParse: ordinary as {
            parse_unparsed: boolean;
            parse_selected: boolean;
            update_outdated: boolean;
            preserve_previous: boolean;
          } } : {}),
          ...(claude && typeof claude === "object" && !Array.isArray(claude) ? { claudeParse: claude as {
            parse_unparsed: boolean;
            parse_selected: boolean;
            update_outdated: boolean;
            preserve_previous: boolean;
          } } : {}),
          ...(archiveWorkflow(archiverWorkflow) ? { archiverWorkflow } : {}),
          ...(archiveWorkflow(readerWorkflow) ? { readerWorkflow } : {}),
          ...(claudeWorkflow && typeof claudeWorkflow === "object" && !Array.isArray(claudeWorkflow) ? { claudeWorkflow: claudeWorkflow as {
            sort: "time_asc" | "time_desc" | "title";
            time_field: "created_at" | "updated_at";
          } } : {}),
          transaction: engineTransactionId(),
          recoveryTransaction: engineTransactionId(),
          timestamp: new Date().toISOString()
        });
        if (result.status === "conflict") throw new EngineCommandError("CLOUDIG_LIBRARY_REVISION_CONFLICT", "Library changed; refresh preferences and try again");
        return { status: result.status, ...state(result.state!) };
      }
    };
  }
}
