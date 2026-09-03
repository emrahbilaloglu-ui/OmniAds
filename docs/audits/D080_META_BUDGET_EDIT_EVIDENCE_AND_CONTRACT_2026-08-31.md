# D080A — Meta budget-edit evidence and contract design (2026-08-31, Correction 10)

**Analysis only.** No database, provider, live, product, UI, route, resolver,
schema or migration mutation of any kind. The four audit deliverables listed
below were written — that is the task. Configuration loading populated
`process.env` (see §1), but never granted or masked execution authority.
**Automation remains OFF.** No manual Test/Main/Mixed label source was read,
restored or consulted.

---

## Current verification

Every number below is emitted by `runVerify` and re-rendered from the artifact.
The block is delimited so a test can parse it and compare it to a live verify;
nothing in this document may claim a value the verifier does not produce.

<!-- D080-VERIFICATION-BLOCK:BEGIN -->
| Verified value | Current |
|---|---|
| `contract` | adsecute.meta.d080-budget-edit-evidence.v6 |
| `retrievedAt` | 2026-08-31 21:59:04.483477+00 |
| `sqlTemplates` | 28 |
| `planDefinitions` | 29 |
| `expectedInvocations` | 226 |
| `observedInvocations` | 226 |
| `requiredSections` | 25 / 25 |
| `discoveredRowSets` | 68 / 68 |
| `totalRows` | 176712 |
| `scopeCheckedRows` | 176391 |
| `effectiveTimeCheckedFields` | 181542 |
| `knowledgeTimeCheckedFields` | 10651 |
| `matrixAudits` | 8 |
| `crossSectionReconciliations` | 121 |
| `invocationResultReceipts` | 226 |
| `recomputableResultReceipts` | 211 |
| `sourceAggregateRows` | 77 |
| `violations` | 0 |
| `ok` | true |
<!-- D080-VERIFICATION-BLOCK:END -->

A test asserts that exactly one such block exists in this file and that it is
byte-identical to `renderVerificationBlock(artifact, verifyArtifact(artifact))`.

**The contract stays at `.v6`.** Correction 10 is verifier hardening only: no
artifact field was added, removed, renamed or retyped, and the generated package
is byte-for-byte what v6 already described. What changed is that the verifier now
*proves* the whole `dependencyCoverage` cell instead of five of its eleven
fields. A v6 reader sees exactly the same schema; a forged v6 package no longer
passes. Bumping to v7 would signal a schema change that did not happen.

Correction 9 moved v5 to v6, and that reason still stands: Correction 8 kept v5 on the
grounds that only verifier strictness had changed. Correction 9 changes the
artifact itself, so the version moves with it:

- **new section** — `dependencyCoverage.cells`, one row per invocation a
  dependency prevented, required by the shape contract and reconciled one-to-one
  against the ledger's skips;
- **new statuses** — `not_run_dependency_failed` is now legal on
  `canonicalDecisions.servedDateCoverage`, `analysis.servedDateContract.coverage`
  and `canonicalDecisions.perBinding.latest_status`;
- **new row fields** — `dependency_code` and `missing_prerequisites` on unit,
  config, served-date and canonical coverage cells;
- **a relaxed-then-rebound invariant** — `clocks.perBinding.series_from` may now
  be null, but only when dependency cells declare it unavailable.

A v5 reader would not know any of these exist, so keeping v5 while expanding its
schema would have been the silent expansion the correction forbids.

---

## Corrected verdict: `NO-GO`

The verdict survives Correction 3, and one of its supporting blockers is now
*stronger* than before while another has been re-derived from scratch.

| # | Blocker | Evidence in this run |
|---|---|---|
| 1 | **Strict point-in-time owner reconstruction is unavailable on this database.** | `meta_entity_observation_runs` lacks `last_captured_at`, `manifest_kind`, `base_run_id`, `delta_stats_json`. `resolveBudgetOwnerAtOrigin` returns status `unresolved_schema_contract`; in the retrospective layer that surfaces as **162,614** entity-days with outcome `blocked_owner_schema_contract`, plus **2,428** that exit earlier as `not_pit_reconstructible` because those origins have no prior visible performance row. |
| 2 | **The decision system cannot express a budget intent.** | `decision_entity_type = 'ad'`; vocabulary is creative-only. Observed budget-decision denominator **0**, from a scanned historical population of **307,963**. |
| 3 | **Campaign role has no account-scoped, knowledge-time-safe authority.** | All 2,318 in-window rows have `provider_account_id = NULL`; the source is a mutable UPSERT, so it can at best be a retrospective candidate. |
| 4 | **Budget-configuration history cannot support a change model.** | Of 5,793 non-routine transitions, only **23** (11 campaign + 12 ad-set) have resolved semantics on both sides. 2,368 ad-set states carry *both* budget fields and 2,096 campaign states are conflicting captures. |
| 5 | **The endpoint contract is unverified**, with no reconciliation path and no manual idempotency key. | Both Postman URLs return an SPA shell with zero occurrences of `daily_budget`. |

Blocker 4 replaces Correction 2's "63 ad-set true changes" — that number was an
artefact of a model that coerced dual-field states to daily and let conflicted
baselines seed clean transitions.

---

## 1. Provenance, transaction and read ledger

| | |
|---|---|
| Artifact | `docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json` |
| Contract | `adsecute.meta.d080-budget-edit-evidence.v6` (supersedes v5 and the rejected v4) |
| Retrieved | `2026-08-31 19:26:23.934557+00` (server clock) |
| Transaction | `transaction_isolation = repeatable read`, `transaction_read_only = on`, both read back from the server and asserted before any query ran |
| Timeouts | `statement_timeout = 30s`, `lock_timeout = 5s` |
| Read invocations | **226** expected, **226** observed, each savepoint-isolated and reconciled one-to-one against the generated plan |
| Read failures | **none in this run** |
| Size | 50,906,326 bytes |

**Query failures.** Zero. This is run-dependent and is not a standing property:
the Grandmix ad-set config clock (`act_805150454596350`) sits on the 8-second
pool boundary and failed in two earlier runs of this same code. Where it fails
it is recorded as `unknown/source_read_failed` with the **real** grain
(`adset`) and the **real** source table (`meta_adset_config_history`) — the
previous package wrote the query name into the grain field while the report
said `adset`, which is corrected. Claimability is derived from the read ledger,
so the artifact and this report cannot disagree about which cells are known.

`clockAdsetConfig` is **lower-bounded at a fixed floor** to keep the scan inside
the statement timeout. Its reported earliest value is therefore that floor, not
the source's unbounded minimum; the executed read plan states this explicitly.

**Environment, stated precisely.** Correction 2 opened with "no write of any
kind" and "no environment mutation" and then described the loader populating
`process.env`. Both statements cannot be true; the blanket one is withdrawn.
What actually happens: the module has **no import-time side effect at all** (a
subprocess test asserts `process.env` is unchanged by importing it);
configuration is loaded only at an explicit CLI boundary, where `@next/env`
populates `process.env` and set `ENABLE_RUNTIME_MIGRATIONS` from unset to
`"false"` in this run. The enforced invariant is that execution authority is
never granted or masked: a flag truthy **before or after** loading refuses the
run and is never overwritten to pass. Both truthy sets were empty here.

