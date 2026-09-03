# D083 — account-scoped Meta budget-fact observation, PIT ownership/schedule contract, and historical replay (2026-09-01, Correction 9)

> **Correction 4 supersedes Correction 3.** C3 removed a 120-day candidate
> horizon and replaced it with a single-pass bi-temporal "frontier". The
> frontier was lossy, and **the C3 report contradicted the C3 code**: the note
> said the unsafe single-pass form had been "proved unsafe and not shipped",
> while a different unsafe single-pass form was in the file and produced the
> `a293fe3d…` artifact. Both are corrected here.
>
> **The defect, reproduced against the shipped statement** inside a
> server-asserted `REPEATABLE READ READ ONLY` transaction, before any edit. One
> entity, one `observed_at`, three captures `t1 < t2 < t3`, strict cutoff
> between t2 and t3:
>
> ```json
> {"kept_ids":["t1","t3"],"expected_winner":"t2","frontier_winner":"t1"}
> ```
>
> `RANGE … CURRENT ROW` makes equal-`observed_at` rows peers, so `best_captured`
> is t1 for all three and `finalized_rank = 1` keeps only t3. t2 — the correct
> strict winner — is deleted.
>
> The same statement loses the winner a second way, when a later-effective row
> was recorded earlier (reproduced: kept `{j}`, expected `w`, selected
> **nothing**). That shape is **unreachable in this table**:
> `meta_entity_state_history_time_check` is `CHECK (captured_at >= observed_at)`
> and **0** of 919,973 rows violate it. Under that invariant the equal-
> `observed_at` case is the *only* reachable loss — and it is the one that
> occurred.
>
> **How much of C3 was wrong, measured rather than asserted.** Replaying both
> rules over all seven bindings at all 17 real account-local cutoffs, both
> grains, strict lane:
>
> | | |
> |---|---|
> | Entity-origin selections compared | **14,431** |
> | Selected a **different row** | **14,367 (99.6%)** |
> | Selected nothing (a lost winner) | **0** |
> | …of the wrong rows, identical `state_hash` | **14,194** |
> | …different `state_hash` | **173** |
> | …different budget field or origin | **0** |
> | …different configured/effective status | **173** |
>
> So the damage is exact: **every** wrong selection carried the wrong capture
> identity and provenance (observation id, run id, payload/run hash,
> `captured_at`) — which is the whole point of a point-in-time authority
> artifact — **173** carried the wrong *status*, and **no** budget amount moved.
> That is why C3's owner-resolved totals, owner-mode census and budget-field
> census were **identical** to this run's while 99.6% of the underlying rows
> were wrong. A green aggregate proved nothing.
>
> **The replacement makes no cleverness claim.** The statement already ran per
> origin and grain; it now also runs per lane and asks the database for the
> answer directly — scope to what the lane may see at that cutoff, keep
> `RANK() OVER (PARTITION BY entity_type, entity_id ORDER BY observed_at DESC,
> captured_at DESC) = 1`, retaining every exact-clock tie so a conflict still
> reaches the canonical selector. Worst measured execution on the largest
> binding: **1.82s** against the 8s client timeout.
>
> **Withdrawn from C3:** the `a293fe3d…` artifact and every hash, count, control
> and reconciliation value in it; the claim that the shipped frontier was
> "complete"; the claim that the unsafe single-pass form was not shipped; and
> the C3 seam's completeness verdict, whose only same-clock case shared *both*
> clocks, so nothing was ever dropped and it could not fail.
>
> **Carried forward unchanged from C3, because they were independently
> established and are unaffected by the SQL defect:** the removal of the 120-day
> horizon; the 827,277 pre-first-origin rows and 2023-03-29 earliest observation;
> the canonical fail-closed contract (decision-truth fingerprint, non-finite
> clocks, blank statuses, malformed API versions, strict coverage bits,
> campaign-parent-null); and the seven additive nullable columns.
>
> **Denominator reconciliation (carried from C2).** The C1 rejection cited "36 of
> 1,190"; my recomputation of the same defect gave "36 of 1,153". The numerator
> is identical. 1,153 is the ad-set-grain subset of the withdrawn C1 run's 1,432
> strict usable facts. I could not reproduce the scope that yields 1,190, so both
> are recorded with their definitions rather than one silently chosen.

**Read-only research plus local implementation.** DB evidence is SELECT only,
inside one `REPEATABLE READ READ ONLY` transaction with a server-asserted
read-only proof, a 30s statement timeout, a 5s lock timeout and a savepoint per
optional read. The migration is additive and **was not executed**. No provider
call of any kind was made — not even a GET. No producer, backfill or job run, no
deploy, no activation, no env change, no commit. Automation and every Meta write
gate stay OFF; `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` stays UNSET.

