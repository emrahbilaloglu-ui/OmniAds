export const META_LAUNCHPAD_MANUAL_ACTION_ORIGIN =
  "launchpad_manual_v1" as const;
export const META_LAUNCHPAD_MANUAL_CONFIRMATION =
  "explicit_operator_confirmation" as const;

/**
 * The authority a PERSON binds when they confirm a create on the review screen
 * or approve one in the queue. Exact, and never inferred.
 */
export interface MetaLaunchpadOperatorAuthority {
  actionOrigin: typeof META_LAUNCHPAD_MANUAL_ACTION_ORIGIN;
  manualConfirmation: typeof META_LAUNCHPAD_MANUAL_CONFIRMATION;
}

export const META_LAUNCHPAD_MANUAL_AUTHORITY = Object.freeze({
  actionOrigin: META_LAUNCHPAD_MANUAL_ACTION_ORIGIN,
  manualConfirmation: META_LAUNCHPAD_MANUAL_CONFIRMATION,
}) satisfies MetaLaunchpadOperatorAuthority;

export const META_LAUNCHPAD_STAGED_ACTION_ORIGIN =
  "launchpad_decision_staged_v1" as const;
export const META_LAUNCHPAD_STAGED_CONFIRMATION =
  "decision_staged_approval" as const;

/**
 * The authority a BACKGROUND producer binds when it stages an intent.
 *
 * `launch-intent-producer.ts` composes nothing: it stages an intent only when a
 * named person has already reviewed the brief for that exact decision and
 * composed the draft that names the asset, the copy mode and the exact
 * destination. That is a real approval, and it is not the same act as an
 * operator standing at a screen and confirming this provider write — nobody
 * pressed anything at the moment the producer ran.
 *
 * So it gets its own pair of words. `decision_staged_approval` says what is
 * true (a reviewed decision was staged for later) and refuses to say what is
 * not (`explicit_operator_confirmation`). The two origins stay distinguishable
 * in every place a launch is journalled, so a reader can always tell an
 * operator-staged launch from a producer-staged one.
 */
export interface MetaLaunchpadStagedAuthority {
  actionOrigin: typeof META_LAUNCHPAD_STAGED_ACTION_ORIGIN;
  manualConfirmation: typeof META_LAUNCHPAD_STAGED_CONFIRMATION;
}

export const META_LAUNCHPAD_STAGED_AUTHORITY = Object.freeze({
  actionOrigin: META_LAUNCHPAD_STAGED_ACTION_ORIGIN,
  manualConfirmation: META_LAUNCHPAD_STAGED_CONFIRMATION,
}) satisfies MetaLaunchpadStagedAuthority;

/**
 * The two authorities a stored launch payload may carry, and nothing else.
 *
 * A union of two exact pairs rather than two loose fields: a payload can never
 * carry an operator origin beside a staged confirmation, or the reverse.
 */
export type MetaLaunchExecutionAuthority =
  | MetaLaunchpadOperatorAuthority
  | MetaLaunchpadStagedAuthority;

/**
 * @deprecated Use `MetaLaunchpadOperatorAuthority` for the operator's own pair,
 * or `MetaLaunchExecutionAuthority` where either may appear.
 *
 * Kept as an alias of the union because the receipt and create signatures in
 * `lib/launchpad/meta-launch-intent.ts` and
 * `lib/launchpad/meta-launch-execution.ts` import this name, and both now carry
 * either authority. The runtime contract those signatures sit behind is
 * unchanged: `evaluateMetaLaunchpadManualAuthority` still refuses any request
 * body that is not exactly the operator pair.
 */
export type MetaLaunchpadManualAuthority = MetaLaunchExecutionAuthority;

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
  | { ok: true; authority: MetaLaunchpadOperatorAuthority }
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

/**
 * Bind an authority into the payload the request fingerprint is taken over.
 *
 * Generic in the authority so the bound value keeps its exact type: a payload
 * bound with the staged pair is statically a staged-payload, and the caller
 * that later reads it back cannot quietly treat it as an operator confirmation.
 */
export function bindMetaLaunchExecutionAuthorityToPayload<
  T extends object,
  A extends MetaLaunchExecutionAuthority,
>(requestPayload: T, authority: A): T & { executionAuthority: A } {
  return {
    ...requestPayload,
    executionAuthority: { ...authority },
  };
}

export function bindMetaLaunchpadManualAuthorityToPayload<T extends object>(
  requestPayload: T,
  authority: MetaLaunchExecutionAuthority,
): T & { executionAuthority: MetaLaunchExecutionAuthority } {
  return bindMetaLaunchExecutionAuthorityToPayload(requestPayload, authority);
}

/**
 * Read an authority back out of a stored payload, by exact pair.
 *
 * A value that is neither pair is `null` rather than a partial authority. That
 * matters most for the unattended arm, whose whole question is "what did the
 * person who staged this actually approve" — a half-recognised value would be
 * answered as though it were one of them.
 */
export function readMetaLaunchExecutionAuthority(
  value: unknown,
): MetaLaunchExecutionAuthority | null {
  if (!isRecord(value)) return null;
  if (
    value.actionOrigin === META_LAUNCHPAD_MANUAL_ACTION_ORIGIN
    && value.manualConfirmation === META_LAUNCHPAD_MANUAL_CONFIRMATION
  ) {
    return { ...META_LAUNCHPAD_MANUAL_AUTHORITY };
  }
  if (
    value.actionOrigin === META_LAUNCHPAD_STAGED_ACTION_ORIGIN
    && value.manualConfirmation === META_LAUNCHPAD_STAGED_CONFIRMATION
  ) {
    return { ...META_LAUNCHPAD_STAGED_AUTHORITY };
  }
  return null;
}

export function isMetaLaunchpadStagedAuthority(
  authority: MetaLaunchExecutionAuthority,
): authority is MetaLaunchpadStagedAuthority {
  return authority.actionOrigin === META_LAUNCHPAD_STAGED_ACTION_ORIGIN;
}

/**
 * What the action log says about WHO acted.
 *
 * `authority` is the authority of THIS attempt — on the operator's route that
 * is always their own confirmation. `stagedAuthority` is the separate fact of
 * what the stored payload was staged under, written beside it when the two
 * differ, so a producer-staged launch an operator approved at the queue reads
 * as exactly that and not as a launch the operator also composed.
 */
export function metaLaunchpadActionLogAuthority(input: {
  authority: MetaLaunchExecutionAuthority;
  requestFingerprint: string;
  stagedAuthority?: MetaLaunchExecutionAuthority | null;
}) {
  const staged = input.stagedAuthority ?? null;
  return {
    action_origin: input.authority.actionOrigin,
    manual_confirmation: input.authority.manualConfirmation,
    launch_intent_request_fingerprint: input.requestFingerprint,
    ...(staged && staged.actionOrigin !== input.authority.actionOrigin
      ? { staged_execution_authority: { ...staged } }
      : {}),
  };
}
