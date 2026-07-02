# Creative Decision Math Theoretical Review - 2026-07-02

Bu dokuman, Creative Decision Center karar matematiginin teorik incelemesidir.
Hedefi formule hemen mudahele etmek degil, mevcut karar zincirinde hangi kisimlarin
eksik veya riskli oldugunu kanit sinirlariyla ortaya koymaktir.

## 1. Kanit Siniri

Bu rapor su kaynaklara dayanir:

- Zorunlu proje dokumanlari: `START_HERE.md`, `DECISION_LOG.md`,
  `DATA_READINESS.md`, `GOLDEN_CASES.md`, `INVARIANTS.md`.
- Mevcut branch uzerindeki karar motoru kodu:
  `lib/creative-decision-engine/*`, `lib/creative-decision-center/*`,
  `app/api/creatives/briefing/*`, `app/api/sync/cron/route.ts`.
- Ilk teorik inceleme sirasinda tekrar calistirilan test:
  `npx vitest run lib/creative-decision-engine lib/creative-decision-center app/api/creatives/briefing components/creatives/briefing app/api/sync/cron/route.test.ts`
  sonucu: 64 test dosyasi gecti, 4 skip; 591 test gecti, 53 skip, 57 todo.
- Claude Desktop uygulamasindaki acik `Adsecute Creative Decision audit`
  chat'ine clipboard/computer-use ile verilen prompt:
  `CLAUDE_DECISION_MATH_REVIEW_PROMPT_2026-07-02.md`.
- Claude Code'un ayni acik uygulama chat'inde yazdigi bagimsiz rapor:
  `CLAUDE_DECISION_MATH_REVIEW_2026-07-02.md`.
- Faz 0 read-only replay script'i:
  `scripts/creative-decision-center/phase0-current-engine-simulation.ts`.
- Faz 0 wall-clock runtime raporu:
  `generated/phase0-current-engine-simulation.json` ve
  `PHASE0_CURRENT_ENGINE_SIMULATION_2026-07-02.md`.
- Faz 0 historical-freshness analiz raporu:
  `generated/phase0-current-engine-simulation-historical.json` ve
  `PHASE0_CURRENT_ENGINE_SIMULATION_HISTORICAL_2026-07-02.md`.
- Null freshness semantigi icin uygulanan kismi Faz 3 kod degisikligi:
  `unknown_freshness` badge'i, confidence cap ve hard-scale freshness blocker.
- Son dogrulama:
  `npx vitest run lib/creative-decision-engine lib/creative-decision-center app/api/creatives/briefing components/creatives/briefing app/api/sync/cron/route.test.ts`
  sonucu: 64 test dosyasi gecti, 4 skip; 600 test gecti, 53 skip, 57 todo.
  `npx tsc --noEmit --pretty false --incremental false`, hedefli ESLint ve
  `git diff --check` temiz.

Onemli sinir: Once `claude -p` CLI ile yeni review alma denemesi `401 Invalid
authentication credentials` hatasi verdi; bu nedenle kullanicinin talebi
dogrultusunda is Claude Desktop uygulamasindaki acik chat'e tasindi. Bu raporun
son hali, o gorunur Claude calismasi tamamlandiktan sonra guncellendi. Claude
raporu once bagimsiz bolumlerini yazdi, sonra bu Codex raporunu okuyup
`Review of Codex Report` bolumunu ekledi.

Bu rapor formulleri degistirmez. Karar matematigi degisikligi icin kullanicinin
itirazlari ve onayi beklenmelidir.

## 2. Mevcut Karar Matematigi Haritasi

Karar zinciri kabaca su sirayla calisir:

1. `spend-unit-resolver.ts`: Kreatifin ticari olgunluga ulasmasi icin gereken
   spend birimini bulur.
2. `account-decision-profile.ts`: Spend biriminden hard cut, zero-conversion,
   sustained loser, scale ve recent sample esiklerini uretir.
3. `engine.ts`: Scope, target, diagnose, quality-only, zero-conversion,
   maturity ve ratio-zone gate'lerini sirasiyla calistirir.
4. `maturity.ts`: Kreatif yeterli ticari olgunlukta degilse genellikle
   `test_more` dondurur.
5. `ratio-zones.ts`: Scale, keep, refresh, cut, demote adaylarini uretir.
6. `gates/types.ts`: Confidence, stale cap, badge ve hard-action eligibility
   son islemlerini uygular.
7. `fatigue.ts`, `funnel.ts`, `outcome-classifier.ts`: Destekleyici sinyal,
   problem sinifi ve sonradan sonuc etiketleme yapar.

Temel prensip dogru: UI karar uretmiyor, karar motoru uretip UI'a tasiyor.
Ayrica hard action icin policy/delivery/proof gate yaklasimi tasarim olarak
dogru. Sorun, bazi formullerin teorik olarak makul gorunmesine ragmen pratikte
olculebilirlik, branch erisilebilirligi ve confidence kalibrasyonu tarafinda
yeterince kanitlanmamis olmasi.

