# Proposed Contracts

Documentation only. Do not implement runtime code from this file without tests and ADR review.

## Core Types

```ts
type CreativeDecisionOsV21PrimaryDecision =
  | "Scale"
  | "Cut"
  | "Refresh"
  | "Protect"
  | "Test More"
  | "Diagnose";

type CreativeDecisionCenterBuyerAction =
  | "scale"
  | "cut"
  | "refresh"
  | "protect"
  | "test_more"
  | "watch_launch"
  | "fix_delivery"
  | "fix_policy"
  | "diagnose_data";

type CreativeDecisionCenterAggregateAction =
  | "brief_variation"
  | "creative_supply_warning"
  | "winner_gap"
  | "fatigue_cluster"
  | "unused_approved_creatives";

type CreativeDecisionCenterExecutionAction =
  | "promote_to_main"
  | "scale_budget"
  | "controlled_scale";

interface CreativeDecisionOsV21Output {
  contractVersion: "creative-decision-os.v2.1";
  engineVersion: string;
  primaryDecision: CreativeDecisionOsV21PrimaryDecision;
  actionability: "direct" | "review_only" | "blocked" | "diagnose";
  problemClass:
    | "performance"
    | "creative"
    | "fatigue"
    | "delivery"
    | "policy"
    | "data_quality"
    | "campaign_context"
    | "insufficient_signal"
    | "launch_monitoring";
  confidence: number;
  maturity: "too_early" | "learning" | "actionable" | "mature";
  priority: "critical" | "high" | "medium" | "low";
  reasonTags: string[];
  evidenceSummary: string;
  blockerReasons: string[];
  missingData: string[];
  queueEligible: false;
  applyEligible: false;
  // Optional review metadata only. These fields must never affect the fields
  // above, buyerAction, an authority blocker, or provider mutation eligibility.
  commercialTargetAge?: {
    status: "recent" | "review_due" | "unknown";
    ageDays: number | null;
  };
}

interface CreativeDecisionCenterRowDecision {
  scope: "creative";
  creativeId: string;
  rowId?: string;
  identityGrain: "ad" | "creative" | "asset" | "family";
  familyId?: string | null;
  engine: CreativeDecisionOsV21Output;
  buyerAction: CreativeDecisionCenterBuyerAction;
  buyerLabel: string;
  uiBucket: CreativeDecisionCenterBuyerAction;
  // D019: optional campaign-kind execution CTA. Null/absent for non-scale rows
  // or scale rows without a labeled campaign kind. Does not expand buyerAction.
  executionAction?: CreativeDecisionCenterExecutionAction | null;
  // D020: opaque audit metadata for the upstream engine label (for example V3
  // `keep`, `same_as_canonical`, `out_of_scope`). Free-form string; never used
  // by the UI to compute buyerAction. Adapter-only diagnostic surface.
  sourceDecision?: string | null;
  confidenceBand: "high" | "medium" | "low";
  priority: "critical" | "high" | "medium" | "low";
  oneLine: string;
  reasons: string[];
  nextStep: string;
  missingData: string[];
}

interface CreativeDecisionCenterAggregateDecision {
  scope: "page" | "family";
  familyId?: string | null;
  action: CreativeDecisionCenterAggregateAction;
  priority: "critical" | "high" | "medium" | "low";
  confidence: number;
  oneLine: string;
  reasons: string[];
  affectedCreativeIds: string[];
  nextStep: string;
  missingData: string[];
}

interface DecisionCenterSnapshot {
  contractVersion: "creative-decision-center.v2.1";
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  generatedAt: string;
  dataFreshness: {
    status: "fresh" | "stale" | "unknown";
    maxAgeHours?: number | null;
    latestSnapshotAsOf?: string | null;
    snapshotAgeHours?: number | null;
  };
  inputCoverageSummary: Record<string, number>;
  missingDataSummary: Record<string, number>;
  todayBrief: Array<{
    id: string;
    priority: "critical" | "high" | "medium" | "low";
    text: string;
    rowIds: string[];
    aggregateIds?: string[];
  }>;
  actionBoard: Record<CreativeDecisionCenterBuyerAction, string[]>;
  rowDecisions: CreativeDecisionCenterRowDecision[];
  aggregateDecisions: CreativeDecisionCenterAggregateDecision[];
}

interface BuyerActionMappingRule {
  id: string;
  when: {
    primaryDecision?: CreativeDecisionOsV21PrimaryDecision;
    problemClass?: CreativeDecisionOsV21Output["problemClass"];
    reasonTagsAny?: string[];
    actionability?: CreativeDecisionOsV21Output["actionability"];
    requiredData?: string[];
    blockersAbsent?: string[];
  };
  output: {
    buyerAction: CreativeDecisionCenterBuyerAction;
    buyerLabel: string;
    uiBucket: CreativeDecisionCenterBuyerAction;
    // D019: optional campaign-kind execution CTA emitted alongside `buyerAction`.
    executionAction?: CreativeDecisionCenterExecutionAction | null;
    nextStepTemplate: string;
  };
}

interface CreativeDecisionConfig {
  configVersion: string;
  launchWindowHours: number;
  noSpendWindowHours: number;
  minSpendForMaturityMultiplier: number;
  minPurchasesForScale: number;
  minImpressionsForCtrReliability: number;
  fatigueCtrDropPct: number;
  fatigueCpmIncreasePct: number;
  fatigueFrequencyIncreasePct: number;
  maxCpaOverTargetForCut: number;
  minRoasOverTargetForScale: number;
  winnerGapDays: number;
  fatigueClusterTopN: number;
  benchmarkReliabilityMinimum: "strong" | "medium" | "weak";
  staleDataHours: number;
  minConfidenceForScale: number;
  minConfidenceForCut: number;
}
```

