# WP6 — Shared response/state contract and data readiness

Work package: WP6 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP5
Date: 2026-08-22

## 1. What landed

`lib/meta/read-state-contract.ts` holds three things that were previously
implicit or duplicated:

- **§9's seven read states** — `loading`, `refreshing-with-stale`, `success`,
  `empty-proven`, `partial`, `degraded`, `refused`.
- **§9's nine mutation states** — `validating` … `ambiguous-reconciliation-required`.
- **§9.1's failure-code dictionary** — all twenty codes, each with an operator
  sentence, the surface state it produces, and whether the operator can resolve
  it themselves.

Plus `MetaResponseEnvelope<T>`, the §6 shape (`scope` / `evidence` / `data` /
`capability` / `permissions` / `failure` / `state`), generic over the payload so
a surface keeps its own data type while every surface agrees about the rest.

### 1.1 Why a second grammar beside `lib/zero-base/state-types.ts`

That one is a **component** grammar: what a cell, a chart or a control renders.
This is a **surface** grammar: what the whole screen is doing, and it draws
three distinctions the component grammar does not need.

- `empty-proven` vs `degraded` — a read that succeeded and found nothing, and a
  read that failed. Both show no rows; one means "there is nothing here", the
  other "we do not know what is here", and the operator's next action differs
  completely. Collapsing them is D8.
- `partial` vs `success` — presenting a served subset as the whole is how a
  total silently becomes wrong.
- `refreshing-with-stale` vs `loading` — blanking readable evidence to a
  skeleton throws away data to show a spinner.

### 1.2 Two rules enforced on the copy itself

`metaFailureMessage` returns **null** for an unrecognised code rather than a
generic sentence. Inventing a reassuring default is how an unknown failure
becomes a known-looking one; the caller has to decide what to say about
something the contract has never heard of.

And a test asserts that no message for a **failed read** contains "no data",
"is empty" or "nothing to show". That is D8 enforced on the words, not just on
the state machine — those are the exact sentences that turn a broken source into
a data fact on someone's screen.

### 1.3 Centralised, additively

`automation-view.tsx` now chains its local dictionary → the shared contract →
its general fallback. The local wording stays first because it names the four
values the operator is looking at, which a shared sentence cannot. But a code
the screen has never heard of no longer falls straight to "Automation could not
be read" when the contract already has a sentence for it — which is how an
expired connection was reported as an unexplained read failure.

## 2. The honest scope of the contract test

The Meta and Launchpad API surface emits **110 distinct** `code: "..."` values.
§9.1 names twenty as a **floor** ("En az"), and eight of those twenty are
actually emitted today. The other ninety-odd are narrow blocker and lineage
codes that never reach an operator as a surface state.

An earlier draft of the test required all 110 to be contracted. That would
assert a rewrite nobody agreed to, and it would say more about the test's
ambition than about the product. The test now asserts the invariant that
protects the operator:

1. **Where a §9.1 code is emitted, the surface can speak for it.** A contracted
   code with no dictionary entry renders raw or renders nothing.
2. **The uncontracted count is held below a recorded ceiling (102).** A
   *ratchet*, not a target: it fails when the uncontracted set grows, forcing
   "does this new code need an operator sentence?" at the moment someone adds
   it rather than when an operator meets it. Lower it when a batch is
   contracted; never raise it without a reason in the same commit.

## 3. Items already satisfied — verified, not rewritten

| Item | State | Where |
|---|---|---|
| 4. missing schema does not produce 200 + empty | **satisfied** | assignment and automation paths return `503 schema_not_ready` with `missingTables`; the Integrations drawer's `degraded` state (WP3) covers the read side |
| 5. provider permission failure does not become an empty list | **satisfied** | `ProviderSnapshotFailureClass` carries `auth` / `scope` / `permission` / `quota` through to the drawer's `degraded` state (WP3 §4) |
| 6. source freshness and partial coverage in the payload | **satisfied** | `ProviderAccountSnapshotMeta` already carries `sourceHealth`, `stale`, `refreshFailed`, `failureClass`, `lastKnownGoodAvailable` and the trust fields |
| 8. V1/operator/V2 snapshot compatibility | **satisfied** | preserved; nothing in WP0–WP6 deletes a compatibility path |
| 11. no blind cap increase or destructive cleanup | **satisfied** | `lib/sync/db-growth-fence.ts` records that retention "deletes history, so it is an operator decision, not a default", and the 5 GiB ceiling carries its own derivation (~200 rows/day measured) |

## 4. Not done, and why — stated rather than skipped

| Item | Status |
|---|---|
| 3. API and client response keys verified in **one** contract test | **partial.** The envelope type exists and is the target shape. No surface has been migrated onto it yet, because migrating a surface's response shape belongs with that surface's own work package (WP8–WP12), and doing it here would rewrite bodies twice |
| 7. additive migrations tested from-zero and on upgrade | **NOT RUN.** `npm run test:migrations-from-zero` and `test:schema-upgrade-seam` need an ephemeral Postgres. Not executed in this session |
| 9. `meta_entity_state_history` query plan, index, retention, capacity | **UNKNOWN.** Needs production-read-only DB access, which the plan's start-instruction rule 9 gates behind explicit approval. The *code* side is already hardened: per-table budgets, a per-provider (not global) refusal on a single-table breach, and the 2026-08-08 collateral-outage fix are all in `db-growth-fence.ts` with their incidents recorded |
| 10. 30/90-day growth forecast | **UNKNOWN.** Same reason — it is a measurement, and no measurement was taken |

Items 9 and 10 are measurements, not code. Writing a forecast without running
one would be the kind of claim this plan exists to prevent.

## 5. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 536 passed, 0 failed (WP5: 12 525; +11) |
| migrations from zero | `npm run test:migrations-from-zero` | **NOT RUN** — needs ephemeral Postgres |
| real DB read-only | — | **NOT RUN** — needs explicit approval |

## 6. Rollback

Additive. `read-state-contract.ts` is new and imported in exactly one place so
far; deleting the import restores Automation's previous two-level fallback.
Nothing depends on the envelope type yet.
