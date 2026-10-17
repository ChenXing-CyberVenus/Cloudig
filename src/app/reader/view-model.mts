import { ContractValidationError, validateConversation, validateConversationMetadata, type ObservedResourceBody } from "../../core/contracts/index.mts";
import type { JsonObject } from "../../core/contracts/types.mts";
import { validateRecord, validateConversationRecordMetadata, type ObservedRecordResource } from "../../core/records/index.mts";
import { projectRecordForReading, type RecordPresentation } from "../../core/records/presentation.mts";
import { buildConversationPageCore, type ConversationViewSource, type ConversationViewPageInput } from "./view-model-core.mts";
export { DEFAULT_READER_SESSION, conversationMessagePath } from "./view-model-core.mts";
export type { ReaderSessionPreferences, ConversationPageRequest, ConversationViewSource, ConversationViewPageInput } from "./view-model-core.mts";

function validatedConversation(value: JsonObject, resourceBodies?: ReadonlyMap<string, ObservedResourceBody>): JsonObject {
  const result = resourceBodies
    ? validateConversationMetadata(value, resourceBodies)
    : validateConversation(value);
  if (result.ok) return result.value;
  throw new ContractValidationError("Conversation failed contract validation", result.issues);
}

export class PreparedConversationView {
  readonly #source: ConversationViewSource;

  constructor(input: ConversationViewSource) {
    this.#source = {
      conversation: validatedConversation(input.conversation, input.resourceBodies),
      resolved: input.resolved,
      ...(input.resourceBodies ? { resourceBodies: input.resourceBodies } : {})
    };
  }

  page(input: ConversationViewPageInput): JsonObject {
    return buildConversationPageCore({ ...this.#source, ...input }, this.#source.conversation);
  }
}

export function prepareConversationView(input: ConversationViewSource): PreparedConversationView {
  return new PreparedConversationView(input);
}

export function buildConversationPage(input: ConversationViewSource & ConversationViewPageInput): JsonObject {
  return prepareConversationView(input).page(input);
}

export function prepareRecordConversationView(input: Readonly<{ conversation: JsonObject; resolved: RecordPresentation; mark?: JsonObject; resourceBodies?: ReadonlyMap<string, ObservedRecordResource>; resolveAgentAvatar?: (reference: string) => string }>): Readonly<{ page(request: ConversationViewPageInput): JsonObject }> {
  const valid = input.resourceBodies ? validateConversationRecordMetadata(input.conversation, input.resourceBodies) : validateRecord("conversation", input.conversation);
  if (!valid.ok) throw new TypeError(`Invalid Conversation record: ${JSON.stringify(valid.issues)}`);
  if (input.mark) {
    const mark = validateRecord("mark", input.mark);
    if (!mark.ok || input.mark["target"] !== input.conversation["conversation_id"]) throw new TypeError("Invalid or unrelated Mark");
  }
  const conversation = projectRecordForReading(input.conversation, input.resolved, input.mark, input.resolveAgentAvatar ? { resolveAgentAvatar: input.resolveAgentAvatar } : undefined);
  return { page: request => buildConversationPageCore({ conversation, resolved: input.resolved, ...request }, conversation) };
}
