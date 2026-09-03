# D077 state-history compaction — hardening acceptance record (2026-08-30)

One bounded correction closing every confirmed D077 hardening gap
(retrospective audit P1-1, P1-4, P2-1, and overstatement items 2–4).
Everything below is **local implementation + ephemeral real-Postgres
verification only**: no production compaction planner or executor was run,
no extension was installed in production, no production database was read
or mutated for this package, nothing was deployed, committed, pushed,
scheduled, or activated, no provider state changed, and no environment
flag changed. `META_AUTOMATION_ENABLED`,
`CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION`, and
`STATE_HISTORY_COMPACTION_ABORT` are unset. Compaction remains
CLI-execute-only, unreachable from app runtime (static guard re-run
green), never scheduled, UI display-only.

Skill gate: bridge `/Users/harmelek/.claude/skills/emb-media-buyer/SKILL.md`
sha256 `03a0790396b65596d4a9de7df223a900374a89319ffad924fbbe5ad29b57d88b`
(verified thin bridge pointing at the canonical package); canonical
`/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md` sha256
`985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187` (read
completely from disk; differing hashes are the intended bridge design).

## A. Snapshot-consistent planner — CLOSED [fact]

- Fail-first (ephemeral seam, run archived): the planner accepted a READ
  COMMITTED READ ONLY transaction — the new refusal assertion failed on
  the rejected code.
- Fix: the CLI plan transaction is `SET TRANSACTION ISOLATION LEVEL
  REPEATABLE READ READ ONLY` before any planner read (bounded statement
  timeout retained); the planner independently checks
  `transaction_read_only = on` AND `transaction_isolation` ∈
  {repeatable read, serializable} and refuses otherwise.
- Real-PG proof: with a second live session committing a new complete run
  between the planner transaction's statements, the produced plan's scope
  fingerprint equals the fingerprint read at transaction start — the
  concurrent commit is invisible; no multi-statement mixed-snapshot
  artifact is possible under the enforced isolation. (Deterministic
  two-session seam, not a source-text grep.)

## B. Forgeable readiness/policy gate — CLOSED [fact]

- Fail-first (archived log `d077-failfirst-1d.log`): an
  insufficient-evidence plan edited to `status: "ready"`,
  `insufficiencyReasons: []`, and a fabricated
  `effectiveReusableHeap.cleared: true`, with the public hash and token
  HONESTLY recomputed, executed on the rejected code to
  `{"status":"completed", "rowsDeleted":2}` — journal rows written, state
  rows deleted, insufficiency laundered.
- Fix: before lease acquisition or ANY journal insert, the executor
  re-derives the authoritative current plan from the database in one
  REPEATABLE READ READ ONLY transaction using the production planner
  (`planStateHistoryCompaction`), and requires the incoming canonical
  execution payload to match the authoritative result exactly (the
  canonical hash binds business scope, scopes and removable run sets, all
  protection counts, timelines, scope fingerprint, current raw/effective
  fence measurement, reclaim projection, insufficiency reasons, and final
  status — incoming arithmetic and clearance flags are never trusted).
  Typed zero-write refusals: `authoritative_replan_mismatch`,
  `authoritative_replan_not_ready:<status>`,
  `authoritative_replan_failed:<detail>`.
- Resume rule (explicit): the equality gate binds a plan's FIRST admission
  (the admission writes the `planned` journal row). A resume of an
  admitted, uncompleted plan skips only the equality check — its own
  earlier batches legitimately changed the world — and keeps the lease
  exclusivity, scope-fingerprint staleness check, per-batch full
  revalidation, and completed-plan block. A forged plan can never reach
  the resume path: its first admission refuses before any journal row
  exists for its hash.
- Post-fix real-PG proof: the same forged payload now refuses with zero
  journal rows and zero deletions; foreign-run injection and stale plans
  refuse the same way (previously they journaled lease/refusal rows before
  rolling back). Existing invalid-token / tampered-payload /
  missing-acknowledgement zero-write guarantees re-proven unchanged. The
  in-batch scope/count/signature/predecessor/non-head/pin/interleave
  revalidation and the final timeline proof are retained in full — the
  policy proof is additional.
