# Adsecute Phase 2 Final Operator Policy Report

Date: 2026-04-21  
Scope: synthesis of all reports in `docs/operator-policy/phase-2/reports/`  
Status: policy-only final report. No engine code, Creatives code, provider writes, `main` merge, `main` push, or secret access is authorized by this document.

## 1. Corrected Product Doctrine

Adsecute is not a KPI dashboard and not a generic AI recommendation layer. It is an expert operator system that must decide what the operator should do, not touch, watch, or investigate.

The corrected doctrine is:

- Deterministic operator policy is the source of action authority.
- AI commentary may summarize, explain, or draft language, but it must never create the final action, confidence, queue eligibility, push eligibility, target, or projected impact.
- Selected reporting ranges are analysis overlays. They can explain what the operator is inspecting, but they cannot authorize today's Meta or Creative action.
- Today's operator authority comes from `decisionAsOf` plus stable complete-provider-day windows.
- Commercial truth, measurement truth, delivery state, source freshness, evidence floors, and push-safety gates outrank raw ROAS.
- Missing, stale, partial, contradictory, selected-range-only, demo, inaccessible, or non-live evidence must degrade confidence and eligibility.
- Creative policy is planning and evaluation policy. It must not imply direct Meta write-back or Creatives code edits.
- Phase 2 should not implement the full engine. Phase 2 should prepare the deterministic operator policy engine, its contracts, test scenarios, data requirements, and UX hierarchy for Phase 3.

Expected implementation sequence: implement the Meta policy engine before Creative implementation unless the Creative audit proves selected-date/window flaws are more urgent in production. The current audit shows both surfaces have selected-range contract flaws, while Meta also has a live legacy selected-range recommendation fallback and Command Center date coupling, so Meta should normally go first.

## 2. Why Examples Are Intent Signals, Not Exhaustive Rules

User examples such as "do not scale from ROAS alone", "do not kill from a selected date drop", or "do not increase budget when a cost cap is binding" are intent signals. They reveal the operating principle: prevent shallow, media-buyer-stupid recommendations.

They are not exhaustive rules because the policy surface is wider than any example list. The engine must generalize the intent across Meta budget, bid, delivery, structure, GEO, placement, Creative lifecycle, measurement, profitability, UX, and push safety. A future case not named in examples must still be blocked when it violates the doctrine: selected-range-only evidence, missing truth, thin sample, stale source, attribution mismatch, learning instability, unsupported push path, or unclear provider target.

The testable rule is: examples seed scenario classes; they do not whitelist only those cases. New cases inherit the same authority, evidence, and safety gates.

## 3. Reporting Range vs Operator Decision Context

| Concept | Purpose | Can Change Reports | Can Change Primary Decision | Can Enter Execution |
| --- | --- | --- | --- | --- |
| Selected `startDate/endDate` | User exploration, charts, exports, selected-period analysis | Yes | No | No |
| `analyticsWindow` | Explicit reporting context with role `analysis_only` | Yes | No | No |
| `recent7d` | Recent pressure, veto, volatility, fatigue, cooldown | Yes, as context | Veto only; not sole authority | Only as supporting proof |
| `primary30d` | Main decision authority | Yes | Yes | Yes, with provenance |
| `baseline90d` / all history | Memory, protection, variance, historical winners | Yes | Supports or blocks | Supporting proof only |
| `decisionAsOf` | Complete provider-day anchor | Yes | Yes | Required |
| Live provider state | Current target status, budget owner, accessibility, preflight | No report-only role | Required for apply-adjacent actions | Required |

The current product contract already contains the correct conceptual split, but the public API/page/workflow contract still blurs it. The UI and routes must make it impossible to confuse selected reporting context with operator action authority.

## 4. Current Meta and Creative Date-Window Design Flaws

The code/data contract audit found that Meta and Creative internals are mostly stable-window compliant, but their public contracts still depend on selected dates.

Meta flaws:

- The Meta Decision OS route accepts selected `startDate/endDate` and passes them into the Decision OS route contract.
- The Meta page keys campaigns, recommendations, and Decision OS queries by selected dates.
- "Run analysis" refetches Decision OS and recommendations for the selected range, which teaches users that changing the date picker can change today's action.
- Meta campaign detail and workflow links include selected dates, so Command Center handoff can inherit reporting dates.
- The legacy Meta recommendations route can fall back to selected-span heuristic recommendations when Decision OS is unavailable.
- Command Center queue, preview, apply, and rollback clients still pass selected `startDate/endDate`.

Creative flaws:

- The Creative Decision OS route accepts selected `startDate/endDate`.
- The Creative page keys Decision OS by selected dates.
- Page history windows are derived from selected `drEnd`.
- Selected-period historical analysis is valid as context, but it is still presented close enough to the decision route/query identity that users can infer the selected range changes the operator decision.

Required correction: decision routes and execution flows must bind to `decisionAsOf`, source window key, source window dates, stable decision id, source row scope, and evidence hash. Selected reporting dates may remain as `analyticsStartDate/insights/analyticsEndDate` only.

## 5. Recommended Stable Decision Windows for Meta

Meta should use complete provider days, anchored to `decisionAsOf`.

- `recent7d`: trend, volatility, attribution lag watch, learning cooldown, delivery shocks, fatigue pressure, veto checks. It may block scale/stop but should not alone authorize aggressive action.
- `primary30d`: main authority for scale, reduce, pause, recover, budget shift, bid/control review, structure review, GEO decisions, placement exception review, and no-touch protection.
- `baseline90d`: historical memory for stable winner protection, recurring scale failure, seasonality, prior fatigue, outlier detection, and variance baselines.
- Current live provider state: required for any apply-adjacent budget/status action, budget ownership, live status, provider access, preview hash, rollback snapshot, and post-apply validation.

Same-day/current-day data should be pacing context only unless a separate live current-state policy marks it valid for diagnostic use. Current-day or partial-day performance must not authorize scale, pause, creative verdicts, or bid/control changes.

## 6. Recommended Stable Decision Windows for Creative

Creative should use the same operator authority model, with Creative-specific supporting windows.

- `recent7d`: decay, fatigue pressure, recent engagement/funnel movement, volatility, and watch-state changes.
- `primary30d` / last30: main authority for lifecycle, segment, action, confidence, and push-planning eligibility.
- `baseline90d` and all-history: winner memory, comeback eligibility, fatigue validation, stable-winner protection, family memory, and repeated failure detection.
- last3/last14 style windows may be useful for alerting or descriptive trend analysis, but they must not independently promote, kill, refresh, or protect a creative.
- Selected-period historical analysis is allowed only as descriptive context. It may create an investigation prompt, not an action.

Creative decisions also require deployment compatibility with Meta lane, objective, optimization goal, bid regime, GEO/country economics, campaign role, and creative supply context.

## 7. Meta Operator Action Taxonomy

Meta actions should reuse the existing Decision OS vocabulary and trust lanes instead of creating a separate taxonomy.

Primary action classes:

- No action/archive: `hold_no_touch`, `archive_context`, inactive/immaterial/no identity.
- Protect/hold/watch: `hold`, `stable_no_touch`, `monitor_only`, `review_hold`, `protected_watchlist`.
- Budget actions: `scale_budget`, `reduce_budget`, manual campaign budget review, donor-recipient `budget_shift`.
- Status actions: `pause`, `recover`.
- Bid/control actions: `review_cost_cap`, `tighten_bid`, loosen/tighten cost cap, bid cap, ROAS floor, hold automatic bidding.
- Structure actions: `rebuild`, consolidate, merge/pool, split/test, duplicate validation, objective review, optimization review.
- GEO actions: `scale`, `validate`, `pool`, `isolate`, `cut`, `monitor`.
- Placement actions: `keep_advantage_plus`, `exception_review`.
- Creative-dependent Meta actions: `creative_refresh_required`, scale blocked by creative supply/fatigue, creative validation dependency.
- Unsupported/manual classes: targeting edits, objective changes, optimization event changes, CBO campaign budget changes, campaign-level status/budget writes, geo/placement mutations, duplicate creation, bid writes.

