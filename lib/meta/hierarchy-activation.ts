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
 * So activation runs outside in — campaigns, then ad sets, then ads — and each
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
 *
 * ## Every identity, not one per grain
 *
 * This module used to walk `ACTIVATION_ORDER` and `find` ONE target per grain.
 * A launch that created two ad sets and two ads was therefore activated as
 * three entities — the first of each grain — and the result still said
 * `delivering: true`, because "every step is on" was asked of the three steps
 * it had chosen to take rather than of the identities it was given. The launch
 * create runtime has always supported several ad sets and several creatives, so
 * that sentence was untrue of real launches: an operator read "delivering" over
 * ad sets that were still paused and ads that had never been touched.
 *
 * So the plan is the COMPLETE set of identities, one step each, and delivery is
 * asked of all of them. Ordering within a grain is the order it was given;
 * ordering between grains is still outside in, and each entity may name the
 * parent this same launch created so that an ad is never sent while the ad set
 * it belongs to is off. A branch that blocks blocks its own descendants and
 * nothing else — the sibling ad set is a separate, independently approved
 * entity and there is no truth in leaving it paused because another one failed.
 * An outcome nobody can read is different: it stops the whole run, because the
 * next write would be built on a state no one has seen.
 *
 * ## Two places the authority is asked, not one
 *
 * `authorize` is asked here, before the step's write is handed to the caller's
 * `activate`. That is not the last instant: `activate` writes a durable claim
 * first, and the write primitive underneath takes its own authority snapshot,
 * so several awaits stand between the answer and the request. The caller re-asks
 * the identical question inside the primitive's own pre-POST hook and reports a
 * refusal there as `authorityRefused`, which this module treats exactly as it
 * treats a refusal from `authorize`: the whole run halts.
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
  /** An earlier step stopped the sequence, or this one's parent is not on. */
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

/**
 * How much of the plan is on, counted over the identities themselves.
 *
 * `planned` is the number of entities the plan named, and there is exactly one
 * step per entity, so `on === planned` is the only arithmetic behind
 * `delivering`. It is stated as a count rather than left implicit because a
 * receipt that reported three steps for a five-entity launch was the defect:
 * nothing in the old shape could tell an operator that two identities had never
 * been considered at all.
 */
export interface HierarchyActivationCoverage {
  planned: number;
  /** Read back active — activated by this run, or already active before it. */
  on: number;
  blocked: number;
  ambiguous: number;
  notAttempted: number;
}

export interface HierarchyActivationResult {
  contract: typeof HIERARCHY_ACTIVATION_CONTRACT;
  steps: ActivationStepResult[];
  /** True only when EVERY identity in the plan reads back active. */
  delivering: boolean;
  /** Some of the plan is on and some is not. Never a launch, never a failure. */
  partial: boolean;
  coverage: HierarchyActivationCoverage;
  /** The grain the sequence first stopped at, if it stopped. */
  blockedAt: ActivationGrain | null;
  blockedReason: string | null;
}

