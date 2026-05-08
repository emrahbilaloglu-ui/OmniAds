# ME2 Redo Persona Consultations

Timestamp: 2026-05-08T18:40:21Z

## Cluster 1: Controlled Scale

Question to Marcus: given mature winners above calibrated account p75, how aggressive should scale and bid-raise recommendations be?

Marcus: scale only when the winner is materially above the account distribution and keep the edit bounded. A 10-25% budget move is acceptable for lowest-cost winners; capped winners need bid room first, not budget.

Question to Dr. Lin: what sample gates protect controlled scale from lucky spikes?

Dr. Lin: require calibrated sample availability and purchase depth. If calibration sample is thin, do not emit high-confidence scale; state/watch is better than pretending certainty.

Outcome: C1 requires calibrated ROAS p75, mature history, and purchase depth; B1 requires capped bidding, ROAS above p50, and budget utilization below 95%; J1 remains a protected keep/watch signal.

## Cluster 2: Weak Entity Action

Question to Marcus: when should weak entities stop being state rows?

Marcus: once spend is meaningful and ROAS is below the account lower quartile, a keep row is useless. Emit rebuild or diagnose so the operator can act.

Question to Sam: when does weak performance imply rebuild rather than a micro cut?

Sam: campaign-level weakness with mixed learning or poor structure should rebuild first. Cut/pause is Marcus territory at adset level; campaign state should not hide structural failure.

Outcome: A2 emits rebuild below calibrated ROAS p25 after meaningful spend; F1/F4 emit diagnose-first recommendations for sudden drops and stable-winner fade.

## Cluster 3: Creative Fatigue / Refresh

Question to Aria: how should fatigue become an action recommendation?

Aria: high frequency plus weak CTR is a refresh call, not a bid/budget call. CTR decay under stable spend should also route to creative refresh before budget action.

Question to Dr. Lin: how do we avoid fatigue false positives?

Dr. Lin: require account-relative frequency/CTR context or observed CTR decay. If the signal is missing, cap confidence instead of inventing a refresh.

Outcome: E1 uses calibrated frequency p75 and CTR context on adsets; E2/E4 use observed CTR decay with active spend and mature history.

## Cluster 4: Structural / Architecture

Question to Sam: which structural signals should outrank scale or refresh?

Sam: mixed config and test-CBO architecture must outrank scale because downstream performance is ambiguous. Fix the operating structure first.

Question to Dr. Lin: how confident can config classification be?

Dr. Lin: config booleans are deterministic when present. Emit action when the flags are present; if config is missing, do not infer the problem.

Outcome: K1 and I4 have high precedence over scale/refresh. A1 uses calibrated CPA p50 and daily budget to detect the 50-conversion math floor rather than generic benchmarks.
