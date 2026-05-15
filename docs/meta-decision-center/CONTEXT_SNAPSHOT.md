# Meta Decision Center Context Snapshot

Last updated: 2026-05-15
Owner: Codex/Claude collaborative planning context
Status: canonical local context document for the Meta + Creative decision-model workstream

## Purpose

This file preserves the current working context so future Codex/Claude sessions do
not lose the thread. Update this file after every material change in this
workstream: implementation PR, review fix, merge, deploy verification, manual DB
smoke, or plan revision.

When handing work to Claude or another AI session, explicitly provide this file
path and ask the model to read it before planning or changing code.

## Source Rules To Preserve

- Read `docs/creative-decision-center/START_HERE.md` before Creative Decision
  Center work.
- Before resolver changes, read:
  - `docs/creative-decision-center/DECISION_LOG.md`
  - `docs/creative-decision-center/DATA_READINESS.md`
  - `docs/creative-decision-center/GOLDEN_CASES.md`
  - `docs/creative-decision-center/INVARIANTS.md`
- UI must not compute buyer actions.
- Missing required data must produce `diagnose_data`, disabled action, or capped
  confidence.
- No high-confidence scale/cut on stale, missing, or weak benchmark/target data.
- Policy and delivery blockers override performance.
- Thresholds must be config-as-data, not scattered hard-coded resolver branches.
- Do not create a new standalone decision core unless the decision log receives a
  new ADR.

## Current Repo State

- Current implementation branch: `phase-c-meta-campaign-semantics`.
- Phase A PR: `#162` (`[codex] Unify Meta funnel cohort resolution`), merged.
- Phase A implementation commit: `fc8a8d7` (`Unify Meta funnel cohort resolution`).
- Phase A context commit: `2a49ef1` (`Record Phase A PR context`).
- Phase A merge commit on `main`: `49716c3706ec9ea98e0e452452163357b6cdeae0`.
- Phase B PR: `#163` (`[codex] Anchor Meta hard actions to commercial targets`),
  merged.
- Phase B implementation commit: `aaa0c0d`
  (`Anchor Meta hard actions to commercial targets`).
- Phase B review-fix commit: `7f18c81`
  (`Ignore fallback thresholds for Meta hard anchors`).
- Phase B merge commit on `main`: `cd7b72d629bf828cca9acdba34a666dbf2fd80b9`.
- Current `main` SHA verified locally:
  `cd7b72d629bf828cca9acdba34a666dbf2fd80b9`.
- Phase A tracked-file modifications at the time of this snapshot:
  - `lib/meta/campaign-lanes.ts`
  - `lib/meta/campaign-lanes.test.ts`
  - `lib/meta/creative-intelligence.ts`
  - `lib/meta/engine-v1/state-rows.ts`
  - `lib/meta/engine-v1/state-rows.test.ts`
  - `lib/meta/funnel-cohort.ts`
  - `lib/meta/funnel-cohort.test.ts`
  - `lib/meta/recommendations.ts`
  - `lib/meta/recommendations.test.ts`
- Phase A local artifacts:
  - `_analysis/phase-a-meta-decision-hygiene/2026-05-15-smoke-evidence.md`
  - `_analysis/phase-a-meta-decision-hygiene/2026-05-15-pr-triage.md`
- Context preservation file:
  - `docs/meta-decision-center/CONTEXT_SNAPSHOT.md`
- Untracked local artifacts exist and should not be deleted casually:
  - `.claude/`
  - `_analysis/db-normalization-cleanup-audit/`
  - `_analysis/phase-4-meta-archive/`
  - `_analysis/phase-a-meta-decision-hygiene/`
  - `_analysis/phase-meta-goal-aware/`
  - `_analysis/phase-meta-rnd/`
  - `docs/meta-decision-center/`
  - `scripts/_phase-meta-rnd-claude-personas.ts`
- Open PRs remaining after Phase B merge: none.
- Phase B tracked-file modifications at the time of this snapshot:
  - `app/api/meta/recommendations/route.ts`
  - `lib/meta/commercial-targets.ts`
  - `lib/meta/commercial-targets.test.ts`
  - `lib/meta/recommendations.ts`
  - `lib/meta/recommendations.test.ts`
  - `lib/meta/adset-decisions.ts`
  - `lib/meta/adset-decisions.test.ts`
  - `lib/meta/scenario-emitters/high-priority.ts`
  - `lib/meta/scenario-emitters/high-priority.test.ts`
  - `lib/meta/snapshot.ts`
  - `lib/meta/snapshot.test.ts`
