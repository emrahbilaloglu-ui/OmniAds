# Live Output Restoration Trace

Last updated: 2026-04-24 by Codex

## Scope

This pass traced why the live-firm audit branch reported:

- `8` readable live Meta businesses
- non-zero screening live creative rows for each business
- `0` current Creative Decision OS rows for all `8`

The goal was to determine whether current `/platforms/meta/creatives` output was actually broken, or whether the audit helper had drifted away from the current product source path.

## Root Cause

The zero-row result came from a route/source parity bug in the live-firm audit helper, not from the current Creative Decision OS route itself.

What happened:

1. The audit helper used a warehouse-backed helper, `getCreativeDecisionOsForRangeWarehouseBacked()`.
2. That helper read creative windows through `getMetaCreativesDbPayload()`, which depends on `meta_creative_daily`.
3. In the validated runtime, `meta_creative_daily` is currently empty for the audited businesses.
4. The actual `/platforms/meta/creatives` Decision OS path does not read that warehouse path for current creative rows. It reads the live/persisted creative snapshot path through `getCreativeDecisionOsForRange()` and `getMetaCreativesApiPayload()`.

So the branch audit proved a warehouse-helper mismatch, not a live `/platforms/meta/creatives` empty-state defect.

## Concrete Trace

Healthy traced alias: `company-06`

Window used for rerun:

- `startDate`: `2026-03-24`
- `endDate`: `2026-04-22`
- `decisionAsOf`: `2026-04-22`
- primary decision window: `2026-03-24` -> `2026-04-22`

Verified facts:

- `meta_creatives_snapshots` for `company-06`, primary 30d window:
  - `row_count = 64`
  - `snapshot_level = metadata`
- `meta_creative_daily` for the same business/window:
  - `0` rows
- `meta_ad_daily` for the same business/window:
  - `1282` rows
  - `30` completed days
- direct current-source read through `getCreativeDecisionOsForRange()`:
  - `64` current Decision OS creatives

This proves the prior zero-row finding was produced by the warehouse-backed helper path, not by the actual current Decision OS row flow.

## Investigation Results

### 1. `decisionWindows.primary30d` resolution

Window resolution was not the blocker in the traced healthy case.

- The screening and actual Decision OS call both used `2026-03-24` -> `2026-04-22`
- `decisionAsOf` matched the completed-day boundary
- The actual current Decision OS call returned rows on that exact window

### 2. Persisted zero-row snapshot acceptance

This is a real possible failure mode in general, but it was not the primary blocker for the traced live-firm issue.

For `company-06`, the persisted primary-window snapshot was non-zero (`64` rows), and the actual current path still returned rows.

### 3. Upstream row shape / `creativeId` integrity

There is a separate identity/grouping concern in the source path, but it does not explain the prior all-zero audit result.

In the traced case, actual Decision OS rows were emitted successfully, which rules out a full pre-policy row wipeout for this cohort.

### 4. Route/source parity

This was the real blocker.

- Screening path on the audit branch: live current source
- Decision path on the audit branch: warehouse-backed creative helper
- Actual product `/platforms/meta/creatives` path: live/persisted creative source

The audit branch was comparing two different sources and treating the warehouse-backed result as if it were the current product output.

## What Was Changed

Helper-only changes:

- restored the live-firm audit helper to the actual current `getCreativeDecisionOsForRange()` source path
- removed the warehouse-backed Decision OS helper path from the audit script
- made the helper request base URL explicit and runtime-safe (`http://127.0.0.1:3000` by default)
- added a localhost refresh guard in the CLI helper so background snapshot warm requests do not recurse or crash the audit run

No product behavior was changed:

- no Creative policy logic change
- no threshold retuning
- no taxonomy change
- no queue/push/apply safety change
- no UI change

## Validation Result

Current-source rerun across the full readable cohort produced rows for all `8` audited businesses.

Per-business current Decision OS row counts:

- `company-01`: `50`
- `company-02`: `8`
- `company-03`: `16`
- `company-04`: `50`
- `company-05`: `56`
- `company-06`: `64`
- `company-07`: `35`
- `company-08`: `40`

This exceeds the required restoration threshold of non-zero rows for at least `6` of `8` readable businesses.

## Conclusion

The live row-flow issue was not a current product empty-state bug.

It was a parity bug in the audit helper:

- warehouse-backed helper said `0`
- actual Decision OS route says rows flow

The restoration pass therefore fixed the audit source path and restored trustworthy live output verification.
