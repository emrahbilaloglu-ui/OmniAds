# `meta_entity_state_history` — 6 GiB fence relief runbook

**Status: WRITTEN, NOT RUN.** Nothing in this document has been applied to
production. Every measurement below was taken through a read-only session
(`SET default_transaction_read_only = on`) over the operator tunnel on
127.0.0.1:15432. No row was written, no extension was created, no index was
rebuilt, and the D077 executor has never run here — the journal proves it
(`SELECT count(*) FROM meta_state_history_compaction_journal` returned `0`).

This is the operator procedure. It is D077-compatible by construction: it adds
no new deletion contract, no new metric, and no budget change. It sequences the
steps D077 already named as blockers, in the order that is actually safe, with
the preconditions and rollback each one needs.

**D096 release addition (September 9).** The release adds
`idx_meta_entity_state_history_manifest_delta`, which was absent from the
September 7 index census below. Its production size and reclaimable space are
unknown until measured. The migration logs total relation bytes and this index's
bytes before and after its concurrent build. The narrowly scoped migration
contract documented in [the receipt rollback contract](meta-receipt-additive-rollback.md)
permits index work while the actual SOURCE growth fence is already closed and
fresh physical capacity passes. It does not change the 6 GiB ceiling or admit
sync. Deploy the bounded writer with SOURCE fenced, then perform Step A below.
Include the new index, if present, in a fresh size census and the measured
smallest-first reindex order; do not reuse the old seven-index list as today's
complete catalog. A valid existing index can be checked again without granting
new build capacity. Acceptance requires actual post-recovery headroom including
the new index; deployment itself reclaims no space.

**What this document can and cannot return, stated before anything else.** The
writer fixes in this working tree stop three inflows (§1, §6.1); they reclaim
nothing already stored. The 638,976 B that is already over the ceiling comes back
only from a physical step — an index rebuild (§3) or, after a compaction, B4 —
because `DELETE` does not lower `pg_total_relation_size` (§2). And **the rows the
partial-write storm produced are not reclaimable by D077 at all**: its planner
only ever considers the `complete` lane, and those partial rows in fact *protect*
complete duplicates from removal. That is set out with the predicates in §2.1,
and it is the single most important thing to read before approving anything here.

---

## 0. Preflight (read-only, safe, run this first)

Nothing below this section may be started until this block has been run and its
output read. It is SELECT-only inside a read-only transaction, it creates
nothing, and it exists so the operator learns the four facts that decide which
branch of this runbook applies — **size, free-space provability, privileges,
planner state** — instead of assuming §1 still holds. §1 is a measurement taken
on 2026-09-07; this block is how you find out whether it is still true.

Run it against production through the operator tunnel:

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SET default_transaction_read_only = on;
SET statement_timeout = '120s';

-- 0.1 SIZE AND THE OVERAGE. 6 GiB = 6442450944 B is
--     DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history in
--     lib/sync/db-growth-fence.ts.
SELECT
  pg_total_relation_size('meta_entity_state_history')            AS total_bytes,
  pg_table_size('meta_entity_state_history')                     AS heap_toast_bytes,
  pg_indexes_size('meta_entity_state_history')                   AS index_bytes,
  6442450944                                                     AS budget_bytes,
  pg_total_relation_size('meta_entity_state_history') - 6442450944 AS overage_bytes,
  CASE WHEN pg_total_relation_size('meta_entity_state_history') > 6442450944
       THEN 'BREACHED - admission refused for this table'
       ELSE 'under budget - no relief step is needed' END        AS verdict;

-- 0.2 IS A FREE-SPACE PROOF POSSIBLE? Without pgstattuple the governing metric
--     is raw size, the D077 plan reports free_space_proof_unavailable and the
--     executor refuses (see §2.1). "available but not installed" means B0 is a
--     one-statement operator DDL; "not available" means the server package
--     lacks contrib and B0 cannot be done at all.
SELECT
  (SELECT count(*) FROM pg_extension WHERE extname = 'pgstattuple') AS installed,
  (SELECT count(*) FROM pg_available_extensions
    WHERE name = 'pgstattuple')                                    AS available,
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple')
      THEN 'installed - the effective metric is provable'
    WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgstattuple')
      THEN 'NOT installed, but available - B0 is possible'
    ELSE 'NOT available on this server - B0 is impossible, Step B is out'
  END AS verdict;

-- 0.3 PRIVILEGES. Step A needs table ownership (or superuser); B0 needs the
--     right to CREATE EXTENSION. This says which session you are actually in.
SELECT
  current_user,
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)  AS is_superuser,
  (SELECT tableowner FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'meta_entity_state_history')              AS table_owner,
  pg_has_role(current_user,
    (SELECT tableowner FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'meta_entity_state_history'), 'USAGE')  AS can_reindex,
  current_setting('default_transaction_read_only')              AS session_read_only,
  current_setting('server_version')                             AS server_version;