- Phase C tracked-file modifications at the time of this snapshot:
  - `lib/migrations.ts`
  - `lib/migrations.test.ts`
  - `lib/meta/calibration.ts`
  - `lib/meta/calibration.test.ts`
  - `lib/meta/campaign-label-guard.ts`
  - `lib/meta/campaign-label-guard.test.ts`
  - `lib/meta/recommendations.ts`
  - `lib/meta/snapshot.ts`

## Completed Work

### Creative Decision Model

- Removed fixed `2.0` ROAS fallback logic.
- Added quality-only path when no target/benchmark exists.
- Kept missing target/benchmark from producing hard scale/cut decisions.
- Narrowed tracking/delivery/checkout diagnostics:
  - zero purchases alone no longer implies CAPI/tracking failure;
  - tracking suspicion requires funnel-step regression evidence;
  - checkout issue requires meaningful IC volume and degraded IC-to-purchase
    conversion;
  - delivery is treated as warning/context unless proof exists.
- Added Main/Test/Mixed campaign labeling substrate and UI.
- Added unlabeled hard-action guard.
- Added kind-aware Creative profile selection for Main/Test/Mixed where
  sufficient kind calibration exists.
- Added Test cohort `refresh -> cut` semantic transform and persisted
  `label_transform` snapshot diagnostics.

### Meta Campaign/Adset Model

- Added funnel cohort resolver foundation.
- Added purchase-cohort filtering and cohort chip/context.
- Added Out of Sales Scope lane so non-sales recommendations do not sit in the
  daily sales-action lane.
- Added ThruPlay, `view_content`, and `post_engagement` ingest into warehouse
  payload paths.
- Added cohort-segmented calibration rows for purchase, mid_funnel,
  upper_funnel, lead, traffic, and engagement cohorts.
- Added non-purchase adset emitter families:
  - mid_funnel M1-M4;
  - lead L1-L4;
  - traffic T1-T4;
  - engagement EG1-EG4.
- Added upper_funnel informational card instead of hard action cards.
- Added Meta-side campaign label substrate and snapshot hard-action guard.

### PR / Review / Deploy Closure

- Merged final Meta chain through current main SHA `0b79c222`.
- Merged Phase A through current main SHA `49716c3` via PR `#162`.
- Closed stale superseded PRs `#112`, `#114`, `#115`, `#116`, `#117`.
- Phase A triaged and closed old draft/review PRs `#80`, `#79`, `#77`, `#76`,
  `#75`, `#73`, `#58`, `#52`, `#48`, `#46`, and `#36` as stale historical
  Creative review/evidence artifacts. Triage evidence is saved at
  `_analysis/phase-a-meta-decision-hygiene/2026-05-15-pr-triage.md`.
- Verified local final stack during closure:
  - `npx vitest run lib/meta components/meta app/api/meta` passed with 108
    files and 935 tests.
  - `npx tsc --noEmit` passed.
  - `npm run lint` passed.
  - `npm run build` passed.
- GitHub main CI passed.
- Hetzner deploy passed.
- Post-deploy verification passed.

### Phase A - Hygiene, Evidence, And Single-Source Cleanup

- Branch: `phase-a-meta-decision-hygiene`.
- PR: `#162`, merged.
- Implementation commit: `fc8a8d7`.
- Context commit: `2a49ef1`.
- Merge commit: `49716c3`.
- A.1 single-source cleanup:
  - `lib/meta/recommendations.ts` no longer uses its local string-based
    campaign purchase filter.
  - Campaign purchase filtering now calls `resolveMetaFunnelCohort(...)` and
    `isPurchaseCohort(...)`.
  - `lib/meta/campaign-lanes.ts` no longer uses local purchase/value/traffic
    string matching for family classification.
  - `lib/meta/creative-intelligence.ts` now reuses campaign family
    classification instead of duplicating local string matching.
  - `lib/meta/engine-v1/state-rows.ts` now passes optimization goal, custom
    event, campaign objective, purchases, and revenue into the shared resolver
    instead of using a separate sales-objective string fallback.
  - `resolveMetaFunnelCohort(...)` now supports objective fallback and
    revenue-bearing fallback, but only after higher-quality metadata is absent.
  - Objective fallback covers sales, leads, traffic, awareness, and engagement
    objective families.
  - Important behavior: `customEventType` wins over `optimizationGoal`;
    `optimizationGoal` wins over campaign `objective`; purchase/revenue fallback
    is only allowed when event, goal, and objective are missing.
  - This preserves legacy metadata-missing purchase eligibility without letting
    `OUTCOME_SALES` or revenue override an explicit non-purchase optimization
    goal such as `LANDING_PAGE_VIEWS`.
