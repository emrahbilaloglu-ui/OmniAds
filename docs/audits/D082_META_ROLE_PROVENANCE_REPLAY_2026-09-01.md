# D082 — real-DB, PIT-safe campaign-role provenance replay and historical counterfactual (2026-09-01, Correction 1)

> **Correction 1 supersedes the first D082 run.** Independent review found a
> point-in-time defect in Lane C: the daily chain ingested the origin day's own
> warehouse rows and campaign names before scoring that origin, so every score
> could see facts that were not knowable at origin start. The first run's Lane C
> headlines — **832** scored campaign-origins, **134** would-satisfy-authority
> tuples and **2,560** role-resolvable proposals — are **invalid and withdrawn**.
> The corrected figures below are **844 / 140 / 2,650**. Lanes A, B, the legacy
> census, Lane D and the funnel are unchanged; the snapshot is the same read
> (`b616fd05…`), so no finding reverses. See §4a for the contract and its
> controls.


**Read-only research.** SELECT only, inside one `REPEATABLE READ READ ONLY`
transaction with a server-asserted read-only proof, a 30s statement timeout, a
5s lock timeout and a savepoint per optional read. No write of any kind, no
migration, no deploy, no scheduler or env mutation, no activation, no producer,
backfill or job run, no provider call, no Meta action. Automation stays OFF and
`CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` stays UNSET. No manual
Test/Main/Mixed label was restored, consulted or inferred from outside the
locked evaluation lane, where labels are evaluation evidence only.

---

## Headline: the role table has never been written by the account-scoped producer

Across the six charter businesses, `engine_v3_campaign_context_daily` holds
**2,350 rows**. Every one of them:

- carries **no physical provider account** (`accountScopedRows: 0`);
- carries the resolver identity **`campaign-context-resolver.v1-shadow-2026-07-06`**,
  which is the only identity present — not the compiled
  `…v2-account-scoped-name-neutral-2026-09-01`, and not either of the two
  identities D081 C5 retired;
- carries `kind_source = 'system_inferred'` — 2,350 of 2,350.

So the source gate is the one gate these rows *do* pass. What blocks them is
account scope and resolver identity, and both block absolutely: **0 rows at the
compiled identity, 0 rows with an account.** The D033 account-scoped producer
has never written a row for these businesses; what is retained is v1 shadow
output.

This sharpens two earlier statements rather than contradicting them. D080B
reported "3,058 role rows in window, 0 with a provider account" from a query
that filtered only by business and therefore counted TheSwaf twice; the
account-filtered read finds 2,286 rows in the same window across six distinct
businesses. D081 recorded `role_source_not_system_inferred` as the first
observed gate and said explicitly that both provenances were *absent* from the
frozen snapshot rather than wrong. D082 settles it: the source was never the
problem.

---

## 1. What was read

| | |
|---|---|
| Retrieved at | `2026-09-01 04:01:32.260709+00` |
| Transaction | `repeatable read`, `read_only on`, `statement_timeout 30s`, `lock_timeout 5s` |
| Read ledger | 62 invocations, all executed, **0** failed, 0 dependency-skipped |
| Rows kept | 39,280 |
| Snapshot hash | `b616fd0510d50b5a60825f4f0b58cceb4b8359325474bbc10fea29639846d45e` |
| Analysis hash | `dd675f75216514b7ec5af896374325813802f18f4e08cb76ad90759f95c23e55` |
| Artifact hash | `965b7a26647f6f40c749e1dfcdb7ef2af9c97c014a90f6a58a2813ac42dc9c09` |
| Origins | the 17 pinned D080B origins, `2026-04-30` → `2026-08-20`, 4 walk-forward folds |
| Schema census | 20 columns on `engine_v3_campaign_context_daily` |

Pinned byte-for-byte before the run and re-checked at verification: D080A
`d4a1898a…`, D080B `b46e6aa8…`, D081 `5514023b…`, H11B bundle `f27f6cbe…`,
H11B evaluation protocol `a99bd6c7…`.

