/**
 * The shared read/mutation state grammar and the failure-code dictionary.
 *
 * §9 and §9.1 of `docs/meta-market-ready-master-plan-2026-08-22.md`. Every Meta
 * surface presents exactly one read state, and every refusal names a code from
 * one list.
 *
 * ## Why a second grammar beside `lib/zero-base/state-types.ts`
 *
 * That one is a *component* grammar: what a cell, a chart or a control renders.
 * This one is a *surface* grammar: what the whole screen is doing right now, and
 * it draws distinctions the component grammar deliberately does not need.
 *
 * The three that matter, and that a surface loses when it flattens them:
 *
 * - `empty-proven` vs `degraded`. A read that succeeded and found nothing, and
 *   a read that failed. Both show no rows. One means "there is nothing here",
 *   the other means "we do not know what is here", and the operator's next
 *   action is completely different. Collapsing them is D8.
 * - `partial` vs `success`. Some sources answered and some did not. Presenting
 *   a subset as the whole is how a total silently becomes wrong.
 * - `refreshing-with-stale` vs `loading`. Old data still on screen while new
 *   data is fetched is not a first load, and blanking it to a skeleton throws
 *   away readable evidence to show a spinner.
 *
 * Nothing here renders. It is a vocabulary plus the messages that go with it,
 * so two surfaces cannot describe the same failure differently.
 */

/** §9. Exactly one of these describes a read surface at any moment. */
export type MetaReadState =
  /** First load. Skeleton, never an empty list. */
  | "loading"
  /** Old data stays visible and is labelled as updating. */
  | "refreshing-with-stale"
  /** Usable, evidenced data. */
  | "success"
  /** The read succeeded and there are genuinely zero rows. */
  | "empty-proven"
  /** Some sources are missing or a cap was applied. The subset is named. */
  | "partial"
  /** Schema, permission, migration, source or evidence problem. */
  | "degraded"
  /** Auth, reviewer, demo, kill-switch or scope refusal — visible before a click. */
  | "refused";

/** §9. The additional states a mutation moves through. */
export type MetaMutationState =
  | "validating"
  | "awaiting-confirmation"
  | "executing"
  | "provider-response-received"
  | "readback-pending"
  | "verified"
  | "refused"
  | "failed-definite"
  | "ambiguous-reconciliation-required";

export const META_READ_STATES = [
  "loading",
  "refreshing-with-stale",
  "success",
  "empty-proven",
  "partial",
  "degraded",
  "refused",
] as const satisfies readonly MetaReadState[];

export const META_MUTATION_STATES = [
  "validating",
  "awaiting-confirmation",
  "executing",
  "provider-response-received",
  "readback-pending",
  "verified",
  "refused",
  "failed-definite",
  "ambiguous-reconciliation-required",
] as const satisfies readonly MetaMutationState[];

/**
 * §9.1. The closed failure vocabulary.
 *
 * A code that is not here has no operator message, so adding one without a
 * message is a build failure rather than an em dash on someone's screen. That
 * is the rule the plan states as "yeni failure code eklenen PR aynı kodun
 * kullanıcı mesajını ve testini de içermelidir".
 */
export const META_FAILURE_CODES = [
  // D071 contracts the codes its demo branches emit, so the uncontracted
  // ratchet holds rather than being raised.
  "demo_journal_not_recorded",
  "demo_workspace_envelope_unavailable",
  "provider_account_not_assigned",
  "provider_account_scope_unverified",
  "account_required",
  "reviewer_read_only",
  "demo_business_read_only",
  "insufficient_role",
  "supervision_state_unavailable",
  "kill_switch_engaged",
  "kill_switch_release_preflight_failed",
  "schema_not_ready",
  "capability_read_denied",
  "execution_limit_exceeded",
  "bulk_cap_exceeded",
  "invalid_payload",
  "expectedVersion_conflict",
  "handoff_refused",
  "source_read_failed",
  "provider_rate_limited",
  "provider_auth_expired",
  "provider_outcome_ambiguous",
  "reconciliation_required",
  /**
   * Added 2026-08-23 with the P1 runtime gate.
   *
   * §9.1 names twenty codes as a floor, not a ceiling. This one is distinct
   * from `launchpad_execution_disabled` on purpose: that is a rollout state the
   * operator may legitimately ask to have changed, while this is a deployment
   * error they cannot fix and must not be invited to try.
   */
  "launchpad_execution_disabled",
  "launchpad_execution_safety_incomplete",
  /**
   * Added 2026-08-25 when the remaining release gates were wired.
   *
   * Four gates were declared and read by nothing, so four capabilities had no
   * server-side refusal at all and no code to refuse with. One code per gate,
   * because "this is not enabled yet" is a different fact per capability and an
   * operator reporting one needs to be able to name which.
   */
  "decision_workflow_disabled",
  "automation_stop_disabled",
  "automation_live_writes_disabled",
  "public_share_mint_disabled",
  "account_picker_disabled",
] as const;

