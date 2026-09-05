# Claude uygulaması — bağımsız inceleme

İncelenen HEAD: `8d5756c53`; başlangıç: `fc8a16b2845a8543f388188c76ccb6b4f3540c84`.
Referans: Claude planı `/Users/harmelek/.claude/plans/sa-ma-sapan-gereksiz-i-lerle-mutable-llama.md`, S1–S4 ve Ek A.

**Sonuç: KISMİ / tamamlanma kabulü verilmedi.** Gerekli üretim bağlantıları eksik ve gerçek işlem yollarında kontrol kusurları var. Bunlar yalnız deploy veya canlı hesap yapılandırması eksikleri değildir. Kaynak kod değiştirilmedi; bu dosya inceleme çıktısıdır.

## Öncelikli bulgular

1. **[P1] Prova modu, ortak kapasite ve read-only koşulları tüm gerçek işlem yollarında zorlanmıyor.** `resolveMetaWriteCapability` üretim kodunda yalnız tanımlı; çağrısı yok. Manuel entity route'u `dryRun` değerini yalnız istek gövdesinden alıyor; yeni Launchpad aktivasyonu resume primitiflerine dry-run seçeneği göndermiyor. Mevcut `getMetaWriteBlockState` global/işletme STOP ve kuralları kontrol ediyor, fakat `META_AUTOMATION_LIVE_WRITES`, `guardrails.dryRunOnly` veya `readiness_tier` denetimini yapmıyor. Geçerli operatör isteğinde STOP kapalı, prova açıkken gerçek provider POST'una ulaşılabilir. Ortak kontrol sunucu girişine ve son POST sınırına bağlanmalı; prova sunucuda zorlanmalı.
   Kanıt: [entity-action-routes.ts:691](/Users/harmelek/Adsecute/lib/meta/entity-action-routes.ts:691), [launch-intent-activation.ts:183](/Users/harmelek/Adsecute/lib/meta/launch-intent-activation.ts:183), [automation-control-plane.ts:1897](/Users/harmelek/Adsecute/lib/meta/automation-control-plane.ts:1897).

2. **[P1] Bütçe/bid kaynak sorgusu gerçek şemayla uyuşmuyor.** `meta_campaign_config_history` ve ad-set karşılığından `budget_owner_mode`, `budget_raw_minor_units`, `budget_field`, `changed_at` okunuyor; migration şemasında bunların yerine `daily_budget`, `lifetime_budget`, `captured_at` gibi alanlar var. Ek bid sorgusu da `meta_adset_daily.bid_amount` istiyor; gerçek alanlar `bid_value`/`bid_value_format`. İlk SQL hatası null'a çevriliyor, snapshot eski önerileri aynen döndürüyor. Sonuç: politikalar uygun olsa bile gerçek kaynak üzerinden tipli miktar üretimi çalışmaz. Sorgular gerçek retained sözleşmeye bağlanmalı ve izole, migration uygulanmış DB üzerinde çalıştırılmalı.
   Kanıt: [intent-projection-context.ts:89](/Users/harmelek/Adsecute/lib/meta/intent-projection-context.ts:89), [migrations.ts:9423](/Users/harmelek/Adsecute/lib/migrations.ts:9423), [snapshot.ts:929](/Users/harmelek/Adsecute/lib/meta/snapshot.ts:929).

3. **[P1] Shopify AOV okuyucusu üretime bağlanmamış.** `resolveObservedShopifyAov` için üretim çağrısı yok. Native builder çağrısı yeni kanıt girdisini vermiyor; yapı tarafının miktar hesabı hâlâ yalnız ayarlanmış CPA veya manuel AOV varsayımını kullanıyor. Maturity hesabına da türetilmiş ölçüt taşınmıyor. Dolayısıyla yalnız hedef ROAS ve Shopify verisi olan işletmenin planlanan uçtan uca davranışı tamamlanmamış. AOV $58 / ROAS 2,2 = $26,36 örneği gerçek snapshot üretiminden başlayarak doğrulanmalı.
   Kanıt: [shopify-aov-source.ts:205](/Users/harmelek/Adsecute/lib/creative-decision-engine/shopify-aov-source.ts:205), [ad-calibration-job.ts:2142](/Users/harmelek/Adsecute/lib/creative-decision-engine/jobs/ad-calibration-job.ts:2142), [snapshot.ts:849](/Users/harmelek/Adsecute/lib/meta/snapshot.ts:849).

