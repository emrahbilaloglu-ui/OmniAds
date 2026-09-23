# Calibration / decision source query — where the time went, and what changed

2026-09-22. Read-only investigation against production
(`REPEATABLE READ READ ONLY` + `ROLLBACK`, SELECT only, no writes, no DDL, no
deploy). The subject is `READ_NATIVE_AD_CALIBRATION_SOURCE_SQL`
(`lib/creative-decision-engine/jobs/ad-calibration-job.ts`) and the config CTEs it
splices in from `lib/meta/config-field-source-contract.ts`.

## The starting report, and what was wrong with it

The observation that opened this was: the same 3,319-row TheSwaf replay returned
26.9 s on one run and 15.0 s on the next, and `enable_nestloop=off` returned
14.3 s, with identical row hashes.

**`enable_nestloop=off` is not the fix, and that reading was a single-trial
artefact.** Four interleaved read-only rounds on TheSwaf:

| setting | min | med | max |
|---|---|---|---|
| default planner | 9,895 | 11,314 | 13,128 ms |
| `enable_nestloop=off` | 12,499 | **14,829** | 16,848 ms |

It is consistently *worse*. The plan says why: forcing hash joins does remove the
CTE nested loops (44.2M row touches collapse to 31,728) but it also destroys the
efficient index nested loops **inside** the receipt CTEs and the joins to
`meta_campaign_daily` / `meta_adset_daily`, and those cost more than it saves.

### A measurement trap worth writing down

`EXPLAIN ANALYZE` cannot be used to compare these plan shapes. The default plan
pushes ~60M tuples through `CTE Scan` nodes and per-tuple instrumentation is
charged on every one of them, so its reported `Execution Time` is inflated
relative to a plan that moves fewer tuples. Under `EXPLAIN ANALYZE` the
nestloop-off plan looks 3.3 s *faster*; measured by the client, it is 3.5 s
*slower*. **Use EXPLAIN for structure — loops, rows, join type — and a plain
client-timed query for time.**

## The real bottleneck

One pathology, in two places: **a nested loop over an unindexed materialised
CTE.** The planner estimates every config CTE at exactly 1 row, so a nested loop
looks free and it re-reads the whole relation per outer row.

The estimate collapses at a nameable node. In
`meta_raw_snapshot_observations`, the bitmap index scan is already 18× off
(est 294 / act 5,290), and then the heap filter — six `request_context->>'...'`
json predicates whose selectivity the planner can only guess at — multiplies down
to **est 1 / act 4,726**. Everything downstream inherits it:
`calib_adset_cfg_receipts` est 1 / act 22,176, `calib_adset_cfg_entity_day`
est 1 / act 5,488.

Cost decomposition by real execution (TheSwaf, 4 rounds, medians). An
unreferenced `MATERIALIZED` CTE is never evaluated, so referencing a growing
prefix isolates each layer:

| layer | med ms |
|---|---|
| scope only | 166 |
| + campaign receipts / entity-day / 3 resolutions | 747 |
| + ad-set receipts / entity-day | 514 |
| + ad-set **1** resolution | 1,470 |
| + ad-set **3** resolutions | 3,518 |
| + ad-set **6** resolutions | 6,283 |
| full query | 10,013 |

Exactly linear at ~960 ms per ad-set resolution, and 1,394 × 5,488 = 7.65M row
touches each — every resolution was re-deriving the same join. Six of them:
**45.9M row touches, 5.8 s of a 10.0 s query.** The remaining ~3.4 s was the
final `SELECT` re-scanning nine CTEs once per output row.

## What changed

Three changes, all in `lib/meta/config-field-source-contract.ts` (plus one line in
`ad-calibration-job.ts`). Every one preserves the result set **bit-identically** —
sha256 over the full row set, every account, every run.

### 1. The scope join is computed once (`resolutionScopeCte`)

