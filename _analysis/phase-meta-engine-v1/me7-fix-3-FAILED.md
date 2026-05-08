# ME7 Fix 3 Failed — Structural Recommendation

Timestamp: 2026-05-08T15:58:24Z

## Result

The third corrective loop confirms ME7 remains blocked. ME8 must not start.

## Current Gate Status

| ME7 criterion | observed after fix loops | target | result |
| --- | ---: | ---: | --- |
| Campaign coverage | 103/101, capped 100% | >=80% | pass |
| Adset coverage | 184/177, capped 100% | >=80% | pass |
| Scenario fixture firing | 40/40 scenario rec types | 25+/32 | pass |
| Decision label coupling | 0 unknown labels; `scale_for_profitability = tune`; anomalies = diagnose | 0 mismatch | pass |
| Engine/persona disagreement | 37.1% | <10% | fail |

## Why This Cannot Be Safely Fixed As Another Hydration Patch

Fix 1 proved the campaign coverage failure was a snapshot completeness/idempotency problem and fixed it. Fix 2 proved scenario rec types can fire in validation fixtures and corrected extraction/label-coupling issues. The remaining failure is not a persistence, extraction, or UI coupling issue. It is a decision-core gap: coverage state rows now populate every mature entity, but many of those rows are `keep` while the persona audit expects actual decisions such as `scale`, `cut`, `diagnose`, `refresh`, or `rebuild`.

Changing state rows to mimic persona decisions would game the metric and violate the action-density protection established in ME1. The correct fix is to reopen ME2 decision-core work and implement production scenario emitters that convert high-confidence state-only entities into real action recommendations when account-history grounded trigger conditions exist.

## Structural Recommendation

Re-open ME2 as a focused decision-core remediation before retrying ME7:

1. Build production emitters for the highest-disagreement scenario clusters first: controlled scale, weak campaign cut/diagnose, creative fatigue/refresh, and structural rebuild.
2. Keep `campaign_state` / `adset_state` rows as coverage-only rows with low/watch confidence.
3. Add action-density-aware validation that reports state coverage separately from action agreement.
4. Re-run the 4-persona evaluation after real action rows exist, not by relabeling state rows.

## Stop Condition

The continuation prompt says if the third fix still fails, hard-stop E remains in force and the user should receive a structural recommendation. That condition is met.