- A.1 tests added/updated:
  - resolver objective fallback;
  - resolver revenue-bearing fallback;
  - `OFFSITE_CONVERSIONS` plus `PURCHASE` custom event stays purchase;
  - `PRODUCT_CATALOG_SALES` stays purchase;
  - `LANDING_PAGE_VIEWS` stays out of purchase recommendation window even with
    purchase/revenue metrics.
  - campaign family classification uses resolver output for LPV/catalog
    sales/metadata-missing cases;
  - entity state rows use objective fallback for missing adset goal fields.
- A.1 targeted regression passed:
  - `npx vitest run lib/meta/funnel-cohort.test.ts lib/meta/recommendations.test.ts lib/meta/campaign-lanes.test.ts lib/meta/engine-v1/state-rows.test.ts lib/meta/calibration.test.ts app/api/meta/lane-classify/route.test.ts`
  - Result: 6 test files, 105 tests passed.
- A.1 broader local verification passed:
  - `npx vitest run lib/meta components/meta app/api/meta`
  - Result: 108 test files, 941 tests passed.
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run build`
- A.2 read-only production smoke evidence is saved at
  `_analysis/phase-a-meta-decision-hygiene/2026-05-15-smoke-evidence.md`.
- A.2 key evidence:
  - Recent `meta_ad_daily` rows contain `thruplay_actions`, `view_content`, and
    `post_engagement` payload keys.
  - Recent calibration rows are purchase-only; no mid_funnel, lead, traffic,
    upper_funnel, or engagement calibration rows were observed in the 14-day
    smoke window.
  - Non-purchase adset cohorts exist in latest warehouse partitions, but spend
    volume is sparse and `unknown` remains large.
  - No live snapshot emission was observed for non-purchase emitter rec types or
    upper-funnel informational card recs.
  - `meta_entity_decision_signals_daily` is fresh, but
    `audience_overlap_pct` coverage is zero in the evidence window.
  - `meta_campaign_labels` production adoption is currently zero; label-guarded
    hard actions are expected to block until users label campaigns.

### Phase B - Target/Profit Anchor And Unified Purchase Maturity

- Branch: `phase-b-meta-profit-maturity`.
- PR: `#163`, merged.
- Implementation commit: `aaa0c0d`.
- Review-fix commit: `7f18c81`.
- Merge commit: `cd7b72d`.
- Added `lib/meta/commercial-targets.ts` as the shared Meta commercial target
  adapter.
- The adapter reads `business_target_packs` through
  `getBusinessCommercialTruthSnapshot(...)`, not inline SQL in API routes.
- PR review correction:
  - `coverage.thresholds` fallback values are not treated as configured Meta
    anchors.
  - Hard scale/cut anchors now come only from the actual target pack fields.
- Commercial target fields used by Meta:
  - `targetRoas`
  - `breakEvenRoas`
  - `targetCpa`
  - `breakEvenCpa`
  - `riskPosture`
- Purchase hard-action semantics now require configured commercial anchors:
  - campaign `scale_for_volume`;
  - campaign `scale_for_profitability`;
  - adset `adset_scale_budget`;
  - adset `adset_cut_spend`;
  - high-priority campaign `scenario_c1_controlled_scale`;
  - high-priority campaign `scenario_b1_capped_winner_bid_raise`;
  - high-priority campaign `scenario_a2_learning_weak_structural`.
- ROAS anchor behavior:
  - scale floor = `targetRoas`, or `breakEvenRoas * 1.15` when target ROAS is
    missing;
  - cut/loss ceiling = `breakEvenRoas`, or `targetRoas * 0.75` when break-even
    ROAS is missing;
  - account percentiles remain benchmark gates, not standalone profit targets.
