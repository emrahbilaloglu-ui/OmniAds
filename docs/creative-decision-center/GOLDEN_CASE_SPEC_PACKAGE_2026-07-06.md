# Golden-Case Spec Package - 2026-07-06

Documentation-only package. This file does not approve resolver, provider,
database, migration, scheduler, or UI runtime changes.

## Decision

No production formula change is supported by this phase.

The next implementation-eligible slice should be executable test coverage and
copy contracts, not resolver math. Any later resolver/config change must first
land the golden cases below, pass the existing invariants, and keep rollback
small.

## Inputs Reviewed

- `docs/creative-decision-center/START_HERE.md`
- `docs/creative-decision-center/DECISION_LOG.md`
- `docs/creative-decision-center/DATA_READINESS.md`
- `docs/creative-decision-center/GOLDEN_CASES.md`
- `docs/creative-decision-center/INVARIANTS.md`
- `docs/creative-decision-center/CONTRACTS.md`
- `docs/creative-decision-center/FORMULA_EVALUATION_REPORT_2026-07-06_TR.md`
- `docs/creative-decision-center/MULTI_WINDOW_ROBUSTNESS_SUMMARY_2026-07-06.md`
- `docs/creative-decision-center/CONFIDENCE_CALIBRATION_SOURCE_MODE_SUMMARY_2026-07-06.md`
- `lib/creative-decision-engine/config-values.ts`
- `lib/creative-decision-engine/gates/diagnose.ts`
- `lib/creative-decision-engine/gates/ratio-zones.ts`
- `lib/creative-decision-engine/gates/types.ts`

## Non-Goals

- Do not change `decideCreative`, gate order, thresholds, source-mode behavior,
  persisted snapshots, or UI lane mapping in this phase.
- Do not add row-level `brief_variation`.
- Do not let UI compute `buyerAction`, `primaryDecision`, confidence, freshness
  caps, or campaign-kind execution semantics.
- Do not introduce a new standalone decision core.
- Do not promote any account-level parameter pack to production from historical
  replay alone.

## Constants That Need Test Coverage

Current relevant constants:

- `STALE_TIER_NONE_MAX_HOURS = 36`
- `RECENT_SIGNAL_FRESHNESS_HOURS = 36`
- `STALE_SOURCE_UPDATED_AT_HOURS = 48`
- `STALE_CONFIDENCE_CAP = 65`
- Preset `lossBudget` multipliers: aggressive `1.5`, balanced `2.0`,
  conservative `2.5`
- Preset `hardCut` multipliers: aggressive `3.0`, balanced `5.0`,
  conservative `8.0`

These constants create intentional asymmetry:

- verified no-delivery and funnel proof require fresh enough source evidence;
- stale or unknown freshness must not hide mature severe stop-loss cuts;
- stale or unknown freshness must hard-block scale;
- stale or unknown freshness caps confidence for surfaced decisions.

## Candidate Golden Cases

These cases should be converted into executable fixtures before any resolver or
config behavior change. The `SPEC-GC-*` IDs are proposal IDs; canonical IDs can
be assigned when `GOLDEN_CASES.md` is updated.

