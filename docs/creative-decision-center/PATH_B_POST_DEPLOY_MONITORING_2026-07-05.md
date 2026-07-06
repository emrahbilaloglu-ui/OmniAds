# Adsecute Creative Decision Center - Path B Post-Deploy Monitoring

Tarih: 2026-07-05

Durum: `CONTINUE`

Kapsam: Path B merge/deploy sonrasi gun-1 ve gun-2 pasif izleme.

Canli yazim: manuel cron yok, provider yazimi yok, migration yok. DB kontrolleri read-only tunnel uzerinden yapildi.

## 1. Nihai Karar

Zincir acik kalmali. 2026-07-05 itibariyla production runtime, producer chain, snapshot mutabakati, outcome job'lari ve change-event zinciri icin kill-switch'i tekrar kapatmayi gerektiren kanit yok.

Bu karar formullerin dogrulugunu kanitlamaz. Sadece Path B'nin deploy sonrasi veri biriktirme hattinin temiz calistigini ve 7 gunluk current-version outcome penceresine kadar zincirin acik kalabilecegini soyler.

Claude Desktop'taki gorunur `Adsecute Creative Decision audit` chat'inden faz sonu review alindi. Claude karari `CONTINUE` ve ek notu: anomali yoksa 2026-07-09'a kadar her gun Claude review istemek gerekli degil; Codex pasif read-only izleyecek, Claude review yalniz anomali veya 2026-07-10 checkpoint kapisinda gerekecek.

## 2. Kanit Siniri

Kanitlar:

- Repo: `/Users/harmelek/Adsecute`, branch `main...origin/main`, calisma agaci temiz.
- Runtime tarihi: 2026-07-05 18:30 UTC civari.
- Production web/worker SSH ve Docker Compose uzerinden kontrol edildi.
- Public build endpoint: `https://adsecute.com/api/build-info`.
- Production DB: acik SSH tunnel uzerinden, read-only sorgularla kontrol edildi.
- Manuel olarak `/api/sync/cron` cagrilmadi.

Kanit disinda kalanlar:

- Current-version snapshot outcome dogrulugu henuz beklenmez. Ilk 7 gunluk pencere yaklasik 2026-07-10'da anlamli hale gelecek.
- Formula precision/recall/ECE karari bu raporun konusu degil.
- `npm run test:local-db` borcu kapanmis sayilmaz; canli production tunnel uzerinde destructive DB test calistirmak reddedildi.

## 3. Runtime ve Build Kapisi

Production runtime temiz:

| Kontrol | Sonuc |
|---|---|
| Web container | healthy |
| Worker container | healthy |
| Autoheal | healthy |
| Web image | `ghcr.io/erhanrdn/omniads-web:6b0a30df42130bef12d4bc67247649765601164a` |
| Worker image | `ghcr.io/erhanrdn/omniads-worker:6b0a30df42130bef12d4bc67247649765601164a` |
| `APP_BUILD_ID` | `6b0a30df42130bef12d4bc67247649765601164a` |
| `DECISION_ENGINE_V3_JOBS_DISABLED` | `0` |
| `/api/build-info` buildId | `6b0a30df42130bef12d4bc67247649765601164a` |
| deployGate / releaseGate | pass / pass |
| runtimeRegistry issues | `[]` |
| DB/config fingerprint | match / match |

Non-blocking not: Docker Compose halen `DEPLOY_MIGRATION_TIMEOUT_MS` degiskeni set edilmemis uyarisi veriyor. Bu bugunku chain icin bozulma uretmedi, fakat ops borcu olarak kapanmali.

## 4. Producer ve Outcome Kronolojisi

Engine version: `v3-2026-07-02-math-guardrails`.

### 2026-07-04 gun-1 ozeti

| Is | Durum | Kosu | Satir |
|---|---:|---:|---:|
| calibration | success | 14 | 405 |
| lifecycle | success | 14 | 1633 |
| decisions | success | 14 | 1569 |
| outcomes | success | 13 | 2444 |

Gun-1 ek kanitlari:

