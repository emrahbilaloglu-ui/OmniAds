# D080B — six-business historical Meta budget-policy simulation (2026-09-01, Correction 1)

**Read-only research.** No provider call, no Meta entity activated or changed, no
product, UI, route, resolver, migration, schema or shared-database mutation. One
`REPEATABLE READ READ ONLY` transaction, SELECT only, savepoint per optional
read. Automation stays OFF and no execution flag was set. No manual
Test/Main/Mixed label was restored, consulted or inferred from; automatic role
inference is the only path used.

---

## Verdict: `NO-GO` for the next supervised budget-intent implementation slice

**No numeric default is supported. Not at 5%, 10%, 15%, 20% or 25%, in either
direction, at any origin, for any entity, in any business.**

Across **247,050** candidate proposals — 2,430 entities × 17 weekly origins × 10
ladder rungs — **zero** were eligible. Waiving the three system-capability
blockers in the research-only conditional lane produced **zero** eligible as
well. This is not a threshold that came out unfavourable; it is a system that
cannot currently express, authorise, or evidence a budget change at all.

The verdict is `NO-GO` for *budget intent*. It is not "nothing is buildable" —
§8 names the instrumentation slice that is buildable locally, and that slice is a
prerequisite, not a substitute.

---

## 1. What was read

| | |
|---|---|
| Retrieved at | `2026-08-31 23:29:38.751948+00` |
| Transaction | `repeatable read`, `read_only on`, `statement_timeout 30s`, `lock_timeout 5s` |
| Read ledger | 95 invocations, all executed, **0** failed, **0** dependency-skipped |
| Snapshot hash | `0c4c4b9d05eeb38efdbe1d85aa7aa1ed7cb133afe2bb539d1b7a48d4f4ca1d38` |
| Simulation window | `2026-04-30` → `2026-08-20` (112 days, bounded by the read) |
| Origins | 17, weekly, partitioned into 4 walk-forward folds |
| Entities | 2,430 (868 campaigns, 1,562 ad sets) |

Per-binding cutoffs are `2026-08-21` for six bindings and `2026-08-20` for
TheSwaf's deselected reference account; the fleet origin axis uses the earliest
cutoff so no origin sits outside history every binding supports.

**Horizons.** 7/14/28/56 are all supported at the earliest origins and fall away
as origins approach the cutoff; the last origin supports none. Each origin
publishes its own supported and unsupported horizons with the reason, rather
than asserting a single horizon the data does not carry everywhere.

---

## 2. Three blockers alone make every candidate ineligible

Each of these hits **100.0%** of all 247,050 proposals. Any one of them is
sufficient on its own.

| Blocker | Evidence |
|---|---|
| `decision_vocabulary_absent` | **0** typed budget-verb rows exist across all seven bindings. `decision_entity_type` is `'ad'`; the vocabulary is creative-only and ad-grain-only. There is nowhere to record a campaign- or ad-set-grain budget intent. |
| `role_authority_absent` | **3,058** automatic campaign-role rows in window; **0** carry a provider account. A role without account scope cannot authorise an account-scoped change. |
| `unit_exponent_unknown` | **No column anywhere in the public schema** names a currency exponent, minor unit, currency scale or currency decimal. |

The unit finding deserves care because the repository asserts the opposite.
`docs/creative-decision-center/INVARIANTS.md` states *"Meta budget and
currency-formatted bid values are provider minor units."* That assertion is not
backed by a retained per-currency exponent, and ISO exponents are not uniform
(JPY 0, most currencies 2, KWD 3). The six accounts here are USD and one TRY —
both exponent-2 by ISO — so a `/100` convention would happen to work today, and
would silently break on the first zero- or three-exponent account. This audit
therefore reports raw provider amounts only and publishes
`accountCurrencyExposure: null` with the reason attached, rather than a
converted figure that would be an assumption presented as evidence.

---

## 3. Where candidates actually die — the funnel

Measured in the conditional lane, so the three blockers above are already
waived and cannot mask the rest.

