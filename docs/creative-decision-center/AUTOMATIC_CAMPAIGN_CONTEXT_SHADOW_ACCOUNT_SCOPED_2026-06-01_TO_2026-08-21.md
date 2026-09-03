# Automatic Campaign Context Shadow Evaluation - 2026-06-01 to 2026-08-21

Read-only shadow evaluation of the Automatic Campaign Context Resolver (D033). This report is NOT production approval: no resolver behavior, guard behavior, DB state, provider state, or UI consumption changed.

## Live Status

- generatedAt: 2026-08-29T17:34:34.662Z
- resolverVersion: campaign-context-resolver.v2-account-scoped-2026-08-29
- engineVersion (guard-impact join): v3-2026-07-02-math-guardrails
- window: 2026-06-01 .. 2026-08-21, feature window 28d, asOf grid: 82 dates
- source: live_db_read_only; tables: meta_creative_daily, meta_campaign_daily, meta_campaign_labels, engine_v3_decision_snapshots_daily, businesses

## Bilsem Zeka

- campaigns evaluated: 16
- class counts: {"unknown/unknown":7,"main/medium":4,"main/low":4,"mixed/high":1}
- lineage: 92/238 creatives visibly multi-campaign (coverage 0.3866)
- hysteresis (production applyDailyHysteresis, causal): raw flips on 14 campaigns (43 total), published flips on 14 campaigns (41 total), 14 campaigns with suppressed days, 0 with final published!=raw divergence

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 7 (active in final window: 7, dormant: 0)
- active-labeled agreement: 4/7 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 4/7
- high-confidence agreement: 1/1
- false-Test (high confidence): 0/1
- false-Test (any class): 0/7
- without-lineage active agreement (ablation): 4/7

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EmB-Şampiyon Ali Koç-Thruplay-20 Ağustos | mixed | main | medium | active | NO |
| EmB-Purchase-Dikkat ve Hafıza Gelişim-2 Haziran | main | main | low | active | yes |
| EmB-Lead-İlkokul-2 Haziran | mixed | mixed | high | active | yes |
| EmB-Erken Kayıt-2 Haziran | main | main | medium | active | yes |
| EmB-Purchase-Okul Öncesi-2 Haziran | main | main | medium | active | yes |
| EmB-Lead-Okul Öncesi-2 Haziran | mixed | main | medium | active | NO |
| EmB-Profil Ziyareti-15 Temmuz | mixed | main | low | active | NO |

### Spot-check package (0 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 6
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## ColorFullWorldsTR

- campaigns evaluated: 4
- class counts: {"unknown/unknown":2,"main/high":2}
- lineage: 0/56 creatives visibly multi-campaign (coverage 0)
- hysteresis (production applyDailyHysteresis, causal): raw flips on 3 campaigns (10 total), published flips on 3 campaigns (6 total), 3 campaigns with suppressed days, 0 with final published!=raw divergence

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 2 (active in final window: 1, dormant: 1)
- active-labeled agreement: 1/1 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 1/2
- high-confidence agreement: 1/1
- false-Test (high confidence): 0/1
- false-Test (any class): 0/2
- without-lineage active agreement (ablation): 1/1

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EMB-Advantage - 25 Mart | main | unknown | unknown | dormant | n/a (dormant) |
| Retargeting - 13 mart | main | main | high | active | yes |

### Spot-check package (1 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| EmB-Cost Cap-21 may. | main | high | behavioral | 0.6442 | 1414 | scores test=0.15 main=0.6442 margin=0.4942 agreeing=[behavioral+structure+continuity] |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 2
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 2
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## Grandmix

