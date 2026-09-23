# The ISO minor-unit chain — what was actually wrong, and what was not

2026-09-22, follow-up to `CURRENCY_UNIT_REPAIRS_2026-09-22.md`. Closes its two
remaining open items. Read-only production access only
(`REPEATABLE READ READ ONLY` + `ROLLBACK`); no provider write, no commit, no
deploy.

Untouched, by instruction: `lib/creative-decision-engine/jobs/ad-calibration-job.ts`,
`docs/meta-decision-center/CALIBRATION_SOURCE_QUERY_PERF_2026-09-22.md`,
`scripts/creative-decision-center/native-ad-repair-differential-replay.ts`.
`ad-calibration-job.ts:5047` is an ISO consumer and is listed below as another
lane's to decide, not analysed.

---

## 1. The registry, re-verified

Two independent reads of
`https://developers.facebook.com/docs/marketing-api/currencies/`.

| | value |
|---|---|
| table rows | **66** |
| distinct offsets | **1 and 100 only** — nothing above 100 |
| offset-1 codes | CLP COP CRC HUF IDR ISK JPY KRW PYG TWD VND (11, identical both reads) |
| a stated currency count on the page | **none** |
| FBZ | present, Name "credits", offset 100 |

The registry held 65. **FBZ was the one missing row** and is now carried at
offset 100 — see §0 of the first report for why the exclusion could not be
proved and why including it costs nothing. Version bumped to
`meta.currency-offsets.2026-09-22.2`; it is persisted nowhere, so the bump is
free.

The claim that the page "states it lists 103 currencies" was mine and was not
in the source. It is retracted in the registry docblock, in the first report,
and pinned against by a test (`META_CURRENCY_OFFSET_SOURCE` must not match
`/103/`).

---

## 2. What the chain actually does with an exponent

Measured before repaired. The single most decision-relevant fact, from
read-only production:

> **No divergent-or-unlisted currency has ever been stored anywhere.** Every
> exponent-bearing table and jsonb payload holds only USD, TRY, GBP and EUR —
> and all four agree between the two registries.

So **every divergence is latent, and no migration is required.** That is what
made a corroboration gate possible instead of a migration.

The second fact reshaped the whole repair:

> **The exponent mostly is not used to scale anything.** The percent arithmetic
> (`applyPercentToMinorUnits`) is scale-free — minor units in, minor units out,
> no currency. Through most of the chain the exponent is *carried as provenance
> and hashed into an idempotency key*, not multiplied by.

### A claim from the first report that is now disproved

That report said `bid-sizing-policy.ts:250` (`cpaMinor = cpaMajor * 10**e`) was
a live wrong-decision path for a divergent currency. **It is not.**
`snapshot.ts:1075` builds `spendUnitMinor = round(majorSpendUnit * 10**e)` from
the *same* `e`, and `bid-sizing-policy.ts:251` divides one by the other — so
`ratio = cpaMajor / spendUnitMajor` at every exponent. Verified numerically:
HUF at e=2 and e=0 both give 1.2000000000; BHD at e=3 and e=2 likewise. The bid
rung is exponent-invariant. The site is left on ISO deliberately.

The same cancellation holds for the Shopify AOV: `shopify-aov-source.ts` mints
`aovMinor` at an exponent and `account-decision-profile.ts:291` divides by that
same recorded exponent — the only reader there is. **That one nearly cost a
regression:** the `?? 2` fallback there reads exactly like the silent
two-decimal default this codebase forbids, and it was "fixed" into a refusal
before the round trip was checked. Reverted. Converting it would have withheld a
usable store AOV on every currency the ISO registry does not transcribe, for a
scale error that cannot occur. The invariant is now written at the mint site and
pinned by a test that asserts there is exactly one reader and that it divides.

---

## 3. The approach: corroborate, do not replace

Swapping ISO out for the provider registry across the chain would have to move,
atomically: every producer, every validator that re-derives and compares, every
idempotency key that hashes the exponent, every persisted
`currency_registry_version`, and every served dry-run receipt. Move one end and
the other fails closed on something that works today.

`lib/currency/provider-corroborated-minor-units.ts` (new) instead makes the
existing number *true*: an ISO exponent may enter the chain only when Meta's own
offset implies the same subdivision-digit count.

- Where they agree it **returns the ISO value unchanged**, with the ISO registry
  version. Every downstream key, receipt and retained fact is byte-identical.
- Where they disagree, or the provider publishes nothing, it **refuses with a
  distinguishable reason**.

After this gate, a carried `currencyExponent` means "ISO says this AND Meta does
not contradict it" — which is what makes the few sites that genuinely raise 10
to it safe.

### The honest shape of the gate, pinned in a test

| | count | codes |
|---|---|---|
| admitted | 41 | incl. USD, TRY, GBP, EUR, JPY, KRW |
| refused — the two registries disagree | 6 | BHD COP HUF IDR JOD TWD |
| refused — the ISO registry does not hold the code | 19 | BDT BOB CRC DZD FBZ GTQ HNL HRK KES LTL LVL MOP NIO PKR RUB SKK UYU VEF VES |

