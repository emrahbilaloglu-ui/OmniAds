# Claude Decision Math Review Prompt - 2026-07-02

You are Claude Code working in `/Users/harmelek/Adsecute`.

The user explicitly asked that Claude Code also perform this analysis in the
visible Claude desktop application chat. This is not a CLI-only task.

## Task

Produce an independent theoretical review of the Creative Decision Center
decision math and formulas for Adsecute.

You may create exactly one report file:

`/Users/harmelek/Adsecute/docs/creative-decision-center/CLAUDE_DECISION_MATH_REVIEW_2026-07-02.md`

Do not modify code. Do not modify tests. Do not create commits. Do not run
migrations. Do not mutate DB/provider/live systems. Read-only shell commands and
tests are allowed if needed.

## Required Read Order

First read:

1. `docs/creative-decision-center/START_HERE.md`
2. `docs/creative-decision-center/DECISION_LOG.md`
3. `docs/creative-decision-center/DATA_READINESS.md`
4. `docs/creative-decision-center/GOLDEN_CASES.md`
5. `docs/creative-decision-center/INVARIANTS.md`

Then review the current branch implementation, especially:

- `lib/creative-decision-engine/engine.ts`
- `lib/creative-decision-engine/config-values.ts`
- `lib/creative-decision-engine/spend-unit-resolver.ts`
- `lib/creative-decision-engine/account-decision-profile.ts`
- `lib/creative-decision-engine/maturity.ts`
- `lib/creative-decision-engine/ratio-zones.ts`
- `lib/creative-decision-engine/gates/types.ts`
- `lib/creative-decision-engine/gates/diagnose.ts`
- `lib/creative-decision-engine/fatigue.ts`
- `lib/creative-decision-engine/funnel.ts`
- `lib/creative-decision-engine/outcome-classifier.ts`
- Relevant producer/outcome jobs if needed.

Do not read Codex's new report before writing yours:

`docs/creative-decision-center/DECISION_MATH_THEORETICAL_REVIEW_2026-07-02.md`

After your report is written, you may read that Codex report only to add a
short final section named `Review of Codex Report`, where you say which points
you agree with, disagree with, or think are missing.

## Project Constraints

- Product name is `Adsecute`.
- Be candid and evidence-first.
- If data is missing, say what is unknown.
- Do not recommend UI computing `buyerAction`.
- Do not recommend row-level `brief_variation`.
- Do not recommend a new standalone decision core unless you explicitly say it
  would require a new ADR in `DECISION_LOG.md`.
- Do not recommend deleting V1/operator/V2 snapshot compatibility without a
  migration plan.
- Do not rename routes.
- Keep changes small and rollbackable.

## Questions To Answer

1. What formulas and thresholds exist today, and what assumptions do they encode?
2. Which assumptions are defensible theoretically?
3. Which assumptions are weak, unreachable, under-measured, or likely to create
   biased decisions?
4. Where could historical data or generated scenario data help?
5. Where would historical/generated data be insufficient?
6. What should be fixed first before claiming the decision math is close to
   10/10?

## Required Report Structure

Use this structure:

1. Evidence Boundary
2. Formula Map
3. Strengths
4. Findings Ranked by Severity
5. Historical Data and Scenario Backtest Plan
6. Review of Codex Report
7. What Not To Change Yet
8. Recommended Next Phases

The report should be detailed enough for the user to inspect and object to.
Avoid generic praise. Praise only if backed by code or tests.
