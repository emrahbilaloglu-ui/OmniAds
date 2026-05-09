# ME9 Signal Backfill — Validation Failed

Timestamp: 2026-05-08T20:38:51Z

## Summary

ME9 signal backfill is implemented and production DB validation now runs, but the ME9/ME7 quality gate still fails. The five narrow signals A-E were written for TheSwaf and IwaStore and the snapshot job completed for both businesses, yet action density remains `25 / 263 = 9.5%`, below the required `>= 30%`. Per the ME9 prompt, this is a hard stop: do not continue to ME8.

## Implemented

- Added additive schema support for `creative_age_days_max` and `days_since_significant_edit`.
- Added `lib/meta/entity-signals.ts` to read/upsert `meta_entity_decision_signals_daily`.
- Added `lib/meta/entity-signals-backfill.ts` and `scripts/_run_meta_signals_backfill.ts`.
- Wired snapshot order as `calibration -> signals_backfill -> snapshot recommendation build`.
- Joined signal rows into campaign and adset recommendation builders.
- Updated signal-aware emitters:
  - E1 reads `frequency_p80`.
  - E2/E4 require `ctr_decay_pct`; E4 also requires `creative_age_days_max`.
  - F1/F4 suppress during recent significant-edit cooldown.
  - C1/J1 suppress during recent significant-edit cooldown.
  - A1/A2 require `learning_state`.
- Exposed adset `reach` and `frequency` from warehouse serving rows.
- Reduced snapshot validation DB pressure by reading campaign windows sequentially.
- Documented persona consultations in `me9-persona-consultations.md`.

## Signal Backfill Proof

TheSwaf (`172d0ab8-495b-4679-a4c6-ffa404c389d3`):

- Rows written: 146
- Campaign signals: 49
- Adset signals: 97
- `frequency_p80`: 16
- `ctr_decay_pct`: 12
- `creative_age_days_max`: 122
- `last_significant_edit_at`: 76
- `learning_state`: 146

IwaStore (`f8a3b5ac-588c-462f-8702-11cd24ff3cd2`):

- Rows written: 141
- Campaign signals: 54
- Adset signals: 87
- `frequency_p80`: 30
- `ctr_decay_pct`: 11
- `creative_age_days_max`: 82
- `last_significant_edit_at`: 47
- `learning_state`: 141

By scope after final rerun:

| Business | Scope | Rows | frequency_p80 | ctr_decay_pct | creative_age_days_max | last_significant_edit_at | learning_state |
|---|---:|---:|---:|---:|---:|---:|---:|
| TheSwaf | adset | 97 | 11 | 8 | 78 | 27 | 97 |
| TheSwaf | campaign | 49 | 5 | 4 | 44 | 49 | 49 |
| IwaStore | adset | 87 | 18 | 6 | 48 | 0 | 87 |
| IwaStore | campaign | 54 | 12 | 5 | 34 | 47 | 54 |

## Snapshot Proof

TheSwaf snapshot job:

- Calibration rows written: 12
- Account scopes: 2
- Campaign scopes: 0
- Recommendations/state rows written: 102
- Anomalies written: 1

IwaStore snapshot job:

- Calibration rows written: 6
- Account scopes: 1
- Campaign scopes: 0
- Recommendations/state rows written: 161
- Anomalies written: 0

## Action Density Check

Latest `scripts/_phase-meta-rnd-action-density-check.ts` result:

```json
{
  "snapshotDate": "2026-05-08",
  "coverage": [
    { "scope_type": "adset", "entities": 184, "rows": 199 },
    { "scope_type": "campaign", "entities": 55, "rows": 64 }
  ],
  "persistedRows": 263,
  "actionRows": 25,
  "actionDensityPct": 9.5
}
```

Action rec types:

| rec_type | rows |
|---|---:|
| adset_cut_spend | 8 |
| bid_strategy_fit | 5 |
| scenario_e1_frequency_fatigue | 5 |
| adset_scale_budget | 2 |
| bid_value_guidance | 1 |
| roas_drop_sudden | 1 |
| scale_for_profitability | 1 |
| scenario_i4_test_should_use_abo | 1 |
| scenario_k1_mixed_config_rebuild | 1 |

## Toolchain

- `npm run lint`: pass
- `npm run test`: pass, 381 files passed, 5 skipped; 2523 tests passed, 44 skipped
- `npm run build`: pass
- Targeted tests:
  - `lib/meta/entity-signals-backfill.test.ts`: pass
  - `lib/meta/scenario-emitters/high-priority.test.ts`: pass
  - `lib/meta/snapshot.test.ts`: pass

## Failure Mode

ME9 fixed the immediate missing-signal problem enough to populate A-E signal rows, but those signals still do not unlock enough production action rows. Only E1 materially increased firing (`scenario_e1_frequency_fatigue`: 5 rows). E2/E4 remain sparse because valid stable-spend CTR decay signals are sparse. A1/A2 remain constrained by learning-state and ROAS/budget gates. F1/F4 and C1/J1 are now correctly suppressed during recent edit cooldown, which improves correctness but does not improve action density.

The new root-cause hypothesis is that the remaining 30% action-density target cannot be reached by the ME9 narrow A-E signal backfill alone without either:

- wiring additional production scenarios beyond the ME2-redo 12 emitters, especially audience, catalog/feed, portfolio, and tracking scenarios; or
- revisiting emitter thresholds/precedence using the refreshed signal distribution and persona disagreement examples.

Per the ME9 prompt, do not loop automatically. Human decision needed: either reopen decision-core scope for more production emitters, lower the action-density target with an explicit risk note, or run a focused threshold calibration pass on the 12 wired emitters.

## Operational Notes

The broad `npm run db:migrate` attempt timed out and left a stale `ALTER TABLE meta_sync_partitions` backend lock. That backend was terminated with `pg_terminate_backend`; the ME9-required additive columns were applied directly with:

```sql
ALTER TABLE meta_entity_decision_signals_daily ADD COLUMN IF NOT EXISTS creative_age_days_max INTEGER;
ALTER TABLE meta_entity_decision_signals_daily ADD COLUMN IF NOT EXISTS days_since_significant_edit INTEGER;
```

Signals F and G remain deferred:

- `audience_overlap_pct`: engine v2, because it requires cross-campaign overlap computation and no ME2-redo wired emitter depends on it.
- `feed_disapproval_count`: engine v2, because K4 was not in the ME2-redo wired-12 production set.
