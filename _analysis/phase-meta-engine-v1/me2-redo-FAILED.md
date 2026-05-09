# ME2 Redo Failed

Timestamp: 2026-05-08T18:49:57Z

## Summary

ME2-redo wired the requested high-priority production scenario emitters into the campaign/adset recommendation paths and confirmed they reach the snapshot job. The code now emits real `scenario_*` recommendation rows in production snapshots, not relabeled state rows. However, ME7 still fails because the new action volume is not enough to meet the action-density or engine/persona agreement gates.

## Implemented

- Added high-priority scenario emitters for the requested clusters:
  - C1 `scenario_c1_controlled_scale`
  - B1 `scenario_b1_capped_winner_bid_raise`
  - J1 `scenario_j1_stable_winner_protected`
  - A2 `scenario_a2_learning_weak_structural`
  - F1 `scenario_f1_roas_drop_diagnostic`
  - F4 `scenario_f4_stable_winner_drop_context`
  - E1 `scenario_e1_frequency_fatigue`
  - E2 `scenario_e2_ctr_decay_refresh`
  - E4 `scenario_e4_creative_age_refresh`
  - K1 `scenario_k1_mixed_config_rebuild`
  - I4 `scenario_i4_test_should_use_abo`
  - A1 `scenario_a1_math_floor_unmet`
- Wired campaign emitters into `buildMetaRecommendations`.
- Wired adset emitters into `buildMetaAdsetRecommendations`.
- Expanded recommendation caps so snapshot persistence can carry per-entity action rows rather than only top 8 campaign / top 5 adset rows.
- Added `scripts/_phase-meta-rnd-action-density-check.ts`.
- Added cluster persona consultations in `me2-redo-persona-consultations.md`.

## Validation Results

Snapshot date: 2026-05-08

| metric | observed | target | result |
| --- | ---: | ---: | --- |
| Campaign coverage | 103/101, capped 100% | >=80% | pass |
| Adset coverage | 184/177, capped 100% | >=80% | pass |
| Scenario fixture firing | 40/40 | 25+/32 | pass |
| Decision label coupling | 0 unknown labels; `scale_for_profitability = tune`; anomalies = diagnose | 0 mismatch | pass |
| Action density | 31/318 = 9.7% | >=30% | fail |
| Engine/persona disagreement | 400/1112 = 36.0% | <10% | fail |

Action rec types observed after rerun:

| rec_type | rows |
| --- | ---: |
| `adset_cut_spend` | 6 |
| `adset_scale_budget` | 6 |
| `scale_for_profitability` | 6 |
| `scenario_i4_test_should_use_abo` | 6 |
| `scenario_f4_stable_winner_drop_context` | 4 |
| `bid_strategy_fit` | 1 |
| `roas_drop_sudden` | 1 |
| `scenario_c1_controlled_scale` | 1 |

## Root Cause Hypothesis

The 12 requested scenario emitters are now wired, but available production signals do not support enough high-confidence action rows on TheSwaf + IwaStore. Frequency is missing from adset source rows, creative age is unavailable, recent edit/learning state is unavailable, and campaign calibration scopes are often sparse. As a result, the engine still correctly falls back to `campaign_state` / `adset_state` on most mature entities, while the prior persona audit expects more buyer judgment than the current structured signals can safely justify.

The next remediation should not relabel state rows. It should add or backfill the missing ME1 signal table fields (`learning_state`, `last_significant_edit_at`, `creative_age_days`, `freq_p80`, audience overlap, feed status) and then extend scenario production emitters to use those real signals. Without those signals, forcing action density above 30% would game the validation metric.

## Toolchain

- `npx vitest run lib/meta/scenario-emitters/high-priority.test.ts lib/meta/engine-v1/scenario-rec-factory.test.ts lib/meta/snapshot.test.ts lib/meta/scheduled.test.ts lib/meta/rec-label-mapping.test.ts`: pass.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run test`: pass, 380 files passed, 5 skipped; 2514 tests passed, 44 skipped.
- `npm run build`: pass.

## Stop

ME7 remains failed. ME8 was not started.
