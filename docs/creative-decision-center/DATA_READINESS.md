# Data Readiness

Status: framework plus known risks. Live data coverage is TODO unless a read-only snapshot/DB audit is run.

Known facts to preserve unless repo evidence proves otherwise:

- V3 input now carries `ctr`, `cpm`, `frequency`, `firstSeenAt`, `firstSpendAt`, `spend24h`, `impressions24h`, `reviewStatus`, `disapprovalReason`, and `limitedReason` where warehouse rows expose them.
- `fix_delivery`, `fix_policy`, and `watch_launch` remain proof-gated: they may emit only when those fields are present and the bridge can map the server-produced diagnostic badge.
- If required data is missing, fallback to `diagnose_data` or cap confidence.
- `brief_variation` requires family grouping / supply / backlog / winner gap data and should be aggregate only.

## Buyer Actions

| action | requiredData | currentlyAvailable | whereAvailable | missingFields | likelyDataSource | safeFallbackIfMissing | canMVPEmit | confidenceImpact |
|---|---|---|---|---|---|---|---|---|
| scale | spend, purchases, CPA/ROAS, target or benchmark, truth, maturity | partial | V1/V2 metrics, commercial truth partial | target source, freshness, attribution quality | business target config, snapshot trust | test_more / diagnose_data | conditional | cap if target/benchmark/truth weak |
| cut | mature spend, CPA/ROAS vs target, no recovery, truth | partial | V1/V2 metrics | target source, maturity, freshness | commercial truth, historical windows | diagnose_data | conditional | no high-confidence cut without maturity/truth |
| refresh | CTR/CPM/frequency trend, fatigue proof, winner context | partial | V1 fatigue/historical windows | explicit `ctr`, `cpm`, `frequency` trend fields in V2 input | historical feature enrichment | test_more / diagnose_data | conditional | single-metric fatigue is low confidence |
| protect | stable winner, adequate history, no blockers | partial | V1 lifecycle/operator, V2 Protect | freshness/target context | V1/V2 + trust | test_more / diagnose_data | conditional | cap if benchmark weak |
| test_more | low maturity/insufficient signal | yes/partial | V1/V2/scoring | none critical | current metrics | diagnose_data if stale | yes | safe default |
| watch_launch | firstSeenAt/firstSpendAt/launch age, early spend/purchase | partial | V3 input from warehouse/lifecycle + latest Meta row | complete first-spend coverage where warehouse lacks it | Meta ad created_time + earliest spend insight | diagnose_data | conditional | emitted only with explicit launch basis |
| fix_delivery | active ad/campaign/adset + 24h no spend/impressions | partial | V3 input from latest daily warehouse row | campaign/adset active status still partial | Meta ad/adset/campaign status + latest daily insights | diagnose_data | conditional | must not emit without spend/impression proof |
| fix_policy | review/effective status + disapproval/limited reason | partial | V3 input from effective status + payload review/reason fields | Meta review fields depend on payload availability | Meta ad/ad creative review fields | diagnose_data | conditional | must not emit without policy/review proof |
| diagnose_data | missing required data, stale data, truth issue | partial | trust/provenance/snapshot | per-row freshness and missingData summary | snapshot/source health | diagnose_data | yes | honest fallback |

## Aggregate Actions

| action | requiredData | currentlyAvailable | whereAvailable | missingFields | likelyDataSource | safeFallbackIfMissing | canMVPEmit | confidenceImpact |
|---|---|---|---|---|---|---|---|---|
| brief_variation | family winner/fatigue, no backup, backlog/supply | partial/no | V1 family/supply plan partial | backlog, production status, backup variants | creative ops data + V1 family | disable aggregate | conditional/low | high false positive risk |
| creative_supply_warning | creative supply/backlog/winner gap | no | unknown | backlog, recent launches, production state | planning/ops system | disable aggregate | no | cannot be confident |
| winner_gap | winner cadence window + historical snapshot window | no/partial | historical snapshots if available | fresh persisted decision snapshots | historical decision snapshots | disable aggregate | no until derived | avoid fake supply alarm |
| fatigue_cluster | top N fatigue proof | partial | V1 fatigue/historical metrics | top N definition, trend fields | feature enrichment | disable/low confidence | conditional | composite proof required |
| unused_approved_creatives | explicit approved review status + no delivery | no/partial | `meta_creative_daily` aggregate when review/approval status proof and zero lifetime delivery proof exist | explicit review-status enrichment is still sparse; active effective status is not enough | Meta review status + lifetime insights | suppress aggregate | conditional | must not infer from spend alone, active status alone, or missing status proof |
