# Account-Level Shadow Parameter Pack Plan - 2026-07-06

Bu belge, formula evaluation fazindan sonra gelen shadow tasarim fazidir.
Amaci production resolver'i degistirmek degil; hesap bazli parametre adaylarini
mevcut historical replay/sweep altyapisi uzerinde olcmek icin sozlesmeyi
sabitlemektir.

## Kanit Siniri

- Bu faz migration, DB write, provider write veya operator davranisi degistirmez.
- UI buyerAction hesaplamaz; karar yetkisi engine tarafinda kalir.
- Yeni standalone decision core yoktur; mevcut V3 engine ve replay harness
  uzerinden gider.
- Campaign label guard korunur. Tag coverage production zincirinin degil,
  hard-action degerinin onkosuludur.
- 2026-06-01 -> 2026-07-05 replay production scheduler'in gecmiste calistigini
  kanitlamaz; 127/140 business-day fallback modundadir.
- Bu replay, 2026-07-10 current-version/live lifecycle-informed checkpoint'inin
  yerine gecmez.
- Hicbir hard-action outcome hucresi henuz `n >= 30 known` seviyesinde degildir.

## Claude Review'a Codex Yaniti

Claude'un phase-end review kararini kabul ediyorum: `CONTINUE`, ancak wording
duzeltmeleri gerekliydi. Bu nedenle once formula evaluation raporunda su
duzeltmeleri yaptim:

1. Tag coverage ifadesi production zinciri yerine hard-action degeriyle
   sinirlandi.
2. Confidence tablosuna fallback-mode ve momentum-proxy uyarisi gomuldu.
3. Replay'in 2026-07-10 live checkpoint yerine gecmedigi acik yazildi.

Benim nihai gorusum: Bu faz global threshold degisikligi icin yeterli kanit
uretmedi; fakat account-level shadow parameter pack olcumu icin yeterli hipotez
seti uretmistir. Claude'un ikinci review'u da `CONTINUE` dedi; ortak karar:
devam. Bu kararin sarti, implementation'da `lossBudget >= hardCut` siralama
etkisi, source-gate kirilimi, trade-off tablosu, flapping metrigi ve V0 fidelity
bari acikca raporlanmasidir.

## Shadow Pack Sozlesmesi

Ilk uygulama production schema'ya yazilmamali. Pack tanimlari script-local JSON
veya TypeScript fixture olarak tutulmali; cikti markdown/JSON artifact olarak
uretilmeli.

Minimum alanlar:

| Field | Tip | Anlam | Production etkisi |
|---|---|---|---|
| `packId` | string | Stabil shadow pack kimligi | Yok |
| `businessSlug` | string | Hesap kapsamı | Yok |
| `objectiveFamily` | enum | Ilk faz `sales` | Yok |
| `campaignKind` | enum | `all`, opsiyonel `main/test/mixed` | Yok |
| `lossBudgetMultiplier` | number/null | Preset `lossBudget` degerinin absolute override adayi | Shadow-only |
| `cutPurchaseFloorMode` | enum | Cut icin purchase-depth guard adayi | Shadow-only |
| `cutBoundaryMode` | enum | Cut zone ratio boundary varyanti | Shadow-only |
| `scalePurchaseMultiplier` | number/null | Mevcut override desenindeki scale purchase adayi | Shadow-only |
| `confidenceCalibrationMode` | enum | Confidence icin report-only kalibrasyon modu | Shadow-only |
| `notes` | string | Hipotez ve risk | Yok |

### `lossBudgetMultiplier`

Mevcut kodda `mergeMultipliers()` diger carpan override'larini alirken
`lossBudget: defaults.lossBudget` seklinde kalir. Bu, kullanicinin 3.1
itirazinin teknik karsiligidir.

Ilk shadow fazinda `lossBudgetMultiplier`, preset uzerine uygulanan oran degil,
dogrudan `EngineMultiplierSet.lossBudget` absolute degeri olarak tanimlanmali.
Ornek: balanced preset icin `2.0`, conservative icin `2.5`.

Kabul edilebilir analiz araligi:

- Lower bound: `1.0`
- Upper bound: `4.0`
- Production'a gecis: sadece user approval + golden cases + `ENGINE_VERSION`
  bump ile.

Etkilesim notu:

- Bu aralik shadow-only'dir; "candidate" anlamina gelmez.
- `lossBudgetMultiplier >= preset hardCut` oldugunda commercial maturity
  siralamasi hard-cut esigini asabilir. Bu, bugun pratikte erisilemeyen
  `maturity_severe_loser` dalini canlandirabilir.