## Meta Decisions Read-Time Compatibility Projection (D035)

The V2.1 adapter union above remains readable for historical snapshots. The
current Meta Decisions server boundary must additionally discriminate an
action from a blocked resolution:

```ts
type MetaDecisionState = "act" | "monitor" | "blocked" | "not_applicable";

interface MetaDecisionResolution {
  code: string;
  category:
    | "data"
    | "tracking"
    | "commercial_truth"
    | "campaign_context"
    | "delivery"
    | "policy"
    | "funnel"
    | "system";
  owner: "system" | "operator" | "integration";
  label: string;
  nextStep: string;
}

interface MetaDecisionClassificationProjection {
  decisionState: MetaDecisionState;
  heldAction: "scale" | "cut" | "refresh" | null;
  legacyBuyerAction: CreativeDecisionCenterBuyerAction;
  buyerAction: Exclude<
    CreativeDecisionCenterBuyerAction,
    "diagnose_data"
  > | null;
  resolution: MetaDecisionResolution | null;
}
```

When `decisionState === "blocked"`, `buyerAction` must be null,
`resolution` must be non-null, and no provider mutation may be exposed. The UI
must not recreate this projection from raw labels, reason text, or badge copy.
When persisted `blocked_action_type` is non-null, the server projection must
also be blocked and must label the held Scale/Cut/Refresh signal explicitly;
the published soft compatibility label remains audit provenance only.

## Native Ad Calibration Action Readiness v3 (D060-D063)

The v3 native calibration receipt keeps the v2 action path and adds one
account/currency spend-unit proof. Label math remains in the canonical
resolver:

```ts
interface NativeAdCalibrationActionReadinessEntryV3 {
  ready: boolean;
  reason: string | null;
  authorityBasis:
    | "calibrated_relative"
    | "calibrated_relative_with_economic_stop_loss"
    | "commercial_stop_loss"
    | null;
  observedSampleCount: number;
  requiredSampleCount: number;
}

interface NativeAdAccountAovEvidenceV1 {
  status:
    | "ready"
    | "insufficient_sample"
    | "contradictory_purchase_truth"
    | "unavailable";
  scope: "business_provider_account_currency";
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  asOfCutoff: string;
  observedPurchaseCount: number;
  requiredPurchaseCount: 20;
  revenueBackedRowCount: number;
  canonicalRowCount: number;
  contradictoryRowCount: number;
  legacySchemaRowCount: number;
  unsupportedSchemaRowCount: number;
  totalRevenue: number;
  meanAov: number | null;
  evidenceHash: string;
}

interface NativeAdSpendUnitAuthorityV1 {
  contractVersion: "engine-v3-native-ad-spend-unit-authority.v1";
  status: "ready" | "blocked";
  basis:
    | "target_cpa"
    | "operator_aov"
    | "physical_account_purchase_aov_90d"
    | null;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  asOfCutoff: string;
  targetAuthorityHash: string;
  baseSpendUnit: number | null;
  accountAovEvidence: NativeAdAccountAovEvidenceV1;
  authorityHash: string;
}

interface NativeAdCalibrationActionReadinessV3 {
  spendUnitAuthority: NativeAdSpendUnitAuthorityV1;
  scale: NativeAdCalibrationActionReadinessEntryV3;
  cut: NativeAdCalibrationActionReadinessEntryV3;
  refresh: NativeAdCalibrationActionReadinessEntryV3;
}

interface ExpandedEconomicCutAuthorityV1 {
  eligible: boolean;
  authorityBasis:
    | "calibrated_relative_with_economic_stop_loss"
    | "commercial_stop_loss"
    | null;
  reason: string | null;
}
```