- Purchase loss-budget maturity behavior:
  - maturity spend = `max(currency_floor, CPA_baseline * risk_multiplier)`;
  - CPA baseline priority = `breakEvenCpa`, then `targetCpa`, then calibrated or
    account CPA baseline;
  - risk multipliers: conservative `2.5`, balanced `2.0`, aggressive `1.5`;
  - currency floors currently: USD/EUR/default `50`, TRY `1500`.
- Live and snapshot recommendation paths now pass commercial targets into the
  campaign/adset decision builders.
- Explicit test coverage added:
  - no campaign hard scale/profitability action without commercial targets;
  - no purchase adset hard scale/cut without commercial targets;
  - no C1 controlled scale without commercial targets;
  - target helper normalization, scale/cut floors, and CPA loss-budget maturity.
  - `readMetaCommercialTargets(...)` ignores conservative fallback coverage
    thresholds when the target pack is absent.
- Phase B targeted verification passed:
  - `npx vitest run lib/meta/commercial-targets.test.ts lib/meta/recommendations.test.ts lib/meta/adset-decisions.test.ts lib/meta/scenario-emitters/high-priority.test.ts lib/meta/snapshot.test.ts app/api/meta/recommendations/route.test.ts`
  - Result after PR review fix: 6 test files, 88 tests passed.
  - `npx vitest run lib/meta components/meta app/api/meta`
  - Result after PR review fix: 109 test files, 948 tests passed.
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run build`
- Intentional Phase B boundary:
  - Non-purchase hard cut emitters still use cohort/event-cost maturity logic and
    are not forced through sales ROAS anchors in this PR.
  - This is deliberate. Lead, traffic, mid-funnel, and engagement actions need
    their own CPL/link-click/event-cost targets or D/E signal substrate before
    their hard actions can be made fully automation-ready.

### Phase C - Main/Test/Mixed Meta Semantics

- Branch: `phase-c-meta-campaign-semantics`.
- Added kind-aware compatibility to `meta_decision_calibration_daily`:
  - new `campaign_kind` dimension with values `all`, `main`, `test`, `mixed`;
  - default `all` preserves existing calibration behavior;
  - primary key and cohort-scope index include `campaign_kind`.
- Calibration reads now accept requested campaign kind:
  - requested `main`/`test`/`mixed` rows are preferred when present;
  - `all` rows remain the fallback.
- Snapshot recommendation context now passes campaign label kind into campaign
  and adset calibration scope reads.
- Added engine-only Test campaign transforms:
  - `refresh` semantics become `cut` for campaigns labeled `Test`;
  - `scale` semantics become payload type `promote_test_to_main`;
  - transforms write a `labelTransform` object into the recommendation payload,
    `signalQuality`, and `calibrationScope`.
- UI CTA mapping for `promote_test_to_main` is intentionally not enabled in
  this phase.
- Phase C targeted verification passed:
  - `npx vitest run lib/meta/calibration.test.ts lib/meta/campaign-label-guard.test.ts lib/migrations.test.ts lib/meta/snapshot.test.ts`
  - Result: 4 test files, 43 tests passed.
- Phase C broader verification passed:
  - `npx vitest run lib/meta components/meta app/api/meta`
  - Result: 109 test files, 952 tests passed.
  - `npx vitest run lib/migrations.test.ts`
  - Result: 1 test file, 8 tests passed.
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run build`

## Important Caveats

- The warehouse metric additions are forward-looking. There was no historical
  backfill in the completed work.
- Upper-funnel and non-purchase cohort percentiles may need 14-28 days of fresh
  post-merge data before they become useful.
- Production manual SQL smoke for the latest Meta chain is now recorded in
  `_analysis/phase-a-meta-decision-hygiene/2026-05-15-smoke-evidence.md`.
  The smoke found current production gaps rather than full readiness:
  non-purchase calibration and snapshot emission are not visible yet, and label
  adoption is zero.
- `meta_entity_decision_signals_daily` has a local backfill/read path:
  `lib/meta/entity-signals-backfill.ts` writes it and
  `runMetaSnapshotForBusiness` invokes the backfill before snapshot
  recommendations. The remaining uncertainty is production evidence: verify
  that the daily job actually writes fresh rows before relying on learning
  state, overlap, or similar signals.
