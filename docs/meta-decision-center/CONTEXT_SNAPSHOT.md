# Meta Decision Center Context Snapshot

Last updated: 2026-05-16
Owner: Codex/Claude collaborative planning context
Status: canonical local context document for the Meta + Creative decision-model workstream

## Purpose

This file preserves the current working context so future Codex/Claude sessions do
not lose the thread. Update this file after every material change in this
workstream: implementation PR, review fix, merge, deploy verification, manual DB
smoke, or plan revision.

When handing work to Claude or another AI session, explicitly provide this file
path and ask the model to read it before planning or changing code.

For Meta Decision Center work, start at
`docs/meta-decision-center/START_HERE.md`. It points back here as the canonical
context anchor and then to the Meta decisions, data-readiness matrix,
invariants, golden cases, and Phase G closeout record.

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

- Current implementation branch:
  `main`, after Phase F.4 merge and deploy closure.
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
- Phase C PR: `#164` (`[codex] Add Meta campaign kind semantics`), merged.
- Phase C implementation commit: `4f6cc32`
  (`Add Meta campaign kind semantics`).
- Phase C merge commit on `main`: `82f7f76279ea400300ffa551045564b52bc96751`.
- Phase D PR: `#165` (`[codex] Ground Meta decision signal diagnostics`),
  merged.
- Phase D implementation commit: `78b521a`
  (`Ground Meta decision signal diagnostics`).
- Phase D merge commit on `main`: `c218f48a7fb089322f4961c0169ca052bcb19f16`.
- Phase E.1 PR: `#166` (`[codex] Add Meta learning sample scenarios`),
  merged.
- Phase E.1 implementation commit: `a958eff`
  (`Add Meta learning sample scenarios`).
- Phase E.1 review-fix commit: `237bbe8`
  (`Require learning exit evidence for Meta A5`).
- Phase E.1 merge commit on `main`: `fe9de23b3734db9f7d82a6af1cad67899205e3cd`.
- Phase E.2 PR: `#167` (`[codex] Add Meta bid regime scenarios`), merged.
- Phase E.2 implementation commit: `2d07ac0`
  (`Add Meta bid regime scenarios`).
- Phase E.2 review-fix commit: `521810d`
  (`Tighten Meta bid scenario gates`).
- Phase E.2 merge commit on `main`: `9b01d42c206912ddca0a0975cbc5c0a3e9d5af22`.
- Phase E.3 PR: `#168`
  (`[codex] Add Meta optimization and feed scenarios`), merged.
- Phase E.3 implementation commit: `39f11ec`
  (`Add Meta optimization and feed scenarios`).
- Phase E.3 review-fix commits:
  - `f4adb4a` (`Tighten Meta optimization event scenario gates`)
  - `9934b94` (`Require explicit purchase event for Meta G1`)
  - `1d4f91a` (`Harden Meta feed status diagnostics`)
- Phase E.3 merge commit on `main`: `4ca36bcb9bf8f8aaba357ee8e11e881fdd7c1a1d`.
- Phase E.4 PR: `#169`
  (`[codex] Add Meta purchase downshift scenario`), merged.
- Phase E.4 implementation commit: `0b49e13`
  (`Add Meta purchase downshift scenario`).
- Phase E.4 review-fix commit: `db79421`
  (`Reach Meta purchase downshift in recommendations`).
- Phase E.4 merge commit on `main`: `bb2736e260aca8d2a1dae45a1fd685c646659240`.
- Phase F.1 PR: `#170`
  (`[codex] Add Meta automation readiness substrate`), merged.
- Phase F.1 implementation commit: `329b28b`
  (`Add Meta automation readiness substrate`).
- Phase F.1 review-fix commit: `5194f9b`
  (`Require preflight proof for Meta auto readiness`).
- Phase F.1 branch-context commit: `92541c3`
  (`Record Phase F readiness review fix`).
- Phase F.1 merge commit on `main`: `fe95969d34d3398bb827b5c3430791dda740fbf3`.
- Phase F.2 PR: `#171`
  (`[codex] Add Meta decision outcome log storage`), merged.
- Phase F.2 implementation commit: `bbf9cc4`
  (`Add Meta decision outcome log storage`).
- Phase F.2 merge commit on `main`: `fce250858fa3a675d0b1671b38439fb84eac6f48`.
- Phase F.3 PR: `#172`
  (`[codex] Add Meta empirical outcome summaries`), merged.
- Phase F.3 implementation commit: `fd36f53c`
  (`Add Meta empirical outcome summaries`).
- Phase F.3 review-fix commits:
  - `a1287bb4` (`Require judged Meta outcome sample floor`)
  - `63aaaaf9` (`Use judged Meta outcomes for negative rate`)
  - `40efb29f` (`Ignore non-outcome Meta decision logs`)
  - `cbca3cd7` (`Require explicit Meta outcome action logs`)
  - `b99db07e` (`Read persisted Meta outcome status fields`)
- Phase F.3 merge commit on `main`: `f59564bed53280980ec5e1cf3bbba58786cd38cb`.
- Phase F.3 context commit on `main`: `0e6f1048`
  (`Record Phase F empirical summary merge context`).