---

## 2. Query-scope manifest — the blanket claim is withdrawn

Correction 2's provenance said every read was "account-scoped and two-sided".
That was false for the four clocks, `canonicalLatestAsOf`, `campaignRoleCensus`,
`targetPackHistory` and both static probes, and the test that appeared to prove
it checked five hand-picked names.

The artifact now carries a **query manifest** with one entry per query, and the
tests iterate it in full. Every entry declares kind, scope, effective bounds,
knowledge bounds, PIT status and a stated reason; a test asserts the SQL
actually applies what each entry claims.

| Kind | Queries | Notes |
|---|---|---|
| `static_schema` | 2 | `runSchema`, `decisionVocabulary`. **Not** account-scoped and **not** two-sided; a date predicate on `information_schema` would be theatre. |
| `binding_discovery` | 1 | `bindings` is business-scoped **on purpose** — its job is to detect an account outside the pinned matrix, which an account filter would hide. |
| `time_varying` | 25 | Each declares its own bounds. Clocks and `MAX` probes are `effectiveBounds: none` with a stated reason: bounding a clock makes it report the bound instead of the clock. |

Two queries carry `knowledgeBounds: upper_only` — the config reads and the
ownership lineage read, which previously bounded `observed_at` only and shipped
287 rows captured after their binding cutoff.

**Three separate counts, never conflated:**

| | Count | What it is |
|---|---|---|
| SQL templates | **28** | distinct statements in the query contract |
| Plan definitions | **29** | invocation shapes; `configSemanticStates` has two, one per knowledge-bound layer |
| Expected invocations | **226** | execution instances for the fixed scope: 4 once + 112 per-binding + 98 per-binding-grain + 12 per-business |

Correction 5 generated the 226 descriptors but compared only **labels**. The
descriptor carried no expected bounds, as-of date, limit or statement, and
`source` was compared only where the plan definition happened to declare one —
so `seriesCampaign.effectiveFrom = 1900-01-01`, `source = totally_wrong`,
`limit = 1` and a forged `asOfDate` all verified clean.

The read boundary is now a **canonical request**. `buildCanonicalRequest` shapes
the statement (including the campaign/ad-set table and entity-column
substitutions), normalises the parameters, and hashes both; `safeQ` executes
*that object* and derives the ledger row from it, refusing to run at all if the
request's own hashes do not describe its statement and params. There is no
separate scope argument that could describe a different query than the one
executed.

`verify` then **rebuilds** every expected request from the static plan plus the
frozen prerequisites — the seven bindings and six businesses, each binding's
cutoff and `series_from`, the lineage window, the ad-set-config clock floor, the
business cutoff, each layer's knowledge bound, the latest canonical as-of date,
the identity limit and the business-list hash — and compares fifteen fields per
invocation: template key, statement SHA-256, params SHA-256, business, account,
business-list hash, grain, source, effective lower/upper, knowledge upper-or-null,
as-of date, limit, PIT status and bound kind. Every plan definition now has an
exact source expectation, including the binding-level entries that previously
had none. A dependency skip legitimately carries no bounds and is checked on
template and source only.

`provenance.readFailures` must equal the non-`ok` ledger rows as an exact
canonical **multiset** keyed by invocation, status, reason and row count, so a
duplicated failure can no longer hide a different failed invocation.

---

## 3. Config transitions — rebuilt from ordered raw history

Correction 2 grouped by `(entity, effective_from)` with `MAX(daily_budget)`,
`MAX(lifetime_budget)` and `MAX(captured_at)`, discarding `config_fingerprint`,
row id and within-day order. That model could not tell a duplicate from two
genuine same-day transitions, and it silently chose `daily` whenever both budget
fields were set.

The model is now explicit about state semantics:

| State class | Resolved? | Meaning |
|---|---|---|
| `daily_only`, `lifetime_only` | **yes** | a single comparable budget kind |
| `both_fields_present` | no | both fields set; which is authoritative is unproven until the endpoint contract is captured, so it is never coerced |
| `conflicting_capture` | no | more than one `config_fingerprint` inside the effective day |
| `mixed` | no | `is_budget_mixed` |
| `neither` | no | no budget observed |

A transition is `true_change` **only** when both sides are individually
resolved and single-kind. Ordering is deterministic on
`(effective_from, captured_at, id)`, and `config_fingerprint` identity is
preserved. All aggregation happens in SQL: roughly 700k raw captures never leave
Postgres, and only the 5,793 non-routine transition identities are materialised.

### Point-in-time layer (captures recorded by the binding cutoff)

| | Campaign | Ad set |
|---|---|---|
| Raw captures | 120,396 | 565,734 |
| Semantic states | 3,894 | 7,749 |
| Duplicate captures collapsed | 116,502 | 557,985 |
| Same-clock conflict states | 0 | 0 |
| `both_fields_present` states | 0 | **2,368** |
| `conflicting_capture` states | **2,096** | 548 |
| `mixed` states | 1,393 | 0 |
| Initial observations | 868 | 1,562 |
| Unchanged | 70 | 3,350 |
| Unresolved (prior + next) | 2,945 | 2,825 |
| **Clean true changes** | **11** | **12** |

### Retrospective-finalized layer (`isPointInTime: false`)

Same effective window, admitting capture recorded after the cutoff: campaign
130,006 raw captures, ad-set 606,298 — i.e. **9,610 campaign and 40,564 ad-set
captures arrived after their cutoff**. Clean true changes are unchanged at 11
and 12; the layers differ in the tail (`unchanged` 3,348 vs 3,350,
`unresolved_next_state` 358 vs 356, `conflicting_capture` 550 vs 548 on ad set),
which is exactly the late-arriving evidence the PIT layer must exclude.

**Coverage: 42 expected cells (7 bindings × 2 grains × 3 reads — the two
semantic layers plus the identity read), exact key audit clean, 0 unknown.**
Correction 3 counted only the 28 semantic cells and left the identity read
outside coverage entirely, so it could fail while the total still read as
claimable.

Claimability is two separate booleans, and neither borrows the other's success:
`semanticCountsClaimable: true` and `identityManifestComplete: true`. Both are
now **recomputed by `verify`** from the coverage rows using the same pure
function replay uses, rather than trusted as self-authored booleans — Correction
4 would accept a failed `configTransitionIdentities`, `servedDateCandidates`,
`canonicalIdentities` or `unitEvidenceCampaignDaily` read with the coverage and
claims left untouched. Canonical evidence additionally carries an explicit
`identity_status` per binding (`ok_populated`, `ok_zero_identities`,
`unknown/source_read_failed`, `not_run_dependency_failed`), so a failed or
skipped identity read can never present as a clean empty membership. All seven
bindings are `ok_populated` in this run.
The identity manifest is
`01be667285dd574a46b7a35a3b3e9314648f5e37f033142be71e42e9a348e84a` over all
**5,793** non-routine transitions, none truncated. **23 clean true changes**
(11 campaign + 12 ad-set).

