# Meta decision repair: local and provider readback (2026-09-21)

This is a pre-release observation record, not deployment or live acceptance.
Database queries were read-only; provider requests were GETs. Counts describe
the selected accounts and windows, not every Adsecute business.
Entries below are chronological: an early `NO_GO` describes the SQL and
evidence available at that point. Later successful reads supersede that
specific measurement only where they use the same bounded source path; they
do not turn this pre-release record into a completed release gate.

| Check | Observed result | Limit |
| --- | --- | --- |
| Spending campaign-days with missing warehouse objective, 2026-08-25 through 2026-09-20 | 20 distinct campaigns in 7 accounts | The affected active subset is 13; this count is not a global lifetime total. |
| Fresh campaign configuration for those 20 IDs | All 7 account requests completed and all 20 IDs were matched. The 13 currently active IDs returned 10 `OUTCOME_SALES`, one `OUTCOME_LEADS`, one `OUTCOME_ENGAGEMENT`, and one `OUTCOME_TRAFFIC`. | The response is a current observation. Each entity's `updated_time` was after the historical window start, so this does not assign its objective to every earlier report day. |
| Fresh adset configuration below the 20 campaigns | 201 adsets, with complete responses in all 7 accounts; `optimization_goal` and `start_time` were present on all 201. `bid_constraints` was absent on all 201 and is optional. | An absent bid target cannot be filled from purchase results or a business Target ROAS. |
| Config source failure | The campaign selector's `bid_constraints` expansion was rejected by the measured API with code 100. A field-isolation GET accepted the other campaign fields, including schedule and bid amount. | The repaired selector and raw-to-DB path still require an integrated release and readback. |
| Retained config-request degradation, read-only 2026-07-01 through 2026-09-20 | Among fetched HTTP-200 observation rows, 41,444 `campaign_configs` and 67,174 `adset_configs` had a recorded selector and none recorded `pagination.fieldDegradation.recovered=true`. | The field-specific degraded-selector guard is covered by fixtures, but this window does not supply a natural live example of that branch. |
| Original dated raw config | ColorFull's complete campaign and adset raw receipts observed on provider-local 2026-07-25 contain two spending campaigns with `OUTCOME_SALES`; their stored daily objectives are NULL. | A current config backfill stamped with an older report date is not a dated observation. |
| Retained ColorFull 2026-07-25 `ad_insights_bulk` payload | The sampled stored ad-level Insights keys include spend, clicks, actions and campaign/adset IDs, but no `objective` or `optimization_goal`. | A new dated Insights request may return these fields, but existing raw Insights cannot prove their historical configuration semantics. |
| Legacy snapshot-only config receipts | A read-only July census found 57,609 `campaign_configs` raw snapshots with no observation row; 31,266 are fetched HTTP-200, complete, natural-end, single-page responses. ColorFull's 2026-07-25 campaign snapshot `38a2c5c5-15d5-428e-a997-c5e14ecf8b8c` and adset snapshot `d59949d7-d042-47c3-8eeb-00226cd73664` are in this class. | An observation-only reader drops a real source. Snapshot-only receipts require their own source class, exact account/entity scope, provider-local observation time, and dated corroboration. The counts are candidate receipts, not proven daily objectives. |
| Historical change-case search | In ColorFull's complete fetched campaign/adset config receipts from 2026-07-01 through 2026-09-20, no ID had two distinct `objective` or `optimization_goal` values. | This account cannot validate whether dated Insights fields retain historical configuration across an actual change. Absence of a transition does not prove immutability. |
| Wider retained transition-candidate sweep, read-only on 2026-09-22 | `meta_config_snapshots` has 2,166 campaign rows since 2026-06-01, covering 2,148 distinct business/account/campaign identities; all carry an objective and none has two distinct objective values. The newest row was captured on 2026-08-16. No campaign in `meta_campaign_daily` or adset in `meta_adset_daily` has two distinct non-null objective/optimization-goal values since 2026-06-01. | These tables are sparse or derived rather than a complete provider change log. This sweep found no suitable change case; it does not establish that objective or goal is immutable, nor the historical meaning of dated Insights fields. |
| Meta account activity history as a possible dated change source | The official [SDK exposes `GET /{ad_account}/activities`](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py) with `since`/`until`; read-only Graph v25 probes returned HTTP 200. Eight of the 12 selected accounts reached natural pagination end for 2026-07-01 through 2026-09-22. The four initially incomplete accounts were retried over 2026-08-25 through 2026-09-22 and all reached natural end. Across these scoped scans, all **264** `update_ad_set_optimization_goal` events had `old_value=null`; a sampled event used the UI label `new_value="Conversions"` and `object_type="CAMPAIGN"`, not the API enum. None exposed a non-null old→new goal change or an `extra_data.type` containing `objective`. | The combined coverage is not uniform before August 25, so it is not a full 12-account July census. Even on the complete scoped responses, missing activity events cannot prove no configuration change. The observed UI labels and null old values cannot be written as exact historical optimization goals. A supported event with canonical old/new values and stable entity mapping would change that assessment. |
| Read-only repair preview for ColorFull 2026-07-25 | Two campaign rows and two adset rows have 17 source-backed stored-field changes. The manifest records old/new values, the same-day raw source, and a later complete raw receipt with the same config and `updated_time`. Derived bid labels and manual-amount display values are excluded because they have no independent DB column. | No repair was applied. The later corroborating observations were on 2026-07-28. This is evidence for this day, not for the remaining missing days. |
| ColorFull 2026-07-25 campaign observation density | The two affected campaign IDs each appear in 231 retained config snapshots in the provider-local day; their observed objective, daily budget and bid strategy each have one distinct value. The snapshots span 21:10Z on July 24 through 17:42Z on July 25, while the provider-local day ends at 21:00Z. | This supports a stable observed interval but leaves an unobserved final gap. Meta's `updated_time` is not guaranteed to advance for campaign budget changes, so matching clocks alone do not certify a budget for every instant of the day. |
| Independent provider-local source-contract readback, same ColorFull campaign day | After the cutoff-before-ranking fix, campaign `120243489401800340` returns `OUTCOME_SALES / legacy_single_page / review_only` at a 2026-07-25 16:00Z cutoff from its 15:54Z receipt, the same tier at 18:00Z from its 17:42Z receipt, and `OUTCOME_SALES / legacy_bracketed / decision_authority` at 2026-07-28 06:00Z after its 04:08Z corroborating receipt. The earlier `unknown` readback at 16:00Z was caused by selecting the later 17:42Z row before applying the cutoff. | This executes the source SQL against the live DB in a read-only session. It proves that the as-of fix recovers an earlier valid receipt without leaking the later one, not a complete native decision job or the 25 August–20 September cohort. |
| Legacy multi-page adset receipts | An independent read-only count for business `75f65b18-97e5-426c-a791-a8f693d34c84` at 07:22 UTC found 7,136 multi-page `adset_configs` observation rows; none records `pagination.startedAt` or `pagination.completedAt`. The adversarial readback found two accounts whose otherwise complete multi-page responses resolve to `unknown` under the single-page-only legacy rule. | The aggregate observation time does not prove each entity's page time. These receipts should retain a visible source-backed, time-uncertain signal, but cannot gain full-day decision authority from a guessed page clock. Newly captured per-entity page clocks are the authority path. |
| Source-contract query performance before reader wiring | Claude's read-only adversarial probe measured the adset source query at 7.4–14.3 seconds across nine runs for a 736-adset-day, one-business window; eight runs exceeded the web pool's 8-second query limit. A narrower 320-adset-day scope hit the 45-second probe timeout under a different plan. The wired calibration query took 312.7 seconds for the largest measured 9,241-ad-day, 90-day account. | This is a pre-integration blocker. The query must pass a bounded worst-case read and emitted-SQL tests before it can be called by calibration or the decision loader. No production decision reader runs this new contract yet. |
| Bounded calibration source read after set-based resolution and timezone-aware receipt compression | A read-only 2026-09-22 probe on the same 9,241-ad-day, 90-day account finished in 20.707 seconds under a 30-second PostgreSQL statement timeout. It returned 7,230 rows with an objective and 5,496 with an optimization goal; the separate decision-authority counts were 3,556 and 5,203. The earlier, incomplete compression still took 307.087 seconds and was rejected. | This is one source-query timing with warm database state, not a native job run, repeated latency distribution, joined decision loader, or released behavior. The returned counts do not establish that the authority sets overlap on the same ad-days. |
| Source-query timing after admitting time-uncertain legacy multi-page receipts | Claude's read-only 90-day rerun measured 29.4 seconds on the large account, with zero row-level differences between compressed and uncompressed source resolution on a separate 744-row comparison. | The native calibration transaction sets a **30-second per-statement** timeout, not a 30-second deadline for the entire transaction. A 29.4-second source SELECT has little margin for a cold or variable run and remains a performance `NO_GO` until measured under the actual job executor. The 744-row equivalence check does not prove every account or date window. |
| Pre-admitted-window native calibration source and pure compute, ColorFull, as of 2026-09-22 | A production **READ ONLY, REPEATABLE READ** query through `READ_NATIVE_AD_CALIBRATION_SOURCE_SQL` returned 1,409 ad-days in 19.329 seconds under a 30-second statement limit. The real mapper and pure batch compute yielded 30 candidate ads, four observations, and two cells; 25 ads were excluded for missing context and one for censored truth. Of source rows, objective readiness was 574 decision-authority, 524 review-only and 311 none; goal readiness was 850 decision-authority, 42 review-only and 517 none. Both cells had zero verified-suffix ads. | No job, writer, API, or UI ran and no production row was changed. This was a pre-fix probe: the then-current code excluded an entire ad when **any** positive-spend day lacked exact context, before the verified suffix was computed, so old 90-day source gaps erased a newer complete sample. Source field counts are independent and do not establish same-day overlap. |
| Repeated native calibration preview after admitted-window repair, same account/date | A second read-only source SELECT took 22.541 seconds for the same 1,409 rows. Pure compute now admitted 29/30 candidate ads, with zero `missingContext` exclusions, 26 context-window truncations, 25 gap truncations, 1,157 dropped older/newer rows, and three cells. The mature ad counts were 7, 5 and 2; all three cells remained `insufficient` under existing sample floors. The first two cells had only two verified-suffix ads, 12 days and $1.20 of spend; the third had none. | This verifies that the old-gap all-ad exclusion was removed on this measured account without turning the still-small verified sample into an approved hard decision. The query still has weak margin under 30 seconds. Claude's earlier intermediate run before the calendar-gap adjustment counted 9/7/2 mature ads; these later numbers are from the current shared tree, which may change again before final acceptance. |
| Historical native calibration preview, 2026-08-21 | A read-only, repeatable-read ColorFull source query plus target read and the real mapper/pure compute completed in 30.032 seconds for 1,267 source ad-days. The account-wide purchase cell had 21 source ads, 20 verified-suffix ads, 101 verified-suffix days and $363.04 verified-suffix spend, but only seven mature verified converters; `quality=insufficient` under the existing sample floor. The target was present. A separate Bilsem Zeka account probe for the same historical date hit the 30-second statement/query limit before source rows returned. | Historical data can exercise the actual pure calibration path without waiting for a natural production wave, but it does not fabricate the missing 20/30 mature sample. The Bilsem timeout is a concrete performance `NO_GO`, not a missing-data verdict. Neither probe wrote a production row or ran a live job. |
| Bilsem source-query account-scope performance experiment | On the same 2026-08-21 read-only query, runtime-only filters for the physical account in raw observations, raw snapshots, and creative witness lowered the planner's estimated total cost from about 273,151 to 46,653. The actual calibration source query nevertheless hit its 30-second query limit before returning rows. | The filter is promising but the cost estimate is not a latency result. This experiment changed no repository SQL or production data and does not close the large-account performance gate. |
| TheSwaf receipt-resolution compression experiment | A runtime-only second reduction after entity expansion retained the first and last observations before the cutoff and the last overall observation for each entity, provider-local day and requested-field scope. In one read-only repeatable-read transaction at the 2026-08-21 cutoff, the original 90-day native source SELECT took 88.530 seconds and the reduced variant 20.250 seconds. All 3,421 returned rows, columns and order matched by full JSON SHA-256 `6f3677113582e7052e972c513998f697890887f49680ee4ae0abefde95f5ade6`; the variant then completed the real mapper/pure calibration in 20.921 seconds in a separate read. | This demonstrates a substantial real-query reduction and exact parity for the query version loaded by that process on one account/cutoff, not general semantic equivalence or parity with edits made later in the shared worktree. The original exceeded the job's 30-second statement limit; the extended comparison timeout was diagnostic only. The prototype is outside the repository in `/tmp`, with no production write. Timezone changes, same-instant conflicts, selector differences, future evidence, later tie-break edits and other accounts still require tests and readback before adoption. |
| Bilsem receipt-resolution compression experiment | The same runtime-only variant completed the 2026-08-21 read-only source, target lookup and real pure calibration in 31.289 seconds total. The source SELECT itself finished within its 30-second statement limit for 8,529 ad-days; the unmodified SELECT timed out. The SALES/purchase account cell had 21 mature verified converters and `quality=low_sample`, with 120 verified-suffix ads, 497 verified days and $140,261.80 verified spend. A later read-only run of the in-tree source and pure action-readiness calculation found the exact objective/optimization cell Cut-ready (`calibrated_relative_with_economic_stop_loss`): 21 mature versus the Cut floor of 20. Scale was not ready at 21 versus 30; Refresh had 17 versus 20. | The account-pooled cell remains soft-only, and `quality=low_sample` is not itself an action verdict: the exact-context Cut readiness differs from Scale/Refresh. This establishes calibration-level readiness, not an emitted decision or live action. The full transaction may exceed 30 seconds because that is a per-statement limit, but the source SELECT's warm-run margin is too small for release confidence; another historical 30-second run timed out. The earlier runtime-only variant was not yet checked for row parity against later tie-break edits, while the subsequent integrated comparison below did establish full source-row parity. No production row was written. |
| Integrated compression parity after tie-break update | Independent read-only repeatable-read comparisons reconstructed the uncompressed source from the current emitted SQL, preserving the new deterministic tie-break, and compared it with the in-tree compression in one transaction snapshot per account at the 2026-08-21 cutoff. ColorFull: 1,267 rows and every field/order matched, full JSON SHA-256 `6f21d05f7f25ff71fd82d283b973c78f5e64fd8b5fdd59b0b339ae4d6e3bb8af`, 23.705s uncompressed versus 11.362s compressed. TheSwaf: 3,421 rows matched, hash `6f3677113582e7052e972c513998f697890887f49680ee4ae0abefde95f5ade6`, 79.252s versus 17.131s. Bilsem: 8,529 rows matched, hash `1e75bf8cf643a5b04f45c171c1030b85b0301b73ab6e87c25665bd60124c92ed`, 37.052s versus 17.708s. | These are exact output-parity proofs for three real accounts and one historical cutoff on the loaded query version. The uncompressed query used an extended diagnostic statement limit; the native job still has 30 seconds per statement. Bilsem's other compressed warm runs included 34.7 seconds, so this fast parity run does not establish cold-run headroom. The decision loader and its hard-action gate remain separate acceptance work. No production row was written. |
| Stored ad `actions`, 12 accounts, 2026-08-25 through 2026-09-20 | Among 10,733 spending ad-days, raw page-view events occur on 6,025 days, cart events on 2,455, and checkout events on 1,310. Raw positive link clicks with a NULL dedicated column occur on 2,936 rows. | These are presence counts. The parser and backfill need per-row verification, especially event aliases and measured zero versus missing data. |
| Creative-grain metric presence, same reporting window | A separate read-only census found 9,308 spending `meta_creative_daily` rows and zero NULL `link_clicks` values; zero creatives mix NULL and measured days in this window. All 9,308 flattened payloads carry non-null `landing_page_views`, `add_to_cart`, `initiate_checkout`, `thumbstop`, `video25`, and `video50` keys. Zero values occur on 3,809 LPV, 7,128 cart, 8,144 checkout, and 3,624 thumbstop rows. | Creative-grain payloads are distinct from raw ad `actions`; key presence and a stored zero alone do not prove that Meta measured zero rather than an upstream default. Legacy creative calibration/lifecycle code also coalesces a future NULL link-click to zero, but this census does not establish a present live effect or justify treating those 9,308 rows as missing. Thumbstop/video semantics still need their provider source and denominator verified. |
| Typed adset goal/event shape, read-only 2026-08-25 through 2026-09-20 | Spending adset-days with `Offsite Conversions` goal have a non-null `custom_event_type` on 1,672/1,672 rows; `Value` has it on 89/89. `Profile Visit` (43), `Reach` (27), `ThruPlay` (27), and `Link Clicks` (27) have no event, as their non-purchase goals would permit. Another 677 spending rows have neither a goal nor an event. | These are derived daily columns, not raw config receipts, and cannot grant source authority. They show why an event is a purchase-specific gate and why a universal event requirement would create false holds. The 677 missing rows require source tracing; no goal or event is inferred from their outcomes. |
| Custom conversion context collision, latest complete Bilsem Zeka adset receipt | A read-only 2026-09-22 query of the latest fetched, complete `adset_configs` snapshot (`2026-09-21T21:10:35.723Z`) found 21 adsets with `optimization_goal=OFFSITE_CONVERSIONS` and `custom_event_type=OTHER`, spanning **six distinct `custom_conversion_id` values** in the same account. A separate read-only typed warehouse query found zero spending `OTHER`+ID adset-days over 2026-08-23 through 2026-09-21. | The existing `goal+event` optimization-context key puts these six configured conversion targets in one cell; the IDs are a real source dimension, not interchangeable purchase-event labels. This proves a configuration pooling risk, **not** a measured wrong spending decision in that window. Meta's [AdPromotedObject](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adpromotedobject.py) and [CustomConversion](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/customconversion.py) SDK definitions keep the promoted-object event and the conversion object's own event type separate. The repair must segregate these targets or withhold their mixed cell; `OTHER` alone does not prove a purchase event. |
| Custom conversion object GET, same six IDs | Six Graph v25 `GET /{custom_conversion_id}?fields=id,custom_event_type,event_source_type` requests succeeded with HTTP 200. All six conversion objects reported `custom_event_type=OTHER` and `event_source_type=pixel`. A separate GET that included `rule` also succeeded; the rule was not interpreted as an event-type guarantee. | The object's own enum still does not assert `PURCHASE`. In `lib/meta/funnel-cohort.ts`, `OTHER` has no event mapping and `OFFSITE_CONVERSIONS` falls back to `purchase`, so the native config-only path may assign purchase semantics without proof. This requires a source-backed event/rule interpretation or a specific review-only/unknown gate; merely separating cells by ID is insufficient. These were provider GETs only, with no Meta or database mutation. |
| Read-only historical input differential, TheSwaf, same window | The 2026-09-22 replay examined 1,047 ad-days without truncation. The repaired reader resolves landing-page views on 925 versus zero before (623 available at the selected run cutoff, 302 restated later); 122 have no retained `actions` array. Link-click repair has 205 locally measurable NULL-column candidates (198 positive, seven measured zero); 122 need provider resync. The objective section also counts 807 contemporaneous typed witnesses but does not promote them to raw-receipt authority. The authority projection offered zero provider mutations before and after. | This exercises retained inputs and pure transforms, not the native writing job, API or UI. Its objective dimension is explicitly `pending_architecture` and must not be used as evidence that the new source contract is integrated. The replay labels a value unresolved by its reader; that does not assert the provider never supplied any related source. |
| TheSwaf two-band link-click repair preview, 2026-08-24 through 2026-09-20 | The actual repair CLI ran with `PGOPTIONS=default_transaction_read_only=on` and no `--execute`: 423 candidates examined, 270 repair rows planned (212 measured positive, 58 measured zero), 60 already consistent, 93 with no `actions` payload requiring separate source investigation, zero writes. Manifest SHA-256: `581e184f826cc84009bbd706522db3123b0d1c93b4dba7f3fa667cfd85bb5e26`. | The CLI's exact adjacent prior/recent 14-day pair starts on August 24, one day earlier than the 27-day differential replay above, so its counts are not directly comparable. The preview is no approval to apply; the 93 rows have no trustworthy local `actions.link_click` value to fill. |
| TheSwaf dated provider re-read of those 93 rows | A Graph v25 read-only ad Insights query for August 24–September 20 completed with three naturally ended pages and 1,176 ad-day rows. All 93 missing-actions candidates matched by ad ID and reporting day, and 93/93 spend and impression pairs equaled the stored facts. All 93 still lacked `actions`; all 93 separately reported `inline_link_clicks="0"`. A one-day September 16 comparison returned 131 positive `actions.link_click` rows, with `inline_link_clicks` equal on all 131, and 13 missing-actions candidates with the separate zero. Explicit `1d_click` and `28d_click` requests kept those 131 equal and the 13 direct zeros; the 28-day query also returned five extra report rows, showing that request scopes are not identical even when the matched click values agree. | Re-queuing the same `actions` selector is not demonstrated to repair the 93 rows. The provider has supplied a direct zero in a **different field**, but one-day numerical agreement does not establish interchangeable attribution scope for the existing `link_clicks` column. Keep that field distinct until its semantics and downstream rate contract are verified; do not turn a missing `actions.link_click` into a measured zero by assumption. A later repeat of the full 28-day provider query returned HTTP 500; the successful three-page read is the evidence for the 93-row count. The query and DB reads made no write. |
| Read-only historical input differential, largest 90-day ad-volume account, same 27-day window | A second 2026-09-22 replay examined 2,698 ad-days without truncation. Landing-page views resolve on 1,938 days (1,672 available at the selected run cutoff, 266 restated later); 760 have no retained `actions` array. The existing link-click column resolves 1,077 days; 861 NULL-column rows have locally measurable raw actions (595 positive and 266 measured zero), while 760 need provider resync. Four role-held Cuts gain a visible manual-action lane, with zero execution authority or provider mutations offered. | This is another input/presentation differential, not an integrated native decision run. Its objective source dimension remains `pending_architecture`: 1,543 contemporaneous typed witnesses are diagnostic, not a raw-authorized historical objective. Creative attribution improved to 2,697/2,698 ad-days in the restated read, but 1,486 of those relations were observed after the selected run cutoff and cannot be claimed as point-in-time inputs. |
| Ad state presence for campaign-role attribution | 107 ads have a newest `absent_unconfirmed` state with no observed creative field; 19 of those ads spent within the trailing 90 days. All 336 spending ad-days for those 19 preceded the absence state. | The latest-state guard prevents a future stale-creative assignment, but its measured effect on those current spending ad-days is zero. This does not establish a count for every historical role ambiguity. |
| Result-derived cohort fallback in existing code | `resolveMetaFunnelCohort` returns `purchase` from positive purchases or revenue when objective, goal, and event are all missing. Older Meta recommendation paths pass result metrics. Native hydration also passes them, but its current `contextIdentityUnknown` guard prevents this fallback when configuration is wholly absent; native calibration passes no result metrics to this resolver. | The shared fallback is a verified code path, not a measured count of affected live decisions or evidence that native decisions currently infer the configured event from purchase results. Keep the native guard explicit during source-contract integration; changing older snapshot semantics needs a compatibility decision. |

