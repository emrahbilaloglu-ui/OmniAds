# Invariants

These rules are hard gates for V2.1.

## Required Invariants

- UI must not compute `buyerAction`.
- No row-level `brief_variation`.
- No `fix_delivery` without active status + no spend/impression proof.
- No `fix_policy` without review/effective/disapproval/limited proof.
- No high-confidence scale/cut on stale data.
- No hard cut for new launch unless maturity threshold is met or severe-loss rule is explicit.
- No high-confidence scale when benchmark/target is missing.
- Policy and delivery blockers override performance.
- Campaign/adset paused must not become `fix_delivery`.
- Missing required data must produce `diagnose_data` or confidence cap.
- Aggregate decisions must not attach to a random `creativeId`.
- Same input/config/version must produce deterministic output.
- No hard-coded thresholds scattered inside resolver.
- Kind-aware baseline selection must be all-or-nothing per decision: a decision
  uses either a kind-selected profile view or the canonical `all` profile, never
  a mixed per-gate blend.
- Kind-aware selection must fall back to canonical baselines when required
  kind calibration fields are null or the kind mature pool is too small.
- Unlabeled creatives must use canonical baselines; the campaign-label guard
  still converts hard actions to diagnostic output.
- Sparse Mixed campaign buckets fall back to canonical `all`; they must not be
  inferred from Main or Test buckets.
- Test-cohort `refresh` to `cut` transformation must execute inside
  `finalizeDecision` before `applySoftOnlyLabel`; running it later misses
  refresh emissions already downgraded to `keep`.
- `labelTransform` must be preserved on the final `DecisionOutput` even if the
  transformed label is subsequently downgraded by hard-action eligibility.
- Test-cohort semantic transformation applies only to explicit
  `campaignKind === "test"` inputs. Main, Mixed, and unlabeled creatives keep
  their existing refresh semantics.
- Resolver gate files remain responsible for resolver math only; label semantic
  transforms belong in the `finalizeDecision` pipeline orchestrator.

## Metamorphic Tests

| Change | Expected behavior |
|---|---|
| dataFreshness becomes stale | confidence goes down or action becomes `diagnose_data` |
| benchmarkReliability strong -> weak | confidence goes down |
| campaignStatus active -> paused | `fix_delivery` disappears |
| reviewStatus -> disapproved | policy overrides performance |
| launch age under threshold | hard scale/cut becomes `watch_launch` / `test_more` unless maturity threshold is met |

## Test Placement

TODO: Convert these into executable tests before resolver changes. Keep tests close to adapter/resolver contracts, not UI components.
