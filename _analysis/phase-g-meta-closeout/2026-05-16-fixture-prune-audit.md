# Phase G Fixture Prune Audit

Date: 2026-05-16
Scope: Meta Decision Center Phase G closeout.

## Inputs Checked

Commands used:

```bash
find lib/creative-decision-engine lib/meta components/meta app/api/meta -maxdepth 3 -type f \( -name '*test.ts' -o -name '*test.tsx' -o -name '*fixture*' -o -name '*golden*' \) | sort
rg -n "P1b|kind-aware|labelTransform|campaign_kind|promote_test_to_main|empirical|automationReadiness|scenario_g2|scenario_g1|scenario_a5|scenario_b4|scenario_b6|obsolete|TODO" lib/creative-decision-engine lib/meta components/meta app/api/meta docs/meta-decision-center docs/creative-decision-center
```

## Decision

No test or fixture was deleted in Phase G.

Reason: the existing Creative and Meta tests still assert live contracts:

- Creative P1b/P1c/P1d tests protect kind-aware calibration fallback,
  `labelTransform`, and Test refresh-to-cut ordering. These are still active
  invariants, not obsolete scaffolding.
- Meta calibration, label-guard, scenario, empirical-outcome, and automation
  readiness tests protect the implemented Phase A-F.4 behavior.
- `components/meta/redesign/test-fixtures.ts` is a shared UI test fixture, not
  an obsolete golden-case artifact.
- Before Phase G, there was no Meta-specific `docs/meta-decision-center`
  fixture/golden file to prune. Phase G adds documentation goldens instead of
  deleting executable tests.

## Future Prune Rule

Delete or archive a fixture only when it asserts behavior that has intentionally
stopped being a product contract. Sparse production data, deferred UI CTA
binding, or disabled auto-execute are not reasons to delete safety tests.