The corrected role read is account-scoped and provenance-complete: it selects
`kind_source`, `resolver_version`, `created_at`, `updated_at` and `job_run_id`,
filters `business_id AND provider_account_id`, and keys every row by
`business + physical account + campaign + as-of`. That is the read D080B did not
have.

**One read-plan correction during the run.** The first extract lost Grandmix's
two Lane C reads to the client's 8s query ceiling — the largest account, and
half the proposal universe. Rather than raise a timeout, the reads were split:
the correlated first-spend CTE became its own aggregate read joined back in
memory on the production key `(provider_account_id, creative_id)`, and the
campaign-name read became a name-change log, which is exactly equivalent for
"latest name at or before a ceiling". The second extract completed all seven
bindings with **0 read failures**.

---

## 2. Lane A — actual current runtime authority: **0**

| | |
|---|---|
| Env gate | `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` **unset** |
| Approved identity resolves | **no** |
| Account-scoped rows read | **0** |
| Authoritative campaign-origins | **0** |
| Technically shaped but gate-closed | **0** |

Zero here is over-determined, and it is worth separating the reasons because
they fail independently:

1. the authority env is unset, so the canonical validator denies resolver
   authority to every row whatever it contains;
2. there are no account-scoped rows to evaluate at all;
3. every retained row carries a v1-shadow identity that is not the compiled one.

Fixing any one of these alone would still leave Lane A at zero. In particular,
arming the env would change nothing: the rows are not account-scoped and not at
the compiled identity. `technicallyShapedButGateClosed` is **0**, so there is not
even a population waiting behind the gate.

---

## 3. Lane B — strict historical retained-row PIT: **0**

Rule: `as_of_date < origin` **and** `created_at <= origin start` **and**
`updated_at <= origin start` **and** exact source, class and identity **and**
exact business/account/campaign scope **and** inside the existing freshness
window.

Rows considered: **0**, because no account-scoped row exists. There is therefore
nothing to exclude and nothing to reconstruct, and
`mutable_prior_version_unreconstructible` is **0** — not because the table is
immutable, but because the strict lane never reached a row.

The exclusion machinery is nonetheless real and is proven on fixtures: an
origin-day fact, a row created after the origin, a row rewritten after the
origin, and a row with inexact provenance are each excluded for their own named
reason, and the first three become visible once the origin advances past them.

### Research annex — legacy null-account identity join (never authority)

| | |
|---|---|
| Legacy rows in window | 2,286 across six businesses |
| Distinct campaigns | 79 |
| Identity uniquely resolvable before the origin | 2,254 |
| Ambiguous identity | 0 |
| No identity observed before the origin | 32 |
| **Exact provenance after the join** | **0** |

Even granting every one of the 2,254 identity joins, not a single row survives
the provenance test, because all 2,286 carry the v1-shadow identity. The join is
addressability, not authority: the partial unique index does not cover
null-account rows, the producer's `ON CONFLICT` cannot touch them, and the D033
migration deliberately did not backfill them because they were computed with
business-wide normalisation.

---

## 4. Lane C — retrospective name-neutral counterfactual: **140**

The current name-neutral v2 resolver, recomputed in memory over real warehouse
data through the production feature builder, resolver, family-inheritance and
daily-hysteresis functions — grouped by physical account before features are
built, warmed up for 14 days before the first scored origin, and run every
calendar day because hysteresis is a per-day causal chain. **126 scored days,
2026-04-16 through 2026-08-19. Nothing was persisted.**

| | First run (withdrawn) | Corrected |
|---|---|---|
| Campaign-origins scored | 832 | **844** |
| Would satisfy role authority | 134 | **140** |
| Role-resolvable proposals | 2,560 | **2,650** |

| | |
|---|---|
| Published classes | high 140, medium 241, low 233, unknown 230 |
| Published kinds | main 468, mixed 90, test 56, null 230 |

