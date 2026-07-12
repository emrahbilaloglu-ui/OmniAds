# Adsecute Meta Karar Motoru Derin Matematik Denetimi

Tarih: 2026-07-12
Kapsam: Creative/Ads karar motoru, Structure kararları, eşik kalibrasyonu,
ticari otorite, tarihsel replay, veri zaman-doğruluğu ve otomasyon güvenliği.

## 1. Yönetici kararı

**Nihai karar ikiye ayrılmıştır:**

- **Read-only / shadow karar desteği:** `CONTINUE`.
- **Provider'a otomatik aksiyon yazma:** `STOP_AND_FIX`; kapalı kalmalıdır.

Kullanıcının hedeflediği minimum 9.5 seviyesi henüz kanıtlanmış değildir. Yerel
mühendislik/formül hazırlığı bu çalışma öncesindeki yaklaşık **5.0/10** düzeyinden
**7.9/10** düzeyine çıktı. Bu, test başarısı ve daha güvenli matematik açısından
anlamlıdır; fakat gerçek kanıt tavanı yaklaşık **5.5/10** seviyesindedir. Nedeni
formüllerin çalışmaması değil, geçmiş karar anındaki tam girdilerin ve karşı-olgusal
aksiyon sonuçlarının eksik olmasıdır.

`9.5/10` demek için yalnızca doğru görünen formüller yetmez. Aşağıdakilerin
birlikte kanıtlanması gerekir: sıfır gelecek-veri sızıntısı, native ad-grain geçmiş,
tam input manifestleri, düşük unknown oranı, hard-action precision/recall/ECE
kapıları ve kontrollü aksiyon kanıtı. Bugünkü veri bunların tamamını taşımıyor.

## 2. Puanlama yöntemi

Puanlar sezgisel bir “beğeni” puanı değildir:

- `0-4`: genel sabitlere veya eksik kimliğe rağmen karar üreten sistem.
- `5-6`: deterministik ve testli, fakat hesap/zaman/aksiyon bağlamı zayıf sistem.
- `7-8`: hesap-adaptif eşikler, fail-closed otorite, formül testleri ve sınırlı replay.
- `9`: tam PIT girdiler, native execution grain ve ölçülebilir hard-action kalitesi.
- `9.5`: precision/recall/ECE ile kontrollü-canary/treatment kanıtı birlikte geçer.
- `10`: aynı kalite farklı hesap, dönem ve rejimlerde sürdürülebilir biçimde tekrar eder.

| Bileşen | Önce | Yerel kod | Kanıt tavanı | Neden 10 değil |
|---|---:|---:|---:|---|
| Creative/Ads formül matematiği | 5.4 | 8.6 | 6.0 | Native ad-grain outcome ve hard-action örneği yok |
| Structure formül matematiği | 4.6 | 8.2 | 5.5 | Live maturity alanları her fallback yolunda tam değil |
| Segmentasyon / karar grain'i | 4.0 | 8.4 | 5.5 | Karışık creative aggregate güvenli biçimde dışlanıyor; ad-grain producer henüz yok |
| Hesaba ve zamana adaptif eşikler | 5.5 | 8.2 | 6.0 | Bazı güvenlik/politika sabitleri ve shrinkage eksik |
| Güvenlik / aksiyon otoritesi | 6.0 | 9.5 | 8.5 | Kod fail-closed; kontrollü provider-write kanıtı yok |
| Veri lineage / PIT doğruluğu | 4.2 | 7.6 | 4.8 | Exact-day raw scope yalnızca 7/12; facts tam bitemporal değil |
| Ölçüm / backtest / kalibrasyon | 3.8 | 5.4 | 4.0 | Replay non-causal, %50 outcome unknown, hard karar yok |
| Terminoloji / karar semantiği | 5.5 | 7.8 | 7.0 | Dört katmanlı model belgeli; tüm yüzeylere migration tamamlanmadı |
| **Ağırlıklı toplam** | **5.0** | **7.9** | **5.5** | 9.5 için immutable facts + treatment evidence gerekir |

Bu toplamlar birbirine eklenen başarı yüzdeleri değildir. En zayıf güvenlik veya
kanıt halkası otomasyon tavanını belirler.

## 3. Bağımsız inceleme yapısı

Çalışma altı ayrı uzman bakışıyla yürütüldü:

1. **Kıdemli Meta media buyer:** kararların gerçek kampanya/ad set/ad kullanımına
   ve “winner/promote/scale/cut” terminolojisine uygunluğunu değerlendirdi.
2. **Karar bilimci / istatistikçi:** eşik, quantile, decay, maturity ve confidence
   matematiğini inceledi.
3. **Causal inference / backtest uzmanı:** replay censoring, off-policy sonuçlar,
   precision/recall ve ECE iddialarını denetledi.
4. **Data lineage / PIT mühendisi:** cutoff, target history, raw fetch generation,
   identity ve zaman sızıntısını inceledi.
5. **Safety / action-authority mühendisi:** hard aksiyon, hysteresis, stale target,
   execution CTA ve fail-closed kurallarını inceledi.
6. **Adversarial release reviewer:** diğer görüşlerden bağımsız olarak güncel
   worktree'yi tekrar taradı ve yalnız doğrulanabilir critical/major bulgu aradı.

Claude Code görünür uygulamada bağımsız review yaptı. Claude'un öne çıkardığı
ana riskler; örtüşen fatigue pencereleri, global frequency eşiği, runtime raw
generation tekrar sayımı, stale ticari eşik otoritesi, mutable-fact replay ve
kalibre edilmemiş confidence idi. Claude'un kararı shadow/read-only devam için
koşullu `CONTINUE`, otomatik execution için kapalı kalma yönündeydi.

Son adversarial review dört ek `STOP_AND_FIX` maddesi buldu: terminal raw cursor'ın
ilk sayfaya düşmesi, non-zero global page checkpoint matematiği, Creative Engine
action-specific ROAS otoritesi, snapshot'ta bitemporal/current target kontrolü ve
replay raporundaki sabit tarih metni. Dördü de kod ve regresyon testiyle kapatıldı.
Aynı reviewer son worktree'yi yeniden denetledi; dört bulgunun tamamını `CLOSED`
ve genel kararı `CONTINUE` olarak verdi. Replay rapor metni için ayrı bir pure
unit suite bulunmamasını test açığı olarak not etti; güncel generator, JSON ve
Markdown değerleri doğrudan birbirine karşı doğrulandı.

## 4. Mevcut sonuç neden hatalıydı, yeni formül ne yapıyor?

### 4.1 Fatigue ile performans düşüşü karışıyordu

**Eski sonuç:** geçmişte iyi olan bir creative, frekansı 1.2 gibi düşükken bile
ROAS/CTR düşüşü nedeniyle “fatigued” olabiliyordu. Örtüşen 28/30/90 günlük
pencereler bağımsız kanıt gibi kullanılıyor, global `frequency >= 2.5` çizgisi
hesap DNA'sını yok sayıyordu.

**Yeni sonuç:** fatigue için iki farklı koşul birlikte gerekir:

```text
decay_count >= 2
AND
(frequency >= account_frequency_Q75 OR benchmark_weakening = true)
```

Karşılaştırma örtüşmeyen iki dönemle yapılır:

```text
recent14 = [t-13, t]
prior14  = [t-27, t-14]
decay(metric) = (prior14_metric - recent14_metric) / prior14_metric
```

`recent14` ve `prior14` harcama/satın alma tabanını geçmiyorsa fatigue hard
kanıtı çıkmaz. Frequency baskısı hesap içi 28 günlük creative dağılımının Q75'i
ile belirlenir; minimum örnek yoksa fail-closed olur.

**Etkisi:** düşük frekanslı ekonomik düşüş “audience fatigue” diye yanlış
sınıflandırılmaz; decline/lifecycle sinyali olarak kalır.

### 4.2 Küçük funnel sapması ekonomik sonucu eziyordu

**Eski sonuç:** bir metrik P25'in çok az altındaysa, örneğin Link-to-LPV
`30.06%` ve hesap P25'i `30.84%`, hedef üstü ROAS olsa bile terminal `diagnose`
çıkabiliyordu.

**Yeni zayıflık eşiği:** risk preset çarpanı `m_weak` olmak üzere:

```text
weak_threshold = min(Q25, m_weak * Q50)
weak = observed_rate < weak_threshold
```

Ekonomik üstünlük kuralı:

```text
economic_ratio = observed_ROAS / target_ROAS
if economic_ratio >= 0.85:
    funnel_diagnosis = secondary_evidence
    terminal_decision = economic/lifecycle gates
```

