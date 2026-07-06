# Meta Page UI Contract

## Mission

The Meta platform page is a campaign/adset-level **Decision Center** (see
`docs/meta-decision-center/START_HERE.md`). It tells the operator what to do,
why, on what evidence, and whether the action executes, routes to Launchpad, or
is review-only.

Core rule, inherited from the Decision Center non-negotiables:

- **The UI renders server truth. It never computes action semantics.**
- Decision labels, action kinds, and primary CTA labels are annotated
  server-side at read time (`lib/meta/rec-presentation.ts`). The client may
  format; it may not decide.
- Hard actions require backend evidence (labels, commercial anchors, maturity,
  fresh data, blocker checks). Missing evidence degrades to diagnose/watch or
  capped confidence on the server, never in the client.

## Scope

- Describes the current rendered Meta page only. Route payload fields that are
  not rendered are out of contract and listed under "Known caveats" when they
  matter.
- The legacy `components/meta/meta-decision-os.tsx` page this document used to
  describe is deleted. Legacy components under `components/meta/*.tsx`
  (campaign list/detail, breakdown grid, account recs) are not part of this
  page anymore.

## Exact code path

Page shell:

- `app/(dashboard)/platforms/meta/page.tsx` — resolves the selected business
  from the app store, renders `<MetaPlatformPage businessId businessName currency />`,
  or `BusinessEmptyState` when no business is selected.
- `components/meta/redesign/MetaPlatformPage.tsx` — the entire page: topbar,
  inline `FinalMetaPulse` strip, inline `ReadinessNotice`, banners, lane tabs,
  filter bar, lane content, bulk bar, modals/drawers/overlays.

Components (all under `components/meta/redesign/`):

- `MetaActionCard.tsx` — recommendation + anomaly cards.
- `MetaDrillDrawer.tsx` — decision/informational/anomaly drilldown drawer.
- `MetaLaunchpadOverlay.tsx` — confirm overlay for rebuild/duplicate/apply_bid,
  wraps the shared `LaunchpadOverlay`.
- `MetaHealthyRow.tsx`, `MetaUpperFunnelInformationalCard.tsx`,
  `MetaCampaignLabelsSection.tsx` (label modal body), chip components.
- `meta-card-utils.ts` — verbatim consumption of server presentation fields.
- `types.ts` — shared client payload contracts (`MetaPulsePayload`,
  `MetaLanePayload`, `MetaWatchingSegment`, `MetaHealthyEntity`,
  `MetaArchivedEntity`, `MetaDrillItem`, `MetaLaunchMode`).

Shared briefing primitives (`components/common/briefing/`): `CompareDrawer`,
`TrackingConfirmModal`, `DeferChip`/`useDeferState`, `HtmlDateRangePicker`,
`EvidencePopover`, `DecisionLabelChip`, `ConfidencePill`.

Read routes used by the page:

- `app/api/meta/account-pulse/route.ts` — live/warehouse aggregates + health.
- `app/api/meta/lane-classify/route.ts` — persisted decision snapshot,
  lane-partitioned and presentation-annotated at read time.
- `app/api/meta/anomalies/route.ts` — active tracking anomalies.

Write routes used by the page:

- `app/api/meta/adsets/[adsetId]/pause/route.ts`
- `app/api/meta/adsets/[adsetId]/apply-bid/route.ts`
- `app/api/meta/adsets/[adsetId]/resume/route.ts`
- `app/api/meta/campaigns/[campaignId]/resume/route.ts`
- `app/api/meta/ads/[adId]/resume/route.ts` (reachable via
  `resumeEndpointForEntity`; the page currently only produces campaign/adset
  resume intents)
- `app/api/meta/recommendations/respond/route.ts` — operator response log.
- `app/api/meta/snapshot/run-now/route.ts` — manual snapshot refresh.
- `/api/triage/event` + `/api/triage/state` — scope-level defer state
  (`useDeferState` in `components/common/briefing/DeferChip.tsx:132`).