| Proposed ID | Scenario | Expected decision contract | Required assertions |
|---|---|---|---|
| SPEC-GC-062 | Active creative, active campaign/ad set, `dataFreshnessHours = 35`, `spend24h = 0`, `impressions24h = 0` | `Diagnose` / `fix_delivery` | Fresh no-delivery proof is allowed at or below the 36h fresh-proof boundary; top reason is delivery proof, not performance. |
| SPEC-GC-063 | Same no-delivery fields, but `dataFreshnessHours = 40`, plus mature severe loser math | `Cut`; no `fix_delivery`, no `stale_evidence`, no freshness confidence cap | 36-48h rows are not fresh enough for latest-window delivery proof, but are not stale enough for `stale_evidence`; the executable fixture must deterministically assert the severe performance path can surface and confidence may exceed `65`. |
| SPEC-GC-064 | Mature severe loser, `dataFreshnessHours = 49` | `Cut` remains visible, action remains review-only, confidence <= `65`, `stale_evidence` badge present | Stale evidence caps confidence but is not a terminal `Diagnose` for mature stop-loss. |
| SPEC-GC-065 | Mature severe loser, `dataFreshnessHours = null` | `Cut` remains visible, action remains review-only, confidence <= `65`, `unknown_freshness` badge present | Unknown freshness is not treated as fresh and does not hide severe cut risk. |
| SPEC-GC-066 | Scale-ready winner, `dataFreshnessHours = 49` | `Keep` / review-only near-scale, no hard `Scale`, freshness blocker present | Scale requires fresh recent-hold proof; stale scale must be blocked even if spend, purchases, and ROAS look strong. |
| SPEC-GC-067 | Scale-ready winner, `dataFreshnessHours = null` | `Keep` / review-only near-scale, no hard `Scale`, `unknown_freshness` and `scale_readiness_blocked` evidence present | Promote existing unknown-freshness scale behavior from unit-level coverage into a canonical golden case. |
| SPEC-GC-068 | Funnel-step issue with `dataFreshnessHours = null` | No confident funnel diagnosis; review-only data-quality output | Funnel proof must not be emitted from unknown freshness. Existing `GC-061` should become executable/canonical if not already. |
| SPEC-GC-069 | Cut-zone creative, recent 7d spend >= `recentSampleMinSpend`, recent 7d ROAS > target | `Keep` / review-only with `recovery_hold`; no hard `Cut` | Recovery hold protects a row that is losing on 28d but currently recovering on enough recent spend. Existing `GC-059` should become executable/canonical if not already. |
| SPEC-GC-070 | Cut-zone creative, recent 7d spend below `recentSampleMinSpend`, recent 7d ROAS > target | `Cut` may remain eligible if other cut gates pass | Recovery hold must require enough recent spend, not only a high recent ROAS ratio. |
| SPEC-GC-071 | Cut-zone creative, recent 7d spend >= threshold, recent 7d ROAS equals target exactly | `Cut` may remain eligible if other cut gates pass | Current code uses `recentRoas > target`; exact equality must not accidentally hold the cut unless the rule is explicitly changed. |
| SPEC-GC-072 | Account override where `lossBudgetMultiplier < hardCutMultiplier` | Config accepted; maturity and hard-cut branches remain ordered | Normal account-level loss-budget tuning stays possible. |
| SPEC-GC-073 | Account override where `lossBudgetMultiplier >= hardCutMultiplier` | Preferred: config validation rejects it before runtime; alternative: explicit golden cases must define `maturity_severe_loser` behavior | Historical sweep showed this opens a distinct behavior class. Do not let it appear accidentally. |
| SPEC-GC-074 | `cutBoundaryMode = account_p25_current` | Current behavior preserved | Baseline mode must match today's `bottomQuartileRatio` cut boundary. |
| SPEC-GC-075 | `cutBoundaryMode = breakeven_floor` on an account with breakeven above account P25 | The breakeven floor may widen cut boundary only behind account-level config, never globally | This is the TheSwaf candidate class; must not silently affect EMOLOS, Grandmix, or IwaStore. |
| SPEC-GC-076 | Harness/policy rule: `cutBoundaryMode = breakeven_floor` on an account where target history is unknown or anachronistic | No production hard-action adoption; diagnostic/shadow only | V2b depends on target/breakeven history. Historical replay with today's target applied to old months cannot be treated as causal proof. This belongs in report/harness policy tests, not the `decideCreative` golden fixture table. |

Operator boundary asymmetry is current behavior and must not be "normalized"
silently: recovery hold uses strict `recent7dRoas > targetRoas`
(`SPEC-GC-071` pins exact equality as not recovering), while scale recent-hold
blocks only when `recent7dRoas < targetRoas`, so exact equality can pass the
scale recent-hold predicate. Equalizing those operators is a separate formula
decision, not fixture cleanup.

## Existing Canonical Cases To Preserve

The current `GOLDEN_CASES.md` already includes important rows that should not
be weakened:

- `GC-057`: stale severe scaled stop-loss loser can remain `Cut` with capped
  confidence.
- `GC-058`: stale sustained loser can remain `Cut` after commercial maturity.
- `GC-059`: recent recovery can hold a cut-zone row as review-only `Keep`.
- `GC-060`: unknown freshness blocks hard scale.
- `GC-061`: unknown freshness blocks funnel proof.

The spec above does not replace those rows. It adds boundary conditions,
especially the 36-48h band, the null-freshness cut case, recovery-hold
threshold edges, and `lossBudget >= hardCut` validation.

## Parameter-Pack Acceptance Criteria

Historical replay supports only shadow hypotheses. A per-account production
pack can be proposed only when all conditions below are true:

1. The pack is account-scoped. No global default change from these replays.
2. The pack has executable golden cases for its changed behavior class.
3. `lossBudgetMultiplier < hardCutMultiplier` is enforced or the alternative
   `maturity_severe_loser` behavior is explicitly golden-tested.
4. Current-version, lifecycle-aware accrual reaches defensible hard-action
   cells for the affected action family, or the user explicitly accepts the
   absence of hard-action calibration as a business risk.
5. The pack passes multi-window robustness without hiding account-level harm
   behind pooled results.
6. The pack preserves source-mode disclosure: fallback-mode evidence cannot be
   presented as lifecycle-informed production evidence.
7. The UI and API expose server-produced blockers, source decision, confidence
   cap reason, and next step; UI must not infer `buyerAction`.
8. Rollout uses a kill switch, build/version marker, read-only shadow before
   visible change, and rollback plan.

## V2b Trade-Off Gate

The strongest repeated economic shadow signal is TheSwaf's breakeven-aware
boundary candidate (`V2b`): multi-window replay showed about `+869.9` saved
spend units versus baseline. It is not a clean production candidate yet.

Reasons:

- pooled early-cut risk worsened by about `+5.3 pp`;
- the sign changed by regime: Dec-Jan and Feb-Mar worsened, Apr-May and June
  improved;
- the worst windows are also the most target-history-anachronistic because
  today's target/breakeven values were applied to older months;
- hard-action confidence calibration did not reach n>=30 in the June replay.

Acceptance question for the user, if this reaches an approval stage:

> For TheSwaf only, is roughly +870 saved spend units worth accepting a
> regime-dependent early-cut risk that can be worse in some windows, while
> live current-version hard-action calibration is still thin?

Codex recommendation: do not ask for that production approval until the golden
cases above exist and current-version live accrual is reviewed. If the user
chooses to override that caution, the change must be kill-switch-gated,
TheSwaf-only, shadow-first, and explicitly labeled as uncalibrated.

## Confidence Copy / Tooltip Spec

The confidence display must not imply calibrated probability until there is
defensible hard-action outcome evidence.

Required copy contracts:

- For hard-action rows where comparable current-version known outcomes are
  below `n = 30`: "Calibration not proven: fewer than 30 comparable outcomes for
  this action/account/source mode."
- For rows with `stale_evidence` or `unknown_freshness`: "Confidence is capped
  because source freshness is stale or unknown. Refresh evidence before applying
  this action."
- For non-hard calibration summaries: "Observed positive is a missed-hard-action
  proxy, not hard-action precision."
- For fallback-mode replay evidence: "Historical replay isolates formula
  behavior and does not equal lifecycle-informed production behavior."

UI tests should assert the copy is rendered from server-provided evidence or
static explanatory text. The UI must not recompute calibration status from raw
metrics.

## Monitoring Note

TheSwaf carry-over rows where a prior fresh lifecycle row influences a later
decision should be made visible in monitoring metadata before any visible
parameter-pack change. The specific class to track is "yesterday's fresh
lifecycle evidence, today's decision row." This is observability guidance only;
it does not approve resolver behavior changes.

## Implementation Gate Sequence

Recommended next implementation order, after Claude/Codex review:

1. Add executable fixture coverage for `SPEC-GC-062` through `SPEC-GC-071`.
2. Track `SPEC-GC-072` through `SPEC-GC-075` as blocked config-surface todos
   until `lossBudgetMultiplier` and `cutBoundaryMode` override fields exist.
   Add config validation for `lossBudgetMultiplier >= hardCutMultiplier` when
   that config surface is introduced, unless a deliberate ADR chooses the
   golden-tested alternative.
3. Add `SPEC-GC-076` as a report/harness policy test, not a `decideCreative`
   fixture.
4. Add copy tests for confidence calibration disclaimers.
5. Re-run typecheck, relevant vitest suites, and `git diff --check`.
6. Only then consider a small shadow-only parameter-pack PR. No production
   default formula change should be included in the fixture PR.

## Open Questions

- Should `lossBudgetMultiplier >= hardCutMultiplier` be a hard config error or a
  warning plus explicit `maturity_severe_loser` golden path? My recommendation
  is a hard config error for account overrides.
- Should the 36-48h band be named in output evidence when it blocks delivery
  proof but does not trigger `stale_evidence`? Today it is an implicit boundary.
- Should confidence calibration status be account-level, action-level, or
  action+source-mode-level in the API? The safest display is action+source-mode
  when available, falling back to account-level "not proven" when sparse.
