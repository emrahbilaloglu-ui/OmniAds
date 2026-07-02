# Phase 1 Outcome/Baseline Measurement Checkpoint

Generated: 2026-07-02T17:40:35.822Z
As-of date: 2026-07-02
Engine version: `v3-2026-07-02-math-guardrails`
Read-only: yes. DB mutation: no. Resolver/formula change: no.
Live status: attempted=true, source=live_db_read_only, tables=businesses, engine_v3_decision_snapshots_daily, engine_v3_decision_outcomes_daily, engine_v3_job_runs, meta_creative_daily, meta_campaign_labels.

## Verdict
Current-version persisted snapshot evidence is not ready yet. This is expected before the scheduled producer chain writes the new `ENGINE_VERSION`; do not claim outcome precision from this checkpoint.

## Business Readiness
| Business | Status | Snapshot day | Rows | Hard rows | Blocked evidence | Stale/unknown share | Spend covered | 7d outcomes | 14d outcomes | Reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| EMOLOS | snapshots_missing_for_current_version | - | 0 | 0 | 0 | - | 0.00 | 0 | 0 | no_current_engine_version_persisted_snapshots |
| Grandmix | snapshots_missing_for_current_version | - | 0 | 0 | 0 | - | 0.00 | 0 | 0 | no_current_engine_version_persisted_snapshots |
| IwaStore | snapshots_missing_for_current_version | - | 0 | 0 | 0 | - | 0.00 | 0 | 0 | no_current_engine_version_persisted_snapshots |
| TheSwaf | snapshots_missing_for_current_version | - | 0 | 0 | 0 | - | 0.00 | 0 | 0 | no_current_engine_version_persisted_snapshots |

## Campaign Label Spend Coverage
| Business | Window | Total spend | Labeled spend | Labeled share | Labeled campaigns | Note |
|---|---:|---:|---:|---:|---:|---|
| EMOLOS | 28d | 9,188.61 | 0.00 | 0.0% | 2/7 | - |
| Grandmix | 28d | 14,561.22 | 6,387.65 | 43.9% | 4/7 | - |
| IwaStore | 28d | 13,085.11 | 10,268.46 | 78.5% | 5/12 | - |
| TheSwaf | 28d | 67,096.44 | 54,829.99 | 81.7% | 8/18 | - |

## Persisted Label Baseline
| Business | Label | Rows | Spend | Spend share | Avg confidence | Stale rows | Unknown freshness rows | Stale/unknown share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | - | 0 | - | - | - | 0 | 0 | - |
| Grandmix | - | 0 | - | - | - | 0 | 0 | - |
| IwaStore | - | 0 | - | - | - | 0 | 0 | - |
| TheSwaf | - | 0 | - | - | - | 0 | 0 | - |

## Current-Version Outcome Windows
| Business | Window | Label | Eligible snapshots | Outcome rows | Known | Positive | Negative | Neutral | Unknown | Coverage |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| Grandmix | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| IwaStore | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| TheSwaf | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |

## All-Version Historical Outcome Context
Current version remains the measurement source of truth. This all-version panel is historical context only.
| Business | Window | Label | Eligible snapshots | Outcome rows | Known | Positive | Negative | Neutral | Unknown | Coverage |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - |
| Grandmix | 7 | cut | 7 | 7 | 1 | 0 | 1 | 0 | 6 | 100.0% |
| Grandmix | 7 | diagnose | 17 | 17 | 3 | 2 | 0 | 1 | 14 | 100.0% |
| Grandmix | 7 | keep | 6 | 6 | 3 | 1 | 0 | 2 | 3 | 100.0% |
| Grandmix | 7 | test_more | 92 | 92 | 26 | 17 | 0 | 9 | 66 | 100.0% |
| Grandmix | 14 | cut | 7 | 7 | 1 | 0 | 1 | 0 | 6 | 100.0% |
| Grandmix | 14 | diagnose | 17 | 17 | 3 | 2 | 0 | 1 | 14 | 100.0% |
| Grandmix | 14 | keep | 6 | 6 | 3 | 2 | 0 | 1 | 3 | 100.0% |
| Grandmix | 14 | test_more | 92 | 92 | 26 | 17 | 0 | 9 | 66 | 100.0% |
| IwaStore | 7 | cut | 6 | 6 | 2 | 2 | 0 | 0 | 4 | 100.0% |
| IwaStore | 7 | diagnose | 28 | 28 | 20 | 17 | 0 | 3 | 8 | 100.0% |
| IwaStore | 7 | keep | 32 | 32 | 14 | 8 | 0 | 6 | 18 | 100.0% |
| IwaStore | 7 | out_of_scope | 30 | 30 | 3 | 3 | 0 | 0 | 27 | 100.0% |
| IwaStore | 7 | scale | 3 | 3 | 3 | 2 | 1 | 0 | 0 | 100.0% |
| IwaStore | 7 | test_more | 627 | 627 | 87 | 78 | 0 | 9 | 540 | 100.0% |
| IwaStore | 14 | cut | 6 | 6 | 2 | 2 | 0 | 0 | 4 | 100.0% |
| IwaStore | 14 | diagnose | 28 | 28 | 23 | 19 | 0 | 4 | 5 | 100.0% |
| IwaStore | 14 | keep | 32 | 32 | 14 | 11 | 0 | 3 | 18 | 100.0% |
| IwaStore | 14 | out_of_scope | 30 | 30 | 3 | 3 | 0 | 0 | 27 | 100.0% |
| IwaStore | 14 | scale | 3 | 3 | 3 | 2 | 0 | 1 | 0 | 100.0% |
| IwaStore | 14 | test_more | 627 | 627 | 93 | 81 | 0 | 12 | 534 | 100.0% |
| TheSwaf | 7 | cut | 19 | 19 | 9 | 3 | 5 | 1 | 10 | 100.0% |
| TheSwaf | 7 | diagnose | 20 | 20 | 5 | 5 | 0 | 0 | 15 | 100.0% |
| TheSwaf | 7 | keep | 32 | 32 | 23 | 15 | 0 | 8 | 9 | 100.0% |
| TheSwaf | 7 | scale | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 100.0% |
| TheSwaf | 7 | test_more | 301 | 301 | 88 | 78 | 0 | 10 | 213 | 100.0% |
| TheSwaf | 14 | cut | 19 | 19 | 9 | 3 | 5 | 1 | 10 | 100.0% |
| TheSwaf | 14 | diagnose | 20 | 20 | 5 | 5 | 0 | 0 | 15 | 100.0% |
| TheSwaf | 14 | keep | 32 | 32 | 23 | 16 | 0 | 7 | 9 | 100.0% |
| TheSwaf | 14 | scale | 2 | 2 | 2 | 0 | 2 | 0 | 0 | 100.0% |
| TheSwaf | 14 | test_more | 301 | 301 | 89 | 85 | 0 | 4 | 212 | 100.0% |

