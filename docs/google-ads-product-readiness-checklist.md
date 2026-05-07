# Google Ads Product Readiness Checklist

Use this checklist together with [`docs/platforms/google-product-truth-matrix.md`](/Users/harmelek/Adsecute/docs/platforms/google-product-truth-matrix.md).
Use the step-by-step rollout order in [`docs/platforms/google-rollout-runbook.md`](/Users/harmelek/Adsecute/docs/platforms/google-rollout-runbook.md).

The canonical executable gate is `npm run google:ads:product-gate -- <businessId>`.

Product-ready is declared only after a real business passes a `T0` and `T0 + 24h` validation window.

## Core Validation

1. Run `npm run google:ads:product-gate -- <businessId>`
2. Run `npm run build`
3. Run `npm run google:ads:health -- <businessId>`
4. Run `npm run google:ads:state-check -- <businessId>`
5. Confirm:
   - `campaign_daily` completed days increased since the previous check
   - `google_ads_sync_state` exists for `account_daily` and `campaign_daily`
   - `google_ads_sync_partitions` shows queue drain, not only queue growth

## Extended Validation

1. Run `npm run google:ads:state-check -- <businessId>` at `T0`
2. Capture a before/after delta with:
   - `npm run google:ads:progress-diff -- <businessId> <T0 sinceIsoTimestamp>`
3. Repeat both checks at `T0 + 24h`
4. Confirm state rows exist for:
   - `search_term_daily`
   - `product_daily`
   - `asset_group_daily`
   - `asset_daily`
   - `geo_daily`
   - `device_daily`
   - `audience_daily`
5. Compare repeated snapshots and confirm:
   - `search_term_daily` additive coverage completed days increase over time
   - `product_daily` completed days increase over time
   - extended queue depth declines when core backlog is low

## Advisor Validation

1. Run `npm run google:ads:advisor-readiness -- <businessId> <startDate> <endDate>`
2. Refresh the native snapshot with `npm run google:ads:advisor-refresh -- <businessId> --json`
3. Confirm:
   - advisor is `ready=false` when `campaign_daily`, additive `search_term_daily`, or `product_daily` is incomplete
   - advisor is `ready=true` only when all required surfaces are complete
   - legacy snapshots remain labeled `compatibility_derived` until refreshed
   - AI structured assist stays absent unless both the global flag and the per-business allowlist are active
4. Confirm from the refresh output:
   - `actionContractVersion=google_ads_advisor_action_v2`
   - `actionContractSource=native`
5. In the UI:
   - advisor button is disabled while readiness is false
   - advisor button is enabled when readiness becomes true
   - changing the date range marks the existing analysis as stale
   - refreshed snapshots render the native `google_ads_advisor_action_v2` contract
   - manual workflow shows validation-due items and recent operator outcomes without implying automation

## Recovery Validation

1. Run `npm run google:ads:cleanup -- <businessId>`
2. If dead-letter partitions exist, run:
   - `npm run google:ads:replay-dead-letter -- <businessId>`
3. Run:
   - `npm run google:ads:refresh-state -- <businessId>`
   - `npm run google:ads:reschedule -- <businessId>`
4. Confirm:
   - no manual SQL was required
   - queue resumes draining after replay/reschedule
   - state rows refresh correctly after recovery

## Admin Validation

1. Open `/admin/sync-health`
2. Confirm:
   - Google Ads queue depth is visible
   - leased partitions are visible
   - dead-letter partitions are visible
   - oldest queued partition is visible
   - Google Ads queue issues appear in the issue list when applicable
3. Trigger recovery actions from the admin screen when needed:
   - `Cleanup`
   - `Replay Dead Letter`
   - `Reschedule`
   - `Refresh State`
4. Confirm:
   - the action completes without manual SQL
   - the screen refreshes with updated queue/state data
   - dead-letter or stuck backlog symptoms visibly improve when the action is appropriate

## Retention / Canary Validation

1. Run `npm run google:ads:retention-canary -- <businessId>`
2. Confirm:
   - the command exits `0`
   - raw search-term probe rows are `0` outside the `120` day hot window
   - historical search intelligence remains aggregate-backed
   - recent advisor support reports `84/84` additive-backed search coverage
   - the output shows raw-hot-table dry-run stats for:
     - `google_ads_search_query_hot_daily`
     - `google_ads_search_term_daily`
3. Confirm `/api/google-ads/status` or `google:ads:product-gate` shows:
   - retention mode `dry_run`
   - retention execution still disabled by default
   - the explicit canary verification command
   - latest raw-hot-table dry-run stats when a retention run has been recorded

## Product Exit Criteria

The Google Ads stack is considered product-ready only when all of the following are true:

- `npm run google:ads:product-gate -- <businessId>` does not report `FAIL`
- `campaign_daily` historical coverage increases continuously without user presence
- extended advisor surfaces generate state rows
- both `search_term_daily` and `product_daily` increase during the same 24 hour validation window
- `/api/google-ads/status` is fully state-driven
- `/api/google-ads/status` reports advisor action-contract truth and retention runtime posture honestly
- Google retention remains `dry_run` by default and the explicit retention canary passes
- advisor runs only on manual trigger
- request-time sync no longer creates queue storms
- admin sync health reflects Google Ads queue/state truth
- there are no recurring runtime crashes or duplicate key warnings on the Google Ads screen
