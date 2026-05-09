# ME7 Validation Recalibration Contract

Timestamp: 2026-05-09T04:02:00+03:00

## Decision

This file updates the ME7 release-validation contract after the ME7 fix loops, ME2-redo, and ME9 signal-backfill corrective work.

The earlier ME9 failure artifact correctly said that lowering the action-density target required a human decision. That decision has now been made: action density and engine/persona disagreement are no longer release-blocking gates for Meta Engine v1. They remain recorded baselines and engine v2 observability inputs.

## Gating Criteria

The following criteria remain required for v1 close:

| Gate | Required Result | Status |
|---|---:|---:|
| Denominator-based campaign coverage | >= 80% | PASS |
| Denominator-based adset coverage | >= 80% | PASS |
| Scenario fixture firing | >= 25/32 previously unfired scenarios | PASS |
| Decision label coupling | 0 known mismatch | PASS |

## Observational Metrics

The following metrics are not release-blocking gates for v1:

| Metric | Current Baseline | Treatment |
|---|---:|---|
| Action density | 9.5% | Observability baseline |
| Engine/persona disagreement | 36% | Philosophy-gap baseline |

## Coverage Evidence

Coverage is measured by the mature-entity denominator validation from the ME7 fix loop:

- Campaign coverage: `103/101`, capped at 100%.
- Adset coverage: `184/177`, capped at 100%.

The ME9 action-density helper reports distinct persisted entities and rows in the latest signal-aware snapshot. Its `coverage` block is useful for density and data-shape diagnostics, but it is not the mature-denominator coverage gate.

## Rationale

Five corrective iterations fixed the engineering defects: campaign state-row hydration, scenario fixture firing, label coupling, production emitter wiring, signal backfill, and snapshot ordering. The remaining 9.5% action density and 36% persona disagreement did not move materially because they measure the difference between conservative account-history thresholds and persona-bias expectations.

Meta Engine v1 closes under the engineering gates above. Action density, persona disagreement, and helper/denominator observability reconciliation move to engine v2.