- `meta_campaign_labels` adoption is unknown; unlabeled entities are expected to
  block hard actions, but product visibility/telemetry still needs review.

## Remaining Gaps To Plan

1. Meta target/profit anchor enforcement:
   - `target_roas` and `break_even_roas` are not yet hard anchors for Meta scale
     or cut decisions.
   - Account percentiles still behave too much like action thresholds.

2. Unified Meta maturity:
   - There is no single formula such as:
     `spend >= max(currency_floor, CPA_baseline * multiplier) + event floor +
     attribution window + active days + recovery gate`.
   - Maturity needs to reflect loss budget, not the spend behavior of scaled
     incumbent campaigns.

3. Main/Test kind-aware Meta calibration and thresholds:
   - Creative has kind-aware profile selection.
   - Meta campaign/adset scenario thresholds do not yet segment Main/Test/Mixed
     calibration.

4. Budget pacing, audience overlap, and placement mix gates:
   - Monthly budget vs MTD pace is not a real decision input.
   - Audience overlap and placement mix are not populated/used as hard gates.

5. Empirical confidence, backtest, and auto-execute tier:
   - Confidence is still heuristic.
   - There is no per-scenario precision/recall or 14d/30d outcome correlation.
   - Auto-execute readiness cannot be claimed without this layer.

6. Purchase scenario coverage:
   - Many scenario-library IDs remain unimplemented, especially learning,
     cooldown, bid-strategy, tracking-diagnostic, overlap, seasonal, and
     controlled-scale variants.

7. Single-source campaign cohort resolution cleanup:
   - Phase A removed the known campaign-level string-based purchase filter in
     `lib/meta/recommendations.ts`.
   - Keep this item as a regression watch: future campaign/adset filters should
     use `resolveMetaFunnelCohort(...)` rather than local string matching.

8. Purchase-side C1 and related scenario refactor:
   - Controlled scale still lacks enough profit anchor, ROAS trend, learning
     state, and variance awareness.

9. Meta-side refresh/cut semantics and Test-to-Main promotion:
   - Creative Test `refresh -> cut` semantics exist.
   - Meta recommendation semantics do not yet have equivalent kind-aware
     transform.
   - `promote_test_to_main` remains intentionally unimplemented.

## Proposed Gap-Closure Plan

Status: user-approved as of 2026-05-15. Phase A and Phase B are merged. Phase C
is in implementation on `phase-c-meta-campaign-semantics`.

Claude was explicitly told to read this file first before producing its plan.
Claude agreed with the final phase order and added three acceptance criteria:
record explicit signal-coverage SQL evidence, split Meta Test promotion into
engine semantics and UI binding sub-phases, and make D-dependent E scenario
families explicit dependencies.

Important correction from Codex review: `meta_entity_decision_signals_daily`
does have local backfill code. Phase D is not "build ETL from scratch"; it is
first live freshness/coverage verification, then gap-fix/populate/extend work
where coverage is weak.

### Phase A - Hygiene, Evidence, And Single-Source Cleanup

- A.1 Fix campaign-level purchase cohort cleanup so remaining string-based
  filters use the shared funnel cohort resolver. Status: implemented locally.
- A.2 Capture production smoke evidence before behavior changes:
  warehouse funnel metrics, calibration rows by cohort, real non-purchase
  emitters, upper-funnel card population, label coverage, and
  `meta_entity_decision_signals_daily` freshness/coverage. Status: completed
  locally and saved under `_analysis/phase-a-meta-decision-hygiene/`.
- A.3 Triage remaining old draft/review PRs and close/archive only after their
  information value is checked. Status: completed; stale PRs closed.
- Acceptance: context file updated, evidence saved under `_analysis/`, targeted
  tests green, and no hard-action behavior changes mixed into the cleanup PR.
  Status: complete. PR `#162` passed GitHub `typecheck`, `test`, and `build`
  checks, then merged into `main` at `49716c3`.

### Phase B - Target/Profit Anchor And Unified Maturity

- Make `target_roas` and `break_even_roas` real hard-action anchors for Meta
  scale/cut decisions. Account percentiles remain benchmark/reference, not
  profit targets.
