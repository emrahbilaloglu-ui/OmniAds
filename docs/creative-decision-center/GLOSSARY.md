# Glossary

| term | definition |
|---|---|
| primaryDecision | Engine root decision: `Scale`, `Cut`, `Refresh`, `Protect`, `Test More`, `Diagnose`. |
| buyerAction | Buyer-facing action from deterministic adapter: `scale`, `cut`, `refresh`, `protect`, `test_more`, `watch_launch`, `fix_delivery`, `fix_policy`, `diagnose_data`. |
| legacyBuyerAction | Historical V2.1 adapter output retained for audit. Meta Decisions may project `diagnose_data` into a blocked resolution instead of a buyer action. |
| decisionState | Meta Decisions served state: `act`, `monitor`, `blocked`, or `not_applicable`. |
| resolution | Server-produced task for a blocked decision, including code, category, owner, label, and next step. |
| heldAction | Nullable Scale, Cut, or Refresh signal withheld by a safety/context guard and persisted as `blocked_action_type`. |
| actionability | Safety/operation posture such as direct, review-only, blocked, or diagnose. |
| problemClass | Root class explaining what kind of issue/opportunity exists: performance, delivery, policy, data_quality, etc. |
| maturity | Whether enough evidence exists to judge performance: too_early, learning, actionable, mature. |
| confidence | Trust in the recommendation's correctness, capped by missing data/truth/benchmark/target. |
| priority | Urgency or impact of action. Can be high even when confidence is low. |
| decisionCenter | V2.1 output surface containing row decisions, aggregate decisions, Today Brief, and Action Board. |
| rowDecision | Decision tied to one row/ad/creative identity grain. |
| aggregateDecision | Page/family-level decision such as `brief_variation` or winner gap. |
| shadow mode | Compute V2.1 output without changing production UI/default behavior. |
| read-time adapter | Adapter that lets old snapshots render in new UI shape without rewriting stored snapshots. |
| config-as-data | Thresholds and policy settings stored in config, not scattered in resolver code. |
| golden case | Expected media-buyer scenario asserting primary, buyerAction, actionability, problemClass, priority, confidence, reason, maturity, fallback. |
| invariant | Hard rule that must hold across all cases. |
| feature enrichment | Layer that builds canonical feature rows from raw Meta/business/snapshot data. |
| data freshness | Age and reliability of source data used for decisioning. |
| benchmark reliability | Strength of relative comparison context. |
| target source | Source/scope of CPA/ROAS/KPI target used to judge performance. |
| adapterVersion | Version of buyer adapter mapping rules. |
| engineVersion | Version of V2.1 engine logic. |
| configVersion | Version of threshold/config set used for a snapshot. |