---

## 4. Strict-PIT and retrospective denominators, kept separate

| Layer | Denominator | Result |
|---|---|---|
| **Strict point-in-time** | **0** | Unavailable: schema lag plus four mutable-UPSERT sources. No result reported. |
| **Retrospective finalized counterfactual** | **165,042 entity-days** | 162,614 `blocked_owner_schema_contract`, 2,428 `not_pit_reconstructible` |

Identical at 7, 14, 28 and 56 days. No entity-day reaches the role, anchor or
unit gates. Assumed-divisor sensitivity: 0 candidates at both divisors on this
population; the 100× divergence is demonstrated in the suite, where one row
yields `blocked_not_binding` at divisor 1 and `candidate_increase` at divisor
100.

---

## 5. Native decisions versus the UI served date

Correction 2 said both readers take the native `MAX(as_of_date)`. **Only one
does.** `lib/meta/assigned-account-states.ts` takes the native maximum alone.
`app/api/meta/decisions-workspace/route.ts` calls `resolveWorkspaceEndDate`,
which resolves a served end date from a **union of three candidates** — native
ad decisions, legacy creative snapshots scoped to account-exclusive creatives,
and the native job-run date — with fallbacks, then reads that exact day.

Reproduced per binding, and they are **not** equal:

| Account | Native max | Legacy max | Job-run max | UI served date | Equal? |
|---|---|---|---|---|---|
| `act_1087566732415606` | 2026-08-22 | 2026-08-22 | 2026-08-22 | 2026-08-22 | yes |
| `act_805150454596350` | 2026-08-22 | 2026-08-22 | 2026-08-22 | 2026-08-22 | yes |
| `act_840779107261785` | 2026-08-22 | 2026-08-22 | 2026-08-22 | 2026-08-22 | yes |
| `act_822913786458311` | 2026-08-22 | 2026-08-22 | 2026-08-22 | 2026-08-22 | yes |
| `act_921275999286619` | **2026-08-21** | 2026-08-22 | 2026-08-22 | **2026-08-22** | **no** |
| `act_2335220976649516` | 2026-08-22 | 2026-08-22 | 2026-08-22 | 2026-08-22 | yes |
| `act_3554615364751964` | 2026-08-22 | 2026-08-22 | 2026-08-22 | 2026-08-22 | yes |

`fleetComparisonClaimable: true` — all seven cells `ok` with a clean exact key
audit — and `allServedEqualNativeMax: false`. On TheSwaf's non-selected account
the UI would serve a day the native table does not reach, so **the native
maximum is not the UI population**.

Correction 3 reproduced only the `meta_creative_daily` half of the route's
ownership CTE, so it was not the contract it claimed to be. The query now
reproduces the route exactly — `meta_creative_dimensions` UNION
`meta_creative_daily` with the account-exclusivity rule — and an independent
read-only comparison against a verbatim transcription of
`resolveWorkspaceEndDate`'s query agreed on **7 of 7** bindings. This covers the
**default path only**: the route returns an explicit `endDate` verbatim, and
returns the previous UTC date when the provider account is null. Those fallbacks
are described, never synthesised as observed evidence.

The comparison is coverage-driven: one record per pinned binding with status
`ok` / `unknown/source_read_failed` / `no_candidate`. When any cell is not `ok`,
`allServedEqualNativeMax` is **null** rather than a vacuous `true` from
`.every()` over a short list. In this run all seven cells are `ok`, the exact
key audit is clean, and the route comparison agreed **7/7** at
`2026-08-31 15:59:55+00` under `read_only = on` / `repeatable read`.

Correction 4's tests only regex-checked that both table names appeared, which
proves none of the semantics. The contract is now modelled as pure functions and
tested behaviourally: dimensions-only ownership; daily-only ownership; the union
of both without double counting; a creative seen under two accounts **excluded**;
a creative owned only by another account excluded; the later legacy candidate
winning; the later job-run candidate winning; `no_candidate` and
`unknown/source_read_failed` kept distinct; and the seven-binding fleet
comparison unclaimable — never vacuously equal — when a cell is missing or
failed. A final test replays the frozen artifact's own seven bindings through
that model and requires the same verdict.

The identity manifest is retained, not replaced by counts: latest-generation
denominator **8,237** across seven bindings, manifest hash
`a5d7fd393f14f0afc528234bdac2191a172111bb09702b20bd910829278d2518`, bound over
the full tuple (business, account, as-of, engine version, decision entity, ad,
scope, input hash, decision hash, evaluation id, job run id, computed at).

`scannedCanonicalPopulation` is renamed **`scannedHistoricalSnapshotRows`**
(307,963): that query scans the bounded historical snapshot population across
days and engine versions, not the latest canonical generation.

---

## 6. Campaign-role authority — temporal and account

`engine_v3_campaign_context_daily` is a mutable UPSERT, so a row read today is
the **current recomputation** of a historical day. The resolver now carries an
explicit source temporal status: a mutable current snapshot can yield a
`retrospective_role_candidate` but is refused as historical authority
(`blocked_mutable_source_not_pit`), even if a supported resolver were added
later. `overwritten_after_insert` (`updated_at > created_at`) is carried per row.

Provider account is part of the **selection** key, not a later check, so a later
row for another account cannot shadow a valid row for the expected account.
Legacy null-account rows remain migration evidence and are never authority.

Two scopes, labelled separately so the report cannot look self-inconsistent:
**2,318** bounded in-window rows, and **2,350** full-history census rows
(556 + 379 + 405 + 758 + 149 + 103). Zero account-scoped rows in either. Replay
census: 4,808 `blocked_legacy_business_scope`, 160,234 `blocked_no_pit_row`.

Correction 3's temporal gate was never actually exercised: with the product's
supported-resolver set empty, the unsupported-resolver gate always fired first,
and the test that claimed to prove the mutable-source branch built a local
supported-version array it never passed in. The resolver now takes
`supportedResolverVersions` as an injected input **defaulting to the product
constant, which stays empty**, and four branches are proven behaviourally:
supported + mutable source → `blocked_mutable_source_not_pit`; supported +
immutable + recomputed row → `retrospective_role_candidate`; supported +
immutable + clean account-scoped row → `authoritative`; and cross-account,
null-account, stale, low-confidence and unsupported rows all still fail closed.
With the product default, nothing in this data is authoritative.

---

## 7. Unit-evidence coverage — four cells per binding

All four grain/field cells are now queried; Correction 2 had no
campaign/lifetime query yet claimed "campaign/lifetime yields no comparable
rows", which was unsupported.

**28 cells (7 bindings × 4): 19 `rows_returned`, 9 `zero_rows_returned`, 0
unknown**, with an exact key audit (no missing, duplicate or unexpected cell).
All seven campaign/lifetime cells return **zero rows** — a successful read
finding nothing comparable, i.e. **zero evidence**, not proof that campaign
lifetime budgets are absent. ColorFullWorldsTR contributes the other two zeros
(ad-set daily and lifetime).

