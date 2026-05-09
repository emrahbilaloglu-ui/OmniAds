# Meta Engine v1 ME1 Coverage Baseline

Run date: 2026-05-08
Source files:

- `_analysis/phase-meta-rnd/00-raw-campaigns.csv`
- `_analysis/phase-meta-rnd/00-raw-adsets.csv`
- `_analysis/phase-meta-rnd/00-extraction-notes.md`
- `_analysis/phase-meta-rnd/04-synthesis.md`

## Baseline Eligible Entity Filter

The R&D extraction maturity filter is the ME1 baseline:

```text
eligible if age_days >= 14
OR spend_28d >= account_spend_28d_p50 * 0.3
```

The checked-in R&D CSVs are already the mature extract, so ME1 treats all 278 rows as the baseline mature population for coverage analysis.

ME2 recommendation: keep this filter for v1 launch. Do not tighten it until ME7 validation proves the engine over-fires. The filter already excludes truly immature rows while preserving rows that matter because they carry meaningful account spend.

## Checked-In Baseline Counts

| bucket | count |
|---|---:|
| total mature entities | 278 |
| campaigns | 101 |
| adsets | 177 |
| current engine snapshot entities | 4 |
| current entity coverage | 1.44% |
| adset snapshot entities | 0 |

## Denominator Treatment

### Entity coverage denominator

Use all mature entities that the engine is expected to classify.

Included:

- Active mature campaigns and adsets.
- `WITH_ISSUES` and `UNKNOWN` mature rows.
- Paused rows with 28d spend or purchase history.
- Non-sales objective rows, but only as state/out-of-scope coverage.

Conditionally included:

- Paused/no-spend archived rows are included only if ME2 chooses to persist archival/state rows. They must not count toward action density.

### Sales action-density denominator

Use rows where a real sales/value decision could reasonably be produced:

- Sales/purchase/value rows.
- Not paused/no-spend archive rows.
- Active, with-issues, unknown, or paused-with-spend rows.

Excluded:

- Paused/no-spend archive rows.
- Non-sales objective rows such as awareness, engagement, traffic, link-click, ThruPlay, and messages.
- State-only `out_of_scope` rows.

### Checked-in denominator classification

| class | count |
|---|---:|
| paused/no-spend archive rows | 223 |
| non-sales objective rows | 49 |
| active/with-issues/unknown rows | 40 |
| active/with-issues/unknown sales rows | 32 |
| paused-with-spend sales rows | 15 |
| recommended sales action-density denominator | 47 |

## Anti-Gaming Metrics

Entity coverage alone can be gamed by writing one `state/no_action` row for every eligible entity. ME7 must use two metrics:

```text
entity_coverage = persisted eligible entity rows / eligible entities
action_density = rows where kind in ('recommendation', 'anomaly') / total persisted eligible rows
```

ME7 target:

- `entity_coverage >= 80%`
- `action_density >= 15%` on the sales action-density denominator

Why 15%: the checked-in mature extract has 47 sales action candidates after excluding non-sales and paused/no-spend archive rows. Codex R&D found clear action, diagnose, switch, rebuild, refresh, tune, or scale patterns among this population, but also warned against Claude-style mass firing. A 15% floor is high enough to prevent 100% no-action gaming, while low enough to preserve media-buyer patience and avoid turning the engine into a deterministic threshold cannon.

Implementation note: ME7 should report action density in three views:

1. All persisted eligible rows.
2. Sales action-density denominator only.
3. Active/with-issues/unknown mature rows only.

## Current Engine Coverage Under These Metrics

Current extracted engine rows:

- Total engine snapshot entities: 4.
- Campaign snapshot entities: 4.
- Adset snapshot entities: 0.

Current coverage:

- All mature entities: `4 / 278 = 1.44%`.
- Sales action-density denominator: `4 / 47 = 8.51%`.
- Adset entity coverage: `0 / 177 = 0%`.

Current action density is not meaningful because the engine does not persist state rows. ME2 must add state rows before action density can be measured properly.

## ME2 Recommendation

Keep the R&D maturity filter for the first v1 implementation, but split outputs into:

- `kind = state`: keep, watch, no_action, out_of_scope, archived.
- `kind = recommendation`: scale, cut, tune, switch, rebuild, refresh, swap, review_placements.
- `kind = anomaly`: diagnose-first issues such as ROAS drop, delivery stall, policy block, pacing failure, CPM spike, tracking degradation.

Coverage should be measured on all eligible entity rows. Action density should be measured only after excluding paused/no-spend archive rows and non-sales state rows.
