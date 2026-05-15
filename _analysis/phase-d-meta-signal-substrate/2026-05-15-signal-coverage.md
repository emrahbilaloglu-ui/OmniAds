# Phase D Meta Signal Coverage Evidence

Date: 2026-05-15
Branch: `phase-d-meta-signal-substrate`

## Source

Read-only production DB inspection of `meta_entity_decision_signals_daily`.
The first combined query attempt had alias/timeout issues, so the inspection was
rerun as smaller sequential read-only queries. No secrets were printed.

## Table Schema

Observed columns:

- `business_id`
- `provider_account_id`
- `scope_type`
- `scope_id`
- `as_of_date`
- `learning_state`
- `days_at_learning_state`
- `last_significant_edit_at`
- `recent_change_cooldown_until`
- `audience_overlap_pct`
- `audience_size`
- `lookalike_pct`
- `audience_stage`
- `creative_age_days`
- `frequency_p80`
- `ctr_decay_pct`
- `feed_disapproval_count`
- `feed_status`
- `dedup_rate_pct`
- `meta_to_crm_ratio`
- `tracking_quality_status`
- `source_json`
- `quality_status`
- `computed_at`
- `creative_age_days_max`
- `days_since_significant_edit`

## Freshness

- Latest campaign daily date: `2026-05-15`
- Latest adset daily date: `2026-05-15`
- Latest signal date: `2026-05-15`
- Latest signal computed at: `2026-05-15 03:00:19.706647+00`

## Latest Signal Coverage

Latest `as_of_date`: `2026-05-15`

| Metric | Value |
|---|---:|
| Rows | 5,258 |
| Businesses | 12 |
| Campaign rows | 2,071 |
| Adset rows | 3,187 |
| Ready rows | 1,483 |
| Partial rows | 3,775 |
| Missing rows | 0 |
| `learning_state` non-null | 5,258 |
| `days_since_significant_edit` non-null | 2,819 |
| `last_significant_edit_at` non-null | 2,819 |
| `creative_age_days_max` non-null | 2,668 |
| `frequency_p80` non-null | 225 |
| `ctr_decay_pct` non-null | 74 |
| `audience_overlap_pct` non-null | 0 |
| `audience_size` non-null | 0 |
| `lookalike_pct` non-null | 0 |
| `audience_stage` non-null | 0 |
| `feed_disapproval_count` non-null | 0 |
| `feed_status` non-null | 0 |
| `dedup_rate_pct` non-null | 0 |
| `meta_to_crm_ratio` non-null | 0 |
| `tracking_quality_status` non-null | 0 |

## `source_json` Coverage

Latest signal rows contain these keys:

| Key | Rows |
|---|---:|
| `age_days` | 5,258 |
| `frequency_impression_floor` | 5,258 |
| `learning_state_quality` | 5,258 |
| `purchases_7d` | 5,258 |
| `significant_edit_rules` | 5,258 |
| `source` | 5,258 |
| `learning_state_aggregation` | 2,071 |

## Interpretation

The signal table is fresh, but many Phase D columns are schema-only. Learning,
edit-cooldown, creative age, frequency, and CTR-decay have partial coverage.
Audience overlap, audience sizing, feed/catalog diagnostics, dedup/CRM ratios,
and tracking quality are not currently populated.

Therefore Phase D should not be treated as a reader-only extension. It needs
writer/backfill grounding for supported signals and explicit unsupported-state
handling where no reliable warehouse source exists.

## Implementation Implications

- Keep audience overlap/feed/catalog fields conservative until a real source is
  identified.
- Tracking quality can be populated from click-to-LPV evidence where ad-level
  warehouse data is present. Do not infer tracking/CAPI issues from zero
  purchases alone.
- Placement mix exists in `meta_breakdown_daily`, but it is account-level by
  breakdown key in the current warehouse shape. It can support account/page
  diagnostics and source evidence; entity-level gates need explicit source
  limitations unless entity-scoped placement data is added.