- Phase F.4 PR: `#173`
  (`[codex] Attach Meta empirical outcome summaries`), merged.
- Phase F.4 implementation commit: `a8313fed`
  (`Attach Meta empirical outcome summaries`).
- Phase F.4 merge commit on `main`: `5d48acf644441fda15bc361510b75b9ad424c68a`.
- Phase F.4 post-merge context commit on `main`: `64793f81`
  (`Record Phase F empirical integration merge context`).
- Phase F.4 deploy-trigger commit on `main`: `fe1a9f8a`
  (`Document optional Meta outcome evidence`).
- Latest `main` verified and deployed after Phase F.4 merge:
  `fe1a9f8aedb971d66e669888a907d7d2fcbd7940`
  (`Document optional Meta outcome evidence`).
- Phase E.1 branch started from `main` context commit:
  `c5617d99822312923b2b9a5fd13239826a76db24`.
- Phase E.2 branch started after Phase E.1 merge/context:
  `phase-e-meta-bid-regime-scenarios`.
- Phase E.3 branch started after Phase E.2 merge/context:
  `phase-e-meta-optimization-feed-scenarios`.
- Phase E.4 branch started after Phase E.3 merge/context:
  `phase-e-meta-purchase-downshift-scenario`.
- Phase F.1 branch started after Phase E.4 merge/context:
  `phase-f-meta-automation-readiness-substrate`.
- Phase F.2 branch started after Phase F.1 merge/context:
  `phase-f-meta-decision-outcome-logs`.
- Phase F.3 branch started after Phase F.2 merge/context:
  `phase-f-meta-empirical-outcome-summary`.
- Phase F.4 branch started after Phase F.3 merge/context:
  `phase-f-meta-empirical-readiness-integration`.
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
- Phase D local artifacts:
  - `_analysis/phase-d-meta-signal-substrate/2026-05-15-signal-coverage.md`
- Context preservation file:
  - `docs/meta-decision-center/CONTEXT_SNAPSHOT.md`
- Phase G Meta docs:
  - `docs/meta-decision-center/START_HERE.md`
  - `docs/meta-decision-center/DECISION_LOG.md`
  - `docs/meta-decision-center/DATA_READINESS.md`
  - `docs/meta-decision-center/INVARIANTS.md`
  - `docs/meta-decision-center/GOLDEN_CASES.md`
  - `docs/meta-decision-center/PHASE_G_CLOSEOUT.md`
- Phase G local artifacts:
  - `_analysis/phase-g-meta-closeout/2026-05-16-fixture-prune-audit.md`
- Untracked local artifacts exist and should not be deleted casually:
  - `.claude/`
  - `_analysis/db-normalization-cleanup-audit/`
  - `_analysis/phase-4-meta-archive/`
  - `_analysis/phase-meta-goal-aware/`
  - `_analysis/phase-meta-rnd/`
  - `scripts/_phase-meta-rnd-claude-personas.ts`
- Open PRs currently known in this workstream after Phase F.4 merge: none.
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
- Phase D evidence status:
  - Live signal table is fresh through `2026-05-15`.
  - Latest signal coverage: 5,258 rows across 12 businesses, 2,071 campaign
    rows, 3,187 adset rows, 1,483 ready rows, and 3,775 partial rows.
  - Existing populated fields are mostly learning/edit/age/frequency/CTR-decay:
    `learning_state` 5,258, `days_since_significant_edit` 2,819,
    `creative_age_days_max` 2,668, `frequency_p80` 225, `ctr_decay_pct` 74.
  - Schema-only or currently unpopulated fields: audience overlap/size/stage,
    lookalike, feed status/disapproval, dedup/CRM ratio, and
    `tracking_quality_status`.
  - Implementation implication: Phase D is gap-fix/populate/reader work, not a
    reader-only change. Do not produce hard actions from unsupported audience,
    feed, or tracking assumptions.
- Phase D tracked-file modifications at the time of this snapshot:
  - `_analysis/phase-d-meta-signal-substrate/2026-05-15-signal-coverage.md`
  - `docs/meta-decision-center/CONTEXT_SNAPSHOT.md`
  - `lib/meta/entity-signals.ts`
  - `lib/meta/entity-signals-backfill.ts`
  - `lib/meta/entity-signals-backfill.test.ts`
  - `lib/meta/scenario-emitters/high-priority.ts`
  - `lib/meta/scenario-emitters/high-priority.test.ts`
  - `lib/meta/adset-decisions.ts`
  - `lib/meta/adset-decisions.test.ts`
  - `lib/meta/snapshot.test.ts`
- Phase D implementation status:
  - Signal reader/upsert now carries schema-backed diagnostics:
    audience overlap/size/stage, lookalike pct, feed status/disapproval,
    dedup rate, Meta-to-CRM ratio, and `tracking_quality_status`.
  - Backfill now writes supported diagnostic evidence:
    click-to-LPV tracking quality from `meta_ad_daily`, monthly MTD pacing from
    daily/lifetime budget and spend, and account-level placement mix evidence
    from `meta_breakdown_daily`.
  - Unsupported fields remain explicit: audience overlap and feed/catalog status
    are not inferred without a warehouse source.
  - Campaign high-priority scenarios now emit watch/diagnose blockers for recent
    edit cooldown, click-to-LPV tracking risk, and overpaced monthly budget
    before hard scale/cut/rebuild actions.
  - Adset hard purchase scale/cut is blocked when adset signals show recent edit
    cooldown, click-to-LPV tracking risk, or overpaced monthly budget.