The historical repair preview was run with `PGOPTIONS='-c default_transaction_read_only=on'`
using `--dry-run`. It is reproducible from
the command in [REPAIR_RUNBOOK.md](REPAIR_RUNBOOK.md). The preview does not
establish that dated Insights `objective` or `optimization_goal` represent
historical configuration; a provider change case is still required before
those fields can serve as a historical repair source.

Release acceptance must trace source to typed history, warehouse, calibration,
decision, API, and mounted UI, then check positive decisions against genuinely
missing-data controls. The exact deployed SHA needs three natural production
waves and at least 24 hours of readback after deployment. This is a subsequent
acceptance check; the authorized pre-deploy gate is historical replay plus
complete local tests.

## Local verification on the shared implementation tree

- The isolated migration-from-zero and Meta config-repair database seams passed
  on a throwaway PostgreSQL cluster. The config writer's compare-and-set,
  audit manifest, rollback-compatible schema, and unchanged metric columns were
  checked without touching the live database.
- The integrated migration-from-zero rerun on 2026-09-22 passed after registering
  the emitted-SQL source seams: 13/13 field-source and 11/11 removal/restore
  PostgreSQL cases executed with zero skips. The throwaway cluster was removed
  after the run. This predates the pending native decision loader changes and
  must be rerun if those change the registered seams.
