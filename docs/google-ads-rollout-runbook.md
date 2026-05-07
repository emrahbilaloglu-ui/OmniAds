# Google Ads Advisor Rollout Runbook

This runbook is the standard operator procedure for Google Ads advisor rollout,
validation, recovery, and rollback while write-back remains disabled.

Production rollout record:

- `docs/platforms/google-rollout-record-2026-04-10.md`

## Shipping Boundary

Keep this rollout inside the current verified posture:

- operator-first
- manual-plan-first
- write-back disabled
- action-first operator cards are the source of truth
- AI structured assist is optional, snapshot-time only, and residual

## Required Flags

Baseline:

- `GOOGLE_ADS_DECISION_ENGINE_V2=true`
- `GOOGLE_ADS_WRITEBACK_ENABLED=false`

Optional AI rollout:

- `GOOGLE_ADS_ADVISOR_AI_STRUCTURED_ASSIST_ENABLED=false` by default
- `GOOGLE_ADS_ADVISOR_AI_STRUCTURED_ASSIST_BUSINESS_ALLOWLIST=` empty by default

## Preflight

1. Confirm the branch is the intended deploy commit.
2. Run:
   - `npm run build`
   - `npm run google:ads:product-gate -- <businessId>`
3. Confirm:
   - advisor action contract is native `google_ads_advisor_action_v2` after refresh
   - write-back remains disabled
   - queue health and state health are not degraded
   - admin sync-health is available if the rollout requires full release signoff

## Standard Validation Order

Run the commands in this order for each rollout business:

1. Product gate
   - `npm run google:ads:product-gate -- <businessId> --json`
2. Warehouse / queue snapshot
   - `npm run google:ads:health -- <businessId>`
3. State consistency
   - `npm run google:ads:state-check -- <businessId>`
4. Advisor readiness over the intended operator window
   - `npm run google:ads:advisor-readiness -- <businessId> <startDate> <endDate>`
5. Native advisor snapshot refresh
   - `npm run google:ads:advisor-refresh -- <businessId> --json`
6. UI/API smoke
   - `GET /api/google-ads/status?businessId=<businessId>`
   - `GET /api/google-ads/advisor?businessId=<businessId>&refresh=1`
   - open `/platforms/google`

## Operator Smoke Checks

Confirm all of the following after refresh:

1. The top of each recommendation card leads with:
   - `Primary action`
   - `Scope`
   - `Exact changes`
2. Narrative fields stay secondary and collapsed.
3. Exact items are visible where available:
   - queries
   - asset groups
   - SKUs / product clusters
   - campaign budget moves
   - target values
4. `Blocked because` is explicit when a move is blocked.
5. Validation and rollback remain manual-plan instructions.
6. Validation-due recommendations and recent outcomes render as workflow views, not autonomous queues.
7. If AI structured assist is active:
   - card still stays action-first
   - `AI-structured assist` is shown only as provenance
   - exact items still come from the structured allowlist

## AI Structured Assist Rollout

Use AI assist only after the deterministic surface is already healthy.

1. Start with:
   - `GOOGLE_ADS_ADVISOR_AI_STRUCTURED_ASSIST_ENABLED=true`
   - `GOOGLE_ADS_ADVISOR_AI_STRUCTURED_ASSIST_BUSINESS_ALLOWLIST=<one business id>`
2. Refresh a native snapshot:
   - `npm run google:ads:advisor-refresh -- <businessId> --json`
3. Confirm:
   - `metadata.aiAssist.enabled=true`
   - `metadata.aiAssist.businessScoped=true`
   - `eligibleCount`, `appliedCount`, `rejectedCount`, `failedCount`, `skippedCount` are visible
4. Expand only after:
   - low reject/fail rate
   - operator review says the assisted residual cards are still execution-grade

## Rollback

If the rollout must be pulled back:

1. Keep `GOOGLE_ADS_WRITEBACK_ENABLED=false`
2. Disable AI assist rollout if needed:
   - `GOOGLE_ADS_ADVISOR_AI_STRUCTURED_ASSIST_ENABLED=false`
   - clear `GOOGLE_ADS_ADVISOR_AI_STRUCTURED_ASSIST_BUSINESS_ALLOWLIST`
3. Redeploy the previous known-good application version
4. Re-run:
   - `npm run google:ads:product-gate -- <businessId>`
   - `npm run google:ads:advisor-refresh -- <businessId> --json`

## Recovery

Use these commands before considering manual DB work:

1. `npm run google:ads:cleanup -- <businessId>`
2. `npm run google:ads:replay-dead-letter -- <businessId>`
3. `npm run google:ads:refresh-state -- <businessId>`
4. `npm run google:ads:reschedule -- <businessId>`
5. `npm run google:ads:advisor-refresh -- <businessId> --json`
6. `npm run google:ads:product-gate -- <businessId> --json`

## Exit Criteria

Do not mark rollout complete until all intended businesses satisfy:

- product gate has no `FAIL`
- refreshed snapshot is native `google_ads_advisor_action_v2`
- operator cards stay action-first
- blocked moves are explicit
- manual workflow renders validation-due and recent outcomes
- write-back remains disabled
- AI assist, if enabled, remains residual and business-scoped
