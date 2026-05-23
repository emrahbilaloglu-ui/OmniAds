# V3 To V2.1 Mapping

Status: PR7B-beta implementation policy approved by Claude follow-up review.
This document is the single mapping source for the first V3 `DecisionOutput`
to V2.1 bridge.

## Boundary

The bridge converts active V3 output into a V2.1 engine-root object plus the
adapter audit metadata that the existing `CreativeDecisionCenter` adapter can
consume.

```
V3 DecisionOutput + explicit context
  -> V3 bridge
  -> V3BridgeMappedResult | V3BridgeOmittedResult
  -> existing buyer adapter
  -> CreativeDecisionCenterRowDecision
  -> snapshot builder
```

The bridge does not call `decideCreative`, resolver gates, Meta write APIs,
DB clients, UI components, or scripts. It is a deterministic translation layer.

## Source Fields

Bridge input must include:

- `decision`: V3 `DecisionOutput`
- `context.creativeId`: row creative id
- `context.rowId`: optional row id, usually ad id when available
- `context.identityGrain`: `ad`, `creative`, `asset`, or `family`
- `context.familyId`: optional family id
- `context.campaignKind`: server-resolved `test`, `main`, `mixed`, or null
- `context.dataHealthDegraded`: route-level data-health degradation

Optional future inputs:

- per-row freshness
- policy proof fields
- 24h delivery proof fields
- first seen / first spend launch basis

## Output Contract

The bridge returns one discriminated union:

- `kind: "mapped"` plus:
  - `engine`: V2.1 `CreativeDecisionOsV21Output`
  - `adapterInput`: the exact `CreativeDecisionCenterAdapterInput` to pass to
    `adaptCreativeDecisionToRow`
  - `sourceDecision`: adapter audit metadata, derived from V3
    `labelTransform` or the V3 label
  - `trace`: deterministic mapping metadata for tests and debugging
- `kind: "omitted"` plus:
  - `omitReason`
  - `sourceDecision`
  - `trace`

Omitted decisions are not row decisions. They may still appear in legacy lanes
until V2.1 becomes the default surface.

All mapped outputs must set:

- `contractVersion: "creative-decision-os.v2.1"`
- `engineVersion` from the V3 decision
- `queueEligible: false`
- `applyEligible: false`
- `sourceDecision` is passed to the adapter, not embedded in the V2.1 engine

The canonical mapped result shape is:

```ts
type V3BridgeMappedResult = {
  kind: "mapped";
  engine: CreativeDecisionOsV21Output;
  adapterInput: CreativeDecisionCenterAdapterInput;
  sourceDecision: string;
  trace: {
    sourceLabel: DecisionLabel;
    labelTransform: DecisionOutput["labelTransform"] | null;
    mappedPrimaryDecision: CreativeDecisionOsV21PrimaryDecision;
    problemClass: CreativeDecisionCenterProblemClass;
    missingData: string[];
    reasonTags: string[];
  };
};

type V3BridgeOmittedResult = {
  kind: "omitted";
  omitReason: "plain_keep_no_action" | "out_of_scope";
  sourceDecision: string;
  trace: {
    sourceLabel: DecisionLabel;
    labelTransform: DecisionOutput["labelTransform"] | null;
    reasonTags: string[];
  };
};
```

`sourceDecision` must be:

1. `decision.labelTransform` when present, for example
   `test_cohort_refresh_to_cut`
2. otherwise `v3:<label>`, for example `v3:scale`, `v3:keep`, or
   `v3:out_of_scope`

This preserves D012/D013 label-transform audit context without expanding the
V2.1 primary-decision or buyer-action unions.

## Label Mapping

| V3 label | V2.1 primaryDecision | Row emitted? | problemClass | actionability | Notes |
|---|---|---:|---|---|---|
| `scale` | `Scale` | yes | `performance` | `review_only` | Execution CTA is adapter-owned from campaign kind. |
| `cut` | `Cut` | yes | `performance` | `review_only` | No automatic pause/write. |
| `refresh` | `Refresh` | yes | `fatigue` or `creative` | `review_only` | Fatigue badges choose `fatigue`; otherwise `creative`. |
| `test_more` | `Test More` | yes | `insufficient_signal` | `review_only` | Launch-specific `watch_launch` is blocked until launch basis is enriched. |
| `diagnose` | `Diagnose` | yes | derived | `diagnose` | Badge/reason context chooses data/campaign/performance. |
| `keep` | derived | conditional | derived | derived | Plain no-op keeps are omitted. Review-worthy keeps are mapped safely. |
| `out_of_scope` | none | no | none | none | Omitted from V2.1 row decisions. |

