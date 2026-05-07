# Phase 3.1 Test-First QA

Added focused contract tests for the Decision Range Firewall and provenance binding surface:

- `lib/meta/decision-os.test.ts`
  - asserts Meta ad set rows carry provenance metadata tied to `businessId`, `decisionAsOf`, and the analytics window
- `lib/command-center.test.ts`
  - asserts command center fingerprints change when `decisionAsOf` changes, even if the analytics window stays fixed
  - asserts missing provenance blocks queue eligibility and default queue selection for Meta rows
Expected initial failures on the current codebase:

- Meta action rows do not currently emit a `provenance` object, so the Meta provenance assertion fails with `undefined`.
- Command center action fingerprints currently ignore `decisionAsOf`, so the fingerprint-delta assertion fails because the before/after arrays are identical.
- Command center rows do not yet bind queue eligibility to provenance, so the provenance/queue assertion fails because provenance is absent and the row still remains queue-eligible.

Validation run:

- `npm test -- lib/command-center.test.ts lib/meta/decision-os.test.ts lib/platforms/google/serving.test.ts`
- Result: 4 failing tests, 29 passing tests during the first QA pass.

Scope correction:

- The initial QA pass included a Google Ads same-day partial selected-range assertion. That is outside the Phase 3.1 Meta/Creative/Command Center scope and should be treated as a future cross-platform policy-hardening item, not part of this branch's implementation scope.

No production code was changed in this pass.