A ready `commercial_stop_loss` proof is valid only for exact purchase-cell
`cut`, requires explicit target, break-even, and spend-unit authority, and
declares zero required peer samples when no usable exact-cell P25 exists. A
ready `calibrated_relative_with_economic_stop_loss` proof has the same
target and break-even requirements, a valid loss-budget spend unit from either
the authenticated account/currency receipt or the canonical exact-cell CPA P50
at the retained sample floor, plus a positive exact-cell P25 backed by the
retained Cut sample floor. It tells the canonical resolver that both the legacy
P25 region and D063's economic-loss extension are available; it is not a
second decision or an authorization to bypass maturity. A ready
`calibrated_relative` proof still requires the action's positive sample floor
and observed samples at or above it, but for Cut it authorizes only the legacy
region below P25. The native profile carries the readiness result as the
hash-bound `expandedEconomicCutAuthority`; only the hybrid and
`commercial_stop_loss` bases set it eligible. Blocked proofs must have a
non-null reason and null authority basis. Pooled/non-purchase cells remain
blocked.

`expandedEconomicCutAuthority` is optional only for canonical non-native
profiles. On that surface, the absent field makes
`expandedEconomicCutAuthority?.eligible === undefined`; that state preserves
the canonical D063 strip and is not an explicit denial. Native profiles must
always set the field from their hash-bound readiness receipt: `eligible: true`
grants the native expanded-strip capability, while `eligible: false` is the
explicit native denial. Consumers must not coerce the absent non-native field
to false.

D063 leaves the legacy region byte-compatible and adds one disjoint region.
Let `L = min(P25 ?? 0.70, 1.0)` and
`B = min(breakEvenRoas / targetRoas, 1.0)`. Ratios below `min(L, B)` retain the
existing Cut policy. Only when `B > L` may `L <= ratio < B` enter the existing
Cut maturity gate, and only after Refresh precedence. `ratio >= B`, including
equality, is never Cut-eligible. In the expanded region, sufficient canonical
recent spend with recent ROAS below break-even confirms the loss; recent ROAS
at or above break-even produces Keep. Missing or thin recent evidence persists
the exact held tuple below:

```ts
{
  preAuthorityLabel: "cut",
  label: "test_more",
  rawLabel: "test_more",
  authorityBlocker: "recent_recovery_unverifiable",
  blockedActionType: "cut",
  authorizedAction: null,
  pendingTransition: false,
}
```

The hold is evidence authority, not D036 hysteresis. When sufficient evidence
first appears, independent-date Cut confirmation starts fresh. Target age is
advisory and cannot veto the result. A ready physical-account AOV proof may
size only Cut loss-budget maturity; it cannot change `L`, `B`, the recent-spend
threshold, recovery, Scale, Refresh, or confidence. V1/v2 receipts remain
readable only under their original engine epochs and must not be upgraded by
inference.

### D061-D066 Release Version Matrix

