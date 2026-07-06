# Creative Decision Center Formula Evaluation - 2026-07-06

Bu rapor mevcut karar motoru matematiğini, F1/F2 threshold sweep sonucunu ve
2026-06-01 -> 2026-07-05 historical replay kanitini birlikte degerlendirir.

## Kapsam ve Sinir

Bu bir implementasyon PR'i degildir. Resolver, migration, DB, provider veya
operator davranisi degistirilmedi.

Kullanilan kanitlar:

- `F1_F2_CUT_THRESHOLD_SWEEP_2026-07-02.md`: read-only parameter sweep.
- `CURRENT_ENGINE_HISTORICAL_REPLAY_CORE_2026-06-01_TO_2026-07-05.md`: current engine historical replay.
- `generated/current-engine-historical-replay-core-2026-06-01-to-2026-07-05.json`: replay kaynak JSON'u.
- Kod kaynagi: `lib/creative-decision-engine/*`.

Kaniti abartmamak icin sinir:

- Historical replay, production scheduler'in gecmiste calistigini kanitlamaz.
- 127/140 business-day `runtime_sql_fallback`; sadece 13/140 business-day
  `lifecycle_same_day`.
- Bu nedenle June fallback davranisi, July lifecycle-informed production
  davranisina esit okunmamalidir.
- Outcome proxy non-causal'dir: historical forward spend gercek operator ve
  platform davranisindan etkilenmistir.
- Hicbir hard-action outcome hucresi `n >= 30 known` seviyesine ulasmadi.
- Bu replay, 2026-07-10 current-version/live lifecycle-informed checkpoint'inin
  yerine gecmez; o checkpoint halen ayri production kaniti olarak gereklidir.

## Kisa Karar

Tek bir global formül degisikligi icin yeterli kanit yok. Buna karsin,
account-level parametreleme ihtiyaci artik uc ayri kanit kaynaginda gorunuyor:

1. Kodda bazi esikler account'a gore degisiyor, ama `lossBudget` gibi kritik
   maturity multiplier'lari sadece preset sabitlerinden geliyor.
2. F1/F2 sweep ayni degisikligin business'lara farkli etki yaptigini gosteriyor.
3. 2026-06-01 -> 2026-07-05 replay, hard-action precision ve confidence
   hizasinin business bazinda ayrildigini gosteriyor.

Sonuc: devam edilmesi gereken yol global threshold degisikligi degil,
account-level shadow parameter pack tasarimi ve olcumudur.

## Mevcut Matematik Haritasi

### 1. Commercial Maturity / Loss Budget

Kod:

- `account-decision-profile.ts`: `mergeMultipliers()` icinde `lossBudget:
  defaults.lossBudget`.
- `config-values.ts`: preset bazli `lossBudget`: aggressive `1.5`, balanced
  `2.0`, conservative `2.5`.
- `maturity.ts`: `commercialMaturitySpendThreshold()` once configured
  `commercialMaturitySpend`, sonra CPA fallback, sonra sustained loser, sonra
  mature spend fallback kullanir.

Degerlendirme:

Bu kismen account-specific, cunku `spendUnit` account target/AOV/CPA
verisinden geliyor. Ama carpan account-specific degil; sadece preset uzerinden
geliyor. `business_decision_calibration_profiles` icinde
`zero_conv_burner_multiplier`, `sustained_loser_multiplier`,
`hard_cut_multiplier`, `scale_purchase_multiplier`, `recent_sample_multiplier`
gibi override'lar var; fakat `loss_budget_multiplier` yok.

Bu nedenle kullanicinin 3.1 itirazi dogru: maturity carpanini sadece
aggressive/balanced/conservative sabitlerine baglamak fazla kaba.

Kanıt:

| Business | Preset etkisi / replay threshold | Replay hard-action sinyali |
|---|---|---|
| EMOLOS | commercial maturity `68.69-70.78`, hard cut `171.72-176.95` | Cut proxy pozitif ama sadece 6 known; June fallback kaynakli |
| Grandmix | commercial maturity `259.08-271.28`, hard cut `829.04-868.11` | 7d hard 70-79 confidence: observed positive `12.5%` vs avg confidence `75%` |
| IwaStore | commercial maturity `97.91-101.77`, hard cut `244.76-254.42` | Hard scale/cut karisik; 14d hard 70-79 observed `41.7%` |
| TheSwaf | commercial maturity `139.14-142.60`, hard cut `278.28-285.21` | Cut directional; 7d hard 70-79 observed `71.4%` |

