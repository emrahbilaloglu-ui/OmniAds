# D075 state-history consumer sweep — complete census and verdicts (2026-08-30)

Closes the assurance gap D075 recorded as INCOMPLETE (the independent
reviewer stopped before reporting; its partial sweep was never counted as
evidence). This artifact is the completed census: every current-worktree
reference to `meta_entity_state_history`, its active call paths, and a
SAFE / UNSAFE / NOT-A-CONTENT-CONSUMER verdict with executable proof.
Guard: `lib/meta/__tests__/state-history-consumer-closure.test.ts` pins the
per-file reference counts and every fix's predicates; a new or moved
reference fails the guard until classified here.

Census (fresh `rg`, this worktree): 41 `.ts` files reference the table —
8 content readers, 1 writer, 1 DDL, 2 size-only, 2 compaction (D077),
4 comment-only, 1 frozen-offline, 1 operational verifier, 7 harness seams,
14 test files. Non-code references (docs, runbooks, one CI workflow, one
ops shell script) are inventoried at the end. Automation OFF; production
untouched; D075 remains local/undeployed — nothing here claims deployed
behavior.

## Verdict matrix — content readers

### 1. `lib/creative-decision-engine/data-source.ts` — SAFE (pre-verified, re-confirmed)

- Symbols: hydration receipt query (`member_states` CTE),
  `READ_AD_ENTITY_STATE_AS_OF_QUERY`, `READ_PRESENT_AD_STATE_SEEDS_QUERY`.
- Callers: `hydrateAdDecisionInputs` → ad decisions job (native V3 path).
- Grain: ad. Lanes: complete (manifest reconstruction) + as-of readers over
  complete/partial/point_lookup. Needs a reconstructed complete manifest:
  YES — and implements it (legacy/full run-bound; delta = latest
  complete-lane row per entity ≤ the run's payload capture clock,
  endpoint-scoped, present winners only). `manifest_kind` handling explicit
  (`IS DISTINCT FROM 'delta'` / `= 'delta'` arms). Scope: business +
  account + endpoint. Clock: payload capture clock; capture floor dropped
  for delta receipts (carried members live in older runs). Presence:
  absent winner = absence evidence, never `DELETED` (explicit tombstones
  only carry `DELETED`); non-present winner for an expected member fails
  the count guard closed. Zero-row delta checkpoints admitted as complete.
- Proof: D14a–D14n + D15 seam legs; native-ad decision seam `D075 PASS
  delta hydration`; `data-source.ad-grain.test`.

### 2. `lib/meta/decisions-workspace-read-model.ts` — was UNSAFE → FIXED

- Symbols: three per-grain `LEFT JOIN LATERAL` latest-row status lookups in
  the native-identity query, three in the creative-grain query.
- Callers: decisions-workspace route → Decision Center/workspace UI.
- Grain: campaign/adset/ad. Lanes: all (per-identity latest — acceptable
  for a current-status lookup; no manifest reconstruction needed). Ordering
  `observed_at DESC, captured_at DESC, id DESC` — a newer absent row wins
  over older present rows (no resurrection ✓).
- **Defect (confirmed)**: a winning `absent_unconfirmed` was served as
  provider status `'DELETED'` — fabricated provider state, violating the
  ADR's "absence is evidence, never DELETED". Downstream, `'DELETED'` is a
  real archive/exclude token (briefing archive filter, history exclusion
  lists), so every post-deploy scope exit would have been displayed and
  filtered as a deleted entity. The creative-grain variant would
  additionally have been wrong the other way if "fixed" naively: falling
  back to the dimension status would resurrect a pre-exit state.
- **Fix**: all six CASE arms serve `NULL` (status unknown) for any
  non-present winner; delivery gating maps NULL to `unknown`, not
  `inactive`. Proof: seam leg D15b (absent winner projects NULL, re-entry
  restores PAUSED, on real PG); SQL pins in
  `decisions-workspace-read-model.test.ts` (`not.toContain("ELSE
  'DELETED'")`) and the closure guard.

