# WP16 / WP17 — Reachability gate and screen-view telemetry

Work packages: WP16 and WP17 of
`docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP14
Date: 2026-08-22

## 1. WP16 item 4 — reachability by module graph, not by grep

The plan is explicit: *"Import graph AST veya module graph ile doğrulanır; grep
tek başına yeterli değildir."* The reason is concrete — this plan found **three**
bodies that are written, tested, and reachable by nobody:

| Body | How it surfaced |
|---|---|
| `components/zero-base/meta/decisions/decisions-client.tsx` | held the **only** caller of the decision-workflow endpoint (§5.1 finding 14, fixed in WP8) |
| `components/zero-base/manage/manage-clients.tsx` | the only consumer of `saveProviderAssignments`, mounted by nothing (found in WP3) |
| `components/creatives/briefing/CreativesBriefingPage.tsx` | renders a hardcoded "Spend today" nobody can see (found in WP5) |

A grep cannot tell these apart from live code: a module can be imported by a
test, by a sibling that is itself unmounted, or by a barrel nothing pulls, and
all three look like "it is imported".

`scripts/meta/verify-mounted-bodies.ts` walks the real import graph from every
`page` / `layout` / `route` file under `app/`, following relative and
`@/`-aliased specifiers **including dynamic `import()`**, and checks every
`mountedBody` the WP2 registry declares.

**Test files are not roots and are not followed.** A body reachable only from a
test is precisely the defect.

Result: **15 / 15 registry bodies reachable.**

### 1.1 The gate is proven to fail, not just to pass

A gate that cannot distinguish anything is not a gate.
`verify-mounted-bodies.test.ts` asserts in both directions:

- the three production bodies from the §11 matrix **are** reached;
- `manage-clients.tsx` and `CreativesBriefingPage.tsx` **are not**.

If either of those ever becomes reachable the test fails, which is the right
signal both ways: either it was mounted deliberately (and the list should
shrink) or something started pulling a dead body into the bundle.

Available as `npm run meta:verify-mounted-bodies`.

## 2. WP17 telemetry — `screen_view` was unmeetable, not merely unmet

WP17's first requirement is "her mounted Meta yüzeyi screen_view". The vendored
leaf ledger declares `event: "screen_view"` for **every** leaf. The runtime
vocabulary in `lib/product-instrumentation.ts` had **no such event name**, and
no `meta_intelligence` or `meta_history` surface — so nothing could emit one and
nothing the two new rail rows did could be attributed to them.

Three changes, and the repo's own gates forced all three to land together:

1. `screen_view` added to the event vocabulary, and the two surfaces to the
   surface allowlist.
2. The `product_instrumentation_events` CREATE TABLE CHECK constraints widened
   to accept them. (The v2 upgrade path already accepted all three — they come
   from the vendored ledger — so only the fresh-install path was narrower.)
3. A real emitter, because `product-instrumentation-emitters.test.ts` refuses a
   declared event with no emitter file, and `product-instrumentation.test.ts`
   refuses a vocabulary entry the database CHECK does not allow.

Those two gates are why this could not be half-done, and they are worth
recording as working exactly as intended.

### 2.1 Emitted from the shell, keyed on the registry

`components/layout/v2/meta-screen-view.tsx` is mounted once by `DashboardFrame`
and resolves the surface from the pathname through the **WP2 registry**, so it
cannot drift from the surfaces that exist.

Two reasons it is not emitted per body:

- The rule that makes the number mean anything — **once per surface and
  business, not once per render** — belongs in one place. Five bodies each
  calling `emitProductInstrumentation` would each own that rule, and the first
  to get it wrong would inflate its own count with its own loading states.
- The surfaces that most needed it, Account Intelligence and History, do not
  receive `businessId` at all. Threading one through two component signatures
  and their routes purely for telemetry would make each of those files harder to
  read for a reason none of them is about.

A path the registry does not know **emits nothing**, rather than falling back to
a real surface name — attributing a view to the wrong screen is worse than not
counting it.

## 3. What WP16 and WP17 do NOT claim

| Item | Status |
|---|---|
| WP16 1–3: harness renders the mounted bodies; visual/a11y/responsive/fidelity gates retargeted | **NOT DONE.** These need the Playwright harness rebuilt against the production route DOM. It is the largest single piece of remaining work and needs a running app to verify |
| WP16 5–6: dead zero-base modules moved to `_reference`, then deleted | **NOT DONE.** The reachability gate now *identifies* them, which is the prerequisite. Moving them is a separate change with its own tsconfig and test implications |
| WP16 9–10: re-vendor; REQ-27 / REQ-28 / REQ-41 closed | **NOT DONE.** These close only when the design owner ships an export regenerated at a single fingerprint (`ACCEPTED_RESIDUALS.md`'s own unlock condition). Not something application code can do |
| WP17: the other 48 contracted events | **NOT AUDITED.** Only `screen_view` is addressed |
| WP17 a11y, responsive 320/390, performance LCP/CLS/TBT | **NOT MEASURED.** Every one is a runtime measurement. Individual a11y improvements did land as side effects of WP1, WP5 and WP8 — `aria-disabled` with `aria-describedby` instead of `disabled` on three separate controls, and the 12px readable-type floor honoured on the new workflow control — but a *measured* a11y or performance pass was not run |
| WP17 security | **PARTIAL.** WP9 closed a real token-leak path (a Graph URL inside an error message reaching the client) and pinned it with a whole-payload assertion. Tenant isolation, CSRF and rate limiting were not re-audited |

## 4. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 600 passed, 0 failed (WP14: 12 590; +10) |
| migrations from zero | `npm run test:migrations-from-zero` | **PASS** — schema builds from zero and is idempotent |
| schema upgrade seam | `npm run test:schema-upgrade-seam` | **PASS** |
| mounted-body reachability | `npm run meta:verify-mounted-bodies` | **PASS** — 15/15 |

The two migration gates were run **because** this change widened a CHECK
constraint. A schema change shipped without them would be exactly the kind of
unverified work the plan's evidence classes exist to prevent.

## 5. Rollback

Harness and module changes are separate commits, as the plan asks. Here:

- the reachability script and its test are additive — deleting them removes the
  gate and nothing else;
- `<MetaScreenView />` is one line in `DashboardFrame`; removing it stops the
  emission with no other effect;
- the vocabulary and CHECK widening are **additive** (a widened allowlist
  accepts every previous value), so reverting them is safe as long as no
  `screen_view` row has been written — after that the constraint must stay
  widened, which is the normal forward-compatibility rule for an allowlist.