## 3. Codex'in Bagimsiz Formul Incelemesi

### 3.1 Spend unit ve profil esikleri

Guclu taraf:

- `spend-unit-resolver.ts`, target CPA, operator AOV, target ROAS, account CPA
  P50, meta adjusted AOV ve breakeven gibi kaynaklari hiyerarsik olarak
  kullaniyor. Bu, tek bir zayif metrikle hard action uretme riskini azaltir.
- `account-decision-profile.ts`, account winner benchmark readiness icin en az
  30 mature creative sartini scale kararina bagliyor. Bu, premature scale
  riskini azaltan dogru bir guard.
- Hard eligibility, spend unit'in kaynagina ve AOV sample kalitesine bagli.
  Ozellikle meta adjusted AOV gibi daha zayif kaynaklarda hard action kisitli.

Eksik taraf:

- Esikler domain bilgisiyle savunulabilir ama backtest ile refit edilmis degil.
  Mevcut dokumantasyon da bunu kabul ediyor. Bu nedenle "10/10 karar matematigi"
  diye okunamaz.
- `minAccountScaleCalibrationSample = 30` teorik olarak mantikli, fakat bu sayi
  account ve kategori cesitliligine gore dogrulanmamis. Kucuk hesaplarda scale'i
  fazla kilitleyebilir, buyuk hesaplarda yetersiz kalabilir.
- Hard cut ve loss budget multiplier arasindaki iliski bazi branch'leri olu
  hale getiriyor. Bu asagida ayri bulgu.

### 3.2 Maturity gate ve cut matematigi

Mevcut tasarim:

- Spend, ticari olgunluk esiginin altindaysa sistem `test_more` tercih ediyor.
- Teorik olarak "severe loser carve-out" var: cok kotu kreatif, genel maturity
  esiginden once kesilebilsin.
- Ratio-zone tarafinda cut bolgesine giren olgun kreatifler hard cut veya
  soft cut adayi olabiliyor.

Temel sorun:

`maturity.ts` icindeki severe-loser carve-out pratikte buyuk olasilikla
erisilemez. Dengeli preset'te `lossBudget = 2`, `hardCut = 5`. Maturity gate,
spend `2 * spendUnit` altindayken calisir. Severe carve-out ise hard cut icin
`5 * spendUnit` seviyesine bakar. Bir kreatif 5 birime ulasmissa zaten 2 birim
maturity esigini asmistir, yani o carve-out'a artik ihtiyac kalmaz.

`ratio-zones.ts` icinde de cut ladder pratikte fazla agresif hale geliyor.
Maturity gate'ten gecmis bir kreatif cut zone'a girdiginde, `spend >=
commercialMaturitySpend` kosulu zaten saglanmis oluyor. Bu nedenle cut zone'daki
son "mature loser" hard cut branch'i cok genis yakaliyor; alttaki fatigue
refresh veya soft test-more dallari gercekte beklenenden daha az calisiyor.

Sonuc:

- Cut matematigi teoride kademeli gorunuyor, ama uygulamada kademelerin bir
  kismi olu, bir kismi da fazla genis.
- Bu, yanlis pozitif hard cut riskini scale riskinden daha yuksek hale getirir.
- Claude'un "dead cut ladder" bulgusuna Codex katiliyor. Bu bulgu mevcut
  branch'te hala acik.

### 3.3 Scale matematigi

Guclu taraf:

- Scale icin sadece ROAS ratio yetmiyor; spend depth, purchase depth, benchmark
  blockers, stale blockers ve recent 7d ROAS target kontrolu var.
- Account winner benchmark readiness olmadan hard scale engelleniyor.
- Stale evidence scale'i veto ediyor.

Eksik taraf:

- Scale tarafinda guard'lar kesme tarafindan daha guclu. Bu muhafazakar bir
  secim olarak savunulabilir, fakat matematigin iki tarafinda asimetri var:
  scale zor, cut daha kolay.
- Scale ratio presetleri 1.2 / 1.3 / 1.4 olarak mantikli ama kanitla refit
  edilmis degil.
- Purchase floor, winnerPurchaseP50 ve recent ROAS target kontrolu dogru sinyal
  aileleri, fakat mevcut historical sample hard scale precision'i olcmeye
  yetecek kadar zengin degil.

Sonuc:

Scale matematigi production read-only icin makul, ama auto-execution icin
kanitlanmis degil. Bu noktada scale tarafinda guard gevsetmek degil, once
current snapshot ve outcome biriktirmek gerekir.

### 3.4 Confidence matematigi

Mevcut tasarim:

- Base confidence 75.
- Spend unit kalitesi dusukse confidence dusuyor.
- Stale evidence cap 65.
- Missing recent 7d data ve data health warning'leri confidence dusuruyor.
- Hard action eligibility finalde tekrar enforce ediliyor.

Temel sorunlar:

- Confidence, henuz outcome verisiyle kalibre edilmis bir olasilik degil.
  Daha cok "heuristic trust score" gibi davranir.