4. **[P1] S3'ün gerekli otomatik/yarı otomatik işlem aileleri eksik.** Sweep yalnız budget/pause/resume ve campaign/adset kabul ediyor. Bid kuyruk zarfı ve kreatif launch kuyruk üreticisi yok; native ad otomatik yürütme açıkça dışlanmış. `activation_approval_json` için migration ve okuyucu var, yazıcı yok. Bunlar güvenli biçimde kapalı tutulmuş olsa da uygulama tamamlanmış sayılmaz.
   Kanıt: [budget-automation-scheduled.ts:66](/Users/harmelek/Adsecute/lib/meta/budget-automation-scheduled.ts:66), [budget-automation-scheduled.ts:358](/Users/harmelek/Adsecute/lib/meta/budget-automation-scheduled.ts:358), [automation-proposal-execution.ts:165](/Users/harmelek/Adsecute/lib/meta/automation-proposal-execution.ts:165).

5. **[P1] Günlük otomatik işlem sınırı duraklatmaları saymıyor.** Hem sweep ön sayımı hem kilitli claim sorgusu yalnız `proposed_action='budget'` sayıyor; aynı sweep pause/resume de çalıştırıyor. Günlük limit 3 olsa bile sonraki tick önceki 3 pause'u saymayıp 3 yeni pause daha yapabilir. Tüm ilgili otomatik işlem aileleri ve bekleyen/belirsiz rezervasyonlar aynı atomik sayımda yer almalı.
   Kanıt: [automation-proposals.ts:1455](/Users/harmelek/Adsecute/lib/meta/automation-proposals.ts:1455), [budget-automation-scheduled.ts:303](/Users/harmelek/Adsecute/lib/meta/budget-automation-scheduled.ts:303).

6. **[P1] Aktivasyonun kalıcı işlem ve belirsiz sonuç kaydı yok.** Yeni yol resume primitiflerini doğrudan çağırıyor; claim, adım başına journal ve durable reconcile bağlantısı yok. Route bellekteki sonucu döndürüyor. Kampanya açıldıktan sonra ad-set başarısız olduğunda History/intent içinde kalıcı aktivasyon fişi oluşmuyor. Belirsiz sonuç da kalıcı beklemeye alınmadığından sonraki istek yanlışlıkla aynı adımı tekrar gönderebilir. Mevcut claim/journal/reconcile yaşam döngüsü bu yola bağlanmalı.
   Kanıt: [launch-intent-activation.ts:183](/Users/harmelek/Adsecute/lib/meta/launch-intent-activation.ts:183), [activate/route.ts:150](/Users/harmelek/Adsecute/app/api/launchpad/meta/intents/[intentId]/activate/route.ts:150).

7. **[P1] Bid artışı için gerekli teslimat kanıtı hiç üretilmiyor.** Snapshot `deliveryConstrainedAdsetIds` değerini koşulsuz boş küme veriyor. Bid politikası her artışta bu kanıtı istediği için, diğer bağlantılar düzelse bile uygun cap artışları üretilemez. A2'deki $12 → $13,20 örneği gerçek snapshot akışında test edilmeli.
   Kanıt: [snapshot.ts:921](/Users/harmelek/Adsecute/lib/meta/snapshot.ts:921), [bid-sizing-policy.ts:206](/Users/harmelek/Adsecute/lib/meta/bid-sizing-policy.ts:206).

## Zamanlama ve veri doğruluğu

8. **[P2] Başarısız 15:00 koşusu sabah satırlarıyla başarılı işaretlenebilir.** Slot kaydı bu koşunun hesap bazlı sonucundan değil, aynı günün bütün snapshot satırlarından çıkarılıyor. 03:00 başarılı, 15:00 başarısız hesapta sabah satırları 15:00 başarısı sayılıp retry engellenir. Ayrıca üretici yalnız eksik çiftleri değil bütün hesapları tekrar çalıştırıyor.
   Kanıt: [scheduled.ts:216](/Users/harmelek/Adsecute/lib/meta/scheduled.ts:216), [scheduled.ts:250](/Users/harmelek/Adsecute/lib/meta/scheduled.ts:250).