All write handlers funnel through `lib/meta/entity-action-routes.ts` and
`lib/meta/ads-write.ts`.

## Page anatomy

Top-to-bottom order in `MetaPlatformPage.tsx`:

### Topbar

- Crumbs + title ("Meta · Decision Center").
- `HtmlDateRangePicker` — window keys `7d | 14d | 28d | 90d | custom`
  (`MetaWindowKey`, `types.ts:6`); custom carries explicit `startDate`/`endDate`.
- Status filter group — `active | active_plus_recent_paused | all`
  (`lib/meta/briefing-filter.ts`), threaded into both pulse and lane queries as
  `status_filter`.
- "Run snapshot" button → `POST /api/meta/snapshot/run-now` (cooldown-aware,
  see write surfaces).
- "+ New campaign" link → `/platforms/meta/launchpad?fromMetaBriefing=true&mode=duplicate`.

URL state: `window`, `startDate`/`endDate` (custom only), `status_filter`,
`lane` are all URL params; defaults (`28d`, `active`, `action`) are omitted
from the URL.

### FinalMetaPulse — 5-cell strip (`MetaPlatformPage.tsx:1002`)

Rendered inline from `MetaPulsePayload`; five cells:

1. **Spend** — `pacing.spendToday` vs `pacing.avg7dSpend` (+ signed % delta)
   and today's conversions vs 7d avg. Honest historical labeling: when
   `pulse.endDate` is not today, the label reads `Spend · {endDate}` instead of
   `Spend · today` (`MetaPlatformPage.tsx:1013-1014, 1046`).
2. **ROAS · window** — window-matched `roas.d7|d14|d28|selected` vs
   `roas.target`, plus a 28-point sparkline from `roasHistory`.
3. **Snapshot** — decision-snapshot freshness chip
   (`fresh | stale | missing | engine_version_mismatch`), snapshot age, engine
   version, engine run time, and the ingest freshness label: real
   `lastSyncAt` rendered as `synced Xm/h/d ago`, or the literal text
   **"sync unknown"** when null (`MetaPlatformPage.tsx:1086-1088`). The server
   never fabricates "now" (`account-pulse/route.ts:380-392`).
4. **Labels** — `labelCoverage.labeledCampaigns / activeCampaigns` with a
   coverage-percent chip and a "Manage labels" trigger for the label modal.
5. **Mode** — `operatingMode` value plus `seasonalRegime` and
   `trackingHealth.status` chips.

Money is currency-aware: `formatMoney` (`MetaPlatformPage.tsx:839-854`) uses
`pulse.currency` (ad-account currency from warehouse rows,
`account-pulse/route.ts:495`) first, then the business `currency` prop, and
only falls back to the legacy USD-style formatter when both are unknown.

### ReadinessNotice (`MetaPlatformPage.tsx:633`)

Amber remediation banner rendered under the pulse when any of:

- `labelCoverage` has unlabeled active campaigns → button opens the label
  modal;
- `targetAnchor.configured === false` → link to `/commercial-truth`;
- `snapshotHealth.status !== "fresh"` → "Refresh decisions now" button calling
  the same run-now endpoint as the topbar, with snapshot-age chip and
  `staleReason` text.

Hidden entirely when all three are healthy.

### Tracking banner vs write gate — deliberately separate

- `isTrackingWriteBlocked(pulse)` (`MetaPlatformPage.tsx:861-869`) is the
  **write gate**: server verdict only (`trackingAnomalyActive`, falling back to
  `trackingHealth.status ∈ {blocked, degraded}`). It is pure and
  dismissal-free **by signature** — it takes exactly one argument (the server
  payload) so client dismissal state cannot reach it.
- `trackingDismissed` local state only hides the red banner
  (`trackingBannerVisible = trackingBlocked && !trackingDismissed`,
  `MetaPlatformPage.tsx:1330`). "Hide banner" never unlocks writes.
