# Superseded native history, scoped pin census and physical reclaim preparation

Status: LOCAL preparation under D133. D135 adds a separate default-OFF historical
integrity reader adapter, without current-reader activation, migrations,
uploader, eviction executor, maintenance command or budget change. It does not
close sustainable storage, admit PR329 or establish a natural reuse receipt.

## Two explicit transport contracts

`native-generation-core-archive.v1` remains the complete last-served core format.
Its original snapshots must still point to every original evaluation. The new
`native-superseded-generation-core-archive.v1` represents a successful original
job whose row_count equals its retained evaluations and whose current snapshot
count is ZERO. Partial current ownership is refused. It requires complete
evaluation/context/input-evidence membership, original IDs, clocks and hashes,
the actual schema digest, trusted manifest digest and a same-snapshot pin census.
It never invents the original mutable daily cells.

This is a historical COPY contract. Known outcome/reuse/shared-evidence pins may
remain in the live store and be recorded in its manifest. They independently
veto the supported-scope removal candidate; copying a pinned generation does not
make it removable. An unknown reference inventory refuses superseded transport.
Both readers always return providerAuthority=false and reclaimEligible=false.
The original v1 reader refuses the new contract rather than silently interpreting
missing daily cells as a complete served generation.

The isolated native producer seam creates multiple actual successful same-day
generations, selects a superseded original with 501 retained evaluations and
zero current snapshots, serializes exact PostgreSQL JSONB text to a0600 local
file, then checks trusted-read and five-table full-row/clock/hash restore parity.
Outgoing twelve FK definitions are rebound and validated using copied sandbox
parents. This is not independent calibration-parent closure, incoming migration,
full DR or credential export. Synthetic missing leaf tables explicitly belong to
the test inventory. Real retained reuse/shared-input references veto removal in
this sample even though its historical copy succeeds.

## Bounded pin and age reader

`readNativeArchivePinCensus` is a SELECT-only helper with no connection-string or
production invocation command. Its caller must hold ONE read-only repeatable-read
transaction and a positive statement_timeout no greater than7500ms. Each catalog
or reference count is a separate statement. No per-evaluation correlated CTE is
used. This timeout bounds an individual statement, not total transaction time,
pool acquisition, end-to-end throughput or a production SLA; actual indexes and
production query cost still need a separately scoped read-only check.

The reader binds successful job/business/day/epoch, exact decimal job/evaluation
counts, observed/finished clocks and catalog hash. It reports age from the
original finish time; age is not a retention horizon. Counts are reference edges
or class-specific memberships, not unique reclaimable rows or reclaimable bytes.
Several FKs can count the same leaf row, and shared evidence can have many retained
evaluation references. Large counts remain exact strings rather than rounded JS
numbers.

| Class | Scoped source |
| --- | --- |
| snapshots | Catalog FKs from current daily snapshots into selected core rows |
| outcomes | Catalog evaluation references from daily outcomes |
| episodes | Catalog evaluation references from recommendation episodes |
| assignments | Catalog evaluation references from controlled assignments |
| events | Catalog event references into selected job/snapshots |
| job_dependencies | Catalog job/lifecycle references plus dependency_run_id |
| reuse_attempts | Job metadata reused_job_run_id to the original success |
| shared_input_evidence | Retained other-generation evaluations with the same contract/input hash |
| action_lineage | Catalog action references plus operator decision_evaluation_id/decision_snapshot_id and controlled-registry source_evaluation_id/source_snapshot_id |

Every non-internal incoming catalog FK is measured with its actual composite
key, including unclassified and cross-schema children. Each edge carries an exact
reference count. An unclassified measured ZERO edge is retained in the inventory;
a positive unclassified edge vetoes as unsupported_reference_inventory. Missing
required tables/FKs or lineage columns remain unknown, never measured zero.
The explicit unmodeledReferences registry carries known unsupported non-FK
readers. An empty fixture registry is not automatic discovery of every JSON,
proposal, experiment or transitive production reader. Independent parent closure
and all production consumers remain required. The assessment's most permissive
result is pin_free_supported_scope, still reclaimEligible=false.

An isolated PostgreSQL fixture separately inserts a pin for every declared class
and proves each vetoes that result. An unclassified empty FK edge is measured and recorded; its positive reference
and an explicitly unsupported non-FK reader refuse. A real7500ms SQL cancellation reports
57014 and the source transaction rolls back. The fixtures do not grant production
execution authority or prove production latency. A separate stage creates a NEW
database on the owned random-loopback seam cluster and runs the actual
run-migrations entrypoint, preserving production calibration, outcomes, operator
and controlled-registry DDL and composite constraints. Schema fixture rows prove
pin-free superseded copying, all nine positive pin classes, both families of
action lineage and unclassified live outcome-run refusal. Snapshot-dependent
classes also have prerequisite snapshot pins; the fast synthetic fixture proves
class sensitivity independently. Foreign-evaluation INSERTs test actual episode
and assignment composite FKs without dropping constraints/triggers. This does
not replace the separate 501-evaluation actual-producer/restore proof or constitute
a production pin census, complete incoming migration or independent parent closure.

The current removal unit is the whole five-table core. Shared evidence or a job
dependency conservatively vetoes that unit; it does not establish that individual
evaluation rows can never move while shared evidence stays. Such a different unit
requires a separate closure/reader contract. No reclaimable population or byte
saving is inferred from these counts.

## Retained measurements used for physical planning

