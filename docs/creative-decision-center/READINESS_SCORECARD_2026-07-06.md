# Creative Decision Center — Readiness Scorecard (2026-07-06)

Mandate: raise every readiness component to >=8/10 on evidence, or record an
honest, unavoidable blocker. Scores are joint Claude assessments against live
evidence (prod DB read-only checks on 2026-07-06), the historical replay
(2026-06-01..07-02), and the test suite (3507 passing, typecheck + lint clean).

| Component | Before | After | Status |
|---|---|---|---|
| Pipeline / data | 9 | 9 | held |
| Formula / math | 6.5 | 8 | hysteresis + F2 clamp, now with full-window replay evidence |
| Segmentation (D033) | 5.5 | 7.5 | daily-grid production-hysteresis simulation done; live day-1 = operational confirmation only |
| Measurement / backtest | 4 | 8 | ECE fixed + adversarially-reviewed historical simulation of the new engine |
| UI / operator contract | 4 | 8 | raised this session |
| Explainability | 7 | 8 | raised this session |
| QA / golden | 7 | 8 | suite green incl. new flip fixtures + invariant scans |
| Release / ops | 6 | 6.5 | image-tag env drift remains P1 ops debt |

## Historical simulation addendum (2026-07-06, after the initial scorecard)

Per the user's direction, the remaining time-gated evidence was produced by
simulating the new engine over existing history instead of waiting.

**Measurement 7.5 → 8.** The historical replay harness (contract v2) now
chains the production hysteresis causally per business over
2026-06-01..07-05 (14 businesses, 490 business-days, 0 failures) and scores
realized outcomes from forward historical aggregates. The methodology
survived a 3-lens adversarial review; confirmed defects were fixed before
the evidence run: an inverted dedupe comparator (pre-existing harness bug -
production keeps the highest-priority computation), a structurally-zero
round-trip metric replaced by reversal-within-3-observations, resolution
categories restricted to next-calendar-day evidence, and delay exposure
measured as next-day spend. Headline results:
- Hard reversals within 3 observations: 76 raw → 20 published (**-73.7%**);
  hard transitions 272 → 183 (-32.7%).
- Of resolved suppressions, 18.7% were pure noise absorbed; the rest
  confirmed one day later (the designed cost: one-day delay).
- Matched suppressed-day scoring (identical forward windows, symmetric
  censoring): 46 flip-right vs 41 hold-right - single-day flip signals are
  ~coin-flip, which is precisely why two-evaluation confirmation is correct.
- Delay exposure: 89 suppressed cut days with 7,547 next-day spend under
  historical operator policy (non-causal), scale delays 21 days / 771.
- Hard-bucket weighted ECE: 0.14 published vs 0.19 raw on 7d windows - both
  far above the 0.05 automation-readiness gate. **The auto-execution gate
  stays closed on evidence, not on missing evidence.** Live 2026-07-10
  outcomes remain as confirmation, not as the primary proof.

**Segmentation (D033) 7 → 7.5.** The weekly shadow artifact's alarming
temporal findings (32/71 stale-kind divergence, pinned high-class flips)
were traced by adversarial review to the shadow's analysis-only hysteresis
(skipped nulls = indefinite pinning; lookahead). The shadow now runs the
production applyDailyHysteresis on a daily grid with per-date sequences
persisted. Real picture: final divergence 2/71; kind-to-kind published churn
on spending campaigns is rare (~5 campaigns, <=2 flips in 35 days); the
residual is unknown/conflict days - cold-start maturation, honest
naming-vs-behavior conflicts (IwaStore "Test Kampanyası -30 Nisan", EMOLOS
Permanent pair - operator-override candidates), and TS_F5K family
evidence-floor oscillation (7/22 unresolved days on the largest spenders).
The guard is conservative in exactly those classes. Pre-automatic-mode
gates are now named and quantified; the remaining live item (does the cron
wave run operationally) is confirmation, not discovery.

## What changed this session (all local, NOT pushed)

### Formula / stability (6.5 → 8)
- **Hard-label hysteresis** (`lib/creative-decision-engine/decision-stability.ts`):
  a transition crossing the hard boundary (cut/scale on either side) publishes
  only after the raw label holds two consecutive evaluations; the suppressed day
  republishes yesterday's label with a `pending_transition` badge. `raw_label`
  column persisted for one-day memory. Applied identically in the decisions job
  and the live briefing route so surfaces never diverge.
- Evidence: the three live flip creatives of 2026-07-04..06 are named test
  fixtures (IwaStore 946471284944193 scale→keep→scale, TheSwaf 1962656064410174
  cut→keep→cut, Tiles 25889037484086563 keep→cut→keep) — all publish stable
  labels with exactly one suppressed pending day; genuine sustained transitions
  confirm after one held day.
