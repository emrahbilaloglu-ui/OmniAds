# Adsecute Creative Decision Center - Kullanıcı Onay Paketi

Tarih: 2026-07-02
Durum: Onay bekliyor
Karar: Merge/deploy yok. Formül değişikliği yok. Kullanıcı onayı olmadan canlıya alma yok.

## 1. Bu Paket Canlıya Ne Sokar?

Bu paket, Creative Decision Center karar üretim hattını canlıda veri biriktirecek hale getirir. Ama cut/scale eşiklerini değiştirmez.

Canlıya girecek ana parçalar:

- Günlük karar snapshot zinciri: calibration -> lifecycle -> decisions.
- Scheduler/producer chain: günlük 03:00+ UTC penceresinde kaçan günleri yakalama mantığı.
- Engine version damgası: `v3-2026-07-02-math-guardrails`.
- Guard iyileştirmeleri:
  - toparlanan creative'i erken kesmeye karşı recovery hold,
  - freshness bilinmiyorsa yüksek güvenli karar vermeme,
  - freshness bilinmeyen veride scale bloğu,
  - funnel fresh-proof gerekliliği,
  - kampanyasız/no-campaign hard aksiyon kapatma,
  - business-level safety guard.
- Severity/outcome sınıflandırma v2 ve eski `unknown` outcome'ların yeniden sınıflandırılabilir hale gelmesi.
- Briefing tarafında karar tazeliği/freshness alanları.
- F1/F2 read-only cut-threshold sweep raporu ve v2 revizyon izi.

## 2. Değişmeyenler

- Cut/scale formülleri ve eşikleri değişmiyor.
- Meta/Google/provider tarafına yazma yok.
- Otomatik platform aksiyonu açılmıyor.
- UI karar dili bu paketle genişletilmiyor.
- Account-level F1/F2 parametreleri uygulanmıyor.
- `decision_calibration_profiles` üzerinden yeni formül parametresi set edilmiyor.

## 3. Doğrulama Durumu

Geçen kapılar:

- `npm test` -> geçti: 454 test dosyası geçti, 4 skipped; 3419 test geçti, 53 skipped, 57 todo.
- `npm run typecheck` -> geçti.
- `npx eslint scripts/creative-decision-center/f1-f2-cut-threshold-sweep.ts scripts/creative-decision-center/phase1-outcome-baseline-checkpoint.ts` -> geçti.
- `git diff --check` -> geçti.
- Canlı DB tunnel read-only probe -> geçti:
  - database: `adsecute_prod`
  - user: `adsecute_app`
  - business count: 14
  - işlem `BEGIN READ ONLY` / `ROLLBACK` içinde yapıldı.
- `localhost:3000/api/build-info` -> yanıt verdi: `buildId=dev-build`, `nodeEnv=development`.
- Tunnel env ile read-only raporlar tekrar üretildi:
  - Phase 1 checkpoint -> geçti.
  - F1/F2 sweep v2 -> geçti.

Kapanmayan kapı:

- `npm run test:local-db` çalışmadı.
- Sebep: script `/Volumes/adsecuteDB` mount edilmiş, izole lokal Postgres data directory bekliyor.
- Canlı tunnel üstünde DB-enabled vitest koşturulmadı. Bunu bilerek reddettim; çünkü bazı DB testleri gerçek TheSwaf/IwaStore business id'leri için `engine_v3_*` tablolarda DELETE/INSERT yapıyor. Bu testleri `adsecute_prod` üzerinde çalıştırmak güvenli değil.
- Bu borç kapanmış sayılmıyor. Path B kapıyı telafi eder, kapatmaz. `/Volumes/adsecuteDB` snapshot'u yenilendiğinde veya izole/staging hedef hazır olduğunda `test:local-db` ayrıca koşulmalı.
- Kalıcı sınır: read-only doğrulama canlı tunnel kullanabilir; destructive/entegrasyon testleri canlı production tunnel üzerinde çalıştırılmaz.

## 4. Deploy Kapısı İçin Seçilen Yol

Seçilen yol: Path B - kill-switch açık, gözetimli ilk koşu.

Path A, yani izole lokal/staging Postgres'te `test:local-db` koşmak tercih edilen yol olurdu. Fakat mevcut `test:local-db` akışı boş ephemeral DB ile eşdeğer değil; pre-populated local Postgres datası bekliyor. Bu yüzden kısa vadede doğru kontrol, production yazımını test olarak değil, kontrollü/aşamalı ilk gerçek koşu olarak yapmak.

Bu onay sadece "merge et" anlamına gelmez. Onay kapsamı şudur:

- merge,
- deploy,
- kill-switch açık halde gözetimli tek-işletme production koşusu,
- kontroller temizse zincir anahtarını açma.

Deploy onayı verilirse uygulanacak güvenli sıra:

1. Deploy `DECISION_ENGINE_V3_JOBS_DISABLED=1` ile yapılacak.
2. Bu halde guard/freshness/briefing davranış değişiklikleri canlıya girer, ama producer chain hiçbir şey yazmaz.
3. İlk gözetimli chain koşusu TheSwaf için yapılacak.
4. Bu koşu lokal tunnel/dev env üzerinden değil, sunucu üzerinde production env ile yapılacak.
5. `engine_v3_job_runs`, snapshot satırları ve chain sonucu kontrol edilecek.
6. Failed run varsa zincir açılmayacak; rollback/kill-switch açık kalacak.
7. Kontrol temizse zincir anahtarı açılacak.
8. İlk zamanlanmış tick ve 1-2 gün gözlemleri takip edilecek.