export interface ActivationTarget {
  grain: ActivationGrain;
  entityId: string;
  /**
   * The entity above this one that THIS launch also created, when there is one.
   *
   * It is what makes two ad sets independent of each other: an ad names the ad
   * set it was created under, so a blocked ad set stops its own ads and leaves
   * the sibling branch alone. A target that names no parent falls back to the
   * conservative rule — every planned entity of every ancestor grain must be on
   * first — because "I do not know which ad set this ad belongs to" must never
   * be read as "it has no parent".
   *
   * An add-to-existing ad names none: the ad set it joined is live and was not
   * created here, so it is not in the plan and must never be activated.
   */
  parentEntityId?: string | null;
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
    /**
     * The write never left the process: an authority check standing at the
     * provider boundary itself refused it.
     *
     * `authorize` below is asked before the claim is written, and the claim and
     * the primitive's own preflight are awaits that stand between that answer
     * and the request. The caller re-asks the identical question inside the
     * primitive's pre-POST hook, and a refusal there arrives here — as a
     * definite non-write, distinct from a provider that said no, and carrying
     * the same "nothing more may be sent AT ALL" meaning `authorize` has.
     */
    authorityRefused?: boolean;
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
 * Every identity in the plan, outside in, one step each.
 *
 * `targets` are the identities the launch receipt recorded — all of them. A
 * grain the launch did not create (an add-to-existing ad joins a live ad set)
 * is simply absent from the plan; it is never invented, and its parent is never
 * touched.
 */
export async function activateHierarchy(input: {
  targets: readonly ActivationTarget[];
  deps: HierarchyActivationDeps;
}): Promise<HierarchyActivationResult> {
  const ordered = orderedPlan(input.targets);

  const steps: ActivationStepResult[] = [];
  /*
    What each entity ended as, so a later one can ask about its parent.

    Keyed by entity id alone: a Meta id names one entity across every grain, and
    a parent is named by id rather than by grain-and-id precisely because the
    caller knows the id and should not have to restate the grain to be believed.
  */
  const settled = new Map<string, { grain: ActivationGrain; on: boolean }>();
  /** The first step that stopped, kept together so neither half can drift. */
  const stop: { at: ActivationGrain | null; reason: string | null } = {
    at: null,
    reason: null,
  };
  /** The first block wins: it is the step the sequence actually stopped at. */
  const noteBlock = (grain: ActivationGrain, reason: string) => {
    if (stop.at !== null) return;
    stop.at = grain;
    stop.reason = reason;
  };
  /*
    A stop that ends the whole run rather than one branch.

    An unknown provider outcome and a refused authority are the two facts that
    say nothing more may be sent AT ALL — the first because the next write would
    build on a state nobody has seen, the second because the permission this run
    is acting under has just been withdrawn. An ordinary blocked step is neither:
    it stops its own descendants and leaves an independently approved sibling
    branch alone.
  */
  let halted = false;

  // Every verdict goes through here, so no branch can record a step without
  // the journal hearing about it.
  const record = async (step: ActivationStepResult) => {
    steps.push(step);
    settled.set(step.entityId, {
      grain: step.grain,
      on: step.outcome === "activated" || step.outcome === "already_active",
    });
    if (input.deps.onStepResult) {
      await input.deps.onStepResult(step).catch(() => undefined);
    }
  };

  for (const target of ordered) {
    if (halted) {
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "not_attempted",
        reason: `blocked_at_${stop.at}`,
        verified: null,
      });
      continue;
    }

