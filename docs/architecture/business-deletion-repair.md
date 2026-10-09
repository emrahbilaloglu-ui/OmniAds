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
scan refuses. D155 adds only the reviewed missing scalar FK lookup indexes,
under physical build admission; it does not rebuild existing indexes or reclaim
storage. Every scoped table is checked for remaining target rows before
root deletion. Shared users and still-referenced provider-account identities are preserved;
connection-owned credentials cascade and active sessions lose the deleted scope.

D160 also removes an unshared application `provider_accounts` row, including
its name, currency, timezone and metadata. It captures account UUIDs from the
existing owned DELETE RETURNING pages, including native evaluation pages;
no additional native-history projection or other-account census is allowed.
Before parent CASCADE, the two inherited snapshot/summary account stores are
captured through selected owner-parent IDs and checked parent-index cursor
pages. Parents are bounded to8MiB/1024 IDs and each inherited census to4,194,304
rows in4096-row pages. Candidate accounts are bounded to128; the global registry
directory is a verified leading raw-UUID index walk bounded to256 identities. Unknown global FK children, RLS,
partitions or unsupported metadata refuse before mutation.

Sorted writer/DDL exclusion includes the registry and both inherited stores.
Every candidate requires a global UUID-point zero-reference proof over every
catalogued provider-account FK child. Large children require valid raw leading
UUID indexes and actual constrained index plans; ordinary heaps of at most1MiB
may use their existing bounded access. The single exact existing NOT VALID
campaign-label FK is preserved with all four RI triggers and included in the
proof. No new validation, FK/guard disabling or cascaded foreign removal is
authorized. Any remaining reference preserves the complete original registry
row. Delete and independent absence run in the same transaction; failure rolls
back every business/account mutation. This is application offboarding, with no
provider-side account deletion, backup/WAL destruction or physical shrink.

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
evaluations and uses a 30-minute background deadline (D162) (four minutes for direct internal callers); bounds roll back all
prior pages. Erasure alone disables JIT in its transaction. The server statement
timeout is capped by both the 30-second query limit and remaining transaction
deadline, so an application timeout cannot leave a longer-running statement
holding its writer locks. Native input keys are captured as evaluations disappear. Only keys with no
reference from ANY remaining evaluation are collected, in 400-key pages. This
requires a valid, ready, live, nonpartial btree on `(contract_version,input_hash)`
and a verified parameterized index-probe plan. The real observed production index
is not created by this code or run-migrations. Missing prerequisites roll back.
Genuinely shared input keys remain for the other business that still owns them.

D161 qualifies the raw temporary `(contract_version,input_hash)` PK in ORDER BY
and seeks past the last consumed tuple for every later400-key page. Projecting
the bpchar hash as text must not make that alias the sort key. Each actual first
and continuation plan must be a PK Index/Index Only Scan, without Sort,
Bitmap/Seq Scan or materialization; continuation requires the tuple seek in its
index condition. Captured keys are complete before this traversal begins and
writers remain excluded. GLOBAL references are still checked on every page,
shared input content is preserved and only processed temporary keys are removed.
Unsafe page plans roll back every preceding business/input mutation. At D161 the query cap, total deadline, pages, ownership bounds, guards and FKs
were unchanged. D162 subsequently changes only the approved background total
deadline from20 to30 minutes, following actual full-input-cleanup completion
and total-deadline rollback in provider-identity cleanup. Direct internal
callers remain bounded tofour minutes and every PostgreSQL statement to30
seconds or the remaining deadline, whichever is shorter. The lock cap, pages,
row bounds, GLOBAL reference proof, guards/FKs, writer exclusion and single
atomic rollback remain unchanged. Local fixtures advance only the application
clock at the real late provider phase: completion beyond20 minutes remains
allowed, while exceeding30 minutes rolls back all earlier owned-row removal
and preserves foreign businesses. No new index or maintenance is authorized.

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

Fifty-five destructive cases run only on a disposable localhost PostgreSQL migrated
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

