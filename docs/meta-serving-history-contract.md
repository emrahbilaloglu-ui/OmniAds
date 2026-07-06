# Meta serving: present-config-over-history — the explicit contract

Status: **explicit, deliberate contract** as of 2026-07-07 (was: undocumented
anachronism debt in docs/meta-surface-readiness-10-10.md). This document is
pinned to the code by `lib/meta/serving-contract.test.ts`; change either side
in the same commit.

## The rule

**Entity identity columns (name, status, bid/budget/goal configuration) on
Meta serving payloads describe the PRESENT; metric columns (spend, ROAS, CPA,
CTR, ...) describe the SELECTED WINDOW.** The two coexist in one row by
design: the operator asks "how did this thing — as I know it today — perform
over that window", not "what did the account look like back then".

`lib/meta/serving.test.ts` asserts this behavior by name ("returns campaign
current config from typed history instead of warehouse fact config"): a
2026-04-01..03 range whose in-range row was ACTIVE/bid_cap returns the
CURRENT dimension status and the LATEST config-history bid.

## Where the rule applies (the eight classes)

1. **Campaign status** — `getMetaWarehouseCampaigns` overrides
   `campaignStatus` with `meta_campaign_dimensions.campaign_status`
   (current, no history); fallback is the last in-range daily row.
2. **Campaign config** — the LATEST `meta_campaign_config_history` row
   replaces per-date fact config wholesale (optimizationGoal, bid*, budgets,
   mixed flags); per-date warehouse values are discarded, `?? null`.
3. **Adset status/config** — same pattern via `meta_adset_dimensions` and
   `readLatestMetaAdSetConfigHistory`; `buildAdSetTableRow` takes budget/bid
   exclusively from latest config.
4. **"Previous" config diffs** — `readPreviousDifferentMeta*ConfigHistoryDiffs`
   anchor to the latest capture, not the selected range: the previous-bid/
   budget columns describe present-day change history.
5. **Current-status gating** — previous-bid enrichment is fetched only for
   entities whose CURRENT status is ACTIVE, regardless of window.
6. **budgetLevel (CBO/ABO)** — derived from latest-config budget presence,
   stamped onto any window.
7. **Repair-path backfill** — `repairMetaWarehouseTruthRange` (script-only,
   guarded off request paths by `scripts/check-request-path-side-effects.ts`)
   permanently fills NULL per-date config from latest snapshots + live API.
8. **Names** — `*_name_current` preferred over `*_name_historical` for labels.

Also intentional and out of scope for "fixing": lane-classify/briefing
act-now status semantics (the live status probe deliberately overwrites row
status with NOW — lanes are an act-now surface) and the account-pulse
`isInBriefing` filtering, which shares the same present-status rule.

## Why the remaining "honest fixes" are gated (decision gates)

- **Product decision — headline numbers change.** Reconstructing
  window-honest status/config from the per-date daily rows (the columns
  exist) would change account-pulse previous-window totals, WoW deltas,
  constrainedBidShare/operatingMode, and table bid/budget columns that the
  operator is calibrated to. Do not ship without an explicit user decision.
- **Data provenance gap — silently degraded reconstruction.** Per-date
  status/config columns are only observed-at-date from daily sync onward;
  the initial 365d backfill and the repair path stamped older dates with
  capture-time config, and there is NO provenance column to tell the two
  apart. A window-honest mode would be honest only for recent spans and
  cannot say where the boundary is.
- **Write-time capture gap — cannot be backfilled.** No table stores entity
  STATUS history (config snapshots exclude status; dimensions hold current
  only). A true status timeline requires a new append-on-change capture
  stream starting from its deploy date.
- **Cheap and safe when wanted:** an as-of-date reader over
  `meta_*_config_history` (`captured_at <= :endDate` on the existing
  LATERAL) is a pure SQL addition with no schema change — the display
  wiring, not the reader, is what needs the product decision.

## What this contract forbids

- Presenting per-date fact config as if it were current (the inverse
  anachronism).
- Extending the repair-path backfill to overwrite non-NULL per-date values.
- Reusing `readMetaBidRegimeHistorySummaries` (all-time aggregate, no date
  bound) as a window-scoped regime signal.
