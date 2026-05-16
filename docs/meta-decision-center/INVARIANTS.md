# Meta Decision Center Invariants

These rules are hard gates for the Meta campaign/adset recommendation model.

## Decision Authority

- UI must render backend-provided recommendations; it must not compute buyer
  actions, decision labels, label transforms, or automation readiness.
- Shared campaign/adset cohort resolution must use
  `resolveMetaFunnelCohort(...)`; local string-based purchase filters are a
  regression risk.
- `customEventType` wins over `optimizationGoal`, which wins over objective.
  Purchase/revenue fallback is allowed only when event, goal, and objective
  metadata are absent.
- Non-sales cohorts must not be evaluated with purchase ROAS logic. They need
  cohort-appropriate CPL, event-cost, traffic-quality, or engagement paths.

## Commercial Anchors And Maturity

- Purchase hard scale/cut actions require configured commercial anchors:
  `target_roas`, `break_even_roas`, `target_cpa`, or `break_even_cpa`.
- Account percentiles such as p25/p50/p75 are benchmark context only; they must
  not become profit anchors by themselves.
- Fallback coverage thresholds are not configured Meta commercial targets.
- Purchase loss-budget maturity must use
  `spend >= max(currency_floor, CPA_baseline * risk_multiplier)` with the CPA
  baseline selected from break-even CPA, target CPA, or account CPA in that
  order.
- Hard actions must stay blocked when maturity, active-day, attribution, or
  recent-recovery evidence is missing.

## Main/Test/Mixed Semantics

- Hard actions that change budget, bid, cut, scale, refresh, rebuild, or
  promotion flow require explicit Main/Test/Mixed campaign context.
- Missing label context must downgrade hard actions to diagnostic/review-only
  output while preserving evidence.
- Kind-aware calibration is all-or-nothing per decision. A decision uses either
  a sufficient requested kind profile or canonical `all`; it must not mix kind
  thresholds gate by gate.
- Sparse `main`, `test`, or `mixed` calibration falls back to canonical `all`.
- Test campaign refresh semantics become cut semantics in the backend payload
  with `labelTransform`; Main, Mixed, and unlabeled campaigns keep normal refresh
  semantics.
- Test campaign scale semantics may produce `promote_test_to_main` payload
  diagnostics, but UI CTA binding remains disabled until label adoption and
  kind-aware distribution gates are proven.

## Signal And Blocker Discipline

- Recent edit cooldown, learning state, click-to-LPV tracking risk, and
  overpaced monthly budget evidence must block hard scale/cut before performance
  branches.
- Zero purchases alone must not imply tracking/CAPI failure.
- Tracking risk requires explicit funnel-step evidence such as click-to-LPV
  degradation.
- Checkout risk requires meaningful initiate-checkout volume plus degraded
  IC-to-purchase conversion versus history.
- Feed/catalog problems require explicit problem evidence. Healthy or negated
  statuses such as `no_issues` or `not_limited` are not problem evidence.
- Audience overlap, audience size/stage, lookalike, and entity-scoped placement
  assumptions must not emit hard actions unless a supported warehouse source is
  present.

## Scenario And Automation Safety

- Every implemented scenario must have fixtures/golden expectations, missing
  signal fallback, and invariant coverage.
- Learning-exit cuts require explicit post-learning evidence; being in or near
  learning is not enough for a cut.
- Optimization-event switching must require explicit current optimization event
  evidence. Generic `OFFSITE_CONVERSIONS` is not a purchase event by itself.
- `scenario_g2_downshift_to_purchase` requires an explicit pre-purchase
  optimization event, recent purchase sample evidence, and commercial targets.
- Empirical summaries must count only explicit outcome logs; preflight,
  rollback, operator-response, pending, or missing-action rows must not satisfy
  the empirical model.
- Empirical sample floors are judged positive/negative outcomes, not raw rows.
- Negative rate uses judged outcomes as the denominator, so unknown rows cannot
  dilute loss risk.
- Auto-execute remains blocked unless empirical outcome evidence, live preflight
  proof, and rollback proof are all present.
- Visible confidence and automation tier are separate concepts; improving one
  must not silently imply the other.

## Context And Release Hygiene

- `CONTEXT_SNAPSHOT.md` must be updated after material code, docs, review,
  merge, CI, deploy, or verification changes.
- Docs-only commits may pass CI while runtime remains on the last runtime SHA;
  this is acceptable only when the live runtime build-info is explicitly
  recorded.
- Do not claim Phase G complete without current tests, CI, deploy/post-deploy
  evidence, golden-case maintenance, invariant docs, and context update.
