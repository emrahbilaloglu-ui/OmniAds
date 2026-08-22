# Meta ve Alt Menüleri — Market-Ready Uygulama Master Planı

Durum: Nihai ortak plan; uygulama yapılmadı  
Tarih: 2026-08-22  
Repo: /Users/harmelek/Adsecute  
İncelenen HEAD: 843b6e9c836ee0ad8187954e4dff72d86b2914a7  
Öncelik: Meta ve Meta alt menüleri  
Plan sahipliği: Codex bağımsız incelemesi + Claude Code incelemesi + ortak uzlaştırma

## 1. Amaç

Bu planın amacı yeni Dashboard v2 görsel yönünü değiştirmeden Meta deneyimini:

- frontend ve backend sözleşmeleri uyumlu,
- gerçek production route’larında çalışan,
- doğru business ve fiziksel provider account kapsamında,
- eksik veya bozuk veriyi dürüstçe gösteren,
- provider yazmalarını receipt, read-back ve reconciliation ile güvenceye alan,
- erişilebilir, responsive, gözlemlenebilir ve geri alınabilir,
- kontrollü canary sonrasında piyasaya çıkmaya hazır

hale getirmektir.

Bu doküman yalnızca uygulama planıdır. Oluşturulduğu turda uygulama kodu, veritabanı, provider, deploy veya production ayarı değiştirilmemiştir.

## 2. Kapsam sınırı

### 2.1 Kapsam dahilinde

- Dashboard v2 shell ve Meta rail’i.
- Decisions.
- Account Intelligence.
- Creative Studio:
  - Assets
  - Copies
  - Landing Pages
  - Inbox
  - Audiences
  - Briefs
  - Shares
  - Creative Detail
- Launchpad.
- Automation.
- History.
- Meta bağlantısı ve provider-account ataması; tüm Meta yüzeylerinin upstream ön koşulu olduğu için.
- Public Creative Share; Shares akışının dış kullanıcıya çıkan production sonucu olduğu için.
- Meta yüzeylerinin route, account, time-window, state, mutation, telemetry, responsive, accessibility ve release sözleşmeleri.

### 2.2 Kapsam dışında

- Google Ads sayfalarının yeniden tasarlanması.
- Yeni ürün navigasyon paradigması.
- Dashboard v2 dışı geniş tasarım yenilemesi.
- Creative decision resolver matematiğinin yeniden icadı.
- Yeni standalone decision core.
- Tasarımın yönünü değiştirecek mobile redesign.
- Bu plan dışında yeni provider veya yeni modül eklenmesi.

Google Ads yalnız şu güvenlik kuralı açısından kapsam içindedir: Meta Stop veya başka bir Meta kontrolü Google Ads yazmalarını durdurduğunu söyleyemez ve durduramaz.

## 3. Otorite sırası

Çelişki halinde aşağıdaki öncelik sırası uygulanır:

1. Görsel otorite:
   /Users/harmelek/Downloads/Dashboard tasarımı yenileme/Adsecute Dashboard v2.dc.html

   SHA-256:
   2af6cbaf5f366a7dee8fc0ae96fdf713eff777c62f16e2d57638368d1678637a

2. Decision ve data otoritesi:
   - docs/creative-decision-center/DECISION_LOG.md
   - docs/creative-decision-center/DATA_READINESS.md
   - docs/creative-decision-center/GOLDEN_CASES.md
   - docs/creative-decision-center/INVARIANTS.md

3. Davranışsal sözleşme:
   docs/zero-base-design/v3 altındaki vendored capability ve invariant paketi.

4. Runtime otoritesi:
   Gerçek production route’unun mount ettiği component ve server read/write modeli.

5. Route ve navigasyon otoritesi:
   WP2’de oluşturulacak tek semantic surface registry.

### 3.1 Yasak otorite kullanımları

- Eski d65c0117871aa392fb2f93e79d02540f6538be6a00b1d2ecea03bdd9f8432193 hash’i güncel görsel otorite sayılamaz.
- Vendored paket elle değiştirilerek audit sonucu yeşile çevrilemez.
- Test harness’ının render ettiği component, production route’unda mount edilmiyorsa runtime otoritesi sayılamaz.
- UI, server tarafından verilmemiş buyerAction veya karar otoritesi üretemez.

## 4. Kanıt sınıfları

Her PR ve acceptance raporu bulgularını şu şekilde etiketlemelidir:

- VERIFIED-STATIC:
  Aynı commit üzerinde dosya, import graph, route, schema veya test ile doğrudan kanıtlandı.
- VERIFIED-RUNTIME:
  Gerçek mounted route, authenticated session ve gerçek payload ile kanıtlandı.
- VERIFIED-PROVIDER:
  Provider’dan bağımsız GET/read-back ile kanıtlandı.
- INFERENCE:
  Koddan güçlü biçimde çıkarıldı fakat runtime doğrulanmadı.
- UNKNOWN:
  DB, credential, provider veya hosted runtime gerektiriyor.

UNKNOWN bir bulgu DONE veya READY kabul edilemez.

## 5. Mevcut durum özeti

### 5.1 Statik olarak doğrulanan kritik sorunlar

1. Decisions, Automation, Launchpad ve Creative Studio için hazırlanmış bazı zero-base gövdeler yalnız harness/test içinde render ediliyor. Gerçek route’lar farklı legacy/V2 gövdeleri mount ediyor.
2. Mevcut visual, a11y ve fidelity kapılarının bir bölümü kullanıcının gördüğü gerçek DOM’u ölçmüyor.
3. Intelligence ve History route desteği bulunmasına rağmen rail, active state ve command palette sözleşmeleri eksik.
4. History route’u Decisions satırını aktif gösterebiliyor; Intelligence hiçbir child satırı aktif göstermiyor.
5. /platforms/meta/audiences için generated contract ile compatibility yönlendirmesi birbiriyle çelişiyor.
6. Çoklu hesapta provider account seçimi zorunlu olabiliyor fakat Intelligence ve Creative ailesi ortak picker sunmuyor.
7. Topbar’daki tarih seçici, tarih aralığını kullanmayan Automation ve bazı kontrol ekranlarında aktif görünerek yanlış bağlam oluşturuyor.
8. ADR-D070 Proposed durumunda; buna rağmen UX remediation ledger onu çözülmüş otorite gibi kullanıyor.
9. Automation approve akışı gerekli persisted control bulunmadığında 503 veya dry-run sonucuna düşüyor.
10. Mounted Automation gövdesinde gerçek Meta Stop engage/release kontrolü bulunmuyor.
11. Automation kopyası Meta kontrolünü global/every-provider kontrolü gibi anlatıyor; Google Ads etkilenmiyor.
12. Launchpad’in eski sözleşmesi execution’ı kalıcı kapalı tarif ederken mounted V2 gövdesi gerçek create endpoint’lerini çağırabiliyor.
13. Creative Engine V3 shadow kararları otorite gibi sunulabiliyor.
14. Decisions workflow ve mutation ceremony endpoint’leri bulunmasına rağmen production gövdede tam tüketilmiyor.
15. Shares istemcisi data.shares okurken API grants ve capability döndürüyor.
16. Shares create payload’ı geçersiz audience veya boş creative seçimi üretebiliyor.
17. Briefs istemcisi servis edilen MetaCreativeBrief alanlarıyla tam uyuşmuyor.
18. History replay, actor, outcome, entity-type ve provenance anlamlarında kayıplar var.
19. Server-side mutation preflight bazı noktalarda client kill-switch verisine güveniyor.
20. Sözleşmeli Meta telemetry event’lerinin önemli kısmı emit edilmiyor.