**Etkisi:** funnel problemi görünür kalır, fakat hedefe yakın/üstü gerçek ekonomik
sonuç generic kararsızlığa dönüşmez.

### 4.3 Growth target ile loss boundary birbirinden türetiliyordu

**Eski sonuç:** `break_even_roas * 1.15` growth target, `target_roas * 0.75`
loss boundary gibi davranabiliyordu. Bu oranların işletme ekonomisinde zorunlu
bir karşılığı yoktur.

**Yeni action-specific otorite:**

```text
budget_scale_authority = fresh(explicit_target_roas)
economic_cut_authority = fresh(explicit_break_even_roas)
```

Fresh target CPA yalnızca evidence/spend unit üretebilir:

```text
target_cpa -> maturity sizing allowed
target_cpa -/-> scale authority
target_cpa -/-> cut authority
```

Upper-funnel/lead/traffic/engagement kararında purchase target, CPL/CPC/ATC veya
engagement hedefi yerine geçmez. Goal-specific anchor yoksa aday review-only'dir.

### 4.4 Ticari olgunluk sabit para eşiğine bağlıydı

**Eski sonuç:** TRY/EUR/USD için ayrı sabit harcama çizgileri hesap ekonomisinden
bağımsız otorite verip kesebiliyordu.

**Yeni loss maturity:**

```text
risk_multiplier = {
  aggressive: 1.5,
  balanced:   2.0,
  conservative: 2.5
}

loss_maturity_spend = max(
  account_calibrated_hard_cut_spend,
  CPA_baseline * risk_multiplier
)
```

CPA baseline önceliği:

```text
break_even_cpa > target_cpa > account_cpa_baseline
```

Risk multiplier performans eşiği değil, açık operator risk politikasıdır.

### 4.5 Nested Structure pencereleri bağımsız oy sayılıyordu

**Eski sonuç:** 3/7/14/30/90d cumulative metrikleri aynı günleri tekrar tekrar
sayarak sahte confirmation üretiyordu. “90d satırı var” ifadesi kampanyanın 90
günlük olduğunu da kanıtlamıyordu.

**Yeni disjoint bantlar:**

```text
B1 = day 0..3
B2 = day 4..7
B3 = day 8..14
B4 = day 15..30
B5 = day 31..90

w_i = 2 ^ (-midpoint_i / 14)
weighted_ROAS = sum(w_i * revenue_i) / sum(w_i * spend_i)
weighted_CPA  = sum(w_i * spend_i) / sum(w_i * purchases_i)
```

Cumulative zincir non-monotonic ise ilk bozuk banttan sonrası kullanılmaz.
Gerçek olgunluk:

```text
age = min(explicit_age, distinct_active_days, calendar_age_since_first_delivery)
```

### 4.6 Creative aggregate yanlış execution context'e bağlanıyordu

**Eski sonuç:** aynı creative farklı ülke, hesap, campaign, ad set veya
optimization'da kullanıldığında son görülen context tüm aggregate adına karar
verebiliyordu.

**Yeni grain eligibility:** positive-spend kaynakta aşağıdaki cardinality'lerin
her biri tam `1` olmalıdır:

```text
provider_account_count = 1
campaign_count = 1
adset_count = 1
optimization_context_count = 1
objective_count = 1
funnel_cohort_count = 1
context_identity_unknown = false
```

Herhangi biri farklıysa sonuç `out_of_scope`; majority-spend ile rastgele bir
context seçilmez. Bu muhafazakârlığın kalıcı çözümü native ad-grain producer'dır.

### 4.7 Hysteresis eski hard kararı güvenli olmayan biçimde taşıyabiliyordu

**Yeni kural:**

```text
soft -> hard: aynı raw hard karar iki ardışık değerlendirme ister
hard -> soft: güvenlik çıkışı anında yayımlanır
hard A -> hard B: geçiş canonical keep üzerinden yeniden doğrulanır
```

Bekleyen hard girişte yayımlanan label `keep`, raw niyet `raw_label` ve
`pending_transition` metadata'sında kalır. Eski hard label bugünün payload'ıyla
birleştirilmez.

### 4.8 Target history bugünün bilgisini geçmişe sızdırabiliyordu

Tarih-only üretim cutoff'u artık tam `03:00:00Z`:

```sql
effective_at <= producer_cutoff
AND recorded_at <= producer_cutoff
ORDER BY effective_at DESC, recorded_at DESC
LIMIT 1
```

