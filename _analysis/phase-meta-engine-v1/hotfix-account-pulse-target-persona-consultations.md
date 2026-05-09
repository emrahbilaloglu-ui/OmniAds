# Hotfix: Account Pulse Target ROAS Provenance Persona Consultations

Timestamp: 2026-05-09T09:51:52Z

## Sam - Architecture / Provenance Contract

Question: Sam - given the Pulse strip currently labels current-window campaign ROAS median as a target, how should the API contract separate true business targets from fallback account benchmarks?

Response: Commercial Truth must be the primary provenance for buyer-facing targets. A calibrated account p50 can be a graceful fallback benchmark, but it cannot silently occupy the `target` field because that couples a statistical reference to an operator goal. The contract should expose `target`, `median`, and `target_source` explicitly so UI consumers can render the right semantics without guessing from numeric presence.

Outcome: `account-pulse` now resolves target ROAS from `business_target_packs.target_roas` first, reads `meta_decision_calibration_daily` account `roas_28d` p50 as a separate median fallback, and returns `target_source` as `commercial_truth`, `account_median`, or `none`.

## Dr. Lin - Statistical Semantics

Question: Dr. Lin - when a true Commercial Truth target is missing, should being below account median produce the same alarm state as being below target?

Response: No. The median is a distribution reference, not a performance gate. In a normal account distribution, roughly half of entities or windows can be below median; rendering that as "below target" creates false positives. Use neutral tone for account-median fallback, and only emit a below-target alarm when the target source is Commercial Truth.

Outcome: The Pulse UI renders `account median` fallback neutrally with no `below target` badge. The `below target` badge and severity tone are reserved for real Commercial Truth target comparisons.
