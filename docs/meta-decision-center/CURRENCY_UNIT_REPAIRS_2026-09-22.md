# Meta money units — what was wrong, what changed, what is still open

2026-09-22. Scope: the five reported bid/budget unit defects, plus the root
cause of the NULL `budget_currency_exponent`. No production write, no provider
mutation, no commit, no deploy. Live database access was read-only
(`REPEATABLE READ READ ONLY` + `ROLLBACK`).

`lib/creative-decision-engine/jobs/ad-calibration-job.ts` and
`docs/meta-decision-center/CALIBRATION_SOURCE_QUERY_PERF_2026-09-22.md` were
not touched — they belong to the concurrent performance lane.

---

## 0. The authority this rests on

**Meta publishes its own per-currency `offset`, and it is not the ISO-4217
exponent.** It is a MULTIPLIER, not an exponent, and Meta publishes exactly two
values — 1 and 100. `lib/currency/meta-currency-offsets.ts` is the new registry;
`lib/currency/meta-currency-offsets.test.ts` pins it (17 cases).

Where the two authorities disagree, derived from both registries rather than
asserted:

| code | Meta offset | Meta digits | ISO exponent | error if ISO is read |
|---|---|---|---|---|
| COP, HUF, IDR, TWD | 1 | 0 | 2 | **100x** |
| BHD, JOD | 100 | 2 | 3 | **10x** |
| KWD, OMR, TND, IQD, LYD | *(not listed)* | — | 3 | a scale nothing supports |

Meta lists no offset above 100 anywhere. The two three-decimal currencies it
*does* list — BHD and JOD — are both mapped to 100. So an ISO-derived ÷1000 for
KWD was more likely wrong than right, which is why refusing is not merely the
conservative choice here.

**Transcription, corrected 2026-09-22 (follow-up).** An earlier revision of this
report and of the registry docblock said the page "states it lists 103
currencies" and that 66 of them had been transcribed. **That was wrong on both
halves.** The page states no count at all, and 66 was never a partial reading —
it is the whole table. Re-verified by two independent reads: 66 rows, the same
11-code offset-1 set both times, no offset outside {1, 100}.

The registry held 65 of the 66. The missing row was **FBZ**, whose Name column
reads "credits" — Facebook Credits, the virtual currency retired in September
2013 — and which is not an ISO-4217 code. It had been dropped as an obvious
non-currency, which is exactly the silent editorial judgement a provider
registry must not make: the page introduces its table as the currencies ad
accounts support, lists FBZ in it, publishes 100 for it, and marks no row as
unusable. The exclusion cannot be proved from the source and the source
affirmatively includes it, so **FBZ is now carried at offset 100**. The cost of
being wrong is asymmetric and small — no live account is denominated in it, and
`Intl.NumberFormat` renders it as a plain code prefix rather than throwing.

Registry version bumped to `meta.currency-offsets.2026-09-22.2`. It is not
persisted anywhere, so the bump is free.

**This changes what a refusal MEANS.** While the reading was believed partial,
a code absent from the registry meant only "nobody transcribed it". Now the
registry IS the page, so an absent code means the page does not list it. That
upgrades the KWD/OMR/TND/IQD/LYD refusals from caution to evidence.

USD, TRY and GBP — every currency the warehouse actually holds — agree between
the two authorities, and so do JPY and KRW. **Every divergence below is latent,
not currently active on a live account.**

---

## 1. Launchpad budget/bid x100

Two separate sites, and the one that was NOT reported is the one that is live.

### 1a. The reported site — `lib/launchpad/meta-store.ts`

`listRecentMetaLaunchTemplates` multiplied the stored budget and bid by 100.
Served by `GET /api/launchpad/meta/templates/recent` and the workspace route,
but **not consumed**: the mounted body reads `templates` only as `.length`, and
`onApplyTemplate` does not exist anywhere in the repo.

Three fixes, landed together because a half-repair is worse than none:

- `amountMinor` and `bidAmountMinor` pass through.
- `schedule` now comes off the same column the amount did. The old predicate
  read `lifetime_budget !== null` alone, so a row carrying BOTH budgets took the
  daily number (via `??`) and labelled it "lifetime".
