# Automatic Campaign Context Shadow Evaluation - 2026-06-01 to 2026-07-05

Read-only shadow evaluation of the Automatic Campaign Context Resolver (D033). This report is NOT production approval: no resolver behavior, guard behavior, DB state, provider state, or UI consumption changed.

## Live Status

- generatedAt: 2026-07-06T07:39:30.471Z
- resolverVersion: campaign-context-resolver.v1-shadow-2026-07-06
- engineVersion (guard-impact join): v3-2026-07-02-math-guardrails
- window: 2026-06-01 .. 2026-07-05, feature window 28d, weekly asOf grid
- source: live_db_read_only; tables: meta_creative_daily, meta_campaign_daily, meta_campaign_labels, engine_v3_decision_snapshots_daily, businesses

## EMOLOS

- campaigns evaluated: 11
- class counts: {"unknown/unknown":6,"main/medium":3,"unknown/conflict":2}
- lineage: 11/205 creatives visibly multi-campaign (coverage 0.0537)
- hysteresis: 0 campaigns with confirmed flips, 5 with suppressed one-off flips

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 3 (active in final window: 0, dormant: 3)
- active-labeled agreement: 0/0 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 0/3
- high-confidence agreement: 0/0
- false-Test (high confidence): 0/0
- false-Test (any class): 0/3
- without-lineage active agreement (ablation): 0/0

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EMB-API-Test-ABO-M25-54-GBUSNLDECA-May2026 | test | unknown | unknown | dormant | n/a (dormant) |
| EMB-Retest-Orphans-HOLD-ABO-M25-54-GBUSDECA-May2026 | test | unknown | unknown | dormant | n/a (dormant) |
| EMB-BidCap-DiscoveryPrune-M25-54-GBUSDECA-May2026 | main | unknown | unknown | dormant | n/a (dormant) |

### Spot-check package (3 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| EMB-Perm-UK-2026Q2 | main | medium | behavioral | 0.5768 | 1490 | scores test=0.05 main=0.5768 margin=0.5268 agreeing=[behavioral+naming+continuity] |
| EMB-Perm-USCA-2026Q2 | main | medium | behavioral | 0.5358 | 1110 | scores test=0.045 main=0.5358 margin=0.4908 agreeing=[behavioral+naming+continuity] |
| EMB-Perm-DEFR-2026Q2 | main | medium | behavioral | 0.4814 | 270 | scores test=0.0983 main=0.4814 margin=0.3831 agreeing=[behavioral+naming+continuity] |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 9
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## Grandmix

- campaigns evaluated: 16
- class counts: {"unknown/unknown":11,"main/high":3,"main/medium":2}
- lineage: 6/199 creatives visibly multi-campaign (coverage 0.0302)
- hysteresis: 0 campaigns with confirmed flips, 3 with suppressed one-off flips

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 9 (active in final window: 4, dormant: 5)
- active-labeled agreement: 4/4 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 4/9
- high-confidence agreement: 3/3
- false-Test (high confidence): 0/3
- false-Test (any class): 0/9
- without-lineage active agreement (ablation): 4/4

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| Claude-2TierShelf-Discovery | test | unknown | unknown | dormant | n/a (dormant) |
| Claude-Bathroom-Winners | main | main | high | active | yes |
| Claude-DPA-USA-eski | main | unknown | unknown | dormant | n/a (dormant) |
| Claude-Bathroom-USA-BC-v2 | main | unknown | unknown | dormant | n/a (dormant) |
| Claude-OtherCountries-DPA | main | main | high | active | yes |
| Claude-MAF-R2-Test | test | unknown | unknown | dormant | n/a (dormant) |
| ASC-Niche-USA-BC | main | main | high | active | yes |
| Claude-WallArt-USA-BC-v2 | main | unknown | unknown | dormant | n/a (dormant) |
| Claude-WallArt-Winners | main | main | medium | active | yes |

### Spot-check package (1 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| Claude-DPA-USA | main | medium | behavioral | 0.5729 | 8617 | scores test=0.0232 main=0.5729 margin=0.5497 agreeing=[behavioral+structure+naming+continuity] |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 3
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## IwaStore

- campaigns evaluated: 12
- class counts: {"main/high":3,"unknown/conflict":1,"main/medium":2,"unknown/unknown":6}
- lineage: 0/104 creatives visibly multi-campaign (coverage 0)
- hysteresis: 0 campaigns with confirmed flips, 0 with suppressed one-off flips

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 5 (active in final window: 4, dormant: 1)
- active-labeled agreement: 3/4 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 3/5
- high-confidence agreement: 2/2
- false-Test (high confidence): 0/2
- false-Test (any class): 0/5
- without-lineage active agreement (ablation): 3/4

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EmB- USA-DPA | main | main | high | active | yes |
| Test Kampanyası -30 Nisan | test | unknown | conflict | active | NO |
| EmB- UK-CA-DPA | main | main | high | active | yes |
| EmB -SA-AE-QA-KW-BH-OM-DPA | main | main | medium | active | yes |
| EmB- DE-FR-ES-AU-DPA | main | unknown | unknown | dormant | n/a (dormant) |