### 5.2 Runtime doğrulaması bekleyen alanlar

- Gerçek authenticated 0/1/N Meta hesabı.
- Production-read-only DB şeması ve query planları.
- Source freshness ve provider ID normalizasyonu.
- Meta provider mutation/read-back.
- Public share token yaşam döngüsü.
- Gerçek hosted responsive, a11y ve performans.
- Rollback ve reconciliation runbook’ları.

## 6. Bağlayıcı ortak kararlar

### D1 — Görsel yön kilitli

Dashboard v2 görsel dili korunacaktır.

İzin verilen mikro değişiklikler:

- eksik rail satırı,
- active-state,
- mevcut context alanında picker,
- loading, empty, partial, degraded, refused ve error state,
- yanlış veya riskli mikro metin,
- focus, aria, kontrast,
- responsive overflow ve içerik erişilebilirliği,
- mevcut butonda disabled-with-reason.

Yasak değişiklikler:

- yeni layout,
- yeni card/grid sistemi,
- farklı navigasyon hiyerarşisi,
- yeni tasarım dili,
- görsel kaynağın yeniden yorumlanması.

### D2 — Production gövdeleri görsel owner kalır

Wholesale zero-base mount yapılmayacaktır.

- Decisions:
  components/meta/redesign/MetaPlatformPage.tsx görsel owner.
- Intelligence:
  mevcut mounted intelligence-view görsel owner.
- Creative Studio:
  components/creatives/CreativeStudioExact.tsx görsel owner.
- Launchpad:
  app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx ve components/launchpad altı görsel owner.
- Automation:
  app/(dashboard)/platforms/meta/automation/automation-view.tsx görsel owner.
- History:
  mevcut mounted history-view görsel owner.
- Briefs, Shares ve Detail:
  mevcut mounted zero-base gövdeler korunur.
- Shell:
  UnifiedDashboardClientShell ve DashboardFrame korunur.

Ölü bileşenlerdeki doğru davranışlar bu owner’lara port edilir.

### D3 — Nihai Meta rail’i

Rail aynı Meta grubu ve aynı satır stili içinde altı görünür giriş taşır:

1. Decisions
2. Account Intelligence
3. Creative Studio
4. Launchpad
5. Automation
6. History

Creative Studio içinde:

1. Assets
2. Copies
3. Landing Pages
4. Inbox
5. Audiences

Briefs, Shares ve Detail bu hub’ın bağlı alt yüzeyleri olarak kalır.

### D4 — Navigasyon adapter’ı korunur

components/layout/nav-items.ts V2 rail adapter’ı olarak kalır.

lib/zero-base/navigation.ts runtime rail renderer olarak kullanılmaz. Cross-contract testinde semantic oracle olarak kullanılır.

### D5 — Audiences resmi yönlendirmesi

/platforms/meta/audiences resmi olarak Creative Studio Audiences’a yönlenir.

Intelligence kendi canonical route’unu kullanır.

### D6 — Tek fiziksel provider account

Hesap-scoped yüzeyler tek bir fiziksel Meta hesabı olmadan veri sunmaz.

- 0 hesap:
  bağlantı/atama gerekli.
- 1 hesap:
  otomatik seçilebilir.
- N hesap:
  geçerli açık seçim zorunlu.
- null:
  seçilmedi; asla tüm hesaplar değil.
- geçersiz veya revoked seçim:
  sessiz fallback yok.

providerAccountId tek canonical parametre adıdır.

### D7 — Üç ayrı zaman kavramı

1. Reporting window.
2. Decision as-of.
3. Current provider state.

Bu üç kavram birbirinin yerine kullanılamaz.

### D8 — Eksik veri sıfır değildir

Bozuk, yetkisiz, eksik veya şeması hazır olmayan kaynak:

- boş liste,
- 0,
- —,
- success

olarak gösterilemez.

### D9 — Launchpad nihai posture

Nihai hedef:

- feature-gated gerçek execution,
- yalnız PAUSED create,
- ayrı activation,
- ayrı confirmation,
- receipt,
- provider read-back,
- ambiguity-safe reconciliation.

WP15 tamamlanana kadar execution kontrolleri disabled-with-reason kalır.

### D10 — Automation posture

- Meta Stop yalnız Meta writes kapsamındadır.
- Google Ads writes etkilenmez.
- Dry-run varsayılan TRUE’dur.
- Canlı Automation execution ancak audited admin ayarı, persisted guardrail ve ayrı release gate sonrasında açılır.
- Engage/release reversibility kanıtlanmadan stop UI aktif edilmez.

### D11 — Decision core korunur

- Yeni standalone decision core yok.
- UI buyerAction hesaplamaz.
- Row-level brief_variation yok.
- Missing data yüksek güvenli scale/cut üretmez.
- Policy ve delivery blocker performans kararını geçersiz kılabilir.
- Resolver değişikliği gerekiyorsa ADR, Golden Cases, replay ve rollback ayrı çalışma olur.

### D12 — Integrations ve Public Share zorunlu release dependency

Meta account assignment upstream; Public Share downstream production akışıdır. İkisi doğrulanmadan Meta paketi market-ready sayılamaz.

### D13 — 320/390px erişilebilirlik release kapısı

Mobile tasarım yönü değiştirilmeyecektir. Ancak gerçek içerik 320 veya 390 pikselde gizlenemez, erişilemez veya clip olamaz. Bunu düzeltmek mikro responsive çalışma sayılır.

### D14 — Market-ready, test-green demek değildir

Gerçek mounted route, authenticated scope, gerçek payload, gerektiğinde provider read-back ve rollback birlikte kanıtlanmadan READY denemez.

## 7. Ortak scope modeli

### 7.1 Business scope

- Tek server otoritesi requireBusinessPageContext veya eşdeğer güvenli access resolver’dır.
- URL’deki businessId doğrudan güvenilmez.
- /app ikizleri business bilgisini session.activeBusinessId üzerinden alır.
- Client query parametresi business yetkisi üretemez.
- Uyuşmazlık MetaBusinessScopeRefusal veya eşdeğer dürüst refusal state üretir.

### 7.2 Provider-account scope

- Tek otorite resolveProviderAccountId.
- Provider hesabı business’a atanmış olmalı.
- Seçim canonical Meta ID’ye normalize edilmeli.
- act_ prefix farkı Meta sınırında tek forma dönüştürülmeli.
- Tüm query cache key’leri en az:
  - businessId
  - providerAccountId
  - window veya event range
  içermeli.
- Hesap değişiminde:
  - selected entity,
  - inspector,
  - drawer,
  - handoff token,
  - stale query data
  temizlenmeli.