Per binding (scored / authoritative): IwaStore 180 / 31, Grandmix 168 / 23,
Bilsem Zeka 148 / 25, TheSwaf selected 231 / 19, TheSwaf deselected 37 / 12,
IwaTR 33 / 14, ColorFullWorldsTR 47 / 16.

**Name neutrality holds where it must.** All 140 hard-authoritative tuples were
re-resolved with the campaign name removed, and **0** changed. The complement is
also true and asserted as such: naming still moves rows that never reach hard
authority between `low` and `medium`. Naming is explanatory evidence; it cannot
promote, veto or alter a hard tuple.

### 4a. The Lane C temporal contract (Correction 1)

**A score published for origin `O` is the outcome of the canonical daily chain on
`O-1`.** The chain advances one calendar day at a time from the warm-up start to
`laneCLastScoredDay = lastOrigin - 1`; on each day it admits only creative rows
and campaign names dated at or before that day, builds features, resolves,
applies family inheritance, advances daily hysteresis, and publishes that day's
outcome as the score for `O = day + 1`. No row dated on an origin can reach that
origin's score, and the first row that can is dated `O-1` — the same boundary
Lane B and `originCutoffMs()` already use.

The first run instead scored origin `O` from the chain *on* `O`, so origin-day
creative rows, spend and renames all reached the score. The existing leakage
controls covered retained role rows, not Lane C's feature and name inputs, which
is why they did not catch it.

**The separately read first-spend and first-seen inputs are safe by
monotonicity, and the argument is now enforced rather than trusted.** Both are
`MIN` aggregates read once at the wide ceiling. A `MIN` is monotone: if a
creative or campaign has any row at or before an earlier day `D`, its global
minimum is itself at or before `D`, so the wide value equals the `D`-bounded
value; and a creative whose first spend is after `D` has no row in `D`'s window
at all, so it is never reached. Two fail-closed counters publish violations of
that argument — `firstSpendAfterScoringDay` and `firstSeenAfterCeiling`, both
**0** — and the verifier rejects the artifact if either is non-zero.

**Four controls are sealed into the artifact and re-derived at verification**,
run on the real snapshot rather than asserted in prose. The rename site is
*searched for* in deterministic order rather than assumed, because a rename only
moves a score where the naming family is load-bearing; without that search the
control would pass while proving nothing.

| Control | Site | Result |
|---|---|---|
| Creative row dated **on** origin `2026-05-07` | TheSwaf deselected | invisible at that origin, **visible at the next** — pass, non-vacuous |
| Creative row dated `2026-05-06` (`O-1`) | same | **visible at the origin** — positive control |
| Rename dated **on** origin `2026-06-11` | TheSwaf deselected, found after 6 tries | origin tuples **unchanged** — pass |
| Rename dated `2026-06-10` (`O-1`) | same | origin tuples **changed** — which is what makes the row above non-vacuous |

Both renames left hard authority unchanged, so even a rename that does reach an
origin moves only non-authoritative evidence.

**Why this lane is still `retrospective_finalized_conditional`.** Removing
origin-day leakage fixes an effective-date defect; it does not manufacture a
recorded/knowledge clock. `meta_creative_daily`, the table the canonical feature
builder reads, carries only `created_at`/`updated_at` — no `finalized_at`, no
`truth_state` — and the measured clock census says plainly that this pair cannot
carry a knowledge bound:

| Account | Rows | Rewritten after creation | Created before the day they describe |
|---|---|---|---|
| act_1087566732415606 | 5,017 | 4,688 | 0 |
| act_805150454596350 | 4,971 | 4,391 | 0 |
| act_840779107261785 | 8,619 | 6,951 | **2,184** |
| act_822913786458311 | 4,101 | 3,412 | 0 |
| act_921275999286619 | 1,116 | 999 | 0 |
| act_2335220976649516 | 5,155 | 4,351 | **670** |
| act_3554615364751964 | 2,392 | 2,014 | **558** |

