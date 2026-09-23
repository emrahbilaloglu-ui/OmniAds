# Meta decision data repair (local implementation, 2026-09-21)

This work has separate source, storage, decision, and live acceptance gates. A
successful local test does not prove that deployed decisions changed. Keep the
20/30 sample thresholds, commercial targets, recovery checks, and automation
permissions unchanged.

## Config source contract

- The campaign Graph request includes objective, bid/budget, status, and
  schedule fields. Campaign `bid_constraints` is unsupported on the measured
  account/API version and is requested only from adsets. A missing optional
  field does not erase other fields actually returned by the same receipt.
- Typed config history is written only from a complete current provider
  receipt. The record carries the raw snapshot ID and each entity's own page
  response observation time. Multi-page receipts retain these times in raw
  context; a legacy multi-page receipt without them is ineligible for dated
  repair. The writer verifies the fetched HTTP-200 observation in the same
  partition and sync attempt, including natural-end pagination, before accepting
  the shared raw content ID. A canonical content row can be reused by later
  observations and retains its first status; its ID alone cannot prove this
  attempt succeeded. A partitioned core capture must carry its non-null sync
  run ID, and each claimed config field must be in the effective request
  selector and in that entity's raw response. The writer also matches each
  entity and its non-null objective, optimization goal, promoted object,
  conversion target, budget, and bid fields against the raw payload. It also
  selects the exact observation by its provider page clocks when the receipt
  carries them, including concurrent reads in one attempt. An Insights raw ID cannot
  substitute for a config receipt. A degraded HTTP-200 response authorizes only
  the effective selector after dropped fields are removed; an unreadable
  dropped-field list authorizes no field from that response.
  A first raw-linked receipt is retained even
  when its fingerprint matches a legacy derived history row. Later identical
  provider receipts coalesce. The transition comparison uses the preceding
  observation at each entity's own provider clock, so an out-of-order response
  is not compared with a future config. Historical daily fact writes never
  create a new config observation.
- New current config snapshots store a `providerObservation` contract with
  raw snapshot ID, observation time, entity update time, effective field selector,
  fields actually present on each entity, and
  normalization version 2. Their `captured_at` is the receipt observation time,
  even if the DB write occurs later. Direct UI Graph reads attach complete raw
  receipts before writing current config snapshots; pre-existing unlinked
  snapshots have no decision authority. The source metadata is excluded from the
  change-only snapshot dedupe, so an unchanged hourly response does not add
  another row; an old unlinked snapshot can be upgraded once when a complete
  raw receipt supplies the same values.
- A complete response can still omit one entity field. That field is recorded
  as absent in `observedFieldScope`; the other returned budget, bid, or goal
  fields remain usable. An absent objective is never filled from purchase
  results, and an absent optimization goal is never inferred from the campaign.
- Historical repair reads complete original raw config receipts directly;
  derived config snapshots remain for serving and cannot substitute for a
  missing original provider response. It accepts only an account-matched receipt
  under the authoritative account timezone whose actual observation falls on
  the provider-local report day, whose entity `updated_time` predates the day
  start, and whose first complete observation after that day has the same
  entity update clock and normalized configuration. The first later observation
  must arrive within the shared three-day corroboration horizon; a longer gap
  does not prove an unchanged day. Both raw IDs and timestamps are retained in
  the repair manifest. This relies on the provider update clock
  representing relevant configuration changes; it does not infer configuration
  from a metric result. The campaign API's `updated_time` does not necessarily
  advance when campaign budgets change (see D097 round 6 in
  `docs/creative-decision-center/DECISION_LOG.md`), so a matching clock and two
  matching values are bounded evidence, not absolute proof that a budget was
  constant between observations. Budget fields in the preview manifest need
  their observed interval and any gaps reviewed before application. A later
  changed budget or bid field does not erase an independently matching
  objective/goal; bid strategy, amount, and constraints are corroborated as one
  group to avoid combining incompatible observations. Legacy raw
  `start_date` is not used as
  observation time: earlier backfills stamped current inventory with historical
  report dates. An earlier observation is last-known config, not proof that it
  remained effective on a later day. Dated Insights objective/optimization-goal
  semantics still need a provider change-case before they become historical
  config authority. Meta's [official Business SDK campaign update contract](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/campaign.py)
  accepts an `objective` update parameter, so this system cannot assume an
  objective is immutable merely because a campaign ID stayed the same. The SDK
  also lists `objective` and `optimization_goal` as Insights fields, but listing
  a field does not establish whether a dated report returns its historical or
  current configuration. `VALUE` and `RETURN_ON_AD_SPEND` must not be silently
  treated as the same event, and a purchase result cannot establish a
  `custom_event_type`.