- Phase D local verification so far:
  - `npx vitest run lib/meta/entity-signals-backfill.test.ts lib/meta/scenario-emitters/high-priority.test.ts lib/meta/adset-decisions.test.ts lib/meta/snapshot.test.ts`
    passed: 4 files, 68 tests.
  - `npx vitest run lib/meta components/meta app/api/meta` passed: 109 files,
    961 tests.
  - `npx tsc --noEmit` passed.
  - `npx vitest run` passed: 408 files passed, 4 skipped; 2,913 tests passed,
    49 skipped.
  - `npm run lint` passed.
  - `npm run build` passed.
  - GitHub PR `#165` checks passed: `typecheck`, `test`, and `build`.
  - GitHub review context checked with thread-aware read: no review threads,
    no reviews, and no conversation comments.
- Phase E.1 implementation status:
  - Branch: `phase-e-meta-learning-scenarios`.
  - Scope intentionally limited to learning/sample guard family:
    `scenario_a3_learning_on_pace_wait`,
    `scenario_a5_post_learning_underperformer`, and
    `scenario_c3_scale_sample_gate`.
  - PR review fix: A5 now requires learning-exit/post-learning maturity
    evidence (`learning_exit_at` in `sourceJson` or `days_at_learning_state`)
    before producing a cut/action recommendation.
  - `scenario_a4_learning_limited_persistent` is intentionally not included
    because it requires entity-scoped audience size/overlap, which Phase D
    confirmed is not populated.
  - Local verification so far:
    - `npx vitest run lib/meta/scenario-emitters/high-priority.test.ts lib/meta/recommendations.test.ts lib/meta/adset-decisions.test.ts`
      passed after review fix: 3 files, 80 tests.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 109
      files, 968 tests.
    - `npx tsc --noEmit` passed.
    - `npx vitest run` passed: 408 files passed, 4 skipped; 2,919 tests
      passed, 49 skipped.
    - `npm run lint` passed.
    - `npm run build` passed.
    - GitHub PR `#166` checks passed after review fix: `typecheck`,
      `test`, and `build`.
    - GitHub thread-aware review check: P1 A5 learning-exit thread resolved;
      no remaining unresolved review threads at merge.
- Phase E.2 implementation status:
  - Branch: `phase-e-meta-bid-regime-scenarios`.
  - Scope intentionally limited to bid-regime scenarios with existing reliable
    fields: `scenario_b4_min_roas_loosen` and
    `scenario_b6_profit_first_bid_cap_keep`.
  - PR review fixes:
    - B4 now requires a readable Meta ROAS target before recommending a target
      loosen.
    - B6 now requires under-delivery (`budget_utilization < 95%`) so it cannot
      hide a full-delivery C1 controlled-scale candidate.
  - `scenario_b3_bid_cap_underperforming` and
    `scenario_b5_lowest_cost_volatility_switch` are intentionally deferred
    because required auction-loss and daily-volatility signals are not yet
    reliable enough for hard/tune recommendations.
  - Local verification so far:
    - `npx vitest run lib/meta/scenario-emitters/high-priority.test.ts lib/meta/recommendations.test.ts`
      passed after PR review fixes: 2 files, 75 tests.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 109
      files, 974 tests after PR review fixes.
    - `npx tsc --noEmit` passed after PR review fixes.
    - `npx vitest run` passed: 408 files passed, 4 skipped; 2,924 tests
      passed, 49 skipped before PR review fixes.
    - `npx vitest run` passed after PR review fixes: 408 files passed, 4
      skipped; 2,926 tests passed, 49 skipped.
    - `npm run lint` passed after PR review fixes.
    - `npm run build` passed after PR review fixes.
    - GitHub PR `#167` checks passed after review fixes: `typecheck`,
      `test`, and `build`; runtime deploy jobs skipped because no runtime image
      change was detected.
    - GitHub thread-aware review check: P1 B6 controlled-scale suppression
      thread and P2 B4 missing-target thread resolved; no remaining unresolved
      review threads at merge.
