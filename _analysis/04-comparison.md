# Adsecute Decision Engine Comparison

**Snapshots used**: TheSwaf=2026-05-02 11:55, IwaStore=2026-05-01 20:30
**Creatives compared**: 76 (TheSwaf=40, IwaStore=36)
**Targets**: TheSwaf tROAS=1.71, IwaStore tROAS=3.5

## Distributions (mapped to my 6-category vocabulary)

| Category | MY | V1.primary | V1.lifecycle | V1.legacy | V2 | V2.1 buyer | Meta-campaign |
|---|---|---|---|---|---|---|---|
| scale | 5 | 0 | 0 | 0 | 0 | 0 | 0 |
| keep | 10 | 6 | 6 | 6 | 0 | 0 | 3 |
| refresh | 3 | 9 | 9 | 0 | 0 | 2 | 0 |
| cut | 4 | 0 | 5 | 16 | 0 | 0 | 1 |
| test_more | 54 | 54 | 54 | 54 | 0 | 5 | 0 |
| diagnose | 0 | 7 | 2 | 0 | 76 | 69 | 0 |

## Agreement summary

**Average disagreement** (engines disagreeing with MY): **3.18** out of 5-6 engines
- Fully aligned (0 disagreements): **0/76**
- Almost aligned (≤1 disagreement): **4/76**
- High disagreement (≥4): **32/76**

## Pairwise agreement (vs MY)

| Engine | Agree % | Most common disagreement |
|---|---|---|
| V1.primary | 62% (47/76) | MY=keep→ENG=test_more (8), MY=test_more→ENG=diagnose (7), MY=test_more→ENG=refresh (5) |
| V1.lifecycle | 62% (47/76) | MY=keep→ENG=test_more (8), MY=test_more→ENG=refresh (5), MY=test_more→ENG=cut (5) |
| V1.legacy | 58% (44/76) | MY=test_more→ENG=cut (12), MY=keep→ENG=test_more (8), MY=scale→ENG=keep (4) |
| V2 | 0% (0/76) | MY=test_more→ENG=diagnose (54), MY=keep→ENG=diagnose (10), MY=scale→ENG=diagnose (5) |
| V2.1 buyer | 5% (4/76) | MY=test_more→ENG=diagnose (49), MY=keep→ENG=diagnose (10), MY=scale→ENG=diagnose (4) |
| Meta-campaign | 0% (0/4) | MY=refresh→ENG=keep (2), MY=scale→ENG=keep (1), MY=refresh→ENG=cut (1) |

## Top high-disagreement creatives (top 25)

| # | Business | Name | Spend | Purch | ROAS | MY | V1.primary | V1.lifecycle | V1.legacy | V2 | V2.1 buyer | Meta | Disag |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | IwaStore | WoodenWallArtCatalog | 1651.36 | 57 | 5.3 | **scale** | refresh | refresh | cut | diagnose | refresh | keep | 6 |
| 2 | TheSwaf | EMB - CatalogAd | 12338.65 | 84 | 1.31 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 3 | TheSwaf | EmB - Catalog Ad | 7422.19 | 53 | 1.33 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 4 | IwaStore | WallArtCatalog | 2310.73 | 46 | 3.19 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 5 | TheSwaf | Advantage+ catalog | 2122.32 | 21 | 2.44 | **scale** | keep | keep | keep | diagnose | diagnose | — | 5 |
| 6 | TheSwaf | wearthefearrevise | 1950.29 | 9 | 0.95 | **cut** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 7 | TheSwaf | protection | 1361.73 | 9 | 1.68 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 8 | TheSwaf | aphrodite | 1193.43 | 10 | 1.63 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 9 | TheSwaf | fatal | 944.37 | 7 | 1.67 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 10 | IwaStore | A misbaha | 838.24 | 19 | 3.51 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 11 | IwaStore | Transforming a house | 830.76 | 25 | 9.52 | **scale** | keep | keep | keep | diagnose | diagnose | — | 5 |
| 12 | TheSwaf | depth | 587.18 | 2 | 0.63 | **cut** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 13 | TheSwaf | biterevise | 525.23 | 8 | 4.01 | **scale** | keep | keep | keep | diagnose | diagnose | — | 5 |
| 14 | IwaStore | decorista_93 | 434.36 | 19 | 7.85 | **scale** | keep | keep | keep | diagnose | diagnose | — | 5 |
| 15 | TheSwaf | faith | 324.83 | 1 | 0.38 | **test_more** | diagnose | diagnose | cut | diagnose | diagnose | — | 5 |
| 16 | IwaStore | julia_julia386 | 279.67 | 0 | 0 | **cut** | test_more | test_more | test_more | diagnose | test_more | — | 5 |
| 17 | IwaStore | A prayer niche | 274.95 | 7 | 3.93 | **keep** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 18 | TheSwaf | watchthat | 226.26 | 0 | 0 | **cut** | test_more | test_more | test_more | diagnose | diagnose | — | 5 |
| 19 | TheSwaf | legacyrevise | 154.4 | 1 | 1.23 | **test_more** | diagnose | diagnose | cut | diagnose | diagnose | — | 5 |
| 20 | IwaStore | The heart finds | 145.02 | 2 | 2.11 | **test_more** | refresh | refresh | cut | diagnose | diagnose | — | 5 |
| 21 | IwaStore | Cherish every | 111.02 | 3 | 4.9 | **test_more** | refresh | refresh | cut | diagnose | diagnose | — | 5 |
| 22 | IwaStore | PrayerEssentialsCatalog | 88.79 | 0 | 0 | **test_more** | refresh | refresh | cut | diagnose | refresh | — | 5 |
| 23 | IwaStore | Glowing lanterns | 63.99 | 1 | 7.99 | **test_more** | refresh | refresh | cut | diagnose | diagnose | — | 5 |
| 24 | IwaStore | Beautiful gatherings | 25.12 | 2 | 6.22 | **test_more** | refresh | refresh | cut | diagnose | diagnose | — | 5 |
| 25 | IwaStore | It became the favorite | 3.09 | 0 | 0 | **test_more** | diagnose | cut | cut | diagnose | diagnose | — | 5 |