-- 0.4 PLANNER / VACUUM STATE. n_dead_tup = 0 on an insert-only table is the
--     reason plain VACUUM returns nothing TODAY (§2) and the reason B3 only
--     becomes meaningful after B2 has deleted rows. A non-zero n_dead_tup here
--     means something HAS deleted, and the assumption in §2 must be re-derived
--     before any step is taken.
SELECT
  n_live_tup, n_dead_tup, n_mod_since_analyze,
  last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
  (SELECT reloptions FROM pg_class
    WHERE oid = 'meta_entity_state_history'::regclass)          AS table_reloptions,
  CASE WHEN n_dead_tup = 0
       THEN 'insert-only shape holds - VACUUM alone returns nothing yet'
       ELSE 'dead tuples exist - re-derive section 2 before proceeding' END AS verdict
FROM pg_stat_user_tables
WHERE relname = 'meta_entity_state_history';

-- 0.5 LEFTOVER INVALID INDEXES. Any row here is a previous REINDEX
--     CONCURRENTLY that failed and is still consuming bytes. Exit criterion 2.
SELECT indexrelid::regclass AS invalid_index,
       pg_relation_size(indexrelid)  AS bytes
FROM pg_index
WHERE NOT indisvalid AND indrelid = 'meta_entity_state_history'::regclass;

-- 0.6 PER-INDEX SIZES, so Step A's smallest-first order can be re-derived
--     rather than copied from §1.
SELECT indexrelname, pg_relation_size(indexrelid) AS bytes, idx_scan
FROM pg_stat_user_indexes
WHERE relname = 'meta_entity_state_history'
ORDER BY 2 DESC;

-- 0.7 HAS D077 EVER RUN? An empty journal means no compaction has been
--     executed against this database.
SELECT count(*) AS journal_rows FROM meta_state_history_compaction_journal;

-- 0.8 WHAT D077 CAN EVEN SEE. Candidacy is completeness = 'complete' only
--     (§2.1). This is the run-side split, which is cheap; the state-row split
--     is a full heap scan and is deliberately NOT in this preflight.
SELECT completeness, count(*) AS runs, SUM(COALESCE(row_count, 0)) AS logical_rows
FROM meta_entity_observation_runs
GROUP BY completeness
ORDER BY completeness;