- Stale cap sadece `stale_evidence` badge'i varsa uygulanir. Buna karsin
  `gates/diagnose.ts` icinde `dataFreshnessHours === null` stale sayilmiyor.
  Bu, bilinmeyen tazeligi teorik olarak fazla guvenli gosterebilir.
- Low CTR icin cut/refresh decision'larda -10 confidence uygulanmasi tartismali.
  Low CTR bazen kreatifin sorunlu oldugunu guclendirir, bazen de conversion
  datasinin yorumlanmasini zayiflatir. Hangi yonde agirlik verilmesi gerektigi
  outcome ile olculmeden sabit delta olmamali.
- Confidence ile priority birbirine karisabilir. Ornegin dusuk confidence ama
  yuksek zarar potansiyeli olan bir cut adayi, operasyonel olarak yuksek
  oncelikli olabilir.

Sonuc:

Confidence su anda karar aciklamasi icin faydali, ama "istatistiksel dogruluk"
olarak okunmamali. ECE, Brier score veya action-type bazli precision/recall
olcumuyle kalibre edilmeden auto-execution esigi olamaz.

### 3.5 Freshness ve missing data matematigi

Mevcut tasarim:

- Stale kaynak confidence'i cap'leyebilir.
- Scale stale iken veto edilir.
- Delivery/policy proof alanlari olmadan `fix_delivery` ve `fix_policy` daha
  temkinli davranir.

Eksik taraf:

- Null freshness, "bilinmiyor" yerine pratikte "stale degil" gibi ele
  alinabiliyor.
- D032 karari, stale evidence'in scale'i veto etmesini ama mature stop-loss cut'i
  tamamen saklamamasini soyluyor. Bu dogru bir prensip. Ancak null freshness icin
  ayni ayrim net degil.

Ortak onerilen kural:

- `null` freshness = "fresh" degil, "unknown" olmalidir.
- Unknown freshness hard scale'i veto etmeli.
- Unknown freshness cut icin karari tamamen saklamamali, ama confidence cap ve
  acik badge uretmeli.
- Delivery/policy proof gerektiren kararlar icin unknown freshness hard action'a
  izin vermemeli.

### 3.6 Fatigue matematigi

Guclu taraf:

- Fatigue sadece ROAS'a bakmiyor; best window decay, spend concentration,
  frequency ve benchmark status sinyallerini ayri topluyor.
- Strong history gereksinimi var. Bu, yeni kreatifin erken "fatigue" diye
  etiketlenmesini azaltir.

Eksik taraf:

- Production call site'larda `spendConcentration` ve `benchmarkRoasStatus`
  null gecilebiliyor. Bu, formulun teorik sinyal setinin runtime'da tam
  beslenmedigini gosterir.
- Confidence hesabi 0.48 taban ve sabit artislardan olusuyor; outcome ile
  kalibre edilmis degil.
- Winner memory min spend default'u 0, min purchases default'u 1. Bu kucuk
  orneklerde false positive fatigue riskini artirabilir.

Sonuc:

Fatigue formulu karar motoruna yardimci sinyal olarak iyi, fakat refresh veya
hard aksiyon mantiginda tek basina yuksek guven tasimamali.

### 3.7 Funnel ve quality-only matematigi

Guclu taraf:

- Funnel, CTR, LPV, ATC, checkout ve purchase oranlarini ayrip problem class
  uretiyor.
- Denominator confidence fikri dogru: az veriyle sert funnel teshisi yapmamak
  gerekir.
- Quality-only assessment, kreatif kalitesini sadece ROAS'a indirgemiyor.

Eksik taraf:

- Denominator confidence fallback P50 sabitleri, account/kategori bazli
  backtest ile refit edilmis degil.
- Quality weights dosyada operator-tunable v1 olarak tarif ediliyor. Bu dogru
  bir uyari, ama ayni zamanda bu agirliklarin henuz kanitlanmis olmadigini
  gosterir.
- Funnel diagnosis ile buyer action arasindaki iliski dogru aciklansa bile,
  UI ve raporlama ayni dili kullanmazsa operator yanlis yorumlayabilir.

Sonuc:

Funnel/quality katmani iyi bir explainability ve diagnosis kaynagi. Hard action
matematiginin ana belirleyicisi olmadan once historical outcome ile validasyon
gerekir.

### 3.8 Outcome classifier ve historical veri

Mevcut branch'te onemli iyilesmeler var:

- Outcome classifier version `v2`.
- Spend severity artik baseline spend'e gore normalize ediliyor.
- Decision-outcomes job, eski classifier version veya unknown outcome olan
  kayitlari yeniden siniflandirabiliyor.

Fakat historical veri su anda esik refit'i icin yeterli degil:

- Grandmix, IwaStore ve TheSwaf tarafinda snapshot'lar eski ve buyuk olcude
  stale.
- Hard scale sample cok az.
- Hard cut ve refresh icin pozitif/negatif outcome dagilimi precision/recall
  hesabi icin yetersiz.
- Existing outcome'larin onemli bolumu `unknown`.