- Failed/stuck row yok.
- `pruned_snapshot_count=0` ve `pruned_event_count=0`.
- Change-event sayisi 32; snapshot linkleri kopuk degil.
- 2444 outcome satiri tarihsel v1/older outcome envanterinin classifier v2 ile ilk tam yeniden siniflandirilmasi olarak beklenen hacimdi.

### 2026-07-05 gun-2 ozeti

| Is | Durum | Kosu | Satir | Ilk baslangic | Son bitis | Max sure |
|---|---:|---:|---:|---:|---:|---:|
| calibration | success | 14 | 415 | 03:03:19Z | 03:04:27Z | 5289ms |
| lifecycle | success | 14 | 1651 | 03:03:24Z | 03:04:27Z | 6117ms |
| decisions | success | 14 | 1590 | 03:03:29Z | 03:04:27Z | 2026ms |
| outcomes | success | 13 | 1855 | 04:00:42Z | 04:00:42Z | 303ms |

Gun-2 ek kanitlari:

- Failed/running/stuck row yok.
- Tum current producer business'larda calibration + lifecycle + decisions success.
- `pruned_snapshot_count=0` ve `pruned_event_count=0`.
- Decisions job'larindaki toplam `change_event_count=47`; `engine_v3_decision_events` gunluk sayisi da 47. Kopuk `snapshot_id` yok.

## 5. Snapshot ve Lifecycle Mutabakati

Gun-2 exact veya bos mutabakat:

| Business | Lifecycle | Snapshot | Not |
|---|---:|---:|---|
| Adsecute Demo | 0 | 0 | Bos decision evreni |
| Bilsem Zeka | 90 | 90 | Exact |
| BskTR | 37 | 37 | Exact |
| ColorFullWorldsTR | 50 | 50 | Exact |
| EMOLOS | 277 | 277 | Exact |
| Enise | 0 | 0 | Bos decision evreni |
| Grandmix | 190 | 190 | Exact |
| Halicizade | 165 | 165 | Exact |
| Silveristic | 48 | 48 | Exact |
| Vornom | 49 | 49 | Exact |

Tum business'larda `snapshots_missing_lifecycle_id=0`.

Bilinen istisnalar ve bugunku karar:

| Sinif | Kanit | Karar |
|---|---|---|
| TheSwaf carry-over | lifecycle 283, snapshot 284; +1 snapshot same-day lifecycle disinda ama `lifecycle_row_id` mevcut, linked lifecycle 2026-07-02, label `test_more`, confidence 65, eligible=false, campaign paused, zero spend/purchases | Bilinen +1 sinifi; blocker degil |
| Tiles stale-disarida kalma | lifecycle 207, snapshot 142; 65 lifecycle-without-snapshot satirinin tamami eligible=false, insufficient_history, freshness 375h, stale/source_max_date 2026-06-19 local | Bilinen guvenli yon; blocker degil |
| IwaStore carry-over | lifecycle 154, snapshot 155; +1, linked lifecycle 2026-07-04, label `test_more`, confidence 75, eligible=false, campaign paused, zero spend/purchases | Yeni ama TheSwaf sinifiyla ayni mekanik; tek hane oldugu surece blocker degil |
| IwaTR carry-over | lifecycle 101, snapshot 103; +2, linked lifecycle 2026-07-04, label `test_more`, confidence 40, eligible=false, paused, zero spend/purchases | Yeni ama orphan degil; tek hane oldugu surece blocker degil |

Izleme siniri:

- TheSwaf/Iwa carry-over sinifi tek haneli kalmali.
- Ayni creative yaklasik 3 gunden uzun ayni carry-over sinifinda kalirsa anomali sayilmali.
- Bu sinif trend halinde buyurse veya `lifecycle_row_id` kopuk satir uretirse `HOLD/RE-CLOSE` kapisi acilir.
- Tiles sinifi ayni sekilde stable/stale-disarida kalma olarak kalmali; buyume veya taze aktif creative'e yayilma anomali olur.
- Claude review'un somut gun-3 notu: TheSwaf creative `1241793714589639`, 2026-07-03/04/05 boyunca 2026-07-02 lifecycle satirina bagli carry-over sinifinda gorunuyorsa, 2026-07-06 sabah kontrolunde ya 72h hydration/stale dislama mekanigiyle snapshot evreninden cikmali ya da taze lifecycle ile rehydrate olmali. Ayni eski lifecycle'a bagli kalmaya devam ederse bu raporun 3-gun carry-over esigini tetikler.

