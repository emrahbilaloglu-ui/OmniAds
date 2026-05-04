# Yeni Karar Motoru — Kural Kararları

Bu doküman 5 açık soruya verilen kararları tek tek kayıt altına alır. Yeni motor implementasyonu (creative-decision-engine-v3) bunlara dayanır.

---

## Mimari ilke: 4-katmanlı eşik yapısı (kabul: 2026-05-03)

Tüm karar kuralları aşağıdaki 4 katmanda yaşar:

| Katman | Niteliği | Örnek |
|---|---|---|
| **1. Domain-evrensel** | matematik/mantık, hesap fark etmez. Minimum hardcoded. | "0 purchase + spend > 0 + age ≥ 7g = cut" |
| **2. Business config** | her business kendi değeri (DB'den) | target_roas, breakeven_roas, maturity_spend_threshold, aggression_preference |
| **3. Self-calibrating** | hesabın kendi tarihinden çıkarılır (90g pencere) | "anlamlı düşüş" P10 quantile, sample size baseline |
| **4. Operator override** | UI'dan elle ayar | Geçici override, kategoriye özel kurallar |

**Cold start fallback**: yeterli tarihi olmayan hesaplar için (≥20 kreatif geçmişi yoksa) konservatif default kullan + UI'da "calibrating" badge göster.

---

## Soru 1 — Fatigue ve refresh kararı (karar: 2026-05-03)

### Karar
**Fatigue = sinyal/badge, label-driven karar değildir.** Refresh sadece **kanıtlanmış recent trend düşüşü** olduğunda tetiklenir.

### Konkret kural
```
SCALE:
  ROAS ≥ target × 1.4
  AND recent_7d_ROAS ≥ target × 1.0
  AND purchases ≥ maturity_purchases
  → scale (fatigue=fatigued ise badge eklenir, label DEĞİŞMEZ)

REFRESH:
  fatigue=fatigued
  AND (recent_7d_ROAS / total_ROAS) < account.refresh_threshold  ← self-calibrating P10
  AND recent_7d_spend ≥ account.recent_sample_min                  ← business config
  → refresh

KEEP:
  Default ROAS-driven (fatigue badge eklenebilir, label değişmez)
```

### Self-calibrating refresh threshold
Hesabın son 90 günündeki tüm kreatiflerinin `recent_7d_ROAS / total_28d_ROAS` oranlarının **P10 quantile**'ı = bu hesabın doğal volatility tabanı. Bir kreatif bu P10'un altına düştüğünde refresh tetiklenir.

Cold start (≥20 kreatif geçmişi yoksa): default 0.75 kullan.

### Bağımlılık
Yeni motor `recent_7d_ROAS` + `recent_7d_spend` verisini hesaplayabilmeli. Snapshot'ta yok. Çözüm: ya `meta_ad_daily` günlük tablodan toplama, ya canlı Meta API çağrısı.

### Düzeltme: V1 fatigue motorundaki tasarım zayıflığı
V1'in `bestWindow` seçimi (`buildHistoricalSummary`, line 1286): `last3, last7, last14, last30, last90, allHistory` arasından en yüksek ROAS'lı pencereyi seçiyor. Bu **last3 lucky day** baseline yapıp yapay decay üretebilir.

Yeni motor V1 fatigue logic'ini reuse etmeden ÖNCE düzeltmeli:
- `bestWindow` seçimi sadece `last14, last30, last90, allHistory`'den (kısa pencereleri at)
- Veya: window dahil edilmek için spend ≥ $200 minimum

---

## Soru 2 — CTR threshold for cut (karar: 2026-05-03)

### Mimari kural: Objective-aware scope

Yeni motor input olarak `campaign_objective` alır. Sadece desteklediği objective'lerde karar üretir; diğerleri `out_of_scope` etiketiyle skip edilir.

**Phase 1 supported_objectives**: `["OUTCOME_SALES"]` (purchase/value optimize)
**Sonraki phase'ler**: OUTCOME_ENGAGEMENT, OUTCOME_TRAFFIC, OUTCOME_LEADS, OUTCOME_AWARENESS — her biri için ayrı kural setleri.

```
SCOPE FILTER (her karar öncesi):
  IF campaign_objective NOT IN supported_objectives:
    label = "out_of_scope"
    reason = "Motor henüz {objective} için karar üretmiyor; sales objective dışı"
    SKIP
```

**Bulgu**: Mevcut Codex/AI rubric kıyasında 5 engagement kreatifi yanlışlıkla sales kuralıyla etiketlendi (julia_julia386, لا للمحراب, Our hearts are, mum2boys_style, Joyful prep — hepsi IwaStore). Bu kreatifler 71-kreatiflik sales kıyasından dışlanmalı (mevcut 04-comparison.csv'yi düzeltirken).

### Soru 2 cevabı: CTR sales objective içinde cut tetikçisi DEĞİL

Sadece `OUTCOME_SALES` kreatiflerinde:

| Tier | CTR'nin rolü |
|---|---|
| **1. Domain-evrensel** | **CTR tek başına cut tetiklemez.** Hardcoded yasak. Kanıt: Cherish every (ROAS 4.9, CTR 0.64%) ve New 2026 Collection (ROAS 3.27, CTR 0.67%) düşük CTR + güçlü performans örnekleri. |
| **2. Business config** | `low_ctr_threshold` cold start fallback (default %1.0, sadece UI badge için) |
| **3. Self-calibrating** | Hesabın geçmiş 90g sales kreatif CTR dağılımının P10 quantile'ı → bu hesabın "anormal düşük CTR" çizgisi. UI badge + confidence modifier, karar değil. |
| **4. Operator override** | Yok — bu kural katı. |

```
CTR cut'ı YASAK (Tier 1):
  IF only signal is "low CTR" → ignore et, ROAS+purchase kuralına dön

CTR confidence modifier (Tier 3):
  IF cut/refresh kararı verildi
  AND CTR < account.low_ctr_threshold (self-calibrated):
    confidence -10 puan

CTR UI badge:
  IF CTR < account.low_ctr_threshold:
    "düşük CTR" badge göster (label değişmez)
```

Engagement/traffic/lead objective'lerinde CTR farklı bir rol oynar (potansiyel ana karar metriği) — bu Phase 2+ kural setlerinde tasarlanacak.

---

## Soru 3 — Target civarı + yüksek purchase (karar: 2026-05-03)

### Karar
Target band (`ratio = roas / target` arası **0.85-1.10**) = **keep zone**. Scale değil. Fatigue ve CTR sinyalleri label'ı değiştirmez, sadece UI badge olarak eklenir.

### Konkret kural
```
ratio 0.85-1.10 (target band):
  fatigue = none      → keep
  fatigue = watch     → keep + "watch" UI badge
  fatigue = fatigued  → Soru 1 kuralı (recent_7d trend gate)
                          tetik varsa: refresh
                          tetik yoksa: keep + "fatigued" badge

Düşük CTR (account P10 altı): label etkilemez, ekstra UI badge (Soru 2 kuralı)
```

### Scale eşiği — business config (Tier 2)
```
scale_ratio_threshold:
  aggressive   = 1.2
  balanced     = 1.3 (default)
  conservative = 1.4
```
Operatör business setup'ında seçer. Cold start default = 1.3.

### Veriden destek
- **aura** (TheSwaf, ratio 0.94, fatigue=none) → 4/4 keep consensus, kuralı doğruluyor
- **A misbaha** (IwaStore, ratio 1.00, fatigue=none) → kural keep der; Marcus+Aria'nın "scale" demesi panel-bazlı zayıf sinyal
- **WallArtCatalog** (ratio 0.91, fatigue=watch) → keep + watch badge
- **Catalog New Collection** (ratio 1.08, fatigue=fatigued) → Soru 1 kuralı, recent trend gate'e göre refresh ya da keep+badge

---

## Soru 4 — truth_state=degraded_missing_truth (karar: 2026-05-03)

### Karar
Truth eksikliği label durdurmaz. **Truth varsa kullanılır; yoksa hesap kendi tarihinden self-calibrate eder.** Diagnose SADECE gerçek data quality problemi için.

### Truth ≠ Data Quality (mimari ayrım)

| | Anlamı | Örnek | Yeni motor davranışı |
|---|---|---|---|
| **Commercial truth** | İşletme yapısal veri (COGS, fulfillment, margin) | TheSwaf 76/76 degraded | Eksikse hesap baseline'a düş, label durmaz |
| **Data quality** | Performans metriğinin güvenilirliği | active+spend=0, policy_reject, stale | Diagnose tetikçisi |

### Target_roas resolution chain (Tier 1 → 2 → 3 → 4)

```
IF business.commercial_truth.target_roas IS SET:
  target = commercial_truth.target_roas
  truth_source = "commercial_truth"
  confidence_baseline

ELIF account has ≥30 mature creatives in last 90d:
  target = account.roas_p75   ← Tier 3 self-calibrating
  truth_source = "account_baseline"
  confidence -5, UI badge: "Truth eksik — hesap baseline P75=X kullanılıyor"

ELIF account has ≥10 mature creatives:
  target = account.roas_p60   ← daha geniş quantile, az veri için
  truth_source = "account_baseline_thin"
  confidence -15, UI uyarı badge

ELSE:
  target = global_default (varsayılan 2.0)
  truth_source = "global_default"
  confidence -25, güçlü uyarı badge
```

### Mature creative tanımı (P75 örneklemine girer)
- spend ≥ business.maturity_spend_threshold (default $300)
- purchases ≥ 3 (zero-conv burner'ları baseline'a sokma)
- decision_age ≤ 90g

### Quantile seçimi (Tier 2 business config)
- `account_baseline_quantile` default 0.75 (P75 = "hesabın iyileri")
- Aggressive operatör 0.6, conservative 0.85

### Önemli sınır (operatöre bildirilmeli)
Account baseline = **göreceli** karar verir, mutlak kâr/zarar değil. Hesap topyekün zarar ediyor olsa bile sistem "iyileri kötülerden" ayırır — UI badge bu sınırı işaret eder.

### Diagnose tetikçileri (sıkı tanım)

```
DIAGNOSE — SADECE bu 4 koşul:
  effective_status = "ACTIVE" AND spend (last 7d) = 0
    → "delivery issue: active ama harcamıyor, ad set/budget kontrol et"
  
  policy_reject = true
    → "policy: kreatif reddedildi, gözden geçir"
  
  data_freshness_hours > 48
    → "stale data: son güncelleme {N} saat önce, sync sorunu"
  
  tracking_anomaly (örn. spend var ama attribution 0 ve son 7g)
    → "tracking: pixel/CAPI sorunu olabilir"

NEYİ DEĞİL:
  truth_state = degraded_missing_truth → confidence cap, diagnose değil
  trust state = degraded → confidence cap, diagnose değil
  operating constraints missing → confidence cap, diagnose değil
```

### Confidence cap matrisi

| Truth source | Confidence delta | UI |
|---|---|---|
| commercial_truth | 0 (baseline) | yok |
| account_baseline | -5 | "hesap baseline" badge |
| account_baseline_thin | -15 | uyarı badge |
| global_default | -25 | güçlü uyarı badge |

### Veriden bağlam
Mevcut 76 kreatifte:
- truth_state="degraded_missing_truth" çoğunluk → V2 76/76 diagnose dedi (yanlış)
- Gerçek diagnose koşulları (active+no_spend, policy_reject, stale) bu snapshot'ta yakalanamadı çünkü `meta_ad_dimensions.ad_status`, `last_active_at`, `policy_reason` snapshot payload'ında saklanmıyor

**Bağımlılık**: Yeni motor diagnose tetikçilerini hesaplayabilmek için `meta_ad_dimensions` ve `meta_ad_daily` tablolarından ad_status + son spend tarihi + policy reason input'larına ihtiyaç duyacak. Snapshot tek başına yeterli değil.

---

## Soru 5 — Per-business config (karar: 2026-05-03)

### Karar
**Karar mantığı evrensel (Tier 1), eşikler değişken (Tier 2-3-4).** Ayrı kural seti yok; ortak iskelet, kalibrasyon farkı.

### Şey-katman tablosu

| Konu | Katman | Niteliği |
|---|---|---|
| **Karar mantığı** (label tree, oranlar) | Tier 1 evrensel | Tüm business'lar için AYNI |
| `target_roas` | Tier 2 commercial truth | Business config (varsa truth, yoksa account baseline) |
| `breakeven_roas` | Tier 2 commercial truth | Business config |
| `scale_ratio_threshold` | Tier 2 (aggressive/balanced/conservative preset) | Operatör seçer (default 1.3) |
| `maturity_spend_threshold` | Tier 2 (default: aylık spend × 0.05) | Her business kendi |
| `recent_sample_min` | Tier 2 (default $50) | Operatör tune |
| `account_baseline_quantile` | Tier 2 (default 0.75) | Operatör tune |
| `truth_penalty_for_degraded` | Tier 2 (default -10) | Operatör tune |
| `low_ctr_threshold` | Tier 3 self-calibrating | Account P10 (cold start: %1.0) |
| `refresh_threshold` (recent/total ratio) | Tier 3 self-calibrating | Account P10 (cold start: 0.75) |
| Operator overrides | Tier 4 | Per-creative geçici |

### Niye karar mantığı evrensel?

Domain mantığı işletme tipinden bağımsız:
- Hedef üstü winner = scale (DTC, B2B, agency — fark etmez)
- Sürdürülebilir kayıp = cut (her vertical aynı)
- Yorgun winner + recent düşüş = refresh (her platform aynı)

Sadece **eşikler** ve **target değerler** kalibrasyon ister, mantık değil.

### Phase 2'ye not: objective × business breakdown

Phase 1 scope = `OUTCOME_SALES`. Phase 2'de ENGAGEMENT/TRAFFIC/LEADS desteklendiğinde:
- Self-calibrating baseline'lar `business × objective` çift kırılım olmalı
- Sample size yeterli değilse `business`-only baseline'a fallback
- Cold start'ta `objective`-default

---

## TÜM KURALLAR — Yeni motor için final decision tree

```
INPUT: creative_row + business_config + account_calibration

═══════════════════════════════════════════════════════════
GATE 0 — SCOPE FILTER (Phase 1: sadece sales)
═══════════════════════════════════════════════════════════
  IF creative.objective NOT IN ["OUTCOME_SALES"]:
    → label = "out_of_scope"
    → reason = "Motor henüz {objective} için karar üretmiyor"

═══════════════════════════════════════════════════════════
GATE 1 — TARGET RESOLUTION (4-tier fallback)
═══════════════════════════════════════════════════════════
  IF business.commercial_truth.target_roas SET:
    target = business.commercial_truth.target_roas
    truth_source = "commercial_truth"
    confidence_baseline
  ELIF account.mature_creatives_90d ≥ 30:
    target = account.roas_p75
    truth_source = "account_baseline"
    confidence -5
  ELIF account.mature_creatives_90d ≥ 10:
    target = account.roas_p60
    truth_source = "account_baseline_thin"
    confidence -15
  ELSE:
    target = global_default (2.0)
    truth_source = "global_default"
    confidence -25

═══════════════════════════════════════════════════════════
GATE 2 — DATA QUALITY DIAGNOSE
═══════════════════════════════════════════════════════════
  IF effective_status = "ACTIVE" AND spend_7d = 0:
    → label = "diagnose"
    → reason = "delivery: active ama harcamıyor"
  ELIF policy_reject = true:
    → label = "diagnose"
    → reason = "policy reject"
  ELIF data_freshness_hours > 48:
    → label = "diagnose"
    → reason = "stale data"
  ELIF tracking_anomaly:
    → label = "diagnose"
    → reason = "tracking anomaly"

═══════════════════════════════════════════════════════════
GATE 3 — ZERO-CONV BURNER
═══════════════════════════════════════════════════════════
  IF purchases = 0 AND spend ≥ 200 AND age ≥ 7g:
    → label = "cut"
    → reason = "0 purchase + ${spend} spend"

═══════════════════════════════════════════════════════════
GATE 4 — MATURITY (test_more default)
═══════════════════════════════════════════════════════════
  IF spend < business.maturity_spend OR purchases < 5:
    → label = "test_more"
    → reason = "thin data ({spend}, {purchases})"

═══════════════════════════════════════════════════════════
GATE 5 — RATIO ZONES (mature creatives)
═══════════════════════════════════════════════════════════
  ratio = roas / target

  ┌─ ZONE: SCALE (ratio ≥ business.scale_ratio_threshold; default 1.3)
  │   IF purchases ≥ 10 AND recent_7d_roas ≥ target × 1.0:
  │     → label = "scale"
  │   ELSE:
  │     → label = "keep" (early signal yetersiz)
  │   IF fatigue = "fatigued":
  │     → fatigue badge eklenir, label DEĞİŞMEZ
  │
  ├─ ZONE: KEEP (target band: 0.85 ≤ ratio < 1.3)
  │   IF fatigue = "fatigued"
  │      AND (recent_7d_roas / total_roas) < account.refresh_threshold
  │      AND recent_7d_spend ≥ business.recent_sample_min:
  │     → label = "refresh"
  │     → reason = "fatigued + recent trend düşüş"
  │   ELSE:
  │     → label = "keep"
  │     fatigue=watch/fatigued ise badge
  │
  ├─ ZONE: CUT (ratio < 0.7) hard cut for mature spend
  │   IF spend ≥ business.cut_maturity_spend (default $1000):
  │     → label = "cut"
  │   ELIF spend ≥ 500 AND ratio < 0.4:
  │     → label = "cut"
  │   ELSE:
  │     IF fatigue = "fatigued":
  │       → label = "refresh" (zayıf + yorgun)
  │     ELSE:
  │       → label = "test_more"
  │
  └─ ZONE: WORKING (0.7 ≤ ratio < 0.85) zayıf ama break-even-yakını
      IF fatigue = "fatigued"
         AND recent trend gate tetiklenir:
        → label = "refresh"
      ELSE:
        → label = "keep"
        weak performance badge

═══════════════════════════════════════════════════════════
POST-PROCESS — BADGES & CONFIDENCE
═══════════════════════════════════════════════════════════
  CTR badge: ctr < account.low_ctr_threshold → "düşük CTR" UI badge
  Fatigue badge: fatigue ≠ none → "{fatigue}" UI badge
  Truth source badge: truth_source ≠ "commercial_truth" → ilgili uyarı
  
  Confidence başlangıç: 75
  - truth_source penalty (yukarıdaki tablo)
  - CTR penalty if low: -10
  - missing recent data: -10
  Clamp: [40, 95]

═══════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════
  {
    creativeId: "...",
    label: scale|keep|cut|refresh|test_more|diagnose|out_of_scope,
    reason: "<1-2 cümle>",
    confidence: 40-95,
    badges: ["fatigue:watch", "low_ctr", "truth:account_baseline", ...],
    metrics: { spend, purchases, roas, ratio_to_target, recent_7d_roas },
    truth_source: "commercial_truth"|"account_baseline"|...,
    engineVersion: "v3-2026-05-03"
  }
```
