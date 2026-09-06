/**
 * The shared Meta write-safety sequence, and which write families satisfy it.
 *
 * §10 of `docs/meta-market-ready-master-plan-2026-08-22.md` states eighteen
 * ordered steps every Meta write must follow, and §10.1 states nine rules that
 * hold regardless of order. Three write families exist — Decisions manual
 * actions, Automation proposal approval, and Launchpad create — and they were
 * built at different times against different modules, so nothing forced them to
 * agree about what "safe" means.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is **not** a rewrite of the three paths into one. They are individually
 * hardened, differently shaped, and each carries decisions (D065, D067, D069)
 * that a merge would have to relitigate. Rewriting three working write paths to
 * share a call stack is a large risk with no test-provable benefit.
 *
 * It **is** the specification made explicit and machine-checked: each family
 * declares, step by step, what implements it and where — or states plainly that
 * it does not. The conformance test then enforces the rule that matters:
 *
 *   **A write family whose gate is open must satisfy every step.**
 *
 * That turns WP15's precondition from a promise in a document into a build
 * failure. Setting `META_LAUNCHPAD_EXECUTION=true` while Launchpad still has no
 * provider read-back does not quietly ship an unverified create — it fails.
 */
import { readMetaReleaseGates } from "@/lib/meta/release-gates";

/** §10's eighteen ordered steps. */
export const WRITE_SAFETY_STEPS = [
  "exact_business_access",
  "exact_physical_provider_account",
  "exact_role_and_posture",
  "explicit_action_origin",
  "exact_target_identity",
  "fresh_provider_or_current_state_read",
  "parent_hierarchy_and_policy",
  "server_side_kill_switch",
  "persisted_preflight",
  "preflight_age_and_no_provider_contact_disclosure",
  "typed_or_explicit_confirmation",
  "durable_idempotency_claim",
  "at_most_one_provider_post",
  "immutable_attempt_receipt",
  "independent_provider_readback",
  "exact_identity_and_state_verification",
  "durable_terminal_receipt_or_reconciliation_marker",
  "rollback_or_compensation_record",
] as const;

export type WriteSafetyStep = (typeof WRITE_SAFETY_STEPS)[number];

export type WriteFamilyId =
  | "decisions_manual_action"
  | "automation_proposal_approval"
  | "launchpad_create"
  | "launchpad_activation";

/**
 * How a family satisfies one step.
 *
 * `not_applicable` needs a reason as much as `missing` does. A step waved away
 * without one is indistinguishable from a step nobody looked at.
 */
export type StepConformance =
  | { readonly status: "implemented"; readonly where: string }
  | { readonly status: "not_applicable"; readonly why: string }
  | { readonly status: "missing"; readonly why: string };

export interface WriteFamily {
  readonly id: WriteFamilyId;
  readonly label: string;
  /** The release gate that must be open before this family may reach Meta. */
  readonly gate: "META_DECISION_WORKFLOW_UI" | "META_AUTOMATION_LIVE_WRITES" | "META_LAUNCHPAD_EXECUTION";
  readonly steps: Readonly<Record<WriteSafetyStep, StepConformance>>;
}

const ok = (where: string): StepConformance => ({ status: "implemented", where });

