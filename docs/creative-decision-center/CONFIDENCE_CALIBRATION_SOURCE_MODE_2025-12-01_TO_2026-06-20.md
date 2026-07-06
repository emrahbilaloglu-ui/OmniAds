# Confidence Calibration By Source Mode - 2025-12-01 to 2026-06-20

Generated at: 2026-07-05T22:31:52.214Z
Engine version: `v3-2026-07-02-math-guardrails`
Outcome classifier: `creative-outcome-classifier.v2`
Decision window: 2025-12-01 -> 2026-06-20
Outcome evaluation ceiling: 2026-07-05

## Boundary

Read-only: yes. This report reads persisted current-version decision snapshots and Meta daily facts through the DB tunnel; it does not run provider writes, DB writes, migrations, resolver changes, or cron endpoints.

This is snapshot-backed calibration, not a fresh formula replay for every historical date. If a historical day has no current-version snapshot, it is absent from this report. Source mode is derived from the snapshot lifecycle row link.

## Coverage

| Business | First decision date | Latest decision date | Closed daily rows | Episodes | Known | Unknown | Labels | Source modes |
|---|---:|---:|---:|---:|---:|---:|---|---|

## Calibration Cells

Positive polarity is explicit: for hard labels, positive means the hard action proxy was supported; for non-hard labels, positive means a missed hard-action opportunity proxy. Do not pool those polarities.

| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|

## Evidence Limits

- Current-version snapshot coverage controls the sample; absent historical snapshot days are not inferred.
- Episode dedup follows the same shape as prior replay: new label run plus fresh spend after the prior episode.
- Confidence gaps are descriptive calibration smoke tests, not causal proof.
- Hard and non-hard positive polarity is never pooled.
- Target history is not reconstructed; snapshots carry their stored effective target ROAS.