- Phase E.3 implementation status:
  - Branch: `phase-e-meta-optimization-feed-scenarios`.
  - PR: `#168`, merged.
  - Implementation commit: `39f11ec`.
  - Review-fix commits: `f4adb4a`, `9934b94`, and `1d4f91a`.
  - Merge commit: `4ca36bcb`.
  - Scope intentionally limited to scenarios with reliable present or explicitly
    populated signals:
    `scenario_g1_upper_funnel_event` and
    `scenario_k4_catalog_feed_first`.
  - G1 emits only for purchase-optimized campaigns that are at least 7 days old,
    have weak recent purchase signal, and have a stronger same-campaign
    pre-purchase event signal. It is a `test`/`switch` recommendation, not a
    cut.
  - K4 emits only when explicit feed/catalog issue evidence exists
    (`feedStatus`, `feedDisapprovalCount`, or `sourceJson.feed_status`). It does
    not infer feed problems from zero purchases or poor ROAS.
  - G1/G2 optimization-event switch recommendations are now treated as
    label-guarded hard actions when campaign Main/Test/Mixed context is missing.
  - PR review fixes:
    - G1 now requires the actual optimization event/custom event to be purchase
      optimized; a Sales objective alone is not enough.
    - G1 no longer treats generic `OFFSITE_CONVERSIONS` as purchase optimized
      unless purchase custom-event evidence is present.
    - G1 now requires explicit `age_days` evidence from the signal table instead
      of inferring age from the presence of a 7-day aggregate window.
    - K4 feed-status matching now treats negated/healthy statuses such as
      `no_issues` and `not_limited` as non-problematic.
  - Local verification so far:
    - `npx vitest run lib/meta/scenario-emitters/high-priority.test.ts lib/meta/campaign-label-guard.test.ts lib/meta/rec-label-mapping.test.ts`
      passed after PR review fixes: 3 files, 89 tests.
    - `npx tsc --noEmit` passed after PR review fixes.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 109
      files, 987 tests after PR review fixes.
    - `npx vitest run` passed before PR review fixes: 408 files passed, 4
      skipped; 2,935 tests passed, 49 skipped.
    - `npx vitest run` passed after PR review fixes: 408 files passed, 4
      skipped; 2,939 tests passed, 49 skipped.
    - `npm run lint` passed after PR review fixes.
    - `npm run build` passed after PR review fixes.
    - GitHub PR `#168` checks passed after review fixes: `typecheck`,
      `test`, and `build`; runtime deploy jobs skipped because no runtime image
      change was detected.
    - GitHub thread-aware review check: P2 G1 optimization-event thread, P2 G1
      explicit-age thread, P2 G1 purchase-event thread, and P2 K4 negated
      feed-status thread resolved; no remaining unresolved review threads at
      merge.
- Phase E.4 implementation status:
  - Branch: `phase-e-meta-purchase-downshift-scenario`.
  - PR: `#169`, merged.
  - Implementation commit: `0b49e13`.
  - Review-fix commit: `db79421`.
  - Merge commit: `bb2736e2`.
  - Scope intentionally limited to `scenario_g2_downshift_to_purchase`.
  - G2 emits only when a campaign is explicitly optimized to a supported
    pre-purchase event (`INITIATE_CHECKOUT`, `ADD_TO_CART`, `VIEW_CONTENT`, or
    `LANDING_PAGE_VIEWS`), has explicit `purchases_7d` evidence, has enough
    recent purchase sample, and clears both calibrated account ROAS p50 and the
    configured commercial ROAS floor.
  - G2 does not emit for purchase-optimized campaigns, generic
    `OFFSITE_CONVERSIONS` without custom-event evidence, missing recent purchase
    evidence, recent edit cooldown, tracking-quality issue, or missing
    commercial target anchors.
  - The G2 scenario scope is `any` because the source cohort can be
    mid/upper/traffic even though the target event is purchase.
  - PR review fix:
    - G2 now runs through the real `buildMetaRecommendations(...)` path before
      the purchase-only recommendation window filter, so explicit pre-purchase
      campaigns are not dropped before the G2 emitter can evaluate them.
    - The production-path test keeps ordinary add-to-cart campaigns with no
      explicit `purchases_7d` signal at zero recommendations, while allowing G2
      when that signal and commercial target evidence exist.
  - Local verification so far:
    - `npx vitest run lib/meta/scenario-emitters/high-priority.test.ts lib/meta/campaign-label-guard.test.ts lib/meta/rec-label-mapping.test.ts lib/meta/engine-v1/scenarios.test.ts`
      passed: 4 files, 98 tests.
    - `npx tsc --noEmit` passed.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 109
      files, 994 tests.
    - `npx vitest run` passed: 408 files passed, 4 skipped; 2,946 tests
      passed, 49 skipped.
    - `npm run lint` passed.
    - `npm run build` passed.
    - After PR review fix,
      `npx vitest run lib/meta/recommendations.test.ts lib/meta/scenario-emitters/high-priority.test.ts lib/meta/campaign-label-guard.test.ts lib/meta/rec-label-mapping.test.ts lib/meta/engine-v1/scenarios.test.ts`
      passed: 5 files, 126 tests.
    - After PR review fix, `npx tsc --noEmit` passed.
    - After PR review fix, `npx vitest run lib/meta components/meta app/api/meta`
      passed: 109 files, 995 tests.
    - After PR review fix, `npx vitest run` passed: 408 files passed, 4
      skipped; 2,947 tests passed, 49 skipped.
    - After PR review fix, `npm run lint` passed.
    - After PR review fix, `npm run build` passed.
    - GitHub PR `#169` checks passed after review fix: `typecheck`, `test`,
      and `build`; runtime deploy jobs skipped because no runtime image change
      was detected.
    - GitHub thread-aware review check: P2 G2 production-reachability thread
      resolved; no remaining unresolved review threads at merge.

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