When `primaryDecision === "Diagnose"`, `actionability` is always `diagnose`.
This includes conditional `keep` mappings that become `Diagnose` rows.

## Conditional `keep` Mapping

Plain V3 `keep` is not a V2.1 buyer-facing primary decision. The bridge only
emits a row when the `keep` result contains an explicit reason a buyer should
review.

| V3 evidence | V2.1 primaryDecision | problemClass | actionability | reasonTags |
|---|---|---|---|---|
| `unlabeled_campaign_context` badge or `campaignLabelStatus` not labeled while hard action is blocked | `Diagnose` | `campaign_context` | `diagnose` | `campaign_label_missing` |
| `scale_readiness_blocked` badge | `Test More` | `insufficient_signal` | `review_only` | `near_scale_blocked` |
| `scale_calibration_thin` badge | `Test More` | `data_quality` | `review_only` | `scale_calibration_thin` |
| `weak_performance`, `low_ctr`, or `below_breakeven` badge | `Test More` | `insufficient_signal` | `review_only` | matching V3 badge type |
| no review-worthy badge | omit | none | none | `plain_keep_no_action` |

## Problem Class Derivation

Badge and reason context is read in this priority order:

1. `tracking_anomaly`, stale badges, truth-source degradation, missing recent
   data, or thin calibration -> `data_quality`
2. `unlabeled_campaign_context`, missing campaign label, or campaign/adset
   context blocker ->
   `campaign_context`
3. `fatigue_watch` or `fatigue_fatigued` -> `fatigue`
4. `delivery_limited` without policy proof -> `data_quality`
5. `landing_page_issue`, `checkout_breakdown`, or funnel breakdown ->
   `performance`
6. otherwise V3 `diagnose` -> `data_quality`
7. otherwise action labels `scale`, `cut`, `test_more` -> `performance` or
   `insufficient_signal` per label table

The bridge must not emit `delivery` or `policy` problem classes until the
proof fields in `DATA_READINESS.md` exist in the input.

## Maturity Derivation

Maturity is conservative and based only on V3 output fields currently present:

| Condition | maturity |
|---|---|
| spend <= 0 or V3 metrics missing | `too_early` |
| spend > 0 and purchases === 0 | `learning` |
| purchases > 0 and confidence < 70 | `actionable` |
| purchases > 0 and confidence >= 70 | `mature` |

This is intentionally a heuristic for bridge v1. D014 commercial maturity
thresholds are not part of the V3 `DecisionOutput` bridge input yet; using
account-profile maturity thresholds would require widening the bridge input and
is deferred to a separate ADR because it can change decision surface confidence.
Future data-readiness slices may replace this with explicit launch age,
commercial maturity, and row freshness context.

## Priority Derivation

Priority stays deterministic:

| Condition | priority |
|---|---|
| `dataHealthDegraded` or problem class `data_quality` with label `diagnose` | `high` |
| V3 label `scale`, `cut`, or `refresh` with confidence >= 70 | `high` |
| confidence >= 40 | `medium` |
| otherwise | `low` |

The first bridge version does not emit `critical`.

## Confidence And Missing Data

The bridge copies V3 `confidence` numerically, but adds missing data markers
when the row lacks proof required for the buyer action:

- route `dataHealth.degraded` -> `data_health`
- truth source `account_baseline_thin` or `global_default` -> `truth`
- tracking anomaly badge -> `tracking`
- `diagnose` from delivery-limited evidence without delivery proof -> `delivery_proof`
- `test_more` standing in for launch without first seen/spend basis -> no
  `watch_launch`; do not add `launch_basis` unless launch monitoring is emitted