- `bid_strategy_type` is the lowercase token `normalizeBidStrategy` writes
  (`bid_cap`, `cost_cap`, …), never the Meta API enum the code compared against.
  The comparison could not be true for any stored row, so every template came
  out stamped `LOWEST_COST_WITHOUT_CAP` while still carrying a bid amount —
  a combination `validateMetaLaunchPayload` does not catch.

**Correction to the original report:** sub-claim (d) was wrong. Line 342 *does*
check `bid_value_format === "currency"`, so a ROAS ratio was never carried as a
currency bid. That guard is kept.

### 1b. The unreported site — the list routes, live and rendered

`app/api/launchpad/meta/campaigns/route.ts` and
`app/api/launchpad/meta/adsets/route.ts` applied the identical `× 100` to the
same columns. This one **is** consumed and **is** rendered: the add-to-existing
flow shows it through `components/launchpad/LaunchpadReview.tsx`.

The two errors cancelled exactly, because the renderer divided by 100 again. So
both ends moved in one change:

- the routes pass the stored value through (`storedBudgetMinorUnits`);
- `LaunchpadReview` divides by the **provider's** offset and renders
  `"Unavailable"` when the currency has none.

Test fixtures used `daily_budget: 50` and expected `5000` — they pinned the
defect by treating the column as major units. Corrected to realistic minor-unit
values with the reason recorded inline.

### 1c. The operator↔provider conversion (write path)

`amountToMinorUnits` / `amountFromMinorUnits` (`lib/launchpad/meta.ts`) were a
hardcoded `×100` / `÷100` on operator-typed amounts, and the result goes to
`daily_budget` / `bid_amount` verbatim. A ¥5,000 daily budget would have been
submitted as ¥500,000.

Both are now currency-aware. An unresolvable currency yields `0` — the same
sentinel a blank amount already produces — so the launch stops at the existing
`budget_required` / `bid_amount_required` blocker rather than sending a number
at a scale nobody can name.

**Why the column is minor units, from four directions:** `lib/meta/live.ts`
parses Meta's string with a bare `parseFloat` and never scales;
`roundCurrencyAmount` is a two-decimal round, not a scale; `lib/meta/warehouse.ts`
throws `meta_current_config_history_daily_budget_source_mismatch` unless the
stored value equals the raw provider number; and the write path posts the same
value straight back to Graph.

---

## 2. ROAS floor normalization and the second read

`normalizeTargetRoasValue` was two functions wearing one name:
`Math.abs(value) > 100 ? value / 10000 : value`.

Meta documents the scaling as unconditional and the range as `[100, 10000000]`:

> "In the API, `roas_average_floor` is an integer and scaled up 10000x …
> `roas_average_floor = 100` means 'the minimum roas' = 0.01 …
> `roas_average_floor = 23300` means 'the minimum roas' = 2.33"

Two distinct wrong magnitudes:

1. **At Meta's documented minimum, raw 100**, `Math.abs(100) > 100` is false —
   so a floor of 0.01 was stored as a ROAS target of **100x**. Exactly at the
   boundary, on a value the provider is documented to send.
2. **`lib/meta/config-snapshots.ts` re-applied it on the READ path**, to a value
   that had already been divided at capture.

Replaced by `metaTargetRoasFromProviderFloor`, which only ever accepts a RAW
provider floor, divides unconditionally, and refuses out-of-range input. The
read path passes the stored multiplier through unchanged.

**The two changes had to land together.** Making the divisor unconditional while
leaving the second application would have turned a stored 2.5 into 0.00025.

**Proven safe against stored data, read-only:** 88,993 retained ROAS rows
across `meta_adset_daily` (35,037), `meta_campaign_daily` (19,066),
`meta_adset_config_history` (34,771) and `meta_config_snapshots` payloads (119).
**Zero above 100, zero exactly 100**, range 1.5–6.0, 13 distinct values. So both
arms — the second application and the boundary — have never fired on stored
data, and no served number moves as a result of this repair.

A test asserts the function is **not idempotent** (feeding the output back in is
refused). That is the property that makes a second application a defect rather
than a harmless no-op, and the old magnitude branch was what hid it.

One existing test fed `targetRoas: 3.4` — a value the provider cannot send — and
expected 3.4 back. It pinned the dual-domain assumption. Corrected to raw 34000.

---

## 3. Hardcoded /100 displays

Ordered by whether an operator can actually see the number today.

### Live, on the Decision Center