- Comment/docs corrected: the approval token binds explicit operator
  acknowledgement to an exact current planner artifact; it is NOT
  cryptographic provenance/authenticity. The executor header's foreign-run
  zero-write claim is now actually true and stated as such.

## C. Protected counts by reason — DELIVERED [fact]

- Plan scopes and totals now expose hash-bound `protectionsByReason`:
  `headDuplicate` (non-head rule), `liveLineagePinned`,
  `archivedLineagePinned` (`adsecute_compact_20260726t0204z`),
  `responseEventPinned`, `interleavedExcluded`; multi-endpoint exclusion
  remains the explicit scope flag. Pin families may OVERLAP (one run
  pinned by several families is counted in each family); the union stays
  `pinnedRuns`/`pinnedRunRows` and per-family values are never additive —
  serialization states this and the planner fail-closes on internal count
  inconsistency (union > family sum, union < family max, exclusion
  mirrors, candidate reconciliation). Removable rows are never derived by
  row-level pin subtraction.
- Real-PG proof distinguishes every family independently: live-lineage
  pins (2 runs), archived-schema pin (1 run, seeded retained schema with
  the production column shape), response-event pins (2 runs through the
  full episode chain), one run pinned by BOTH live and response families
  (union counts it once: pinned 4 ≠ 2+1+2), a head duplicate (1 run,
  counted, not a candidate), and the pre-existing interleave and
  multi-endpoint fixtures. Fail-first: the assertion that
  `protectionsByReason` exists failed on the rejected plan shape.

## D. Response-event FK seam proof — DELIVERED [fact]

- The seam seeds the minimal legitimate chain: `engine_v3_job_runs` →
  `engine_v3_ad_decision_evaluation_contexts` →
  `engine_v3_ad_decision_evaluations` →
  `engine_v3_ad_decision_snapshots_daily` (authority CHECK satisfied) →
  `engine_v3_ad_recommendation_episodes` →
  `engine_v3_ad_operator_response_events` rows referencing candidate
  state-history rows.
- Proven: the planner attributes those runs specifically to the
  response-event family and protects each WHOLE run; a response-event pin
  arriving AFTER planning refuses before any write
  (`authoritative_replan_mismatch`, zero journal rows, pinned run keeps
  every row — no partial deletion; the RESTRICT FK remains fail-loud
  defense-in-depth and is never exercised); a fresh plan reclassifies the
  late-pinned run as response-event-pinned with nothing removable
  (`nothing_to_do`). The ADR's "shape guard only / no dedicated fixture"
  residual is removed on this executable proof.

## E. Readiness: business-scoped, measured, real UI — DELIVERED [fact]

- Read model extracted to the server-owned helper
  `lib/meta/state-history-compaction-readiness.ts` (contract
  `d077.state-history-compaction-readiness.v2`), consumed by the admin
  readiness route and the business Automation page. Display-only: no
  token, no executable plan, no mutation affordance (isolation guard
  byte-pins this).
- Journal read is business-scoped via `$1 = ANY(business_ids)` with the
  canonical business id as a SQL parameter — multi-business plans
  containing the business match; the global latest-five is gone
  (cross-business leakage tested).
- The unconditional `d075_delta_manifests_not_deployed` assertion is
  REMOVED. D075 writer evidence is measured server-side from
  `manifest_kind` presence: `observed` / `not_observed` (absence of
  evidence — explicitly NOT a deployment claim, never converted to ready)
  / `unknown` (measurement failed). Each maps to an honest blocker or its
  absence.
- UI: the business-scoped Automation page (`/c/[businessId]/meta/
  automation`) renders a `StateHistoryRecoverySection` on BOTH the desktop
  and mobile surfaces: governing fence metric with raw/effective/budget
  bytes and breach state (or "unavailable"), business-scoped
  approval/journal state, planned reclaim as honestly unknown (no operator
  artifact), measured D075 evidence state, and all blockers. No readiness
  computation client-side, no zeros/green fabrication, no
  planner/executor invocation, no tokens, no compaction/extension/shrink/
  automation buttons; a failed read renders "Readiness read unavailable".
  Viewer/write-authority gates untouched.

