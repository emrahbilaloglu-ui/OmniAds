# Adsecute Creative Decision Center - Path B + D033 Monitoring

Tarih: 2026-07-06

Durum: `CONTINUE`

Kapsam: Path B gun-3 pasif izleme + D033 Automatic Campaign Context deploy day-0 kontrolu.

Canli yazim: manuel cron yok, provider yazimi yok, DB write yok. D033 deploy sonrasi tek yeni write yuzeyi olan `engine_v3_campaign_context_daily` tablosu sadece scheduled producer tarafindan dolacak; bu rapordaki DB kontrolleri read-only tunnel uzerinden yapildi.

## 1. Nihai Karar

Zincir acik kalmali. 2026-07-06 itibariyla production runtime, producer chain, snapshot/lifecycle mutabakati, outcome job'lari ve decision change-event zinciri icin kill-switch'i tekrar kapatmayi gerektiren kanit yok.

D033 Automatic Campaign Context deploy edildi, ancak karar semantigi hala davranis-notr modda: `CAMPAIGN_CONTEXT_MODE` prod ortaminda set degil, default `legacy_labels`; `ENGINE_VERSION` bump edilmedi. Bu nedenle bugunku deploy otomatik campaign context verisini hazirlar, fakat motoru henuz automatic mode'a gecirmez.

Claude Desktop'taki gorunur `Adsecute Creative Decision audit` chat'inden faz sonu review alindi. Claude karari `CONTINUE`.

Claude ile ortak karar:

- 3 creative'deki hard-label flip bulgusu Path B blokeri degil.
- Bu bulgu canli-teyitli formul borcu olarak 2026-07-10 checkpoint kapsaminda isimli golden-case/formul analizi girdisi olacak.
- D033 day-1 icin asil kanit 2026-07-07 03:00+ UTC producer dalgasindan sonra gelecek.

## 2. Kanit Siniri

Kanitlar:

- Repo: `/Users/harmelek/Adsecute`, `main...origin/main`, calisma agaci temiz.
- D033 commit: `61ce475ab51ba329c3166f30f1c9839bd1df858b`.
- Public build endpoint: `https://adsecute.com/api/build-info`.
- Latest public sample: 2026-07-06T08:07:55Z.
- Production DB: acik SSH tunnel uzerinden, read-only sorgularla kontrol edildi.
- Claude review: visible Claude Desktop chat, `Decision: CONTINUE`.
- Manuel olarak `/api/sync/cron` cagrilmadi.

Kanit disinda kalanlar:

- Current-version 7d outcome dogrulugu henuz beklenmez. Ilk anlamli pencere 2026-07-10 civarinda acilir.
- D033 automatic mode flip henuz yapilmadi. Bugunku context deploy'u shadow/veri toplama hazirligi olarak okunmali.
- Formula precision/recall/ECE karari bu raporun konusu degil; 3 hard-flip vaka bu konunun 2026-07-10 girdisidir.

## 3. Runtime ve Build Kapisi

Production runtime temiz:

| Kontrol | Sonuc |
|---|---|
| Commit / buildId | `61ce475ab51ba329c3166f30f1c9839bd1df858b` |
| CI | success |
| Deploy workflow | success |
| Post-deploy verification | success |
| Public `/api/build-info` buildId | `61ce475ab51ba329c3166f30f1c9839bd1df858b` |
| Web runtime | healthy/fresh |
| Worker runtime | healthy/fresh |
| deployGate / releaseGate | pass / pass |
| runtimeRegistry issues | `[]` |
| DB/config fingerprint | match / match |
| `APP_BUILD_ID` | `61ce475ab51ba329c3166f30f1c9839bd1df858b` |
| `DECISION_ENGINE_V3_JOBS_DISABLED` | `0` |
| `CAMPAIGN_CONTEXT_MODE` | absent/empty, therefore `legacy_labels` default |

Not: `/healthz` public request login redirect dondu; runtime sagligi icin otorite olarak `/api/build-info` runtimeRegistry kullanildi.

## 4. D033 Day-0 Kontrolu

D033 migration uygulanmis durumda:

- `engine_v3_campaign_context_daily` tablosu production DB'de var.
- Tablo kolonlari beklenen semayla mevcut: business/account/campaign/as_of/inferred_kind/confidence/source/basis/resolver/evidence/hysteresis/freshness/job_run_id timestamps.
- Row count: `0`.

Bu `0` satir beklenen durumdur. D033 deploy'u 2026-07-06 03:00 UTC producer dalgasindan sonra yapildi. Bu nedenle ilk scheduled `engine_v3_campaign_context_job` kaniti 2026-07-07 03:00+ UTC dalgasindan sonra beklenir. Manuel cron cagrisi yapilmadi ve yapilmamali.

