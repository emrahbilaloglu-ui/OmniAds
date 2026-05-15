# Decision Log

## D001 — Use V2 As Base And Evolve To V2.1

Decision: use existing `creative-decision-os-v2` as the base decision engine and evolve it to V2.1.

Reason: V2 already has a concise primary decision vocabulary and safety posture.

Rejected alternative: create a new standalone decision core.

Risk: V2 may need input expansion and problem-class refinements before it can support buyer-facing actions safely.

## D002 — Keep `primaryDecision` Separate From `buyerAction`

Decision: engine root remains `primaryDecision`; buyer language is produced by an adapter.

Engine `primaryDecision`:

- `Scale`
- `Cut`
- `Refresh`
- `Protect`
- `Test More`
- `Diagnose`

Buyer action:

- `scale`
- `cut`
- `refresh`
- `protect`
- `test_more`
- `watch_launch`
- `fix_delivery`
- `fix_policy`
- `diagnose_data`

Risk: collapsing these fields would mix engine semantics, UI labels, and safety posture.

## D003 — Use Deterministic Table-Driven Buyer Adapter

Decision: use a transparent adapter from engine output to buyer-facing action.

Reason: UI needs specific action language without turning UI into a decision engine.

Constraint: adapter must not become a hidden second decision engine.

## D004 — No Row-Level `brief_variation`

Decision: `brief_variation` is aggregate/page/family-level only.

Reason: variation needs often come from family/supply gaps, not one row.

Risk: row-level variation would mislead buyers and corrupt row action semantics.

## D005 — UI Must Not Compute Decisions

Decision: UI renders `decisionCenter`.

Reason: decision authority must be testable and reproducible.

Risk: UI-side meaning drift and duplicate vocabularies.

## D006 — Old Snapshots Must Remain Renderable

Decision: old V1/operator snapshots remain renderable through read-time adapters if needed.

Reason: historical reports and existing UI consumers must not break.

Risk: additive response design is required; do not rename routes initially.

## D007 — Missing Data Means `diagnose_data` Or Capped Confidence

Decision: required data gaps must produce `diagnose_data`, disabled action, or capped confidence.

Reason: fake certainty is worse than a conservative diagnostic.

Risk: buyer trust loss if `fix_delivery`, `fix_policy`, scale, or cut are emitted without proof.

## D008 — Minimal Detail Drawer Belongs In MVP

Decision: Minimal Detail Drawer is part of MVP.

Reason: Today Brief without "why" will not earn trust.

Risk: users will ignore recommendations if the engine root and evidence are hidden.

## D009 — Config-As-Data Is Required

Decision: thresholds must live in config, not scattered resolver branches.

Reason: launch windows, maturity, fatigue, and scale/cut thresholds need account/business tuning.

Risk: hard-coded thresholds cause silent drift and hard-to-review AI edits.

## D010 — Golden Cases And Invariants Before Resolver Changes

Decision: golden cases and invariants must land before behavior changes.

Reason: AI-generated resolver drift must be controlled.

Risk: plausible but inconsistent resolver rewrites.

## D011 — Kind-Aware Baseline Selection With Strict Canonical Fallback

Decision: when a creative's source campaign is labeled Main/Test/Mixed and
the kind-specific calibration row is sufficient, `decideCreative` uses a
kind-selected profile view: account baselines, spend-unit thresholds, funnel
calibration, and hard-action eligibility are selected together. Otherwise the
decision falls back to the canonical `all` profile.

Reason: Main and Test cohorts can have materially different distributions.
Using one shared baseline blurs decision boundaries and makes Test/Main
campaign labels operationally weaker than intended.

Risk: kind-aware decisions can diverge from canonical `all` decisions for
labeled creatives. Mitigation: GC-038 through GC-042 plus strict canonical
fallback for missing, sparse, or unlabeled kind data. `DecisionOutput`
also exposes `decisionKindSource` so API/debug consumers can distinguish
kind-selected decisions from canonical fallback while `accountProfile` remains
the canonical account-wide profile.

Rejected alternative: per-gate kind selection. That would mix Main/Test
threshold logic across gate files and violate D009.

Rejected alternative: include Test-fatigue refresh-to-cut semantic switching in
the same slice. That changes operator-visible label semantics and belongs in a
separate phase.

## D012 — Test Cohort Refresh Signals Become Cut Semantics

Decision: when a resolver gate emits `refresh` for a creative whose source
campaign is explicitly labeled Test, the engine pipeline transforms that label
to `cut` before soft-only hard-action eligibility is applied. The transform is
recorded on `DecisionOutput.labelTransform` as
`test_cohort_refresh_to_cut`, and the reason receives a
`[test_cohort: refresh->cut]` prefix.

Reason: Test campaigns are experiment slots. A fatigue/refresh signal in Test
does not mean "refresh this stable winner"; it means the experiment has reached
a negative or exhausted outcome and should leave the test pool. Main and Mixed
campaigns keep the existing `refresh` semantics.

Ordering: the transform runs inside `finalizeDecision` before
`applySoftOnlyLabel`, so it sees the raw gate-emitted label before any
`hardActionEligibility` downgrade. This is required because `applySoftOnlyLabel`
already converts `refresh` to `keep` when refresh is disabled. Placing the
transform after `finalizeDecision` would miss those cases. The engine-level
`enforceHardActionEligibility` call remains an idempotent defensive duplicate.

Scope: resolver gate files remain unchanged. `gates/types.ts::finalizeDecision`
is the pipeline orchestrator and now owns this semantic transform. No new
`DecisionLabel` value is introduced, no UI computes the transform, and
`labelTransform` is an API/debug diagnostic only.

Rejected alternative: persist `labelTransform` into
`engine_v3_decision_snapshots_daily` in the same slice. Persistence was deferred
to D013 because this phase already changed behavior and should not have bundled
a schema migration/rollback concern.

## D013 — Persist Test Cohort Label Transform Diagnostics

Decision: persist `DecisionOutput.labelTransform` into
`engine_v3_decision_snapshots_daily.label_transform` as a nullable constrained
diagnostic field. The only allowed non-null value is
`test_cohort_refresh_to_cut`.

Reason: `labelTransform` explains why a Test campaign refresh signal became a
cut-style decision. Keeping it only on the live/API `DecisionOutput` loses that
audit context when daily snapshots are inspected later.

Scope: this is persistence-only. It does not add a new `DecisionLabel`, does not
change resolver math, does not change UI read paths, and must not be used by UI
code to compute `buyerAction`.

Risk: adding new transform values later requires a schema migration to widen the
constraint. That is intentional; a new semantic transform should be an explicit
decision-log event rather than an untracked string extension.
