# Historical Simulation Closure Report

Date: 2026-07-12
Status: `HISTORICAL_SEARCH_EXHAUSTED_REVIEW_ONLY`
Provider writes: none
Production deploy: none

## Verdict

Every bounded H1-H12 formula, structure, context, confidence, and stability
family that can be evaluated from retained data has been rerun. No remaining
historically testable challenger passed its locked promotion gate. Automatic
execution therefore stays closed and hard actions remain review-only.

This is not a 9.5/10 causal-readiness claim. The strict rerun exposed a more
important truth: all 17,233 restated native-ad rows lack cutoff-safe status,
format, lifecycle, and ranking receipts. The resolver correctly publishes only
`diagnose` or `out_of_scope` at baseline instead of borrowing current state.
Consequently, retained history cannot honestly compare cut/scale/refresh
policies as though those missing inputs were known.

The local runtime hardening is complete: native ad identity, immutable
calibration generations, exact lineage, native outcomes, operator receipts,
controlled-assignment contracts, scheduler integration, server-owned reads,
and UI action authority are implemented and covered by real-Postgres seams.
No local change was pushed or deployed in this phase.

## Evidence Tiers

| Tier | Verified coverage | Permitted conclusion |
| --- | --- | --- |
| exact raw PIT | 1,695 native-ad manifests; 87 generation-safe 7d and 77 generation-safe 28d windows; 362 exact terminal branches | raw observation integrity and exact terminal behavior; no full resolver authority |
| persisted output seam | 11,552 `raw_label` rows through 2026-07-12 | output-sequence behavior only; canonical historical inputs are absent |
| restated native ad | 142,170 source rows; 17,233 fixed rows; 12 businesses; 16,945 complete 14d outcomes | paired descriptive sensitivity and falsification only |
| restated campaign context | 349 campaigns; 87,945 creative-day rows; 59 reviewed labels | bounded context classification sensitivity only |
| restated campaign/ad set | 1,536 variants per grain | structure and weekday-seasonality sensitivity only |

All 17,233 native cohort rows were updated after their historical cutoff.
Current creative dimensions are optional grouping metadata and never execution
authority. Full and smoke replay matched all 14 cohort/hash fields; the current
manifest-set hash is
`a9bd0b4bcbc8e3353e3f10aa2e95b6af5be5a99f2299800870959e6dc5f861d3`.

## Current Family Closure

| Family | Matrix | Current locked evidence | Classification | Consequence |
| --- | ---: | --- | --- | --- |
| H1 calibration | 144 | 0 known hard emissions under cutoff-safe authority | insufficient evidence | retain current policy |
| H1 campaign-kind parent | 8 x 144 upstream sensitivity | H11 challengers fail the locked gate | rejected authority parent | do not condition calibration on automatic context |
| H1 country parent | 288 | 69 conditioned locked rows, 0 changed decisions | no incremental retained signal | retain account-goal parent |
| H2 maturity | 100 | 0 known hard emissions | insufficient evidence | retain current policy |
| H3 cut boundary | 16 | 0 current strict hard emissions | insufficient evidence | no threshold expansion |
| H4 winner/budget split | 60 | 11 locked emissions, all outcome-unknown | insufficient evidence | winner remains review-only; budget action stays at owner grain |
| H5 fatigue | 120 | 5 known; 80.0% precision; 2.2% recall; paired net -8 | insufficient evidence | retain pressure-plus-decay policy |
| H6 funnel materiality | 36 | 352 known; 25.0% precision; 60.9% recall; paired net -24 | reject precision | retain D035 blocked-resolution contract |
| H7/H9 structure | 1,536 per grain | 0/1,536 campaign and 0/1,536 ad-set variants passed | insufficient evidence | no structure or seasonality formula change |
| H8 non-purchase | 16 | 11 known; 18.2% precision; one-business evidence | insufficient evidence | keep relative ranking review-only |
| H10 confidence | 8 | 15 calibration-known; 67 test-known; 0 transformed; 111 unsupported | insufficient evidence | confidence remains a score, not a probability |
| H11 campaign context | 8 | selected challenger: 17 high-confidence, 82.35% accuracy, 58.97% Wilson lower, Test recall 0/12 | reject | retain production default; automatic consumption off |
| H12 hard-entry stability | 7 | 86,770 restated observations but 0 raw hard entries; exact persisted seam is input-incomplete | reject policy change | retain shipped guard only as a safety mechanism, not proven lift |
| HC interactions | 6 | 0 known hard emissions | insufficient evidence | no interaction change |