| Contract surface | Release value |
| --- | --- |
| Canonical engine | `v3-2026-07-18-decision-presentation-hardening` |
| Native-Ad engine | `v3-ad-2026-07-18-decision-presentation-hardening-shadow` |
| Exact native rollback epoch | `v3-ad-2026-07-15-commercial-stop-loss-shadow` |
| Native calibration | `engine-v3-native-ad-calibration.v3` |
| Canonical evaluation | `engine-v3-canonical-evaluation.v5` |
| Native-Ad evaluation | `engine-v3-canonical-ad-evaluation.v7` |
| Native-Ad outcome | `engine-v3-ad-decision-outcome.v3` |
| Decisions workspace read | `meta-decisions-workspace.read.v4` |
| Classification overlay | `meta-decisions-classification-overlay.v4` |
| Decisions OS presentation | `meta-os-decisions.presentation.v5` |

D061 and D063 were not deployed separately. D064 therefore advances their
single release epoch while retaining the already-bumped v3/v5/v7 contracts
above. D065 execution hardening and D066 fact-ownership/replay proof do not
change resolver output or persisted decision shape, so they use that same
release epoch without another version bump. Older immutable rows remain
readable only under their recorded contracts.

## Canonical Briefing Authority And Synthetic Demo (D062, D064)

The briefing projection accepts only two authoritative statuses:

```ts
type BriefingCanonicalAuthorityStatus =
  | "native_exact"
  | "demo_synthetic_review_only";
```

`native_exact` may expose an action only when the persisted authority names the
same buyer action and every exact-Ad lineage field validates.
`demo_synthetic_review_only` must have null `authorizedAction`,
`actionEligible: false`, review-only reason
`demo_synthetic_review_only`, and identity `adActionEligible: false`.
`legacy_review_only` is not a canonical serving authority.

The demo generation contract binds one current-epoch synthetic Meta account,
the complete input-row manifest, one item hash per exact Ad, expected count,
and a generation manifest hash. Runtime projection validates the committed
fixture; it does not call the resolver or native persistence. Validation is
all-or-nothing and any mismatch returns an unavailable canonical inventory.
The production generator must reproduce the committed JSON byte-for-byte.

Blocked or held canonical actions never map to a launchpad mode, even when
their compatibility label is `test_more`. Money presentation uses the
canonical `accountCurrency`; missing currency is described generically and is
never silently defaulted to USD.

## Meta Provider Execution Origin And Live-Proof Contract (D065)

Provider mutations accept one explicit, non-overlapping authority envelope:

```ts
type MetaProviderActionOrigin =
  | {
      actionOrigin: "native_decision_v1";
      decisionOrigin: DecisionOriginAdExecutionRequest;
    }
  | {
      actionOrigin: "manual_operator_v1";
      manualConfirmation: "explicit_operator_confirmation";
      providerAccountId: string;
      entityId: string;
      creativeId: string | null;
    }
  | {
      actionOrigin: "launchpad_manual_v1";
      manualConfirmation: "explicit_operator_confirmation";
      launchIntentRequestFingerprint: string;
    };
```

Origin is a required discriminator; optional lineage-field presence is never
an origin signal. Manual and Launchpad envelopes reject every native-lineage
field when it is present, including `null`.

A native decision-origin preflight requires an exact derived provider action
from persisted `authorized_action`: only Cut-to-`pause` and Scale-to-`resume`
match. A null or different derived action is `action_not_authorized`; a matching
published label alone is insufficient.
The idempotency key is server-verifiable and deterministic over business,
physical account, Ad, snapshot, evaluation, engine epoch, decision hash,
provider action, and execute/dry-run mode. A non-canonical key fails before any
receipt lookup or live read. `creativeId` is required for execution and must
match the persisted source tuple and fresh provider Ad; a nullable legacy value
cannot authorize a write. A duplicate-success receipt and its durable log must
also carry that exact creative ID; a mismatch is `idempotency_conflict`.
`dryRun`, when present, is strictly boolean at the runtime JSON boundary.
Strings, numbers, null, and other malformed values are rejected before
receipt/provider work rather than being treated as execute mode.

Manual-operator and native-decision Ad status claim creation uses one shared
transactional claim over the exact business/provider-account/Ad tuple. The
transaction takes one advisory key, checks every origin for an unresolved
status claim, including any pending pause/resume row without a TTL, and either
inserts one claim or returns a typed conflict. New manual claims persist exact
`provider_account_id`; a legacy manual pending row whose account is null still
blocks the same business/Ad fail-closed. Provider network work never runs while
the transaction lock is held.