No new production read was performed for this preparation. Retained Sept30
09:47 evidence measured database172968696855B against the161GiB cap172872433664B:
excess96263191B. Physical free59306663936B and its42949672960B floor admit
separately; their difference is16356990976B (about15.23GiB). That difference is a
stale planning margin, NOT an allowable logical-budget increase or guaranteed
scratch reservation. DB logical size, filesystem free space, WAL, concurrent
writers and per-table fences have different accounting.

The retained06:24 relation census displays evaluation total63.56GB, heap15.72GB,
indexes17.38GB and TOAST30.46GB, rounded decimal measurements. Planner/live/dead
estimates do not measure reclaimable bytes. Full migration includes TOAST,
indexes, WAL, temporary sort space and dependent rows. The successful Sept28
controlled-identity index rebuild measured1320280064→1002749952B, freeing
317530112B with252519401B aggregate headroom. That exact historical result is
neither a fresh bloat estimate nor authority to repeat maintenance. No writer
share, lifetime or time-to-full forecast follows from these snapshots.

## Physical options and gates

| Option | Proposed unit and current feasibility | Locks, readback and recovery |
| --- | --- | --- |
| Partition migration / detach | No existing partitioned layout is established. Design additive date/generation routing, uniqueness/FK compatibility, original-ID lookups and dual-read rollback first. Copying can temporarily keep old plus new heap/TOAST/indexes. Detaching a retained partition within the same database alone releases no database bytes. Durable off-host transfer and separately approved removal are required. | Stage schema/reader parity in an isolated migrated PG first. Explicit cutover window, reader inventory and lock plan must precede live DDL. Keep original table/read path until exact bundle, parent/pin and restore checks pass. After any approved removal, recovery needs the original archived IDs and tested dependency-order restore, not a code-only rollback. |
| Full-table pg_repack | Its documented scratch estimate is about twice target table-plus-index size. Roughly127GB for the displayed63.56GB target exceeds the retained59.31GB physical free even before its floor. Server extension/tool presence and prerequisite key are unverified. This full-target option is not currently feasible from retained evidence. | Brief exclusive locks still occur at start/end. A future approved plan must preserve blockers, use no-kill-backend behavior and cancel its own attempt rather than kill applications. Before swap the original relation remains; after commit, a code revert does not undo physical organization. Validate exact row/hash/constraints and inspect only owned temporary artifacts before separately authorized cleanup. |
| VACUUM FULL | Requires a rewrite copy and exclusive lock; reserve the full target, rebuilt indexes, WAL/sort and margin. A rough63.56GB rewrite already exceeds retained59.31GB free, and the15.23GiB floor margin is smaller. No full-target operation is proposed now. | Requires explicit downtime/lock budget and fresh physical checks. Validate lineage, row/hash/schema/index parity after commit. Failed or committed rewrite recovery differs; maintain backup/restore evidence and never assume a runtime release rollback restores storage layout. |
| One separately scoped REINDEX CONCURRENTLY | Only an exact independently justified index may be considered after fresh size/bloat/catalog measurements, scratch estimate and specific approval. The historical controlled index shrank317530112B; current benefit is unknown. Old and new copies, sort/WAL and concurrent load need reserved space. It is temporary admission relief, not sustainable writer control. | It performs additional scans/waits and resource work. Bind exact OID/DDL/constraint ownership, permit one intent, then inspect readback. Invalid ccnew/ccold remnants require identity/dependency evidence and separately scoped cleanup; no blind retry/drop. Preserve valid unique/FK constraints. Before swap retain old validity; after success read definitions, constraints, bytes and actual fence. |
| Volume expansion / another logical budget step | Separate resource and owner decisions, currently unauthorized. More physical capacity does not fix repeated evidence writes or prove an appropriate logical budget. No second bridge is prepared as an automatic fallback. | Require fresh physical/WAL/table gates, cost/resource plan, exact pinned restart if needed and one independently verified release. Do not infer this scope from delegated strategy. |

An archive upload alone releases no PostgreSQL space. DELETE usually only makes
space internally reusable. Standard VACUUM can return empty tail pages, but no
tail-truncation saving is measured here; it cannot be promised to reopen this
fence. A successful shrink without sustained writer control can fill again.
These maintenance details follow the primary
[PostgreSQL vacuum guidance](https://www.postgresql.org/docs/16/routine-vacuuming.html),
[PostgreSQL concurrent reindex contract](https://www.postgresql.org/docs/16/sql-reindex.html)
and [pg_repack requirements](https://reorg.github.io/pg_repack/).

## Concrete remaining scope before a live mutation request

Choose sustainable storage as immutable external bundles plus compatible readers
and separately approved physical reclamation. This local implementation provides
copy/restore and pin-diagnostic primitives, not that entire rollout. The next
reviewable candidate must define a durable destination/access/cost and trusted
manifest index; bind a measured generation/date horizon; complete calibration
parents, incoming/non-FK/transitive pins and every production reader; prove
missing/corrupt/unsupported and restore paths; measure expected physical release
and fresh scratch/WAL/lock bounds; and specify exact IDs, operation and recovery.
Credential roots never enter a generic archive traversal.

Reopening admission and sustainable growth are separate decisions. The current
refusal is preserved while authority is absent; it is not a decision to freeze
the product indefinitely. After this concrete local phase and independent review,
present any necessary new scope as a specific owner decision, including cost,
preservation/removal, fresh gates and realistic limits. No destination creation,
upload, deletion, table rewrite, index operation or extra budget is implicit.
Passing local/source/image gates still does not permit deployment under refusal.