**The 19 are not a regression and not caused by this work.** The ISO registry in
this repo is deliberately partial, and `resolveMinorUnitExponent` already
refuses every one of them — a Meta account in PKR, RUB or KES could not carry a
budget or bid intent before this change either. The gate reclassifies the
reason; it removes no capability. Widening it would mean minting an exponent
from the provider table while the emitted `currencyRegistry.version` still names
ISO — a provenance claim the contract cannot support. Left closed, and reported
here so it is a decision rather than an oversight.

### The split that decides which authority applies

Not every site wants corroboration. The rule used throughout:

- **Scaling a provider amount, where both sides are already provider units** →
  **Meta's offset alone.** ISO has no bearing on it, and demanding corroboration
  would needlessly refuse the 19.
- **Stamping or hashing an exponent as provenance** → **corroboration**, because
  the emitted registry version names ISO and that claim must be true.
- **A non-provider amount** (Shopify order values, bank figures) → **ISO alone**,
  unchanged.

---

## 4. What was repaired

### 4a. The per-action spend ceiling — the one that mattered

**A safety guardrail that failed OPEN, live, mounted and persisted.** Found
independently by two of the six tracing lenses and confirmed by hand.

`guardrails_json.perActionSpendCeilingMinor` is minted from what an admin types,
times `10**exponent`, and is then compared **unscaled** against the provider
minor-unit amount an automated budget write would send
(`budget-write-safety-projection.ts:180`, `budget-sizing-policy.ts:452`). The
exponent came from ISO.

On a HUF business a ceiling entered as 50,000 forint was stored as 5,000,000 and
compared against real forint — **a limit a hundred times looser than the one the
operator set**. On BHD, ten times. And the read-back used the same wrong
exponent, so the form showed exactly what they typed: invisible from the UI.

Three independent gates now, because a ceiling that fails open is worse than no
ceiling:

1. **The editor** (`automation-view.tsx`) mints and renders through the provider
   offset. No offset → no ceiling can be entered.
2. **The server** (`budget-automation-config-contract.ts`) refuses a well-formed
   ISO code the provider publishes no offset for, with its own rejection code —
   a raw POST never touches the editor.
3. **The read path** (`automation-control-plane.ts`) marks the pair invalid, so
   `snapshot.ts` passes null and `budget-sizing-policy.ts` withholds with
   `policy_spend_ceiling_unset`.

**No ceiling means no budget change at all**, so refusing an unscaleable ceiling
is fail-closed, not permissive. Verified in `budget-sizing-policy.ts:294`.

`automation-posture.ts` AUTO-06 also rendered the raw integer — "5000" for a
$50.00 ceiling, in a safety guardrail list. Now shown at the provider's offset,
or labelled as minor units when unknown.

### 4b. The two intent contracts

`bid-intent-contract.ts` and `budget-intent-contract.ts` resolved ISO with no
provider check, then stamped `currencyExponent` into the intent, hashed it into
`intentKey`/`idempotencyKey`, and carried a `currencyRegistry` naming ISO.
Both now gate on corroboration with a new rejection code,
`currency_scale_not_provider_corroborated`.

**Key stability is the property that let this land**, and it is asserted rather
than argued: the gate filters and never substitutes, so USD, TRY, GBP, EUR and
JPY re-derive byte-identical keys. A moved idempotency key would orphan every
open proposal slot.

### 4c. The persisted operator-facing money label

`exactMoneyLabel` placed the decimal point from the stored ISO exponent and its
output is written to `meta_automation_proposals.evidence_label` — the string a
person reads before approving a provider write. A HUF proposal for a
1,200-forint cap read "HUF 12.00".

It existed **twice, byte for byte**, in `bid-proposal-producer.ts` and
`budget-proposal-producer.ts`, both writing that same column. Three adversarial
verifiers caught the duplicate after the first copy was fixed — which is how a
duplicated formatter fails: not by being wrong everywhere, but by being right in
the place someone looked. Extracted to `lib/meta/provider-money-label.ts`, one
copy, placement from the provider's offset, and an explicit
`"<CODE> <n> minor units"` when the provider disagrees with the carried exponent
or publishes nothing. The envelope is untouched — `currencyExponent` stays in
the proposal fingerprint exactly as it was.

### 4d. Read-side and validator-side guards

- `budget-readiness-retention.ts` — the CAPTURE side. It resolves and stamps its
  own exponent beside a registry version naming ISO, independently of the
  provenance writer, so it needed the gate too (new blocker
  `budget_fact_currency_scale_not_provider_corroborated`).
- `budget-fact.ts` — the matching READ side: a retained fact may not be honoured
  at a scale the provider denies (new blocker
  `currency_scale_not_provider_corroborated`). Covers rows retained before the
  capture gate existed.
- `budget-proposal-dry-run.ts` — the validator half of the producer rule, so a
  request minted outside the contract cannot mint a receipt at a denied scale.