Each resolution used to carry its own `scope JOIN entity_day` on
(account, entity, timezone). They now read one materialised relation, bounded by
the **union** of every window a resolution uses — `[dayStart, dayEnd + horizon)` —
and each still applies its own exact window, its own `requested_<field>` selector
flag and its own cutoff on top. Bounded, that relation is 7,241 rows at ad-set
grain and 1,046 at campaign grain.

The scope is also `DISTINCT`ed to the grain the resolutions key on. `DISTINCT ON`
collapsed duplicates already, so no answer changes; it is worth real time at
campaign grain, where 1,394 scope rows carry only 482 distinct campaign-days.

EXPLAIN before: 8,364 loops, 44,228,832 row touches over
`calib_adset_cfg_entity_day`. After: **6 loops, 12,256 touches.** The six
resolution CTEs now build in 3–6 ms each instead of 1.5–2.4 s.

### 2. The restated diagnostic is opt-in (`includeRestated`, default off)

`restatedValueSql` has exactly one production caller: `ad-calibration-job.ts`
reads the **campaign** objective as `objective_restated`. `data-source.ts`, the
decision loader, reads no restated value at any grain. The two ad-set diagnostic
relations were built and `LEFT JOIN`ed and then never read — 11.1M of the 44.1M
row touches in Bilsem's final join.

Stripping just those two joins from the emitted SQL, 4 interleaved rounds on
Bilsem: 9,441 → 8,267 ms median, result set bit-identical. So the resolution is
now emitted only on request, and `restatedValueSql` **throws** when it was not
requested rather than naming a relation the query does not contain.

The four `HYDRATION_*` contracts in `data-source.ts` pick this up from the
default with no edit to that file.

### 3. The final join is a single-row lookup, not a relation scan

`LEFT JOIN <relation> ON <three equalities>` makes the `CTE Scan` emit the whole
relation and filters above it, once per output row — 44.1M rows emitted for at
most 9,117 matches. Each relation is `DISTINCT ON (account, entity, date)`, so at
most one row can match; pushing the equalities inside a lateral with `LIMIT 1`
cannot drop a match or choose a different one, it only lets the scan stop.

Paired rounds, alternating which form runs first: **8/8 faster on both accounts**,
median 0.76 (Bilsem 8,723 → 6,743 ms) and 0.77 (TheSwaf 4,127 → 3,103 ms).

This is **not** the lateral this contract withdrew. That one re-derived the answer
per ad-day by ranking the whole receipt table inside the lateral. The reduction
still happens exactly once, set-based, in the `DISTINCT ON`; what is lateral here
is only the lookup of an already-decided row. The test
`resolves the ANSWER set-based, and never re-derives it per row` now asserts that
distinction directly: no lateral may touch the receipts, entity-day or scoped
relations.

## End to end

Paired rounds, alternating order, read-only, production:

| account | ad-days | baseline med | current med | paired ratio | rounds won | baseline max | current max |
|---|---|---|---|---|---|---|---|
| Bilsem `act_840779107261785` | 9,241 | 9,914 | **6,696** | 0.71 | 6/6 | 24,087 | **7,332** |
| TheSwaf `act_822913786458311` | 3,047 | 10,380 | **4,136** | 0.42 | 6/6 | 12,580 | **4,395** |
| Grandmix `act_805150454596350` | 4,638 | 5,150 | **3,508** | 0.70 | 6/6 | 14,456 | **4,353** |
| Tiles `act_904404985140555` | 3,962 | 6,069 | **4,595** | 0.84 | 9/10 | 18,677 | **6,445** |

Row parity identical in every cell. The **tail** is the point: against a 30 s
statement timeout the worst observed baseline run was 24.1 s and the worst
observed current run was 7.3 s **in these measured windows**. A later September
20 probe below supersedes that as a global worst-case claim.

## Later current-window counterexample and bounded response

