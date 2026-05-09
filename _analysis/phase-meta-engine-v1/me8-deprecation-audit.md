# ME8 Deprecation Audit

Timestamp: 2026-05-09T00:09:20+03:00

## Scope

ME8 reviewed Phase 5.1-5.5 Meta recommendation paths that overlap with the ME2-redo scenario emitters. The goal was to remove only paths that are both superseded and unused. Active runtime paths, UI consumers, snapshot compatibility, and regression tests were treated as blockers to removal.

Audited files:

- `lib/meta/recommendations.ts`
- `lib/meta/rec-label-mapping.ts`
- `components/meta/redesign/MetaActionCard.tsx`
- `lib/meta/recommendations.test.ts`
- `lib/meta/rec-label-mapping.test.ts`
- `lib/meta/snapshot.test.ts`

## Decisions

| Rec type | Decision | Rationale |
|---|---|---|
| `scale_for_profitability` | Keep | The rec type remains meaningful as defensive profitability guidance. ME2 fixed the buyer-facing label coupling so defensive reduce/tighten/reallocate language maps to `tune`, not `scale`. |
| `bid_strategy_fit` | Keep as legacy-active | It overlaps with `scenario_b1_capped_strategy_bid_raise`, but it still covers broader bid-strategy mismatch cases and is consumed by the UI action card. ME9 production validation still emitted this type. |
| `bid_value_guidance` | Keep as legacy-active | It provides account-history bid-band guidance that is narrower than full structural scenario coverage but still useful when B1 does not fire. |
| `bid_band_from_history` | Keep as legacy-active | UI already groups it with bid-strategy recommendations, and it remains a compatibility bridge for historical bid guidance. |
| `campaign_structure` | Keep as legacy-active | It overlaps with `scenario_k1_mixed_config_rebuild` and `scenario_i4_test_should_use_abo`, but it remains a broader fallback for campaign architecture warnings. |
| `scaling_structure_fit` | Keep as legacy-active | It covers portfolio and creative-intelligence lane fit, not only the K1/I4 structural cases. Existing tests assert the rec remains useful. |
| Scenario rec types A1-K4 | Keep | All 40 scenario rec types are registered and covered by fixtures. Twelve high-priority emitters are production-wired; 28 remain register-only for engine v2 wiring. |

## Removal Result

No runtime rec type was removed in ME8. The audit found overlap but not dead code. Removing these paths would break active tests, UI affordances, or snapshot compatibility without improving engine correctness.

ME8 therefore treats the Phase 5.x rec types above as legacy-active compatibility adapters. Engine v2 can remove them only after replacement scenario emitters cover the same production cases and the UI no longer depends on their rec-type-specific details.

## Sentinel And Archive Check

The legacy sentinel `legacy_decision_os_archived_phase_4_1` remains absent from active runtime paths. Any historical mentions are confined to analysis/archive notes and do not gate snapshot execution.

## Sam Architecture Review

Sam reviewed the overlap between old rec types and scenario emitters as an architecture problem, not a deletion contest. His recommendation was to keep legacy-active recs where they still express a distinct operator concept or preserve snapshot/UI compatibility. The architectural value is in the shared label mapping and scenario registry, not in deleting every older rec type during v1 close.

Implementation outcome: ME8 keeps active rec paths, documents the deprecation boundary, and defers true removal to engine v2 when replacement coverage is complete.