Karar:

- `lossBudget` icin account-level override tasarlanmalı.
- Bu override dogrudan production'a alinmamali; once shadow pack olarak
  replay/snapshot karsilastirmasinda kosmali.
- Engine version bump ve golden case eklenmeden resolver davranisi
  degismemeli.

### 2. Cut Boundary: Bottom Quartile vs Breakeven

Kod:

- `ratio-zones.ts`: cut zone `ratio < bottomQuartileRatio` ile baslar.
- `bottomQuartileRatio`, account calibration `roasRatioP25` degerinden gelir.
- Breakeven bugun hard cut boundary'yi genisletmez. Kodda breakeven sadece
  `ratio >= bottomQuartileRatio` fakat `ratio < breakevenRatio` ve
  `spend >= hardCutSpend` ise `keep` + `below_breakeven`/demote candidate
  olarak cikar.

Degerlendirme:

Bu tasarim guvenli, ama bazen fazla gec kaliyor. F1/F2 sweep'teki
`V2b_p25_breakeven_floor` ve `V3_recommended_combo`, breakeven'i cut boundary
icinde kullanmanin bazi hesaplarda ciddi saved-spend artisi verdigini gosterdi.
Fakat etki business bazinda ayni degil.

F1/F2 kaniti:

| Business | V0 early-cut | V2b / V3 sinyali | Yorum |
|---|---:|---|---|
| EMOLOS | `11.4%` | V3 saved spend units `293.79 -> 383.87`, early-cut `21.0%` | Daha agresif cut para kurtarabilir ama false/early risk artiyor |
| Grandmix | `34.6%` | V1d early-cut `21.1%`; V3 `28.0%` | Purchase floor Grandmix icin daha onemli gorunuyor |
| IwaStore | `42.1%` | V3 early-cut `46.6%` | Breakeven/floor kombosu burada kotulesebilir |
| TheSwaf | `18.8%` | V2b saved spend units `484.08 -> 1,640.06`, early-cut `19.6%` | TheSwaf icin breakeven clamp guclu aday |

Karar:

- Breakeven clamp global default olmamali.
- Account-level `cutBoundaryMode` veya `cutBoundaryFloor` shadow parametresi
  olarak denenmeli.
- TheSwaf icin aday: breakeven-aware boundary.
- IwaStore icin aday degil; once daha konservatif veya purchase-floor odakli
  varyant test edilmeli.

### 3. Cut Purchase Floor

Mevcut production code:

- `ratio-zones.ts` icinde cut icin purchase floor yok.
- Cut karari spend maturity + ratio zone + recovery guard ile veriliyor.
- Scale tarafinda `scaleMinPurchases` var; cut tarafinda benzer purchase-depth
  guard yok.

F1/F2 sweep'te test edilen F1 varyantlari:

- fixed purchase floor 2/3/5.
- account-relative `max(2, ceil(0.5 * winnerPurchaseP50))`.
- sustained-loser spend durumunda floor bypass.

Kanıt:

| Business | En faydali F1 sinyali | Etki |
|---|---|---|
| Grandmix | `V1d_purchase_floor_half_winner` | early-cut `34.6% -> 21.1%` |
| EMOLOS | fixed/account floor | early-cut `11.4% -> 6.9%` |
| IwaStore | F1 tek basina zayif | V1d early-cut `42.1% -> 45.6%` |
| TheSwaf | F1 tek basina zayif | V1d early-cut `18.8% -> 20.0%` |

Degerlendirme:

Purchase floor global rule olursa bazi account'larda gec kalma yaratabilir.
Ama Grandmix icin ciddi iyilestirme sinyali var.

Karar:

- Cut purchase floor account-level opsiyon olmali.
- Varsayilan global production davranisina hemen eklenmemeli.
- Grandmix icin shadow aday: `max(2, ceil(0.5 * winnerPurchaseP50))`,
  sustained-loser bypass korunarak.