- **F2 cut-boundary clamp**: `CUT_BOUNDARY_RATIO_CLAMP = 1.0` caps
  `bottomQuartileRatio` so curve grading can never mark an above-breakeven
  creative as cut (ratio-zones, both usages; regression-tested).
- **PAUSED advisory badges**: `resume_candidate` (scale on PAUSED),
  `confirm_kill` (cut on PAUSED). Known residual: `CAMPAIGN_PAUSED`/
  `ADSET_PAUSED` statuses coerce to null in CreativeInput, so those rows do not
  get the badge — documented follow-up, not silent.
- `ENGINE_VERSION` bumped to `v3-2026-07-06-decision-stability` (snapshots, job
  dedupe, and backtest windows are version-keyed; the new version starts a clean
  hysteresis epoch).
- Deliberately skipped: a separate neutral band around the cut boundary — the
  hysteresis rule already absorbs boundary oscillation; adding a band on top
  would double-damp and hide genuine sustained transitions for an extra day.

### Measurement / backtest (4 → 7.5)
- **ECE polarity defect fixed**: `computeExpectedCalibrationError` pooled hard
  and non-hard rows whose `realizedOutcome` polarity is opposite (for hard rows
  "positive" validates the action; for non-hard rows it flags a missed action).
  A confident, correct keep registered as near-maximal calibration error,
  making the automation-readiness gate unpassable by construction. Now hard-only;
  non-hard risk remains separately gated by `highSeverityMissedOpportunityRate`.
- Locked by test: adding confident correct keeps no longer changes ECE;
  no-known-hard-rows returns null.
- Remaining to 8: the fix is validated on fixtures and the historical window.
  Live 7-day outcome accrual for the new engine version completes 2026-07-10 —
  physically time-blocked, runbook is the day-1 check script plus the backtest
  summary at that date.

### UI / operator contract (4 → 8)
- **One decision language end-to-end.** The briefing action filter
  (`cardMatchesActionFilter`) now reads the server-supplied decision-center row
  (`buyerAction` / `executionAction`) when present; legacy substring matching
  survives only as fallback for rows without a decision-center row.
  `add_existing` stays legacy by design (launchpad workflow action, no
  decision-center equivalent). Written as comparisons only — the invariant scans
  ("UI must not compute buyerAction") still pass.
- **Asset library split-brain closed**: the label filter and the CSV export both
  resolve the same label the table cell displays
  (`resolveAssetLibraryRowLabel` / `rowEffectiveDecisionLabel`), keyed on the
  same `decisionCenterUiEnabled` flag. Buyer actions project into DecisionLabel
  space for filtering (protect→keep, watch_launch→test_more, fix_*→diagnose).
- **Evidence drawer**: stale "shadow surface" copy removed (decision center is
  the published surface); new server-fields-only "Decision basis" section
  renders `targetRoas`, `ratioToTarget`, `truthSource`, and per-predicate
  blockers (observed vs threshold, severity). Section omitted entirely when the
  payload has none of the fields — no derived values.
- Documented next slice (not blocking 8): footer `executionAction` CTA wiring;
  v3/evidence debug routes intentionally stay raw (documented as the un-hysteresis
  view).