- Direct live campaign/adset reads attach config only to the account-local
  current day. Dated Insights fallback keeps its metrics but cannot label
  today's objective, goal or budget as historical. Fresh missing fields are
  never filled from older snapshots. Bid-regime confidence and previous-config
  comparisons ignore legacy unlinked snapshots.
- Direct campaign serving follows every Insights, campaign-config, and
  adset-config page. A failed, malformed, cyclic, or over-limit Insights page
  makes the metric read unavailable; the campaigns API reports `isPartial: true`
  rather than treating the first page as the whole inventory. A config-page
  failure is reported separately as `configPartial` and leaves complete
  Insights metrics available, without inventing the missing config. Historical
  Insights fallback does not request current config. A successfully paged
  receipt with an omitted optional field remains usable for its other observed
  fields, and an unavailable previous-config comparison does not erase fresh
  provider data.

Legacy complete multi-page config receipts without per-entity page clocks
must retain a source-backed, time-uncertain diagnostic signal; they do not prove
the reporting day's full configuration. At the 07:22 UTC readback, all 7,136
multi-page adset observation rows in one affected business lacked retained
pagination start/end clocks.
For a newly retained legacy multi-page response, the source contract reads the
first-request and last-response instants from that exact receipt. If both are
valid, ordered, on the same provider-local day as the row observation, and the
account timezone is known, the field receives
`provider_receipt_legacy_paged_within_day`. This proves which
day named the value, but remains review-only without the usual bracketing or
other decision-authority evidence. A missing account timezone gives no
config authority tier. Missing timing, date-only, malformed, or
midnight-crossing intervals stay `provider_receipt_legacy_interval_uncertain`;
that tier cannot satisfy `currentValueEvidence`. Per-entity clocks from a
run-bound receipt retain their stronger independent path.
The corrected writer captures per-entity page times for new run-bound syncs.
An observed missing field is distinct from a request that never asked for it:
a later receipt that omits a previously present event must invalidate the
stale value, including in restated diagnostic reads. The shared config source
contract now serves both calibration and decision hydration. Its
pre-optimization 90-day probe took 312.7 seconds; that version was rejected.
The earlier optimized source had 42 real reads under a 30-second statement
limit with no timeout, but the slowest took 27.4 seconds. The subsequent
shared-join, unused-diagnostic and single-row-lookup changes matched every
source row on four production accounts. In paired reads their worst observed
source SELECT was 7.332 seconds versus 24.087 seconds on the earlier SQL; see
[the measured performance record](./CALIBRATION_SOURCE_QUERY_PERF_2026-09-22.md).
The native calibration transaction now sets a 60-second per-statement limit
and 16MB transaction-local `work_mem` after a larger Bilsem window exceeded
the earlier 30-second source bound. Other jobs retain their 30-second limit.
`runDbTransaction({ timeoutMs })` does not set a total transaction deadline.
The measured cold and warm timings, row-parity check, and remaining tail risk
are in the linked performance record.
This must be remeasured if the source query or scale changes; an `EXPLAIN`
estimate alone is not acceptance.

## Repair command

`scripts/meta-repair-config-history.ts` now has three explicit modes:

```text
node --import tsx scripts/meta-repair-config-history.ts --queue-metric-source BUSINESS_ID START_DAY END_DAY
DB_QUERY_TIMEOUT_MS=60000 node --import tsx scripts/meta-repair-config-history.ts --dry-run BUSINESS_ID START_DAY END_DAY
DB_QUERY_TIMEOUT_MS=60000 node --import tsx scripts/meta-repair-config-history.ts --apply BUSINESS_ID START_DAY END_DAY REVIEWED_MANIFEST_SHA256
```

