# v-next ENGINE_VERSION Package (prepared 2026-07-06 night)

One consolidated next-version deploy decision. All three label-affecting
changes are ALREADY quantified on live data - there is no evidence left to
wait for. Bundling them into a single ENGINE_VERSION bump costs one
clean-epoch day (hysteresis memory reset + outcome-accrual restart) instead
of three.

## The three changes and their measured live impact (2026-07-06, 1602 decisions)

| Change | Today's label impact | Direction |
|---|---|---|
| Stale hard-action ceiling (>7d feed age -> diagnose) | 11 published cuts -> diagnose; ALL on Tiles Workshop's dead feed (17d stale); 5 more already guard-demoted; zero healthy-feed impact | strictly conservative |
| Disjoint winner-memory (fatigue) | 37/1602 creatives flip the memory bit (every one nested=true -> disjoint=false: live proof of the double-count defect); at most ~10 fatigue statuses soften (watch->none / fatigued->watch) | strictly conservative |
| CAMPAIGN_CONTEXT_MODE=automatic | 22/1602 decisions change; every one an unblocked hard action behind a missing manual label (top: 137K-spend winner at 162% of target freed to scale); interplay: 4 Tiles unblocked cuts get re-demoted by the stale ceiling in the same version | unblocking (reviewed row list) |

Reproduce: scripts/creative-decision-center/head-vs-deployed-decision-diff.ts
(stale ceiling rows = the allowed-badge set),
disjoint-winner-memory-materiality.ts, automatic-mode-decision-diff.ts.

## Evidence basis (no future dates required)

- 35-day daily-grid simulation of context hysteresis under production
  semantics; live day-1 wave passed same-day (14/14, no collapse).
- Full-window historical replay of the deployed engine (490 business-days,
  0 failures) with matched suppressed-day scoring.
- Live seam proofs: decision-label memory (1602/1602 raw_label through the
  production reader) and context state round-trip (95 states, counters
  intact) - plus both seams under real Postgres in CI-runnable form.
- HEAD-vs-deployed gate green: pending commits change no label/confidence.
- The previously-recommended "7 consecutive live shadow days" was extra
  caution, not evidence: the daily-grid simulation covers 35 days of the
  same semantics. Waiting remains available but adds no new information
  class; the user may waive it explicitly.

## Deploy procedure (single decision - IMPLEMENTED, push-button)

The code is DONE on branch `vnext-2026-07` (commit bb25f7ee), on top of the
16-commit main batch:
- Both label flips implemented with tests; full suite 3544 green in that
  tree; typecheck + lint clean; ENGINE_VERSION = v3-2026-07-07-vnext-stale-fatigue.
- Decision-diff gate run against the 2026-07-06 live fixture: exactly 11
  label changes (all Tiles dead-feed cuts -> diagnose), 0 confidence
  changes, 41 badge removals all being cut-specific badges dropping off
  demoted rows, nothing added. GS goldens and the 72-case canonical set
  unchanged.
- Note: the fatigue swap's decision effect materializes through the next
  lifecycle computation (fatigueStatus is computed upstream of decisions);
  live estimate remains <=10 conservative softenings from 37 bit flips.

Remaining steps on approval (Codex):
1. Merge `vnext-2026-07` into main after the main batch is pushed.
2. Set CAMPAIGN_CONTEXT_MODE=automatic on both hosts (env-only; rollback =
   unset).
3. Push + standard deploy; day-1 runbook applies (clean-epoch wave expected).
4. Rollback: revert merge + unset env; prior-version snapshots intact.

## Operator pre-flip checklist (optional, improves day-one labels)

Override candidates where the resolver honestly disagrees with manual
labels: IwaStore "Test Kampanyası -30 Nisan" (behaves main, named test),
EMOLOS EMB-17Jun-Permanent pair (naming contradicts behavior), TheSwaf
TS_F5K 365D_Winner_Retest + Core_Value_ReligiousDuality (resolver main,
manual mixed).
