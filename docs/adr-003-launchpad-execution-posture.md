# ADR-003 — Launchpad execution posture: gated, PAUSED-only create, separate activation

## Status

**Accepted** — 2026-08-22. Ratified under WP0 of
`docs/meta-market-ready-master-plan-2026-08-22.md`; corresponds to that plan's
§18 row "Launchpad LAUNCH-06/07 → GATED; PAUSED create, activation ayrı".

## Context

Two authorities disagree about whether Meta Launchpad may write to the provider.

The **vendored behavioural contract** says it may not. `lib/zero-base/generated-contracts.ts`
registers the two launch controls as `disabled:LAUNCH-06 launch` and
`disabled:LAUNCH-07 add`; `components/zero-base/launchpad/launchpad-view.tsx`
renders them `aria-disabled="true"`, and
`components/zero-base/interactions/interactions-meta-reports.test.tsx` asserts
that. Read alone, that describes execution as permanently closed.

The **mounted production body** says it may. The real route
`/c/[businessId]/meta/launchpad` mounts
`app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx`, and at line 1854 that
body POSTs to `/api/launchpad/meta/add-to-existing` or `/api/launchpad/meta/launch`
depending on mode. Both endpoints exist, are ~950 lines each, and create real
campaigns, ad sets and ads on Meta. `app/api/launchpad/meta/launch/route.ts`
already sets `status: "PAUSED"` at every create site, and already enforces
business access, reviewer read-only, demo read-only, manual authority,
idempotency-key presence and execution bounds — but **no feature flag gates it**.
The zero-base body that renders the disabled controls is not the body the user
reaches.

So the disabled control is a claim about a screen nobody is served, while the
screen that *is* served can write to Meta. Neither "execution is closed" nor
"execution is open" is currently true, and that ambiguity is what has to be
decided rather than discovered.

## Decision

Launchpad provider execution is **gated**, not permanently closed and not
currently open.

1. **`META_LAUNCHPAD_EXECUTION` is the single execution gate, and it defaults
   to off.** Absent, empty or unparseable means off. Off is the shipped state.
2. **While the gate is off, the execution controls are `disabled-with-reason`.**
   Not hidden, not silently inert, and not removed: the operator sees the
   control, sees why it will not run, and the reason is reachable by keyboard
   and by screen reader. Draft, template, intent and validate keep working in
   full — preparation is not execution.
3. **The server guards are independent of the gate and are never removed with
   it.** Access, reviewer, demo, authority, bounds, idempotency and account
   assignment stay enforced whether the UI gate is on or off. A UI flag that is
   also the server's authorization is not a gate, it is a decoration.
4. **A create may produce only PAUSED entities.** No Launchpad create path may
   result in a delivering entity, and no create may be combined with activation
   in one operation.
5. **Activation is a separate operation** with its own permission, its own
   persisted preflight, its own typed confirmation, its own receipt and its own
   provider read-back. Production activation additionally requires explicit
   owner approval per run; it is not covered by the execution gate alone.
6. **One provider POST per confirmed intent, never retried automatically.** A
   create or duplicate whose outcome is ambiguous is parked for reconciliation.
   It is never reported as success and never reported as a definite failure, and
   a pending reconciliation blocks further writes to the same entity. GET-only
   verification may use bounded retry; writes may not.
7. **The gate may only be turned on after** the master plan's WP0–WP14 are
   accepted, the guarded write sandbox is green, release authority has approved,
   and a dedicated canary ad account exists. WP15 is the work that turns it on.

## Consequences

- The vendored `disabled:LAUNCH-06/07` contract becomes **true of the production
  body** rather than true only of a body nobody mounts. The two authorities stop
  contradicting each other, and they are reconciled by closing the production
  surface to match the contract — not by loosening the contract to match the code.
- Rollback is turning `META_LAUNCHPAD_EXECUTION` off. Because every create is
  PAUSED, entities created before a rollback cannot begin spending; they are
  inert until someone separately activates them.
- Preparation work is unaffected, so the gate costs the operator nothing they
  could safely have done anyway.

## Rejected alternatives

- **Delete the execution routes.** Rejected: it discards ~1 900 lines of
  correct, already-guarded work and would have to be rebuilt for WP15.
- **Leave execution reachable and rely on the server guards.** Rejected: the
  server guards answer *who* may write, not *whether this product is ready to
  write at all*. They cannot express "not yet proven", and a control the operator
  can click is a promise the product has not earned.
- **Hide the controls.** Rejected: hiding makes the product look like it lacks
  the feature and gives the operator nothing to act on. `disabled-with-reason`
  is honest about both the capability and its current state.