- The dated raw-config repair reader now requires HTTP 200 and exact business,
  provider account, endpoint, and entity scope, and shares a three-day
  corroboration horizon with the decision source contract. Its focused
  tests passed, including late-confirmation, degraded-selector, changed-budget,
  and bid-regime negative controls.
  ColorFull's 2026-07-25 read-only dry run produced 17 stored-field changes and
  manifest hash `d3e9e8cdf8c80de883caa6014f04ae0cec5f42cafec53978a3d9c27f083abdf8`.
- A provider `updated_time` with no explicit timezone is now refused by the
  dated repair reader instead of being parsed under the machine timezone.
  The parser also accepts zoned microsecond timestamps, matching the decision
  source's timestamp shape instead of withholding an otherwise valid receipt,
  and refuses calendar-invalid dates that JavaScript would otherwise roll
  forward. All 14 focused tests passed. Repeating the same ColorFull dry run under a
  read-only database session still produced 17 changes and the identical
  manifest hash; no historical write occurred.
- A later complete receipt that dropped an optional field no longer masks an
  earlier eligible same-day source or the next field-bearing corroborator.
  The reader checks every intervening provider clock and refuses requested-but-
  absent fields, changed values, and untimed pages. The new A→B→C positive and
  negative cases passed 26/26 focused tests. Because the repair receipt has one
  source identity, it cannot combine A's objective with B's separately observed
  budget; that budget remains unresolved in this branch rather than acquiring
  invented provenance. The ColorFull 2026-07-25 read-only dry run still produced
  17 changes and manifest hash
  `d3e9e8cdf8c80de883caa6014f04ae0cec5f42cafec53978a3d9c27f083abdf8`.
