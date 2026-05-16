# Meta Decision Center - START HERE

This is the first file future Codex/Claude sessions should read before changing
the Meta campaign/adset recommendation model.

## Purpose

The Meta page should operate as a media-buyer decision center. It should explain
what to do, why, what evidence supports it, what is missing, and whether the
recommendation is review-only or automation-ready.

## Canonical Read Order

1. [CONTEXT_SNAPSHOT.md](./CONTEXT_SNAPSHOT.md)
2. [DECISION_LOG.md](./DECISION_LOG.md)
3. [DATA_READINESS.md](./DATA_READINESS.md)
4. [INVARIANTS.md](./INVARIANTS.md)
5. [GOLDEN_CASES.md](./GOLDEN_CASES.md)
6. [PHASE_G_CLOSEOUT.md](./PHASE_G_CLOSEOUT.md)
7. [../creative-decision-center/START_HERE.md](../creative-decision-center/START_HERE.md)

For Creative Decision Center resolver changes, follow the Creative read order in
`docs/creative-decision-center/START_HERE.md` before editing resolver behavior.

## Non-Negotiables

- UI must not compute buyer actions or automation readiness.
- Campaign/adset hard actions require backend evidence: label context, target or
  profit anchor, maturity, fresh data, and blocker checks.
- Missing required data must produce diagnose/watch/review-only output or capped
  confidence.
- Account-history percentiles are benchmarks, not profit targets.
- `target_roas`, `break_even_roas`, `target_cpa`, and `break_even_cpa` are the
  hard-action commercial anchors.
- Main/Test/Mixed labeling is required before hard action semantics can be
  trusted.
- Test campaign promotion semantics may exist in backend payloads, but
  `promote_test_to_main` must not become a primary UI CTA until adoption and
  kind-aware distribution gates are proven.
- Empirical outcome summaries can remove the empirical-evidence blocker only.
  They do not unlock auto-execute without live preflight and rollback proof.
- Unsupported audience, feed, tracking, or placement assumptions must remain
  diagnose/watch, not hard action.
- Update `CONTEXT_SNAPSHOT.md` after every material change.

## Decision Scope

Implemented Phase A-F.4 behavior is closed. Remaining unsupported scenario
families are not hidden debt inside Phase G; they are Phase H or later product
scope because the current warehouse/signal substrate does not support safe hard
actions for them yet.

## Current Phase State

As of Phase G closeout, Phases A through F.4 are implemented and deployed on the
runtime SHA recorded in `CONTEXT_SNAPSHOT.md`. Phase G is a documentation,
verification, deploy-evidence, and context-preservation closeout. It does not
claim that every scenario-library idea is implemented or automation-ready.

Known product limitations after Phase G must stay explicit:

- visible confidence remains heuristic;
- unsupported scenario families remain diagnose/watch or unimplemented;
- auto-execute remains blocked without empirical outcomes, live preflight, and
  rollback proof;
- `promote_test_to_main` remains payload/diagnostic only until UI gates are met.