export const WRITE_FAMILIES: readonly WriteFamily[] = [
  {
    id: "decisions_manual_action",
    label: "Decisions — manual ad pause/resume",
    gate: "META_DECISION_WORKFLOW_UI",
    steps: {
      exact_business_access: ok("lib/meta/ads-action-routes.ts → requireBusinessAccess"),
      exact_physical_provider_account: ok(
        "execution-safety.ts blocker provider_account_mismatch",
      ),
      exact_role_and_posture: ok("lib/meta/reviewer-write-guard.ts + demo-write-authority"),
      explicit_action_origin: ok("D065 — DecisionOriginAdExecutionRequest requires the origin"),
      exact_target_identity: ok(
        "execution-safety.ts — ad_identity_mismatch, verification_creative_mismatch",
      ),
      fresh_provider_or_current_state_read: ok(
        "decision-origin-action-preflight.ts → readMetaAdExecutionState",
      ),
      parent_hierarchy_and_policy: ok(
        "execution-safety.ts — current_hierarchy_* and policy_* blockers",
      ),
      server_side_kill_switch: ok("getMetaWriteBlockState in the preflight, not from the client"),
      persisted_preflight: ok("lib/meta/ads-action-log.ts attempt rows"),
      preflight_age_and_no_provider_contact_disclosure: ok(
        "execution-safety.ts — current_ad_state_stale",
      ),
      typed_or_explicit_confirmation: ok("MANUAL_CONFIRMATION on the request"),
      durable_idempotency_claim: ok("findDecisionOriginActionByIdempotency + idempotency_conflict"),
      at_most_one_provider_post: ok("D067 append-only attempt journal"),
      immutable_attempt_receipt: ok("createMetaAdsActionLog / completeMetaAdsActionLog"),
      independent_provider_readback: ok(
        "DecisionOriginProviderVerificationResult — an independent GET",
      ),
      exact_identity_and_state_verification: ok(
        "execution-safety.ts — the verification_* blocker family",
      ),
      durable_terminal_receipt_or_reconciliation_marker: ok(
        "lib/meta/duplicate-ad-reconciliation.ts (D069)",
      ),
      rollback_or_compensation_record: ok("the action log records the prior state"),
    },
  },
  {
    id: "automation_proposal_approval",
    label: "Automation — proposal approval",
    gate: "META_AUTOMATION_LIVE_WRITES",
    steps: {
      exact_business_access: ok("app/api/meta/automation/proposals/route.ts → requireBusinessAccess"),
      exact_physical_provider_account: ok("proposal rows carry providerAccountId and are re-checked"),
      exact_role_and_posture: ok("rejectIfReviewerReadOnly + rejectIfAutomationDemoWrite"),
      explicit_action_origin: ok("the proposal's recId and decisionKey are the origin"),
      exact_target_identity: ok("scopeId on the claimed proposal"),
      fresh_provider_or_current_state_read: ok(
        "the reused guarded handler performs its own current-state read",
      ),
      parent_hierarchy_and_policy: ok("delegated to the reused guarded pause/resume handler"),
      server_side_kill_switch: ok("getMetaWriteBlockState via the control plane"),
      persisted_preflight: ok("claimMetaAutomationProposal — refuses when unclaimable"),
      preflight_age_and_no_provider_contact_disclosure: ok(
        "receipt.dryRun and receipt.withheld are surfaced (WP1 §2.4)",
      ),
      typed_or_explicit_confirmation: ok("MANUAL_CONFIRMATION required for approve"),
      durable_idempotency_claim: ok("claim token, one per attempt"),
      at_most_one_provider_post: ok("the claim is atomic; a second claim refuses 409"),
      immutable_attempt_receipt: ok("MetaAutomationProposalReceipt + the activity ledger row"),
      independent_provider_readback: ok("inherited from the reused guarded handler"),
      exact_identity_and_state_verification: ok("inherited from the reused guarded handler"),
      durable_terminal_receipt_or_reconciliation_marker: ok(
        "appendMetaAutomationReconciliationReceipt — ambiguous parks, never 'applied'",
      ),
      rollback_or_compensation_record: ok("the ledger records the pre-action state"),
    },
  },
  {
    id: "launchpad_create",
    label: "Launchpad — campaign/ad-set/ad create",
    gate: "META_LAUNCHPAD_EXECUTION",
    /**
     * Re-audited 2026-08-23 against the code, not against the previous
     * declaration.
     *
     * The earlier version of this record declared SEVEN steps missing. Six of
     * those seven were already implemented — the audit that produced it read
     * `app/api/launchpad/meta/launch/route.ts` and never opened
     * `lib/meta/launch-write.ts`, where the independent read-back and the exact
     * identity verification live. A declaration that is wrong in the
     * pessimistic direction is still wrong: it would have held a gate closed
     * forever against work that was already done, and it made the contract look
     * authoritative while being unchecked.
     *
     * Every `implemented` entry below is now backed by a **behavioural** test
     * that exercises the module or the route, listed in
     * `launchpad-write-safety.behaviour.test.ts`. A declaration with only a
     * declaration-shaped test behind it is what this file exists to stop.
     */
    steps: {
      exact_business_access: ok(
        "requireLaunchpadBusinessAccess, minRole collaborator; unattended, the business comes from the claimed proposal row and getMetaLaunchIntent is scoped by it, so an intent belonging to another business is unreadable rather than refused late",
      ),
      exact_physical_provider_account: ok("resolveAssignedMetaLaunchAccount"),
      exact_role_and_posture: ok(
        "rejectIfLaunchpadReviewerReadOnly + rejectIfLaunchpadDemoWrite; the unattended arm has no session role to check and instead proves scheduled authority (evaluateScheduledAuthority, twice) and readMetaWritePosture, which fail-closes and already carries the demo and kill-switch refusals",
      ),
      explicit_action_origin: ok(
        "evaluateMetaLaunchpadManualAuthority (D065) on the operator's own request; the unattended arm (scheduled-launch-runtime.ts) writes source launchpad_scheduled_v1 with requested_by null and replays the intent's stored payload untouched, so the action log always says which authority created the entity",
      ),
      exact_target_identity: ok("normalizeMetaLaunchPayload + the handoff's verified lineage"),
      fresh_provider_or_current_state_read: ok(
        "preflightMetaLaunchCreatives — a fresh Meta GET per creative binding exact id and account, immediately before the first create",
      ),
      parent_hierarchy_and_policy: {
        status: "not_applicable",
        why: "A new campaign has no pre-existing parent. Add-to-existing DOES have one and is covered by its own target validation.",
      },
      server_side_kill_switch: ok(
        "rejectIfLaunchpadMetaWritesBlocked → getMetaWriteBlockState, plus rejectIfMetaWritesBlocked before the first POST",
      ),
      persisted_preflight: ok(
        "recordMetaLaunchIntentValidation → meta_launch_intents.validation_receipt_json, carrying the checks and their checkedAt",
      ),
      preflight_age_and_no_provider_contact_disclosure: ok(
        "lib/launchpad/validation-preflight-disclosure.ts — validate discloses what it did and did not read; launch returns the preflight's own age",
      ),
      typed_or_explicit_confirmation: ok(
        "LaunchpadReview requires the acknowledgement before onLaunch fires",
      ),
      durable_idempotency_claim: ok(
        "meta_launch_intents UNIQUE (business_id, provider_account_id, operation, idempotency_key) — a database-enforced claim written before any provider work, plus the request fingerprint and the executing transition",
      ),
      at_most_one_provider_post: ok(
        "no automatic retry on create; metaFetchWithRateLimitRetry is used for GET-only reads",
      ),
      immutable_attempt_receipt: ok(
        "createMetaAdsActionLog before each POST, completed after; meta_launch_intents result/error receipts",
      ),
      independent_provider_readback: ok(
        "lib/meta/launch-write.ts — a separate GET after every create (campaign, ad set, ad), never the create response",
      ),
      exact_identity_and_state_verification: ok(
        "lib/meta/launch-write.ts — verified id, account, status and objective must equal the requested values or the result fails closed as silent_failure",
      ),
      durable_terminal_receipt_or_reconciliation_marker: ok(
        "persistExecutionFailure → intent status silent_failure with an error receipt and retryAllowed:false for an ambiguous outcome",
      ),
      rollback_or_compensation_record: {
        status: "not_applicable",
        why: "Every create is PAUSED (ADR-003 rule 4), so nothing begins spending and no compensating action is required before WP15 adds activation.",
      },
    },
  },
  {
    id: "launchpad_activation",
    label: "Launchpad — activating what a launch created",
    gate: "META_LAUNCHPAD_EXECUTION",
    /**
     * The family the create record deferred.
     *
     * `launchpad_create` declares its rollback step not-applicable precisely
     * because every create is PAUSED — "nothing begins spending". Activation is
     * the write that ends that, so it needs its own declaration rather than
     * inheriting a create's. It is a status write, not a create: nothing is
     * made, identities come from the launch receipt, and every step only
     * changes a status.
     *
     * Behavioural evidence, in the same spirit as the create family's:
     * `lib/meta/launch-activation-durability.test.ts` drives the real path
     * against a provider double for the claim, the terminalisation and the
     * no-blind-retry gate; `lib/meta/hierarchy-activation.test.ts` for the
     * ordering and the two-status read-back; `lib/meta/launch-intent-activation.test.ts`
     * for the plan coming from the receipt; and the SQL those depend on is
     * proved against a migrated database in
     * `scripts/ephemeral-postgres-launch-intent-seam-child.ts`.
     */
    steps: {
      exact_business_access: ok(
        "activate/route.ts → requireLaunchpadBusinessAccess",
      ),
      exact_physical_provider_account: ok(
        "resolveAssignedMetaLaunchAccount + resolveMetaLaunchWriteContext, both bound to the intent's own providerAccountId",
      ),
      exact_role_and_posture: ok(
        "rejectIfLaunchpadReviewerReadOnly + rejectIfLaunchpadDemoWrite + readMetaWritePosture",
      ),
      explicit_action_origin: ok(
        "manual_operator_v1 + explicit_operator_confirmation on the request; the scheduled path (scheduled-activation-runtime.ts) instead calls activateLaunchIntent under authorization kind scheduled, whose entire authority is meta_launch_intents.activation_approval_json validated by launch-activation-approval.ts — every step is journalled under launch_activation_v1 with no operator named",
      ),
      exact_target_identity: ok(
        "activationPlanForIntent — the plan comes from the launch receipt, never from the request, so an activation cannot name an entity this launch did not create",
      ),
      fresh_provider_or_current_state_read: ok(
        "hierarchy-activation.ts — readState by id immediately before each step's own write",
      ),
      parent_hierarchy_and_policy: ok(
        "ACTIVATION_ORDER runs campaign → ad set → ad and requires each ancestor's effective_status ACTIVE before the next step",
      ),
      server_side_kill_switch: ok(
        "readMetaWritePosture at entry, and the authorize hook re-reads it before EVERY step's POST",
      ),
      persisted_preflight: ok(
        "the claim row's payload_request carries prior_state, written before the POST (launch-intent-activation.ts → defaultActivationJournal.claim)",
      ),
      preflight_age_and_no_provider_contact_disclosure: {
        status: "not_applicable",
        why: "The current-state read happens inside the step, immediately before that step's own POST, so there is no stored preflight that could age between reading and writing.",
      },
      typed_or_explicit_confirmation: ok(
        "the route refuses without manualConfirmation; scheduled-activation-runtime.ts reaches the provider only through the scheduled arm, which refuses with the approval's own named code — activation_approval_absent for the NULL default — before any plan is run",
      ),
      durable_idempotency_claim: ok(
        "createMetaAdsActionLog before each POST, plus findUnresolvedMetaAdStatusActionLog refusing a step whose prior attempt is unresolved",
      ),
      at_most_one_provider_post: ok(
        "one resume call per step, no retry; an already-active entity is read and skipped rather than re-sent",
      ),
      immutable_attempt_receipt: ok(
        "meta_ads_action_log rows carrying launch_intent_id — the same table History reads",
      ),
      independent_provider_readback: ok(
        "hierarchy-activation.ts — a second readState by id after the write, never the write's own response",
      ),
      exact_identity_and_state_verification: ok(
        "identity_drift when the read answers about another entity; both status and effective_status must read ACTIVE",
      ),
      durable_terminal_receipt_or_reconciliation_marker: ok(
        "completeMetaAdsActionLog terminalises each step — ambiguous lands as silent_failure, which is what blocks the next attempt — and meta_launch_intents.activation_receipt_json stores the whole sequence",
      ),
      rollback_or_compensation_record: ok(
        "the claim's payload_request.prior_state records what the entity was before this write, written before the POST so it survives an unreadable outcome",
      ),
    },
  },
];