- Merged final runtime-affecting Meta chain through SHA `fe1a9f8a`; Phase G
  docs-only closeout commits are recorded in the Phase G section below.
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

### Phase G - Final Regression, Deploy, Context, And Golden-Case Maintenance

- Added Meta-specific canonical documentation:
  - `docs/meta-decision-center/START_HERE.md`
  - `docs/meta-decision-center/DECISION_LOG.md`
  - `docs/meta-decision-center/DATA_READINESS.md`
  - `docs/meta-decision-center/INVARIANTS.md`
  - `docs/meta-decision-center/GOLDEN_CASES.md`
  - `docs/meta-decision-center/PHASE_G_CLOSEOUT.md`
- Recorded fixture prune evidence at
  `_analysis/phase-g-meta-closeout/2026-05-16-fixture-prune-audit.md`.
- Phase G explicitly defers unsupported scenario-library families to Phase H or
  later when source signals are not reliable enough for safe hard actions.
- Phase G does not change runtime behavior. It closes documentation,
  verification, deploy-evidence, and context-preservation requirements for the
  implemented A-F.4 chain.

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
- PR: `#164`, merged.
- Implementation commit: `4f6cc32`.
- Merge commit: `82f7f76`.
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

1. Empirical confidence, backtest, and auto-execute tier:
   - Phase F.1 is complete and merged in PR `#170`.
   - Phase F.2 is complete and merged in PR `#171`.
   - Phase F.3 is complete and merged in PR `#172`.
   - Phase F.4 is complete and merged in PR `#173`.
   - Phase F.4 deploy closure is complete on SHA `fe1a9f8a`.
   - Visible confidence is still heuristic; F.4 intentionally does not change
     confidence scores.
   - There is no per-scenario precision/recall or 14d/30d outcome correlation.
   - Auto-execute readiness still cannot be claimed from production traffic.
     F.4 attaches empirical summaries to snapshot/live recommendation payloads,
     but the current implementation intentionally keeps candidates below
     auto-execute unless empirical outcome evidence, live preflight, and
     rollback proof are all explicitly present.

2. Purchase scenario coverage:
   - Phase E.1, E.2, E.3, and E.4 implemented the learning/sample, bid-regime,
     optimization/feed, and purchase-downshift subsets that current data can
     support.
   - Remaining scenario-library IDs are still unimplemented, especially
     audience/overlap, placement, cross-campaign, seasonal, and deeper
     controlled-scale variants.
   - Phase G decision: these remaining IDs are deferred to Phase H or later
     unless their required signals become populated and testable. They are not
     hidden Phase G blockers because forcing hard actions without data would
     violate the signal and automation invariants.

3. Signal coverage gaps that still block additional scenario families:
   - Audience overlap, audience size/stage, lookalike, and entity-scoped
     feed/catalog source coverage remain weak or unsupported.
   - Monthly pacing, click-to-LPV tracking quality, and account-level placement
     evidence exist, but placement and overlap still need stronger entity-level
     decision gates before hard automation.

4. Single-source campaign cohort resolution cleanup:
   - Phase A removed the known campaign-level string-based purchase filter in
     `lib/meta/recommendations.ts`.
   - Keep this item as a regression watch: future campaign/adset filters should
     use `resolveMetaFunnelCohort(...)` rather than local string matching.

5. Purchase-side C1 and related scenario refactor:
   - Controlled scale is anchored more safely after Phases B/D/E.1/E.2, but it
     still lacks enough ROAS trend, volatility, placement, and post-action
     outcome awareness for auto-execute.
   - Phase G decision: deeper C1 automation/refactor remains Phase H or later.

6. Meta-side refresh/cut semantics and Test-to-Main promotion:
   - Creative Test `refresh -> cut` semantics exist.
   - Meta engine has label transforms and `promote_test_to_main` payload support,
     but the UI CTA mapping remains intentionally disabled until label coverage
     and kind-aware distribution stability are proven.

## Proposed Gap-Closure Plan

Status: user-approved as of 2026-05-15. Phase A, Phase B, Phase C, Phase D,
Phase E.1, Phase E.2, Phase E.3, Phase E.4, Phase F.1, Phase F.2, Phase F.3,
and Phase F.4 are merged.

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
  Status: complete. PR `#164` passed GitHub `typecheck`, `test`, and `build`
  checks, then merged into `main` at `82f7f76`.

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
  Status: complete. PR `#165` passed GitHub `typecheck`, `test`, and `build`
  checks, then merged into `main` at `c218f48`. Implemented typed signal
  transport, click-to-LPV tracking quality, monthly pacing, account-level
  placement evidence, and hard-action blockers. Audience overlap and
  feed/catalog diagnostics remain explicit unsupported states until an
  entity-scoped source exists.

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
  Status: Phase E.1, E.2, E.3, and E.4 complete.
  - Phase E.1 PR `#166` passed GitHub `typecheck`, `test`, and `build` after
    the A5 learning-exit review fix, then merged into `main` at `fe9de23`.
  - Phase E.2 PR `#167` passed GitHub `typecheck`, `test`, and `build` after
    the B4/B6 review fixes, then merged into `main` at `9b01d42`.
  - Phase E.3 PR `#168` passed GitHub `typecheck`, `test`, and `build` after
    the G1/K4 review fixes, then merged into `main` at `4ca36bcb`.
  - Phase E.4 PR `#169` passed GitHub `typecheck`, `test`, and `build` after
    the G2 production-reachability review fix, then merged into `main` at
    `bb2736e2`.
  - Remaining Phase E work should focus only on scenario families whose required
    signals are present or can be explicitly populated; unsupported overlap/feed
    assumptions must keep producing diagnose/watch, not hard actions.

