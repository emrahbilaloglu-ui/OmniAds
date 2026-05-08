# Meta Engine v1 ME1 Schema Plan

Run date: 2026-05-08
Scope: DDL-ready additive plan only. No migration was applied in ME1.

## Principles

- Additive only: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- No DROP.
- No RENAME.
- All new signal fields nullable at launch.
- Missing or low-quality signals cap confidence and prevent high-confidence destructive or scale decisions.
- Calibration thresholds remain account-history grounded.

## Calibration Metric Expansion

Current `meta_decision_calibration_daily` is EAV-shaped:

```text
business_id
scope_type
scope_id
snapshot_date
metric_name
p10, p25, p50, p75, p90
sample_size
```

ME2 should extend TypeScript metric constants and writers to emit these additional metric rows:

| metric_name | scope | source | unlocks |
|---|---|---|---|
| `freq_p80` | account, campaign | frequency distribution or proxy table | E3 |
| `daily_roas_volatility` | account, campaign | 14d daily ROAS stddev / mean | B5, B6 |
| `dedup_rate_pct` | account | Pixel/CAPI event diagnostics | H1, H3 |
| `meta_to_crm_ratio` | account | Shopify/CRM actuals vs Meta-reported conversions | H2 |
| `auction_loss_to_bid_ratio` | campaign, adset | delivery diagnostics if available | B3 |
| `peer_audience_overlap_pct` | campaign, adset | audience overlap calculator | D4, I5 |
| `creative_age_days` | campaign, adset | ad/creative first_seen aggregation | E4 |
| `ctr_decay_pct` | campaign, adset | 7d/28d or 14d/28d CTR comparison | E2, E4, J2 |

No table migration is required for the EAV rows themselves. The migration work is TypeScript enum expansion and any supporting source tables below.

## Entity Signal Table

DDL-ready proposal:

```sql
CREATE TABLE IF NOT EXISTS meta_entity_decision_signals_daily (
  business_id TEXT NOT NULL,
  provider_account_id TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('campaign', 'adset')),
  scope_id TEXT NOT NULL,
  as_of_date DATE NOT NULL,

  learning_state TEXT,
  days_at_learning_state INTEGER,
  last_significant_edit_at TIMESTAMPTZ,
  recent_change_cooldown_until TIMESTAMPTZ,

  audience_overlap_pct DOUBLE PRECISION,
  audience_size BIGINT,
  lookalike_pct DOUBLE PRECISION,
  audience_stage TEXT,

  creative_age_days INTEGER,
  frequency_p80 DOUBLE PRECISION,
  ctr_decay_pct DOUBLE PRECISION,

  feed_disapproval_count INTEGER,
  feed_status TEXT,

  dedup_rate_pct DOUBLE PRECISION,
  meta_to_crm_ratio DOUBLE PRECISION,
  tracking_quality_status TEXT,

  source_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_status TEXT NOT NULL DEFAULT 'missing'
    CHECK (quality_status IN ('ready', 'partial', 'missing', 'stale', 'unsupported')),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (business_id, scope_type, scope_id, as_of_date)
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_meta_entity_decision_signals_business_date
  ON meta_entity_decision_signals_daily (business_id, as_of_date DESC);

CREATE INDEX IF NOT EXISTS idx_meta_entity_decision_signals_scope_date
  ON meta_entity_decision_signals_daily (scope_type, scope_id, as_of_date DESC);

CREATE INDEX IF NOT EXISTS idx_meta_entity_decision_signals_quality
  ON meta_entity_decision_signals_daily (business_id, as_of_date DESC, quality_status);
```

## Snapshot Table Extension

`meta_decision_snapshots_daily` already supports:

- `scope_type`
- `kind`
- `severity`
- `diagnostics`
- `evidence_trail`
- `campaign_role`
- `bid_regime`

ME2 should add explicit state coverage fields:

```sql
ALTER TABLE meta_decision_snapshots_daily
  ADD COLUMN IF NOT EXISTS decision_label TEXT;

ALTER TABLE meta_decision_snapshots_daily
  ADD COLUMN IF NOT EXISTS state_reason TEXT;

ALTER TABLE meta_decision_snapshots_daily
  ADD COLUMN IF NOT EXISTS calibration_scope JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE meta_decision_snapshots_daily
  ADD COLUMN IF NOT EXISTS signal_quality JSONB NOT NULL DEFAULT '{}'::jsonb;
```

ME2 should also extend the `kind` check to include `state`. Because check-constraint mutation is riskier than a plain add-column, implementer must first inspect the current constraint name and use an additive migration pattern that preserves old rows. If constraint replacement is not safe in ME2, use `kind='recommendation'` with `decision_state='watch'` for state rows temporarily and document the compatibility shim.

## Extraction Updates

Update `scripts/_phase-meta-rnd-extract.ts` to left-join `meta_entity_decision_signals_daily` for campaign and adset rows by:

```text
business_id
scope_type
scope_id
latest as_of_date <= extraction as_of date
```

Add CSV columns:

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
- `signal_quality_status`

Preserve all existing CSV columns for Claude/Codex comparability.

## Confidence Caps

ME2 rule:

- If a scenario requires a missing signal, the scenario may emit only `watch`, `diagnose`, or low-confidence state.
- No high-confidence scale/cut/rebuild may depend on a signal with `quality_status != 'ready'`.
- Tracking-related degradation (`dedup_rate_pct`, `meta_to_crm_ratio`) caps confidence globally for the affected business.
- Learning-state scenarios A3/A4/A5 must not fire as high confidence when `learning_state` or `days_at_learning_state` is missing.
- Audience-overlap scenarios D4/D5/I5 must not fire unless overlap source quality is ready.
- Catalog feed scenario K4 must not fire as a feed-specific recommendation unless `feed_disapproval_count` or `feed_status` source is ready.

## Migration Ordering

1. Add `meta_entity_decision_signals_daily`.
2. Add snapshot compatibility columns.
3. Extend TypeScript calibration metric names.
4. Extend calibration writer for derivable metrics first: `daily_roas_volatility`, `ctr_decay_pct`, `creative_age_days` where source exists.
5. Add unsupported/missing source rows for metrics that need external data: `dedup_rate_pct`, `meta_to_crm_ratio`, audience overlap.
6. Update R&D extraction joins.

## Open Implementation Risks

- `freq_p80` cannot be derived from current mean frequency alone.
- `dedup_rate_pct` needs Pixel/CAPI diagnostics not currently present in the warehouse.
- `meta_to_crm_ratio` needs a reconciled Shopify/CRM source.
- Audience overlap needs targeting metadata and an overlap calculator; naming alone is not enough for high-confidence D4/I5.
