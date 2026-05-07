# Creative Date-Range Invariance Audit

Last updated: 2026-04-24 by Codex

## Scope

This pass audited whether the Creative page's selected reporting date range can mutate primary Creative operator segments.

The product rule remains:

- reporting range may change visible reporting rows and reporting metrics
- reporting range must not re-authorize or mutate the same creative's primary operator segment
- `decisionAsOf`, the primary Decision OS window, and explicit benchmark scope are the decision-authority inputs

## Reproduction

User-observed UI counts:

| Segment | Last 14 days | Last 30 days |
| --- | ---: | ---: |
| Scale | 0 | 0 |
| Scale Review | 0 | 0 |
| Test More | 5 | 5 |
| Protect | 4 | 4 |
| Watch | 8 | 9 |
| Refresh | 2 | 2 |
| Retest | 0 | 0 |
| Cut | 0 | 0 |
| Campaign Check | 0 | 0 |
| Not Enough Data | 9 | 11 |

The observed totals differ by three rows. That shape is consistent with the selected reporting range changing the visible row set.

A production-equivalent private trace was run against the sanitized business alias `company-03` with the same benchmark scope and two reporting ranges.

| Field | Last 14 days | Last 30 days |
| --- | --- | --- |
| decisionAsOf | `2026-04-23` | `2026-04-23` |
| primary Decision OS window | `2026-03-25` to `2026-04-23` | `2026-03-25` to `2026-04-23` |
| visible rows | 16 | 16 |
| Decision OS rows | 16 | 16 |
| shared Decision OS rows | 16 | 16 |
| same-creative segment changes | 0 | 0 |

Sanitized segment counts in that trace:

| Segment | Last 14 days | Last 30 days |
| --- | ---: | ---: |
| Scale | 0 | 0 |
| Scale Review | 0 | 0 |
| Test More | 4 | 4 |
| Protect | 1 | 1 |
| Watch | 0 | 0 |
| Refresh | 4 | 4 |
| Retest | 0 | 0 |
| Cut | 0 | 0 |
| Campaign Check | 0 | 0 |
| Not Enough Data | 6 | 6 |

## Root Cause

No same-creative segment mutation was found in the traced runtime path.

The actual ambiguity was UI scope:

- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` fetches table/reporting rows for the selected reporting range.
- `buildCreativeQuickFilters()` receives `visibleIds` from the currently visible table rows.
- quick-filter counts therefore represent the current visible reporting set, not the global invariant Decision OS distribution.
- the UI did not explicitly say that, so count changes could look like segment reclassification.

The primary operator decision path is already anchored separately:

- `lib/creative-decision-os-source.ts` resolves provider-backed `decisionAsOf` and the primary 30-day decision window.
- `buildCreativeDecisionOs()` receives those decision windows and uses selected reporting dates for historical/selected-period analysis only.
- existing and added tests cover that lifecycle, primary action, operator segment, push readiness, action fingerprint, and evidence hash remain stable when only reporting dates change.

## Fix

No Creative policy or threshold logic changed.

Changes made:

- top Creative segment filter copy now states that counts follow the visible reporting set while row segments use the Decision OS window
- top filter buttons now expose an accessibility label that says the count is for visible rows in the current reporting set
- Decision Support quick-filter copy now states that counts follow the current visible reporting set and row segments remain anchored to the Decision OS window
- added deterministic tests for visible-set quick filter counts and UI copy

## Validation Notes

Targeted tests confirm:

- same creative + same `decisionAsOf` + different reporting dates keeps the same primary segment
- selected-period analysis can still reflect reporting dates
- quick-filter counts can change with `visibleIds`
- the UI now labels segment-filter counts as visible reporting-set counts

## Remaining Risks

If a future live trace shows the same creative changing primary segment with identical `decisionAsOf` and identical benchmark scope, that would be a separate correctness bug in the Decision OS source path and should block acceptance.

This pass found a visible-count scope bug, not a policy-threshold bug.
