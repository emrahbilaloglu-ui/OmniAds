# Confidence Calibration / Source-Mode Summary - 2026-07-06

Generated from read-only DB/replay artifacts. No provider writes, DB writes, migrations, resolver changes, UI changes, or cron posts were made.

## Decision

No production confidence-threshold or formula change is supported by this phase.

The June replay produced enough evidence to inspect soft-label calibration, but not enough evidence to validate hard-action confidence. All 80 business-days in the replay used `runtime_sql_fallback`, so this does not compare fallback vs lifecycle-informed production behavior.

## Inputs

- Snapshot-backed current-version query: `docs/creative-decision-center/CONFIDENCE_CALIBRATION_SOURCE_MODE_2025-12-01_TO_2026-06-20.md`
- Formula replay JSON: `docs/creative-decision-center/generated/confidence-calibration-source-mode-replay-2026-06-01-to-2026-06-20.json`
- Formula replay report: `docs/creative-decision-center/CONFIDENCE_CALIBRATION_SOURCE_MODE_REPLAY_2026-06-01_TO_2026-06-20.md`

## Coverage

The snapshot-backed Dec-Jun route returned zero rows for `v3-2026-07-02-math-guardrails`. That means persisted current-version snapshots cannot be used as a full historical calibration source for Dec-Jun.

The formula replay route covered June 1-20, 2026 with a July 5, 2026 evaluation ceiling:

- Decision rows: 9,571
- Unique business+creative pairs: 644
- Episode-deduped outcome rows: 1,622
- Known episodes: 923
- Unknown episodes: 699
- Source-mode days: `runtime_sql_fallback: 80`
- Failed days: 0 across EMOLOS, Grandmix, IwaStore, and TheSwaf

## Defensible Cells

All n>=30 defensible cells are non-hard labels, so their positive polarity means `non_hard_missed_hard_action_proxy`, not hard-action precision.

Important calibration caveat: the `Gap` column below is not a confidence
miscalibration estimate for non-hard labels. For non-hard rows, observed
positive means a missed-hard-action proxy, while confidence is the engine's
decision confidence. Those are different quantities. The gap is kept only as a
directional table diagnostic. Positive means observed proxy rate is above
average confidence; negative means it is below average confidence.

| Business | Window | Label | Bucket | Known | Positive | Observed positive | Avg confidence | Gap | Meaning |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|
| EMOLOS | 7d | test_more | 70_79 | 97 | 95 | 97.9% | 75.0% | 22.9 pp | missed hard-action proxy |
| EMOLOS | 14d | test_more | 70_79 | 97 | 95 | 97.9% | 75.0% | 22.9 pp | missed hard-action proxy |
| Grandmix | 7d | test_more | 70_79 | 37 | 27 | 73.0% | 75.0% | -2.0 pp | missed hard-action proxy |
| Grandmix | 14d | test_more | 70_79 | 37 | 27 | 73.0% | 75.0% | -2.0 pp | missed hard-action proxy |
| IwaStore | 14d | test_more | 70_79 | 30 | 29 | 96.7% | 74.8% | 21.8 pp | missed hard-action proxy |
| TheSwaf | 7d | test_more | 70_79 | 108 | 93 | 86.1% | 74.9% | 11.3 pp | missed hard-action proxy |
| TheSwaf | 14d | test_more | 70_79 | 109 | 94 | 86.2% | 74.9% | 11.4 pp | missed hard-action proxy |
| TheSwaf | 7d | keep | 70_79 | 30 | 25 | 83.3% | 75.0% | 8.3 pp | missed hard-action proxy |
| TheSwaf | 14d | keep | 70_79 | 30 | 23 | 76.7% | 75.0% | 1.7 pp | missed hard-action proxy |

## Hard-Action Cells

Hard-action cells do not reach the n>=30 defensible threshold.

- TheSwaf `cut` is only directional: 7d known 13, positive 10, observed 76.9% vs 75.0% average confidence; 14d known 13, positive 9, observed 69.2% vs 75.0%.
- EMOLOS `cut` has known 6 and is insufficient despite 6/6 positive.
- Grandmix `cut` and `scale` are insufficient and noisy.
- IwaStore `scale` and `cut` are insufficient and noisy.

The TheSwaf directional `cut` cell sits on both sides of the stated 75%
confidence level across 7d and 14d windows. That is not proof of calibration
with n=13, but it also is not evidence of a gross hard-action miscalibration.
Hard-action calibration remains unmeasured by this phase.

## Interpretation

The main signal is not "confidence is globally calibrated." The main signal is that many 70-79 confidence non-hard decisions, especially `test_more`, later fall into the missed-hard-action proxy bucket. That suggests conservative behavior in the fallback replay, but it does not justify immediately loosening hard-action thresholds because:

- all evidence is fallback-mode, not lifecycle-informed current-version production mode;
- non-hard positive polarity is a missed-opportunity proxy, not a precision win;
- hard-action validation never reaches n>=30;
- forward outcomes remain non-causal because real operator/platform spend decisions shaped the future data.

The primary path to close the hard-action calibration gap is live
current-version accrual with lifecycle-aware snapshots and outcomes. A secondary
path is an off-hours full Dec-Jun formula replay batch, but that would still be
fallback-mode evidence and should not override lifecycle-informed production
accrual.

Next phase should be a golden-case/spec package, not a resolver change.