Gözetimli TheSwaf koşusu sonrası zorunlu kontroller:

- `engine_v3_job_runs`: calibration/lifecycle/decisions için `success` satırları.
- Yeni engine version damgası: `v3-2026-07-02-math-guardrails`.
- Makul duration.
- `error_json` boş.
- Takılı `running` satırı yok.
- `engine_v3_decision_snapshots_daily`: TheSwaf için satır sayısı > 0.
- TheSwaf briefing canlı sayısı ile snapshot sayısı mutabık.
- Snapshot label dağılımı phase0 replay wall-clock dağılımından büyük sapma göstermiyor.

Anahtar açıldıktan sonra ilk scheduled tick kontrolü:

- 03:00+ UTC sonrası cron tick'inde tüm enabled işletmeler için chain sonuçları cron yanıtında görünmeli.
- EMOLOS gerçek UUID dahil edilmeli: `a7fd8563-8c9a-497a-b0d7-fd65e4248d1f`.
- Failed run olmamalı.

2. gün outcome gözlemi:

- Yeni snapshot'lar için pencere henüz kapanmayacağı için yeni outcome beklenmemesi normaldir.
- Asıl gözlemlenecek sinyal: eski `unknown`/v1 outcome satırlarının classifier v2 ile yeniden sınıflandırılması.

Playwright smoke bu read-only doğrulama paketinin parçası değildir. Smoke setup app DB'ye reviewer/commercial smoke kullanıcıları yazar; bu yüzden deploy/post-deploy kapsamına alınır ve canlı yazma içerdiği açık kabul edilir.

Gözetimli TheSwaf koşusu, ilk scheduled tick ve 2. gün outcome gözlemleri kısa bir post-deploy raporuna kaydedilecek. Her aşamanın çıktısı olmadan zincir "tam açıldı" kabul edilmeyecek.

## 5. Rollback Kolları

- `DECISION_ENGINE_V3_JOBS_DISABLED=1`: Creative Decision producer/outcome job yazımları durur.
- `DECISION_CENTER_DEFAULT_DISABLED=1` veya `?decisionCenter=0`: Decision Center yüzeyi kapatılabilir.
- `DECISION_ENGINE_V3_ENABLED=false`: motor genel olarak kapatılabilir.
- `business_engine_v3_flags`: işletme bazlı kapatma/override yapılabilir.

Job'lar idempotent olacak şekilde tasarlanmıştır: advisory lock ve natural-key upsert kullanılır. Yarım kalan koşu tekrar denenebilir. Buna rağmen herhangi bir aşamada beklenmeyen failed/running durum görülürse `DECISION_ENGINE_V3_JOBS_DISABLED=1` geri konur ve zincir açılmaz.

## 6. Bilinen 1. Gün Etkisi

Engine version bump sonrası lifecycle verisi ilk gün runtime fallback'e düşebilir. Bu, karar kalitesinin o gün lifecycle sinyali olmadan çalışması anlamına gelir. Snapshot birikince kendini toparlaması beklenir.

Bu yüzden deploy sonrası ilk gün şu kontroller zorunlu:

- TheSwaf, IwaStore, Grandmix ve EMOLOS için `engine_v3_job_runs` success satırları.
- EMOLOS gerçek business id: `a7fd8563-8c9a-497a-b0d7-fd65e4248d1f`.
- Snapshot satırlarının oluşması.
- Cron/chain sonucunda failed run olmaması.
- İlk 04:00 UTC koşusunda eski `unknown` outcome'ların classifier v2 ile yeniden sınıflandırıldığının görülmesi.

## 7. EMOLOS Operatör Aksiyonu

EMOLOS'ta harcama yapan kampanyalar etiketlenmeli.

Bu deploy'dan bağımsızdır ve şimdi yapılabilir. Yapılmazsa EMOLOS, deploy sonrasında da hard action üretmekte kısıtlı kalır; çünkü campaign label guard gerçek yüzeyde hard aksiyonları bloke eder.

## 8. Accrual Planı

- En az 7 gün current-version veri birikecek.
- Sonra Phase 1 checkpoint yeniden koşulacak.
- EMOLOS snapshot ve briefing mutabakatı kontrol edilecek.
- Sonra current-version F1/F2 re-sweep yapılacak.
- Ancak bu noktadan sonra account-level formül/parametre önerisi tartışılacak.

## 9. Onay Kararı

Onay verirsen uygulanacak karar:

- Formül değişikliği yok.
- Önce merge/deploy hazırlığı.
- Deploy kill-switch açık yapılır.
- Gözetimli tek-işletme ilk chain koşusu yapılır.
- Kontroller temizse zincir açılır.
- 7+ gün accrual sonrası tekrar analiz edilir.

Onay verilmezse:

- Merge/deploy yapılmaz.
- Mevcut read-only raporlar karar girdisi olarak kalır.
- İzole local/staging Postgres kapısı için ayrı tooling işi açılır.
