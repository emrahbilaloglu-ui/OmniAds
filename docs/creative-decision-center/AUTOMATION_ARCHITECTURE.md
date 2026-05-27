# Creative Automation Architecture

Conceptual only. No executor code. Operator enablement and a dedicated ADR are required before Adsecute can move from `read_only` to any auto-execute tier.

## Current State

- Creative decisions can be scored, explained, prioritized, and backtested.
- `CreativeMutationPreflightResult`, `CreativeRollbackPlan`, `CreativePostActionMonitorPlan`, and `CreativeExecutionReadinessResult` already define the safety contract in `lib/creative-decision-engine/execution-safety.ts`.
- `creativeAutomationReadiness` keeps `tier: "read_only"` and `autoExecuteEligible: false`.

## Required Automation Blocks

1. Executor: a narrow mutation adapter that can only execute an allowlisted action for a specific creative/ad/ad set after a signed execution plan exists.
2. Preflight: fresh read-before-write checks for object status, spend window, current label, tracking health, policy status, account ownership, and duplicate pending actions.
3. Rollback plan: a deterministic reversal description for every supported action, stored before execution.
4. Post-action monitor: T+1/T+3/T+7 observation windows with expected metric movement and failure escalation.
5. Holdout: operator-approved control design so outcome lift is not confused with attribution noise.
6. Operator enablement: per-business opt-in, visible audit log, and hard kill switch.

## Empirical Floor

Auto-execute remains blocked until the current engine version proves:

- hard action precision >= 0.90
- hard action recall >= 0.85
- expected calibration error <= 0.05
- critical false-positive rate <= 1%
- high-severity missed-opportunity rate <= 5%
- persisted decision coverage >= 95%

## ADR Requirement

Changing `tier: "read_only"` to any mutation-enabled tier requires a new entry in `DECISION_LOG.md`. The ADR must name supported actions, rollback limits, holdout policy, kill-switch behavior, and the exact empirical evidence window used for approval.