- While gated, tracking-sensitive primaries (`execute_pause`,
  `route_launchpad_rebuild` — `isTrackingSensitiveRec`,
  `MetaPlatformPage.tsx:1527-1532`) and all resume intents are intercepted by
  `TrackingConfirmModal` ("Pause anyway" / "Rebuild anyway" / "Resume anyway")
  before `performPrimary`/resume runs. It is a confirm interstitial, not a
  hard block. `execute_bid` is not tracking-intercepted (see caveats).

### Lanes (`MetaPlatformPage.tsx:1899-1909`)

Five lane tabs, single active lane rendered at a time; counts reflect
client-filtered rows:

- **Action Now** — anomaly cards (from `/api/meta/anomalies`) first, then
  cross-adset rollup cards (adset recs in the same campaign with mixed
  decision labels, `groupAdsetRollups`), then individual `MetaActionCard`s.
  Tab count = filtered recs + anomalies. Empty state
  (`EmptyActionState`) surfaces label/target remediation CTAs.
- **Watching** — `WatchingSegments` chip row (server-provided
  `watchingSegments`, keys: `unlabeled`, `missing_target`, `learning`,
  `recently_changed`, `deferred`, `issues`, **`mid_confidence`**,
  `insufficient_signal`, `other` — `types.ts:153-162`), then cards.
- **Healthy** — hierarchical campaign→adset grouping
  (`MetaHealthyHierarchy`): real campaign rows or synthetic campaign headers
  inferred from adset snapshots, with Mix-aware optimization/bid-strategy
  rollup chips.
- **Non-sales** — `upper_funnel` cohort entries render
  `MetaUpperFunnelInformationalCard`; other non-purchase cohorts render
  `MetaActionCard`.
- **Archive** — inline read-only table of closed entities (PAUSED / ARCHIVED /
  DELETED / UNKNOWN) capped at 30 rows, with a "Resume campaign/adset" button
  for `PAUSED` rows only.

A ghost "Deferred N" chip on the tab row sums local + triage-scope deferred
counts.

### Secondary filter bar (`MetaPlatformPage.tsx:1911-2058`)

Client-side narrowing **only** — the info chip literally says "These controls
narrow server-provided lanes. They do not recompute recommendation lanes in
the UI." Controls: level (Campaigns/Ad sets), campaign picker (max 12 options
derived from lane rows), readiness (All / Auto-ready / Manual only, keyed off
`automationReadiness.tier`), labels (All / Main / Test / Mixed, keyed off
server `campaignKind`), plus Reset.

### Drill drawer (`MetaDrillDrawer.tsx`)

Three modes (`MetaDrillItem`, `types.ts:173-176`): `decision` (rec + related
adset recs, KPI header, adset-depth table, evidence accordion, optional launch
CTA), `informational` (upper-funnel KPI grid), `anomaly` (diagnostic ladder).
Window switcher inside the drawer writes back to the page URL.

### Compare drawer

`CompareDrawer` over the current selection. Items are built by
`compareItemForRec` (`MetaPlatformPage.tsx:320-342`): numbers come **only**
from the server `metrics` field and the typed evidence trail; formatted
evidence display strings are never parsed back into math; missing metrics stay
`undefined` and the entity is excluded from ranking. Action bar: "Pause
weakest" / "Scale strongest" (ranked by structured ROAS via
`selectedRecByRoas`, `MetaPlatformPage.tsx:1806-1818` — metric-less recs never
rank as zero) and "Send selected to Launchpad".

### Launchpad overlay

`MetaLaunchpadOverlay` confirms the three routed/executed flows:

- `rebuild` / `duplicate` → on confirm, `markActed` + `router.push` to
  `/platforms/meta/launchpad?mode=...&campaignIds=...&adsetIds=...&fromMetaBriefing=true`.
- `apply_bid` → on confirm, executes the bid write (see write surfaces); the
  overlay shows `proposedBidCap` from `proposedBidDisplayValue`.

### Campaign label modal

