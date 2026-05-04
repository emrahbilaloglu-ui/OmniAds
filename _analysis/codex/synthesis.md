# Adsecute Decision Engine - 3 Persona Re-Labeling Synthesis

Kaynaklar: `01-raw-with-v1.csv`, üç bağımsız persona çıktısı ve `03-my-labels.csv`. Bu re-run her kreatif için raw CSV’deki satır bazlı `target_roas` kolonunu kullandı; TheSwaf satırlarında `2.2`, IwaStore satırlarında `3.5` doğrulandı.

Konsensüs mekanik hesaplandı: 4 etiketten en az 3 aynıysa o etiket, aksi halde `no_consensus`. Persona etiketleri birbirlerinden ve AI rubric’ten bağımsız üretildi.

## 1. Distribution karşılaştırması
| Etiket seti | scale | keep | refresh | cut | test_more | diagnose |
| --- | --- | --- | --- | --- | --- | --- |
| Marcus | 7 | 15 | 9 | 10 | 35 | 0 |
| Dr. Lin | 1 | 10 | 0 | 1 | 64 | 0 |
| Aria | 9 | 12 | 11 | 28 | 0 | 16 |
| AI rubric | 4 | 9 | 3 | 6 | 54 | 0 |

## 2. Pairwise agreement matrix
|  | Marcus | Dr. Lin | Aria | AI rubric |
| --- | --- | --- | --- | --- |
| Marcus | 100.0% | 51.3% (39/76) | 30.3% (23/76) | 67.1% (51/76) |
| Dr. Lin | 51.3% (39/76) | 100.0% | 3.9% (3/76) | 78.9% (60/76) |
| Aria | 30.3% (23/76) | 3.9% (3/76) | 100.0% | 18.4% (14/76) |
| AI rubric | 67.1% (51/76) | 78.9% (60/76) | 18.4% (14/76) | 100.0% |

## 3. Persona bias analizi
- Marcus 7 `scale`, 10 `cut`, 9 `refresh` dedi; en hızlı performans aksiyonu alan persona. Buna rağmen 35 `test_more` ile düşük spend ve düşük purchase alanını bekletiyor.
- Dr. Lin 64 `test_more`, 1 `scale`, 1 `cut` dedi; en muhafazakar set. 20+ purchase, $1000+ spend ve target x 1.3 eşiği olmadan scale vermiyor.
- Aria 11 `refresh`, 28 `cut`, 16 `diagnose` dedi; CTR, fatigue ve creative-health sinyallerine en çok ağırlık veren persona.
- AI rubric 54 `test_more`, 4 `scale`, 6 `cut` dedi; Lin’e yakın ihtiyatlı ama bazı yüksek hacimli veya yorgun winner vakalarını ayrıştırıyor.

## 4. Strong consensus listesi (4/4)
| Business | creative_id | name | spend | purchases | ROAS | fatigue | target | 4/4 label |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TheSwaf | creative_2chqoy | wearthefearrevise | $1,950 | 9 | 0.95 | none | 2.2 | cut |
| TheSwaf | creative_1d99qi7 | aura | $1,531 | 16 | 2.07 | none | 2.2 | keep |