`--queue-metric-source` queues dated metric acquisition only. Historical sync
does not fetch date-scoped campaign configuration, so this mode cannot repair
missing historic objective by itself and does not run repair in the same
command. The explicit 60-second query limit is for the bounded repair scanner:
the web runtime's default eight seconds timed out on the first 27-day preview,
while the 60-second read-only preview completed. For a preview against live
data, also set `PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000'`.
`--dry-run` reads candidate rows and
returns a stable manifest of stored fields containing field, old/new value, source ID,
observation time, account timezone, and reason. It makes no warehouse write. Review the whole
manifest before applying it. `--apply` recomputes the manifest from current DB
state and refuses a hash mismatch or a config change without a raw-linked
source. It updates only the changed config columns with exact old-value and
account-timezone guards; spend, conversions, revenue, `updated_at`, and other
metric facts are not rewritten. In the same transaction it stores the reviewed
manifest and hash in `meta_config_repair_audits` for field-level source readback. Running
the dry run again after application should yield an empty manifest. Repeating
`--apply` with the previously reviewed hash returns `alreadyApplied` without a
write only when that audit exists for the same business/range and every stored
postimage still matches; a changed postimage fails. No
historical backfill or live write is authorized by this document alone. Apply
only a reviewed, source-backed manifest under the current task's release scope.

The dated raw reader follows omitted optional fields only across complete
responses with unchanged, valid per-entity provider clocks and no requested
absence or contradiction. A repair entry retains one raw source identity. If a
same-day earlier receipt proves objective while a later receipt proves budget,
the two values are not silently merged into one entry; the unsupported field
stays for a separate source-linked repair. A dry run on a broader window must
also be timed before bulk use because retaining all same-day and corroborating
candidate receipts costs more than the former one-row `DISTINCT ON` lookup.

## Which fields a dated receipt may write

The day proof is a property of the entity-day; whether a given COLUMN may be
dated to that day is a property of the column. Those were one decision until
2026-09-22, and the 2026-09-22 dry-run manifests showed both failure directions
at once — a column riding in on a proof that did not cover it, and a whole
business blocked because `--apply` is bound to one manifest hash and cannot take
a subset. They are now separate, and `--dry-run` reports both halves:
`manifest` is what would be written, `withheldFields` and `withheldByReason` are
what was refused and why.

Three rules, each with the measurement that produced it.

1. **A bid strategy is read, never inferred.**
   `normalizeBidStrategy` (`lib/meta/configuration.ts`) reports `manual_bid` when
   the strategy token is absent and a finite `bid_amount` is present. That is
   right for a live entity and unsound as history, because by the time it runs
   `fieldNames.has("bid_strategy")` has already collapsed "never requested" and
   "requested and absent" into the same `null`
   (`lib/meta/raw-config-receipts.ts`). `manual_bid` is not in Meta's
   `bid_strategy` enum; it is a hypothesis.
   The reader now drops the whole bid triple unless the provider actually stated
   `bid_strategy` on that entity, and `metaRepairFieldAdmission` refuses
   `bidStrategyType`, `bidValue`, `bidValueFormat`, `isBidStrategyMixed` and
   `isBidValueMixed` with `bid_strategy_not_observed` at the manifest boundary.
   Measured: ColorFull `bc0c6178`, ad set `120243489401810340`, 2026-07-25 — the
   only entry in 2,766 written from a receipt that did not carry its field. Its
   own parent campaign was read as `cost_cap` from a receipt that DID request
   `bid_strategy`, and the live path resolves the same ad set the same way
   (`effectiveBidStrategy = adset.bid_strategy ?? campaignConfig.bid_strategy`),
   so the historical claim contradicted the live one. Downstream, `manual_bid`
   is outside `BID_CAP_STRATEGIES` (`lib/meta/bid-sizing-policy.ts`), so the
   fabricated label would have removed that ad set from bid actions silently.

2. **The day-closing witness must be a different RECEIPT, and must agree.**
   `meta_raw_snapshots` deduplicates payloads, so two genuine GETs of unchanged
   configuration SHARE a snapshot id — that is the normal case, not a defect.
   Receipt identity lives in `meta_raw_snapshot_observations`, whose unique key
   includes `observed_at` so that every distinct observation INSTANT is its own
   row (`lib/migrations.ts`); a same-instant replay heartbeats instead of
   appending, so equal observation ids really do mean one receipt.
   The reader now carries `observationId` and `corroboratingObservationId` on
   every receipt, `repair.ts` exports one predicate `isSameProviderReceipt`, and
   both the day proof (`sourceProvesWholeProviderDay`) and the apply-path guard
   (`meta_repair_corroborator_is_the_source_receipt`) use it. The manifest
   carries both identities beside the two content ids.
   A legacy snapshot-only receipt has no observation row and therefore no
   receipt id; two of them on one canonical snapshot cannot be shown to be
   distinct GETs, so an unknown identity falls back to the content id and is
   refused. The value and `updated_time` agreement checks were already present
   and are unchanged; what was missing was witness identity.
   **A first version of this rule compared SNAPSHOT ids and was wrong** — it
   discarded real second witnesses. Verified read-only on production for the
   case that prompted it: Silveristic `67a9b51a`, ad set `120251869715690343`,
   2026-09-11. Its source and witness are observations
   `e5511bab-9e3e-4f5d-a320-01926c072912` (2026-09-12T04:53:37.979Z) and
   `c86e1e4b-bd90-4123-8789-2d1aa3c67198` (T05:00:07.888Z): separate rows, both
   fetched/HTTP 200/natural_end, each `created_at` equal to its own
   `observed_at`, same partition, on one canonical snapshot
   `0d629df6-9f35-45c0-a83c-100354f83bc4` that carries 211 observations across
   24 hours. That day is legitimately repairable and is back in the manifest.