## 6. Outcome Yorumu ve Duzeltme

Gun-1 outcome hacmi dogru yorum:

```text
Grandmix: 244
IwaStore: 1452
TheSwaf: 748
Toplam: 2444
```

Bu, tarihsel v1/older outcome envanterinin classifier v2 ile ilk tam yeniden siniflandirilmasiydi.

Gun-2 outcome hacmi icin onemli duzeltme:

Ilk Codex yorumu 1855 satiri "tarihsel yeniden siniflandirmanin ikinci dalgasi" gibi okumaya yatkindi. Bu eksik bir yorumdu. Claude review hakli olarak daha iyi acikladi: 2026-07-05'teki 1855 satir, v2'ye cevrilmis satirlarin tekrar secilmesi degil; `realized_outcome='unknown'` kalan tarihsel satirlarin outcome job eligibility OR kosulu nedeniyle gunluk idempotent yeniden degerlendirme churn'udur.

Matematik:

```text
Grandmix: 178 / 244 = 72.95% ~= baseline unknown share 73.0%
IwaStore: 1185 / 1452 = 81.61% ~= baseline unknown share 81-82%
TheSwaf: 492 / 748 = 65.78% ~= baseline unknown share 65.8-66.0%
Toplam: 178 + 1185 + 492 = 1855
```

Sonuc:

- Bu churn operasyonel olarak su an blocker degil; outcome job max sure 303ms.
- Dogruluk etkisi beklenmez; yazim idempotent.
- Fakat olcum fazi icin rafine edilmesi gereken teknik borctur. Nihai verisi artik degismeyecek `unknown` satirlarin her gun tekrar yazilmasi anlamsiz is yuku ve metrik gurultusudur.
- Gun-3'te yaklasik 1855 outcome satiri veya yavas azalan bir hacim gorulurse bu hipotezle uyumludur. Azalma iki nedenle normal olabilir: nadir de olsa bir `unknown` satirin `known` hale gelmesi veya eski kohortlarin 120 gunluk lookback'ten yaslanarak cikmasi. 2026-05-04 kohortu yaklasik 2026-09-01'de, 2026-05-25 kohortu yaklasik 2026-09-22'de hacimden dusmeye baslar. Buna karsilik hacmin belirgin buyumesi veya unknown-churn modeliyle aciklanamayan yon degisikligi anomali sayilmali.

Current-version outcome beklentisi:

- `decision_as_of_date >= 2026-07-03` ve current engine icin outcome satiri bugun 0.
- Bu beklenen durumdur. Ilk anlamli 7 gunluk current-version outcome penceresi yaklasik 2026-07-10'da acilir.

## 7. Change-Event ve Flapping Izleme

2026-07-05 change-event ozeti:

- Event sayisi: 47.
- Missing snapshot link: 0.
- Ornek gecisler: `keep -> cut`, `diagnose -> test_more`, `test_more -> diagnose`, `scale -> keep`.

Iki gunluk repeat-flip taban cizgisi:

- 2026-07-04 ile 2026-07-05 arasinda 8 creative tekrar-flip adayi goruldu.
- Bu adaylarda tekrar eden hard `keep <-> cut` veya `scale <-> keep` flip-flop yok.
- Bu, recovery-guard flapping riskinin bugun blocker olmadigini gosterir.

Izleme siniri:

- Ayni creative'in 3 veya daha fazla ardisk gun hard etiketlerde gidip gelmesi anomali sayilmali.
- Tek gunluk label degisimi tek basina blocker degil; creative karar sistemi yeni current-version veri biriktirirken bu beklenen churn sinifina girebilir.

## 8. EMOLOS Durumu

EMOLOS gun-2 snapshot dagilimi:

| Label | Satir |
|---|---:|
| diagnose | 18 |
| keep | 4 |
| test_more | 255 |
| hard cut/scale | 0 |

EMOLOS icin problem deploy/runtime degil. Kampanya etiketleme aksiyonu yapilmadikca hard action guard maliyeti gorunur kalacak. Bu bilincli olarak otomatik cozulmemeli; kullanici/operator aksiyonu gerektiriyor.

## 9. Non-Blocking Borclar

Bu maddeler bugun zinciri kapatmaz, fakat hardening sonrasi sahiplenilmeli:

- `DEPLOY_MIGRATION_TIMEOUT_MS` Compose uyarisi.
- Adsecute Demo'nun producer kapsaminda gorunup outcomes kapsaminda `is_demo` filtresiyle disarida kalmasi; kozmetik kapsam uyumsuzlugu.
- `unknown` historical outcome churn'unun olcum fazinda azaltilmasi.
- Env-drift pipeline ve release-authority islerinin netlestirilmesi.
- Izole/staging DB veya guncel `/Volumes/adsecuteDB` ile `npm run test:local-db` borcunun kapatilmasi.
- EMOLOS kampanya etiketleme aksiyonu.

## 10. Devam Kapilari

2026-07-06 ile 2026-07-09 arasi sessiz izleme:

- Her gun pasif read-only kontrol.
- Manuel cron yok.
- Claude review sadece anomali varsa.
- Kontrol seti:
  - web/worker healthy,
  - buildId ve `APP_BUILD_ID` ayni,
  - `DECISION_ENGINE_V3_JOBS_DISABLED=0`,
  - 14/14 producer success,
  - failed/stuck/running yok,
  - `pruned_snapshot_count=0`,
  - `snapshots_missing_lifecycle_id=0`,
  - carry-over sinifi tek hane ve rotasyonlu,
  - TheSwaf `1241793714589639` carry-over creative'i 2026-07-06'da ya kaybolmus/rehydrate olmus,
  - Tiles stale-disarida kalma sinifi buyumuyor,
  - repeat hard flip eşiği asilmiyor,
  - outcomes hacmi unknown-churn modeliyle uyumlu: yaklasik 1855 veya yavas azalma normal, belirgin buyume anomali.

2026-07-10 checkpoint:

- Ilk current-version 7d outcome penceresi kontrol edilecek.
- Phase 1 checkpoint tekrar kosulacak.
- EMOLOS snapshot/briefing mutabakati tekrar kontrol edilecek.
- Current-version F1/F2 re-sweep yapilacak.
- Ancak bundan sonra account-level formule/parametre tartismasi yeniden acilmali.

## 11. HOLD / RE-CLOSE Esikleri

Asagidakilerden biri gorulurse zincir acik birakilmamali:

- Production web/worker build mismatch.
- `DECISION_ENGINE_V3_JOBS_DISABLED` beklenmedik sekilde `1` veya runtime drift.
- Failed/stuck/running job.
- Aciklanamayan `pruned_snapshot_count > 0`.
- `snapshots_missing_lifecycle_id > 0`.
- Bilsem-sinifi orphan snapshot tekrar ortaya cikmasi.
- TheSwaf/Iwa carry-over sinifinin tek haneden cikmasi veya ayni creative'in 3 gunden uzun takili kalmasi.
- TheSwaf `1241793714589639` creative'inin 2026-07-06'da halen 2026-07-02 lifecycle satirina bagli carry-over olarak kalmasi.
- Tiles stale-disarida kalma sinifinin taze/aktif creative'lere yayilmasi.
- Ayni creative'de 3+ ardisk gun hard label flip-flop.
- Outcomes hacminin unknown-churn modelinden belirgin sapmasi; yavas azalma model-uyumlu, belirgin buyume anomali olarak okunmali.

## 12. Ortak Faz Karari

Codex karari: `CONTINUE`.

Claude review karari: `CONTINUE`.

Ortak karar: Zincir acik kalir; gunluk pasif izleme devam eder. Anomali yoksa sonraki buyuk kapı 2026-07-10 current-version 7d outcome checkpoint'idir.
