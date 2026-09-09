# Meta receipt schema and image rollback

D096 preserves the deployed `a2eb1b1b1dae9e69ffe470c39ada19731a570224`
writer without a bridge image. Its four-column `ON CONFLICT` arbiter remains
on `meta_entity_observation_receipts`, together with its two historical ranked
indexes. The current attempt arbiter and ranked indexes belong to the separate
`meta_entity_observation_receipts_v2` table. Two different sync attempts at one
capture timestamp must never share the old table's uniqueness constraint.

The new writer appends every attempt to v2 and mirrors the first occurrence
into the legacy table in one SQL statement inside the observation transaction.
The mirror shares its UUID, clocks and evidence. The authority union includes
all v2 rows and legacy rows whose UUID is absent from v2. An exact legacy
occurrence is compared before a new copy is admitted, including a NULL attempt
written by the old image. A contradictory retry still throws. Production
observation writers retain the shared transaction advisory lock.

Rolling back the image requires no receipt DDL, row rewrite or deletion. The
old writer and migration continue using the legacy table; v2 evidence remains
retained. Rolling forward reads both tables, including receipts appended during
rollback. The migration refuses an incompatible pre-existing legacy table that
already contains duplicate four-column keys; it never deletes rows to force
that table into shape.

The PostgreSQL safety seam extracts and executes the deployed writer function
and its original index DDL from the exact Git revision. It proves old → new →
old → new reads/writes, same-clock distinct attempts, retry deduplication,
contradiction rejection and migration replay. The branch-point upgrade seam
removes v2 before upgrading and proves the legacy receipt payload, UUID and
relfilenode survive while v2 begins empty. This is local compatibility proof;
it does not measure production migration duration or index growth.

Both tables use restrictive references to observation runs, partitions,
snapshots and sync attempts. No receipt deletion/TTL executor is introduced;
the existing 160 GiB database aggregate fence counts both physical tables and
their indexes. The state-history ceiling remains 6 GiB. Readback must report
each receipt table's row count and `pg_total_relation_size`, and the deduplicated
authority count, rather than reporting the legacy mirror alone.

## The state-history index during this release

`idx_meta_entity_state_history_manifest_delta` was absent from the September 7
index census. Its production size and reclaimable space remain unmeasured until
the actual build/readback. The migration records total relation bytes and this
index's bytes before and after its concurrent build.

An ordinary index create/repair refuses an over-budget relation. Rechecking an
already valid index is a no-growth operation and needs no maintenance flag;
the migration still records the measured sizes. The exact, migration-only
contract `ADSECUTE_META_HISTORY_SCHEMA_MAINTENANCE=index_only_while_source_fenced`
allows this index work when the source is already blocked by the real growth
fence and a fresh physical-capacity sample passes the existing build/WAL peak
plus residual-disk floor. A post-build over-budget result is accepted only when
that same pre-build maintenance admission succeeded. A malformed measurement,
an override that admits SOURCE, a higher source budget, stale/missing physical
capacity or a newly exceeded budget after an ordinary build still refuses.

The flag belongs only to the migration container. It neither changes the
6 GiB SOURCE ceiling nor admits ordinary sync. Deploy the bounded writer with
SOURCE still fenced, then follow the measured `REINDEX INDEX CONCURRENTLY`
recovery in the [6 GiB runbook](state-history-6gib-fence-relief-runbook.md).
Include the new index in the size census and recovery order if it exists.
Re-read the unchanged growth fence after recovery; release acceptance requires
actual headroom including the new index. No history deletion or budget increase
is authorized by this schema maintenance contract.