### 4. Scale Readiness

Kod:

- `SCALE_RATIO_BY_PRESET`: aggressive `1.2`, balanced `1.3`, conservative
  `1.4`.
- `scaleMinPurchases = ceil(winnerPurchaseP50 * scalePurchaseMultiplier)`,
  minimum 1.
- Hard scale icin:
  - ratio scale threshold ustunde,
  - commercial maturity spend dolmus,
  - purchase depth dolmus,
  - benchmark blockers yok,
  - freshness blockers yok,
  - recent 7d ROAS target uzerinde.

Replay kaniti:

| Business | Scale episodes | Known outcome |
|---|---:|---|
| Grandmix | 7d `2`, 14d `2` | positive `0`, negative `2` |
| IwaStore | 7d `10`, 14d `8` | mixed; 14d positive `3`, negative `5` |
| TheSwaf | 7d `4`, 14d `1` | insufficient/mixed |
| EMOLOS | `0` surfaced scale episodes | not applicable |

Degerlendirme:

Current scale guard mantikli ve gevsetilmemeli. Replay scale sayilari kucuk ama
iyi degil. Bu, daha agresif scale degil; daha iyi account/action-specific
confidence ve belki daha siki scale evidence gerektirir.

Karar:

- Scale threshold gevsetilmemeli.
- Scale icin account-level parameterization ancak shadow olarak denenmeli.
- Known scale episode sayisi artmadan production scale matematigi
  degistirilmemeli.

### 5. Confidence Calibration

Kod:

- `initialContext()` base confidence `75`.
- `finalizeDecision()` confidence deltalari ve badge cap uygular.
- Stale/unknown freshness cap `65`.

Replay kaniti:

Not: Bu tablo tek basina production confidence dogrulamasi degildir. Episode'larin
buyuk bolumu June `runtime_sql_fallback` modundan gelir ve `observed positive`
operator tarafindan onaylanmis dogru karar degil, forward-window momentum
proxy'sidir.

| Business | Hard 70-79 bucket observed vs avg confidence |
|---|---|
| EMOLOS | 7d `100.0%` vs `75.0%`, ama only 6 known |
| Grandmix | 7d `12.5%` vs `75.0%`; 14d `16.7%` vs `75.0%` |
| IwaStore | 7d `46.2%` vs `75.0%`; 14d `41.7%` vs `75.0%` |
| TheSwaf | 7d `71.4%` vs `75.0%`; 14d `62.5%` vs `75.0%` |

Degerlendirme:

Bu bugun en net matematiksel uyumsuzluk. Confidence ayni bucket'ta business'a
gore cok farkli davranıyor. Ancak known hard sample sayilari kucuk oldugu icin
tek basina yeni confidence formulu yazmak da dogru degil.

Karar:

- Confidence global sabit gibi davranmamali.
- Account/action/window bazli calibration layer tasarlanmali.
- Interim production davranisi degistirilmemeli; ama rapor/UI yorumunda
  `n < 30 known` olan hard-action confidence "calibration not proven" olarak
  isaretlenmeli.

### 6. Campaign Label Guard ve Main/Test/Mixed Semantics

Kod:

- `kind-aware-profile.ts` campaign-kind calibration'i all-or-nothing secer;
  eksik/sparse ise canonical `all_fallback`.
- `finalizeDecision()` Test campaign refresh sinyalini cut semantigine cevirir.
- Campaign label guard hard action'lari unlabeled campaign'de soft-only hale
  getirir.

Replay kaniti:

- EMOLOS June fallback'ta tagged Test campaign hard cut uretti ve proxy pozitif
  gorundu.
- EMOLOS July lifecycle-informed gunlerinde hard label yok; bu formula
  zayifligi degil, mevcut harcayan campaign'lerde label eksikligi/guard
  sonucudur.
- Tum core business'larda `campaign_label_guard_blocked_hard_actions` risk hint'i
  var.

Degerlendirme:

Guard dogru calisiyor. Eksik olan formül degil, operasyonel campaign label
coverage. Hard action kalitesini olcmek icin guard'i gevsetmek yanlis olur.