- The provisional current-provider pass no longer reads older config snapshots
  into its in-memory daily representation when the response omits a field. Its
  current snapshot and typed history writers already use the provider response;
  finalized historical metric slices already withhold current configuration.
  This closes a stale fallback path without asserting that it caused a stored
  production objective error. The unused snapshot fallback parameters were
  removed from both daily config builders so a later caller cannot revive the
  path inadvertently. All 62 focused API tests, file lint, and a shared-tree
  typecheck passed after this cleanup; the existing
  phase timer now names this step `resolve_current_entity_scope`.
- Before the native authority-persistence change, typecheck, repository lint,
  workflow structure checks, and a production build passed. During that change
  typecheck briefly failed on missing `configAuthorityCounts` hydration and
  fixtures; after the store and fixture updates, a fresh `npm run typecheck`
  passed on the shared tree at 09:13 UTC on 2026-09-22. This is an in-progress
  check, not the final integrated release gate.
  Claude's Meta/creative-decision-engine run had 6,971 passing tests and
  two D077 artifact-hash failures: the 2026-08-30 release-candidate manifest
  pins the older tree. Its external API/component consumer run had 2,283
  passing tests with no failures. These runs preceded the final UI message
  patch, which has its own unit and mounted-route verification.
- A first mounted-route pass found nine failures where the read state and
  failure code were correct but the UI printed a generic message instead of
  the closed failure dictionary's operator explanation. The component now
  derives that explanation from the whitelisted code and never prints the
  envelope's free-text diagnostic. After rebuilding, 312 authenticated route
  cases and all 23 read-state browser tests passed on the throwaway database;
  the 29 Creative Studio browser tests had passed in the preceding run.