The factual unit contract remains `unknown_unit_scale`: the only proven relation
is identity, and every `adset/lifetime` cell where all three relations hold is
vacuous because the values are zero.

---

## 8. Invariant registry — what is actually checked

Correction 2 checked four hand-picked sections (179,519 rows = series +
ownership + config + canonical) and skipped one with a `__none__` sentinel,
while claiming "every artifact row". At least 2,477 row-bearing records were
uncovered.

The scan is now registry-driven: it walks the artifact, requires an explicit
handler for **every** row-bearing section, and fails verification if a new one
appears without one.

Correction 3 still had six ways through it, each reproduced before being fixed:
a freshly sealed **empty shell** verified `ok`; a row set at depth four was
invisible because discovery stopped at `path.length > 3`; a
`source_clock_exception` waived **scope** as well as time, so an unpinned row
passed; `configStates.identities` had no knowledge-time field, so an
Aug-20-effective row captured Aug 29 passed under an Aug 21 cutoff; a
null-account role row dated after its business's cutoff passed because
business-scoped rows had no derived bound; and an unpinned read-ledger row
passed because the scan read only snake_case while the ledger uses camelCase —
while still incrementing the "checked" counter.

All six now fail closed. Discovery is exhaustive with no depth cap; 23 required
sections must **exist** (an empty array is valid data, an absent section is
not); scope is validated independently of any clock exception; identity
accessors accept both naming conventions; and derived sections carry
`businessId` so they can be validated at all.

| Handler | Sections | Rows | Scope-checked | Effective fields | Knowledge fields |
|---|---|---|---|---|---|
| `pinned_binding` | 14 | 173,698 | 173,698 | 179,224 | 8,333 |
| `pinned_business` | 4 | 2,338 | 2,338 | 2,318 | 2,318 |
| `verified_aggregate` | 15 | 269 | 262 | 0 | 0 |
| `source_clock_exception` | 8 | 93 | 93 | 0 (exempt) | 0 (exempt) |
| `static_schema` | 19 | 45 | 0 | 0 | 0 |
| **Total** | **60** | **176,443** | **176,391** | **181,542** | **10,651** |

The single `rowsBoundChecked` figure is withdrawn: it conflated "a handler
visited this row" with "this row's bounds were checked". The time counters count
**fields**, not rows — 143 clock fields are explicitly exempted under eight
named exceptions.

Correction 5 closed six further escapes, each reproduced against the frozen
artifact before being fixed. Emptying `clocks.perBinding` silently removed **all**
temporal enforcement while still verifying; deleting `analysis`,
`capabilityMatrix`, `d080bContract`, `correctionLedger`, `sourceSemantics` or
`schemaContract` verified; a wrong `contract` string, `transactionReadOnly =
"off"` or a forged `queryContractSha256` verified; a compromised
`executionAuthority` verified; an emptied `scope.pinnedBindings` or a fabricated
`unexpectedExtra` verified; and a **non-empty** scalar list disappeared from
discovery entirely, because `materialiseRows` only treated scalar arrays as
sections while they were empty.

Correction 6 closed six further classes. The shape contract was **top-level
only**, so deleting `analysis.layer1Budget` or `analysis.configChangeQuality`
simply made the recomputation skip its own checks and verified clean; status
domains were unvalidated, so `not_run_dependency_failed` still counted as a
successful unit read; `clocks.perSource` was checked only for `length === 28`,
so swapping a cell for a duplicate of another passed; and `scope.observedBindings`
was reduced to a Set, hiding duplicates and self-declared omissions.

The contract now also requires 22 **nested** objects the report depends on
(`analysis.layer1Budget`, `analysis.configChangeQuality`, `analysis.unitCoverage`,
`analysis.servedDateContract`, the two config layers, the identity manifest, the
capability and D080B sub-objects and more), validates four enumerated status
domains, rejects any execution-authority change outside the known flag set or
with a truthy value on either side, requires `clocks.perSource` to be exactly one
row per `(business, account, source, grain)` **key** with each raw value
reconciled against the derived `per_source` snapshot, and requires
`scope.observedBindings` to be the exact seven-row result with `is_selected`
parity. `unitAllCellsRead` is true only for `rows_returned` or
`zero_rows_returned`.

The verifier also enforces a full versioned shape: the exact contract string, 14
required top-level objects, seven required scalar lists, the transaction proof
(`repeatable read` / `read_only = on` / declared timeouts), clean execution
authority with both truthy sets empty, the D078 pin, and the query-contract,
query-manifest and read-plan hashes against the live code constants. The pinned
matrix is compared to the seven-entry constant; `expectedMissing` and
`unexpectedExtra` are **recomputed** from `observedBindings` rather than trusted;
`clocks.perBinding` must hold exactly one cell per binding with a cutoff and
`series_from` recomputed from the required daily clocks; and `clocks.perSource`
must hold exactly 28 cells. A declared clock field that is absent, or present
without a resolvable cutoff, is now a failure instead of a silent skip.

| Counter | Value | Meaning |
|---|---|---|
| `discoveredRowSets` / `registeredSections` | 67 / 67 | every array, scalar lists included |
| `requiredSectionsPresent` | 24 / 24 | required row sections |
| `totalRows` | 176,712 | rows in registered sections |
| `scopeCheckedRows` | 176,391 | membership actually validated |
| `effectiveTimeCheckedFields` | 181,542 | effective-clock **fields** compared |
| `knowledgeTimeCheckedFields` | 10,651 | knowledge-clock **fields** compared |
| `matrixChecks` | **8** | exact key matrices enforced: 5 recomputed here, plus the clock-binding, clock-source and observed-binding audits the shape contract performs |
| `crossSectionReconciliations` | **121** | comparisons of two independent values |
| `invocationResultReceipts` | **226** | one outcome receipt per invocation |
| `recomputableResultReceipts` | **211** | receipts whose slice is recomputed and hashed offline |
| `sourceAggregateRows` | **77** | DB aggregates that cannot be recomputed offline |
| `expectedInvocations` / `observedInvocations` | 226 / 226 | exact plan reconciliation |

A test asserts this block against the live verifier output, so the 23/23-versus-
24/24 and 176,486-versus-176,712 drift Correction 6 shipped cannot recur.

### Invocation results bound to materialised evidence

Correction 5 treated a successful ledger row and a detached array as evidence of
each other. Emptying `series.rows` (165,042 rows), `configStates.identities`
(5,793), `canonicalDecisions.servedDate`, `ownershipObservations.rows` or
`campaignRole.rows` all verified clean, and a successful row count could
disagree with the slice it claimed to have produced.

Every invocation now has an **outcome receipt** of one of three explicit kinds.
Correction 6 left 15 of them with `rowHash: null` and treated that as proof; it
was not proof of anything.