A live manual terminal `silent_failure/provider_outcome_ambiguous` remains an
unresolved status claim even though its row is terminal. Until exact
reconciliation clears that ambiguity, any later manual or native claim for the
same business/physical-account/Ad is rejected with
`meta_ad_status_reconciliation_required`,
`reconciliationRequired: true`, and `retryAllowed: false`, and performs zero
provider POSTs. A dry-run `silent_failure` is a definite non-mutation result and
does not create this live reconciliation hold.

Every new live manual pause/resume claim persists the exact
business/provider-account/Ad/creative/campaign/ad-set target and declares
`meta-manual-ad-status-mutation-attempt.v1`. Immediately before its sole
provider POST, the adapter must finish its fresh hierarchy/status/policy and
write-block checks and pass the exact business/account/Ad/creative/campaign/
ad-set baseline to the route's pre-mutation hook. Only an exact match to the
durable target may append one immutable `attempt_started` event under the shared
exact-Ad advisory lock. The event binds the source log, target hierarchy,
action, slashless Ad POST path, start time, and a two-minute attempt lease. The
provider call is forbidden on baseline drift, adapter precondition failure, or
start persistence failure. A received provider result must append one immutable
`attempt_completed` event before the source log becomes terminal. The
completion binds the exact one-attempt/no-automatic-retry receipt and one of:

- `provider_response_verified_success`;
- `provider_response_succeeded_verification_failed`;
- `provider_definite_failure`; or
- `provider_outcome_ambiguous`.

An unexpected throw after the immutable start may intentionally leave the
source pending with only `attempt_started`; a second POST is never inferred or
attempted. Started/completed events are append-only, evidence-hashed, and
idempotent only for the same normalized fact. The store and database trigger
both require the start target to equal the source claim's durable journal
target. Once a reconciliation event exists for that source, neither a late
start nor a late completion may be appended. Event `created_at` is
database-canonical and caller backdating is rejected; completed-attempt
reconciliation requires provider `observedAt` at or after the durable
completion event.

A live journal-required manual source may become terminal only through one of
the journal-consistent paths enforced by both store and database:

- success requires an exact `provider_response_verified_success` completion;
- `silent_failure` requires an ambiguous or
  successful-response/verification-failed completion;
- a provider failure requires an exact `provider_definite_failure` completion;
  or
- a pre-provider DB-only failure requires one of the closed, explicitly
  non-mutation post-claim/start/adapter-abort/bulk-abort proof shapes and no
  attempt event.

Generic action-log completion cannot bypass this guard. Dry-run, native, legacy
pre-contract, and non-status manual logs retain their own contracts. Protected
source identity, journal target/contract, and committed terminal fields are
immutable on every update; attempt and reconciliation events are append-only.

Direct and bulk live status routes run the same automatic reconciliation
preflight before any new claim or provider write. It performs no provider GET
before the source-specific settlement floor:

- a completed attempt waits five minutes after completion;
- a started-only attempt waits through its two-minute lease and five additional
  minutes;
- a journal-contract pending row with no start waits five minutes after claim
  creation; and
- a pre-contract legacy `silent_failure` with no physical-account identity is
  quarantined for seven days after its latest requested/updated/verified
  timestamp and is eligible only when the database resolves one exact target.

After that floor, reconciliation performs one bounded exact-state read sequence
and requires matching business, physical account, Ad, creative, campaign,
ad-set, configured/effective status, active parent hierarchy, and policy
eligibility. Under the same advisory key, it revalidates the unchanged source
authority and appends one immutable
`meta-manual-ad-status-reconciliation.v1` event with provider GET evidence and
hash. The only resolutions are `current_state_matches_requested` and
`current_state_matches_precondition`; neither rewrites the historical terminal
fact or pretends the old provider attempt succeeded. A final source reread must
prove the unresolved blocker disappeared. Missing, multiple, contradictory,
stale, ineligible, or persistence-uncertain evidence fails closed with zero
provider POSTs.

If the reconciled current configured/effective state already equals the new
request's desired status, that request returns a verified no-op and creates no
new mutation claim. Otherwise the route creates a fresh exact claim and runs
the normal post-claim preflight plus single-attempt journal. These rules are
provider-generic and identical for every business; no firm-specific bypass,
manual provider mutation, or timeout-only deletion can clear a hold.