### 7.3 Role ve posture

Tüm yüzeyler şu rollerde test edilir:

- guest
- reviewer
- collaborator
- admin
- owner
- demo

Reviewer ve demo posture yalnız UI’da değil server mutation katmanında da uygulanır.

## 8. Zaman ve evidence modeli

### 8.1 Route capability sınıfları

#### metric_window

- Decisions metrics.
- Creative Assets.
- Creative Copies.
- Creative Landing Pages.
- Creative Audiences.

#### event_window

- Creative Inbox.
- History.

#### current_state

- Integrations.
- Automation control state.
- Launchpad library/control state.
- Shares ledger.

#### mixed

- Intelligence; her kaynak kendi evidence aralığını taşır.
- Decisions; metric window ve decision as-of ayrıdır.
- Launchpad; candidate evidence ve current provider target state ayrıdır.
- Creative Detail; frozen decision evidence ve current presentation enrichment ayrıdır.

### 8.2 Topbar kuralı

- metric_window veya event_window:
  picker aktiftir.
- current_state:
  picker disabled/annotated; tarih aralığının uygulanmadığı yazılır.
- mixed:
  picker yalnız etkilediği bölüm için aktiftir ve diğer as-of/current-state zamanı ayrı gösterilir.

### 8.3 Freshness

Her payload şu kanıtları taşır:

- sourceUpdatedAt
- snapshotAt
- observedAt
- freshness
- failureCode
- window
- decisionAsOf, uygulanıyorsa

Meta yüzeyinin freshness’i Google veya başka provider’ın daha taze timestamp’inden üretilemez.

## 9. Ortak read-state sözleşmesi

Her read yüzeyi aşağıdaki state’lerden tam olarak birini sunar:

1. loading
   - İlk yükleme.
   - V2 skeleton.
   - Boş liste gösterilmez.

2. refreshing-with-stale
   - Eski veri görünür kalır.
   - Updating etiketi gösterilir.

3. success
   - Kullanılabilir kanıtlı veri.

4. empty-proven
   - Başarılı okuma ve gerçekten sıfır satır.
   - Window/account bağlamıyla açıklanır.

5. partial
   - Bazı kaynaklar eksik veya cap uygulanmış.
   - Served subset açıkça yazılır.

6. degraded
   - Schema, permission, migration, source veya evidence sorunu.
   - Unavailable sebebi gösterilir.

7. refused
   - Auth, reviewer, demo, kill-switch veya scope refusal.
   - Tıklamadan önce görünür.

Ek mutation state’leri:

- validating
- awaiting-confirmation
- executing
- provider-response-received
- readback-pending
- verified
- refused
- failed-definite
- ambiguous-reconciliation-required

### 9.1 Failure-code sözlüğü

En az:

- provider_account_not_assigned
- provider_account_scope_unverified
- account_required
- reviewer_read_only
- demo_business_read_only
- supervision_state_unavailable
- kill_switch_engaged
- kill_switch_release_preflight_failed
- schema_not_ready
- capability_read_denied
- execution_limit_exceeded
- bulk_cap_exceeded
- invalid_payload
- expectedVersion_conflict
- handoff_refused
- source_read_failed
- provider_rate_limited
- provider_auth_expired
- provider_outcome_ambiguous
- reconciliation_required

Yeni failure code eklenen PR aynı kodun kullanıcı mesajını ve testini de içermelidir.

## 10. Ortak mutation güvenliği

Her Meta write aşağıdaki sırayı izler:

1. Exact business access.
2. Exact physical provider account.
3. Exact role ve demo/reviewer posture.
4. Explicit action origin:
   - native decision
   - manual operator
   - Launchpad
5. Exact target identity:
   - provider account
   - campaign
   - ad set
   - ad
   - creative
   gerekli olanların tümü.
6. Fresh provider GET veya kanıtlanmış current-state read.
7. Parent hierarchy ve policy kontrolü.
8. Server-side kill-switch/read-only kontrolü.
9. Persisted preflight.
10. Preflight yaşı ve did not contact Meta açıklaması.
11. Typed veya explicit confirmation.
12. Durable idempotency claim.
13. En fazla bir provider POST.
14. Immutable attempt/receipt.
15. Bağımsız provider GET read-back.
16. Exact identity ve state doğrulaması.
17. Durable terminal receipt veya reconciliation marker.
18. Rollback/compensation kaydı.

### 10.1 Değişmez kurallar

- Client kill-switch değeri server otoritesi değildir.
- Provider create/duplicate POST otomatik retry edilmez.
- GET-only doğrulama bounded retry kullanabilir.
- Aynı idempotency key ikinci provider write üretemez.
- Belirsiz sonuç success veya definite failure olarak uydurulamaz.
- Pending reconciliation aynı entity için sonraki write’ları bloklar.
- Provider’ın 200 cevabı read-back değildir.
- Receipt persist edilemediyse write verified sayılamaz.
- Bulk akış tüm target preflight’larını ilk POST öncesi tamamlar.

## 11. Surface/body/scope/action matrisi

| Yüzey | Canonical route | Mounted görsel owner | Scope | Zaman | Write posture |
|---|---|---|---|---|---|
| Decisions | /c/[businessId]/meta/decisions | MetaPlatformPage | Tek Meta hesabı | metric window + decision as-of | Workflow + guarded manual action |
| Intelligence | /c/[businessId]/meta/intelligence | intelligence-view | Tek Meta hesabı | mixed/per-source | Internal snapshot/respond; role-gated |
| Creative Assets | /c/[businessId]/creative/performance | CreativeStudioExact | Tek Meta hesabı | metric window | Read-only |
| Creative Copies | /c/[businessId]/creative/copies | CreativeStudioExact | Tek Meta hesabı | metric window | Read-only |
| Landing Pages | /c/[businessId]/creative/landing-pages | CreativeStudioExact | Tek Meta hesabı | metric window | Read-only |
| Inbox | /c/[businessId]/creative/inbox | CreativeStudioExact | Tek Meta hesabı | event window | Workflow action |
| Audiences | /c/[businessId]/creative/audiences | CreativeStudioExact | Tek Meta hesabı | metric window | Read-only |
| Briefs | /c/[businessId]/creative/briefs | mounted studio client/view | Tek Meta hesabı | source snapshot | Brief lifecycle |
| Shares | /c/[businessId]/creative/shares | mounted studio client/view | Business + source account | current ledger + frozen source window | Mint/rotate/revoke/delete |
| Public Share | /share/creative/[token] | PublicSharePage | Token-safe public projection | frozen snapshot | Message/CSV capability-gated |
| Creative Detail | /c/[businessId]/creative/[creativeId] | mounted detail client | Tek Meta hesabı | mixed | Read-only/action handoff |
| Launchpad | /c/[businessId]/meta/launchpad | legacy V2 Launchpad | Tek Meta hesabı | mixed | Default disabled; gated PAUSED create |
| Automation | /c/[businessId]/meta/automation | automation-view | Tek Meta hesabı | current state | Dry-run default; Meta-only guarded writes |
| History | /c/[businessId]/meta/history | history-view | Tek Meta hesabı | event window | Read-only/replay |
| Integrations | /c/[businessId]/manage/integrations | IntegrationsExact | Business/provider assignment | current state | Connect/assign/revoke |