- Bu durum bloker degil, fakat sonuc artifact'inda zorunlu flag olmalidir:
  `loss_budget_ge_hard_cut=true`.
- Her shadow pack sonucu episode bazinda source-gate kirilimi vermelidir:
  `ratio_hard_cut`, `ratio_loss_budget`, `ratio_sustained_loser`,
  `maturity_severe_loser`, `zero_conv_burner`.

### `cutPurchaseFloorMode`

Production code'da cut icin purchase floor yoktur. Shadow modlari:

| Mode | Kural |
|---|---|
| `current_none` | Bugunku davranis |
| `fixed_2` | purchases >= 2 veya sustained-loser bypass |
| `fixed_3` | purchases >= 3 veya sustained-loser bypass |
| `half_winner_p50_min_2` | purchases >= `max(2, ceil(0.5 * winnerPurchaseP50))` veya sustained-loser bypass |

Bu guard global uygulanmamalidir. Grandmix'te erken cut riskini dusurme sinyali
var; TheSwaf ve IwaStore'da ayni sinyal yok.

### `cutBoundaryMode`

Production code'da cut zone `ratio < bottomQuartileRatio` ile baslar; breakeven
bugun cut boundary'yi genisletmez.

Shadow modlari:

| Mode | Kural |
|---|---|
| `current_p25` | `bottomQuartileRatio ?? 0.7` |
| `p25_upper_clamp_1` | `min(p25, 1.0)`; V2a etkisi zayif bulundu |
| `breakeven_floor_to_1` | `min(1.0, max(p25, breakEvenRoas / targetRoas))` |

`breakeven_floor_to_1` TheSwaf icin adaydir. IwaStore icin su an aday degildir;
V3 orada early-cut tarafini kotulestirdi.

### `confidenceCalibrationMode`

Ilk fazda production confidence hesaplamasi degismemeli. Kalibrasyon sadece
raporlama katmani olmalidir.

Minimum rapor kirilimlari:

- business
- action label (`cut`, `scale`, diger hard/non-hard ayrimi karismadan)
- window (`7d`, `14d`)
- confidence bucket (`60-69`, `70-79`, `80-89`, `90+`)
- source mode (`runtime_sql_fallback`, `lifecycle_same_day`)

Kural: `n < 30 known` olan hucre "calibration not proven" olarak isaretlenir.
Bu isaret production kararini degistirmez, sadece yorum/gosterim riskini
azaltir.

## Hesap Bazli Aday Pack'ler

| Business | Pack ID | Aday | Gerekce | Risk |
|---|---|---|---|---|
| Grandmix | `grandmix_cut_floor_shadow_v1` | `cutPurchaseFloorMode=half_winner_p50_min_2`, `cutBoundaryMode=current_p25` | Sweep'te V1d early-cut `34.6% -> 21.1%`; replay confidence 70-79 hard bucket cok overconfident | Waste azaltma zayiflayabilir; saved spend dususu izlenmeli |
| TheSwaf | `theswaf_breakeven_cut_shadow_v1` | `cutBoundaryMode=breakeven_floor_to_1`, purchase floor yok | V2b saved spend units `484.08 -> 1,640.06`, early-cut yatay | Daha agresif cut operator riskini artirabilir |
| IwaStore | `iwastore_conservative_control_shadow_v1` | Baseline control + no breakeven clamp | V3 early-cut'i kotulestirdi; scale/cut outcome karisik | Degisiklik yapmak veriyle desteklenmiyor |
| EMOLOS | `emolos_label_coverage_first_shadow_v1` | Formula degisikligi yok; label coverage ayri gate | June tagged hard cut pozitif ama July hard kararlar label guard ile kilitli | Formula shadow sonucu July production davranisi gibi okunabilir |

## Olcum Metrikleri

Shadow pack karsilastirmasi episode bazinda yapilmali; daily row sayimi karar
kalitesini sisirir.

Zorunlu metrikler:

| Metric | Hesaplama | Neden |
|---|---|---|
| `knownEpisodes` | Closed forward window ve forward spend/conversion sinifi bilinen episode | Defensible sample |
| `openWindowEpisodes` | Pencere kapanmamis episode | Bekleyen kaniti ayirir |
| `unknownEpisodes` | Pencere kapali ama forward sinyal yok | Operator/platform survivorship riskini ayirir |
| `earlyCutRate` | Cut episode sonrasi positive/recovery momentum gosteren episode orani | False/early cut riskini gosterir |
| `trueLoserEpisodes` | Cut sonrasi negatif kalan episode | Waste capture sinyali |
| `savedSpendUnits` | SpendUnit-normalized saved spend proxy | Currency'leri havuzlamadan karsilastirma |
| `tradeoffSpendUnitsPerEarlyCutPoint` | Saved-spend degisimi / early-cut pp degisimi | Trade-off'u otomatik onay yerine kullanici kararina tasir |
| `confidenceError` | `abs(observedPositiveRate - avgConfidence)` | Confidence kalibrasyon farki |
| `sourceGateBreakdown` | Episode sayisi kaynak gate'e gore | `lossBudget/hardCut` siralama etkisini gorunur kilar |
| `flipRateVsBaseline` | Gunluk pack-vs-V0 cut/non-cut fark orani | Boundary churn/flapping riskini gosterir |
| `labelGuardBlockedHardActions` | Guard tarafindan soft'a dusen hard raw verdict sayisi | Hard-action coverage riskini gosterir |
| `fidelityToSnapshot` | Replay vs persisted snapshot exact match | Replay altyapisinin guvenilirligi |

## Kabul ve Ret Kapilari

Bu kapilar otomatik production karari degildir; sadece user approval oncesi
review filtresidir.

Harness guven bari:

- V0 baseline, lifecycle_same_day fidelity tarihlerinde persisted snapshot ile
  `label+confidence >= 99%` match korumali. Bu saglanmazsa shadow pack sonucu
  production formulu icin kullanilmaz; once harness farki aciklanir.

Bir pack "candidate" sayilabilir:

- Ilgili business/action/window icin `knownEpisodes >= 30`, veya daha azsa
  sadece "hypothesis" olarak etiketlenir.
- Global pooled iyilesme, business-level kotulesmeyi saklamamalidir.
- Cut pack icin ya early-cut oranini anlamli dusurmeli ya da saved spend/true
  loser capture'i artirmali; ikisini ayni anda kotulestiren pack reddedilir.
- Bir metrik iyilesirken digeri kotulesiyorsa pack "candidate" degil,
  nicellestirilmis trade-off olarak sunulur. Ornek: "her +1 saved-spend unit,
  +X pp early-cut artisi maliyetiyle geliyor."
- `lossBudgetMultiplier >= preset hardCut` olan pack'ler ancak source-gate
  kirilimiyle birlikte yorumlanir; bu flag varsa golden case ihtiyaci daha
  yuksektir.
- Pack-vs-V0 `flipRateVsBaseline` yuksekse, episode metrikleri iyi olsa bile
  churn/flapping riski ayri karar sorusu olarak kullaniciya gider.
- Scale pack icin known scale episode sayisi artmadan scale threshold
  gevsetilmez.
- Confidence pack production confidence'i degistirmez; once calibration report
  uretir.

Ret kosullari:

- `sourceMode` ayrimi yoksa.
- `open_window`, `unknown`, `known` siniflari karisiyorsa.
- Hard ve non-hard positive anlamlari ayni metrikte havuzlaniyorsa.
- Label guard yok sayiliyorsa.
- `breakEvenRoas` veya `targetRoas` eksikken `cutBoundaryMode` agresif davranisa
  kayiyorsa. Dogru null davranisi `current_p25` fallback'tir; `p25` de null ise
  mevcut `?? 0.7` fallback korunur.
- Resolver davranis degisikligi user approval/golden cases/engine version bump
  olmadan planlaniyorsa.

## Uygulama Sirasi

1. Script-local shadow pack tanimlarini ekle.
2. Historical replay harness'i pack bazli varyant hesaplayacak sekilde genislet;
   production data yazma yok.
3. Core 4 hesap icin 2026-06-01 -> 2026-07-05 araliginda kos.
4. Markdown + JSON artifact uret:
   - pack summary
   - business/action/window metrics
   - source-gate breakdown
   - `lossBudget >= hardCut` flags
   - trade-off table
   - pack-vs-V0 flip/churn metrics
   - confidence calibration table
   - source-mode split
   - V0 lifecycle_same_day fidelity bar
   - top changed episodes
5. Claude Code visible-app review iste.
6. Claude + Codex ortak karar `CONTINUE` ise user approval icin production
   implementation PR planini hazirla.
7. Production'a gecilecekse ayri faz:
   - `business_decision_calibration_profiles` icin typed config alanlari veya
     ayri versioned override tablosu tasarla.
   - Golden cases ekle.
   - Invariants'i guncelle.
   - `ENGINE_VERSION` bump yap.
   - Kill-switch ve rollback planini yaz.

## Nihai Karar

Bu fazin sonucu production degisikligi degil, olculebilir shadow sozlesmesidir.
Bir sonraki uygulanabilir adim: pack tanimlarini script seviyesinde ekleyip
historical replay uzerinde core 4 shadow comparison kosmak.