ROLLBACK;
```

**How to read it.** 0.1 says whether you have a problem at all. 0.2 decides
whether Step B is even reachable. 0.3 says whether the session you are in can
perform Step A (the read-only operator tunnel cannot). 0.4 tells you whether the
insert-only assumption this document is built on still holds. 0.5 and 0.6 size
the work. 0.7 and 0.8 say what D077 has done and what it is allowed to look at.

This block has **not** been run by whoever wrote it: like everything else here it
is an operator procedure, not a record of an execution.

---

## 1. Measured state (read-only, 2026-09-07)

| Fact | Value |
| --- | --- |
| `pg_total_relation_size` | 6,443,089,920 B |
| Ceiling (D089, `DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history`) | 6,442,450,944 B (6 GiB) |
| **Overage** | **638,976 B** |
| Live rows | 4,416,298 |
| Dead tuples (`pg_stat_user_tables.n_dead_tup`) | 0 |
| Heap + TOAST (`pg_table_size`) | 2,803,474,432 B |
| Indexes (`pg_indexes_size`) | 3,639,615,488 B — **56.5 % of the relation** |
| Database total | 124,778,871,831 B against the 160 GiB aggregate fence |
| PostgreSQL | 16.15 (Ubuntu) |
| `pg_extension` | `pgcrypto`, `plpgsql` only — **`pgstattuple` is still not installed** |

Per-index, ordered by size:

| Index | Bytes | `idx_scan` |
| --- | --- | --- |
| `meta_entity_state_response_lineage_unique` | 1,103,249,408 | 0 |
| `idx_meta_entity_state_history_asof` | 724,377,600 | 8,330,556 |
| `idx_meta_entity_state_history_d086_latest` | 680,828,928 | 4,821,699 |
| `idx_meta_entity_state_history_run_ad_identity` | 302,383,104 | 328,812 |
| `idx_meta_entity_state_history_run` | 299,974,656 | 198,051 |
| `meta_entity_state_history_run_entity_unique` | 299,974,656 | 1,960,400 |
| `meta_entity_state_history_pkey` | 228,827,136 | 23,889 |

### What changed since D077's census (2026-08-30)

| | 2026-08-30 (D077) | 2026-09-07 | Δ |
| --- | --- | --- | --- |
| Rows | 4,239,834 | 4,416,298 | +176,464 (+4.2 %) |
| Heap + TOAST | 2,684,198,912 | 2,803,474,432 | +119,275,520 (+4.4 %) |
| Indexes | 2,684,551,168 | 3,639,615,488 | +955,064,320 (+35.6 %) |

Heap grew in step with the rows. The index half did not. **680,828,928 B of that
index growth is a new index** — `idx_meta_entity_state_history_d086_latest`,
created by `lib/meta/budget-readiness-retention.ts` — which accounts for 71 % of
it. The remaining ~274 MB across the pre-existing six is *consistent with*
btree bloat and **is not proof of it**: without `pgstattuple` there is no
free-space measurement on this database, so no bloat claim in this document may
be treated as measured.

### Two writers were producing rows with no content

Both are fixed in `lib/meta/entity-state-history.ts` in this working tree
(uncommitted, undeployed). They stop the *inflow*; they reclaim nothing. A
third inflow — one run and one receipt appended per failed provider attempt,
into two tables that no per-table fence covers — is a different surface and is
set out separately in §6.1.

1. **Partial-lane full rewrite.** Every `partial` observation re-wrote every row
   it had fetched. 126,500 partial state rows were written between 2026-09-04
   and 2026-09-07 and **126,500 of them** carried a `state_hash` identical to
   the entity's immediately preceding row. Total partial-lane rows today:
   342,000 (D077 measured 215,500 on 2026-08-30).
2. **Complete-lane lineage carry.** `lineageRelevantAdIds` named every ad in the
   payload, so the D075 delta carried the whole scope back in. Four consecutive
   `ad_configs` delta runs on 2026-09-06 recorded
   `changedEntityCount: 0, newEntityCount: 0, exitedEntityCount: 0` beside
   `lineageCarriedEntityCount: 3288, physicalStateRows: 3288, amplification: 1`.

Re-measure both after deploy with `readMetaObservationWriterPressure`
(§6). Do **not** start any reclaim step below until that readback shows the
inflow has actually stopped — D077's own §"Explicitly out of scope" item 1 says
reclaimed space refills at the measured rate otherwise, and the 2026-08-18
budget raise is the worked example (four days of headroom).

---

## 2. The byte semantics that decide the order of operations

D077 established these and nothing here weakens them.

- **`DELETE` does not lower `pg_total_relation_size`.** It creates reusable
  space inside existing pages. The fence compares the raw size.
- **This table has zero dead tuples and is insert-only.** So there is no
  existing free space to reclaim and `VACUUM` alone returns nothing today. The
  only way a `VACUUM`-class step can help is *after* a `DELETE`.
- **The effective-size metric is unavailable.** `lib/sync/db-growth-fence.ts`
  falls back to the raw size on any uncertainty, and `pgstattuple` is absent, so
  the governing metric is raw. The D077 readiness contract therefore reports
  `free_space_proof_unavailable` and the executor refuses an
  `insufficient_evidence` plan outright.
- **Indexes are 56.5 % of the relation and are fully counted.** No index-side
  proof mechanism exists.

The consequence is uncomfortable and must be stated plainly to whoever approves
this: **the only step that returns raw bytes without deleting a single row is an
index rebuild.** Every deletion path needs a physical step afterwards anyway.

## 2.1 Is the D077 executor applicable to THIS table and THIS overage?

Answered by reading the planner, not assumed. Three separate questions, three
different answers.

**a) To this table — yes.** `meta_entity_state_history` is the only table D077
targets; `stateHistoryBudgetBytes()` in `lib/meta/state-history-compaction.ts`
reads the same `DEFAULT_TABLE_BUDGET_BYTES` entry the fence compares against.

**b) To the partial-write storm's rows — NO. They are not reclaimable by D077,
and this is not a tuning question.** Candidacy is restricted to the complete
lane at every stage of planning, by predicate:

| Where | Predicate |
| --- | --- |
| `SCOPE_FINGERPRINT_QUERY`, `lib/meta/state-history-compaction.ts:417` | `WHERE r.completeness = 'complete'` |
| `computeTimelineHashes`, same file `:450` | `AND run_completeness = 'complete'` |
| scope enumeration, same file `:610` | `WHERE r.completeness = 'complete'` |
| `run_manifest` (the candidate CTE), same file `:671` | `WHERE r.completeness = 'complete'` |

A `partial` run is therefore never a candidate, never appears in a plan's
`removable` list, and cannot be deleted by the executor under any approval. The
342,000 partial-lane rows §1 counts — 126,500 of them written by the storm
between 2026-09-04 and 2026-09-07 — are **outside D077's reach entirely.**

It is worse than "no help". Those rows actively *reduce* what D077 may remove.
`lib/meta/state-history-compaction.ts:713` marks a complete duplicate excluded
when a `partial`/`point_lookup` row is interleaved between it and its retained
predecessor:

```
AND interleaved.run_completeness IN ('partial', 'point_lookup')
```

and the classifier at `:779`–`:786` counts that run under
`reasons.interleavedExcluded` instead of `removable`, because deleting it would
resurface the interleaved row as the as-of winner. A lane that emitted partial
rows continuously — which `ad_configs` and `adset_configs` did throughout the
storm window — therefore has its complete duplicates protected in exactly that
window. **The fix in `lib/meta/entity-state-history.ts` that stops the partial
inflow is also the thing that widens D077's future candidate set. It reclaims
nothing that is already stored.**

**c) To the 638,976 B overage — no, not directly, and the plan says so itself.**
D077 projects only the EFFECTIVE metric and explicitly refuses to claim the raw
one: `fenceProjection.raw.clearedByDeleteAlone` is hard-coded `false`
(`lib/meta/state-history-compaction.ts`, the `fenceProjection` literal) with the
detail string "DELETE creates reusable space only; pg_total_relation_size does
not shrink." Index bytes are never projected as reclaimed at all. And the
executor will not run without a proof that does not exist here:

- the plan's `status` becomes `insufficient_evidence` whenever
  `fence.metric !== 'effective_reusable_heap'`, which is the state of this
  database while `pgstattuple` is absent (`state-history-compaction.ts`, the
  `insufficiencyReasons` block);
- `lib/meta/state-history-compaction-executor.ts:169` refuses any plan whose
  status is not `ready` (`plan_not_ready:<status>`), and `:172` refuses again
  unless `fenceProjection.effectiveReusableHeap.cleared === true`;
- `lib/meta/state-history-compaction-readiness.ts:171` is where the operator
  instruction comes from — `free_space_proof_unavailable:… (operator: CREATE
  EXTENSION pgstattuple)` — and the same function unconditionally pushes
  `delete_alone_cannot_shrink_raw_size (operator: REINDEX CONCURRENTLY /
  pg_repack for physical byte return)`.

So: **B0 is a hard precondition for the executor to run at all, and even a
successful, fully approved D077 execution clears the EFFECTIVE metric, never the
raw `pg_total_relation_size` the fence is currently comparing.** The 638,976 B
overage is cleared by a physical step (Step A, or B4) or it is not cleared. That
is why Step A is first in this document and not an afterthought.

---

## 3. Step A — `REINDEX CONCURRENTLY` (the minimum viable relief)

This is the recommended first and possibly only step. It deletes nothing, needs
no plan, no approval token and no journal, and is reversible by construction.

### Preconditions

1. The two writer fixes are deployed **and** §6 confirms the inflow stopped.
   Reindexing a table that is still being rewritten buys days, not relief.
2. Data-volume free space ≥ 40 GiB
   (`MINIMUM_VOLUME_FREE_BYTES` in `lib/sync/db-growth-fence.ts`) **plus** the
   size of the largest index being rebuilt (1,103,249,408 B) plus WAL burst.
   Verify on the DB host, not from the app process — the app cannot read that
   filesystem.
3. A low-traffic window. `REINDEX INDEX CONCURRENTLY` takes only a
   `SHARE UPDATE EXCLUSIVE` lock, so reads and inserts continue, but it waits
   for conflicting transactions to drain at the start and end.
4. **Connect as a role that owns the table.** The read-only operator tunnel
   cannot run this; this is a privileged maintenance session.

### The warning nobody should be surprised by

While each `REINDEX CONCURRENTLY` runs, the old and new index coexist, so
`pg_total_relation_size` **temporarily rises by the size of that index**. The
fence is already breached; during the rebuild it is breached further. Sync
admission is already refused, so nothing new breaks — but do not run this
expecting the number to fall monotonically, and do not run two rebuilds
concurrently.

### Order

Rebuild smallest-first so the first result is available quickly and the disk
high-water mark grows gradually. One statement at a time, measuring between
each, and stop as soon as the relation is under 6,442,450,944 B with the margin
in §5:

```
REINDEX INDEX CONCURRENTLY public.meta_entity_state_history_pkey;
REINDEX INDEX CONCURRENTLY public.meta_entity_state_history_run_entity_unique;
REINDEX INDEX CONCURRENTLY public.idx_meta_entity_state_history_run;
REINDEX INDEX CONCURRENTLY public.idx_meta_entity_state_history_run_ad_identity;
REINDEX INDEX CONCURRENTLY public.idx_meta_entity_state_history_d086_latest;
REINDEX INDEX CONCURRENTLY public.idx_meta_entity_state_history_asof;
REINDEX INDEX CONCURRENTLY public.meta_entity_state_response_lineage_unique;
```

Measure after each (read-only is enough):

```sql
SET default_transaction_read_only = on;
SELECT pg_total_relation_size('meta_entity_state_history') AS total,
       pg_table_size('meta_entity_state_history')          AS heap_toast,
       pg_indexes_size('meta_entity_state_history')        AS indexes;
