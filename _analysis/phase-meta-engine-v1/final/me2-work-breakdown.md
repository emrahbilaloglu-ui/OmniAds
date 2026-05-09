# Meta Engine v1 ME2 Work Breakdown

Input: ME1 audit + Phase Meta R&D synthesis.
Goal: implement the decision core without changing routes or migrations beyond the approved ME1 schema plan.

## Phase Objective

Build the Meta Engine v1 decision core as a per-eligible-entity engine:

- One persisted state row per eligible campaign/adset per day.
- Additional recommendation/anomaly rows only when action or diagnosis is justified.
- Scenario-library coverage for A1-K4.
- Backend/shared decision-label mapping, with UI no longer inferring labels from rec type prefixes.

## Required Persona Consultations

- Marcus: cut/scale thresholds, severe-loser bypass, fast-pause boundaries, controlled budget/bid target bands.
- Dr. Lin: sample gates, confidence calibration, maturity rules, missing-data caps.
- Aria: fatigue thresholds, diagnostic ladder, optimization-event ladder, creative/funnel interpretations.
- Sam: architecture, per-entity state rows, rebuild logic, ABO/CBO transitions, structural rec types.

ME2 sign-off requires all four persona consultation outcomes in `_analysis/phase-meta-engine-v1/me2-persona-consultations.md`.

## Architecture Work

- Add Meta Engine v1 module structure modeled after `lib/creative-decision-engine`:
  - data source / signal context builder
  - calibration resolver
  - scenario rec modules
  - confidence/scoring helpers
  - snapshot adapter
  - telemetry/response adapter
- Add `lib/meta/rec-label-mapping.ts`.
  - Input: `kind`, `decisionState`, `rec.type`, `recommendedAction`, optional backend `decision_label`.
  - Output: buyer-facing label.
  - Hard rule: anomaly kind maps to `diagnose`.
  - Hard rule: `scale_for_profitability` with reduce/tighten/pause/reallocate language must not map to `scale`.
- Add state-row semantics:
  - `keep`
  - `watch`
  - `out_of_scope`
  - `archived`
  - `no_action`
  - `stable_winner_protected`

## Scenario Map