## Verification (exact commands and results)

- Fail-first harness runs (archived in the session scratchpad):
  `d077-failfirst-1d.log` — forged plan `completed`, `rowsDeleted: 2`
  (gap B); `d077-failfirst-2.log` — planner accepted READ COMMITTED
  (gap A); `d077-failfirst-3b.log` — `protectionsByReason` absent
  (gap C). Each subsequent run moved the failure to the next gap,
  proving each regression fails on the exact rejected code.
- `npm run test:migrations-from-zero` (final): **green end-to-end, 31
  PASS banners, exit 0**; the D077 compaction seam banner enumerates the
  hardening legs (forged-plan zero-write refusal, isolation refusal +
  snapshot stability, per-family counts with non-additive union,
  response-event chain, late-pin refusal).
- Focused suites (`--maxWorkers=1`): compaction isolation guard 6/6
  (extended: RR pins, helper/view no-executor/no-token pins,
  business-scope pin, measured-evidence pin); readiness helper 6/6;
  recovery section 5/5 (incl. desktop+mobile parity and
  no-mutation-affordance); business Automation page 11/11 (prop
  pass-through, business-scoped read, failure→null→unavailable); admin
  readiness route 10/10 (business-scoped section, no token, measured
  evidence).
- `npx vitest run lib/meta --maxWorkers=1`, `npx tsc --noEmit`, focused
  ESLint on every changed file, `git diff --check`: results recorded in
  the final package report (all green at completion).

## Epistemic labels

- Facts: every fail-first log line and seam assertion above; the hash
  binding (scopes/totals are hashed wholesale, so `protectionsByReason`
  is hash-bound by construction).
- Inference: the resume rule's soundness argument (a forged hash can
  never acquire a `planned` journal row) — enforced by ordering, proven
  by the seam's zero-journal assertions.
- Assumption: ephemeral Postgres (homebrew, pgstattuple available)
  faithfully represents production Postgres semantics for isolation,
  FKs, and DELETE behavior.
- Unknown / not claimed: production readiness, actual fence clearance,
  D075 production deployment state (only measured-evidence reporting
  shipped), six-business UI parity, and post-deploy behavior — all
  remain operator decisions outside this package.

## Acceptance correction 2 (2026-08-30, same day)

The ACCEPTED claim above was independently REJECTED on three gaps. All
three are closed fail-first; the historical record above is preserved
as-written and this section is the correction of record.

1. **Multi-endpoint exclusion was not a delivered reason** — the plan
   carried only a boolean flag with zeroed counts, the seam asserted only
   the flag, and the docs called the ADR promise delivered. Fail-first:
   the seam assertion for exact counts failed on the rejected plan shape
   (`d077c-failfirst.log`, exit 1). Fix: `protectionsByReason` gains
   `multiEndpointExcluded` — every complete-lane run and its physical
   state rows of an unsupported multi-endpoint scope, excluded wholesale
   BEFORE candidate classification (disjoint from every other reason and
   from the candidate denominator; the boolean remains for compatibility
   only). Values are measured by a scope-bound count, never manufactured
   or subtracted; totals aggregate them and the payload hash binds them
   (scopes/totals are hashed wholesale). Real-PG proof: per creative
   endpoint scope exactly 3 runs / 3 rows; totals 6 / 6.
2. **Row-level count reconciliation was missing** — the invariant claim
   was broader than the implementation (runs only). Fail-first: the new
   perturbation suite failed 9/9 on the rejected code (no validator
   existed; no row reconciliation anywhere). Fix: exported
   `validateCompactionScopeCounts`, called by the planner per scope
   (supported AND multi-endpoint paths) and on totals: disjoint candidate
   reconciliation for runs AND rows, pinned-union bounds against
   overlapping family runs AND rows (≤ sum, ≥ max — non-additive),
   interleave mirrors, scope-level multi-endpoint disjointness, and
   non-negative safe integers. Executable proofs perturb row counts
   (candidate-row mismatch, pinned-row union above family sum and below
   family max, run-union violations, disjointness violation) and prove
   refusal — not a source-text assertion.