03:00 sonrasında girilen target aynı günkü 03:00 replay'ine giremez. Dated
Structure snapshot aynı history'yi kullanır. Persist edilmiş bir aksiyon servis
edilirken target güncel olarak tekrar okunur; stale/deleted/missing ise karar
`watch` olur, `proposedAction` ve `targetValue` kaldırılır.

### 4.9 Raw fetch restore aynı generation'ı iki kez sayabiliyordu

**Eski hata:** tamamlanmış generation'da `nextPageUrl = null`, nullish fallback
nedeniyle ilk sayfa URL'ine dönüşebiliyordu. Ayrıca non-zero partition-global
page index için `pages.length` kullanılıyordu.

**Yeni kural:**

```text
checkpoint exists AND nextPageUrl = null -> fetch complete
checkpoint absent -> build first page URL
post_fetch_next_page_index = last_global_page_index + 1
```

Yalnız son observed generation seçilir; incomplete son generation varsa eski
complete generation'a geri dönülmez. Checkpoint row count, cursor ve durable raw
sayfalar birebir uyuşmazsa üretim fail-closed olur.

## 5. Terminoloji ve karar sınıflandırması

Tek bir `scale/keep/watch/diagnose` etiketi dört farklı soruyu birbirine
karıştırmamalıdır. Önerilen kalıcı sözleşme:

1. **economicVerdict:** profitable / loss_making / uncertain / not_applicable.
2. **portfolioRole:** current_winner / historical_winner / challenger /
   learning / declining / exhausted.
3. **authorityState:** actionable / review_only / blocked_data /
   blocked_commercial / blocked_policy.
4. **executionAction:** promote_ad / keep_running / cut_ad / increase_budget /
   decrease_budget / change_bid / refresh_creative / resolve_data / none.

Creative/Ad düzeyinde “scale” doğru execution fiili değildir. Doğru ifade:

- Test kampanyasındaki iyi ad: **Winner / Promote to main**.
- Ana kampanyada iyi ad: **Current winner / Keep running**.
- Campaign veya ad set budget artışı: **Increase budget / Scale budget**.
- Ad kapatma: **Cut ad**.

Bu ayrım mevcut resolver'ı atmak anlamına gelmez. Mevcut matematik
`economicVerdict` ve `portfolioRole` üretmeye devam eder; server adapter yalnız
doğru bağlama göre execution action üretir. UI buyer action hesaplamaz.

## 6. Sabit eşik denetimi

### Kaldırılan veya adaptif hale getirilenler

| Eski yaklaşım | Yeni yaklaşım |
|---|---|
| Global frequency `2.5` | Hesap 28d creative frequency Q75, örnek floor |
| `breakEven * 1.15` growth | Fresh explicit target ROAS |
| `target * 0.75` loss | Fresh explicit break-even ROAS |
| Currency-specific spend floor | Account CPA × risk posture, calibrated floor ile max |
| Nested cumulative vote | Disjoint weighted bands |
| Ortak funnel sample count | Her metric için ayrı sample floor |
| Mutable current target | Bitemporal cutoff target |

### Sabit kalması meşru olan politika eşikleri

- `1.5 / 2.0 / 2.5` risk multiplier: performans tahmini değil, açık risk posture.
- Hard girişte iki değerlendirme: safety policy.
- 30 günlük target freshness: operatör kontrol periyodu; performans eşiği değil.
- Minimum sample floor: tahmin güvenliği; account performance cutoff'u değil.

### Bir sonraki adaptif çalışma gerektirenler

- Fatigue decay `18%` materiality.
- Spend concentration `55%` pressure.
- Bazı age/purchase minimumları.
- Scenario normalized-score cutoffs.
- Campaign/ad set budget increment `10-25%` aralıkları.

Önerilen hierarchical shrinkage:

```text
n_eff = (sum(omega))^2 / sum(omega^2)
w = n_eff / (n_eff + k)
theta_group = w * theta_local + (1 - w) * theta_parent
```

Parent sırası `account+goal+country -> account+goal -> account -> portfolio`
olmalıdır. Böylece az örnekli segment rastgele eşik üretmez; güçlü yerel veri
geldikçe kendi DNA'sına yaklaşır.

## 7. Tarihsel veri ve replay kanıtı

### Raw PIT integrity