Kullanici review notu: Buradaki amac "sentetik veri uretip ona gore formul
uydurmak" degil; eldeki hazir ham/snapshot/historical veriyi bugunku karar
motorundan gecirip motorun nasil karar verecegini simule etmek. Bu ayrim dogru.
Mevcut motoru replay/shadow modda calistirarak hangi kreatifin hangi gate'e
takildigini, hangi action'a dustugunu, confidence'in nasil dagildigini ve
outcome classifier'in bunu nasil etiketledigini gorebiliriz.

Bu nedenle fikir dogru yonde, ama ikiye ayrilmali:

1. Eski/hazir veri ile mevcut karar motoru simule edilebilir. Bu, fake outcome
   uretmek degil; var olan creative/account gunlerini bugunku engine'den
   replay edip karar dagilimini, gate coverage'i, branch reachability'yi ve
   classifier davranisini gormektir.
2. Esik degistirme veya "bu formul dogru" karari icin current branch ile yeni
   snapshot/outcome biriktirmek gerekir.

## 4. Claude Desktop Bulgulari ve Codex Review'i

Claude Code analizi gorunur Claude Desktop uygulama chat'inde yaptirildi ve
repo icine `CLAUDE_DECISION_MATH_REVIEW_2026-07-02.md` olarak yazildi. Claude
zorunlu dokumanlari okudu, formulleri bagimsiz inceledi, sonra bu Codex raporunu
okuyup kendi `Review of Codex Report` bolumunu ekledi.

### 4.1 Bagimsiz yakinlasma

Claude ile Codex'in ayrica vardigi ana ortak bulgular:

- Cut ladder sorunu: Claude bunu daha sert ifade etti. Codex "fazla genis ve
  bazi dallari olu" dedi; Claude "P25 alti mature cut akisi tek kademeye
  cokuyor, soft/fatigue dallari pratikte olu" diye netlestirdi.
- Confidence heuristic: Iki taraf da confidence'in kalibre edilmis olasilik
  olmadiginda ayni goruste.
- Null freshness: Iki taraf da engine tarafinda bilinmeyen tazeligin fresh gibi
  davranma riskinin kaldigini kabul ediyor.
- Historical data: Iki taraf da eski verinin pipeline/classifier/ECE smoke test
  icin kullanilabilecegini, fakat esik refit icin yetersiz oldugunu soyluyor.
- Closed fixes: Claude, Codex'in scheduler/no-campaign/outcome reclass/freshness
  plumbing tarafinda "kapandi veya kismen kapandi" dedigi noktalari difflerden
  dogruladi.

### 4.2 Claude'un Codex'e ekledigi bulgular

Claude raporu Codex raporuna su ek keskinlestirmeleri getirdi:

- `roasRatioP25` cut boundary kelepcesiz. Guclu bir hesapta P25 0.85 hatta 1.0
  uzerine cikarsa, hedefe yakin veya karli kreatifler "emsale gore zayif" diye
  cut zone'a girebilir. Zayif hesapta ise gercek kaybedenler fazla tolerans
  gorebilir. "Emsale gore kotu" ile "para kaybediyor" ayni sey degildir.
- ECE/measurement polaritesi kirik kalabilir. Hard action positive/negative
  anlami ile non-hard missed-opportunity anlami ayni raporda karisirsa
  confidence kalibrasyonu yanlis okunur.
- Compliance confound var. Operator bir cut onerisine uyarsa ve kreatif kesildigi
  icin sonraki outcome zayiflarsa, bu decision quality degil, compliance etkisi
  olabilir. Operator-response join olmadan precision mekanik olarak bozulabilir.
- Low CTR cut baglaminda yalnizca "tartismali" degil; Claude'a gore dusuk CTR,
  cut icin destekleyici kanit olabilir. Burada sabit -10 confidence deltasi en
  azindan action-type bazli yeniden ele alinmali.
- Golden case'ler bazi mevcut davranislari beklenen diye kilitliyor olabilir.
  Bu nedenle matematik degisikligi sadece unit test degil, golden case revizyonu
  da gerektirebilir.

### 4.3 Guncel skor yorumu

Claude'un guncel raporu karar matematigini "iyi yapilandirilmis bir 6/10" diye
okudu. Codex'in bu rapordaki teorik degerlendirmesi yarim puan daha iyimserdi:
6.5/10. Fark esas degil; iki taraf da su noktada ayni yerde:

- Read-only planning/diagnosis icin kullanilabilir bir iskelet var.
- Auto-execution icin hazir degil.
- 8+ seviyeye cikmak icin once cut boundary, cut ladder, freshness, confidence
  semantics, ECE/outcome measurement ve golden/metamorphic testler duzelmeli.

## 5. Ortak Sonuc: Neresi Neden Eksik?

### P0 - Measurement eksigi: Formuller dogrulanmadan kesin karar gibi sunuluyor

Neden eksik:

- Existing thresholds domain mantigiyla yazilmis, fakat yeterli action-type
  outcome ile refit edilmemis.