- Campaign-role coverage now survives an all-unresolved result: the SQL emits
  a coverage-only row that the role mapper filters out, so seven unresolved
  spending ad-days are reported as seven rather than zero in the negative test.
  All seven focused campaign-context tests passed; a read-only query for
  TheSwaf's 2026-09-20 ran successfully and returned 109 resolved of 109
  spending ad-days. The live check validates the emitted SQL, not the synthetic
  all-unresolved state.
- This is local proof only. The full `verify:pre-push` gate is still `NO_GO`
  until a new release candidate is pinned and its complete gate passes. No
  deploy, historical backfill, decision regeneration, or 24-hour natural-wave
  live acceptance has occurred.

## Native historical decision replay (2026-09-22, read only)

- A later source-backed config dry-run covered all seven businesses with
  positive-spend campaigns missing objective on 2026-08-25 through 2026-09-20,
  plus ColorFull 2026-07-25. It proposed 2,749 adset fields in the seven-business
  window and zero campaign objective fields there; ColorFull proposed 17 fields,
  including two objectives. All 2,766 entries retained raw source IDs and old/new
  values, and none was applied. The 397 August–September adset-days with changes
  had selected receipts within 11 minutes 13 seconds of the provider-local day
  end, with a matching later receipt 4–29 minutes after the selected one. ColorFull
  has an approximately 3-hour-18-minute end-of-day gap and remains a separate
  field-level review. See `REPAIR_RUNBOOK.md` for the per-business counts and
  commands.
