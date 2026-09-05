/**
 * Turning on a hierarchy that was created paused.
 *
 * A test launch creates a campaign, an ad set and an ad, all PAUSED. Setting
 * the ad to ACTIVE does not put it in front of anybody: Meta will not deliver
 * an ad whose ad set or campaign is paused, and the ad's own `status` will
 * still read ACTIVE while its `effective_status` says otherwise. An interface
 * that reported "live" from the ad's own status would be telling the operator
 * something untrue about their money.
 *
 * So activation runs outside in — campaign, then ad set, then ad — and each
 * step is proved by reading that entity back by id and requiring BOTH its own
 * status and its effective status to be active. A step that fails or comes
 * back unclear stops the sequence where it is.
 *
 * ## Why stopping is the whole design
 *
 * A partially activated hierarchy is a normal outcome, not an error to be
 * cleaned up: the campaign is genuinely on, and turning it back off would
 * discard a verified provider write to make a report tidier. The result names
 * the step that blocked, the surface says "campaign is on, ad set is not", and
 * a retry resumes at the blocked step. Nothing is created, so a retry cannot
 * duplicate anything — the identities were fixed when the launch receipt was
 * written and this module only ever changes their status.
 */
export const HIERARCHY_ACTIVATION_CONTRACT =
  "meta.hierarchy-activation.v1" as const;

export type ActivationGrain = "campaign" | "adset" | "ad";

/** Outside in. Delivery depends on every ancestor, so the ancestors go first. */
export const ACTIVATION_ORDER: readonly ActivationGrain[] = [
  "campaign",
  "adset",
  "ad",
];

export type ActivationStepOutcome =
  /** Read back active by id, both statuses. */
  | "activated"
  /** Already active before this run; nothing was sent. */
  | "already_active"
  /** The provider refused, or the read-back disagreed. */
  | "blocked"
  /** The write may or may not have landed. Never reported as either. */
  | "ambiguous"
  /** An earlier step stopped the sequence before this one was attempted. */
  | "not_attempted";

export interface ActivationStepResult {
  grain: ActivationGrain;
  entityId: string;
  outcome: ActivationStepOutcome;
  /** The named reason, when there is one. Never a free sentence. */
  reason: string | null;
  /** Exactly what the provider said this entity's statuses are, after. */
  verified: { status: string | null; effectiveStatus: string | null } | null;
}

export interface HierarchyActivationResult {
  contract: typeof HIERARCHY_ACTIVATION_CONTRACT;
  steps: ActivationStepResult[];
  /** True only when every step in the plan reads back active. */
  delivering: boolean;
  /** The grain the sequence stopped at, if it stopped. */
  blockedAt: ActivationGrain | null;
  blockedReason: string | null;
}

export interface ActivationTarget {
  grain: ActivationGrain;
  entityId: string;
}

export interface HierarchyActivationDeps {
  /**
   * Set one entity active. Returns the provider's answer; it does not decide
   * whether that answer counts, because deciding is this module's job.
   *
   * `observed` is the state read from the provider immediately before this
   * call, passed on rather than re-read: it is what makes a durable claim able
   * to record what the entity was before the write, which is the only thing a
   * rollback could ever be built from.
   */
  activate(
    target: ActivationTarget,
    observed: { status: string | null; effectiveStatus: string | null },
  ): Promise<{
    ok: boolean;
    ambiguous?: boolean;
    reason?: string | null;
  }>;
  /**
   * Read one entity back BY ID. `null` means the read failed, which is not the
   * same as reading a paused entity and must never be treated as one.
   */
  readState(target: ActivationTarget): Promise<{
    id: string;
    status: string | null;
    effectiveStatus: string | null;
  } | null>;
  /** Re-proved before every single provider call. Throws or returns a reason. */
  authorize?(target: ActivationTarget): Promise<string | null>;
  /**
   * Called once per step with this module's verdict on it, before the next
   * step begins.
   *
   * The provider's answer and the verdict are not the same fact: a write the
   * adapter accepted whose independent read-back still says PAUSED is a
   * successful call and a failed step. A durable record built from the call
   * alone would say the ad set was activated when it demonstrably was not, so
   * the journal is terminalised from here rather than from `activate`.
   */
  onStepResult?(step: ActivationStepResult): Promise<void>;
}

function isActive(state: {
  status: string | null;
  effectiveStatus: string | null;
}): boolean {
  /*
    Both, and both explicitly.

    `status` is what was configured; `effective_status` is what Meta will
    actually do, and it carries the reasons — an ad set in review, a campaign
    over its schedule, an account with a billing problem. An entity is only on
    when the two agree.
  */
  return (
    (state.status ?? "").toUpperCase() === "ACTIVE"
    && (state.effectiveStatus ?? "").toUpperCase() === "ACTIVE"
  );
}