| Stage | Survivors | Eliminated |
|---|---|---|
| 0 — all candidates | 247,050 | — |
| 1 — scope | 240,240 | 6,810 |
| **2 — money shape** | **4,990** | **235,250** |
| 3 — unit | 4,990 | 0 (waived) |
| 4 — delivery | 1,180 | 3,810 |
| 5 — authority | 10 | 1,170 |
| 6 — evidence | **0** | 10 |
| 7 — change safety | 0 | 0 |
| 8 — execution safety | 0 | 0 |

**One stage eliminates 95.2% of everything: the shape of the money.** Its
components:

- `owner_evidence_absent` — 216,340 (87.6%). Only **462** owner/status
  observations exist across 2,430 entities and 17 origins. `budget_origin` in
  `meta_entity_state_history` is the sole retained statement of which node owns
  the money, and its coverage is the ceiling on every strict point-in-time
  reconstruction.
- `budget_field_ambiguous` — 72,640 (29.4%). Ad-set config rows carrying a
  lifetime budget almost always carry a daily budget too (24,626 of 24,631 for
  one account alone), so the target field is undecidable.
- `owner_mode_ambiguous` — 11,720. `budget_origin = not_applicable`.
- `lifetime_schedule_unretained` — 2,900. Neither config-history table retains a
  start or end date, so remaining lifetime is unknowable and no lifetime-budget
  policy can be evaluated at all.

Delivery then removes most of the remainder (`parent_not_active` 164,090 —
active ad sets under paused campaigns are the single most common shape in this
data), and authority removes almost all of what survives
(`commercial_target_absent` 133,040; one of the six businesses has no target
pack at all, and the newest pack for two others predates the window).

---

## 4. The ladder cannot be discriminated

Every rung produces an identical outcome: 24,705 blocked at 5%, 10%, 15%, 20%
and 25%, in both directions. The mechanism is structural — **every gate that
binds is evaluated before the proposed magnitude is ever considered.** A
percentage cannot be ranked when nothing reaches the point of applying it.

The one real asymmetry is directional, and it is worth keeping:

- an **increase** must additionally clear an explicit target-ROAS gate, a
  trailing-conversion floor, and a budget-binding test;
- a **decrease** faces none of those three.

That is the correct shape — a reduction is the safer intervention and should
carry the lighter evidence burden — and the synthetic fixtures confirm it holds
in the cases a buyer most cares about: `high_spend_no_sales` and
`budget_not_binding` both leave the decrease reachable while blocking the
increase.

**Conditionally least risky, stated honestly:** if the three system blockers
were closed, decreases on campaign-owned daily budgets in the coverage-complete
cohort would be the first reachable action, and no rung within 5–25% is
distinguishable from another on this history. Anyone choosing a number is
choosing it on judgement, not on this evidence.

---

## 5. The coverage-complete cohort

700 proposals (70 entity-origins) had every structurally required fact retained.
Even there, **zero** were eligible. What remained:

`budget_field_ambiguous` 470 · `status_not_active` 360 · `commercial_target_stale`
320 · `recent_change_cooldown` 190 · `owner_mode_ambiguous` 160 ·
`budget_not_binding` 140 · `parent_not_active` 130 · `conflicting_transition` 70 ·
`conversion_evidence_floor` 65 · `entity_cap` 30 · `oscillation_risk` 10.

70 entity-origins out of 41,310 possible pairs is **0.17% coverage**. That number
is the honest ceiling on what this history can say about budget policy.

---

## 6. What the observed history actually shows

444 retained budget transitions in window. **23** have resolved semantics on both
sides — independently reproducing D080A's figure from a different code path and
a different window.

**A correction to that figure:** those 23 rows are only **14 distinct economic
events.** A change on a campaign-owned campaign is recorded at both the campaign
and the ad-set grain, so the row count double-counts. D080A's "23 clean
transitions" should be read as 14 operator actions.

The 421 unresolved transitions fail for two reasons only: 401 because a side
carries two budget fields, 20 because a side is flagged budget-mixed.

**Magnitudes actually used:** 5 of 23 rows fall inside the 5–25% ladder; **18 do
not.** Retained changes include +455.6%, +233.3%, +200%, −96%, −86.7% and −60%.
This is evidence about historical operator behaviour. It is *not* evidence that
large steps are safe, and it is not a reason to widen the ladder — no outcome
was measured for any of them.

