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

- `app/(dashboard)/platforms/meta/legacy-page.tsx` and the authorized
  `/c/[businessId]/meta/decisions` page resolve the real business envelope and
  pass it into `MetaPlatformPage`; the scoped route does not delegate business
  authority back to the client store.
- `components/meta/redesign/MetaPlatformPage.tsx` owns queries, real-data
  adaptation, exceptional source/readiness banners, guarded snapshot refresh,
  route-family navigation, mobile read-only presentation, and evidence
  callbacks.
- `components/meta/decision-center/meta-decision-center-exact-adapter.ts`
  losslessly maps the served workspace/OS contracts to the presentation model;
  it does not compute buyer actions, lanes, confidence, or write authority.
- `components/meta/decision-center/MetaDecisionCenterExact.tsx` is the exact
  desktop presentation: source header, five KPIs, two scopes, five lanes,
  creative posture/cards, and the default inline evidence inspector.

Supporting components under `components/meta/redesign/`:

- `MetaLaunchpadOverlay.tsx` — confirm overlay for rebuild/duplicate/apply_bid,
  wraps the shared `LaunchpadOverlay`.
- `MetaCampaignLabelsSection.tsx` is the label-modal body;
  `MetaCreativeEvidenceDrawer.tsx` displays canonical creative evidence.
- `meta-card-utils.ts` — verbatim consumption of server presentation fields.
- `types.ts` — shared client payload contracts (`MetaPulsePayload`,
  `MetaLanePayload`, `MetaWatchingSegment`, `MetaHealthyEntity`,
  `MetaArchivedEntity`, `MetaDrillItem`, `MetaLaunchMode`).

Shared briefing primitives still used by non-canonical/guarded flows include
`CompareDrawer`, `TrackingConfirmModal`, and `DeferChip`/`useDeferState`.

Read routes used by the page:

- `app/api/meta/account-pulse/route.ts` — live/warehouse aggregates + health.
- `app/api/meta/lane-classify/route.ts` — persisted decision snapshot,
  lane-partitioned and presentation-annotated at read time.
- `app/api/meta/anomalies/route.ts` — active tracking anomalies.

Mutation routes used directly by the page:

- `app/api/meta/recommendations/respond/route.ts` — operator response log.
- `app/api/meta/snapshot/run-now/route.ts` — manual snapshot refresh.
- `/api/triage/event` + `/api/triage/state` — scope-level defer state
  (`useDeferState` in `components/common/briefing/DeferChip.tsx:132`).

The recommendation page performs **no direct Meta provider write**. Its
campaign/ad-set recommendations are advisory until those entity levels have an
immutable canonical execution-authority contract. Rebuild/duplicate controls
only route the operator into Launchpad; any later provider write is a separate
manual Launchpad flow with its own confirmation, write guard, intent lineage,
action log, and verify-after-write boundary.

## Page anatomy

The desktop happy path is rendered by `MetaDecisionCenterExact`: source-aware
header → five KPI cards → scope and snapshot note → five lane controls plus
sort/search → the selected lane workspace with its inline evidence inspector.
Exceptional account, source, readiness, tracking, and read-only banners stay
outside that canonical block and render only when their server state requires
them.

### Topbar

- Crumbs + title ("Meta · Decision Center").
- The visible window control has exactly `7d | 14d | 28d | 90d`. A custom
  range can still arrive through the existing URL contract, but no fifth
  control is invented; in that state none of the four fixed keys is selected.
- The mono source line (`data-meta-exact-source-identity`) binds sync age to
  `pulse.lastSyncAt`, snapshot identity to the canonical decision source with
  lane/OS fallbacks, and engine/time to server source metadata. Missing values
  render as an em dash; client render time is never presented as source time.
- Status filtering remains in the request contract, but the exact desktop
  design does not add the old visible filter group.
- "Run snapshot" button → `POST /api/meta/snapshot/run-now` (cooldown-aware,
  see write surfaces).
- "+ New campaign" preserves the current legacy, `/app`, or `/c/:businessId`
  route family and carries the explicit assigned provider account into
  Launchpad.

Directly beside the two scope controls, the queue note
(`data-meta-exact-queue-snapshot`) reads "queue reflects snapshot
`{snapshotAsOf}` — the date range scopes metrics, not decisions". The adapter
uses the real canonical/lane/OS snapshot identity or an em dash.

