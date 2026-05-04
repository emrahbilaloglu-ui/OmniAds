# Adsecute Karar Motorları — Kök Neden Analizi + Yeni Motor Spec'i

**Tarih**: 2026-05-03
**Kapsam**: 76 aktif/yakın-zamanda-kapatılmış kreatif (TheSwaf=40, IwaStore=36)
**Yöntem**: Bağımsız uzman media buyer etiketlemesi vs V1×3 + V2 + V2.1 + Meta-campaign motorları

---

## 1. Tema bazlı kök neden analizi

### Tema A — V1: Maturity gate'i pratikte ulaşılamaz

V1 motoru 76 kreatifin 54'ünü (%71) "test_more / keep_in_test / validating" diyor. Bunlar arasında:
- **EMB-CatalogAd**: $12,338 spend, 84 purchase → V1 hâlâ "validating"
- **EmB-Catalog Ad**: $7,422 spend, 53 purchase → V1 "validating"
- **A misbaha**: $838 spend, 19 purchase, ROAS 3.51 (target üstü) → V1 "validating"

Bunlar "test" değil; bunlar gerçek kreatifler, gerçek paralarla, gerçek satışlarla. V1 lifecycle "scale_ready" durumuna 0 kreatif geçmiş — yani sistem hiçbir kreatife "scale et" demiyor.

**Kök neden**: V1'in `scale_ready` ve `stable_winner` thresholdları o kadar yüksek ki pratikte ulaşılamaz. Sistem "agresif aksiyon alma" reflexine sahip.

### Tema B — V2: Commercial truth eksikliği motoru kilitliyor

V2 motoru **76/76 kreatif** için "Diagnose" diyor. Tek bir scale/keep/cut/refresh/test_more kararı yok.

Sebep tek: 76 kreatifin tamamı için `truthState = "degraded_missing_truth"`. V2 motoru bu flag'i sert bir gate olarak kullanıyor — commercial truth eksikse karar vermiyor.

**Kök neden**: V2 commercial truth'u **ön koşul** olarak görüyor, **bilgi katmanı** olarak değil. Eksikse "diagnose" demek, gerçek media buyer perspektifinden "ben işimi yapamıyorum, sen ayarlamalar yap" demek — operatör için yararsız.

### Tema C — V2.1: V2'nin sınırlamasını tekrar üretiyor

V2.1 buyer adapter %91 (69/76) "diagnose_data" veriyor. Bu V2'nin sonucunun (Diagnose) buyer adapter tarafından mekanik olarak "diagnose_data"ya çevrilmesi.

V2.1 V2'nin üzerine inşa edildiği için, V2 Diagnose verdiğinde V2.1 da Diagnose veriyor. 9 buyer action'dan sadece 3'ü kullanılıyor (diagnose_data, test_more, refresh) — diğer 6'sı (scale/cut/keep/protect/watch_launch/fix_delivery/fix_policy) hiç tetiklenmiyor.

**Kök neden**: V2.1 yeni bir karar mantığı değil, V2'nin etiket-değiştirici sarmalayıcısı. Üst katman alt katmanın hatasını miras alıyor.

### Tema D — Veri akışı mimarisinde kopukluk

V2 motorunun input'u (`recentRoas`, `long90Roas`, `recentPurchases`, `peerMedianSpend`) snapshot içinde saklanmıyor. Snapshot V1 motorunun output'u; V2 input'u için ayrı bir audit pipeline (`runCreativeLiveFirmAudit`) çalışmalı.

Şu an snapshot → V2.1 builder pipeline'ı V2 input'unu eksik kuruyor → motor "veri yetersiz" diyor → diagnose.

**Kök neden**: Karar motorları arasında veri sözleşmesi kopuk. Her motor farklı input formatı bekliyor, snapshot'ta ortak veri katmanı yok.

### Tema E — Meta campaign-level kararı eşleşmiyor