### Explainability (7 → 8)
- Calibration honesty copy: when `empiricalSampleSize` is null or < 30 (mirrors
  the server's reliable-sample default), the explainability panel states
  "Calibration not proven … directional, not proof" instead of letting
  precision/recall/ECE numbers imply validated confidence.

### Segmentation D033 (5.5 → 7, then time-blocked)
- Resolver + trust classes + family-prefix inheritance deployed behavior-neutral
  at 61ce475a. Validation on Grandmix: 13/16 active-labeled resolved, 7/7 high
  trust, 0/38 false-Test.
- **Honest blocker**: the first scheduled context wave runs 2026-07-07 03:00 UTC.
  Day-1 evidence (`scripts/creative-decision-center/campaign-context-day1-check.ts`,
  read-only) cannot exist before then. Score rises past 7 only on that evidence.

### QA / golden (→ 8)
- Full suite 3507 passing; typecheck and lint clean. New coverage: 10
  hysteresis tests (3 named live flips), F2 clamp, PAUSED badges, ECE hard-only,
  filter/CSV/drawer/calibration-copy UI tests. Invariant + golden-case source
  scans pass unchanged (guards were not weakened; UI code was restructured to
  comply).
- On the flip-activating commit, promote the three named flip sequences into the
  golden-case set.

## Honest blockers (cannot be closed by more work today)
1. **D033 day-1 evidence** — first wave 2026-07-07 03:00 UTC. Run the day-1
   check script after it; watch for unresolved-collapse and producer regressions.
2. **Live outcome window for the new engine version** — 7d outcomes complete
   2026-07-10. Until then, measurement is proven on replay + fixtures only.
3. **Release/ops** — APP_IMAGE_TAG env drift (compose reads `.env`) remains the
   recurring P1; owned by the deploy lane (Codex), not fixable from this repo
   slice.

## Deploy gate (unchanged)
This session's commits are local only. Push = deploy; that decision stays with
the user/Codex flow with the standard gates: ENGINE_VERSION bump (done),
goldens green (done), rollback = revert commit + previous engine version
snapshots remain intact under their own version key.


## 10/10 pass addendum (2026-07-06, final)

Directive: implement every identified fix and report where the scores land.
All work local (14 commits ahead of deployed 61ce475a), NOT pushed. Gates:
3529 tests, typecheck, lint, 13-agent adversarial pre-deploy review (every
critical/major independently verify-confirmed and fixed), final historical
replay regenerated against the shipped code.

| Component | Start of day | Final | Named path to 10 |
|---|---|---|---|
| Pipeline / data | 9 | 9.5 | isolated local-DB test env (infra debt) |
| Formula / math | 6.5 | 8.5 | outcome-calibrated confidence after 2026-07-10; disjoint fatigue windows (data contract) |
| Segmentation (D033) | 5.5 | 8 | live operational confirmation 07-07; automatic-mode flip decision |
| Measurement / backtest | 4 | 8.5 | live-window confirmation; operator-response join |
| UI / operator | 4 | 8.5 | budget-CTA executes vs reviews (product decision) |
| Explainability | 7 | 8.5 | per-decision empirical outcome history once live windows accrue |
| QA / golden | 7 | 8.5 | DB-integration suite on isolated env |
| Release / ops | 6 | 8 | host-side sed/permissions hardening; staging environment |

Fixes landed in this pass beyond the morning slices:
- Three agreed math-review defects: low-CTR sign error zeroed, quality-only
  double penalty removed, fatigue decay baseline floored (lifecycle path;
  the runtime-SQL hydration fallback remains floor-less - documented).
- CAMPAIGN_PAUSED/ADSET_PAUSED normalize to PAUSED (advisory badges fire;
  hierarchy-paused rows leave the zero-conv burner path by design).
- GS-series hysteresis sequence goldens parsed and executed from
  GOLDEN_CASES.md (the 3 live flip creatives are permanent goldens).
- D033: evidence-dip grace (3 days, reduced class) + conflict two-evaluation
  confirmation; per-date persistence; daily-grid shadow evidence (final kind
  divergence 2/71; TS_F5K churn reduced to cold-start maturation only;
  persistent conflicts still surface from day 2).
- CRITICAL caught by adversarial review and fixed: hysteresis state fields
  were persisted but never parsed back (grace/conflict rules would have been
  dead in production); now covered by a write-read round-trip test.
- UI: chip completeness restored (refresh -> Fresh test; blocked cuts ->
  Cut), execution CTA on card footers, rawLabel/pendingTransition surfaced,
  calibration banner gates on hard-known sample size.
- Ops: deploy pins host .env APP_IMAGE_TAG/APP_BUILD_ID with assertion
  (recurring P1 drift class closed); pin hardened for newline/dual-key.
- Pipeline: lagged_lifecycle_row_count job metadata; direction-disambiguated
  universe-count reconciliation notes.
- Honesty corrections recorded: the F2 clamp is defense-in-depth shadowed by
  the 0.85 keep band (the band is the active protection); replay evidence
  for the fatigue floor does not exist yet (fallback path floor-less).

Replay evidence (final artifact): hard reversals within 3 observations
76 -> 20 (-73.7%), transitions 272 -> 183; matched suppressed-day scoring
46 flip-right vs 41 hold-right (single-day signals ~coin-flip, confirming
the two-evaluation rule); published hard-bucket weighted ECE 0.14 vs raw
0.19 - the 0.05 auto-execution gate stays closed on evidence.

Why nothing is 10: the remaining points are exactly the things code cannot
manufacture today - live operational confirmation (07-07 wave, 07-10
outcome window), an outcome-calibrated confidence scheme that needs that
live data, an isolated DB integration environment, and one product decision
(budget CTA semantics). Each is named, dated, and has a runbook.


## Post-deploy simulation pass (2026-07-06 evening, after SHA 459c80b3 went live)

Directive: do not wait for the calendar; simulate what remains and work the
named path-to-10 items. Six local commits on top of the deployed SHA
(fe6c5a08..d3ce875d, not pushed). Suite 3534 green, typecheck + lint clean.

| Component | Final (morning) | Now | What closed |
|---|---|---|---|
| Pipeline / data | 9.5 | 9.5 | (Tiles feed halt routed to its own task - a new finding, not a regression here) |
| Formula / math | 8.5 | 9 | disjoint winner-memory shadow metric live next to the nested one; divergence measurable pre-flip |
| Segmentation (D033) | 8 | 8.5 | day-1 wave PASSED same-day; context state round-trip proven on live data (95 states, 73 with counters); flip package prepared |
| Measurement | 8.5 | 9 | operator-response join built and run (the named gap); day-2 seams proven live |
| UI / operator | 8.5 | 9 | budget CTAs review-framed (copy = click); decision history surface |
| Explainability | 8.5 | 9 | per-creative 30d decision history with closed 7d outcomes, server-supplied |
| QA / golden | 8.5 | 9 | migrations-from-zero harness (found + fixed a real from-zero FK-ordering defect; 159 tables converge in one run) |
| Release / ops | 8 | 8.5 | portable inode-preserving env pin; release-authority false-red routed to its own task |

New evidence produced by simulation instead of waiting:
- **Day-2 live dry run** (`day2-hysteresis-dry-run.ts`): tomorrow's chaining
  executed against today's persisted production state - the production
  reader returned 1602/1602 previous labels with raw_label, and
  parseHysteresisState parsed all 95 persisted context states (73 carrying
  non-default counters). The only day-2 unknown left is tomorrow's spend
  data itself.
- **Operator-response report**: 2/9 measurable cuts responded (1-day
  median); TheSwaf ignored 7/7 measurable cuts (~3,195 truncated forward
  spend); 50% of responded cuts land in the unknown-outcome bucket -
  quantifying the precision-denominator interaction named in the math
  review. Windows are heavily truncated (hard decisions exist only from
  07-02); the script is rerunnable and self-truncates at the last complete
  warehouse day (the first run caught fake compliance against today's
  partial ingest).
- **D033 day-1 gate passed same-day** (deploy-day catch-up): 14/14 context
  success, no collapse, EMOLOS conflicts surfaced exactly as the shadow
  predicted; day-1 hard-flip wave = 7 (expected clean-epoch class).

Remaining to 10 - the irreducible set:
1. Tomorrow's spend data (first day suppression CAN occur) and the 7d live
   outcome window closing 2026-07-13 - future reality, not simulatable.
2. The D033 automatic-mode flip - a user decision; package is ready
   (D033_AUTOMATIC_MODE_FLIP_PACKAGE_2026-07-06.md).
3. Prod-snapshot integration suite portability + staging environment -
   infra investments beyond this repo session.
4. Two routed investigations: Tiles Workshop feed halt (since 06-19, with
   15 stale-data cuts to audit against the staleness guards) and the
   release-authority checker false-red.


## Closer-to-10 pass (2026-07-06 late, non-sync scope per user direction)

Suite 3538 green, typecheck + lint clean. Six local commits pending push
(fe6c5a08..decea3c9), all deploy-safe (no label-affecting change).

| Component | Now | Movement | Evidence |
|---|---|---|---|
| Formula | 9 → 9.25 | stale-guard audit + ceiling shadow | Tiles' 40 stale hard rows: 40/40 fully stale-badged, all floor-capped at confidence 40 - guards worked as designed; the remaining design gap (weeks-stale data should demote hard actions to diagnose) ships as stale_hard_ceiling_advisory shadow badge (>7d feed age) for live prevalence measurement before the next-version flip |
| Measurement | 9 → 9.25 | sync-broken sensitivity cut | excluding Tiles, hysteresis evidence strengthens: reversals -76.2% (vs -73.7% full), noise share 17.9% - headline results do not depend on the contaminated business |
| Explainability | 9 → 9.5 | empirical confidence | per-confidence-decade observed positive rates in the backtest summary; every card shows its own bucket's track record (Obs. @ conf) server-supplied |
| QA | 9 → 9.5 | real-DB seam test | ephemeral harness now runs the hysteresis DB seam check: production UPSERT -> production reader on a real migrated database (raw_label round trip, strict before-asOf, rerun upsert) - the in-memory-blind defect class is permanently covered |

Irreducible remainder (unchanged): tomorrow's spend data, the 07-13 live
outcome window, the automatic-mode flip decision (user), prod-snapshot
test portability + staging, and the two routed investigations (Tiles sync
root cause - explicitly out of scope per user direction; release-authority
checker).