## 5. High-disagreement listesi (<=2 agreement)
Top 15 spend sıralı edge case listesi:
| Business | creative_id | name | spend | purchases | ROAS | fatigue | target | labels | manuel karar noktası |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TheSwaf | creative_8qhjj | EmB - Catalog Ad | $7,422 | 53 | 1.33 | none | 2.2 | M:keep / L:keep / A:cut / AI:cut | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| TheSwaf | creative_2dptrn | Advantage+ catalog | $2,122 | 21 | 2.44 | none | 2.2 | M:scale / L:keep / A:scale / AI:keep | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| IwaStore | creative_gav4ek | WoodenWallArtCatalog | $1,651 | 57 | 5.30 | fatigued | 3.5 | M:refresh / L:scale / A:refresh / AI:scale | Kazanan ama yorgun: scale ile refresh önceliği netleşmeli. |
| TheSwaf | creative_ylpchy | aphrodite | $1,193 | 10 | 1.63 | watch | 2.2 | M:keep / L:test_more / A:refresh / AI:keep | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| IwaStore | creative_kgfoui | A misbaha | $838 | 19 | 3.51 | none | 3.5 | M:scale / L:keep / A:scale / AI:keep | Hedef civarı hacimli kreatif: keep mi refresh mi sınırı ticari toleransa bağlı. |
| IwaStore | creative_7o6ry1 | Transforming a house | $831 | 25 | 9.52 | none | 3.5 | M:scale / L:keep / A:keep / AI:scale | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| TheSwaf | creative_uf55lo | AllRings | $564 | 4 | 1.19 | none | 2.2 | M:cut / L:test_more / A:cut / AI:test_more | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| IwaStore | creative_zri7ic | Every beautiful | $479 | 8 | 2.31 | none | 3.5 | M:keep / L:test_more / A:keep / AI:test_more | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| TheSwaf | creative_zgt8em | restraintrevise | $467 | 6 | 4.14 | watch | 2.2 | M:scale / L:test_more / A:scale / AI:keep | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| TheSwaf | creative_1ckebyd | EMB - AllRings | $460 | 3 | 1.12 | watch | 2.2 | M:cut / L:test_more / A:refresh / AI:test_more | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| IwaStore | creative_1qxpvdx | decorista_93 | $434 | 19 | 7.85 | watch | 3.5 | M:scale / L:keep / A:refresh / AI:scale | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| IwaStore | creative_tah2d0 | New 2026 Collection | $434 | 13 | 3.27 | watch | 3.5 | M:keep / L:test_more / A:cut / AI:test_more | Hedef civarı hacimli kreatif: keep mi refresh mi sınırı ticari toleransa bağlı. |
| TheSwaf | creative_8a8qqj | ancientegypt | $378 | 2 | 0.64 | none | 2.2 | M:cut / L:test_more / A:cut / AI:test_more | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| TheSwaf | creative_1w229oq | begintodeath | $348 | 2 | 2.26 | none | 2.2 | M:keep / L:test_more / A:scale / AI:test_more | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |
| TheSwaf | creative_5r9ggv | angelNdevill | $341 | 2 | 1.10 | none | 2.2 | M:cut / L:test_more / A:cut / AI:test_more | Performans hacmi, engagement ve fatigue sinyali aynı yönde değil. |

Bu edge case’lerde ortak nokta şu: ticari performans, fatigue ve CTR aynı aksiyonu göstermiyor. Yeni motor özellikle `scale vs refresh`, `keep vs cut`, `cut vs test_more` ve data-quality kaynaklı `diagnose` ayrımını açık öncelik kurallarıyla çözmeli.

## 6. Per-business breakdown
### IwaStore target_roas=3.5
| Set | scale | keep | refresh | cut | test_more | diagnose | no_consensus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Marcus | 4 | 5 | 8 | 1 | 18 | 0 | 0 |
| Dr. Lin | 1 | 5 | 0 | 0 | 30 | 0 | 0 |
| Aria | 2 | 5 | 7 | 12 | 0 | 10 | 0 |
| AI rubric | 3 | 3 | 2 | 1 | 27 | 0 | 0 |
| Consensus | 0 | 1 | 2 | 1 | 18 | 0 | 14 |

### TheSwaf target_roas=2.2
| Set | scale | keep | refresh | cut | test_more | diagnose | no_consensus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Marcus | 3 | 10 | 1 | 9 | 17 | 0 | 0 |
| Dr. Lin | 0 | 5 | 0 | 1 | 34 | 0 | 0 |
| Aria | 7 | 7 | 4 | 16 | 0 | 6 | 0 |
| AI rubric | 1 | 6 | 1 | 5 | 27 | 0 | 0 |
| Consensus | 1 | 3 | 1 | 4 | 17 | 0 | 14 |