A concurrent native same-key loser receives HTTP 409 with the existing pending
idempotency receipt and `action_in_flight`; if that receipt already has a
reconciliation marker, the response instead carries the marker's common error
code, `reconciliationRequired: true`, and `retryAllowed: false`. A concurrent
native different-key loser receives HTTP 409 with
`decision_origin_pending_reconciliation_required`,
`reconciliationRequired: true`, and `retryAllowed: false`. Cross-origin and
manual/manual conflicts receive HTTP 409 `action_in_flight`,
`blockingActionLogId`, `blockingOrigin`, and `retryAllowed: false`; a native
reconciliation receipt is included when applicable. Every variant authorizes
zero provider POSTs. Direct and bulk status endpoints must reach this shared
classifier rather than substituting native-only or time-window pending guards.

Before the first mutation:

- the exact business-owned provider account and requested entity IDs must
  resolve from server-held identity;
- a fresh provider GET must prove returned entity ID, `account_id`, creative
  identity, configured/effective status, policy eligibility, and every
  required parent link;
- duplicate/reuse must prove the source Ad/creative and ACTIVE target
  ad-set/campaign;
- new-campaign creation must prove every selected creative/account; and
- bulk and multi-create requests must pass all target, pending-action, and
  cardinality checks as one preflight set.

The all-target set is the initial batch gate: one failure there prevents the
first provider mutation. After either a manual or native Ad status action has
atomically claimed its pending log row, it must rerun the exact live preflight;
native ignores only its own pending receipt. A blocked manual post-claim
preflight is persisted as a DB-only terminal failure and performs no provider
POST. Bulk status execution performs an additional fresh exact-state and
unresolved-owner check immediately before each manual provider POST. The source
must still be the same pending claim and must still own the exact durable
target; a concurrent reconciliation or ownership change stops the current and
remaining items with no additional POST. A later claim conflict or preflight
failure never represents earlier completed mutations as rolled back. Any halt
DB-only terminalizes every untouched later prepared claim; cleanup uncertainty
returns reconciliation-required 503.

Provider-verified manual status success uses
`meta-ad-status-write-verification.v1`. The write adapter binds a complete
execution-state baseline immediately before its one allowed POST, then performs
a fresh complete read. Success requires unchanged provider account, Ad,
creative, campaign, and ad-set identity; requested Ad configured and effective
status; ACTIVE campaign/ad-set configured and effective status; policy
eligibility; null review blocker; observation time; and the unmodified provider
GET evidence. The store and database completion trigger revalidate this
canonical payload against the immutable attempt target and requested action.
Any missing field, effective-state drift, parent drift, policy/review blocker,
or identity contradiction is verification failure, never verified success.
Every provider GET and the sole POST are bounded at 30 seconds. Mutation fetches
use redirect-error semantics so provider redirects cannot replay the POST; no
POST retry is allowed. Bounded terminal retries reuse one frozen,
byte-identical terminal fact, including duration.

Post-write verification repeats returned ID, provider-account, creative,
campaign, and ad-set checks before an intent or action log can become
successful. A newly finalized provider-verified native pause/resume receipt
persists the full proof as:

```ts
interface ExactMetaStatusVerificationLineage {
  sourceCreativeId: string;
  sourceCampaignId: string;
  sourceAdsetId: string;
  verifiedProviderAccountId: string;
  verifiedCreativeId: string;
  verifiedCampaignId: string;
  verifiedAdsetId: string;
}
```

The verified account must equal the physical provider account and every
verified creative/campaign/ad-set ID must equal the corresponding immutable
source/episode ID. This object is part of the immutable receipt hash; changing
one field without changing the receipt is a hash mismatch, while a recomputed
but contradictory object still fails exact episode/provider lineage checks.

`verification_lineage` remains nullable only for receipts persisted before the
additive column existed. When it is null, the receipt hash intentionally omits
the `verificationLineage` property and therefore preserves the old canonical
hash bytes. Readers may accept that old receipt under its recorded contract,
but may not invent the missing hierarchy or treat null as newly observed live
proof. New provider-verified status finalization writes the complete non-null
object.

