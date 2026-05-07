# Phase 05 Command Center & Team Workflow V1

> Live release posture for this surface now lives in `docs/v3-01-release-authority.md` and `/api/release-authority`.
> This document remains a design and contract reference.

## Scope
- Phase 05 adds an operator workflow layer on top of shipped Phase 03 Meta Decision OS and Phase 04 Creative Decision OS.
- Deterministic decision engines remain the source of truth for action candidates, evidence, guardrails, and operating-mode semantics.
- Command Center does not perform ad-platform write-back.

## Product Surface
- New route: `/command-center`
- New API root: `GET /api/command-center`
- New workflow mutations:
  - `PATCH /api/command-center/actions`
  - `POST /api/command-center/actions/note`
  - `GET /api/command-center/journal`
  - `GET|POST|PATCH|DELETE /api/command-center/views`
  - `GET|POST|PATCH /api/command-center/handoffs`

## Workflow Layer
- Queue sources:
  - Meta ad set decisions
  - Meta budget shifts
  - Meta geo decisions
  - Meta placement exception-review items
  - Creative primary decisions
- Watchlist-only sources:
  - Meta no-touch items
  - Creative `hold_no_touch`
- Supported workflow states:
  - `pending`
  - `approved`
  - `rejected`
  - `snoozed`
  - `completed_manual`
  - `executed`
  - `failed`
  - `canceled`
- `executed` remains reserved for Phase 06. Phase 05 does not use write-back or execution outcomes.

## Guardrails
- `Recommendations`, `Decision Signals`, and `AI Commentary` wording split remains unchanged on source surfaces.
- `Operating Mode`, Meta `Decision OS`, and Creative `Decision OS` semantics remain deterministic and read-only.
- Command Center overlays workflow state; it does not mutate decision-engine payloads.
- `/platforms/meta/copies` is untouched in this phase.
- Export/share truth remains unchanged.

## Persistence
- Additive tables:
  - `command_center_action_state`
  - `command_center_action_journal`
  - `command_center_saved_views`
  - `command_center_handoffs`
- `command_center_action_state` is keyed by `(business_id, action_fingerprint)`.
- `client_mutation_id` is unique per business in `command_center_action_journal` to keep mutation paths idempotent under the DB retry wrapper.
- GET routes never create queue or journal rows. Missing workflow state resolves to an ephemeral `pending` overlay.

## Source Surface Integration
- Meta account/campaign detail now includes a read-only Command Center entry card with workflow counts and a deep link.
- Creative detail now shows the current workflow badge/assignee state for the creative plus a deep link into Command Center.
- Source surfaces keep full mutation controls out of Meta and Creative pages.

## Saved Views
- Built-in immutable shared views:
  - `today_priorities`
  - `budget_shifts`
  - `test_backlog`
  - `scale_promotions`
  - `fatigue_refresh`
  - `high_risk_actions`
  - `no_touch_surfaces`
  - `geo_issues`
  - `promo_mode_watchlist`
- Custom views are shared at business scope in V1. Personal/private views are out of scope.

## Handoffs
- Fixed shifts:
  - `morning`
  - `evening`
- Handoffs carry summary, blockers, watchouts, linked action fingerprints, sender, optional recipient, and acknowledgement state.