Push posture:

- Only `pause`, `recover`, `scale_budget`, and `reduce_budget` on exact live Meta ad set targets can ever become push-eligible under the current safety model.
- Even those require deterministic source, live-confident trust, human approval, supported capability, live read, fresh preview hash, canary gate, kill switch inactive, rollback artifact, and post-apply validation.
- All other Meta classes are report-only, watchlist, manual handoff, or queue planning until a new execution contract exists.

## 8. Creative Operator Segment Taxonomy

Creative segments should be policy states, not legacy score labels.

- `scale_ready`: enough evidence, commercial fit, and compatible deployment lane to plan promotion.
- `promising_under_sampled`: positive early signal, below spend or purchase floors.
- `false_winner_low_evidence`: ROAS looks strong but sample, AOV, or selected-window proof is too thin.
- `fatigued_winner`: prior winner memory plus current decay and pressure evidence.
- `kill_candidate`: material downside evidence and no stronger campaign/context explanation.
- `protected_winner`: stable winner that should not be disturbed.
- `hold_monitor`: meaningful but mixed or unresolved evidence.
- `needs_new_variant`: useful family signal requires new hook, angle, format, copy, offer, or refresh.
- `creative_learning_incomplete`: not enough delivery, time, impressions, spend, or purchases.
- `spend_waste`: material spend without profitable or strategically useful learning.
- `no_touch`: inactive, immaterial, missing identity, selected-range artifact, already handled, or outside authority.

Precedence should be conservative: no-touch and protected-winner checks run before fatigue, kill, scale, low-evidence winner, promising, learning-incomplete, variant planning, and hold-monitor. When two segments conflict, choose the safer segment unless evidence and commercial truth support the more aggressive segment.

## 9. Evidence Floors

Evidence floors are minimums, not guarantees.

Meta floors:

- Scale candidate should normally require fresh source, compatible objective, clean structure, budget-limited diagnosis, commercial truth, and material signal.
- Current hard-coded approximations from the audit: strong ad set signal around `$250 spend / 8 purchases`, high signal around `$500 / 12 purchases`, protected-winner signal around `$500 / 18 purchases`, and opportunity board floor around `$250 / 6 purchases`.
- Pause/reduce requires material loss against target or break-even, enough spend and conversions/events, no learning/tracking/status alternative explanation, and primary-window loss.
- Thin high-ROAS rows, one-purchase winners, one-day anomalies, and selected-range spikes are watch/investigate, not scale.

Creative floors:

- `scale_ready`: spend >= 200, purchases >= 4, impressions >= 5,000, target or break-even fit, deployment compatibility, fresh commercial truth.
- Conservative fallback when no commercial target exists: spend >= 250, purchases >= 5, ROAS >= 2.0, with confidence capped and fallback clearly labeled.
- `kill_candidate`: spend >= 150 with very weak purchases/ROAS/CPA, or spend >= 2x target CPA with zero purchases, unless objective/tracking/learning context blocks the verdict.
- Fatigue requires prior winner memory plus current decay in at least two signals, such as CTR, click-to-purchase/CVR, ROAS, attention, frequency, creative age, or family concentration.
- Learning states must remain watch/test/no-touch when spend, impressions, age, or purchase floors are missing.

Measurement floors:

- Same attribution basis across comparisons.
- Complete provider days outside attribution/finalization lag.
- No one order dominating the result without corroboration.
- Parent/child and sibling segment context for segment actions.
- Fresh source state and stable identity.

## 10. Profitability and Commercial Truth Requirements

Profitability must be explicit business truth, not inferred optimism.

Required commercial truth:

- AOV or reliable observed order-value aggregate.
- Contribution margin, COGS, shipping, fees, fixed per-order costs, or configured margin assumption.
- Target CPA and target ROAS.
- Break-even CPA and break-even ROAS.
- Payback window.
- Country economics and serviceability for GEO-specific scale/isolate.
- Promo calendar.
- Operating constraints: site, checkout, conversion tracking, feed, stock, landing/merchandising, manual do-not-scale.
- Calibration profile: channel, objective family, bid regime, risk posture, action ceiling.

