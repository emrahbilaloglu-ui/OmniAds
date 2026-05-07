# Sync Control Plane Product Readiness And Google Ads Runtime

Last updated: 2026-04-21

## Goal / Scope

This document is the durable engineering handoff for the current sync platform.
It records:

- the control-plane architecture that is now authoritative in production
- what was closed to reach product-ready Meta + Google control-plane/self-heal posture
- how incidents, repair plans, and repair executions relate to each other
- the current worker/runtime layering and why `consumeBusiness` still exists
- the user-visible versus operational sync truth contract
- the current Google Ads runtime bottleneck and the acceptance bar for fixing it
- the throughput philosophy for the Hetzner-hosted stack
- future non-blocking rollout notes for Shopify, GA4, and Search Console

This document does not replace the ADRs or provider-specific truth matrices. It
connects them into one operational picture.

## Current Control-Plane Architecture

The sync platform now runs with one canonical operational control plane:

- `sync_incidents`
- `sync_repair_plans`
- `sync_repair_executions`
- provider-scoped deploy / release gates
- provider-scoped runtime registry

Operational truth is expected to agree across:

- `GET /api/build-info`
- provider status routes
- cron control-plane evaluation
- worker runtime repair loop
- admin sync-health surfaces
- user-visible sync helpers

### Canonical vs derived

Canonical:

- `sync_incidents`
- deploy/release gate records
- worker/runtime registry
- provider queue/checkpoint/warehouse state tables

Derived / read-model:

- `sync_repair_plans`
- release readiness summaries
- user-visible sync state
- most dashboard pills and progress summaries

Append-only audit:

- `sync_repair_executions`

## Product-Readiness Closure Reached So Far

The recent product-readiness work closed the following cross-provider issues:

- incident-driven control-plane state now exists and is durable
- deploys now fail if incident migrations are missing or unverifiable
- provider status routes and `build-info` consume incident-based truth instead of
  repair-plan count alone
- incident identity is stable across queue-depth / lease-count drift
- auto-repair is bounded by cooldown, retry budget, incident lock, and
  postcondition verification
- `half_open` is active, and repeated identical failures can move to
  `quarantined`
- stale running repair executions are finalized rather than left as fake
  in-progress rows
- user-visible sync truth and operational sync truth are separated
- `consumeBusiness` remains available only as a bounded compatibility path

These changes were intentionally generic. No positive business-specific overrides
were introduced for TheSwaf, Grandmix, IwaStore, or any other business.

## Incidents, Repair Plans, And Repair Executions

### `sync_incidents`

This is the canonical operational state for recoverable sync problems.

Lifecycle:

- `detected`
- `eligible`
- `repairing`
- `cooldown`
- `half_open`
- `cleared`
- `quarantined`
- `exhausted`
- `manual_required`

Meaning:

- an incident represents one stable fault identity
- it is the source of truth for operational sync posture
- it owns bounded retries, cooldowns, and circuit state

### `sync_repair_plans`

This is a read model / recommendation surface.

Meaning:

- what the planner believes should happen next
- not the canonical operational truth
- can be empty while incidents are still cooling down or quarantined

### `sync_repair_executions`

This is append-only audit.

Meaning:

- every bounded auto/manual repair action produces an execution row
- execution rows record preflight, action, outcome, and verification evidence
- execution rows do not replace incident state

## Worker / Runtime Layering

Current production runtime is still hybrid by design:

1. outer worker/runtime orchestration
2. provider-specific runtime execution

### Outer runtime owns

- business scheduling
- runner lease / heartbeat
- incident lifecycle
- repair supervision
- cooldown / retry-budget enforcement
- control-plane truth emission
- guaranteed inclusion and prioritization of release-canary businesses in the
  worker batch, even when the nominal business limit would otherwise trim them

### Provider runtime owns

- queue generation
- partition leasing
- fetch / transform / write
- publication / finalize / verification
- provider-specific recovery capabilities

### Why `consumeBusiness` still exists

`consumeBusiness` was not removed because Meta and Google still use provider
runtime logic for real queue planning, leasing, and partition execution.

Current rule:

- it is a bounded compatibility fallback
- it must not create a second operational truth
- it must not bypass incidents, gates, or postcondition semantics
- it must remain observable
- it does not replace batch prioritization; release canary businesses must be
  present and ordered before this fallback even becomes relevant

The goal is not to keep `consumeBusiness` forever. The goal is to keep one
authoritative control loop while the provider runtimes still own real execution.

## Incident States And Their Meaning

- `repairing`: one bounded repair is executing now
- `cooldown`: a failed repair or recently applied repair is waiting before the
  next attempt
