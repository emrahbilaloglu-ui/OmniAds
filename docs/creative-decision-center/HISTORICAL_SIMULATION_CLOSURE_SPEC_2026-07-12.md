# Historical Simulation Closure Specification

Date: 2026-07-12
Status: implementation contract
Production/provider writes: forbidden

## Objective

Exhaust every decision-engine improvement that can be evaluated from retained
history. Only evidence that was never observed or a causal counterfactual that
requires a contemporaneous control may remain open.

This specification implements D047. It does not authorize a resolver rollout.

## Evidence Tiers

| Tier                       | Source                                                            | Permitted claim                                          |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `exact_raw_pit`            | Exact-day, cutoff-safe, complete raw generation                   | Reconstructed decision-time input                        |
| `persisted_decision_input` | Persisted lifecycle/calibration/decision input IDs and hashes     | Reproduced producer input where the manifest is complete |
| `restated_ad_daily`        | Finalized normalized ad facts and cutoff-safe config observations | Formula and robustness sensitivity only                  |
| `restated_raw_ad_country_daily` | Latest complete raw country generation observed by each decision cutoff, reconciled to restated ad facts | Country-parent sensitivity only; never full resolver PIT or causal authority |
| `unreconstructable`        | Missing/conflicting source or current-only dimension              | Coverage inventory only                                  |

No lower tier may be silently promoted to a higher tier.

## Fixed Opportunity Cohort

The replay first creates one entity-date cohort independent of every candidate.
All variants evaluate the same rows and forward windows.

Required identity by grain:

- campaign: business, provider account, campaign, currency, objective/goal;
- ad set: campaign fields plus ad set and optimization/custom-event context;
- ad: ad-set fields plus ad; creative is optional grouping metadata.

Outcome windows are `3d`, `7d`, and `14d`. A window is closed only when every
date has a finalized account ingestion receipt. Positive forward spend with zero
revenue is a known zero-ROAS result. Zero forward spend is censored unless an
action/status receipt explains it.

## Decision Axes

Every row keeps these independent fields:

1. `economicVerdict`: target/breakeven relationship;
2. `portfolioRole`: winner, challenger, learning, declining, exhausted;
3. `authorityState`: actionable, review-only, or a named blocker;
4. `executionAction`: grain-specific operation;
5. `operationalState`: delivery/policy/learning state.

`scale` is not an ad action. A Test winner may be `promote_to_main`; a Main
winner may be `keep_running`. Budget increase/decrease belongs to the verified
campaign or ad-set budget owner.

## Challenger Families

Each family runs as a single-axis challenger first. Only validation winners may
enter bounded combinations. Hyperparameters are selected on earlier periods and
scored once on the held-out later period.

| ID  | Family                             | Bounded candidates                                                                                                 |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| H1  | Recency and hierarchical baselines | half-life `14/28/56/90`; shrinkage `8/16/32/64`; quantile `P10/P20/P25/P30/P50/P60/P70/P75/P80`; account/goal plus country-spend parent sensitivity |
| H2  | Commercial maturity                | loss budget `1.25/1.5/2/2.5/3`; zero conversion `2/3/4/5`; hard cut `3/4/5/6/8`                                    |
| H3  | Cut boundary                       | account P10/P25; `min(P25, BE/target)`; convex P25-to-breakeven; purchase floor `0/2/3/half-winner-P50`            |
| H4  | Winner and budget-scale split      | relative winner P70/P75/P80; budget scale target ratio `1.1/1.2/1.3/1.4/1.5`; purchase multiplier `0.7/1/1.25/1.5` |
| H5  | Fatigue                            | decay `0.10/0.15/0.18/0.25/0.30`; concentration `0.40/0.55/0.70`; frequency P70/P75/P80/P85; decay count `2/3`     |
| H6  | Funnel materiality                 | weak multiplier `0.35/0.50/0.65/0.80`; confidence `0.55/0.65/0.75`; per-metric effective sample floor              |
| H7  | Structure purchase maturity        | age `7/14/21/28`; purchases `5/8/10/half-peer-winner-P50`; utilization `0.70/0.80/0.90/0.95`                       |
| H8  | Non-purchase cohorts               | cohort-specific weight simplex and separate depth gates; no purchase-target substitution                           |
| H9  | Structure history                  | half-life `7/14/28/56`; support `1/2/3` disjoint bands; seasonality `none/day_of_week_match`                        |
| H10 | Confidence                         | action/account hierarchical calibration; current score remains a predictor, not a probability                      |