Rules:

- Missing commercial truth does not hide the page. It caps or blocks aggressive action.
- Conservative fallback thresholds may support context only; they are not business truth.
- Missing target pack, margin, AOV, country economics, payback, or blocking operating constraints must block scale, budget increase, target relaxation, creative promotion, GEO scale/isolate, and spend-increasing recovery.
- Protective reductions may remain reviewable under degraded truth only when loss evidence is material and caveated.
- Projected impact must be bounded, labeled as estimate, and based on deterministic assumptions. AI commentary must not invent profit, uplift, CAC, ROAS, or payback estimates.

## 11. Bid, Budget, Learning, and Structure Guardrails

Budget guardrails:

- Budget owner must be known. CBO/campaign-owned budgets cannot be treated as child ad set budgets.
- Native apply can only target live ad set-owned daily budgets, not campaign budgets, CBO budgets, lifetime budgets, or mixed config.
- Daily budgets are average daily allowances; same-hour pacing should not be treated as a hard cap.
- Lifetime budgets require schedule and remaining-budget analysis and are manual-only in Phase 2.
- Budget increase requires proof the entity is budget-limited, not bid-limited, demand-limited, learning-limited, status-blocked, or creative-supply constrained.

Bid guardrails:

- Cost caps, bid caps, and ROAS floors can throttle delivery. Increasing budget first is blocked when a restrictive control is likely binding.
- Numeric bid/control changes require current control values, previous control age, commercial target, budget utilization, objective/optimization fit, and stable windows.
- Bid/control writes are not supported push paths in Phase 2.

Learning and delivery guardrails:

- Learning is not failure. Learning limited is a diagnostic constraint, not a pause instruction.
- Significant edits can disturb learning. Budget, bid, objective, optimization, targeting, placement, creative/ad, schedule, status, or structure edits should cool down for at least 3 complete provider days.
- Delivery diagnostics must precede performance verdicts: status, account access, learning/edit state, budget owner, bid/control, signal density, demand/structure, tracking, commercial truth, then performance.

Structure guardrails:

- Objective mismatch, optimization mismatch, mixed config, fragmented learning, CBO allocator effects, over-segmentation, and thin overlapping ad sets route to review or restructure, not direct budget action.
- Targeting, audience, GEO, placement, objective, optimization, CBO/ABO, and campaign rebuild actions are manual handoff only in Phase 2.

## 12. Creative Evaluation Guardrails

Creative quality is not identical to campaign outcome.

Before scale, kill, fatigue, or refresh:

- Check objective and optimization goal.
- Check bid regime and budget ownership.
- Check campaign lane: test, validation, scaling, retargeting, promo, existing-customer, recovery.
- Check deployment compatibility and whether a clean scaling lane exists.
- Check commercial truth, country economics, stock/site/feed/checkout/manual constraints.
- Check creative age, family provenance, preview status, benchmark cohort, frequency, funnel and attention signals.
- Distinguish creative-quality verdict, campaign-context verdict, and mixed verdict.

Blocked creative behavior:

- Do not promote from ROAS alone.
- Do not kill from selected-range performance alone.
- Do not call fatigue without winner memory and decay evidence.
- Do not treat AI commentary or legacy score vocabulary as authority.
- Do not make direct provider push claims for Creative actions.
- Do not edit Creatives code as part of this policy.

## 13. Data Gaps

The reports identify these gaps as contract gaps, not Phase 2 implementation requests:

