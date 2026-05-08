# Meta Engine v1 ME2 Persona Consultations

Timestamp: 2026-05-08T13:45:00Z

## Marcus: Cut/Scale Thresholds

Question: Marcus, given ME2 needs broad state coverage without mass-firing actions, how do you weigh fast cut/scale thresholds?

Response: Keep state coverage broad, but do not let state rows soften bad spend. A severe loser can still bypass sample patience when spend is above the account hard-cut line and ROAS is under the calibrated lower band. Scaling should stay controlled at 10-15% unless a later mode/regime layer explicitly raises the ceiling.

Implementation outcome: ME2 keeps existing sparse action recommendations and adds state rows separately. State rows do not become scale/cut actions; defensive `scale_for_profitability` language maps to `tune`, not `scale`.

## Dr. Lin: Sample Gates And Missing Signals

Question: Dr. Lin, given many scenario signals are nullable or unavailable, how should ME2 treat confidence?

Response: Missing signal rows must cap confidence. Nullable schema is acceptable only if quality/source metadata travels with snapshots. Do not infer learning state, audience overlap, tracking quality, or creative age from names.

Implementation outcome: ME2 adds nullable signal schema and state-row `signalQuality` metadata. Missing signal state rows default to low confidence; high-confidence destructive/scale decisions remain tied to existing calibrated metrics.

## Aria: Fatigue And Funnel Diagnostics

Question: Aria, given ME2 is decision-core foundation, how should creative/funnel judgment enter without overfitting?

Response: Fatigue, CTR decay, and event ladder rules should exist as explicit scenario labels, but should diagnose or refresh only when the signal source is present. If the signal is missing, say it is missing and watch rather than pretending it is healthy.

Implementation outcome: ME2 type coverage includes E/F/G scenario rec types and label behavior. Missing creative/funnel signals are represented as state/watch coverage rather than high-confidence refresh or switch.

## Sam: State Rows And Structure

Question: Sam, given the current table accepts recommendation/anomaly kinds only, how should ME2 establish per-entity coverage?

Response: Use a compatibility shim for now. Persist `entity_state` rows under the existing recommendation kind, but mark them with `decision_label`, `state_reason`, and target metadata so ME5/ME7 can separate coverage from action density. Avoid risky constraint replacement until production shape is verified.

Implementation outcome: ME2 uses `entity_state` rows as coverage rows, keeps recommended action text as no-action/state, and documents that state rows must not satisfy action density.

## Trade-Off Decision

ME2 chooses the Sam/Lin-safe compatibility shim over immediate `kind='state'` constraint replacement. This avoids a schema hard stop while still making per-eligible-entity coverage testable. The cost is that state rows live under `kind='recommendation'` until a later migration safely extends the constraint.