- Observed raw snapshot: **1,949**.
- Karar cutoff'unda exact-day uygun snapshot: **277**.
- Post-cutoff olduğu için dışlanan: **1,672**.
- İncelenen scope: **12**.
- Tam reconstruct edilebilen scope: **7**.
- Exact-day girdisi eksik scope: **5**.
- Kullanılabilir evidence row: **187**.
- Seçilen generation içinde conflict: **0**.
- Sonuç: `unknown`; `reconstructionEligible=false`.

Bu sonuç “geçmiş veri kullanılamaz” demek değildir. Formül ve authority davranışı
simüle edilebilir. Fakat 5/12 scope yokken bu replay production kararının tam
PIT rekonstrüksiyonu diye sunulamaz.

### Current-engine candidate replay v2

`2026-06-29..2026-07-05`, Grandmix + IwaStore + TheSwaf, 21 business-day:

- Karar satırı: **1,966**.
- Unique creative: **340**.
- Label dağılımı: `out_of_scope=605`, `test_more=1,229`, `diagnose=76`,
  `keep=56`.
- Hard karar: **0**.
- Episode: **368**; known **184**, unknown **184**.
- Unknown oranı: **50.0%**.
- Kaynak modu: yalnız `runtime_sql_fallback`.
- Current-version persisted snapshot fidelity karşılaştırması: `0` ortak satır.

| İşletme | Karar | Creative | Label özeti | 7d known | 7d unknown |
|---|---:|---:|---|---:|---:|
| Grandmix | 602 | 123 | out_of_scope 231, test_more 370, diagnose 1 | 71 | 53 |
| IwaStore | 545 | 92 | test_more 414, out_of_scope 40, diagnose 68, keep 23 | 75 | 39 |
| TheSwaf | 819 | 125 | test_more 445, out_of_scope 334, keep 33, diagnose 7 | 38 | 92 |

Bu replay formül davranışını ve authority collapse'ı gösterir. Hard karar yoksa
hard precision “mükemmel” değildir; **ölçülemez**. Unknown episode'lar başarısız
karar gibi de başarılı karar gibi de sayılamaz.

Outcome pencereleri operatörün geçmişte yaptığı gerçek aksiyonlardan etkilenir.
Cut sonrası sıfır forward spend “tasarruf edildi” kanıtı değildir; off-policy
censoring'dir. Bu nedenle replay sonucu causal lift iddiası taşımaz.

## 8. Kapanan açıklar

- Fatigue: disjoint prior14/recent14 + account Q75 frequency.
- Funnel: materiality + ekonomik üstünlük sıralaması.
- Target/loss ayrımı ve goal-specific action authority.
- Structure: account/currency/intent/bid context izolasyonu.
- Structure: disjoint weighted history ve gerçek maturity.
- Per-metric funnel sample floors.
- Creative mixed-context fail-closed grain guard.
- Bitemporal target pack ve exact 03:00 cutoff.
- Snapshot üretiminde historical target; serving'de current authority revocation.
- Raw fetch latest-generation restore, terminal cursor ve global index doğruluğu.
- Safety-dominant hard-label hysteresis.
- Replay precision/recall/ECE polarity ve metodoloji açıklamaları.
- Quality-only double confidence penalty kaldırıldı.
- Paused hierarchy normalization ve ECE hard-only kapsamı.

## 9. Açık kalan gerçek sınırlamalar

1. `meta_creative_daily` tam bitemporal fact history değildir; sonradan düzeltilen
   provider facts eski kararın birebir girdisi sayılamaz.
2. Native ad-grain decision producer yoktur. Mixed creative aggregate güvenli
   biçimde dışarı alınır, fakat bu coverage kaybıdır.
3. Structure runtime fallback'ta first-delivery/active-day alanlarının tamamı her
   kaynak yolunda garanti değildir; bilinmiyorsa hard action fail-closed kalır.
4. Confidence bir trust/quality skorudur; henüz account/action bazında kalibre
   edilmiş başarı olasılığı değildir.
5. Yayınlanmış hard-bucket ECE yaklaşık `0.14`; otomasyon kapısı `0.05` ve kapalıdır.
6. Replay'de hard aksiyon yoktur; hard precision, recall ve flip reduction bu
   aday setinde doğrulanamaz.
7. Outcome unknown oranı kabul eşiğinin çok üzerindedir.
8. Randomized holdout, treatment receipt veya kontrollü canary karşılaştırması yoktur.
9. Fatigue 18%, concentration 55%, bazı maturity minimumları ve budget-step
   politikaları hierarchical calibration'a taşınmamıştır.