87% of rows have been rewritten since creation, and three accounts contain rows
whose `created_at` precedes the calendar day they describe — impossible for a
knowledge clock. Feature eligibility is therefore bounded by effective date
only, which is a retrospective finalized reconstruction, not a strict
point-in-time replay. The lane keeps its label and is never presented as current
live authority. The what-if validator is explicit and local; the env was never
touched.

## 5. Lane D — locked accuracy diagnostics: `openAuthorityGate: false`

The current name-neutral v2 re-evaluated against the frozen H11B package
(bundle `f27f6cbe…`, internal `58de78a1…`, protocol `a99bd6c7…`, which binds to
the same bundle hash). 57 manual labels; anchors, folds and the 45-day truth
window are transcribed from the frozen protocol, not restated here.

| Predeclared gate | Required | Observed | Pass |
|---|---|---|---|
| Labeled validation observations | ≥ 30 | **21** | no |
| Overall accuracy | ≥ 0.90 | **0.5714** | no |
| Minimum per-class recall | ≥ 0.80 | **0** (mixed) | no |
| High-confidence precision | ≥ 0.95 | **0.25** (n=4) | no |
| Max single-business truth share | ≤ 0.60 | 0.3333 | yes |
| Independent, unreused holdout | required | not available | no |

Validation per class: main recall 0.846 / precision 0.647 (support 13); test
recall 0.5 / precision 1.0 (support 2); **mixed recall 0.0 / precision 0.0
(support 6)**. Train fold accuracy is 0.3333 over 45 labeled observations. 8
labeled campaigns were excluded as stale truth and 28 never had features at any
anchor.

Five of six gates fail, so the authority gate stays closed — which is also its
default. The honest reading is not merely "insufficient evidence": on the truth
that does exist, the current resolver does not recognise the `mixed` class at
all, and one in four of its high-confidence validation calls is right. That is a
refutation this lane is entitled to make even though, on reused post-hoc truth,
it could never have licensed a promotion.

Disclosed limits: manual labels are evaluation evidence only; `meta_campaign_labels`
keeps no versioned history, so the role an operator believed on a historical day
cannot be reconstructed; truth is sparse and uneven; both stored H11/H11B
packages were produced under now-retired identities and their numbers are
deliberately not quoted; this lane applies no family inheritance and no
hysteresis, matching the comparator's point-classification protocol; and the v3
lifecycle challenger is not re-evaluated because its lifecycle feature builder
lives in a module that runs a CLI on import — v3 remains REJECTED under D076 and
is unchanged here.

---

## 6. Proposal-level impact across the six businesses

All 247,050 typed research proposals were recovered by re-deriving the pinned
D080B analysis from its own frozen reads. D082 never recounts that universe.

**A structural ceiling that no role table can lift.** A campaign role is a
campaign-scoped fact, and **147,760 of 247,050 proposals (59.8%) carry no
campaign identity at all** — they are ad-set proposals whose parent campaign was
not retained in the D080B snapshot. Only **99,290** are joinable to a role in
principle, in any lane.

| Lane | Role resolvable | Still blocked | Zero residual blockers |
|---|---|---|---|
| `actual_current_runtime_authority` | **0** | 247,050 | 0 |
| `strict_pit_authority` | **0** | 247,050 | 0 |
| `retrospective_finalized_conditional` | **2,650** | 244,400 | **0** |

The conditional lane's 2,650 break down as: TheSwaf 730, IwaStore 580, Grandmix
520, Bilsem Zeka 420, ColorFullWorldsTR 220, IwaTR 180; by grain campaign 1,290
and ad set 1,360; by fold 420 / 970 / 840 / 420; 2,440 on selected accounts and
210 on TheSwaf's deselected reference account, which remains scope-blocked in
every proposal it appears in.

**Funnel after applying the role overlay and D081's two accepted overlays**
(vocabulary and currency exponent):

