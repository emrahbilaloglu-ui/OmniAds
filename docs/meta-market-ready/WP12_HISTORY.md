# WP12 — History

Work package: WP12 of `docs/meta-market-ready-master-plan-2026-08-22.md`
Depends on: WP0–WP11
Date: 2026-08-22

## 1. The defect: every ownership act was attributed to the engine

`decision_workflow_events` records acknowledging, deferring, rejecting and
reopening — ownership acts, performed by a person, with `actor_user_id`
recording who. The History journal's branch for that table hardcoded:

```sql
NULL,               -- actor_id
NULL,               -- actor_name
'not_applicable',   -- actor_availability
```

and `actorFor` in `lib/zero-base/meta/history-adapter.ts` renders
`not_applicable` as **"No human actor (engine)"**.

So every workflow event in the audit trail said the engine did it. That inverts
the single fact the row exists to carry, and it is WP12 item 5 exactly:
`not_applicable` is for events that genuinely have no actor.

### Fixed

The branch selects `workflow.actor_user_id` and joins `users`, in the same shape
the briefs and action-log branches already use.

**`unavailable`, not `not_applicable`, when the id no longer resolves.** The FK
is `ON DELETE SET NULL`, so a departed colleague's rows outlive them. "A person
acted and we cannot name them" is a different fact from "no person acted", and
only the second is `not_applicable`. Collapsing them would re-introduce the same
lie in a smaller window.

## 2. The before state was being dropped (item 7)

The row's `detail_json` carried `toState` and `stateVersion`. `toState` alone
says where a decision ended up and hides what it was moved from — half of what
an audit reader needs. It now carries `fromState`, `toState`, `stateVersion`,
`reasonCode` and `actorUserId`.

## 3. A real trap worth recording

The first attempt broke the build: this SQL lives inside a **TypeScript template
literal**, and the explanatory comment contained backticks around identifier
names — which terminate the string. The comment is now backtick-free and a test
asserts the branch stays that way, because the failure mode is a parse error a
long way from the edit.

## 4. Items verified as already correct

| Item | State |
|---|---|
| 1. `replayed` vs `reconstructed` | **satisfied** — `replayed: entry.replay !== null` comes from the read model's own `replay` object, and any replayed row raises a banner that cannot be dismissed |
| 4. observed outcome preserved | **satisfied** — `outcome: entry.status` is the served status word, with the adapter's comment stating it is "not a re-derived one" |
| 6. correlation / identity / provenance / detail | **satisfied** — the SELECT list carries `correlation_status`, `correlation_key`, `correlation_reason`, `account_scope_basis`, `attribution`, `engine_version` and `detail_json` |
| 9. entity and kind filters sent to the server | **satisfied** — `history-client.tsx` sends `outcome` (with the comment "`outcome`, never `label`: they are different columns") and the query travels to the endpoint |
| 12. `event_date` and `occurred_at` not merged | **satisfied** — both are separate columns throughout, and `replay_date` is a third |
| 3. `decision_workflow_events` in the entity-type contract | **satisfied** — the branch is present and carries `entity_type = 'decision'` with `correlation_key = 'decision_key'` |

## 5. Not done in this pass

| Item | Status |
|---|---|
| 2. "snapshot available" used in the right sense | **not audited.** Needs a rendered comparison of the replay panel against real rows |
| 8. five outcome chips rendered separately | **not audited.** A presentation claim about the mounted body; belongs with WP16's mounted visual gate |
| 10. empty state | **not audited** for the same reason |
| 11. "snapshot was not held" stated explicitly | **not audited** for the same reason |

Each of these is a claim about what the rendered surface shows, and confirming
one from a code read would be the kind of inference the plan's evidence classes
exist to prevent. They are recorded as open.

## 6. Acceptance

The plan's WP12 acceptance is **real-DB, read-only**: event-family counts, UI
row counts matching the database, outcome/entity golden tests, and no row
mislabelled as a replay.

**NOT RUN.** All four need database access, which the plan's start-instruction
rule 9 gates behind explicit approval. What is delivered is the actor and
before-state correction, proven at source level and covered by six assertions.

## 7. Gate results

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **PASS** |
| lint | `npx eslint .` | **PASS** |
| unit + integration | `npx vitest run` | **PASS** — 12 586 passed, 0 failed (WP11: 12 580; +6) |

## 8. Rollback

Adapter-local, as the plan asks: the change is one branch of one `UNION ALL` in
`lib/meta/history-read-model.ts`, plus its `LEFT JOIN`. Reverting restores the
previous attribution. No schema change, no migration.
