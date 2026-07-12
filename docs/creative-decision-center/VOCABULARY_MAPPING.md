# Vocabulary Mapping

Status: initial framework. Some mappings are TODO until a full repo import/consumer audit is completed.

## Mapping Principles

- `stable_winner` likely maps to `Protect` or `Scale` depending on maturity/confidence.
- `fatigued_winner` likely maps to `Refresh`.
- Delivery/policy problems should map to engine root `Diagnose` plus buyer actions `fix_delivery` / `fix_policy`.
- D035 compatibility note: `diagnose_data` remains in the historical V2.1
  adapter mapping below, but current Meta Decisions projects it to
  `decisionState: blocked`, `buyerAction: null`, and a server-owned resolution.
  It is not shown as an Act Now action.
- `scale_review` should not become an engine `primaryDecision`; use `primaryDecision: Scale` + `actionability: review_only` or `review_required`.
- `brief_variation` is not row-level.
- `old-rule-challenger` is regression/challenger context, not user-facing authority.
- `media-buyer-scoring` should be signal layer, not UI authority.

| currentTerm | currentLayer | meaning | mapsToV21PrimaryDecision | mapsToProblemClass | mapsToBuyerAction | mapsToActionability | keep/move/deprecate | riskIfLost | notes |
|---|---|---|---|---|---|---|---|---|---|
| `scale_ready` | V1 / operator-policy | Scale candidate | Scale | performance | scale | review_only | move | high | Must preserve evidence floors. |
| `stable_winner` | V1 | Stable winner | Protect / Scale | performance | protect / scale | review_only | move | high | Exact mapping depends on maturity and scale readiness. |
| `fatigued_winner` | V1 / operator-policy | Winner losing freshness | Refresh | fatigue | refresh | review_only | move | high | Requires fatigue proof. |
| `blocked` | V1 / operator-policy | Blocked/unsafe | Diagnose | data_quality / campaign_context | diagnose_data | diagnose | move | high | Split problem classes. |
| `retired` | V1 | Inactive/old row | Diagnose | insufficient_signal / campaign_context | diagnose_data | diagnose | move | medium | Could be comeback with history. |
| `promote_to_scaling` | V1 primary action | Scale intent | Scale | performance | scale | review_only | move | high | No direct apply initially. |
| `keep_in_test` | V1 primary action | More evidence | Test More | insufficient_signal | test_more / watch_launch | review_only | move | medium | Launch split requires firstSeen/firstSpend. |
| `hold_no_touch` | V1 primary action | Protect | Protect | performance | protect | review_only | move | high | Keep stable winner semantics. |
| `refresh_replace` | V1 primary action | Refresh | Refresh | fatigue / creative | refresh | review_only | move | high | Do not map to cut. |
| `block_deploy` | V1 primary action | Block/cut/deploy unsafe | Cut / Diagnose | performance / data_quality / campaign_context | cut / diagnose_data | review_only / diagnose | move | high | Must avoid cutting delivery/policy problems. |
| `retest_comeback` | V1 primary action | Retest old winner | Refresh | creative | refresh | review_only | move | medium | Aggregate brief may also be relevant. |
| `scale_review` | operator-policy | Review-only scale candidate | Scale | performance | scale | review_only | move | high | Not a primaryDecision. |
| `promising_under_sampled` | operator-policy | Good but immature | Test More | insufficient_signal | test_more | review_only | move | medium | Prevent premature scale. |
| `false_winner_low_evidence` | operator-policy | Weak winner signal | Diagnose / Test More | insufficient_signal | diagnose_data / test_more | review_only | move | high | Important ROAS-only guardrail. |
| `kill_candidate` | operator-policy | Cut candidate | Cut | performance | cut | review_only | move | high | Must require maturity/truth. |
| `spend_waste` | operator-policy | Waste | Cut | performance | cut | review_only | move | high | Preserve but cap on missing data. |
| `needs_new_variant` | operator-policy | Refresh/variant need | Refresh | fatigue / creative | refresh | review_only | move | high | Not row-level `brief_variation`. |
| `investigate` | operator-policy | Diagnose context | Diagnose | campaign_context / data_quality | diagnose_data | diagnose | move | high | Could become fix_delivery with proof. |
| `scale` | operator-surface | UI scale bucket | Scale | performance | scale | review_only | move | high | UI must stop computing this. |
| `test_more` | operator-surface | UI test bucket | Test More | insufficient_signal | test_more | review_only | move | medium | Adapter-owned bucket. |
| `protect` | operator-surface | UI protect bucket | Protect | performance | protect | review_only | move | high | Preserve. |
| `refresh` | operator-surface | UI refresh bucket | Refresh | fatigue / creative | refresh | review_only | move | high | Preserve. |
| `cut` | operator-surface | UI cut bucket | Cut | performance | cut | review_only | move | high | Preserve with review language. |
| `diagnose` | operator-surface | UI diagnose bucket | Diagnose | data_quality / campaign_context | diagnose_data | diagnose | move | high | Split into more specific buyer actions when proof exists. |
| `Scale` | V2 | Engine primary | Scale | performance | scale | review_only | keep | high | V2.1 base. |
| `Cut` | V2 | Engine primary | Cut | performance | cut | review_only | keep | high | Review by default. |
| `Refresh` | V2 | Engine primary | Refresh | fatigue / creative | refresh | review_only | keep | high | Needs fatigue feature enrichment. |
| `Protect` | V2 | Engine primary | Protect | performance | protect | review_only | keep | high | Keep. |
| `Test More` | V2 | Engine primary | Test more | insufficient_signal / launch_monitoring | test_more / watch_launch | review_only | keep | high | Adapter maps launch. |
| `Diagnose` | V2 | Engine primary | Diagnose | data_quality / delivery / policy / campaign_context | diagnose_data / fix_delivery / fix_policy | diagnose | keep | high | Buyer adapter adds specificity. |
| `scale_hard` | old-rule-challenger | Aggressive scale | Scale | performance | scale | review_only | deprecate | medium | Regression only. |
| `pause` | old-rule-challenger | Stop/pause | Cut / Refresh | performance / fatigue | cut / refresh | review_only | deprecate | low | Regression only. |
| `kill` | old-rule-challenger | Hard stop | Cut | performance | cut | review_only | deprecate | medium | Regression only. |