**No causal claim is made anywhere.** `roasLift`, `revenueLift`, `purchaseLift`
and `profitLift` are all published as `null`: no counterfactual exists for a
change that was never made. This audit measures proposal eligibility and
exposure, never outcome lift.

---

## 7. Evidence lanes

| Lane | Rows | May authorise action? |
|---|---|---|
| `strict_pit_authority` | 247,050 | Yes in principle — 0 eligible in fact |
| `retrospective_finalized_conditional` | 247,050 | **Never.** Waives ≥1 system blocker |
| `synthetic_stress_only` | 25 fixtures | **Never.** Outside every real denominator |

The verifier enforces the separation: a synthetic row relabelled to a real lane,
a synthetic-lane database read, or a real denominator equal to the synthetic row
count each fail verification. Every conditional row names the waivers it took,
and every synthetic fixture states what it proves.

**A gap the fixtures expose in this audit's own engine:** the unit gate asks only
whether an exponent source *exists*, not whether it covers the currency at hand.
The `unit_exponent_0_jpy_like` and `unit_exponent_3_kwd_like` fixtures pass that
gate and would be mis-scaled by 100× and 10× respectively. With no exponent
source in the schema this is unreachable today, but it must be closed before any
exponent source is introduced.

---

## 8. What can be built next, and what cannot

**Buildable locally, without new history:**

1. **A typed budget intent ledger.** D080A already designed it and rejected
   extending the creative action log. Nothing in this simulation contradicts
   that design. Building it closes `decision_vocabulary_absent`.
2. **A per-currency exponent source**, with the currency-coverage check above,
   not a presence check. Closes `unit_exponent_unknown`.
3. **Owner-coverage instrumentation.** 462 observations for 2,430 entities is
   the dominant gap. Recording `budget_origin` and delivery status on the
   existing observation path costs no new provider capability.

**Not buildable locally — needs new observation or migration:**

4. Account-scoped automatic campaign role. 0 of 3,058 role rows carry an account.
5. Schedule and end-date retention. Without it, no lifetime-budget policy is
   evaluable, ever.
6. Dual-field disambiguation at ad-set grain. 401 of 421 unresolved transitions
   trace to this one defect.
7. Commercial target coverage. One charter business has no pack; two have none
   newer than the window.

**Requires primary provider compatibility proof:** the campaign-versus-ad-set
budget endpoint contract remains unverified, exactly as D080A left it.

---

## 9. Correction 1 — the evidence contract, rebuilt

Independent acceptance rejected the first submission. Fifteen separately
authored single-field lies were applied to the shipped artifact, resealed with
this audit's own `sealArtifact`, and every one returned `{ok: true}`. The
rejection was correct, and the cause was structural: the v1 verifier recomputed
**self-authored** section hashes and re-derived only a handful of claims, so
anything it did not re-derive was simply believed. A test of mine even asserted
that outcome as a known limit — disclosure is not tamper-resistance.

**The fix is architectural, not additional checks.** The artifact now carries
`snapshot.reads`: every executed read, with the raw rows exactly as the database
returned them. That is the single authoritative record. Every other section —
clocks, entity universe, origins, denominators, funnel, breakdowns, exposure,
conditional lane, sample, transitions, fixtures, leakage checks — is
**re-derived from those reads plus module constants** during verification and
compared. A stored value is now only ever compared against something
recomputed, never trusted.

Concretely:

- the snapshot hash is recomputed from the reads and never supplied by them;
- the expected invocation set is rebuilt from the static plan, the pinned
  matrix, sources, grains and windows, then compared key-for-key;
- each ledger row's count and source hash are **recomputed from the kept rows**,
  and its envelope is rebuilt rather than read back;
- `readFailures` must be the exact stable multiset of non-ok ledger rows;
- `queryContractSha256` is recomputed from the static contract, and the
  predecessor hashes are compared to module constants, not to self-report;
- the real `analyse()` is re-run inside verification and every derived output is
  compared, with `proposalsEvaluated` re-derived from entity-origin pairs;
- observed transitions, stress fixtures, the conditional waivers and the
  proposal sample are recomputed from their deterministic builders;
