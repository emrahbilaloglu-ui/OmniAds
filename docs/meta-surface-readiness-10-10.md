# Meta Surface Readiness Ledger — 10/10 Program (2026-07-06)

Per user direction: the frontend design may be fully rebuilt across ALL Meta
surfaces. This ledger therefore splits every gap into (A) NON-UI readiness
debt that survives a redesign and must be engineered now, and (B) UI-only /
design-shell debt that the redesign wipes — recorded so it cannot be used to
hide backend/contract defects, and NOT worth polish time today.

Scores are evidence-backed as of the cross-surface hardening pass plus the
briefing/launchpad currency slice on 2026-07-06. Update this ledger when a
surface's contract changes (same-PR discipline, as with
docs/meta-page-ui-contract.md).

## Surface scores

| Surface | Score | Server truth? | Payload currency | Freshness honesty |
|---|---|---|---|---|
| Decision Center (/platforms/meta) | 7.5 | yes (post-hardening: server-owned actionKind/labels/metrics; anomalies now status-filter-scoped, coarse+fail-open) | yes (pulse) | real lastSyncAt or "sync unknown"; dataReadiness banner |
| Creatives (/platforms/meta/creatives) | 9 | yes (CDC v3; invariant-guarded) | yes (briefing card contract + asset library default currency) | snapshot health + calibration honesty copy |
| Launchpad | 8.5 | yes (server validate + forced-PAUSED launch; templates/drafts route contracts + payload normalizer now directly tested) | yes (new-campaign payload currencyCode + selection rendering) | honest (server updatedAt) |
| Copies | 8 | yes (real funnel/video fields mapped+summed; seeMoreRate fabrication removed server+client; no client re-derivation) | yes (per-row) | generatedAt stamped and rendered; unresolved-count rendered |
| Creative Inbox | 6.5 | yes (renders briefing labels) | yes (per-card account currency; null = unknown) | generatedAt unrendered |
| Audiences | stub | n/a — honest ComingSoon placeholder | n/a | n/a |

## A. NON-UI gaps (survive any redesign — engineering backlog, priority order)

1. **Meta v1 recommendation engine lacks the CDC disciplines** — partially
   closed this pass: act-boundary state hysteresis now runs at snapshot
   write time (`lib/meta/decision-stability.ts`, mirroring the CDC rule:
   act<->non-act flips publish only after two consecutive snapshots; memory
   rides in signal_quality.stability, no schema change; disappearing recs
   are deliberately NOT republished — that would fabricate decisions).
   Unit + pipeline-integration tested, but NOT yet replay-verified against
   live snapshot history the way CDC was — do not claim churn reduction
   until day-over-day evidence exists. Still open: outcome/calibration
   loop for confidence thresholds (calibration exists, thresholds untested
   against outcomes), 30d fixed lookback. Largest remaining structural
   item on the Decision Center path to 10.
2. **Launchpad meta-store SQL layer is untested.** The templates/drafts
   route contracts and the broad payload normalizer got direct tests this
   pass (all 5 previously untested routes + normalizeMetaLaunchPayload /
   normalizeMetaAddToExistingPayload edge cases), but the route tests mock
   `lib/launchpad/meta-store.ts` - its SQL (upsert scoping, business
   isolation in DELETE, recent-template ordering) still has no coverage.
   An ephemeral-postgres seam test (CDC pattern) is the honest closer.
3. **Two-source freshness model on the Decision Center** (live pulse
   aggregates vs persisted decision snapshot lanes) is communicated only by
   the snapshot chip; a unified as-of contract would survive any redesign.
4. **Present-config-over-history classes in lib/meta/serving.ts** (historical
   windows classified by current status/bid config) — anachronism debt
   shared by pulse and lanes.
5. **Stale e2e specs assert dead testids** (`reviewer-smoke.spec.ts:42`,
    `commercial-truth-smoke.spec.ts:118,443,564` target components with no
    importer); the Playwright layer needs a redesign-era rewrite — blocked
    on/coupled to the frontend redesign decision.