Rows with any `missingData` are capped to low confidence by the existing
adapter invariant path.

## Reason Tags

The bridge emits stable machine tags. It never parses arbitrary prose for tags.
`evidenceSummary` may copy the V3 human-readable `reason` verbatim, but
`reasonTags` are generated only from this whitelist:

- V3 `badges[].type` values verbatim
- V3 label literals: `v3_scale`, `v3_cut`, `v3_refresh`, `v3_test_more`,
  `v3_diagnose`, `v3_keep`, `v3_out_of_scope`
- conditional `keep` tags: `near_scale_blocked`, `scale_calibration_thin`,
  `campaign_label_missing`, `plain_keep_no_action`
- missing-data tags: `data_health_degraded`, `truth_degraded`,
  `tracking_anomaly_present`

`evidenceSummary` may include the V3 human-readable reason.

## Data Readiness Blocks

Until enriched fields exist:

- no `fix_delivery`
- no `fix_policy`
- no high-confidence `watch_launch`
- no aggregate `brief_variation`
- no live apply eligibility

The safe fallback is `diagnose_data`, `test_more`, or omit.

## Known PR7B-beta Coverage Gaps

The first bridge does not fake proof fields that do not exist yet. These
golden-case expectations are therefore intentionally pending until the PR8
data-readiness slice enriches bridge input:

| Case | Expected future buyerAction | PR7B-beta bridge output | Reason |
|---|---|---|---|
| GC-001 | `fix_delivery` | `diagnose_data` | no 24h spend/impression proof |
| GC-004, GC-005, GC-022 | `fix_policy` | `diagnose_data` | no policy/review proof fields |
| GC-007, GC-008, GC-009 | `watch_launch` | `test_more` | no first-seen/first-spend launch basis |
| GC-029, GC-031, GC-034 | `protect` | omitted or non-Protect review row | V3 emits no Protect and family signals are not bridge input |
| GC-038 | review-like no-op | omitted | plain `keep` has no V2.1 buyer action |
| GC-040, GC-041 | same-as-canonical | omitted or `Diagnose` | V2.1 has no `same_as_canonical` buyer action |
| GC-049-GC-052 | review-like keep | `test_more` | conditional `keep` maps to safe review-only testing rows |
| GC-054, GC-055, GC-056 | scale execution CTA | `scale` plus adapter `executionAction` | supported by D016/D019 |

PR7B-beta tests must mark the pending data-readiness cases as explicit
`it.todo`/documented gaps rather than silently asserting future behavior.

## Module Isolation Implications

`lib/creative-decision-center/v3-bridge.ts` may import V3 types from
`@/lib/creative-decision-engine/types` using `import type` only. It must not
runtime-import `@/lib/creative-decision-engine`, call `decideCreative`, call
resolver gates, call `finalizeDecision`, use campaign-label guards, access DB
clients, use `process.env`, fetch, or touch Meta write APIs.

The module-isolation test must be narrowed so type-only engine imports are
allowed only for `v3-bridge.ts`, while runtime engine imports and runtime
engine identifiers remain forbidden for every Creative Decision Center module.

## Versioning

The bridge exposes `CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION =
"creative-decision-center.v3-bridge.v1"`. The `DecisionCenterSnapshot`
contract does not gain a new top-level
`bridgeVersion` field in PR7B-beta; route wiring may compose the string into
`adapterVersion` (for example `bridge-v1+adapter-v1`) when a non-empty bridged
snapshot is emitted behind `?decisionCenter=1`.

## Determinism Requirements

For the same bridge input, output must be byte-stable except object identity.
Tests must assert repeated calls produce identical JSON.

## Acceptance Tests

PR7B implementation must include tests for:

- every V3 label
- all three scale campaign kinds: Test, Main, Mixed
- unlabeled scale safety path through the existing adapter
- review-worthy `keep` mapping
- plain `keep` omission
- `out_of_scope` omission
- `labelTransform` -> `sourceDecision` audit preservation
- degraded data adds `missingData`
- module isolation allows only type-only V3 imports in `v3-bridge.ts`
- bridge output validates as V2.1 engine output
- bridge -> adapter row validates and passes invariants
- deterministic repeated output