### 3. `lib/meta/history-read-model.ts` (+ `history-contract.ts`) — was UNSAFE → FIXED

- Symbol: the `meta_entity_state_history` arm of the History feed
  (external status changes), with a prior-row lateral.
- Callers: history route → History UI. Grain: all four entity types.
  Lanes: all (event-stream read — valid under delta manifests, which write
  exactly on change). Backwards clocks: ordered by `observed_at`; the
  prior-row lateral takes the latest earlier observation.
- **Defect (confirmed)**: presence-blind transitions. A scope-exit
  (`absent_unconfirmed`, NULL statuses) row satisfied
  `prior.configured_status IS DISTINCT FROM entity_state.configured_status`
  and was published as an entity "status changed" History entry — every
  scope exit (and the one-time exit backfill of a scope's first delta run,
  measured ≤35 rows/scope) would fabricate change entries. Symmetrically, a
  re-entry's real status change was masked (prior row = absent → NULL →
  filtered).
- **Fix**: transitions are computed over `presence = 'present'` rows on
  both sides. Absence rows publish nothing; a change spanning absence
  (ACTIVE → absent → PAUSED) is reported once. Proof: seam leg D15c on
  real PG (exactly one transition; exits fabricate none); byte pins in the
  closure guard.

### 4. `lib/creative-decision-engine/jobs/ad-operator-response-job.ts` + `ad-operator-response-detection.ts` — was UNSAFE → FIXED

- Symbols: `FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY` (targets →
  truth_events → baseline / post_recommendation / terminal_confirmation),
  detection (`terminalTruth`, coverage proof). 17 of the job's references
  are DDL/journal constants, the evidence-kind enum, and FK definitions;
  the single content read is the truth-events query.
- Callers: scheduled operator-response job (native V3). Grain:
  ad/adset/campaign point reads per episode target, cutoff-capped. Lanes:
  all selected; detection's completeness proof requires
  complete/point_lookup + presence present (absence can never fabricate a
  status, a DELETED, or a treatment — verified).
- **Defect (confirmed)**: the terminal-confirmation contract requires a
  row whose clocks SPAN window end (`observed_at ≤ window_end ≤
  captured_at` — the unit fixtures encode day-long spans), but the writer
  never advances a state row's `captured_at`: the same-completeness
  heartbeat bumps only the RUN's `last_captured_at`, and a delta manifest
  writes nothing for unchanged entities. An unchanged entity could
  therefore never certify window-end truth — `no_response` (the class the
  detector exists for) degraded to permanently `unknown_incomplete`
  (fail-closed, but purpose-defeating).
- **Fix**: the state arm now computes `confirmed_until` — the
  as-of-cutoff re-confirmation clock:
  `GREATEST(captured_at, own-run last_captured_at, scope confirmation)`,
  where the scope confirmation is the latest same-endpoint **delta**
  complete run at or after the row (each delta re-observed the whole scope)
  and applies only while the row is still the entity's complete-lane winner
  (a superseded row gains nothing); every input is capped at the target
  cutoff (a heartbeat past cutoff is excluded — its as-of-cutoff value is
  unknowable from the overwritten column). `terminal_confirmation` and
  detection's `terminalTruth` filter on `confirmed_until`; baseline and
  post-recommendation arms still use the raw clocks (an extension must not
  eject a row from the baseline). The source-proof contract is bumped to
  `engine-v3-native-ad-operator-source-proof.v3` with `confirmedUntil` in
  the hashed evidence entries.
- Proof: detection regression (fails on pre-fix code: unchanged-entity
  shape → `no_response_observed`); seam leg D15a on real PG (heartbeat
  confirmation, delta-run confirmation for the unchanged winner, no
  extension for a superseded row, pre-heartbeat cutoff caps at first
  capture); byte pins in the closure guard.

### 5. `lib/creative-decision-engine/jobs/ad-decision-outcomes-job.ts` — SAFE