export function writeFamily(id: WriteFamilyId): WriteFamily {
  const family = WRITE_FAMILIES.find((item) => item.id === id);
  if (!family) throw new Error(`write-safety: unknown family ${id}`);
  return family;
}

/** Steps a family does not satisfy. Empty means it conforms. */
export function missingSteps(family: WriteFamily): WriteSafetyStep[] {
  return WRITE_SAFETY_STEPS.filter(
    (step) => family.steps[step].status === "missing",
  );
}

/**
 * Families whose gate is open while steps are still missing.
 *
 * This is the check that gives the contract teeth. A family may be incomplete
 * as long as it cannot reach Meta; the moment its gate opens, every step has to
 * be satisfied. The conformance test asserts this list is empty in whatever
 * environment it runs.
 */
export function openGatesWithMissingSteps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Array<{ family: WriteFamilyId; missing: WriteSafetyStep[] }> {
  const gates = readMetaReleaseGates(env);
  const open: Record<WriteFamily["gate"], boolean> = {
    META_DECISION_WORKFLOW_UI: gates.decisionWorkflowUi,
    META_AUTOMATION_LIVE_WRITES: gates.automationLiveWrites,
    META_LAUNCHPAD_EXECUTION: gates.launchpadExecution,
  };
  return WRITE_FAMILIES.filter((family) => open[family.gate])
    .map((family) => ({ family: family.id, missing: missingSteps(family) }))
    .filter((entry) => entry.missing.length > 0);
}

/**
 * §10.1's rules. Stated as data so they can be quoted in a refusal and asserted
 * in a test, rather than living only in prose someone has to remember.
 */
export const WRITE_SAFETY_INVARIANTS = [
  "A client kill-switch value is not server authority.",
  "A provider create or duplicate POST is never retried automatically.",
  "GET-only verification may use bounded retry; writes may not.",
  "The same idempotency key never produces a second provider write.",
  "An ambiguous outcome is never recorded as success or as definite failure.",
  "A pending reconciliation blocks further writes to the same entity.",
  "A provider 200 response is not a read-back.",
  "A write whose receipt could not be persisted is not verified.",
  "A bulk flow completes every target's preflight before the first POST.",
] as const;