- A separate read-only 12-business link-click repair preview for the adjacent
  14/14-day pair ending 2026-09-20 proposed 4,342 column fills: 3,173 positive
  counts and 1,169 measured zeros. Every proposed row had a NULL old value and
  its own raw snapshot ID; no business hit the scanner's row limit. Another
  1,842 rows had no stored `actions` evidence and remain unresolved. These are
  preview counts, with no production write.
- A separate read-only storage counterfactual for that exact two-band window
  found 1,135 ads, 489 represented in both bands, and zero whose delivered
  days have measured link-click coverage in both bands today. Filling only
  values already recoverable from stored `actions` would make 184 of those 489
  fully measured; 268 still lack coverage in the recent band and 250 in the
  prior band (the sets overlap). This is a coverage ceiling from retained
  warehouse rows, not a simulated decision verdict or a reason to turn absent
  actions into zero. It does not include the other context, sample, target, or
  freshness gates, and no production row was changed.
- The first 30-second-bounded integrated historical source/loader attempt after
  the new within-day pagination tier timed out on a real database query while
  Claude's full test suite was running. This is a release blocker pending an
  isolated, instrumented repeat and source-query performance comparison; CPU
  contention is a possible explanation, not an established one. No production
  job or decision write was attempted by that read-only probe.

- The follow-up completed with the native 30-second **per-statement** limit in a
  read-only repeatable-read transaction. TheSwaf's provider-local 2026-08-21
  close is 2026-08-22T04:59:59.999Z in America/Chicago, so the calibration
  `asOf` passed to the unchanged UTC-date safety check was 2026-08-22. The
  production calibration source query returned 3,319 ad-days in 20.5 seconds;
  the target read and pure calibration produced 118 observations and a
  purchase account cell with 21 mature ads. The production decision loader
  hydrated 81 ads in 2.3 seconds: 73 had observed current config, 11 had a
  fully verified economic context, and the same 11 satisfied both. The whole
  read-only transaction took 25.2 seconds. The selected historical case now
  passes after the initial timeout, but this does not prove every larger or
  later account will stay under 30 seconds.
  The historical hydration receipt was `complete_source_run_missing`, so it was
  not authoritative for account-wide pruning; this old day cannot stand in for
  a complete native production generation. There were no writes.
- A direct planner comparison for the same TheSwaf source parameters returned
  the same 3,319 rows and SHA-256 under the default planner (15.0 seconds) and
  `enable_nestloop=off` (14.3 seconds). One earlier default-plan `EXPLAIN
  ANALYZE` took 26.9 seconds. That variability does not justify forcing a
  different planner setting from one fast run. The performance lane is under
  independent review before release.
- The [Meta account activity endpoint](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py)
  returned one complete page for
  TheSwaf's 2026-08-01 through 2026-09-21 campaign-category interval: 44 events,
  comprising 30 status changes, 12 campaign creations, and two name changes.
  None supplied a historical objective value. This read is useful as a change
  audit, but an absent activity entry does not prove the objective never
  changed. The current objective therefore remains a current observation, not
  an August/September backfill source.

- Claude measured 42 real source reads with the production 30-second statement
  limit, zero timeouts, typical 8–12 seconds and slowest 27.4 seconds. Five
  current-query-versus-uncompressed comparisons matched every row, field and
  order by SHA-256. These are measured bounded reads, but the slowest has only
  2.6 seconds of margin; a future query or data-growth change requires a new
  performance check.
- A later, in-tree source-query repair removed repeated scope joins, unused
  restated diagnostics and full scans for single-row result lookups. Paired
  read-only source comparisons on Bilsem, TheSwaf, Grandmix and Tiles matched
  every output row. Their current-query medians were 6.696, 4.136, 3.508 and
  4.595 seconds; the worst current run across them was 7.332 seconds versus
  24.087 seconds on the previous SQL. This supersedes the narrow-margin result
  for those measured source windows only. The decision-loader queries inherit
  the builder changes but still need their own eight-second-pool timing.
  See [the performance record](./CALIBRATION_SOURCE_QUERY_PERF_2026-09-22.md).