---

## Headline: the fact was mostly retained; the reader was wrong and the cadence is thin

Three findings, in order of how much they change:

1. **`budget_field_ambiguous` was a reader defect, not a retention gap.** Across
   **848,906** retained config-history rows — 149,643 campaign and 699,263 ad set —
   **zero** carry a positive daily *and* a positive lifetime amount. 208,433 ad-set
   rows carry both fields, and every one of them is the provider's `"0"` sentinel
   beside a real amount. D080B counted "both fields present" as ambiguity and
   charged 72,640 proposals for it.
2. **Parent-campaign identity is complete wherever it was observed.**
   **825,961 of 825,961** ad-set observation rows carry a parent campaign, and
   **1,570 of 1,570** distinct ad sets do. `meta_entity_state_history` is the only
   table in the schema that structurally enforces it, via
   `meta_entity_state_history_entity_identity_check`.
3. **The real gap is three missing fields, not cadence.** Correction 2 reported
   "92,651 observations over only 3-23 distinct observed days each and 339
   distinct entities" and called cadence the limitation. **That was an artefact
   of its own 120-day floor and is withdrawn.** The census over the whole table
   counts **919,973** retained campaign and ad-set rows reaching back to
   **2023-03-29**, and the point-in-time candidate set alone spans 15 to 324
   distinct observed days per binding. What is genuinely missing is fields:
   no table anywhere retains a budget start or end time, none retains a currency
   exponent, and none retains the provider API version — the schema census
   searched the whole public schema and found none of them on any budget-bearing
   table. That is why intent-ready is zero, and it is a schema gap, not a
   sampling gap.

---

## 1. What was read

| | |
|---|---|
| Retrieved at | `2026-09-01 08:04:51.65472+00` |
| Transaction | `repeatable read`, `read_only on`, `statement_timeout 30s`, `lock_timeout 5s` |
| Read ledger | **541** executions, all executed, **0** failed |
| Kept reads | **72** — the exact declared key set. The point-in-time statement is executed once per origin, grain **and lane** (17 × 2 × 2 = **68** per binding) and kept once per binding as a set deduplicated by observation identity; the ledger keeps every execution, and the verifier reconciles the two by count, by distinct execution key, and by pre-deduplication row total rather than by equality. |
| Rows kept | **17,092** (53,151 returned before deduplication) |
| Snapshot hash | `7a0af4aa47c313db8783b8816d6914ab5ea04bcf2c7297a9055cb17ad02dc70b` |
| Analysis hash | `be7be068c3f5d7c6d8eee452406d6064864772d5aa529a1d32b838a4d2d88db5` |
| Artifact hash | `c3df90aea6de37f04537090bca4e0d8a1b8e37ad4e0c663fc4760db21c89f9a2` |
| Artifact size | **25.85 MiB** (C3: 13.17 MiB on a candidate set that was 99.6% wrong; C2: 155 MB) |
| Worst single execution | **1.82s** (largest binding, last origin, ad-set grain) against the 8s client timeout |

Pinned byte-for-byte and re-checked at verification: D080A `d4a1898a…`, D080B
`b46e6aa8…`, D081 `5514023b…`, D082 file `bc4d06d0…` and D082 internal
`965b7a26…`.

**Primary documentation**, consulted only for volatile field semantics and never
as account evidence: the Meta ad-set reference
(`developers.facebook.com/docs/marketing-api/reference/ad-campaign`, retrieved
2026-09-01). It establishes that the budgets are numeric strings in the account
currency, **minor units for USD and EUR but basic units for JPY and KRW**, that
either `daily_budget` or `lifetime_budget` must be greater than zero, and that
`start_time`/`end_time` are required together with a lifetime budget.

Per binding, **retained campaign and ad-set rows** (what the table holds) and
**candidate rows / distinct observed days** (what can win at some
origin):

| Binding | Account | Retained | Candidates | Candidate days | Earliest observed |
|---|---|---|---|---|---|
| IwaStore | `act_1087566732415606` | 60,080 | 1,206 | 63 | 2024-01-10 |
| Grandmix | `act_805150454596350` | 516,582 | 8,610 | 324 | 2023-08-31 |
| Bilsem Zeka | `act_840779107261785` | 281,818 | 4,481 | 232 | 2023-09-04 |
| TheSwaf (selected) | `act_822913786458311` | 38,050 | 1,450 | 63 | 2024-07-14 |
| TheSwaf (deselected) | `act_921275999286619` | 2,572 | 378 | 26 | 2023-03-29 |
| IwaTR | `act_2335220976649516` | 8,561 | 215 | 15 | 2023-08-16 |
| ColorFullWorldsTR | `act_3554615364751964` | 12,310 | 547 | 47 | 2023-08-30 |
| **Total** | | **919,973** | **16,887** | | **2023-03-29** |