`materialised_slice` (**211**) carries the actual source row count and hash
captured at the read boundary *before* transformation, plus the offline-recomputed
slice count and slice hash. `source_query_receipt` (**15** — one `runSchema`,
seven `canonicalLatestAsOf`, seven `canonicalIdentities`) carries the actual
source row count and hash from the boundary together with a **bound transformed
summary hash**: the observed/missing column contract, the per-binding latest
status and as-of date, and the membership count, group hash and censuses
respectively. Its raw hash cannot be recomputed offline, and this report says so
rather than claiming all 226 row hashes are offline-recomputed.
`dependency_skip` carries a deterministic no-query envelope hash and is never
described as a zero-row result; there are none in this run.

`verify` recomputes all 226 receipts and compares them field by field, so a
removed slice, a count that disagrees with the ledger, a failed read that still
has rows, a **row-content change that preserves the count**, a forged source
hash, a mutated summary binding or a changed receipt kind each fail.

`aggregateConsistencyCheckedRows` is **withdrawn**. Correction 4 reported 269 of
them while performing no aggregate comparison at all: inflating
`unitEvidence.rows[0].compared`, rewriting `budgetVerbCensus.scanned_rows`, or
setting a replay window's `entityDays` to 1 all verified clean. The 121
cross-section reconciliations, 8 matrix checks and 226 outcome receipts are now
real — coverage matrices recomputed from their rows,
claims re-derived from coverage by the same pure function replay uses, replay
window outcome sums against their denominators, membership sums against the L1
denominator, config transition totals summed from the frozen rows, the unit
`totalCompared` sum, sub-counts bounded by their own denominator, and the
budget-verb census sum. The 77 remaining rows are named honestly: a raw
provider-side aggregate such as an observation-run repeat count cannot be
recomputed from anything else in the package, and is protected only by the
frozen extract and file hash. That limitation is stated rather than counted as a
check.

---

## 9. External API receipts

Every external claim carries a receipt: URL, retrieval date, declared date-only
precision, method, a short claim-specific excerpt, a **`claimMetadataHash`**, and
a status that **carries the limitation instead of hiding it in prose**. The hash
covers this audit's own claim record, not captured source bytes — no page
capture is archived — and it is named accordingly.

| Claim | Status |
|---|---|
| v24.0 daily budget flexibility 25% → 75% | `primary_render_verified_not_byte_verified` (also `official_sdk_release_verified`) |
| v24.0 `is_adset_budget_sharing_enabled` required for ad-set-level budgets | `primary_render_verified_not_byte_verified` — the SDK notes do **not** contain it and were not used |
| v25.0 Advantage+ restriction, all versions by 2026-05-19 | `primary_render_verified_not_byte_verified` (also SDK) |
| v26.0 released 2026-07-29 | `primary_render_verified_not_byte_verified` — SDK v26.0.0 (2026-08-06) says only that it follows Graph v26 and does **not** establish the date |
| v22.0 expires 2027-05-20; v21.0 2027-01-21; v19.0 expired 2026-05-21 | `primary_render_verified_not_byte_verified` |
| Campaign vs ad-set budget endpoint/field/body/amount contract | **`unverified`** — HTTP 200 but an SPA shell with zero `daily_budget` occurrences; not asserted, not inferred |

There is no blanket `VERIFIED` status anywhere: `developers.facebook.com`
answers direct curl with an HTTP 400 bot shell, so no Meta page could be
byte-verified and **no source capture is archived**, and that fact is part of
every status.

Two receipt-metadata corrections. `retrievedAt` is a **date**, so each receipt
now declares `retrievedAtPrecision: "date_only"`; the exact retrieval instants
were not captured and an earlier precise time is not invented. And the per-claim
hash is renamed **`claimMetadataHash`**: it is a sha256 over this audit's own
claim record (url, date, precision, method, excerpt, status), which detects
edits to that record. It is **not** a hash of captured source bytes; the earlier
name overstated what it covers and is withdrawn from the report, the artifact
and the generator comments alike.

Repo inventory, with its scope published: production `v25.0` count **44**
(scope: tracked files, excluding `lib/archive/**` and all test/spec files);
the "~70" figure is withdrawn. Two write paths, both v22.0;
`lib/launchpad/meta-validation.ts` is a **read** path. No SDK dependency. Out of
scope and reported, not changed: `sign-with-facebook` is pinned to v19.0, which
expired 2026-05-21.

---

## 10. D080B contract (design only)

**Recommendation unchanged: a new typed generic execution ledger.** Correction 3
does not weaken it — §5's vocabulary finding means there is no typed path for a
campaign- or ad-set-grain budget intent anywhere in the decision system, not
merely in the action log.

**Rollback, corrected.** Before any use, rollback is `DROP TABLE` ×3 with no
effect on existing readers. **After use it is not zero-impact and `DROP` is not
the procedure**: disable the write route; drain and settle every in-flight
attempt so no provider mutation is left unreconciled; stop every reader extended
by `UNION`; and **retain the audit history**, because a budget change that
reached the provider must remain auditable after the feature is withdrawn.

`meta_automation_proposals` is not widened in slice 1.

---

## 11. What is what

**Verified facts** — §1–§9, each a count from the frozen artifact, a named file
and line, or a re-runnable command.

**Inference** — that the missing observation-run columns are the *only* barrier
to strict PIT owner reconstruction; the schema contract proves they are *a*
barrier and fails closed on that alone.

**Assumptions** — that `meta_entity_state_history` is the only `budget_origin`
authority; that `business_provider_accounts.is_selected` is the scope authority.

**Unknowns** — which budget field is authoritative when both are set (2,368
ad-set states); campaign lifetime unit behaviour (all seven cells returned zero
rows); whether the corrected role and anchor resolvers behave correctly on
production data — **they were never reached**, so they are proven by test only.

**Implementation gap** — no budget write path, no reconciliation path for value
mutations, no manual idempotency key, no per-currency exponent authority.

**Prerequisites** — a database migrated to the current observation-run schema; a
decision vocabulary that can express a budget intent at campaign and ad-set
grain; an account-scoped, knowledge-time-safe, non-shadow role resolver; and the
G1–G8 compatibility gate, beginning with the endpoint contract §9 could not
verify.

**What would change the conclusion** — blockers 1 and 2 are binding. Until the
decision system can represent a budget intent, there is nothing for a budget
policy to be measured against.

---

## 12. The dependency-cell contract the verifier enforces

Correction 9 built the cells correctly and tested that it had. It did not make
the **verifier** prove them: `reconcileDependencyCoverage` compared five fields
— invocation key, dependency code, missing set, plan key, family — and ignored
the other six. A re-sealed package could therefore name the wrong grain, the
wrong account, a fabricated business display name or a non-zero row count and
still return `ok: true`.

Every cell is now compared against a canonical projection derived from three
sources that are verified independently of the cell itself: the ledger's skip
row (already reconciled field-by-field against the request rebuilt from the
static plan and the frozen prerequisites), `D080_PINNED_BINDINGS` for the exact
display name and identity pair, and the static plan/family tables. A test
rebuilds that projection from a package with its cells **stripped out** and gets
the same 32 cells, so the expectation cannot be reading what it checks.