- Hard scale, hard cut, refresh ve diagnose icin ayri precision/recall yok.
- Confidence kalibrasyonu yok.

Neden onemli:

- Teorik olarak dogru gorunen esik, farkli hesaplarda yanlis karar verebilir.
- Operator "95 confidence" gordugunde bunu gercek olasilik sanabilir.

Duzeltme:

- Her karar icin `decisionScore`, `confidence`, `priority`, `outcomeWindow`,
  `classifierVersion`, `actionType` ayri loglanmali.
- ECE/Brier/action precision raporu uretilmeli.
- Threshold degisikligi once shadow-mode backtest'te denenmeli.

### P1 - Cut ladder olu ve fazla agresif dallar iceriyor

Neden eksik:

- Severe-loser carve-out, mevcut multiplier siralamasi nedeniyle pratikte
  erisilemez.
- Maturity gate'ten gecen cut-zone kreatifler, hard cut branch'ine fazla kolay
  dusuyor.

Neden onemli:

- Yanlis pozitif cut, iyi kreatifi erken oldurur.
- Scale guard'lari cok gucluyken cut guard'lari gorece gevsek kalirsa karar
  motoru sistematik olarak defansif davranir.

Duzeltme:

- Cut ladder yeniden siralanmali.
- `soft_cut_candidate`, `hard_cut`, `refresh_due_to_fatigue`, `test_more`
  dallari testlerle erisilebilir hale getirilmeli.
- Mature cut icin sadece spend yetmemeli; recent recovery, purchase floor ve
  severe ratio birlikte degerlendirilmeli.

### P1 - Cut boundary kelepcesiz relative percentile kullaniyor

Neden eksik:

- Cut zone siniri account `roasRatioP25` degerinden geliyor ve yeterli mutlak
  zarar/target guard'i ile kelepcelenmiyor.
- Guclu bir hesapta P25 zaten hedefe yakin veya hedef ustu olabilir; bu durumda
  sadece hesabin kendi dagiliminda alt ceyrek olmak, kreatifin ticari olarak
  kaybettirdigi anlamina gelmez.
- Zayif bir hesapta P25 fazla dusukse gercek kaybedenler fazla gec fark
  edilebilir.

Neden onemli:

- Bu sorun cut ladder bug'indan ayridir. Ladder duzeltilse bile boundary yanlis
  kalirsa sistem ya iyi kreatifleri keser ya da kotu kreatifleri korur.
- "Emsale gore kotu" sinyalini "para kaybettiriyor" karariyla karistirir.

Duzeltme:

- Cut boundary, relative percentile + absolute target/regret guard olarak
  tanimlanmali.
- P25 siniri icin alt/ust clamp belirlenmeli.
- Cut refactor testlerinde guclu hesap ve zayif hesap dagilimlari ayri scenario
  olarak yer almali.

### P1 - Null freshness fresh gibi ele aliniyor

Neden eksik:

- `dataFreshnessHours === null`, stale degilmis gibi davranabiliyor.

Neden onemli:

- Bilinmeyen data tazeligi ile hard action uretmek guven problemidir.
- D032'nin stale evidence prensibi null case icin net uygulanmiyor.

Duzeltme:

- Null freshness icin `unknown_freshness` badge'i.
- Hard scale veto.
- Hard cut icin confidence cap ve explicit reason.
- Delivery/policy aksiyonlarinda proof yoksa hard action yok.

### P1 - Confidence olasilik degil, heuristic

Neden eksik:

- Base 75 ve delta sistemi kalibre edilmemis.
- Low CTR gibi sinyallerin yonu action-type bazinda kanitlanmamis.
- Confidence ve priority ayrimi net degil.

Neden onemli:

- UI'da operator, confidence'i istatistiksel dogruluk gibi okuyabilir.
- Yeterli kanit yokken yuksek confidence, yanlis guven uretir.

Duzeltme:

- Confidence'i "model certainty" yerine kalibre edilene kadar "evidence
  strength" olarak isimlendirmek dusunulmeli.
- Action-type bazli ECE/Brier raporu uretilmeli.
- Priority, business impact ve confidence ayri alanlar olmali.

### P1 - ECE ve outcome polaritesi ayrilmadan calibration yaniltici olur

Neden eksik:

- Hard action icin "positive outcome" ile non-hard "missed opportunity" ayni
  yonde okunamaz.
- Operator response/compliance hesaba katilmazsa, aksiyon alindigi icin ortaya
  cikan sonraki performans hareketi decision quality gibi gorunebilir.

Neden onemli:

- Confidence kalibrasyonu yanlis etiketle egitilirse sistem daha guvenilir
  gorunur ama gercekte daha yanlis karar verir.
- Auto-execution gate'leri bu metriklere baglanirsa guvenlik yaniltilir.

Duzeltme:

- Hard action, soft action ve non-hard missed opportunity outcome'lari ayri
  polariteyle raporlanmali.
- Operator response join zorunlu olmasa bile measurement report'ta "operator
  complied / ignored / unknown" ayrimi yer almali.