Every native decision-origin condition that cannot be safely terminalized leaves
the existing attempt pending and uses one common reconciliation error code:

```ts
type DecisionOriginReconciliationOutcome =
  | "provider_outcome_ambiguous"
  | "provider_response_succeeded_verification_failed"
  | "provider_write_verified_receipt_persistence_failed"
  | "dry_run_terminal_persistence_failed"
  | "provider_rejection_terminal_persistence_failed"
  | "pre_provider_terminal_persistence_failed";

{
  errorCode: "provider_verification_persistence_failed";
  outcome: DecisionOriginReconciliationOutcome;
  reconciliationRequired: true;
  retryAllowed: false;
  providerMutationAttempted: boolean;
  providerMutationSucceeded: boolean;
  providerOutcomeAmbiguous: boolean;
}
```

`provider_outcome_ambiguous` means a provider POST began but exact external
outcome is unknown. `provider_response_succeeded_verification_failed` means the
response proves mutation success but exact verification failed.
`provider_write_verified_receipt_persistence_failed` means mutation and
verification succeeded but atomic terminal row/receipt persistence failed.
`provider_rejection_terminal_persistence_failed` means a definite rejection was
received but its terminal failure could not be persisted.
`pre_provider_terminal_persistence_failed` and
`dry_run_terminal_persistence_failed` both assert that no provider mutation
occurred; the latter is specifically a non-mutation dry-run DB-only terminal
persistence failure.

The marker retains available mutation-attempt, provider-response, and
verification evidence but does not set success, `provider_verified`,
`verified_at`, or terminal-finalization authority. A pending reconciliation row
cannot emit an immutable operator-action receipt and is always treatment
ineligible, even when its outcome proves provider mutation success. A same-key
replay returns this non-retryable reconciliation state and performs zero
provider POSTs; a different key for the same exact Ad is likewise blocked. It
may become terminal only after exact reconciliation against current provider
state. A reader may expose `providerMutationSucceeded: true` only when the
marker carries a success-compatible outcome, mutation attempted and succeeded
are both explicitly true, and ambiguity is explicitly false. Missing or
contradictory fields remain unknown.

`rebuild_creative` is not executable until image, creative, and Ad steps have
durable attempt receipts. Provider create/duplicate POSTs are not automatically
retried without a provider-idempotent attempt contract; bounded retry remains
allowed for GET verification only.

For native decision-origin status actions, a provider POST transport exception
uses the pending `provider_outcome_ambiguous` reconciliation outcome above and
creates no immutable operator-action receipt. Manual status actions retain
terminal `silent_failure` action-log compatibility when a terminal fact can be
persisted; a new journaled raw throw may instead remain pending with only its
immutable start so settlement authority is not invented. Launchpad retains its
separate terminal attempt-receipt behavior. A received provider HTTP rejection
is a definite failure when terminal persistence succeeds. Multi-step execution
stops after either mutation failure.

Every manual action-log completion is a pending-only compare-and-set. Repeating
the same JSONB-normalized terminal fact is idempotent; a different terminal
fact conflicts and cannot overwrite the first outcome. A live raw adapter
exception before the pre-mutation hook is an exact DB-only zero-write failure.
An exception after the immutable start remains pending as an ambiguous external
outcome, with no inferred mutation success and `retryAllowed: false`; it blocks
every later provider claim for the exact Ad until reconciliation. Terminal
status alone does not make an ambiguous external outcome safe to retry. The
append-only journal and exact-state reconciliation above are the only generic
recovery path. If a verified success or other manual terminal fact cannot be
confirmed after two identical completion attempts, the response is a typed
`503` carrying the action-log identity and non-retryable disposition; bulk
execution omits every later item and no fallback failure completion is allowed.

The shared Launchpad fan-out contract rejects more than 20 creatives, 10 ad
sets or targets, or 20 planned provider creates before intent persistence or
provider work. The manual bulk status contract separately rejects more than
20 exact Ads.

The LaunchIntent request fingerprint binds the exact manual authority and
normalized payload while excluding attempt identity fields. Validation,
result/error receipts, and action logs carry that fingerprint. An unresolved
ambiguous intent blocks any fresh-key intent for the same business, physical
account, operation, and semantic fingerprint before persistence. The guard has
no timeout without an explicit reconciliation record. A retry or recovery
implementation must reconcile provider state against that fingerprint and the
recorded step attempts; it must not replay a POST from an ambiguous success.

