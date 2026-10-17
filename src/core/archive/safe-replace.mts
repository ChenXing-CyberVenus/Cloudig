import { canonicalizeJcs } from "../contracts/deterministic-json.mts";
import type { JsonValue } from "../contracts/types.mts";

export type Fingerprint = Readonly<{
  bytes: number;
  sha256: string;
}>;

export type SourceLineIdentity = Readonly<{
  format: string;
  platform: string;
  family?: string;
  payload?: string;
  profile?: string;
  selector?: JsonValue;
}>;

export type RegisteredBinding = Readonly<{
  fresh: boolean;
  sourcePath: string;
  sourceFingerprint: Fingerprint;
  sourceIdentity: SourceLineIdentity;
  archive: string;
  generation: number;
  targetPath: string;
  targetFingerprint: Fingerprint;
}>;

export type ObservedTarget = Readonly<{
  path: string;
  fingerprint: Fingerprint;
  schemaSupported: boolean;
  archive: string;
  generation: number;
}>;

export type CandidateIdentity = Readonly<{
  valid: boolean;
  archive?: string;
  generation?: number;
}>;

export type TranslationCompatibility =
  | "same_adapter"
  | "none"
  | "reparse_source"
  | "redownload_source"
  | "upgrade_cloudig"
  | "unsupported"
  | "unknown_policy";

export type ArchiveWriteDecision = Readonly<{
  action:
    | "unchanged"
    | "replace"
    | "create_new"
    | "conflict"
    | "reject_candidate"
    | "redownload_required"
    | "upgrade_required"
    | "unsupported";
  reason: string;
  archive?: string;
  generation?: number;
  copyUserState?: boolean;
}>;

export type ArchiveWriteEvidence = Readonly<{
  source: {
    path: string;
    fingerprint: Fingerprint;
    identity: SourceLineIdentity;
  };
  binding?: RegisteredBinding;
  target?: ObservedTarget;
  candidate: CandidateIdentity;
  compatibility: TranslationCompatibility;
  preservePrevious: boolean;
  copyUserStateOnPreserve: boolean;
  expectedStillCurrent: boolean;
  registeredPathMigrationProven: boolean;
}>;

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function sameSourceLine(left: SourceLineIdentity, right: SourceLineIdentity): boolean {
  return canonicalizeJcs(left) === canonicalizeJcs(right);
}

function createNew(reason: string, copyUserState = false): ArchiveWriteDecision {
  return { action: "create_new", reason, copyUserState };
}

export function decideArchiveWrite(evidence: ArchiveWriteEvidence): ArchiveWriteDecision {
  if (!evidence.candidate.valid) return { action: "reject_candidate", reason: "candidate_invalid" };
  if (!evidence.binding) return createNew("new_source_unit");
  if (evidence.preservePrevious) return createNew("preserve_previous", evidence.copyUserStateOnPreserve);
  if (!evidence.binding.fresh) return createNew("catalog_binding_stale");
  if (evidence.source.path !== evidence.binding.sourcePath) {
    if (
      !evidence.registeredPathMigrationProven
      || !sameFingerprint(evidence.source.fingerprint, evidence.binding.sourceFingerprint)
    ) {
      return createNew("different_source_path");
    }
  }
  if (!sameSourceLine(evidence.source.identity, evidence.binding.sourceIdentity)) return createNew("source_line_identity_changed");
  if (!evidence.target || !evidence.target.schemaSupported) return createNew("target_untrusted");
  if (
    evidence.target.path !== evidence.binding.targetPath
    || evidence.target.archive !== evidence.binding.archive
    || evidence.target.generation !== evidence.binding.generation
    || !sameFingerprint(evidence.target.fingerprint, evidence.binding.targetFingerprint)
  ) {
    return createNew("target_binding_mismatch");
  }
  if (!evidence.expectedStillCurrent) return { action: "conflict", reason: "expected_state_changed" };

  switch (evidence.compatibility) {
    case "redownload_source":
      return { action: "redownload_required", reason: "missing_capture_capability" };
    case "upgrade_cloudig":
      return { action: "upgrade_required", reason: "parser_too_old" };
    case "unsupported":
      return { action: "unsupported", reason: evidence.compatibility };
    case "unknown_policy":
      return createNew("unknown_policy");
    default:
      break;
  }

  const sourceUnchanged = sameFingerprint(evidence.source.fingerprint, evidence.binding.sourceFingerprint);
  if (sourceUnchanged && evidence.compatibility !== "reparse_source") {
    return {
      action: "unchanged",
      reason: evidence.source.path === evidence.binding.sourcePath ? "registered_source_unchanged" : "registered_source_moved",
      archive: evidence.binding.archive,
      generation: evidence.binding.generation
    };
  }
  if (
    evidence.candidate.archive !== evidence.binding.archive
    || evidence.candidate.generation !== evidence.binding.generation + 1
  ) {
    return { action: "reject_candidate", reason: "candidate_identity_mismatch" };
  }
  return {
    action: "replace",
    reason: sourceUnchanged ? "adapter_reparse" : "registered_source_changed",
    archive: evidence.binding.archive,
    generation: evidence.binding.generation + 1,
    copyUserState: true
  };
}