Karar:

- Guard korunmali.
- Tag coverage production zincirinin degil, hard-action degerinin onkosuludur;
  soft kararlar guard altinda calismaya devam edebilir.
- Label missing row'lar hard-action formula precision analizine karistirilmamali.

### 7. Freshness, Delivery ve Funnel Diagnosis

Kod:

- `diagnoseGate()` fresh no-delivery proof olmadan delivery hard diagnosis
  vermez.
- Landing/checkout diagnosis icin fresh evidence ve funnel confidence gerekir.
- Stale/unknown freshness confidence'i cap'ler.

Replay/fidelity kaniti:

- Grandmix snapshot fidelity `99.4%`; mismatch'ler delivery/funnel/freshness
  boundary'den geldi.
- Ornek: replay `diagnose`/75, persisted snapshot `test_more`/75 veya
  `keep`/75; bunlar hard label reversal degil.

Degerlendirme:

Bu alanda hemen formül degisikligi gerekmiyor. Ancak fidelity mismatch'leri
delivery/freshness yorumunun hassas oldugunu gosteriyor.

Karar:

- Fresh proof gate korunmali.
- Replay report'larda source-mode/fidelity zorunlu kalmali.
- Delivery/funnel mismatch sayisi production monitoring'e metrik olarak eklenmeli.

## Account Bazli Nihai Degerlendirme

| Business | Mevcut sinyal | Formül karari |
|---|---|---|
| TheSwaf | Cut directional olarak iyi; V2b breakeven clamp saved-spend guclu | Breakeven-aware cut boundary shadow adayi |
| Grandmix | Hard confidence ciddi overconfident; F1d purchase floor early-cut'i dusurdu | Cut purchase floor shadow adayi; confidence cap/kalibrasyon oncelikli |
| IwaStore | Cut/scale hard outcome karisik; V3 kombosu early-cut'i kotulestirdi | Global degisiklik uygulanmamali; daha konservatif account pack denenmeli |
| EMOLOS | June tagged hard cut pozitif; July hard kararlar label guard ile kilitli | Once label coverage; formula sonucu July production icin okunmamali |

## Uygulama Onerisi

Onay olmadan production resolver degisikligi yapilmamali. Bir sonraki teknik faz
sadece shadow/analysis olmalı:

1. `lossBudgetMultiplier` icin account-level config alanı tasarla.
2. `cutPurchaseFloorMode` icin account-level shadow parametre tasarla.
3. `cutBoundaryMode` icin `p25`, `min(p25,1.0)`,
   `max(p25,breakevenRatio)` gibi varyantlari account bazli shadow kos.
4. Confidence icin account/action/window calibration report uret; `n < 30 known`
   hucresini production confidence degisikligine dayanak yapma.
5. Golden case eklemeden ve `ENGINE_VERSION` bump olmadan resolver davranisini
   degistirme.

## Itiraz Edilebilecek Noktalar

Kullanicinin kontrol etmesi gereken kritik sorular:

- Grandmix icin erken cut riskini azaltmak mi, yoksa spend waste azaltmak mi
  daha oncelikli?
- TheSwaf'ta breakeven-aware cut daha agresif davranacak; bu kabul edilebilir mi?
- EMOLOS icin once label coverage mi yapilmali, yoksa formula shadow kosulari
  devam mi etmeli?
- Confidence UI'da bugunku `75` degerini "kesinlik" gibi mi algilatiyor?
  Eger evetse, production davranisi degismese bile copy/tooltip degismeli.

## Nihai Yargi

Mevcut formüller tamamen yanlis degil; guardrail yapisi genel olarak dogru.
Fakat matematik tek preset ve tek global davranisla fazla kaba kaliyor.
Ozellikle `lossBudget`, cut purchase floor, breakeven-aware boundary ve confidence
kalibrasyonu account-level hale gelmeden "10/10" seviyesine yaklasmayacak.

Bugun uygulanabilecek guvenli karar: production resolver'i degistirme; account
shadow parameter pack'i tasarla, replay et, Claude + Codex review'dan sonra
kullanici onayina sun.