`MetaCampaignLabelsSection` in a page-level modal (Escape/backdrop close).
Main/Test/Mixed labels feed the server lanes and hard-action gating.

## Data contracts

### `/api/meta/account-pulse` → `MetaPulsePayload` (`types.ts:8-61`)

Live/warehouse aggregate model via `getMetaCampaignsForRange`
(`lib/meta/campaigns-source.ts`; current day = live reads, historical =
warehouse read models). Key semantics:

- `pacing.mtdSpend` / `mtdTarget` / `dayPace` — **true month-to-date**
  (month start .. `endDate`), not the selected window relabeled
  (`account-pulse/route.ts:413-420`). `windowSpend` carries the
  selected-window figure separately.
- `lastSyncAt` — `MAX(updated_at)` from `meta_campaign_daily` for the
  business; `null` means unknown, never fabricated
  (`account-pulse/route.ts:380-392`).
- `currency` — ad-account currency from warehouse rows; `null` = unknown.
- `snapshotHealth` — decision-snapshot freshness with a 26h SLA and
  engine-version comparison (`buildSnapshotHealth`,
  `account-pulse/route.ts:187-217`).
- `trackingHealth` — from `engine_v3_creative_lifecycle_daily`
  `tracking_anomaly_score` (≥0.7 blocked, ≥0.35 degraded, no rows → unknown;
  `account-pulse/route.ts:266-288`). `trackingAnomalyActive` mirrors
  blocked/degraded.
- `roas.target` resolution order: commercial-truth target pack →
  account-median calibration → none (`target_source`).
- `labelCoverage`, `targetAnchor` — readiness inputs for the notice/empty
  states.
- `dataReadiness` — `{status, isPartial, notReadyReason, evidenceSource}`
  passthrough from the campaigns source (`account-pulse/route.ts:496-501`).
  Present in the payload; not currently rendered (see caveats).

### `/api/meta/lane-classify` → `MetaLanePayload` (`types.ts:135-151`)

Persisted decision snapshot model: recommendations come from
`readMetaDecisionSnapshotForRange` (`lib/meta/snapshot.ts`), not recomputed
per request. The response object is `satisfies MetaLanePayload`-typed
(`lane-classify/route.ts:1372-1393`) so payload drift fails typecheck.

Lane partition (purchase-scoped recs):

- **actionNow** — `confidenceScore ≥ 0.7`, not learning, no delivery issues,
  not deferred (`lane-classify/route.ts:1272-1278`).
- **watching** — issues / learning / recently-changed (48h) / insufficient
  signal (`score < 0.55` or `decisionState === "watch"`) / **mid confidence**
  (`[0.55, 0.7)` band, `isMidConfidence`, `lane-classify/route.ts:448-451`) /
  deferred; each rec gets a `watchSegment`.
- **No-gap guarantee**: any purchase-scoped rec missed by every predicate is
  parked in Watching under segment `other` and logged as
  `lane_partition_fallback` instead of being dropped
  (`lane-classify/route.ts:1294-1307`).
- **healthy** — non-recommended, purchase-scoped rows above minimum volume
  (campaign: spend ≥ 100 or purchases ≥ 3; adset: spend ≥ 75 or purchases ≥ 3),
  capped 12+12 then 18, enriched with previous-bid config diffs.
- **nonSales** — non-purchase cohorts, as synthesized `state`-kind
  recommendations (`nonSalesStateRecommendation`) plus snapshot recs with
  non-sales cohorts; upper-funnel rows carry thruplay/CPM metrics and account
  p50 benchmark.
- **archive** — PAUSED/ARCHIVED/DELETED/UNKNOWN entities with status labels
  and diagnostic notes, spend-sorted.

Operator-response reconciliation, server-side:

- `readOperatorRecStates` merges `meta_decision_responses` and successful
  `meta_ads_action_log` rows into a latest-state-per-rec map.
- **Time-bounded deferrals**: a deferral is active only while `reappear_at` is
  null (legacy indefinite) or in the future; expired deferrals drop out of
  `deferredIds`, the deferred segment, and annotations
  (`isExpiredDeferral`, `lane-classify/route.ts:604-612`).