SELECT indexrelname, pg_relation_size(indexrelid) AS bytes
FROM pg_stat_user_indexes
WHERE relname = 'meta_entity_state_history'
ORDER BY 2 DESC;
```

### Expected reclaim: UNKNOWN, and it must stay unknown until measured

There is no free-space proof on this database, so this runbook states no
projected number. The per-index growth arithmetic in §1 is an *indicator*, not a
forecast. If the whole rebuild returns less than the 638,976 B overage plus
margin, go to Step B; do not repeat Step A hoping for a different answer.

### Rollback

`REINDEX CONCURRENTLY` is transactional per index in the sense that matters: on
failure it leaves the ORIGINAL index in place and an extra invalid index named
`<name>_ccnew`. Nothing is lost. Clean up with:

```sql
SELECT indexrelid::regclass AS invalid_index
FROM pg_index WHERE NOT indisvalid
  AND indrelid = 'meta_entity_state_history'::regclass;
-- then, per name found:
DROP INDEX CONCURRENTLY public.<name>_ccnew;
```

An invalid leftover index still consumes bytes, so this cleanup is part of the
step, not an optional tidy-up.

### What must NOT be done in this step

**Do not drop `meta_entity_state_response_lineage_unique`** because its
`idx_scan` is 0. It is the referenced-side index of
`engine_v3_ad_response_events_state_history_fk` on
`engine_v3_ad_operator_response_events` — a seven-column composite FK
(`ON DELETE RESTRICT`). Dropping it drops the constraint or fails. A zero scan
count on an FK target index means the parent has never been deleted from, not
that the index is unused. Two other `ON DELETE RESTRICT NOT VALID` FKs point at
this table from `meta_creative_lineage_edges` **and from the retained
`adsecute_compact_20260726t0204z` schema's copy of it** — the retained schema is
still wired into the live table and must be reckoned with before any deletion
step, exactly as D077 recorded.

---

## 4. Step B — D077 compaction, then a physical step

Only if Step A does not clear the ceiling with margin. This is the existing
D077 machinery; this runbook adds sequencing, not contract.

### B0. Make the free-space proof possible (a real blocker, not a formality)

```sql
CREATE EXTENSION pgstattuple;
```

Until this exists, `lib/meta/state-history-compaction-readiness.ts` emits
`free_space_proof_unavailable:… (operator: CREATE EXTENSION pgstattuple)` and
`lib/meta/state-history-compaction-executor.ts` refuses the plan. Note what it
buys today: with `n_dead_tup = 0` on an insert-only table, `approx_free_space`
will be near zero *until B2 has deleted rows and autovacuum has processed them*.
Installing it before B2 is correct sequencing, not an immediate gain.

Rollback: `DROP EXTENSION pgstattuple;` — it adds functions only, no data.

### B1. Plan (SELECT-only, safe to run any time)

```
node --import tsx scripts/state-history-compaction-cli.ts \
  --mode plan \
  --business-ids <id,id,...> \
  --plan-out /tmp/state-history-compaction-plan.json \
  --statement-timeout-ms 300000