The actual reconciliation-event `ON DELETE SET NULL` lookup is reproduced with
and without its scalar index. The migrated seam requires indexed RI access and
byte-identical foreign reconciliation/slice rows after selected erasure. All 38
reviewed lookup contracts, including the partitioned outcome parent, must be
valid, ready and live. A completed release-gate provider-scope replay must keep
the exact existing index definitions and physical identities.

## D155 additive FK lookup schema

The fifth live Halıcızade attempt reached `meta_authoritative_slice_versions`
and rolled back at the unchanged 30-second statement cap. The PostgreSQL error
context identified the internal `SET slice_version_id=NULL` lookup in
`meta_authoritative_reconciliation_events`; its indexes had no leading slice
UUID. This is a foreign-key access defect, not proof of slow outer owner access.
Thirty-two reviewed, fixed-width scalar Meta/native FK columns with selected
parent history receive missing partial btree indexes (`key IS NOT NULL`).
Usable existing leading default-opclass/collation indexes are adopted. Unknown,
invalid or conflicting indexes refuse; none is dropped or rebuilt. Ordinary
heap indexes use `CONCURRENTLY`; PostgreSQL's partitioned-parent case uses
ordinary parent/leaf DDL under the existing migration deadlines.

Only these reviewed scalar UUID/integer/bigint indexes use a physical reserve
of three times the heap size (including every partition leaf) plus the unchanged
40 GiB residual floor. Variable/toasted keys and expressions are excluded. The
live physical sample must be fresh and complete, even for a tiny production
build. This additive index operation does not rewrite existing indexes or TOAST.
All existing heavy rewrites retain their total-relation reserve and physical
refusals remain unoverrideable. No logical growth budget is raised.

An already completed provider-scope migration is recognized by the exact three
valid/live/ready index definitions, NOT NULL text/default contract and absence
of the obsolete index. Two actual bounded indexed range probes must find no
mislabelled deploy row before the entire old repair group may be skipped. Any
missing, ambiguous or inconsistent proof takes the original physical guard
before any repair mutation. This avoids replaying a completed heavy rebuild.

New indexes are additive and remain during a code rollback. A failed build or
physical refusal stops publication without bypass or automatic cleanup/rebuild.
Local tests do not establish successful live migration, erasure or a reopened
growth gate. Fresh pre/post target and foreign-scope proofs remain required.

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

D155 native campaign RI access: the additional nullable BYTEA reference uses
a fixed four-byte hash index, with full equality/owner recheck. Its separate
physical admission requires exact valid nonpartial unique UUID PK coverage,
8x measured PK bytes plus the unchanged 40 GiB floor and fresh telemetry.
No BYTEA width assumption or ordinary heavy-step relaxation is allowed.
Canonical deletion seam: 53 cases and 38 reviewed FK access contracts.

Five additional compound-lineage parent UUIDs use the same scalar btree
admission: calibration batch/daily jobs, native event/outcome snapshot refs,
and snapshot calibration refs. All 38 catalog contracts are required.


## D156 observation-run generic RI access

After D155 the sixth live Halıcızade request rolled back at observation-run
parents. Actual generic full-FK plans used owner-wide access with run_id
residual despite an existing run_id-leading index; Vornom custom access was
also broad. The 30-second timeout bounds the complete 4,096-parent statement.