Currencies: TRY for Bilsem Zeka, USD for the rest. The two columns are kept
apart deliberately: the candidate count is the union of exact point-in-time
winner sets, not a sample of retention, and Correction 2's report conflated the
two. It is 3.1× larger than Correction 3's 5,161, because C3's reduction was
discarding rows that could win.

---

## 2. Existing coverage defects and their cause

| Defect | Cause |
|---|---|
| `budget_field_ambiguous` over-counted | The reader tested "both fields non-null" instead of "both fields positive", so the provider's `"0"` sentinel read as a second budget. |
| `owner_mode_ambiguous` over-counted | `budget_origin = 'not_applicable'` is a statement about a *grain*, not a hierarchy: it means the money is at the other grain. Read alone it looks like ignorance; joined to the sibling observation it resolves the owner exactly. |
| No CBO/ABO fact | The producer set `budget_origin` from whether *that row* carried a budget string, with JS truthiness, so the `"0"` sentinel claimed ownership and both-missing collapsed to `not_applicable`. **Corrected in C1** by `deriveMetaBudgetOrigin`; the cross-grain reconciliation is the canonical reader's hierarchy join. |
| Lifetime budgets unevaluable | `start_time`/`end_time` are neither requested from Graph nor stored in any table. |
| No exponent provenance | The ISO-4217 registry exists but nothing in the sync path imported it, while `providerBudgetValue` in the presentation layer divides by 100 unconditionally — wrong for JPY (0) and KWD (3). **Corrected in C1**: the sync stamps the exponent and registry version, and the reader requires the captured pair rather than re-deriving it. |
| Thin coverage | Complete-lane observation runs only over part of the window and stopped when ingestion halted. |

---

## 3. The canonical contract

`lib/meta/budget-fact.ts` (`meta.budget-fact.v2`) is the **sole consumer
boundary**. It is pure, contains no SQL, no provider call, and no campaign-name
or manual-label input.

- **Validate, never trust.** Every observation is checked against the requested
  business, physical account, grain, entity id and declared parent; a mismatch is
  a named blocker and refusal, not a silent acceptance.
- **A hierarchy needs both rows.** An ad-set fact requires a PIT-eligible parent
  campaign observation — including ABO — and both rows must be `present`,
  `complete` and parent-consistent.
- **Values are bound to the row that supplied them.** A campaign-owned fact takes
  its amount, currency, exponent, schedule and provenance from the campaign row;
  the subject's and parent's statuses are carried separately.
- **Owner provenance fails closed.** Null, `not_observed`, unrecognised or
  contradictory origins refuse; `not_applicable` is read only as the non-owner
  side of a complete two-grain join.
- **Two outcomes, not one.** `ownerResolved` means owner and amount are proven.
  `intentReady` additionally requires captured exponent provenance, a valid
  schedule where required, an observed supported shape and immutable identity.

### 3a. What Correction 1 changed