## 12. İş paketleri

Her iş paketi ayrı, küçük ve geri alınabilir PR olmalıdır.

### WP0 — Baseline, dirty-tree ve authority reconciliation

Amaç:

- Uygulamanın başlayacağı exact repo ve tasarım tabanını sabitlemek.
- Mevcut kullanıcı/Claude çalışmalarını korumak.
- Ratify edilmemiş kararlarla kod yazılmasını engellemek.

Yapılacaklar:

1. git status, HEAD ve mevcut diff snapshot’ı kaydedilir.
2. Mevcut Creative Share/Public Share değişiklikleri ayrı commit, branch veya açık patch olarak korunur.
3. 2af6... görsel hash’i güncel source authority olarak kaydedilir.
4. Eski d65c... hash’i kullanan current-authority belgeleri güncellenir; tarihsel kayıtlar old/superseded olarak etiketlenir.
5. ADR-D070 Accepted yapılır ve DECISION_LOG’a eklenir.
6. Launchpad execution posture ADR’si kabul edilir.
7. Audiences destination ADR’si kabul edilir.
8. Visual authority ile vendored behavioral authority arasındaki precedence yazılır.
9. Vendored dosyalar elle değiştirilmez; re-vendor veya ACCEPTED_RESIDUALS kullanılır.

Bağımlılık:

- Yok.

Acceptance:

- Exact HEAD ve source hash kanıtı.
- ADR’ler numaralı ve Accepted.
- Contract verifier sonucu dürüstçe raporlanıyor.
- Kirli Share çalışması kaybolmadı.

Rollback:

- Doküman-only revert.

### WP1 — Güvenli ve dürüst interim posture

Amaç:

- Bugün çalışıyor gibi görünen fakat güvenli olmayan yolları yalan söylemeden kapatmak.

Yapılacaklar:

1. Launchpad Create PAUSED ve Add to existing kontrolleri disabled-with-reason olur.
2. Draft, template, intent ve validate çalışmaya devam eder.
3. Server routes savunma katmanı olarak kalır.
4. Bulk cap UI’da görünür.
5. Automation Global writes metni Meta writes olarak düzeltilir.
6. No control stops Google Ads writes metni birebir görünür.
7. dryRunOnly gerçek değeri görünür.
8. Approve dry-run ise nothing was sent to Meta denir.
9. Authority/control-plane read hataları doğru failure-code mesajına bağlanır.

Temel dosyalar:

- app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx
- components/launchpad/*
- app/(dashboard)/platforms/meta/automation/automation-view.tsx
- lib/zero-base/launchpad/launchpad-contract.test.ts

Acceptance:

- Yeni provider write eklenmedi.
- Launchpad validate green, execution disabled.
- Automation hiçbir metinde Google kontrolü ima etmiyor.
- Disabled sebebi klavye ve ekran okuyucu için erişilebilir.

Rollback:

- Surface-local feature flag/revert.

### WP2 — Canonical surface registry, nav ve route sözleşmesi

Amaç:

- Leaf, route, nav, active-state, command palette ve mounted body drift’ini tek kaynakla engellemek.

Registry alanları:

- surfaceId
- label
- role
- canonicalRoute
- aliases
- legacyRedirect
- mountedBody
- providerAccountCapability
- windowCapability
- actionCapability
- requiredPlan
- activeHrefs

Yapılacaklar:

1. Intelligence ve History mevcut Meta grubuna eklenir.
2. History, Decisions activeHrefs listesinden çıkarılır.
3. Screen registry Intelligence ve History’yi tanır.
4. Route family ve platform family iki ekranı tanır.
5. Command palette rail adapter’dan doğru hedefleri alır.
6. /platforms/meta/audiences Creative Audiences’a gider.
7. Intelligence canonical route’u ayrı tanımlanır.
8. navigation.ts oracle olur; renderer olmaz.

Acceptance:

- Altı rail girişi.
- Beş Creative sekmesi.
- Canonical, /app ve legacy alias yollarında doğru active-state.
- Tüm navigable leaf’ler erişilebilir.
- Sıfır 404.
- Görsel rail hiyerarşisi ve row stili değişmedi.

Rollback:

- Nav commit’i tek başına geri alınabilir.

### WP3 — Integrations ve provider-account assignment

Amaç:

- Meta yüzeylerinin dayandığı bağlantı ve hesap atamasını production-ready yapmak.

Yapılacaklar:

1. Meta connect, callback, status, ad-account discovery ve assignment zinciri incelenir.
2. Tenant access ilk kontrol olur.
3. Current connection generation doğrulanır.
4. Fresh successful discovery snapshot aynı credential generation’a bağlı olmalıdır.
5. Account ID’leri canonical forma normalize edilir.
6. Ambiguous veya duplicate spelling reddedilir.
7. Assignment transaction içinde exact read-back yapılır.
8. Scheduling sonucu selectionSaved ve syncScheduled olarak ayrı raporlanır.
9. Reconnect/refresh yarışı CAS ve lock ile fail-closed olur.
10. Empty selection güvenli revocation olarak çalışır.
11. Demo flow gerçek bağlantı/atama gibi raporlanmaz; demo ve persisted=false açıkça döner.
12. Permission, expired token, stale snapshot, scheduling failure ve schema error boş connected state’e düşmez.

Temel dosyalar:

- app/c/[businessId]/manage/integrations/page.tsx
- app/(dashboard)/integrations/legacy-page.tsx
- components/integrations/IntegrationsExact.tsx
- components/integrations/provider-assignment-drawer.tsx
- lib/provider-account-assignments.ts
- lib/provider-assignment-service.ts
- app/businesses/[businessId]/meta/assign-accounts/route.ts
- app/integrations/meta/ad-accounts/route.ts

Acceptance:

- Authenticated 0/1/N account akışları.
- Stale snapshot, reconnect race, revoked credential, duplicate ID ve scheduling failure testleri.
- Assignment sonrası tüm Meta yüzeyleri aynı canonical hesabı görür.
- Gerçek DB read-only schema ve selection readback kanıtı.

Rollback:

- UI assignment gate kapanabilir; server authorization ve validation kalır.

### WP4 — Shell ve provider-account authority

Amaç:

- account_required dead-end’ini kaldırmak ve her yüzeyi tek scope modeline taşımak.

Yapılacaklar:

1. providerAccountId tek param adı olur.
2. accountId geriye dönük alias olarak kısa süre kabul edilir ve deprecation log üretir.
3. Ortak picker mevcut context slot’una yerleştirilir.
4. Intelligence ve tüm Creative yüzeyleri picker kullanır.
5. 0/1/N semantiği uygulanır.
6. Invalid/revoked account sessiz başka hesaba düşmez.
7. Hesap değişiminde entity ve handoff state’i temizlenir.
8. Business/account/window cache key’lere girer.
9. Reviewer ve demo posture shell genelinde görünür.
10. /app layout rollout flag’in gerçek değerini kullanır.
11. Workspace switch membership listesini replace etmek yerine merge eder.

Acceptance:

- 0/1/N × tüm surface × role matrisi.
- account_required state’inden seçimle çıkılabiliyor.
- Hesap değişiminde cross-account data görünmüyor.
- ZERO_BASE_UI_MODE off, allowlist ve on senaryoları /c ve /app yollarında çalışıyor.

Rollback:

- Picker ve context bar ayrı gate’lere sahip olabilir.

### WP5 — Reporting window, as-of ve freshness authority

Amaç:

- Ekrandaki tarih/freshness metninin gerçekten servis edilen veriyi anlatmasını sağlamak.

Yapılacaklar:

1. Tüm ilgili route’lar windowFromSearchParams veya tek eşdeğer parser kullanır.
2. Previous period seçili gün sayısından hesaplanır.
3. Spend today, CTR 28d ve benzeri sabit metinler kaldırılır.
4. Custom aralık açık startDate → endDate gösterir.
5. Decisions metric window ve decision as-of’u ayrı render eder.
6. Intelligence her bölümün kendi evidence penceresini taşır.
7. Launchpad farklı candidate/current-state pencerelerini ayrı açıklar.
8. Automation ve current-state ekranlarında date picker uygulanmıyor notu bulunur.
9. Freshness yalnız ilgili provider’dan türetilir.
10. Currency ve timezone configured-only, unknown, missing ve proven durumlarını ayırır.

Acceptance:

- 7d, 28d, today ve custom için URL → server payload → label eşitliği.
- Gerçek hesapta window geçişi ekran kaydı.
- Yanlış sabit gün etiketi yok.
- Timezone missing iken UTC tahmini yok.

Rollback:

- Route bazlı.

### WP6 — Ortak response/state contract ve data readiness

Amaç:

- Server ile istemcinin aynı veri, capability ve failure modelini konuşmasını sağlamak.

Standart response envelope:

- scope
- evidence
- data
- capability
- permissions
- failure

Yapılacaklar:

1. Yedi read state tüm yüzeylerde aynı semantiğe taşınır.
2. Failure-code sözlüğü merkezileştirilir.
3. API ve client response key aynı contract testinde doğrulanır.
4. Missing schema 200+empty üretmez.
5. Provider permission failure boş listeye dönüşmez.
6. Source freshness ve partial coverage payload’a girer.
7. Additive migrations from-zero ve upgrade yollarında test edilir.
8. V1/operator/V2 snapshot compatibility korunur.
9. meta_entity_state_history query planı, index, retention ve kapasite ölçülür.
10. 30/90 günlük büyüme forecast’i çıkarılır.
11. Blind cap increase veya destructive cleanup yapılmaz.

Acceptance:

- Contract tests.
- Real DB read-only.
- Migration from-zero ve upgrade.
- Query plan/capacity raporu.
- Unsupported window ve unavailable source açık state.

Rollback:

- Additive migration forward-compatible; reader eski alanları toleranslı okur.

### WP7 — Ortak mutation safety foundation

Amaç:

- Decisions, Automation ve Launchpad’in aynı güvenli write sözleşmesini kullanması.

Yapılacaklar:

1. Server business/account/role/demo/reviewer/kill-switch/freshness doğrular.
2. Exact action origin zorunlu olur.
3. Exact provider identity ve active parent hierarchy doğrulanır.
4. Persisted preflight ve age görünür olur.
5. Typed confirmation uygulanır.
6. Durable idempotency claim yazılır.
7. Provider POST en fazla bir kez yapılır.
8. Immutable attempt/receipt tutulur.
9. Provider GET read-back yapılır.
10. Ambiguous outcome reconciliation’a park edilir.
11. Pending reconciliation sonraki write’ları engeller.
12. UI feature flag kapansa da server guard’ları kalır.

Acceptance:

- Guarded sandbox matrisi:
  - wrong tenant
  - wrong account
  - reviewer
  - demo
  - kill switch
  - stale preflight
  - duplicate idempotency
  - 429
  - 5xx
  - network ambiguity
  - receipt persistence failure
  - read-back mismatch
- İkinci aynı-key POST provider’a gitmez.

Rollback:

- Her write family için ayrı flag.

### WP8 — Decisions

Amaç:

- Mevcut V2 Decisions gövdesini gerçek workflow ve güvenli action davranışıyla tamamlamak.

Yapılacaklar:

1. assign
2. acknowledge
3. defer
4. snooze
5. reject
6. resolve
7. reopen

expectedVersion ile optimistic conflict korunur.

Ek olarak:

- mutation ceremony port edilir,
- preflight route gerçek caller alır,
- read-age chip ve did not contact Meta gösterilir,
- bidConfiguration ve entity facts görünür,
- blocker/shield chip slice ile düşürülemez,
- thumbnails ve exact IDs gösterilir,
- lane empty state dürüst olur,
- selected window ve decision as-of ayrılır,
- Decisions label writer kaldırılır,
- UI buyerAction hesaplamaz.

Acceptance:

- Workflow state-machine testleri.
- expectedVersion conflict integration.
- Existing Golden Cases ve invariants.
- Gerçek decision üzerinde acknowledge → defer → resolve.
- Blocker öncelik golden test.

Rollback:

- META_DECISION_WORKFLOW_UI.

### WP9 — Account Intelligence

Amaç:

- Düz sayaç listesini sözleşmeli ve kanıtlı intelligence panellerine dönüştürmek; mevcut V2 kart dilini korumak.

Dokuz bölüm:

1. Top creatives.
2. Breakdowns.
3. Anomalies.
4. Page status.
5. Warehouse campaigns.
6. Structure configuration.
7. Recommendations/respond.
8. Lane classify.
9. Snapshot/run-now.

Kurallar:

- Her bölüm ya veri ya açık unavailable sebebi gösterir.
- Ham Error.message basılmaz.
- Rejected kaynak served sayılmaz.
- Her bölüm own evidence window/freshness taşır.
- Account picker olmadan account-scoped veri gösterilmez.
- Respond ve run-now role/capability gate kullanır.

Acceptance:

- 9 bölüm × 7 read state.
- Gerçek hesap render kaydı.
- Failure-code ve source-count doğruluğu.

Rollback:

- Bölüm bazlı gate.

### WP10 — Creative Studio core

Amaç:

- Beş ana sekmenin gerçek backend kontratlarıyla aynı V2 gövdesinde çalışması.

Yapılacaklar:

1. Assets.
2. Copies.
3. Landing Pages.
4. Inbox.
5. Audiences.

Ek kurallar:

- Engine posture hidden, shadow-only veya authoritative olarak çözülür.
- Shadow decision authority gibi gösterilmez.
- CREATIVE action filter davranışı mevcut toolbar’a port edilir.
- Inbox event window kullanır.
- Data-grain ve benchmark provenance görünür.
- Account required state çözülebilir.
- Audiences canonical destination olur.
- Row-level brief_variation yok.

Acceptance:

- Beş sekme account/window/state matrisi.
- Shadow posture’ın sekiz kombinasyonu.
- Sekme geçişinde cache/scope sızıntısı yok.
- Gerçek mounted route screenshot ve payload eşleşmesi.

Rollback:

- Sekme bazlı.

### WP11 — Briefs, Shares ve Public Share

Amaç:

- İç paylaşım ledger’ını ve dış public snapshot’ı eksiksiz ve privacy-safe yapmak.

Shares:

1. Client grants alanını okur.
2. capability yüzeye taşınır.
3. canRead false degraded state üretir.
4. Create yalnız gerçek creative seçimi ve geçerli SHARE_AUDIENCES değeriyle açılır.
5. Dialog varsayılan kapalıdır.
6. Mint, list, rotate, revoke ve delete çalışır.

Briefs:

1. MetaCreativeBrief alanları doğru adapter ile eşlenir.
2. sourceDecision.creativeId ve providerAccountId korunur.
3. Başlık servis edilen gerçek alandan gelir.
4. keep/change/next içeriği korunur.
5. Synthetic lineage uydurulmaz.

Public Share:

1. Internal ID, workspace adı, contact ve provider account dış payload’da bulunmaz.
2. Invalid, malformed, expired, revoked ve rotated-away token aynı unavailable görünümünü verir.
3. Cache-Control no-store.
4. robots noindex/nofollow.
5. CSV yalnız frozen snapshot’ta görünen alanları taşır.
6. Buyer-tier finansal veri strip edilir; strip hazır değilse tier disabled olur.
7. Media unavailable dürüst state gösterir.
8. Message endpoint rate-limit, length ve abuse guard kullanır.
9. Rotate old token’ı geçersiz kılar.
10. Revoke/delete exact business ve role guard kullanır.
11. Open tracking PII sızdırmaz.

Acceptance:

- Mint → list → public open → CSV → message → rotate → old-token unavailable → revoke.
- Token enumeration testi.
- Sanitized projection testi.
- Buyer-tier privacy testi.
- Reviewer/demo write refusal.
- Gerçek business runtime.

Rollback:

- Public mint feature gate kapanır.
- Var olan linkler revoke edilebilir kalır.

### WP12 — History

Amaç:

- Audit/history verisini anlam kaybı olmadan sunmak.

Yapılacaklar:

1. replayed ve reconstructed ayrılır.
2. Snapshot available doğru anlamda kullanılır.
3. decision_workflow_events entity_type sözleşmesine alınır.
4. observed outcome korunur.
5. not_applicable yalnız gerçek actor olmayan olaylarda kullanılır.
6. correlation, identity, provenance ve detail taşınır.
7. Config before/after görünür.
8. Beş outcome chip’i ayrı render edilir.
9. Entity ve kind filtreleri server’a gönderilir.
10. Empty state eklenir.
11. Snapshot tutulmadıysa açıkça yazılır.
12. event_date ve occurred_at semantiği birleştirilmez.

Acceptance:

- Real DB read-only olay ailesi sayımı.
- UI satır sayılarıyla DB eşleşmesi.
- Outcome/entity golden testleri.
- Replay etiketi yanlış kullanılan satır yok.

Rollback:

- Adapter-local.

### WP13 — Automation

Amaç:

- Automation’ı Meta-only, reversible ve dürüst bir control plane yapmak.

Yapılacaklar:

1. WP1 copy/posture kalır.
2. Meta Stop engage collaborator+.
3. Meta Stop release admin + taze persisted preflight.
4. Typed confirm.
5. POST sonucu success banner üretmez; read-back üretir.
6. decision-type mode selector eklenir.
7. Guardrail policy için audited admin writer oluşturulur.
8. dryRunOnly varsayılan TRUE.
9. Live automation ayrı gate ve canary olmadan açılamaz.
10. Proposal approve:
    - dry-run modunda gerçek dry-run receipt,
    - live modda ortak write safety,
    - eksik control’de typed refusal.
11. Google Ads unaffected copy sabit kalır.

Acceptance:

- Role matrix.
- Engage → read-back → release → read-back.
- Release reversibility aynı oturumda.
- Proposal dry-run receipt.
- Live mode yalnız explicit admin ve release gate ile.

Rollback:

- META_AUTOMATION_STOP_UI.
- META_AUTOMATION_LIVE_WRITES.
- Rollback runbook önce engaged stop’u release eder.

### WP14 — Launchpad read, draft ve validate

Amaç:

- Provider write açılmadan tüm hazırlık yolunu doğru ve kullanılabilir yapmak.

Yapılacaklar:

1. Recent actions response unwrap.
2. Capability unavailable state.
3. Picker response.ok kontrolü.
4. Pixel listesi boş gelince geçerli seçimi yanlışlıkla silmeme.
5. Draft update/delete caller’ları.
6. Bulk ve cardinality limitleri validate içinde.
7. Kill-switch refusal viewer envelope’a.
8. Current ads projection PAUSED varlıkları doğru sayar.
9. Candidate/current-state pencereleri ayrı gösterilir.
10. Receipt ve handoff state’leri validate aşamasında korunur.
11. Execution flag kapalı.

Acceptance:

- Draft create/edit/delete.
- Validate happy path.
- Over-limit refusal.
- Missing account/pixel/source.
- Revoked account.
- Kill-switch pre-click refusal.
- Sıfır provider POST.

Rollback:

- Surface-local.

### WP15 — Launchpad gerçek execution

Amaç:

- Tam güvenlik sonrasında PAUSED create ve ayrı activation.

Ön koşullar:

- WP0–WP14 DONE.
- Guarded sandbox green.
- Release authority onayı.
- Ayrılmış canary ad account.

Yapılacaklar:

1. META_LAUNCHPAD_EXECUTION varsayılan off.
2. Validate limits server ve UI aynı shared constant’tan.
3. Persisted preflight.
4. Read age.
5. Typed confirmation.
6. Durable idempotency.
7. Exact source account/creative/target validation.
8. Provider create bir kez.
9. Oluşan campaign/adset/ad ID lineage’ı receipt’e.
10. Provider GET read-back.
11. Sonuç yalnız PAUSED.
12. Ambiguous response reconciliation’a.
13. Automatic retry yok.
14. Activation ayrı permission, preflight, confirmation, receipt ve read-back.
15. Rollback/compensation receipt’ten entity listesi çıkarır.

Acceptance:

- Happy path.
- Over-limit.
- Reviewer/demo.
- Kill switch.
- Wrong account.
- Identity drift.
- Ambiguous response.
- Duplicate idempotency.
- Provider read-back mismatch.
- Tek PAUSED canary create.
- Activation ayrı test; production activation için ayrıca explicit approval.

Rollback:

- META_LAUNCHPAD_EXECUTION off.
- UI WP1 posture’una döner.
- Oluşturulmuş varlıklar PAUSED kaldığı için spend başlamaz.

### WP16 — Harness retargeting, contract closure ve ölü modül tasfiyesi

Amaç:

- Test edilen DOM ile kullanıcının gördüğü DOM’u aynı yapmak.

Yapılacaklar:

1. frame-registry ve shell harness gerçek mounted gövdeleri render eder.
2. Visual, a11y, responsive ve fidelity kapıları gerçek route’a hedeflenir.
3. Route/nav/body/API cross-contract gate CI’a eklenir.
4. Import graph AST veya module graph ile doğrulanır; grep tek başına yeterli değildir.
5. Port edilen ölü zero-base modüller _reference altına taşınır ve tsconfig’ten çıkarılır.
6. Bir stabil release sonrası silinir.
7. V1/operator/V2 snapshot compatibility migration olmadan silinmez.
8. H17 benzeri uydurma fixture fact’leri gerçek server şekline taşınır.
9. Vendored package aynı fingerprint ile re-vendor edilir.
10. REQ-27, REQ-28/M11 ve REQ-41 kapatılır.

Acceptance:

- Harness DOM ve gerçek route DOM diff sıfır.
- Dead module import edilirse typecheck kırılır.
- Contract verdict READY.
- Audit dosyası elle değiştirilmemiş.

Rollback:

- Harness ayrı commit.
- Module move/delete ayrı commit.

### WP17 — Telemetry, security, a11y, responsive ve performance

Amaç:

- Piyasaya çıkış için çapraz kalite kapılarını tamamlamak.

Telemetry:

- Her mounted Meta yüzeyi screen_view.
- Sözleşmeli 49 event emit veya explicit exemption.
- decision_opened ve decision_inspector_opened isimleri hizalı.
- Mutation lifecycle:
  - preflight
  - confirm
  - dispatch
  - response
  - readback
  - reconciliation
- account_required oranı.
- Source failure/freshness.
- Public share lifecycle.
- Reconciliation queue depth.

Security:

- Tenant isolation.
- Reviewer/demo server guard.
- CSRF.
- Rate limit.
- Token secrecy.
- PII-safe logs.
- Secret/token hiçbir client payload veya telemetry’ye girmez.

Accessibility:

- Keyboard-only.
- Focus order.
- Focus trap ve return focus.
- Semantic headings.
- Form labels.
- aria-live.
- Contrast.
- Reduced motion.
- Manual VoiceOver/NVDA veya eşdeğer.

Responsive:

- 1440
- 1024
- 768
- 390
- 320
- light
- dark

Hiçbir kritik bilgi veya kontrol clip/hide olamaz.

Performance hedefleri:

- LCP ≤ 2.5 saniye.
- CLS ≤ 0.1.
- Lab TBT ≤ 300 ms.
- İlk yükte duplicate/N+1 çağrı yok.
- İlk-load request bütçesi hedef olarak 12 veya altı; daha fazlası gerekirse belgeli istisna.
- p95 latency mevcut verified baseline’dan yüzde 10’dan fazla bozulamaz.

Acceptance:

- Gerçek mounted route kanıtı.
- Accessibility raporu ve manual check.
- Responsive screenshot matrisi.
- Performance trace.
- Telemetry event kaydı.

Rollback:

- Telemetry no-op olabilir.
- UI quality fix’leri surface-local revert edilebilir.

### WP18 — Staged release, canary ve rollback

Amaç:

- Exact build’i kontrollü biçimde production’a çıkarmak ve gerçek geri dönüşü kanıtlamak.

Release sırası:

1. Local static/unit/integration.
2. Ephemeral DB:
   - from-zero migration
   - upgrade migration
3. Authenticated staging.
4. Production-read-only internal kullanıcı.
5. Tek business allowlist, write kapalı.
6. En az 24 saat read-only canary.
7. Automation guarded sandbox.
8. Launchpad ayrılmış ad account’ta tek PAUSED write canary.
9. Provider read-back.
10. En az 72 saat post-release gözlem.
11. Sonra kontrollü geniş rollout.

Feature flag ayrımı:

- Dashboard v2 UI.
- Meta account picker/context.
- Decisions workflow.
- Automation stop UI.
- Automation live writes.
- Launchpad execution.
- Public share mint.

Deploy kuralları:

- Image main push üzerinden üretilir.
- Exact SHA deploy edilir.
- Bare docker compose up ile eski .env tag’ine dönülmez.
- Proje deploy wrapper’ı kullanılır.
- Canlı 503/404 için nginx per-route blokları kontrol edilir.
- meta_entity_state_history bütçesi deploy readiness öncesi ölçülür.

Acceptance:

- Exact SHA live build-info.
- Canary business doğrulaması.
- Write/read-back evidence.
- Rollback rehearsal.
- 72 saat SLO raporu.

## 13. Test matrisi

### T1 — Type/build quality

- typecheck
- lint
- unit tests
- integration tests
- production build

### T2 — Contract integrity

- zero-base contract verifier
- generated contracts check
- source fingerprint
- vendored integrity

### T3 — Cross-contract

Aynı test içinde:

- semantic leaf
- rail/nav
- screen ID
- route family
- mounted body
- account param
- window capability
- API response key
- client read key

### T4 — Route existence ve active-state

- Canonical route.
- /app alias.
- Legacy route.
- Command palette.
- Desktop rail.
- Mobile nav.

### T5 — State matrix

Her yüzey:

- loading
- refreshing
- success
- empty-proven
- partial
- degraded
- refused

### T6 — Scope matrix

- 0 hesap.
- 1 hesap.
- N hesap.
- Geçersiz seçim.
- Revoked seçim.
- Reconnect.
- Business switch.

### T7 — Role matrix

- guest
- reviewer
- collaborator
- admin
- owner
- demo

### T8 — Fault injection

- DB unavailable.
- Missing relation.
- Permission denied.
- Provider 401.
- Provider 403.
- Provider 409.
- Provider 429.
- Provider 5xx.
- Timeout.
- Stale source.
- Partial source.
- Ambiguous provider response.

### T9 — Real mounted visual/a11y/responsive/fidelity

Harness ve gerçek route aynı DOM owner’ını kullanmalıdır.

### T10 — Real DB read-only

- Schema.
- Migrations.
- Query plan.
- Source counts.
- Freshness.
- History event families.
- Retention/growth.

### T11 — Guarded write sandbox

- Decisions manual action.
- Automation engage/release.
- Automation proposal dry-run/live gate.
- Launchpad PAUSED create.

### T12 — Hosted canary

- Exact SHA.
- Real session.
- Real account.
- Provider read-back.
- Rollback.

## 14. Release kapıları

Sırayla tamamlanmalıdır:

1. WP0 ADR ve source kararları.
2. T1.
3. T2.
4. T3 ve T4.
5. T5–T7.
6. T8.
7. T9.
8. T10.
9. Write içeren yüzeylerde T11.
10. Launchpad için T12.
11. Rollback rehearsal.
12. 72 saat SLO gözlemi.

Bir önceki gate kapanmadan sonraki gate’e geçilemez.

## 15. Anlık rollback tetikleyicileri

Aşağıdakilerden biri oluşursa rollout durur ve ilgili flag kapanır:

1. Yanlış tenant verisi.
2. Yanlış Meta account verisi.
3. Account switch sonrası eski hesap verisi.
4. Receiptsiz write.
5. Provider read-back’siz success.
6. Ambiguous write’ın reconciliation’a park edilmemesi.
7. Reviewer veya demo write.
8. Kill-switch engage olup release edilememesi.
9. Meta Stop’un Google writes’i etkilemesi veya etkiliyormuş gibi görünmesi.
10. Missing/degraded verinin 0 veya success gibi sunulması.
11. account_required dead-end.
12. Window/as-of/freshness yanlış etiketi.
13. Nav sonrası 404 veya yanlış active-state.
14. Public share internal identifier veya finansal veri sızıntısı.
15. meta_entity_state_history growth fence.
16. Error veya latency p95’te kabul edilen baseline’a göre yüzde 10’dan fazla bozulma.

## 16. Post-release gözlem

En az:

- write error rate
- reconciliation queue depth
- account_required rate
- provider auth/permission failure rate
- snapshot freshness p95
- Decisions screen-view ve workflow completion
- Intelligence section availability
- History source/event family counts
- Launchpad validate refusal rate
- Automation engage/release success
- Public share mint/open/rotate/revoke errors
- meta_entity_state_history büyüme hızı
- LCP, CLS ve interaction latency

izlenir.

## 17. Kesinlikle yasak kestirmeler

1. Vendored paketi elle düzenlemek.
2. Audit sonucunu elle READY yapmak.
3. Wholesale zero-base mount.
4. nav-items.ts yerine navGroupsFor çıktısını doğrudan render etmek.
5. Yeni layout veya tasarım yönü.
6. Client guard’a güvenip server guard’ını kaldırmak.
7. guardrails_json içine sessiz default yazarak Automation’ı açmak.
8. WP7 bitmeden live write flag’i açmak.
9. WP15 bitmeden Launchpad execution açmak.
10. Provider create/duplicate POST otomatik retry.
11. null hesabı tüm hesaplar saymak.
12. Missing data’yı 0 saymak.
13. Test harness render’ını production kanıtı saymak.
14. Provider 200 cevabını read-back saymak.
15. Prod DB’ye doğrulama amaçlı yazmak.
16. Growth/retention sorununu satır silerek çözmek.
17. Dirty Share çalışmasını overwrite etmek.
18. Feature branch’ten production deploy.
19. Live dev server açıkken cache’i bozacak build çalıştırmak.
20. Ratify edilmemiş ADR’yi resolved saymak.

## 18. Owner ratification listesi

WP0’da yazılı hale getirilecek önerilen kararlar:

| Karar | Ortak öneri |
|---|---|
| Launchpad LAUNCH-06/07 | GATED; PAUSED create, activation ayrı |
| ADR-D070 | Accepted ve Decision Log’a ekli |
| Audiences destination | Creative Studio Audiences |
| Intelligence rail konumu | Meta grubunda Decisions sonrası |
| Meta Stop UI | Release reversibility sandbox’ta kanıtlanmadan kapalı |
| Decisions label writer | Decisions’tan kaldır |
| Görselde bulunmayan META-WRITE-01…05 | Yeni UI ekleme; absent-with-reason veya ayrı onaylı tur |
| History workflow entity_type | Sözleşmeye ekle |
| Ölü zero-base modüller | Bir release _reference, sonra sil |
| Buyer-tier financial share | Strip; mümkün değilse tier disabled |
| Mobile 320px | Görsel yön korunarak functional micro-fix zorunlu |
| History growth budget | Backfill öncesi ölçüm ve infra onayı |
| Reviewer/demo mutation guard | Tüm Meta server write route’larına ekle |
| Visual vs vendored authority | Visual dosya görünümü, vendored paket davranışı yönetir |

## 19. Market-ready tanımı

Bir yüzey ancak aşağıdakilerin tamamı varsa market-ready sayılır:

1. Gerçek authenticated kullanıcı.
2. Gerçek business.
3. Gerçek seçilmiş fiziksel provider account.
4. Birincil kullanıcı işi baştan sona tamamlanmış.
5. Ekrandaki her sayı ve etiket gerçek payload’la eşleştirilmiş.
6. Account, currency, timezone, window ve as-of kanıtlı.
7. Missing/degraded durumlar sebebiyle açıkça gösterilmiş.
8. Visible enabled her control gerçekten çalışıyor.
9. Unsupported control gizli veya disabled-with-reason.
10. Write varsa durable receipt.
11. Write varsa bağımsız provider read-back.
12. Ambiguous outcome reconciliation test edilmiş.
13. Reviewer/demo refusal server’da kanıtlanmış.
14. Rollback gerçek ortamda uygulanmış.
15. Mounted visual/a11y/responsive/performance gate’leri geçmiş.
16. Telemetry ve alerting çalışıyor.
17. Release SLO gözlem süresi tamamlanmış.

Yeşil test, yeşil typecheck, doğru screenshot veya başarılı deploy tek başına readiness kanıtı değildir.

## 20. Yeni uygulama chat’i için başlangıç talimatı

Aşağıdaki talimat yeni chat’in ilk mesajına eklenmelidir:

---

/Users/harmelek/Adsecute reposunda çalış.

Önce AGENTS.md ve docs/creative-decision-center/START_HERE.md dosyasındaki zorunlu okuma sırasını tamamla.

Bağlayıcı uygulama planı:

docs/meta-market-ready-master-plan-2026-08-22.md

Kurallar:

1. Önce yalnız WP0’ı uygula.
2. Mevcut dirty worktree ve Creative Share/Public Share değişikliklerini koru.
3. Görsel otorite SHA-256 2af6cbaf5f366a7dee8fc0ae96fdf713eff777c62f16e2d57638368d1678637a olan Dashboard v2 dosyasıdır.
4. Tasarım yönünü değiştirme.
5. Wholesale zero-base mount yapma; davranışları mevcut V2 production gövdelerine port et.
6. Her WP ayrı küçük PR/commit ve açık rollback taşısın.
7. Her WP sonunda:
   - değişen dosyaları,
   - static testleri,
   - gerçek runtime kanıtını,
   - DB/provider kanıtını,
   - rollback sonucunu,
   - kalan UNKNOWN noktaları
   raporla.
8. Bir WP’nin acceptance kanıtı olmadan sonraki WP’ye geçme.
9. Explicit approval olmadan production DB/provider write veya deploy yapma.
10. Test-green sonucunu market-ready olarak raporlama.

---

## 21. Başlangıç çalışma ağacı uyarısı

Plan hazırlanırken aşağıdaki mevcut değişiklikler bulunuyordu ve yeni uygulama chat’i bunları kullanıcı işi olarak korumalıdır:

- .gitignore
- app/(dashboard)/platforms/meta/creatives/legacy-page.tsx
- components/creatives/share/ShareSnapshotModal.module.css
- components/creatives/share/ShareSnapshotModal.tsx
- components/zero-base/creative/PublicSharePage.module.css
- components/zero-base/creative/public-share-page.test.tsx
- components/zero-base/creative/public-share-page.tsx
- lib/creative-share-store.test.ts
- lib/creative-share-store.ts
- lib/typography-floor.test.ts
- lib/zero-base/creative/public-share.ts
- docs/meta-design-backend-audit-2026-08-22.md
- docs/public-share-design-review-codex.md

Bu liste implementation başlangıcında yeniden git status ile doğrulanmalıdır; listedeki hiçbir değişiklik otomatik olarak reset, checkout veya overwrite edilemez.