76 kreatiften sadece **4'ünün** Meta decision-os çıktısıyla campaign eşleşti. Sebep: snapshot'taki `deployment.preferredCampaignIds` ile Meta runtime'ın campaign listesi format/scope farklı.

**Kök neden**: Kreatif-level ve campaign-level decision sistemleri ayrı veri pencerelerinde, ayrı `decision_as_of` zamanlarında çalışıyor. İkisini birleştiren bir "creative ↔ campaign decision bridge" yok.

### Tema F — "diagnose" semantik kaymış

Gerçek media buyer dilinde **diagnose** = "data quality probleminden veri kalitesi düzelene kadar karar verme". Adsecute'ta **diagnose** = "ben karar veremiyorum, default'um bu". Bu çok büyük fark.

Sonuç: 76 kreatifin 69'u (V2.1) ve 76'sı (V2) "diagnose" — gerçekte hiçbiri data quality problemi olan kreatif değil; hepsinde data var, motor karar vermek istemiyor.

**Kök neden**: Bilgi/durum etiketlemesi (data eksik) ile karar etiketlemesi (önerim şu) aynı kategoride çakışıyor. Yeni motorda bunlar ayrılmalı.

---

## 2. Yeni motor için spec

### 2.1. Tasarım ilkeleri

1. **Tek motor, tek katman**. V1 → V2 → V2.1 → buyer adapter → snapshot builder zinciri yok. Tek fonksiyon: `decideCreative(input) → { label, reason, confidence }`.

2. **6 kategori, sade isimlendirme**:
   - `scale` — bütçe artışı için sinyal
   - `keep` — dokunma, oynamasına izin ver (günlük çoğunluk)
   - `refresh` — fatigue/saturation, yeni iterasyon çıkar
   - `cut` — kapat
   - `test_more` — gerçekten thin data (spend < eşik VEYA purchases < eşik), daha veri biriktir
   - `diagnose` — **sadece** data quality problem (status uyumsuzluğu, 0 spend ama active, policy reject). Eğer bu üç şart yoksa diagnose döndürme.

3. **Commercial truth eksikse de karar üret**. Truth eksikliği "confidence" düşürür (örn. 65 → 50), ama "diagnose"a yönlendirmez.

4. **Per-business target_roas zorunlu**. Hardcoded değil, business commercial truth'tan gelir (TheSwaf=1.71, IwaStore=3.5).