The same emitted calibration source SQL, at Bilsem's provider-local 2026-09-20
cutoff, returned 9,078 rows in 29.375 s on one read-only run and exceeded the
job's 30 s query limit on the next. `EXPLAIN (ANALYZE, BUFFERS)` completed in
24.122 s. The two largest final-row lookup costs were materialized CTE scans
repeated 9,078 times: `calib_campaign_cfg_receipt` (about 9.9 s across loops)
and `calib_adset_cfg_optimization_goal_day` (about 9.8 s). This is a real
current-window timeout, despite the faster August 21 paired results above.

A production read-only `REPEATABLE READ` diagnostic compared the source query
at the database's 4MB `work_mem` default and a transaction-local 16MB setting,
in 4MB/16MB/16MB/4MB order. All four returned exactly 9,078 rows and the same
full-result SHA-256 `88cafd1c882f36d809f57e554320eaaf5442bfa41ba4aab04556478dd99b6b6d`.
Times were 12.275/5.851/5.106/6.748 s. Cache warming affects the first pair;
the later warm comparison is 6.748 versus 5.106 s. A separate cold-ish 16MB
read took 6.264 s, while 32MB and 64MB trials took 16.908 and 17.540 s under
different cache states. These observations support 16MB as a bounded local
sort-memory setting, not a claim that memory alone eliminates the cold tail.

The native ad calibration transaction now uses a **60 s per-query bound** and
sets `work_mem` to 16MB within that transaction. Other native jobs retain their
30 s bound, and no server-wide setting changes. The new bound prevents this
observed 30 s timeout from aborting the calibration generation; it still needs
post-deploy stage timings and a retry/error watch on the exact SHA. If a later
account exceeds 60 s, that is a fresh performance failure to investigate, not
a reason to infer missing data.

Tiles needed ten rounds to read clearly — at six it looked flat (0.95, 5/6). That
is the sampling floor for this box; **six paired rounds is not enough to call a
sub-20% effect**, and any future claim here should say how many rounds it rests on.

## What was measured and rejected

- **`enable_nestloop=off`** — consistently slower (above). Not applied.
- **Witness lateral → plain equality join** — the parity argument holds
  (`witness_scope` is `GROUP BY` on exactly the join key, so `LIMIT 1` is dead),
  but it would *add* ~1.06M row touches. Rejected on cost.
- **Merging the per-grain resolution relations into one row per key** — would cut
  the remaining final-join touches roughly 4×, but it requires renaming every
  column reference in `valueSql` / `tierSql` / `sourceClassSql` / `pitClassSql`
  and every emitted-SQL test. Not taken in this pass; it is the next lever if the
  budget gets tight again.
- **Estimate-hacking the planner** (restructuring the json predicates so the
  selectivity guess multiplies less aggressively) — rejected as fragile. The
  correct fix for the estimate is extended statistics, which is DDL on production
  and out of scope here.

## How to watch this in acceptance

1. **Structure, not time.** `EXPLAIN (ANALYZE, FORMAT JSON)` on the calibration
   source for the largest account, and assert on loops rather than milliseconds:
   `calib_adset_cfg_entity_day` must be scanned with **loops ≤ 6**, not 8,364. That
   number is deterministic and load-independent; wall time on this box is not.
2. **Row parity.** Any further change to this query must be A/B-ed against the
   previous emitted SQL inside one `REPEATABLE READ` snapshot with a sha256 over
   the full result set. Four such comparisons are recorded above; the harness
   pattern is a paired runner that alternates which side goes first.
3. **The tail, not the median.** Track the max over ≥ 8 paired rounds. The failure
   mode this work addresses is a cold or contended run crossing 30 s, and that
   shows up in the max long before it shows up in the median.
4. **The decision loader is structurally covered and separately timed.**
   `data-source.ts` inherits all three changes through the shared builder — its
   four `HYDRATION_*` contracts now emit no restated relation, use the hoisted
   scope join and the lateral lookups. A later read-only Bilsem 2026-09-20
   hydration completed for 3,296 ads in 47.754 s total. This is several SQL
   batches, not a single statement; the native job uses a 30 s **per-query**
   limit. End-to-end job staging and each batch's tail still need post-release
   readback. The web pool's 8 s default is a different execution path.
