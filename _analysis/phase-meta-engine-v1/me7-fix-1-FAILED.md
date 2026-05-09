# ME7 Fix 1 Failed

Timestamp: 2026-05-08T15:44:25Z

## Result

Fix 1 corrected the campaign/adset coverage asymmetry, but ME7 still fails on the scenario firing gate. ME8 must remain blocked.

## What Passed After Fix 1

Snapshot date: 2026-05-08

| level | covered entities | mature denominator | coverage | gate |
| --- | ---: | ---: | ---: | --- |
| campaign | 103 | 101 | 100% capped | pass |
| adset | 184 | 177 | 100% capped | pass |

Decision label coupling check:

- `scale_for_profitability` rows were present.
- All observed rows carried `decision_label = tune`.
- The known wrong `scale` label did not recur in this slice.

## What Failed

Scenario firing remains below the ME7 target:

| criterion | observed | target | result |
| --- | ---: | ---: | --- |
| previously unfired scenarios firing | 0/32 | 25+/32 | fail |

Production rows for TheSwaf + IwaStore on 2026-05-08 fired legacy/core rec types (`campaign_state`, `adset_state`, `bid_strategy_fit`, `bid_value_guidance`, `scale_for_profitability`, `campaign_structure`, `adset_cut_spend`, `adset_scale_budget`, anomalies) but no `scenario_%` rec types.

## Next Hypothesis

The remaining failure is deeper than campaign state-row hydration. ME2 registered scenario IDs A1-K4 and label mappings, but the scenario registry is not connected to production recommendation emission with trigger fixtures. Fix 2 should focus on a scenario-emission harness that proves at least 25 of the previously unfired scenarios can produce concrete rec rows under fixture inputs, then wire high-confidence production-safe scenario outputs where required signals exist.
