# PR6 Buyer Adapter Approval Pack

STATUS: approval pack only. Implementation is blocked until the mapping table, contract vocabulary, and open questions below are explicitly approved.

## Why Approval Is Required

The buyer adapter maps active engine output into operator-facing buyer actions. Even in shadow mode, this is decision policy because it changes the action vocabulary that future UI/API layers will present. It must not be treated as a harmless display refactor.

PR6 can only proceed after approval because it touches these policy surfaces:

- Engine decision label to buyer action mapping.
- Campaign-kind execution semantics.
- Missing-data fallbacks and confidence/invariant handling.
- Golden case expected action parity.
- Future Action Board and operator workflow meaning.

## Inputs Reviewed

- `docs/creative-decision-center/START_HERE.md`
- `docs/creative-decision-center/DECISION_LOG.md`
- `docs/creative-decision-center/CONTRACTS.md`
- `docs/creative-decision-center/GOLDEN_CASES.md`
- `docs/creative-decision-center/INVARIANTS.md`
- `docs/creative-decision-center/DATA_READINESS.md`
- `docs/creative-decision-center/VOCABULARY_MAPPING.md`
- `docs/creative-decision-center/generated/before-after-shadow.json`
- `docs/creative-decision-center/03-before-after-shadow-report.md`
- `lib/creative-decision-center/contracts.ts`
- `lib/archive/v1-v2-v21/lib/creative-decision-center/buyer-adapter.ts` as historical reference only. Do not unarchive blindly.

## Current Blocker

`CONTRACTS.md` and `lib/creative-decision-center/contracts.ts` currently define the PR4 buyer action union as:

```ts
scale | cut | refresh | protect | test_more | watch_launch | fix_delivery | fix_policy | diagnose_data
```

`GOLDEN_CASES.md` expects additional values:

- `review`
- `same_as_canonical`
- `promote_to_main`
- `scale_budget`
- `controlled_scale`

This must be resolved before implementation. Either the contract union expands with an ADR and tests, or the golden cases are corrected. Implementing an adapter while this mismatch exists would bake in an inconsistent contract.

### Resolution Paths

Pick one path before PR6 implementation starts:

1. Expand `CreativeDecisionCenterBuyerAction` with the missing five values. This requires a `CONTRACTS.md` update, a PR4 contracts module patch, tests, and a new ADR.
2. Keep the PR4 buyer action union and relabel `GOLDEN_CASES.md` expected buyer actions to existing values. Any execution nuance must move to a separate approved field such as `uiBucket` or `executionAction`.
3. Keep `buyerAction` as the nine-value operator action and model `promote_to_main`, `scale_budget`, `controlled_scale`, `review`, and `same_as_canonical` as non-buyer-action context. This likely fits the existing `uiBucket` separation best, but still needs explicit approval.

## Proposed Mapping Dimensions

The mapping table should be deterministic and should consider only the active engine output and approved context fields:

- `primaryDecision`
- existing engine label/action category
- `actionability`
- `problemClass`
- `priorityBand`
- `confidenceBand`
- `maturity`
- `reasonTags`
- blocker and missing-data indicators
- campaign kind: `main`, `test`, `mixed`, or unknown
- identity grain and aggregate-only constraints
- compatibility with V1/operator/V2 snapshots

The adapter must not mutate engine inputs, recompute resolver outcomes, or change thresholds.

## Draft Mapping Table For Approval

This table is not approved policy yet.

| Engine output | Condition | Proposed buyer action | Evidence |
| --- | --- | --- | --- |
| Scale | campaign kind unknown | `diagnose_data` | GC-036, GC-042 |
| Scale | explicit Test campaign | `promote_to_main` | GC-054 |
| Scale | explicit Main campaign | `scale_budget` | GC-055 |
| Scale | explicit Mixed campaign | `controlled_scale` | GC-056 |
| Scale | no campaign-kind execution split | `scale` | GC-011, GC-037, GC-039, GC-053 |
| Cut | mature loser or commercial loss budget | `cut` | GC-010, GC-043, GC-044b, GC-048 |
| Refresh | fatigue and not Test-transform-to-cut | `refresh` | GC-012, GC-028, GC-035, GC-045, GC-046 |
| Test More | launch monitoring | `watch_launch` | GC-007, GC-008, GC-009 |
| Test More | thin signal or soft block | `test_more` | GC-013, GC-014, GC-015, GC-026, GC-027, GC-032, GC-044a |
| Protect | aggregate-only winner-gap or backup-variant logic | `protect` | GC-029, GC-031, GC-034 |
| Diagnose | delivery proof | `fix_delivery` | GC-001 |
| Diagnose | policy proof | `fix_policy` | GC-004, GC-005, GC-022 |
| Diagnose | data quality, stale benchmark, paused context, unlabeled context | `diagnose_data` | GC-002, GC-003, GC-016 to GC-025, GC-036, GC-042, GC-047 |
| Keep | scale-readiness blocked or weak zone | `review` or contract correction required | GC-038, GC-049 to GC-052 |
| Same as canonical | kind-aware fallback | `same_as_canonical` or contract correction required | GC-040, GC-041 |

## Open Questions Requiring User Decision

1. Should `promote_to_main`, `scale_budget`, and `controlled_scale` be real `buyerAction` values, or should `buyerAction` stay `scale` with a separate execution label?
2. Should `review` be added to the buyer action union, or should the affected golden cases map to an existing action?
3. Should `same_as_canonical` be a buyer action, a diagnostic status, or a non-action explanation?
4. Should the spike artifact `before-after-shadow.json` be regenerated after PR6, or should PR6 tests ignore the spike artifact and use only golden cases?
5. What exact `adapterVersion` string should PR6 emit?

## Proposed D019 ADR Shape

If PR5 uses D018, PR6 should add D019: "Buyer Action Adapter Mapping Table v1 (Shadow Mode)".

Minimum ADR content:

- Decision: add a deterministic table-driven buyer adapter.
- Scope: adapter module, approved mapping table, tests, and invariant post-condition checks.
- Non-scope: no route/UI/job default import, no resolver changes, no threshold changes.
- Constraints: UI does not compute buyer action; adapter reads output only; module isolation remains enforced.
- Open-question resolutions: contract vocabulary, spike artifact strategy, adapter version.
- Rejected alternative: wholesale unarchive of the historical buyer adapter.
- Rollback: PR6 is a separate commit and can be reverted without reverting PR4 contracts.

## Green-light Conditions

PR6 implementation can start only when all conditions are true:

- The contract-vs-golden-case vocabulary mismatch is resolved.
- The mapping table is approved.
- The ADR is accepted.
- Adapter tests cover all golden cases.
- Invariant tests cover I04, I20, and I21.
- Module-isolation tests prove no route, UI, or job imports the adapter by default.