    /*
      The parent has to be on before its child is sent.

      An ad under a paused ad set delivers to nobody, so activating it would put
      an ACTIVE status on an entity that shows to no one and — far worse — would
      let the surface count it towards delivery. The dependency is read from
      what this run itself settled, never from the provider a second time.
    */
    const missingParent = firstDependencyNotOn(target, ordered, settled);
    if (missingParent) {
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "not_attempted",
        reason: `blocked_at_${missingParent.grain}`,
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
      noteBlock(target.grain, "state_unreadable");
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
      noteBlock(target.grain, "identity_drift");
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

    /*
      The authority, re-read immediately before this step's own write.

      The operator can engage the STOP between the campaign and the ad set, and
      the stored approval this run may be acting under can be revoked in the
      same gap. Either is a statement about the WHOLE run rather than about one
      entity, so a refusal here halts everything that has not been sent — a
      sibling ad set is not more permitted than the one just refused.
    */
    const refusal = input.deps.authorize
      ? await input.deps.authorize(target).catch((error: unknown) =>
        error instanceof Error ? error.message : "authorization_unreadable")
      : null;
    if (refusal) {
      noteBlock(target.grain, refusal);
      halted = true;
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
      // A throw is an unknown outcome, never a refused authority: the call may
      // have gone out. `authorityRefused` is stated rather than omitted so this
      // fallback keeps the same shape the deps contract declares.
      ok: false, ambiguous: true, authorityRefused: false, reason: "activate_threw",
    }));
    if (written.ambiguous === true) {
      /*
        An unknown outcome stops everything, and is never retried here.

        The write may have landed. Sending the next step would build on a
        parent whose state nobody knows, and re-sending this one could be the
        second of two writes. It parks for a person.
      */
      const reason = written.reason ?? "provider_outcome_ambiguous";
      noteBlock(target.grain, reason);
      halted = true;
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "ambiguous",
        reason,
        verified: null,
      });
      continue;
    }

    /*
      The authority, refused at the provider boundary rather than above it.

      `authorize` ran before the claim was written, and the claim and the
      primitive's own preflight are both awaits in front of the request. A
      refusal raised inside the pre-POST hook is therefore the SAME fact as a
      refusal from `authorize` — the permission this run acts under has been
      withdrawn — arriving a few milliseconds later, so it halts the whole run
      exactly as `authorize` does. It is not folded into the ordinary blocked
      branch below: that branch stops one branch and leaves siblings alone,
      which is right for a provider that refused one entity and wrong for a
      permission that no longer covers any of them.
    */
    if (written.authorityRefused === true) {
      const reason = written.reason ?? "activation_authority_refused";
      noteBlock(target.grain, reason);
      halted = true;
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "blocked",
        reason,
        verified: null,
      });
      continue;
    }

    const after = written.ok
      ? await input.deps.readState(target).catch(() => null)
      : null;
    if (!written.ok || after === null || after.id !== target.entityId || !isActive(after)) {
      const reason = !written.ok
        ? written.reason ?? "activation_refused"
        : after === null
          ? "verification_unreadable"
          : after.id !== target.entityId
            ? "identity_drift"
            : "verified_not_active";
      noteBlock(target.grain, reason);
      await record({
        grain: target.grain,
        entityId: target.entityId,
        outcome: "blocked",
        reason,
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

  const coverage = coverageOf(ordered.length, steps);
  return {
    contract: HIERARCHY_ACTIVATION_CONTRACT,
    steps,
    /*
      Delivering means every planned IDENTITY is on — not that the ad is, and
      not that the steps this run happened to take are.

      This is the sentence the UI reads. An ad whose own status is ACTIVE under
      a paused campaign is exactly the case that must not read as live, and so
      is a launch whose second ad set was never touched: counting only the steps
      taken is how five requested entities used to report delivery on three.
    */
    delivering: coverage.planned > 0 && coverage.on === coverage.planned,
    partial: coverage.on > 0 && coverage.on < coverage.planned,
    coverage,
    blockedAt: stop.at,
    blockedReason: stop.reason,
  };
}

/**
 * Outside in between grains, given order within one.
 *
 * Duplicates are dropped by grain and id, because two steps for one entity
 * would claim the same durable row twice and count it twice towards delivery.
 */
function orderedPlan(
  targets: readonly ActivationTarget[],
): ActivationTarget[] {
  const seen = new Set<string>();
  return ACTIVATION_ORDER.flatMap((grain) =>
    targets.filter((target) => {
      if (target.grain !== grain) return false;
      const key = `${target.grain}:${target.entityId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
}

/**
 * The first thing this target depends on that is not on, or nothing.
 *
 * A named parent is the whole dependency, which is what makes two ad sets
 * independent. With no named parent the rule is deliberately the conservative
 * one it has always been — every planned entity of every ancestor grain — since
 * an ad whose ad set is unknown could belong to any of them.
 */
function firstDependencyNotOn(
  target: ActivationTarget,
  plan: readonly ActivationTarget[],
  settled: ReadonlyMap<string, { grain: ActivationGrain; on: boolean }>,
): { grain: ActivationGrain; entityId: string } | null {
  const parentId = target.parentEntityId?.trim() || null;
  const dependencies = parentId
    ? plan.filter((other) => other.entityId === parentId)
    : plan.filter(
      (other) =>
        ACTIVATION_ORDER.indexOf(other.grain)
          < ACTIVATION_ORDER.indexOf(target.grain),
    );
  for (const dependency of dependencies) {
    const outcome = settled.get(dependency.entityId);
    if (!outcome || !outcome.on) {
      return { grain: dependency.grain, entityId: dependency.entityId };
    }
  }
  return null;
}

function coverageOf(
  planned: number,
  steps: readonly ActivationStepResult[],
): HierarchyActivationCoverage {
  const count = (outcome: ActivationStepOutcome) =>
    steps.filter((step) => step.outcome === outcome).length;
  return {
    planned,
    on: count("activated") + count("already_active"),
    blocked: count("blocked"),
    ambiguous: count("ambiguous"),
    notAttempted: count("not_attempted"),
  };
}
