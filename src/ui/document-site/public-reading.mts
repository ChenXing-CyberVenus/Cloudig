import type { JsonObject } from '../../core/contracts/types.mts';
import type { BuiltinIdentity } from '../../core/library/overlay.mts';
import { resolveRecordPresentation, projectRecordForReading } from '../../core/records/presentation.mts';
import { buildConversationPageCore, type ReaderSessionPreferences } from '../../app/reader/view-model-core.mts';
import limits from '../../core/contracts/machine/resource-limits.json' with { type: 'json' };

/** Only build-validated public examples. No filesystem, Engine, Library or Mark. */
export function preparePublicReading(record: JsonObject, language: 'zh-CN' | 'en', builtins: BuiltinIdentity) {
  const resolved = resolveRecordPresentation({ conversation:record, language, bindings:{}, identities:new Map(), availableAssets:new Set(), builtins });
  const conversation = projectRecordForReading(record, resolved);
  return {
    page(session: ReaderSessionPreferences, offsets: { messages?:number; navigation?:number; branches?:number } = {}) {
      return buildConversationPageCore({ conversation, resolved, session,
        page:{offset:offsets.messages ?? 0,limit:limits.reader_message_page_max},
        navigationPage:{offset:offsets.navigation ?? 0,limit:limits.reader_navigation_page_max},
        branchPage:{offset:offsets.branches ?? 0,limit:limits.reader_branch_page_max}
      }, conversation);
    }
  };
}