| site | what it shows |
|---|---|
| `components/meta/redesign/meta-card-utils.ts` | the bid cap in the confirmation dialog, read immediately before authorising a write |
| `components/meta/redesign/MetaPlatformPage.tsx` | the notice shown AFTER a bid-cap write succeeds or dry-runs |
| `lib/meta/recommendations.ts` (bid band, bid value) | strings rendered in the Decision Center inspector |
| `lib/meta/decisions-os-presentation.ts` | every bid value and budget in the decisions-workspace payload |
| `app/api/meta/lane-classify/route.ts` | budget utilisation |
| `components/launchpad/LaunchpadAddToExistingTarget.tsx` | the target's existing budget |

`proposedBidDisplayValue` had a second defect beyond the divisor: it returned
**minor units on one branch and major units on another**, with nothing to tell
them apart. The undiscriminated branch read
`targetValue.bidValue / .bidAmount / .proposedBidCap`; no producer in the repo
writes any of those three keys (the bid intent projection writes
`proposedMinorUnits` / `currency` / `currencyExponent`), and none carries a
`bidValueFormat`. That branch was **removed rather than reinterpreted** —
guessing would print a bid cap 100x off in a confirmation dialog, while refusing
prints "—".

### Not currently mounted, fixed anyway

`MetaDrillDrawer.tsx`, `MetaActionCard.tsx`, `MetaHealthyRow.tsx`,
`meta-campaign-table.tsx`, `meta-campaign-detail.tsx`.

`meta-campaign-table` and `meta-campaign-detail` had only a currency *symbol* in
scope, and a symbol does not identify a currency ("kr" is SEK, NOK and DKK at
once). `resolveCurrencyCode` / `useCurrencyCode` were added beside the existing
symbol resolver. This reads the **workspace** currency, which is what those
components already pair with the amount via `fmt$` — the repair makes the
existing assumption explicit rather than introducing a new one.

### The emitter that was already "fixed" with the wrong authority

`lib/meta/scenario-emitters/high-priority.ts` had been repaired in an earlier
round to stop dividing by 100 — but it read the **ISO** registry, which is the
authority this pass shows is wrong for a provider amount. Its own docblock cited
"KWD (exponent 3)" as a worked example.

- `budgetAmount` now uses Meta's offset. This feeds the A1 learning-floor gate
  and the B1 utilisation gate, both live decision outputs.
- The B1 bid proposal additionally **refuses when Meta and ISO disagree**, or
  when Meta publishes no offset. The emitted `minorUnitExponent` travels into
  the bid-intent contract, which re-derives it from ISO — so the two ends agree
  with each other and not necessarily with the provider. A withheld proposal is
  a visible absence; a mis-scaled one is a live overpay.

Its tests asserted KWD at three decimals. Replaced with explicit refusal cases,
plus a new HUF case that discriminates in the other direction: 600 HUF/day
clears the 50-conversion floor, while the ISO reading of 6 gives 0.51 and would
report the floor as unreachable.

---

## 4. MetaDrillDrawer amounts

Two problems, one of them worse than reported.

- `configuredBidDisplay` divided by 100 — now the provider offset.
- `formatChangeValue` did **no** division and named **no** currency: it printed
  `bid amount 12,000` for a ₺120 bid cap, which reads as a hundredfold larger
  bid than the one that was written. It now formats as money at the provider's
  offset, and labels the number `(minor units)` when the currency is missing
  rather than dressing it up as an amount.

The drawer is mounted by nothing (there is a test pinning that), so this changes
nothing an operator sees today.

---

## 5. History read model format loss

`lib/meta/history-read-model.ts` emitted `bidValue` / `previousBidValue` into
the History journal's `detail` with no `bidValueFormat` beside them. `bid_value`
holds two number systems — provider minor units, or a plain ROAS multiplier —
and `bid_value_format` is the only discriminator. The served number was not
merely unscaled, it was **uninterpretable**. The column is written by the same
INSERT as the value and exists on both tables, so this was a projection
omission, not a gap in the data.

Fixed: `LAG(...bid_value_format)` in both window CTEs, and four new keys in the
two `jsonb_build_object`s.

Two further findings from the same read:

- The ad-set branch omitted **`previousLifetimeBudget`** although its own change
  predicate fires on a lifetime-budget move — so an ABO ad set whose lifetime
  budget changed served the new figure with nothing to compare it against.
  Budget lives on the ad set for ABO accounts, so this is the common case.
  Added.