```

- A global scope is refused by design; pass the explicit business list.
- The CLI opens one `REPEATABLE READ READ ONLY` transaction, so the whole
  multi-statement plan sees one snapshot.
- The **exact removable run/row count is produced here and nowhere else.** D077
  is explicit that the 3,449,571-row candidate mass is an UPPER bound (one
  FK-pinned row excludes its whole run) and that no row-level subtraction may be
  presented as a removable count. Read the plan's `totals` and
  `fenceProjection`, not this document, for the number.
- Expect `status: insufficient_evidence` while B0 has not been done.

### B2. Execute (destructive; a separate human approval)

```
node --import tsx scripts/state-history-compaction-cli.ts \
  --mode execute \
  --business-ids <the exact same list> \
  --plan-file /tmp/state-history-compaction-plan.json \
  --approval-token 'approve-state-history-compaction:<planHash from B1>' \
  --acknowledge-physical-shrink-required
```

The executor re-derives the authoritative plan from the database, recomputes the
hash, and revalidates every run inside each batch transaction (scope identity,
expected row count, manifest signature, a retained identical earlier manifest, a
retained newer run, the interleaved partial/point-lookup window, and all three
FK pin families). A tampered plan, a wrong token, or a pin that arrived after
planning produces zero writes.

Kill switch between batches: set `STATE_HISTORY_COMPACTION_ABORT`
(`COMPACTION_KILL_SWITCH_ENV`). The lease is a 15-minute expiring journal lease
under an advisory lock, so a crashed executor releases on its own.

**Rollback**: there is none in the "restore the rows" sense, by deliberate D077
design — no archive table is kept, because an archive would re-spend the same
bytes inside the same fence, and the deleted rows are byte-identical duplicates
whose content the retained copies already carry. The recovery record is
`meta_state_history_compaction_journal` (what was deleted, under which plan,
with which checks). The rollback you actually have is **not starting**: B1 is
free and reversible, B2 is not. Take a backup snapshot of the database before
B2 and confirm it restores, or do not run B2.

### B3. Convert the deletions into provable free space

```sql
VACUUM (VERBOSE, ANALYZE) public.meta_entity_state_history;
```

Plain `VACUUM` — **not** `VACUUM FULL`. This takes no exclusive lock and makes
the deleted space reusable so `pgstattuple_approx.approx_free_space` can see it.
Only after this can the fence's effective-size metric fall. Raw size still will
not move.

### B3b. Read the effective size back, and let it say "no relief" if that is the answer

B2 reports how many rows it deleted. That is not relief; it is a deletion count.
This step measures the number the fence actually compares, using the exact
expressions `lib/sync/state-history-effective-size.ts` uses so the readback and
admission cannot disagree — `pgstattuple_approx(...)`'s `table_len` and
`approx_free_space` against `pg_total_relation_size`.

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SET default_transaction_read_only = on;
SET statement_timeout = '300s';

WITH raw AS (
  SELECT pg_total_relation_size('meta_entity_state_history') AS raw_bytes,
         pg_table_size('meta_entity_state_history')          AS heap_bytes
), approx AS (
  SELECT table_len, approx_free_space
  FROM pgstattuple_approx('meta_entity_state_history'::regclass)
)
SELECT
  raw.raw_bytes,
  raw.heap_bytes,
  approx.approx_free_space                       AS proven_free_heap_bytes,
  raw.raw_bytes - approx.approx_free_space       AS effective_bytes,
  6442450944                                     AS budget_bytes,
  CASE
    WHEN approx.table_len > raw.heap_bytes
      THEN 'INCONCLUSIVE: table_len inconsistent - the fence falls back to RAW'
    WHEN approx.approx_free_space > raw.raw_bytes
      THEN 'INCONCLUSIVE: free space exceeds the table - fence falls back to RAW'
    WHEN raw.raw_bytes - approx.approx_free_space < 6442450944
      THEN 'RELIEF PROVEN on the effective metric'
    ELSE 'NO RELIEF: still over budget after the compaction and the vacuum'
  END                                            AS effective_verdict,
  CASE WHEN raw.raw_bytes < 6442450944
       THEN 'raw also under budget'
       ELSE 'raw STILL over budget - a physical step (B4 / Step A) is required'
  END                                            AS raw_verdict
FROM raw, approx;

ROLLBACK;
```

