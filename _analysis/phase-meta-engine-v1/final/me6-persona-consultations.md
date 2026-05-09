# ME6 Persona Consultations

Timestamp: 2026-05-08T14:50:14Z

## Decision 1: Operator Response Badges

Question to Marcus: given the `/platforms/meta` operator flow now records acted, deferred, undeferred, and ignored responses, how should the card surface that state without slowing action?

Marcus: keep the state visible on the card itself. Acted and deferred are operational facts, not drawer-only metadata; the buyer should be able to scan what has already been handled before making another cut or bid move.

Outcome: `MetaActionCard` now accepts a response state and renders compact Acted, Deferred, or Ignored badges. `MetaPlatformPage` maintains local response state after primary and defer actions so the UI reflects telemetry immediately instead of waiting for a full snapshot refresh.

## Decision 2: Diagnostic and Signal Visibility

Question to Aria: given anomalies already render a diagnostic ladder, what additional context should recommendations show when signal quality affects confidence?

Aria: keep the diagnostic ladder on anomalies, but expose missing or capped signal quality on decision cards. Creative/funnel calls are only trustworthy if the operator can see when the engine is working from complete tracking versus capped evidence.

Outcome: recommendation cards now render signal-quality chips when `signalQuality` is present, including confidence caps such as `low_without_signal_table`.

## Decision 3: Engine and Calibration Context

Question to Sam: given ME2-ME5 added shared label semantics, calibration scope, and engine version fields, what should be visible in the UI for architecture traceability?

Sam: show the engine version and calibration scope in-line with each decision. Account architecture reviews need to know whether a recommendation came from account-level history, entity-specific history, or degraded fallback.

Outcome: `MetaPulse` uses the actual engine version in the engine status pill, and `MetaActionCard` renders calibration-scope chips when snapshot rows provide `calibrationScope`.

## Trade-Off

The UI does not add a new ignored action button in ME6. The badge path supports ignored responses from the API contract, but introducing a new destructive/hiding control belongs with a fuller operator-response workflow rather than this integration pass.
