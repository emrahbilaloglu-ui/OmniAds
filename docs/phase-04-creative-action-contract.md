# Phase 04 - Creative Action Contract

Live release posture for this surface now lives in `docs/v3-01-release-authority.md` and `/api/release-authority`.

## Routes

- `GET /api/creatives/decision-os?businessId&startDate&endDate`
- `POST /api/ai/creatives/decisions`

## Read-only Decision OS response

```ts
interface CreativeDecisionOsV1Response {
  contractVersion: "creative-decision-os.v1";
  generatedAt: string;
  businessId: string;
  startDate: string;
  endDate: string;
  summary: CreativeDecisionOsSummary;
  creatives: CreativeDecisionOsCreative[];
  families: CreativeDecisionOsFamily[];
  patterns: CreativeDecisionOsPattern[];
  protectedWinners: CreativeDecisionProtectedWinner[];
  supplyPlan: CreativeDecisionSupplyPlanItem[];
  lifecycleBoard: CreativeDecisionLifecycleBucket[];
  operatorQueues: CreativeDecisionOperatorQueue[];
  commercialTruthCoverage: CreativeDecisionOsCommercialTruthCoverage;
}
```

## Creative decision object

```ts
interface CreativeDecisionOsCreative {
  creativeId: string;
  familyId: string;
  familyLabel: string;
  familySource: "story_identity" | "asset_identity" | "copy_signature" | "singleton";
  name: string;
  creativeFormat: "image" | "video" | "catalog";
  lifecycleState:
    | "incubating"
    | "validating"
    | "scale_ready"
    | "stable_winner"
    | "fatigued_winner"
    | "blocked"
    | "retired"
    | "comeback_candidate";
  primaryAction:
    | "promote_to_scaling"
    | "keep_in_test"
    | "hold_no_touch"
    | "refresh_replace"
    | "block_deploy"
    | "retest_comeback";
  legacyAction: "scale_hard" | "scale" | "watch" | "test_more" | "pause" | "kill";
  confidence: number;
  benchmark: CreativeDecisionBenchmark;
  fatigue: CreativeDecisionFatigue;
  economics: CreativeDecisionEconomics;
  familyProvenance: CreativeDecisionFamilyProvenance;
  deployment: CreativeDecisionDeploymentRecommendation;
  report: CreativeRuleReportPayload;
}
```

Additive V2-05 fields do not change `contractVersion`; they extend the existing read-only contract.

## Family and pattern objects

- `CreativeDecisionOsFamily`
  - family-level rollup for spend, purchase value, purchases, member ids, top lifecycle, primary action, and family provenance
- `CreativeDecisionOsPattern`
  - hook / angle / format rollup with counts, spend, purchase value, and primary outcome mix
- `CreativeDecisionOperatorQueue`
  - operator queue object for `promotion`, `keep_testing`, `fatigued_blocked`, and `comeback`
- `CreativeDecisionProtectedWinner`
  - stable winners that stay protected and out of the promotion queue
- `CreativeDecisionSupplyPlanItem`
  - deterministic creative backlog for `new_test_concepts`, `refresh_existing_winner`, `expand_angle_family`, and `revive_comeback`

## Compatibility contract

`POST /api/ai/creatives/decisions` stays operator-visible and backward compatible.

Mapping is fixed:

- `promote_to_scaling` -> `scale_hard` or `scale`
- `hold_no_touch` -> `scale` or `watch`
- `keep_in_test` -> `test_more`
- `refresh_replace` -> `pause`
- `block_deploy` -> `kill` or `pause`
- `retest_comeback` -> `test_more`

The legacy route is a compatibility surface only. The Decision OS engine is the source of truth.

## Deterministic versus AI provenance

- `Recommendations`
  - page-level operator framing; may contain deterministic Decision OS sections
- `Decision Signals`
  - deterministic row-level compatibility surface backed by the Decision OS engine
- `AI Commentary`
  - bounded commentary only; never the source of lifecycle state, benchmark choice, fatigue status, or deployment target

The UI must never relabel deterministic outputs as AI, and must never present AI commentary as a decision object.

## UI test-id contract

- `creative-decision-os-drawer`
- `creative-decision-os-overview`
- `creative-lifecycle-board`
- `creative-operator-queues`
- `creative-family-board`
- `creative-pattern-board`
- `creative-protected-winners`
- `creative-supply-plan`
- `creative-detail-deterministic-decision`
- `creative-detail-commercial-context`
- `creative-detail-ai-commentary`
- `creative-detail-deployment-matrix`
- `creative-detail-benchmark-evidence`
- `creative-detail-fatigue-evidence`

## Non-goals

- No write-back
- No action queue persistence
- No AI-authored decision objects
- No creative generation workflow