### Phase F - Empirical Confidence And Automation Readiness

- Replace or cap heuristic confidence with per-scenario outcome tracking:
  precision/recall, 14d/30d post-action outcomes, and high/medium/low bands.
- Separate UI confidence from auto-execute eligibility.
- Do not claim auto-execute readiness until target anchors, maturity, freshness,
  labels, and empirical scenario precision pass.
- Acceptance: automation tier is evidence-backed and scenario-specific.
- Phase F.1 complete:
  - Branch: `phase-f-meta-automation-readiness-substrate`.
  - PR: `#170` (`[codex] Add Meta automation readiness substrate`).
  - Implementation commit: `329b28b`
    (`Add Meta automation readiness substrate`).
  - Review-fix commit: `5194f9b`
    (`Require preflight proof for Meta auto readiness`).
  - Added a conservative `meta-automation-readiness.v1` payload layer for Meta
    recommendations.
  - Current auto-execute eligibility remains false unless a future empirical
    outcome model is explicitly available.
  - Label-guarded recommendations are recomputed as read-only automation
    blockers, so missing Main/Test/Mixed context cannot leak into automation
    candidates.
  - UI displays backend-provided readiness only; it does not compute buyer
    actions.
  - Local verification so far:
    - `npx vitest run lib/meta/automation-readiness.test.ts lib/meta/campaign-label-guard.test.ts lib/meta/adset-decisions.test.ts components/meta/redesign/MetaActionCard.test.tsx`
      passed: 4 files, 31 tests.
    - `npx vitest run lib/meta/automation-readiness.test.ts lib/meta/campaign-label-guard.test.ts components/meta/redesign/MetaActionCard.test.tsx`
      passed after the helper cleanup: 3 files, 20 tests.
    - `npx tsc --noEmit` passed.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 110
      files, 1000 tests.
    - `npx vitest run` passed: 409 files passed, 4 skipped; 2952 tests
      passed, 49 skipped.
    - `npm run lint` passed.
    - `npm run build` passed.
    - `git diff --check` passed.
    - After PR review fix `5194f9b`:
      `npx vitest run lib/meta/automation-readiness.test.ts lib/meta/campaign-label-guard.test.ts components/meta/redesign/MetaActionCard.test.tsx`
      passed: 3 files, 22 tests; `npx tsc --noEmit` passed;
      `npx vitest run lib/meta components/meta app/api/meta` passed: 110
      files, 1002 tests; `npx vitest run` passed: 409 files passed, 4
      skipped, 2954 tests passed, 49 skipped; `npm run lint` passed;
      `npm run build` passed.
  - GitHub PR `#170` checks passed on implementation commit `329b28b`:
    `typecheck`, `test`, and `build`; runtime deploy jobs skipped because no
    runtime image change was detected.
  - GitHub PR `#170` checks passed again on final branch commit `92541c3`:
    `typecheck`, `test`, and `build`; runtime deploy jobs skipped because no
    runtime image change was detected.
  - GitHub thread-aware review check on implementation commit `329b28b` found
    one P1 review thread: auto-execute could become eligible if empirical
    outcomes were enabled without live preflight or rollback proof. Fixed in
    `5194f9b` by making live preflight and rollback explicit blockers/missing
    evidence for auto readiness. Thread
    `PRRT_kwDORfeVes6Cftw0` was resolved after the fix.
  - Merged to `main` at `fe95969d`.
  - CI runtime deploy jobs were skipped by the workflow; no production
    post-deploy smoke was performed for this phase.
- Phase F.2 complete:
  - Branch: `phase-f-meta-decision-outcome-logs`.
  - Scope is intentionally additive: create/read/write storage for
    `meta_decision_action_outcome_logs`, but do not yet change confidence
    scores or auto-execute eligibility.
  - Added migration shape for canonical business/provider refs,
    recommendation fingerprint, rec metadata, action type, outcome status,
    payload JSON, and occurred timestamp.
  - Added `lib/meta/decision-outcomes.ts` storage helpers:
    `appendMetaDecisionActionOutcomeLog(...)` and
    `readMetaDecisionActionOutcomeLogs(...)`.
  - Local verification so far:
    - `npx vitest run lib/meta/decision-outcomes.test.ts lib/migrations.meta-decision-outcomes.test.ts`
      passed: 2 files, 3 tests.
    - `npx tsc --noEmit` passed.
    - `npx vitest run lib/meta lib/migrations.test.ts lib/migrations.meta-decision-outcomes.test.ts`
      passed: 72 files, 788 tests.
    - `npx vitest run` passed: 411 files passed, 4 skipped; 2957 tests
      passed, 49 skipped.
    - `npm run lint` passed.
    - `npm run build` passed.
  - GitHub PR `#171` checks passed: `typecheck`, `test`, and `build`;
    runtime deploy jobs skipped because no runtime image change was detected.
  - GitHub thread-aware review check: no review threads, reviews, or
    conversation comments.
  - Merged to `main` at `fce25085`.
  - CI runtime deploy jobs were skipped by the workflow; no production
    post-deploy smoke was performed for this phase.
