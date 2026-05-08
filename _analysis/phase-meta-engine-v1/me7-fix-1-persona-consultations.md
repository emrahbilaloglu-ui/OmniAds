# ME7 Fix 1 Persona Consultations

Timestamp: 2026-05-08T15:44:25Z

## Sam: Architecture Consultation

Question: Sam — given the ME7 asymmetry where adset state rows existed but campaign rows were absent until a targeted rerun, is this a pure implementation bug or a deeper rec-emission contract asymmetry between campaign and adset levels?

Response: Treat it as an implementation/completeness bug, not a reason to redesign the contract. The state-row contract is correct: every mature entity needs one coverage row even when no action fires. The weak point is the scheduler accepting partial persisted output as complete, plus shared `entity_state` naming that makes campaign/adset coverage harder to audit.

Outcome: The fix keeps the ME2 state-row contract, strengthens the daily skip guard to require both campaign and adset rows per active business, and splits state rec types into `campaign_state` and `adset_state` for clearer architecture and coverage reporting.

## Dr. Lin: Confidence Consultation

Question: Dr. Lin — if state rows are added at scale, what confidence convention should they carry, especially when signal rows are missing or nullable?

Response: State rows should remain `decisionState="watch"` with low confidence by default. They are coverage and denominator rows, not action recommendations. If the row is a stable winner protected by calibrated account history, medium confidence is acceptable, but missing signal tables must cap confidence and prevent high-confidence scale/cut/rebuild labels.

Outcome: The existing state-row convention remains: `watch` decision state, low confidence score `0.35` for ordinary state rows, medium `0.6` only for `stable_winner_protected`, and `signalQuality.confidence_cap="low_without_signal_table"` when the expanded signal table is unavailable.
