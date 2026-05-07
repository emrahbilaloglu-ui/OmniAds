# 18-20. Identity, Target, Benchmark, Timezone, Attribution, Freshness Audit

## Source-of-Truth And Identity Model

Current evidence:

| Evidence | File |
|---|---|
| Creative API supports `groupBy = "adName" | "creative" | "adSet"` | `lib/meta/platforms/meta/creatives-types.ts` lines 1-5 |
| Raw row id is ad-level while `creative_id` is separate | `lib/meta/platforms/meta/creatives-row-mappers.ts` lines 548-560 |
| Creative usage map groups `creative_id` to ad ids | `lib/meta/platforms/meta/creatives-warehouse.ts` lines 71-78 |
| Public table row exposes `id`, `creativeId`, account/campaign/adset | `components/platforms/meta/creatives/metricConfig.ts` lines 59-76 |
| V1 decision row uses `creativeId` but carries campaign/adset | `lib/creative-decision-os.ts` lines 162-210 |
| V1 family grouping exists | `lib/creative-decision-os.ts` family fields lines 431-433, family type lines 471-487 |

Blunt finding: the Creative Table row is currently often an ad-level row (`id` from ad id) presented with a `creativeId`. A V2.1 row decision must state its grain. Do not call it creative-level if the evidence is ad/adset-specific.

### Recommended Canonical Identity

| Layer | Canonical key | Purpose | MVP/deferred |
|---|---|---|---|
| Delivery row | `adId + adsetId + campaignId + accountId` | Delivery/policy/status decisions like `fix_delivery` | MVP |
| Creative object | `creativeId` | Creative-level performance summary | MVP but must show usage count |
| Asset identity | `imageHash/videoId/objectStoryId/effectiveObjectStoryId/postId` | Same asset across creatives | Deferred |
| Message identity | normalized copy/headline/description signature | Same asset with different copy | Deferred for UI; V1 family may use |
| Landing-page identity | destination URL/final URL | Same creative different LP | Deferred; required for CVR diagnosis |
| Family/concept | V1 familyId + provenance | Aggregate `brief_variation`, fatigue clusters | MVP aggregate only if reliable |

### Edge Cases

| Case | Current handling | V2.1 recommendation |
|---|---|---|
| Duplicate creative across campaigns/adsets | Usage map exists; decisions may be row-specific | Show row grain and conflicting placements; aggregate only when signals agree |
| Same asset + different copy | V1 family seed can group by story/asset/copy | Keep as family evidence, not row buyerAction |
| Same creative + different landing pages | Not reliably modeled | Defer; if high CTR poor CVR, diagnose_data/landing issue only |
| One adset winner, another loser | Current row can carry campaign/adset context | Do not emit creative-level cut; emit row-level/ad delivery context |
| Missing asset/family identity | V1 singleton fallback | Use `familyId = null` or singleton with low confidence; disable aggregate |

Required row fields: `accountId`, `campaignId`, `adsetId`, `adId`, `creativeId`, `familyId`, `identityGrain`, `assetIds`, `copySignature`, `landingPageKey`, `associatedAdsCount`, `conflictSummary`.

## Target And Benchmark Source Audit

| targetType | source | scope | available | usedBy | missingFallback | riskIfMissing |
|---|---|---|---|---|---|---|
| target CPA | `business_target_packs.target_cpa` | business/account default | partial | V1 economics, commercial truth | cap confidence, diagnose_data for hard cut/scale | High-confidence scale/cut becomes arbitrary |
| target ROAS | `business_target_packs.target_roas` | business/account default | partial | V1 economics, commercial truth | use benchmark only with cap | Scale/cut based on relative benchmark only |
| break-even CPA/ROAS | `business_target_packs` | business | partial | economics guardrails | review-only | Profitability context missing |
| country economics | `business_country_economics` | country/GEO | partial | operating mode/commercial truth | account default | GEO decisions can be wrong |
| calibration profile multipliers | calibration rows | channel/objective/bid regime/archetype | partial | commercial truth | default multipliers | Campaign/funnel mismatch |
| campaign bid target | Meta campaign bid constraints | campaign | partial | Meta recommendations | show as contextual only | Could conflict with business target |
| benchmark reliability | V1 relative baseline | account/campaign cohort | yes/partial | V1/V2/operator | cap confidence if weak/unavailable | False winner/loser |

Evidence:

| Evidence | File |
|---|---|
| Target pack DB row has `target_cpa`, `target_roas`, break-even fields | `lib/business-commercial.ts` lines 64-77 |
| Target pack is read from `business_target_packs` | `lib/business-commercial.ts` lines 1100-1119 |
| Target pack is persisted with target CPA/ROAS | `lib/business-commercial.ts` lines 1268-1315 |
| V1 economics carries target and break-even fields | `lib/creative-decision-os.ts` lines 325-335 |
| V1 commercial truth coverage tracks configured sections | `lib/creative-decision-os.ts` lines 1013-1030 |
| V2 only gets `activeBenchmarkRoas`, `activeBenchmarkCpa`, `baselineReliability`; no target fields | `lib/creative-decision-os-v2.ts` lines 30-53 |

Rules:

| Rule | Required behavior |
|---|---|
| Target missing | No high-confidence scale/cut |
| Benchmark weak | Confidence capped; drawer says "weak benchmark" |
| Target source ambiguous | Drawer says "target unknown / weak benchmark" |
| Campaign target conflicts with business target | review_only and show both |

Target config schema should support business default, account override, campaign override, objective/funnel override, country modifier, effective target source label, updatedAt, and confidence cap.

## Timezone, Attribution, Freshness

| Topic | Current behavior | Risk | Recommended normalized model |
|---|---|---|---|
| Server date defaults | API defaults use `new Date()` and `toISOString()` | UTC day can differ from Meta account day | Inject account timezone clock and record basis |
| Meta warehouse current day | Warehouse has account timezone helper | Good for sync, not yet exposed to decision rows | Carry account timezone into feature rows |
| Date math | `lib/meta/history.ts` uses UTC ISO date math | Fine for stored dates, unsafe for "last 24h" language | Distinguish daily insight date range vs rolling 24h |
| Launch date | Mapper uses `ad.created_time` or `insight.date_start` | Could be first seen, not first spend | Store `launchBasis: firstSeenAt|firstSpendAt|firstInsightDate` |
| Last 24h | Not exposed | Cannot honestly emit `fix_delivery` | Use stored hourly/rolling if available; otherwise say last verified day |
| Attribution window | Not explicit in creative decision row | ROAS/CPA can shift | Store attribution setting/source on snapshot |
| Stale data | Warehouse has freshness/truth concepts | Not per-row in V2 input | V2.1 input needs `dataFreshnessHours` and truth state |

Evidence:

| Evidence | File |
|---|---|
| UTC date helper | `lib/meta/history.ts` lines 4-13 |
| Account timezone helper | `lib/meta/warehouse.ts` lines 160-178 |
| Current account day uses account timezone | `lib/meta/warehouse.ts` lines 180-193 |
| Mapper launch date from ad created or insight date | `lib/meta/platforms/meta/creatives-row-mappers.ts` line 586 and earlier line 491 in audit |

Do not call daily insights "last 24h". If the source is yesterday/today daily insight, label it "last verified Meta day" or "today observed daily slice".

