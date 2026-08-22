# WP2 — Canonical surface registry, nav and route contract

Work package: WP2 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0 (`3bf9cd460`), WP1 (`ce05ed234`)
Date: 2026-08-22

## Goal

Stop leaf, route, nav, active-state, command-palette and mounted-body facts
drifting apart by giving them one source.

## 1. What was actually wrong

Five tables each held a partial opinion about the same surfaces, and nothing
forced them to agree:

| Table | Opinion it held |
|---|---|
| `components/layout/nav-items.ts` | rail rows, hrefs, active hrefs |
| `lib/dashboard-v2/screen-registry.ts` | screen ids, `/app` spellings, family rewrites |
| `lib/zero-base/compatibility.ts` | legacy destinations |
| `components/layout/dashboard-frame.tsx` | route-owned surfaces |
| the route files | what actually mounts |

Each was individually green. Together they produced:

1. **`/c/:id/meta/history` resolved to no screen at all.** It fell through to
   the Decisions row's `activeHrefs`, which listed `/platforms/meta/history`, so
   the rail said **Decisions** while the operator was reading History
   (plan §5.1 finding 4).
2. **`/c/:id/meta/intelligence` lit up nothing** — on a route that has existed
   and worked all along (finding 3).
3. **`/platforms/meta/audiences` had two canonical destinations** depending on
   which table you asked (finding 5).
4. **`/platforms/meta/decisions` was a phantom** — present in the legacy→app
   translation table, translated cleanly, and served a 404. Found by the new
   route-existence gate, not by inspection.

## 2. The registry

`lib/meta/surface-registry.ts` states each fact once, with every field the plan
lists: `surfaceId`, `label`, `role`, `canonicalRoute`, `aliases`,
`legacyRedirect`, `mountedBody`, `providerAccountCapability`,
`windowCapability`, `actionCapability`, `gate`, `requiredPlan`, `activeHrefs`,
`railOrder`.

It is **descriptive, not executable**: it grants nothing, authorizes nothing and
mounts nothing. Its value is that `surface-registry.contract.test.ts` (T3) reads
it and all five tables in one run, so drift is a failure rather than a
discovery. Sixteen surfaces are covered — six rail hubs, four Creative Studio
tabs, five sub-surfaces, and the public share.

Two capability fields carry decisions rather than description:

- `windowCapability` implements §8.1–8.2, so a `current_state` surface stops
  showing an active date range it never applies. `surfaceUsesReportingWindow`
  is the single predicate WP5 will consume.
- `providerAccountCapability` implements D6. Every surface is `single_physical`
  except three, and the three exceptions are **stated in the test** rather than
  assumed: the public share carries a frozen token scope, the Shares ledger is
  business-wide, and Integrations decides assignments rather than consuming one.

## 3. The six rail entries — and a correction worth recording

D3 requires six Meta rail rows. The rail had four.

The design file draws four: its own model reads
`metaFam = ['meta','creative','launchpad','automation']`. On that evidence
alone, Account Intelligence and History look like rows invented against the
visual authority.

**They are not.** The vendored behavioural package already carries
`L-C-META-INTEL` (`/c/[businessId]/meta/intelligence`) and `L-C-META-HIST`
(`/c/[businessId]/meta/history`) as navigable Client leaves —
`navGroupsFor("Client")` returns both today. So the two authorities disagree
with each other, and D3 sides with the one that governs behaviour
(`docs/adr-005-visual-vs-vendored-authority.md` rule 2). D1 permits the added
rail row either way.

The rows were missing from the rail, not from the contract. This is pinned by
`backs D3's two added rail rows with the vendored leaf ledger`, so the reason
survives as a test rather than as a paragraph.

Order, per §18: Decisions → **Account Intelligence** → Creative Studio →
Launchpad → Automation → **History**.

### 3.1 Why Intelligence is addressed by its `/app` spelling

Account Intelligence is new in v2 and has no pre-v2 route. Naming
`/platforms/meta/intelligence` would name a 404, and it could not even be made a
compatibility shim: `compatibilityTargetFor` only knows paths the vendored
contract records as *changed*, which this never was.

So its rail href is `/app/meta/intelligence`, and
`dashboardHrefForRouteFamily` was extended to recognise the `/app` spelling.
That extension fixes a real scope bug: an href with no legacy key previously
passed through **unchanged**, so clicking Intelligence from
`/c/biz_1/meta/decisions` navigated to `/app/meta/intelligence`, which
re-scopes from `session.activeBusinessId` — potentially a **different
business**. That is the plan's rollback trigger 1, and
`keeps a /c/:businessId visitor inside their own business scope` now asserts
every Meta rail href stays inside `/c/biz_1/` when clicked from there.

