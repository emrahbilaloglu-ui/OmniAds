# Yeni Karar Motoru — Implementation Planı (v3)

**Tarih**: 2026-05-03
**Bağlam**: 5 açık soru kapatıldı (`06-rule-decisions.md`). Bu dosya implementation'a rehberdir; tasarım kararları orada.

---

## 1. Mimari özet

**Tek motor, tek katman** — V1/V2/V2.1 zinciri yok.

```
lib/creative-decision-engine/
├── engine.ts              ← ana resolver: decideCreative(input) → Decision
├── target-resolution.ts   ← Gate 1: 4-tier truth/baseline fallback
├── diagnose.ts            ← Gate 2: data quality kontrolü
├── ratio-zones.ts         ← Gate 5: ratio bazlı karar tree
├── account-calibration.ts ← Tier 3 self-calibrating thresholds (P75, P10, refresh_threshold)
├── badges.ts              ← post-process badge ve confidence
├── types.ts               ← input/output contract
└── config.ts              ← business config schema, default'lar
```

**Reuse edilenler** (V1'den):
- `buildFatigue()` — fatigue motoru sağlam (çoklu sinyal, winnerMemory gate)
  - **Düzeltme şart**: `bestWindow` seçimi sadece `last14, last30, last90, allHistory`'den (last3/last7 atılır) — yapay decay önle
- Benchmark logic'i
- Snapshot loader

**Yeniden yazılanlar**:
- Karar üretim tree'si (Gate 1-5)
- Truth resolution chain
- Account-level self-calibration

---

## 2. Veri ihtiyaçları

Yeni motor şu input'lara ihtiyaç duyacak:

| Veri | Kaynak | Mevcut durumu |
|---|---|---|
| Per-creative kümulatif metrikler (spend, purchases, roas, ctr) | snapshot.payload.creatives veya `meta_creative_daily` | Snapshot dolu, daily tablo boş |
| **recent_7d_ROAS, recent_7d_spend** | `meta_ad_daily` (creative bazlı toplama) | meta_ad_daily 241k row dolu, kreatif bazlı toplanması gerek |
| total_roas (28d veya 90d aggregated) | `meta_ad_daily` aggregation | Aynı kaynak |
| **effective_status, last_active_at, policy_reason** | `meta_ad_dimensions` | dolu (7490 row) ama `ad_status` çoğu NULL — `projection_json`'dan çıkarılmalı |
| campaign_objective | snapshot.payload.creatives[].policy.objectiveFamily | dolu |
| target_roas, breakeven_roas | snapshot.payload.creatives[].economics veya `business_target_packs` | snapshot'ta dolu |
| Fatigue (status, decay metrics) | snapshot.payload.creatives[].fatigue | dolu |
| Account ROAS dağılımı (P75, P60 calibration) | runtime hesap: meta_ad_daily 90g | hesaplanmalı |
| Account refresh_threshold (P10 ratio) | runtime hesap: per-creative recent/total ratio dağılımı | hesaplanmalı |
| Account low_ctr_threshold (P10) | runtime hesap: account CTR dağılımı | hesaplanmalı |

### Ara katmanlar (yeni)

`lib/creative-decision-engine/data-source.ts`:
- `getRecentSevenDayMetrics(creativeId, asOf)` → `meta_ad_daily`'den
- `getEffectiveAdStatus(creativeId)` → `meta_ad_dimensions.projection_json.effective_status`
- `getAccountCalibration(businessId)` → P75 ROAS, P10 ratio, P10 CTR (90g pencere, cache'lenebilir)

---

## 3. Sıralama (revize 2026-05-03 — UI shadow başta, contract-first)

### Faz 0 — Foundation + UI iskelesi (kullanıcı her aşamayı canlı görsün)
1. `lib/creative-decision-engine/types.ts` — input/output contract
2. `lib/creative-decision-engine/engine.ts` — stub (mock output döner)
3. `lib/creative-decision-engine/data-source.ts` — adapter interface (mock + real fallback)
4. `app/(dashboard)/creatives/page.tsx` — eski surface kaldır, yeni surface mount et
5. `components/creatives/CreativeDecisionEngineV3Surface.tsx` — yeni UI iskeleti
6. Eski `CreativeDecisionCenterSurface.tsx` ve V1/V2/V2.1 zinciri **surface'tan kaldırılır** (cutover, kod AR-GE'de kalır)

**Sonuç**: Motor henüz logic üretmiyor, ama UI iskelesi 76 kreatif için "out_of_scope/test_more" gibi default kararlar gösterir. Layout, badge, confidence düzeni netleşir.

### Faz 1 — Motor core (sales scope, gate gate)
Her gate eklendiğinde kullanıcı UI'ı açıp doğrular:
- Gate 0 (scope filter) → 5 engagement kreatifi out_of_scope
- Gate 1 (target resolution) → truth_source badge görünür
- Gate 2 (data quality diagnose) → diagnose vakaları
- Gate 3 (zero-conv burner) → ilk gerçek cut'lar
- Gate 4 (maturity) → çoğu kreatif test_more
- Gate 5 (ratio zones) → full karar dağılımı

### Faz 2 — Veri katmanı (paralel: kullanıcı `meta_creative_daily` sync)
Kullanıcı paralel olarak `meta_creative_daily` günlük sync'i ekler. Hazır olunca:
1. `data-source.ts` mock'tan gerçek SQL'e geçer
2. recent_7d aggregation function (`meta_creative_daily`'den)
3. Account calibration cache (P75/P60/P10) — runtime hesap, 24h TTL
4. **V1 fatigue motoru düzeltmesi**: `bestWindow` seçimi sadece `last14, last30, last90, allHistory`'den (last3/last7 atılır)
5. effective_status / policy_reason için `meta_ad_dimensions.projection_json` parse

### Faz 3 — Validation
1. 71 sales kreatifi yeni motora ver (5 engagement out_of_scope)
2. Çıktıyı `04-comparison.csv`'deki AI rubric + Marcus + Lin + Aria ile karşılaştır
3. Fark analizi raporu: `_analysis/08-engine-v3-validation.md`
4. Beklenti: v3 vs Marcus agreement ≥ %70 (kullanıcı niyetine yakın)
5. Edge case'ler için manual review

### Faz 4 — Cutover (Faz 0'da kısmi cutover, burada finalize)
1. Eski V1/V2/V2.1 surface kaldırma Faz 0'da yapıldı — burada production switch
2. `creative_engine_v3_decisions` tablosu oluştur (per-creative satır)
3. Snapshot persistence yeni şemaya
4. Eski `creative_decision_os_snapshots` AR-GE olarak DB'de kalır

---

## Veri katmanı prensipleri (kararlaştırıldı: 2026-05-03)

**Retention**:
- Performans metrikleri + metadata: **455 gün** normalized warehouse (365 aktif + 90 gün quarterly YoY)
  - Aktif karar penceresi (yeni motor sorguları): son 365g
  - YoY karşılaştırma penceresi: 365-455g (çeyreklik YoY, mevsimsel ramping pattern, Ramazan/holiday season karşılaştırması — leap year tamponu dahil)
- Ağır medya/preview alanları: **90 gün**
- `image_hash` referansı: **455g** (eski kreatif preview lazım olursa Meta'dan yeniden çekilebilir)

Gerekçe: çeyreklik YoY (90g + 365g) ve mevsimsel pattern (Ramazan/Q4) karşılaştırmaları yarı-otomatik karar üretimi için temel. 455g aşağıdaki üç somut analiz scenario'sunu kapsar:
- "Q4 2025 vs Q4 2024 holiday season ROAS"
- "Geçen yıl Black Friday öncesi ramping pattern (30g+30g geriye)"
- "Ramazan dönemi YoY (60g pencere)"

**Read-write separation** (kritik):
- **Sync ayrı process** (scheduled job, günlük + saatlik incremental + on-demand trigger)
- **GET endpoint'leri DB'ye yazmaz** — sadece okur
- **Live fallback** eksik warehouse coverage için kalır, ama Meta API response DB'ye yazılmaz
- Live fallback request-scoped memory cache kullanabilir (aynı request'te tekrar fetch önle), DB persist yok

### data-source.ts adapter davranışı
```typescript
class WarehouseDataSource implements CreativeDecisionDataSource {
  private liveCache = new Map(); // request-scoped, in-memory
  
  async getRecentSevenDayMetrics(creativeId, asOf) {
    // 1. Warehouse'a bak
    const fromDb = await db.query(...);
    if (fromDb) return fromDb;
    
    // 2. Live fallback (request cache check)
    if (this.liveCache.has(creativeId)) return this.liveCache.get(creativeId);
    
    // 3. Meta API'den çek
    const live = await metaApi.getInsights(creativeId, asOf);
    this.liveCache.set(creativeId, live); // sadece bu request için
    
    // 4. DB'ye yazma — sync process'in sorumluluğu
    return live;
  }
}
```

### Sync schedule önerisi (codex sync kurarken)
- Günlük tam sync: gece UTC + 3 saat (Meta aggregation netleştikten sonra)
- Saatlik incremental: opsiyonel ama tavsiye (gün içi fresh karar için)
- On-demand: rate-limited (5 dakikada 1 max)

---

## Contract-first prensipi (madde 2 sonucu)

Kullanıcı `meta_creative_daily` sync'ini paralel ekleyecek. Ben motoru `recent_7d_roas` + `recent_7d_spend` varmış gibi yazarım. `data-source.ts` adapter'ı:

```typescript
interface CreativeDecisionDataSource {
  getRecentSevenDayMetrics(creativeId: string, asOf: Date): Promise<{
    spend: number;
    purchases: number;
    roas: number;
    impressions: number;
  } | null>;
  
  getEffectiveAdStatus(creativeId: string): Promise<{
    status: "ACTIVE" | "PAUSED" | "DELETED" | "REJECTED";
    lastActiveAt: Date | null;
    policyReason: string | null;
  } | null>;
  
  getAccountCalibration(businessId: string): Promise<{
    roasP75: number | null;
    roasP60: number | null;
    refreshThresholdP10: number | null;
    lowCtrThresholdP10: number | null;
    sampleSize: number;
  }>;
}
```

İki implementation:
- `MockDataSource` — Faz 0-1 boyunca, sabit veri (test için yeterli, motor logic geliştirme için)
- `WarehouseDataSource` — Faz 2'de `meta_creative_daily` hazır olunca aktif olur

Motor adapter'a bağımlı, hangi source'tan veri gelmesi fark etmez. Bu, paralel geliştirmeyi mümkün kılar.

---

## 4. Validation kriterleri (Faz 3)

71 sales kreatifi için yeni motor beklenen davranışı:
- **Strong consensus 4/4 vakaları** (`wearthefearrevise: cut`, `aura: keep`) → motor da aynı kararı vermeli
- **High-disagreement vakaları** (örn. EmB-Catalog Ad ROAS 1.33, target 2.2 → ratio 0.60): motor "cut" demeli (ratio < 0.7 + spend $7422 + olgun)
- **Diagnose dağılımı** mevcut veride **0** olmalı (gerçek diagnose koşulu yok, çünkü `meta_ad_dimensions.ad_status` çoğunlukla NULL)
- **out_of_scope** = 5 (engagement kreatifleri)

Karşılaştırma tablosu üretilecek: `_analysis/08-engine-v3-validation.csv`

### Başarı kriterleri
- v3 vs Marcus agreement ≥ %70 (kullanıcının niyetine yakın persona)
- v3 vs (Lin + AI rubric) agreement düşer (konservatiften daha aksiyon-oriented'a kayar)
- v3 vs Aria agreement orta (CTR'ye dayanmıyor, ama refresh kuralları benzer)
- 0 hard error (her kreatif bir label aldı)

---

## 5. Cold start ve operasyon

### Cold start senaryoları

| Durum | Davranış |
|---|---|
| Yeni business, hiç tarihi yok | global_default target (2.0), confidence -25, güçlü uyarı badge |
| Business var ama < 10 mature creative | global_default, "kalibre oluyor" badge |
| Business var, ≥10 mature | account_baseline_thin (P60), confidence -15 |
| Business var, ≥30 mature | account_baseline (P75), confidence -5 |
| Commercial truth set | tam confidence, baseline target |

### Self-calibration cache stratejisi

Her business için 90g rolling pencerede:
- account_roas_p75 (target fallback)
- account_roas_p60 (target fallback thin)
- account_recent_to_total_ratio_p10 (refresh threshold)
- account_ctr_p10 (low_ctr_threshold)

Cache invalidation: günlük rebuild (nightly job) veya kreatif-snapshot'ta on-demand.

### Operator override mekanizması

Per-creative override DB tablosu: `creative_decision_overrides`
- creative_id, override_label, override_reason, set_by, expires_at
- Motor karar üretmeden önce kontrol eder; varsa kullanır + "operator override" badge

(Bu Phase 1'de implementation gerek değil, Phase 2 için skeleton.)

---

## 6. Eski motorlar — durumu

**Silinmiyor, AR-GE klasörü olarak kalıyor**:
- `lib/creative-decision-os.ts` (V1)
- `lib/creative-decision-os-v2.ts` (V2)
- `lib/creative-decision-center/*` (V2.1 buyer adapter)

**Surface kapatılıyor (Faz 5)**:
- `app/(dashboard)/creatives/page.tsx` v3 motoruna bağlanıyor
- `components/creatives/CreativeDecisionCenterSurface.tsx` v3 output formatına adapte ediliyor (Today Brief + Action Board basitleştiriliyor)

**Snapshot tablosu**:
- `creative_decision_os_snapshots` korunuyor (V1 output AR-GE), v3 ayrı tablo: `creative_engine_v3_decisions` (per-creative satır, daha küçük JSON)

---

## 7. Açık operasyonel sorular (implementation öncesi son tur)

1. **Faz 4 paralel mi (shadow), yoksa direkt cutover mı?** Önerim: shadow mode 1-2 hafta, sonra cutover.
2. **`meta_ad_daily` boyutu 241k row** — recent_7d aggregation performans için index ekleme lazım mı? Önerim: `(business_id, creative_id, date)` composite index var mı kontrol et.
3. **Account calibration cache** nightly job mı, on-demand mı? Önerim: on-demand + 24h TTL (Faz 1'de basit tutalım).
4. **UI refactor scope'u** v3 ile aynı sprint mi yoksa ayrı bir iş paketi mi? Önerim: ayrı sprint — motor önce, UI sonra.

---

## 8. Risk ve fallback'ler

| Risk | Etki | Önlem |
|---|---|---|
| `meta_ad_daily` recent_7d aggregation yavaş | runtime > 5sn / business | index + materialized view |
| Account calibration cold start (yeni business) | yanlış default | global_default + güçlü uyarı + operatör manuel override yolu |
| Truth ile baseline arasındaki gap büyük (örn. truth 3.5, account P75 1.5) | sistem aniden cut bombardımanı | UI'da "truth ↔ baseline divergence" uyarı badge |
| V1 fatigue motoru bestWindow düzeltmesi yapılmazsa | yapay refresh tetiklemeleri | Faz 2'de mutlaka düzelt |

---

## 9. Bu plan için bekleyen onay

- [ ] Faz sıralaması ve scope
- [ ] Veri katmanı önerileri (recent_7d aggregation kaynağı)
- [ ] Validation kriterleri
- [ ] Eski motorların AR-GE olarak tutulması
- [ ] Snapshot schema (yeni tablo: `creative_engine_v3_decisions`)
- [ ] Faz 4 shadow mode önerisi