- A full Bilsem native decision-loader read returned 3,200 ads in 34.6 seconds
  total, with every SQL statement below its 30-second limit. It found 139 ads
  with both current observed context and fully verified economic context. A
  historical Bilsem purchase/Cut cell had 21 mature source-backed ads against
  the unchanged floor of 20; two sampled loader ad spends exactly matched
  calibration at $7,075.44 and $11,204.09. The full loader is read-only and
  does not prove persistence or UI serving.
- TheSwaf at its 2026-08-21 provider-local day end had 3,399 source ad-days,
  118 observations, 55 verified-suffix eligible ads and 21 fresh eligible ads.
  In a selected 15 high-spend-ad pure replay, eight raw Cut verdicts appeared.
  Fresh, fully economic-authorized examples included ad
  `120251381043730042` ($1,623.81 spend, three purchases, 0.31 ROAS) and ad
  `120251381061900042` ($500.99 spend, two purchases). The published verdict
  stayed Keep in these first-run examples because prior-label hysteresis and
  campaign-role evidence were absent from the replay. This demonstrates
  evidence-qualified positive verdicts and separately identified execution
  holds, not a claim that a natural production job emitted a Cut.
- A separate decision-loader census at that cutoff found 77 ads with economic
  days: 11 had every admitted economic day source-authorized and 66 had at
  least one blocked day. This is stricter than calibration's verified-suffix
  sample count above. Claude initially attributed most blocks to August 5;
  that claim was a diagnostic date-decoding error (`pg` returned a provider-local
  midnight `Date`, which `toISOString()` shifted back one day in the investigator's
  timezone). Recomputed with local calendar components, 42 blocked ads had an
  August 6 economic day. A sampled campaign's August 6 `updated_time` was
  18:06:53Z, after its 05:00Z provider-local day start; a same-day receipt
  cannot prove the whole day even though the next receipt had an equal value.
  Across 103 examined campaign-days, 51 bracketed, 41 had no same-day receipt,
  seven had a within-day update clock, and four lacked corroboration within
  three days. Those 52 unbracketed days are real source limits in this window,
  not a reason to promote review-only values to decision authority.
- Among the 66 held ads, 34 had a verified economic suffix after their last
  blocked day; 32 had none. The suffix was a median two days, with 19 of the
  34 carrying zero conversions. Recomputing a 28-day decision from these
  short, heterogeneous suffixes would change the economic comparison and was
  not adopted. The retained source-backed path is to improve future sync
  coverage and leave historical gaps visible. In the same sample, none of
  84 inspected ads had a full 28-day admitted context window; 63 had only
  one to six calendar days. The UI must label the actual persisted admitted
  window instead of claiming a fixed 28-day measured period.
- TheSwaf at 2026-09-20 had 2,751 source rows ending on September 18 and 282
  observations, but zero fresh verified-suffix eligible ads. Raw
  `campaign_configs` attempts since September 15 in the inspected partition
  were HTTP 400; the missing current objective cannot be created by moving a
  simulation clock or borrowing a later current API value. A real fetched
  config receipt or other source-backed repair would change that conclusion.
- An independent read-only, repeatable-read Bilsem 2026-09-20 probe used the
  production calibration source, mapper and pure batch compute, then the
  production decision input loader at the same provider-local cutoff. It
  returned 9,078 source ad-days, 302 observations and a purchase cell with
  eight mature ads (`insufficient` under the unchanged sample floor). The
  loader hydrated 3,296 ads, with zero carrying observed current config and
  zero carrying a fully verified economic window; the completeness receipt was
  present. Retained `campaign_configs` attempts since September 15 were all
  HTTP 400 in this account. This is a source failure with an explicit negative
  result, not evidence that a decision threshold should be lowered or that a
  present-day objective should be backdated. The first source SELECT took
  29.375 seconds and a repeated 30-second-bounded read timed out; the bounded
  calibration query response and its 4MB/16MB row-parity measurements are in
  [the performance record](./CALIBRATION_SOURCE_QUERY_PERF_2026-09-22.md).
- The provider-local day is used for both calibration and decision-loader
  receipt classification. A west-of-UTC cutoff test covers a run where the
  UTC date has advanced but the account-local day has not. The v12 envelope
  now has a test proving that a `decisionEconomics` change alters both its
  input and decision hashes. Focused tests passed; the complete pre-push gate
  and release-source manifest remain pending.
