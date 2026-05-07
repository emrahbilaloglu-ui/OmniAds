# Google Control Model Prep

Date: `2026-04-20`

## Goal

Prepare a Google rollout plan that reuses the Meta control model primitives without starting Google implementation in this phase.

## Repo Map

### Control-plane primitives

- `lib/sync/release-gates.ts`
  - canonical deploy/release gate record model
  - persisted gate verdicts, blocker classes, scope, mode
- `lib/sync/provider-status-truth.ts`
  - canonical provider progress/activity/truth model
  - blocker reasons, repairable actions, stall fingerprints, lease-plan evidence
- `lib/sync/repair-planner.ts`
  - canonical dry-run repair-plan model
  - recommendation shape and safety classifications

### Meta implementation of the model

- `app/api/meta/status/route.ts`
  - Meta status route
  - already composes provider truth, gate records, repair plan, page readiness, integration summary
- `lib/meta/page-readiness.ts`
  - Meta-specific readiness rollups
- `lib/meta/integration-summary.ts`
  - Meta-specific integration card semantics
- `lib/sync/meta-canary-remediation.ts`
  - Meta-only remediation execution path

### Google implementation today

- `app/api/google-ads/status/route.ts`
  - Google status route
  - computes Google truth from warehouse, advisor, queue, retention, and status-machine logic
- `lib/platforms/google/status-machine.ts`
  - Google-specific status state transitions
- `lib/platforms/google/status-types.ts`
  - Google status payload contract
- `lib/sync/platforms/google-sync.ts`
  - Google sync engine, queue, leases, retries, throughput, repair helpers
- `app/(dashboard)/platforms/google/page.tsx`
  - current Google route is a redirect to `/platforms/google`

## Current Data Flow

### Meta

1. Runtime/sync evidence is collected.
2. `provider-status-truth` derives activity/progress/blocker semantics.
3. `release-gates` persists deploy/release gate verdicts.
4. `repair-planner` emits dry-run repair recommendations.
5. `/api/meta/status` merges provider truth + control-plane + Meta UI readiness into one response.

### Google today

1. Warehouse/sync/advisor evidence is collected.
2. `lib/platforms/google/status-machine.ts` derives Google page state.
3. `/api/google-ads/status` serves provider-specific readiness and queue truth.
4. Google does **not** yet appear to be wired into the shared deploy/release gate + repair-plan control-plane surface.

## Meta Primitives To Reuse As-Is

These should be ported with the same contract, not redesigned.

1. `release-gates.ts`
   - deploy gate vs release gate split
   - persisted verdict shape
   - blocker class vocabulary
2. `provider-status-truth.ts`
   - progress/activity/truth derivation
   - blocking reasons
   - repairable action vocabulary
   - stall fingerprints
3. `repair-planner.ts`
   - dry-run repair-plan record
   - recommendation contract
   - safety classification
4. runtime/control-plane identity
   - exact current-build persistence
   - build/environment/provider scoping
5. report-only post-deploy release authority verification
   - keep as report/verification primitive
   - do not make Google-specific deploy behavior broader than Meta

## Meta Primitives Not To Port Directly

These are provider-specific or incident-specific and should not be copied wholesale.

1. `meta-canary-remediation`
   - Meta-only proof/remediation flow
2. `meta-watch-window`
   - Meta-specific closure process
   - only reintroduce a Google watch window if Google later needs the same operational ceremony
3. Meta integration-summary/page-readiness semantics
   - `recent window`, `extended surfaces`, `selected-range ending today` logic is Meta-specific
4. Meta repair actions
   - `replay_dead_letter`, `stale_lease_reclaim`, `integrity_repair_enqueue`, etc. may map conceptually, but action selection must remain provider-specific

## Google Gaps Against The Control Model

1. Google status is currently provider-local.
   - It has a status route and status machine.
   - It does not appear to expose shared `deployGate`, `releaseGate`, and `repairPlan` surfaces inside the Google route.
2. Google state decisions are currently centered on:
   - queue health
   - advisor readiness
   - historical rebuild posture
   - selected-range readiness
   rather than the shared control-plane records.
3. Google already has strong internal primitives:
   - warehouse health
   - queue health
   - status machine
   - retention/advisor gates
   These should be adapted into the shared control model rather than replaced.

## Recommended Handoff Plan

### Phase 1 — Mapping only

Goal:
- identify how Google evidence maps onto shared control-plane inputs

Tasks:
1. Map Google queue/warehouse/advisor evidence into `provider-status-truth` inputs.
2. Define which Google blocker conditions become shared blocker classes:
   - worker unavailable
   - queue blocked
   - stalled
   - not release ready
3. Define Google canary/business sample set for future validation.

Exit:
- one agreed mapping table from Google evidence to shared truth fields

### Phase 2 — Gate wiring

Goal:
- wire Google into shared deploy/release gate persistence without changing existing Google UX yet

Tasks:
1. Compute Google provider truth using shared truth primitives.
2. Persist Google deploy/release gate rows using `release-gates.ts`.
3. Produce Google dry-run repair-plan rows using `repair-planner.ts`.

Exit:
- Google has control-plane records independent of UI rollout

### Phase 3 — Status route alignment

Goal:
- align `/api/google-ads/status` with shared control-plane output

Tasks:
1. Merge shared gate/repair-plan truth into Google status payload.
2. Preserve Google-specific page/advisor semantics where they are genuinely provider-specific.
3. Keep provider-local labels, but stop inventing a second control truth.

Exit:
- Google status has one control truth instead of a separate local one

### Phase 4 — UI alignment

Goal:
- expose Google control truth safely in UI

Tasks:
1. Update integration card and Google page surfaces to read aligned truth.
2. Keep heavy analysis/manual actions explicit, not page-load blocking.
3. Avoid reintroducing Meta’s old “preparing loop” class of bug.

Exit:
- Google UI reflects the same control model as the backend

## Initial Acceptance For Google Prep

Google implementation should not start until these prep conditions are accepted:

1. Shared primitive inventory is frozen:
   - gate model
   - provider truth model
   - repair-plan model
2. Google evidence-to-truth mapping is documented.
3. Provider-specific logic that must stay local is explicitly listed.
4. No Meta-only primitive is copied into Google by default.

## Non-Goals In This Phase

- no Google implementation patch
- no Google deploy workflow changes
- no Google remediation workflow
- no UI behavior changes
- no new watch-window process

## Default Recommendation

Start Google with the smallest safe slice:

1. truth mapping
2. gate persistence
3. repair-plan persistence
4. status route alignment
5. UI only after backend truth is proven

This keeps Google on the Meta control model without repeating Meta’s cleanup cycle.