- `lib/api/meta.ts` `metaBudgetCurrencyProvenance` — **consolidated**. It
  open-coded the same agreement test; it now calls the shared module. Two copies
  of one rule is how two ends of a chain drift apart, and this is the gate the
  whole bid arm fails closed behind.

---

## 5. What was deliberately NOT changed

| site | why |
|---|---|
| `bid-sizing-policy.ts:250`, `snapshot.ts:1012/1075` | the exponent **cancels** in `ratio = cpaMinor / spendUnitMinor`; both sides use the same `e`. Verified numerically. |
| `shopify-aov-source.ts` + `account-decision-profile.ts:291` | non-provider, and the same cancellation. A "fix" here was reverted after the round trip was checked. |
| `decisions-workspace/route.ts:813`, `account-profile-output-producer.ts:654` | Shopify merchant AOV, not a Meta amount. ISO is the right authority. |
| `applyPercentToMinorUnits`, `MAX_MINOR_UNITS` | currency-free. |
| `iso-4217-minor-units.ts` itself | correct at the bank question. Two authorities that disagree must stay apart, not be merged. |
| `formatMinorUnitsForDisplay` | takes a digit count, not a currency — correct once the count comes from the provider. |
| the 19 ISO-silent currencies | see §3; a deliberate non-expansion, not an oversight. |
| `ad-calibration-job.ts:5047` | another lane's file. |
| `scripts/audits/d081-*`, `d083-*` | audit artifacts only, no decision or write. Consistency pass not taken. |

---

## 6. Still open

1. **The 19 ISO-silent currencies stay closed.** Real Meta advertising
   currencies (BDT, KES, PKR, RUB and fifteen more) cannot carry a budget or bid
   intent. Pre-existing, unchanged, now named and counted. Closing it means
   either transcribing those ISO exponents from the published standard, or
   making the provider table the primary authority and changing what
   `currencyRegistry.version` claims. Both are decisions, not clean-ups.

2. **The audit scripts still read ISO directly.** Artifact-only, so no decision
   or write is affected, but their stamped registry version now means something
   narrower than the chain's does.

3. **`provider_accounts` holds 10 Meta rows with currency EUR** while no EUR
   account has produced a warehouse fact or a state-history row. Assigned but
   never synced, or stale? Not resolved here. EUR agrees between both
   registries, so nothing in this pass depends on the answer.

4. **The first report's `bid-sizing-policy` claim is retracted** — see §2. Noted
   here because it was stated as a live defect and it is not one.

---

## 7. Verification

- `npx tsc --noEmit` — clean.
- `npx eslint` over every file changed in this working tree — clean.
- New: `lib/currency/provider-corroborated-minor-units.test.ts` (9 cases,
  including the full 41/6/19 split asserted from both registries and a
  no-regression case proving nothing ISO alone admitted is newly refused),
  `lib/meta/automation-spend-ceiling-scale.test.ts` (8 cases: the HUF
  hundredfold, per-currency round trips, the three server gates, and a source
  pin on the editor).
- Extended: `lib/currency/meta-currency-offsets.test.ts` (66-row count, the
  11-code offset-1 set, FBZ, the retracted-count guard),
  `lib/meta/bid-intent-contract.test.ts` and
  `lib/meta/budget-intent-contract.test.ts` (corroboration refusals plus
  idempotency-key stability for every live currency),
  `lib/meta/budget-automation-configuration.test.ts`,
  `lib/creative-decision-engine/shopify-aov-source.test.ts` (the round-trip
  invariant and a guard that there is exactly one reader).
- Corrected tests that pinned the defect. `budget-intent-contract.test.ts` and
  two `budget-fact.test.ts` tables asserted KWD as a valid three-decimal Meta
  currency carrying a READY fact at exponent 3. There is no such thing — Meta
  publishes no offset above 100 anywhere. Replaced with live currencies plus an
  explicit refusal case covering both shapes.
- Narrowed one bundle-purity assertion rather than duplicating a registry.
  `budget-preparation-route.test.ts` required `budget-automation-config-contract.ts`
  to have ZERO imports, to keep a browser-shipped module free of server weight.
  The server-side ceiling guard needs the offset table, so the assertion now
  admits that one module BY NAME and additionally asserts the table itself has
  no imports — the property the rule was protecting. Inlining a copy of the
  registry to satisfy the stricter form would have recreated the duplication
  this pass spent its time removing.
- **Whole suite** (`npx vitest run lib components app`): **19,141 passed, 1
  failed, 778 skipped, 63 todo across 1,348 files.** The single failure is
  `lib/meta/__tests__/decision-release-source-manifest.test.ts`, which sha256-pins
  every file changed since `ef33d238b9b0` — that is the release-manifest lane's
  to regenerate, and it is stale for both lanes' files, not only this one.
  (The `decision-ctr-scalar-units` and `MetaDrillDrawer` failures recorded in
  the previous report are no longer failing; the other lane resolved them.)
- Final confirming run after the last change
  (`lib/currency lib/meta lib/creative-decision-engine lib/zero-base` plus the
  automation route and view suites): 8,865 passed, same single failure.
