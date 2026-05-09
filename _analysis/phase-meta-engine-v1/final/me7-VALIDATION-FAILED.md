# ME7 Validation Failed

Timestamp: 2026-05-08T14:53:45Z

## Result

ME7 hard-stopped on the production coverage gate. The engine is not ready for ME8 cleanup because campaign coverage is far below the required 80% threshold.

## Coverage Evidence

Snapshot date: 2026-05-08

Businesses:

- TheSwaf: `172d0ab8-495b-4679-a4c6-ffa404c389d3`
- IwaStore: `f8a3b5ac-588c-462f-8702-11cd24ff3cd2`

R&D maturity denominators from `_analysis/phase-meta-rnd/00-raw-campaigns.csv` and `_analysis/phase-meta-rnd/00-raw-adsets.csv`:

| level | TheSwaf | IwaStore | total |
| --- | ---: | ---: | ---: |
| campaign | 48 | 53 | 101 |
| adset | 94 | 83 | 177 |

Production snapshot rows for the same businesses and snapshot date:

| scope_type | rec_type | kind | distinct entities | rows |
| --- | --- | --- | ---: | ---: |
| campaign | `roas_drop_sudden` | `anomaly` | 1 | 1 |
| adset | `entity_state` | `recommendation` | 184 | 184 |
| adset | `adset_cut_spend` | `recommendation` | 3 | 3 |
| adset | `adset_scale_budget` | `recommendation` | 3 | 3 |

Coverage against the ME7 gate:

| level | covered entities | mature denominator | coverage | gate |
| --- | ---: | ---: | ---: | --- |
| campaign | 1 | 101 | 1.0% | fail |
| adset | 184 | 177 | 100% capped | pass on entity coverage |

Action density protection:

| metric | value |
| --- | ---: |
| persisted eligible rows | 191 |
| non-state recommendation/anomaly rows | 7 |
| action density | 3.7% |

## Other ME7 Checks

- Decision label coupling: no `scale_for_profitability` rows were present in today's TheSwaf/IwaStore production snapshot, so the known mismatch was not reproduced in this validation slice.
- Scenario firing: production rows fired only `roas_drop_sudden`, `adset_cut_spend`, `adset_scale_budget`, and `entity_state` on this snapshot slice. This does not demonstrate the target of 25+/32 previously unfired scenarios firing through fixtures or production-triggered rows.
- Engine vs persona disagreement: not run because the coverage gate failed first. Running persona reconciliation against 1 covered campaign would not be a valid ME7 quality measurement.

## Hard-Stop Rationale

The continuation prompt defines ME7 as the overall gate and requires a stop if engine coverage is below 80% on either campaigns or adsets. Campaign coverage is 1.0%, so ME7 cannot self-pass and ME8 cleanup must not begin.

## Recommended Next Step

Loop back to the decision-core/snapshot path before ME7 retry. The specific defect appears to be campaign snapshot emission: adset `entity_state` rows are being persisted, but mature campaigns are not receiving equivalent state/action rows except one anomaly. Fix campaign state-row hydration and campaign scenario emission, rerun the snapshot job, then restart ME7 validation.