## Native Ad Fact Ownership And Replay Proof (D066)

`upsertMetaAdDailyRows` accepts only its authoritative fact mode:

```ts
interface MetaAdDailyWriteOptions {
  writeMode: "authoritative_fact";
}
```

The explicit `authoritative_fact` mode retains the existing
insert, reference-resolution, provider-account metadata, Ad-dimension, fact,
and truth-version contract. Any other runtime mode, including the removed
`creative_enrichment` lane or an omitted mode, throws before DB access.
Creatives metadata sync writes only dedicated creative
daily/dimension/media presentation tables and must leave every byte and
timestamp of `meta_ad_daily` unchanged.

The authoritative lane recursively strips creative-media, preview, and
media-debug keys from `payload_json` before persistence while preserving metric
and other decision-evidence keys. The creative-media retention routine is
presentation-storage cleanup only: `meta_ad_daily` is excluded from its table
readiness contract, no Ad-day row or timestamp is mutated or deleted, and its
Ad-day update count is always zero.

Peer calibration and strict account evidence are intentionally non-identical:

- peer eligibility requires exact same-day Ad/campaign/ad-set hierarchy, all
  three truth states `FINALIZED`/`PASSED`, and cutoff-safe created/updated
  timestamps; Ad `finalized_at` may be null and is then quality-counted;
- physical-account AOV/currency/timezone eligibility additionally requires a
  non-null cutoff-safe Ad `finalized_at`.

The v7 current-day replay admits exactly three safe calibration classes only
after hash-bound production recomputation proves both projections, resolved
inputs, and resolved campaign contexts. Two
`profile_availability_restatement` classes are forward-only: exact
ready-profile collecting Test More to Keep under calibration-only maturity, or
the exact `native_calibration_missing` soft-only profile to an ordinary
non-hard Keep/Test More profile with zero hard-action eligibility on both
sides. The third, `calibration_restatement`, requires both sides to be ordinary
non-hard Keep/Test More with the identical action-semantic tuple while only
calibration-profile evidence changes. All three require unchanged exact
identity/input/data health/context and no hard label, `cut_candidate`, or
pending-transition artifact. `calibration_restatement` additionally requires
null blocker/blocked action/authorization and no hysteresis. A reason or badge
difference is safe only when production reproduction proves it is the
deterministic consequence of the calibration-only profile change. Reverse,
hybrid, arbitrary label/reason/context, hard-action, identity, or data-health
drift is `semantic_drift` and fails release.

The focused and all-current-population compact artifacts use
`adsecute.meta.native-ad-account-aov-current-day-production-parity.v7`, bind
the omitted full-row artifact and pre-output repository manifest, and require
an adjacent checksum. The real PostgreSQL seam must prove enrichment
immutability and retained authoritative upsert/truth-version behavior.

## Constraints

- Do not collapse `primaryDecision` and `buyerAction`.
- Do not add `brief_variation` to row-level `BuyerAction`.
- Row decision must expose engine root for drawer.
- Snapshot must include `engineVersion`, `adapterVersion`, `configVersion`, `generatedAt`, `dataFreshness`, `inputCoverageSummary`, and `missingDataSummary`.
- Do not expand `CreativeDecisionOsV21PrimaryDecision`. Upstream engine labels
  that do not match the existing six values (V3 `keep`, `same_as_canonical`,
  `out_of_scope`) ride on the optional `sourceDecision` audit metadata. See D020.
- Do not expand `CreativeDecisionCenterBuyerAction` for campaign-kind execution
  moves. Pair the existing `scale` buyerAction with the optional
  `executionAction` field. See D019.
- `actionBoard` stays keyed only by `buyerAction`. `executionAction` is row-level
  metadata and must not become a top-level bucket.

## Minimal Drawer Fields

- `buyerAction`
- `buyerLabel`
- engine `primaryDecision`
- `actionability`
- `problemClass`
- `reasonTags`
- `evidenceSummary`
- blockers
- `confidence`
- `maturity`
- `priority`
- `nextStep`
- `missingData` if any
