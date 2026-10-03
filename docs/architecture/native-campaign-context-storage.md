# Native campaign context storage

R1 is read compatibility and additive schema. It writes every new evaluation
inline, retains its NOT NULL column, and saves or reclaims zero bytes. No engine,
canonical input, decision, context hash, source epoch, clock or provider authority
changes. The previous inline-only image remains the R1 rollback target.

The shared object key binds business UUID and SHA256 of the original PostgreSQL
JSONB text. A separate storage version, exact UTF8 byte length, digest/object
checks and UPDATE/DELETE refusal protect that content. Tenant keys cannot share
an object by accident. This storage digest is not a decision identity or a clock
normalization. No reference reverse index or shared-object garbage collector is
introduced; these roots remain live.

The evaluation receives one nullable, no-default BYTEA reference. The new XOR
and composite tenant/object FK are NOT VALID: all new writes are enforced,
without a scan of the existing large table. Existing evaluated rows are not
backfilled or rewritten. Pinned migration lock/deadline bounds and strict catalog
verification remain necessary; a busy lock refuses the migration.
The hot-table ADD COLUMN/constraints use their own 500ms lock bound on that
pinned transaction, then restore the caller's bound. This is not an outer
transaction or deployment latency guarantee.
The ADD is catalog-guarded too: a repeated migration does not issue its hot-table
ALTER while existing reads hold ACCESS SHARE. The owned full-DDL fixture removes
only the new nullable column, exercises the first addition on existing data,
checks pre-existing column bytes/clocks and filenode, NOT VALID constraints, the
exact unchanged a89 inline INSERT and R1 capability. It proves the former repeat
ALTER refuses under a read lock while the catalog-guarded repeat succeeds. This
does not execute the complete a89 capability or install a complete old schema.
An R1 release must run migrations before service recreation and verify the new
catalog/capability; migration/admission refusal prevents distributing R1 code.

The sole campaign-context SQL accessor returns the inline object or the exact
tenant-bound reference. Both populated, both absent, missing object and unknown
storage version refuse through existing object validators. Evidence, outcomes,
the natural-wave verifier and account-AOV replay all use it. The outcomes reader
cannot turn missing content into `{}`. An explicit empty original object remains
an object. A column-level CI ledger rejects new or changed raw readers, including
operator scripts; it is not a claim of all production/transitive consumers.

R1 can read a later nullable reference-only representation. Such rows are tested
only in a rolled-back, owned full-migration fixture. They cannot yet be written
by R1. Its old archive formats refuse non-null campaign references because their
five/seven-table membership does not include these shared roots. Original inline
archives remain readable, with original row bytes and schema; future reference
archives require an explicit transport/restore contract before their eviction.
Adding the nullable column changes live row/schema representation by adding a
NULL key. Sealed old archives retain their original schema and bytes; any future
live-to-archive comparison must explicitly account for this additive column.

R2 follows an actual R1 release: its writer may relax the inline NOT NULL under
the XOR/FK checks and write one content object plus a reference, without inline
shadow copies. Its rollback is R1, which can read those references and writes
new rows inline. Its unchanged original payload, hashes, clocks and actual
natural producer must be proved before claiming saving. Net heap/TOAST/index and
WAL costs must be measured; the earlier 316-byte/row estimate was a model based
on a 128-row sample, not an observed reference-storage result.

Sustainable history also requires a measured closed-day superseded population,
all zero/unknown pin gates, immutable recoverable copies on existing separate
hosts, exact reader/restore parity, bounded source removal and actual free-space
reuse/reclaim. Metadata, copying, SQL fixtures and R1 do not close that outcome.
Regular VACUUM can reuse space without shrinking the logical size used by the
capacity fence; no FULL/repack or future capacity admission is promised.