## Classifier Version Distribution
| Business | Scope | Window | Classifier | Engine version | Rows | Unknown share |
|---|---|---:|---|---|---:|---:|
| EMOLOS | - | - | - | - | 0 | - |
| Grandmix | all_versions | 7 | creative-outcome-classifier.v1 | all | 122 | 73.0% |
| Grandmix | all_versions | 14 | creative-outcome-classifier.v1 | all | 122 | 73.0% |
| IwaStore | all_versions | 7 | creative-outcome-classifier.v1 | all | 726 | 82.2% |
| IwaStore | all_versions | 14 | creative-outcome-classifier.v1 | all | 726 | 81.0% |
| TheSwaf | all_versions | 7 | creative-outcome-classifier.v1 | all | 374 | 66.0% |
| TheSwaf | all_versions | 14 | creative-outcome-classifier.v1 | all | 374 | 65.8% |

## Backtest Segment Status
Uses `summarizeDecisionBacktestByLabelAndWeek`; pooled ECE is intentionally not reported because hard/non-hard polarity differs.
| Business | Current-version segments | All-version segments | Defensible all-version segments |
|---|---:|---:|---:|
| EMOLOS | 0 | 0 | 0 |
| Grandmix | 0 | 4 | 1 |
| IwaStore | 0 | 11 | 2 |
| TheSwaf | 0 | 9 | 2 |

## Confidence Buckets
| Business | Buckets | Stale share | Unknown freshness share | Computed at range |
|---|---|---:|---:|---|
| EMOLOS | 00_49: 0, 50_59: 0, 60_69: 0, 70_79: 0, 80_89: 0, 90_100: 0 | - | - | - -> - |
| Grandmix | 00_49: 0, 50_59: 0, 60_69: 0, 70_79: 0, 80_89: 0, 90_100: 0 | - | - | - -> - |
| IwaStore | 00_49: 0, 50_59: 0, 60_69: 0, 70_79: 0, 80_89: 0, 90_100: 0 | - | - | - -> - |
| TheSwaf | 00_49: 0, 50_59: 0, 60_69: 0, 70_79: 0, 80_89: 0, 90_100: 0 | - | - | - -> - |

## Provisional Replay Baseline
Source: `docs/creative-decision-center/generated/phase0-current-engine-simulation.json`. This section is distribution context only; it is not persisted outcome evidence.
| Business | Replay day | Rows | Labels | Hard rows | Blocked rows | Stale share |
|---|---:|---:|---|---:|---:|---:|
| EMOLOS | 2026-07-01 | 85 | test_more: 64, diagnose: 11, keep: 10 | 0 | 11 | 70.6% |
| Grandmix | 2026-07-01 | 82 | test_more: 61, diagnose: 13, keep: 7, cut: 1 | 1 | 1 | 21.9% |
| IwaStore | 2026-07-01 | 80 | test_more: 49, diagnose: 19, out_of_scope: 6, keep: 4, scale: 2 | 2 | 2 | 26.3% |
| TheSwaf | 2026-07-01 | 120 | test_more: 73, keep: 21, diagnose: 14, cut: 10, scale: 2 | 12 | 13 | 75.0% |

## Evidence Limits
- This report does not prove precision, recall, ECE, or causal correctness unless outcome rows are present and covered.
- Current-version rows are filtered by `ENGINE_VERSION`; older-version outcomes are deliberately excluded.
- `stale/unknown share` is based on persisted decision badges (`stale_evidence`, `unknown_freshness`) when snapshots exist.
- Historical/all-version outcome context is separated from current-version evidence and must not be used as current precision proof.
- Pooled ECE is not emitted here because the existing hard/non-hard realized-outcome polarity is not comparable across label classes.
- No resolver thresholds or buyer-action mappings were changed in this phase.