10. Dört katmanlı terminoloji bütün eski snapshot/UI compatibility yüzeylerine
    tam migrate edilmemiştir.

## 10. 9.5 kabul kapıları

Bir sonraki engine version ancak aşağıdaki ölçülebilir kapılarla 9.5 adayı olabilir:

1. **PIT:** geleceğe sızıntı `0`; raw/fact generation conflict `0`.
2. **Identity coverage:** overall `>=95%`, her aktif hesapta `>=90%` native
   account/campaign/adset/ad/optimization identity.
3. **Generation completeness:** karar verilen her row immutable input manifest'e
   ve exact target version'a bağlanır.
4. **Hard precision:** point estimate `>=0.92`, Wilson lower bound `>=0.85`.
5. **Hard opportunity recall:** point estimate `>=0.92`, Wilson lower bound
   `>=0.85`; yalnız emitted rows üzerinden hesaplanmaz.
6. **Calibration:** hard-known ECE hedef `<=0.03`, mutlak automation ceiling
   `<=0.05`; action/account bucket sample floor sağlanır.
7. **Unknown outcome:** closed-window episode'larda `<=5%`.
8. **Safety:** stale/missing target, mixed currency/account/goal ve paused/policy
   durumda provider-write ihlali `0`.
9. **Stability:** hard flip oranı raw adaya göre azalırken missed safety-exit `0`.
10. **Causal evidence:** treatment/action receipt + shadow holdout veya sınırlı
    controlled canary; provider sonucu ve rollback receipt eşleşir.

Bu kapılar için “bir hafta beklemek” çözüm değildir. Şimdi yapılabilecek iş,
immutable fact/treatment altyapısını kurmak ve mevcut raw history'yi dürüst coverage
sınırıyla backfill etmektir. Ancak geçmişte hiç kaydedilmemiş decision-time input
sonradan yaratılmış gibi gösterilemez.

## 11. En yüksek kaldıraçlı sonraki iş

**Tek en yüksek kaldıraçlı yatırım: immutable native ad-grain decision fact +
treatment ledger.** Her karar aşağıdakilere bağlanmalıdır:

```text
decision_id
engine_version
as_of_cutoff
provider_account_id / campaign_id / adset_id / ad_id / creative_id
optimization_goal / custom_event_type / country / currency
input_manifest_hash
target_pack_history_id
raw_decision / published_decision / authority_state
proposed_action / executed_action / idempotency_key
provider_receipt / operator_override
7d_and_14d_outcome_status
```

Bu olmadan daha fazla formül eklemek skoru 9.5'e yaklaştırmaz; yalnızca testli
karmaşıklığı artırır. Bu kurulduğunda hierarchical eşiklerin shadow challenger'ı
mevcut engine'e karşı aynı PIT girdilerle kıyaslanabilir.

## 12. Verification ve güvenlik sınırı

- Provider write yapılmadı.
- Manual `/api/sync/cron` POST yapılmadı.
- Canlı DB'ye write yapılmadı; tunnel yalnız read-only analiz için kullanıldı.
- Push, deploy ve production env değişikliği yapılmadı.
- Hedefli yeni regresyon testleri: `82/82` geçti.
- Full Vitest: **526 dosya geçti; 4,199 test geçti, 59 skipped, 61 todo**.
- TypeScript: `PASS`.
- ESLint: `PASS`.
- Migration-from-zero + idempotency + DB seam: `PASS`.
- `git diff --check`: `PASS`.

## 13. Sonuç

Karar motoru artık düşük frekansı tek başına fatigue saymıyor, minik funnel
sapmasını ekonomik gerçeğin önüne koymuyor, growth/loss sınırlarını birbirinden
uydurmuyor, mixed context'i rastgele execution'a bağlamıyor ve stale ticari
otoriteyi sürdürmüyor. Bunlar gerçek matematik ve güvenlik iyileştirmeleridir.

Fakat **9.5 iddiasına katılmıyorum**: bugün böyle bir puan vermek test kapsamını
gerçek-world doğrulukla karıştırmak olur. Doğru durum, **7.9 mühendislik hazırlığı,
5.5 kanıt tavanı, read-only CONTINUE ve auto-execution STOP_AND_FIX** şeklindedir.
9.5'e giden yol yeni sabit formül değil; native ad-grain PIT facts, action-specific
calibration ve treatment-backed ölçümdür.