- campaigns evaluated: 18
- class counts: {"unknown/unknown":13,"main/high":4,"main/low":1}
- lineage: 17/228 creatives visibly multi-campaign (coverage 0.0746)
- hysteresis (production applyDailyHysteresis, causal): raw flips on 11 campaigns (23 total), published flips on 11 campaigns (23 total), 11 campaigns with suppressed days, 0 with final published!=raw divergence

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 12 (active in final window: 5, dormant: 7)
- active-labeled agreement: 5/5 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 5/12
- high-confidence agreement: 4/4
- false-Test (high confidence): 0/4
- false-Test (any class): 0/12
- without-lineage active agreement (ablation): 5/5

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
| Claude-WallArt-Winners | main | unknown | unknown | dormant | n/a (dormant) |
| Claude-DPA-USA | main | main | high | active | yes |
| GMX-Higgsfield-WallArt30Jun-AllAssets-Test-20260706-R1 | main | unknown | unknown | dormant | n/a (dormant) |
| Claude-WallArt-LAL3-CostCap-v1 | main | main | low | active | yes |

### Spot-check package (0 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 3
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 3
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## IwaStore

- campaigns evaluated: 16
- class counts: {"unknown/unknown":12,"main/medium":1,"unknown/conflict":1,"main/high":1,"test/high":1}
- lineage: 18/153 creatives visibly multi-campaign (coverage 0.1176)
- hysteresis (production applyDailyHysteresis, causal): raw flips on 16 campaigns (48 total), published flips on 16 campaigns (43 total), 16 campaigns with suppressed days, 2 with final published!=raw divergence

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 10 (active in final window: 2, dormant: 8)
- active-labeled agreement: 2/2 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 2/10
- high-confidence agreement: 2/2
- false-Test (high confidence): 0/2
- false-Test (any class): 0/10
- without-lineage active agreement (ablation): 2/2

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EmB- USA-DPA | main | unknown | unknown | dormant | n/a (dormant) |
| Test Kampanyası -30 Nisan | test | unknown | unknown | dormant | n/a (dormant) |
| EmB- UK-CA-DPA | main | unknown | unknown | dormant | n/a (dormant) |
| EmB -SA-AE-QA-KW-BH-OM-DPA | main | unknown | unknown | dormant | n/a (dormant) |
| EmB- DE-FR-ES-AU-DPA | main | unknown | unknown | dormant | n/a (dormant) |
| EmB- USA - Cost Cap | main | unknown | unknown | dormant | n/a (dormant) |
| EmB- UK-CA - cost cap | main | unknown | unknown | dormant | n/a (dormant) |
| EmB- DE-FR-ES-AU - cost cap | main | unknown | unknown | dormant | n/a (dormant) |
| IWA | SALES | CATALOG ACQ | COSTCAP | ABO | 7DC1DV | main | main | high | active | yes |
| IWA | SALES | CREATIVE LAB | COSTCAP | ABO | 7DC1DV | test | test | high | active | yes |

### Spot-check package (1 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| IWA | SALES | CATALOG ACQ | ABO | 7DC1DV | main | medium | behavioral | 0.5391 | 2539 | scores test=0.1 main=0.5391 margin=0.4391 agreeing=[behavioral+structure+naming] |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 7
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## IwaTR

- campaigns evaluated: 4
- class counts: {"main/medium":1,"unknown/unknown":3}
- lineage: 4/107 creatives visibly multi-campaign (coverage 0.0374)
- hysteresis (production applyDailyHysteresis, causal): raw flips on 3 campaigns (11 total), published flips on 3 campaigns (11 total), 3 campaigns with suppressed days, 0 with final published!=raw divergence

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 0 (active in final window: 0, dormant: 0)
- active-labeled agreement: 0/0 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 0/0
- high-confidence agreement: 0/0
- false-Test (high confidence): 0/0
- false-Test (any class): 0/0
- without-lineage active agreement (ablation): 0/0

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |

### Spot-check package (1 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| EmB-Prospecting-27 Haziran | main | medium | behavioral | 0.5911 | 1824 | scores test=0.1635 main=0.5911 margin=0.4276 agreeing=[behavioral+structure+continuity] |

### Guard impact (APPROXIMATE)

- snapshot asOf: null
- guard-blocked hard rows: 0
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## TheSwaf

- campaigns evaluated: 49
- class counts: {"unknown/unknown":41,"main/high":1,"main/low":3,"main/medium":3,"test/high":1}
- lineage: 31/374 creatives visibly multi-campaign (coverage 0.0829)
- hysteresis (production applyDailyHysteresis, causal): raw flips on 26 campaigns (68 total), published flips on 26 campaigns (58 total), 21 campaigns with suppressed days, 1 with final published!=raw divergence