`pgstattuple_approx` acquires no exclusive lock, but it does read the table, so
run it in a low-traffic window with the statement timeout above rather than
against the 8 s application pool.

**Three outcomes, and each has a next step.** `RELIEF PROVEN` with `raw STILL
over budget` is the normal result and means the fence's *governing* metric is now
the effective one — go to B4 for raw bytes and then to §5. `NO RELIEF` means the
removable set was smaller than the overage: record the number, do **not** re-run
B2 hoping for more, and read §5's closing paragraph. `INCONCLUSIVE` means the
fence has fallen back to raw and the effective metric is not in force at all —
the readback disagreeing with admission is itself the finding, and nothing
further should be executed until it is understood.

Record the three numbers (`raw_bytes`, `proven_free_heap_bytes`,
`effective_bytes`) with the timestamp. They are the before-image for B4.

### B4. Return raw bytes

Re-run Step A (`REINDEX CONCURRENTLY`) after B3 — index entries for deleted rows
are gone, so a rebuild after compaction returns more than a rebuild before it.
For heap return, `pg_repack` (online, needs the extension and ~2× the heap in
free space) or `VACUUM FULL` (exclusive lock for the whole rewrite of
~2.8 GB — a hard outage window). Neither is executed by any code in this
repository, and neither should be attempted without the backup from B2.

---

## 5. Exit criteria

Stop when all of these hold, measured, in one read-only session:

1. `pg_total_relation_size('meta_entity_state_history') < 6,442,450,944` with at
   least **256 MiB** of margin — enough that a single day of genuine entity
   transitions cannot re-breach it before anyone looks. (D089 sized the whole
   bridge at 432 MiB of headroom; leaving less than half of that is how
   2026-08-18 repeated itself.)
2. No invalid index remains (`pg_index WHERE NOT indisvalid`).
3. `readMetaObservationWriterPressure` over the 24 h after the writer fix shows
   `physicalStateRows` far below `deltaLogicalEntityCount` on every
   `complete` and `partial` lane — i.e. the inflow really is delta-bounded.
4. Sync admission is allowed again: the growth fence stops reporting
   `sync_admission_blocked` / `decision_manifest_invalid` for this table.

**Do not raise the budget again.** D077 rejected that outright and D089 raised it
once, on measured evidence, calling six GiB "a reversible operating bridge" whose
exhaustion "requires compaction, not another unmeasured increase". This
document adds no argument for a seventh GiB. If Steps A and B both fail to clear
6 GiB, the answer is a retention horizon for the partial lane and for
non-duplicate history — which D077 deliberately did **not** invent, and neither
does this runbook, because no consumer requirement enumerated there justifies
deleting non-duplicate history yet.

**Do not use `SYNC_GROWTH_FENCE_OVERRIDE`** as relief. It is a bounded,
audited, six-hour emergency admission override
(`OVERRIDE_MAX_AGE_MS`); D089 used it once for a 30-minute production proof. It
admits writes into a breached table; it does not make the table smaller.

## 5.1 The catch-up, bounded

Clearing the fence does not end the operation. Admission has been refused since
2026-08-22 for parts of this chain, so the moment it re-opens every queued
partition drains at once — and the last time this table was relieved (the
2026-08-18 budget raise), the headroom was gone in four days. Whatever margin §5
leaves is spent by the catch-up unless the catch-up is bounded.

The bound is a per-business staircase with a measurement between every step. It
uses only tooling that already exists and only levers that already exist.

1. **Before re-admitting anything**, take the §0 preflight and record
   `total_bytes` as the baseline `B0`. Compute the headroom
   `H = 6442450944 - B0`. If `H` is below the 256 MiB margin of §5 exit
   criterion 1, the relief is not finished and the catch-up must not start.