Eleven stable fields are permitted and required: `invocationKey`, `business`,
`business_id`, `provider_account_id`, `planKey`, `family`, `grain`, `status`,
`dependencyCode`, `missingPrerequisites`, `rows`. There is no implementation-only
metadata; anything else is a smuggled field and is named as one. `rows` joins the
finite non-negative integer schema *and* must be exactly `0` — a skip read
nothing, so any other value is a claim about data never fetched.

| Forged field | Verifier response |
|---|---|
| `grain` campaign→adset (**attack 1**) | `dependency_cell_grain_mismatch` |
| `rows` 0→-1 (**attack 2**) | `invalid_count` |
| `rows` 0→1 (**attack 3**) | `dependency_cell_rows_invalid` |
| `provider_account_id`→null (**attack 4**) | `dependency_cell_identity_mismatch` |
| `business` display forged (**attack 5**) | `dependency_cell_identity_mismatch` |
| `business_id` forged | `unpinned_binding` + `dependency_cell_identity_mismatch` |
| `provider_account_id` cross-paired | `unpinned_binding` + `dependency_cell_identity_mismatch` |
| `status`→`ok` | `status_domain` + `dependency_state_not_stated` |
| `planKey` forged | `dependency_plan_mismatch` |
| `family` forged | `dependency_family_mismatch` |
| `dependencyCode` forged | `dependency_code_mismatch` |
| `missingPrerequisites` forged | `dependency_missing_set_mismatch` |
| `invocationKey` forged | `dependency_coverage_mismatch` |
| `rows` as string / fractional / non-finite | `invalid_count` |
| smuggled extra field | `dependency_cell_unexpected_field` |
| any required field removed | `dependency_cell_field_missing` |
| cell duplicated or omitted | `dependency_coverage_mismatch` |

Every one of these also trips `dependency_cell_projection_mismatch`, an
independent multiset equality between the observed cells and the expected
projection. All five attacks in the list were observed returning `ok: true`
against the Correction 9 verifier before the change and rejected after it.

---

## 13. What the missing-prerequisite package actually proves

This is a behavioural result, not a description. The scenario runs the same
flow production runs — `collectEvidence` → `assembleArtifact` → `analyseAndSeal`
→ `verifyArtifact` — over a deterministic synthetic source, with one pinned
binding (`act_3554615364751964`) whose cutoff is valid and whose series lower
bound is explicitly unavailable.

| Claim | Observed |
|---|---|
| Planned outcomes preserved | 226 ledger rows, each invocation key exactly once |
| Result receipts | 226 |
| Executed vs skipped | 194 executed, 32 dependency skips |
| Victim owned invocations skipped | 26, all `binding_cutoff_unavailable` / `["series_from"]` |
| Executor calls for those 26 | 0 |
| Victim reads that still ran | 4 — the clock reads that resolved its cutoff |
| Victim unit coverage | 4 cells: `campaign/daily`, `campaign/lifetime`, `adset/daily`, `adset/lifetime` |
| Victim config coverage | 6 cells: 2 grains × `pointInTime`, `retrospective`, `identities` |
| Victim served-date coverage | 1 cell |
| Victim canonical coverage | 1 cell |
| Victim observation / state-change | 2 + 2 dependency cells (their row contracts carry no status column) |
| State on every one of those cells | `not_run_dependency_failed`, code `binding_cutoff_unavailable`, set `["series_from"]` |
| `analysis.unitCoverage.allCellsRead` | `false` |
| `clocks.perBinding.series_from` for the victim | `null`, with `cutoff` still `2026-08-21` |
| Full `verifyArtifact` on the sealed package | `ok: true`, 0 failures |

Four negative controls confirm the package is not merely self-consistent:

| Control | Verifier response |
|---|---|
| Drop one dependency-coverage cell | `dependency_coverage_mismatch`, naming the missing invocation |
| Forge one cell's dependency code | `dependency_code_mismatch`, cell vs ledger |
| Delete one victim unit-matrix cell | `dependency_matrix_hole` (expected 4, found 3) plus `coverage_key_mismatch` |
| Repair `series_from` silently | `request_provenance_mismatch` ×25 — the frozen prerequisites would imply executions that contradict the 26 recorded skips |
| Erase the cells but keep the null bound | `no dependency-coverage cell declaring it unavailable` |

The **real** package has zero dependency skips, so its `dependencyCoverage.cells`
is legitimately empty. The mechanism above is what proves that emptiness means
"nothing was blocked" rather than "something was blocked and disappeared".

---

## 14. Correction 10 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C10.1 | A dependency-cell reconciliation that compared five of eleven fields, so `business`, `business_id`, `provider_account_id`, `grain`, `status` and `rows` could each be forged in a freshly sealed package that still verified `ok: true` | One canonical expected-cell projection derived from the verified ledger skip, the pinned binding matrix and the static plan/family tables, compared field by field and as an exact multiset. Eleven fields are permitted and required; `rows` is in the integer schema and must be exactly `0`; smuggled and missing fields are each named. Business-scoped skips resolve their pinned business and require a null account; binding-scoped skips require the exact pinned pair |
| C10.4 | 345 tests | 372 tests, all passing in 668.7s under `--no-file-parallelism`. Each of the 27 new tests was observed failing before the fix and passing after; a deliberate wrong-reason mutation was used to confirm the reason assertions are not vacuous |
| C10.3 | Five pre-existing multi-reseal loops relied on the 15s default timeout | Each re-seals and re-verifies the ~50 MB real package three or more times; the added projection check pushed them to roughly 17.5s, so every such loop now carries an explicit 180s timeout. Same assertions, more wall clock — no assertion was relaxed and no attack was dropped |
| C10.2 | Attacks demonstrated only by constructing the package correctly | 27 behavioural tests that start from the valid sealed package, mutate one field, re-seal and re-verify. All five reported attacks plus sixteen more are refused with a dependency-cell reason, asserted to come from `dependencyCoverage.cells` rather than from a downstream matrix or a stale hash. Four more forgeries of the same family were found while writing them — a smuggled stable field, `rows` as a string, fractional `rows`, and a deleted `grain` — and closed with the rest |

---