- **Live status probe**: for recs with acted pause/resume states, a batched
  Graph API status read (v25.0, 5s timeout, failure-tolerant) detects
  externally reversed states so stale "Acted" chips do not stick
  (`lane-classify/route.ts:817-898`).
- Campaign labels (`campaignKind`) are attached server-side to recs, healthy,
  non-sales, and archive rows.

Every rec in `actionNow`, `watching`, and `nonSales` leaves the route through
`annotateMetaRecPresentation` (`lane-classify/route.ts:1340-1369`) — see next
section.

### `/api/meta/anomalies`

`{ anomalies, snapshotDate, count }` from `readMetaAnomaliesForBusiness`
(`lib/meta/anomalies.ts`). The page always fetches `activeOnly=1` and does not
scope by window or status filter. Anomaly cards render in Action Now and add
to its tab count; they are `MetaAnomaly` objects, not recommendations, and are
**not** annotated by `rec-presentation` (see caveats).

### Two source models on one page

The pulse strip is a **live/warehouse aggregate** view (fresh up to
`lastSyncAt`); the lanes are a **persisted decision snapshot** view (fresh up
to `snapshotHealth.lastRunAt` / `snapshotDate`). They can legitimately
diverge. Freshness is communicated per model in the Snapshot cell: snapshot
age + engine run time for the decision model, `synced X ago` / "sync unknown"
for the ingest model. The ReadinessNotice remediates the snapshot side
(run-now); the sync side has no page-level remediation control.

## Server-owned action presentation

`lib/meta/rec-presentation.ts` is the single source of action semantics,
applied at read time by lane-classify (so old persisted snapshots get the
fields too):

- `decisionLabel` (`serverDecisionLabelForRec`, `rec-presentation.ts:130`) —
  engine-persisted label wins; otherwise derived from type sets
  (CUT/SCALE/REBUILD/SWITCH/SWAP/TEST/REFRESH/TUNE/KEEP) with a defensive-text
  check for `scale_for_profitability` (server-generated text analyzed
  server-side).
- `actionKind` (`serverActionKindForRec`, `rec-presentation.ts:165`) — what
  the primary control actually does:
  `execute_pause | execute_bid | execute_resume | route_launchpad_rebuild |
  route_launchpad_duplicate | review_drill`. Typed `proposedAction.kind` takes
  precedence over type mapping.