- Phase F.3 complete:
  - Branch: `phase-f-meta-empirical-outcome-summary`.
  - PR: `#172` (`[codex] Add Meta empirical outcome summaries`).
  - Implementation commit: `fd36f53c`
    (`Add Meta empirical outcome summaries`).
  - Review-fix commits:
    - `a1287bb4` (`Require judged Meta outcome sample floor`)
    - `63aaaaf9` (`Use judged Meta outcomes for negative rate`)
    - `40efb29f` (`Ignore non-outcome Meta decision logs`)
    - `cbca3cd7` (`Require explicit Meta outcome action logs`)
    - `b99db07e` (`Read persisted Meta outcome status fields`)
  - Scope remained conservative: add empirical outcome summarization and wire it
    as an optional automation-readiness gate, but do not yet fetch summaries in
    production recommendation builders or change visible confidence scores.
  - Added `lib/meta/empirical-outcomes.ts` to classify outcome statuses and
    summarize sample size, judged sample, positive/negative/neutral/unknown
    counts, precision, negative rate, confidence band, and auto-eligible status.
  - Extended `deriveMetaAutomationReadiness(...)` so a high empirical summary
    can satisfy the empirical gate only when live preflight and rollback proof
    are also present; insufficient sample and weak precision become explicit
    blockers.
  - PR review hardened the empirical gate:
    - Sample floor now applies to judged positive/negative outcomes, not total
      raw rows.
    - Negative-rate denominator now uses judged outcomes, so unknown/pending
      rows cannot dilute loss risk.
    - Summary rows must be explicit `actionType`/`action_type: "outcome"`;
      preflight, execute, rollback, operator-response, and missing-action rows
      are ignored.
    - Persisted snake_case DB rows are supported through `action_type` and
      `outcome_status`.
  - Local verification:
    - `npx vitest run lib/meta/empirical-outcomes.test.ts lib/meta/automation-readiness.test.ts`
      passed after the final review fix: 2 files, 15 tests.
    - `npx tsc --noEmit` passed.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 112
      files, 1013 tests.
    - `npx vitest run` passed: 412 files passed, 4 skipped; 2963 tests
      passed before review fixes; after final review fix it passed with 2966
      tests passed and 49 skipped.
    - `npm run lint` passed.
    - `npm run build` passed.
    - `git diff --check` passed.
  - GitHub PR `#172` checks passed on final commit `b99db07e`: `typecheck`,
    `test`, and `build`; runtime deploy jobs skipped because no runtime image
    change was detected.
  - GitHub thread-aware review check found four empirical-summary review
    threads across the branch. All were fixed and resolved:
    `PRRT_kwDORfeVes6Cf5AE`, `PRRT_kwDORfeVes6Cf9ey`,
    `PRRT_kwDORfeVes6CgAFE`, and `PRRT_kwDORfeVes6CgB_V`.
  - Merged to `main` at `f59564be`.
  - CI runtime deploy jobs were skipped by the workflow; no production
    post-deploy smoke was performed for this phase.
