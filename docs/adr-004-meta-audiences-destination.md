# ADR-004 — `/platforms/meta/audiences` resolves to Creative Studio Audiences

## Status

**Accepted** — 2026-08-22. Ratified under WP0 of
`docs/meta-market-ready-master-plan-2026-08-22.md`; corresponds to that plan's
§18 row "Audiences destination → Creative Studio Audiences" and its binding
decision D5.

## Context

Two in-tree authorities give the legacy path `/platforms/meta/audiences` two
different canonical destinations.

The **generated contract** merges it into Intelligence.
`lib/zero-base/generated-contracts.ts:716` attaches
`legacy: [{ route: "/platforms/meta/audiences", mode: "merged" }]` to leaf
`L-C-META-INTEL` (`/c/[businessId]/meta/intelligence`).

The **compatibility table** sends it to Creative Studio.
`lib/zero-base/compatibility.ts` special-cases exactly this one route and
rewrites its canonical URL to `/c/[businessId]/creative/audiences`, with a
comment explaining that Dashboard v2 restored Audiences as the fifth Creative
Studio view and that the archived package predates that screen.

Both statements are in the shipped build, and they cannot both be the
destination. Meanwhile the destination the compatibility table names is real:
`app/c/[businessId]/creative/audiences/page.tsx` mounts
`app/(dashboard)/platforms/meta/audiences/legacy-page.tsx`, the same body the
legacy path itself renders through `compatibilityPage`. The Intelligence screen
has no Audiences section that could receive the traffic.

This is the master plan's §5.1 finding 5. Leaving it unresolved means the active
rail entry, the redirect and the command palette can each pick a different
answer, which is exactly the drift WP2's registry exists to prevent.

## Decision

`/platforms/meta/audiences` **resolves to `/c/[businessId]/creative/audiences`**,
the Creative Studio Audiences tab.

1. Creative Studio Audiences is the canonical destination for the legacy path,
   for the rail's active state, for the command palette and for redirects.
   There is one answer and every navigation surface reads it.
2. Account Intelligence keeps its **own** canonical route,
   `/c/[businessId]/meta/intelligence`. It is not the audiences destination and
   does not claim to be. Intelligence may present audience-derived *evidence*
   inside its own sections; that is analysis, not the Audiences screen.
3. The generated contract is **not hand-edited** to agree. It is a vendored
   artifact and the master plan's §17 forbids editing one to make a check pass.
   The divergence stays visible, is recorded here and in
   `docs/zero-base-design/v3/ACCEPTED_RESIDUALS.md`, and is corrected upstream at
   the next re-vendor.
4. WP2's surface registry is where this decision is expressed once in code.
   Until then, `compatibility.ts` keeps the override and its comment now cites
   this ADR by number.

## Consequences

- The `mode: "merged"` record in the generated package becomes a **known stale
  fact about an older screen inventory**, not an instruction. It predates
  Dashboard v2 restoring Audiences, which is a design change, not a package bug.
- Anyone following an old `/platforms/meta/audiences` link reaches a screen that
  actually renders audiences instead of a screen that never had them.
- Rollback is deleting the override in `compatibility.ts`, which restores the
  generated destination. That is a one-hunk revert and touches no data.

## Rejected alternatives

- **Follow the generated contract and send the path to Intelligence.** Rejected:
  the destination has no Audiences content, so an operator following a real link
  would land nowhere useful. It also contradicts the visual authority, which
  draws Audiences as the fifth Creative Studio tab, and §3 of the plan puts the
  visual file above the vendored package on questions of what a screen *is*.
- **Edit `generated-contracts.ts` so the two agree.** Rejected outright by §17.1
  and §17.2 of the plan: the generated package is vendored, and editing it to
  turn a check green destroys the only independent record of what the design
  package actually said.
- **Serve both — redirect by role or plan.** Rejected: two destinations for one
  path is the drift this ADR exists to end.
