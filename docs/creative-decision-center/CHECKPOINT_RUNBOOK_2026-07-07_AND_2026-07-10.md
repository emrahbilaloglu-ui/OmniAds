# Checkpoint Runbook — 2026-07-07 (D033 day-1) and 2026-07-10 (outcome window)

Read-only verification steps for the two remaining time-gated readiness items.
All commands run against the live tunnel (127.0.0.1:15432) and never write.

## 2026-07-07, after the 03:00 UTC producer wave — D033 day-1

```
node --env-file=.env.local --import tsx scripts/creative-decision-center/campaign-context-day1-check.ts --asOf=2026-07-07
```

Pass criteria:
1. `contextJobRuns`: one success row per enabled business (14/14); zero failed.
2. `contextDistribution`: no business where every campaign lands in
   `unknown`/`conflict` (`collapseWarning: false` everywhere). Expected shape
   from the shadow run: majority main/test with high/medium confidence;
   Grandmix ~13/16 active-labeled resolved.
3. `producerRunsByStatus`: context job is non-gating — calibration/lifecycle/
   decisions must all still show success rows even if context had failures.
4. `hardLabelChangeCount`: compare against the pre-hysteresis baseline
   (3 hard flips on 2026-07-04..06). Day 1 after the ENGINE_VERSION bump is a
   clean epoch (all labels publish raw, no suppression possible) — judge flip
   reduction from day 2 onward, not day 1.

Escalation: any `failedOrRunning` row, or a collapse warning, blocks the
`CAMPAIGN_CONTEXT_MODE=automatic` flip discussion; capture the JSON and stop.

## 2026-07-08+ — first hysteresis-active days

From day 2 of the new engine version, spot-check suppression behavior:

```
SELECT as_of_date, creative_id, label, raw_label
FROM engine_v3_decision_snapshots_daily
WHERE engine_version = 'v3-2026-07-06-decision-stability'
  AND label <> raw_label
ORDER BY as_of_date DESC LIMIT 50;
```

Expect: rows exist only where a hard-boundary transition was suppressed;
each such creative shows the `pending_transition` badge in the briefing and
resolves within one day (either confirms or reverts).

## 2026-07-10 — 7-day outcome window closes for the new version

1. Re-run the outcome/baseline checkpoint:
   `phase1-outcome-baseline-checkpoint.ts` (current-version rows now non-empty).
2. Gate metrics to check (thresholds in
   `lib/creative-decision-engine/automation-readiness.ts`):
   - `expectedCalibrationError` — now hard-only by construction; compare with
     the replay's published-label weighted ECE as the prior.
   - `hardActionPrecision` / `hardActionRecall`
   - `criticalFalsePositiveRate`, `highSeverityMissedOpportunityRate`
3. Compare live hard-flip counts (decision_changed events with cut/scale on
   either side) for 07-08..07-10 against the replay's predicted published-label
   transition rate. Large excess over prediction = investigate before any
   automation-tier discussion.
4. If all gates hold: raise measurement to 8 in the scorecard with the live
   window as evidence; the historical replay remains the reproducibility
   artifact.