URL state: `window`, `startDate`/`endDate` (custom only), `status_filter`,
`lane`, and `entity` (the open inspector's rec id) are all URL params; defaults
(`28d`, `active`, `action`) are omitted from the URL.

### Business scope rail (`MetaScopeRail`, `data-testid="meta-scope-rail"`)

Left column of the content row, collapsible (« collapse / » expand). Lists the
operator's real businesses from the app store (`useAppStore((s) =>
s.businesses)`); before the persisted store hydrates it falls back to a single
row built from the resolved `businessId`/`businessName` props so the selected
business is always represented — never a fabricated entry.

- The **currently selected** business shows its real act-now count
  (`actionNow.length + anomalies.length`, mirroring the Action Now tab meaning)
  and its real spend-today (`pacing.spendToday`, same day-pace fallback as the
  pulse strip; null renders "spend —"), with a status dot toned by real signal
  (tracking blocked → danger, act-now pending → warn, else ok).
- **Other** businesses carry no fabricated per-business numbers — only the name
  and a muted "Open" affordance — because the page holds data for the selected
  business alone. Selecting a row drives the store (`selectBusiness`);
  `page.tsx` re-resolves the selected business and re-keys the queries, so the
  whole page reloads that business's data.
- Footer: "Spend shown in each account's own currency. Cross-business totals
  are never summed." There is no "All businesses" affordance — no cross-business
  route exists, so none is shown.

### FinalMetaPulse — 5-cell strip (`MetaPlatformPage.tsx:1002`)

Rendered inline at the top of the queue column (right of the scope rail) from
`MetaPulsePayload`; five cells:

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

Money is currency-aware: `formatMoney` uses `pulse.currency` (the decision
payload's cutoff-safe ad-account currency) first, then the selected provider
account currency only when the decision payload has no currency. It never
defaults to USD; when both are unknown the copy says `Currency unavailable`.
The campaign-label table formats each campaign's spend with that row's
server-returned `currency`; it does not drop the row currency or borrow a
different selected-account symbol.

### MetaWorkspacePostureBanners

Server-composed posture rows rendered under the pulse when the workspace
reports an active truth, safety, or readiness condition, including:

- snapshot or data-readiness degradation;
- tracking write-gate posture;
- reviewer read-only posture;
- environment or business kill-switch engagement.

The stack consumes server-owned banner ids and severity. Dismissing a tracking
banner affects presentation only and never changes the write gate.

### Tracking posture banner vs write gate — deliberately separate

- `isTrackingWriteBlocked(pulse)` (`MetaPlatformPage.tsx:861-869`) is the
  **write gate**: server verdict only (`trackingAnomalyActive`, falling back to
  `trackingHealth.status ∈ {blocked, degraded}`). It is pure and
  dismissal-free **by signature** — it takes exactly one argument (the server
  payload) so client dismissal state cannot reach it.
- `trackingDismissed` local state only hides the `tracking_write_gate` row in
  `MetaWorkspacePostureBanners`; the posture copy explicitly says hiding the
  banner does not unlock writes. The write gate above still stays active.
- While gated, the remaining tracking-sensitive provider handoff
  (`route_launchpad_rebuild` — `isTrackingSensitiveRec`) is intercepted by
  `TrackingConfirmModal` before routing to Launchpad. Legacy
  `execute_pause`, `execute_resume`, and `execute_bid` payload values never
  reach a provider endpoint: the client boundary downgrades them to
  `review_drill`.

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
server `campaignKind`), plus Reset. It also carries a **sort** control
(`meta-row-sort`: Money at stake (default) / Priority / Age — `sortMetaRecs`,
over structured server truth, missing-metric rows always sorted last) and a
**free-text search** (`meta-row-search` — `metaRecSearchMatch` over entity
name, campaign, adset, and decision label). Sort/search narrow the rendered
rows in the rec lanes; lane tab counts stay lane totals.

### Evidence inspector (`MetaDecisionCenterExact.tsx`)

The Action Now workspace always reserves the canonical in-flow inspector
column at desktop widths. It renders the selected server recommendation (or
the first real action row) as: decision contract → server reasoning →
money/target evidence → confidence and readiness → blockers → evidence rows →
provenance. Missing fields stay as em dashes. Selecting a row updates the
existing `entity` deep link; the page no longer adds the old sub-1440 overlay
drawer on top of the canonical inspector. Mobile keeps its separate read-only
evidence screen.

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
  passthrough from the campaigns source. Rendered in the workspace posture
  stack as `data-banner-id="data_readiness"` when status is not `ok` or the
  range is partial.

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

- Accepts `endDate` to scope the anomaly snapshot to the selected range's
  end (newest anomaly snapshot at or before that date); the client threads
  it for custom ranges and keys the query on the full window/status scope.
- Accepts `status_filter`, applied against the entity status captured at
  anomaly write time (`entityStatus` inside the stored anomaly). Semantics
  live in `anomalyMatchesStatusFilter` (`lib/meta/anomalies.ts`): "active"
  keeps ACTIVE plus unknown/legacy rows (fail-open — an anomaly never
  disappears for lack of metadata), "active_plus_recent_paused"
  additionally keeps PAUSED (coarse: anomaly rows store observed status at
  day resolution, not a status-change timestamp, so the <=24h recent-paused
  rule cannot be evaluated exactly), "all" keeps everything. Absent param =
  no status filtering.

`{ anomalies, snapshotDate, count }` from `readMetaAnomaliesForBusiness`
(`lib/meta/anomalies.ts`). The page always fetches `activeOnly=1` with the
current `status_filter`. Anomaly cards render in Action Now and add
to its tab count; they are `MetaAnomaly` objects, not recommendations, and are
**not** annotated by `rec-presentation` (see caveats).

### Two source models on one page — unified as-of contract

The pulse payload is a **live/warehouse aggregate** view (fresh up to
`lastSyncAt`); the lanes are a **persisted decision snapshot** view. They can
legitimately diverge. Each source carries its OWN as-of in its payload. The
exact header source line (`data-meta-exact-source-identity`) surfaces the
divergence compactly (synced · snapshot · engine · computed time); the Snapshot
KPI separately reports the server snapshot-health state:

- **Ingest (pulse):** `lastSyncAt` = real `MAX(updated_at)` from
  `meta_campaign_daily`, null-honest ("sync unknown"). Never fabricated.
- **Decision engine (pulse):** `snapshotHealth` (26h SLA, engine-version
  check) + `engineLastRun`/`engineVersion`. NOTE: this is the GLOBALLY
  latest engine run, not range-bounded.
- **Lanes/workspace:** `snapshotDate` is the TRUE `snapshot_date` of
  the served rows (the newest in-range snapshot — on historical ranges this
  can be older than the requested end; the payload used to echo the range
  end, which overstated freshness and mis-scoped deferral events). It is a
  fallback for the source snapshot identity and is repeated in the exact queue
  note (`data-meta-exact-queue-snapshot`).
- **Anomalies:** feed-level `snapshotDate` remains request-scoped at or before
  the range end, and per-item `detectedAt` remains evidence metadata. The exact
  desktop reference has no separate anomaly-as-of strip, so the page does not
  fabricate one or reintroduce the removed chrome.
- **Copies (separate page):** `meta.generatedAt` is response-generation
  time — a cache-age stamp, NOT an ingest-freshness claim; the two
  semantics are deliberately distinct.

The workspace posture stack explains snapshot/readiness state. Snapshot refresh
remains a separate guarded topbar command; the sync side has no page-level
remediation control.

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
  the primary control actually does. The server emits
  `route_launchpad_rebuild | route_launchpad_duplicate | review_drill`.
  Historical `execute_pause | execute_bid | execute_resume` values remain in
  the wire type only for snapshot compatibility and are defensively normalized
  to `review_drill` by `uiActionKindForRec`; typed `proposedAction.kind` is
  advisory and cannot grant write authority.
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

Advisory bid values are typed minor units only:
`proposedBidMinorForExecute` (`meta-card-utils.ts:75`) accepts
`proposedAction.bidAmountMinor` / `targetValue.bidAmountMinor`. This value can
be shown as evidence but does not make the recommendation executable.

## Write surfaces and safety model

No campaign, ad-set, or Ad provider write executes from this recommendation
page. Clicking a server-emitted review action opens evidence; clicking a
Launchpad route records the operator response and navigates to a separate
manual workflow. Even a stale or injected `execute_*` value is review-only.

The still-supported explicit manual campaign/ad-set routes use the shared
pipeline in `lib/meta/entity-action-routes.ts`, but they are not recommendation
execution authority:

- Exact `actionOrigin: "manual_operator_v1"` plus
  `manualConfirmation: "explicit_operator_confirmation"` is mandatory.
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
- A provider POST transport exception has an unknown external outcome. It is
  recorded as `silent_failure` with
  `error.code = "provider_outcome_ambiguous"`, a durable single-attempt
  receipt, and `retryAllowed: false`; the request chain stops. A received
  provider HTTP rejection is a definite `failure`. Neither case automatically
  retries the mutation.
- Manual, native-decision, and Launchpad envelopes are presence-checked as
  non-overlapping contracts. Explicit `null` or empty fields from another
  origin still fail closed; shared manual request fields such as
  `idempotencyKey`, operation `action`, and `creativeBriefId` are not
  misclassified as native decision lineage.
- Launchpad intent creation and execution share one server-side fan-out gate:
  at most 20 creatives, 10 ad sets or 10 targets, and 20 total planned
  provider creates. Limit failure returns before capability lookup, intent
  persistence, live provider reads, or mutations. Manual bulk status actions
  are independently capped at 20 exact Ads.

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
  the page renders each source's own as-of (see the unified as-of contract)
  but does not reconcile them. The pulse `snapshotHealth` is globally latest
  while the lane `snapshotDate` is range-bounded — on historical ranges the
  pulse can say "fresh" while the lanes serve an older in-range snapshot;
  the source identity and queue snapshot note make that visible.
- **Anomalies route is not presentation-annotated.** `MetaAnomaly` objects
  bypass `rec-presentation`; their CTA is hardcoded "Open diagnostic".
  Status filtering is coarse by design: it uses the write-time observed
  entity status and fails open on legacy rows without one.
- **Secondary filters are client-narrowing only.** Level/campaign/readiness/
  label filters (and the campaign picker's 12-option cap) never change server
  classification; lane tab counts reflect filtered rows.
- **Present-config-over-history in serving.** Config classes used for cohort
  and lane routing (`optimizationGoal`, `customEventType`, bid strategy) come
  from current config snapshots, so historical windows are classified by
  present configuration — an explicit deliberate contract as of 2026-07-07;
  see docs/meta-serving-history-contract.md for the rule and its decision
  gates.
- **`dataReadiness` is rendered in the workspace posture stack**
  (`data-banner-id="data_readiness"`) when status is not `ok` or the range
  is partial, so not-ready ranges do not present as silent zeros
  (regression-tested in `MetaPlatformPage.test.tsx`).
- **`MetaLanePayload.snapshotHealth` is never populated by lane-classify**
  (`types.ts:149` is optional; the route omits it). Snapshot health on this
  page comes solely from account-pulse.
- **True-MTD pacing is a payload contract, not a rendered cell.**
  `mtdSpend`/`mtdTarget`/`dayPace` are computed honestly, but the strip's
  spend cell renders `spendToday` vs 7d avg, using `dayPace × dailyTarget`
  only as a fallback (`MetaPlatformPage.tsx:1024-1028`).
- **Currency-awareness covers the Decision Center money surfaces.**
  `formatMoney` (shared in `meta-card-utils.ts`) renders the pulse spend
  cell and 7d-avg sublabel, card KPI strips, healthy hierarchy rows, the
  archive table, and the drill-drawer KPI header with the account currency
  (pulse payload `currency`, selected-provider fallback). Remaining legacy `$`:
  the transient bid apply/dry-run notices and the compare drawer's internal
  formatting (shared component) - tracked in the readiness ledger.
- **Display-string parsing survives only as explicit fallback.** The
  drill-drawer KPI header prefers structured `rec.metrics` (currency-aware)
  and falls back to evidence strings only for payloads predating the
  metrics contract - regression-tested. `proposedBidDisplayValue` still
  falls back to parsing evidence text for the overlay's DISPLAY value
  (`meta-card-utils.ts`); the executable bid amount never comes from
  display strings (`proposedBidMinorForExecute`).


## Update discipline

- If a user-visible surface on this page changes (added, removed, re-sourced,
  or re-labeled), update this document **in the same PR**.
- If a rendered field changes truth source, nullability, freshness, or
  readiness semantics, update this document in the same PR.
- If the action-presentation contract changes, update
  `lib/meta/rec-presentation.ts`, its tests, and this document in the same PR.
- If a caveat above is fixed, delete it here in the same PR.