- Durable policy/rule tables for thresholds, scale bands, bid tests, pacing, learning gates, fatigue thresholds, and no-touch protections.
- Per-decision provenance: stable decision id, `decisionAsOf`, source window key, source dates, row scope, evidence hash, source query id.
- Regression proof that changing selected analytics range with the same `decisionAsOf` does not change primary Meta or Creative decisions.
- Command Center binding to decision provenance instead of selected reporting dates.
- Per-SKU/product inventory, margin, availability, fulfillment constraints, category profitability.
- True contribution profit actuals by campaign, ad set, ad, creative, country, product.
- LTV, payback, cohort retention, refund, cancellation, new-vs-returning, and order-quality data.
- Shopify/GA4/server reconciliation in the decision path.
- Explicit attribution basis/action-report-time contract per decision.
- Current-day pacing source with account-day progress, timezone, budget remaining, schedule, and same-day spend.
- Learning/delivery feed: learning status, learning limited diagnostics, policy/account/payment/review issues, activity-history edit classes.
- Audience size, overlap, placement saturation, auction competition, estimated action rate, demand headroom.
- Creative supply queue: fresh concept availability, variant backlog, refresh capacity, concept reuse limits, production owner.
- Creative-by-GEO and placement-by-format evidence for some cross-page decisions.

## 14. Legacy Rule Engine Findings

There is no longer one standalone legacy Creative rule engine acting as source of truth. Remaining legacy/compatibility surfaces include snapshot-backed creative scoring, AI creative decision wrappers that map current OS output into old labels, commentary over deterministic reports, and the Meta recommendations fallback.

Preserve:

- Snapshot freshness/replay metadata for debugging and audit.
- Human-readable score/factors/next-step envelope for reports.
- The commentary split: narration interprets deterministic output but does not decide.
- Compatibility translation downstream of current Decision OS.

Reject:

- Selected-range-driven score or cache identity as action authority.
- Legacy snapshot fallback as an action-core surface.
- `meta-creative-score-v1` as policy source of truth.
- Old labels such as `scale_hard`, `scale`, `watch`, `test_more`, `pause`, `kill` as canonical authority.
- Any route where Decision OS failure re-enables selected-range heuristic recommendations as queue/apply candidates.

Required policy: if legacy fallback appears, label it `non_authoritative_selected_range_context` or equivalent, cap it to report/watch, and suppress it from default action surfaces and execution.

## 15. Scenario Bank Summary

The scenario bank contains 160 test-oriented scenarios:

- 50 Meta campaign/ad set scenarios.
- 50 Creative scenarios.
- 20 cross-page scenarios.
- 20 do-not-act scenarios.
- 20 future push-to-account safety scenarios.

The scenarios are the acceptance test bank for Phase 3. The strongest recurring assertions are:

- Same `decisionAsOf`, different selected reporting ranges: primary decisions must remain identical.
- Thin ROAS winners do not scale.
- Selected-range winners/losers do not act.
- CBO children do not receive direct ad set budget writes.
- Lifetime-budget cases are manual schedule review.
- Cost cap, bid cap, and ROAS floor constraints block naive budget increases.
- Learning, recent edits, tracking gaps, stock/site blockers, and objective mismatches cap actions.
- Creative scale is human planning, not provider push.
- Command Center actions without stable provenance are blocked.
- AI-only or commentary-only recommendations never enter work buckets or push.

## 16. UX Hierarchy

Adsecute's UI should prioritize operator decisions over raw analytics.

First screen order:

1. Scope and truth state.
2. Operator headline.
3. Work buckets: `Do this`, `Do not touch`, `Watch`, `Investigate`.
4. Compact highest-priority row cards.
5. KPI context only after or beside the decision headline.

Operator buckets:

- `Do this`: evidence-backed move for review, queue, manual handoff, or apply candidate depending on policy.
- `Do not touch`: protection is the action.
- `Watch`: real signal without enough authority.
- `Investigate`: missing, stale, conflicting, blocked, or unsupported evidence.

UI rules:

- Show decision window and selected range separately.
- Label selected range as analysis-only near decisions.
- Row cards should show one action, one authority label, one confidence label, one short reason, up to three secondary labels, up to five metric chips, and one blocker when present.
- Missing evidence must appear as a cap, not as silent null.
- Empty states must distinguish no rows, immaterial rows, suppressed rows, preparing data, partial/stale data, missing commercial truth, and selected-range no-data cases.
- No UI button, queue badge, or copy may imply stronger eligibility than the deterministic push label.

## 17. Push-to-Account Readiness Model

Safety levels:

