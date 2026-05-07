# V2-06 Command Center Throughput & Workflow Intelligence

This document is the accepted V2-06 workflow baseline layered on top of the shipped V2-05 Command Center and Phase 06 execution preview surfaces.

## Scope

- keep deterministic decision sources authoritative
- keep `Recommendations`, `Decision Signals`, and `AI Commentary` wording split unchanged
- keep Command Center execution preview/apply contracts unchanged
- add bounded queue throughput, operator workload visibility, structured feedback, and retry-safe status-only batch actions

## Contract Additions

`command-center.v1` remains the public contract version. V2-06 is additive only.

- every action now carries `throughput`
- the response now includes `throughput`, `ownerWorkload`, `shiftDigest`, `viewStacks`, `feedbackSummary`, and `feedback`
- apply/rollback preview contracts stay unchanged

## Default Queue Policy

- only `action_core` items in `pending`, `approved`, or `failed` state are queue-eligible
- total budget: `12`
- quotas: `critical=4`, `high=4`, `medium=3`, `low=1`
- unused quota rolls forward through the sorted actionable backlog
- watchlist and archive lanes never enter the default queue
- overflow count and selected fingerprints are returned by the API and rendered directly in the UI

## Priority And SLA

- priority score stays deterministic
- base weights: `critical=100`, `high=80`, `medium=55`, `low=35`
- confidence, failed state, unassigned state, and high-risk tags increase urgency
- degraded commercial truth reduces urgency
- age anchor is `lastMutatedAt ?? createdAt ?? decisionAsOf@00:00Z`
- SLA targets: `critical=4h`, `high=24h`, `medium=72h`, `low=168h`

## Workflow Additions

- owner workload is derived from the actionable queue without new write paths
- shift digest is derived from queue selection, workload hotspots, overflow, degraded truth, and queue-gap feedback
- saved views render in fixed stacks: `Run now`, `Optimize`, `Watch`, `History`, `Custom`
- action-level feedback supports `false_positive` and `bad_recommendation`
- queue-gap feedback supports `false_negative` without linking to an existing action
- status-only batch actions support `approve`, `reject`, `reopen`, and `complete_manual`

## Idempotency And Safety

- feedback, batch child mutations, single-action mutations, and notes all use persisted mutation receipts
- idempotency no longer depends only on `lastMutationId`
- no route-to-route internal HTTP was added
- GET/read routes remain side-effect free

## Source-Surface Clarity

- Meta deep links now preserve `campaignId`
- Meta page hydrates and syncs `selectedCampaignId` from the query string
- Creative deep-link behavior remains on the existing `creative` query model

## Non-Goals

- no execution subset expansion
- no change to `/platforms/meta/copies`
- no change to rollout flag posture for apply/rollback