- ECE raporu action-type ve compliance status bazinda bolunmeli.

### P2 - Fatigue ve funnel sinyalleri tam beslenmiyor

Neden eksik:

- Runtime'da bazi onemli fatigue sinyalleri null geciliyor.
- Funnel denominator fallback'leri account-specific degil.
- Quality weights operator-tunable v1 seviyesinde.

Neden onemli:

- Refresh onerileri dogru neden yerine yanlis semptoma baglanabilir.
- Funnel problemClass UI'da guvenilir gorunur ama veri tabani zayif olabilir.

Duzeltme:

- Spend concentration ve benchmark ROAS status gercek veriyle beslenmeli.
- Funnel denominator esikleri account/kategori dagilimlarindan uretilmeli.
- Quality weights historical outcome ile refit edilene kadar hard action'da
  ikincil sinyal kalmali.

### P2 - Segmentation ve creative family coverage karari sinirliyor

Neden eksik:

- Campaign label, objective ve creative family bilgisi eksikse hesap/kreatif
  segmenti yanlis okunabilir.

Neden onemli:

- Test creative ile main creative ayni esiklerle okunursa yanlis hard action
  cikabilir.
- Ayni creative family icindeki fatigue ve winner memory sinyalleri eksik kalir.

Duzeltme:

- Label coverage metrikleri dashboard'a tasinmali.
- Coverage dusukse confidence ve hard action cap uygulanmali.
- Creative family identity, fatigue ve benchmark mantigina baglanmali.

## 6. Gecmis Veri ve Simulasyon Nasil Kullanilmali?

Gecmis veriden faydalanmak mantikli. Buradaki oncelik sentetik veri uretmek
degil, eldeki hazir veriyi bugunku karar motorundan gecirip replay/shadow
simulation yapmaktir. Synthetic scenario setleri sadece branch coverage ve
metamorphic invariant testleri icin yardimci ikinci katman olmalidir.

### Kullanilabilir

- Hazir historical/current creative verisini bugunku engine input'una cevirip
  mevcut karar motorunu simule etmek.
- Her karar icin hangi gate'in terminal oldugunu, hangi profile/threshold'un
  kullanildigini, confidence deltasini ve hard-action eligibility sonucunu
  raporlamak.
- Existing snapshot ve outcomes ile pipeline'in calistigini gostermek.
- Outcome classifier v2'nin v1'e gore davranisini karsilastirmak.
- Confidence bucket'lari icin kaba ECE smoke test yapmak.
- Synthetic scenario setleriyle yalnizca branch coverage/metamorphic testleri
  tamamlamak.
- Golden case'leri executable hale getirip formullerin beklenen dallara
  dustugunu kanitlamak.

### Henuz kullanilmamali

- Hard cut multiplier'ini kesin refit etmek.
- Scale ratio threshold'unu dusurmek veya yukseltmek.
- Confidence skorunu gercek olasilik gibi etiketlemek.
- Auto-execution icin onay mekanizmasi kurmak.

Sebep: Historical sample stale, hard action dagilimi dengesiz ve unknown outcome
orani yuksek. Bu veri engine replay ve branch/gate analizi icin kullanilmali;
dogrudan esik ogrenmek veya auto-execution kaniti olarak kullanilmamali.

## 7. Onerilen Duzeltme Sirasi

### Faz 0 - Hazir veriyle mevcut motoru simule et

- Historical/current creative verisini karar motorunun bekledigi input sekline
  map et.
- Bugunku engine'i degistirmeden replay et.
- Account bazinda action dagilimi, gate dagilimi, cut/scale/refresh/test_more
  oranlari, confidence bucket'lari, stale/unknown freshness, label coverage ve
  hard-action blocker nedenlerini raporla.
- Cut branch reachability ve `roasRatioP25` boundary hassasiyetini scenario
  olarak goster.
- Bu fazda threshold degistirme yok; sadece motorun bugunku davranisini goruruz.

Kabul kriteri:

- Her business icin "bugunku karar motoru hazir veride ne yapiyor?" sorusuna
  action/gate/confidence/boundary seviyesinde cevap veren bir simulation raporu
  uretilir.

Uygulama sonucu:

- Read-only script eklendi:
  `scripts/creative-decision-center/phase0-current-engine-simulation.ts`.
  Script DB'ye snapshot/event yazmaz; yalnizca mevcut WarehouseDataSource,
  account profile, campaign label guard ve `decideCreative` zincirini bellekte
  calistirir.
- Wall-clock runtime modunda rapor:
  `PHASE0_CURRENT_ENGINE_SIMULATION_2026-07-02.md`.
  Bu mod gercek runtime freshness davranisini gosterir.
- Historical-freshness analiz modunda rapor:
  `PHASE0_CURRENT_ENGINE_SIMULATION_HISTORICAL_2026-07-02.md`.
  Bu mod production iddiasi degildir; eski veride formulu gormek icin
  freshness'i simulated as-of tarihine normalize eder.

Wall-clock replay ozeti:

| Business | simulatedAsOf | inputs | labels | hardActionRows | blockedHardActionRows | staleEvidenceRows |
|---|---:|---:|---|---:|---:|---:|
| EMOLOS | 2026-07-01 | 85 | test_more 64, keep 10, diagnose 11 | 0 | 11 | 60 |
| Grandmix | 2026-07-01 | 82 | test_more 61, diagnose 13, keep 7, cut 1 | 1 | 1 | 18 |
| IwaStore | 2026-07-01 | 80 | test_more 49, diagnose 19, out_of_scope 6, keep 4, scale 2 | 2 | 2 | 21 |
| TheSwaf | 2026-07-01 | 120 | test_more 73, keep 21, diagnose 14, cut 10, scale 2 | 12 | 13 | 90 |

Historical-freshness analiz ozeti:

| Business | simulatedAsOf | inputs | labels | hardActionRows | blockedHardActionRows | staleEvidenceRows |
|---|---:|---:|---|---:|---:|---:|
| EMOLOS | 2026-07-01 | 85 | test_more 64, keep 10, diagnose 11 | 0 | 11 | 0 |
| Grandmix | 2026-07-01 | 82 | test_more 61, diagnose 13, keep 7, cut 1 | 1 | 1 | 0 |
| IwaStore | 2026-07-01 | 80 | test_more 46, diagnose 23, out_of_scope 6, keep 3, scale 2 | 2 | 2 | 0 |
| TheSwaf | 2026-07-01 | 120 | test_more 71, keep 21, diagnose 16, cut 10, scale 2 | 12 | 12 | 0 |

Bu sonuclarin yorumu:

- Claude faz sonu review'unda eski `latest` replay'in Grandmix/IwaStore/TheSwaf
  icin Mayis 2026 lifecycle tarihine takildigini tespit etti. Replay
  `--asOf=2026-07-01` ile yeniden kosuldu; dort business artik ayni explicit
  tarih uzerinde raporlanir.
- Wall-clock mod hala runtime freshness etkisini gosterir: TheSwaf'ta 90,
  EMOLOS'ta 60, IwaStore'da 21, Grandmix'te 18 stale evidence satiri var.
- Historical analiz, ayni `2026-07-01` inputlarinda wall-clock stale etkisi
  kaldirilinca dagilimi gosterir: IwaStore'da 2 scale, TheSwaf'ta 10 cut + 2
  scale, Grandmix'te 1 cut, EMOLOS'ta 11 blocked cut.
- En buyuk operasyonel blocker campaign label coverage: EMOLOS 82/85 unlabeled,
  TheSwaf ve Grandmix'te de hard-action kararlarinin bir kismi campaign label
  guard tarafindan review/diagnose'a cekiliyor.
- Cut boundary hesabi account'a gore ciddi degisiyor: EMOLOS P25 ratio 0.2069,
  TheSwaf 0.4321, Grandmix 0.4974, IwaStore 0.6311. Bu, 3.1'de kullanicinin
  belirttigi "sabit degil account'a gore degisken olmali" itirazini destekler.
- Bu faz threshold refit icin yeterli degil; ama hangi branch ve blocker'larin
  once duzeltilmesi gerektigini gosterir.

### Faz 1 - Baseline dondur ve olcum raporunu kur

- Current branch ile scheduled pipeline'i calistir.
- Her business icin current snapshot ve outcome toplansin.
- Score-phase raporu action-type bazli uretilsin:
  scale, cut, refresh, diagnose, keep/test_more ayri.
- Esik degistirmeden once baseline freeze edilsin.

Kabul kriteri:

- Her action type icin sample sayisi, positive/negative/neutral/unknown dagilimi,
  confidence bucket ve stale/freshness coverage gorunuyor.

### Faz 2 - Cut ladder'i duzelt

- Severe-loser carve-out gercekten erisilebilir hale getirilmeli.
- Mature cut, sadece spend threshold degil, ratio severity ve recent recovery
  ile birlikte karar vermeli.
- Soft cut ve refresh branch'leri testle kanitlanmali.

Kabul kriteri:

- Unit testlerde hard cut, soft cut, fatigue refresh ve test_more branch'leri
  ayri ayri tetikleniyor.
- Cut tarafinda stale/unknown freshness confidence cap'i var.

Uygulanan kismi sonuc:

- Cut zone'a recent recovery guard eklendi.
- Cumulative 28d ROAS cut zone'da olsa bile recent 7d ROAS hedefin ustunde ve
  recent sample spend floor'u doluysa karar hard `cut` yerine `keep`/review
  olarak kalir.
- Bu degisiklik yeni sabit threshold eklemez; mevcut target ROAS ve account
  recent sample spend floor'unu kullanir.
- Guncel explicit `2026-07-01` replay'de cut dagilimi wall-clock ve historical
  modda ayni kaldi: Grandmix 1, TheSwaf 10, EMOLOS/IwaStore 0. Recovery guard
  icin asil kanit executable GC-059 ve hedefli gate testidir; daha genis
  quantification icin Phase 1 baseline/outcome raporu gerekir.