### Evaluation vs manual labels (exact counts)

- labeled campaigns: 25 (active in final window: 5, dormant: 20)
- active-labeled agreement: 4/5 (dormant labeled campaigns resolve to unknown by design and are excluded)
- all-labeled agreement (context only): 4/25
- high-confidence agreement: 1/2
- false-Test (high confidence): 0/2
- false-Test (any class): 0/25
- without-lineage active agreement (ablation): 4/5

### Grandfathering table (manual vs inferred)

| Campaign | Manual | Inferred | Class | Window | Agree |
| --- | --- | --- | --- | --- | --- |
| EMB - USA - CC - Apr2026 | main | unknown | unknown | dormant | n/a (dormant) |
| EMB - TargetOthers - CC - Apr2026 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Test_202606 | test | unknown | unknown | dormant | n/a (dormant) |
| TEST — EMB - CreativeTest - May2026 | test | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Core_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Catalog_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Catalog_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Catalog_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Catalog_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Core_202606 - V1 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_US_Core_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonUS_Core_202606 | main | unknown | unknown | dormant | n/a (dormant) |
| EMB - NonTarget - CC - Apr2026 | main | unknown | unknown | dormant | n/a (dormant) |
| TS_NonTesvik_Catalog_202606 | mixed | main | high | active | NO |
| TS_NonTesvik_Core_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_US_DPA_Value_InStock_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_US_Core_Value_ReligiousDuality_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_US_365D_Winner_Retest_Value_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_US_10Jun_Hero_Value_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_US_31May_Controlled_Value_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_F5K_GB_Diagnostic_Value_202606 | mixed | unknown | unknown | dormant | n/a (dormant) |
| TS_R5_STATIC | test | test | high | active | yes |
| TS_R5_DPA_CORE | main | main | medium | active | yes |
| TS_R5_DPA_INTL | main | main | low | active | yes |
| TS_R5_RTG | main | main | low | active | yes |

### Spot-check package (2 unlabeled campaigns, high+medium)

| Campaign | Inferred | Class | Basis | Score | Spend28 | Evidence |
| --- | --- | --- | --- | ---: | ---: | --- |
| TS_R4_DPA_CORE | main | medium | behavioral | 0.5684 | 11432 | scores test=0 main=0.5684 margin=0.5684 agreeing=[behavioral+structure+naming+continuity] |
| TS_R4_DPA_INTL | main | medium | behavioral | 0.4975 | 4669 | scores test=0 main=0.4975 margin=0.4975 agreeing=[behavioral+structure+naming+continuity] |

### Guard impact (APPROXIMATE)

- snapshot asOf: 2026-07-06
- guard-blocked hard rows: 13
- blocked rows under high-confidence inferred context (potential unlock candidates, subject to remaining guards and user approval gates): 0
- note: snapshots lack campaign columns; joined via latest meta_creative_daily campaign_id per creative

## Evidence Limits

- This is a read-only evaluation of the local resolver candidate. It is NOT production approval; no DB row, provider state, deployment, or automation state changed.
- Manual labels are evaluation truth only; label coverage is sparse and uneven (EMOLOS-like accounts need the spot-check package).
- Creative lineage visibility is capped by warehouse first-non-null campaign attribution; same-day multi-campaign reuse is invisible, so visibleLineageCoverage understates true reuse.
- Guard-impact numbers are APPROXIMATE: decision snapshots do not persist campaign ids; the join uses the latest meta_creative_daily campaign per creative.
- Campaign names come from meta_campaign_daily as of the data ceiling; historical renames are not versioned here.
- Hysteresis uses the production applyDailyHysteresis function chained causally over the asOf grid; run with the default daily grid for production-cadence fidelity (gridMode=weekly is an approximation).
- Per-campaign perDate sequences (raw and published kind/class per asOf) are persisted so adjacent-date flips are auditable; earlier artifacts without perDate cannot support flip claims.
