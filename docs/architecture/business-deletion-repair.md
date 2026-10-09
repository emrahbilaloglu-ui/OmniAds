# Complete business data deletion — 2026-10-08

Both authenticated DELETE routes enqueue durable web-owned erasure under D154
and return HTTP 202. That acknowledgement is pending, never success. The
completion endpoint and an independent authorized-list read must prove absence.
A completed response means the business and its owned application records have been removed,
including retained decisions, frozen labels, calibrations, protected action
history, indirect report copies and the optional normalization archive. D153 is
an explicit whole-business offboarding exception to ordinary retained-history
policy. It grants no routine retention, age pruning or decision-writer authority.

## Transaction and isolation

The assignment kill switch and existing selection advisory lock apply. Catalog
ownership is checked against an explicit reviewed allowlist across non-system
schemas; unknown tables, inconsistent owners, unknown DELETE guards, live runner
leases and active jobs refuse the request. Retired native running bookkeeping
qualifies only under the existing three-epoch, 30-minute, 64-row idle contract,
with exact job/chain locks held until commit and no foreign ledger rewrite.
Current/fresh/unknown/owned runs or an incomplete census still refuse. The known legacy compaction schema's
lineage table is owned data; `keep_runs` and `run_semantics` are removed through
the exact observation-run IDs before their parents disappear.

All scoped tables and indirect stores are locked in sorted order using SHARE ROW
EXCLUSIVE. This permits reads and excludes competing writers. Lock acquisition
waits at most 1.5 seconds. The business row is locked and the ownership catalog
is reread after locks. Foreign keys stay active; their catalog dependencies set
child-before-parent order. Only the twenty named, source-reviewed immutable
DELETE guards are suspended, transactionally, while those locks are held. Their
original O/A/R modes are restored and read back before commit. Unknown, missing
or already disabled guards refuse rather than widening this exception. A failed
statement or commit rolls back database mutations and trigger changes together.
No `session_replication_role`, FK disabling, global bypass flag or schema change
is used. Ordinary protected-history mutation remains forbidden.

Validated equality CHECKs plus a NOT NULL indexed owner permit indexed native
ownership reads; `meta_creative_lineage_edges` uses its existing text-leading
index. Five explicitly reviewed original creative-grain tables use their
required UUID/PK owner despite nullable compatibility text. A contradictory
non-null alias in the selected canonical scope refuses. Native response tables
use their episode-key indexes only when a validated, complete, NOT NULL composite
FK proves episode ownership through the parent's equality CHECK. Missing proofs
refuse. Actual DELETE plans are checked before writes; a large sequential scope
scan refuses. No production index or index maintenance is introduced. Every scoped table is checked for remaining target rows before
root deletion. Shared users and provider-account identities are preserved;
connection-owned credentials cascade and active sessions lose the deleted scope.

Native evaluation history is walked once through a non-holdable, non-scrolling
server cursor over the verified leading business index. At its child-first
position, exact physical-TID pages of at most 4,096 evaluations are deleted;
RETURNING captures their input keys into a temporary unique-key table without
a whole-history DISTINCT/sort or a second eager history read. Each actual cursor
and delete plan must be a leading owner-index walk and exact Tid Scan respectively,
with no blocking Sort/Bitmap or non-leading ownership scan. Byte-exact,
non-indexable owner residuals retain ownership checks without restarting the
owner index per page. Index scans stay available for internal foreign-key probes;
disabling them globally made the real 4,096-row page time out in canonical CI.
The real page-limit rollback case verifies that FK probe's indexed plan under
the actual DELETE settings without raising its eight-second query cap.
The complete operation permits at most 4,194,304
evaluations and uses a 20-minute background deadline (four minutes for direct internal callers); bounds roll back all
prior pages. Erasure alone disables JIT in its transaction. The server statement
timeout is capped by both the 30-second query limit and remaining transaction
deadline, so an application timeout cannot leave a longer-running statement
holding its writer locks. Native input keys are captured as evaluations disappear. Only keys with no
reference from ANY remaining evaluation are collected, in 400-key pages. This
requires a valid, ready, live, nonpartial btree on `(contract_version,input_hash)`
and a verified parameterized index-probe plan. The real observed production index
is not created by this code or run-migrations. Missing prerequisites roll back.
Genuinely shared input keys remain for the other business that still owns them.

Indirect custom-report shares and identifying admin-audit entries are removed.
Derived cross-business retention/release/repair receipts containing the exact
UUID are invalidated as whole receipts; unrelated receipts and underlying other
business facts remain. The multi-gigabyte global release-receipt table has no
business index: it receives a complete finite census through its existing
`(emitted_at,id)` index, at most 1,024 rows per verified ordered page. No global
JSON DELETE or sequential plan is allowed. A maximum of 1,048,576 rows / 4 GiB
of evidence and the transaction deadline bound the complete operation. Exceeding
any bound rolls back all earlier pages and the business deletion; a partial
census never counts as erasure. This can inspect substantial historical evidence
and holds the deletion's writer locks for that bounded operation. Every gate
writer acquires the gate-table lock before business key-share locks and refuses
a canary whose business disappeared, preventing delayed ghost copies. The admin route emits only an anonymous deletion count
receipt, with no removed business ID or name.

