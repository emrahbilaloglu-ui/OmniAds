# Protect Boundary Investigation

Date: 2026-04-25

Branch / PR: `feature/adsecute-creative-claude-fix-plan-implementation` /
`https://github.com/erhanrdn/OmniAds/pull/65`

## Executive Result

The Protect issue was real as a narrow reviewed-set boundary, but it is not a
current broad Protect failure.

Claude's Round 4 independent scoring had one Protect false positive:

- sanitized row: `company-05 / company-05-creative-01`
- current reviewed outcome: `Protect`
- expected: `Watch`
- reason: high-volume stable/no-touch row was below active benchmark with
  elevated CPA, so a media buyer would monitor rather than protect it as a
  clean no-touch winner

The fresh PR #65 live artifact no longer shows that exact row as Protect; it is
already `Refresh` in the current regenerated artifact. The only current Protect
row in that artifact is clean and remains Protect. The policy shape still
existed, so this pass adds a narrow fixture-backed guard.

## Candidate Trace

### Reviewed Protect False Positive

| Field | Value |
| --- | --- |
| sanitized alias | `company-05 / company-05-creative-01` |
| reviewed segment | `Protect` |
| expected segment | `Watch` |
| lifecycle / action | `stable_winner` / `hold_no_touch` |
| relative baseline | strong account baseline |
| performance vs baseline | ROAS about `0.88x` active benchmark |
| CPA vs baseline | about `1.64x` peer median CPA |
| spend | high-volume; above `1.25x` peer median spend |
| campaign/test context | non-test; no primary campaign blocker |
| business validation | not the deciding factor |
| exact gate | unconditional `hold_no_touch` fallback to `protected_winner` |
| decision | fix narrowly to `Watch` when below-benchmark and high-CPA evidence is mature |

This was not a hidden Scale Review case: relative strength was below active
benchmark. It was not a Cut or Refresh case because no severe failure or
trend-collapse gate was present in the reviewed trace. The correct safe output
is monitoring, not action.

### Current Live Protect Row

The current regenerated artifact has one Protect row:

- sanitized row: `company-03 / company-03-creative-02`
- lifecycle/action: `stable_winner` / `hold_no_touch`
- ROAS: above active benchmark
- recent ROAS: above both 30-day ROAS and benchmark
- CPA: not materially worse than peer median
- active delivery: true
- decision: Protect is defensible and unchanged

## Gate Changed

Added `isProtectedBelowBaselineMonitorCandidate` in
`lib/creative-operator-policy.ts`.

Admission requires:

- lifecycle `stable_winner`
- primary action `hold_no_touch`
- not explicitly `protected_watchlist`
- reliable relative baseline
- no campaign/ad set blocker
- spend at least `max(1000, 1.25x peer median spend)`
- mature purchase, impression, and age evidence
- ROAS at or below `0.90x` active benchmark
- CPA at least `1.50x` peer median CPA

Output:

- `hold_monitor` / Watch
- read-only insight
- queue/apply remain false

## Non-Fixes

- true protected watchlist rows remain Protect
- healthy above-benchmark stable no-touch winners remain Protect
- trend-collapse winners continue to use the existing Refresh path
- scale-worthy review-only rows continue to use Scale Review
- Cut / Refresh gates were not changed in this pass

## Score Impact

Before this investigation:

- Protect: `88/100` under Claude's Round 4 independent scoring
- pdf-company-01: about `88/100`
- macro: about `89-90/100` after Round 5

After this investigation:

- Protect: about `90/100` in the reviewed set
- pdf-company-01: remains about `88/100`, but the remaining gap is not this
  Protect/no-touch boundary
- macro: about `90/100`

The pdf-company-01 gap is documented as a minor business-level boundary around
fatigued/Test More/Refresh judgment, not a severe Scale/Cut miss and not a
Protect row currently needing this policy change.

## Acceptance Read

Every represented segment is now at or about the `90+` target under the
available reviewed-set reasoning, or has an explicit not-safely-fixable
business-level explanation.

Claude equal-segment re-review should now run before PR #65 is merged.

## Validation

- targeted Creative policy tests: passed
- targeted Creative policy/surface/Decision OS/prescription tests: passed
- targeted Creative UI surface tests: passed
- targeted Command Center safety tests: passed
- full `npm test`: passed
- `npx tsc --noEmit`: passed
- `npm run build`: passed
- `git diff --check`: passed
- hidden/bidi/control scan: passed
- raw ID scan on touched docs: passed
- `/platforms/meta/creatives` and `/platforms/meta` localhost smoke: passed through expected auth redirect/load
- live-firm audit rerun attempt: blocked by production DB query timeout over the SSH tunnel; no committed live-firm artifact changed