- **`bid_value_format` was deliberately NOT added to the change predicate.** It
  is an input to the config fingerprint, and the fingerprint is part of the
  table's unique key — so a discriminator flip materialises a NEW row rather
  than updating one, and the predicate would surface it as a "configuration
  changed" entry for an edit nobody made. Nothing is lost: the format is a pure
  function of the bid strategy and the bid value's null-ness, both already in
  the predicate. A test pins the exclusion.

**Honest scope:** the harm here is latent. No renderer consumes `detail` at all
— `toHistoryRow` drops it, the legacy body never reads it, and
`moneyFactsForRow` builds no money fact for either config source. The operator
sees "Campaign configuration changed | <name>" with no amounts either way. This
repair makes the served payload correct; it does not change a displayed number.

---

## 6. `budget_currency_exponent` — root cause, and why it stays fail-closed

### The headline figure is mostly structural, not missing data

Read-only, 90 days, production:

| grain | rows | with exponent |
|---|---|---|
| ad | 265,349 | **0** (0.0%) |
| adset | 167,840 | 6,802 (4.1%) |
| campaign | 10,094 | **0** (0.0%) |

**`mapAdObservationState` never stamps the exponent, and that is correct.** An ad
owns no budget: all four budget fields are null and `budgetOrigin` is
`not_applicable` by construction. There is no amount to scale, so there is no
exponent to record. Ad rows are the dominant arm of the "70% NULL" figure and
they are permanent, by design. Reading that headline as missing data leads to
backfilling a scale for amounts that do not exist. The invariant is now written
at the mapper.

The currency IS kept on ad rows, because it labels the ad's own spend figures,
which are major-unit and need no offset.

### Why nothing is backfilled or restated

`budgetCurrencyExponent` is **inside the entity state hash**. Changing it
restates every affected row rather than editing it — and the growth fence on
`meta_entity_state_history` has already killed a full day of Meta observation
writes for far less. No production write was in scope here regardless.

### The read path was verified fail-closed, reader by reader

No consumer of `budget_currency_exponent` defaults to 2. A NULL yields "no
budget fact", which every surface already treats as an absence. Nothing needed
repairing there.

### What did change: the stored exponent must now satisfy both authorities

`metaBudgetCurrencyProvenance` wrote the ISO exponent. The number scales a
PROVIDER amount, so an exponent is now recorded only when Meta's own offset
implies the same number of subdivision digits. A disagreement, or a currency
Meta does not publish, records `null` — the same value an unresolvable currency
already produced, and the one every reader fails closed on.

This is forward-only and restates nothing: for USD, TRY, GBP, JPY and KRW the
two authorities already agree, so **no account this product holds produces a
different value than before**. The refusal only ever bites an account that has
not appeared. The recorded registry version stays the ISO one, because that is
where the number comes from; Meta's table is a corroborator. A stored exponent
now means "ISO said this and Meta did not contradict it".

---

## What is still open

1. **~20 other `resolveMinorUnitExponent` call sites read ISO for a provider
   amount.** — **ADDRESSED 2026-09-22** in a follow-up pass; see
   `CURRENCY_ISO_CHAIN_REPAIRS_2026-09-22.md` for what was repaired, what was
   deliberately left on ISO, and one claim in this report that the follow-up
   DISPROVED (the `bid-sizing-policy` exponent cancels; it never moved a bid
   decision). Original text follows. `bid-intent-contract.ts`, `budget-intent-contract.ts`,
   `budget-proposal-dry-run.ts`, `budget-fact.ts`, `budget-readiness-retention.ts`,
   `bid-sizing-policy.ts`, `snapshot.ts`, `decisions-workspace/route.ts`,
   `automation-view.tsx`, `account-profile-output-producer.ts`,
   `bid-intent-projection.ts`, `api/meta.ts`. These form one coherent versioned
   chain: a `currencyExponent` is emitted into `targetValue`, stored, and
   re-validated against the same registry at the queue predicate. Converting one
   end alone would fail the other closed. **Not converted.** The boundary is
   guarded instead: the emitter that feeds the chain now refuses a
   divergent-or-unlisted currency, and the provenance writer will not stamp one.
   All live accounts are USD/TRY/GBP, where the two registries agree exactly.

