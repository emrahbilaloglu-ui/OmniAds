export const META_LAUNCHPAD_MANUAL_ACTION_ORIGIN =
  "launchpad_manual_v1" as const;
export const META_LAUNCHPAD_MANUAL_CONFIRMATION =
  "explicit_operator_confirmation" as const;

export interface MetaLaunchpadManualAuthority {
  actionOrigin: typeof META_LAUNCHPAD_MANUAL_ACTION_ORIGIN;
  manualConfirmation: typeof META_LAUNCHPAD_MANUAL_CONFIRMATION;
}

export const META_LAUNCHPAD_MANUAL_AUTHORITY = Object.freeze({
  actionOrigin: META_LAUNCHPAD_MANUAL_ACTION_ORIGIN,
  manualConfirmation: META_LAUNCHPAD_MANUAL_CONFIRMATION,
}) satisfies MetaLaunchpadManualAuthority;

export const META_NATIVE_LINEAGE_FIELDS = [
  "contractVersion",
  "contract_version",
  "snapshotId",
  "snapshot_id",
  "evaluationId",
  "evaluation_id",
  "engineVersion",
  "engine_version",
  "decisionHash",
  "decision_hash",
  "decisionAction",
  "decision_action",
  "lineage",
  "decisionOrigin",
  "decision_origin",
  "sourceDecisionId",
  "source_decision_id",
  "sourceDecisionSnapshotId",
  "source_decision_snapshot_id",
  "decisionId",
  "decision_id",
  "decisionSnapshotId",
  "decision_snapshot_id",
  "decisionEvaluationId",
  "decision_evaluation_id",
  "decisionReason",
  "decision_reason",
  "nativeEngineVersion",
  "native_engine_version",
] as const;

export const META_MANUAL_EXECUTION_FIELDS = [
  "manualConfirmation",
  "manual_confirmation",
  "manualLaunch",
  "manual_launch",
  "launchpadManual",
  "launchpad_manual",
  "launchIntentId",
  "launch_intent_id",
  "launchIntentRequestFingerprint",
  "launch_intent_request_fingerprint",
  "executionAuthority",
  "execution_authority",
] as const;

export const META_ACTION_ORIGIN_ALIAS_FIELDS = [
  "action_origin",
  "executionOrigin",
  "execution_origin",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function presentMetaActionContractFields(
  value: unknown,
  fields: readonly string[],
) {
  if (!isRecord(value)) return [];
  return fields.filter((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

/**
 * `dryRun` is an execution-mode discriminator, not a truthy flag. If a caller
 * sends the field, only a real JSON boolean is accepted; strings/numbers must
 * never silently fall through to live execution.
 */
export function hasInvalidMetaDryRunField(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "dryRun") &&
    typeof value.dryRun !== "boolean"
  );
}

export type MetaLaunchpadManualAuthorityResult =
  | { ok: true; authority: MetaLaunchpadManualAuthority }
  | {
      ok: false;
      status: 400;
      error: { code: string; message: string };
    };

/**
 * Launchpad provider writes are an explicit manual contract. They must never be
 * inferred from the presence or absence of decision-lineage fields.
 */
export function evaluateMetaLaunchpadManualAuthority(
  value: unknown,
): MetaLaunchpadManualAuthorityResult {
  const body = isRecord(value) ? value : {};
  if (body.actionOrigin !== META_LAUNCHPAD_MANUAL_ACTION_ORIGIN) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "action_origin_required",
        message: `actionOrigin must be exactly ${META_LAUNCHPAD_MANUAL_ACTION_ORIGIN}.`,
      },
    };
  }
  if (body.manualConfirmation !== META_LAUNCHPAD_MANUAL_CONFIRMATION) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "manual_confirmation_required",
        message:
          "manualConfirmation must prove the current operator explicitly acknowledged the provider write.",
      },
    };
  }
  const mixedFields = [
    ...presentMetaActionContractFields(body, META_NATIVE_LINEAGE_FIELDS),
    ...presentMetaActionContractFields(body, META_ACTION_ORIGIN_ALIAS_FIELDS),
  ];
  if (mixedFields.length > 0) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "mixed_action_origin_contract",
        message: `Manual Launchpad requests cannot carry native decision lineage fields: ${mixedFields.join(", ")}.`,
      },
    };
  }
  return {
    ok: true,
    authority: { ...META_LAUNCHPAD_MANUAL_AUTHORITY },
  };
}

export function bindMetaLaunchpadManualAuthorityToPayload<T extends object>(
  requestPayload: T,
  authority: MetaLaunchpadManualAuthority,
): T & { executionAuthority: MetaLaunchpadManualAuthority } {
  return {
    ...requestPayload,
    executionAuthority: { ...authority },
  };
}

export function metaLaunchpadActionLogAuthority(input: {
  authority: MetaLaunchpadManualAuthority;
  requestFingerprint: string;
}) {
  return {
    action_origin: input.authority.actionOrigin,
    manual_confirmation: input.authority.manualConfirmation,
    launch_intent_request_fingerprint: input.requestFingerprint,
  };
}
