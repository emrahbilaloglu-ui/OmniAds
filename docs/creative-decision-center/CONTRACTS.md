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
