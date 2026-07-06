# Creative Decision Center — Readiness Scorecard (2026-07-06)

Mandate: raise every readiness component to >=8/10 on evidence, or record an
honest, unavoidable blocker. Scores are joint Claude assessments against live
evidence (prod DB read-only checks on 2026-07-06), the historical replay
(2026-06-01..07-02), and the test suite (3507 passing, typecheck + lint clean).

| Component | Before | After | Status |
|---|---|---|---|
| Pipeline / data | 9 | 9 | held |
| Formula / math | 6.5 | 8 | raised this session |
| Segmentation (D033) | 5.5 | 7 | code deployed; **time-blocked** until day-1 wave |
| Measurement / backtest | 4 | 7.5 | ECE fixed; **time-blocked** until 2026-07-10 outcomes |
| UI / operator contract | 4 | 8 | raised this session |
| Explainability | 7 | 8 | raised this session |
| QA / golden | 7 | 8 | suite green incl. new flip fixtures + invariant scans |
| Release / ops | 6 | 6.5 | image-tag env drift remains P1 ops debt |

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
