# Google Ads Advisor Rollout Record

Date recorded: `2026-04-10`

This note captures the operator-first Google Ads advisor rollout validation
performed after deterministic action-card coverage was completed across the live
recommendation families, while write-back remained disabled.

## Rollout Summary

- Shipping posture validated: operator-first / manual-plan-first
- Write-back posture validated: disabled
- Action contract validated: native `google_ads_advisor_action_v2`
- AI structured assist posture during this rollout:
  - global flag disabled
  - no business allowlist configured
  - residual scope only
- Rollout runbook:
  - `docs/platforms/google-rollout-runbook.md`

## Validation Commands

The following commands were executed during this rollout:

1. `npm run google:ads:product-gate -- <businessId> --skip-build --json`
2. `npm run google:ads:health -- <businessId>`
3. `npm run google:ads:state-check -- <businessId>`
4. `npm run google:ads:advisor-readiness -- <businessId> 2026-03-13 2026-04-09`
5. `npm run google:ads:advisor-refresh -- <businessId> --json`

Note:

- `--skip-build` was used in the live per-business gate because the local build had already passed before rollout validation started.
- The truthful advisor window for this validation was the refreshed snapshot `asOfDate` window `2026-03-13 -> 2026-04-09`.

## Production Validation Record

Validated on three connected Google Ads businesses:

1. Grandmix
   - `businessId=5dbc7147-f051-4681-a4d6-20617170074f`
   - product gate:
     - `feature_flag_posture=PASS`
     - `warehouse_sync_health=PASS`
     - `advisor_readiness_contract=PASS`
     - `admin_visibility_contract=PASS`
     - `product_exit_criteria=WARN`
     - `overallLevel=WARN`
   - refreshed advisor snapshot:
     - `actionContractVersion=google_ads_advisor_action_v2`
     - `actionContractSource=native`
     - `recommendationCount=7`
     - `aiAssist.enabled=false`
     - `aiAssist.eligibleCount=0`
     - `aiAssist.appliedCount=0`
   - advisor readiness on `2026-03-13 -> 2026-04-09`:
     - `ready=true`
   - health snapshot:
     - `campaign_daily=90/90 recent days`
     - `search_term_daily=89/90 recent days`
     - `product_daily=89/90 recent days`
     - `dead_letter_count=0`
   - state snapshot:
     - required `google_ads_sync_state` rows present for `account_daily`, `campaign_daily`, `search_term_daily`, `product_daily`

2. IwaStore
   - `businessId=f8a3b5ac-588c-462f-8702-11cd24ff3cd2`
   - product gate:
     - `feature_flag_posture=PASS`
     - `warehouse_sync_health=PASS`
     - `advisor_readiness_contract=PASS`
     - `admin_visibility_contract=PASS`
     - `product_exit_criteria=WARN`
     - `overallLevel=WARN`
   - refreshed advisor snapshot:
     - `actionContractVersion=google_ads_advisor_action_v2`
     - `actionContractSource=native`
     - `recommendationCount=4`
     - `aiAssist.enabled=false`
     - `aiAssist.eligibleCount=0`
     - `aiAssist.appliedCount=0`
   - advisor readiness on `2026-03-13 -> 2026-04-09`:
     - `ready=true`

3. TheSwaf
   - `businessId=172d0ab8-495b-4679-a4c6-ffa404c389d3`
   - product gate:
     - `feature_flag_posture=PASS`
     - `warehouse_sync_health=PASS`
     - `advisor_readiness_contract=PASS`
     - `admin_visibility_contract=PASS`
     - `product_exit_criteria=WARN`
     - `overallLevel=WARN`
   - refreshed advisor snapshot:
     - `actionContractVersion=google_ads_advisor_action_v2`
     - `actionContractSource=native`
     - `recommendationCount=3`
     - `aiAssist.enabled=false`
     - `aiAssist.eligibleCount=0`
     - `aiAssist.appliedCount=0`
   - advisor readiness on `2026-03-13 -> 2026-04-09`:
     - `ready=true`

## Rollout Verdict

Advisor surface verdict for the current shipping boundary: `GO`

Reason:

- connected businesses refreshed successfully into native `google_ads_advisor_action_v2`
- operator window readiness passed on the truthful snapshot window
- product gate passed the core advisor, warehouse, and admin visibility sections
- write-back remained disabled
- AI structured assist remained optional and inactive by default

This is not a write-back or autonomy signoff.

## Known Non-Blocking Observations

1. Product gate stayed at `overallLevel=WARN` in these live runs because:
   - `--skip-build` was used during the per-business validation
   - retention execution remains intentionally `dry_run`

2. Historical / maintenance queue pressure is still visible in admin telemetry for some businesses.
   - This did not block native advisor snapshot generation in the validated sample.

3. AI structured assist showed `eligibleCount=0` in the validated sample.
   - This matches the current design: the live recommendation families are mostly deterministic, and AI scope is residual only.

## Post-Rollout Monitoring

1. Re-run `npm run google:ads:product-gate -- <businessId>` at `T0 + 24h`
2. Re-run `npm run google:ads:advisor-refresh -- <businessId> --json`
3. Watch `/admin/sync-health` for:
   - dead letters
   - stale maintenance pressure
   - queue growth without recent checkpoint movement
4. Keep write-back disabled
