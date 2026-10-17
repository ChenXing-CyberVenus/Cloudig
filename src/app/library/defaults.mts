import { createHash } from "node:crypto";

import {
  serializeLibrary,
  serializeTimeSystem,
  validateLibrary,
  validateTimeSystem
} from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";

export type InitialAuthority = Readonly<{
  library: JsonObject;
  time: JsonObject;
  libraryBytes: Buffer;
  timeBytes: Buffer;
}>;

export function createInitialAuthority(input: Readonly<{
  timestamp: string;
  localDate: string;
  offset: string;
  language: "zh-CN" | "en";
}>): InitialAuthority {
  const anchor = { date: input.localDate, offset: input.offset };
  const time: JsonObject = {
    schema: "cloudig/time-system/1.0.0",
    revision: 1,
    edited_at: input.timestamp,
    next: { lineage: 1, variant: 1, time: 1 },
    terran_values: {
      p13: {
        start: { kind: "decade", era: "AD", index: 194 },
        end: { kind: "now", anchor }
      },
      p14: {
        start: { kind: "calendar", era: "AD", year: 2017, month: 6, day: 12 },
        end: { kind: "now", anchor }
      },
      p15: {
        start: { kind: "now", anchor },
        end: { kind: "calendar", era: "AD", year: 9999 }
      }
    }
  };
  const timeValidation = validateTimeSystem(time);
  if (!timeValidation.ok) throw new TypeError(`Initial Time System is invalid: ${timeValidation.issues.map((entry) => entry.code).join(",")}`);
  const timeBytes = Buffer.from(serializeTimeSystem(time), "utf8");
  const library: JsonObject = {
    schema: "cloudig/library/1.0.0",
    conversation_schema: "cloudig/conversation/1.0.0",
    next_archive: 1,
    revision: 1,
    edited_at: input.timestamp,
    preferences: { language: input.language, theme: "dawn" },
    parse: {
      ordinary: { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false },
      claude: { parse_unparsed: true, parse_selected: true, update_outdated: false, preserve_previous: false }
    },
    workflow: {
      parser: { sort: "time_desc", time_field: "file_modified_at" },
      archiver: { sort: "time_desc", time_field: "file_modified_at" },
      reader: { sort: "time_desc", time_field: "file_modified_at" },
      claude: { sort: "time_desc", time_field: "updated_at" }
    },
    content_time: {
      schema: "cloudig/time-system/1.0.0",
      revision: 1,
      sha256: createHash("sha256").update(timeBytes).digest("hex")
    }
  };
  const libraryValidation = validateLibrary(library);
  if (!libraryValidation.ok) throw new TypeError(`Initial Library is invalid: ${libraryValidation.issues.map((entry) => entry.code).join(",")}`);
  return {
    library,
    time,
    libraryBytes: Buffer.from(serializeLibrary(library), "utf8"),
    timeBytes
  };
}