- Symbols: two per-ad point-read arms (state at window start; states in
  window), lanes filtered to complete/point_lookup, cutoff-capped both
  clocks, plus a schema-capability column list.
- Callers: decision-outcomes job. Purpose: prove non-delivery/delivery for
  outcome attribution. As-of semantics (latest at/before window start) are
  correct under delta manifests: an unchanged ad's older row remains true;
  any status change writes a row. An `absent_unconfirmed` winner carries
  NULL statuses → `isNonDeliveringStatus` false and `isDeliverableStatus`
  false → absence claims nothing in either direction (fail-closed;
  evidence degrades to less-definitive, never fabricates). `DELETED` in
  its status list refers to provider statuses, not absence. No manifest
  reconstruction needed. Verdict: SAFE.

### 6. `lib/api/meta.ts` — SAFE

- Symbols: two `readMetaEntityStatesAsOf` recovery calls (adset, campaign)
  that backfill statuses missing from config responses; one comment.
- Both callers guard `if (state.presence !== "present") continue;`
  (pinned by the closure guard), and D075 exit rows carry NULL statuses as
  a second belt. Generic as-of winner semantics via the central helper —
  a newer absent row shadows older present rows. Verdict: SAFE.

### 7. Central helpers — `lib/meta/entity-state-history.ts` — WRITER + central-helper

- The D075 writer (verified by D14a–D14n) plus `readMetaEntityStatesAsOf`
  / `readMetaEntityTombstonesAsOf` / `readMetaEntityTruthAsOf`:
  `DISTINCT ON (entity_id) … ORDER BY observed_at DESC, captured_at DESC`
  over complete/partial/point_lookup with both clocks cutoff-capped. The
  helper RETURNS the winner including `presence`; treating an absent
  winner as absence is the caller's contract (both active callers verified
  above; seam D14 legs prove the ordering, cutoff, and account isolation).

### 8. `scripts/creative-decision-center/native-ad-natural-wave-operational-verifier.ts` — was UNSAFE → FIXED

- Symbol: `SOURCE_RUNS_SQL` (now exported for the seam) — recomputes each
  source run's persisted membership and requires
  `expected === persisted === receipt counts`.
- **Defect (confirmed)**: membership was counted run-bound
  (`state.run_id = run.id`), so every delta run (1 physical row vs logical
  `row_count`) would be flagged `hydration_receipt_proof_invalid` — false
  operational blockers for exactly the runs D075 makes normal.