| Stage | Survivors | Eliminated |
|---|---|---|
| 0 — all candidates | 247,050 | — |
| 1 — scope | 240,240 | 6,810 |
| **2 — money shape** | **2,495** | **237,745** |
| 3 — delivery | 610 | 1,885 |
| 4 — authority | 5 | 605 |
| 5 — evidence | **0** | 5 |
| 6 — change safety | 0 | 0 |

Closing role in the most generous lane available does not produce a single
eligible proposal. The money-shape stage still eliminates 96% of what survives
scope, and the last five die on evidence floors. **Role was never the binding
constraint** — which is the substantive finding, and it means the instrumentation
D080B §8 named remains the prerequisite, not role provenance.

Exposure is nominal and proposed only. No spend moved, no outcome occurred, and
no ROAS, revenue, conversion, profit or spend claim is made or implied.

---

## 7. Integrity

- `snapshot.reads` is the single authoritative record. Every other section —
  window, censuses, all four lanes, proposal impact, leakage, isolation,
  reconciliation — is re-derived from those reads plus module constants at
  verification and compared, and the snapshot hash is recomputed from the reads
  rather than read back.
- **29 reconciliations, all balanced**: every lane's resolvable + blocked equals
  247,050; joinable + unjoinable equals 247,050; every per-business,
  per-account, per-selected-state, per-grain, per-fold, per-origin and per-role
  breakdown sums to its lane's total; and each lane's per-origin and per-binding
  series sum to that lane's headline.
- **Five leakage families pass in both directions.** An origin-day fact, a row
  created after the origin and a row rewritten after the origin are invisible at
  the origin and visible once it advances; a retired identity and a manual origin
  are never visible at any origin.
- **Isolation is proven on a source that has rows.** The role read is empty, so
  its separation check is explicitly marked `vacuous` rather than counted as a
  pass, and the same checks are repeated on `meta_creative_daily`: no foreign
  account row, no campaign shared between TheSwaf's selected and deselected
  accounts, and no campaign id appearing under two bindings.
- Replay twice and verify twice are byte-identical; the verifier checks 24
  sections and rejects a forged read-only proof, a single mutated row, an edited
  headline, an inflated ledger count and an unpinned identity. It additionally
  rejects the artifact if any Lane C temporal control fails **or is vacuous**, if
  either boundary-guard counter is non-zero, or if the last Lane C scoring day is
  not the day before the last origin.
- **Remaining limit, stated plainly:** an offline verifier cannot detect a
  wholesale re-forge in which the reads and every derived output are replaced
  consistently. What binds this package to reality is the real-DB extraction
  inside a server-asserted read-only transaction and the pinned predecessor
  hashes.

---

## 8. What this changes, and what it does not

The role blocker is not a code gap and, on this database, not really a
provenance gap either. The capability D081 built is wired to the canonical rule
and works; there is simply nothing for it to read. Closing role would require
the account-scoped producer to have run — and even then, on the most generous
counterfactual measured here, it would move 2,560 of 247,050 proposals and
produce zero eligible ones.

Two things are worth carrying forward:

1. **The account-scoped context producer has not run for these businesses.**
   That is a concrete, checkable operational fact, and it is upstream of every
   role-dependent surface, not just budget intent.
2. **The current resolver's `mixed` class is unrecognised on the truth that
   exists** (recall 0.0 on support 6). That is a resolver-quality signal
   independent of authority plumbing, and it is a reason not to arm the
   authority env even if account-scoped rows appeared tomorrow.

Neither justifies opening automation, and this package does not.

---

## Files

| | |
|---|---|
| Extractor / replay / verifier | `scripts/audits/d082-meta-role-provenance-replay.ts` |
| Tests | `scripts/audits/d082-meta-role-provenance-replay.test.ts` (69) |
| Artifact | `docs/audits/generated/d082-meta-role-provenance-replay-2026-09-01.json` |
| Report | this file |
| ADR | `docs/creative-decision-center/DECISION_LOG.md`, D082 |
