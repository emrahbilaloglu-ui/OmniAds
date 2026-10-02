# Native historical archives on existing application storage

## D138: explicit local transport

The owner chose no additional paid storage. The completed full-database recovery
and removal of exactly three old application-host dump copies freed application
root space; they did not shrink PostgreSQL. Use that existing host as a candidate
archive target instead of creating the earlier paid S3 bucket. This source change
implements the transport; it does not turn on a production reader or remove data.

`ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT=filesystem` selects the new adapter explicitly.
Unset preserves the existing S3 configuration. Unsupported values fail closed;
neither mode falls back to the other. The reader remains default OFF under
`ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED`.

The deployment-selected `ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT` is an absolute,
canonical private directory. The web process must receive it as a **read-only
bind mount**. Catalogs remain independently digest-pinned, and encryption keys
remain separate from ciphertext. No path, key or version comes from an HTTP
request. For a local object, the existing catalog object pointer is:

```
bucket = adsecute-native-local
key = native/v1/<ciphertext SHA256>.bin
versionId = <the same ciphertext SHA256>
```

The adapter opens only that exact regular file, refuses symlinks, hard links,
writable files, unsafe object directories, different owners, size/digest changes
and alternate versions. It checks original exact ciphertext before the existing
separate compiled worker decrypts and validates full original row/clock/identity
and tenant lineage. Provider authority, current-decision eligibility and reclaim
eligibility remain false. Existing 2MiB runtime plaintext, 256KiB response,
concurrency, rate, cache and worker limits are unchanged. Filesystem reads receive
the same five-second transport and outer ten-second request bounds; cancellation
closes late descriptors but cannot promise to cancel kernel disk I/O.
One process-wide slot covers actual local I/O, including trusted catalogs in both
transport modes. A timeout does not release it: it remains occupied until the
underlying operation finishes and closes its descriptor. New operations refuse
before touching the filesystem while that slot is occupied; there is no queue.
This prevents historical requests from accumulating uncancellable disk operations
behind request deadlines. It is not a host-wide kernel or distributed I/O limit.

## Operator publication and recovery

`persistLocalNativeArchive` is an offline operator helper. Call it only after
validating and sealing the complete original bundle. It writes a new random
temporary file, syncs it, removes all write permission, and atomically hard-links
the content-addressed name without replacing an existing name. It removes only
its own temporary file, syncs the directory and verifies the exact object again.
An ambiguous/crashed operation is handled by reading the exact object, never by
blind overwrite. A corrupted existing object refuses. It publishes no catalog,
changes no DB row and grants no removal permission.

A crash between linking the target and unlinking its temporary name can leave two
names on one inode. That is an explicit fail-closed recovery case, not automatic
successful retry: the reader rejects it. An operator must verify the exact target
and exact `.pending-<uuid>` identity with no-follow opens, same dev/inode/owner,
exactly two links, immutable length and independent trusted SHA/envelope recovery.
After a separately scoped recovery action removes only that matching temporary
name, sync the directory and perform the ordinary one-link readback. Do not remove
the target, scan/delete other temporary names or infer recovery permission from
this document. First creation also syncs parent directories before publication.

This is not provider Object Lock or protection against a host administrator.
Administrator write access and the independent trusted catalog/key are part of
the trust boundary. A read-only application mount prevents application writes;
private files and encryption restrict exposure. The writer root is owned by the
operator running publication. Reader access must be verified in the actual image
and actual mount before activation; no insecure permission fallback is added.

Existing disk is finite. A full backup is roughly27GB in the latest retained
measurement, and the last APP-root readback had roughly96GB free. Those are dated
observations, not a future reservation or a promise of reclaim. A measured pilot
must retain existing recovery points, a fixed root-space floor, bounded per-run
output and independent key/catalog recovery. A source copy on the DB host and a
Mac copy help recovery but do not make this single application-host archive an
independent disaster recovery site. Provider backups do not include attached
database Volumes.

## Remaining production gates

Before any DB removal: choose an exact generation/evaluation unit, measure actual
complete package size, every incoming and non-FK consumer/pin, original calibration
parents, current/last-served/hysteresis/reuse/action/outcome identity, and compatible
historical readers. Unknown consumer closure refuses. Oversized packages refuse;
this phase does not silently drop required parents, chunk data or increase limits.

Then prove actual host read-only mount, encrypted object readback, independently
trusted catalog/key recovery and exact original-row restore. Only a separately
reviewed and authorized exact-ID removal/reclaim plan can change PostgreSQL.
Logical DELETE alone does not lower the relation budget. Fresh scratch/WAL/lock
and rollback gates still apply. The already blocked growth fence is not bypassed
for source deployment. New-row content addressing and date/generation lifecycle
remain required for sustainable growth; this transport alone does not close item3.

The existing daily core-only **installed** service remains19/231 public tables in
the retained inspection. The repository's complete-backup implementation is not
proof that that full policy is installed or scheduled. Preserve the existing core
timer; a full automatic policy needs its own bounded I/O, space, retention and
restore disposition. Do not activate the repository script's broad cleanup merely
to enable full backups. The manual239-table SQL restore is a separate proved
recovery result, not automatic daily full coverage or a native reuse witness.