- Severe-loser carve-out icin henuz yeni daha dusuk spend esigi eklenmedi.
  Bunu backtest/refit olmadan uydurmak agresif false-positive cut riski
  yaratir. Bu alt madde Faz 2'nin kalan isidir.

### Faz 3 - Freshness semantics duzelt

- Null freshness `unknown` sayilmali.
- Unknown freshness scale'i veto etmeli.
- Cut icin badge + confidence cap uretmeli.

Kabul kriteri:

- Null freshness ile hard scale cikmiyor.
- Null freshness ile mature severe cut tamamen saklanmiyor, ama guven sinirli
  ve aciklanmis oluyor.

Uygulanan kismi sonuc:

- `unknown_freshness` badge'i eklendi.
- `unknown_freshness`, `stale_evidence` gibi confidence cap'e giriyor.
- `diagnoseGate`, null freshness'i fresh saymiyor; delivery warning ve
  funnel-step diagnose icin fresh proof sartini koruyor.
- `ratioZonesGate`, null freshness ile hard scale'i `scale_readiness_blocked`
  uzerinden `keep` olarak tutuyor.
- Mature severe loser cut karari unknown freshness nedeniyle tamamen
  saklanmiyor; karar `cut` kalip confidence cap ve badge ile aciklaniyor.
- Golden/executable coverage eklendi: GC-059 recovery hold, GC-060 unknown
  freshness scale block, GC-061 funnel fresh-proof behavior. Bu case'ler
  Markdown canonical list, fixture JSON ve `golden-cases.test.ts` switch'inde
  kilitlendi.
- Yeni testler hedefli gate, engine ve golden seviyesinde eklendi.

### Faz sonu Claude review ve STOP_AND_FIX sonucu

Claude Desktop uygulamasindaki acik chat'ten faz sonu review istendi. Claude'un
karari `STOP_AND_FIX` oldu; Codex buna katildi. Ortak karar: Phase 1 baseline
adimina gecmeden once uc dar blocker kapatilacak.

Kapatilan blocker'lar:

1. `ENGINE_VERSION` `v3-2026-07-02-math-guardrails` olarak bump edildi.
   Sebep: recovery hold, unknown freshness cap/block ve funnel fresh-proof
   semantigi ayni input icin karar davranisini degistiriyor; eski version
   damgasiyla yeni snapshot/outcome yazmak olcum temelini bozar.
2. GC-059/060/061 canonical golden rows ve executable fixture/test coverage
   eklendi.
3. Phase 0 replay, dort business icin de acik `asOf=2026-07-01` ile yeniden
   kosuldu; eski `latest` replay'in Mayis lifecycle tarihine takilmasi giderildi.

### Faz 4 - Confidence'i kalibre et

- Confidence, priority ve evidence strength ayrilsin.
- Action-type bazli ECE/Brier raporu eklensin.
- Low CTR ve missing recent data deltalarinin yonu historical outcome ile
  test edilsin.

Kabul kriteri:

- Confidence bucket 50-60, 60-70, 70-80, 80-90, 90+ icin observed outcome rate
  raporlanabiliyor.

### Faz 5 - Fatigue/funnel sinyallerini tamamla

- Runtime'da null gecilen fatigue sinyalleri gercek veriyle beslensin.
- Funnel denominator fallback'leri account-specific dagilimlarla degistirilsin.
- Quality weights hard-coded v1 olmaktan cikip config/backtest destekli hale
  gelsin.

Kabul kriteri:

- Refresh/fatigue onerileri icin false positive orani izlenebiliyor.
- Funnel problemClass, outcome ile en azindan directional olarak tutarli.

## 8. Simdilik Yapilmamasi Gerekenler

- Auto-execution acilmamali.
- Scale guard'lari gevsetilmemeli.
- Cut threshold'lari historical sample yetersizken refit edilmemeli.
- Yeni standalone decision core yazilmamali.
- UI buyerAction hesaplamaya baslamamali.
- Row-level `brief_variation` eklenmemeli.
- V1/operator/V2 snapshot compatibility migration plani olmadan kaldirilmamali.

## 9. Kisa Sonuc

Ortak karar su:

Adsecute'un karar matematigi iyi bir iskelete sahip. En degerli taraflari
proof-gate yaklasimi, spend-unit hiyerarsisi, scale readiness guard'i ve UI'in
karar uretmemesi. Ancak bu sistem henuz "matematiksel olarak kanitlanmis karar
motoru" degil. En kritik eksikler cut ladder'in branch problemi, null freshness
semantics, confidence kalibrasyonu ve historical/current outcome olcumunun
yetersizligi.

Bu nedenle sonraki dogru adim formulleri hemen degistirmek degil:

1. Baseline ve outcome olcumunu sabitle.
2. Cut ladder ve freshness semantics'i testli olarak duzelt.
3. Confidence'i calibrated probability gibi sunma; once olc.
4. Fatigue/funnel sinyallerini tam veriyle besle.
5. Kullanici itirazlari ve onayindan sonra kademeli implement et.
