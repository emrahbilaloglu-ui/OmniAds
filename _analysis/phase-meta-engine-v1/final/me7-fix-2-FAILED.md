# ME7 Fix 2 Failed

Timestamp: 2026-05-08T15:56:48Z

## Result

Fix 2 corrected the remaining label-coupling issue in the R&D extraction path and added scenario firing fixtures, but ME7 still fails on engine/persona disagreement. ME8 remains blocked.

## What Passed After Fix 2

Coverage:

| level | covered entities | mature denominator | coverage | gate |
| --- | ---: | ---: | ---: | --- |
| campaign | 103 | 101 | 100% capped | pass |
| adset | 184 | 177 | 100% capped | pass |

Scenario firing:

| criterion | observed | target | result |
| --- | ---: | ---: | --- |
| scenario-library rec types firing in fixtures | 40/40 | 25+/32 | pass |

Decision label coupling:

- Extraction now reads backend-owned `decision_label` from `meta_decision_snapshots_daily`.
- `scale_for_profitability` extracts as `tune`, not the old buggy `scale`.
- Anomaly rows now persist `decision_label = diagnose`.
- Unknown labels in refreshed extraction: `0`.

## What Failed

Engine/persona disagreement remains above the ME7 threshold:

| criterion | observed | target | result |
| --- | ---: | ---: | --- |
| engine/persona disagreement | 37.1% | <10% | fail |

Comparison method: refreshed extraction rows were joined to the existing Codex persona audit by `entity_level + entity_id`; all 278 entities had engine output and all had persona rows available. Total comparisons: 1112. Disagreements: 412.

Representative examples:

- `TEST — EMB - CreativeTest - Apr2026`: engine `keep`; personas include `scale`, `diagnose`, `refresh`, `rebuild`.
- `EMB - TargetOthers - CC - Apr2026`: engine `keep`; Marcus/Lin-style outputs include `scale`.
- `EMB - NonTarget - CC - Apr2026`: engine `diagnose`; persona output includes `cut`.

## Next Hypothesis

The remaining issue is not snapshot persistence or label extraction. It is the decision-core action contract: `campaign_state` / `adset_state` rows solved entity coverage, but they also reveal that the engine still emits too many coverage-only `keep` rows where personas expect scale, cut, diagnose, refresh, or rebuild. Fix 3 should not add more state rows. It should either add real scenario/action emission for the high-disagreement patterns or declare the ME7 gate structurally failed and reopen ME2 decision-core work.
