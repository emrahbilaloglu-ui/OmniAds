# ADR D070 — The decision as-of date must be scoped by creative account keys, not by a column that does not exist

**Status:** **Accepted** — ratified into `DECISION_LOG.md` as **D070** on 2026-08-22.
**Date:** 2026-08-08 (drafted) · 2026-08-22 (ratified)
**Supersedes:** nothing. **Relates to:** D013 (date-range replay), findings G0-F2 and G0-F3.

> **Ratified.** This file is no longer a draft. `DECISION_LOG.md` ended at **D069**, so
> **D070** was the next free number exactly as predicted, and the decision is now recorded
> there under that number. The log entry is the authority; this file remains the long-form
> rationale behind it. Do not renumber, and do not treat a future edit to this file as
> changing the ratified decision — that requires a new log entry.

## Context

`resolveWorkspaceEndDate` in `app/api/meta/decisions-workspace/route.ts` resolves which
snapshot day the Decisions workspace answers for. It runs two lookups, and both filter
`engine_v3_decision_snapshots_daily` on `provider_account_id`:

```sql
FROM engine_v3_decision_snapshots_daily
WHERE business_id::text = $1
  AND provider_account_id = $2
```

That table has no such column. Its DDL (`lib/migrations.ts`) identifies rows by `creative_id`
and scopes them with `scope_type` / `scope_id`; the canonical route to a provider account is
the `creative_account_keys` → `creative_account_scope` join already used by
`lib/meta/history-read-model.ts`. No migration adds the column anywhere.

Consequences on the deployed build (`0bcf1fbf5`):

1. Both lookups always raise `42703 undefined_column`.
2. Both were swallowed by bare `catch {}` blocks that attributed the failure to a
   schema/capability gate. Slice C3 (`4f37ac663`) now classifies and logs the cause, so the
   failure is visible, but the behaviour is unchanged.
3. The first query places the broken branch in a `UNION ALL` with two branches that would
   work (`engine_v3_ad_decision_snapshots_daily`, `engine_v3_job_runs`), so the error takes
   those down with it.
4. The resolver therefore always falls through to `previousUtcDate()`. Whenever the newest
   snapshot is not exactly yesterday, the workspace asks for a day with no rows and the
   operator sees empty lanes with no error — the "a failed request never collapses into no
   data" rule breaking in production. This is also the direct cause of the full-UI visual
   gate failing at baseline (G0-F2): the seeded decision row is never reached.

## Decision

Scope the `engine_v3_decision_snapshots_daily` lookup by creative account keys, matching the
join `history-read-model.ts` already treats as canonical, instead of by a non-existent column.

Specifically:

- Replace `AND provider_account_id = $2` with an `INNER JOIN` against a `creative_account_scope`
  CTE derived from `meta_creative_dimensions` ∪ `meta_creative_daily`, keeping the existing
  `HAVING COUNT(DISTINCT provider_account_id) = 1` guard so a creative that appears under more
  than one account is excluded rather than attributed to one arbitrarily.
- Leave `engine_v3_ad_decision_snapshots_daily` and `engine_v3_job_runs` branches untouched;
  they already filter on columns those tables have.
- Keep the `previousUtcDate()` fallback for the genuinely-absent-data case, and keep C3's
  cause classification so a future failure is still visible.

## What changes for a user

The workspace resolves the newest day for which decisions actually exist for the selected
account, instead of always assuming yesterday. Where the newest snapshot *is* yesterday —
the common healthy case — nothing changes. Where it is not, lanes that were silently empty
will populate.

## Explicitly not changed

- Date-range replay semantics (D013). `metricsRangeAffectsDecisionSnapshot` stays `false`;
  this ADR changes only which day is resolved when no explicit end date is supplied, never
  whether a metric range re-scopes a decision snapshot.
- No decision label, authority, risk tier or provider eligibility is affected. This is a date
  lookup, not a resolver of decision content.
- No new decision core, and no change to the engine.

## Risk and rollback

Risk is that a newly-reachable snapshot day surfaces decisions that were previously invisible.
That is the intended correction, but it is a visible change in what an operator sees, which
is why it is gated behind this ADR rather than shipped as a bug fix.

Rollback is a one-line revert of the predicate; no data migration is involved and no persisted
state changes.

## Required evidence before ratification

1. Golden coverage asserting the resolver's contract (added alongside this ADR).
2. Invariant coverage asserting the query references only columns the schema declares.
3. `migrations-from-zero` green.
4. The full-UI visual smoke passing, which currently fails at baseline for this reason.
5. Owner ratification into `DECISION_LOG.md` under the next free number.

Items 1–4 are producible locally and are attached to this branch. Item 5 is the owner's.

## Ratification record (2026-08-22)

Item 5 is closed: the decision is recorded in `DECISION_LOG.md` as **D070**.

The predicate this ADR asks for was **already implemented** in the tree at HEAD
`843b6e9c8` before ratification — `resolveWorkspaceEndDate` in
`app/api/meta/decisions-workspace/route.ts` builds the `creative_account_keys` →
`creative_account_scope` CTE from `meta_creative_dimensions` ∪ `meta_creative_daily`,
carries the `HAVING COUNT(DISTINCT provider_account_id) = 1` exclusion guard, leaves the
`engine_v3_ad_decision_snapshots_daily` and `engine_v3_job_runs` branches filtering on
their own real columns, and keeps the `previousUtcDate()` fallback with C3's cause
classification. It cites this ADR by number in the query comment.

So ratification changes no code. What it changes is standing: before 2026-08-22 a
`Proposed` ADR was being cited by the UX remediation ledger as settled authority, which is
the master plan's §5.1 finding 8 and its §17 prohibition 20 ("treating an unratified ADR as
resolved"). That gap is now closed in the correct direction — by ratifying the decision the
code already implements, not by loosening the rule.