- `half_open`: the cooldown window expired and one bounded probe attempt is
  allowed
- `exhausted`: the retry budget is spent and automatic attempts are paused
- `quarantined`: repeated identical failures crossed the bounded strike window;
  keep this internal and operator-visible, not user-alarming

These states must never be overwritten back to `eligible` by derived planner
reconciliation alone. Incident reconciliation must preserve active lifecycle
state.

## User-Visible Truth Vs Operational Truth

The system has two truth layers and both are intentional.

### User-visible sync truth

Allowed states:

- `healthy`
- `refreshing_in_background`
- `using_latest_available_data`
- `setup_required`
- `reconnect_required`
- `data_unavailable`

Rules:

- recoverable incidents with a usable last-good snapshot should not show scary
  sync failure UI
- auth/setup/reconnect/no-snapshot/manual-required states must remain visible
  and honest
- user-facing `Ready` labels must not imply a false global green state

### Operational truth

Operational/admin surfaces must continue to expose:

- exact blocker class
- incident lifecycle state
- cooldown / circuit posture
- open incident count
- degraded serving
- queue / checkpoint / lease evidence

No fake healthy state is acceptable. Heartbeats and “last touched” timestamps
must not be mistaken for real progress.

## Snapshot-First Degradation

If a usable last-good snapshot exists:

- serve the latest available data
- keep background refresh internal
- suppress recoverable sync noise on user surfaces

If there is no usable snapshot:

- show setup / reconnect / unavailable truth honestly

This rule applies to Meta today and must continue to apply to Google.

## Current Google Ads Problem Statement

The Google Ads control plane and self-heal loop are no longer the primary
problem. The remaining Google problem is runtime throughput and progress truth.

### What is already true

- the Google control plane can publish incident/gate truth
- repair plan mode is `auto_execute`
- Google status and `build-info` can surface provider-scoped control-plane data
- self-heal is bounded and incident-driven

### What is still wrong

Google can look operationally quiet or even superficially healthy while making
little or no meaningful forward progress.

The key failure modes observed before the current fix set:

1. **Hidden extended execution suppression**
   - Google extended/recent work could remain effectively disabled behind an old
     global reopen posture instead of real runtime safety conditions.

2. **Priority historical deadlock**
   - full-sync priority could require historical recovery
   - but the same runtime also blocked historical extended work while the wider
     recent-90 window was incomplete
   - result: no queue, no leases, no movement

3. **False progress from sync-state refresh**
   - `latestBackgroundActivityAt` and `latestSuccessfulSyncAt` were being
     refreshed even when no real partition work or new successful sync had
     happened
   - this created heartbeat-only progress signals and could leak into release
     truth

### 2026-04-21 runtime closure update

The Google user-facing and operational layers now explicitly split core serving
readiness from historical / visible backfill:

- `Core ready` means account and campaign serving data is usable.
- historical/full coverage percentage is rendered as `Historical backfill` or
  background progress, not beside the core-ready stage.
- status routes expose additive `backgroundBackfill` and `runtimeProgress`
  diagnostics.
- heartbeat-only worker activity is not considered progress. If backfill is
  incomplete and there is no queue drain, useful lease, checkpoint movement,
  successful scope sync, or ready-through/publish movement in the observation
  window, the internal state is classified as stalled through queue/starvation
  fingerprints.

Meta attention leakage was also tightened at the integration-card layer:

- exact control-plane closed + usable data suppresses stale provider-local queue
  or dead-letter attention on user surfaces.
- admin/internal surfaces still keep exact queue, dead-letter, incident,
  cooldown, and repair history.
- completed sync does not mean no future maintenance queue; maintenance queues
  can reopen, but they must not be presented to end users as failures while
  serving truth remains healthy.

### Why Google is the next focus

Meta already behaves materially better under the current architecture:

- core data reaches useful completion quickly
- breakdown flow is healthy
- queue/drain behavior is operationally smoother

Google must now reach the same practical standard:

- real queue generation when recovery is needed
- real lease conversion into useful work
- real checkpoint / publish movement
- bounded, truthful incidents
- no silent stall

## Performance Philosophy

Optimize Google sync for the real platform we run now:

- self-managed Hetzner DB
- current Google Ads API quota contract
- safe write / publish / verify semantics

Do not preserve overly conservative assumptions from the old Neon era.

The target philosophy is:

- use the maximum safe throughput the system can actually support
- do not add retries as a substitute for real scheduling fixes
- do not treat heartbeats as progress
- only widen concurrency or batching when runtime evidence says the system is
  under-utilized

