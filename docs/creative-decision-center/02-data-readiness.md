# Creative Decision Center V2.1 Data Readiness

## Live Data Readiness Test

The spike script was run:

```bash
node --import tsx scripts/creative-decision-center-v21-spike.ts
```

Live DB/API was not used.

| Item | Result |
|---|---|
| `DATABASE_URL` | missing |
| Live snapshot read | not attempted |
| Write/mutation API | not called |
| Fallback | fixture-backed report |
| Generated artifact | `docs/creative-decision-center/generated/data-readiness-coverage.json` |

## Repo Evidence For Required Fields

| Field | Current availability | Evidence |
|---|---|---|
| spend, purchases, impressions, ROAS, CPA, CTR, CPM | yes | `MetaCreativeRow` in `components/platforms/meta/creatives/metricConfig.ts` lines 105-115; V1 input lines 176-184 |
| historical windows last3/7/14/30/90 | yes | `CreativeDecisionOsHistoricalWindows` in `lib/creative-decision-os.ts` lines 153-160 |
| launch date | partial | `MetaCreativeRow.launchDate` line 102; mapper derives from ad created time or insight date at `lib/meta/platforms/meta/creatives-row-mappers.ts` line 491 |
| firstSeenAt / firstSpendAt | no | No public row/type field found |
| spend24h / impressions24h | no | V1/V2 use aggregate/recent windows, no explicit 24h fields |
| campaign/adset active status | partial | V1 `CreativeDecisionDeliveryContext` lines 213-221 has campaign/adset status and active/paused delivery |
| ad active status | no/partial | Meta fetcher filters effective statuses but public row type does not expose ad status |
| reviewStatus / disapprovalReason / limitedReason | no | Fetcher filters `PENDING_REVIEW`, `DISAPPROVED` at `lib/meta/platforms/meta/creatives-fetchers.ts` lines 306-310 but mapper/type do not expose review/disapproval reasons |
| effectiveStatus | no/partial | Fetcher status filter exists, public row lacks field |
| benchmark reliability | yes | V1 creative has `benchmarkReliability` line 457 |
| fatigue trends | partial | V1 fatigue object and historical windows exist; explicit CTR/CPM/frequency trend fields absent |
| creative family grouping | yes | V1 family fields lines 431-433 and family type lines 471-487 |
| approved but unused creative | no | Requires status + zero delivery + approval distinction |
| backlog/brief/production status | no | No creative production/backlog contract found |
| attribution/truth quality | partial | V1 trust/provenance and operator policy missing evidence exist |
| data freshness | partial | snapshot/source window exists; no per-row freshness field |

## Buyer Action Matrix

| action | requiredData | currentlyAvailable | whereAvailable | missingFields | likelyDataSource | backendWorkNeeded | safeFallbackIfMissing | canMVPEmit | confidenceImpact |
|---|---|---|---|---|---|---|---|---|---|
| scale | spend, purchases, ROAS/CPA, benchmark, truth, maturity | yes/partial | V1 rows, V2 input, operator policy | per-account target thresholds | commercial truth/config | config + adapter | test_more/diagnose_data | conditional | Missing target/truth lowers confidence |
| cut | mature spend, CPA/ROAS vs target, recent recovery, truth | partial | V1/V2 metrics, scoring | target CPA/ROAS, attribution quality | commercial truth/config | target plumbing | diagnose_data | conditional | Hard cut unsafe without maturity/truth |
| refresh | composite fatigue trend, mature winner context | partial | V1 fatigue + windows | explicit ctr/cpm/frequency trend fields | warehouse historical windows | trend feature builder | test_more/diagnose_data | conditional | Single-metric fatigue must be low confidence |
| protect | stable winner, sufficient history, no fatigue | partial | V1 lifecycle/operator | explicit freshness/truth | V1 + trust | adapter only initially | test_more | yes conditional | Medium if benchmark weak |
| test_more | low sample/maturity | yes | V1/V2/scoring | none critical | existing rows | adapter | diagnose_data if data stale | yes | Safe default |
| watch_launch | launch/first-spend age, early spend/purchase | partial/no | `launchDate` only | firstSeenAt, firstSpendAt, reliable launch age | Meta ad created_time + insight earliest spend | data enrichment | diagnose_data | conditional only | Current launchDate may be misleading |
| fix_delivery | ad/campaign/adset active, 24h spend/impressions zero | no/partial | campaign/adset context only | spend24h, impressions24h, adStatus | Meta insights 24h + ad effective status | required | diagnose_data | no until enriched | Must not emit without proof |
| fix_policy | review/effective status and reasons | no/partial | fetch filter only | reviewStatus, effectiveStatus, disapprovalReason, limitedReason | Meta ads/adcreatives delivery/review fields | required | diagnose_data | no until enriched | Must not emit without proof |
| diagnose_data | freshness/truth/missing evidence | partial | trust/provenance/snapshot | per-row freshness | snapshot/source metadata | minor | diagnose_data | yes | Honest fallback |
| brief_variation | family winner/fatigue/no backups/backlog | partial/no | V1 family/supply plan | production backlog, backup variants | creative ops/DB | required for high confidence | disable aggregate | conditional/low | Do not attach row-level |
| creative_supply_warning | recent winner gap/backlog | no/partial | V1 supply plan | backlog, last winner date | production system + snapshots | required | disable aggregate | no | High false positive risk |
| winner_gap | last winner date | no | not explicit | last winner date | derived from historical V1 snapshots | backend derivation | disable aggregate | no | Cannot infer from one snapshot |
| fatigue_cluster | top N fatigue proof | partial | fatigue + family/order | top creative rank, trend fields | V1 + historical windows | feature builder | disable/low confidence | conditional | Needs composite trend |
| unused_approved_creatives | approved status + no spend | no | not exposed | effective/review status, zero delivery | Meta statuses + 24h/lifetime insights | required | disable aggregate | no | Unsafe now |

## Fixture Coverage Output

The fixture-backed spike intentionally includes target V2.1 fields. It is not proof live data exists.

| Metric | Fixture result |
|---|---:|
| Total creatives | 35 |
| Scale/cut eligible | 11.43% |
| Fix delivery eligible | 2.86% |
| Fix policy eligible | 8.57% |
| Watch launch eligible | 51.43% |
| Fatigue/refresh eligible | 2.86% |
| Diagnose data rate | 22.86% |

Blunt conclusion: `scale`, `protect`, `test_more`, and some `cut/refresh` can be shadowed with existing V1/V2 data. `fix_delivery`, `fix_policy`, `watch_launch`, and aggregate supply actions require explicit data gates before shipping.