6. **Creatives surface still zero-fills the phantom seeMoreRate metric**
   (`creatives/page-support.tsx:773`): no see-more metric exists in the
   warehouse, yet the shared metric registry offers a "See more rate" column
   (would show 0.0% for every row) and the derived hook/see-more 0-100
   scores (`CreativesTableSection.tsx:355,379`, `page-support.tsx:276,313`)
   take it as an input. The copies views no longer expose the column; the
   shared registry and score model still do. Fix = remove the metric from
   the registry and re-derive the scores without it (Creatives-surface
   slice; noted, not done in the copies pass).

Fixed this pass (was NON-UI debt): fabricated pulse lastSyncAt; fake MTD;
dropped dataReadiness; lane drop-zone [0.55,0.7); non-time-bounded
deferrals; client-side action semantics (rec-label-mapping in UI); display
-string compare math; card KPI display-string dependence; unscoped anomaly
snapshot date; deferred chip cross-scope count; release-authority manifest
citing dead components as live surfaces; briefing card/account currency for
Creative Inbox; Launchpad new-campaign currencyCode and creative-selection
money rendering; Copies API funnel/video omission (real source fields now
mapped per-row and summed per-bucket), see_more_rate fabrication
(ctr_all*1.5 both server- and client-side — removed; field is now always
null and the copies default metric list/table preset dropped the column);
Copies generatedAt (stamped in meta, rendered as-of line with the
previously swallowed unresolved_filtered_count); anomaly per-entity status
(entityStatus captured at write time inside the stored anomaly JSON — no
schema change — with status_filter threaded route→read and coarse,
fail-open filter semantics in anomalyMatchesStatusFilter; legacy rows
without the field always pass); Launchpad templates/drafts route contract
tests (all 5 untested persistence routes: auth-before-store ordering,
membership-scoped ids, name/payload validation codes, 404-vs-500 mapping,
sanitized error messages) and direct payload-normalizer coverage
(currencyCode ISO gate, objective forcing, goal/event whitelists, creative
dedup/merge, target dedup, copyMode whitelist, minor-unit round-trip);
Copies bucket thumbstop/first_frame_retention now impression-weighted
(rate metrics reconstruct as delivery-weighted means - unambiguous from
the metric's plays/impressions semantics; null when the bucket had no
delivery).

## B. UI-only / design-shell debt (redesign wipes it — do NOT polish now)

- Decision Center: bid overlay display value regex fallback (executable
  amount never comes from display strings); legacy formatCurrency in the
  transient bid notices; "Let cook" label is client-conditional (honest,
  but client-decided); compare drawer visuals. (Drill-drawer KPI header
  moved to structured metrics this pass - no longer debt.)
- Launchpad: hardcoded `$` remains in existing-target budget/pixel preview
  labels; creative selection no longer has this debt. Also
  `window.prompt/confirm` UX; client status bucketing for display.
- Copies: stub export buttons.
- Creative Inbox: unrendered `generatedAt`; utilitarian list styling.
- Legacy `components/meta/*.tsx` cluster (11 components + 5 tests): fully
  dead (zero importers). Delete during the redesign; until then it is inert
  weight only — kept out of the release-authority manifest as of this pass.

## Out of scope by user decision

- **Landing Pages** (`/platforms/meta/landing-pages`): explicitly excluded
  from this Meta readiness mandate by the user (2026-07-06). Findings from
  the survey are preserved for a future mandate without score pressure:
  the scale/keep/investigate rule engine runs client-side and feeds the
  server AI commentary endpoint; payload lacks currency/generatedAt;
  unavailableMetrics unrendered; only the rule-engine unit test exists.
  Not counted against the 10/10 target and not in the active order above.
- **Audiences**: honest ComingSoon placeholder; no debt.

## Acceptance gates for surface-level 10/10 (NON-UI portion)

- Every displayed number traces to a server payload field (no client
  fabrication/derivation), with currency and as-of carried in the contract.
- Every decision/action label traces to a server-computed field guarded by
  an invariant test (Decision Center: done).
- Every lane/feed partition is total (no drop zones) and scope-aligned
  (window/status) or the misalignment is an explicit documented contract.
- Write paths: server-validated, kill-switched, dry-runnable, audited
  (Launchpad + Decision Center: done).
- Route tests for every API surface; contract-drift typed (`satisfies`).