export type MetaFailureCode = (typeof META_FAILURE_CODES)[number];

interface FailureDescriptor {
  /**
   * One sentence for the operator. Says what happened and, where there is one,
   * what they can do — never a bare status word and never a raw error.
   */
  readonly message: string;
  /** Which surface state a code puts the screen into. */
  readonly state: Extract<MetaReadState, "degraded" | "refused" | "partial">;
  /** True when the operator can resolve it themselves from the product. */
  readonly operatorActionable: boolean;
}

export const META_FAILURES: Readonly<Record<MetaFailureCode, FailureDescriptor>> = {
  demo_workspace_envelope_unavailable: {
    message:
      "This demo workspace serves committed decision evidence, but the pacing and lane sources behind this screen are not part of the demo, so the workspace was withheld rather than served with invented figures.",
    state: "degraded",
    operatorActionable: false,
  },
  demo_journal_not_recorded: {
    message:
      "This is a demo workspace. It serves committed decision evidence and records no provider actions, so no journal was written for it. This is not a proven-zero history.",
    state: "degraded",
    operatorActionable: false,
  },
  provider_account_not_assigned: {
    message:
      "That ad account is not assigned to this workspace, so nothing was read for it. Choose one of the assigned accounts, or assign it in Integrations.",
    state: "refused",
    operatorActionable: true,
  },
  provider_account_scope_unverified: {
    message:
      "This workspace's ad-account assignments could not be read, so the account scope is unproven and nothing was served. This is not an empty account.",
    state: "degraded",
    operatorActionable: false,
  },
  account_required: {
    message:
      "This workspace has more than one assigned ad account. Choose one to see its data — no figure here is a total across accounts.",
    state: "refused",
    operatorActionable: true,
  },
  reviewer_read_only: {
    message:
      "Reviewer access is read-only. Everything on this screen can be read; nothing can be changed.",
    state: "refused",
    operatorActionable: false,
  },
  /**
   * The refusal a role produces, distinct from the two beside it.
   *
   * `reviewer_read_only` and `demo_business_read_only` are properties of the
   * SESSION and the WORKSPACE; this one is a property of the membership. A
   * guest who is neither a reviewer nor in a demo workspace had no code at all,
   * so a control refused for their role either borrowed a sentence that was
   * false about them — telling a real operator they are a reviewer — or
   * reported no reason. Whoever grants the role can lift this one, which is why
   * it is operator-actionable and the other two are not.
   */
  insufficient_role: {
    message:
      "Your role on this workspace can read this but cannot act on it. An admin can change that.",
    state: "refused",
    operatorActionable: true,
  },
  demo_business_read_only: {
    message:
      "This is a demo workspace. It has no Meta write authority, so actions here change nothing on Meta.",
    state: "refused",
    operatorActionable: false,
  },
  supervision_state_unavailable: {
    message:
      "The automation control state could not be read, so the kill switch, guardrails and readiness are unknown rather than the defaults they would otherwise show.",
    state: "degraded",
    operatorActionable: false,
  },
  kill_switch_engaged: {
    message:
      "Meta writes are stopped for this workspace. Reads are unaffected, and no control on this screen stops Google Ads writes.",
    state: "refused",
    operatorActionable: true,
  },
  kill_switch_release_preflight_failed: {
    message:
      "The stop could not be released because its preflight did not pass. It remains engaged; nothing was sent to Meta.",
    state: "refused",
    operatorActionable: false,
  },
  schema_not_ready: {
    message:
      "A pending database migration has not been applied, so this data cannot be read yet. It is unavailable, not empty.",
    state: "degraded",
    operatorActionable: false,
  },
  capability_read_denied: {
    message:
      "Meta refused to serve part of this data for the connected login. What is missing is unknown rather than zero — reconnecting with the right permissions may restore it.",
    state: "degraded",
    operatorActionable: true,
  },
  execution_limit_exceeded: {
    message:
      "This request is larger than one execution supports. Nothing was sent; reduce the selection and try again.",
    state: "refused",
    operatorActionable: true,
  },
  bulk_cap_exceeded: {
    message:
      "This bulk action covers more entities than one run allows. Nothing was sent; split it into smaller runs.",
    state: "refused",
    operatorActionable: true,
  },
  invalid_payload: {
    message: "This request was malformed, so nothing was applied.",
    state: "refused",
    operatorActionable: true,
  },
  expectedVersion_conflict: {
    message:
      "Someone else changed this item since it was loaded, so nothing was applied. Reload to see the current state before deciding again.",
    state: "refused",
    operatorActionable: true,
  },
  handoff_refused: {
    message:
      "That handoff is no longer valid — it was used, expired, or the decision behind it changed — so nothing was opened.",
    state: "refused",
    operatorActionable: true,
  },
  source_read_failed: {
    message:
      "One of the sources behind this screen could not be read, so what is shown is incomplete. The missing part is unknown rather than zero.",
    state: "partial",
    operatorActionable: false,
  },
  provider_rate_limited: {
    message:
      "Meta is rate-limiting this workspace, so this read was not served. Nothing is wrong with the data; try again shortly.",
    state: "degraded",
    operatorActionable: true,
  },
  provider_auth_expired: {
    message:
      "The Meta connection has expired, so nothing could be read. Reconnect it in Integrations.",
    state: "degraded",
    operatorActionable: true,
  },
  provider_outcome_ambiguous: {
    message:
      "This action reached Meta and no result came back, so whether it landed is unknown. It is held for reconciliation and was not retried.",
    state: "refused",
    operatorActionable: false,
  },
  reconciliation_required: {
    message:
      "An earlier action on this entity has an unresolved outcome, so further changes are blocked until it is reconciled.",
    state: "refused",
    operatorActionable: false,
  },
  launchpad_execution_disabled: {
    message:
      "Creating campaigns on Meta from Launchpad is not enabled yet. Drafts, templates and validation are fully available, and a validated draft will run unchanged once execution is turned on.",
    state: "refused",
    operatorActionable: false,
  },
  launchpad_execution_safety_incomplete: {
    message:
      "Creating campaigns on Meta from Launchpad is unavailable: this deployment does not yet meet the write-safety requirements for provider creates. Nothing was sent. Drafts, templates and validation are unaffected.",
    state: "refused",
    operatorActionable: false,
  },
  decision_workflow_disabled: {
    message:
      "Decision workflow actions are not enabled yet on this workspace. Every verdict and its evidence stay readable; only the controls that record a workflow state are held.",
    state: "refused",
    operatorActionable: false,
  },
  automation_stop_disabled: {
    message:
      "The Meta Stop control is not enabled yet: releasing it again has not been proven reversible in this environment, and a stop that cannot be released is worse than no stop.",
    state: "refused",
    operatorActionable: false,
  },
  automation_live_writes_disabled: {
    message:
      "Automation runs in dry-run only. Approving a proposal records what would have been sent and contacts Meta for nothing.",
    state: "refused",
    operatorActionable: false,
  },
  public_share_mint_disabled: {
    message:
      "Minting new public share links is not enabled yet. Existing links keep working and can still be rotated or revoked.",
    state: "refused",
    operatorActionable: false,
  },
  account_picker_disabled: {
    message:
      "Changing the Meta ad account is not enabled yet. The account this workspace resolved is still the scope of everything on screen.",
    state: "refused",
    operatorActionable: false,
  },
};