- Phase F.4 complete:
  - Branch: `phase-f-meta-empirical-readiness-integration`.
  - PR: `#173` (`[codex] Attach Meta empirical outcome summaries`).
  - Implementation commit: `a8313fed`
    (`Attach Meta empirical outcome summaries`).
  - Scope is conservative production-path integration: read persisted
    `meta_decision_action_outcome_logs` outcome rows by recommendation type and
    decision label, summarize them with the Phase F.3 empirical model, and
    attach the summary to snapshot/live recommendation payloads.
  - The integration does not change visible confidence scores and does not make
    auto-execute eligible by itself. High empirical summaries only remove the
    empirical-model blocker; live preflight and rollback proof remain required.
  - Added a bulk outcome-log reader for recommendation types, a pure
    recommendation enrichment helper, and a defensive integration wrapper that
    returns unchanged recommendations if outcome-log storage is unavailable.
  - Snapshot generation, persisted snapshot read, and live debug
    recommendations now attempt empirical enrichment after label guards.
  - Local verification so far:
    - `npx vitest run lib/meta/empirical-outcomes.test.ts lib/meta/empirical-outcome-integration.test.ts lib/meta/decision-outcomes.test.ts lib/meta/automation-readiness.test.ts`
      passed: 4 files, 21 tests.
    - `npx tsc --noEmit` passed.
    - `npx vitest run lib/meta components/meta app/api/meta` passed: 113
      files, 1017 tests.
    - `npx vitest run` passed: 413 files passed, 4 skipped; 2970 tests
      passed, 49 skipped.
    - `npm run lint` passed.
    - `npm run build` passed.
    - `git diff --check` passed.
  - GitHub PR `#173` checks passed: `typecheck`, `test`, and `build`; runtime
    deploy jobs skipped because no runtime image change was detected.
  - GitHub thread-aware review check: no review threads, reviews, or
    conversation comments.
  - Merged to `main` at `5d48acf6`.
  - Immediate PR CI runtime deploy jobs were skipped by the workflow because the
    merge itself did not publish a new runtime image.
  - Post-merge context commit `64793f81` was docs-only. A manual deploy attempt
    for that SHA failed at `Prepare runtime images` because no GHCR image
    existed for the docs-only SHA.
  - Runtime deploy was then triggered intentionally by the behavior-neutral
    runtime commit `fe1a9f8a` (`Document optional Meta outcome evidence`).
  - Push CI run `25947123898` succeeded for `fe1a9f8a`: `typecheck`, `test`,
    runtime-change detection, `publish-worker-image`, `publish-web-image`, and
    `dispatch-deploy` all passed.
  - Hetzner deploy workflow run `25947244447` succeeded for
    `fe1a9f8aedb971d66e669888a907d7d2fcbd7940`; deploy job steps through
    runtime image preparation, migrations, web/worker recreation, local runtime
    readiness, public build propagation, public ingress smoke, and post-deploy
    verification dispatch all passed.
  - Post-deploy verification workflow run `25947265036` succeeded for
    `fe1a9f8aedb971d66e669888a907d7d2fcbd7940`.
  - Live public build-info verification for provider scope `meta` returned:
    `buildId=fe1a9f8aedb971d66e669888a907d7d2fcbd7940`,
    `nodeEnv=production`, `deployGate=pass`, `releaseGate=pass`,
    `missingExact=[]`, `runtimeRegistry.contractValid=true`,
    `web.healthState=healthy`, `worker.healthState=healthy`, and
    `repairPlan.eligible=true`.

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
- Status: documentation closeout is now covered by:
  - `docs/meta-decision-center/START_HERE.md`
  - `docs/meta-decision-center/DECISION_LOG.md`
  - `docs/meta-decision-center/DATA_READINESS.md`
  - `docs/meta-decision-center/INVARIANTS.md`
  - `docs/meta-decision-center/GOLDEN_CASES.md`
  - `docs/meta-decision-center/PHASE_G_CLOSEOUT.md`
- Obsolete fixture audit:
  `_analysis/phase-g-meta-closeout/2026-05-16-fixture-prune-audit.md` records
  that no current Creative/Meta fixture should be deleted in Phase G. Existing
  tests still protect active kind-aware, label-transform, scenario, empirical,
  and automation-readiness contracts.
- Phase G local verification after documentation closeout:
  - `npx vitest run lib/meta/empirical-outcomes.test.ts lib/meta/empirical-outcome-integration.test.ts lib/meta/decision-outcomes.test.ts lib/meta/automation-readiness.test.ts`
    passed: 4 files, 21 tests.
  - `npx tsc --noEmit` passed.
  - `npx vitest run lib/meta components/meta app/api/meta` passed: 113 files,
    1017 tests.
  - `npx vitest run` passed: 413 files passed, 4 skipped; 2970 tests passed,
    49 skipped.
  - `npm run lint` passed.
  - `npm run build` passed.
  - `git diff --check` passed.
- Claude read-only recheck after documentation closeout returned no blockers:
  "Phase G complete for implemented A-F.4 scope"; remaining items are
  Phase H/product-scope limitations.
- Phase G docs closeout commit `ceda07e3` (`Complete Meta Phase G
  documentation closeout`) was pushed to `main`.
- GitHub CI run `25947833866` for `ceda07e3` succeeded:
  `detect-runtime-changes`, `typecheck`, and `test` passed; `build`,
  `publish-web-image`, `publish-worker-image`, and `dispatch-deploy` were
  skipped because the commit was docs-only; `skip-runtime-deploy` passed.
- Live public build-info verification after `ceda07e3` confirmed runtime still
  serving the last runtime commit:
  `buildId=fe1a9f8aedb971d66e669888a907d7d2fcbd7940`,
  `nodeEnv=production`, `deployGate=pass`, `releaseGate=pass`,
  `missingExact=[]`, `runtimeRegistry.contractValid=true`,
  `web.healthState=healthy`, `worker.healthState=healthy`,
  `providerScope=meta`, and `repairPlan.eligible=true`.
- Phase G scope note: this closeout confirms implemented A-F.4 behavior,
  verification, deploy evidence, and documentation hygiene. It does not claim
  unsupported scenario families are automation-ready; those remain explicit
  post-closeout product limitations until their signals exist.

## Update Protocol

After every material change:

1. Add the branch/PR/commit/SHA.
2. Move completed items from "Remaining Gaps" to "Completed Work".
3. Record tests and exact verification commands.
4. Record GitHub review, CI, merge, deploy, and post-deploy status.
5. Record any manual DB/UI smoke evidence separately from code/test evidence.
6. Keep unknowns explicit. Do not convert assumptions into completed status.
7. If Claude is involved, tell Claude this file is the canonical context anchor.