TheSwaf target 2.2 olduğu için önceki 1.71 varsayımına göre daha az kreatif hedef üstü sayılıyor; bu durum Marcus ve Aria’da daha fazla `cut/refresh` tartışması yaratıyor. IwaStore target 3.5 olduğu için yüksek ROAS eşiği daha sert, ancak bazı katalog winner’larında purchase hacmi güçlü olduğu için `scale` ile `refresh` çatışması öne çıkıyor. Sistemik fark sadece business target değil, fatigue ve CTR sinyallerinin nasıl önceliklendirildiğiyle oluşuyor.

## 7. Yeni motor spec’ine 5 somut kural önerisi
1. **Target source rule:** her satırda raw `target_roas` kullanılmalı; `breakeven_roas` ile karıştırılmamalı. Bu re-run TheSwaf için 2.2, IwaStore için 3.5 ile üretildi.
2. **Thin-data default:** spend < $150 ve purchases < 3 ise `test_more` ana default olmalı; bu bantta 39 kreatif var. Düşük CTR veya düşük ROAS tek başına hard cut üretmemeli.
3. **Scale maturity rule:** 20+ purchases, spend >= $1000 ve ROAS >= target x 1.3 güçlü scale eşiği olarak kullanılmalı; bu pattern 1 kreatifte var. Eşik altında scale varsa confidence düşürülmeli veya keep/test_more’a çevrilmeli.
4. **Fatigued winner rule:** fatigue/watch + age >=30 + ROAS >= target vakaları (9 kreatif) doğrudan hard scale edilmemeli; `refresh` ya da `keep + refresh` ayrımı için CTR, ROAS ratio ve purchase hacmi birlikte kullanılmalı.
5. **Cut maturity rule:** 0 purchase + spend >= $200 (2 kreatif) veya ROAS < target x 0.6 + spend >= $300 (8 kreatif) cut adayıdır. CTR < 1% (11 kreatif) ve target-adjacent hacimli vakalar (5 kreatif) için tek başına cut değil, maturity ve trend şartı aranmalı.

## 8. Açık sorular
- Fatigued winner’da birincil aksiyon ne olmalı: bütçe artırmak mı, aynı anda yeni varyasyon çıkarmak mı?
- CTR < 1% sinyali hangi spend/purchase eşiğinden sonra hard cut için yeterli sayılmalı?
- Target civarı, yüksek purchase hacimli kreatiflerde `keep` ile `refresh` sınırı ROAS ratio’ya mı, fatigue’e mi, CTR’ye mi bağlanmalı?
- `truth_state=degraded_missing_truth` veya `deploy_compat=limited` performans aksiyonunu sadece confidence cap ile mi sınırlamalı, yoksa bazı hallerde `diagnose`a mı çevirmeli?
- TheSwaf ve IwaStore için aynı ratio kuralları yeterli mi, yoksa business bazlı target ve breakeven farkı nedeniyle ayrı config gerekir mi?

## Pattern notları
| Pattern | N | Consensus dağılımı | 4/4 N | <=2 agreement N |
| --- | --- | --- | --- | --- |
| 0 purchase + spend >= $200 | 2 | cut:2 | 0 | 0 |
| 0 purchase + spend >= $100 | 7 | no_consensus:3, cut:2, test_more:2 | 0 | 3 |
| thin data: spend < $150 and purchases < 3 | 39 | test_more:35, no_consensus:4 | 0 | 4 |
| mature strong winner: purchases >=20, spend >=1000, ROAS >= target*1.3 | 1 | no_consensus:1 | 0 | 1 |
| fatigue/watch age>=30 and ROAS >= target | 9 | no_consensus:6, refresh:1, scale:1, test_more:1 | 0 | 6 |
| CTR < 1% | 11 | test_more:6, no_consensus:4, cut:1 | 0 | 4 |
| ROAS < 60% target + spend >=300 | 8 | no_consensus:5, cut:3 | 1 | 5 |
| target-adjacent: purchases >=10 and ROAS 0.85x-1.10x target | 5 | keep:2, no_consensus:2, refresh:1 | 1 | 2 |
