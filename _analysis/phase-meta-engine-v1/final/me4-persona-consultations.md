# Meta Engine v1 ME4 Persona Consultations

Timestamp: 2026-05-08T13:47:48Z

## Sam: Mode Classification

Question: Sam, given ME4 introduces account operating mode, how should the architecture avoid mixing commercial runbook labels with engine behavior?

Response: Use a small Meta-specific classifier that emits engine-readable modes, not the broader commercial truth labels. Keep the output simple: `aggressive_volume` or `profit_first`, grounded in spend movement, ROAS-to-target, purchase growth, and constrained bidding share.

Implementation outcome: ME4 adds `classifyMetaOperatingMode()` with account-relative inputs and exposes its output through account pulse.

## Marcus: Mode-To-Action Mapping

Question: Marcus, how should scale ceilings differ between aggressive volume and profit-first accounts?

Response: Aggressive volume can tolerate a higher controlled ceiling, especially in peak conditions, but profit-first accounts should cap moves tightly and taper during post-peak or unstable regimes.

Implementation outcome: ME4 adds `modeAwareScaleCeiling()` with 30% peak/aggressive, 25% aggressive, 15% normalized profit-first, and 10% post-peak/unstable ceilings.

## Trade-Off Decision

ME4 keeps mode/regime classification deterministic and account-history grounded. It does not introduce user-facing generic industry benchmarks and does not infer seasonality from calendars alone.