- **Fix**: kind-aware membership mirroring the receipt: legacy/full stays
  run-bound; delta counts the reconstructed complete lane (endpoint-scoped
  latest-per-entity ≤ the run's capture clock, present winners). Proof:
  seam leg D15d on real PG (full 2/2 AND delta 2/2 where run-bound would
  be 1); byte pins in the closure guard.

## NOT-A-CONTENT-CONSUMER references (assumptions stated)

- `lib/migrations.ts` — DDL (additive columns, CHECKs, indexes).
- `lib/sync/db-growth-fence.ts`, `lib/sync/state-history-effective-size.ts`
  — size-only (`pg_total_relation_size`, `pgstattuple_approx`); assumption:
  byte budgets are content-independent; fail-closed to raw size (D077
  record).
- `lib/meta/state-history-compaction.ts` + `-executor.ts` — D077
- `scripts/audits/d078-six-business-evidence-bundle.ts` — size-only (one `pg_total_relation_size` literal in the D078 frozen evidence census; no content read)
- `scripts/audits/d077-production-recovery-readonly-preflight.ts` — size-only (11 literals: relation size/stat/index probes, information_schema/to_regclass presence checks, and the global MAX(captured_at)/MAX(created_at) admission clock, all inside one REPEATABLE READ READ ONLY transaction ended by ROLLBACK; reads no row content and writes nothing)
- `scripts/audits/d077-correction1-artifact-generator.ts` — size-only (4 literals inside emitted packet TEXT: the A5 vacuum command shape and executor-description prose; the generator executes no SQL) (D077 correction 3 raised the planner to 10 literal references: the strict count-parser refusal label "live_rows census of meta_entity_state_history" names the table in a diagnostic string; no new reader)
  planner/executor: reads counts, run-bound row sets, and
  interleaved-partial existence to plan deletions. Classified, NOT changed
  in the D075 package (charter boundary; the 2026-08-30 D077 hardening
  later split the pin-family EXISTS fragments per reason and added the
  measured multi-endpoint exclusion count — reference count 6→9, same
  category — and extended the compaction seam child, 5→8). Stated assumption it must keep
  honoring: delta-run baselines live in OLDER runs — its interleaved/
  exclusion rules and the D077 seam already encode this; any future
  compaction change must re-prove against delta reconstruction.
- `lib/meta/briefing-filter.ts`, `lib/meta/current-evidence-gate.ts`,
  `lib/sync/staged-worker-predicate.ts`, `lib/sync/worker-runtime.ts` —
  comment-only.
- `scripts/creative-decision-center/h11b-context-lifecycle-bundle.ts` —
  frozen-offline SELECT (H11B bundle): complete-lane, presence-filtered
  per-day signatures; artifact frozen by hash; event-stream semantics
  remain valid under delta manifests (rows on change).
- Harness seams (7 files) — real-Postgres test fixtures/DDL.
- Test files (14) — fixtures and SQL pins; updated where they pinned the
  pre-fix behavior (workspace `IS NULL THEN NULL` pin → present-only +
  no-DELETED pin).
- Non-`.ts`: `deploy/db/adsecute-table-fingerprint-runner.sh` (read-only
  ops fingerprint of the physical table; content-agnostic),
  `.github/workflows/zero-base-production-rollout.yml` + runbooks/docs —
  documentation/ops references, no reader semantics.

## Adversarial fixture coverage (charter checklist)

- legacy full → delta with unchanged members in older runs: D14c/D14m,
  D15a/D15d, native seam delta-hydration leg.
- zero-row delta checkpoint as a complete generation: D14 (forced
  checkpoint), receipt compaction-guard admission.
- scope exit shadowing older present rows: D14d, D15b (projection), as-of
  readers.
- re-entry restoring presence: D14e, D15b/D15c.
- failed/partial/point_lookup outside reconstruction: D14 lanes legs;
  receipt/verifier reconstruction filters pinned to `complete`.
- sibling endpoint + account isolation: D14 isolation legs; every fixed
  query is endpoint- and account-scoped (byte-pinned predicates).
- backwards/replayed clocks + deterministic cutoffs: D14 replay legs;
  D15a cutoff capping; outcomes/operator reads cap both clocks.
- absence never `DELETED`: D15b + workspace pins; detection/outcomes
  presence guards; only explicit tombstones map to `DELETED`.
- complete receipt/count mismatch fails closed: receipt bar per kind
  (data-source), verifier equality now kind-aware.

## Acceptance correction 1 (2026-08-30, same day)

Independent Codex acceptance REJECTED the initial sweep package on three
confirmed gaps; all are fixed with fail-first evidence:

- **Broad-sweep overstatement (withdrawn):** the sweep's "broad battery"
  ran `__tests__` directories plus selected root files, missing root-level
  `lib/meta/*.test.ts`. The exact
  `npx vitest run lib/creative-decision-engine lib/meta --maxWorkers=1`
  discovered one stale failure (`decision-semantics.test.ts` still
  asserting the removed "No label is required" copy). The test now pins the
  system-owned automatic-role copy and forbids label/correction vocabulary;
  the exact broad command's final totals are recorded in DECISION_LOG.
- **Heartbeat replay regression (gap B):** the early semantic-coalescing
  UPDATE assigned `last_seen_at`/`last_captured_at` from the incoming
  clocks unguarded, so an accepted older exact replay (H2) moved the
  heartbeat backward — erasing established `confirmed_until` evidence and
  demoting a proven `no_response` to `unknown_incomplete`. Fail-first: seam
  leg D15e failed on the rejected code (clocks regressed T4→T3). Fix: both
  clocks are GREATEST-guarded exactly like the `ON CONFLICT (run_hash)`
  branch; D15e proves advance → replay → clocks and confirmation intact,
  `last_captured_at ≥ last_seen_at`.
- **Winner/scope closure (adjudicated):** the anti-supersession predicate
  checked only `newer.captured_at > state.captured_at`. Adjudication: the
  D075 complete-lane winner is deterministic on
  `captured_at DESC, created_at DESC, id DESC` and its authority scope is
  the ENDPOINT (the writer's diff scope and the reader's reconstruction
  scope). Fail-first: D15f failed on the rejected predicate (both
  equal-captured rows received the delta confirmation — asserted per row
  through the exported production fragment
  `AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL`, since the outer query's
  DISTINCT ON hides the losing row); D15g failed on the rejected predicate
  (a later sibling-endpoint row superseded E1's winner and blocked its
  legitimate confirmation). Fix: supersession uses the exact tuple order
  `(captured_at, created_at, id)` and is endpoint-scoped through the
  superseding row's own run; the closure guard byte-pins the tuple
  comparison, the endpoint join, and the absence of the old
  captured-at-only check.

## Epistemic state

- The former "[fact — review incomplete]" label is superseded: this sweep
  inventories every current-worktree reference with a verdict and proof.
- Four confirmed consumer defects were found and fixed (workspace
  DELETED fabrication; history-feed absence transitions; operator-response
  window-end confirmation; verifier run-bound counts). Every fix carries a
  regression that failed on the pre-fix code (detection unit test; seam
  legs structurally impossible pre-fix — `confirmed_until` did not exist,
  the verifier counted 1, the CASE served DELETED, the feed fabricated a
  transition).
- Production remains untouched and undeployed: realized write mix, warm
  plan costs, and post-deploy amplification are unknown until a release
  carries D075 (unchanged from the D075 record). The operator-response
  source-proof contract is now v3; no persisted v2 proofs exist outside
  local/test environments.

---

## D083 addendum (2026-09-01) — read-only audit consumers

The consumer-closure guard classifies every literal reference to
`meta_entity_state_history`. Five read-only audit references are classified as
`read-only-audit` and one as `comment-only`. None of them reads at runtime, none
writes, and none is reachable from a served route:

| file | references | why |
|---|---|---|
| `scripts/audits/d080-meta-budget-edit-evidence.ts` | 21 | D080A evidence extractor, SELECT only. Was unregistered before D083. |
| `scripts/audits/d080b-meta-budget-policy-simulation.ts` | 6 | D080B simulation extractor, SELECT only. Was unregistered before D083. |
| `scripts/audits/d083-meta-budget-fact-observation.ts` | 7 | D083 budget-fact extractor, SELECT only. |
| `scripts/audits/d083-meta-budget-fact-observation.test.ts` | 2 | its fixtures. |
| `lib/meta/budget-fact.ts` | 1 | a doc comment naming the vocabulary source; the module contains no SQL. |

`lib/migrations.ts` moves 22 → 28 and `scripts/ephemeral-postgres-migrations-check.ts`
11 → 17 for the six additive D083 columns and the six matching from-zero
assertions.

### D083 C2 addendum (2026-09-01)

`lib/migrations.ts` moves 28 → 29 and `scripts/ephemeral-postgres-migrations-check.ts`
17 → 18 for the additive `provider_api_version` column and its from-zero
assertion. `scripts/ephemeral-postgres-entity-state-history-seam-child.ts` moves
16 → 17 for the D16 round-trip read, and
`scripts/ephemeral-postgres-schema-upgrade-seam.ts` gains one reference (0 → 1)
for the D083 pre-change rewind that makes the upgrade seam a real upgrade rather
than a no-op. All are harness or DDL references; none reads at runtime.


### D083 C4 addendum (2026-09-01)

`scripts/ephemeral-postgres-entity-state-history-seam-child.ts` moves 17 → 23.
The D17 seam that proves the point-in-time statement returns the exact winner
set adds six literal references: the seeded-history read, the retained control
that re-runs the rejected Correction 3 reduction, and the bi-temporal
`CHECK (captured_at >= observed_at)` assertion that makes the reduction's other
loss class unreachable. All are harness reads inside an ephemeral database;
none reads production at runtime, and no runtime consumer changed.

## Acceptance correction (2026-09-02) — D086 correction 7 adds four references

D086's readiness read previously consumed `meta_campaign_config_history` /
`meta_adset_config_history`. Correction 7 rejected that: the only writer of those
tables records TRANSITIONS and never stamps the `source_run_id` the readiness
attestation requires, so no retained row could ever attest. The read now consumes
`meta_entity_state_history` — the rows the real capture path actually writes.

### 9. `lib/meta/budget-readiness-read-model.ts` — SAFE (content reader)

- **Scope.** `D086_STATE_BUDGET_SQL` filters on `business_id`, `provider_account_id`
  and `entity_type IN ('campaign','adset')`, and bounds every row by
  `captured_at <= $3::timestamptz`. It selects `business_id` and
  `provider_account_id` back out so the canonical scope validation can refuse a
  row that is not this account's, rather than trusting the WHERE clause alone.
- **Latest per identity.** `rank()` over `(captured_at DESC, created_at DESC,
  id DESC)` per `(grain, entity_id)`, with a grouped `distinct_truths` aggregate
  so an equal-clock disagreement is reported as a conflict instead of being
  silently adjudicated.
- **No independent authority.** Every budget judgment — owner, raw amount,
  currency, exponent, schedule, provenance — comes from D083's
  `buildCanonicalBudgetFact`, reached through the shared projector
  `lib/meta/budget-observation-projection.ts`. D086 translates `fact.ownerGrain`
  into its universe vocabulary and reports `fact.blockers` verbatim.
- **Membership is not read from this table alone.** The attested universe comes
  from `meta_entity_observation_receipts` joined to `meta_entity_observation_runs`,
  with membership reconstructed over this table and explicit deletions excluded
  by `meta_entity_tombstones`.

### 10. `lib/meta/budget-readiness-retention.ts` — NOT A CONTENT CONSUMER

Names the table twice: once in `D086_REQUIRED_STATE_COLUMNS` (the capability
contract) and once in the capability probe, which reads
`information_schema.columns`. Neither statement reads a row of content.

### 11. The D086 audit script and its test — NOT CONTENT CONSUMERS

`scripts/audits/d086-budget-readiness-input-pack.ts` names the table only in the
list of queries the local seam executed, which is reporting. Its test names it in
the fake-database router and in fixtures; it never opens a database.

### `lib/migrations.ts` 29 → 30

One additive statement: `budget_shape_support`, the captured budget shape. D083
refuses a fact whose shape support is unknown, and nothing captured it — so every
retained fact failed that gate by omission rather than by evidence. The column is
`IF NOT EXISTS` and CHECK-constrained to the canonical vocabulary.

## Acceptance correction (2026-09-02, second) — D086 correction 8

Correction 8 changed what the D086 readiness read does with this table and
added two local-seam consumers. The reference counts move as follows.

### `lib/meta/budget-readiness-read-model.ts` 3 → 4 — still SAFE

The extra reference is the delta-membership scope guard: a delta manifest
reconstructs latest-per-entity over the complete lane, and the base-chain lookup
names the table a second time. The read is unchanged in kind — account-scoped,
grain-scoped, cutoff-bounded — and gained two corrections:

- **The current inventory only.** `latest` now filters `presence = 'present'`.
  An entity whose latest word is an absence has left scope; counting it made a
  real scope exit look like a reconciliation failure.
- **The population is the identity count.** `count(*) OVER ()` moved after
  `clock_rank = 1`, so it counts current identities rather than every historical
  row this account ever wrote.

### `lib/meta/budget-readiness-retention.ts` 2 → 5 — NOT A CONTENT CONSUMER

`D086_REQUIRED_STATE_COLUMNS` grew to cover every D083 field the executed
statement selects, and two prepared statements now name the table: the
latest-path index and its catalog contract. No statement here reads a row.

### `lib/migrations.ts` 30 → 32

`idx_meta_entity_state_history_d086_latest` — the latest path reads the most
rows of any readiness statement and had no index at all — and the catalog
contract that validates it. Both `IF NOT EXISTS`.

### `scripts/d086-capture-to-readiness-child.ts` (new, 3) and the seam wrapper (1)

The capture-to-readiness seam boots its own ephemeral cluster, applies the real
migration registry, and drives the real writers. It names the table where it
asserts what the writer actually stored — the delta's physical state count, the
tombstone's effect, and the changed-row hashes. It opens no production handle;
the parent refuses to run unless `DATABASE_URL` is the cluster it just created.

## Addendum — 2026-09-03 pre-deploy audit (D087/D088 budget slice)

Five files joined the closure while the D077–D088 release candidate was
assembled. Classified here and in
`lib/meta/__tests__/state-history-consumer-closure.test.ts`.

### `lib/meta/budget-proposal-server-readers.ts` (new, 1) — CONTENT READER

One statement, inside `readMeasuredBudgetHistory`. It reconstructs the
owner-deduplicated retained budget population for the prospective account
concentration a budget write is checked against.

It satisfies the D075 serving corollaries:

- **latest-per-entity** — `DISTINCT ON (entity_type, entity_id) … ORDER BY
  entity_type, entity_id, captured_at DESC, created_at DESC, id DESC`, the
  exact deterministic winner order;
- **absence-aware** — `WHERE presence = 'present'`, so an entity whose winning
  row is `absent_unconfirmed` is excluded as absence, never resurrected from an
  older `present` row;
- **cutoff-bounded** — `captured_at <= now()`;
- **fail-closed** — the helper returns `null` (not zero) when the owner
  population is empty, any owner row is unpriced, the total is not positive, or
  either read fails. Unknown blocks the write.

It serves no entity content to a surface: it sums owned budget amounts and
returns three scalars.

### `lib/meta/budget-write-safety-projection.ts` (new, 1) — COMMENT-ONLY

The table name appears only inside a provenance STRING recording which tables a
measured policy flag was read from. The module issues no query and imports no
database handle.

### `scripts/ephemeral-postgres-migrations-check.ts` 18 → 19 — HARNESS

`budget_shape_support` joined the D083 required-column list. It is read by
production SQL (`budget-readiness-read-model.ts`) and was previously in neither
schema gate, so a database missing that one `ALTER` reported green and failed at
runtime as a broken readiness read.

### Three test files (1 each) — TEST

`lib/meta/budget-production-path.c3.test.ts`,
`lib/meta/budget-no-fabricated-defaults.test.ts` and
`app/api/meta/automation/proposals/budget-execution-paths.c3.test.ts` name the
table in fixtures and in a static assertion about the concentration
denominator. No production read.

## Addendum — 2026-09-03 gate job (growth-fence provider-family slice)

`lib/sync/db-growth-fence.test.ts` 11 → 18 — TEST

Seven more literal references joined the collateral-admission slice added to
prove the provider-family fix: `installMetaTableOverBudget()` (a fixture that
overrides `meta_entity_state_history`'s measured size to reproduce the exact
2026-08-08/2026-09-03 40,960-byte overage) plus the four tests that depend on
it (the `it.each` collateral-admission cases, the same-provider-still-refused
case, the unknown-label-still-refused case, and the old-ambiguous-label-still-
refused case). All are fixture data or assertion strings; none open a query or
a database handle.
