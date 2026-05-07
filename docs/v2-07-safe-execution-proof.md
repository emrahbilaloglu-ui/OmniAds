# V2-07 Safe Execution Proof & Supported Automation V2

This document is the accepted V2-07 execution baseline layered on top of the shipped V2-06 workflow and Phase 06 execution preview surfaces.

## Scope

- keep preview-first execution honesty intact
- keep deterministic decision sources authoritative
- keep `Recommendations`, `Decision Signals`, and `AI Commentary` wording unchanged
- keep `/platforms/meta/copies` and unrelated workflow surfaces unchanged
- keep provider-backed execution limited to the already reviewed Meta ad set subset

## Supported Provider-Backed Subset

Current provider-backed apply and rollback remain limited to:

- `meta_adset_decision.pause`
- `meta_adset_decision.recover`
- `meta_adset_decision.scale_budget`
- `meta_adset_decision.reduce_budget`

All other Command Center execution families remain explicit `manual_only` or `unsupported`.

## Support Matrix

The canonical family-level capability registry and support matrix now live in:

- `lib/command-center-execution-capabilities.ts`
- `lib/command-center-execution-support.ts`

They enumerate every current Command Center execution family and record:

- capability key
- `supportMode`
- apply gate posture
- rollback truth
- validation plan
- operator guidance

The execution preview exposes that matrix additively so the operator can see:

- current preview status
- selected family capability
- preflight drift checks
- latest validation status
- family-level rollback truth
- unsupported and manual-only families without hidden write-back assumptions

## Retry And Rollback Semantics

- apply and rollback still require explicit human approval and the existing allowlist gate
- duplicate `clientMutationId` values replay stored terminal results from the existing `command_center_mutation_receipts` table
- if a duplicate arrives while a prior mutation is still `applying`, the service re-reads live provider state
- if live state proves the original mutation already committed, execution finalizes without a second provider write
- if live state does not prove that commit, the duplicate request returns a non-dispatching conflict and must not auto-retry
- post-apply and post-rollback validation must observe the requested live state before execution is recorded as successful
- immutable provider diff evidence is written for apply and rollback attempts
- rollback is only presented as available when the preview has a truthful provider-backed restore path

## Canary Proof Rule

V2-07 is not accepted as production-proven until one allowlisted real business completes:

1. preview
2. approve
3. apply
4. audit verification
5. rollback
6. live provider re-read confirming restore

Apply and rollback runtime posture remains allowlist-gated after this phase. Preview remains live.