3. **`updated_time` does not date a budget.**
   Meta's Campaign reference documents `updated_time` only by exclusion, and two
   of the three write classes it names as NOT advancing it are daily budget and
   lifetime budget (the third is `spend_cap`); the same point is recorded in the
   header of `lib/meta/config-field-source-contract.ts`. The whole-day proof
   rests on `updated_time <= dayStart`, so for exactly those columns it proves
   nothing: a budget could change, or change and revert, inside the day without
   moving the clock. Nothing else this path collects covers the gap — across the
   four non-empty 2026-09-22 manifests, 2,749 of 2,766 entries had their two
   witnesses less than an hour apart, both straddling local midnight (median 7.5
   minutes on TheSwaf), which dates a budget to the end of the day and to
   nothing else.
   `metaRepairFieldAdmission` therefore refuses `dailyBudget`, `lifetimeBudget`
   and `isBudgetMixed` with `budget_day_opening_unobserved` unless the source
   observation is at or before the provider-local day's opening.
   **This is written as a condition, not a ban.** What would satisfy it is an
   observation of the same value at or before the day's opening, which together
   with the day-closing corroborator brackets the day without relying on that
   clock. Today's reader selects its source from inside the day, so it cannot
   supply one and every budget field is refused. A reader that later selects a
   day-opening receipt satisfies the rule with no change to it.

### What the rules do to the 2026-09-22 manifests

Measured by re-running `--dry-run` read-only against production
(`PGOPTIONS='-c default_transaction_read_only=on'`), one run per business:

| business | before | after | bid refused | budget refused | lost to rule 2 |
|---|---:|---:|---:|---:|---:|
| TheSwaf `172d0ab8` | 2,528 | 1,816 | 0 | 712 | 0 |
| IWA-MDNLLC `f8a3b5ac` | 210 | 150 | 0 | 60 | 0 |
| ColorFull `bc0c6178` | 17 | 12 | 3 | 2 | 0 |
| Silveristic `67a9b51a` | 11 | 11 | 0 | 0 | 0 |
| **total** | **2,766** | **1,989** | **3** | **774** | **0** |

ColorFull is the point of the field-level split: it keeps both campaign
`objective` rows, both campaign `bidStrategyType` rows (which WERE read from a
receipt carrying `bid_strategy`), and all four sound ad-set config fields.
Before the split, one unsupportable column held all seventeen. Note the two
refusal routes differ in where they show up: the three inferred ad-set bid rows
never reach the manifest boundary at all — the reader drops the triple, the
payload's bid fields become null, and the null-filling hydrator leaves the
stored null alone — so only the two campaign budget rows appear in
`withheldFields`. New hashes from these runs: TheSwaf `fa92539e…`, IWA-MDNLLC
`f387a6cc…`, ColorFull `b8f791ef…`, Silveristic `3065aeb5…`.

Every manifest hash from 2026-09-22 is therefore stale by construction: re-run
`--dry-run` and review the new hash before any `--apply`. `withheldFields` is
deliberately NOT part of the hash — it reports what apply never touches, and
folding it in would invalidate a reviewed hash on every refusal.

### Still open, and not addressed here

- **Budget and bid units.** `parseNum` (`lib/meta/live.ts`) stores Meta's minor
  units unscaled, while the bid-intent projection treats `bid_value` as major
  and multiplies by `10^exponent`. No live ad-set row reaches that path today —
  the only bid-moving recommendation type is campaign-grain while the projection
  requires `level === "adset"` — so this is latent, not active. TheSwaf's 18
  read `bidValue` rows are admitted by these rules and land on exactly the row
  that path would read, so the unit contract should be settled before they are
  applied.