- `read_only_insight`: reports and explanations only.
- `operator_review_required`: human review or manual handoff; no provider apply.
- `safe_to_queue`: deterministic action can enter operator queue; approval still required.
- `eligible_for_push_when_enabled`: only after approval, live preview, current preview hash, preflight, canary, inactive kill switch, rollback artifact, and post-apply validation.
- `blocked_from_push`: unsupported or unsafe until a new explicit execution contract exists.

Currently push-considerable classes:

- `meta_adset_decision.pause`
- `meta_adset_decision.recover`
- `meta_adset_decision.scale_budget`
- `meta_adset_decision.reduce_budget`

Hard push blockers:

- Missing deterministic source decision.
- Missing stable decision id/window/provenance/evidence hash.
- Selected dates as execution context.
- Missing live provider read.
- Provider/entity mismatch.
- Campaign/CBO budget owner for ad set budget action.
- Lifetime or mixed budget/config state.
- Stale preview hash.
- Manual provider change after approval.
- Kill switch active.
- Business/account pause flag.
- Canary not enabled.
- Missing rollback artifact.
- Post-apply validation unavailable or failed.
- Unsupported action class.

Creative, GEO, placement, structure, bid/control, objective, targeting, duplicate, merge, campaign budget, and no-touch actions must not auto-push under the current model.

## 18. Phase 3 Implementation Roadmap

Phase 2 should end with doctrine, contracts, scenario bank, and data gaps ready. Phase 3 should implement in deterministic layers.

1. Contract firewall.
   - Rename selected dates in decision routes to `analyticsStartDate/insights/analyticsEndDate`.
   - Make `decisionAsOf` the decision anchor.
   - Stop using selected dates as Decision OS query identity.
   - Add tests proving selected-range changes do not mutate primary Meta or Creative decisions.

2. Per-decision provenance.
   - Add stable decision id, source window key, source window dates, source row scope, `decisionAsOf`, evidence hash, source query id, and action fingerprint to every action-bearing row.
   - Require provenance before queue, preview, apply, rollback, or workflow links.

3. Meta deterministic policy engine.
   - Implement Meta policy compiler first unless Creative date-window flaws become more urgent.
   - Cover budget, bid/control, delivery/learning, structure, GEO, placement, measurement, profitability, and push ceilings.
   - Demote legacy selected-range recommendation fallback to report-only context.

4. Command Center rebinding.
   - Replace selected date context with decision provenance.
   - Enforce stale-preview rejection against evidence hash and live provider state.
   - Keep existing push support narrow.

5. Commercial and measurement truth gates.
   - Add explicit readiness outputs for target pack, break-even, AOV, margin, payback, country economics, operating constraints, attribution basis, finalization lag, and reconciliation.
   - Block aggressive actions when truth is degraded.

6. UX hierarchy.
   - Rework action surfaces around `Do this`, `Do not touch`, `Watch`, and `Investigate`.
   - Make authority windows first-class and selected range subordinate.
   - Show blockers, missing inputs, and eligibility ceilings compactly.

7. Creative policy engine.
   - Implement Creative segments, precedence, evidence floors, deployment compatibility, family memory, fatigue, false-winner, supply-planning, and no-touch rules.
   - Keep Creative provider push blocked.
   - Ensure selected-period historical analysis remains descriptive only.

8. Scenario-bank test harness.
   - Convert the 160 scenarios into regression fixtures.
   - Include cross-page tests for Meta/Creative linkage, commercial truth, tracking, stock, selected-range anomaly, provenance mismatch, and AI-commentary conflict.

## 19. Final Recommendation

Do not implement the full operator engine in Phase 2. Phase 2 should prepare the deterministic operator policy engine with clear doctrine, stable windows, evidence floors, taxonomies, data contracts, scenario tests, UX hierarchy, and push-readiness constraints.

Phase 3 should start with the selected-range firewall, per-decision provenance, and Meta deterministic policy engine. Creative implementation should follow unless production audit shows Creative selected-window coupling is creating more urgent operator harm than Meta's legacy fallback and Command Center date coupling.