The same reasoning covers Creative Briefs and Creative Shares, which are
sub-surfaces with no rail row: their `/app` spellings are listed as the Creative
Studio hub's `activeHrefs`, so opening a brief no longer drops the whole Meta
group's active state.

## 4. D4 — `navigation.ts` is an oracle, never the renderer

Already true at runtime: `components/zero-base/shell/client-shell.tsx`, the only
consumer of `navGroupsFor`, is not mounted by any production layout — both
`app/c/[businessId]/layout.tsx` and `app/app/layout.tsx` mount
`UnifiedDashboardClientShell`.

WP2 makes it *guaranteed*: `is not imported by any production layout or route`
greps `app/**` and fails on any non-test import. Containment is the right rule
rather than agreement, because the two disagree on purpose — the ledger is a
frozen inventory, the rail is the shipped product, and forcing them to match
would mean editing the vendored package, which §17.1 forbids.

The oracle now covers **every** registry surface except three, and the three are
enumerated rather than skipped: `creative-audiences` (the ADR-004 divergence),
`creative-detail` (dynamic id, so `isNavigable` excludes it) and
`public-creative-share` (unauthenticated, outside the client nav).

## 5. T4 — route existence, as an assertion

`lib/meta/surface-routes.test.ts` resolves URLs the way the App Router does —
walking `app/`, preferring concrete segments over `[param]` ones, treating
`(group)` directories as invisible and letting `[[...catchall]]` swallow the
rest. Verified to answer `null` for `/platforms/meta/decisions`,
`/platforms/meta/intelligence` and `/totally/bogus/path`, so it can actually
fail.

It covers all 42 cases: every canonical route, alias and legacy spelling; every
rail href in all three route families; and every command-palette jump target.

Existence of the `/app` catch-all is deliberately **not** treated as
sufficient — an alias the catch-all's dispatch table does not list falls through
to `notFound()`, which is a 404 behind a 200-shaped route file, so the table's
contents are asserted separately.

## 6. Changes

| File | Change |
|---|---|
| `lib/meta/surface-registry.ts` | **new** — the single registry |
| `lib/meta/surface-registry.contract.test.ts` | **new** — T3, 19 cases |
| `lib/meta/surface-routes.test.ts` | **new** — T4, 42 cases |
| `components/layout/nav-items.ts` | six Meta rows; History removed from Decisions' active hrefs; Briefs/Shares added to the Creative hub's |
| `components/layout/v2/nav-model.ts` | Meta platform family recognises both new screens |
| `lib/dashboard-v2/screen-registry.ts` | two screen ids, five route entries, `/app` href recognition; phantom `/platforms/meta/decisions` removed |
| `lib/i18n.ts` | two navigation labels |
| `components/zero-base/meta/{intelligence,history}` | `data-screen-label` on the surface roots |
| `components/dashboard-v2/screen-label-coverage.test.ts` | the two new screens |
| `components/layout/nav-items.test.ts`, `lib/dashboard-v2/screen-registry.test.ts` | updated to the six-row / twenty-screen reality, with the reason recorded |

## 7. Acceptance

| Plan acceptance item | Result | Evidence |
|---|---|---|
| Six rail entries | PASS | `carries D3's six rail entries in D3's order`; `agrees with the rail adapter on the Meta group` |
| Five Creative tabs | PASS | `carries D3's five Creative Studio tabs` |
| Correct active state on canonical, `/app` and legacy paths | PASS | `lights exactly one Meta rail row per rail surface, in all three families` — exactly one row, and the platform group stays lit |
| All navigable leaves reachable | PASS | `lib/meta/surface-routes.test.ts`, 42 cases |
| Zero 404s | PASS | same; the resolver is verified to reject phantoms |
| Rail hierarchy and row style unchanged | PASS | rows use the same `ShellNavItem` shape, icon vocabulary and group; no layout, card or hierarchy change |

## 8. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 467 passed, 144 skipped, 63 todo, **0 failed** (WP1: 12 403; +64) |

## 9. Runtime evidence

**UNKNOWN.** Everything above is **VERIFIED-STATIC**. No authenticated session
and no hosted render were exercised. The active-state and route-existence claims
are proven against the same functions the shell calls and the same files the
router resolves, which is the strongest static evidence available, but it is not
`VERIFIED-RUNTIME`.

## 10. Rollback

The nav commit is revertible on its own, as the plan requires. Within it:

- reverting `nav-items.ts` alone restores the four-row rail; the registry and
  its tests then fail, which is the intended signal rather than silent drift;
- the registry and its two test files are additive — deleting them removes the
  gate and nothing else;
- the `screen-registry.ts` change is additive except for the phantom
  `/platforms/meta/decisions` row, whose removal cannot regress anything because
  no route ever served it.