/**
 * Run the plan, stopping at the first step that does not read back active.
 *
 * `targets` are the identities the launch receipt recorded. A grain the launch
 * did not create (an add-to-existing ad joins a live ad set) is simply absent
 * from the plan; it is never invented, and its parent is never touched.
 */
export async function activateHierarchy(input: {
  targets: readonly ActivationTarget[];
  deps: HierarchyActivationDeps;
}): Promise<HierarchyActivationResult> {
  const ordered = ACTIVATION_ORDER
    .map((grain) => input.targets.find((target) => target.grain === grain))
    .filter((target): target is ActivationTarget => Boolean(target));

  const steps: ActivationStepResult[] = [];
  let blockedAt: ActivationGrain | null = null;
  let blockedReason: string | null = null;

  // Every verdict goes through here, so no branch can record a step without
  // the journal hearing about it.
  const record = async (step: ActivationStepResult) => {
    steps.push(step);
    if (input.deps.onStepResult) {
      await input.deps.onStepResult(step).catch(() => undefined);
    }
  };

  for (const target of ordered) {
    if (blockedAt !== null) {
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "not_attempted",
        reason: `blocked_at_${blockedAt}`,
        verified: null,
      });
      continue;
    }

    /*
      Already on? Then send nothing.

      This is what makes a retry safe to run as often as an operator likes: the
      step that succeeded last time costs one read and no write, so resuming
      after a blocked ad set never re-POSTs the campaign.
    */
    const before = await input.deps.readState(target).catch(() => null);
    if (before === null) {
      blockedAt = target.grain;
      blockedReason = "state_unreadable";
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "blocked",
        reason: "state_unreadable",
        verified: null,
      });
      continue;
    }
    if (before.id !== target.entityId) {
      // The read answered about a different entity. Nothing is written on the
      // strength of an answer that is not about this one.
      blockedAt = target.grain;
      blockedReason = "identity_drift";
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "blocked",
        reason: "identity_drift",
        verified: { status: before.status, effectiveStatus: before.effectiveStatus },
      });
      continue;
    }
    if (isActive(before)) {
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "already_active",
        reason: null,
        verified: { status: before.status, effectiveStatus: before.effectiveStatus },
      });
      continue;
    }

    // The authority, re-read immediately before this step's own write. The
    // operator can engage the STOP between the campaign and the ad set.
    const refusal = input.deps.authorize
      ? await input.deps.authorize(target).catch((error: unknown) =>
        error instanceof Error ? error.message : "authorization_unreadable")
      : null;
    if (refusal) {
      blockedAt = target.grain;
      blockedReason = refusal;
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "blocked",
        reason: refusal,
        verified: null,
      });
      continue;
    }

    const written = await input.deps.activate(target, {
      status: before.status,
      effectiveStatus: before.effectiveStatus,
    }).catch(() => ({
      ok: false, ambiguous: true, reason: "activate_threw",
    }));
    if (written.ambiguous === true) {
      /*
        An unknown outcome stops everything, and is never retried here.

        The write may have landed. Sending the next step would build on a
        parent whose state nobody knows, and re-sending this one could be the
        second of two writes. It parks for a person.
      */
      blockedAt = target.grain;
      blockedReason = written.reason ?? "provider_outcome_ambiguous";
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "ambiguous",
        reason: blockedReason,
        verified: null,
      });
      continue;
    }

    const after = written.ok
      ? await input.deps.readState(target).catch(() => null)
      : null;
    if (!written.ok || after === null || after.id !== target.entityId || !isActive(after)) {
      blockedAt = target.grain;
      blockedReason = !written.ok
        ? written.reason ?? "activation_refused"
        : after === null
          ? "verification_unreadable"
          : after.id !== target.entityId
            ? "identity_drift"
            : "verified_not_active";
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "blocked",
        reason: blockedReason,
        verified: after
          ? { status: after.status, effectiveStatus: after.effectiveStatus }
          : null,
      });
      continue;
    }

    await record({
      grain: target.grain,
      entityId: target.entityId,
      outcome: "activated",
      reason: null,
      verified: { status: after.status, effectiveStatus: after.effectiveStatus },
    });
  }

  return {
    contract: HIERARCHY_ACTIVATION_CONTRACT,
    steps,
    /*
      Delivering means every planned step is on — not that the ad is.

      This is the sentence the UI reads. An ad whose own status is ACTIVE under
      a paused campaign is exactly the case that must not read as live.
    */
    delivering: steps.length > 0
      && steps.every((step) =>
        step.outcome === "activated" || step.outcome === "already_active"),
    blockedAt,
    blockedReason,
  };
}
