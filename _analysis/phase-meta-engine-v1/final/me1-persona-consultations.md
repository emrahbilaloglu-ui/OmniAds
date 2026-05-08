# Meta Engine v1 ME1 Persona Consultations

Run date: 2026-05-08
Scope: ME1 audit and foundation only.

## Consultation 1 — Sam, Architecture and Coverage

Question:

> Sam, given the current Meta engine writes sparse recommendation rows and has 0/177 adset coverage in the R&D extract, how do you weigh sparse action-only persistence versus one persisted state row per eligible entity?

Sam response:

> Sparse action-only persistence makes the surface operationally untrustworthy. If an adset has no row, I cannot tell whether the engine protected it, skipped it, lacked data, or never ran. Architecture needs a per-eligible-entity state row. The state row can be `keep`, `watch`, `out_of_scope`, or `archived`, but it must be explicit. Then recommendations and anomalies can sit on top as action-bearing rows.

Outcome:

- ME1 recommends per-eligible-entity persisted state coverage for ME2.
- ME1 also adds action density so the system cannot claim success by writing only state/no-action rows.
- ME2 work breakdown must treat coverage and action density as separate quality gates.

Tradeoff:

- More snapshot rows and more UI state handling.
- Clearer operator semantics, better auditability, and measurable ME7 agreement.

## Consultation 2 — Dr. Lin, Calibration and Missing Signals

Question:

> Dr. Lin, given the scenario library requires metrics that are absent today, how should the engine treat nullable calibration and signal columns during the v1 rollout?

Dr. Lin response:

> Missing data must not become confidence. Add the fields nullable, but every scenario needs a sample-quality check. If daily volatility, learning state, dedup rate, CRM ratio, or audience overlap is missing, the engine can explain the gap and watch, but it cannot produce high-confidence actions from inference. Account-history percentiles are usable only when sample size is visible and adequate.

Outcome:

- ME1 schema plan keeps new signal fields nullable.
- ME1 requires `quality_status`, `source_json`, and sample/source fields.
- ME2 must cap confidence when required scenario inputs are missing or stale.

Tradeoff:

- Some scenario modules will initially emit low-confidence `watch`/`diagnose` instead of action.
- This prevents the Claude-style mass firing pattern and matches the R&D synthesis preference for nuanced judgment.

## Deferred Personas

Marcus and Aria are intentionally not ME1 sign-off personas because ME1 is architecture, coverage, calibration, and audit. They must be active in ME2 and later phases:

- Marcus: cut/scale thresholds, fast-pause patterns, severity tone, action-density review.
- Aria: creative fatigue, funnel diagnosis, optimization-event ladder, diagnostic ladder wording.

This deferral is not a removal. ME2 cannot sign off without Marcus and Aria consultations.

## ME1 Decision Summary

- Adopt per-eligible-entity state coverage.
- Add action-density as an anti-gaming metric.
- Keep new schema fields nullable.
- Require signal quality and sample gates.
- Defer operator threshold and creative/funnel judgment to ME2 with Marcus and Aria.