| scenario | module | required signals | expected behavior | tests |
|---|---|---|---|---|
| A1 | `rec-types/a1-math-floor-unmet.ts` | weekly budget, account CPA p50, purchases_7d | switch event, budget raise, or rebuild warm audience; never wait | positive floor unmet, negative floor met, missing CPA low confidence |
| A2 | `rec-types/a2-learning-weak-structural.ts` | age, ROAS p25, spend, CPA | structural rebuild/cut bypass despite learning | weak mature, median performer no fire, missing age watch |
| A3 | `rec-types/a3-learning-on-pace-wait.ts` | learning state, age, conv pace, ROAS p25/p75 | keep/watch only | on-pace wait, weak excluded, missing learning state no high confidence |
| A4 | `rec-types/a4-learning-limited-persistent.ts` | learning_state, days_at_state, audience size, adset count, overlap, budget | rebuild with root-cause diagnostic | 14d limited, younger no fire, missing root cause diagnose |
| A5 | `rec-types/a5-post-learning-underperformer.ts` | learning exit, ROAS p50 | rebuild/cut, not tune | post-learning weak, above p50 protect, missing state cap |
| B1 | `rec-types/b1-capped-winner-bid-raise.ts` | bid strategy, budget utilization, ROAS p50 | bid raise 10-15%, not budget raise | cost cap underutilized, budget utilized no fire, missing bid amount pct target |
| B2 | `rec-types/b2-lowest-cost-budget-scale.ts` | lowest cost, budget utilization, ROAS p50, volatility | budget bump 10-25 unless volatile | hit budget winner, capped excluded, volatility routes B5 |
| B3 | `rec-types/b3-bid-cap-underperforming.ts` | bid cap, auction loss to bid, ROAS target | tighten bid or switch cost cap | ceiling loser, no ceiling no fire, missing auction loss watch |
| B4 | `rec-types/b4-min-roas-loosen.ts` | minimum ROAS, delivery starvation, ROAS target | loosen target 10-15% | starved winner, weak no fire, missing target cap |
| B5 | `rec-types/b5-lowest-cost-volatility-switch.ts` | daily_roas_volatility, bid strategy | switch to cost cap/min ROAS | volatile open bidding, stable no fire, missing volatility no high confidence |
| B6 | `rec-types/b6-profit-first-bid-cap-keep.ts` | operating mode, bid cap, profit stability, volume volatility | keep in profit-first, avoid forced switch | profit-first keep, volume mode alternative, missing mode default |
| C1 | `rec-types/c1-controlled-scale.ts` | ROAS target/p75, age, edit cooldown | controlled 10-25% scale | stable winner, recent edit suppressed, thin sample no scale |
| C2 | `rec-types/c2-recent-edit-cooldown.ts` | last_significant_edit_at, learning state | watch cooldown | recent edit, old edit no fire, missing edit no suppress |
| C3 | `rec-types/c3-scale-sample-gate.ts` | purchases, days at target, ROAS windows | block lucky single-window scale | lucky spike blocked, sustained target allowed, missing days low confidence |
| D1 | `rec-types/d1-lal-beats-broad-control.ts` | audience labels, ROAS, maturity | budget shift but keep control | LAL winner, broad retained, missing pair no fire |
| D2 | `rec-types/d2-lal-wide-efficiency-loss.ts` | lookalike_pct, ROAS trend, CPM trend | narrow to 1-3% | 10% loss, small LAL no fire, missing LAL pct watch |
| D3 | `rec-types/d3-lal-compound-scale.ts` | LAL pct, winner state, expansion need | 3% LAL plus interest | ready LAL, not winner no fire, missing interest target nullable |
| D4 | `rec-types/d4-audience-overlap-consolidate.ts` | overlap pct | consolidate/exclude | >= danger overlap, normal overlap no fire, missing overlap no high confidence |
| D5 | `rec-types/d5-funnel-mixed-split.ts` | audience stage mix | split cold/warm/RT | mixed funnel, single stage no fire, missing stages watch |
| E1 | `rec-types/e1-frequency-fatigue.ts` | frequency p75/p90, vertical | refresh/watch fatigue | high relative freq, normal freq no fire, missing vertical account-relative fallback |
| E2 | `rec-types/e2-ctr-decay-refresh.ts` | CTR decay, stable spend | refresh | decay, no decay, missing stable spend low confidence |
| E3 | `rec-types/e3-frequency-p80-fatigue.ts` | freq_p80, mean frequency | refresh even if mean ok | p80 high, mean high handled E1, missing p80 watch |
| E4 | `rec-types/e4-creative-age-refresh.ts` | creative_age_days, CTR decay | creative refresh | aged decay, young no fire, missing age cap |
| F1 | `rec-types/f1-roas-drop-diagnostic.ts` | ROAS drop, tracking/fatigue/edit/auction/seasonality context | anomaly diagnose ladder | drop emits anomaly, stable no fire, no single-action |
| F2 | `rec-types/f2-recent-data-confidence-cap.ts` | data freshness/window age | confidence cap | fresh cap, settled no cap, missing freshness cap |
| F3 | `rec-types/f3-budget-change-cooldown.ts` | budget edit pct/date, performance drop | cooldown watch, no rollback | recent large edit, small edit no fire, old edit no fire |
| F4 | `rec-types/f4-stable-winner-drop-context.ts` | stable winner, ROAS drop, CPM/seasonality | anomaly diagnose auction/seasonality first | winner drop, edited excluded, missing seasonality diagnostic |
| G1 | `rec-types/g1-upper-funnel-event.ts` | purchases_7d, optimization event, age | switch to ATC/IC | thin purchase, adequate purchase no fire, non-purchase excluded |
| G2 | `rec-types/g2-downshift-to-purchase.ts` | current ATC/IC, purchases_7d, ROAS p50 | duplicate and test purchase | adequate ATC, weak ATC no fire, missing event no fire |
| G3 | `rec-types/g3-ab-test-bottom-funnel-verdict.ts` | test pairing, purchase ROAS | bottom-funnel verdict | ATC vs purchase test, no pair no fire, missing purchase ROAS no verdict |
| H1 | `rec-types/h1-dedup-tracking.ts` | dedup_rate_pct | tracking anomaly and confidence cap | high dedup, normal no fire, missing unsupported |
| H2 | `rec-types/h2-meta-crm-ratio.ts` | meta_to_crm_ratio | adjusted ROAS/confidence cap | overcount, normal no fire, missing unsupported |
| H3 | `rec-types/h3-ios-tracking-degradation.ts` | iOS share, tracking infra quality | diagnose/cap confidence | degraded, optimized no fire, missing source unsupported |
| H4 | `rec-types/h4-event-quota.ts` | event priority list | quota diagnostic | quota full, capacity no fire, missing list unsupported |
| I1 | `rec-types/i1-abo-winner-budget-shift.ts` | adset family ROAS, ABO | zero-sum budget shift | one winner losers, no winner no fire, CBO excluded |
| I2 | `rec-types/i2-abo-to-cbo.ts` | adset count, winners, budget adequacy | consolidate to CBO | 3-8 winners, too few no fire, over 8 maybe I3 |
| I3 | `rec-types/i3-cbo-overcrowded.ts` | CBO, adset count, per-adset spend | split/consolidate | >10 adsets, 3-8 no fire, missing budget watch |
| I4 | `rec-types/i4-test-should-use-abo.ts` | campaign role test, budget mode | rebuild test as ABO | test CBO, non-test no fire, unknown role watch |
| I5 | `rec-types/i5-cross-campaign-overlap.ts` | overlap pct across campaigns | consolidate/exclude | high overlap, normal no fire, missing overlap no high confidence |
| J1 | `rec-types/j1-stable-winner-protected.ts` | mature winner, no edits | state protected/no action | stable winner, recent edit excluded, missing edit medium |
| J2 | `rec-types/j2-fade-risk-diagnose.ts` | ROAS and CTR decline | diagnose/refresh first | concurrent fade, ROAS-only F1, missing CTR low confidence |
| J3 | `rec-types/j3-aggressive-scale-guard.ts` | proposed scale pct, winner state | reject >25% jump | large bump blocked, small allowed, peak override via K2 |
| K1 | `rec-types/k1-mixed-config-rebuild.ts` | mixed config flags | rebuild uniform config | mixed, clean no fire, missing flags watch |
| K2 | `rec-types/k2-peak-scale-ceiling.ts` | seasonal_regime peak, winner | allow higher ceiling with guard | peak winner, normal C1, missing regime default C1 |
| K3 | `rec-types/k3-post-peak-taper.ts` | post_peak, CPM/frequency trend | gradual taper | post-peak pressure, normalized no fire, missing trend watch |
| K4 | `rec-types/k4-catalog-feed-first.ts` | catalog role, feed disapproval/status | diagnose/fix feed before campaign action | feed issue, catalog healthy no fire, missing feed status watch |

## First Implementation Order

1. Define shared output contract and label mapping.
2. Add state rows and per-entity snapshot adapter.
3. Fix scheduler idempotency and retry semantics.
4. Implement high-frequency R&D scenarios first: I4, K4, G1, C1, J1, A1, B1, A2, F1, F2.
5. Add remaining scenario modules behind missing-signal confidence gates.
6. Wire UI to backend/shared label mapping.

## ME2 Test Requirements

- Each rec module gets positive, negative, and missing-signal edge tests.
- Snapshot tests prove campaign and adset state/recommendation/anomaly rows persist and hydrate.
- UI tests prove `scale_for_profitability` no longer renders scale when action semantics say reduce/tighten/reallocate.
- Anomaly tests prove anomaly kind renders diagnose-first cards and diagnostic ladders.
- Coverage tests prove state rows cannot satisfy action-density.
