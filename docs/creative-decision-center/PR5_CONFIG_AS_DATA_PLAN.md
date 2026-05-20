# PR5 Config-as-Data Plan

STATUS: planning artifact only. This document does not authorize or implement an active decision-engine behavior change.

## Approval Boundary

PR5 may move existing threshold and preset values into a clearer config surface only if all values, fallback order, gate eligibility, confidence math, labels, and buyer-facing output remain byte-for-byte behaviorally equivalent.

Changing any value, changing a fallback, combining two thresholds with different semantics, changing confidence caps/deltas, or changing buyer action meaning requires explicit user approval before implementation.

## Sources Reviewed

- `docs/creative-decision-center/START_HERE.md`
- `docs/creative-decision-center/DECISION_LOG.md`
- `docs/creative-decision-center/DATA_READINESS.md`
- `docs/creative-decision-center/GOLDEN_CASES.md`
- `docs/creative-decision-center/INVARIANTS.md`
- `docs/creative-decision-center/CONTRACTS.md`
- `lib/creative-decision-engine/config.ts`
- `lib/creative-decision-engine/engine-presets.ts`
- `lib/creative-decision-engine/data-health.ts`
- `lib/creative-decision-engine/fatigue.ts`
- `lib/creative-decision-engine/kind-aware-profile.ts`
- `lib/creative-decision-engine/campaign-label-guard.ts`
- `lib/creative-decision-engine/gates/*`
- `lib/creative-decision-engine/jobs/*`

## Non-goals

- No resolver, gate, diagnosis, confidence, scenario, route, UI, or job behavior changes.
- No new standalone decision core.
- No UI-side buyer action computation.
- No route rename or snapshot compatibility removal.
- No PR6 buyer adapter implementation.

## Candidate Constant Inventory

### Low-risk exported values

These are already named exports or central config values. They are the safest first slice if PR5 implementation is approved.

| Current location | Current value | Notes |
| --- | ---: | --- |
| `config.ts` `MIN_CAMPAIGN_CALIBRATION_SAMPLE` | `8` | Campaign calibration maturity floor. |
| `config.ts` `MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE` | `30` | Account scale calibration maturity floor. |
| `config.ts` `SCALE_RATIO_BY_PRESET.aggressive` | `1.2` | Existing preset value. |
| `config.ts` `SCALE_RATIO_BY_PRESET.balanced` | `1.3` | Existing preset value. |
| `config.ts` `SCALE_RATIO_BY_PRESET.conservative` | `1.4` | Existing preset value. |
| `config.ts` `defaultBusinessConfig.recentSampleMinSpend` | `50` | Default business config. |
| `config.ts` `defaultBusinessConfig.accountBaselineQuantile` | `0.75` | Default business config. |
| `config.ts` `defaultBusinessConfig.truthPenaltyForDegraded` | `10` | Existing confidence penalty value. |
| `config.ts` `defaultBusinessConfig.globalDefaultTargetRoas` | `2.0` | Existing target fallback. |
| `config.ts` `defaultBusinessConfig.lowCtrThresholdFallback` | `1.0` | Existing CTR fallback. |
| `data-health.ts` `STALE_TIER_NONE_MAX_HOURS` | `36` | Data freshness threshold. |
| `data-health.ts` `STALE_TIER_WARNING_MAX_HOURS` | `72` | Data freshness threshold. |
| `gates/zero-conv-burner.ts` `ZERO_CONV_MIN_AGE_DAYS` | `7` | Existing zero-conversion age floor. |
| `kind-aware-profile.ts` `MIN_KIND_CALIBRATION_MATURE_COUNT` | `10` | Kind-aware calibration floor. |
| `campaign-label-guard.ts` `CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP` | `50` | Existing unlabeled-campaign cap. |
| `jobs/operator-response-job.ts` `RESPONSE_WINDOW_DAYS` | `30` | Operator response lookback. |
| `jobs/calibration-job.ts` `SAMPLE_WINDOW_DAYS` | `90` | Calibration sample window. |

### Preset multipliers

`engine-presets.ts` currently owns the named multiplier set. A PR5 implementation can preserve the existing export and move the backing object only if tests prove equality.

| Preset | zeroConvBurner | cutCandidate | sustainedLoser | lossBudget | hardCut | scalePurchase | winnerMemory | recentSample | weakFunnelRate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| aggressive | `2.0` | `1.5` | `2.0` | `1.5` | `3.0` | `0.7` | `1.0` | `0.25` | `0.65` |
| balanced | `3.0` | `2.0` | `3.0` | `2.0` | `5.0` | `1.0` | `1.5` | `0.5` | `0.5` |
| conservative | `5.0` | `3.0` | `5.0` | `2.5` | `8.0` | `1.5` | `2.0` | `1.0` | `0.35` |

### Medium-risk named local constants

These are named but currently local to behavioral modules. Moving them is still behavior-neutral only if imports and tests prove no semantic drift.

| Current location | Current value | Risk |
| --- | ---: | --- |
| `fatigue.ts` `SIGNIFICANT_DECAY_THRESHOLD` | `0.18` | Fatigue classification can change if value or comparison changes. |
| `fatigue.ts` `SPEND_CONCENTRATION_THRESHOLD` | `0.55` | Fatigue classification can change if value or comparison changes. |
| `fatigue.ts` `FREQUENCY_PRESSURE_THRESHOLD` | `2.5` | Fatigue classification can change if value or comparison changes. |
| `fatigue.ts` `STRONG_WINDOW_FALLBACK_ROAS` | `1.5` | Strong-window fallback. |
| `gates/ratio-zones.ts` `TARGET_BAND_MIN_RATIO` | `0.85` | Zone boundary. |
| `gates/ratio-zones.ts` `WEAK_TARGET_MAX_RATIO` | `0.95` | Zone boundary. |
| `gates/ratio-zones.ts` `AT_TARGET_MAX_RATIO` | `1.15` | Zone boundary. |
| `gates/ratio-zones.ts` `REFRESH_RATIO_FALLBACK` | `0.75` | Refresh fallback. |

### High-risk inline literals

Do not move these in the first PR5 implementation slice. They are too easy to accidentally reinterpret as policy changes.

- Confidence cutoffs such as `0.5`, `0.65`, and confidence clamps/deltas in gate modules.
- Data freshness checks such as `48` hour diagnosis gates.
- Mature count branches such as `30` and `10` in target resolution.
- Fallback performance ratios such as `0.7`, `0.6`, and AOV adjustment `1.0`.
- Funnel denominator and quality cutoffs in `funnel.ts`.
- Spend-unit resolver purchase-count and account CPA sample thresholds.

## Proposed PR5-alpha Implementation, If Approved

1. Add D018 to `DECISION_LOG.md`: "Config-as-Data Without Behavioral Drift".
2. Add a central config module for the low-risk exported values and preset multipliers.
3. Preserve old export names as compatibility re-exports.
4. Add lockstep tests that compare every moved value against the old public surface.
5. Add module-isolation tests proving no UI or route computes buyer action.
6. Run `npx vitest run lib/creative-decision-engine`, `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, and `npm run build`.

## Rollback

PR5 must be a separate commit from PR4. If any behavioral drift appears, revert only the PR5 commit and keep PR4 contracts intact.