- Add a unified maturity helper based on loss budget:
  `spend >= max(currency_floor, CPA_baseline * multiplier)` plus event floor,
  attribution/active-day checks, and recent recovery gate.
- Remove absolute/fixed hard-cut spend assumptions where they bypass account
  economics.
- Acceptance: no hard scale/cut without a target/profit anchor and mature loss
  evidence; docs and golden cases updated.
  Status: complete. PR `#163` passed GitHub `typecheck`, `test`, and `build`
  checks after the review fix, then merged into `main` at `cd7b72d`.

### Phase C - Main/Test/Mixed Meta Semantics

- C.1 Add kind-aware calibration storage/read compatibility in a small migration
  PR with default `all` behavior preserved.
- C.2 Wire scenario threshold reads to kind-aware profiles only after the schema
  path is stable.
- C.3a Add engine-only Meta Test semantics: `refresh -> cut` transform
  diagnostic, `labelTransform`, golden cases, and `promote_test_to_main`
  recommendation type in payload only.
- C.3b Add UI CTA/label mapping for `promote_test_to_main` only after label
  coverage and kind-aware distribution stability gates are met. Do not show a
  broken CTA just because the action type exists.
- Acceptance: UI still does not compute buyer actions; hard actions remain
  guarded by labels, anchors, maturity, and data freshness.
  Status: local implementation and full local verification are complete.
  PR, CI/review, and merge remain.

### Phase D - Signal Substrate, Pacing, Overlap, And Placement Gates

- First verify `meta_entity_decision_signals_daily` row freshness and signal
  coverage in production.
- If coverage is weak, treat D as populate/gap-fix work, not just reader
  extension.
- Extend signal read/write/backfill coverage for currently schema-only or
  underused signals: audience overlap, placement mix, monthly budget vs MTD
  pacing, learning/edit cooldown, and tracking/feed diagnostics where data
  supports them.
- Acceptance: missing signals produce unsupported/diagnose/watch, not hard
  actions.

### Phase E - Purchase Scenario Families

- Implement remaining purchase-side scenario families only after B/C/D
  prerequisites are satisfied.
- D-dependent families must wait for D:
  - learning/cooldown A3/A4/A5 require D.1;
  - audience/placement D1/D2/D3/D5 require D.3;
  - cross-campaign I1/I2/I3/I5 require D.3.
- Less D-dependent families can proceed after B+C: profit/bid/controlled scale,
  tracking/catalog/seasonal where their required data exists.
- Keep scenario PRs small: maximum 2-3 related scenarios per PR unless there is
  a strong reason.
- Acceptance: every scenario has fixtures, golden cases, invariant coverage,
  missing-signal fallback, and no hard action without anchors/maturity.

### Phase F - Empirical Confidence And Automation Readiness

- Replace or cap heuristic confidence with per-scenario outcome tracking:
  precision/recall, 14d/30d post-action outcomes, and high/medium/low bands.
- Separate UI confidence from auto-execute eligibility.
- Do not claim auto-execute readiness until target anchors, maturity, freshness,
  labels, and empirical scenario precision pass.
- Acceptance: automation tier is evidence-backed and scenario-specific.

### Phase G - Final Regression, Deploy, Context, And Golden-Case Maintenance

- Run the full verification stack: focused tests, `npx vitest run`, `npx tsc
  --noEmit`, `npm run lint`, `npm run build`, GitHub CI, deploy, and
  post-deploy smoke.
- Update this context file after each phase/PR.
- Maintain docs, not just tests: prune obsolete fixtures, expand
  `GOLDEN_CASES.md`, and mirror Meta Test/labelTransform invariants into the
  appropriate Meta Decision Center docs.
- Acceptance: no phase is considered complete until code, tests, review, CI,
  deploy evidence, post-deploy evidence, and this context file are current.

## Update Protocol

After every material change:

1. Add the branch/PR/commit/SHA.
2. Move completed items from "Remaining Gaps" to "Completed Work".
3. Record tests and exact verification commands.
4. Record GitHub review, CI, merge, deploy, and post-deploy status.
5. Record any manual DB/UI smoke evidence separately from code/test evidence.
6. Keep unknowns explicit. Do not convert assumptions into completed status.
7. If Claude is involved, tell Claude this file is the canonical context anchor.