- `primaryActionLabel` (`serverPrimaryActionLabelForRec`,
  `rec-presentation.ts:189`) — **honest CTA copy**: execute verbs ("Pause
  adset", "Apply bid cap", "Resume") only for controls that execute a write;
  route verbs ("Rebuild in Launchpad", "Promote in Launchpad") for Launchpad
  handoffs; review framing ("Review scale plan", "Review cut plan", ...) for
  clicks that open the drill drawer.
- `metrics` — structured numeric `{spend, roas, cpa, ctr, purchases,
  frequency}` per entity for compare/bulk math; display strings in
  `evidence[]` are presentation-only.

Client consumption is verbatim (`meta-card-utils.ts`): `decisionLabelForRec`
returns `rec.decisionLabel ?? "diagnose"`, `launchModeForRec` switches on
`rec.actionKind`, `primaryLabelForRec` returns `rec.primaryActionLabel ??
"Open drilldown"`, `structuredMetricsForRec` returns `rec.metrics ?? null`.
Primary routing in `performPrimary` (`MetaPlatformPage.tsx:1534-1585`) follows
`actionKind` only — never rec type or display text.

Executable bid values are typed minor units only:
`proposedBidMinorForExecute` (`meta-card-utils.ts:75`) accepts
`proposedAction.bidAmountMinor` / `targetValue.bidAmountMinor`; a rec without
one gets a disabled apply-bid primary ("No executable bid value - open
evidence").

## Write surfaces and safety model

Three writes execute from this page:

1. **Adset pause** — `POST /api/meta/adsets/{id}/pause` from
   `actionKind === "execute_pause"` primaries.
2. **Apply bid cap** — `POST /api/meta/adsets/{id}/apply-bid` with
   `{ bidAmountMinor, recId }`, always behind the `MetaLaunchpadOverlay`
   confirm step. The route rejects anything but a positive-integer
   `bidAmountMinor`; legacy `bidValue`/`bidValueMinor` fields are refused with
   `invalid_bid_unit` (`entity-action-routes.ts:446-462`).
3. **Resume** — campaign/adset resume from acted-pause cards
   (`canResumeCompletedPrimary`) and from `PAUSED` archive rows.

Shared pipeline (`lib/meta/entity-action-routes.ts`):

- `requireBusinessAccess` at `collaborator` (reads are `guest`).
- Entity → provider-account resolution from warehouse dimension/config tables.
- **In-flight guard**: 409 `action_in_flight` if a pending action exists for
  the entity within 30s (`entity-action-routes.ts:284-298`).
- **Kill switch**: `META_ADS_WRITE_KILL_SWITCH` env
  (`lib/meta/ads-write.ts:84`) short-circuits every write with
  `kill_switch_engaged` → HTTP 503; the UI maps it to operator copy
  ("Meta writes are temporarily disabled (kill switch)...",
  `metaActionFailureMessage`, `MetaPlatformPage.tsx:256-269`).
- **Dry run**: `dryRun: true` passthrough performs no Meta write but still
  runs verification; responses carry `dryRun` + `wouldHaveWritten`, and the UI
  renders info-tone feedback ("Dry run: ...") without marking the rec acted.
- **Action log + verification**: every attempt creates a
  `meta_ads_action_log` row up front and completes it with status
  (`success | failure | silent_failure`), response payload, duration,
  `verifiedAt`, and verification payload; success responses return the
  Meta-verified status/bid (`result.verifiedStatus` /
  `result.verifiedBidAmount`).

Respond / defer flow:

- `POST /api/meta/recommendations/respond` with
  `acted | deferred | undeferred | ignored`. Executed writes also mark acted
  (`markActed`) with subtypes `paused` / `bid_applied`; Launchpad confirms
  mark `rebuild_clicked` / `audience_swap_clicked`.
- **Defer = 24h let-cook, time-bounded**: `deferRec`
  (`MetaPlatformPage.tsx:1460-1473`) posts `action: "deferred"`,
  `actionSubtype: "let_cook_24h"`, `reappearAt: now + 24h`, and additionally
  records a scope-level triage event via `useDeferState` (also 24h). Expiry is
  enforced server-side in lane-classify; "Undo defer" posts `undeferred`.
- Watch-state cards surface "Let cook" as the primary (a defer, which is what
  the click does — `MetaActionCard.tsx:339-341`).

Run-now cooldown: `POST /api/meta/snapshot/run-now` →
`requestMetaSnapshotRefreshForBusiness` with a 5-minute cooldown
(`META_SNAPSHOT_REFRESH_COOLDOWN_MS`, `lib/meta/snapshot-refresh.ts:25`); the
UI distinguishes "refreshed" from "in cooldown".

Tracking gate semantics: see "Tracking banner vs write gate" above — server
verdict only, confirm interstitial on pause/rebuild/resume, dismissal can only
hide the banner.

## Invariants and tests

`lib/meta/__tests__/rec-presentation.test.ts`:

- Execute verbs only for executes; review framing for drawer-only actions
  (the pre-review UI said "Scale budget" on a drawer-opening button).
- Launchpad handoffs routed explicitly; engine `decisionLabel` precedence.
- Annotation attaches presentation fields + structured metrics; unknown
  entities get `metrics: null`.
- **Source scans over `components/meta/redesign/`** (invariant tests, lines
  111-143): no `rec-label-mapping` import (client-side semantics), no
  regex/string inference over `recommendedAction`, no evidence display-string
  parsing in compare/bulk math.

`components/meta/redesign/MetaPlatformPage.test.tsx`:

- **Tracking gate signature test** (lines 703-727): gate blocks on server
  verdict, ignores client state, and `isTrackingWriteBlocked.length === 1` —
  signature-level proof that dismissal cannot be an input.
- **Compare display-string proof** (lines 730-767): compare numbers are
  identical under arbitrary reformatting of evidence strings; metric-less recs
  are excluded (`undefined`), never guessed as zero.
- Plus: lane rendering from snapshot payloads, kill-switch copy, dry-run
  feedback distinctness, acted-pause resume affordance, status filter
  threading, custom-range ROAS, archive/non-sales/healthy hierarchy cases.

`app/api/meta/entity-actions.route.test.ts` and `lib/meta/ads-write.test.ts` /
`ads-action-log.test.ts` cover the write pipeline; `lib/meta/__tests__/`
covers launch-write and creative surfaces.

## Known caveats

Real, current limitations — kept explicit on purpose:

- **Two source models diverge in freshness.** Pulse aggregates
  (live/warehouse) and lane snapshots (persisted engine output) can disagree;
  the page communicates each model's freshness but does not reconcile them.
- **Anomalies route is not presentation-annotated.** `MetaAnomaly` objects
  bypass `rec-presentation`; their CTA is hardcoded "Open diagnostic" and the
  anomalies feed is not window- or status-filter-scoped.
- **Secondary filters are client-narrowing only.** Level/campaign/readiness/
  label filters (and the campaign picker's 12-option cap) never change server
  classification; lane tab counts reflect filtered rows.
- **Present-config-over-history in serving.** Config classes used for cohort
  and lane routing (`optimizationGoal`, `customEventType`, bid strategy) come
  from current config snapshots (`lib/meta/serving.ts:1440-1495`), so
  historical windows are classified by present configuration.
- **`dataReadiness` is payload-only.** The pulse route returns it
  (`account-pulse/route.ts:496-501`) but the page does not render it yet.
- **`MetaLanePayload.snapshotHealth` is never populated by lane-classify**
  (`types.ts:149` is optional; the route omits it). Snapshot health on this
  page comes solely from account-pulse.
- **True-MTD pacing is a payload contract, not a rendered cell.**
  `mtdSpend`/`mtdTarget`/`dayPace` are computed honestly, but the strip's
  spend cell renders `spendToday` vs 7d avg, using `dayPace × dailyTarget`
  only as a fallback (`MetaPlatformPage.tsx:1024-1028`).
- **Currency-awareness is partial.** `formatMoney` covers the pulse spend
  value; the 7d-avg sublabel, archive table, compare drawer, and card bid
  chips still use the legacy `formatCurrency` (USD-style `$`).
- **Display-string parsing survives in display-only paths.** The drill
  drawer's KPI header aggregates evidence strings for display
  (`MetaDrillDrawer.tsx:32-36, 50-56`) and `proposedBidDisplayValue` falls back
  to parsing evidence text for the overlay's display value
  (`meta-card-utils.ts:87-100`). Neither feeds executes or compare/bulk math;
  the invariant scans deliberately scope to math, not display.
- **`MetaArchiveTable` is dead code.** Defined at `MetaPlatformPage.tsx:751`
  but the archive lane renders its own inline table (lines 2200-2262).
- **`execute_bid` is not tracking-intercepted.** Only pause/rebuild primaries
  and resumes go through the tracking confirm modal; apply-bid relies on its
  own confirm overlay.

## Update discipline

- If a user-visible surface on this page changes (added, removed, re-sourced,
  or re-labeled), update this document **in the same PR**.
- If a rendered field changes truth source, nullability, freshness, or
  readiness semantics, update this document in the same PR.
- If the action-presentation contract changes, update
  `lib/meta/rec-presentation.ts`, its tests, and this document in the same PR.
- If a caveat above is fixed, delete it here in the same PR.