3. **Journal-only read failure rendered as "NOT_EXECUTED / no journal
   entries"** — the helper swallowed the failed business-scoped journal
   query to an empty array. Fail-first: with fence and D075 reads
   succeeding and ONLY the journal query throwing, the rejected helper
   reported `NOT_EXECUTED` with no blocker. Fix (contract bumped to
   `d077.state-history-compaction-readiness.v3`): explicit
   `journalRead: "ok" | "unavailable"` provenance; approval status
   `UNKNOWN_JOURNAL_UNAVAILABLE` plus the
   `compaction_journal_read_unavailable` blocker whenever the journal is
   unreadable (including total read failure); `NOT_EXECUTED` is asserted
   only from a SUCCESSFUL empty business-scoped read. Desktop and mobile
   render the failure as "journal state unavailable — … execution state
   is unknown" with neither `NOT_EXECUTED` nor `no journal entries` in
   the markup; genuine-empty and genuine-completed states preserved;
   `$1 = ANY(business_ids)` scoping, no tokens, no mutation affordance —
   all unchanged. All fixtures/consumers updated to v3.

Correction-2 verification: focused suites 6 files / 50 tests green
(counts validator 9, readiness helper 8, recovery section 6, business
page 11, admin route 10, isolation guard 6);
`npx vitest run lib/meta --maxWorkers=1` → 165 files (160 passed,
5 skipped), 1,985 passed / 56 skipped / 0 failed;
`npm run test:migrations-from-zero` green — 31 PASS banners, exit 0,
with the compaction seam banner now claiming the complete per-reason
list including the measured multi-endpoint counts; `tsc --noEmit`,
focused ESLint, `git diff --check` clean; executor isolation guard
green; the three env variables remain unset. All evidence ephemeral;
production untouched.

## Acceptance correction 3 (2026-08-30, final)

Historical truth: the correction-2 ACCEPTED claim above was itself
independently REJECTED on three remaining proof/validator gaps. Nothing
in correction 2 is rewritten away — its record stands verbatim; this
section closes what it missed. As before, everything is local +
ephemeral: no production access, no deploy, no env change.

1. **Multi-endpoint disjointness had row-level holes — CLOSED [fact].**
   The correction-2 validator entered its disjointness branch only when
   `multiEndpointExcluded.runs > 0` and checked only a subset of RUN
   fields, so row-only leakage rode through. Fail-first: two new
   perturbation tests failed on the rejected validator (asymmetric
   presence `{runs:0,rows:9}`/`{runs:3,rows:0}` accepted; a multi scope
   carrying `headDuplicate {runs:0,rows:1}` accepted). Fix: presence is
   now derived from runs OR rows; asymmetric presence (runs===0 xor
   rows===0) fails closed (an all-empty multi scope refuses for operator
   investigation rather than serializing impossible evidence); when
   present under `multiEndpointDisjoint` (the per-scope default), EVERY
   other scalar (candidate/pinned/interleaved/removable at RUN and ROW
   level) and every other reason family's runs AND rows must be zero.
   Totals keep `multiEndpointDisjoint: false` and legitimately mix
   supported and excluded scopes. Existing run/row reconciliation checks
   unweakened (counts suite 11/11).