| Defect | Correction |
|---|---|
| Vacuous scope test; foreign/absent-owner/partial/wrong-id parents accepted | Full scope validation; all five reproduced cases now refuse |
| ABO accepted with no parent | Parent is mandatory for every ad-set fact |
| Owner provenance null or `not_observed` authorised money | `owner_origin_unrecognised`, fail closed |
| Mapper used JS truthiness, so `"0"` was an owner and both-missing became `not_applicable` | `deriveMetaBudgetOrigin` with explicit absent / zero / positive semantics |
| Child provenance reported beside parent money | `ownerProvenance` and `subjectProvenance` are separate |
| Captured exponent ignored; history restated with today's registry | The captured exponent and registry version are carried and required |
| Parent status and full provenance missing; `providerApiVersion` hard-coded null | Both statuses carried; observation id, run id, source snapshot and run hash joined from the run table; API version stays **unknown** for history and is pinned going forward |
| No shape input; report claimed a fail-close the reader could not make | `BudgetShapeSupport` is a real input; unobserved and unsupported both refuse |
| UTC-hard-coded cutoff, `observed_at::date` | Account-local, DST-safe cutoff on exact instants |
| Read began at the first origin | A pre-window PIT baseline read makes a still-current predecessor selectable (**superseded twice**: C3 removed the baseline's 120-day floor but replaced it with a lossy frontier; C4 asks for the exact per-origin, per-lane winner set) |
| Global future-aware `parentByEntity` | Parent learned per lane and origin from the child selected at that origin |
| Two temporal controls | Six, all non-vacuous |
| Verifier compared counts, not the key set | The exact 72-key set is rebuilt from the plan and required; any failed read refuses |
| Six `.catch(() => {})` ALTERs | Removed; `ADD COLUMN IF NOT EXISTS` is already idempotent |
| Report said the fields were excluded from `state_hash`; code included them | They **are** included, and the contract identity bumps to `meta-entity-state.v3` |
| `status_evidence_absent` cleared by a money fact | Only the four blockers a proven owner/amount actually answers are cleared |

**`state_hash`, resolved deliberately.** The seven fields stay in the hash and
the contract is now `meta-entity-state.v3`. Excluding them would mean the D075 delta
writer never persists a first capture or a later schedule change for an otherwise
unchanged entity, so the columns would exist and stay empty. Including them costs
one bounded restatement: on the first complete run after deploy every entity's
hash differs from its predecessor, so the writer persists at most one extra row
per entity per scope, once.

**Migration (added, deliberately not executed).** **Seven** additive nullable
columns on `meta_entity_state_history` — four schedule columns, the captured
currency exponent, the ISO-4217 registry version, and `provider_api_version`.
Correction 2's report said six; that was a miscount, not a change of scope. Proven in ephemeral Postgres: from-zero build and
idempotence, the existing-schema upgrade seam, and a **D16 round trip** — Graph
field presence → mapper → writer → stored schedule/exponent → PIT reader, with a
missing field reading back null rather than zero and every pre-existing column
still correct beside the new ones.

### 3b. What Correction 3 changed

Each was reproduced against the built code before any edit, and each is now a
permanent, parameterized test rather than a single example.

| Defect | Reproduction | Correction |
|---|---|---|
| The candidate set was bounded by a 120-day floor | a real RR-RO census: 827,277 retained rows precede the first origin, earliest 2023-03-29 | `BASELINE_LOOKBACK_DAYS = null`. C3's replacement frontier was itself lossy and is superseded by C4's exact per-origin, per-lane winner set — see the header |
| Same-clock conflict compared a subset of fields | two rows differing only in `shapeSupport` selected cleanly in one order and dirtily in the other | `DECISION_TRUTH_FIELDS` drives one fingerprint; a mutation test asserts a conflict in both orders for each of 24 fields, and an exhaustiveness test fails if a field is added to `BudgetObservation` and not accounted for |
| Non-finite clocks, blank statuses and arbitrary API versions passed | `capturedAtMs: Infinity` → `intentReady: true`; `"   "` statuses → ready; `providerApiVersion: "banana"` → ready | `subject_clock_not_finite`, `subject_status_evidence_absent`, `subject_api_version_malformed` (and the parent equivalents). Blank is *absence*, a separately named blocker, so the two stay distinguishable |
| `coverageBit` was a truthiness test | `"false"` and `"0"` read as covered | only boolean `true` is admitted; source strings decoded against `client_registry` / `client_known` |
| Campaign requests carried a parent | the request echoed the campaign's own id | requested and emitted as `null`; a non-null campaign parent is refused as `campaign_parent_identity_invalid` |

`observationId` is deliberately **outside** the fingerprint, alongside the three
clocks: it is the tie-break key. Two capture rows of identical decision truth
differ only by id, and the established contract is to select one of them
deterministically rather than to call identical truth a conflict.

The API-version contract is a **syntax and admission** check on provenance
(`/^v\d+\.\d+$/`). It takes no position on ACTIVE/PAUSED policy.

---

## 4. Historical replay — two lanes, never merged

| | strict (effective **and** recorded) | finalized conditional (effective only) |
|---|---|---|
| Truth label | `verified_fact` | `counterfactual_reconstruction` |
| Facts resolved | 41,242 | 41,242 |
| **Owner-resolved** | **12,940** | **34,865** |
| **Intent-ready** | **0** | **0** |

**The candidate set is exact, and has no horizon.** For each origin, grain and
lane the pinned statement asks the database for the answer rather than deriving
it: scope to the rows that lane may see at that cutoff — `observed_at < cutoff`,
and additionally `captured_at <= cutoff` for the strict lane — then keep
`RANK() OVER (PARTITION BY entity_type, entity_id ORDER BY observed_at DESC,
captured_at DESC) = 1`. Every row tied on **both** clocks is retained, so a
same-clock conflict still reaches the canonical selector instead of being
adjudicated in SQL.

The union over both lanes and all origins is therefore exactly the set the
selector needs: for any evaluated cutoff and lane the winner is by construction
rank 1 of that execution, and no row that could win anywhere is dropped. The
ordering is a prefix of `idx_meta_entity_state_history_asof`, so no sort is
required: **53,151** rows across **476** executions, **16,887** after
deduplication by observation identity, worst execution **1.82s**.

Correction 3 instead derived the candidate set from a single-pass frontier, and
that reduction deleted the true winner in **99.6%** of strict-lane selections
(see the header). The replacement is deliberately unclever.

The completeness of the statement is not a code claim. The ephemeral seam
(`D17`) seeds the shapes that break a reduction — one `observed_at` with three
captures, an exact-clock pair, a 2023 row recorded in 2026 — derives **47**
cutoffs from those seeded clocks themselves (each instant, ±1 ms, and every
adjacent midpoint) rather than hand-picking them, and sweeps **both lanes** for
**94 comparisons**. At every one the canonical selector returns the identical
verdict over the SQL-reduced set as over the entity's entire history, including
**16** conflicts. The seam additionally:

- retains the **rejected C3 reduction as a live control**, asserting it still
  drops t2 at a cutoff between t2 and t3 — so the regression is demonstrated,
  not described; and
- asserts that the writer and `meta_entity_state_history_time_check`
  (`CHECK (captured_at >= observed_at)`) refuse a row recorded before it was
  effective, which is what makes the reduction's *other* loss class unreachable
  rather than merely unobserved.

### 4a. What is frozen DB truth, and what is authored but unapplied

| | frozen production DB | locally authored, **not applied or deployed** |
|---|---|---|
| Schedule columns | absent from every retained row | four columns in the migration; both Graph field lists request the times |
| Captured exponent / registry | absent | stamped by the mapper, required by the reader |
| Provider API version | absent | column, mapper stamp, writer, reader, and binding into `meta-entity-state.v3` |
| Budget shape | no provider field requested or retained | a first-class canonical input that refuses when unobserved |

Every historical fact therefore fails `budget_shape_not_observed`, and every
owner-resolved one also fails `currency_exponent_not_captured`. That is why
intent-ready is zero and will stay zero until the migration is applied and an
admitted sync runs.

---

## 5. Two funnels, labelled for what they are

**The canonical intent-readiness funnel** — the gates the canonical fact
actually applies, terminating at its own gate:

| Stage | Survivors | Eliminated | Gate |
|---|---|---|---|
| 0 - entity-origin pairs with any observation | 41,242 | 0 | — |
| 1 - observed at the origin | 38,683 | 2,559 | budget_not_observed |
| 2 - owner resolved | 34,865 | 3,818 | owner_unresolved_hierarchy |
| 3 - owner and amount proven | 34,865 | 0 | budget_field_none |
| 4 - captured currency exponent | 0 | 34,865 | currency_exponent_not_captured |
| 5 - observed budget shape | 0 | 0 | budget_shape_not_observed |
| 6 - provider API provenance | 0 | 0 | subject_api_version_absent |
| intent-ready | 0 | 0 | — |

Stages 4-6 all eliminate the same population, because the production schema
supplies none of the three. The order is the canonical builder's, not a ranking
of severity.

**The legacy overlay** below is an *owner/amount counterfactual over the D080B
blocker codes*. It does not inject the canonical shape, exponent or provenance
blockers, so it is neither a money-shape nor an intent-readiness funnel:

| Stage | Survivors |
|---|---|
| 0 - all candidates | 247,050 |
| 1 - scope | 240,240 |
| 2 - money shape | 22,585 |
| 3 - delivery | 2,740 |
| 4 - authority | 35 |
| 5 - evidence | 0 |
| 6 - change safety | 0 |

Owner-resolved proposals: **18,090** strict and
**32,850** conditional. Intent-ready proposals: **0**.
Exposure is nominal and proposed only; no causal claim is made.

---

## 6. Residual blockers and the next dependency-ordered slice

What retained history **cannot** close, with the exact observation that would:

1. **Lifetime schedule** — add `start_time`/`end_time` to both Graph field lists
   and persist them into the four schedule columns. (The field lists are wired;
   the columns need the migration applied and a sync run.)
2. **Exponent provenance at capture** — stamp the exponent and registry version
   per observation. (Wired; needs the same.)
3. **Provider API provenance** — persist `provider_api_version` per observation.
   (Wired and bound into `meta-entity-state.v3`; needs the same.) Until then
   every fact carries `subject_api_version_absent`.
4. **Advantage+ / shared-budget shapes** — no provider field is requested or
   retained; the reader returns `unsupported` rather than guessing.

**Observation cadence is withdrawn from this list.** Correction 2 called it "the
single largest lever: 339 distinct entities observed against a 2,430-entity
universe". Without the 120-day floor, **2,435** distinct entities appear in the
candidate set — the universe is essentially fully observed, and the
apparent cadence gap was the floor, not the sync.

CBO-versus-ABO is **not** on this list: the canonical hierarchy join resolves it
from retained evidence wherever both grains are observed.

**The next slice is not a budget dry run.** On this evidence the terminal
blockers are three unretained fields and role authority, so the dependency-ordered
next step is applying the additive migration and running an admitted sync so
schedule, exponent and API provenance start accruing — followed by the
commercial-target and role-producer gaps. Not an execution path.

---

## 7. Integrity

- `snapshot.reads` is the single authoritative record; every section is
  re-derived from it plus module constants at verification and compared.
- **23 reconciliations, all balanced**, including that the strict lane is a
  subset of the finalized lane.
- **Six** temporal controls are sealed, each re-derived by the verifier from the
  control's own raw fields rather than from its authored `pass`, and each
  carrying an explicit non-vacuity flag the verifier also checks:
  `future_recorded_row_excluded_from_strict`,
  `early_origin_does_not_select_a_later_overwrite`,
  `pre_window_predecessor_is_selected`, `winners_selected_over_full_history`,
  `invalid_as_of_date_is_refused`, `account_local_cutoff_differs_from_utc`.
  `pre_window_predecessor_is_selected` is now grounded in the observation's own
  effective instant against the first origin's local cutoff, not in which read
  carried the row — the C2 formulation became vacuous the moment the candidate
  set became one deduplicated read, and the verifier refused it.
- Replay twice and verify twice are byte-identical, all three hashes agreeing
  with the extract; the verifier checks 16 sections and rejects a forged
  read-only proof, a mutated row, an edited headline, an inflated ledger count,
  an unpinned identity, and an execution count, execution-key count, **repeated
  execution key**, pre-deduplication count or duplicate observation identity
  that does not reconcile with the ledger.
- **Hardware safety.** Every heavy step ran in its own process, serially, with
  `/usr/bin/time -l`; no two overlapped. Maximum resident set: extract **839
  MiB**, replay **861 MiB**, verify **925 MiB**, D083 test file **1,023 MiB**,
  `budget-fact` tests **168 MiB**, from-zero seam **234 MiB**, upgrade seam
  **138 MiB**, state-history regressions **143-166 MiB**, D080 test file **1,660
  MiB** (372/372), D081 **1,715 MiB**, D082 **883 MiB**. The primary artifact is
  **25.85 MiB** and no generated D083 file reaches 100 MB.

  **D080B is no longer an exception.** Correction 4 recorded its verifier at
  **2,058 MiB** and its 116-test suite as unrunnable under the ceiling, and
  classified both as unrelated pre-existing red because D080B imported nothing
  C4 had touched. That reasoning is withdrawn: the gate is a property of the
  process, not of who wrote the code inside it. Correction 5 fixed it.

  The cause was not the test file's eager `const ARTIFACT = JSON.parse(...)` or
  its `clone()`, which profiling put at **158 MiB** and **~8 MiB**. It was
  `verifyArtifact` itself, and specifically `analysisHashOf`, which built one
  canonical string over all **247,050** replayed proposals. Isolated processes,
  externally sampled:

  | Prefix of the verifier | Peak RSS |
  |---|---|
  | parse the 10,223,204-byte artifact | 158 MiB |
  | + `analyse()` | 736 MiB |
  | + sample and blocker census | 735 MiB |
  | + deterministic builders | 736 MiB |
  | + all derived comparisons | 734 MiB |
  | + `analysisHashOf` | **2,146 MiB — over the ceiling** |

  The fix streams that hash instead: `canonicalDigest` feeds canonical JSON into
  SHA-256 in pieces. The whole-string comparisons, the blocker `flatMap` and the
  247,050-row sample copy were bounded the same way, so **no stored hash moves**.

  **Correction 6 — the C5 equivalence claim was overbroad and is withdrawn.**
  C5 said `undefined` and `toJSON` semantics were "inherited exactly" because
  every leaf and small subtree went to `canonicalJson`. That holds only where no
  value carries `toJSON`. With a large sibling forcing the streaming path:

  | Input | `sha256Canonical` | C5 `canonicalDigest` |
  |---|---|---|
  | `{ big: [600 ints], omit: { toJSON: () => undefined } }` | `2014cfb9…` | **threw** |
  | `[...600 ints, { toJSON: () => undefined }]` | `e5ecfaed…` | **threw** |

  A streamed container tested children for `undefined`, function and symbol, but
  a value whose `toJSON` *returns* one of those is none of them. Reproducing it
  surfaced a second, **silent** divergence: `toJSON` receives the property name,
  and the streamed path passed the root key `""`, so a key-dependent `toJSON`
  returned a *different digest* instead of throwing. Nested `Date` values agreed
  only because `Date.prototype.toJSON` ignores its argument.

  Serialisation is split at each position exactly where the specification splits
  it — `toJSON(key)` with the real key and never twice, then the replacer, then
  omit / `null` / recurse.

  **Correction 7 — C6's universal claim was still too broad and is withdrawn.**
  Three further divergences were reproduced against the shipped C6 code:

  | Input | `sha256Canonical` | C6 `canonicalDigest` |
  |---|---|---|
  | `{ big: [600 ints], f }`, `f` a function carrying `toJSON` | `b07fd5df…` | `2014cfb9…` — **wrong digest** |
  | `{ toJSON: () => undefined }` as the root | throws after **1** call | throws after **2** calls |
  | `{ aChild: <object with a getter>, zBig: [600 ints] }` | `57f54176…`, getter run **once** | `2898fda1…`, getter run **twice** |

  A **function is an Object** to `SerializeJSONProperty`, so a callable object's
  `toJSON` must run; C6 asked `typeof === "object"` and skipped it. The root
  failure path re-serialised the raw value, invoking a root `toJSON` twice. And
  the size probe **read** nested values, so an accessor ran once for the probe
  and once for serialisation — an extra observable call and, for any getter that
  does not repeat itself, a different digest.

  The probe is now descriptor-based and executes **no user code**: it recurses
  only into data descriptors and answers the `toJSON` question from the
  prototype chain's descriptors rather than by reading the property. Anything it
  cannot prove inert is streamed, where each position is read exactly once.
  Cycles are tracked on the **raw** containers, because the replacer hands back
  a fresh copy at every object level.

  **Correction 8 — C7's contract was self-contradictory and is withdrawn.** It
  claimed every ordinary non-Proxy value gets the same result *and the same
  error*, then named cycles as an exception where the errors differ, and treated
  stack exhaustion as acceptable refusal. Three failures followed:

  | Input | `sha256Canonical` | C7 `canonicalDigest` |
  |---|---|---|
  | `a = { toJSON(k) { return k === "" ? {big:[600], self:a} : "done:"+k } }` | `52340cda…`, **2** calls | **threw** a false circular-structure error |
  | a `Proxy` **returned by** `toJSON` | serialises, 3 traps | same hash, **3 traps** — no fail-closed |
  | a `toJSON` manufacturing fresh ancestry | stack exhaustion | stack exhaustion |

  A repeat is not recursion: a key-dependent `toJSON` may return the enclosing
  object once and a string next. Ancestry now proves a cycle only where **no
  `toJSON` intervened**, so the transformed value really is the raw object or a
  shallow copy of it. A Proxy returned by `toJSON` is checked **before** the
  replacer touches it — refused with **zero traps**. And what ancestry cannot
  decide is bounded by `CANONICAL_MAX_DEPTH = 512` with an error naming depth,
  not a false cycle.

  **Correction 9 — C8's module-global claim is withdrawn.** C8 kept
  `let lastTransformUsedToJson` and argued nothing interleaves between writing
  and reading it. In plain synchronous JavaScript `canonicalReplacer` calls
  `Object.entries`, an enumerable getter can call `canonicalDigest` again, and
  the nested digest overwrote the flag first. An ordinary finite program —
  key-dependent `toJSON` whose results carry a re-entrant getter — hashes to
  `c42ca17e…` with `calls=3`, `reentries=2`, and C8 **threw** a false
  circular-structure error with the same counts. The flag now lives on a
  `DigestContext` created once per top-level digest, so nested re-entry is
  independent by construction. The source comment, which still carried the old
  claim, is rewritten domain-first and no longer calls `canonicalJson`'s stack
  exhaustion a bounded refusal.

  **The contract, stated before any equality claim.** The supported domain is
  values containing no `Proxy`, no cycle, and nesting no deeper than 512.
  Accessors, inherited accessors, array-index accessors, a `toJSON` that is
  itself a getter, callable objects carrying `toJSON`, and key-dependent
  `toJSON` are all **inside** it. Inside the domain the digest equals
  `sha256Canonical`, refuses the same values with the same error, and matches
  the observable operations — one read per property, one `toJSON` per position,
  same key. Outside it nothing silently disagrees: a Proxy, a cycle and
  excess depth each fail closed with their own accurate error. `canonicalJson`
  also refuses cyclic data, but by stack exhaustion; that is recorded as a
  difference in *how* they refuse, not claimed as sameness.

  The real packages nest **7** levels, far inside the bound.

  **The C7 production-domain test was vacuous and is replaced.** It declared
  `let proxies = 0`, never incremented it, and asserted it was zero. The audit
  now tests every visited value with `node:util.types.isProxy`, reads `toJSON`
  by descriptor so no accessor executes, and detects cycles by open ancestor
  path while allowing shared children. It is proved non-vacuous by injecting a
  proxy, accessor, callable `toJSON`, function, symbol, BigInt and cycle into
  the real package — at the root and nested — and asserting each is caught. It
  also enumerates every production `canonicalDigest` call site by balanced-paren
  extraction, pins each argument to a reviewed allowlist, and audits `analyse()`'s
  five outputs directly instead of vouching for them in a comment.

  **The last full-package canonical strings are gone.** `sealArtifact` and the
  verifier still built one over the whole package; both now stream. The
  verifier's output is byte-identical before and after, so no stored hash moved.

  Escaping, number formatting, `-0`, `NaN`, lone surrogates and BigInt refusal
  remain genuinely inherited. `canonicalJson` delegates to one shared replacer
  and is proved byte-identical to its pre-refactor form.

  Measured after Correction 9's final code, each in a fresh process with an
  exact-child 2 GiB watchdog that stops only its own group:

  | Command | Result | KiB | MiB |
  |---|---|---|---|
  | canonical-digest tests | **158/158** | 673,616 | 658 |
  | memory-architecture tests | **37/37** | 423,200 | 413 |
  | D080B verifier, run 1 | `ok: true` | 726,304 | 709 |
  | D080B verifier, run 2 (byte-identical) | `ok: true` | 620,000 | 605 |
  | complete D080B suite, no filter, run 1 | **116/116** | **1,060,912** | **1,036** |
  | complete D080B suite, no filter, run 2 | **116/116** | **1,101,728** | **1,076** |
  | D083 verifier | `ok: true` | 791,552 | 773 |
  | D080 verifier | `ok: true` | 984,960 | 962 |

  The D080B artifact is untouched — `b46e6aa8…`, 10,223,204 bytes — and its
  `snapshotHash`, `analysisHash`, `artifactHash` and all 20 section hashes still
  recompute exactly, which is what `ok: true` means here.

  **The headroom problem is fixed, not deferred.** C8 reported whole-suite peaks
  of 2,083,568 KiB and 1,821,776 KiB — 13 MiB of margin on the worse run — and
  named the driver: the conditional lane materialised a second array of 247,050
  `{ ...p }` spread copies, each with a `reasons` array nothing read, walked a
  dozen times afterwards. Correction 9 aggregates that lane online, with state
  bounded by the number of distinct groups rather than by proposals.

  | | run 1 | run 2 |
  |---|---|---|
  | C8 | 2,083,568 KiB (2,035 MiB) | 1,821,776 KiB (1,779 MiB) |
  | C9 | **1,060,912 KiB (1,036 MiB)** | **1,101,728 KiB (1,076 MiB)** |

  Both 116/116, both roughly **1 GiB** under the 2,097,152 KiB ceiling. The
  outputs are byte-identical: the verifier's output is unchanged, and a
  permanent test compares the accumulator against the array implementation it
  replaced across ten fixtures by canonical bytes.

  The primary `proposals` array is still materialised on purpose — it is part of
  `AnalysisResult`'s declared contract and D083 consumes it. Removing it would
  need a two-pass analysis hash and a second code path; the criterion is met
  with ~750 MiB of margin without introducing that fork.

- **Diagnosis-only instrumentation removed.** The `D083_PROGRESS` RSS tracing
  that located the ICU leak is deleted, not left dormant.

---

## Files

| | |
|---|---|
| Canonical contract | `lib/meta/budget-fact.ts` (`meta.budget-fact.v4`) + `lib/meta/budget-fact.test.ts` (152) |
| Streaming canonical digest | `scripts/audits/d080-meta-budget-edit-evidence.ts` (`canonicalReplacer`, `canonicalDigest`, `transformAt`, `inspectSubtree`) + `scripts/audits/canonical-digest.test.ts` (158) |
| D080B memory architecture | `scripts/audits/d080b-meta-budget-policy-simulation.ts` + `scripts/audits/d080b-memory-architecture.test.ts` (37) |
| Extract / replay / verify | `scripts/audits/d083-meta-budget-fact-observation.ts` + `.test.ts` (69) |
| Migration (unapplied) | `lib/migrations.ts` — seven additive nullable columns |
| From-zero assertions | `scripts/ephemeral-postgres-migrations-check.ts` |
| Sync wiring | `lib/api/meta.ts`, `lib/meta/entity-state-history.ts` |
| Ephemeral round trip | `scripts/ephemeral-postgres-entity-state-history-seam-child.ts` (D16 real production mappers; D17 exactness sweep against the actual pinned statement, with the rejected C3 reduction retained as a live control) |
| Pre-D083 upgrade rewind | `scripts/ephemeral-postgres-schema-upgrade-seam.ts` |
| Consumer ledger | `lib/meta/__tests__/state-history-consumer-closure.test.ts`, `docs/audits/D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md` |
| Artifact | `docs/audits/generated/d083-meta-budget-fact-observation-2026-09-01.json` |
| Report | this file |
| ADR | `docs/creative-decision-center/DECISION_LOG.md`, D083 and Corrections 1-9 |