- **The 1,842-row missing-actions residual** in the link-click previews is a
  separate repair and is untouched by this change. A dated provider re-read of
  TheSwaf's 93 rows returned matching spend and impressions and still no
  `actions` array, so re-queuing the same selector is not demonstrated to fix it.

## Evidence required before release

The typed config tables are transition logs: an unchanged API response need not
append a row. Their last row alone cannot prove a later day's configuration.
The live 2026-09-22 read found no fetched `campaign_configs` observation after
2026-08-22 in the examined 12-account history; the later typed history is
`warehouse_daily` derived from Insights, not a campaign-config receipt. In the
25 August–20 September window, 20 distinct positive-spend campaigns have a
NULL objective in `meta_campaign_daily`, including the original 13-campaign
sample. A read-only GET using the corrected campaign selector completed on all
12 accounts: 2,209 current campaign rows, each with an objective, no field
degradation, and natural-end pagination (the 621-row account required two
pages). That establishes the current request works; today's returned objective
does not establish any campaign's historical objective for an earlier report
day. The ad-calibration and ad-decision loaders must agree on field-level source
authority before a release can claim historical objective coverage. Preserve
unverified values for diagnosis, but do not grant decision authority from a
daily value or typed row whose original config receipt and date are unproven.
An unchanged but independently verified daily value also needs provenance;
recording only changed values in repair audits is insufficient.

The bounded historical differential replay is available immediately, before a
deployment. It compares retained inputs and pure decision transforms without
production writes. It is not an integrated native job run and cannot prove
that a newly deployed scheduler, DB writer, API, and mounted UI all advance
together. Historical replay, full local gates, and a mounted UI check are the
pre-deploy acceptance route. Three natural production waves over at least
24 hours are a subsequent live acceptance check, not a reason to delay a
verified release. A day of waiting also cannot create
missing historical facts or satisfy a 20/30 evidence threshold by itself.

A read-only 2026-09-22 repair preview over the seven businesses with missing
objective on 2026-08-25 through 2026-09-20 found 2,749 field-level changes,
all in adset daily rows, and no source-backed campaign objective change. One
business accounts for 2,528 of those fields; two others account for 11 and
210, and four have an empty manifest. A separate ColorFull 2026-07-25 preview
has 17 field changes, including two campaign objectives. Every proposed change
has a raw source ID and an old/new value; the 2,766 total is a preview, not an
applied repair. No present-day objective should be backdated to fill the seven
businesses' historical gaps. Rerun and review each manifest on the release SHA
before applying it.
The 2,749 August–September changes cover 397 distinct adset-days. Their chosen
source was observed at most 11 minutes 13 seconds before the provider-local day
ended, and the confirming receipt arrived 4–29 minutes after the chosen source.
The four ColorFull entity-days instead have an approximately 3-hour-18-minute
unobserved end-of-day gap and require separate field-level review, especially
for budget and bid fields whose provider update clock is not a complete change
log. These intervals bound the evidence; they do not prove that an unobserved
change and reversal was impossible.

1. For the original 13 affected campaigns and the other seven now identified,
   trace the raw current campaign response, typed history row, current decision
   context, API response, and mounted UI.
   The original 13-campaign sample had 10 SALES, one LEADS, one ENGAGEMENT and
   one TRAFFIC when checked against current provider values. The wider 20 have
   16 SALES, two ENGAGEMENT, one TRAFFIC and one LEADS. A new release has to
   demonstrate its own source-backed coverage and must not claim these
   current values held across the whole historical window.