Local validation deploy oncesi temizdi:

- Targeted tests: campaign-label-guard, v3 route, v3 evidence route passed.
- Full suite: 457 test files, 3478 tests passed, 56 skipped, 61 todo.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- `npm run creative:decision:campaign-context-shadow`: passed.

Shadow headline:

| Metrik | Sonuc |
|---|---:|
| Businesses | 4 |
| High-confidence agreement | 7/7 |
| False-Test high | 0 |
| Active-labeled agreement | 13/16 |
| Guard-impact high-confidence unlock candidates | 0 |

## 5. 2026-07-06 Producer Penceresi

Engine version: `v3-2026-07-02-math-guardrails`.

| Is | Durum | Kosu | Satir | Ilk baslangic | Son bitis | Max sure |
|---|---:|---:|---:|---:|---:|---:|
| calibration | success | 14 | 415 | 03:03:17Z | 03:04:18Z | 4813ms |
| lifecycle | success | 14 | 1666 | 03:03:22Z | 03:04:18Z | 5918ms |
| decisions | success | 14 | 1609 | 03:03:27Z | 03:04:18Z | 1960ms |
| outcomes | success | 13 | 1855 | 04:00 window | 04:00 window | 378ms |
| campaign_context | absent | 0 | 0 | - | - | - |

`campaign_context` job'unun 2026-07-06 icin absent olmasi beklenen durumdur; deploy 03:00 UTC dalgasindan sonra tamamlandi.

Ek kanitlar:

- Failed/running/stuck `engine_v3` job row yok.
- Tum current-version business'larda calibration + lifecycle + decisions success.
- Decisions metadata genelinde `pruned_snapshot_count=0`.
- Decisions metadata genelinde `pruned_event_count=0`.
- Adsecute Demo ve Enise bos decision evreni; `prune_skipped_empty_payload=true`, pruned satir yok.

## 6. Snapshot ve Lifecycle Mutabakati

Exact veya beklenen mutabakat:

- Bilsem, BskTR, ColorFullWorldsTR, EMOLOS, Grandmix, Halicizade, Silveristic, Vornom: distinct creative mutabakati exact.
- Adsecute Demo ve Enise: bos evren.
- Snapshot'larda null `lifecycle_row_id` yok.
- Broken `lifecycle_row_id` yok.

Bilinen istisnalar:

| Sinif | Kanit | Karar |
|---|---|---|
| IwaStore carry-over | lifecycle 155, snapshot 157; 2 prior-linked, zero spend/purchase, paused/ineligible | Tek hane, orphan degil, izlenir |
| IwaTR carry-over | lifecycle 100, snapshot 103; 3 prior-linked, zero spend/purchase, paused/ineligible | Tek hane, orphan degil, izlenir |
| TheSwaf carry-over | lifecycle 279, snapshot 283; 4 prior-linked, 2026-07-05 lifecycle, zero spend/purchase, campaign paused/ineligible | Tek hane, rotasyonlu, izlenir |
| Tiles stale-disarida kalma | lifecycle 207, snapshot 141; 66 ineligible lifecycle without snapshot, source_max_date 2026-06-19, freshness 399h, zero spend/purchase | Bilinen stale safe-direction sinifi |

TheSwaf hedef creative kontrolu:

- Creative `1241793714589639`, 2026-07-02 ile 2026-07-05 arasinda 2026-07-02 lifecycle carry-over olarak gorunmustu.
- 2026-07-06 snapshot evreninde yok.
- Bu nedenle beklenen stale/Tiles-style exclusion yonune cikmis kabul edilir; 2026-07-02 lifecycle'a takili kalma anomalisi yok.

## 7. Outcome Yorumu

2026-07-06 outcome job'u sadece historical `unknown` churn modeline uyan satirlari yazdi:

| Business | Outcome satiri |
|---|---:|
| Grandmix | 178 |
| IwaStore | 1185 |
| TheSwaf | 492 |
| Toplam | 1855 |

Bu hacim onceki gun tanimlanan unknown-churn modeliyle uyumlu:

- 2026-05-04 ve 2026-05-25 kohortlari tekrar idempotent degerlendiriliyor.
- Operasyonel sure dusuk: max 378ms.
- Dogruluk etkisi beklenmez, fakat olcum gurultusu/teknik borc olarak kayitli kalir.

Current-version outcome beklentisi:

- `decision_as_of_date >= 2026-07-03` icin current engine 7d outcome satiri: `0`.
- Bu beklenen durumdur; ilk anlamli current-version 7d pencere 2026-07-10 civarinda acilir.