### Spot-check package (2 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| ADTC | main | high | behavioral | 0.6084 | 552 | scores test=0.0555 main=0.6084 margin=0.5529 agreeing=[behavioral+continuity] |
| ThruPlay | main | medium | behavioral | 0.5725 | 552 | scores test=0.0556 main=0.5725 margin=0.5169 agreeing=[behavioral+continuity] |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 7
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## TheSwaf

- campaigns evaluated: 32
- class counts: {"unknown/unknown":15,"main/low":2,"main/medium":2,"test/low":1,"mixed/medium":10,"mixed/high":2}
- lineage: 17/259 creatives visibly multi-campaign (coverage 0.0656)
- hysteresis: 1 campaigns with confirmed flips, 6 with suppressed one-off flips

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 21 (active in final window: 8, dormant: 13)
- active-labeled agreement: 6/8 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 6/21
- high-confidence agreement: 2/2
- false-Test (high confidence): 0/2
- false-Test (any class): 0/21
- without-lineage active agreement (ablation): 2/8

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EMB - USA - CC - Apr2026 | main | unknown | unknown | dormant | n/a (dormant) |
| EMB - TargetOthers - CC - Apr2026 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Test_202606 | test | unknown | unknown | dormant | n/a (dormant) |
| TEST — EMB - CreativeTest - May2026 | test | unknown | unknown | dormant | n/a (dormant) |
| EMB - NonTarget - CC - Apr2026 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Core_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Catalog_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Catalog_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Catalog_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Catalog_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Core_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonTesvik_Catalog_202606 | mixed | main | medium | active | NO |
| TS_NonTesvik_Core_202606 | mixed | main | medium | active | NO |
| TS_US_Core_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Core_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_US_DPA_Value_InStock_202606 | mixed | mixed | medium | active | yes |
| TS_F5K_US_Core_Value_ReligiousDuality_202606 | mixed | mixed | high | active | yes |
| TS_F5K_US_365D_Winner_Retest_Value_202606 | mixed | mixed | high | active | yes |
| TS_F5K_US_10Jun_Hero_Value_202606 | mixed | mixed | medium | active | yes |
| TS_F5K_US_31May_Controlled_Value_202606 | mixed | mixed | medium | active | yes |
| TS_F5K_GB_Diagnostic_Value_202606 | mixed | mixed | medium | active | yes |

### Spot-check package (6 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| TS_F5K_US_DPA_Value_BestSellers_202606 | mixed | medium | family_inheritance | 0 | 2194 | insufficient_evidence spend28=2193.58 activeCreatives=1 activeDays=3; family_prefix_inheritance basis=2 members |
| TS_F5K_AUCA_DPA_Value_202606 | mixed | medium | family_inheritance | 0 | 1118 | insufficient_evidence spend28=1117.96 activeCreatives=2 activeDays=3; family_prefix_inheritance basis=2 members |
| TS_F5K_US_Core_Value_MythStyle_202606 | mixed | medium | family_inheritance | 0 | 1076 | insufficient_evidence spend28=1076.01 activeCreatives=5 activeDays=3; family_prefix_inheritance basis=2 members |
| TS_F5K_US_10Jun_Symbolic_Value_202606 | mixed | medium | family_inheritance | 0 | 714 | insufficient_evidence spend28=714.16 activeCreatives=6 activeDays=3; family_prefix_inheritance basis=2 members |
| TS_F5K_AUCA_Core_Value_202606 | mixed | medium | family_inheritance | 0 | 595 | insufficient_evidence spend28=594.78 activeCreatives=4 activeDays=3; family_prefix_inheritance basis=2 members |
| TS_F5K_DEFRITES_Diagnostic_Value_202606 | mixed | medium | family_inheritance | 0 | 226 | insufficient_evidence spend28=226.06 activeCreatives=3 activeDays=3; family_prefix_inheritance basis=2 members |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 13
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## Evidence Limits

- This is a read-only shadow evaluation. It is NOT production approval; no resolver, guard, DB, or UI consumption changed.
- Manual labels are evaluation truth only; label coverage is sparse and uneven (EMOLOS-like accounts need the spot-check package).
- Creative lineage visibility is capped by warehouse first-non-null campaign attribution; same-day multi-campaign reuse is invisible, so visibleLineageCoverage understates true reuse.
- Guard-impact numbers are APPROXIMATE: decision snapshots do not persist campaign ids; the join uses the latest meta_creative_daily campaign per creative.
- Campaign names come from meta_campaign_daily as of the data ceiling; historical renames are not versioned here.
- Weekly asOf grid hysteresis approximates daily hysteresis; production would evaluate daily.
