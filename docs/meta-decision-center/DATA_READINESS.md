# Meta Decision Center Data Readiness

This matrix records what the Meta campaign/adset decision model can safely use
after Phase G closeout and what must remain diagnose/watch until more data
exists.

| decision area | required data | current status | source / code path | safe fallback if missing |
|---|---|---|---|---|
| funnel cohort | `optimization_goal`, `custom_event_type`, objective, purchase/revenue fallback only when metadata absent | available enough for implemented paths | `lib/meta/funnel-cohort.ts`, state rows, lane classification | unknown or out-of-sales-scope lane |
| purchase hard scale/cut | target or break-even ROAS/CPA anchor, purchase metrics, maturity, fresh data | available only when target pack exists | `lib/meta/commercial-targets.ts`, recommendation/snapshot routes | no hard action; benchmark/watch/diagnose |
| purchase maturity | currency floor, CPA baseline, risk multiplier, event/active-day/recovery checks | implemented for purchase hard actions | `metaPurchaseLossBudgetMaturity(...)` | no hard purchase scale/cut |
| campaign labels | Main/Test/Mixed campaign kind | available but production adoption may be sparse | `meta_campaign_labels`, label guard, snapshot/live path | hard action downgraded to diagnostic/review-only |
| kind-aware calibration | `campaign_kind` rows for all/main/test/mixed with sufficient sample | schema/read path available; useful only when rows exist | `meta_decision_calibration_daily.campaign_kind` | canonical `all` profile |
| non-purchase adset cohorts | ATC/IC/VC, lead, traffic, engagement, ThruPlay, CTR/CPM/frequency where applicable | implemented for selected M/L/T/EG families | warehouse payload JSON, cohort calibration | cohort watch/keep or no hard cut |
| learning/edit cooldown | learning state, learning-exit evidence, days since significant edit | partially populated and used for implemented blockers | `meta_entity_decision_signals_daily` and backfill | wait/watch or no cut |
| monthly pacing | daily/lifetime budget and MTD spend | populated by signal backfill where source data exists | `lib/meta/entity-signals-backfill.ts` | no hard scale/cut when overpaced or unknown |
| tracking quality | clicks and landing-page views sufficient to judge click-to-LPV | implemented as explicit funnel-step risk | `meta_ad_daily` signal backfill | no CAPI/tracking claim |
| checkout quality | initiate-checkout volume and historical IC-to-purchase conversion | limited; only safe with explicit regression proof | warehouse funnel metrics | no checkout diagnosis from zero purchase alone |
| feed/catalog diagnostics | explicit feed status, disapproval count, or supported source JSON | limited; healthy/negated statuses guarded | high-priority emitter feed branch | no feed problem scenario |
| audience overlap/size/stage | entity-scoped overlap, size, stage, lookalike evidence | not reliable enough for hard actions | schema fields exist but source coverage weak | unsupported/diagnose/watch |
| placement mix | entity-level placement distribution and efficiency | account-level evidence exists; deeper hard gates deferred | breakdown daily + signal substrate | no placement hard action |
| empirical outcomes | explicit outcome logs with judged positive/negative sample | storage/summary/integration available; production sample may be sparse | `meta_decision_action_outcome_logs`, empirical helpers | empirical blocker or insufficient sample |
| live preflight and rollback | preflight proof, rollback proof, action execution envelope | not enabled for auto-execute | automation readiness payload | no auto-execute |
| UI action rendering | backend-provided recommendation type, decision label, automation readiness | available | Meta action card/readiness chip | UI must not derive missing decisions |

## Phase H Or Later Data Needs

The following scenario families are intentionally not Phase G blockers because
their safe implementation requires stronger source coverage:

- audience overlap consolidation and lookalike compound scale;
- cross-campaign overlap and ABO/CBO budget-shift families;
- entity-level placement mix hard gates;
- seasonal peak scale ceiling and post-peak taper;
- deeper controlled-scale automation with post-action outcomes.

Until those sources exist, the correct behavior is diagnose/watch, not a named
hard action.