2. ~~The transcription is partial~~ — **CLOSED 2026-09-22.** The page has 66
   rows and all 66 are now in the registry, FBZ included. See §0. The follow-up
   also closed item 1 below; both are written up in
   `CURRENCY_ISO_CHAIN_REPAIRS_2026-09-22.md`.

3. **ROAS rounding stays at two decimals**, which is not exact: a provider floor
   between 100 and 149 all collapses to 0.01. Widening it would change the
   stored value for the same provider input, and `bid_value` is a fingerprint
   input — so every affected entity would materialise a new history row and read
   as a configuration change nobody made. Left deliberately; recorded in the
   function's docblock.

4. **`meta_campaign_config_history` wrote 0 rows in September** (the
   `bid_constraints{roas_average_floor}` request defect, §2a of the joint plan).
   That is a separate lane and is why the campaign-grain exponent count above is
   0 — not because the campaign mapper omits the stamp. It does stamp it.

5. **The History journal still renders no amounts.** §5 makes the served payload
   self-describing; it does not add a renderer. Making the movement visible
   additionally needs a money fact built from the discriminator — deliberately
   not bundled here.

6. **`readMetaAccountCurrency` reads the workspace's assigned account currency**,
   and `meta-campaign-table` / `meta-campaign-detail` read the *workspace*
   currency. Where a workspace holds accounts in more than one currency these
   are not the same fact. Pre-existing, unchanged in kind, now explicit.

7. **Three red tests in this shared worktree belong to the other lane, not to
   this repair.** Each was checked rather than assumed:

   - `components/meta/redesign/MetaDrillDrawer.test.tsx > renders informational
     upper-funnel KPIs without decision panels` expects "Hook rate (3s)". It
     fails identically with `MetaDrillDrawer.tsx` stashed back to its base
     state, so it predates this work.
   - `lib/meta/decision-ctr-scalar-units.test.ts > reads the stored trail back
     and serves it without rescaling` byte-pins a source string from
     `app/api/meta/ads/series/route.ts`. That file carries an **uncommitted**
     `ctrMissing` change (`git diff` confirms the added lines) while the test
     itself has no diff at all and was last committed in `5172235ad`. The pin
     is stale against the other lane's edit.
   - `lib/meta/__tests__/decision-release-source-manifest.test.ts` pins a
     sha256 of every file changed since `ef33d238b9b0`. It is stale for **23
     paths this repair never touched**, including
     `lib/creative-decision-engine/jobs/ad-calibration-job.ts` and
     `docs/meta-decision-center/CALIBRATION_SOURCE_QUERY_PERF_2026-09-22.md` —
     the two files reserved for the performance lane. Regenerating it now would
     stamp another lane's still-moving files into a release ledger, so it is
     left for release time, once both lanes settle.

   One guard that WAS this repair's to fix has been fixed:
   `lib/meta/__tests__/state-history-consumer-closure.test.ts` flagged the new
   `lib/currency/meta-currency-provenance.test.ts` as an unclassified literal
   reference to `meta_entity_state_history`. It is a comment-only reference and
   is now registered in both the in-test ledger and
   `docs/audits/D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md`, as the guard
   requires.

---

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` over every file changed in this working tree — clean.
- Whole suite, `npx vitest run lib components app`: **19,108 passed, 3 failed,
  778 skipped, 63 todo across 1,346 files.** All three failures are the other
  lane's, each attributed above by evidence rather than assumption.
- New: `lib/currency/meta-currency-offsets.test.ts` (17),
  `lib/currency/meta-currency-provenance.test.ts` (4).
- Extended: `lib/meta/configuration.test.ts` (ROAS contract, 7 new),
  `lib/meta/history-read-model.test.ts` (3 new SQL-contract cases),
  `lib/launchpad/meta.test.ts` (offset-1 and refusal cases),
  `components/meta/redesign/meta-card-utils.test.ts` (4 new),
  `lib/meta/scenario-emitters/b1-a1-commercial-authority.test.ts`
  (KWD/BHD/JOD/OMR refusals, HUF discriminator).
- Corrected fixtures that pinned a defect:
  `app/api/launchpad/meta/{campaigns,adsets}/route.test.ts` (budget was stored
  as if major units), `lib/meta/configuration.test.ts` (`targetRoas: 3.4`),
  `components/launchpad/LaunchpadReview.test.tsx` and
  `components/meta/redesign/MetaPlatformPage.test.tsx` (an amount printed under
  an unknown currency).