Policy invariants are not hyperparameters: target/breakeven authority,
identity/currency/goal isolation, policy/delivery proof, stale-data vetoes,
hard-entry hysteresis, UI non-authority, and minimum effective samples remain
fail-closed.

## Scoring

Report separately by grain, action, business, goal/objective, currency, source
mode, treatment status, confidence band, and outcome window:

- hard precision and Wilson interval;
- dated opportunity recall and Wilson interval;
- critical false-positive and missed-opportunity rates;
- hard-known ECE and Brier score;
- unknown and censored rates over all closed episodes;
- paired action transition matrix and clustered/bootstrap interval;
- normalized loss-budget cost when explicit economics exist;
- winner durability, early-cut, saved-spend proxy, and stability metrics;
- PIT/identity/target/config/treatment coverage;
- safety violations, which must remain zero.

Observed durability is not budget-scale lift. Observed post-cut zero spend is not
saved spend. Treatment effects are labeled causal only with a contemporaneous
control or randomized/controlled canary.

## Time Protocol

1. Fit account/segment statistics only from rows available before each cutoff.
2. Select candidate hyperparameters on earlier rolling-origin validation folds.
3. Lock the candidate before the final time holdout.
4. Repeat by business and leave-one-business-out where the metric is portable.
5. Run target, source-mode, missingness, seam, and action-contamination
   falsification checks.

### Locked dates and evidence gates

- Development: `2025-12-01..2026-03-31`; only outcomes observed by
  `2026-03-31` may enter fit statistics.
- Calibration/selection: `2026-04-01..2026-05-31`; a 14-day outcome limits
  eligible decisions to `2026-05-17`.
- Locked test: `2026-06-01..2026-07-05`; the retained outcome ceiling
  `2026-07-11` limits a 14-day test to decisions through `2026-06-27`.
- A hard-action promotion cell needs at least `100` known outcomes, point
  precision and opportunity recall of at least `0.92`, precision Wilson lower
  bound of at least `0.85`, zero safety violations, and paired
  non-inferiority lower bound above `-0.02`.
- Confidence promotion needs five equal-mass hard-known bins with at least 50
  observations each, action-specific ECE at most `0.03`, and Brier score at
  least 10% below the uncalibrated score.
- Uncertainty uses 10,000 business/entity clustered bootstrap replicates with
  seven-day moving blocks. Leave-one-business-out direction and McNemar paired
  disagreements are reported for the calibration-selected candidate.

### Finite matrix

- Ad grain: 144 H1, 100 H2, 16 H3, 60 H4, 120 H5, 36 H6, 16 H8,
  and six preregistered interactions, plus the baseline.
- Country parent: the same 144 H1 configurations crossed with account-goal and
  account-goal-country-spend-weighted parents, for 288 paired variants.
- Confidence: four calibrators times two pooling modes, for eight H10 runs.
- Campaign/ad-set structure: 1,536 H7/H9 combinations at each native
  budget-owner grain, including both bounded weekday-seasonality modes.
- Context and stability: four H11 context configurations and three H12
  hysteresis configurations.

Kind-conditioned H1 calibration is eliminated by an upstream authority
invariant: H11's four automatic-context policies failed their locked gate, and
current legacy labels are not historical PIT truth. A rejected shadow segment
cannot define calibration cells. Country-conditioned H1 uses only the latest
complete raw `breakdown_country` generation observed by each decision's
producer cutoff; both retained `fetched_at` and `created_at` must be at or
before that cutoff, and an incomplete latest generation may not fall back to
an older one. It reconciles each ad-day to `meta_ad_daily`, preserves
multi-country ads as spend-share vectors, and falls back share-by-share without
increasing confidence. Its source mode is
explicitly restated, not exact PIT. Month-of-year and year-over-year H9 modes
are eliminated because the 224-day source history is shorter than one annual
cycle; only the estimable weekday sensitivity is swept.

## Closure Rule

A simulatable item closes only when it is implemented, tested, replayed, and
classified as adopt, reject, or retain-as-policy with measurable evidence. A
candidate may not remain open merely because another bounded formulation could
have been tried; all variants in its declared family must be evaluated or
eliminated by an invariant before closure.

The physically unreconstructable remainder must name the absent fact, prove no
retained source can supply it, and state the future instrumentation that will
capture it.