[D156](../creative-decision-center/DECISION_LOG.md#d156--bounded-observation-run-lineage-access-for-erasure-2026-10-09)
adds one nonpartial concurrent six-key lineage btree with fillfactor 90.
Three UUIDs, timestamptz and exact validated bounded enum keys with deterministic collation are proved
before DDL; the full eight-column RESTRICT FK and identity residuals remain.
Only this contract uses 32x fresh validated full single-UUID PK bytes plus the
same 40GiB residual floor for physical admission. No override, existing-index
rebuild, growth-budget adjustment or other-relation reserve relaxation applies.

Owned mutation pages are now 512; ownership census and the native evaluation
helper remain 4,096. Limits, exact TID/owner checks, locks and atomic rollback
are preserved. Canonical deletion seam requires 55 actual PostgreSQL cases.
Live acceptance requires selective actual custom/generic RI plans for both
selected targets, then fresh prestate and Halıcızade complete absence before
Vornom. An index or successful release alone is not erasure acceptance.


## D157 account-binding FK access

The seventh live attempt rolled back at the full snapshot account-binding FK
when removing business_provider_accounts. Read-only custom/generic plans cover
all 13 bindings in both targets. Nine native child indexes have an unconstrained
leading key, even when later account conditions appear in Index Cond.
D157 adds missing fixed-UUID provider_account_ref_id-leading partial btrees via
the existing typed/adopt/refuse scalar helper, and keeps bitmap access disabled
transaction-locally during parent-binding erasure. Full owner/provider/text FK
rechecks, writer locks, row limits, deadlines and atomic rollback stay intact.
Only these nine exact UUID contracts use 8x fresh unique single-UUID PK coverage
plus the unchanged 40GiB floor. All other admission and 163GiB growth limits are
unchanged; physical refusal has no override. Canonical coverage requires 56
actual PostgreSQL cases and 47 reference contracts, including actual full generic
RI access and foreign-byte preservation with a shared provider identity.
Exact live plans and real terminal/absence acceptance are still separate gates.

The reserve is a conservative fixed-width model, not a measured future index
size. Its primary-source basis is PostgreSQL 16's [B-tree deduplication rules](https://www.postgresql.org/docs/16/btree-implementation.html),
[index tuple header/layout](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/include/access/itup.h)
and [page item identifiers](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/include/storage/itemid.h).
Distinct live UUID primary keys require separate entries; old versions of one
key may be deduplicated. The coverage proof rejects partial or incomplete
primary indexes. Fresh measured free space and the floor remain mandatory.

## D158 complete binding keys

The D157 release is exact live, but20 of52 full account-binding plans still
choose broad access on five native relations. A catalog comparison formatting
error was corrected independently; the leading-key failure is real. Do not
call D157 complete erasure and do not repeat DELETE on that evidence.
[D158](../creative-decision-center/DECISION_LOG.md#d158--complete-account-binding-key-access-for-erasure-2026-10-09)
adds five typed three-key btrees in the existing schema helper. Full business
and account identity equality becomes searchable with the leading account UUID.
Full FK/provider rechecks, writer exclusion and rollback remain mandatory.
The five exact contracts require finite parent/width evidence and their separate
fresh12x complete UUID-PK capacity model plus the same40GiB floor. All other
models and163GiB growth admission remain unchanged. No rebuild or global
planner change is authorized. Live52-plan acceptance and terminal/full absence
are separate from56-case canonical PostgreSQL validation.

The model uses PostgreSQL16's [leading equality rules](https://www.postgresql.org/docs/16/indexes-multicolumn.html),
[default btree fillfactor and key semantics](https://www.postgresql.org/docs/16/sql-createindex.html)
and the header/layout sources cited above. It bounds current referenced keys
through their validated small parent and refuses unbounded keys; it is not a
measured future index or physical storage reclamation claim.

## D159 Meta binding access and honest live acceptance

The eighth Halıcızade attempt on D158 rolled back at the Meta creative-lineage
binding RI probe. Neither business is erased. See
[D159](../creative-decision-center/DECISION_LOG.md#d159--meta-account-binding-ri-access-after-actual-erasure-rollback-2026-10-09).
The existing full-binding migration adds only two validated Meta contracts,
for seven in total, using unchanged typed12x UUID-PK physical admission.
Its populated shared-account seam now proves both Meta generic account-leading
plans, selected full erasure and foreign byte preservation. Live52-plan
acceptance must require UUID-leading access for every large binding child;
only the explicitly measured campaign-label and retained-lineage heaps below
1MiB may retain constrained owner-leading access. A preparation receipt is not
terminal completion; all prior selected/foreign proofs remain required.