2. **Re-admit ONE business.** Not a lane, not the fleet: one business id. Let
   its queue drain and watch it with the existing instruments —
   `node --import tsx scripts/meta-sync-drain-rate.ts --business <id>` for
   progress and `scripts/meta-sync-db-diagnostics.ts` for the worker side.
3. **Measure before the next one.** Re-run §0.1. The cost of that business is
   `Δ = total_bytes - B0`. Set `B0` to the new value.
4. **The stop rule, decided in advance so nobody has to decide it under
   pressure.** Stop and go back to §3/§4 if any of these holds:
   - remaining headroom `H` is less than `2 × Δ` (the next business of similar
     size would breach);
   - `H` has fallen below 256 MiB;
   - `readMetaObservationWriterPressure` over that business's catch-up window
     shows `physicalStateRows` at or near `deltaLogicalEntityCount` on any
     `complete` or `partial` lane — that is the delta contract not holding, and
     more catch-up will refill the table at the pre-D075 rate.
5. **Do not batch the historical backlog with the live cadence.** A business
   whose catch-up spans many historical days is the shape that produced the
   original amplification; give it its own step and its own measurement.
6. **Record each step**: business id, `Δ`, remaining `H`, and the writer-pressure
   shape. Four rows of that is the evidence that the relief held; its absence is
   how 2026-08-18 was allowed to repeat.

An override is not a substitute for any of this: `SYNC_GROWTH_FENCE_OVERRIDE`
admits writes into a breached table for at most six hours and makes nothing
smaller.

---

## 6. Readback: how to re-test the chain afterwards

`readMetaObservationWriterPressure` in `lib/meta/entity-state-history.ts` is the
instrument. It is SELECT-only and safe against production through a read-only
session. Measured unscoped over an 18-day window on 2026-09-07: 3.4 s over
2,379 runs.

```ts
const rows = await readMetaObservationWriterPressure({
  since: "2026-09-04T00:00:00.000Z",
  businessIds: ["<business id>"],   // omit for every business
});
```

Each row is one `(business, account, entity_type, endpoint, completeness)` lane
and separates four states that look identical from outside the writer:

| Shape | Reading |
| --- | --- |
| **No row for the lane at all** | Nothing was attempted in the window — no run appended AND no capture receipt. Look upstream: sync admission, the growth fence, the scheduler, the lease. |
| `runsAppended = 0`, `windowOccurrences > 0` | Alive and coalescing: the lane WAS captured in the window, and every capture found truth the writer already held, so nothing was appended. Not a stall. |
| `runsAppended > 0`, `runsWithError > 0`, `physicalStateRows = 0`, `lastStateCapturedAt = null` | Attempted, and the provider refused. Read `lastErrorKind` / `lastErrorHttpStatus` / `lastErrorTermination`. |
| `physicalStateRows` present, compared against `deltaLogicalEntityCount` | It ran and wrote. The ratio is whether the delta contract is holding or the scope is being rewritten. |

**Which numbers are window numbers.** A run is coalesced content, so filtering
runs on `captured_at` selects them by their FIRST capture and any total summed
off them crosses the window in both directions. The fields name their own basis:
`runsAppended`, `runsWithError`, `physicalStateRows`, `providerRowCount` and the
`delta*` sums are facts about runs APPENDED in the window;
`lifetimeOccurrencesOfWindowRuns` and `lastHeartbeatAtOfWindowRuns` are those
runs' LIFETIME totals and can reach past `until`; `windowOccurrences`,
`firstWindowOccurrenceAt` and `lastWindowOccurrenceAt` are the window's actual
captures, counted from `meta_entity_observation_receipts`. A NULL
`windowOccurrences` means the lane wrote no receipt at all — absence of
measurement, not zero.

### The open question this exists for

`campaign_configs` has no `complete` run after **2026-08-22 06:02 UTC**. As of
2026-09-07, read-only:

- 2026-08-20 … 2026-08-22: 33 complete campaign runs, last state row
  2026-08-22 06:02 UTC.
- 2026-08-22 → 2026-09-04 15:57 UTC: **no campaign run of any lane** — nothing
  was attempted. This window contains the 2026-08-22 14:53 UTC fence stop D077
  recorded.
- 2026-09-04 15:57 UTC onward (after the D089 6 GiB bridge): **729 `failed`
  campaign runs**, every one carrying
  `pagination.failure.kind = "http_failure"` with `httpStatus = 400` against
  `graph.facebook.com/v25.0/act_…/campaigns`. Zero state rows. Meanwhile the
  `ad` and `adset` lanes resumed and wrote.

Those are two different stalls in sequence, and **this document does not decide
whether the second is a consequence of the first.** It asserts no causal
direction. The measurable test, once the writer fix and the relief above are in:

1. Clear the fence so admission is allowed (Steps A/B, exit criteria §5).
2. Run `readMetaObservationWriterPressure` over the following 24 h.
3. If `campaign_configs` still shows only the `failed` shape with `httpStatus`
   400 while `ad`/`adset` write normally, the campaign freeze is independent of
   the storage chain and the next investigation is the campaign field list in
   `lib/api/meta.ts` (the request asks for
   `bid_constraints{roas_average_floor}` among others; a 400 on a field
   selection is a provider-contract question, not a storage one).