Worker heartbeat `last_business_id`/JSON copies and runtime contract canary
copies are also covered. Complete finite ordered primary-key pages inspect at
most100,000 rows/512MiB per store. A running/starting worker or runtime configuration referencing the target
within five minutes returns the specific control-reference blocker. Stale
observations and fresh idle/shutdown observations are invalidated. Bounds or plan failures roll back every prior page. Actual
worker/runtime writers lock the destination tables before checking live
business references under key-share locks. Delayed running/runtime writes
refuse; idle/shutdown writes discard the entire stale metadata (including old
names/metrics) and identity fields, retaining anonymous process presence. Unrelated job/partition UUIDs are not business identities.

## External files and archives

Business media files under the exact provider/business UUID cache directory are
removed and absence checked. Unsafe paths, foreign storage keys and symlinks
refuse. This derived cache eviction can survive a later database rollback; the
business and database records remain transactionally protected.

The exact digest-pinned active legacy and routed native archive metadata are
fully checked within fixed bounds. Inactive/staged local metadata is also scanned
within a 256-entry/16 MiB census; unowned orphan ciphertext refuses success.
A remaining target generation, invalid pin,
missing metadata or failed file cleanup returns `external_cleanup_required` and
keeps the business. Native archive ciphertext/catalog destruction is deliberately
not guessed by the web request. An archive-bearing business must first have its
owned archive copies removed through a separately reviewed archive offboarding
path; until then the product MUST NOT report successful deletion. Halıcızade and
Vornom are checked independently against the actual configured catalog before
any production attempt. Archive offboarding must freeze every archived native
input key and its current full-row digest before destroying the archive. After
removal of served and inactive copies, collect only those frozen keys after
GLOBAL indexed zero-reference proof under native-producer and input/evaluation
writer exclusion. Source drift or a new foreign reference vetoes collection.
The separately reviewed Vornom operational artifact covers 518 already-orphaned
archived keys; the ordinary request's hot-evaluation key census alone cannot
prove their removal. Its local fixture, live execution and independent post-read
are separate evidence. No whole input-table scan or other-key GC is authorized.

Application deletion is not a claim of forensic erasure of PostgreSQL MVCC/WAL,
shared system logs, or shared disaster-recovery backups. Shared backups contain
other businesses and are not destroyed by deleting one business. Restoring an old
backup must not silently reintroduce removed businesses. Backup-level erasure is
a separate, currently unsupported boundary, explicitly shown in the confirmation.
SQL DELETE may free reusable tuple space without reducing `pg_database_size` or
opening the 163 GiB growth-admission gate.

## Verification and rollout

Fifty destructive cases run only on a disposable localhost PostgreSQL migrated
by the actual migrations and are registered in the canonical CI harness. They
cover legacy FK failure, complete scoped removal, frozen/protected history,
shared users/accounts, credentials/sessions, unknown tables/guards, late-FK
rollback with trigger restoration, live leases, growth-refused removal, ownership
conflicts, the kill switch, absent businesses, indirect compact/report/audit
copies, native producer calibration/context/evaluation cleanup and GLOBAL shared
input safety, nullable legacy owners, contradictory legacy aliases, actual
native episode/response cleanup, multiple release-receipt pages, rollback after
a census bound and stale-canary write refusal. A real second session proves another tenant's writer times out
while the first deletion has suspended guards, then proves ordinary immutable
DELETE still fails after commit. External-file tests cover exact scoped cache
removal, absent files, unsafe paths and pinned archive blockers.

Manage Business rereads the authoritative list and requires target absence
before clearing local data or showing success. Active-workspace switching uses
that fresh list and distinguishes switch failure from deletion failure.

Release requires canonical local checks, exact-head CI, exact main CI/images and
canonical deployment without break glass. Deployment alone deletes nothing.
Live acceptance is sequential: Halıcızade, independent UI/API/catalog-indexed
absence and other-business checks, then Vornom with active-workspace switching.
Any failure stops the second target until repaired. Database size and fresh
capacity admission are separate acceptance observations, never inferred from a
delete response or host health.

## Rollback

The additive `business_deletion_jobs` table has no completed tombstones: each
job disappears in the same commit as its business. Drain/refuse active jobs
before reverting code through the normal release workflow. Do not return to a
pre-D154 eraser while this new ownership table exists; it correctly refuses an
unreviewed scope. Keep the small additive table attached to surviving businesses. Code rollback restores neither deleted records nor
evicted files. Completed erasure is permanent in the application; any disaster
recovery needs explicit scope and must account for deletions after the backup.
No provider account, advertisement, budget, quota or growth override is changed.