### Practical throughput rules

- prefer fixing admission / fairness / queue generation before increasing knobs
- if DB is the bottleneck, batch and narrow transaction scope
- if quota is the bottleneck, keep scheduling honest and bounded
- if no queue exists, the first fix is planning/admission, not worker count

## Acceptance Standard For Google Sync

Google is only considered operationally improved when all of the following are
true:

1. work is actually created when coverage is missing
2. useful work is actually leased
3. checkpoints or publication truth advance meaningfully
4. heartbeat-only activity is not counted as health
5. incidents stay bounded and truthful
6. Meta does not regress
7. no business-specific override is introduced

### Live validation checklist

Use at minimum:

- `npm run google:ads:diagnostic-snapshot -- <businessId>`
- `npm run google:ads:throughput-probe`
- `npm run google:ads:lease-eligibility -- <businessId>`
- `npm run google:ads:progress-diff -- <businessId> <sinceIso>`
- `npm run google:ads:state-check -- <businessId>`
- `npm run ops:sync-effectiveness-review`
- public `GET /api/build-info?providerScope=google_ads`
- public `GET /api/build-info?providerScope=meta`

Treat repeated heartbeat-only timestamps without any of the following as
non-progress:

- queue drain
- checkpoint advance
- ready-through movement
- publication/finalization movement
- successful scope progression

## Known Risks

- Google still uses provider-specific execution internals, so regressions must
  be tested against real data, not only unit tests
- control-plane green does not automatically prove warehouse throughput is good
- status routes can drift if they use “last touched” fields instead of verified
  progress signals
- fallback compatibility paths must remain fenced to avoid a second truth source

## Non-Goals

- no business-specific positive overrides
- no hiding real auth/setup/no-data/manual-required failures
- no broad rewrite of the provider runtimes unless the repo proves it is
  necessary
- no new public endpoint unless an existing route cannot carry the contract
  safely
- no Google implementation that regresses Meta behavior

## Follow-Up Provider Rollout Notes

The same product-readiness standard should later be extended to:

- Shopify
- GA4
- Search Console

That future rollout is intentionally non-blocking for this task.

2026-04-21 Shopify kickoff update:

- Shopify rollout has started with a bounded compatibility-path hardening pass
- initial fixes made Shopify status historical-readiness checks null-safe and
  scope-aware so missing historical state cannot report as fully ready
- Shopify historical backfill now defaults on for stores with `read_all_orders`,
  while `SHOPIFY_HISTORICAL_SYNC_ENABLED=false` remains an explicit opt-out
- historical chunking moved from a conservative 14-day default to 30 days and
  GraphQL root page size moved to a bounded 250 to reduce API round-trips
- page-limit truncation now fails explicitly instead of writing false success
- Shopify sync-state date normalization now preserves local calendar dates from
  database `date` objects, preventing ready-through drift
- follow-up throughput pass converted order, line, refund, return,
  transaction, and sales-event writes from per-row upserts to JSONB batch
  upserts; runtime-validation row tracing remains available when explicitly
  requested
- default historical drain now processes up to 3 bounded chunks per run
  (`SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN`, capped at 6), so one worker cycle
  advances more than one month without requiring unsafe long unbounded loops
- live TheSwaf validation moved a 30-day historical chunk from roughly 516s
  before batch writes to roughly 59s after batch writes, then completed
  historical coverage through 2026-04-20 with `status=ready`
- live Grandmix and IwaStore validation used the same generic path and advanced
  3 historical chunks each without business-specific overrides

Expected future work:

- move those adapters onto the same incident-canonical control-plane standard
- preserve snapshot-first user serving
- keep one operational truth across build-info, provider status, cron, and
  worker
- reuse bounded repair semantics instead of inventing provider-specific control
  loops

## Cross-References

- [ADR-001 Legacy-First Sync Control Plane](/Users/harmelek/Adsecute/docs/adr-001-sync-control-plane.md)
- [Google Ads Product Truth Matrix](/Users/harmelek/Adsecute/docs/platforms/google-product-truth-matrix.md)
- [Sync Effectiveness Review](/Users/harmelek/Adsecute/docs/sync-effectiveness-review.md)
- [Google Control Model Prep 2026-04-20](/Users/harmelek/Adsecute/docs/google-control-model-prep-2026-04-20.md)
- [Serving Write Ownership Map](/Users/harmelek/Adsecute/docs/architecture/serving-write-ownership-map.md)
- [Serving Runtime Validation Evidence](/Users/harmelek/Adsecute/docs/architecture/serving-runtime-validation-evidence.md)
