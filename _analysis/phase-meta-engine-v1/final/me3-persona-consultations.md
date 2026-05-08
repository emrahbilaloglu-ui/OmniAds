# Meta Engine v1 ME3 Persona Consultations

Timestamp: 2026-05-08T13:44:49Z

## Aria: Diagnostic Priority

Question: Aria, given ROAS drops can come from tracking, fatigue, edits, auction, or seasonality, how should anomaly cards guide the operator?

Response: Show the operator an ordered ladder instead of one action. Start with tracking, then fatigue, then recent edits, then auction pressure, then seasonality. This prevents a budget or bid action from masking a creative/funnel problem.

Implementation outcome: ME3 adds `diagnosticLadder` metadata to anomalies and renders ordered diagnostic steps in anomaly cards and drill drawers.

## Dr. Lin: Severity Thresholds

Question: Dr. Lin, how should anomaly severity behave when the signal is directional but not conclusive?

Response: Keep severity tied to magnitude and preserve low/medium states. Detection should not imply a direct action; it should create an investigation object with clear evidence and ordered checks.

Implementation outcome: Existing magnitude-based severity remains unchanged. The ladder augments diagnostics without changing thresholds or creating single-action recommendations.

## Marcus: Fast Pause Versus Investigate

Question: Marcus, when should anomaly output pause quickly rather than diagnose?

Response: Policy blocks and severe delivery failure can be urgent, but the anomaly stream should still open diagnostics first unless a separate recommendation row says pause or cut. Do not mix anomaly cards with action cards.

Implementation outcome: ME3 keeps anomaly kind diagnose-first. UI primary copy is "Open diagnostic", and label mapping continues to map anomaly kind to `diagnose`.

## Trade-Off Decision

ME3 keeps anomalies as investigation-first objects. Any later pause/cut action must be emitted by the decision core as a recommendation, not by the anomaly ladder itself.