2. For funnel stages, compare raw `actions` to all ad-grain readers. Bare
   `add_to_cart` and `initiate_checkout` are not summed with their `omni`
   variants. An `actions` array without an event is measured zero; a missing
   array or malformed count is not. Creative-grain flattened payloads retain
   their separate reader. Link-click backfill follows the existing
   `scripts/meta/link-click-repair-backfill.ts` candidate contract and is
   previewed before any write. A dated read-only Meta re-query of TheSwaf's 93
   rows without stored `actions` returned the same 93 rows with matching spend
   and impressions but still no `actions`; an ordinary re-sync of that selector
   cannot be counted as their repair. Meta separately returned
   `inline_link_clicks=0` for those rows. Keep its separate field/attribution
   scope explicit until proven equivalent to this column's
   `actions.link_click` contract; otherwise leave these 93 as missing rather
   than inventing a measured zero. The upper-funnel ad reader also must keep
   video starts, `actions.video_view`, and ThruPlay as distinct measurements;
   the first cannot fill a missing three-second view and the second cannot
   fill a missing ThruPlay. Older creative-grain flattened thumbstop ratios
   require their own source-lineage check before decision use.
   Ad-set totals and merged chart points remain missing if a delivered
   contributor lacks the field; one measured ad must not make a partial total
   look complete. The Assets ad-name fallback may fill only a missing ad-day
   value from a uniquely mapped creative day, never overwrite a measured zero.
   Link-click repair records the report-day pair and warehouse knowledge cutoff
   separately. For a present-day restatement of a historical pair, pass an
   explicit `--admissibility-cutoff YYYY-MM-DDTHH:mm:ss.sssZ` to include rows
   finalized after the report day; reuse that exact cutoff in dry-run and
   execution. Execution also requires
   `--expected-manifest-hash <sha256>` from that dry run, in addition to the
   existing `--execute` flag and environment lock. The apply recomputes the
   full plan before its first update and writes nothing if any old value, new
   value, source identity, raw `actions` digest, or reason changes. Each UPDATE
   also compares the reviewed `link_clicks` pre-image, source snapshot, and
   canonical raw `actions` value. If any row changes while apply is running,
   the complete transaction rolls back and a newly reviewed dry-run is
   required; a partial reviewed manifest is never committed. The default end-of-report-day UTC cutoff preserves historical
   preview semantics and can exclude later finalized captures.
3. Positive cases with sufficient economic evidence must produce a decision;
   genuinely missing target, sample, source, or recovery data must retain its
   own hold reason. Cut role-neutrality and Scale/fatigue readiness are
   evaluated separately from the recommendation itself. No UI computation of
   buyer action or automation permission is introduced. Campaign-role inputs
   use ad-day spend and the newest ad state as of the provider-local day. A
   winning `absent_unconfirmed` state or an unobserved creative field leaves
   that ad-day unresolved; an older creative is not silently revived. A held
   Cut may state that its performance verdict is complete, but must not claim
   proven financial loss when its boundary is relative to a commercial target
   rather than a measured break-even. A missing `custom_event_type` is irrelevant
   for non-purchase goals; for purchase goals, check whether the source instead
   names a [`custom_conversion_id`](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adpromotedobject.py)
   before describing the conversion target as absent. The conversion type
   behind that ID remains unverified until read
   from its own source.
4. Complete `npm run verify:pre-push`, fresh database seams, and mounted UI
   checks on a pinned integrated tree. Include bounded real-source reads for a
   high-volume account under the native calibration job's 60-second
   per-statement limit and transaction-local 16MB work memory.
   The previous SQL's 42 bounded reads had a 27.4-second tail. After the
   measured query repair, four accounts matched every source row and the
   slowest observed current SELECT was 7.332 seconds in paired reads. This is
   evidence on those windows, not a bound on all later loads. A full Bilsem
   decision loader returned 3,200 ads in 34.6 seconds total before the latest
   query repair; each statement stayed under its 30-second limit, but the loader's
   eight-second web-pool budget still needs its own current measurement. A
   transaction may exceed a statement limit because it covers multiple reads.
   Re-run after any source-query change.
5. Freeze the release source manifest, pass the full gate, then deploy the
   same tested SHA under the user's authorized scope. Before deployment, run
   point-in-time historical simulations for representative accounts and a
   real source-gap negative control. Report source-backed presentation
   separately from a source-authorized hard action; a presence pass cannot
   certify the latter. Read back build identity, source, persisted calibration
   and decisions, API, and mounted UI immediately after deployment. Natural
   production waves provide forward source-health evidence, but no fixed
   24-hour wait substitutes for the historical and immediate live checks.
   If historical data cannot establish hard-action authority, say so and do
   not treat a simulated positive verdict as a live authorization. Keep
   automation permission disabled.

The historical D077 release manifest remains pinned to its own completed
source tree. This repair has a separate
`docs/meta-decision-center/RELEASE_SOURCE_MANIFEST_2026-09-22.json`, generated
last from the exact changed source bytes before tests, commit and deployment.
Its verifier checks the candidate path set and SHA-256 values against the
pre-repair base; temporary `scratchpad/` scripts are excluded from release.