/** True for a code this contract knows. Narrows an unknown string safely. */
export function isMetaFailureCode(value: unknown): value is MetaFailureCode {
  return (
    typeof value === "string" &&
    (META_FAILURE_CODES as readonly string[]).includes(value)
  );
}

/**
 * The operator sentence for a code.
 *
 * An unrecognised code returns `null` rather than a generic sentence, so a
 * caller has to decide what to say about something this contract has never
 * heard of. Inventing a reassuring default here is how an unknown failure
 * becomes a known-looking one.
 */
export function metaFailureMessage(code: unknown): string | null {
  return isMetaFailureCode(code) ? META_FAILURES[code].message : null;
}

/** Which read state a failure code puts a surface into. */
export function metaFailureState(code: MetaFailureCode): MetaReadState {
  return META_FAILURES[code].state;
}

/**
 * The standard envelope shape from §6.
 *
 * Generic over the payload so a surface keeps its own data type while every
 * surface agrees about scope, evidence, capability, permissions and failure.
 */
export interface MetaResponseEnvelope<TData> {
  scope: {
    businessId: string;
    providerAccountId: string | null;
  };
  evidence: {
    /** When the underlying source last changed. */
    sourceUpdatedAt: string | null;
    /** When this snapshot was taken. */
    snapshotAt: string | null;
    /** When the facts in it were observed. */
    observedAt: string | null;
    freshness: "fresh" | "stale" | "unknown";
    window: { startDate: string; endDate: string } | null;
    /** Set only on surfaces where a decision as-of exists and differs (D7). */
    decisionAsOf: string | null;
  };
  data: TData | null;
  capability: {
    canRead: boolean;
    canWrite: boolean;
  };
  permissions: {
    role: string | null;
    reviewerReadOnly: boolean;
    demo: boolean;
  };
  /** Null exactly when `state` is not `degraded`, `refused` or `partial`. */
  failure: { code: MetaFailureCode; message: string } | null;
  state: MetaReadState;
}