## 8. Change-Event ve Hard-Flip Bulgusu

2026-07-06 change-event ozeti:

- `decision_changed` event: 43.
- Missing snapshot link: 0.
- Business dagilimi: Bilsem 3, BskTR 1, EMOLOS 1, Grandmix 3, Halicizade 2, IwaStore 10, IwaTR 8, Silveristic 1, TheSwaf 1, Tiles 5, Vornom 8.

3 real hard-label round-trip bulundu:

| Business | Creative | Pattern | Ortak yorum |
|---|---|---|---|
| IwaStore | `946471284944193` | `scale -> keep -> scale` | Scale recent-hold `recent7dRoas >= target` sinir esigi churn'u; ayrica paused kampanyada hard scale semantigi formel olarak netlesmeli |
| TheSwaf | `1962656064410174` | `cut -> keep -> cut` | En ciddi vaka. Creative derin zararda; yanlis olan cut gunleri degil, account-relative P25 sinirinin kaymasiyla gelen keep gunu |
| Tiles | `25889037484086563` | `keep -> cut -> keep` | Confidence 40, 17 gun bayat veri, low-risk event churn; stale tail sinifi |

Claude ile ortak karar:

- Bu bulgu bloker degil, cunku review-only yuzeyde 1609 karar icinde 3 vaka ve otomasyon beslemiyor.
- Buna ragmen formul borcu gercek: karar-seviyesi label hysteresis, F2 clamp/band, PAUSED-status hard-action semantigi ve Tiles stale-tail churn'u 2026-07-10 formul fazina isimli vaka olarak girmeli.
- Gunluk hard-flip sayaci artik izleme metrigi olarak kayda alinmali. Bugunku baseline: `3`.

## 9. Siradaki Kapilar

2026-07-07 03:00+ UTC D033 day-1 kontrolu:

- `engine_v3_campaign_context_job` 14 current-version business icin success olmali.
- `engine_v3_campaign_context_daily` dolmali.
- Confidence-class dagilimi business bazinda raporlanmali.
- Hysteresis suppressed-flip sayilari kontrol edilmeli.
- calibration/lifecycle/decisions zinciri etkilenmemis kalmali.
- `pruned_snapshot_count=0` ve `pruned_event_count=0` kalmali.

2026-07-06 ile 2026-07-09 arasi sessiz izleme:

- Manuel cron yok.
- DB/provider/live sistemlere yazim yok.
- Claude review sadece anomali veya materyal checkpoint varsa.
- Hard-flip sayaci gunluk izlenir; bugunku baseline `3`.

2026-07-10 checkpoint:

- Ilk current-version 7d outcome penceresi.
- Phase1 checkpoint re-run.
- EMOLOS reconciliation.
- Current-version F1/F2 re-sweep.
- Hard-flip/golden/stability review, bugunku 3 isimli vaka dahil.
- D033 shadow haftasi ara raporu.
- Claude review zorunlu; ortak karar olmadan automatic flip yok.

## 10. HOLD / RE-CLOSE Esikleri

Asagidakilerden biri gorulurse zincir acik birakilmamali:

- Production web/worker build mismatch.
- `DECISION_ENGINE_V3_JOBS_DISABLED=1` veya runtime drift.
- Failed/stuck/running producer job.
- D033 day-1'de context job'unun genis kapsamli fail etmesi.
- Context confidence dagiliminin aktif business'larda `unknown` veya `conflict` sinifina cokmesi.
- Hysteresis suppressed flip storm.
- Aciklanamayan `pruned_snapshot_count > 0` veya `pruned_event_count > 0`.
- `snapshots_missing_lifecycle_id > 0`.
- TheSwaf/Iwa carry-over sinifinin tek haneden cikmasi veya ayni creative'in takili kalmasi.
- TheSwaf `1241793714589639` tekrar 2026-07-02 lifecycle carry-over sinifinda gorunurse.
- Tiles stale-disarida kalma sinifinin taze/aktif creative'lere yayilmasi.
- Ayni creative'de 3+ ardisk gun hard-label flip-flop hacminin baseline ustune anlamli sekilde cikmasi.
- Outcomes hacminin unknown-churn modelinden belirgin sapmasi.

## 11. Ortak Faz Karari

Codex karari: `CONTINUE`.

Claude review karari: `CONTINUE`.

Ortak karar: Path B zinciri ve D033 shadow hazirligi acik kalir. Sonraki operasyonel kontrol 2026-07-07 03:00+ UTC scheduled producer dalgasindan sonra D033 day-1 kanitidir. Sonraki buyuk karar kapisi 2026-07-10 current-version 7d outcome + formul/checkpoint review'udur.