- An additional read-only video-metric probe found 9,546 delivered
  `meta_creative_daily` rows from August 25 through September 20. All carry a
  flattened `thumbstop` key and 5,832 have a positive value, but none retain
  `actions` or `video_play_actions` in that creative projection and none have a
  direct raw snapshot ID. This projection cannot by itself establish a measured
  three-second video view. In the ad-grain raw receipt archive for the same
  window, 14,759 fetched `ad_insights_bulk` snapshots contained no
  `video_play_actions` array, while 14,211 had at least one `actions.video_view`
  entry. The native ad range reader previously filled its `videoViews3s` from
  video starts or a thumbstop ratio when that event was absent. It now keeps
  the value missing unless the stored `actions.video_view` entry exists; a
  focused test covers a start-only record. The same reader also used
  `actions.video_view` as a fallback for ThruPlay, which conflated a video view
  with a different watch threshold; that fallback was removed and the test
  verifies a view-only record has no ThruPlay measurement. The older creative-grain ratio and
  legacy calibration path need separate source-lineage review before they can
  be called a verified three-second metric. The creative daily `ad_id` values
  sampled in the live table were synthetic `creative_*` IDs, so a plain
  creative/ad-day `ad_id` join returned no rows and cannot repair them. The
  [official Meta SDK v25 release note](https://github.com/facebook/facebook-python-business-sdk/releases/tag/25.0.0)
  announced a June 2026 deprecation of legacy 3-second Viewers in favor of
  Media Views/Viewers. That notice does not establish the exact September
  semantics of `actions.video_view`, so the informational UI no longer labels
  its ratio as a proven three-second hook rate; it says video-view rate.
  A read-only production table census found zero
  `engine_v3_decision_evaluations` at creative grain, versus 6,948,015 native
  ad evaluations and 865,218 native ad snapshots. The legacy creative video
  ratio is therefore a compatibility/data-quality issue, not a demonstrated
  cause of current native ad decision holds. It still needs a source-backed
  correction before that legacy producer is enabled.
- A production snapshot baseline for `as_of_date = 2026-09-20` shows the
  native system writes many rows and its distribution is dominated by: 9,033
  `diagnose` rows without an authority blocker, another 3,993 with
  `native_profile_unavailable`, 2,553 `out_of_scope`, 454 `test_more`, 39
  `keep`, 15 `cut` and 10 `scale` whose `authority_blocker` is
  `campaign_context`, plus smaller blocked groups. This is a snapshot census,
  not a post-repair simulation and not a count of unique ads or businesses.
  It gives the release a concrete before/after label-and-blocker distribution;
  individual source-qualified cases still decide whether a hold is correct.
- A separate ad-set serving read had summed each nullable ad-day funnel field
  through `?? 0`. One delivered ad-day with missing measurement therefore
  yielded a measured-looking total when another ad-day had a value. The
  accumulator now returns `null` for that field if any delivered contributor
  is missing, while preserving measured zero and keeping other fields
  independent. Another Assets ad-name fallback selected a creative-day value
  whenever an ad-day metric was zero or missing; this could overwrite a
  measured zero. It now consults the uniquely mapped creative day only for
  missing fields. Both boundary cases have focused tests.
  The ad-series API had the same partial-sum problem when several ads shared
  a daily chart point: one measured ad and one delivered ad with missing
  link-clicks produced a non-null total. Its merged point now stays null while
  the individually measured ad keeps its own number. The same completeness
  rule applies to its impression-weighted CTR and frequency. The route test
  covers the split.

### 22 September read-only historical replay and manifest refresh

- Fresh config repair previews on the current source, with no production
  writes: TheSwaf has 1,816 admitted field changes on 356 adset-days and 712
  budget fields withheld for an unobserved day opening; IWA-MDNLLC has 150
  admitted changes on 30 adset-days and 60 withheld budget fields;
  Silveristic has 11 admitted goal fields; ColorFull's 25 July window has 12
  admitted fields on four entity-days (including two campaign objectives) and
  two withheld budget fields. The admitted total is 1,989 and the withheld
  total is 774. Every admitted entry names a raw snapshot; ColorFull's older
  snapshot-only receipts have no observation-row ID and an approximately
  3-hour-18-minute unobserved end-of-day interval, so those 12 fields still
  require their weaker source class and individual review before application.
  None of these previews repairs the 25 August–20 September missing campaign
  objectives; a present-day campaign GET cannot prove that past interval.
- The bounded read-only differential replay on TheSwaf, 25 August–20 September,
  examined 1,047 ad-days without truncation. Its implemented funnel reader
  resolved 925 landing-page-view inputs the old flattened reader missed; 122
  lacked an `actions` array. Stored actions could repair 205 link-click
  columns; 122 ad-days still lacked that source. Twelve persisted role-held
  Cut findings project to an operator-visible manual Cut, while their decision
  state stays blocked and no provider mutation is offered. This is a pure
  transform, not an emitted new native job generation.
- The same differential on Bilsem, 26 July–21 August, examined 2,410 ad-days.
  The implemented funnel reader recovered 1,873 landing-page-view inputs;
  the link-click classifier found 1,260 stored zeros contradicted by a positive
  retained action and 226 null columns recoverable from retained actions.
  The replay's objective dimension is explicitly labelled
  `pending_architecture`: its old typed-history comparison does not exercise
  the now-shared raw config source SQL and its zero resolved value must not be
  reported as the current native reader's outcome. Its Cut count is not a
  full-job verdict.
- A TheSwaf 28-day link-click preview ending 20 September using the default
  end-of-report-day UTC cutoff examined 423 candidates, planned 270 changes,
  and had 93 rows without an actions array. Using an explicit later warehouse
  knowledge cutoff of 22 September 16:00 UTC examined 508 candidates, planned
  the same 270 changes with the same manifest hash, and exposed 140 missing
  action arrays. The extra rows were later-finalized captures, not additional
  sourced repairs. The CLI now exposes these clocks separately so a replay or
  restatement can name the population it actually read. Both runs were dry.
- The production `WarehouseDataSource.hydrateAdDecisionInputs` reader itself was
  run read-only at two retained native-job cutoffs, without substituting
  current dimensions. Bilsem on 21 August returned 191 ad inputs in 17.0s;
  188 had a value for objective, 189 had a current provider value observation,
  and 139 had fully verified decision economics. TheSwaf on 20 September
  returned 183 inputs in 10.2s; 164 had an objective value but **zero** had a
  current provider value observation or fully verified economics, consistent
  with the later config-request outage. Both hydration receipts reported
  incomplete account coverage, so these are source-reader positive and
  negative controls, not proofs that the integrated native job emitted or
  pruned a complete generation. This direct reader check also supersedes the
  differential replay's stale `pending_architecture` objective dimension.