## 15. Correction 9 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C9.1 | A "full-verifiable missing-prerequisite package" that never existed: the tests imported `assembleArtifact`, never called it, and asserted on `orchestrateEvidence`'s partial return value. Nothing was sealed and nothing was verified | One end-to-end seam — `collectEvidence` → `assembleArtifact` → `analyseAndSeal` → `verifyArtifact` — shared by production and the tests. Both extraction seams were proven behaviour-preserving first: replaying the shipped package through them reproduced its hash byte-for-byte. The synthetic missing-`series_from` run now seals a real package that passes the real full verifier, `ok: true`, zero failures |
| C9.2 | `expect(victimUnit.every(c => c.status !== "rows_returned")).toBe(true)` on an array that was ALWAYS empty — three vacuous assertions that passed because the dependency-blocked binding had vanished from every coverage matrix | Exact counts and exact key sets first, statuses second: 4 unit cells, 6 config cells, 1 served cell, 1 canonical cell, 2 observation and 2 state-change dependency cells for the victim, each `not_run_dependency_failed` with code `binding_cutoff_unavailable` and set `["series_from"]`. An empty array now fails. Four negative controls prove it: drop a dependency cell, forge its code, punch a hole in the unit matrix, or repair `series_from` silently — each is refused, with the exact reason |
| C9.3 | A guard that checked only the fields a plan *named*. Five self-consistent attacks reached the executor: an extraneous `knowledgeTo`, `asOfDate` or `limit`, an unpinned business/account pair, and a window running backwards | A complete nine-field envelope contract derived from the read plan for all 29 plans, where every field is required-with-parameter, plan-bound, nullable-bound, or **forbidden**. Identity is checked against the pinned binding matrix, dates must be real calendar dates, the effective window must run forwards, an upper knowledge bound must equal `effectiveTo`, a limit must be the plan's exact limit, and a business list must be exactly the pinned set. All five attacks plus sixteen more are refused with **zero** executor calls, and all 226 real requests still pass |
| C9.4 | "There was no `.claude/skills` directory and no skill invocation" — false, and contradicted by this session's own opening verification | Both files exist and were read in full: bridge `03a0790396b65596d4a9de7df223a900374a89319ffad924fbbe5ad29b57d88b`, canonical `985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`. Its quality bar — reject work that reports "done" when only a local validation is green — is the standard this correction was measured against |
| C9.6 | 297 tests, three of which were vacuous and one of which sealed nothing | 345 tests, all passing in 668.2s under `--no-file-parallelism`. Every new test fails if its guard is removed: the four negative controls, the twenty-one zero-executor-call refusals and the exact-count coverage assertions were each observed failing before the fix and passing after |
| C9.5 | "The victim binding executed all 25 of its plans" | 26, derived from the plan table: 12 `per_binding` plans that are not clock reads, plus 7 `per_binding_grain` plans at two grains. The four clock reads for that binding do execute — they are what resolve its cutoff — and are excluded from the owned set |

---

## 16. Correction 8 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C8.1 | An "end to end" orchestration test that cloned the finished green artifact, mapped every ledger row to itself and verified the unchanged original — a no-op that could not fail | One injectable orchestration seam (`orchestrateEvidence`) shared by the real extraction and the tests, driven through a fake executor from a synthetic prerequisite state. It exposed a real defect: a recorded-unavailable `series_from` was silently recomputed from the cutoff by a `?? seriesFromForCutoff(cutoff)` fallback, so the dependency gate never fired and the binding read a lower bound it had no evidence for. Removing the fallback exposed a second defect — the coverage loop derived its own lower bound and ran before the gate, so the victim's `observationCoverage` and `stateChangeDensity` were represented **twice**, once executed and once skipped. Both are fixed: prerequisites are resolved once per binding, the gate covers exactly the plans this orchestrator owns, and the clock reads issued before it are excluded |
| C8.2 | Skip-forgery tests that started from a row already contradicting its expected disposition, so the "attack" was rejected for the wrong reason | The attacks start from the valid skip baseline the C8.1 scenario produces and mutate one field at a time |
| C8.3 | A guard that bound only the statement and params hashes, so a request could carry a forged business, account, grain, bound or limit with honest hashes | The whole semantic envelope is bound before execution: template, shaped statement, a full rebuild from the request's own declared scope, and every declared field checked against the parameter that carries it. Writing the check found two more defects — a numeric `limit` was compared against its own string coercion and refused every `configTransitionIdentities` call, and a plan with a fixed grain accepted a foreign grain because neither its key nor its template interpolates one |
| C8.4 | A domain census that reached only the paths someone had listed | A recursive census over 17 object domains and 5 row-value domains; 13 unknown report-critical values are refused with the exact invalid path named. Meta's own delivery vocabulary (`campaign_status`, `effective_status`, `presence`) is deliberately **not** policed, and a test asserts it stays that way |
| C8.5 | A source-to-materialisation binding that compared the ledger hash to the receipt hash — both forgeable together | The transform is declared per plan (`identity`, `columnar_roundtrip`, `not_materialised`) and value-preserving transforms must satisfy hash equality against the **recomputed** slice, so a pair-forged hash is refused with `source_materialisation_mismatch` |
| C8.7 | 258 tests, of which the orchestration proof was a no-op | 297 tests, all passing in 672.8s. The count is not the point: the C8.1 scenario, the zero-executor-call envelope attacks and the pair-forged source hash each fail if the corresponding guard is removed, which is what the replaced tests could not do |
| C8.6 | `matrixChecks` as `shapeEnforcedMatrices.length + 5`, and report numbers a reader had to trust | 8 structured matrix audit records, each with its expected/observed/missing/duplicate counts and pass flag, and one uniquely delimited verification block in this document that a test compares byte-for-byte against a live verify |

---

## 17. Correction 7 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C7.1 | A skip waiver that compared only template and source, so a `not_run_dependency_failed` row could forge its hashes, business, account and bounds | An explicit execute/dependency-skip disposition union: a skip carries exact identity, explicitly null request fields, a deterministic dependency code, the exact missing-prerequisite set, a reason and a no-query envelope hash, all verifier-checked |
| C7.2 | "Boundary" tests that regex-matched an error string in the source and recomputed hashes by hand | The exact guard `safeQ` runs is exported and driven against an injected executor; a mismatched statement or params must produce **zero** executor calls |
| C7.3 | 15 executed invocations with `rowHash: null` presented as proof | Three explicit outcome kinds: 211 `materialised_slice` with boundary source hash plus recomputed slice hash, 15 `source_query_receipt` with boundary source hash plus a bound transformed-summary hash, and `dependency_skip` with a no-query envelope hash |
| C7.4 | A shape contract with four status paths, an unparsed timestamp and no numeric validation — `retrievedAt = "not-a-timestamp"`, `cutoff_status = "made_up"`, `latest_status = "made_up"`, `rows = -1` and `denominator = -1` all verified | v5: timezone-qualified timestamp parsing, valid calendar dates, six path-specific field domains, three status domains, 13 required count paths and row-level count fields all validated as finite non-negative integers |
| C7.5 | A four-field failure projection that accepted a forged `source`, `statementSha256` and `paramsSha256`; a hard-coded `matrixChecks: 5` | The complete stable ledger projection (everything except the genuinely nondeterministic `ms`), and `matrixChecks` derived from the named collection of matrices actually enforced — now 8 |
| C7.6 | 235 tests that left the seven confirmed attacks open | 258 tests: all seven attacks, the boundary with zero-call assertions, receipt-kind and summary mutations, typed/date/count/status attacks, forged skip fields and an automated report-versus-verifier consistency check |

---