4. If `campaign_configs` starts producing `complete` runs again with no code
   change to the request, the freeze was downstream of admission and the chain
   was the cause.

Either answer is a measurement. Record it in the D077/D089 line of
`docs/creative-decision-center/DECISION_LOG.md` when it is taken.

---

## 6.1 The other unbounded surface: one run and one receipt per failed attempt

This is a second growth path in the same chain, established by reading the code
rather than inferred from the table sizes, because **no fence bounds it.**

**What was true.** `buildMetaObservationSemanticHash` in
`lib/meta/entity-state-history.ts` hashed the failure receipt whole, and the
receipt it is handed contains request identity. The chain, by line:

1. `lib/api/meta.ts`, `readMetaGraphErrorIdentity` — extracts `code`,
   `error_subcode`, `is_transient` and `fbtrace_id` from a rejected Graph body.
   `fbtrace_id` is Meta's identifier for one HTTP request.
2. `lib/api/meta.ts`, the non-complete `MetaPagedCollectionReceipt` constructor
   — puts `fbtraceId: identity.fbtraceId` into `receipt.failure`, beside
   `message`, `pageUrl` and `attempts`.
3. `lib/api/meta.ts`, `paginationReceiptContext` — passes
   `failure: receipt.failure` through **whole** into the `error` object that
   `persistMetaStatusConfigObservation` hands the writer.
4. `lib/meta/entity-state-history.ts:1676` — the coalescing branch fires only
   when `currentRun.semantic_hash === semanticHash`.

(Line numbers are given only for files this change set is not concurrently
editing. `lib/api/meta.ts` is being edited in this working tree, so its three
references are by symbol.)

Because step 3 delivers a per-request trace id into step 4's hash input, two
attempts at the same failure were never semantically equal. Every retry appended
one `meta_entity_observation_runs` row and one
`meta_entity_observation_receipts` row.

**Is there a bound?** No. `FENCED_TABLES` in `lib/sync/db-growth-fence.ts:40`
lists thirteen relations, and **neither `meta_entity_observation_runs` nor
`meta_entity_observation_receipts` is among them.** There is no per-table
ceiling on either; the only backstop is the 160 GiB aggregate database budget,
which refuses ALL sync when it trips rather than bounding these tables. The
production shape §6 records is what that looks like in practice: 729 `failed`
`campaign_configs` runs since 2026-09-04, every one carrying `httpStatus 400`.
(That the count is one run per attempt follows from the hash rule above; it is
not a separate measurement. Nor did it begin with the trace id — `message` and
`pageUrl` vary per attempt as well.)

**What was done about it.** The fix is in this working tree, in
`lib/meta/entity-state-history.ts`: `META_REQUEST_SCOPED_ERROR_FIELDS`
(`:740`) names the four request-identity keys — `fbtraceId`, `message`,
`pageUrl`, `attempts` — and `canonicalizeSemanticError` strips them at every
depth before hashing (`:843`). The classification a reader would act on stays
in: `kind`, `termination`, `httpStatus`, `errorCode`, `errorSubcode`,
`isTransient`, `pageIndex`, `complete`, `pageCount`, `invalidRowCount` and the
field-degradation record. A repeating identical failure now coalesces onto its
run and advances `repeat_count` instead of appending, and the degraded
checkpoint cadence (`META_OBSERVATION_DEGRADED_CHECKPOINT_INTERVAL_MS`, one
hour) still forces a fresh auditable run once an hour so a long outage does not
collapse into a single stale row.

**Nothing is lost.** The run keeps the first occurrence's `error_json` verbatim
— `buildMetaObservationRunHash` and the stored column are untouched — and
`appendObservationCaptureReceipt` writes the whole error, trace id included, for
EVERY occurrence, on the coalesced path as well as the appending one. The
forensic record moved from "one run per attempt" to "one receipt per attempt",
which is what the receipts table is for.

The hash's `contractVersion` is bumped to
`meta-entity-observation-semantic.v2` because the stored `semantic_hash` column
carries no version of its own. The cost is exactly one appended run per
`(business, account, entity_type, endpoint, completeness)` lane on the first
observation after deploy; on the complete lane that run takes the delta branch
and writes only genuinely changed rows.

**This reclaims nothing already stored.** Like the partial-lane fix it stops
inflow. Neither table has a compaction path in this repository.

---

## 7. What this runbook deliberately does not do

- It applies nothing. Every command above is written to be run by a human with
  the preconditions checked.
- It adds no index. `pg_total_relation_size` feeds the breached fence, so a new
  index deepens the breach — D075's own reason for shipping the delta writer
  without a supporting index.
- It changes no budget, no metric, and no deletion contract.
- It does not enable automation, authorise a proposal, or write to any provider.
- It does not claim a relief it cannot deliver. §2.1 says which rows D077 can
  and cannot remove; §3 refuses to forecast the rebuild's return; B3b is written
  so that "NO RELIEF" is a reportable outcome rather than a reason to try again;
  and §6.1 records a growth surface that has no reclaim path in this repository
  at all.