`Insufficient evidence` means the bounded family ran but retained facts cannot
support promotion. It is not a statistical rejection and cannot be repaired by
adding more thresholds to the same incomplete source.

## D049 Correction

D049 remains a local monotonic safety rule: when fresh commercial truth proves
break-even below account P25, the lower boundary caps cut grading. It cannot
widen the cut zone; missing or stale authority preserves the prior fail-closed
path. Unit, golden, and invariant tests cover that property.

The earlier `1,390 -> 1,380` cut comparison is retained only in the explicitly
named pre-D049 artifact. It is not current closure evidence because that run
used the superseded hydration source. The strict current replay emits no cuts
without cutoff-safe status receipts, so a numerical pre/post comparison across
the two source hashes would be invalid. No historical lift claim is made for
D049.

## Context And Stability

H11 evaluated eight predeclared signal/threshold policies. The
calibration-selected no-lineage policy failed locked coverage and sample gates;
all policies missed all 12 reviewed Test campaigns. Automatic context remains
shadow-only.

H12 evaluated seven entry policies. The strict restated sequence contains zero
hard entries because required cutoff-safe authority is absent. The exact
persisted seam contains 11,552 raw-label rows and proves deterministic state
handling, but it cannot be pooled with restated outcomes or account identity.
Therefore the prior 57.6% reversal-reduction claim is superseded and no
hysteresis performance promotion is justified.

## Automation Boundary

Observational outcomes cannot open automation. A controlled row requires a
durable random assignment, seed verification, immutable control observation,
DB-computed finalized estimate, unique verified treatment receipt, exact native
snapshot/evaluation lineage, and the independent operator-enablement gate.
Malformed or mixed batches fail closed. The current strict 5 x 50 action-bin,
ECE <= 0.05, and >=10% Brier-improvement gate has zero accepted variants.

## Non-Simulatable Remainder

Only evidence that does not exist in retained history remains:

1. Canonical serialized native input/profile/data-health/context/hysteresis
   records for historical decisions.
2. Cutoff-safe ad, ad-set, and campaign effective/configured status plus policy,
   review, learning, budget-origin, format, ranking, and lifecycle generations.
3. Historical versioned campaign-label belief, hierarchy renames, deleted
   entities, successor lineage, and unlogged manual/provider actions.
4. Provider attribution generations that were never retained.
5. Enough hard-known outcomes for action-specific 5 x 50 confidence bins.
6. Contemporaneous randomized controls and verified treatment receipts needed
   to identify the causal effect of acting, delaying, pausing, refreshing,
   promoting, or scaling.

These are absent facts or causal counterfactuals, not untried formulas. Filling
them requires future native producer generations and controlled experiments;
backfilling them from present-day dimensions would reintroduce leakage.

## Verification

- `npx vitest run`: 568 files passed, 4 skipped; 4,654 tests passed.
- `npm run test:migrations-from-zero`: two clean idempotent runs plus all native
  capability and real-Postgres seam checks passed.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: passed.
- Native full/smoke cohort comparison: pass, 14 fields.
- H11 verdict: `RETAIN_PRODUCTION_DEFAULT`.
- H12 verdict: `REJECT_H12_POLICY_CHANGE`.

## Primary Artifacts

- `NATIVE_AD_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-06-27.md`
- `NATIVE_STRUCTURE_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-07-05.md`
- `H1_COUNTRY_PARENT_CHALLENGER_2025-12-01_TO_2026-07-05.md`
- `EXACT_PIT_CONFIRMATORY_REPLAY_2026-06-01_TO_2026-07-05.md`
- `H11_CAMPAIGN_CONTEXT_CHALLENGER_2025-12-01_TO_2026-07-05.md`
- `H12_DECISION_HYSTERESIS_CHALLENGER_2025-12-01_TO_2026-07-05.md`