2. **`toCount` manufactured measured-zero evidence — CLOSED [fact].**
   The planner's `toCount` mapped null/undefined/malformed database
   values to `0`, turning missing count evidence into a confident
   measurement. Fail-first: five planner-level tests driven through the
   REAL `planStateHistoryCompaction` path with a routing mock SQL client
   produced plans (and hashes) from NULL live-row counts, `"garbage"`,
   `"12abc"`, `-1`, `1.5`, `NaN`, `Infinity`, NULL candidate
   `physical_rows`, and NULL multi-endpoint row counts on the rejected
   code. Fix: `toCount` is deleted; `requirePlannerCount(value, label)`
   accepts only non-negative safe-integer numbers and pure decimal
   strings (`/^\d+$/`, trimmed, safe range) and otherwise throws
   `state-history compaction planner refused unparseable count evidence
   (<label>): <value>` BEFORE any plan or hash serialization. All six
   count sites audited and labelled (timeline transition_rows, scope
   complete_runs, multi-endpoint excluded runs/rows, candidate
   physical_rows, recency_rank, live_rows census); boolean fields
   remain on the separate `truthy()` helper. PostgreSQL string counts
   (`"3"`) still plan successfully through the same real path
   (planner-counts suite 6/6). The refusal label adds a 10th literal
   table reference in the planner — classified in the D075 closure
   ledger and sweep artifact as a diagnostic string, not a new reader.

3. **Hash-binding and consumer proofs were asserted, not executed —
   CLOSED [fact].**
   - 3A: a focused suite
     (`state-history-compaction-hash-binding.test.ts`, 3/3) proves that
     mutating ONLY `protectionsByReason.multiEndpointExcluded.runs` or
     `.rows` — on a scope or on totals — changes
     `computeExecutionPayloadHash`, and that a tampered payload carrying
     the stale hash and its matching token is refused by
     `executeStateHistoryCompaction` with `plan_payload_tampered`,
     0 batches, 0 rows (validation phase, before any DB access).
   - 3B route: the admin readiness route test now includes a
     journal-ONLY failure leg (fence + D075 measured reads succeed, only
     the `meta_state_history_compaction_journal` query throws) asserting
     HTTP 200, contract v3, `journalRead: "unavailable"`,
     `approvalStatus: "UNKNOWN_JOURNAL_UNAVAILABLE"`, the
     `compaction_journal_read_unavailable` blocker, the empty journal
     array as unavailable-evidence, zero `NOT_EXECUTED` anywhere in the
     serialized section, and the `$1 = ANY(business_ids)` predicate
     issued with the requested business id (route suite 11/11).
   - 3B page: the business Automation page test proves a v3
     journal-unavailable readiness object is passed through to the view
     VERBATIM (same object, `journalRead`/`approvalStatus` intact) —
     never converted to null/empty/NOT_EXECUTED (page suite 12/12). The
     helper's successful-empty and UI-rendering tests are retained.
   - The stale comment in `state-history-compaction-readiness.test.ts`
     claiming the journal read "degrades to empty" is corrected to the
     v3 truth (explicit unavailable provenance + UNKNOWN status).

Correction-3 verification (all serial, `--maxWorkers=1`): focused suites
9 files / 70 tests green (counts 11, planner-counts 6, hash-binding 3,
readiness helper 8, recovery section 6, business page 12, admin route 11,
isolation guard 6, consumer-closure 7); `npx vitest run lib/meta
--maxWorkers=1` → 167 files (162 passed, 5 skipped), 1,996 passed /
56 skipped / 0 failed; `npm run test:migrations-from-zero` green — 31
PASS banners, exit 0; `npx tsc --noEmit` clean; focused ESLint on every
changed file clean; `git diff --check` clean; env readback:
`META_AUTOMATION_ENABLED`, `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION`,
`STATE_HISTORY_COMPACTION_ABORT` all unset. All evidence ephemeral;
production untouched.

## Residuals

- The in-batch pinned-run skip path (`completed_with_skips`) is now
  reachable only in the race window between the pre-write re-plan and a
  batch transaction; it is retained as defense-in-depth per the charter.
- Plan→execute strictness: ANY change to the fenced table (or fence
  measurement) between planning and first execution refuses with
  `authoritative_replan_mismatch`; the operator re-plans. This is
  intended fail-closed behavior and is documented in the CLI flow.
- The journal exposes plan hashes (pre-existing); the UI renders journal
  events/timestamps only. Token derivation additionally requires the full
  matching plan artifact, CLI access, and DB access, and the pre-write
  re-plan makes a non-authoritative payload unexecutable regardless.
