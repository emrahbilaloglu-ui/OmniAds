# ME8 Persona Consultations

Timestamp: 2026-05-09T00:09:20+03:00

## Sam - Deprecation And Architecture

Question to Sam: given ME2-redo production-wired scenario emitters now overlap older Phase 5.x rec types, should ME8 remove legacy paths or keep them as compatibility adapters?

Sam: remove only dead paths. A rec type can be old without being architecturally harmful if it still protects a buyer workflow, feeds an existing UI path, or preserves snapshot compatibility. The important v1 boundary is that buyer-facing labels are derived from `kind`, `decisionState`, and action semantics, not from brittle type-prefix rules.

Outcome: ME8 did not remove `scale_for_profitability`, `bid_strategy_fit`, `campaign_structure`, or `scaling_structure_fit`. Each remains active or compatibility-relevant. The deprecation audit marks them as engine v2 migration candidates rather than v1 deletion targets.

## Dr. Lin - Calibration Cadence And Confidence Caps

Question to Dr. Lin: is the v1 runbook cadence statistically defensible if calibration runs daily, signal backfill follows calibration, and snapshots read the latest signal rows before recommendation emission?

Dr. Lin: daily cadence is defensible if missing or low-quality signals cap confidence and do not produce high-confidence action rows. Calibration should fall back from sparse campaign scopes to account scope rather than forcing thin campaign-level thresholds. Signal rows should carry quality/source metadata so operators can distinguish API-authoritative, inferred, and missing signals.

Outcome: the runbook documents daily calibration, signal backfill after calibration, snapshot after signal backfill, account-scope fallback for sparse calibration, and confidence caps when signal quality is missing or inferred.

## Trade-Off

Sam favored compatibility stability over aggressive cleanup. Lin favored conservative confidence handling over action-density pressure. ME8 follows both recommendations: no active rec path is deleted, and the operator runbook frames low action density as a calibrated production baseline rather than a defect.