## 18. Correction 6 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C6.1 | Invocation reconciliation that compared labels, never the actual call: no expected bounds/as-of/limit/statement, `source` compared only when the plan declared it, and a self-authored scope object beside the statement and params | A canonical request that shapes and hashes the statement and params and *is* the executed call, plus a verifier-side rebuild comparing 15 fields per invocation; every plan definition has an exact source; `readFailures` is an exact canonical multiset |
| C6.2 | Ledger rows detached from their results — emptying series, identities, served-date, ownership or role rows verified clean | 226 result receipts with recomputed slice counts and row hashes, compared against the stored receipts; failed/skipped reads may not carry rows |
| C6.3 | A top-level-only shape with no nested contract and no status domains; a dependency skip counted as a successful read | 22 required nested objects, four enumerated status domains, execution-authority self-consistency, and `unitAllCellsRead` restricted to genuinely successful statuses |
| C6.4 | `clocks.perSource` checked by length; `scope.observedBindings` reduced to a Set | Exact `(business, account, source, grain)` key matrix reconciled against the derived `per_source`; exact seven-row observed matrix with `is_selected` parity |
| C6.5 | Post-hoc JSON mutation as the only adversarial proof | 235 tests including all 22 independent attacks, boundary-level request-hash refusal, row-hash mutation, status-domain attacks, clock-key attacks and nested-deletion attacks |

---

## 19. Correction 5 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C5.1 | A verifier that accepted an emptied `clocks.perBinding` (silently disabling all temporal checks), any deleted top-level object, a wrong contract string, `read_only = "off"`, a forged contract hash, a compromised execution authority, an emptied pinned matrix, a fabricated `unexpectedExtra`, and a populated scalar list vanishing from discovery | A full versioned shape contract: exact contract string, 14 required objects, 7 required scalar lists, provenance truth, execution authority, D078 pin, three contract hashes, recomputed scope reconciliation, exact clock cardinality with recomputed cutoff and `series_from`, and fail-closed clock fields. Every array is a section |
| C5.2 | "29 executed plan entries" checked for at-least-once presence | 28 templates / 29 plan definitions / **226 generated invocation descriptors** compared one-to-one on identity and caller parameters, with explicit dependency skips so cardinality never shrinks |
| C5.3 | Stored `keyAudit` objects trusted as invariants | Every coverage matrix recomputed inside `verify`: 7 clock bindings, 28 clock sources, 42 config cells, 28 unit cells, 7 canonical, 7 served-date, 7 served-analysis — with drop, duplicate and extra all rejected |
| C5.4 | Ledger failures disconnected from coverage and claims | Each invocation status reconciled to its coverage cell, and every claim re-derived from coverage by the same pure function replay uses |
| C5.5 | `aggregateConsistencyCheckedRows: 269` for zero actual comparisons | **121 real `crossSectionReconciliations`**, 5 `matrixChecks` and 226 result receipts, plus **77 honestly-labelled `sourceAggregateRows`** that cannot be recomputed offline |
| C5.6 | Regex-only served-date tests; a stale "receipt hash" sentence and generator comment; "executed plan entries" | Behavioural served-date model covering ownership, exclusivity and every failure state; `claimMetadataHash` named correctly everywhere; the three counts stated separately |

---

## 20. Correction 4 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C4.1 | An invariant registry that accepted an empty shell, depth-four row sets, out-of-scope rows under a clock exception, late-captured config identities, null-account rows past their business cutoff, and camelCase unpinned rows — while counting them as "checked" | Exhaustive discovery; 23 required sections; scope validated independently of clock exceptions; dual-convention identity accessors; `businessId` added to derived sections; separate discovered / required / scope / effective / knowledge / aggregate / exempt counters |
| C4.2 | A template manifest presented as the read plan, with `configSemanticStates` labelled `pit_safe` despite a retrospective invocation, and tests that enforced only three bound kinds | A 29-entry executed read plan reconciled one-to-one with the ledger; per-invocation PIT status; `readFailures` proven to be the non-`ok` ledger subset; every `BoundKind` and scope kind enforced behaviourally |
| C4.3 | A served-date query that omitted `meta_creative_dimensions`, a comparison that could pass vacuously, and a stale "both readers take native MAX" comment | The exact route CTE, agreeing 7/7 with a verbatim transcription; one coverage record per binding; `allServedEqualNativeMax: null` when unclaimable; the stale comment removed from code, tests, artifact and report |
| C4.4 | Role temporal tests that never reached the temporal gate, and a regex-presence test standing in for the overwrite branch | An injected `supportedResolverVersions` seam defaulting to the empty product constant, with all four branches proven behaviourally |
| C4.5 | Claimability that ignored the identity read and coverage matrices with no exact key audit | Identity cells inside coverage; exact expected-key audits (missing / duplicate / unexpected) for config, unit, canonical and served-date; separate `semanticCountsClaimable` and `identityManifestComplete`; a `verify`-time reconciliation of ledger, coverage and analysis claims |
| C4.6 | "Correction 2" header; a stale canonical-selection comment; "every owner resolution returns `blocked_owner_schema_contract`"; an unbounded-minimum reading of `clockAdsetConfig`; date-only `retrievedAt` presented as a timestamp; `receiptHash` over self-authored metadata | Correct header; the constant described as the native-table diagnostic only; exact status/outcome vocabulary; the bounded clock described as bounded; `retrievedAtPrecision: date_only`; `claimMetadataHash` |

---

## 21. Correction 3 ledger

| | Withdrawn | Replaced by |
|---|---|---|
| C3.1 | A static ledger entry restating a run-specific count that contradicted the analysis | Count-free ledger text plus `D080_LEDGER_DERIVED_KEYS`; a test fails if a count-free entry reintroduces a number |
| C3.2 | The grouped `MAX()` transition model and its "63 ad-set true changes" | Explicit state classes with `both_fields_present` unresolved; deterministic `(effective_from, captured_at, id)` ordering; fingerprint identity; SQL-side aggregation; **11 + 12 = 23** clean |
| C3.3 | Config counts presented without a knowledge-time bound | Two named layers; 9,610 campaign and 40,564 ad-set captures arrive after cutoff and are excluded from the PIT layer |
| C3.4 | "Every query is bounded" and "every artifact row is scanned" | Query manifest (28 entries, iterated in full) and invariant registry (46 sections, 0 unhandled, 8 named exceptions) |
| C3.5 | Ledger grain recorded as the query name | Real grain and real source table on every ledger and fallback row |
| C3.6 | "campaign/lifetime yields no comparable rows" | Fourth query added; 28-cell coverage matrix distinguishing rows / zero rows / unknown |
| C3.7 | "Both readers take native MAX(as_of_date)" | Two contracts described accurately; three candidates reproduced; one binding proven divergent; census renamed `scannedHistoricalSnapshotRows` |
| C3.8 | Role authority that could admit a mutable snapshot as historical authority | Source temporal status; account in the selection key; in-window (2,318) and full-history (2,350) scopes labelled separately |
| C3.9 | "No write of any kind"; "no environment mutation"; "confirmed continuously"; a duplicated line | Precise statements of what was written and what the loader did; heartbeat described as repeated confirmation through a date, not uninterrupted continuity |
| C3.10 | Blanket `VERIFIED` alongside a byte-verification caveat | Per-claim receipts with distinct statuses carrying the limitation |

---

## 22. Nothing was started

D080B implementation has **not** begun. No migration, route, provider call, live
budget or status change, schema or environment mutation, no automation
activation, and no manual Test/Main/Mixed label source read or restored.
Automation is OFF. Submitted for independent reconciliation, not self-accepted.