5. **Maturity gates gerçekçi**: spend ≥ $300 + purchases ≥ 5 ile non-test_more karar verilebilir. Daha sıkı eşik (live-audit'in $500 + 10) sahada çoğunluğu test_more'a iter.

6. **Output sade**: 200-500 byte / kreatif, 35KB değil. Sadece karar alıp uygulamak için lazım olanlar.

### 2.2. Rule set v0 (kuralı sade tut, judgment'a açık bırak)

```
INPUT: { businessId, creativeId, spend, purchases, roas, fatigueStatus, target_roas }

GATE 0: data quality
  IF status mismatch (active=true ama spend=0 son 7g)
  OR policy_reject = true
  OR data_freshness > 48h
  RETURN ("diagnose", "data quality issue: <reason>")

GATE 1: zero-conv burner
  IF purchases == 0 AND spend >= 200
  RETURN ("cut", "0 purchases despite $X spend")

GATE 2: maturity
  IF spend < 300 OR purchases < 5
  RETURN ("test_more", "thin data (spend=$X, purchases=Y)")

GATE 3: scale
  IF roas/target >= 1.4 AND purchases >= 10
  RETURN ("scale", "ROAS X = N% of target")
  IF purchases >= 8 AND roas/target >= 1.5  # early winner
  RETURN ("scale", "early winner: ROAS X = N% of target with Y buys")

GATE 4: hard cut
  IF spend >= 1000 AND roas/target < 0.7
  RETURN ("cut", "ROAS X = N% of target after $Z — clear loser at scale")
  IF spend >= 500 AND roas/target < 0.4
  RETURN ("cut", "sustained loser")

GATE 5: refresh
  IF fatigueStatus == "fatigued" AND spend >= 300
    IF roas/target >= 1.0
    RETURN ("refresh", "fatigued winner")
    ELSE
    RETURN ("refresh", "fatigued underperformer")

GATE 6: keep
  IF roas/target >= 1.0
  RETURN ("keep", "at/above target, stable")
  IF roas/target >= 0.7 AND spend >= 500
  RETURN ("keep", "below target but in working zone")

DEFAULT
  RETURN ("test_more", "unclear signal")
```

### 2.3. Confidence skoru (0-100)

Her karar için confidence (gerçek media buyer'ın "%80 eminim" sezgisini sayı olarak):
- Ham puan: maturity güçlü + ROAS uç değerlerde → yüksek confidence
- Penalize: truth_state eksik, fatigue belirsiz, recent data yok → -10/-15

```
base = 60
+ 10 if spend >= 1000
+ 10 if purchases >= 20
+ 10 if abs(ratio - 1.0) > 0.5  # uç değer (çok güçlü ya da çok zayıf)
- 10 if truth_state == "degraded_missing_truth"
- 10 if recentRoas missing
clamp [30, 95]
```

Confidence < 50 olanlar UI'da "düşük güven" badge ile gösterilebilir, ama karar yine de üretilir.

### 2.4. Output format (JSON, ~250 byte)

```json
{
  "creativeId": "creative_8qhjj",
  "label": "keep",
  "reason": "ROAS 1.33 below target 1.71 (78%) but in working zone — monitor",
  "confidence": 60,
  "metrics": { "spend": 7422.19, "purchases": 53, "roas": 1.33, "ratio_to_target": 0.78 },
  "engineVersion": "v3-2026-05-03"
}
```

### 2.5. NE OLMAYACAK

- ❌ `actionability` (direct/review_only/blocked/diagnose) — gerek yok, label zaten net
- ❌ `maturity` ayrı kategori (too_early/learning/actionable/mature) — test_more bunu zaten kapsıyor
- ❌ `problemClass` (performance/creative/fatigue/delivery/policy/data_quality/insufficient_signal/winner/launch_monitoring) — reason field'ı yeterli
- ❌ `actionFingerprint`, `evidenceHash`, `decisionSignals[]` — debug için olabilir ama ana output'ta yok
- ❌ `buyerAction` farklı katmandan tekrar mapping — direkt label kullan
- ❌ `Today Brief` + `Action Board` + `Row Decisions` + `Aggregate Decisions` — UI seçimi sonra yapılır, motor sadece per-creative label döner

---

## 3. Sıradaki adımlar (önerim)

1. **UI'ı kapat**: Creative Decision Center surface'ını feature flag ile gizle. Şu an üreten sinyaller %91 diagnose — UI'da gösterecek bir şey yok zaten.
2. **Yeni motoru yaz**: `lib/creative-decision-engine-v3.ts` — yukarıdaki rule set'i implement et. ~150-200 satır olur.
3. **76 kreatif üzerinde validation**: Yeni motor bu CSV'deki kreatiflere benim etiketlemem ile ne kadar uyuşuyor? Hedef: %80+ uyum.
4. **Sonra iterasyon**: Edge case'ler için rule'ları sıkıştır, threshold'ları ince ayar yap.
5. **UI'ı yeni motor üzerinde aç**: Sade bir tablo başla — creative_id, label, reason, confidence. Action Board / Today Brief sonra.

Bu plan'ın en kritik yanı şu: **mevcut V1/V2/V2.1 kod tabanını silme**. AR-GE klasörü olarak tut. Yeni motor production'a geçince eski motorları feature flag ile devre dışı bırak ama dosyaları silme — referans olarak kalır.