9. **[P2] Native reklam önerileri üretilmeden kuyruğa aktarılmaya çalışılıyor.** Kuyruk projeksiyonu yalnız yapı snapshot'ında çağrılıyor; cron native reklam zincirini bunun ardından çalıştırıyor. Yeni native kararlar üretildiğinde aynı slotun yapı işi tamamlanmış oluyor. Sabah kararları o slotta kuyruğa girmez; öğleden sonra eski sabah kararları görülüp yeni öğleden sonra kararları yine atlanabilir. Projeksiyon başarılı native yayından sonra çalışmalı ve kısmi hesap tekrarlarını kapsamalı.
   Kanıt: [snapshot.ts:1617](/Users/harmelek/Adsecute/lib/meta/snapshot.ts:1617), [cron/route.ts:640](/Users/harmelek/Adsecute/app/api/sync/cron/route.ts:640), [cron/route.ts:699](/Users/harmelek/Adsecute/app/api/sync/cron/route.ts:699).

10. **[P2] Shopify okuyucusunda tazelik ve mağaza kapsamı yanlış.** 48 saatlik sync tazeliği `MAX(order_created_at)` ile ölçülüyor; son satış tarihi başarılı senkronizasyon tarihi değildir. Bugün sync olmuş, 28 günde 40 siparişi bulunan fakat son 3 günde satışı olmayan mağaza yanlışlıkla stale olur. Para birimi ve zaman sorguları yalnız business filtreli; gelir sorgusu ise seçili mağaza filtreli. İkinci mağazanın para birimi/tarihi seçili mağazanın kanıtını kirletebilir. Başarılı tam sync ayrı okunmalı, bütün kanıt okuyucuları seçili Shopify hesabıyla sınırlandırılmalı.
    Kanıt: [shopify-aov-source.ts:145](/Users/harmelek/Adsecute/lib/creative-decision-engine/shopify-aov-source.ts:145), [shopify-aov-source.ts:170](/Users/harmelek/Adsecute/lib/creative-decision-engine/shopify-aov-source.ts:170), [shopify-aov-source.ts:285](/Users/harmelek/Adsecute/lib/creative-decision-engine/shopify-aov-source.ts:285).

## Doğrulama ve sınırlar

- Bağımsız inceleme sırasında **13 odaklı test dosyasında 218 test geçti**: ekonomik kaynak/boyutlandırma 64, aktivasyon 37, route/kontrol/UI 117. DB/provider bağımlılıkları mock veya enjekte okuyucuydu; gerçek sağlayıcı yazması yapılmadı.
- İlk kök test çalıştırmasındaki global kill-switch override'ı quiet-hours testlerinin daha erken durmasına neden oldu. Yalnız etkilenen 15 test uygun süreç ayarıyla tekrar çalıştırıldı ve geçti; bu ilk ortam çakışması ürün kusuru olarak raporlanmadı.
- Yeşil testler yukarıdaki bağlantıları kanıtlamıyor: SQL testleri var olmayan sütunları içeren hazır mock satırlar döndürüyor; Shopify testleri üretim okuyucularını atlıyor.
- Claude'un 17.145 test, typecheck/lint ve migration iddiaları bu incelemede baştan bütünüyle tekrarlanmadı. Raporladığı dört genel suite başarısızlığı için yeni bir neden ataması yapılmadı.
- `verify-mounted-bodies` import grafiği kontrolüdür; gerçek masaüstü/mobil etkileşim testi değildir. Claude 1280/390 px akış doğrulamasını yapmadığını açıkça bildirdi. Bu kabul maddesi eksik; üretime bağlı `.env.local` bulunması izole yerel fixture doğrulamasını kapsam dışına çıkarmaz.
- Canlı deploy, production DB, gerçek Meta/Shopify hesapları ve sağlayıcı sonuçları bu incelemede test edilmedi. Kaynak çalışma ağacı inceleme öncesinde temizdi.

**Düzeltme sırası:** önce gerçek yazma kontrolleri ve kalıcı yürütme/sayaç; ardından gerçek şemaya ve Shopify kanıtına bağlantı; eksik S3 aileleri; slot/projeksiyon sırası; sonra izole DB ve gerçek mounted UI üzerinden uçtan uca kabul. Yeni planlama veya kapsam genişletme gerekmiyor.