- every discovered row-bearing section must resolve to exactly one registered
  semantic handler, and each publishes which checks actually ran. An
  unregistered section fails closed.

**Result: 15 of 15 now rejected**, each from the relevant semantic section with a
specific reason, and each accompanied by at least one non-hash failure:

| Lie | Rejection |
|---|---|
| 1 forged `entityUniverse` id | `entityUniverse: derived_output_mismatch` |
| 2 denominator 247,050 → 1 | `measurements.denominators: denominator_not_recomputable` |
| 3 removed origin | `origins: derived_output_mismatch` |
| 4 forged funnel survivor | `measurements.conditionalLane: derived_output_mismatch` |
| 5 erased performance reads | `snapshot.reads: snapshot_hash_mismatch` |
| 6 cross-paired account | `snapshot.reads: identity_not_pinned` |
| 7 removed ledger invocation | `provenance.readLedger: invocation_set_mismatch` |
| 8 row count → 999,999 | `provenance.readLedger: slice_count_mismatch` |
| 9 replaced source-row hash | `provenance.readLedger: slice_hash_mismatch` |
| 10 replaced query-contract hash | `provenance.queryContractSha256: query_contract_mismatch` |
| 11 replaced predecessor hash | `provenance.pinnedInputHashes: predecessor_hash_mismatch` |
| 12 cutoff → 2099-01-01 | `window: derived_output_mismatch` |
| 13 flipped transition + total | `observedTransitions: derived_output_mismatch` |
| 14 erased waivers | `measurements.conditionalLane.waivers: waivers_mismatch` |
| 15 erased leakage checks | `leakageChecks: derived_output_mismatch` |

Twenty-three further attacks are covered: smuggled and missing read fields,
duplicate and unexpected invocations, forged envelope grain/identity/hashes,
future knowledge times, impossible dates, invented `readFailures`, forged
sample, breakdown, exposure and causal claims, flipped selection flags, merged
accounts, a mutated snapshot row, and a coordinated snapshot-plus-hash lie.

**The leakage proof was also rebuilt.** v1 only showed that the pure engine
changes when handed a later fact — true, but silent about the selector that
decides what gets handed over. Each check now drives the real
`latestAtOrBefore` seam: at the earlier origin the later fact is not selected
and the decision fingerprint is unchanged, and a negative control proves the
same fact becomes visible, and does change the decision, once the origin
advances past it. All five families — owner, role, commercial target, unit
exponent, config state — pass both directions.

**Contract `v2` supersedes `v1`.** The artifact gained `snapshot.reads` and
`provenance.analysisHash`, and dropped the pre-materialised snapshot sections.
That is a schema change, so the version moved with it rather than silently
expanding v1.

**No finding changed.** The corrected package reports the same real numbers from
the same real snapshot: 95 reads, 23,278 frozen rows, 2,430 entities, 17
origins, 247,050 proposals, 0 eligible, 444 transitions / 23 resolved / 14
distinct events. The verdict stands.

---

## 10. Determinism and integrity

- The frozen reads are carried inside the artifact, so `replay` re-derives the
  analysis from the same bytes rather than from a second database read.
- Two consecutive replays produced identical snapshot, analysis and artifact
  hashes.
- The verifier registers a semantic handler for all 20 discovered row-bearing
  sections and publishes what each one checked. Self-authored section hashes are
  still recomputed, but they are now the last and weakest check rather than the
  only one.
- **Remaining limit, stated plainly:** an offline verifier cannot detect a
  wholesale re-forge in which the reads, the ledger and every derived output are
  replaced consistently with one another. What binds this package to reality is
  the real-DB extraction inside a server-asserted read-only transaction and the
  pinned predecessor hashes, not the artifact's internal consistency. Every
  single-field and small coordinated edit is now caught.

---

## 11. Scope

Exactly the six charter businesses and the seven pinned bindings from D080A.
Accounts are never merged inside a business. TheSwaf carries one selected account
and one assigned-but-deselected reference account; the deselected account is
scope-blocked in every proposal it appears in (6,810 of them) and is never action
scope.

Pinned inputs verified byte-for-byte before the run: D080A artifact
`d4a1898a…`, D080A internal `21e7ac32…`, D078 bundle `9c0d83aa…`.
