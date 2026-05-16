# Meta Decision Center Decision Log

This log records the Meta campaign/adset decision-model decisions behind Phases
A through G. It complements, but does not replace, the Creative Decision Center
decision log.

## D-M001 - Use One Funnel Cohort Resolver

Decision: campaign/adset recommendation windows, lane classification, entity
state rows, and related Meta decision paths must use the shared
`resolveMetaFunnelCohort(...)` resolver.

Reason: string-based local purchase filters let non-purchase campaigns leak
into sales decisions and let sales objective text override explicit non-purchase
optimization goals.

Rejected alternative: keep per-module objective/optimization string matching.
That duplicates taxonomy and recreates the original sales-style logic failure.

## D-M002 - Hard Purchase Actions Need Commercial Anchors

Decision: purchase hard scale/cut needs configured target or profit anchors from
the business target pack. Account percentiles are benchmark context only.

Hard-action anchor fields:

- `target_roas`
- `break_even_roas`
- `target_cpa`
- `break_even_cpa`

Reason: p75/p25 benchmarks describe account distribution; they do not prove
profitability. Hard actions must connect to the business economics.

Rejected alternative: treat legacy coverage/fallback thresholds as target
anchors. Review found this would let fallback values act as fake commercial
truth.

## D-M003 - Purchase Maturity Uses Loss Budget

Decision: purchase maturity uses
`spend >= max(currency_floor, CPA_baseline * risk_multiplier)`, with CPA
baseline priority `break_even_cpa`, then `target_cpa`, then account CPA.

Reason: maturity should represent allowed loss budget, not relative spend
against the largest main campaigns. Otherwise test creatives/campaigns never
reach a fair verdict or get judged against scale-campaign spend.

## D-M004 - Main/Test/Mixed Labels Are Semantic Inputs

Decision: Main/Test/Mixed labels are backend decision inputs for hard-action
guards, kind-aware calibration, and Test campaign semantics.

Rules:

- unlabeled hard actions downgrade to diagnostic/review-only output;
- requested kind calibration falls back to canonical `all` when sparse;
- Test refresh semantics become cut semantics in backend payloads;
- Test scale semantics may emit `promote_test_to_main` payload diagnostics;
- UI CTA binding for `promote_test_to_main` remains deferred.

Reason: Test campaigns are experiments. Their failure and success semantics are
not the same as Main campaign stability semantics.

## D-M005 - Unsupported Signals Stay Diagnostic

Decision: tracking, checkout, feed, overlap, placement, pacing, learning, and
recent-edit paths must emit hard action only when their required source signal
exists and is fresh enough.

Reason: zero purchases or poor ROAS alone cannot diagnose CAPI, checkout, feed,
or delivery problems. The engine must distinguish performance failure from
missing signal proof.

## D-M006 - Scenario Expansion Is Data-Gated

Decision: Phase E implemented only scenario families whose required signals were
present or could be explicitly populated. Remaining scenario-library ideas are
deferred until signal coverage exists.

Reason: adding more named scenarios without signal support would increase
apparent sophistication while reducing decision truth.

Deferred to Phase H or later:

- audience overlap and lookalike compound actions;
- deeper placement mix gates;
- cross-campaign overlap and budget-shift families;
- seasonal/peak scale ceiling and taper variants;
- deeper C1 controlled-scale automation.

## D-M007 - Empirical Outcomes Gate Automation, Not Visible Confidence

Decision: empirical outcome logs and summaries can inform automation readiness,
but they do not change visible confidence scores in Phase F.

Reason: visible confidence, empirical precision, live preflight, rollback proof,
and auto-execute tier are different concepts. Collapsing them would make the UI
look safer than the operational system actually is.

Auto-execute requires all of:

- sufficient positive/negative judged outcome sample;
- precision/negative-rate thresholds;
- live preflight proof;
- rollback proof;
- label, target, maturity, freshness, and blocker checks.

## D-M008 - Phase G Closes Documentation And Release Hygiene

Decision: Phase G closes the implemented A-F.4 chain by adding Meta-specific
read order, decisions, data-readiness matrix, invariants, golden cases, fixture
audit, final regression, deploy/post-deploy evidence, and context update.

Reason: without these docs, future AI sessions can pass tests while drifting
back to fixed benchmarks, UI-derived actions, missing-signal hard actions, or
unbounded automation claims.

Scope note: Phase G completion does not mean all future scenario families are
done. It means implemented behavior is documented, verified, deployed, and
explicit about its post-closeout limitations.
